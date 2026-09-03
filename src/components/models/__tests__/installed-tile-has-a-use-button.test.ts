/**
 * @vitest-environment jsdom
 *
 * A16 (A14-4a), Windows counter-check 02.09.: the 2.6.8 release notes promise
 * a Use button on the Installed tile twice ("stays visible as Installed with a
 * Use button that starts the engine for it", "its tile carries a Use button
 * that starts the engine and loads that model"). On the real build the tile
 * carried Bench and Details and nothing else. The tile itself was the switch,
 * which works and says nothing about itself, so the counter-check filed the
 * button as missing and was right to.
 *
 * The button is here now, on LU Engine rows that are not already active, and
 * it takes exactly the path the tile click takes (`activateModel` in
 * useModels, behind the shared bolt in api/lu-engine-swap-lock).
 *
 * Run: npx vitest run src/components/models/__tests__/installed-tile-has-a-use-button.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

const activateBuiltinModel = vi.fn(async () => true)

vi.mock('../../../api/backend', () => ({
  isTauri: () => true,
  isMacOS: () => false,
  isWindows: () => true,
  isLinux: () => false,
  backendCall: vi.fn(async () => null),
  secretGet: vi.fn().mockRejectedValue(new Error('no vault')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))
vi.mock('../../../api/comfyui', async () => {
  const actual = await vi.importActual<typeof import('../../../api/comfyui')>('../../../api/comfyui')
  return {
    ...actual,
    getInstalledImageModels: vi.fn(async () => []),
    getInstalledVideoModels: vi.fn(async () => []),
    checkComfyConnection: vi.fn(async () => false),
    refreshComfyModels: vi.fn(async () => undefined),
    readModelDiskSizes: vi.fn(async () => new Map()),
    getSystemVRAM: vi.fn(async () => 0),
  }
})
vi.mock('../../../api/ollama', () => ({
  listModels: vi.fn(async () => []),
  unloadModel: vi.fn(async () => undefined),
  pullModel: vi.fn(), pullModelTauri: vi.fn(), deleteModel: vi.fn(), showModel: vi.fn(async () => ({})),
}))
vi.mock('../../../api/providers', async () => {
  const actual = await vi.importActual<typeof import('../../../api/providers')>('../../../api/providers')
  return { ...actual, getEnabledProviders: () => [] }
})
vi.mock('../../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../../api/engine')>('../../../api/engine')
  return {
    ...actual,
    listBundledModels: vi.fn(async () => []),
    customModelDirs: vi.fn(async () => []),
    isManagedBuiltinActive: () => true,
    bundledEngineStatus: vi.fn(async () => ({ running: true, healthy: true, port: 8127 })),
    bundledEmbedStatus: vi.fn(async () => ({ running: true, healthy: true, port: 8128 })),
    startBundledEmbed: vi.fn(),
    activateBuiltinModel: (...a: unknown[]) => activateBuiltinModel(...(a as [])),
  }
})

const { ModelManager } = await import('../ModelManager')
const { useModelStore } = await import('../../../stores/modelStore')
const { useProviderStore } = await import('../../../stores/providerStore')
const { __resetLuEngineSwapLockForTests } = await import('../../../api/lu-engine-swap-lock')
const { displayModelName } = await import('../../../api/providers/model-name')

const ACTIVE = 'openai::Phi-4-mini-instruct-Q4_K_M'
const OTHER = 'openai::mlabonne_gemma-3-4b-it-abliterated-Q4_K_M'
const OLLAMA = 'llama3.2:3b'

function installedList() {
  return [
    { name: ACTIVE, model: 'Phi-4-mini-instruct-Q4_K_M', size: 1, type: 'text', provider: 'openai', providerName: 'LU Engine' },
    { name: OTHER, model: 'mlabonne_gemma-3-4b-it-abliterated-Q4_K_M', size: 1, type: 'text', provider: 'openai', providerName: 'LU Engine' },
    { name: OLLAMA, model: OLLAMA, size: 1, type: 'text', provider: 'ollama', providerName: 'Ollama' },
  ] as never
}

/** The Installed tab of the Models page, as the counter-check had it open. */
async function openInstalled() {
  render(createElement(ModelManager))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  fireEvent.click(screen.getByText('Installed'))
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
  // The hook's own fetch answers with the mocked backends (nothing), so the
  // rows are put in afterwards, which is also what a refresh does.
  await act(async () => {
    useModelStore.setState({ models: installedList(), activeModel: ACTIVE })
    await Promise.resolve()
  })
}

