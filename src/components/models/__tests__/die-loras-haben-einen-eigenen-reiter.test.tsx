/**
 * @vitest-environment jsdom
 *
 * Models bekommt einen vierten Eintrag in der linken Leiste: LoRAs.
 *
 * Vorher war der Befund zweigeteilt. Die LoRAs waren im Bild-Reiter zwischen
 * den Checkpoints einsortiert, ohne ein Wort darueber, was sie sind, und ein
 * Klick darauf machte eine LoRA-Datei zum AKTIVEN Bildmodell, also zu etwas,
 * was sie nicht sein kann. Und die CivitAI-Suche daneben fragte hart nach
 * 'Checkpoint', obwohl die API und der Downloadweg LoRAs laengst konnten.
 *
 * Gemessen wird hier beides an der gerenderten Seite, nicht an der Quelle:
 * die Leiste, die Liste, der Groessentext, der Charakter-Chip samt
 * Triggerwort, der Loeschweg samt Abbruch ueber X und Escape, und die
 * Typfrage, die der Get-new-Reiter an CivitAI stellt.
 *
 * Run: npx vitest run src/components/models/__tests__/die-loras-haben-einen-eigenen-reiter.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AIModel } from '../../../types/models'

// ── Der Unterbau, den die Seite anfasst ────────────────────────────────

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
  openExternal: vi.fn(),
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
vi.mock('../../../api/ollama', () => ({ showModel: vi.fn(async () => ({})) }))
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

// Der Bestand, den die Seite zu sehen bekommt: ein Checkpoint, zwei LoRAs,
// eine davon ein selbst trainierter Charakter, dazu eine VAE als Zeuge fuer
// die anderen Addon-Bahnen.
const CHECKPOINT: AIModel = {
  name: 'sdxl_base.safetensors', model: 'sdxl_base.safetensors', size: 6_000_000_000,
  format: 'safetensors', architecture: 'sdxl', type: 'image', providerName: 'ComfyUI',
  source: 'checkpoint',
}
const LORA: AIModel = {
  name: 'pixel_art_xl.safetensors', model: 'pixel_art_xl.safetensors', size: 170_917_888,
  format: 'safetensors', architecture: 'sdxl', type: 'image', providerName: 'ComfyUI',
  source: 'lora',
}
const CHARACTER_LORA: AIModel = {
  name: 'char_marla_zimage.safetensors', model: 'char_marla_zimage.safetensors', size: 41_943_040,
  format: 'safetensors', architecture: 'zimage', type: 'image', providerName: 'ComfyUI',
  source: 'lora',
}
/** ComfyUI listet Dateien MIT ihrem Unterordner. Genau dieser Fall fehlte in
 *  der ersten Fassung, und er ist der teuerste: der Loeschweg ist der eine
 *  Weg im Stueck, der Dateien vom Datentraeger nimmt. Schneidet irgendwer den
 *  Praefix ab, sucht Rust in `loras/` statt in `loras/styles/` und loescht
 *  entweder nichts oder die falsche gleichnamige Datei. */
const LORA_IM_UNTERORDNER: AIModel = {
  name: 'styles/foo.safetensors', model: 'styles/foo.safetensors', size: 12_345_678,
  format: 'safetensors', architecture: 'sdxl', type: 'image', providerName: 'ComfyUI',
  source: 'lora',
}
/** Dieselbe Sache mit dem Trennzeichen, das Windows schreibt. */
const CHAR_LORA_WINDOWS: AIModel = {
  name: 'chars\\char_marla_zimage.safetensors', model: 'chars\\char_marla_zimage.safetensors',
  size: 41_943_040, format: 'safetensors', architecture: 'zimage', type: 'image',
  providerName: 'ComfyUI', source: 'lora',
}

const VAE: AIModel = {
  name: 'sdxl_vae.safetensors', model: 'sdxl_vae.safetensors', size: 334_000_000,
  format: 'safetensors', architecture: 'sdxl', type: 'image', providerName: 'ComfyUI',
  source: 'vae',
}

let bestand: AIModel[] = []

