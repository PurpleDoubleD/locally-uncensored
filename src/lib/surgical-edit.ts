/**
 * Surgical edit primitive — the core of the `file_edit` tool (2.5.9, M1).
 *
 * Replaces exactly ONE unique occurrence of old_string with new_string (or
 * every occurrence with replace_all, or several edits in one call), or
 * reports why it could not (empty / no-op / not found / not unique). This is
 * the small-model-friendly alternative to full-file rewrites: the model sends
 * only the lines it wants changed, so editing a 2000-line file costs a few
 * tokens instead of regenerating the whole thing (slow, and prone to
 * truncation on local models). Aider / Cline / Cursor all edit this way.
 *
 * Pure + dependency-free so it can be unit-tested and shared between the tool
 * executor (api/mcp/builtin-tools.ts) and the diff event emitter (useCodex.ts).
 */

export type EditFailReason = 'empty_old' | 'noop' | 'not_found' | 'not_unique'

export interface EditOutcome {
  ok: boolean
  /** The updated file content — present only when ok. */
  content?: string
  /** How many times old_string occurred (0, 1, or >1). */
  matches: number
  /** Machine-usable reason when !ok. */
  reason?: EditFailReason
  /** The exact text was not there; the whitespace-tolerant line match was used. */
  fuzzy?: boolean
}

/**
 * Line endings, the reason `file_edit` could not touch a Windows file at all.
 *
 * Measured at the wire on the Windows box, 2026-08-15: `file_read` hands the
 * model the raw file, so on Windows it carries CRLF, and the model sends its
 * `old_string` back with plain LF, which is what models emit. A literal search
 * then finds nothing and the user is told the file cannot be edited. Same
 * mismatch as the staged-apply fix, one layer down.
 *
 * So the search runs on one normalized form. The write-back does NOT: this is
 * the surgical tool, so only the matched region is replaced, in the file's own
 * endings, and every byte around it is left exactly as it was.
 */
const toLf = (text: string) => text.replace(/\r\n/g, '\n')

function eolOf(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  return crlf > lf ? '\r\n' : '\n'
}

const withEol = (text: string, eol: '\r\n' | '\n') =>
  eol === '\r\n' ? toLf(text).replace(/\n/g, '\r\n') : toLf(text)

/**
 * Normalize to LF and keep, for every LF position, the index it came from in
 * the original. That is what lets the match be found on the normalized form
 * and the replacement be cut out of the ORIGINAL, so the untouched part of the
 * file never changes shape. The trailing entry is the end marker, so
 * `map[start + needle.length]` is the index just past the match.
 */
function lfWithMap(text: string): { lf: string; map: number[] } {
  let lf = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r' && text[i + 1] === '\n') {
      lf += '\n'
      map.push(i)
      i++
      continue
    }
    lf += text[i]
    map.push(i)
  }
  map.push(text.length)
  return { lf, map }
}

/** Count NON-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

/**
 * Whitespace-tolerant fallback for a missing exact match (30.09.2026).
 *
 * Open models copy code back with the indentation off by a level, tabs turned
 * into spaces or a trailing space lost. The exact search then fails, and the
 * only way on was "read the file again and retry", two more full-context
 * round trips on a paid provider. opencode, Cline and Aider all fall back to a
 * line-wise comparison for this reason.
 *
 * Rule, kept narrow on purpose: compare line by line with leading and trailing
 * whitespace ignored, blank edge lines of old_string dropped, and accept only
 * when exactly ONE window of the file matches. The matched lines are replaced
 * whole, and new_string is shifted from old_string's indentation to the
 * file's, so the result sits at the file's own level.
 */
function fuzzyLineMatch(contentLf: string, oldLf: string, newLf: string):
  { content: string | null; matches: number } {
  const oldLines = oldLf.split('\n')
  while (oldLines.length && oldLines[0].trim() === '') oldLines.shift()
  while (oldLines.length && oldLines[oldLines.length - 1].trim() === '') oldLines.pop()
  if (oldLines.length === 0 || oldLines.join('').trim().length < 2) return { content: null, matches: 0 }
  const fileLines = contentLf.split('\n')
  const want = oldLines.map((l) => l.trim())
  const hits: number[] = []
  for (let i = 0; i + want.length <= fileLines.length; i++) {
    let same = true
    for (let j = 0; j < want.length; j++) {
      if (fileLines[i + j].trim() !== want[j]) { same = false; break }
    }
    if (same) hits.push(i)
  }
  if (hits.length !== 1) return { content: null, matches: hits.length }
  const at = hits[0]
  const indentOf = (l: string) => l.match(/^[ \t]*/)![0]
  const fileIndent = indentOf(fileLines[at])
  const oldIndent = indentOf(oldLines[0])
  let newLines = newLf.split('\n')
  if (fileIndent !== oldIndent && newLines.every((l) => l.trim() === '' || l.startsWith(oldIndent))) {
    newLines = newLines.map((l) => (l.trim() === '' ? l : fileIndent + l.slice(oldIndent.length)))
  }
  const out = [...fileLines.slice(0, at), ...newLines, ...fileLines.slice(at + want.length)]
  return { content: out.join('\n'), matches: 1 }
}

