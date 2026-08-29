/**
 * Befund 2 of the abnahme counter-check (2026-08-29), store side.
 *
 * The counters on the Models page can only refuse to state an uncounted zero
 * if the store knows two things: whether a list has ever landed, and whether
 * a read is running right now. The second one is a number and not a flag on
 * purpose: fetchModels runs from several mounted components at once, and the
 * first one to return must not declare the count settled while the slow one,
 * the one that actually waits on ComfyUI, is still out.
 *
 * Run: npx vitest run src/stores/__tests__/modelStore-inventory-loading.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('../../api/backend', () => ({
  isTauri: vi.fn(() => false),
  backendCall: vi.fn(async () => undefined),
}))
vi.mock('../../api/ollama', () => ({ unloadModel: vi.fn(async () => undefined) }))
vi.mock('../../api/lmstudio', () => ({ unloadLmStudioModel: vi.fn(async () => undefined) }))
vi.mock('../../api/engine', () => ({ activateBuiltinModel: vi.fn(async () => undefined) }))

import { useModelStore } from '../modelStore'
import { counterView } from '../../lib/inventory-counter'

const hook = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../hooks/useModels.ts'),
  'utf8',
)

const chat = (name: string) => ({
  name, model: name, size: 0, type: 'text' as const,
  provider: 'openai' as const, providerName: 'Built-in Engine',
})

beforeEach(() => {
  useModelStore.setState({
    models: [], activeModel: null, inventoryLoaded: false, inventoryRefreshes: 0,
  })
})

describe('the store knows whether anything has been counted', () => {
  it('a fresh store has counted nothing', () => {
    const s = useModelStore.getState()
    expect(s.inventoryLoaded).toBe(false)
    expect(counterView(0, { loaded: s.inventoryLoaded, refreshing: s.inventoryRefreshes > 0 }).kind)
      .toBe('loading')
  })

  it('THE FIX: an empty list that really landed is counted, and shows as 0', () => {
    useModelStore.getState().setModels([])
    const s = useModelStore.getState()
    expect(s.inventoryLoaded).toBe(true)
    expect(counterView(0, { loaded: s.inventoryLoaded, refreshing: s.inventoryRefreshes > 0 }))
      .toEqual({ kind: 'count', value: 0 })
  })

  it('two overlapping reads: the count stays uncounted until the LAST one is back', () => {
    const s = useModelStore.getState()
    s.beginInventoryRefresh()
    s.beginInventoryRefresh()
    // The fast pass returns with the chat models. ComfyUI is still being read.
    useModelStore.getState().setModels([chat('openai::Hermes-3-Llama-3.2-3B.Q4_K_M')])
    useModelStore.getState().endInventoryRefresh()
    const mid = useModelStore.getState()
    expect(mid.inventoryRefreshes).toBe(1)
    // This is the 1.2-second frame on the box: Chat 2, no Image badge.
    expect(counterView(0, { loaded: mid.inventoryLoaded, refreshing: mid.inventoryRefreshes > 0 }).kind)
      .toBe('loading')

    useModelStore.getState().endInventoryRefresh()
    const end = useModelStore.getState()
    expect(end.inventoryRefreshes).toBe(0)
    expect(counterView(0, { loaded: end.inventoryLoaded, refreshing: end.inventoryRefreshes > 0 }))
      .toEqual({ kind: 'count', value: 0 })
  })

  it('NEGATIVE CONTROL: the in-flight count never goes below zero', () => {
    // An unbalanced end would otherwise leave a permanent negative and every
    // later refresh would read as "not running".
    const s = useModelStore.getState()
    s.endInventoryRefresh()
    s.endInventoryRefresh()
    expect(useModelStore.getState().inventoryRefreshes).toBe(0)
    s.beginInventoryRefresh()
    expect(useModelStore.getState().inventoryRefreshes).toBe(1)
  })
})

describe('the refresh marker is raised and lowered around the whole read', () => {
  it('fetchModels announces itself before the first await', () => {
    expect(hook).toMatch(/beginInventoryRefresh\(\)\s*\n\s*try \{/)
  })

  it('NEGATIVE CONTROL: it is lowered in a finally, so a thrown read cannot pin the mark up', () => {
    expect(hook).toMatch(/\} finally \{\s*\n\s*useModelStore\.getState\(\)\.endInventoryRefresh\(\)/)
  })
})
