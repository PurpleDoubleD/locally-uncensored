/**
 * Tool Call Repair — fixes broken JSON from local LLMs.
 *
 * Common issues:
 * - Trailing commas in JSON objects/arrays
 * - Single quotes instead of double quotes
 * - Missing closing braces/brackets
 * - Unquoted property names
 * - Extra text before/after JSON
 * - Escaped quotes inside strings
 *
 * Every repair below is STRING-AWARE and applied one at a time, retrying the
 * parse after each. The earlier version rewrote the whole text blindly and
 * therefore destroyed the payloads it was meant to rescue (measured
 * 2026-07-28): `'` → `"` turned `print('hello')` and the apostrophe in
 * "doesn't" into stray delimiters, the bare-key regex rewrote `a { color: red`
 * inside a CSS string, and brace COUNTING (rather than depth) both miscounted
 * braces inside strings and appended `}` before `]`, so `{"a": [1, 2` closed as
 * `{"a": [1, 2}]`. A file_write whose content is code hit at least one of these
 * almost every time.
 */

import { balancedObjectAt, findBalancedObjects } from './json-scan'
import { isRecord } from '../types/json-guards'

/**
 * What a repair attempt hands back.
 *
 * The input is model output, so the JSON value can be anything — but this
 * module has one subject, the object a model writes when it means to call a
 * tool, and its own last-resort branch below MANUFACTURES exactly that shape.
 * So the result type names the three fields callers read without checking,
 * and {@link asRepairedJson} makes them true instead of merely claiming them:
 * a `name` survives only if the model wrote a string, `arguments` /
 * `parameters` only if they resolve to an object. Every other key stays
 * `unknown` and has to be checked at the point of use.
 */
export interface RepairedJson {
  /** Tool name — present only when the model wrote it as a string. */
  name?: string
  /** Argument object — present only when it is (or repairs to) an object. */
  arguments?: Record<string, unknown>
  /** The other spelling half the small models use. Same guarantee. */
  parameters?: Record<string, unknown>
  /** Anything else the model wrote. */
  [key: string]: unknown
}

/**
 * An `arguments` / `parameters` value, reduced to an object or nothing.
 *
 * The string branch is not cosmetic: OpenAI-shaped producers serialise the
 * argument object into a JSON STRING, and every consumer of this module reads
 * `parsed.arguments.something` straight away. Resolving it here is the same
 * normalisation `repairToolCallArgs` performs one level up.
 */
function argumentObject(v: unknown): Record<string, unknown> | undefined {
  if (isRecord(v)) return v
  if (typeof v === 'string') {
    const inner = tryRepair(v)
    if (isRecord(inner)) return inner
  }
  return undefined
}

/**
 * Present a parsed JSON value as {@link RepairedJson}.
 *
 * A scalar (number, string, boolean, null) is not a repaired call and comes
 * back as `null`: no caller can read a property off one, so all of them
 * already treated such a value as a miss.
 *
 * A RECORD is rebuilt rather than relabelled, so the three declared fields are
 * true of the returned value instead of merely claimed about it.
 *
 * An ARRAY is handed back unchanged — `repairJson('[1,2,3]')` returning the
 * array is pinned behaviour. That step is the module's one cast, and it is
 * sound: all three declared fields are OPTIONAL, and every one of them reads
 * `undefined` off an array, which is exactly what the optional markers
 * promise. TypeScript refuses the plain assignment only because an array
 * carries no STRING index signature, not because one of these reads could
 * mislead anybody; `Array.isArray` still tells the two containers apart.
 */
function asRepairedJson(v: unknown): RepairedJson | null {
  if (Array.isArray(v)) return v as unknown as RepairedJson
  if (!isRecord(v)) return null
  const out: RepairedJson = {}
  for (const [k, val] of Object.entries(v)) out[k] = val
  if (typeof v.name === 'string') out.name = v.name
  else delete out.name
  const args = argumentObject(v.arguments)
  if (args) out.arguments = args
  else delete out.arguments
  const params = argumentObject(v.parameters)
  if (params) out.parameters = params
  else delete out.parameters
  return out
}

/**
 * Attempt to repair broken JSON from a tool call.
 * Returns parsed object or null if unfixable.
 */
