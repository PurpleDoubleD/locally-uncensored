/**
 * Der Assistent klopft an DEM Ollama, auf das die App zeigt.
 *
 * Release-Testbau, macOS, 29.10.2026: OLLAMA_HOST=127.0.0.1:18902, dazu ein
 * anderes Ollama auf 11434. Das Assistentenfenster ("onboarding") faehrt
 * AppShell nicht hoch und holte Rusts Adresse (`get_ollama_host`) nie. Der
 * Backend-Schritt bot "Ollama localhost:11434" an, also das falsche, und
 * "Models you already have" listete dessen Modelle. Stand auf 11434 nichts,
 * fand der Assistent das eingestellte Ollama gar nicht (Issue #31).
 *
 * Erwartet: dieselbe Regel wie AppShell beim Kaltstart, Rust gewinnt, fuer
 * die Sonde und fuer die Modellliste.
 *
 * Lauf: npx vitest run src/lib/__tests__/der-assistent-klopft-an-rusts-ollama.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const RUST_BASE = 'http://127.0.0.1:18902'

const seen: string[] = []
const backend = vi.hoisted(() => ({
  backendCall: vi.fn(),
  localFetch: vi.fn(),
}))

// ollamaUrl() fragt in backend.ts das echte isTauri aus in-tauri.ts.
vi.mock('../../api/in-tauri', () => ({ isTauri: () => true }))
vi.mock('../../api/backend', async () => {
  const actual = await vi.importActual<typeof import('../../api/backend')>('../../api/backend')
  return {
    ...actual,
    isTauri: () => true,
    backendCall: backend.backendCall,
    localFetch: backend.localFetch,
  }
})

import { detectLocalBackends } from '../backend-detector'
import { resetOllamaBaseSyncForTests } from '../ollama-host-sync'
import { getOllamaBase, setOllamaBase } from '../../api/backend'
import { useProviderStore } from '../../stores/providerStore'
import { addDetectedSideBySide } from '../detected-backends-side-by-side'

beforeEach(() => {
  seen.length = 0
  resetOllamaBaseSyncForTests()
  setOllamaBase('http://localhost:11434')
  useProviderStore.getState().setProviderConfig('ollama', { baseUrl: 'http://localhost:11434' })
  backend.backendCall.mockReset()
  backend.backendCall.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_ollama_host') return { base: RUST_BASE }
    throw new Error(`unexpected ${cmd}`)
  })
  // Beide Ollamas laufen: das eingestellte und das fremde auf 11434.
  backend.localFetch.mockReset()
  backend.localFetch.mockImplementation(async (url: string) => {
    seen.push(url)
    if (url === `${RUST_BASE}/api/tags`) {
      return new Response(JSON.stringify({ models: [{ name: 'richtiges:7b' }] }), { status: 200 })
    }
    if (url === 'http://localhost:11434/api/tags') {
      return new Response(JSON.stringify({ models: [{ name: 'fremdes:3b' }] }), { status: 200 })
    }
    throw new Error('Connection refused')
  })
})

describe('Assistentenfenster: Ollama-Adresse aus Rust', () => {
  it('der Scan klopft an Rusts Adresse und meldet sie, nicht localhost:11434', async () => {
    const found = await detectLocalBackends()

    expect(seen).toContain(`${RUST_BASE}/api/tags`)
    expect(seen).not.toContain('http://localhost:11434/api/tags')
    const ollama = found.find((b) => b.id === 'ollama')
    expect(ollama?.baseUrl).toBe(RUST_BASE)
    expect(ollama?.port).toBe(18902)
    // Und der Store traegt dieselbe Adresse, damit die Wahl im Assistenten sie mitnimmt.
    expect(useProviderStore.getState().providers.ollama.baseUrl).toBe(RUST_BASE)
  })

  it('die Modellliste kommt nach dem Abgleich vom eingestellten Ollama', async () => {
    const { syncOllamaBaseFromRust } = await import('../ollama-host-sync')
    await syncOllamaBaseFromRust()
    const { listModels } = await import('../../api/ollama')
    const models = await listModels()

    expect(getOllamaBase()).toBe(RUST_BASE)
    expect(seen).toEqual([`${RUST_BASE}/api/tags`])
    expect(models.map((m) => m.name)).toEqual(['richtiges:7b'])
  })

  it('das Fenster und der Modellschritt holen die Adresse, bevor sie listen', () => {
    const quelle = (f: string) => readFileSync(resolve(__dirname, '../../components/onboarding', f), 'utf8')
    expect(quelle('OnboardingWindow.tsx')).toMatch(/void syncOllamaBaseFromRust\(\)/)
    const schritt = quelle('ModelsStep.tsx')
    const abgleich = schritt.indexOf('syncOllamaBaseFromRust()')
    expect(abgleich, 'ModelsStep gleicht nicht ab').toBeGreaterThan(0)
    expect(abgleich).toBeLessThan(schritt.indexOf('listModels()'))
  })

  it('NEGATIVKONTROLLE: schweigt Rust, gilt der providerStore', async () => {
    backend.backendCall.mockImplementation(async () => { throw new Error('not ready') })
    useProviderStore.getState().setProviderConfig('ollama', { baseUrl: 'http://192.168.1.20:11434' })
    const found = await detectLocalBackends()

    expect(getOllamaBase()).toBe('http://192.168.1.20:11434')
    expect(seen).toContain('http://192.168.1.20:11434/api/tags')
    expect(found.find((b) => b.id === 'ollama')).toBeUndefined()
  })
})

/**
 * Derselbe Fehler im HAUPTFENSTER: der Scan beim Anlauf (AppShell, "Auto-detect
 * local backends on startup") fand das Preset localhost:11434 und schrieb es
 * mit `baseUrl: detectedOllama.baseUrl` fest. Die Subscription trug das per
 * `set_ollama_host` bis in config.json, und /api/tags und /api/show gingen
 * danach an das falsche Ollama. Dasselbe Festschreiben steht in
 * `detected-backends-side-by-side.ts`.
 */
