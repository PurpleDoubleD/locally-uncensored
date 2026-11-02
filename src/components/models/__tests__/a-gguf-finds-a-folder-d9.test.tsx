/**
 * @vitest-environment jsdom
 *
 * D9, Discord 02.11. (Windows 11, LU 3.0.8): many chat models in Discover
 * answered every Get with "Could not determine model directory. Please check
 * app permissions." Nothing was wrong with the permissions. The openai slot
 * held a server of the user's own (OpenRouter, Groq, a Custom one, vLLM …),
 * the download took that slot as its target, asked the backend for that
 * server's model folder, got "no conventional model directory" back, and the
 * reason was swallowed on the way.
 *
 * Now a server elsewhere counts like a cloud model, a local server without a
 * known folder hands its GGUF to the LU Engine and keeps the chat, and a real
 * failure says the backend's reason.
 *
 * Run: npx vitest run src/components/models/__tests__/a-gguf-finds-a-folder-d9.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

const started = vi.hoisted(() => [] as Array<{ dir: string }>)
const setActiveModel = vi.hoisted(() => vi.fn(async () => {}))
const folders = vi.hoisted(() => ({
  engine: '/lu/models' as string | null,
  server: null as string | null,
  engineReason: 'Create LU Engine models folder: Access is denied.',
}))

vi.mock('../../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/backend')>()),
  backendCall: vi.fn(async (cmd: string, args?: { provider?: string }) => {
    if (cmd !== 'detect_model_path') return []
    if (args?.provider === 'builtin') {
      if (folders.engine) return folders.engine
      throw new Error(folders.engineReason)
    }
    if (folders.server) return folders.server
    throw new Error(`No conventional model directory for provider '${args?.provider}'.`)
  }),
  openExternal: vi.fn(),
  isTauri: () => false,
  isMacOS: () => false,
}))
vi.mock('../../../api/comfyui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/comfyui')>()),
  getSystemVRAM: vi.fn(async () => 16),
  readComfyFolderLists: vi.fn(async () => ({})),
  refreshComfyModels: vi.fn(async () => {}),
}))
vi.mock('../../../api/discover', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/discover')>()),
  resolveHfGgufFiles: vi.fn(async () => null),
  checkDownloadSpace: vi.fn(async () => null),
}))
vi.mock('../../../api/model-download', () => ({
  startPlannedDownload: vi.fn(async (_plan: unknown, dir: string) => { started.push({ dir }) }),
}))
vi.mock('../../../hooks/useModels', () => ({
  useModels: () => ({ pullModel: vi.fn(), models: [], fetchModels: async () => {}, setActiveModel }),
}))
vi.mock('../../../lib/hardware', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/hardware')>()),
  getMaxVramGb: vi.fn(async () => 16),
  getTotalRamGb: vi.fn(async () => 32),
}))
vi.mock('../CivitaiSearchPanel', () => ({ CivitaiSearchPanel: () => null }))
vi.mock('../../chat/LuEngineSwitchBar', () => ({ LuEngineSwitchBar: () => null }))

import { DiscoverModels, noModelFolderError } from '../DiscoverModels'
import { resolveTextDownloadTarget, slotIsOnThisMachine } from '../../../lib/text-download-target'
import { useModelStore } from '../../../stores/modelStore'
import { useProviderStore } from '../../../stores/providerStore'
import { useUIStore } from '../../../stores/uiStore'

const OPENROUTER = { enabled: true, managed: false, name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' }
const VLLM = { enabled: true, managed: false, name: 'vLLM', baseUrl: 'http://localhost:8000/v1' }

function slot(openai: typeof OPENROUTER, activeModel: string, ollama = false) {
  const p = useProviderStore.getState().providers
  useProviderStore.setState({
    providers: { ...p, ollama: { ...p.ollama, enabled: ollama }, openai: { ...p.openai, ...openai } },
  })
  useModelStore.setState({ activeModel })
}
const firstGet = () => screen.getAllByRole('button', { name: /^Get/ })[0]
const targetName = () => screen.getByTestId('discover-target-name').textContent

beforeEach(() => {
  started.length = 0
  setActiveModel.mockClear()
  folders.engine = '/lu/models'
  folders.server = null
  useUIStore.setState({ discoverTarget: null })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('where a GGUF goes when the openai slot holds a server of the user', () => {
  it('a server elsewhere counts like a cloud model: the local rule decides', () => {
    expect(resolveTextDownloadTarget({ activeChatModel: 'openai::deepseek/deepseek-v4', openai: OPENROUTER })).toBe('builtin')
    expect(resolveTextDownloadTarget({ activeChatModel: 'openai::x', openai: OPENROUTER, ollamaEnabled: true })).toBe('ollama')
    expect(resolveTextDownloadTarget({ activeChatModel: null, openai: OPENROUTER })).toBe('builtin')
    expect(resolveTextDownloadTarget({ activeChatModel: 'openai::x', openai: { ...VLLM, baseUrl: 'http://192.168.1.20:8000/v1' } })).toBe('builtin')
    // A server on this machine stays the target, LM Studio too.
    expect(resolveTextDownloadTarget({ activeChatModel: 'openai::x', openai: VLLM })).toBe('openai-compat')
    expect(resolveTextDownloadTarget({ activeChatModel: 'openai::x', openai: { ...VLLM, name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' } })).toBe('lmstudio')
    expect(slotIsOnThisMachine('http://[::1]:8080/v1')).toBe(true)
    expect(slotIsOnThisMachine(undefined)).toBe(true)
    expect(slotIsOnThisMachine('https://api.groq.com/openai/v1')).toBe(false)
  })

  it('THE REPORT: OpenRouter in the slot, Get downloads into the LU Engine, no error', async () => {
    slot(OPENROUTER, 'openai::deepseek/deepseek-v4')
    render(<DiscoverModels category="text" />)
    await waitFor(() => expect(targetName()).toBe('LU Engine'))
    fireEvent.click(firstGet())
    await waitFor(() => expect(started).toEqual([{ dir: '/lu/models' }]))
    expect(screen.queryByText(/Could not determine model directory/)).toBeNull()
    expect(screen.queryByText(/LU found no folder/)).toBeNull()
  })

  it('a local server without a known folder: the GGUF goes to the LU Engine and the chat stays', async () => {
    slot(VLLM, 'openai::qwen')
    render(<DiscoverModels category="text" />)
    await waitFor(() => expect(targetName()).toBe('vLLM'))
    fireEvent.click(firstGet())
    await waitFor(() => expect(started).toEqual([{ dir: '/lu/models' }]))
    await screen.findByText(/vLLM reads no model folder LU knows, so .+ is downloading to the LU Engine\. Your chat stays on vLLM/)
    expect(setActiveModel).not.toHaveBeenCalled()
    expect(useModelStore.getState().activeModel).toBe('openai::qwen')
  })

  it('a local server with its folder keeps getting the file', async () => {
    folders.server = '/home/u/.jan/models'
    slot({ ...VLLM, name: 'Jan', baseUrl: 'http://localhost:1337/v1' }, 'openai::m')
    render(<DiscoverModels category="text" />)
    await waitFor(() => expect(targetName()).toBe('Jan'))
    fireEvent.click(firstGet())
    await waitFor(() => expect(started.length).toBe(1))
    expect(started[0].dir.startsWith('/home/u/.jan/models')).toBe(true)
  })

  it('when even the LU Engine folder cannot be had, the error says the real reason', async () => {
    folders.engine = null
    slot(OPENROUTER, 'openai::x')
    render(<DiscoverModels category="text" />)
    await waitFor(() => expect(targetName()).toBe('LU Engine'))
    fireEvent.click(firstGet())
    await screen.findByText(/LU found no folder to download .+ into: Create LU Engine models folder: Access is denied\./)
    expect(screen.queryByText(/app permissions/)).toBeNull()
    expect(started).toEqual([])
  })

  it('the error sentence without and with a reason', () => {
    expect(noModelFolderError('M', null)).toBe('LU found no folder to download M into.')
    expect(noModelFolderError('M', 'Disk gone.')).toBe('LU found no folder to download M into: Disk gone.')
  })
})
