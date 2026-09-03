/**
 * GH #118 (nayffy, 2026-08-27, Windows 11, v2.6.6): "Built in engine test
 * fails and console shows as below", followed by
 * `GET http://127.0.0.1:8127/v1/models net::ERR_CONNECTION_REFUSED`.
 *
 * The Test button in Settings, AI Backends turned a refused connection into a
 * red dot and nothing else. The app owns that process, so a refusal is a
 * question it can answer: is the engine up, is there a model to run at all,
 * does starting it work. House rule is self-healing before an error message,
 * so with `repair` the start is attempted first and only what survives that
 * becomes a sentence.
 *
 * Run: npx vitest run src/api/__tests__/builtin-engine-diagnose.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, backendCall: vi.fn() }
})

import { diagnoseBuiltinEngine } from '../builtin-ensure'
import { backendCall } from '../backend'
import { useProviderStore } from '../../stores/providerStore'

const asManagedSlot = () => {
  useProviderStore.setState((s) => ({
    providers: {
      ...s.providers,
      openai: { ...s.providers.openai, enabled: true, managed: true, baseUrl: 'http://127.0.0.1:8127/v1' },
    },
  }))
}

const asForeignSlot = () => {
  useProviderStore.setState((s) => ({
    providers: {
      ...s.providers,
      openai: { ...s.providers.openai, enabled: true, managed: false, baseUrl: 'https://api.openai.com/v1' },
    },
  }))
}

/** Answer the two probe commands; everything else throws. */
const backend = (
  status: unknown,
  models: unknown,
  onStart?: (args: unknown) => unknown,
) => {
  vi.mocked(backendCall).mockImplementation((async (cmd: string, args: unknown) => {
    if (cmd === 'bundled_engine_status') {
      if (status instanceof Error) throw status
      return status
    }
    if (cmd === 'list_bundled_models') {
      if (models instanceof Error) throw models
      return models
    }
    if (cmd === 'start_bundled_engine') {
      if (!onStart) throw new Error('start not expected in this case')
      return onStart(args)
    }
    throw new Error(`unexpected command ${cmd}`)
  }) as never)
}

describe('diagnoseBuiltinEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    asManagedSlot()
  })

  it('stays silent for a slot that is not ours', async () => {
    asForeignSlot()
    const d = await diagnoseBuiltinEngine({ repair: true })
    expect(d).toEqual({ ok: false, reason: '', repaired: false })
    expect(backendCall).not.toHaveBeenCalled()
  })

  it('reports ok without touching anything when the engine is healthy', async () => {
    backend({ running: true, healthy: true }, { models: [] })
    const d = await diagnoseBuiltinEngine({ repair: true })
    expect(d.ok).toBe(true)
    expect(d.repaired).toBe(false)
  })

  it('names the missing model instead of the refused connection', async () => {
    backend({ running: false, healthy: false }, { models: [] })
    const d = await diagnoseBuiltinEngine({ repair: true })
    expect(d.ok).toBe(false)
    expect(d.reason).toMatch(/no chat model to load yet/i)
    expect(d.reason).toMatch(/Models, Discover/i)
  })

  it('does not count an embedding GGUF as a chat model', async () => {
    backend({ running: false, healthy: false }, {
      models: [{ name: 'nomic-embed-text-v1.5.Q4_K_M', path: '/m/nomic.gguf' }],
    })
    const d = await diagnoseBuiltinEngine({ repair: true })
    expect(d.reason).toMatch(/no chat model to load yet/i)
  })

  it('starts the engine on an installed model, which is the whole point', async () => {
    const started: unknown[] = []
    backend(
      { running: false, healthy: false },
      { models: [{ name: 'Cydonia-24B-v4.1-Q4_K_M', path: '/m/cydonia.gguf' }] },
      (args) => { started.push(args); return { status: 'started' } },
    )
    const d = await diagnoseBuiltinEngine({ repair: true })
    expect(d.ok).toBe(true)
    expect(d.repaired).toBe(true)
    expect(started).toEqual([{ modelPath: '/m/cydonia.gguf', tuning: expect.anything() }])
  })

  it('prefers the model the user already picked', async () => {
    const started: Array<{ modelPath?: string }> = []
    backend(
      { running: false, healthy: false },
      {
        models: [
          { name: 'first', path: '/m/first.gguf' },
          { name: 'second', path: '/m/second.gguf' },
        ],
      },
      (args) => { started.push(args as { modelPath?: string }); return { status: 'started' } },
    )
    await diagnoseBuiltinEngine({ repair: true, preferModel: 'openai::second' })
    expect(started[0].modelPath).toBe('/m/second.gguf')
  })

  it('hands the engine s own reason through when the start fails', async () => {
    backend(
      { running: false, healthy: false },
      { models: [{ name: 'Cydonia', path: '/m/cydonia.gguf' }] },
      () => { throw new Error('CUDA error: no kernel image is available') },
    )
    const d = await diagnoseBuiltinEngine({ repair: true })
    expect(d.ok).toBe(false)
    expect(d.reason).toMatch(/could not start "Cydonia"/)
    expect(d.reason).toContain('CUDA error: no kernel image is available')
  })

  it('never starts anything without repair, and still says what is wrong', async () => {
    const calls: string[] = []
    vi.mocked(backendCall).mockImplementation((async (cmd: string) => {
      calls.push(cmd)
      if (cmd === 'bundled_engine_status') return { running: false, healthy: false }
      if (cmd === 'list_bundled_models') return { models: [{ name: 'Cydonia', path: '/m/c.gguf' }] }
      throw new Error(`unexpected command ${cmd}`)
    }) as never)
    const d = await diagnoseBuiltinEngine({ repair: false })
    expect(calls).not.toContain('start_bundled_engine')
    expect(d.reason).toMatch(/not running/i)
    expect(d.reason).toMatch(/1 model is installed/i)
  })

  it('says so when the model folder itself cannot be read', async () => {
    backend({ running: false, healthy: false }, new Error('Create LU Engine models folder: permission denied'))
    const d = await diagnoseBuiltinEngine({ repair: true })
    expect(d.reason).toMatch(/model folder could not be read/i)
    expect(d.reason).toContain('permission denied')
  })

  it('keeps out of the way when there is no Tauri backend at all', async () => {
    backend(new Error('not in tauri'), { models: [] })
    const d = await diagnoseBuiltinEngine({ repair: true })
    expect(d).toEqual({ ok: false, reason: '', repaired: false })
  })
})
