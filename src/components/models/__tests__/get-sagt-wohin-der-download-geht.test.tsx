/**
 * @vitest-environment jsdom
 *
 * P11, David aus dem Testbau (30.10.2026): wohin "Get" ein Chatmodell laedt,
 * entschied resolveTextDownloadTarget nach dem aktiven Chatmodell, und der
 * Nutzer sah es nirgends. Mit einem Ollama-Modell im Chat landete ein GGUF in
 * Ollama, und der Neuron tweaker, der nur LU-Engine-Dateien liest, kannte es
 * nie.
 *
 * Am gerenderten Discover: das Ziel steht ueber der Liste und am Get-Knopf,
 * "Send to LU Engine instead" schickt den naechsten Download in die LU Engine,
 * ohne das Chatmodell zu wechseln, und der Knopf des Neuron tweakers kommt
 * mit diesem Ziel schon gesetzt an.
 *
 * Gegenprobe: ohne die Zeile, ohne `getTarget` an den Kacheln oder ohne
 * `chosenTextDownloadTarget` in handleTextDownload ist jeder Fall rot.
 *
 * Lauf: npx vitest run src/components/models/__tests__/get-sagt-wohin-der-download-geht.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

const started = vi.hoisted(() => [] as Array<{ dir: string }>)
const pullModel = vi.hoisted(() => vi.fn(async () => {}))
const setActiveModel = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/backend')>()),
  backendCall: vi.fn(async () => []),
  openExternal: vi.fn(),
  isTauri: () => false,
  isMacOS: () => false,
}))
vi.mock('../../../api/comfyui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/comfyui')>()),
  getSystemVRAM: vi.fn(async () => 24),
  readComfyFolderLists: vi.fn(async () => ({})),
  refreshComfyModels: vi.fn(async () => {}),
}))
vi.mock('../../../api/discover', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/discover')>()),
  resolveHfGgufFiles: vi.fn(async () => null),
  luEngineDownloadDir: vi.fn(async () => '/lu/models'),
  detectProviderModelPath: vi.fn(async () => '/lmstudio/models'),
  checkDownloadSpace: vi.fn(async () => null),
}))
vi.mock('../../../api/model-download', () => ({
  startPlannedDownload: vi.fn(async (_plan: unknown, dir: string) => { started.push({ dir }) }),
}))
vi.mock('../../../hooks/useModels', () => ({
  useModels: () => ({ pullModel, models: [], fetchModels: async () => {}, setActiveModel }),
}))
vi.mock('../../../lib/hardware', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/hardware')>()),
  getMaxVramGb: vi.fn(async () => 24),
  getTotalRamGb: vi.fn(async () => 64),
}))
vi.mock('../CivitaiSearchPanel', () => ({ CivitaiSearchPanel: () => null }))
vi.mock('../../chat/LuEngineSwitchBar', () => ({ LuEngineSwitchBar: () => null }))

import { DiscoverModels } from '../DiscoverModels'
import { useModelStore } from '../../../stores/modelStore'
import { useProviderStore } from '../../../stores/providerStore'
import { useUIStore } from '../../../stores/uiStore'

const gets = () => screen.getAllByRole('button', { name: /^Get/ })
const targetName = () => screen.getByTestId('discover-target-name').textContent

function ollamaInChat() {
  const p = useProviderStore.getState().providers
  useProviderStore.setState({
    providers: {
      ...p,
      ollama: { ...p.ollama, enabled: true },
      openai: { ...p.openai, enabled: true, managed: true, name: 'LU Engine' },
    },
  })
  useModelStore.setState({ activeModel: 'llama3:8b' })
}

beforeEach(() => {
  started.length = 0
  pullModel.mockClear()
  setActiveModel.mockClear()
  useUIStore.setState({ discoverTarget: null })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Get says where a chat model goes', () => {
  it('names Ollama when an Ollama model is in the chat, above the list and on Get', async () => {
    ollamaInChat()
    render(<DiscoverModels category="text" />)
    await waitFor(() => expect(targetName()).toBe('Ollama'))
    expect(gets().length).toBeGreaterThan(0)
    for (const b of gets()) expect(b.textContent).toMatch(/→ Ollama$/)
  })

  it('LU Engine for this download: the file lands in the LU Engine folder and the chat model stays', async () => {
    ollamaInChat()
    render(<DiscoverModels category="text" />)
    fireEvent.click(await screen.findByTestId('discover-target-builtin'))
    expect(targetName()).toBe('LU Engine')
    const get = gets().find((b) => /→ LU Engine$/.test(b.textContent ?? ''))!
    expect(get).toBeTruthy()
    fireEvent.click(get)
    await waitFor(() => expect(started).toEqual([{ dir: '/lu/models' }]))
    expect(pullModel).not.toHaveBeenCalled()
    expect(setActiveModel).not.toHaveBeenCalled()
    expect(useModelStore.getState().activeModel).toBe('llama3:8b')
    // And back: the next Get follows the chat model again.
    fireEvent.click(screen.getByTestId('discover-target-follow'))
    expect(targetName()).toBe('Ollama')
  })

  it('arrives with the LU Engine set when the Neuron tweaker sent the user here', async () => {
    ollamaInChat()
    useUIStore.getState().openDiscoverFor('builtin')
    render(<DiscoverModels category="text" />)
    await waitFor(() => expect(targetName()).toBe('LU Engine'))
    expect(useUIStore.getState().discoverTarget).toBeNull()
  })

  it('offers no choice when the chat model already runs on the LU Engine', async () => {
    ollamaInChat()
    useModelStore.setState({ activeModel: 'openai::qwen' })
    render(<DiscoverModels category="text" />)
    await waitFor(() => expect(targetName()).toBe('LU Engine'))
    expect(screen.queryByTestId('discover-target-builtin')).toBeNull()
  })
})
