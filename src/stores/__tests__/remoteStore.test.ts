import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockBackendCall = vi.fn()
vi.mock('../../api/backend', () => ({
  backendCall: (...args: unknown[]) => mockBackendCall(...args),
}))

import { useRemoteStore } from '../remoteStore'

describe('remoteStore', () => {
  beforeEach(() => {
    mockBackendCall.mockReset()
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
      expect(mockBackendCall).toHaveBeenCalledWith('start_remote_server', {})
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
      expect(useRemoteStore.getState().permissions).toEqual({
        filesystem: true,
        downloads: true,
        process_control: false,
      })
    })

    it('calls backend with correct args', async () => {
      const perms = { filesystem: true, downloads: false, process_control: false }
      mockBackendCall.mockResolvedValueOnce(undefined)
      await useRemoteStore.getState().setPermissions(perms)
      expect(mockBackendCall).toHaveBeenCalledWith('set_remote_permissions', { permissions: perms })
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
  })
})
