/**
 * CA (13.11.2026), support case "the app answers once, then never again":
 * about 800 lines of Agent setup ran before the loop's own try/finally. A
 * throw there left the conversation claimed and isAgentRunning true, and
 * every later send was refused without a word. The run in the lane is now
 * wrapped, and a claim still held by this run afterwards is freed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../useAgentChat.ts', import.meta.url), 'utf8')

describe('the Agent run setup cannot lock a chat', () => {
  it('the lane body sits inside a try with a catch that tells the user', () => {
    const tryAt = src.indexOf('    try {\n    laneOutcome = await runInLane(')
    expect(tryAt).toBeGreaterThan(0)
    const catchAt = src.indexOf("log.warn('agent.setup_threw'", tryAt)
    expect(catchAt).toBeGreaterThan(tryAt)
    expect(src.slice(catchAt, catchAt + 600)).toMatch(/'agent-start-failed'/)
  })

  it('afterwards a claim still held by this run is freed, identity checked', () => {
    const after = src.slice(src.indexOf("log.warn('agent.setup_threw'"))
    const release = after.indexOf('if (activeAgentRuns.get(convId) === runState) {')
    expect(release).toBeGreaterThan(0)
    const body = after.slice(release, release + 1200)
    expect(body).toMatch(/activeAgentRuns\.delete\(convId\)/)
    expect(body).toMatch(/setIsAgentRunning\(activeAgentRuns\.size > 0\)/)
    expect(body).toMatch(/await endTurnDurably\(\(\) => \{ useGenerationStore\.getState\(\)\.setGenerating\(convId, false\) \}\)/)
  })
})
