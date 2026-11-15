/**
 * Auto-compact fits the model's window (3.0.7).
 *
 * A small window compacts earlier, because the summary call and the next
 * answer need room in it too; a large one compacts late. A threshold the user
 * set stays theirs, held under what the window can carry. The summary call is
 * sized to the window, and the record keeps files, IDs and open tasks.
 *
 * Run: npx vitest run src/lib/__tests__/compact-fits-the-window.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  adaptiveCompactThreshold,
  compactThresholdCeiling,
  resolveCompactThreshold,
  autoCompactOn,
  shouldAutoCompact,
  ADAPTIVE_MIN,
  MIN_AUTO_COMPACT_WINDOW,
  ADAPTIVE_MAX,
} from '../compact-trigger'
import { transcriptCharsFor, COMPACT_MAX_TOKENS } from '../compact-run'
import {
  buildCompactPrompt,
  buildMergePrompt,
  compactSummaryBody,
  parseCompactSummary,
  renderCompactSummary,
  DEFAULT_TRANSCRIPT_CHARS,
  EMPTY_SUMMARY,
  SECTIONS,
} from '../compact-summary'

describe('the threshold follows the window', () => {
  it.each([
    [4096, 0.5],
    [8192, 0.5],
    [16384, 0.74],
    [32768, 0.81],
    [131072, 0.85],
    [262144, 0.85],
  ])('%i tokens compact at %f', (window, expected) => {
    expect(adaptiveCompactThreshold(window)).toBe(expected)
  })

  it('never falls with a growing window', () => {
    let last = 0
    for (let w = 2048; w <= 1_048_576; w *= 2) {
      const t = adaptiveCompactThreshold(w)
      expect(t).toBeGreaterThanOrEqual(last)
      expect(t).toBeGreaterThanOrEqual(ADAPTIVE_MIN)
      expect(t).toBeLessThanOrEqual(ADAPTIVE_MAX)
      last = t
    }
  })

  it('leaves room for the summary call on every window it fires on', () => {
    for (const w of [8192, 16384, 32768, 131072]) {
      const free = w * (1 - adaptiveCompactThreshold(w))
      expect(free).toBeGreaterThan(COMPACT_MAX_TOKENS)
    }
  })

  it('a fixed threshold stays, under what the window can carry', () => {
    expect(resolveCompactThreshold({ autoCompact: true, autoCompactThreshold: 0.6 }, 131072)).toBe(0.6)
    expect(resolveCompactThreshold({ autoCompact: true, autoCompactThreshold: 0.95 }, 8192)).toBe(compactThresholdCeiling(8192))
    expect(compactThresholdCeiling(8192)).toBeLessThan(0.95)
  })

  it('the default runs from a 16K model window up, never at 8K', () => {
    // Owner decision 18.10.2026: "bei 8k nie, bei 32k immer und alles darueber auch immer an".
    // 16K since 14.11.2026: it is every Ollama chat's window, and David's local
    // chat filled up with no summary ("der sollte natuerlich autokompaktieren").
    const standard = { autoCompact: true, autoCompactThreshold: 0 }
    expect(MIN_AUTO_COMPACT_WINDOW).toBe(16384)
    expect(resolveCompactThreshold(standard, 4096)).toBeNull()
    expect(resolveCompactThreshold(standard, 8192)).toBeNull()
    expect(resolveCompactThreshold(standard, 16383)).toBeNull()
    expect(resolveCompactThreshold(standard, 16384)).toBe(0.74)
    expect(resolveCompactThreshold(standard, 32768)).toBe(0.81)
    expect(resolveCompactThreshold(standard, 131072)).toBe(0.85)
    expect(resolveCompactThreshold(standard, 1_048_576)).toBe(0.85)
  })

  it('the 32K rule reads the model window, not the smaller send window', () => {
    const standard = { autoCompact: true, autoCompactThreshold: 0 }
    // A 32K model whose steps send 26K is still a 32K model.
    expect(resolveCompactThreshold(standard, 26214, 32768)).toBe(adaptiveCompactThreshold(26214))
    // A large send window on an 8K model does not count.
    expect(resolveCompactThreshold(standard, 32768, 8192)).toBeNull()
    // The Ollama chat window (DEFAULT_CONTEXT_CAP) compacts by default.
    expect(resolveCompactThreshold(standard, 16384, 16384)).toBe(0.74)
  })

  it('off is only an explicit false', () => {
    expect(autoCompactOn({})).toBe(true)
    expect(autoCompactOn({ autoCompact: true })).toBe(true)
    expect(autoCompactOn({ autoCompact: false })).toBe(false)
    expect(resolveCompactThreshold({ autoCompact: false, autoCompactThreshold: 0.8 }, 32768)).toBeNull()
  })

  it('with a fixed threshold, an 8K chat at 55 % fires, a 128K chat at 55 % does not', () => {
    const base = { source: 'built' as const, real: true, windowIsTrue: true, messageCount: 20 }
    const small = shouldAutoCompact({ ...base, used: 0.55 * 8192, window: 8192, threshold: adaptiveCompactThreshold(8192) })
    const large = shouldAutoCompact({ ...base, used: 0.55 * 131072, window: 131072, threshold: adaptiveCompactThreshold(131072) })
    expect(small.shouldCompact).toBe(true)
    expect(large.shouldCompact).toBe(false)
  })
})

describe('the summary call fits the window', () => {
  it('a small window shows the summariser less transcript', () => {
    expect(transcriptCharsFor(undefined)).toBe(DEFAULT_TRANSCRIPT_CHARS)
    expect(transcriptCharsFor(262144)).toBe(DEFAULT_TRANSCRIPT_CHARS)
    const small = transcriptCharsFor(8192)
    expect(small).toBeLessThan(DEFAULT_TRANSCRIPT_CHARS)
    // Transcript at three characters a token, plus output and instructions,
    // stays inside the window.
    expect(small / 3 + COMPACT_MAX_TOKENS + 1000).toBeLessThanOrEqual(8192)
  })

  it('a merge leaves room for the old record too', () => {
    expect(transcriptCharsFor(16384, 3000, 4000)).toBeLessThan(transcriptCharsFor(16384))
  })

  it('the prompt carries no more transcript than allowed', () => {
    const turns = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'y'.repeat(2000) }))
    const cap = transcriptCharsFor(8192)
    const prompt = buildCompactPrompt(turns, { maxTranscriptChars: cap })
    const transcript = prompt.split('--- TRANSCRIPT ---')[1].split('--- END TRANSCRIPT ---')[0]
    expect(transcript.length).toBeLessThan(cap + 200)
  })
})

describe('the record keeps files, IDs, numbers, open tasks and decisions', () => {
  it('asks for every file with its exact path and every command', () => {
    const prompt = buildCompactPrompt([{ role: 'user', content: 'read src/a.ts' }])
    expect(prompt).toContain('\nFILES\n')
    expect(prompt).toMatch(/exact path/)
    expect(prompt).toMatch(/Copy every ID and number exactly/)
    expect(prompt).toMatch(/very next step/)
    expect(prompt).toContain('\nDECISIONS\n')
  })

  it('a merge keeps the old files', () => {
    const prompt = buildMergePrompt({ ...EMPTY_SUMMARY, files: 'src/a.ts changed' }, [{ role: 'user', content: 'go on' }])
    expect(prompt).toMatch(/- FILES: keep every path and command/)
    expect(prompt).toContain('src/a.ts changed')
  })

  it('FILES survives the round trip in the order of the headings', () => {
    expect(SECTIONS.map((s) => s.heading)).toEqual(['TASK', 'USER REQUESTS', 'PROGRESS', 'DECISIONS', 'FILES', 'FACTS', 'OPEN'])
    const back = parseCompactSummary(compactSummaryBody(renderCompactSummary({ ...EMPTY_SUMMARY, task: 'T', files: 'src/a.ts\nnpm test passed', facts: 'ID 49795cca7' })))
    expect(back.files).toBe('src/a.ts\nnpm test passed')
    expect(back.facts).toBe('ID 49795cca7')
  })

  it('a record written before FILES existed still reads', () => {
    const old = parseCompactSummary('TASK\nT\n\nFACTS\nF')
    expect(old.task).toBe('T')
    expect(old.files).toBe('')
  })
})
