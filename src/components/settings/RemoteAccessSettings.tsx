import { useEffect, useState } from 'react'
import { useRemoteStore } from '../../stores/remoteStore'
import { backendCall } from '../../api/backend'
import { isMlxImageHost } from '../../api/mlx-image'
import { Shield, Smartphone, Trash2 } from 'lucide-react'

export function RemoteAccessSettings() {
  const {
    enabled, connectedDevices, permissions,
    refreshStatus, refreshDevices, setPermissions,
  } = useRemoteStore()
  const [disconnecting, setDisconnecting] = useState<string | null>(null)

  useEffect(() => {
    refreshStatus()
    refreshDevices()
    const interval = setInterval(() => {
      if (enabled) refreshDevices()
    }, 10000)
    return () => clearInterval(interval)
    // `refreshStatus`/`refreshDevices` sind Store-Actions aus dem create()-
    // Initializer: ihre Referenz entsteht einmal und aendert sich nie. Der
    // Effekt laeuft dadurch weiterhin nur bei einem Wechsel von `enabled`.
  }, [enabled, refreshDevices, refreshStatus])

  // Bug #10: the trash icon called an empty handler. Wire it up to the
  // existing /remote-api/disconnect command and refetch afterwards so the
  // row actually disappears.
  const handleDisconnect = async (deviceId: string) => {
    setDisconnecting(deviceId)
    try {
      await backendCall('disconnect_remote_device', { deviceId })
    } catch {
      // Fallback: some builds only expose the HTTP endpoint
      try {
        await fetch(`http://127.0.0.1:11435/remote-api/disconnect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: deviceId }),
        })
      } catch { /* non-fatal */ }
    } finally {
      setDisconnecting(null)
      await refreshDevices()
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[0.55rem] text-gray-600">
        Remote access is now controlled from the <span className="text-gray-400 font-medium">Remote</span> tab in the sidebar. Use <span className="text-gray-400 font-medium">Dispatch</span> to start a remote chat session.
      </p>

      {/* Permissions */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Shield size={12} className="text-gray-500" />
          <span className="text-[0.65rem] font-medium text-gray-400">Permissions</span>
        </div>
        {([
          { key: 'filesystem' as const, label: 'Filesystem Access', desc: 'Agent file read/write (sandboxed to the chat workspace)' },
          // The two engine-named scopes read differently per platform: macOS
          // has no ComfyUI to install or start, so naming it here would grant
          // the phone a power this machine does not have.
          { key: 'downloads' as const, label: 'Downloads & Installs', desc: isMlxImageHost() ? 'Model downloads, engine install' : 'Model downloads, ComfyUI/Ollama install' },
          { key: 'process_control' as const, label: 'Process Control', desc: isMlxImageHost() ? 'Start/stop the local engines' : 'Start/stop ComfyUI, Ollama' },
          { key: 'shell' as const, label: 'Shell & Code Execution', desc: 'Run shell commands + code from your phone. Risky, leave OFF unless you trust the network.' },
        ]).map(({ key, label, desc }) => (
          <div key={key} className="flex items-center justify-between">
            <div>
              <p className="text-[0.65rem] text-gray-700 dark:text-gray-300">{label}</p>
              <p className="text-[0.5rem] text-gray-500 dark:text-gray-600">{desc}</p>
            </div>
            <button
              onClick={() => setPermissions({ ...permissions, [key]: !permissions[key] })}
              className={`w-8 h-4 rounded-full transition-all relative ${
                permissions[key] ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
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
        <div className="space-y-2 pt-2 border-t border-gray-200 dark:border-white/[0.06]">
          <div className="flex items-center gap-1.5">
            <Smartphone size={12} className="text-gray-500" />
            <span className="text-[0.65rem] font-medium text-gray-400">
              Connected Devices ({connectedDevices.length})
            </span>
          </div>
          {connectedDevices.map((dev) => (
            <div key={dev.id} className="flex items-center justify-between py-1">
              <div>
                <p className="text-[0.6rem] text-gray-700 dark:text-gray-300">{dev.ip}</p>
                <p className="text-[0.5rem] text-gray-500 dark:text-gray-600 truncate max-w-[200px]">{dev.user_agent}</p>
              </div>
              <button
                onClick={() => handleDisconnect(dev.id)}
                disabled={disconnecting === dev.id}
                className="p-1 hover:bg-red-500/15 rounded text-gray-500 dark:text-gray-600 hover:text-red-400 disabled:opacity-40"
                title="Disconnect"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
