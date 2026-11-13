/**
 * Per hunk review: the hunks match the diff the user sees, and any subset of
 * them writes back exactly the lines that were accepted.
 *
 * Run: npx vitest run src/lib/__tests__/hunks.test.ts
 */
import { describe, it, expect } from 'vitest'
import { buildHunks, applyHunks, contentWithDecisions, hunkHeader, splitKeepEol, describeHunk } from '../hunks'
import { computeUnifiedDiff } from '../diff'

const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`)
const text = (ls: string[], eol = '\n', trailing = true) => ls.join(eol) + (trailing && ls.length ? eol : '')

/** Apply only the hunks in `keep`. */
const only = (oldT: string, newT: string, keep: number[]) =>
  applyHunks(buildHunks(oldT, newT), (i) => keep.includes(i), oldT, newT)

describe('splitKeepEol', () => {
  it('keeps every terminator and a last line without one', () => {
    expect(splitKeepEol('')).toEqual([])
    expect(splitKeepEol('a')).toEqual(['a'])
    expect(splitKeepEol('a\nb\r\nc')).toEqual(['a\n', 'b\r\n', 'c'])
    expect(splitKeepEol('a\n\n')).toEqual(['a\n', '\n'])
  })
})

describe('buildHunks', () => {
  it('identical texts have no hunks', () => {
    expect(buildHunks('a\nb\n', 'a\nb\n').hunks).toEqual([])
  })

  it('two edits far apart are two hunks, close ones one', () => {
    const base = lines(30)
    const far = [...base]
    far[2] = 'X'
    far[25] = 'Y'
    expect(buildHunks(text(base), text(far)).hunks).toHaveLength(2)
    const near = [...base]
    near[2] = 'X'
    near[8] = 'Y' // 5 unchanged lines between: within 2 * 3
    expect(buildHunks(text(base), text(near)).hunks).toHaveLength(1)
  })

  it('a file that did not exist before is one hunk of adds', () => {
    const { hunks } = buildHunks('', 'a\nb\nc\n')
    expect(hunks).toHaveLength(1)
    expect(hunks[0].added).toBe(3)
    expect(hunks[0].removed).toBe(0)
    expect(hunks[0].lines.map((l) => l.kind)).toEqual(['add', 'add', 'add'])
  })

  it('reads CRLF as LF, a model writing LF into a CRLF file is not a full rewrite', () => {
    const oldT = text(lines(20), '\r\n')
    const changed = lines(20)
    changed[10] = 'X'
    const { hunks } = buildHunks(oldT, text(changed))
    expect(hunks).toHaveLength(1)
    expect(hunks[0].added).toBe(1)
    expect(hunks[0].removed).toBe(1)
  })

  it('a missing newline at the end is a change, and says so', () => {
    const { hunks } = buildHunks('a\nb\n', 'a\nb')
    expect(hunks).toHaveLength(1)
    const add = hunks[0].lines.find((l) => l.kind === 'add')
    expect(add?.text).toBe('b')
    expect(add?.noNewline).toBe(true)
  })

  it('matches the hunks of computeUnifiedDiff, header by header (random edits)', () => {
    let seed = 7
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let round = 0; round < 300; round++) {
      const base = lines(1 + rnd(40))
      const next = [...base]
      for (let e = 0; e < 1 + rnd(5); e++) {
        const at = rnd(next.length + 1)
        const what = rnd(3)
        if (what === 0) next.splice(at, 0, `new${round}-${e}`)
        else if (what === 1 && next.length > 0) next.splice(Math.min(at, next.length - 1), 1)
        else if (next.length > 0) next[Math.min(at, next.length - 1)] = `chg${round}-${e}`
      }
      const oldT = text(base)
      const newT = text(next)
      const expected = computeUnifiedDiff('f', oldT, newT).split('\n').filter((l) => l.startsWith('@@'))
      expect(buildHunks(oldT, newT).hunks.map(hunkHeader)).toEqual(expected)
    }
  })
})

describe('applyHunks', () => {
  const base = lines(30)
  const edited = [...base]
  edited[0] = 'FIRST'
  edited[14] = 'MIDDLE'
  edited[29] = 'LAST'
  const oldT = text(base)
  const newT = text(edited)

  it('three hunks: first line, middle, last line', () => {
    expect(buildHunks(oldT, newT).hunks).toHaveLength(3)
  })

  it('all accepted is the new text, none the old text, byte for byte', () => {
    expect(only(oldT, newT, [0, 1, 2])).toBe(newT)
    expect(only(oldT, newT, [])).toBe(oldT)
  })

  it('applies exactly the chosen hunks, at the first and the last line too', () => {
    const want = (first: boolean, mid: boolean, last: boolean) => {
      const ls = [...base]
      if (first) ls[0] = 'FIRST'
      if (mid) ls[14] = 'MIDDLE'
      if (last) ls[29] = 'LAST'
      return text(ls)
    }
    expect(only(oldT, newT, [0])).toBe(want(true, false, false))
    expect(only(oldT, newT, [1])).toBe(want(false, true, false))
    expect(only(oldT, newT, [2])).toBe(want(false, false, true))
    expect(only(oldT, newT, [0, 2])).toBe(want(true, false, true))
  })

  it('adjacent hunks (exactly 2 * context + 1 lines apart) stay independent', () => {
    const b = lines(20)
    const n = [...b]
    n[2] = 'A' // gap of 7 unchanged lines to index 10
    n[10] = 'B'
    const o = text(b)
    const nt = text(n)
    expect(buildHunks(o, nt).hunks).toHaveLength(2)
    const onlyB = [...b]
    onlyB[10] = 'B'
    expect(only(o, nt, [1])).toBe(text(onlyB))
  })

  it('inserts and deletions in separate hunks keep line counts right', () => {
    const b = lines(25)
    const n = [...b]
    n.splice(20, 2) // delete l21, l22
    n.splice(1, 0, 'INS1', 'INS2') // insert after l1
    const o = text(b)
    const nt = text(n)
    expect(buildHunks(o, nt).hunks).toHaveLength(2)
    const insOnly = [...b]
    insOnly.splice(1, 0, 'INS1', 'INS2')
    expect(only(o, nt, [0])).toBe(text(insOnly))
    const delOnly = [...b]
    delOnly.splice(20, 2)
    expect(only(o, nt, [1])).toBe(text(delOnly))
  })

  it('keeps the trailing newline state of the side each part comes from', () => {
    const b = lines(20)
    const n = [...b]
    n[1] = 'X'
    const o = text(b, '\n', false) // no newline at the end
    const nt = text(n, '\n', true) // newline added at the end
    const { hunks } = buildHunks(o, nt)
    expect(hunks).toHaveLength(2)
    // only the newline at the end
    expect(only(o, nt, [1])).toBe(text(b, '\n', true))
    // only the edit, the file still ends without a newline
    expect(only(o, nt, [0])).toBe(text(n, '\n', false))
  })

  it('CRLF file: rejected parts keep their CRLF bytes', () => {
    const b = lines(20)
    const n = [...b]
    n[1] = 'X'
    n[17] = 'Y'
    const o = text(b, '\r\n')
    const nt = text(n, '\r\n')
    const firstOnly = [...b]
    firstOnly[1] = 'X'
    expect(only(o, nt, [0])).toBe(text(firstOnly, '\r\n'))
  })

  it('a new file with its single hunk rejected stays empty', () => {
    expect(only('', 'a\nb\n', [])).toBe('')
  })
})

describe('contentWithDecisions', () => {
  it('a hunk without a decision counts as accepted', () => {
    const b = lines(30)
    const n = [...b]
    n[0] = 'A'
    n[28] = 'B'
    const o = text(b)
    const nt = text(n)
    expect(contentWithDecisions(o, nt, undefined).content).toBe(nt)
    expect(contentWithDecisions(o, nt, { 0: 'accepted' }).content).toBe(nt)
    const r = contentWithDecisions(o, nt, { 1: 'rejected' })
    expect(r.rejected.map((h) => h.index)).toEqual([1])
    const want = [...b]
    want[0] = 'A'
    expect(r.content).toBe(text(want))
  })

  it('describes a rejected part in lines the model can find', () => {
    const { hunks } = buildHunks('a\nb\nc\n', 'a\nB\nc\n')
    expect(describeHunk(hunks[0])).toBe('original line 2')
    const ins = buildHunks('a\n', 'a\nb\nc\n').hunks[0]
    expect(describeHunk(ins)).toBe('your new lines 2-3')
  })
})
