/**
 * A13 (21.10.2026): every subcategory of Create in chat, from the tool call to
 * the result on the card, against a stand-in for the server.
 *
 * desktop-walk.test.ts walks one order in depth (image, a chain, a voice).
 * This walks each of the thirteen once, with the inputs it needs taken from
 * earlier items of the same order (item:N), the way a model chains them:
 * create_order → approval → the jobs → every run done with its result. And
 * the two ways a sent job used to get lost: an answer that does not arrive
 * (the poll runs out, the network goes) and a reload in the middle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../api/cloud/supabase', () => ({ getAccessToken: async () => 'test-token' }))

import { useCreateOrderStore } from '../../../stores/createOrderStore'
import { useCreateStore } from '../../../stores/createStore'
import { useChatStore } from '../../../stores/chatStore'
import { useCloudAuthStore } from '../../../stores/cloudAuthStore'
import { useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { neuerServer } from '../../render/__tests__/fixtures/test-catalogs'
import { defaultCreateToolEnv } from '../chat-context'
import { runCreateOptions, runCreateOrder } from '../chat-tools'
import { LOST_TRACK_ERROR, ORDER_RESULT_PREFIX, executeOrder, interruptedRuns, markInterrupted } from '../order'
import { setCreateFollowUp, startOrder } from '../chat-run'
import { CloudJobError } from '../../../api/cloud/jobs'

const CONV = 'conv-a13'
let jobs = 0
let submitted: { kind?: string; op?: string; model?: string }[] = []
let canceled: string[] = []
/** How the stand-in answers a job that is asked about. */
let jobStatus: (id: string) => string

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  jobs = 0
  submitted = []
  canceled = []
  jobStatus = () => 'succeeded'
  useCreateOrderStore.setState({ byConversation: {} })
  useCreateStore.setState({ gallery: [] })
  useCloudAuthStore.setState({ quota: { costs: { image: 400, video: 9000 } } } as never)
  useChatStore.setState({ conversations: [], activeConversationId: CONV })
  // Signed in, so the live catalogue is there. Since 24.10.2026 the only
  // extend models without the filter off are studio models, and a studio
  // model is offered only when the live catalogue lists it.
  useCloudCatalogStore.setState({ models: neuerServer() })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    if (url.pathname === '/api/jobs/quota') {
      return json({ tier: 'hosted-max', period: '2026-10-01', limits: { credits: 5_000_000 }, costs: { image: 400, video: 9000 }, used: { credits_used: 0 }, remaining: { credits: 4_200_000 } })
    }
    if (url.pathname === '/api/loras') return json({ loras: [] })
    if (url.pathname === '/api/account/content-policy') return json({ policy: 'soft', ageConfirmedAt: null, ageConfirmationRequired: true })
    if (url.pathname === '/api/jobs' && method === 'POST') {
      jobs += 1
      const body = JSON.parse(String(init?.body ?? '{}')) as { kind?: string; model?: string; params?: { op?: string } }
      submitted.push({ kind: body.kind, op: body.params?.op, model: body.model })
      return json({ id: `00000000-0000-4000-8000-${String(jobs).padStart(12, '0')}`, quota: { cost: 100, used: 100, limit: 5_000_000 } }, 201)
    }
    if (url.pathname === '/api/jobs/adopt') {
      const role = (JSON.parse(String(init?.body ?? '{}')) as { role?: string }).role ?? 'image'
      return json({ path: `user/adopted.${role === 'audio' ? 'mp3' : role === 'video' ? 'mp4' : 'png'}`, role, contentType: role === 'audio' ? 'audio/mpeg' : role === 'video' ? 'video/mp4' : 'image/png' }, 201)
    }
    if (url.pathname === '/api/jobs/upload') return json({ path: 'user/uploaded.png' }, 201)
    const cancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(url.pathname)
    if (cancel) { canceled.push(cancel[1]); return json({ status: 'canceled', refunded: true }) }
    const job = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname)
    if (job) {
      const status = canceled.includes(job[1]) ? 'canceled' : jobStatus(job[1])
      return json({ job: {
        id: job[1], kind: 'image', model: 'x', provider: null, status,
        result_url: status === 'succeeded' ? `https://files.test/${job[1]}` : null, attestation: null, cost_units: status === 'succeeded' ? 100 : 0,
        created_at: new Date().toISOString(), completed_at: new Date().toISOString(), error: status === 'failed' ? 'render failed' : null,
      } })
    }
    return json({ error: `no stand-in for ${url.pathname}` }, 404)
  }))
})