vi.mock('../../../hooks/useModels', () => ({
  useModels: () => ({
    models: bestand,
    activeModel: null,
    setActiveModel,
    fetchModels,
    removeModel: vi.fn(),
    categoryFilter: 'image',
    setCategoryFilter: vi.fn(),
    inventoryLoaded: true,
    inventoryRefreshing: false,
  }),
}))

import { ModelManager } from '../ModelManager'

beforeEach(() => {
  macHost = false
  comfyLaeuft = true
  bestand = [CHECKPOINT, LORA, CHARACTER_LORA, VAE]
  backendCall.mockClear()
  searchCivitaiModels.mockClear()
  startModelDownload.mockClear()
  setActiveModel.mockClear()
})
afterEach(cleanup)

/** Die Leiste links, mit ihren vier moeglichen Eintraegen. */
const railButton = (name: string) => screen.queryByRole('button', { name: new RegExp(`^${name}`) })

function openLoraInstalled() {
  render(createElement(ModelManager))
  fireEvent.click(screen.getByRole('button', { name: /^LoRAs/ }))
  fireEvent.click(screen.getByRole('button', { name: /^Installed/ }))
}

describe.each(['classic', 'mac'] as const)('Fassung %s', (fassung) => {
  beforeEach(() => { face.name = fassung })

  describe('die Leiste kennt die LoRAs', () => {
    it('THE FIX: der Eintrag steht da', () => {
      render(createElement(ModelManager))
      expect(railButton('LoRAs')).not.toBeNull()
    })

    it('auf einem MLX-Mac fuehrt er zum LoRA-Ordner der Bild-Engine, nicht zu ComfyUI', async () => {
      // Bis zum 09.10.2026 gab es den Eintrag am Mac nicht: es gab keinen
      // Ordner, den er haette zeigen koennen. Jetzt hat die Bild-Engine einen.
      macHost = true
      const { checkComfyConnection } = await import('../../../api/comfyui')
      vi.mocked(checkComfyConnection).mockClear()
      render(createElement(ModelManager))
      expect(railButton('LoRAs')).not.toBeNull()
      expect(railButton('Chat')).not.toBeNull()
      expect(railButton('Image')).not.toBeNull()
      // Die Zahl an der Leiste ist die des Mac-Ordners, nicht die der
      // ComfyUI-LoRAs aus dem Bestand (dort stehen zwei).
      expect(railButton('LoRAs')?.textContent).toContain('1')
      fireEvent.click(screen.getByRole('button', { name: /^LoRAs/ }))
      expect(screen.getByTestId('mac-lora-lane').textContent).toBe('mac-lora-lane discover')
      fireEvent.click(screen.getByRole('button', { name: /^Installed/ }))
      expect(screen.getByTestId('mac-lora-lane').textContent).toBe('mac-lora-lane installed')
      // Nichts von ComfyUI: weder dessen Liste noch dessen Suche noch die
      // Frage, ob es laeuft.
      expect(screen.queryAllByTestId('lora-row')).toHaveLength(0)
      expect(screen.queryByText(/ComfyUI/)).toBeNull()
      expect(vi.mocked(checkComfyConnection)).not.toHaveBeenCalled()
    })

    it('GEGENPROBE: unter Windows und Linux bleibt die Bahn die von ComfyUI', () => {
      render(createElement(ModelManager))
      fireEvent.click(screen.getByRole('button', { name: /^LoRAs/ }))
      expect(screen.queryByTestId('mac-lora-lane')).toBeNull()
      expect(screen.getByText(/Downloads land in ComfyUI's models\/loras folder/)).not.toBeNull()
      expect(railButton('LoRAs')?.textContent).toContain('2')
    })
  })

  describe('Installed unter LoRAs', () => {
    it('listet GENAU die zwei LoRAs, mit ihrer Groesse', () => {
      openLoraInstalled()
      const zeilen = screen.getAllByTestId('lora-row')
      expect(zeilen).toHaveLength(2)
      const namen = zeilen.map((z) => z.textContent ?? '')
      expect(namen.some((t) => t.includes('pixel_art_xl.safetensors'))).toBe(true)
      expect(namen.some((t) => t.includes('char_marla_zimage.safetensors'))).toBe(true)
      // Die Groesse steht dran, sonst beantwortet die Liste nicht, was das kostet.
      expect(namen.some((t) => /\d/.test(t) && /(MB|GB)/.test(t))).toBe(true)
    })

    it('GEGENPROBE: weder der Checkpoint noch die VAE stehen hier', () => {
      openLoraInstalled()
      const text = screen.getAllByTestId('lora-row').map((z) => z.textContent).join(' ')
      expect(text).not.toContain('sdxl_base.safetensors')
      expect(text).not.toContain('sdxl_vae.safetensors')
    })

    it('ein selbst trainierter Charakter traegt Chip und Triggerwort', () => {
      openLoraInstalled()
      const zeile = screen.getAllByTestId('lora-row')
        .find((z) => (z.textContent ?? '').includes('char_marla_zimage'))!
      expect(within(zeile).getByText('Character')).toBeTruthy()
      expect(zeile.textContent).toContain('Trigger word: marla')
    })

    it('GEGENPROBE: die fremde LoRA traegt keinen Chip', () => {
      openLoraInstalled()
      const zeile = screen.getAllByTestId('lora-row')
        .find((z) => (z.textContent ?? '').includes('pixel_art_xl'))!
      expect(within(zeile).queryByText('Character')).toBeNull()
      expect(zeile.textContent).not.toContain('Trigger word')
    })

    it('kein Use, kein Aktivsetzen: ein Klick auf die Zeile waehlt nichts aus', () => {
      openLoraInstalled()
      const zeile = screen.getAllByTestId('lora-row')[0]
      expect(within(zeile).queryByRole('button', { name: /^Use$/ })).toBeNull()
      fireEvent.click(zeile)
      expect(setActiveModel).not.toHaveBeenCalled()
    })

    it('der Hinweis sagt, wo man sie benutzt', () => {
      openLoraInstalled()
      expect(screen.getAllByText(/Use them in Create, Advanced settings, Expert, LoRA stack\./).length)
        .toBeGreaterThan(0)
    })

    it('leer: ein Satz und der Weg zu Get new, sobald ComfyUI geantwortet hat', async () => {
      bestand = [CHECKPOINT]
      openLoraInstalled()
      // Erst wird gefragt, ob ComfyUI ueberhaupt laeuft: eine leere Liste ohne
      // laufenden Dienst ist keine Aussage ueber den Bestand, und die Bahn
      // benutzt dafuer denselben Zwischenzustand wie der Bild-Reiter.
      expect(screen.getByText('Checking ComfyUI…')).toBeTruthy()
      expect(await screen.findByText('No LoRAs installed yet')).toBeTruthy()
      expect(screen.getByRole('button', { name: /Get new LoRAs/ })).toBeTruthy()
    })
  })

  describe('ComfyUI steht', () => {
    it('die LoRA-Bahn zeigt denselben Zustand wie der Bild-Reiter, mit ihrem eigenen Wort', async () => {
      comfyLaeuft = false
      bestand = [CHECKPOINT]
      openLoraInstalled()
      expect(await screen.findByText('Start ComfyUI to see your LoRA models')).toBeTruthy()
      expect(screen.getByText(/LoRA models are served by ComfyUI, which isn't running right now/)).toBeTruthy()
      expect(screen.getByRole('button', { name: /Open Settings/ })).toBeTruthy()
      // GEGENPROBE: der Bild-Reiter sagt weiter Image, das Wort ist nicht
      // ueberall dasselbe geworden.
      cleanup()
      bestand = []
      render(createElement(ModelManager))
      fireEvent.click(screen.getByRole('button', { name: /^Image/ }))
      fireEvent.click(screen.getByRole('button', { name: /^Installed/ }))
      expect(await screen.findByText('Start ComfyUI to see your image models')).toBeTruthy()
    })
  })

  describe('Loeschen aus dem LoRA-Reiter', () => {
    it('THE FIX: bestaetigt, ruft delete_comfy_model mit dem Dateinamen, die Zeile geht', async () => {
      openLoraInstalled()
      fireEvent.click(screen.getByRole('button', { name: 'Delete pixel_art_xl.safetensors' }))
      fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }))
      await waitFor(() => expect(backendCall).toHaveBeenCalledTimes(1))
      expect(backendCall.mock.calls[0][0]).toBe('delete_comfy_model')
      expect((backendCall.mock.calls[0][1] as { filename: string } | undefined)?.filename)
        .toBe('pixel_art_xl.safetensors')
      // Der Bestand ist die eine Quelle der Liste: faellt die Datei dort weg,
      // faellt die Zeile weg.
      bestand = [CHECKPOINT, CHARACTER_LORA, VAE]
      cleanup()
      openLoraInstalled()
      const namen = screen.getAllByTestId('lora-row').map((z) => z.textContent ?? '')
      expect(namen).toHaveLength(1)
      expect(namen[0]).not.toContain('pixel_art_xl')
    })

    it('GEGENPROBE: Abbruch ueber Cancel loescht nichts', async () => {
      openLoraInstalled()
      fireEvent.click(screen.getByRole('button', { name: 'Delete pixel_art_xl.safetensors' }))
      fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }))
      expect(backendCall).not.toHaveBeenCalled()
      expect(screen.getAllByTestId('lora-row')).toHaveLength(2)
    })

    it('GEGENPROBE: Escape schliesst die Bestaetigung und loescht nichts', async () => {
      openLoraInstalled()
      fireEvent.click(screen.getByRole('button', { name: 'Delete pixel_art_xl.safetensors' }))
      expect(screen.getByText('Delete Model')).toBeTruthy()
      fireEvent.keyDown(document, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByText('Delete Model')).toBeNull())
      expect(backendCall).not.toHaveBeenCalled()
    })

    it('GEGENPROBE: das X der Bestaetigung loescht nichts', async () => {
      openLoraInstalled()
      fireEvent.click(screen.getByRole('button', { name: 'Delete pixel_art_xl.safetensors' }))
      const dialog = screen.getByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: /close/i }))
      await waitFor(() => expect(screen.queryByText('Delete Model')).toBeNull())
      expect(backendCall).not.toHaveBeenCalled()
    })
  })

  describe('Get new unter LoRAs', () => {
    it('THE FIX: fragt CivitAI nach LORA', async () => {
      render(createElement(ModelManager))
      fireEvent.click(screen.getByRole('button', { name: /^LoRAs/ }))
      fireEvent.click(screen.getByRole('button', { name: /^Get new/ }))
      fireEvent.change(screen.getByLabelText('Search CivitAI for LoRAs'), { target: { value: 'pixel art' } })
      fireEvent.click(screen.getByRole('button', { name: 'Search CivitAI' }))
      await waitFor(() => expect(searchCivitaiModels).toHaveBeenCalledTimes(1))
      expect(searchCivitaiModels.mock.calls[0][0]).toBe('pixel art')
      expect(searchCivitaiModels.mock.calls[0][1]).toBe('LORA')
    })

    it('und laedt einen Treffer in den loras-Ordner', async () => {
      searchCivitaiModels.mockResolvedValueOnce([{
        id: 7, name: 'Pixel Art XL', sourceUrl: 'https://civitai.com/models/7',
        downloadUrl: 'https://civitai.com/api/download/models/7',
        filename: 'pixel_art_xl.safetensors', subfolder: 'loras', sizeGB: 0.16,
      }])
      render(createElement(ModelManager))
      fireEvent.click(screen.getByRole('button', { name: /^LoRAs/ }))
      fireEvent.click(screen.getByRole('button', { name: /^Get new/ }))
      fireEvent.change(screen.getByLabelText('Search CivitAI for LoRAs'), { target: { value: 'pixel art' } })
      fireEvent.click(screen.getByRole('button', { name: 'Search CivitAI' }))
      const knopf = await screen.findByRole('button', { name: 'Download' })
      fireEvent.click(knopf)
      await waitFor(() => expect(startModelDownload).toHaveBeenCalledTimes(1))
      expect(startModelDownload.mock.calls[0][1]).toBe('loras')
      expect(startModelDownload.mock.calls[0][2]).toBe('pixel_art_xl.safetensors')
    })

    // A user asked on 2026-10-03: where does a catalogue LoRA come from.
    it('die Katalog-LoRAs stehen ueber der Suche, ein Klick installiert', async () => {
      render(createElement(ModelManager))
      fireEvent.click(screen.getByRole('button', { name: /^LoRAs/ }))
      fireEvent.click(screen.getByRole('button', { name: /^Get new/ }))
      const liste = await screen.findByTestId('lora-addons')
      const karte = liste.querySelector('[data-bundle-tile="Pixel Art XL · SDXL LoRA"]') as HTMLElement
      expect(karte).toBeTruthy()
      // Above the CivitAI card, not below it.
      const suche = screen.getByLabelText('Search CivitAI for LoRAs')
      expect(liste.compareDocumentPosition(suche) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      fireEvent.click(within(karte).getByRole('button', { name: /Get/ }))
      await waitFor(() => expect(installBundleComplete).toHaveBeenCalledWith('Pixel Art XL · SDXL LoRA'))
    })
  })

  describe('der Bild-Reiter ist die LoRAs los', () => {
    it('THE FIX: nur der Checkpoint und die VAE stehen dort, keine LoRA', () => {
      render(createElement(ModelManager))
      fireEvent.click(screen.getByRole('button', { name: /^Image/ }))
      fireEvent.click(screen.getByRole('button', { name: /^Installed/ }))
      const seite = document.body.textContent ?? ''
      expect(seite).toContain('sdxl_base.safetensors')
      // Die anderen Addon-Bahnen bleiben, wo sie waren: nur die LoRA-Bahn zieht um.
      expect(seite).toContain('sdxl_vae.safetensors')
      expect(seite).not.toContain('pixel_art_xl.safetensors')
      expect(seite).not.toContain('char_marla_zimage.safetensors')
    })

    it('der Zaehler der Bild-Bahn zaehlt die LoRAs nicht mehr mit', () => {
      render(createElement(ModelManager))
      // Vier Bilddateien im Bestand, zwei davon LoRAs: die Bahn zeigt 2.
      const bildKnopf = screen.getByRole('button', { name: /^Image/ })
      expect(bildKnopf.textContent).toMatch(/2$/)
      expect(screen.getByRole('button', { name: /^LoRAs/ }).textContent).toMatch(/2$/)
    })
  })

  describe('die Checkpoint-Suche fragt weiter nach Checkpoint', () => {
    it('GEGENPROBE: DiscoverModels gibt dem geteilten Panel den alten Typ mit', () => {
      const quelle = readFileSync(resolve(__dirname, '..', 'DiscoverModels.tsx'), 'utf8')
      expect(quelle).toMatch(/<CivitaiSearchPanel[\s\S]{0,120}modelType="Checkpoint"/)
      expect(quelle).not.toContain('modelType="LORA"')
    })
  })


  describe('Unterordner: der Name geht wortgleich weiter', () => {
    it('THE FIX: delete_comfy_model bekommt "styles/foo.safetensors", nicht "foo.safetensors"', async () => {
      bestand = [CHECKPOINT, LORA_IM_UNTERORDNER]
      openLoraInstalled()
      fireEvent.click(screen.getByRole('button', { name: 'Delete styles/foo.safetensors' }))
      fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }))
      await waitFor(() => expect(backendCall).toHaveBeenCalledTimes(1))
      const arg = backendCall.mock.calls[0][1] as { filename: string } | undefined
      expect(arg?.filename).toBe('styles/foo.safetensors')
      // NEGATIVKONTROLLE: der abgeschnittene Name waere ein anderer Ort.
      expect(arg?.filename).not.toBe('foo.safetensors')
    })

    it('THE FIX: dasselbe mit Backslash, und der Charakter-Chip erkennt ihn trotzdem', async () => {
      bestand = [CHECKPOINT, CHAR_LORA_WINDOWS]
      openLoraInstalled()
      const zeile = screen.getAllByTestId('lora-row')[0]
      expect(within(zeile).getByText('Character')).toBeTruthy()
      expect(zeile.textContent).toContain('Trigger word: marla')
      fireEvent.click(screen.getByRole('button', { name: 'Delete chars\\char_marla_zimage.safetensors' }))
      fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }))
      await waitFor(() => expect(backendCall).toHaveBeenCalledTimes(1))
      const arg = backendCall.mock.calls[0][1] as { filename: string } | undefined
      expect(arg?.filename).toBe('chars\\char_marla_zimage.safetensors')
      expect(arg?.filename).not.toBe('char_marla_zimage.safetensors')
    })
  })

  describe('die Kopfsuche auf der LoRA-Bahn', () => {
    it('THE FIX: filtert die Liste, ohne den Bestand zu verleugnen', () => {
      openLoraInstalled()
      fireEvent.change(screen.getByPlaceholderText(/Search (models|LoRAs)/), { target: { value: 'zzz' } })
      expect(screen.queryAllByTestId('lora-row')).toHaveLength(0)
      expect(screen.getByText(/No installed LoRAs match "zzz"/)).toBeTruthy()
      // NEGATIVKONTROLLE: der Leertext ueber den eigenen Bestand darf hier NICHT
      // stehen, es sind zwei LoRAs installiert.
      expect(screen.queryByText('No LoRAs installed yet')).toBeNull()
      // Die Abschnittszeile bleibt stehen, wie auf den anderen Bahnen. In der
      // klassischen Fassung heisst sie „LoRAs". In der Mac-Fassung heisst sie
      // „Installed LoRAs": dort traegt die Seite den Namen der Bahn als
      // Ueberschrift, und zweimal „LoRAs" untereinander waere keine Gliederung.
      expect(screen.getByRole('heading', { level: 2, name: fassung === 'mac' ? 'Installed LoRAs' : 'LoRAs' })).toBeTruthy()
      expect(screen.queryAllByRole('heading', { level: 1, name: 'LoRAs' })).toHaveLength(fassung === 'mac' ? 1 : 0)
    })

    it('THE FIX: Enter nimmt den Suchtext nach Get new mit und sucht damit', async () => {
      render(createElement(ModelManager))
      fireEvent.click(screen.getByRole('button', { name: /^LoRAs/ }))
      fireEvent.click(screen.getByRole('button', { name: /^Installed/ }))
      const kopf = screen.getByPlaceholderText(/Search (models|LoRAs)/)
      fireEvent.change(kopf, { target: { value: 'pixel art' } })
      fireEvent.keyDown(kopf, { key: 'Enter' })
      await waitFor(() => expect(searchCivitaiModels).toHaveBeenCalledTimes(1))
      expect(searchCivitaiModels.mock.calls[0][0]).toBe('pixel art')
      expect(searchCivitaiModels.mock.calls[0][1]).toBe('LORA')
      // Und das Feld der Karte steht nicht leer da.
      expect((screen.getByLabelText('Search CivitAI for LoRAs') as HTMLInputElement).value)
        .toBe('pixel art')
    })
  })

  describe('ein Loeschen, das fehlschlaegt, sagt es auf Englisch', () => {
    it('THE FIX: die Meldung aus Rust steht im Fenster, der Knopf bleibt nicht stumm', async () => {
      const meldung = 'pixel_art_xl.safetensors exists in more than one models folder'
      backendCall.mockRejectedValueOnce(new Error(meldung))
      openLoraInstalled()
      fireEvent.click(screen.getByRole('button', { name: 'Delete pixel_art_xl.safetensors' }))
      fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }))
      expect(await screen.findByText(meldung)).toBeTruthy()
      expect(screen.getByText('Delete failed')).toBeTruthy()
      // NEGATIVKONTROLLE: die Zeile ist NICHT verschwunden, es wurde nichts geloescht.
      expect(screen.getAllByTestId('lora-row')).toHaveLength(2)
    })
  })
})