export function repairJson(raw: string): RepairedJson | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // The text as-is first (covers arrays and whole single-quoted objects), then
  // each balanced {...} inside it (covers a model wrapping its call in prose),
  // then the tail from the first opener (covers a call that was never closed).
  const candidates = [trimmed, ...findBalancedObjects(trimmed)]
  const firstBrace = trimmed.indexOf('{')
  if (firstBrace > 0) candidates.push(trimmed.slice(firstBrace))
  const firstBracket = trimmed.indexOf('[')
  if (firstBracket > 0) candidates.push(trimmed.slice(firstBracket))

  for (const candidate of candidates) {
    const parsed = tryRepair(candidate)
    if (parsed !== undefined) {
      const repaired = asRepairedJson(parsed)
      if (repaired) return repaired
    }
  }

  // Last resort: pull the name out with a regex and balance the args object.
  const nameMatch = raw.match(/["']?name["']?\s*[:=]\s*["']([^"']+)["']/i)
  if (nameMatch) {
    let args: Record<string, unknown> = {}
    const argsKey = /["']?(?:arguments|args|parameters|input)["']?\s*[:=]\s*(?=\{)/i.exec(raw)
    if (argsKey) {
      const obj = balancedObjectAt(raw, argsKey.index + argsKey[0].length)
      const parsed = obj ? tryRepair(obj.text) : undefined
      if (isRecord(parsed)) args = parsed
    }
    return { name: nameMatch[1], arguments: args }
  }

  return null
}

/**
 * Parse `src`, applying one repair at a time and retrying after each.
 *
 * `undefined` means "did not parse". JSON has no `undefined`, so the sentinel
 * can never collide with a real result (`null` is a legal parse and is
 * reported as such).
 */
function tryRepair(src: string): unknown {
  let s = src.trim()
  if (!s) return undefined

  const attempt = (t: string): unknown => {
    try { return JSON.parse(t) } catch { return undefined }
  }

  let parsed = attempt(s)
  if (parsed !== undefined) return parsed

  for (const repair of [requoteSingleQuoted, dropTrailingCommas, quoteBareKeys, closeOpenContainers]) {
    const next = repair(s)
    if (next === s) continue
    parsed = attempt(next)
    if (parsed !== undefined) return parsed
    s = next
  }

  return undefined
}

/** Apply `[start, end) → text` edits back-to-front so earlier indices hold. */
function applyEdits(src: string, edits: Array<{ start: number; end: number; text: string }>): string {
  if (edits.length === 0) return src
  let out = src
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }
  return out
}

/**
 * Visit every character that sits OUTSIDE a double-quoted string. This is the
 * whole point of the rewrite: braces, commas and colons inside a string value
 * are the model's payload, not JSON structure.
 */
function eachStructuralChar(src: string, visit: (i: number, ch: string) => void): void {
  let inString = false
  let escaped = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = inString; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    visit(i, ch)
  }
}

function skipSpace(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i])) i++
  return i
}

/**
 * Turn single-quoted STRING LITERALS into double-quoted ones. An apostrophe
 * inside an already double-quoted string is left alone — that was the bug.
 */
function requoteSingleQuoted(src: string): string {
  const edits: Array<{ start: number; end: number; text: string }> = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"') { // a real string — skip it whole, apostrophes and all
      i++
      while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1
      i++
      continue
    }
    if (ch === "'") {
      let j = i + 1
      let body = ''
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\') { body += src[j] + (src[j + 1] ?? ''); j += 2; continue }
        body += src[j]
        j++
      }
      if (j >= src.length) break // unterminated — leave it for another pass
      edits.push({ start: i, end: j + 1, text: `"${body.replace(/"/g, '\\"')}"` })
      i = j + 1
      continue
    }
    i++
  }
  return applyEdits(src, edits)
}

/** Drop a `,` that is followed by `}` or `]`, outside strings. */
function dropTrailingCommas(src: string): string {
  const edits: Array<{ start: number; end: number; text: string }> = []
  eachStructuralChar(src, (i, ch) => {
    if (ch !== ',') return
    const next = skipSpace(src, i + 1)
    if (src[next] === '}' || src[next] === ']') edits.push({ start: i, end: i + 1, text: '' })
  })
  return applyEdits(src, edits)
}

/** Quote bare property names: `{ key: 1 }` → `{ "key": 1 }`, outside strings. */
function quoteBareKeys(src: string): string {
  const edits: Array<{ start: number; end: number; text: string }> = []
  eachStructuralChar(src, (i, ch) => {
    if (ch !== '{' && ch !== ',') return
    const start = skipSpace(src, i + 1)
    if (!/[A-Za-z_$]/.test(src[start] ?? '')) return
    let end = start
    while (end < src.length && /[\w$]/.test(src[end])) end++
    if (src[skipSpace(src, end)] !== ':') return
    edits.push({ start, end, text: `"${src.slice(start, end)}"` })
  })
  return applyEdits(src, edits)
}