afterEach(() => {
  setCreateFollowUp(null)
  vi.unstubAllGlobals()
})

const orders = () => useCreateOrderStore.getState().ordersFor(CONV)
const layOut = (items: unknown[]) => runCreateOrder({ items }, defaultCreateToolEnv(CONV))

const IMAGE = { intent: 'image', prompt: 'a woman with a red scarf, portrait, studio light' }
const CLIP = { intent: 'video', prompt: 'a woman walks through rain at night', options: { duration: 5 } }
const VOICE = { speech: 'Hello, this is a test of the voice.' }

/** Each subcategory with the items it needs in front of it. The last item
 *  is the one under test. */
const WALKS: [string, unknown[]][] = [
  ['image', [IMAGE]],
  ['video', [CLIP]],
  ['animate', [IMAGE, { intent: 'animate', prompt: 'she turns her head and smiles', inputs: { image: 'item:1' }, options: { duration: 5 } }]],
  ['edit', [IMAGE, { intent: 'edit', prompt: 'make the scarf blue', inputs: { image: 'item:1' } }]],
  ['removebg', [IMAGE, { intent: 'removebg', inputs: { image: 'item:1' } }]],
  ['upscale', [IMAGE, { intent: 'upscale', inputs: { image: 'item:1' } }]],
  ['extend', [CLIP, { intent: 'extend', prompt: 'she keeps walking', model: 'wan-3.0-extend', inputs: { video: 'item:1' } }]],
  ['video_upscale', [CLIP, { intent: 'video_upscale', inputs: { video: 'item:1' } }]],
  ['lipsync', [IMAGE, VOICE, { intent: 'lipsync', model: 'infinitetalk-fast', inputs: { image: 'item:1', audio: 'item:2' } }]],
  ['motion', [IMAGE, CLIP, { intent: 'motion', model: 'steady-dancer', prompt: 'dance', inputs: { image: 'item:1', video: 'item:2' } }]],
  ['music', [{ intent: 'music', prompt: 'calm piano, rain', options: { duration: 30 } }]],
  ['speech', [VOICE]],
]

describe('every subcategory, from create_order to the result', () => {
  it.each(WALKS)('%s', async (_name, items) => {
    const text = await layOut(items)
    expect(text.startsWith(ORDER_RESULT_PREFIX), text).toBe(true)
    const final = await startOrder(orders()[0].id)
    expect(final?.state, JSON.stringify(final?.note)).toBe('done')
    const runs = orders()[0].items.flatMap((i) => i.runs)
    expect(runs.every((r) => r.status === 'done' && !!r.resultUrl)).toBe(true)
    expect(submitted.length).toBe(runs.length)
  })

  it('character: the options name what a run needs, and an unknown character is refused before anything is booked', async () => {
    const text = await runCreateOptions({ intent: 'character' }, defaultCreateToolEnv(CONV))
    expect(text).toMatch(/character/i)
    const order = await layOut([{ intent: 'character', prompt: 'portrait', options: { character: 'nobody-here' } }])
    expect(order.startsWith(ORDER_RESULT_PREFIX)).toBe(false)
    expect(submitted).toEqual([])
  })

  it('a clip handed where a picture belongs is refused at the order, with the reason', async () => {
    const text = await layOut([CLIP, { intent: 'edit', prompt: 'make it blue', inputs: { image: 'item:1' } }])
    expect(text.startsWith(ORDER_RESULT_PREFIX)).toBe(false)
    expect(text).toMatch(/video|clip|image/i)
    expect(submitted).toEqual([])
  })
})

