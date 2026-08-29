/**
 * Universal thinking-tag stripper — runs during streaming so raw tags never
 * reach the user bubble, regardless of what the model emits.
 *
 * Different model families encode their "internal reasoning" differently:
 *   - Qwen3 / DeepSeek-R1 / QwQ / Hermes3 / Llama / Mistral / GLM / Nemotron
 *     → `<think>…</think>` (inline)
 *   - Gemma 3 / Gemma 4
 *     → `<|?channel|?>\s*thought\s*…` channel tags (inline, often without
 *       a closing tag — Ollama sometimes truncates mid-stream)
 *   - Some abliterated variants or older model cards
 *     → `<thought>…</thought>` / `<reasoning>…</reasoning>` / `<reflect>…</reflect>`
 *
 * The user-visible contract: once the Thinking toggle is OFF, **no** reasoning
 * markup may appear in the assistant bubble. The state-machine in useChat.ts
 * handles the canonical `<think>` case char-by-char; this module handles the
 * non-canonical formats that don't fit that pattern (channel tags, alt names,
 * orphan open-tags without matching close).
 */

// ── Patterns, ordered most specific first ─────────────────────────────
//
// Every pattern must use the `g` (global) flag. `stripInline` loops them
// across the full content on every emitted chunk.

const BLOCK_PATTERNS: RegExp[] = [
  // Gemma channel tag with full block (open + close, sometimes the close uses
  // a different pipe shape).
  /<\|?channel\|?>\s*thought\b[\s\S]*?<\/\|?channel\|?>/gi,
  // Alt thinking-tag names that a small fraction of model cards emit.
  /<thought>[\s\S]*?<\/thought>/gi,
  /<reasoning>[\s\S]*?<\/reasoning>/gi,
  /<reflect>[\s\S]*?<\/reflect>/gi,
  /<deepthink>[\s\S]*?<\/deepthink>/gi,
]

// Orphan opening tags — channel tag that never closes in the stream, or an
// opening `<|channel|>thought` / `<thought>` when the close is still arriving.
// We remove the opening marker aggressively so the user never sees "thought"
// mid-stream; if a closing marker later arrives it gets stripped by the
// BLOCK_PATTERNS on the full-content pass.
const ORPHAN_OPENERS: RegExp[] = [
  /<\|?channel\|?>\s*thought\b/gi,
  /<\|?channel\|?>/gi,
  /<channel\|>/gi,
]

/**
 * Strip every recognised thinking-tag format from `content`. Safe to call
 * on an in-progress stream buffer — blocks are only removed when both ends
 * are present; orphan openers are removed eagerly so unclosed channel tags
 * don't leak into the UI.
 *
 * This is the FULL strip — use when thinking is toggled OFF.
 */
export function stripAllThinkingTags(content: string): string {
  if (!content) return content
  let out = content
  for (const pat of BLOCK_PATTERNS) {
    out = out.replace(pat, '')
  }
  for (const pat of ORPHAN_OPENERS) {
    out = out.replace(pat, '')
  }
  return out
}

/**
 * Strip non-canonical thinking tags (channel tags, alt names, orphan openers)
 * but leave the canonical `<think>…</think>` alone — useChat.ts state-machine
 * handles those char-by-char and needs to see the raw `<think>` marker to
 * detect the transition.
 *
 * Use this inside the char-by-char state-machine path.
 */
export function stripNonCanonicalTags(content: string): string {
  if (!content) return content
  let out = content
  for (const pat of BLOCK_PATTERNS) {
    out = out.replace(pat, '')
  }
  for (const pat of ORPHAN_OPENERS) {
    out = out.replace(pat, '')
  }
  return out
}

/**
 * Apply a final safety pass on the complete assistant content after the
 * stream finishes. Catches any orphan closing `</think>` that leaked through
 * (e.g. provider restarted mid-stream, first `<think>` lost).
 */
/**
 * Split off a `<think>` that never got its closer.
 *
 * A turn can end mid-thought: the user pressed Stop, the stream died, or the
 * model walked into the context wall. The balanced `<think>…</think>` regex in
 * the agent loops cannot see that, and `finalStripThinkingTags` deliberately
 * leaves canonical markers alone while the Thinking toggle is ON — so the raw
 * opener plus the entire reasoning text landed in the answer bubble, but only
 * with thinking ON. Found on the installed 2.6.2 build, Coding + Ollama +
 * hermes, after stopping a run mid-turn.
 *
 * Returns the answer without the dangling block, and the reasoning that was in
 * it, so the caller can route it into the thinking panel instead of dropping
 * text the model actually produced.
 */
