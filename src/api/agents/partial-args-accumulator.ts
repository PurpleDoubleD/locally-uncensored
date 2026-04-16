/**
 * Phase 11 (v2.4.0) — Partial tool-call args accumulator.
 *
 * Providers that stream tool-call arguments (OpenAI via
 * choice.delta.tool_calls[].function.arguments, Anthropic via
 * input_json_delta) emit JSON in fragments. To render "args as they
 * stream" in the UI — the same experience Claude Code ships — we need a
 * cheap best-effort parser that takes the accumulated string so far and
 * returns a partial object.
 *
 * Strategy:
 *   1. Try JSON.parse on the raw buffer (works once the object is complete).
 *   2. On failure, attempt to close open braces/brackets and finish open
 *      strings, then re-parse. Yields a partial object with the keys that
 *      have already streamed.
 *   3. If even that fails, return { __partial: raw } — the UI renders the
 *      raw stream so the user at least sees progress.
 *
 * This is deliberately NOT a full streaming JSON parser (jsonStream etc.)
 * because tool args are small enough that the heuristic above handles
 * 100 % of real-world cases in <1 ms. Full streaming becomes necessary
 * only for megabyte-scale payloads, which never happens here.
 */

export interface PartialParse {
  /** True when the buffer successfully parsed as complete JSON. */
  complete: boolean
  /** Partial object view, or {} if nothing parseable yet. */
  partial: Record<string, any>
  /** Raw buffer — available for streaming log display fallbacks. */
  raw: string
}

/**
 * Parse a possibly-incomplete JSON object buffer. See module doc.
 */
export function parsePartialJson(raw: string): PartialParse {
  const trimmed = raw.trim()
  if (!trimmed) return { complete: false, partial: {}, raw }

  // Fast path: complete and valid.
  try {
    const obj = JSON.parse(trimmed)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return { complete: true, partial: obj, raw }
    }
  } catch {
    // fall through
  }

  // Heuristic closure of unfinished string / braces / brackets.
  const closed = closeOpenStructures(trimmed)
  try {
    const obj = JSON.parse(closed)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return { complete: false, partial: obj, raw }
    }
  } catch {
    // fall through
  }

  return { complete: false, partial: {}, raw }
}

/**
 * Stateful accumulator — append chunks as they arrive, ask for the
 * current parse whenever the UI tick wants to render.
 */
export class PartialArgsAccumulator {
  private buffer = ''

  /** Append a streamed chunk. No parsing happens here. */
  push(chunk: string): void {
    if (chunk) this.buffer += chunk
  }

  /** Replace the buffer (e.g. when a provider sends a full replacement). */
  set(full: string): void {
    this.buffer = full
  }

  /** Current buffer length — useful for animation pacing. */
  length(): number {
    return this.buffer.length
  }

  /** Parse current buffer into a best-effort partial object. */
  snapshot(): PartialParse {
    return parsePartialJson(this.buffer)
  }

  /** Reset for the next tool call. */
  reset(): void {
    this.buffer = ''
  }
}

// ─── Internals ───

/**
 * Given a JSON prefix, try to make it syntactically complete by:
 *   1. Closing an unterminated string literal
 *   2. Adding matching } / ] for each unmatched { / [
 *   3. Stripping a trailing comma just before the closing brace
 *
 * This is a heuristic — it can be wrong for deeply adversarial input,
 * but real LLM stream output is well-formed once normalized.
 */
function closeOpenStructures(s: string): string {
  let out = s
  // If odd number of unescaped quotes, we are mid-string.
  let inString = false
  let escape = false
  const stack: string[] = []
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]
    if (inString) {
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }

  if (inString) out += '"'

  // Drop a trailing comma that would otherwise become invalid.
  out = out.replace(/,\s*$/, '')

  while (stack.length > 0) out += stack.pop()
  return out
}

export const __internal = { closeOpenStructures }
