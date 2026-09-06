/**
 * Audit M1 — Stop is allowed to remove exactly ONE job: ours.
 *
 * Two paths did the opposite.
 *
 * Create's cancel fired a blanket `/interrupt`, which kills whatever ComfyUI is
 * executing right now. That is our render only when ours happens to be at the
 * front of the queue; queued behind three others (R32 sat at position 4) Stop
 * killed a stranger's job and left ours to start seconds later with nobody
 * watching — the GPU kept working, the file landed on disk, and it never reached
 * the gallery because the poller was long gone.
 *
 * The chat lane went further: `/interrupt` PLUS `{"clear": true}` on the whole
 * queue, which drops the Create tab's render and everything an external ComfyUI
 * tab on the same server has queued.
 *
 * abandonPrompt is the operation both should have used from the start: delete
 * ours from pending, and interrupt only if ours is the one running.
 *
 * Run: npx vitest run src/api/__tests__/stop-removes-only-our-job.test.ts
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

import { abandonPrompt } from '../comfyui'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

const entry = (id: string) => [0, id, {}, {}, []]
const posted = () => calls.filter((c) => c.init?.method === 'POST')
// /interrupt is a bodyless POST; only the /queue posts carry JSON.
const bodies = (): Record<string, unknown>[] =>
  posted().flatMap((c) => (typeof c.init?.body === 'string' ? [JSON.parse(c.init.body)] : []))

beforeEach(() => {
  calls.length = 0
  queueFixture = { queue_running: [], queue_pending: [] }
})

describe('abandonPrompt — one job, by id', () => {
  it('deletes OUR pending prompt and leaves the running stranger alone', async () => {
    // Ours is queued at position 2 behind somebody else's render. A blanket
    // /interrupt here kills THEIR job and keeps ours alive; this must not.
    queueFixture = { queue_running: [entry('someone-else')], queue_pending: [entry('ours')] }

    await abandonPrompt('ours')

    expect(bodies()).toEqual([{ delete: ['ours'] }])
    expect(posted().some((c) => c.url === '/interrupt')).toBe(false)
    expect(bodies().some((b) => b.clear)).toBe(false)
  })

  it('interrupts only when OUR prompt is the one executing', async () => {
    queueFixture = { queue_running: [entry('ours')], queue_pending: [] }

    await abandonPrompt('ours')

    expect(bodies()).toContainEqual({ delete: ['ours'] })
    expect(posted().some((c) => c.url === '/interrupt')).toBe(true)
  })

  it('never clears the whole queue, whatever is in it', async () => {
    queueFixture = {
      queue_running: [entry('external-comfy-tab')],
      queue_pending: [entry('create-tab-render'), entry('ours')],
    }

    await abandonPrompt('ours')

    expect(bodies().some((b) => 'clear' in b)).toBe(false)
    // Nothing that is not ours is named in any request.
    const named = JSON.stringify(bodies())
    expect(named).not.toContain('create-tab-render')
    expect(named).not.toContain('external-comfy-tab')
  })

  it('a dead ComfyUI is survivable — Stop must never throw at the user', async () => {
    const { localFetch } = await import('../backend')
    vi.mocked(localFetch).mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(abandonPrompt('ours')).resolves.toBeUndefined()
  })
})

describe('the Create lane stops its OWN render', () => {
  const create = read('../../hooks/useCreate.ts')

  it('cancel takes our promptId out of the queue instead of blanket-interrupting', () => {
    expect(create).toContain('const ownPromptId = useCreateStore.getState().currentPromptId')
    expect(create).toContain('await abandonPrompt(ownPromptId)')
    expect(create).not.toContain('await cancelGeneration()')
  })

  it('cancelGeneration is not even imported any more, so it cannot come back by accident', () => {
    expect(create).not.toMatch(/^\s*cancelGeneration,$/m)
  })

  it('the stall watchdog abandons the job too, instead of walking away from it', () => {
    // Every watchdog exit lands in the same catch: the old code just stopped
    // polling, so a "stalled" render kept the GPU busy for another hour and
    // delivered its file to nobody.
    expect(create.match(/await abandonPrompt\(ownPromptId\)/g)?.length).toBe(2)
  })
})

describe('the chat lane stops its OWN render', () => {
  const handoff = read('../vram-handoff.ts')

  it('Stop removes our prompt by id and nothing else', () => {
    expect(handoff).toContain('if (_activeHandoffs > 0 && _currentPromptId) {')
    expect(handoff).toContain('void abandonPrompt(_currentPromptId)')
  })

  it('the blanket interrupt and the queue clear are gone from the Stop path', () => {
    expect(handoff).not.toContain('void cancelGeneration()')
    expect(handoff).not.toContain('void clearComfyQueue()')
    expect(handoff).not.toContain('clearComfyQueue,')
  })

  it('a Stop between building the workflow and submitting it does not submit', () => {
    expect(handoff).toContain('if (cancelledFor(seq)) return CANCELLED')
  })

  it('a Stop that lands DURING the submit takes the job back out', () => {
    const submit = handoff.slice(
      handoff.indexOf('async function submitCancellable('),
      handoff.indexOf('async function runHandoff('),
    )
    expect(submit).toContain('await abandonPrompt(promptId)')
  })

  it('the epoch, not the per-run flag, is what an abandoned promise consults', () => {
    // resetCancel() clears the per-run flag for the NEXT generation. An orphan
    // still running from the cancelled one would read `false` there and submit.
    expect(handoff).toContain('return _genCancelRequested || seq <= _cancelledThrough')
  })
})
