/**
 * Loose tool-call extraction — the safety net for weak local models that
 * "describe" a tool call in their TEXT answer instead of emitting it through
 * the native `tool_calls` channel.
 *
 * Native tool_calls (Ollama `tools`) and Hermes `<tool_call>` XML are handled
 * directly in useAgentChat. This module is the fallback for everything in
 * between — observed LIVE on the only locally-installed agent models:
 *   - gemma4:e4b  → often answers in prose, occasionally writes the call
 *   - qwen2.5-coder:14b → wrote `image_generate(prompt="a small red cube …")`
 *     as plain answer text and never used the structured channel.
 * Without this, the chat-agent image/video flow simply never fires for these
 * models. With it, ANY recognizable call (function-syntax, JSON object, Hermes
 * tag) the model wrote into its answer is lifted into a real tool call.
 *
 * SAFETY: only calls whose name is in `known` are returned, so ordinary prose
 * that happens to contain parentheses or a stray `{}` can't be misread as a
 * tool invocation. The matched snippet is also reported so the caller can strip
 * it from the visible answer (we don't want the raw `foo(...)` echoed as prose).
 */

import { findBalancedObjects, balancedObjectAt } from './json-scan'
import { isRecord, prop } from '../types/json-guards'
import { repairJson } from './tool-call-repair'
import { parseHermesToolCalls } from '../api/hermes-tool-calling'
import { RETIRED_TOOL_NAMES } from './retired-tools'

/**
 * A9. The sixteen names the 2.6.6 merge retired are not in any `known` list
 * any more, but they still EXECUTE: the registry redirects them and the result
 * carries a note naming the new call form. Every recogniser in this file was
 * gated on `known` alone, so the redirect only ever fired for a name that
 * arrived spotless through the native channel. `functions.git_status` (the
 * harmony recipient namespace, seen live on gpt-oss), `git_status` written
 * into prose, `run_code` from a model that learned that spelling elsewhere:
 * all three walked past the redirect and came back as "Unknown tool".
 *
 * A registered tool always wins; this list is only consulted after `known`
 * has had its full ladder, so nothing can be rerouted away from a live tool.
 */
const RETIRED_NAMES: string[] = [...RETIRED_TOOL_NAMES]