/**
 * Close containers the model left open, innermost first. Counting openers and
 * closers separately (the old approach) appended `}` before `]`, so a truncated
 * `{"a": [1, 2` was "repaired" into `{"a": [1, 2}]`.
 */
function closeOpenContainers(src: string): string {
  const stack: string[] = []
  eachStructuralChar(src, (_i, ch) => {
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
    else if ((ch === '}' || ch === ']') && stack[stack.length - 1] === ch) stack.pop()
  })
  if (stack.length === 0) return src
  return src + stack.reverse().join('')
}

/**
 * Repair tool call arguments that might be a string instead of object.
 */
export function repairToolCallArgs(args: unknown): Record<string, unknown> {
  // `isRecord` rather than the old `typeof === 'object'`: an ARRAY passed that
  // test and was handed on as if it were an argument object. Nothing could
  // read a named argument off it, so the tool failed either way — but the
  // declared type said otherwise. Arrays now resolve to `{}` honestly.
  if (isRecord(args)) return args
  // An array is not an argument object — nothing can read a named argument off
  // one — but handing it back is pinned behaviour, and the label is sound for
  // reads for the same reason spelled out on asRepairedJson.
  if (Array.isArray(args)) return args as unknown as Record<string, unknown>
  if (typeof args === 'string') {
    const parsed = repairJson(args)
    if (parsed) return parsed
  }
  return {}
}

/**
 * Extract tool calls from model content when native tool calling fails.
 * Looks for JSON patterns that look like tool calls.
 */
export function extractToolCallsFromContent(content: string): { name: string; arguments: Record<string, unknown> }[] {
  return extractToolCallsWithRanges(content).calls
}

/**
 * Does this text read as "the model wants to call a tool"? Used for the
 * thought-only empty-reply case (live find 2026-06-11): gemma4, primed by
 * remembered tool results, spends the whole turn reasoning "I need to use the
 * web_search tool", emits zero content and stops — the REASONING is the only
 * evidence of intent. Matches a structured call shape anywhere in the text or
 * one of LU's builtin tool names used as an identifier.
 */