/** The Use button on the row for `name`, or null when the row has none.
 *
 *  Gesucht wird nach dem Namen, den der Nutzer SIEHT. Die Kachel zeigt seit
 *  dem 04.09.2026 den Anzeigenamen ohne `openai::`, denn das ist unser
 *  Steckplatzname und kein Name, den ein Kunde je gewaehlt hat (Persona P5).
 *  Der volle Name lebt weiter im title. */
function useButtonFor(name: string): HTMLElement | null {
  const row = screen.getByText(displayModelName(name)).closest('div[class*="rounded-lg"]')
  return row?.querySelector('[data-testid="model-card-use"]') as HTMLElement | null
}

beforeEach(() => {
  activateBuiltinModel.mockReset()
  activateBuiltinModel.mockResolvedValue(true)
  __resetLuEngineSwapLockForTests()
  useProviderStore.getState().resetProvidersToDefaults()
  useProviderStore.getState().setProviderConfig('openai', {
    enabled: true, managed: true, name: 'LU Engine', baseUrl: 'http://127.0.0.1:8127/v1',
  })
  useModelStore.setState({ models: installedList(), activeModel: ACTIVE, categoryFilter: 'text' })
})
afterEach(() => { cleanup(); __resetLuEngineSwapLockForTests() })

describe('the Use button the 2.6.8 notes promise on the Installed tile', () => {
  it('is on every LU Engine row that is not the active one', async () => {
    await openInstalled()
    expect(useButtonFor(OTHER), 'the notes promise this button twice').not.toBeNull()
    expect(useButtonFor(OTHER)!.textContent).toContain('Use')
  })

  it('starts the engine on that model, the same way the tile click does', async () => {
    await openInstalled()
    await act(async () => { fireEvent.click(useButtonFor(OTHER)!) })
    expect(activateBuiltinModel).toHaveBeenCalledWith(OTHER)
    expect(useModelStore.getState().activeModel).toBe(OTHER)
  })

  it('says Loading while the swap runs and stops saying it afterwards', async () => {
    let release: (v: boolean) => void = () => {}
    activateBuiltinModel.mockImplementation(() => new Promise<boolean>((r) => { release = r }))
    await openInstalled()
    await act(async () => { fireEvent.click(useButtonFor(OTHER)!) })

    // The row is the active one now, so the busy state is read off the button
    // the click left behind rather than off a fresh lookup.
    expect(document.body.textContent, 'a cold GGUF takes seconds and the button looked idle').toContain('Loading…')

    await act(async () => { release(true); await Promise.resolve(); await Promise.resolve() })
    expect(document.body.textContent).not.toContain('Loading…')
  })

  // NEGATIVE CONTROL: the active row says Active and offers nothing to press.
  it('is absent on the model that is already active', async () => {
    await openInstalled()
    expect(useButtonFor(ACTIVE), 'Use on the model already in use is noise').toBeNull()
    expect(document.body.textContent).toContain('Active')
  })

  // NEGATIVE CONTROL: an Ollama row is served by another backend. A Use button
  // there would promise something the LU Engine cannot do for that row.
  it('is absent on a row that is not ours', async () => {
    await openInstalled()
    expect(useButtonFor(OLLAMA)).toBeNull()
  })

  // Persona P5, 03./04.09.2026: "openai:: steht vor jedem lokalen
  // Modellnamen. Fuer einen Kunden, der LU Engine benutzt und mit OpenAI
  // nichts zu tun hat, ist das verwirrend." Es ist unser Steckplatzname,
  // nicht seiner.
  it('nennt kein Modell mit dem Steckplatz-Praefix', async () => {
    await openInstalled()
    expect(document.body.textContent).not.toContain('openai::')
    // Gegenprobe zur Gegenprobe: der Name ist wirklich da, nur ohne Praefix.
    expect(document.body.textContent).toContain('Phi-4-mini-instruct-Q4_K_M')
    // Und der volle Name bleibt fuer einen Fehlerbericht erreichbar.
    const zeile = screen.getByText(displayModelName(ACTIVE))
    expect(zeile.getAttribute('title')).toBe(ACTIVE)
  })

  // NEGATIVE CONTROL: the button is a door into the same house, so it obeys
  // the shared bolt. A press while another swap is running must not send a
  // second swap_bundled_model at one llama-server.
  it('is blocked by the shared swap bolt like every other door', async () => {
    const { tryAcquireLuEngineSwap } = await import('../../../api/lu-engine-swap-lock')
    await openInstalled()
    expect(tryAcquireLuEngineSwap(), 'someone else is mid swap').toBe(true)
    await act(async () => { fireEvent.click(useButtonFor(OTHER)!) })
    expect(activateBuiltinModel).not.toHaveBeenCalled()
  })
})