export function splitUnclosedThink(content: string): { content: string; thinking: string } {
  if (!content) return { content, thinking: '' }
  const open = content.lastIndexOf('<think>')
  if (open === -1) return { content, thinking: '' }
  // A closer after the last opener means the block is balanced, not orphaned.
  if (content.indexOf('</think>', open) !== -1) return { content, thinking: '' }
  return {
    content: content.slice(0, open),
    thinking: content.slice(open + '<think>'.length),
  }
}

/**
 * Split off reasoning that arrived with a closer but no opener.
 *
 * The mirror image of `splitUnclosedThink`, and the commoner of the two. Ollama
 * chat templates for the Qwen3 family put the opening `<think>` in the PROMPT,
 * so the model never emits one: what comes back over the wire is the reasoning
 * text, then `</think>`, then the answer. The char-by-char state machine keys
 * on seeing `<think>`, so it never switches, and everything runs through as
 * ordinary content. With the Thinking toggle ON, `finalStripThinkingTags`
 * deliberately leaves canonical markers alone, and the raw `</think>` lands in
 * the answer bubble with the whole thought in front of it.
 *
 * Measured on the installed 2.6.2 build 2026-08-06, Coding + Ollama + hermes,
 * hf.co/DevQuasar/huihui-ai.Qwen3-4B-abliterated-GGUF. Read off the page:
 * "…without stopping. Let's start with the first step. </think>". David has
 * been reporting exactly this: a visible think between the steps that is not
 * styled as thinking.
 *
 * Returns the answer after the closer, and the reasoning that preceded it, so
 * the caller routes it to the thinking panel rather than deleting text the
 * model produced.
 */
export function splitOrphanCloser(content: string): { content: string; thinking: string } {
  if (!content) return { content, thinking: '' }
  const close = content.indexOf('</think>')
  if (close === -1) return { content, thinking: '' }
  // An opener anywhere before it means the block is balanced, not orphaned,
  // and the existing paths own it.
  if (content.lastIndexOf('<think>', close) !== -1) return { content, thinking: '' }
  return {
    content: content.slice(close + '</think>'.length),
    thinking: content.slice(0, close),
  }
}

export function finalStripThinkingTags(content: string, keepCanonicalThink = false): string {
  if (!content) return content
  let out = stripAllThinkingTags(content)
  if (!keepCanonicalThink) {
    // Canonical `<think>` block — strip if still present (shouldn't be,
    // the state-machine handles it, but belt-and-braces).
    out = out.replace(/<think>[\s\S]*?<\/think>/gi, '')
    // Orphan closer alone.
    out = out.replace(/<\/think>/gi, '')
    // Orphan opener alone.
    out = out.replace(/<think>/gi, '')
  }
  return out.trim()
}

/**
 * The end-of-turn settlement, in ONE place for every path.
 *
 * Four call sites used to do this by hand and only two of them did it fully.
 * The agent loop and the coding loop ran the balanced block, then
 * splitOrphanCloser, then splitUnclosedThink, then the final strip. Plain chat
 * and group chat ran the char-by-char state machine and nothing else, and that
 * machine only ever triggers on a literal `<think>`. The Qwen3 chat templates
 * put the opener in the PROMPT: the reply starts mid-thought and only ever
 * sends the closer, the machine never switches, and with the Think button ON
 * `finalStripThinkingTags` deliberately leaves canonical markers alone. So the
 * whole thought plus a raw `</think>` stood in the answer bubble and the
 * thinking block stayed empty. That is a thinking model that visibly does not
 * think, on the two paths a user reaches first.
 *
 * `content` is what the turn produced, `thinking` whatever the native channel
 * already delivered. Returns both, settled: reasoning out of the answer, and
 * into the block when the toggle says so.
 */
export function settleThinking(
  content: string,
  thinking: string,
  keepThinking: boolean,
): { content: string; thinking: string } {
  let out = content
  let think = thinking
  const add = (part: string) => {
    if (!keepThinking || !part) return
    think = think ? `${think}\n\n${part}` : part
  }

  // Balanced blocks first, the common well-formed case.
  out = out.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner: string) => {
    add(inner)
    return ''
  })
  // Closer without opener: the pre-opened Qwen3 thought.
  const closer = splitOrphanCloser(out)
  if (closer.thinking) {
    out = closer.content
    add(closer.thinking)
  }
  // Opener without closer: a turn stopped or cut off mid-thought.
  const opener = splitUnclosedThink(out)
  if (opener.thinking) {
    out = opener.content
    add(opener.thinking)
  }
  // Non-canonical markers (Gemma channel tags, <thought>, <reasoning>, …).
  out = finalStripThinkingTags(out, keepThinking)
  if (!keepThinking) think = ''
  return { content: out, thinking: think }
}