/**
 * Apply one replacement. By default `oldString` must occur exactly once: an
 * ambiguous match is refused rather than silently changing the wrong spot.
 * `replaceAll` replaces every exact occurrence instead (renames). Without an
 * exact match the whitespace-tolerant line match above gets one try.
 */
export function applyUniqueEdit(content: string, oldString: string, newString: string, replaceAll = false): EditOutcome {
  if (oldString === '') return { ok: false, matches: 0, reason: 'empty_old' }
  const { lf: contentLf, map } = lfWithMap(content)
  const oldLf = toLf(oldString)
  const newLf = toLf(newString)
  const matches = countOccurrences(contentLf, oldLf)
  if (oldLf === newLf) return { ok: false, matches, reason: 'noop' }
  if (matches === 0) {
    const fuzzy = fuzzyLineMatch(contentLf, oldLf, newLf)
    if (fuzzy.content === null) {
      return fuzzy.matches > 1
        ? { ok: false, matches: fuzzy.matches, reason: 'not_unique' }
        : { ok: false, matches: 0, reason: 'not_found' }
    }
    return { ok: true, content: withEol(fuzzy.content, eolOf(content)), matches: 1, fuzzy: true }
  }
  if (matches > 1 && !replaceAll) return { ok: false, matches, reason: 'not_unique' }
  if (replaceAll) {
    const updated = withEol(contentLf.split(oldLf).join(newLf), eolOf(content))
    return { ok: true, content: updated, matches }
  }
  // Exactly one occurrence. Cut it out of the ORIGINAL by index instead of
  // running a replace over the normalized copy: that keeps every byte outside
  // the match untouched, so a three-line edit stays a three-line diff. Slicing
  // also sidesteps the `$&` / `$1` / `$$` capture-group syntax that a plain
  // string replacement would interpret and corrupt.
  const start = contentLf.indexOf(oldLf)
  const updated =
    content.slice(0, map[start]) +
    withEol(newLf, eolOf(content)) +
    content.slice(map[start + oldLf.length])
  return { ok: true, content: updated, matches: 1 }
}

/** One replacement as the tool receives it. */
export interface EditSpec {
  old_string: string
  new_string: string
  replace_all?: boolean
}

/**
 * The edits one file_edit call carries: an `edits` array, or the single
 * old_string/new_string pair. A missing new_string stays missing (undefined)
 * so the caller can refuse it instead of silently deleting the found text.
 */
export function editsFromArgs(args: Record<string, unknown>): Array<{ old_string: string; new_string: string | undefined; replace_all: boolean }> {
  const one = (e: Record<string, unknown>) => ({
    old_string: typeof e.old_string === 'string' ? e.old_string : '',
    new_string: typeof e.new_string === 'string' ? e.new_string : undefined,
    replace_all: e.replace_all === true,
  })
  if (Array.isArray(args.edits) && args.edits.length > 0) {
    return args.edits.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object').map(one)
  }
  return [one(args)]
}

export interface MultiEditOutcome extends EditOutcome {
  /** Which edit failed (0-based), when !ok and there was more than one. */
  failedIndex?: number
  /** How many edits needed the whitespace-tolerant match. */
  fuzzyCount?: number
  /** Total replacements made. */
  replacements?: number
}

/**
 * Apply every edit in order on the running result, all or nothing: one failed
 * edit leaves the file untouched, so a half-applied change never lands.
 */
export function applyEdits(content: string, edits: EditSpec[]): MultiEditOutcome {
  let cur = content
  let fuzzyCount = 0
  let replacements = 0
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]
    const r = applyUniqueEdit(cur, e.old_string, e.new_string, e.replace_all === true)
    if (!r.ok) return { ...r, failedIndex: edits.length > 1 ? i : undefined }
    cur = r.content ?? cur
    if (r.fuzzy) fuzzyCount++
    replacements += r.matches
  }
  return { ok: true, content: cur, matches: replacements, fuzzyCount, replacements }
}

/** Edit distance of two short strings, the classic two-row version. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * Where old_string most likely meant to point, for the "not found" answer
 * (C59 A5). A small model that misses by a word used to get "read the file
 * and copy the exact text", which costs a full re-read of the file and
 * another round trip; often it then guessed again. Now the answer shows the
 * closest lines with their number, so the next try can copy from there.
 *
 * Compared on the first non-blank line of old_string, trimmed, against every
 * line of the file (files up to 5 000 lines, lines up to 300 characters, to
 * keep the cost flat). Below 60 % similarity nothing is offered: a wrong
 * pointer is worse than none.
 */
export function closestLines(content: string, oldString: string, context = 3): { line: number; text: string } | null {
  const first = toLf(oldString).split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (!first || first.length > 300) return null
  const lines = toLf(content).split('\n')
  if (lines.length > 5000) return null
  let best = -1
  let bestScore = 0
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t || t.length > 300) continue
    const score = 1 - levenshtein(t, first) / Math.max(t.length, first.length)
    if (score > bestScore) { bestScore = score; best = i }
  }
  if (best < 0 || bestScore < 0.6) return null
  return { line: best + 1, text: lines.slice(best, best + context).join('\n') }
}
