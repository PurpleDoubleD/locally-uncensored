import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { log, _scrubForTest } from '../logger'

describe('logger scrubber', () => {
  it('redacts top-level secret-like keys', () => {
    const r = _scrubForTest({
      ok: 1,
      password: 'p',
      apiKey: 'k',
      api_key: 'k',
      authorization: 'Bearer x',
      cookie: 'c',
      service_role: 'srv',
      private_key: 'pk',
      token: 't',
    }) as Record<string, unknown>
    expect(r.ok).toBe(1)
    for (const k of [
      'password',
      'apiKey',
      'api_key',
      'authorization',
      'cookie',
      'service_role',
      'private_key',
      'token',
    ]) {
      expect(r[k]).toBe('[REDACTED]')
    }
  })

  it('recurses into nested objects', () => {
    const r = _scrubForTest({
      user: { id: 'u', authorization: 'Bearer x' },
    }) as { user: { id: string; authorization: string } }
    expect(r.user.id).toBe('u')
    expect(r.user.authorization).toBe('[REDACTED]')
  })

  it('walks arrays without losing them', () => {
    const r = _scrubForTest({ items: [{ password: 'p' }, { ok: 1 }] }) as {
      items: Array<Record<string, unknown>>
    }
    expect(r.items[0].password).toBe('[REDACTED]')
    expect(r.items[1].ok).toBe(1)
  })

  it('caps recursion depth so cyclic-but-bounded input still scrubs', () => {
    let deep: Record<string, unknown> = { password: 'p' }
    for (let i = 0; i < 20; i++) deep = { next: deep }
    const r = _scrubForTest(deep)
    expect(JSON.stringify(r)).toBeTruthy()
  })

  it('passes through primitives unchanged', () => {
    expect(_scrubForTest(null)).toBeNull()
    expect(_scrubForTest(undefined)).toBeUndefined()
    expect(_scrubForTest(42)).toBe(42)
    expect(_scrubForTest('hi')).toBe('hi')
  })
})

describe('log levels', () => {
  const originalEnv = process.env.NODE_ENV

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env.NODE_ENV = originalEnv
    vi.restoreAllMocks()
  })

  it('writes JSON in production and skips debug', () => {
    process.env.NODE_ENV = 'production'
    log.debug('skipped')
    log.info('hello', { a: 1 })
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('"skipped"'))
    const infoCall = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(typeof infoCall).toBe('string')
    expect(JSON.parse(infoCall)).toMatchObject({ level: 'info', msg: 'hello', a: 1 })
  })

  it('routes warn/error through console.error in production', () => {
    process.env.NODE_ENV = 'production'
    log.warn('bad')
    log.error('worse')
    expect(console.error).toHaveBeenCalledTimes(2)
  })

  it('serialises an Error object into name/message/stack', () => {
    process.env.NODE_ENV = 'production'
    log.error('boom', { err: new Error('kapow') })
    const line = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    const parsed = JSON.parse(line)
    expect(parsed.err.message).toBe('kapow')
    expect(parsed.err.name).toBe('Error')
    expect(typeof parsed.err.stack).toBe('string')
  })

  it('renders human-readable output in dev', () => {
    process.env.NODE_ENV = 'development'
    log.info('hello', { a: 1 })
    expect(console.log).toHaveBeenCalledWith('[info]', 'hello', { a: 1 })
  })
})

// ── Audit #01 — mirroring warn/error into the Rust log file ──────────
//
// A shipped desktop app has no stdout and no open DevTools console, so
// everything above this line went nowhere on a user's machine. warn/error are
// additionally handed to the `log_write` Tauri command, which writes them into
// the same rolling file as the Rust side.

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }))

/** Pretend to be inside the Tauri WebView, the way isTauri() detects it. */
function enterTauri() {
  ;(globalThis as Record<string, unknown>).window = { __TAURI_INTERNALS__: {} }
}
function leaveTauri() {
  delete (globalThis as Record<string, unknown>).window
}

/**
 * Let the mirror's promise chain run. The mirror resolves the Tauri module
 * with a dynamic `import()`, so the first call in the file needs a real turn
 * of the event loop, not just a microtask.
 */
