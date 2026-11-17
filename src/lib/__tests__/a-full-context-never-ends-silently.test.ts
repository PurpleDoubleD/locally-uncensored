/**
 * CA, 14.11.2026. David, on a local 27B in Agent mode: the context filled to
 * the brim, the request never finished, no answer came, and auto-compact did
 * not fire. "Der sollte natuerlich autokompaktieren." Three causes, pinned:
 *   1. the default ran only from a 32K model window; every Ollama chat has 16K;
 *   2. under 8 messages nothing was ever summarised, however full;
 *   3. nothing checked that the request fits before it left; Ollama cuts the
 *      start silently.
 * A full context now compacts, else shortens the longest older turns, else
 * ends the turn with the sentence that says why. Never silence.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { answerRoom, ContextFullError, fitToWindow, isContextFull } from '../fit-to-window'
import { resolveCompactThreshold, shouldAutoCompact } from '../compact-trigger'
import { DEFAULT_CONTEXT_CAP } from '../context-window'
import { CONTEXT_OVERFLOW_REFUSAL_SENTENCE, explainSendRefusal } from '../template-refusal'
import { estimateMessageTokens } from '../context-compaction'

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 97}`).join(' ')
const tokens = (ms: Array<{ role: string; content: string }>) => estimateMessageTokens(ms as never)

describe('auto-compact on an Ollama chat', () => {
  it('the 16K window every Ollama chat gets compacts by default', () => {
    expect(DEFAULT_CONTEXT_CAP).toBe(16384)
    expect(resolveCompactThreshold({ autoCompact: true, autoCompactThreshold: 0 }, DEFAULT_CONTEXT_CAP)).not.toBeNull()
  })

  it('three huge turns over the threshold are summarised, not left alone', () => {
    const v = shouldAutoCompact({ used: 15_000, window: 16_384, source: 'built', real: true, windowIsTrue: true, messageCount: 3, threshold: 0.74 })
    expect(v.shouldCompact).toBe(true)
  })
})

describe('fitToWindow, the last check', () => {
  const sys = { role: 'system', content: 'You are LU.' }

  it('a request that fits leaves untouched', () => {
    const ms = [sys, { role: 'user', content: 'hi' }]
    const r = fitToWindow(ms, 16_384)
    expect(r.fits).toBe(true)
    expect(r.messages).toBe(ms)
    expect(r.shortened).toBe(0)
  })

  it('a long older turn is shortened for the request, head and tail kept, the question whole', () => {
    const pasted = 'START ' + words(30_000) + ' END'
    const ms = [sys, { role: 'user', content: pasted }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'Summarise it.' }]
    const r = fitToWindow(ms, 16_384)
    expect(r.fits).toBe(true)
    expect(r.shortened).toBe(1)
    expect(tokens(r.messages)).toBeLessThanOrEqual(16_384 - answerRoom(16_384))
    expect(r.messages[1].content.startsWith('START')).toBe(true)
    expect(r.messages[1].content.endsWith('END')).toBe(true)
    expect(r.messages[3].content).toBe('Summarise it.')
    // Only the request copy: the input array is not changed.
    expect(ms[1].content).toBe(pasted)
  })

  it('the tool catalogue counts', () => {
    const ms = [sys, { role: 'user', content: words(3_000) }, { role: 'user', content: 'go' }]
    expect(fitToWindow(ms, 16_384).shortened).toBe(0)
    expect(fitToWindow(ms, 16_384, 9_000).shortened).toBe(1)
  })

  it('when even the question alone is too big, it does not fit and says so', () => {
    const ms = [sys, { role: 'user', content: words(40_000) }]
    const r = fitToWindow(ms, 16_384)
    expect(r.fits).toBe(false)
    const err = new ContextFullError(r.tokens, 16_384)
    expect(isContextFull(err)).toBe(true)
    expect(explainSendRefusal(err)).toBe(CONTEXT_OVERFLOW_REFUSAL_SENTENCE)
  })

  it('an unknown window checks nothing', () => {
    const ms = [sys, { role: 'user', content: words(40_000) }]
    expect(fitToWindow(ms, 0).fits).toBe(true)
  })
})

describe('every path runs it before the request leaves', () => {
  it('plain chat, inside the try whose catch explains it', () => {
    const src = readFileSync('src/hooks/useChat.ts', 'utf8')
    expect(src).toMatch(/const fitted = fitToWindow\(continued \?\? budgeted, modelWindowTokens, 0, \{/)
    expect(src).toMatch(/try \{\n\s*if \(!fitted\.fits\) throw new ContextFullError/)
  })

  it('the Agent tab, against the model window, after the build', () => {
    const src = readFileSync('src/hooks/useAgentChat.ts', 'utf8')
    const build = src.indexOf('sendMessages = built.messages')
    const fit = src.indexOf('fitToWindow(sendMessages, calib.budget(agentCtx), catalogTokens, {')
    expect(build).toBeGreaterThan(0)
    expect(fit).toBeGreaterThan(build)
    expect(src).toMatch(/if \(!fit\.fits\) throw new ContextFullError\(fit\.tokens, agentCtx\)/)
  })

  it('the Code tab, outside the best-effort catch', () => {
    const src = readFileSync('src/hooks/useCodex.ts', 'utf8')
    const bestEffort = src.indexOf('// Building is best-effort; fall through with the raw history.')
    const fit = src.indexOf('fitToWindow(sendMessages, calib.budget(numCtx), lastToolsEstimate, {')
    expect(fit).toBeGreaterThan(bestEffort)
    expect(src).toMatch(/if \(!fit\.fits\) throw new ContextFullError\(fit\.tokens, numCtx\)/)
  })
})

describe("David's numbers: about 31K of a 32K window in Agent mode, no compaction", () => {
  // The loop built against 80 % of the window (26214) by its own estimate. The
  // model counted about a fifth more: 31K. Nothing in the loop saw a reason to
  // compact, and about 1K was left for the answer of a thinking model.
  it('after one step the loop measures in the model\'s own tokens', async () => {
    const { TokenCalibration, MAX_CALIBRATION } = await import('../token-calibration')
    const c = new TokenCalibration()
    expect(c.budget(26_214)).toBe(26_214)
    c.observe(26_000, 31_200)
    expect(c.factor).toBeCloseTo(1.2, 2)
    // The same 26214 budget now holds what the model counts as 26214.
    expect(c.budget(26_214) * c.factor).toBeLessThanOrEqual(26_214)
    expect(c.budget(26_214)).toBeLessThan(22_000)
    // Only upward, at most double, and a missing count changes nothing.
    c.observe(26_000, 20_000)
    expect(c.factor).toBe(1)
    c.observe(1_000, 50_000)
    expect(c.factor).toBe(MAX_CALIBRATION)
    c.observe(1_000, undefined)
    expect(c.factor).toBe(MAX_CALIBRATION)
  })

  it('both tool loops feed it from every step and read every budget through it', () => {
    const agent = readFileSync('src/hooks/useAgentChat.ts', 'utf8')
    expect(agent).toMatch(/budgetBesideTheCatalog\(calib\.budget\(sendWindow\), catalogTokens\)/)
    expect(agent).toMatch(/fitToWindow\(sendMessages, calib\.budget\(agentCtx\), catalogTokens, \{/)
    expect(agent.match(/calib\.observe\(stepEstimate, (turn|hermesTurn)\.promptEvalCount\)/g)?.length).toBe(2)
    const code = readFileSync('src/hooks/useCodex.ts', 'utf8')
    expect(code).toMatch(/const sendWindow = calib\.budget\(capToLearnedWindow\(/)
    expect(code).toMatch(/fitToWindow\(sendMessages, calib\.budget\(numCtx\), lastToolsEstimate, \{/)
    expect(code.match(/calib\.observe\(stepPromptEstimate \+ stepToolsEstimate, (turn|hermesTurn)\.promptEvalCount\)/g)?.length).toBe(3)
  })
})
