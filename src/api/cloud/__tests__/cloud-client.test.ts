import { describe, it, expect, vi, beforeEach } from 'vitest'

// Cloud client: bearer injection, base-URL prefixing, error mapping, and the
// jobs wrappers on top. getAccessToken is mocked (no live Supabase); fetch is
// stubbed per test.

const { getAccessToken } = vi.hoisted(() => ({ getAccessToken: vi.fn() }))
vi.mock('../supabase', () => ({ getAccessToken }))

import { cloudFetch, jsonOrError, CloudJobError } from '../client'
import { submitCloudJob, uploadInput, getJob, getQuota } from '../jobs'
import { CLOUD_BASE } from '../config'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  getAccessToken.mockResolvedValue('tok-123')
})

/** A fetch that never answers on its own, and that ends the same way a real
 *  one does when its signal aborts — including a signal that was already
 *  aborted before the call. */
function hangingFetch(onAbort?: () => void) {
  return (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const stop = () => {
        onAbort?.()
        reject(new Error('aborted'))
      }
      if (init.signal?.aborted) stop()
      else init.signal?.addEventListener('abort', stop, { once: true })
    })
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('cloudFetch', () => {
  it('prefixes CLOUD_BASE and injects the bearer token', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true }))
    await cloudFetch('/api/me')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${CLOUD_BASE}/api/me`)
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok-123')
  })

  it('throws a 401 CloudJobError when signed out (no network call)', async () => {
    getAccessToken.mockResolvedValue(null)
    await expect(cloudFetch('/api/me')).rejects.toMatchObject({
      name: 'CloudJobError',
      status: 401,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('gives up on a connection that never answers', async () => {
    // The wedge this bounds: a half-open socket during an upload or a submit.
    // fetch never settles on its own, every Create run awaits it, so the whole
    // surface stayed frozen at "Submitting to the render queue…" until the app
    // was restarted.
    vi.useFakeTimers()
    fetchMock.mockImplementation(hangingFetch())
    const pending = cloudFetch('/api/jobs', { method: 'POST', body: '{"x":1}' })
    const settled = pending.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(120_000)
    const err = await settled
    expect(err).toBeInstanceOf(CloudJobError)
    expect((err as CloudJobError).status).toBe(408)
    vi.useRealTimers()
  })

  it('an upload gets a deadline that grows with the bytes it has to push', async () => {
    // A flat ceiling would cut a legitimate large clip off on a slow uplink.
    vi.useFakeTimers()
    let aborted = false
    fetchMock.mockImplementation(hangingFetch(() => { aborted = true }))
    const big = new ArrayBuffer(40 * 1024 * 1024)
    const settled = cloudFetch('/api/jobs/upload?role=video', { method: 'POST', body: big }).catch(
      (e: unknown) => e,
    )
    await vi.advanceTimersByTimeAsync(120_000)
    expect(aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(await settled).toBeInstanceOf(CloudJobError)
    vi.useRealTimers()
  })

  it('gives up when the TOKEN never arrives, not only when the request does not', async () => {
    // getAccessToken() is not a local lookup: supabase-js refreshes an expired
    // access token there, over the network, with no deadline of its own. The
    // guard used to be armed AFTER that await, so a refresh whose peer
    // disappeared mid-flight wedged Create exactly the way a hanging fetch did
    // — one step earlier, and past every clock this file installs.
    vi.useFakeTimers()
    getAccessToken.mockImplementation(() => new Promise(() => {}))
    const settled = cloudFetch('/api/jobs', { method: 'POST', body: '{"x":1}' }).catch(
      (e: unknown) => e,
    )
    await vi.advanceTimersByTimeAsync(120_000)
    const err = await settled
    expect(err).toBeInstanceOf(CloudJobError)
    expect((err as CloudJobError).status).toBe(408)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("the caller's cancel also ends a token refresh that is hanging", async () => {
    getAccessToken.mockImplementation(() => new Promise(() => {}))
    const ac = new AbortController()
    const settled = cloudFetch('/api/me', { signal: ac.signal }).catch((e: unknown) => e)
    ac.abort()
    const err = await settled
    // A cancelled run is not a timeout, here just as much as at the fetch.
    expect(err).not.toBeInstanceOf(CloudJobError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a 401 raised inside the window keeps its own status', async () => {
    // The deadline wraps the token now, so "not signed in" travels the same
    // catch as a timeout and must not come out relabelled 408.
    getAccessToken.mockResolvedValue(null)
    await expect(cloudFetch('/api/me')).rejects.toMatchObject({ status: 401 })
  })

  it('measures a FormData body instead of counting it as zero bytes', async () => {
    // deadlineFor only knew ArrayBuffer, views, Blob and string. FormData,
    // URLSearchParams and a stream all measured 0 and silently took the flat
    // ceiling, while the comment above it promised a size-derived deadline.
    vi.useFakeTimers()
    let aborted = false
    fetchMock.mockImplementation(hangingFetch(() => { aborted = true }))
    const fd = new FormData()
    fd.append('clip', new Blob(['x'.repeat(1024 * 1024)]))
    const settled = cloudFetch('/api/jobs/upload?role=video', { method: 'POST', body: fd }).catch(
      (e: unknown) => e,
    )
    // 1 MiB at the 64 B/ms floor buys ~16 s on top of the 60 s ceiling.
    await vi.advanceTimersByTimeAsync(65_000)
    expect(aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await settled).toBeInstanceOf(CloudJobError)
    vi.useRealTimers()
  })

  it('measures a URLSearchParams body too', async () => {
    vi.useFakeTimers()
    let aborted = false
    fetchMock.mockImplementation(hangingFetch(() => { aborted = true }))
    const params = new URLSearchParams()
    params.set('payload', 'x'.repeat(1024 * 1024))
    const settled = cloudFetch('/api/jobs', { method: 'POST', body: params }).catch(
      (e: unknown) => e,
    )
    await vi.advanceTimersByTimeAsync(65_000)
    expect(aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await settled).toBeInstanceOf(CloudJobError)
    vi.useRealTimers()
  })

  it("hands the caller's abort signal through to the request", async () => {
    // pollJob and generate() both hold an AbortController for the run; before
    // this, cancelling could not reach a request already in flight.
    const ac = new AbortController()
    let seen: AbortSignal | undefined
    let inFlight!: () => void
    const started = new Promise<void>((resolve) => { inFlight = resolve })
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      seen = init.signal ?? undefined
      inFlight()
      return hangingFetch()(url, init)
    })
    const settled = cloudFetch('/api/me', { signal: ac.signal }).catch((e: unknown) => e)
    // Wait for the request to be genuinely in flight before cancelling. The
    // deadline now also covers the token step, so aborting before fetch is
    // reached (correctly) means no request is ever issued — which is the
    // adjacent test, not this one.
    await started
    ac.abort()
    const err = await settled
    expect(seen?.aborted).toBe(true)
    // A cancelled run is not a timeout — it must not be relabelled as one.
    expect(err).not.toBeInstanceOf(CloudJobError)
  })

  it('an already-aborted signal never reaches the network', async () => {
    fetchMock.mockImplementation(hangingFetch())
    const ac = new AbortController()
    ac.abort()
    await expect(cloudFetch('/api/me', { signal: ac.signal })).rejects.toThrow()
  })

  it('preserves method, body and extra headers', async () => {
    fetchMock.mockResolvedValue(jsonRes({}))
    await cloudFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"x":1}',
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"x":1}')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
  })
})

describe('jsonOrError', () => {
  it('returns the parsed body on 2xx', async () => {
    await expect(jsonOrError(jsonRes({ id: 'j1' }, 202))).resolves.toEqual({ id: 'j1' })
  })

  it('maps { error } bodies to CloudJobError with the status', async () => {
    const err = await jsonOrError(jsonRes({ error: 'monthly credit budget exhausted' }, 429)).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(CloudJobError)
    expect((err as CloudJobError).status).toBe(429)
    expect((err as CloudJobError).message).toBe('monthly credit budget exhausted')
  })

  it('falls back to a generic message on non-JSON error bodies', async () => {
    const res = new Response('gateway timeout', { status: 504 })
    const err = await jsonOrError(res).catch((e: unknown) => e)
    expect((err as CloudJobError).message).toBe('request failed (504)')
  })

  it('keeps the server code and retry-after, which a bare 429 cannot tell apart', async () => {
    const res = new Response(JSON.stringify({ error: 'too many requests', code: 'rate_limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '30' },
    })
    const err = (await jsonOrError(res).catch((e: unknown) => e)) as CloudJobError
    expect(err.code).toBe('rate_limited')
    expect(err.retryAfterMs).toBe(30_000)
  })

  it('a 2xx whose body never finished arriving is an error, not an empty result', async () => {
    // What a cut-off response looks like once cloudFetch's deadline aborts the
    // read mid-body. Returning {} here handed submitCloudJob an undefined id
    // and left the run polling a job that never existed.
    const torn = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"id":"j1"'))
          c.error(new Error('network closed'))
        },
      }),
      { status: 200 },
    )
    await expect(jsonOrError(torn)).rejects.toThrow(/incomplete/)
  })

  it('but an empty 2xx body still resolves', async () => {
    // A 204-style answer from a route that returns nothing is not a failure.
    await expect(jsonOrError(new Response('', { status: 200 }))).resolves.toEqual({})
  })
})

describe('jobs wrappers', () => {
  it('submitCloudJob posts the submit payload and returns id + quota', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 'j1', quota: { cost: 5, used: 10, limit: 800 } }, 202))
    const out = await submitCloudJob({
      kind: 'image',
      model: 'flux-schnell',
      prompt: 'a lighthouse',
      params: { op: 'generate' },
    })
    expect(out.id).toBe('j1')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${CLOUD_BASE}/api/jobs`)
    expect(JSON.parse(String(init.body)).model).toBe('flux-schnell')
  })

  it('uploadInput sends raw bytes with the role in the query and returns the path', async () => {
    fetchMock.mockResolvedValue(jsonRes({ path: 'uid/abc.png', role: 'source' }, 201))
    const path = await uploadInput(new Blob(['x']), 'source')
    expect(path).toBe('uid/abc.png')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${CLOUD_BASE}/api/jobs/upload?role=source`)
    // WKWebView fails cross-origin FormData(Blob) bodies — the contract is a
    // bare ArrayBuffer with the octet-stream content type.
    expect(init.body).toBeInstanceOf(ArrayBuffer)
    expect((init.headers as Headers).get('content-type')).toBe('application/octet-stream')
  })

  it('getJob unwraps { job } and encodes the id', async () => {
    fetchMock.mockResolvedValue(jsonRes({ job: { id: 'j 1', status: 'queued' } }))
    const job = await getJob('j 1')
    expect(job.id).toBe('j 1')
    expect(fetchMock.mock.calls[0][0]).toBe(`${CLOUD_BASE}/api/jobs/j%201`)
  })

  it('getQuota surfaces 402 (no license) as CloudJobError', async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: 'no active license' }, 402))
    await expect(getQuota()).rejects.toMatchObject({ status: 402 })
  })
})
