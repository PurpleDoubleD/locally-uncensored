import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockBackendCall = vi.fn()
const mockIsTauri = vi.fn(() => true)
vi.mock('../../api/backend', () => ({
  backendCall: (...args: unknown[]) => mockBackendCall(...args),
  isTauri: () => mockIsTauri(),
}))

import { useRemoteStore, REMOTE_DEV_MODE_ERROR, remoteBackendArgs, normalizeRemotePermissions } from '../remoteStore'

describe('remoteBackendArgs (#87 non-Ollama remote routing)', () => {
  const providers = {
    ollama: { baseUrl: 'http://localhost:11434' },
    openai: { baseUrl: 'http://127.0.0.1:8127/v1' },
    anthropic: { baseUrl: 'https://api.anthropic.com' },
  }
  const noKey = () => ''
  const withKey = (id: string) => (id === 'openai' ? 'sk-lan' : '')

  it('routes an openai:: model to the openai backend with its base + bare name', () => {
    const out = remoteBackendArgs('openai::qwen3:8b', providers, noKey)
    expect(out.backendKind).toBe('openai')
    expect(out.backendBase).toBe('http://127.0.0.1:8127/v1')
    expect(out.model).toBe('qwen3:8b') // provider prefix stripped
    expect(out.backendKey).toBeUndefined() // empty key omitted
  })

  it('forwards a bearer key when the openai provider has one', () => {
    const out = remoteBackendArgs('openai::m', providers, withKey)
    expect(out.backendKind).toBe('openai')
    expect(out.backendKey).toBe('sk-lan')
  })

  it('leaves a bare Ollama model on the Ollama path (back-compat)', () => {
    const out = remoteBackendArgs('qwen3:8b', providers, noKey)
    expect(out.backendKind).toBe('ollama')
    expect(out.backendBase).toBeUndefined()
    expect(out.model).toBe('qwen3:8b')
  })

  it('falls back to Ollama for cloud/anthropic (not reachable over remote yet)', () => {
    expect(remoteBackendArgs('anthropic::claude', providers, noKey).backendKind).toBe('ollama')
    expect(remoteBackendArgs('lu-cloud::x', providers, noKey).backendKind).toBe('ollama')
  })

  it('defaults to Ollama with no dispatched model', () => {
    const out = remoteBackendArgs(undefined, providers, noKey)
    expect(out.backendKind).toBe('ollama')
    expect(out.model).toBeUndefined()
  })
})

