/**
 * GH #197: the pure parts of the long text field (components/ui/LongTextField).
 */

export interface TextMatch {
  start: number
  end: number
}

/** Most hits a search counts. A one-letter search in a 40,000 token prompt
 *  would otherwise build tens of thousands of entries per key. */
export const MAX_MATCHES = 5000

/** Every place `query` occurs in `text`, ignoring case, in order. */
export function findMatches(text: string, query: string): TextMatch[] {
  if (!query) return []
  const hay = text.toLowerCase()
  const needle = query.toLowerCase()
  const out: TextMatch[] = []
  let at = hay.indexOf(needle)
  while (at !== -1 && out.length < MAX_MATCHES) {
    out.push({ start: at, end: at + needle.length })
    at = hay.indexOf(needle, at + needle.length)
  }
  return out
}

/** 12345 → "12,345", the same in every locale so tests and screens agree. */
export function formatCount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const PREFIX = 'lu-long-text-height:'
/** A height outside this range is a broken entry, not a choice. */
const MIN_HEIGHT = 40
const MAX_HEIGHT = 4000

/** The height a person dragged this field to, in px, or undefined. */
export function readFieldHeight(key: string): number | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) && n >= MIN_HEIGHT && n <= MAX_HEIGHT ? Math.round(n) : undefined
  } catch {
    return undefined
  }
}

export function writeFieldHeight(key: string, height: number): void {
  if (!Number.isFinite(height) || height < MIN_HEIGHT || height > MAX_HEIGHT) return
  try {
    localStorage.setItem(PREFIX + key, String(Math.round(height)))
  } catch {
    // Private window or full storage: the field just opens at its default.
  }
}
