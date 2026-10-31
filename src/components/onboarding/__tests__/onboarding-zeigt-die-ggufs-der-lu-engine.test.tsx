/**
 * @vitest-environment jsdom
 *
 * Befund I1 auf der Windows-Box (integ/309 r2 6545eac24): der Modellschritt
 * des Assistenten zeigte unter "Models you already have" nur Ollamas Modelle.
 * Die GGUFs der LU Engine, die der Model Manager im selben Moment auflistet,
 * fehlten. Wer nur LU-Engine-Modelle hatte, stand vor "Pick a starter model",
 * als haette er keins.
 *
 * Die Liste fragt jetzt dieselbe Quelle wie Model Manager und Waehler
 * (`listBundledModels`, also `list_bundled_models`) und reicht eine Wahl als
 * `openai::<name>` an den Store, der die Engine selbst umstartet.
 *
 * Lauf: npx vitest run src/components/onboarding/__tests__/onboarding-zeigt-die-ggufs-der-lu-engine.test.tsx
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

const listModels = vi.fn(async (): Promise<Array<{ name: string }>> => [])
vi.mock('../../../api/ollama', () => ({
  listModels: () => listModels(),
  pullModelTauri: vi.fn(),
  checkConnection: vi.fn(async () => false),
}))
vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async () => ({})),
  isTauri: () => false,
  isMacOS: () => false,
  openExternal: vi.fn(),
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))
vi.mock('../../../api/discover', () => ({
  detectProviderModelPath: vi.fn(async () => ''),
  startModelDownloadToPath: vi.fn(),
  luEngineDownloadDir: vi.fn(async () => ''),
}))
const listBundledModels = vi.fn()
const activateBuiltinModel = vi.fn(async (_n: string) => true)
vi.mock('../../../api/engine', async (importActual) => {
  const echt = await importActual<typeof import('../../../api/engine')>()
  return {
    ...echt,
    listBundledModels: () => listBundledModels(),
    activateBuiltinModel: (n: string) => activateBuiltinModel(n),
  }
})
vi.mock('../../../api/comfyui', () => ({ getSystemVRAM: vi.fn(async () => 0) }))

const { useProviderStore } = await import('../../../stores/providerStore')
const { useModelStore } = await import('../../../stores/modelStore')
const { ModelsStep } = await import('../ModelsStep')
const { onboardingSkin } = await import('../onboarding-skin')

const LEERE_FLOTTE = {
  ollama: { phase: 'idle' }, lmstudio: { phase: 'idle' },
  comfyInstall: { phase: 'idle' }, pythonInstall: { phase: 'idle' },
  ollamaDo: () => {}, lmstudioDo: () => {}, comfyInstallDo: () => {}, pythonInstallDo: () => {},
  secondsOf: () => 0,
}
const LEERER_SCAN = {
  detectedBackends: [], detecting: false, selectedBackend: 'builtin',
  setSelectedBackend: () => {}, lmstudioOfflineDetected: false, lmstudioModelCount: 0,
  runDetection: async () => {}, stopDetection: () => {},
}

const GGUFS = [
  { name: 'Qwen3-8B-Q4_K_M', path: '/m/Qwen3-8B-Q4_K_M.gguf', size: 5_000_000_000, loaded: false },
  { name: 'LFM3-1.7B-Q4_K_M', path: '/m/LFM3-1.7B-Q4_K_M.gguf', size: 1_099_627_808, loaded: false },
  // Die Einbettung fuer Document Chat ist kein Chatmodell.
  { name: 'nomic-embed-text-v1.5.Q8_0', path: '/m/nomic-embed-text-v1.5.Q8_0.gguf', size: 140_000_000, loaded: false },
]

async function schrittZeichnen() {
  await act(async () => {
    render(createElement(ModelsStep, {
      skin: onboardingSkin(true),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scan: LEERER_SCAN as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fleet: LEERE_FLOTTE as any,
      step: 'models' as const,
      setStep: () => {},
      pulledModels: [],
      setPulledModels: () => {},
    }))
  })
}

beforeEach(() => {
  listModels.mockReset().mockResolvedValue([])
  listBundledModels.mockReset().mockResolvedValue(GGUFS)
  activateBuiltinModel.mockClear()
  useModelStore.setState({ activeModel: null })
  useProviderStore.getState().setProviderConfig('ollama', { enabled: false, disabledByUser: undefined })
})
afterEach(cleanup)

describe('Models you already have: die LU Engine gehoert dazu', () => {
  it('nur LU-Engine-GGUFs: sie stehen in der Liste, die Einbettung nicht', async () => {
    await schrittZeichnen()
    expect(screen.getByText('Models you already have')).toBeTruthy()
    expect(screen.getByText('Pick your chat model')).toBeTruthy()
    expect(screen.getByText('Qwen3-8B-Q4_K_M')).toBeTruthy()
    expect(screen.getByText('LFM3-1.7B-Q4_K_M')).toBeTruthy()
    expect(screen.queryByText('nomic-embed-text-v1.5.Q8_0')).toBeNull()
    // Wer schon Modelle hat, bekommt keine Empfehlung (P4), wie bei Ollama.
    expect(screen.queryByText(/Recommended/i)).toBeNull()
  })

  it('ein Klick waehlt das GGUF als openai::<name>, Ollama bleibt aus', async () => {
    await schrittZeichnen()
    await act(async () => { fireEvent.click(screen.getByText('Qwen3-8B-Q4_K_M')) })
    expect(useModelStore.getState().activeModel).toBe('openai::Qwen3-8B-Q4_K_M')
    expect(useProviderStore.getState().providers.ollama.enabled).toBe(false)
    expect(screen.getByText(/Continue/)).toBeTruthy()
  })

  it('Ollama und LU Engine zusammen, jede Zeile sagt ihre Maschine', async () => {
    listModels.mockResolvedValue([{ name: 'llama3.1:8b' }])
    await schrittZeichnen()
    expect(screen.getByText('llama3.1:8b')).toBeTruthy()
    expect(screen.getByText('Qwen3-8B-Q4_K_M')).toBeTruthy()
    expect(screen.getAllByText('Ollama').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('LU Engine').length).toBe(2)
  })

  it('ohne Sidecar (Web, Bruecke) bleibt es bei Ollamas Liste', async () => {
    listBundledModels.mockRejectedValue(new Error('unknown command list_bundled_models'))
    listModels.mockResolvedValue([{ name: 'llama3.1:8b' }])
    await schrittZeichnen()
    expect(screen.getByText('llama3.1:8b')).toBeTruthy()
    expect(screen.queryByText('LU Engine')).toBeNull()
  })

  it('gar nichts installiert: der Starter mit Empfehlung, wie bisher', async () => {
    listBundledModels.mockResolvedValue([])
    await schrittZeichnen()
    expect(screen.queryByText('Models you already have')).toBeNull()
    expect(screen.getByText('Pick a starter model')).toBeTruthy()
  })
})