describe('remoteStore', () => {
  beforeEach(() => {
    mockBackendCall.mockReset()
    mockIsTauri.mockReset()
    mockIsTauri.mockReturnValue(true) // default: assume Tauri is available
    useRemoteStore.setState({
      enabled: false,
      port: 11435,
      passcode: '',
      passcodeExpiresAt: 0,
      lanUrl: '',
      mobileUrl: '',
      qrPngBase64: '',
      connectedDevices: [],
      permissions: { filesystem: false, downloads: false, process_control: false, shell: false },
      tunnelActive: false,
      tunnelUrl: '',
      tunnelLoading: false,
      loading: false,
      error: null,
      qrVisible: false,
    })
  })

  // ── startServer ────────────────────────────────────────────

  describe('startServer', () => {
    it('sets loading=true, then updates state on success', async () => {
      mockBackendCall
        .mockResolvedValueOnce({
          port: 11435,
          passcode: 'ABC123',
          passcodeExpiresAt: 9999,
          lanUrl: 'http://192.168.1.1:11435',
          mobileUrl: 'http://192.168.1.1:11435/m',
        })
        // fetchQrCode call
        .mockResolvedValueOnce({ qr_png_base64: 'base64data', url: '', passcode: '' })

      await useRemoteStore.getState().startServer()

      const state = useRemoteStore.getState()
      expect(state.enabled).toBe(true)
      expect(state.port).toBe(11435)
      expect(state.passcode).toBe('ABC123')
      expect(state.passcodeExpiresAt).toBe(9999)
      expect(state.lanUrl).toBe('http://192.168.1.1:11435')
      expect(state.mobileUrl).toBe('http://192.168.1.1:11435/m')
      expect(state.loading).toBe(false)
    })

    it('calls backendCall with start_remote_server', async () => {
      mockBackendCall.mockResolvedValue({ port: 0, passcode: '', passcodeExpiresAt: 0, lanUrl: '', mobileUrl: '' })
      await useRemoteStore.getState().startServer()
      // #87: startServer always tags the backend kind. With no dispatched model
      // it defaults to the Ollama path (back-compat), so args carry only that.
      expect(mockBackendCall).toHaveBeenCalledWith('start_remote_server', { backendKind: 'ollama' })
    })

    it('auto-fetches QR code after starting', async () => {
      mockBackendCall
        .mockResolvedValueOnce({ port: 0, passcode: '', passcodeExpiresAt: 0, lanUrl: '', mobileUrl: '' })
        .mockResolvedValueOnce({ qr_png_base64: 'qr123', url: '', passcode: '' })

      await useRemoteStore.getState().startServer()
      // Wait for fetchQrCode to be called (it's fire-and-forget)
      await vi.waitFor(() => {
        expect(mockBackendCall).toHaveBeenCalledWith('remote_qr_code')
      })
    })

    it('sets error and rethrows on failure', async () => {
      mockBackendCall.mockRejectedValueOnce(new Error('Connection refused'))
      // #29: startServer rethrows so dispatch()/restart() callers can clean up
      // (delete orphan conv, surface UI banner) instead of silently
      // marking the chat as dispatched on a server that never came up.
      await expect(useRemoteStore.getState().startServer()).rejects.toThrow('Connection refused')
      const state = useRemoteStore.getState()
      expect(state.loading).toBe(false)
      expect(state.error).toContain('Connection refused')
      expect(state.enabled).toBe(false)
    })

    // Reported by @phantomderp on v2.4.2 — clicking LAN/Internet from
    // `npm run dev` produced an HTTP 404 + JSON.parse SyntaxError because
    // the dev server can't host the Rust backend Remote needs. The store
    // short-circuits with REMOTE_DEV_MODE_ERROR; backendCall is never
    // reached.
    describe('dev-mode short-circuit', () => {
      it('throws REMOTE_DEV_MODE_ERROR when isTauri() is false', async () => {
        mockIsTauri.mockReturnValue(false)
        await expect(useRemoteStore.getState().startServer()).rejects.toThrow(REMOTE_DEV_MODE_ERROR)
      })

      it('sets the dev-mode error on state without calling backendCall', async () => {
        mockIsTauri.mockReturnValue(false)
        try { await useRemoteStore.getState().startServer() } catch { /* expected */ }
        expect(mockBackendCall).not.toHaveBeenCalled()
        expect(useRemoteStore.getState().error).toBe(REMOTE_DEV_MODE_ERROR)
        expect(useRemoteStore.getState().loading).toBe(false)
        expect(useRemoteStore.getState().enabled).toBe(false)
      })

      it('restart() also short-circuits in dev mode', async () => {
        mockIsTauri.mockReturnValue(false)
        await expect(useRemoteStore.getState().restart()).rejects.toThrow(REMOTE_DEV_MODE_ERROR)
        expect(mockBackendCall).not.toHaveBeenCalled()
      })

      it('startTunnel() also short-circuits in dev mode', async () => {
        mockIsTauri.mockReturnValue(false)
        await expect(useRemoteStore.getState().startTunnel()).rejects.toThrow(REMOTE_DEV_MODE_ERROR)
        expect(mockBackendCall).not.toHaveBeenCalled()
        expect(useRemoteStore.getState().tunnelLoading).toBe(false)
      })

      it('REMOTE_DEV_MODE_ERROR mentions the actionable path (`npm run tauri:dev`)', () => {
        // If the message ever loses the developer-actionable hint, this
        // catches it. The whole point of the short-circuit is to point
        // people at the right command.
        expect(REMOTE_DEV_MODE_ERROR).toMatch(/npm run tauri:dev/)
        expect(REMOTE_DEV_MODE_ERROR.toLowerCase()).toContain('desktop app')
      })
    })
  })

  // ── stopServer ─────────────────────────────────────────────

  describe('stopServer', () => {
    it('clears all state on success', async () => {
      // Set up a "running" state first
      useRemoteStore.setState({
        enabled: true,
        passcode: 'XYZ',
        passcodeExpiresAt: 9999,
        lanUrl: 'http://x',
        mobileUrl: 'http://y',
        qrPngBase64: 'data',
        connectedDevices: [{ id: 'd1', ip: '1.1.1.1', user_agent: 'test', last_seen: 1 }],
        tunnelActive: true,
        tunnelUrl: 'https://tunnel',
      })
      mockBackendCall.mockResolvedValueOnce(undefined)
      await useRemoteStore.getState().stopServer()

      const state = useRemoteStore.getState()
      expect(state.enabled).toBe(false)
      expect(state.passcode).toBe('')
      expect(state.passcodeExpiresAt).toBe(0)
      expect(state.lanUrl).toBe('')
      expect(state.mobileUrl).toBe('')
      expect(state.qrPngBase64).toBe('')
      expect(state.connectedDevices).toEqual([])
      expect(state.tunnelActive).toBe(false)
      expect(state.tunnelUrl).toBe('')
    })

    it('calls backendCall with stop_remote_server', async () => {
      mockBackendCall.mockResolvedValueOnce(undefined)
      await useRemoteStore.getState().stopServer()
      expect(mockBackendCall).toHaveBeenCalledWith('stop_remote_server')
    })

    it('sets error on failure', async () => {
      mockBackendCall.mockRejectedValueOnce(new Error('Stop failed'))
      await useRemoteStore.getState().stopServer()
      expect(useRemoteStore.getState().error).toContain('Stop failed')
    })
  })

  // ── regenerateToken ────────────────────────────────────────

  describe('regenerateToken', () => {
    it('updates passcode and sets passcodeExpiresAt to now + 300', async () => {
      mockBackendCall
        .mockResolvedValueOnce('NEWCODE')
        .mockResolvedValueOnce({ qr_png_base64: '', url: '', passcode: '' })

      const before = Math.floor(Date.now() / 1000)
      await useRemoteStore.getState().regenerateToken()

      const state = useRemoteStore.getState()
      expect(state.passcode).toBe('NEWCODE')
      expect(state.passcodeExpiresAt).toBeGreaterThanOrEqual(before + 300)
      expect(state.passcodeExpiresAt).toBeLessThanOrEqual(before + 301)
    })

    it('leaves connected devices intact on regen (Bug #7: decoupled from JWT rotation)', async () => {
      useRemoteStore.setState({
        connectedDevices: [{ id: 'd1', ip: '1.1.1.1', user_agent: 'test', last_seen: 1 }],
      })
      mockBackendCall
        .mockResolvedValueOnce('NEW')
        // fetchQrCode
        .mockResolvedValueOnce({ qr_png_base64: '', url: '', passcode: '' })
        // refreshDevices — returns same device because JWT still valid
        .mockResolvedValueOnce([{ id: 'd1', ip: '1.1.1.1', user_agent: 'test', last_seen: 2 }])

      await useRemoteStore.getState().regenerateToken()
      expect(useRemoteStore.getState().connectedDevices.length).toBeGreaterThan(0)
    })

    it('calls fetchQrCode after regenerating', async () => {
      mockBackendCall
        .mockResolvedValueOnce('NEW')
        .mockResolvedValueOnce({ qr_png_base64: 'updated', url: '', passcode: '' })

      await useRemoteStore.getState().regenerateToken()
      await vi.waitFor(() => {
        expect(mockBackendCall).toHaveBeenCalledWith('remote_qr_code')
      })
    })

    it('sets error on failure', async () => {
      mockBackendCall.mockRejectedValueOnce(new Error('Token error'))
      await useRemoteStore.getState().regenerateToken()
      expect(useRemoteStore.getState().error).toContain('Token error')
    })
  })

  // ── startTunnel ────────────────────────────────────────────

  describe('startTunnel', () => {
    it('sets tunnelActive and tunnelUrl on success', async () => {
      mockBackendCall
        .mockResolvedValueOnce('https://my-tunnel.example.com')
        .mockResolvedValueOnce({ qr_png_base64: '', url: '', passcode: '' })

      await useRemoteStore.getState().startTunnel()
      const state = useRemoteStore.getState()
      expect(state.tunnelActive).toBe(true)
      expect(state.tunnelUrl).toBe('https://my-tunnel.example.com')
      expect(state.tunnelLoading).toBe(false)
    })

    it('sets tunnelLoading while in progress', async () => {
      let resolve: (v: string) => void
      const promise = new Promise<string>(r => { resolve = r })
      mockBackendCall.mockReturnValueOnce(promise)

      const startPromise = useRemoteStore.getState().startTunnel()
      expect(useRemoteStore.getState().tunnelLoading).toBe(true)

      resolve!('https://tunnel')
      mockBackendCall.mockResolvedValueOnce({ qr_png_base64: '', url: '', passcode: '' })
      await startPromise
      expect(useRemoteStore.getState().tunnelLoading).toBe(false)
    })

    it('refreshes QR code after starting tunnel', async () => {
      mockBackendCall
        .mockResolvedValueOnce('https://tunnel')
        .mockResolvedValueOnce({ qr_png_base64: 'tunnelqr', url: '', passcode: '' })

      await useRemoteStore.getState().startTunnel()
      await vi.waitFor(() => {
        expect(mockBackendCall).toHaveBeenCalledWith('remote_qr_code')
      })
    })

    it('sets error on failure and clears tunnelLoading', async () => {
      mockBackendCall.mockRejectedValueOnce(new Error('Tunnel failed'))
      await useRemoteStore.getState().startTunnel()
      expect(useRemoteStore.getState().tunnelLoading).toBe(false)
      expect(useRemoteStore.getState().error).toContain('Tunnel failed')
      expect(useRemoteStore.getState().tunnelActive).toBe(false)
    })
  })

  // ── stopTunnel ─────────────────────────────────────────────

  describe('stopTunnel', () => {
    it('clears tunnel state on success', async () => {
      useRemoteStore.setState({ tunnelActive: true, tunnelUrl: 'https://tunnel' })
      mockBackendCall
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ qr_png_base64: '', url: '', passcode: '' })

      await useRemoteStore.getState().stopTunnel()
      expect(useRemoteStore.getState().tunnelActive).toBe(false)
      expect(useRemoteStore.getState().tunnelUrl).toBe('')
    })

    it('refreshes QR code to show LAN IP again', async () => {
      mockBackendCall
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ qr_png_base64: 'lanqr', url: '', passcode: '' })

      await useRemoteStore.getState().stopTunnel()
      await vi.waitFor(() => {
        expect(mockBackendCall).toHaveBeenCalledWith('remote_qr_code')
      })
    })

    it('sets error on failure', async () => {
      mockBackendCall.mockRejectedValueOnce(new Error('Stop tunnel error'))
      await useRemoteStore.getState().stopTunnel()
      expect(useRemoteStore.getState().error).toContain('Stop tunnel error')
    })
  })

  // ── refreshStatus ──────────────────────────────────────────

  describe('refreshStatus', () => {
    it('updates state from backend status', async () => {
      mockBackendCall.mockResolvedValueOnce({
        running: true,
        port: 11435,
        passcode: 'FRESH',
        passcodeExpiresAt: 5000,
        lanUrl: 'http://fresh',
        mobileUrl: 'http://fresh/m',
        tunnelActive: true,
        tunnelUrl: 'https://tunnel-fresh',
      })
      await useRemoteStore.getState().refreshStatus()
      const state = useRemoteStore.getState()
      expect(state.enabled).toBe(true)
      expect(state.passcode).toBe('FRESH')
      expect(state.tunnelActive).toBe(true)
      expect(state.tunnelUrl).toBe('https://tunnel-fresh')
    })

    it('silently ignores errors (non-critical)', async () => {
      mockBackendCall.mockRejectedValueOnce(new Error('Network'))
      await useRemoteStore.getState().refreshStatus()
      // Should not throw and should not set error
      expect(useRemoteStore.getState().error).toBeNull()
    })
  })

  // ── refreshDevices ─────────────────────────────────────────

  describe('refreshDevices', () => {
    it('updates connectedDevices', async () => {
      mockBackendCall.mockResolvedValueOnce([
        { id: 'd1', ip: '10.0.0.1', user_agent: 'Mozilla', last_seen: 123 },
      ])
      await useRemoteStore.getState().refreshDevices()
      expect(useRemoteStore.getState().connectedDevices).toHaveLength(1)
    })

    it('silently ignores errors', async () => {
      mockBackendCall.mockRejectedValueOnce(new Error('fail'))
      await useRemoteStore.getState().refreshDevices()
      expect(useRemoteStore.getState().connectedDevices).toEqual([])
    })
  })

  // ── fetchQrCode ────────────────────────────────────────────

  describe('fetchQrCode', () => {
    it('updates qrPngBase64', async () => {
      mockBackendCall.mockResolvedValueOnce({ qr_png_base64: 'PNGDATA', url: '', passcode: '' })
      await useRemoteStore.getState().fetchQrCode()
      expect(useRemoteStore.getState().qrPngBase64).toBe('PNGDATA')
    })

    it('silently ignores errors', async () => {
      mockBackendCall.mockRejectedValueOnce(new Error('QR fail'))
      await useRemoteStore.getState().fetchQrCode()
      expect(useRemoteStore.getState().qrPngBase64).toBe('')
    })
  })

  // ── setPermissions ─────────────────────────────────────────

  describe('setPermissions', () => {
    it('updates permissions on success', async () => {
      mockBackendCall.mockResolvedValueOnce(undefined)
      await useRemoteStore.getState().setPermissions({
        filesystem: true,
        downloads: true,
        process_control: false,
      })
      // RA-1: the store now normalises to a fully-explicit payload — `shell`
      // is optional on the TS type, and an undefined scope must never reach
      // the backend as "whatever serde defaults to".
      expect(useRemoteStore.getState().permissions).toEqual({
        filesystem: true,
        downloads: true,
        process_control: false,
        shell: false,
      })
    })

    it('calls backend with correct args, every scope explicit', async () => {
      const perms = { filesystem: true, downloads: false, process_control: false }
      mockBackendCall.mockResolvedValueOnce(undefined)
      await useRemoteStore.getState().setPermissions(perms)
      expect(mockBackendCall).toHaveBeenCalledWith('set_remote_permissions', {
        permissions: { ...perms, shell: false },
      })
    })

    it('sets error on failure', async () => {
      mockBackendCall.mockRejectedValueOnce(new Error('Perm error'))
      await useRemoteStore.getState().setPermissions({
        filesystem: true,
        downloads: true,
        process_control: true,
      })
      expect(useRemoteStore.getState().error).toContain('Perm error')
    })

    it('leaves the shown permissions untouched when the push fails', async () => {
      // RA-1: a failed toggle must not repaint the panel as if it applied —
      // the panel has to keep showing the server's last known truth.
      useRemoteStore.setState({
        permissions: { filesystem: false, downloads: false, process_control: false, shell: false },
      })
      mockBackendCall.mockRejectedValueOnce(new Error('Perm error'))
      await useRemoteStore.getState().setPermissions({
        filesystem: true,
        downloads: true,
        process_control: true,
        shell: true,
      })
      expect(useRemoteStore.getState().permissions).toEqual({
        filesystem: false,
        downloads: false,
        process_control: false,
        shell: false,
      })
    })
  })

  // ── RA-1: permission read-back ─────────────────────────────
  //
  // The panel used to render a purely local guess: the store hardcoded every
  // scope to false, refreshStatus never mapped the server's copy, and the Rust
  // `impl Default for RemotePermissions` started filesystem/downloads/
  // process_control at TRUE. A user who granted nothing still handed a paired
  // phone workspace read/write, model pull/delete and ComfyUI start/stop.
  // Every path that learns the server's mind must now map it into the store.

  describe('permission read-back (RA-1)', () => {
    const statusBase = {
      running: true,
      port: 11435,
      passcode: 'P',
      passcodeExpiresAt: 1,
      lanUrl: 'http://lan',
      mobileUrl: 'http://lan/m',
      tunnelActive: false,
      tunnelUrl: '',
    }

    it('maps the permissions reported by remote_server_status', async () => {
      mockBackendCall.mockResolvedValueOnce({
        ...statusBase,
        permissions: { filesystem: true, downloads: false, process_control: true, shell: false },
      })
      await useRemoteStore.getState().refreshStatus()
      expect(useRemoteStore.getState().permissions).toEqual({
        filesystem: true,
        downloads: false,
        process_control: true,
        shell: false,
      })
    })

    it('surfaces a scope a paired phone raised through the mobile panel', async () => {
      // The mobile permissions panel POSTs /remote-api/permissions, which the
      // desktop never sees on its own. Status polling is the path that catches
      // it, so the desktop toggle stops lying about what the phone can do.
      useRemoteStore.setState({
        permissions: { filesystem: false, downloads: false, process_control: false, shell: false },
      })
      mockBackendCall.mockResolvedValueOnce({
        ...statusBase,
        permissions: { filesystem: true, downloads: false, process_control: false, shell: false },
      })
      await useRemoteStore.getState().refreshStatus()
      expect(useRemoteStore.getState().permissions.filesystem).toBe(true)
    })

    it('treats a missing scope as denied, never as granted', async () => {
      useRemoteStore.setState({
        permissions: { filesystem: true, downloads: true, process_control: true, shell: true },
      })
      mockBackendCall.mockResolvedValueOnce({
        ...statusBase,
        permissions: { filesystem: true }, // older/partial payload
      })
      await useRemoteStore.getState().refreshStatus()
      expect(useRemoteStore.getState().permissions).toEqual({
        filesystem: true,
        downloads: false,
        process_control: false,
        shell: false,
      })
    })

    it('keeps the current value when the backend reports no permissions', async () => {
      // A backend predating the read-back tells us nothing. Coercing to
      // all-false there would just move the lie to the other side.
      useRemoteStore.setState({
        permissions: { filesystem: true, downloads: false, process_control: false, shell: false },
      })
      mockBackendCall.mockResolvedValueOnce({ ...statusBase })
      await useRemoteStore.getState().refreshStatus()
      expect(useRemoteStore.getState().permissions).toEqual({
        filesystem: true,
        downloads: false,
        process_control: false,
        shell: false,
      })
    })

    it('adopts the server permissions in the same update that enables the server', async () => {
      // No window may exist in which `enabled` is already true while the panel
      // still shows the pre-start guess.
      useRemoteStore.setState({
        permissions: { filesystem: false, downloads: false, process_control: false, shell: false },
      })
      const seen: Array<{ enabled: boolean; filesystem: boolean }> = []
      const unsub = useRemoteStore.subscribe((st) =>
        seen.push({ enabled: st.enabled, filesystem: st.permissions.filesystem }),
      )
      mockBackendCall
        .mockResolvedValueOnce({
          port: 11435,
          passcode: 'ABC',
          passcodeExpiresAt: 9999,
          lanUrl: 'http://lan',
          mobileUrl: 'http://lan/m',
          permissions: { filesystem: true, downloads: true, process_control: false, shell: false },
        })
        .mockResolvedValueOnce({ qr_png_base64: '', url: '', passcode: '' })

      await useRemoteStore.getState().startServer()
      unsub()

      expect(useRemoteStore.getState().permissions).toEqual({
        filesystem: true,
        downloads: true,
        process_control: false,
        shell: false,
      })
      // Not one emitted state had the server running under permissions the
      // panel wasn't showing.
      expect(seen.filter((s) => s.enabled && !s.filesystem)).toEqual([])
    })

    it('maps the permissions returned by a restart', async () => {
      useRemoteStore.setState({
        permissions: { filesystem: true, downloads: true, process_control: true, shell: true },
      })
      mockBackendCall
        .mockResolvedValueOnce({
          port: 11435,
          passcode: 'ABC',
          passcodeExpiresAt: 9999,
          lanUrl: 'http://lan',
          mobileUrl: 'http://lan/m',
          permissions: { filesystem: false, downloads: false, process_control: false, shell: false },
        })
        .mockResolvedValueOnce({ qr_png_base64: '', url: '', passcode: '' })

      await useRemoteStore.getState().restart()
      expect(useRemoteStore.getState().permissions).toEqual({
        filesystem: false,
        downloads: false,
        process_control: false,
        shell: false,
      })
    })

    it('starts with every scope off, matching the Rust default', async () => {
      // The store's initial value and `impl Default for RemotePermissions` have
      // to agree, or the very first render is already a lie.
      expect(useRemoteStore.getInitialState().permissions).toEqual({
        filesystem: false,
        downloads: false,
        process_control: false,
        shell: false,
      })
    })
  })
})

describe('normalizeRemotePermissions (RA-1)', () => {
  it('coerces every scope to an explicit boolean', () => {
    expect(normalizeRemotePermissions({ filesystem: true, downloads: false, process_control: true, shell: true }))
      .toEqual({ filesystem: true, downloads: false, process_control: true, shell: true })
  })

  it('reads anything that is not exactly `true` as denied', () => {
    expect(normalizeRemotePermissions({ filesystem: 'true', downloads: 1, process_control: null }))
      .toEqual({ filesystem: false, downloads: false, process_control: false, shell: false })
  })

  it('returns null for a payload that carries no permissions object', () => {
    expect(normalizeRemotePermissions(undefined)).toBeNull()
    expect(normalizeRemotePermissions(null)).toBeNull()
    expect(normalizeRemotePermissions('filesystem')).toBeNull()
    expect(normalizeRemotePermissions([])).toBeNull()
  })
})
