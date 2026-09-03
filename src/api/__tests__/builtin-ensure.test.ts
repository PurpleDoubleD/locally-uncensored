/**
 * Self-heal for the managed built-in engine (the "lazy reload" half of the
 * Create-tab VRAM offload). The provider awaits ensureBuiltinEngineAlive()
 * before every send on a managed slot; these tests pin the contract:
 * no-op on healthy/unmanaged/foreign models, restart with the right GGUF path
 * when the engine is down, and coalescing of concurrent sends.
 *
 * Run: npx vitest run src/api/__tests__/builtin-ensure.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let managed = true
let enabled = true
vi.mock('../../stores/providerStore', () => ({
  useProviderStore: {
    getState: () => ({ providers: { openai: { enabled, managed } } }),
  },
}))

const TUNING = { ctx: 16384, flashAttn: 'on', cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', threads: -1, gpuLayers: -1, mlock: false, noMmap: false }
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ settings: { builtinEngine: TUNING } }),
  },
}))

const backendCall = vi.fn()
vi.mock('../backend', () => ({
  backendCall: (...args: any[]) => backendCall(...args),
}))

import { ensureBuiltinEngineAlive } from '../builtin-ensure'

const MODELS = { models: [{ name: 'qwen2.5-0.5b', path: '/models/qwen2.5-0.5b.gguf' }] }

function mockEngine(opts: { healthy: boolean; list?: unknown }) {
  backendCall.mockImplementation(async (cmd: string) => {
    if (cmd === 'bundled_engine_status') return { running: opts.healthy, healthy: opts.healthy }
    if (cmd === 'list_bundled_models') return opts.list ?? MODELS
    if (cmd === 'start_bundled_engine') return { status: 'started' }
    throw new Error(`unexpected command ${cmd}`)
  })
}

const callsTo = (cmd: string) => backendCall.mock.calls.filter((c) => c[0] === cmd)

describe('ensureBuiltinEngineAlive', () => {
  beforeEach(() => {
    backendCall.mockReset()
    managed = true
    enabled = true
  })

  it('does nothing when the openai slot is not the managed engine', async () => {
    managed = false
    await ensureBuiltinEngineAlive('qwen2.5-0.5b')
    expect(backendCall).not.toHaveBeenCalled()
  })

  it('only probes when the engine is already healthy', async () => {
    mockEngine({ healthy: true })
    await ensureBuiltinEngineAlive('qwen2.5-0.5b')
    expect(callsTo('bundled_engine_status')).toHaveLength(1)
    expect(callsTo('start_bundled_engine')).toHaveLength(0)
  })

  it('restarts a dead engine with the bundled GGUF path AND the user tuning (prefixed name too)', async () => {
    mockEngine({ healthy: false })
    await ensureBuiltinEngineAlive('openai::qwen2.5-0.5b')
    const starts = callsTo('start_bundled_engine')
    expect(starts).toHaveLength(1)
    // Tuning rides along so a self-heal never silently drops configured
    // ctx/KV-quant back to defaults.
    expect(starts[0][1]).toEqual({ modelPath: '/models/qwen2.5-0.5b.gguf', tuning: TUNING })
  })

  it('never starts our engine for a model that is not one of ours, and says why', async () => {
    mockEngine({ healthy: false })
    // The slot is managed, so the send is about to hit our own port with
    // nothing behind it. Returning quietly here is what handed applejames a
    // raw "proxy_localhost_stream_chunked" on a fresh install (2026-08-01), so
    // the guard still refuses to start anything, but it no longer pretends
    // the send will work.
    await expect(ensureBuiltinEngineAlive('gpt-4o-mini')).rejects.toThrow(/no model file named "gpt-4o-mini"/i)
    expect(callsTo('start_bundled_engine')).toHaveLength(0)
  })

  it('coalesces concurrent sends into one probe/restart', async () => {
    let release!: (v: { running: boolean; healthy: boolean }) => void
    const gate = new Promise<{ running: boolean; healthy: boolean }>((r) => (release = r))
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'bundled_engine_status') return gate
      if (cmd === 'list_bundled_models') return MODELS
      if (cmd === 'start_bundled_engine') return { status: 'started' }
      throw new Error(`unexpected command ${cmd}`)
    })
    const a = ensureBuiltinEngineAlive('qwen2.5-0.5b')
    const b = ensureBuiltinEngineAlive('qwen2.5-0.5b')
    release({ running: false, healthy: false })
    await Promise.all([a, b])
    expect(callsTo('bundled_engine_status')).toHaveLength(1)
    expect(callsTo('start_bundled_engine')).toHaveLength(1)
  })

  it('swallows a failing status probe (non-Tauri context) without throwing', async () => {
    backendCall.mockRejectedValue(new Error('not in tauri'))
    await expect(ensureBuiltinEngineAlive('qwen2.5-0.5b')).resolves.toBeUndefined()
  })

  it('propagates a failed restart so the chat shows the real reason', async () => {
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'bundled_engine_status') return { running: true, healthy: false }
      if (cmd === 'list_bundled_models') return MODELS
      if (cmd === 'start_bundled_engine') throw new Error('CUDA out of memory\n--- engine log ---\nggml_cuda_init failed')
      throw new Error(`unexpected command ${cmd}`)
    })
    await expect(ensureBuiltinEngineAlive('qwen2.5-0.5b')).rejects.toThrow(/CUDA out of memory/)
  })
})

// The translated bubble text may hide the raw Rust line from the user, but a
// bug report still needs it. The old test pinned the raw text to the bubble;
// this one pins its replacement path, the app log. Whoever removes the
// log.warn in explainEngineTransportMessage turns this red.
import { explainEngineTransportMessage } from '../builtin-ensure'
import { log } from '../../lib/logger'

describe('explainEngineTransportMessage keeps the raw line reachable', () => {
  it('logs the verbatim transport error while the bubble gets plain english', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const raw = 'proxy_localhost_stream_chunked: error sending request for url (http://127.0.0.1:8127/v1/chat/completions)'
    const text = explainEngineTransportMessage(raw, 'http://127.0.0.1:8127')
    expect(text).toMatch(/LU Engine is not answering/)
    expect(text).not.toContain('proxy_localhost')
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ raw }))
    warn.mockRestore()
  })
})
