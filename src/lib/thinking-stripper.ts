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