export interface LooseToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface LooseParseResult {
  calls: LooseToolCall[]
  /** The exact substrings that were recognized as calls (for stripping from prose). */
  matched: string[]
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Coerce a scalar token ("..."/'...'/number/true/false) into a JS value. */
function coerceScalar(raw: string): unknown {
  const v = raw.trim()
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v)
  // quoted string → unquote + unescape
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(/\\(["'\\])/g, '$1')
  }
  return v
}

/**
 * Parse the inside of a `name( ... )` call into an arguments object.
 * Handles `key="val"`, `key='val'`, `key: "val"`, `key=123`, `key=true`, and a
 * single positional string (mapped to `prompt`, the natural arg for the
 * creative tools this fallback exists for).
 */
function parseCallArgs(inner: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  const kw = /([A-Za-z_]\w*)\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|true|false|null|-?\d+(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  let found = false
  while ((m = kw.exec(inner)) !== null) {
    found = true
    args[m[1]] = coerceScalar(m[2])
  }
  if (!found) {
    // Positional single string → prompt (e.g. image_generate("a red cube")).
    const s = inner.trim().replace(/^["']|["']$/g, '').trim()
    if (s) args.prompt = s
  }
  return args
}

/** Find bare/fenced JSON objects that name a known tool: {"name":"X","arguments":{…}}. */
function parseJsonObjectCalls(text: string, known: Set<string>): { call: LooseToolCall; snippet: string }[] {
  const calls: { call: LooseToolCall; snippet: string }[] = []
  // Every top-level {...} candidate; repairJson tolerates trailing commas /
  // single quotes / unquoted keys. The scan is string-aware (json-scan.ts):
  // the old depth counter treated braces INSIDE a JSON string as structure, so
  // a file_write whose content held a regex or a half-open block either lost
  // its closing brace (candidate never emitted, call silently dropped) or
  // closed one brace early (wrong arguments).
  const candidates: string[] = findBalancedObjects(text)
  for (const cand of candidates) {
    if (!/["']?(?:name|tool|tool_name|tool_call|function)["']?\s*[:=]/.test(cand)) continue
    const parsed = repairJson(cand)
    if (!parsed) continue
    // Name + args may arrive in three shapes, all seen from small local models:
    //   flat     {"name":"file_list","arguments":{…}}
    //   nested   {"function":{"name":"file_list","arguments":{…}}}  (OpenAI/Phi)
    //   wrapped  {"tool_call":{"name":…}} or {"tool_call":"file_list","arguments":{…}}
    // Unwrap an object-valued name carrier so the nested forms resolve too.
    let nameField: unknown = parsed.name || prop(parsed, 'tool') || prop(parsed, 'tool_name')
      || prop(parsed, 'tool_call') || prop(parsed, 'function')
    let argsField: unknown = parsed.arguments ?? parsed.parameters ?? prop(parsed, 'args') ?? prop(parsed, 'params')
    if (isRecord(nameField)) {
      argsField = argsField ?? nameField.arguments ?? nameField.parameters ?? nameField.args
      nameField = nameField.name || nameField.tool || nameField.tool_name
    }
    if (typeof nameField === 'string' && known.has(nameField)) {
      // Arguments can arrive as a JSON STRING (OpenAI serializes them) — repair
      // it. `parsed.arguments` is already resolved by repairJson; this still
      // covers the `args` / `params` spellings and the nested-function form.
      let a: unknown = argsField ?? {}
      if (typeof a === 'string') { const p2 = repairJson(a); a = isRecord(p2) ? p2 : {} }
      // Report the source snippet so the caller can strip the raw JSON object
      // from the visible prose (otherwise it leaks as a "notes"/JSON block).
      calls.push({ call: { name: nameField, arguments: isRecord(a) ? a : {} }, snippet: cand })
    }
  }
  return calls
}

/**
 * Extract tool calls a model wrote into its text answer. Returns the calls plus
 * the matched source snippets (so the caller can strip them from the prose).
 * Only `known` tool names are recognized.
 */
export function parseLooseToolCalls(text: string, known: string[]): LooseParseResult {
  if (!text || !text.trim()) return { calls: [], matched: [] }
  // Retired names are recognisable AND runnable, so they belong in the net.
  const knownSet = new Set([...known, ...RETIRED_NAMES])
  const calls: LooseToolCall[] = []
  const matched: string[] = []
  const seen = new Set<string>()

  const push = (c: LooseToolCall, snippet: string) => {
    // Dedupe by name + JSON of args so the same call found by two patterns
    // isn't executed twice.
    const key = c.name + '|' + JSON.stringify(c.arguments)
    if (seen.has(key)) return
    seen.add(key)
    calls.push(c)
    if (snippet) matched.push(snippet)
  }

  // 1) Hermes <tool_call>{…}</tool_call> tags (some models emit these in content).
  if (/<tool_call>/i.test(text)) {
    for (const hc of parseHermesToolCalls(text)) {
      if (knownSet.has(hc.name)) push({ name: hc.name, arguments: hc.arguments || {} }, '')
    }
    const tagRe = /<tool_call>[\s\S]*?<\/tool_call>/gi
    let tm: RegExpExecArray | null
    while ((tm = tagRe.exec(text)) !== null) matched.push(tm[0])
  }

  // 2) JSON objects naming a known tool (snippet reported so prose can be cleaned).
  for (const { call, snippet } of parseJsonObjectCalls(text, knownSet)) push(call, snippet)

  // 3) Function-call syntax  name( ... )  — only for known tool names.
  for (const name of knownSet) {
    const re = new RegExp(`\\b${escapeRe(name)}\\s*\\(([\\s\\S]*?)\\)`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const args = parseCallArgs(m[1])
      // Require at least one arg — `image_generate()` with nothing is not a
      // usable call (and is more likely the model naming the tool in prose).
      if (Object.keys(args).length > 0) push({ name, arguments: args }, m[0])
    }
  }

  // 4) Brace / bracket form  name {json}  or  [name {json}]  — only known names.
  //    Phi-4-mini (and other non-Hermes small models) emit the args as a JSON
  //    object placed AFTER the bare name, sometimes wrapped in [ ], with NO
  //    `name` key inside the brace (so patterns 2/3 miss it). Observed live:
  //    `[file_read {"path": "/package.json"}]`. Require a non-empty object so a
  //    stray `tool {}` or prose brace isn't misread as a call.
  for (const name of knownSet) {
    // Locate the bare name, then take the BALANCED object after it. The old
    // regex could only express one level of nesting, so `{"a":{"b":{"c":1}}}`
    // and any content string with braces fell outside it.
    const nameRe = new RegExp(`\\[?\\s*\\b${escapeRe(name)}\\b\\s*(?=\\{)`, 'g')
    let m: RegExpExecArray | null
    while ((m = nameRe.exec(text)) !== null) {
      const obj = balancedObjectAt(text, m.index + m[0].length)
      if (!obj) continue
      nameRe.lastIndex = obj.end // never rescan inside the object we just took
      const parsed = repairJson(obj.text)
      if (!parsed) continue
      // The brace may BE the args, or wrap them under arguments/parameters.
      const inner = parsed.arguments ?? parsed.parameters ?? prop(parsed, 'args') ?? prop(parsed, 'params')
      const args: Record<string, unknown> = isRecord(inner) ? inner : parsed
      if (Object.keys(args).length > 0) {
        let end = obj.end
        const closer = text.slice(end).match(/^\s*\]/)
        if (closer) end += closer[0].length
        push({ name, arguments: args }, text.slice(m.index, end))
      }
    }
  }

  return { calls, matched }
}

// Common near-miss tool names small models emit instead of the registered ones
// (gemma4 live: called `video_generation` → "Unknown tool" → gave up). Maps to
// the canonical builtin names. Only applied when the alias target is actually a
// known/registered tool, so this never invents capabilities.
const TOOL_NAME_ALIASES: Record<string, string> = {
  image_generation: 'image_generate', generate_image: 'image_generate', imagegen: 'image_generate',
  create_image: 'image_generate', make_image: 'image_generate', draw_image: 'image_generate', text_to_image: 'image_generate',
  video_generation: 'video_generate', generate_video: 'video_generate', videogen: 'video_generate',
  create_video: 'video_generate', make_video: 'video_generate', animate: 'video_generate', animate_image: 'video_generate',
  text_to_video: 'video_generate', image_to_video: 'video_generate',
  web: 'web_search', search: 'web_search', fetch: 'web_fetch', read_file: 'file_read', write_file: 'file_write',
  list_files: 'file_list', search_files: 'file_search', run_shell: 'shell_execute', run_code: 'code_execute',
  // Retired targets (A9). These resolve only because the retired list is the
  // second ladder in canonicalToolName; while the name was registered they
  // were dead weight, and the moment it retired they became the difference
  // between a redirect and a wasted step.
  execute_code: 'code_execute', run_python: 'code_execute', python_exec: 'code_execute',
  run_test: 'run_tests', test_run: 'run_tests',
  list_processes: 'process_list', current_time: 'get_current_time',
}

/** Exact → lowercase → alias → punctuation-insensitive. Undefined if none hit. */
function matchKnown(name: string, known: readonly string[]): string | undefined {
  if (!name) return undefined
  if (known.includes(name)) return name
  const lc = name.toLowerCase()
  if (known.includes(lc)) return lc
  const alias = TOOL_NAME_ALIASES[lc]
  if (alias && known.includes(alias)) return alias
  // Punctuation/casing-insensitive equality (videoGenerate, video-generate…).
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const target = norm(name)
  for (const k of known) if (norm(k) === target) return k
  return undefined
}

/**
 * Transport noise a model (or a proxy that half-parses its format) can wrap
 * around the bare tool name. Two shapes seen live on gpt-oss via LU Cloud,
 * 2026-07-24:
 *
 *   file_edit<|channel|>commentary   harmony control token leaked into the
 *                                    recipient field, so EVERY write tool call
 *                                    came back "Unknown tool" and the model
 *                                    burned a minute retrying the same name
 *   functions.file_edit              the harmony recipient namespace, verbatim
 *
 * Cutting at the first character a registered name can never contain is safe:
 * builtin names are [a-z_], so the cut can shorten a name but can never turn
 * one tool into a different one. The namespace strip is only ever ACCEPTED by
 * the caller when the tail matches a registered tool, which keeps MCP tools
 * that legitimately carry dots intact.
 */
function toolNameCandidates(name: string): string[] {
  const cut = name.trim().match(/^[A-Za-z0-9_.-]+/)?.[0] ?? ''
  if (!cut) return []
  const dot = cut.lastIndexOf('.')
  return dot > 0 ? [cut, cut.slice(dot + 1)] : [cut]
}

/**
 * Map a model-emitted tool name to a registered one. Tries the name as sent,
 * then the same ladder on the name with transport noise stripped. Returns the
 * original name unchanged when no confident match exists (so genuinely unknown
 * tools still error rather than being silently rerouted).
 */
export function canonicalToolName(name: string, known: string[]): string {
  if (!name) return name
  // Registered tools first, all the way down the ladder, THEN the retired
  // names (A9). Order is the safety property: a live tool can never lose a
  // call to a retired one, and a name that is neither still comes back
  // unchanged so the executor can say "Unknown tool" honestly.
  for (const list of [known, RETIRED_NAMES]) {
    const direct = matchKnown(name, list)
    if (direct) return direct
    for (const candidate of toolNameCandidates(name)) {
      if (candidate === name) continue
      const hit = matchKnown(candidate, list)
      if (hit) return hit
    }
  }
  return name
}

/** Remove the matched call snippets from a prose answer (best-effort). */
export function stripMatchedCalls(text: string, matched: string[]): string {
  let out = text
  for (const snip of matched) {
    if (snip) out = out.split(snip).join('')
  }
  // Tidy leftover empty code fences / blank lines.
  return out.replace(/```(?:json|python|tool_code)?\s*```/gi, '').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Strip ANY recognizable tool-call text (JSON object, function-syntax, Hermes
 * tag, or a fenced ```json block that is actually a call) out of a model's
 * VISIBLE prose. Unlike the loose-parse → strip path (which only runs when the
 * native channel produced nothing), this is meant to run on EVERY turn's
 * content so a model that emits a proper native call AND echoes the same call
 * as text doesn't leak raw JSON into the chat as a "notes"/JSON block.
 *
 * Only `known` tool names are recognized, so ordinary prose with stray braces
 * is left intact. Tool args/results remain in the agent's internal history —
 * this only cleans what the USER sees in the bubble.
 */
export function stripToolCallText(text: string, known: string[]): string {
  if (!text || !text.trim()) return ''
  const { matched } = parseLooseToolCalls(text, known)
  let out = stripMatchedCalls(text, matched)
  // Drop fenced code blocks whose body is a tool call (```json {"name":…}```).
  out = out.replace(/```(?:json|tool_code|tool|python)?\s*([\s\S]*?)```/gi, (m, inner) => {
    const looksLikeCall =
      /["']?(?:name|tool|function)["']?\s*[:=]/.test(inner) &&
      /["']?(?:arguments|parameters|params|prompt)["']?\s*[:=]/.test(inner)
    return looksLikeCall ? '' : m
  })
  // A fence whose BODY was consumed by the strip above still leaves its
  // container behind. Live Agent run on the ship exe (2026-07-25): the model
  // wrote both of its calls as one ```json ARRAY next to perfectly good native
  // tool_calls, the two objects were lifted out by range, and the bubble was
  // left showing a "notes" block containing `[` , `,` , `]`. A fence with no
  // letter or digit left in it carries nothing for the user, so drop it whole.
  out = out.replace(/```[a-z_]*\s*([\s\S]*?)```/gi, (m, inner) =>
    /[A-Za-z0-9]/.test(inner) ? m : '')
  return out
    // Strip special-token tool-call wrappers some models leave in the prose
    // (Phi-4: <|tool_call|>/<|tool|>; Mistral: [TOOL_CALLS]) so they don't show
    // in the bubble. Detection/parsing above already handled the JSON inside.
    .replace(/<\|\/?tool(?:_call)?(?:_start|_end)?\|>/gi, '')
    // The plain Hermes spelling with no pipes. stripToolCallTags only removes
    // MATCHED pairs, so an unclosed `<tool_call>` (a stream that ended mid-tag,
    // a model that opened one and then answered in prose) walked all the way to
    // the bubble — where the markdown renderer swallowed the `<t` and left the
    // user staring at a bare `ool_call>` (live Agent run, ship exe 2026-07-25).
    .replace(/<[|/\s]*tool_calls?[|/\s]*>/gi, '')
    // A whole line that is nothing but a tool-call tag, INCLUDING a truncated
    // one. Captured from the wire on the ship exe, 2026-07-25: Qwen3-32B on LU
    // Cloud sent `</think>\n\nool_call>` as its content, next to a perfectly
    // good native tool_calls array. The provider's own parser had already eaten
    // the `<t`, so every pattern that starts at `<` misses the remainder and it
    // renders as a stray `ool_call>` above the answer. We cannot stop the model
    // doing it; we can stop showing it. Line-anchored, so prose can never match.
    .replace(/^[ \t]*<?[|/]*t?ool_calls?[|/]*>[ \t]*$/gim, '')
    .replace(/\[\/?TOOL_CALLS?\]/gi, '')
    .replace(/```(?:json|tool_code)?\s*```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