describe('Hauptfenster: der Anlauf-Scan ersetzt die eingestellte Adresse nicht', () => {
  /** Was AppShell mit einem gefundenen Ollama macht, ohne die Schale. */
  async function anlaufScan() {
    const backends = await detectLocalBackends()
    const detectedOllama = backends.find((b) => b.id === 'ollama')
    if (detectedOllama) {
      useProviderStore.getState().setProviderConfig('ollama', { baseUrl: detectedOllama.baseUrl, isLocal: true })
    }
    return backends
  }

  it('AppShell schreibt Rusts Adresse fest, nicht das Preset', async () => {
    await anlaufScan()
    expect(useProviderStore.getState().providers.ollama.baseUrl).toBe(RUST_BASE)
    expect(getOllamaBase()).toBe(RUST_BASE)
  })

  it('"Add all side by side" nimmt Rusts Adresse mit', async () => {
    useProviderStore.getState().setProviderConfig('ollama', { enabled: false, disabledByUser: undefined })
    const backends = await detectLocalBackends()
    expect(addDetectedSideBySide(backends.filter((b) => b.id === 'ollama'))).toBe(1)
    expect(useProviderStore.getState().providers.ollama.baseUrl).toBe(RUST_BASE)
  })

  it('auch ohne Abgleich (Rust stumm) bleibt eine eingestellte Adresse stehen', async () => {
    backend.backendCall.mockImplementation(async () => { throw new Error('not ready') })
    // Eingestellt ist die LAN-Box, und sie laeuft; daneben laeuft 11434.
    const LAN = 'http://192.168.1.20:11434'
    useProviderStore.getState().setProviderConfig('ollama', { baseUrl: LAN })
    backend.localFetch.mockImplementation(async (url: string) => {
      seen.push(url)
      if (url.endsWith('/api/tags')) return new Response('{"models":[]}', { status: 200 })
      throw new Error('Connection refused')
    })
    const backends = await anlaufScan()

    expect(backends.find((b) => b.id === 'ollama')?.baseUrl).toBe(LAN)
    expect(seen).not.toContain('http://localhost:11434/api/tags')
    expect(useProviderStore.getState().providers.ollama.baseUrl).toBe(LAN)
  })
})