const flush = () => new Promise((r) => setTimeout(r, 0))

/** The args of the last log_write invoke, or null when nothing was mirrored. */
function lastMirror(): { level: string; target: string; message: string } | null {
  const call = invokeMock.mock.calls.filter((c) => c[0] === 'log_write').pop()
  return call ? (call[1] as { level: string; target: string; message: string }) : null
}

describe('mirroring to the app log file', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    enterTauri()
  })

  afterEach(() => {
    leaveTauri()
    vi.restoreAllMocks()
  })

  it('mirrors warn and error', async () => {
    log.warn('disk nearly full')
    log.error('model load failed')
    await flush()
    const levels = invokeMock.mock.calls
      .filter((c) => c[0] === 'log_write')
      .map((c) => (c[1] as { level: string }).level)
    expect(levels).toEqual(['warn', 'error'])
  })

  it('loses nothing when two lines land in the same tick', async () => {
    // Regression: with the resolved invoke memoised instead of the import
    // PROMISE, the second call of a burst started its own dynamic import and
    // its line went missing — and a burst is exactly what an error cascade is.
    log.error('first')
    log.error('second')
    log.warn('third')
    await flush()
    const msgs = invokeMock.mock.calls
      .filter((c) => c[0] === 'log_write')
      .map((c) => (c[1] as { message: string }).message)
    expect(msgs).toEqual(['first', 'second', 'third'])
  })

  it('does NOT mirror debug or info — they are the noise levels', async () => {
    // Render loops, polling and token streams live at these levels. Mirroring
    // them would drown the two levels a support log is read for, and cost an
    // IPC round trip per line.
    log.debug('tick')
    log.info('rendered 60 frames')
    await flush()
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'log_write')).toHaveLength(0)
  })

  it('stays silent outside Tauri — a browser has no log file to write to', async () => {
    leaveTauri()
    log.error('boom')
    await flush()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('scrubs BEFORE mirroring, so no secret reaches the file', async () => {
    // The whole point of the file is that a user attaches it to a bug report.
    // A key that the console redacts but the file keeps would be a leak with
    // a delivery mechanism.
    log.error('provider call failed', { apiKey: 'sk-live-123', nested: { token: 'tok-abc' }, model: 'llama3' })
    await flush()
    const args = lastMirror()
    expect(args).not.toBeNull()
    expect(args!.message).not.toContain('sk-live-123')
    expect(args!.message).not.toContain('tok-abc')
    expect(args!.message).toContain('[REDACTED]')
    // …and the harmless context still makes it through, or the file is useless.
    expect(args!.message).toContain('llama3')
    expect(args!.message).toContain('provider call failed')
  })

  it('mirrors a serialised Error, not an empty object', async () => {
    log.error('crashed', { err: new Error('kapow') })
    await flush()
    expect(lastMirror()!.message).toContain('kapow')
  })

  it('never throws when the invoke rejects', async () => {
    // Logging is called from catch blocks. A logger that can fail turns a
    // handled error into an unhandled one.
    invokeMock.mockRejectedValue(new Error('command log_write not allowed by scope'))
    expect(() => log.error('boom')).not.toThrow()
    await flush()
  })

  it('never throws when the invoke throws synchronously', () => {
    invokeMock.mockImplementation(() => {
      throw new Error('IPC bridge gone')
    })
    expect(() => log.warn('bad')).not.toThrow()
  })

  it('never throws on a cyclic context and still logs the message', async () => {
    // scrub() caps recursion depth instead of tracking visited nodes, so a
    // cycle survives it and JSON.stringify would throw on the way to the file.
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    expect(() => log.error('cycle', { cyclic })).not.toThrow()
    await flush()
    expect(lastMirror()!.message).toContain('cycle')
  })

  it('still writes to the console when it mirrors', async () => {
    // The mirror is additional, not a replacement: a developer with DevTools
    // open must keep seeing what they always saw.
    process.env.NODE_ENV = 'production'
    log.error('both places')
    await flush()
    expect(console.error).toHaveBeenCalled()
    expect(lastMirror()).not.toBeNull()
    process.env.NODE_ENV = 'test'
  })
})
