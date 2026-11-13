/**
 * Der erste Modellabruf beim Kaltstart geht an DAS Ollama, das gespeichert ist.
 *
 * Release-Testbau, macOS, 29.10.2026, frischer Prozess: providerStore,
 * config.json und OLLAMA_HOST zeigen alle auf 127.0.0.1:18902, ein anderes
 * Ollama laeuft auf 11434. Der erste Abruf (useModels.fetchModels ->
 * listModels -> ollamaUrl) lief vor AppShells pullAndArm, also mit dem
 * Default localhost:11434 in backend.ts. Gemessen: +330 ms die Liste des
 * fremden Ollama, activeModel sprang auf dessen erstes 27B-Modell, +400 ms
 * die richtige Liste, activeModel null. Die Wahl war bei jedem Neustart weg.
 *
 * Lauf: npx vitest run src/stores/__tests__/ollama-adresse-beim-kaltstart.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const GESPEICHERT = 'http://127.0.0.1:18902'

// Das, was ein frischer Prozess in localStorage vorfindet. Muss stehen, bevor
// der providerStore geladen wird: er hydriert beim Anlegen.
const ablage = vi.hoisted(() => {
  const m = new Map<string, string>()
  m.set('lu-providers', JSON.stringify({
    state: { providers: { ollama: {
      id: 'ollama', name: 'Ollama', enabled: true, baseUrl: 'http://127.0.0.1:18902', apiKey: '', isLocal: true,
    } } },
    version: 2,
  }))
  const ls = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size },
  }
  ;(globalThis as { localStorage?: unknown }).localStorage = ls
  return m
})

const backend = vi.hoisted(() => ({
  backendCall: vi.fn(),
  localFetch: vi.fn(),
  seen: [] as string[],
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('../../api/in-tauri', () => ({ isTauri: () => true }))
vi.mock('../../api/backend', async () => {
  const actual = await vi.importActual<typeof import('../../api/backend')>('../../api/backend')
  return { ...actual, isTauri: () => true, backendCall: backend.backendCall, localFetch: backend.localFetch }
})

beforeEach(() => {
  backend.seen.length = 0
  backend.backendCall.mockReset()
  // AppShell hat noch nicht gefragt, und Rust antwortet hier nie: genau das
  // Fenster vor pullAndArm.
  backend.backendCall.mockImplementation(() => new Promise(() => {}))
  backend.localFetch.mockReset()
  backend.localFetch.mockImplementation(async (url: string) => {
    backend.seen.push(url)
    if (url === `${GESPEICHERT}/api/tags`) {
      return new Response(JSON.stringify({ models: [{ name: 'qwen05-zwei:t1' }, { name: 'qwen05:t1' }] }), { status: 200 })
    }
    if (url === 'http://localhost:11434/api/tags') {
      return new Response(JSON.stringify({
        models: [{ name: 'hf.co/fremd/Qwen3-27B', details: { parameter_size: '27B' } }],
      }), { status: 200 })
    }
    throw new Error('Connection refused')
  })
})

describe('Kaltstart: die gespeicherte Ollama-Adresse gilt ab dem ersten Abruf', () => {
  it('listModels vor AppShells Abgleich fragt die gespeicherte Adresse, nicht 11434', async () => {
    const { useProviderStore } = await import('../providerStore')
    expect(useProviderStore.getState().providers.ollama.baseUrl).toBe(GESPEICHERT)
    const { listModels } = await import('../../api/ollama')
    await listModels()

    expect(backend.seen).toEqual([`${GESPEICHERT}/api/tags`])
    expect(backend.seen).not.toContain('http://localhost:11434/api/tags')
  })

  it('die gespeicherte Wahl ueberlebt den Kaltstart', async () => {
    await import('../providerStore')
    const { useModelStore } = await import('../modelStore')
    useModelStore.setState({ activeModel: 'qwen05:t1' })
    const { listModels } = await import('../../api/ollama')
    const models = await listModels()
    useModelStore.getState().setModels(models.map((m) => ({ ...m, provider: 'ollama' as const, providerName: 'Ollama' })))

    expect(useModelStore.getState().activeModel).toBe('qwen05:t1')
    expect(useModelStore.getState().models.map((m) => m.name)).not.toContain('hf.co/fremd/Qwen3-27B')
  })

  it('fetchModels wartet auf Rusts Adresse, bevor es einen Anbieter fragt', () => {
    const hook = readFileSync(resolve(__dirname, '../../hooks/useModels.ts'), 'utf8')
    const start = hook.indexOf('const fetchModels = useCallback')
    const abgleich = hook.indexOf('await syncOllamaBaseFromRust()', start)
    expect(abgleich, 'fetchModels gleicht nicht ab').toBeGreaterThan(start)
    expect(abgleich).toBeLessThan(hook.indexOf('provider.listModels()', start))
  })

  it('ein stummes Rust haelt die Modellliste nicht an, die gespeicherte Adresse bleibt', async () => {
    vi.useFakeTimers()
    try {
      const { syncOllamaBaseFromRust, resetOllamaBaseSyncForTests } = await import('../../lib/ollama-host-sync')
      const { getOllamaBase } = await import('../../api/backend')
      resetOllamaBaseSyncForTests()
      let fertig = false
      void syncOllamaBaseFromRust().then(() => { fertig = true })
      await vi.advanceTimersByTimeAsync(3100)
      expect(fertig).toBe(true)
      expect(getOllamaBase()).toBe(GESPEICHERT)
    } finally {
      vi.useRealTimers()
    }
  })
})

void ablage
