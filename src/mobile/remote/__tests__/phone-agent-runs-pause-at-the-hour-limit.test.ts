/**
 * @vitest-environment jsdom
 *
 * CA (14.11.2026): agent runs from the phone drive the desktop's model, which
 * can be a cloud model with the user's own paid key. One run stopped at 50
 * steps; runs one after another had no limit. Both phone loops now count an
 * estimate per hour and pause cleanly above it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runRemoteAgentLoop } from '../remoteAgent'
import { _resetRemoteTokenHour, countRemoteStep, estimateRemoteTokens, REMOTE_HOUR_TOKEN_LIMIT } from '../../../lib/agent-core/remote-token-hour'

beforeEach(() => _resetRemoteTokenHour())

const T0 = 1_800_000_000_000

describe('the phone hour', () => {
  it('estimates high rather than low', () => {
    expect(estimateRemoteTokens(3_500)).toBe(1_000)
    expect(estimateRemoteTokens(0)).toBe(0)
  })

  it('pauses once when the hour passes the limit, then goes on for an hour', () => {
    expect(countRemoteStep(REMOTE_HOUR_TOKEN_LIMIT - 1, T0)).toBe(false)
    expect(countRemoteStep(10, T0 + 1)).toBe(true)
    // The next message is the go-ahead: no second pause within the hour.
    expect(countRemoteStep(500_000, T0 + 2)).toBe(false)
    // An hour after the pause, the old steps are gone too: counting starts over.
    expect(countRemoteStep(10, T0 + 61 * 60_000)).toBe(false)
  })

  it('a store that cannot answer means a fresh hour, never a crash', () => {
    const original = globalThis.localStorage.getItem
    globalThis.localStorage.getItem = () => { throw new Error('denied') }
    try {
      expect(countRemoteStep(10, T0)).toBe(false)
    } finally {
      globalThis.localStorage.getItem = original
    }
  })
})

describe('the app loop stops cleanly at the limit', () => {
  it('ends as cost-limit before running the tools of that step', async () => {
    countRemoteStep(REMOTE_HOUR_TOKEN_LIMIT - 5, Date.now())
    let toolRuns = 0
    const res = await runRemoteAgentLoop({
      client: {
        chatWithTools: async () => ({ content: 'reading', thinking: '', toolCalls: [{ function: { name: 'file_read', arguments: { path: 'a.txt' } } }] }),
        runAgentTool: async () => { toolRuns++; return { ok: true, result: 'text' } },
      } as never,
      model: 'm', chatId: 'c', tools: ['file_read'],
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'read a.txt' }] as never,
    })
    expect(res.end).toBe('cost-limit')
    expect(toolRuns).toBe(0)
    expect(res.content).toMatch(/reading/)
  })

  it('a run far below the limit is never touched', async () => {
    const res = await runRemoteAgentLoop({
      client: {
        chatWithTools: async () => ({ content: 'done', thinking: '', toolCalls: [] }),
        runAgentTool: async () => ({ ok: true, result: '' }),
      } as never,
      model: 'm', chatId: 'c', tools: ['file_read'],
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] as never,
    })
    expect(res.end).toBe('done')
  })
})

describe('the desktop phone page counts the same way', () => {
  it('imports the shared counter and stops before running tools', () => {
    const page = readFileSync(join(process.cwd(), 'mobile-client/client.js'), 'utf8')
    expect(page).toMatch(/countAgentHourTokens,/)
    const at = page.indexOf('if(countAgentHourTokens(estimateAgentTokens(')
    expect(at).toBeGreaterThan(0)
    const block = page.slice(at, at + 700)
    expect(block).toMatch(/finishToolLoop\(null\);\s*return;/)
    expect(block).toMatch(/Send a message to go on/)
  })
})
