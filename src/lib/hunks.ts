// Hunks of a staged change, for review part by part (accept or reject each).
//
// `computeUnifiedDiff` (lib/diff.ts) gives a string for display. Reviewing per
// hunk needs more: the same grouping, but tied to the exact lines of both
// versions, so that a subset of hunks can be written back byte for byte.
//
// Lines here keep their terminator ("a\n", "b\r\n", a last "c" without one).
// Two lines are equal when they match after CRLF is read as LF: a model writes
// LF into a CRLF file, and every line then differing would turn a three line
// edit into one hunk over the whole file. The apply path (lib/staged-apply)
// writes in the form the file on disk has anyway. A missing newline at the end
// still counts as a difference, it is a real change of the file.
//
// The grouping is the one `computeUnifiedDiff` uses (git's rule: two changes
// share a hunk when no more than 2 * context unchanged lines sit between
// them), so the hunks the panel shows match the stored diff.

import { diffLines } from './diff'

export interface HunkLine {
  kind: 'context' | 'add' | 'remove'
  /** The line without its terminator. */
  text: string
  oldLine?: number
  newLine?: number
  /** Last line of its file and not ended by a newline. */
  noNewline?: boolean
}

export interface Hunk {
  index: number
  /** 1-based start and length of the hunk, context included (git header). */
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** The changed lines only, 1-based and inclusive; an empty range has to < from. */
  changedOld: { from: number; to: number }
  changedNew: { from: number; to: number }
  lines: HunkLine[]
  added: number
  removed: number
}

type Segment =
  | { kind: 'equal'; a: number; b: number; len: number }
  | { kind: 'change'; a: number; aLen: number; b: number; bLen: number; hunk: number }

export interface HunkModel {
  hunks: Hunk[]
  /** Internal: the walk over both files that `applyHunks` replays. */
  segments: Segment[]
  oldLines: string[]
  newLines: string[]
}

/** Lines with their terminator. "" has none, "a" has one, "a\n" has one. */
export function splitKeepEol(text: string): string[] {
  if (text === '') return []
  const out = text.match(/[^\n]*\n|[^\n]+$/g)
  return out ?? []
}

const keyOf = (line: string) => (line.endsWith('\r\n') ? `${line.slice(0, -2)}\n` : line)
const bare = (line: string) => line.replace(/\r?\n$/, '')

/** Build the hunks of old -> new. `context` as in `computeUnifiedDiff`. */
export function buildHunks(oldText: string, newText: string, context = 3): HunkModel {
  const a = splitKeepEol(oldText)
  const b = splitKeepEol(newText)
  const ops = diffLines(a.map(keyOf), b.map(keyOf))

  // Ops to segments: one change segment for every run between two equal runs.
  const segments: Segment[] = []
  let ai = 0
  let bi = 0
  for (const op of ops) {
    const n = op.text.length
    if (op.kind === 'equal') {
      segments.push({ kind: 'equal', a: ai, b: bi, len: n })
      ai += n
      bi += n
      continue
    }
    const last = segments[segments.length - 1]
    const seg = last && last.kind === 'change' ? last : null
    const target = seg ?? { kind: 'change' as const, a: ai, aLen: 0, b: bi, bLen: 0, hunk: -1 }
    if (!seg) segments.push(target)
    if (op.kind === 'remove') { target.aLen += n; ai += n } else { target.bLen += n; bi += n }
  }

  // Changes to hunks: a gap wider than 2 * context starts a new one.
  let hunk = -1
  let lastChange = -1
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]
    if (seg.kind !== 'change') continue
    if (lastChange === -1) {
      hunk = 0
    } else {
      let gap = 0
      for (let k = lastChange + 1; k < s; k++) {
        const g = segments[k]
        if (g.kind === 'equal') gap += g.len
      }
      if (gap > context * 2) hunk++
    }
    seg.hunk = hunk
    lastChange = s
  }

  const hunks: Hunk[] = []
  for (let h = 0; h <= hunk; h++) {
    const first = segments.findIndex((s) => s.kind === 'change' && s.hunk === h)
    let lastIdx = first
    for (let s = first; s < segments.length; s++) {
      const seg = segments[s]
      if (seg.kind === 'change') {
        if (seg.hunk !== h) break
        lastIdx = s
      }
    }
    const lines: HunkLine[] = []
    const firstSeg = segments[first] as Extract<Segment, { kind: 'change' }>
    const lastSeg = segments[lastIdx] as Extract<Segment, { kind: 'change' }>
    const lead = Math.min(context, firstSeg.a, firstSeg.b)
    const oldStart0 = firstSeg.a - lead
    const newStart0 = firstSeg.b - lead
    const pushContext = (aIdx: number, bIdx: number) => {
      lines.push({ kind: 'context', text: bare(b[bIdx]), oldLine: aIdx + 1, newLine: bIdx + 1, noNewline: isLastWithoutEol(b, bIdx) })
    }
    for (let k = lead; k > 0; k--) pushContext(firstSeg.a - k, firstSeg.b - k)
    let added = 0
    let removed = 0
    for (let s = first; s <= lastIdx; s++) {
      const seg = segments[s]
      if (seg.kind === 'equal') {
        for (let k = 0; k < seg.len; k++) pushContext(seg.a + k, seg.b + k)
        continue
      }
      for (let k = 0; k < seg.aLen; k++) {
        lines.push({ kind: 'remove', text: bare(a[seg.a + k]), oldLine: seg.a + k + 1, noNewline: isLastWithoutEol(a, seg.a + k) })
      }
      for (let k = 0; k < seg.bLen; k++) {
        lines.push({ kind: 'add', text: bare(b[seg.b + k]), newLine: seg.b + k + 1, noNewline: isLastWithoutEol(b, seg.b + k) })
      }
      removed += seg.aLen
      added += seg.bLen
    }
    const endA = lastSeg.a + lastSeg.aLen
    const endB = lastSeg.b + lastSeg.bLen
    const trail = Math.min(context, a.length - endA, b.length - endB)
    for (let k = 0; k < trail; k++) pushContext(endA + k, endB + k)
    hunks.push({
      index: h,
      oldStart: oldStart0 + 1,
      oldCount: endA + trail - oldStart0,
      newStart: newStart0 + 1,
      newCount: endB + trail - newStart0,
      changedOld: { from: firstSeg.a + 1, to: endA },
      changedNew: { from: firstSeg.b + 1, to: endB },
      lines,
      added,
      removed,
    })
  }
  return { hunks, segments, oldLines: a, newLines: b }
}

