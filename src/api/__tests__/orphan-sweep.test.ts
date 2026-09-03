/**
 * A dead LU session must not keep the GPU burning (G19-3, R32/G18 witness
 * 2026-08-07: a killed app left its ComfyUI render running and queued four
 * deep; nothing anywhere owned or showed it). Every LU submission now carries
 * an `lu-` client id, and each handoff sweeps jobs wearing that prefix under a
 * DIFFERENT id than the live session's before submitting its own.
 *
 * Run: npx vitest run src/api/__tests__/orphan-sweep.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Was der Mock mitschneidet, hat eine Form: `localFetch`'s eigenes
 * Options-Objekt (backend.ts). Als `any` gelesen haette ein umbenanntes
 * `method`/`body` hier still `undefined` ergeben — und jede `posted()`-Zeile
 * unten waere leer und gruen geblieben.
 */
type LocalFetchInit = Parameters<typeof import('../backend').localFetch>[1]

/** ComfyUI `/queue`: zwei Listen von `[num, promptId, prompt, extra, outputs]`. */
type QueueFixture = { queue_running: unknown[]; queue_pending: unknown[] }

const calls: { url: string; init?: LocalFetchInit }[] = []
let queueFixture: QueueFixture = { queue_running: [], queue_pending: [] }

vi.mock('../backend', () => ({
  comfyuiUrl: (p: string) => p,
  localFetch: vi.fn(async (url: string, init?: LocalFetchInit) => {
    calls.push({ url, init })
    if (url === '/queue' && (!init || !init.method)) {
      return { ok: true, json: async () => queueFixture }
    }
    return { ok: true, json: async () => ({}), text: async () => '' }
  }),
  fetchLocalhostBytes: vi.fn(),
  isTauri: () => false,
  backendCall: vi.fn(),
  comfyuiWsUrl: () => 'ws://x',
}))

import { sweepOrphanedLuJobs } from '../comfyui'
import { CLIENT_ID, LU_CLIENT_PREFIX } from '../comfyui-ws'

const entry = (id: string, owner?: string) => [0, id, {}, owner ? { client_id: owner } : {}, []]

beforeEach(() => {
  calls.length = 0
  queueFixture = { queue_running: [], queue_pending: [] }
})

describe('sweepOrphanedLuJobs', () => {
  it('deletes a dead session\'s pending jobs and interrupts its running one', async () => {
    queueFixture = {
      queue_running: [entry('run1', 'lu-dead-session')],
      queue_pending: [entry('pen1', 'lu-dead-session'), entry('pen2', 'lu-dead-session')],
    }
    const cleaned = await sweepOrphanedLuJobs(CLIENT_ID)
    expect(cleaned).toBe(3)
    const del = calls.find((c) => c.url === '/queue' && c.init?.method === 'POST')
    // Erst nachweisen, dass der POST ueberhaupt einen Koerper trug: ohne das
    // waere ein weggefallener Body ein `JSON.parse(undefined)`-Absturz statt
    // einer Aussage — und mit `?.` waere er still `undefined` gewesen.
    expect(typeof del?.init?.body).toBe('string')
    expect(JSON.parse(String(del?.init?.body))).toEqual({ delete: ['pen1', 'pen2'] })
    expect(calls.some((c) => c.url === '/interrupt')).toBe(true)
  })

  it('NEGATIVE CONTROL: the live session\'s own job is never touched', async () => {
    queueFixture = { queue_running: [entry('mine', CLIENT_ID)], queue_pending: [] }
    expect(await sweepOrphanedLuJobs(CLIENT_ID)).toBe(0)
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false)
  })

  it('NEGATIVE CONTROL: foreign clients without the lu- prefix are never touched', async () => {
    queueFixture = {
      queue_running: [entry('user1', 'aabbccdd-plain-uuid')],
      queue_pending: [entry('user2'), entry('user3', 'someone-else')],
    }
    expect(await sweepOrphanedLuJobs(CLIENT_ID)).toBe(0)
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false)
    expect(calls.some((c) => c.url === '/interrupt')).toBe(false)
  })

  it('returns 0 on an unreachable queue instead of throwing', async () => {
    const { localFetch } = await import('../backend')
    vi.mocked(localFetch).mockRejectedValueOnce(new Error('down'))
    expect(await sweepOrphanedLuJobs(CLIENT_ID)).toBe(0)
  })
})

describe('ownership marker and wiring', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

  it('the live session id itself wears the prefix', () => {
    expect(CLIENT_ID.startsWith(LU_CLIENT_PREFIX)).toBe(true)
  })

  it('every agent-path submission carries the id, so its jobs are sweepable later', () => {
    const handoff = read('../vram-handoff.ts')
    // Since audit M1 the four call sites (image + three video lanes) go through
    // ONE helper, which is also where the Stop-before/after-submit checks live.
    // The ownership marker therefore has a single place to be forgotten in, and
    // this asserts it is not: no raw submit anywhere, and the helper carries it.
    expect(handoff.match(/await submitCancellable\(workflow, seq\)/g)?.length).toBe(4)
    expect(handoff.match(/await submitWorkflow\(workflow, CLIENT_ID\)/g)?.length).toBe(1)
    expect(handoff).not.toContain('await submitWorkflow(workflow)')
  })

  it('the sweep runs each handoff, after ComfyUI is up and before our submit', () => {
    const handoff = read('../vram-handoff.ts')
    const sweepAt = handoff.indexOf('await sweepOrphanedLuJobs(CLIENT_ID)')
    expect(sweepAt).toBeGreaterThan(handoff.indexOf('const up = await ensureComfyRunning()'))
    expect(sweepAt).toBeLessThan(handoff.indexOf("emitHandoff('generating'"))
  })

  it('NEGATIVE CONTROL: the Create tab still submits under the same live id', () => {
    expect(read('../../hooks/useCreate.ts')).toContain('submitWorkflow(workflow, CLIENT_ID)')
  })

  it('NEGATIVE CONTROL: the user Stop path and the G19-1 budget path still work by owner', () => {
    const handoff = read('../vram-handoff.ts')
    // Still gated on an actually-running chat-lane generation, so a plain text
    // Stop never reaches ComfyUI. Since audit M1 it also removes only OUR job
    // by id — the old /interrupt + `clear: true` took the Create tab's render
    // and the user's own ComfyUI tab down with it.
    expect(handoff).toContain('if (_activeHandoffs > 0 && _currentPromptId) {')
    expect(handoff).toContain('void abandonPrompt(_currentPromptId)')
    expect(handoff).not.toContain('void clearComfyQueue()')
    // pace verdict, G24 warm-up verdict, flat deadline — inside the poll loop.
    const pollBody = handoff.slice(handoff.indexOf('async function pollAndExtract('))
    expect(pollBody.match(/await abandonPrompt\(promptId\)/g)?.length).toBe(3)
  })
})
