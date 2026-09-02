/**
 * A14 (2.6.8): the app-managed llama-server sidecar shipped as "Built-in
 * Engine" and is called "LU Engine" from now on.
 *
 * The rename is only a label, so the risk is not that the new name is wrong
 * anywhere. It is that the OLD name is still on disk: every `lu-providers`
 * blob written by 2.5.7 through 2.6.7 carries it on the openai slot, and a
 * second copy of it in the `displaced` memory when another backend pushed the
 * engine aside. Two things therefore have to hold at once, and both are pinned
 * here:
 *
 *   1. everything that ASKS "is this the app's own engine" answers yes to both
 *      names, so an old store does not lose its VRAM handling or its INSTALLED
 *      badges the moment it is opened by 2.6.8,
 *   2. everything the user READS says LU Engine, including the card drawn from
 *      that old store.
 *
 * The negative controls are the reason the matcher is a substring test and not
 * a free-for-all: a backend the user named himself must survive both.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LU_ENGINE_NAME, LEGACY_ENGINE_NAME, isLuEngineName, renameLegacyEngine } from '../engine-name'
import { isBuiltinEngineEntry } from '../lmstudio-match'

vi.mock('../../api/providers/registry', () => ({ clearProviderCache: vi.fn() }))
vi.mock('../../api/backend', () => ({
  secretGet: vi.fn().mockRejectedValue(new Error('no vault')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
  isTauri: () => false,
  backendCall: vi.fn(),
}))

describe('the name itself', () => {
  it('is the one the user reads', () => {
    expect(LU_ENGINE_NAME).toBe('LU Engine')
    expect(LEGACY_ENGINE_NAME).toBe('Built-in Engine')
  })
})

describe('isLuEngineName answers for both names', () => {
  it('the new one', () => {
    expect(isLuEngineName('LU Engine')).toBe(true)
    expect(isLuEngineName('lu engine')).toBe(true)
  })

  it('the one still sitting in every store written before 2.6.8', () => {
    expect(isLuEngineName('Built-in Engine')).toBe(true)
    expect(isLuEngineName('built-in engine')).toBe(true)
    expect(isLuEngineName('Built in Engine')).toBe(true)
  })

  // NEGATIVE CONTROL. A matcher that says yes to everything would make every
  // test above pass and would stop the LM Studio slot from ever being told
  // apart from ours, which is the switch modelStore hangs the VRAM eviction on.
  it('and to nothing else', () => {
    for (const other of ['Ollama', 'LM Studio', 'LU Cloud', 'Anthropic', 'Jan', 'llama.cpp', 'vLLM', '', null, undefined]) {
      expect(isLuEngineName(other), `${other}`).toBe(false)
    }
  })
})

describe('the INSTALLED badge reads a row under either name', () => {
  const row = (providerName: string) => ({ provider: 'openai', providerName, model: 'qwen2.5-0.5b-instruct-q8_0' })

  it('a row stamped by 2.6.8', () => {
    expect(isBuiltinEngineEntry(row(LU_ENGINE_NAME))).toBe(true)
  })

  it('a row recorded by an older version and still in the chat', () => {
    expect(isBuiltinEngineEntry(row(LEGACY_ENGINE_NAME))).toBe(true)
  })

  // NEGATIVE CONTROL: an LM Studio row shares provider 'openai' with ours and
  // must not be sent through the engine repair on a Use press.
  it('but never an LM Studio row, which shares the openai provider id', () => {
    expect(isBuiltinEngineEntry(row('LM Studio'))).toBe(false)
    expect(isBuiltinEngineEntry({ provider: 'ollama', providerName: LU_ENGINE_NAME })).toBe(false)
  })
})

describe('renameLegacyEngine relabels only the shipped name', () => {
  it('swaps the old label for the new one', () => {
    expect(renameLegacyEngine({ name: 'Built-in Engine', baseUrl: 'x' })).toEqual({ name: 'LU Engine', baseUrl: 'x' })
  })

  it('leaves a config that already carries the new name alone, object identity included', () => {
    const cfg = { name: 'LU Engine' }
    expect(renameLegacyEngine(cfg)).toBe(cfg)
  })

  // NEGATIVE CONTROL: the user's own backend keeps the name he typed. A blanket
  // rename would take it from him on the first launch after the update.
  it('never touches a backend the user named himself', () => {
    for (const name of ['Jan', 'My built-in box', 'Ollama', 'LM Studio']) {
      expect(renameLegacyEngine({ name }).name, name).toBe(name)
    }
  })
})

// ── The store the user actually has on disk ──────────────────────────────────

function installLocalStorage(seed?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(seed ?? {}))
  const ls = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => { map.clear() },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size },
  }
  vi.stubGlobal('localStorage', ls)
  vi.stubGlobal('window', { localStorage: ls })
}

async function freshStore() {
  vi.resetModules()
  const mod = await import('../../stores/providerStore')
  return mod.useProviderStore
}

describe('a store written before the rename opens under the new name', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  beforeEach(() => { vi.resetModules() })

  it('the openai slot the engine holds is relabelled', async () => {
    installLocalStorage({
      'lu-providers': JSON.stringify({
        version: 1,
        state: {
          providers: {
            openai: { id: 'openai', name: 'Built-in Engine', enabled: true, baseUrl: 'http://127.0.0.1:8127/v1', apiKey: '', isLocal: true, managed: true },
          },
        },
      }),
    })
    const store = await freshStore()
    expect(store.getState().providers.openai.name).toBe('LU Engine')
    // The rename must not switch the engine off or hand the slot away.
    expect(store.getState().providers.openai.enabled).toBe(true)
    expect(store.getState().providers.openai.managed).toBe(true)
  })

  it('and so is the standby card it left behind when another backend took the slot', async () => {
    installLocalStorage({
      'lu-providers': JSON.stringify({
        version: 1,
        state: {
          providers: {
            openai: {
              id: 'openai', name: 'Jan', enabled: true, baseUrl: 'http://localhost:1337/v1', apiKey: '', isLocal: true, managed: false,
              displaced: { name: 'Built-in Engine', baseUrl: 'http://127.0.0.1:8127/v1', isLocal: true, managed: true },
            },
          },
        },
      }),
    })
    const store = await freshStore()
    const slot = store.getState().providers.openai
    // NEGATIVE CONTROL in the same frame: Jan is the user's own entry and keeps
    // its name, while the card it owes now says LU Engine.
    expect(slot.name).toBe('Jan')
    expect(slot.displaced?.name).toBe('LU Engine')
    expect(slot.displaced?.managed).toBe(true)
  })

  it('a fresh install starts on the new name too', async () => {
    installLocalStorage()
    const store = await freshStore()
    expect(store.getState().providers.openai.name).toBe('LU Engine')
  })
})