function isLastWithoutEol(lines: string[], i: number): boolean {
  return i === lines.length - 1 && !lines[i].endsWith('\n')
}

/** The header `computeUnifiedDiff` writes for this hunk. */
export function hunkHeader(h: Hunk): string {
  return `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`
}

/**
 * Old text with only the accepted hunks applied. All accepted gives the new
 * text exactly, none accepted gives the old text exactly.
 */
export function applyHunks(model: HunkModel, accepted: (index: number) => boolean, oldText: string, newText: string): string {
  const { hunks, segments, oldLines, newLines } = model
  if (hunks.every((h) => accepted(h.index))) return newText
  if (hunks.every((h) => !accepted(h.index))) return oldText
  const out: string[] = []
  for (const seg of segments) {
    if (seg.kind === 'equal') {
      for (let k = 0; k < seg.len; k++) out.push(oldLines[seg.a + k])
    } else if (accepted(seg.hunk)) {
      for (let k = 0; k < seg.bLen; k++) out.push(newLines[seg.b + k])
    } else {
      for (let k = 0; k < seg.aLen; k++) out.push(oldLines[seg.a + k])
    }
  }
  // Taking a last line from one side and the line before it from the other can
  // leave two lines glued together ("a" without its newline, then "b"). Every
  // line but the last gets the newline it lost.
  for (let i = 0; i < out.length - 1; i++) {
    if (!out[i].endsWith('\n')) out[i] += eolOf(oldText, newText)
  }
  return out.join('')
}

function eolOf(...texts: string[]): string {
  return texts.some((t) => /\r\n/.test(t)) && !texts.some((t) => /(^|[^\r])\n/.test(t)) ? '\r\n' : '\n'
}

export type HunkDecision = 'accepted' | 'rejected'

/** What a staged change writes, given the per hunk decisions so far. A hunk
 *  without a decision counts as accepted: Apply on the file means "the rest". */
export function contentWithDecisions(
  oldText: string,
  newText: string,
  decisions: Record<number, HunkDecision> | undefined,
): { content: string; model: HunkModel; rejected: Hunk[] } {
  const model = buildHunks(oldText, newText)
  const rejected = model.hunks.filter((h) => decisions?.[h.index] === 'rejected')
  if (rejected.length === 0) return { content: newText, model, rejected }
  const content = applyHunks(model, (i) => decisions?.[i] !== 'rejected', oldText, newText)
  return { content, model, rejected }
}

/** A hunk in words, for the model: where it was, in lines it can find. */
export function describeHunk(h: Hunk): string {
  const range = (r: { from: number; to: number }) => (r.to <= r.from ? `line ${r.from}` : `lines ${r.from}-${r.to}`)
  if (h.removed === 0) return `your new ${range(h.changedNew)}`
  return `original ${range(h.changedOld)}`
}
