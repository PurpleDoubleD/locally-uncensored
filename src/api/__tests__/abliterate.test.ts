/**
 * Remove refusals (A14): the small helpers the dialog reads its numbers
 * through, the row fields the model list carries, and the prompt block of the
 * two local render tools, which must not depend on the model refusing.
 *
 * Run: npx vitest run src/api/__tests__/abliterate.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { downloadLine, gb, minutesRange, mmluVerdict, phaseShare, roughDuration, sizeText } from '../abliterate'

vi.mock('../backend', () => ({ backendCall: vi.fn(), isTauri: () => false }))

describe('numbers in the dialog', () => {
  it('reads time, size and progress the way people say them', () => {
    expect(minutesRange(13, 33)).toBe('13–33 min')
    expect(minutesRange(74, 191)).toBe('1–3 h')
    expect(minutesRange(40, 110)).toBe('40 min – 2 h')
    expect(roughDuration(90)).toBe('2 min')
    expect(roughDuration(5400)).toBe('1 h 30 min')
    expect(gb(988_097_824)).toBe('1.0 GB')
    expect(gb(27_900_000_000)).toBe('28 GB')
    expect(gb(null)).toBe('?')
    expect(gb(22_011_023)).toBe('22 MB')
    expect(phaseShare({ step: 50, total: 200 })).toBe(0.25)
    expect(phaseShare({ step: 5, total: 0 })).toBeNull()
  })
})

describe('the model list', () => {
  it('carries where the original is and whether LU made the copy', async () => {
    const { bundledToAIModels } = await import('../engine')
    const [orig, copy, older] = bundledToAIModels([
      { name: 'Qwen2.5-0.5B-Instruct-Q8_0', path: '/m/a.gguf', size: 1, loaded: false, sourceRepo: 'Qwen/Qwen2.5-0.5B-Instruct', refusalsRemoved: false },
      { name: 'Qwen2.5-0.5B-Instruct-refusals-removed-Q8_0', path: '/m/b.gguf', size: 1, loaded: false, sourceRepo: null, refusalsRemoved: true },
      { name: 'old', path: '/m/c.gguf', size: 1, loaded: false },
    ])
    expect(orig).toMatchObject({ sourceRepo: 'Qwen/Qwen2.5-0.5B-Instruct' })
    expect('refusalsRemoved' in orig).toBe(false)
    expect(copy).toMatchObject({ refusalsRemoved: true })
    expect('sourceRepo' in copy).toBe(false)
    expect('sourceRepo' in older || 'refusalsRemoved' in older).toBe(false)
  })
})

describe('the local render tools check the prompt themselves', () => {
  it('blocks what the safety module blocks, on every string argument', async () => {
    const { localRenderBlocked } = await import('../mcp/builtin-tools')
    expect(localRenderBlocked({ prompt: 'a lighthouse at dusk, film grain' })).toBeNull()
    expect(localRenderBlocked({ prompt: 'portrait', negative_prompt: 'child porn' })).toMatch(/^Error: This prompt was blocked/)
    expect(localRenderBlocked({ prompt: 'nude', extra: 'a 12 year old' })).toMatch(/^Error: /)
  })

  it('every way out of image_generate and video_generate passes the check first', () => {
    const src = readFileSync(resolve(__dirname, '../mcp/builtin-tools.ts'), 'utf8')
    const body = (name: string) => {
      const start = src.indexOf(`async function ${name}(`)
      const end = src.indexOf('\nasync function ', start + 10)
      return src.slice(start, end)
    }
    for (const fn of ['executeImageGenerate', 'executeVideoGenerate']) {
      const b = body(fn)
      const exits = [...b.matchAll(/return (executeImageGenerateMlx|executeVideoGenerateMlx|vramHandoffGenerate)\(/g)]
      expect(exits.length, fn).toBeGreaterThan(0)
      for (const exit of exits) {
        const before = b.slice(0, exit.index)
        const lastCheck = before.lastIndexOf('localRenderBlocked(')
        const lastExit = Math.max(
          before.lastIndexOf('return executeImageGenerateMlx('),
          before.lastIndexOf('return executeVideoGenerateMlx('),
        )
        expect(lastCheck, `${fn}: ${exit[0]} without a check before it`).toBeGreaterThan(lastExit)
      }
    }
  })
})

describe('a download as it moves (3.0.9)', () => {
  it('names bytes of total, share, speed and time left in one line', () => {
    expect(sizeText(740e6)).toBe('740 MB')
    expect(sizeText(1_990_600_000)).toBe('1.99 GB')
    expect(downloadLine({ step: 740e6, total: 1_990_600_000, rateBps: 4_200_000, etaSecs: 298 }))
      .toBe('740 MB of 1.99 GB · 37% · 4.2 MB/s · about 5 min left')
    // the first second: no speed measured yet
    expect(downloadLine({ step: 0, total: 988_097_824, rateBps: null, etaSecs: null })).toBe('0 MB of 988 MB · 0%')
    expect(downloadLine({ step: 900e6, total: 988e6, rateBps: 800_000, etaSecs: 40 })).toBe('900 MB of 988 MB · 91% · 800 kB/s · 40 s left')
  })
})

describe('the knowledge check, read honestly (3.0.9)', () => {
  const marks = (right: number, n: number) => '1'.repeat(right) + '0'.repeat(n - right)
  it('3.0.8 had no marks: a small change is reported, not judged', () => {
    const v = mmluVerdict({ refusals: 39, falseAlarms: 13, mmlu: 22, n: 50 }, { refusals: 3, falseAlarms: 2, mmlu: 21, n: 50 })
    expect(v.reading).toBe('chance')
    expect(v.text).toBe('-1 of 50 questions; too few to tell a loss from chance')
  })
  it('counts the answers that changed and calls a small net change chance', () => {
    // 90 right before; the copy loses 6 of them and gains 3 others
    const before = { refusals: 0, falseAlarms: 0, mmlu: 90, n: 50, mmluN: 200, mmluMarks: marks(90, 200) }
    const a = before.mmluMarks.split('')
    for (let i = 0; i < 6; i++) a[i] = '0'
    for (let i = 90; i < 93; i++) a[i] = '1'
    const after = { ...before, mmlu: 87, mmluMarks: a.join('') }
    const v = mmluVerdict(before, after)
    expect([v.worse, v.better, v.delta]).toEqual([6, 3, -3])
    expect(v.reading).toBe('chance')
    expect(v.text).toBe('6 answers turned wrong, 3 answers turned right (-3 of 200): within chance')
  })
  it('a loss larger than chance is called a loss, in points', () => {
    const before = { refusals: 0, falseAlarms: 0, mmlu: 100, n: 50, mmluN: 200, mmluMarks: marks(100, 200) }
    const a = before.mmluMarks.split('')
    for (let i = 0; i < 20; i++) a[i] = '0'
    const v = mmluVerdict(before, { ...before, mmlu: 80, mmluMarks: a.join('') })
    expect(v.reading).toBe('loss')
    expect(v.text).toContain('a real loss of 10.0 points')
  })
  it('identical answers say so', () => {
    const c = { refusals: 0, falseAlarms: 0, mmlu: 88, n: 50, mmluN: 200, mmluMarks: marks(88, 200) }
    expect(mmluVerdict(c, c).text).toBe('All 200 answers the same as the original')
  })
})