export function looksLikeToolIntent(text: string): boolean {
  if (!text) return false
  if (extractToolCallsFromContent(text).length > 0) return true
  // name({...}) / name(query=…) call shapes, or an LU builtin named verbatim.
  if (/\b[a-z][a-z0-9_]{2,}\s*\(\s*[{"']/.test(text)) return true
  return /\b(web_search|web_fetch|image_generate|video_generate|file_read|file_write|file_list|file_search|shell_execute|system_info)\b/.test(text)
}

/**
 * Like extractToolCallsFromContent but also returns the `[startIdx, endIdx]`
 * range each tool-call occupies in `content`. Callers can use the ranges to
 * strip the raw JSON from the displayed content after extraction so the user
 * sees a clean chat bubble instead of the rattling JSON stream that small
 * models (qwen2.5-coder:3b) emit.
 */
export function extractToolCallsWithRanges(content: string): {
  calls: { name: string; arguments: Record<string, unknown> }[]
  ranges: Array<[number, number]>
} {
  const calls: { name: string; arguments: Record<string, unknown> }[] = []
  const ranges: Array<[number, number]> = []

  // Pattern 1: {"name": "tool_name", "arguments": {...}}
  //
  // The naive regex `\{[^}]*\}` fails for ANY JSON with nested braces OR for
  // string values containing `{` (e.g. Python f-strings `f'Hello, {name}!'`
  // emitted by qwen2.5-coder). Replace with a locate-header-then-balance
  // scanner: find the `"arguments":` key, then walk the character stream
  // respecting string escapes to find the matching `}`.
  const headerRe = /"(?:name|tool|function)"\s*:\s*"([^"]+)"\s*,\s*"(?:arguments|args|parameters|input)"\s*:\s*\{/gi
  let m: RegExpExecArray | null
  while ((m = headerRe.exec(content)) !== null) {
    const toolName = m[1]
    const argsStart = headerRe.lastIndex - 1 // the `{` of arguments object
    const argsEnd = findBalancedBraceEnd(content, argsStart)
    if (argsEnd < 0) continue
    const argsJson = content.slice(argsStart, argsEnd + 1)
    const args = repairJson(argsJson)
    if (isRecord(args)) {
      calls.push({ name: toolName, arguments: args })
      // The full tool-call JSON range: walk backwards from m.index to include
      // the opening `{` of the outer wrapper, and walk forward from argsEnd
      // to include the closing `}` of the wrapper (one level out).
      const outerStart = findPrecedingOpenBrace(content, m.index)
      const outerEnd = findBalancedBraceEnd(content, outerStart >= 0 ? outerStart : m.index)
      ranges.push([
        outerStart >= 0 ? outerStart : m.index,
        outerEnd > argsEnd ? outerEnd : argsEnd,
      ])
    }
    headerRe.lastIndex = argsEnd + 1
  }

  // Pattern 2: tool_name(arg1, arg2) — function call syntax
  if (calls.length === 0) {
    const pattern2 = /\b(web_search|web_fetch|file_read|file_write|file_list|file_search|shell_execute|code_execute|system_info|process_list|screenshot)\s*\(\s*([^)]*)\)/gi
    let match: RegExpExecArray | null
    while ((match = pattern2.exec(content)) !== null) {
      ranges.push([match.index, match.index + match[0].length - 1])
      const argStr = match[2].trim()
      let args: Record<string, unknown> = {}
      if (argStr) {
        // Try to parse as JSON
        const parsed = repairJson(`{${argStr}}`)
        if (isRecord(parsed)) args = parsed
        else {
          // Simple single-argument: treat as the first required param
          args = { query: argStr.replace(/^["']|["']$/g, '') }
        }
      }
      calls.push({ name: match[1], arguments: args })
    }
  }

  return { calls, ranges }
}

/**
 * Scan backwards from `fromIdx` and return the index of the nearest
 * preceding `{` that is NOT inside a string. Returns -1 if none found.
 * Used to locate the outer wrapper `{` of a tool-call JSON so the full
 * object (not just its `arguments` sub-object) can be stripped from the
 * displayed content after extraction.
 */
function findPrecedingOpenBrace(src: string, fromIdx: number): number {
  // Simple backwards scan — we assume the small window we inspect is not
  // inside a string that starts before fromIdx; in practice the outer
  // wrapper `{` is always at most a few dozen chars back with whitespace
  // and commentary in between.
  for (let i = fromIdx - 1; i >= Math.max(0, fromIdx - 200); i--) {
    if (src[i] === '{') return i
  }
  return -1
}

/**
 * Strip the text ranges `[start,end]` out of `content` and return the
 * cleaned-up result. Ranges are sliced in reverse order so earlier indices
 * stay valid. Also removes orphan ```json / ``` code fences that wrapped
 * the now-removed JSON.
 */
export function stripRanges(content: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return content
  const sorted = [...ranges].sort((a, b) => b[0] - a[0])
  let out = content
  for (const [start, end] of sorted) {
    if (start < 0 || end < start) continue
    out = out.slice(0, start) + out.slice(end + 1)
  }
  // Remove orphan fence lines left behind by the JSON strip.
  out = out.replace(/```(?:json)?\s*\n?\s*```/g, '')
  // Remove the tool-call TAGS the JSON sat inside. We only strip the JSON range
  // itself above, so a model that wraps its call in the Hermes tags leaves
  // `<tool_call>` and `</tool_call>` behind — and the renderer eats the first
  // two characters of an unknown tag, so the user sees a stray `ool_call>` in
  // the transcript (live Agent run on the ship exe, 2026-07-25). Also covers
  // the `<|tool_call|>` / `[TOOL_CALL]` spellings other families use.
  // The slash sits outside the pipes in some spellings (`</tool_call>`) and
  // inside in others (`<|/tool_call|>`), so allow any mix on either side.
  out = out.replace(/<[|/\s]*tool_calls?[|/\s]*>/gi, '')
  out = out.replace(/\[[/\s]*TOOL_CALLS?[/\s]*\]/gi, '')
  // Collapse 3+ consecutive blank lines down to one blank line so the chat
  // bubble doesn't have a sea of whitespace where the JSON used to be.
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

/**
 * Walk JSON starting at `start` (which must be `{`) and return the index of
 * the matching `}` — respecting string escapes so `{` and `}` inside string
 * literals don't count. Returns -1 if unbalanced/malformed.
 */
function findBalancedBraceEnd(src: string, start: number): number {
  if (src[start] !== '{') return -1
  const obj = balancedObjectAt(src, start)
  return obj ? obj.end - 1 : -1
}
