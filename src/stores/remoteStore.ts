import { create } from 'zustand'
import { backendCall } from '../api/backend'

interface ConnectedDevice {
  id: string
  ip: string
  user_agent: string
  last_seen: number
}

interface RemotePermissions {
  filesystem: boolean
  downloads: boolean
  process_control: boolean
}

interface RemoteState {
  enabled: boolean
  port: number
  passcode: string
  passcodeExpiresAt: number
  lanUrl: string
  mobileUrl: string
  qrPngBase64: string
  connectedDevices: ConnectedDevice[]
  permissions: RemotePermissions
  tunnelActive: boolean
  tunnelUrl: string
  tunnelLoading: boolean
  loading: boolean
  error: string | null

  startServer: () => Promise<void>
  stopServer: () => Promise<void>
  refreshStatus: () => Promise<void>
  refreshDevices: () => Promise<void>
  regenerateToken: () => Promise<void>
  fetchQrCode: () => Promise<void>
  setPermissions: (perms: RemotePermissions) => Promise<void>
  startTunnel: () => Promise<void>
  stopTunnel: () => Promise<void>
}

export const useRemoteStore = create<RemoteState>()((set, get) => ({
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

  startServer: async () => {
    set({ loading: true, error: null })
    try {
      const result = await backendCall<{
        port: number
        passcode: string
        passcodeExpiresAt: number
        lanUrl: string
        mobileUrl: string
      }>('start_remote_server')
      set({
        enabled: true,
        port: result.port,
        passcode: result.passcode,
        passcodeExpiresAt: result.passcodeExpiresAt,
        lanUrl: result.lanUrl,
        mobileUrl: result.mobileUrl,
        loading: false,
      })
      // Auto-fetch QR code
      get().fetchQrCode()
    } catch (err) {
      set({ loading: false, error: String(err) })
    }
  },

  stopServer: async () => {
    try {
      await backendCall('stop_remote_server')
      set({
        enabled: false,
        passcode: '',
        passcodeExpiresAt: 0,
        lanUrl: '',
        mobileUrl: '',
        qrPngBase64: '',
        connectedDevices: [],
        tunnelActive: false,
        tunnelUrl: '',
      })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  refreshStatus: async () => {
    try {
      const status = await backendCall<{
        running: boolean
        port: number
        passcode: string
        passcodeExpiresAt: number
        lanUrl: string
        mobileUrl: string
        tunnelActive: boolean
        tunnelUrl: string
      }>('remote_server_status')
      set({
        enabled: status.running,
        port: status.port,
        passcode: status.passcode,
        passcodeExpiresAt: status.passcodeExpiresAt,
        lanUrl: status.lanUrl,
        mobileUrl: status.mobileUrl,
        tunnelActive: status.tunnelActive,
        tunnelUrl: status.tunnelUrl,
      })
    } catch {
      // Non-critical
    }
  },

  refreshDevices: async () => {
    try {
      const devices = await backendCall<ConnectedDevice[]>('remote_connected_devices')
      set({ connectedDevices: devices })
    } catch {
      // Non-critical
    }
  },

  regenerateToken: async () => {
    try {
      const newPasscode = await backendCall<string>('regenerate_remote_token')
      set({
        passcode: newPasscode,
        passcodeExpiresAt: Math.floor(Date.now() / 1000) + 300,
        connectedDevices: [],
      })
      get().fetchQrCode()
    } catch (err) {
      set({ error: String(err) })
    }
  },

  fetchQrCode: async () => {
    try {
      const qr = await backendCall<{ qr_png_base64: string; url: string; passcode: string }>('remote_qr_code')
      set({ qrPngBase64: qr.qr_png_base64 })
    } catch {
      // Non-critical
    }
  },

  setPermissions: async (perms: RemotePermissions) => {
    try {
      await backendCall('set_remote_permissions', { permissions: perms })
      set({ permissions: perms })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  startTunnel: async () => {
    set({ tunnelLoading: true, error: null })
    try {
      const url = await backendCall<string>('start_tunnel')
      set({ tunnelActive: true, tunnelUrl: url, tunnelLoading: false })
      // Refresh QR to show tunnel URL instead of LAN IP
      get().fetchQrCode()
    } catch (err) {
      set({ tunnelLoading: false, error: String(err) })
    }
  },

  stopTunnel: async () => {
    try {
      await backendCall('stop_tunnel')
      set({ tunnelActive: false, tunnelUrl: '' })
      // Refresh QR to show LAN IP again
      get().fetchQrCode()
    } catch (err) {
      set({ error: String(err) })
    }
  },
}))