describe('a sent job whose answer does not arrive is followed, not written off', () => {
  it('a poll that runs out leaves the run lost, not "could not start", and the catch-up settles it', async () => {
    await layOut([CLIP])
    const id = orders()[0].id
    useCreateOrderStore.getState().approve(id)
    const store = useCreateOrderStore.getState()
    // The first poll gives up the way the client does after its deadline.
    let polls = 0
    const deps = {
      ...(await import('../../../stores/createOrderStore')).cloudOrderDeps(() => (defaultCreateToolEnv(CONV) as never)),
      pollJob: async (jobId: string, o: { timeoutMs?: number }) => {
        polls += 1
        if (polls === 1) throw new CloudJobError('render timed out', 0)
        expect(o.timeoutMs).toBe(45 * 60_000) // a clip's own deadline, not the 15 minute default
        const { getJob } = await import('../../../api/cloud/jobs')
        return getJob(jobId)
      },
    }
    const after = await store.run(id, deps as never)
    const run = after.items[0].runs[0]
    expect(run.error).toBe(LOST_TRACK_ERROR)
    expect(after.note).toMatch(/is with LU Cloud/)
    expect(after.note).not.toMatch(/could not start/)
    // The catch-up runs from run()'s finally.
    await vi.waitFor(() => expect(orders()[0].items[0].runs[0].status).toBe('done'))
    expect(orders()[0].state).toBe('done')
    expect(orders()[0].items[0].runs[0].spent).toBe(100)
  })

  it('a network that goes away while polling: the same', async () => {
    await layOut([IMAGE])
    const id = orders()[0].id
    useCreateOrderStore.getState().approve(id)
    let polls = 0
    const deps = {
      ...(await import('../../../stores/createOrderStore')).cloudOrderDeps(() => (defaultCreateToolEnv(CONV) as never)),
      pollJob: async (jobId: string) => {
        polls += 1
        if (polls === 1) throw new CloudJobError('Could not reach the LU Cloud server. Check your connection.', 0)
        const { getJob } = await import('../../../api/cloud/jobs')
        return getJob(jobId)
      },
    }
    const after = await useCreateOrderStore.getState().run(id, deps as never)
    expect(after.items[0].runs[0].interrupted).toBe(true)
    await vi.waitFor(() => expect(orders()[0].state).toBe('done'))
  })

  it('after a reload a running job is followed with a Stop that reaches the server', async () => {
    await layOut([CLIP])
    const id = orders()[0].id
    useCreateOrderStore.getState().approve(id)
    jobStatus = () => 'running'
    // The order was running with a sent job when the window went away.
    const sent = orders()[0]
    const running = {
      ...sent,
      state: 'running' as const,
      items: sent.items.map((i) => ({ ...i, runs: i.runs.map((r) => ({ ...r, status: 'running' as const, jobId: '00000000-0000-4000-8000-0000000000aa' })) })),
    }
    useCreateOrderStore.getState().put(markInterrupted(running))
    expect(interruptedRuns(orders()[0])).toHaveLength(1)
    const pollStarted = new Promise<void>((resolve) => {
      void useCreateOrderStore.getState().catchUp(id, {
        getJob: ((jobId: string) => import('../../../api/cloud/jobs').then((m) => m.getJob(jobId))) as never,
        pollJob: ((_jobId: string, o: { signal?: AbortSignal }) => new Promise((_r, reject) => {
          resolve()
          o.signal?.addEventListener('abort', () => reject(new CloudJobError('polling aborted', 0)))
        })) as never,
      })
    })
    await pollStarted
    expect(useCreateOrderStore.getState().isRunning(id)).toBe(true)
    useCreateOrderStore.getState().stop(id)
    await vi.waitFor(() => expect(canceled).toEqual(['00000000-0000-4000-8000-0000000000aa']))
    await vi.waitFor(() => expect(orders()[0].items[0].runs[0].refunded).toBe(true))
    expect(useCreateOrderStore.getState().isRunning(id)).toBe(false)
  })

  it('a stop right after the submit asks the server instead of claiming a refund', async () => {
    await layOut([IMAGE])
    const id = orders()[0].id
    useCreateOrderStore.getState().approve(id)
    const controller = new AbortController()
    const deps = {
      ...(await import('../../../stores/createOrderStore')).cloudOrderDeps(() => (defaultCreateToolEnv(CONV) as never)),
      submitCloudJob: async () => { controller.abort(); return { id: '00000000-0000-4000-8000-0000000000bb' } },
      cancelJob: async (jobId: string) => { canceled.push(jobId); return { refunded: false } },
    }
    const after = await executeOrder(orders()[0], { ...deps, signal: controller.signal, onUpdate: () => {} } as never)
    const run = after.items[0].runs[0]
    expect(canceled).toContain('00000000-0000-4000-8000-0000000000bb')
    expect(run.refunded).toBe(false)
    expect(run.stoppedLate).toBe(true)
  })
})
