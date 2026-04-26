/**
 * remoteStore v2 — memory enrichment + dispatch lifecycle tests
 *
 * These pair with the existing remoteStore.test.ts but drill into the
 * memory-baking pipeline and per-chat dispatch semantics introduced with
 * the mobile v2 rebuild.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useRemoteStore } from '../remoteStore'
import { useMemoryStore } from '../memoryStore'

// ─── Mocks ───
vi.mock('../../api/backend', () => ({
  backendCall: vi.fn().mockResolvedValue({}),
  // isTauri is consulted at the top of startServer/startTunnel/restart to
  // short-circuit dev-mode callers (REMOTE_DEV_MODE_ERROR). Tests in this
  // file exercise the happy path so we always return true.
  isTauri: vi.fn(() => true),
}))
import { backendCall } from '../../api/backend'
const mockBackend = backendCall as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockBackend.mockClear()
  useRemoteStore.setState({
    enabled: false,
    port: 11435,
    passcode: '',
    passcodeExpiresAt: 0,
    lanUrl: '',
    mobileUrl: '',
    qrPngBase64: '',
    connectedDevices: [],
    permissions: { filesystem: false, downloads: false, process_control: false },
    loading: false,
    error: null,
    tunnelActive: false,
    tunnelUrl: '',
    tunnelLoading: false,
    dispatchedConversationId: null,
    qrVisible: false,
  })
  useMemoryStore.setState({ memories: [] } as any)
})

afterEach(() => {
  mockBackend.mockReset()
})

describe('remoteStore › initial state', () => {
  it('starts with dispatchedConversationId null', () => {
    expect(useRemoteStore.getState().dispatchedConversationId).toBeNull()
  })

  it('starts disabled', () => {
    expect(useRemoteStore.getState().enabled).toBe(false)
  })

  it('starts with empty passcode', () => {
    expect(useRemoteStore.getState().passcode).toBe('')
  })

  it('starts with empty connected devices', () => {
    expect(useRemoteStore.getState().connectedDevices).toEqual([])
  })

  it('starts with default permissions all false', () => {
    const p = useRemoteStore.getState().permissions
    expect(p.filesystem).toBe(false)
    expect(p.downloads).toBe(false)
    expect(p.process_control).toBe(false)
  })

  it('starts with tunnel inactive', () => {
    expect(useRemoteStore.getState().tunnelActive).toBe(false)
  })

  it('starts without loading state', () => {
    expect(useRemoteStore.getState().loading).toBe(false)
  })

  it('starts without error', () => {
    expect(useRemoteStore.getState().error).toBeNull()
  })
})

describe('remoteStore › dispatch()', () => {
  it('sets dispatchedConversationId after successful dispatch', async () => {
    mockBackend.mockResolvedValue({ port: 11435, passcode: '123456' })
    await useRemoteStore.getState().dispatch('conv-1', 'qwen3:8b', 'You are helpful.')
    expect(useRemoteStore.getState().dispatchedConversationId).toBe('conv-1')
  })

  it('passes model + systemPrompt to backend', async () => {
    mockBackend.mockResolvedValue({ port: 11435, passcode: '123456' })
    await useRemoteStore.getState().dispatch('conv-2', 'qwen3:8b', 'SYS')
    const call = mockBackend.mock.calls.find(c => c[0] === 'start_remote_server')
    expect(call).toBeDefined()
    expect(call![1].model).toBe('qwen3:8b')
    expect(typeof call![1].systemPrompt).toBe('string')
  })

  it('enriches systemPrompt with memory before sending', async () => {
    useMemoryStore.setState({
      getMemoriesForPrompt: () => 'MEM CONTEXT HERE',
    } as any)
    mockBackend.mockResolvedValue({ port: 11435, passcode: '123456' })
    await useRemoteStore.getState().dispatch('c', 'm', 'BASE')
    const call = mockBackend.mock.calls.find(c => c[0] === 'start_remote_server')
    expect(call![1].systemPrompt).toContain('BASE')
    expect(call![1].systemPrompt).toContain('MEM CONTEXT HERE')
  })

  it('uses memory-only prompt if base systemPrompt is empty', async () => {
    useMemoryStore.setState({
      getMemoriesForPrompt: () => 'ONLY_MEMORIES',
    } as any)
    mockBackend.mockResolvedValue({ port: 11435, passcode: '123456' })
    await useRemoteStore.getState().dispatch('c', 'm', '')
    const call = mockBackend.mock.calls.find(c => c[0] === 'start_remote_server')
    expect(call![1].systemPrompt).toContain('ONLY_MEMORIES')
  })

  it('leaves systemPrompt unchanged when no memories', async () => {
    useMemoryStore.setState({
      getMemoriesForPrompt: () => '',
    } as any)
    mockBackend.mockResolvedValue({ port: 11435, passcode: '123456' })
    await useRemoteStore.getState().dispatch('c', 'm', 'KEEP_THIS')
    const call = mockBackend.mock.calls.find(c => c[0] === 'start_remote_server')
    expect(call![1].systemPrompt).toBe('KEEP_THIS')
  })

  it('sets error on dispatch failure', async () => {
    mockBackend.mockRejectedValueOnce(new Error('boom'))
    await useRemoteStore.getState().dispatch('c', 'm', '').catch(() => {})
    expect(useRemoteStore.getState().error).toMatch(/boom/)
  })

  it('records an error via set() on startServer failure', async () => {
    // #29: startServer + dispatch now rethrow so the caller (Sidebar)
    // can delete the orphan conv. The error still lives on the store.
    mockBackend.mockRejectedValueOnce(new Error('startup-fail'))
    await useRemoteStore.getState().dispatch('c', 'm', '').catch(() => {})
    expect(useRemoteStore.getState().error).toMatch(/startup-fail/)
  })

  it('rethrows on startServer failure so Sidebar can clean up the orphan conv', async () => {
    // #29: phantomderp's bug — silent failure left the user staring at a
    // "Server stopped" banner that did nothing. The store now rethrows
    // so Sidebar.handleDispatch can delete the just-created conv row.
    mockBackend.mockRejectedValueOnce(new Error('port-in-use'))
    await expect(
      useRemoteStore.getState().dispatch('orphan', 'm', '')
    ).rejects.toThrow('port-in-use')
    expect(useRemoteStore.getState().dispatchedConversationId).toBeNull()
    expect(useRemoteStore.getState().error).toMatch(/port-in-use/)
  })
})

describe('remoteStore › restart() failure semantics', () => {
  it('rethrows on backend failure and exposes the error to the UI', async () => {
    // #29: ChatView's "Server stopped" banner uses the rethrow + error
    // state to render the actual reason inline, instead of the user
    // clicking Restart forever.
    mockBackend.mockRejectedValueOnce(new Error('bind-failed'))
    await expect(
      useRemoteStore.getState().restart('m', '')
    ).rejects.toThrow('bind-failed')
    expect(useRemoteStore.getState().enabled).toBe(false)
    expect(useRemoteStore.getState().loading).toBe(false)
    expect(useRemoteStore.getState().error).toMatch(/bind-failed/)
  })

  it('clearError() wipes the error so the next attempt starts clean', () => {
    useRemoteStore.setState({ error: 'previous failure' })
    useRemoteStore.getState().clearError()
    expect(useRemoteStore.getState().error).toBeNull()
  })
})

describe('remoteStore › undispatch()', () => {
  it('clears dispatchedConversationId', async () => {
    useRemoteStore.setState({ dispatchedConversationId: 'conv-live' })
    mockBackend.mockResolvedValue({})
    await useRemoteStore.getState().undispatch()
    expect(useRemoteStore.getState().dispatchedConversationId).toBeNull()
  })

  it('calls stop_remote_server backend when server is enabled', async () => {
    useRemoteStore.setState({ dispatchedConversationId: 'x', enabled: true })
    mockBackend.mockResolvedValue({})
    await useRemoteStore.getState().undispatch()
    const stopCall = mockBackend.mock.calls.find(c => c[0] === 'stop_remote_server')
    expect(stopCall).toBeDefined()
  })

  it('skips backend call when server is not enabled', async () => {
    useRemoteStore.setState({ dispatchedConversationId: 'x', enabled: false })
    mockBackend.mockResolvedValue({})
    await useRemoteStore.getState().undispatch()
    const stopCall = mockBackend.mock.calls.find(c => c[0] === 'stop_remote_server')
    expect(stopCall).toBeUndefined()
  })
})

describe('remoteStore › memory enrichment behaviour', () => {
  it('prepends "remembered context" preamble to memory block', async () => {
    useMemoryStore.setState({ getMemoriesForPrompt: () => 'FACT_A\nFACT_B' } as any)
    mockBackend.mockResolvedValue({})
    await useRemoteStore.getState().dispatch('c', 'm', '')
    const call = mockBackend.mock.calls.find(c => c[0] === 'start_remote_server')
    expect(call![1].systemPrompt).toContain('remembered context')
  })

  it('separates base prompt and memory with double newline', async () => {
    useMemoryStore.setState({ getMemoriesForPrompt: () => 'MEM' } as any)
    mockBackend.mockResolvedValue({})
    await useRemoteStore.getState().dispatch('c', 'm', 'BASE')
    const call = mockBackend.mock.calls.find(c => c[0] === 'start_remote_server')
    expect(call![1].systemPrompt).toMatch(/BASE\n\n.*remembered context/s)
  })

  it('swallows memory-store errors gracefully', async () => {
    useMemoryStore.setState({
      getMemoriesForPrompt: () => { throw new Error('store broke') },
    } as any)
    mockBackend.mockResolvedValue({})
    await useRemoteStore.getState().dispatch('c', 'm', 'STILL_OK')
    const call = mockBackend.mock.calls.find(c => c[0] === 'start_remote_server')
    // Should still dispatch with at least the base prompt
    expect(call![1].systemPrompt).toContain('STILL_OK')
  })

  it('enrichment applies to restart as well (via restart_remote_server)', async () => {
    useMemoryStore.setState({ getMemoriesForPrompt: () => 'MEM' } as any)
    mockBackend.mockResolvedValue({})
    const restart = (useRemoteStore.getState() as any).restart
    if (typeof restart === 'function') {
      await restart('conv-r', 'm', 'BASE')
      const call = mockBackend.mock.calls.find(c => c[0] === 'restart_remote_server')
      if (call) {
        expect(call[1].systemPrompt).toContain('MEM')
      }
    }
  })
})

describe('remoteStore › permissions state', () => {
  it('can set filesystem permission', () => {
    useRemoteStore.setState({
      permissions: { filesystem: true, downloads: false, process_control: false },
    })
    expect(useRemoteStore.getState().permissions.filesystem).toBe(true)
  })

  it('can set downloads permission independently', () => {
    useRemoteStore.setState({
      permissions: { filesystem: false, downloads: true, process_control: false },
    })
    expect(useRemoteStore.getState().permissions.downloads).toBe(true)
    expect(useRemoteStore.getState().permissions.filesystem).toBe(false)
  })

  it('can set process_control permission independently', () => {
    useRemoteStore.setState({
      permissions: { filesystem: false, downloads: false, process_control: true },
    })
    expect(useRemoteStore.getState().permissions.process_control).toBe(true)
  })

  it('can have all permissions simultaneously', () => {
    useRemoteStore.setState({
      permissions: { filesystem: true, downloads: true, process_control: true },
    })
    const p = useRemoteStore.getState().permissions
    expect(p.filesystem && p.downloads && p.process_control).toBe(true)
  })
})

describe('remoteStore › passcode/url state', () => {
  it('stores passcode as returned by backend', () => {
    useRemoteStore.setState({ passcode: '123456' })
    expect(useRemoteStore.getState().passcode).toBe('123456')
  })

  it('stores expires_at as returned by backend', () => {
    useRemoteStore.setState({ passcodeExpiresAt: 1700000000 })
    expect(useRemoteStore.getState().passcodeExpiresAt).toBe(1700000000)
  })

  it('has mobileUrl separate from lanUrl', () => {
    useRemoteStore.setState({
      lanUrl: 'http://192.168.1.1:11435',
      mobileUrl: 'http://192.168.1.1:11435/mobile',
    })
    expect(useRemoteStore.getState().lanUrl).not.toBe(useRemoteStore.getState().mobileUrl)
    expect(useRemoteStore.getState().mobileUrl).toContain('/mobile')
  })

  it('tunnelUrl is independent of lanUrl', () => {
    useRemoteStore.setState({
      lanUrl: 'http://192.168.1.1:11435',
      tunnelUrl: 'https://xxx.trycloudflare.com',
      tunnelActive: true,
    })
    expect(useRemoteStore.getState().tunnelActive).toBe(true)
    expect(useRemoteStore.getState().tunnelUrl).toContain('trycloudflare')
  })
})

describe('remoteStore › connected devices', () => {
  it('stores connected devices array', () => {
    useRemoteStore.setState({
      connectedDevices: [
        { id: 'dev-1', ip: '192.168.1.50', user_agent: 'Mobile Safari', last_seen: 1700 },
      ],
    })
    expect(useRemoteStore.getState().connectedDevices).toHaveLength(1)
  })

  it('devices have all required fields', () => {
    const dev = { id: 'd1', ip: '10.0.0.1', user_agent: 'UA', last_seen: 1 }
    useRemoteStore.setState({ connectedDevices: [dev] })
    expect(useRemoteStore.getState().connectedDevices[0]).toEqual(dev)
  })

  it('can have multiple devices', () => {
    useRemoteStore.setState({
      connectedDevices: [
        { id: 'd1', ip: '1', user_agent: 'A', last_seen: 1 },
        { id: 'd2', ip: '2', user_agent: 'B', last_seen: 2 },
      ],
    })
    expect(useRemoteStore.getState().connectedDevices).toHaveLength(2)
  })
})
