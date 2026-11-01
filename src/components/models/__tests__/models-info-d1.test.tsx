/**
 * @vitest-environment jsdom
 *
 * D1 (a user on Discord, 01.11.2026): Models, Installed, Image. Das ⓘ neben
 * dem Papierkorb tat bei einem ComfyUI-Modell nichts (es fragte Ollama, und
 * `catch {}` schluckte die Antwort), LoRA-Zeilen hatten gar keins, und es gab
 * keinen Weg zur Seite, von der die Datei kam.
 *
 * Gemessen an der gerenderten Seite in beiden Fassungen: der Klick oeffnet
 * Details mit Datei, Typ, Groesse und Ordner; ein Fehler steht im Dialog; die
 * Quellseite steht nur da, wenn LU sie beim Download notiert hat.
 *
 * Run: npx vitest run src/components/models/__tests__/models-info-d1.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { AIModel } from '../../../types/models'

// ── Der Unterbau, den die Seite anfasst ────────────────────────────────

const openExternal = vi.fn(async (_url: string) => {})
const comfyModelInfo = vi.fn(async (_name: string): Promise<unknown> => ({}))
const showModel = vi.fn(async (_name: string): Promise<Record<string, unknown>> => ({}))
const backendCall = vi.fn(async (_cmd: string, _args?: unknown) => ({ status: 'deleted' }))
const searchCivitaiModels = vi.fn(
  async (_query: string, _type: string, _key?: string, _host?: string) => [] as unknown[],
)
const startModelDownload = vi.fn(
  async (_url: string, _subfolder: string, _filename: string) => ({ status: 'ok', id: '1' }),
)
const installBundleComplete = vi.fn(async (_name: string) => ({}))
const setActiveModel = vi.fn(async () => {})
const fetchModels = vi.fn(async () => {})
let macHost = false
let comfyLaeuft = true

// Die Seite hat seit dem 08.10.2026 zwei Fassungen: die klassische auf
// Windows und Linux, das Redesign auf dem Mac (skin/which.ts entscheidet).
// Die Regeln, die diese Datei bewacht, gelten fuer beide, also laeuft jeder
// Fall einmal je Fassung.
const face = vi.hoisted(() => ({ name: 'classic' as 'classic' | 'mac' }))
vi.mock('../skin/which', () => ({ modelSkinName: () => face.name }))

vi.mock('../../../api/backend', () => ({
  backendCall: (cmd: string, args?: unknown) => backendCall(cmd, args),
  openExternal: (url: string) => openExternal(url),
  isTauri: () => false,
  isMacOS: () => false,
}))
vi.mock('../../../api/discover', () => ({
  lookupFileMeta: () => null,
  searchCivitaiModels: (query: string, type: string, key?: string, host?: string) =>
    searchCivitaiModels(query, type, key, host),
  // The panel downloads through startCivitaiDownload; for a safetensors LoRA
  // that is exactly one startModelDownload (api/discover).
  startCivitaiDownload: (m: { downloadUrl: string; subfolder: string; filename: string }) =>
    startModelDownload(m.downloadUrl, m.subfolder, m.filename),
  // The catalog LoRAs above the search (LoraAddons) ask what is on disk and
  // install through the bundle path.
  checkBundlesInstalled: async () => ({}),
  // What of the CivitAI hits is on disk already: nothing here.
  checkCivitaiInstalled: async () => new Set<number>(),
  civitaiInstalledInFolder: () => new Set<number>(),
  installBundleComplete: (b: { name: string }) => installBundleComplete(b.name),
  remoteBundleNotice: () => '',
  comfyModelInfo: (name: string) => comfyModelInfo(name),
}))
vi.mock('../../../api/comfyui', () => ({
  checkComfyConnection: vi.fn(async () => comfyLaeuft),
  refreshComfyModels: vi.fn(async () => {}),
}))
// In der Mac-Fassung sagt der Fuss der Leiste, was diese Maschine hat, und
// die Fassung fragt dafuer selbst nach dem Speicher. Beide
// Fragen gehen durch `backendCall`, das hier als Zeuge fuer das Loeschen
// gezaehlt wird. Sie bekommen deshalb eine stumme Antwort, damit „nichts
// geloescht" weiter „kein einziger Aufruf" heisst.
vi.mock('../../../hooks/useGraphicsMemory', () => ({ useGraphicsMemoryGb: () => null }))
vi.mock('../../../lib/hardware', async (orig) => ({
  ...(await orig<typeof import('../../../lib/hardware')>()),
  getTotalRamGb: vi.fn(async () => 0),
}))
vi.mock('../../../api/mlx-image', () => ({ isMlxImageHost: () => macHost }))
vi.mock('../../../api/ollama', () => ({ showModel: (n: string) => showModel(n) }))
vi.mock('../../../api/engine', () => ({
  customModelDirs: () => [],
  deleteBundledModel: vi.fn(),
  stopBundledEngine: vi.fn(),
}))
vi.mock('../MacMediaLane', () => ({ MacMediaLane: () => createElement('div', null, 'mlx-panel') }))
// Am Mac ist die LoRA-Bahn der LoRA-Ordner der Bild-Engine (MacLoraLane), nicht
// der von ComfyUI. Hier steht ein Zeuge an ihrer Stelle; die Bahn selbst misst
// der-mac-hat-einen-lora-ordner.test.tsx.
vi.mock('../MacLoraLane', () => ({
  MacLoraLane: ({ tab }: { tab: string }) => createElement('div', { 'data-testid': 'mac-lora-lane' }, `mac-lora-lane ${tab}`),
}))
vi.mock('../../../hooks/useMlxLoras', () => ({
  useMlxLoras: (enabled: boolean) => ({
    loaded: true, dir: '/data/loras', error: null, refresh: async () => {},
    loras: enabled ? [{ name: 'qwen-detail.safetensors', sizeBytes: 1, keys: 'peft' }] : [],
  }),
}))
vi.mock('../../../hooks/useMlxMedia', () => {
  const lane = { models: [], engineReady: true, unsupported: null, engineInstall: null, modelInstall: null, queuedId: null, error: null }
  return { useMlxMedia: () => ({ loaded: true, image: lane, video: lane, music: lane, get: () => {}, setUpEngine: () => {}, remove: async () => {}, clearError: () => {}, refresh: async () => {} }) }
})
vi.mock('../DiscoverModels', () => ({ DiscoverModels: () => createElement('div', null, 'discover-panel') }))
vi.mock('../../chat/LuEngineSwitchBar', () => ({ LuEngineSwitchBar: () => null }))
vi.mock('../../../hooks/useBuiltinEngineStatus', () => ({
  useBuiltinEngineStatus: () => null,
  engineIsIdle: () => false,
}))

const CHECKPOINT: AIModel = {
  name: 'sdxl_base.safetensors', model: 'sdxl_base.safetensors', size: 6_000_000_000,
  format: 'safetensors', architecture: 'sdxl', type: 'image', providerName: 'ComfyUI',
  source: 'checkpoint',
}
const LORA: AIModel = {
  name: 'styles/pixel_art_xl.safetensors', model: 'styles/pixel_art_xl.safetensors', size: 170_917_888,
  format: 'safetensors', architecture: 'sdxl', type: 'image', providerName: 'ComfyUI',
  source: 'lora',
}

let bestand: AIModel[] = []
let lane = 'image'
vi.mock('../../../hooks/useModels', () => ({
  useModels: () => ({
    models: bestand,
    activeModel: null,
    setActiveModel,
    fetchModels,
    removeModel: vi.fn(),
    categoryFilter: lane,
    setCategoryFilter: vi.fn(),
    inventoryLoaded: true,
    inventoryRefreshing: false,
  }),
}))

import { ModelManager } from '../ModelManager'
import { useModelSourceStore } from '../../../stores/modelSourceStore'

const FACTS = {
  path: '/c/ComfyUI/models/checkpoints/sdxl_base.safetensors',
  folder: '/c/ComfyUI/models/checkpoints',
  bytes: 6_938_078_334,
  modified: 1_761_955_200,
  ownFolder: false,
  copies: 1,
}

beforeEach(() => {
  macHost = false
  comfyLaeuft = true
  bestand = [CHECKPOINT, LORA]
  lane = 'image'
  comfyModelInfo.mockReset()
  comfyModelInfo.mockResolvedValue(FACTS)
  showModel.mockReset()
  openExternal.mockClear()
  useModelSourceStore.setState({ pages: {} })
})
afterEach(cleanup)

function openImageInstalled() {
  render(createElement(ModelManager))
  fireEvent.click(screen.getByRole('button', { name: /^Installed/ }))
}

function detailsButtonOf(text: string): HTMLElement {
  // Der Knopf der Zeile, in der der Name steht.
  const row = screen.getAllByText(text)[0].closest('[data-testid="model-card"], [data-testid="lora-row"], .lu-tile') as HTMLElement
  return within(row).getByRole('button', { name: /Details/ })
}

describe.each(['classic', 'mac'] as const)('Fassung %s', (fassung) => {
  beforeEach(() => { face.name = fassung })

  it('THE FIX: das ⓘ eines Bildmodells oeffnet Details aus der Platte, ohne Ollama', async () => {
    openImageInstalled()
    fireEvent.click(detailsButtonOf('sdxl_base.safetensors'))
    const dlg = await screen.findByTestId('model-file-info')
    expect(comfyModelInfo).toHaveBeenCalledWith('sdxl_base.safetensors')
    expect(showModel).not.toHaveBeenCalled()
    await waitFor(() => expect(within(dlg).getByText('/c/ComfyUI/models/checkpoints')).toBeTruthy())
    expect(within(dlg).getByText('Checkpoint')).toBeTruthy()
    expect(within(dlg).getByText(/6\.\d+ GB|6\.\d+ GiB|6,\d+ GB/)).toBeTruthy()
    // Ohne notierte Quelle keine Zeile dafuer.
    expect(screen.queryByRole('button', { name: /Open source page/ })).toBeNull()
  })

  it('ein Fehler der Platte steht im Dialog, statt still zu verschwinden', async () => {
    comfyModelInfo.mockRejectedValue(new Error('sdxl_base.safetensors was not found in the ComfyUI models folders'))
    openImageInstalled()
    fireEvent.click(detailsButtonOf('sdxl_base.safetensors'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('was not found in the ComfyUI models folders')
  })

  it('LoRA-Zeilen haben ein ⓘ, mit Unterordner gefragt, und die notierte Seite oeffnet', async () => {
    useModelSourceStore.getState().record('pixel_art_xl.safetensors', 'https://civitai.com/models/120096')
    render(createElement(ModelManager))
    fireEvent.click(screen.getByRole('button', { name: /^LoRAs/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Installed/ }))
    const row = screen.getAllByTestId('lora-row')[0]
    fireEvent.click(within(row).getByRole('button', { name: /Details/ }))
    await screen.findByTestId('model-file-info')
    expect(comfyModelInfo).toHaveBeenCalledWith('styles/pixel_art_xl.safetensors')
    expect(screen.getByText('LoRA')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Open source page/ }))
    expect(openExternal).toHaveBeenCalledWith('https://civitai.com/models/120096')
  })
})

describe('Ollama-Modelle', () => {
  beforeEach(() => { face.name = 'classic' })

  it('ein Fehler von Ollama wird gezeigt, nicht geschluckt', async () => {
    bestand = [{ name: 'llama3:8b', model: 'llama3:8b', size: 4_000_000_000, type: 'text', provider: 'ollama' } as unknown as AIModel]
    lane = 'text'
    showModel.mockRejectedValue(new Error('connection refused'))
    render(createElement(ModelManager))
    fireEvent.click(screen.getByRole('button', { name: /^Installed/ }))
    fireEvent.click(screen.getAllByRole('button', { name: /Details/ })[0])
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('connection refused')
  })
})
