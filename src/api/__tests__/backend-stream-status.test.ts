/**
 * localFetchStream transport tests (rikki Discord 2026-06-10 — Win11 "agent error").
 *
 * The chunked Rust proxy rejects with the STRING "HTTP <status>: <body>" when
 * the local backend answered non-2xx. These tests pin the three behaviours the
 * fix introduced:
 *   1. Tauri + loopback target → proxy-FIRST (no doomed direct fetch on WebView2)
 *   2. invoke rejection with HTTP shape → faithful Response status/body
 *      (so `res.status === 400` think-downgrade logic behaves like on Linux)
 *   3. invoke rejection without HTTP shape → 503 (retryable transport error)
 * plus the EOF-marker semantics: chunks delivered AFTER the invoke promise
 * resolves (WebView2 149 ordering) still reach the reader.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const invokeMock = vi.fn()
class MockChannel<T = unknown> {
  onmessage: (msg: T) => void = () => {}
}
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: MockChannel,
}))

import { localFetchStream, parseProxyHttpError } from '../backend'
import { isRecord } from '../../types/json-guards'

const fetchMock = vi.fn()

/** Was backend.ts an `invoke('proxy_localhost_stream_chunked', …)` uebergibt. */
type ChunkedInvokeArgs = {
  url: string
  method: string
  body: string | null
  headers: Record<string, string> | null
  onChunk: MockChannel<number[]>
  streamId: string
}

function tauriMode(on: boolean) {
  // Reflect statt eines Casts: die DOM-Typen deklarieren `globalThis.window`
  // als vollstaendiges `Window`, und genau daran ist das `as any` gehangen.
  const existing: unknown = Reflect.get(globalThis, 'window')
  const w: Record<string, unknown> = isRecord(existing) ? existing : {}
  Reflect.set(globalThis, 'window', w)
  if (on) w.__TAURI_INTERNALS__ = {}
  else { delete w.__TAURI_INTERNALS__; delete w.__TAURI__ }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  tauriMode(false)
})

describe('parseProxyHttpError', () => {
  it('parses the bare Rust proxy shape', () => {
    expect(parseProxyHttpError('HTTP 400: {"error":"x does not support tools"}'))
      .toEqual({ status: 400, body: '{"error":"x does not support tools"}' })
  })

  it('parses a prefixed command shape', () => {
    expect(parseProxyHttpError('pull_model_stream: HTTP 502: bad gateway'))
      .toEqual({ status: 502, body: 'bad gateway' })
  })

  it('returns null for transport errors', () => {
    expect(parseProxyHttpError('proxy_localhost_stream_chunked: error sending request: connection refused')).toBeNull()
    expect(parseProxyHttpError('connection refused')).toBeNull()
  })

  it('rejects out-of-range status numbers', () => {
    expect(parseProxyHttpError('HTTP 99: nope')).toBeNull()
  })
})

describe('localFetchStream in Tauri mode (loopback → proxy-first)', () => {
  it('does NOT attempt a direct fetch for loopback targets', async () => {
    tauriMode(true)
    invokeMock.mockImplementationOnce((_cmd: string, args: ChunkedInvokeArgs) => {
      // Immediately EOF an empty-but-successful stream.
      queueMicrotask(() => args.onChunk.onmessage([]))
      return new Promise(() => {}) // never resolves — EOF settles the Response
    })

    const res = await localFetchStream('http://localhost:11434/api/chat', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls[0][0]).toBe('proxy_localhost_stream_chunked')
  })

  it('rebuilds a faithful Response when the backend answered non-2xx', async () => {
    tauriMode(true)
    invokeMock.mockRejectedValueOnce('HTTP 400: {"error":"registry.ollama.ai/library/foo does not support tools"}')

    const res = await localFetchStream('http://127.0.0.1:11434/api/chat', { method: 'POST', body: '{}' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('does not support tools')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps transport failures to a retryable 503', async () => {
    tauriMode(true)
    invokeMock.mockRejectedValueOnce('proxy_localhost_stream_chunked: error sending request for url (http://localhost:11434/api/chat): connection refused')

    const res = await localFetchStream('http://localhost:11434/api/chat', { method: 'POST', body: '{}' })
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('connection refused')
  })

  it('delivers chunks that arrive AFTER the invoke promise resolved (WebView2 149 ordering)', async () => {
    tauriMode(true)
    let channel!: MockChannel<number[]>
    invokeMock.mockImplementationOnce((_cmd: string, args: ChunkedInvokeArgs) => {
      channel = args.onChunk
      return Promise.resolve()
    })

    const res = await localFetchStream('http://localhost:11434/api/chat', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)

    const enc = new TextEncoder()
    channel.onmessage(Array.from(enc.encode('{"message":{"content":"hel')))
    channel.onmessage(Array.from(enc.encode('lo"}}\n')))
    channel.onmessage([]) // Rust EOF marker

    expect(await res.text()).toBe('{"message":{"content":"hello"}}\n')
  })

  it('keeps direct-fetch-first for non-loopback (LAN) targets', async () => {
    tauriMode(true)
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await localFetchStream('http://192.168.1.50:1234/v1/chat/completions', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe('localFetchStream in dev mode (no Tauri)', () => {
  it('uses a plain direct fetch', async () => {
    tauriMode(false)
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await localFetchStream('/api/chat', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
