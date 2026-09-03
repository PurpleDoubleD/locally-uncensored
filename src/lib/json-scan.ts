/**
 * Balanced-object scanning for LOOSE model output (2026-07-28).
 *
 * Small local models wrap their JSON in prose and, worse, put code inside it.
 * A depth counter that ignores string literals therefore miscounts on the very
 * payload the agent uses most: a `file_write` whose content holds a regex
 * (`/\{/`), a CSS rule cut mid-block, or a stray closing brace. Measured
 * against the old scanners: a lone `{` inside the content made the tool call
 * VANISH (zero candidates — the model thinks it wrote the file, nothing
 * happened), and a lone `}` truncated the object one brace early so the
 * arguments came out wrong.
 *
 * Everything here is string- and escape-aware, so braces inside JSON strings
 * are text, not structure.
 */

/** Walk from `from` to the balanced end of the object that starts there. */
export function balancedObjectAt(text: string, from: number): { text: string; end: number } | null {
  let i = from
  while (i < text.length && text[i] !== '{') {
    if (!/\s/.test(text[i])) return null // something other than whitespace first
    i++
  }
  if (i >= text.length) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let j = i; j < text.length; j++) {
    const ch = text[j]
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = inString; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { text: text.slice(i, j + 1), end: j + 1 }
    }
  }
  return null // never closed
}

/** Every top-level balanced object in `text`, outermost only. */
export function findBalancedObjects(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    const obj = balancedObjectAt(text, i)
    if (!obj) continue
    out.push(obj.text)
    i = obj.end - 1 // skip past it; nested objects are part of this one
  }
  return out
}

/**
 * First balanced object in `text` that actually parses as JSON.
 *
 * The value is `unknown`: it came out of a language model, and the only thing
 * the scan proves is that the braces matched. Callers check what they read.
 */
export function extractJsonObject(text: string): unknown {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    const obj = balancedObjectAt(text, i)
    if (!obj) continue
    try {
      return JSON.parse(obj.text)
    } catch {
      // Not the object we want — keep looking from the next brace.
    }
  }
  return null
}
