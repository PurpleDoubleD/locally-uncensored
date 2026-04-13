import { useEffect, useState } from 'react'
import { useRemoteStore } from '../../stores/remoteStore'
import { Wifi, WifiOff, RefreshCw, Copy, Smartphone, Shield, Trash2, Globe } from 'lucide-react'

export function RemoteAccessSettings() {
  const {
    enabled, passcode, passcodeExpiresAt, lanUrl, mobileUrl, qrPngBase64,
    connectedDevices, permissions, loading, error,
    tunnelActive, tunnelUrl, tunnelLoading,
    startServer, stopServer, refreshStatus, refreshDevices,
    regenerateToken, setPermissions, startTunnel, stopTunnel,
  } = useRemoteStore()

  const [countdown, setCountdown] = useState('')

  useEffect(() => {
    refreshStatus()
    const interval = setInterval(() => {
      if (enabled) refreshDevices()
    }, 10000)
    return () => clearInterval(interval)
  }, [enabled])

  // Passcode countdown timer
  useEffect(() => {
    if (!passcodeExpiresAt || !enabled) {
      setCountdown('')
      return
    }
    let regenerating = false
    const tick = () => {
      const remaining = passcodeExpiresAt - Math.floor(Date.now() / 1000)
      if (remaining <= 0) {
        setCountdown('Expired')
        if (!regenerating) {
          regenerating = true
          regenerateToken()
        }
      } else {
        const min = Math.floor(remaining / 60)
        const sec = remaining % 60
        setCountdown(`${min}:${sec.toString().padStart(2, '0')}`)
      }
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [passcodeExpiresAt, enabled])

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  return (
    <div className="space-y-4">
      {/* Server Toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {enabled ? (
            <Wifi size={14} className="text-green-400" />
          ) : (
            <WifiOff size={14} className="text-gray-500" />
          )}
          <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">
            Remote Access
          </span>
          <span className={`text-[0.55rem] px-1.5 py-0.5 rounded-full font-medium ${
            enabled
              ? 'bg-green-500/15 text-green-400 border border-green-500/30'
              : 'bg-gray-500/15 text-gray-500 border border-gray-500/30'
          }`}>
            {enabled ? 'Running' : 'Stopped'}
          </span>
        </div>
        <button
          onClick={enabled ? stopServer : startServer}
          disabled={loading}
          className={`px-3 py-1 rounded-md text-[0.65rem] font-medium transition-all ${
            enabled
              ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/30'
              : 'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border border-blue-500/30'
          } disabled:opacity-50`}
        >
          {loading ? '...' : enabled ? 'Stop' : 'Start'}
        </button>
      </div>

      {error && (
        <p className="text-[0.6rem] text-red-400">{error}</p>
      )}

      {enabled && (
        <>
          {/* QR Code + Connection Info */}
          <div className="flex gap-4 items-start">
            {qrPngBase64 && (
              <div className="shrink-0 bg-white rounded-lg p-2">
                <img
                  src={`data:image/png;base64,${qrPngBase64}`}
                  alt="QR Code"
                  className="w-[100px] h-[100px]"
                />
              </div>
            )}
            <div className="space-y-2 flex-1 min-w-0">
              <div>
                <p className="text-[0.55rem] text-gray-500 mb-0.5">LAN URL</p>
                <div className="flex items-center gap-1.5">
                  <code className="text-[0.6rem] text-blue-400 truncate">{lanUrl}</code>
                  <button onClick={() => copyToClipboard(lanUrl)} className="p-0.5 hover:bg-white/10 rounded" title="Copy">
                    <Copy size={10} className="text-gray-500" />
                  </button>
                </div>
              </div>
              <div>
                <p className="text-[0.55rem] text-gray-500 mb-0.5">Mobile URL</p>
                <div className="flex items-center gap-1.5">
                  <code className="text-[0.6rem] text-blue-400 truncate">{mobileUrl}</code>
                  <button onClick={() => copyToClipboard(mobileUrl)} className="p-0.5 hover:bg-white/10 rounded" title="Copy">
                    <Copy size={10} className="text-gray-500" />
                  </button>
                </div>
              </div>
              <div>
                <p className="text-[0.55rem] text-gray-500 mb-0.5">Pairing Code</p>
                <div className="flex items-center gap-1.5">
                  <code className="text-[1rem] text-amber-400 font-mono tracking-[4px] font-bold">{passcode}</code>
                  <button onClick={() => copyToClipboard(passcode)} className="p-0.5 hover:bg-white/10 rounded" title="Copy">
                    <Copy size={10} className="text-gray-500" />
                  </button>
                  <button onClick={regenerateToken} className="p-0.5 hover:bg-white/10 rounded" title="Regenerate">
                    <RefreshCw size={10} className="text-gray-500" />
                  </button>
                  {countdown && (
                    <span className={`text-[0.5rem] font-mono ${
                      countdown === 'Expired' ? 'text-red-400' : 'text-gray-600'
                    }`}>
                      {countdown}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <p className="text-[0.55rem] text-gray-600">
            Scan the QR code with your phone or open the Mobile URL. Enter the 6-digit code to connect.
          </p>

          {/* Cloudflare Tunnel */}
          <div className="flex items-center justify-between pt-2 border-t border-white/[0.06]">
            <div className="flex items-center gap-2">
              <Globe size={14} className={tunnelActive ? 'text-green-400' : 'text-gray-500'} />
              <div>
                <p className="text-[0.65rem] text-gray-300">Internet Access</p>
                <p className="text-[0.5rem] text-gray-600">
                  {tunnelActive ? 'Accessible from anywhere via Cloudflare' : 'Enable to access from outside your network'}
                </p>
              </div>
            </div>
            <button
              onClick={tunnelActive ? stopTunnel : startTunnel}
              disabled={tunnelLoading}
              className={`px-3 py-1 rounded-md text-[0.6rem] font-medium transition-all ${
                tunnelActive
                  ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/30'
                  : 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/30'
              } disabled:opacity-50`}
            >
              {tunnelLoading ? '...' : tunnelActive ? 'Stop' : 'Enable'}
            </button>
          </div>
          {tunnelActive && tunnelUrl && (
            <div>
              <p className="text-[0.55rem] text-gray-500 mb-0.5">Public URL</p>
              <div className="flex items-center gap-1.5">
                <code className="text-[0.6rem] text-emerald-400 truncate">{tunnelUrl}</code>
                <button onClick={() => copyToClipboard(tunnelUrl)} className="p-0.5 hover:bg-white/10 rounded" title="Copy">
                  <Copy size={10} className="text-gray-500" />
                </button>
              </div>
            </div>
          )}

          {/* Permissions */}
          <div className="space-y-2 pt-2 border-t border-white/[0.06]">
            <div className="flex items-center gap-1.5 mb-2">
              <Shield size={12} className="text-gray-500" />
              <span className="text-[0.65rem] font-medium text-gray-400">Remote Permissions</span>
            </div>
            {([
              { key: 'filesystem' as const, label: 'Filesystem Access', desc: 'Agent file read/write, shell execute' },
              { key: 'downloads' as const, label: 'Downloads & Installs', desc: 'Model downloads, ComfyUI/Ollama install' },
              { key: 'process_control' as const, label: 'Process Control', desc: 'Start/stop ComfyUI, Ollama' },
            ]).map(({ key, label, desc }) => (
              <div key={key} className="flex items-center justify-between">
                <div>
                  <p className="text-[0.65rem] text-gray-300">{label}</p>
                  <p className="text-[0.5rem] text-gray-600">{desc}</p>
                </div>
                <button
                  onClick={() => setPermissions({ ...permissions, [key]: !permissions[key] })}
                  className={`w-8 h-4 rounded-full transition-all relative ${
                    permissions[key] ? 'bg-blue-500' : 'bg-gray-600'
                  }`}
                >
                  <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${
                    permissions[key] ? 'left-4' : 'left-0.5'
                  }`} />
                </button>
              </div>
            ))}
          </div>

          {/* Connected Devices */}
          {connectedDevices.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-white/[0.06]">
              <div className="flex items-center gap-1.5 mb-2">
                <Smartphone size={12} className="text-gray-500" />
                <span className="text-[0.65rem] font-medium text-gray-400">
                  Connected Devices ({connectedDevices.length})
                </span>
              </div>
              {connectedDevices.map((dev) => (
                <div key={dev.id} className="flex items-center justify-between py-1">
                  <div>
                    <p className="text-[0.6rem] text-gray-300">{dev.ip}</p>
                    <p className="text-[0.5rem] text-gray-600 truncate max-w-[200px]">{dev.user_agent}</p>
                  </div>
                  <button
                    onClick={() => {
                      // TODO: disconnect device via backend
                    }}
                    className="p-1 hover:bg-red-500/15 rounded text-gray-600 hover:text-red-400"
                    title="Disconnect"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
