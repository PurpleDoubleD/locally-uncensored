import { useState } from 'react'
import { Wifi, WifiOff, Loader2, Eye, EyeOff, ChevronDown } from 'lucide-react'
import { useProviderStore } from '../../stores/providerStore'
import { getProvider } from '../../api/providers'
import { PROVIDER_PRESETS } from '../../api/providers/types'
import { Modal } from '../ui/Modal'
import type { ProviderId } from '../../api/providers/types'

export function ProviderSettings() {
  const { providers, setProviderConfig, setProviderApiKey, getProviderApiKey } = useProviderStore()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState<'idle' | 'connected' | 'failed'>('idle')
  const [showKey, setShowKey] = useState(false)
  const [showCloudWarning, setShowCloudWarning] = useState(false)
  const [pendingPreset, setPendingPreset] = useState<typeof PROVIDER_PRESETS[0] | null>(null)

  // Determine what's currently active
  const activePreset = getActivePreset()

  function getActivePreset() {
    // Check Ollama
    if (providers.ollama.enabled) {
      return PROVIDER_PRESETS.find(p => p.id === 'ollama')!
    }
    // Check Anthropic
    if (providers.anthropic.enabled) {
      return PROVIDER_PRESETS.find(p => p.id === 'anthropic')!
    }
    // Check OpenAI-compat
    if (providers.openai.enabled) {
      const name = providers.openai.name
      return PROVIDER_PRESETS.find(p => p.name === name && p.providerId === 'openai') ||
        PROVIDER_PRESETS.find(p => p.id === 'custom-openai')!
    }
    // Nothing active
    return null
  }

  // Get the active provider's config
  function getActiveProviderId(): ProviderId | null {
    if (providers.ollama.enabled) return 'ollama'
    if (providers.anthropic.enabled) return 'anthropic'
    if (providers.openai.enabled) return 'openai'
    return null
  }

  const activeProviderId = getActiveProviderId()
  const activeConfig = activeProviderId ? providers[activeProviderId] : null
  const needsKey = activeConfig && !activeConfig.isLocal
  const currentKey = activeProviderId ? getProviderApiKey(activeProviderId) : ''

  // Select a preset
  function selectPreset(preset: typeof PROVIDER_PRESETS[0]) {
    // Cloud → show warning first
    if (!preset.isLocal) {
      setPendingPreset(preset)
      setShowCloudWarning(true)
      return
    }
    applyPreset(preset)
  }

  function applyPreset(preset: typeof PROVIDER_PRESETS[0]) {
    // Disable everything first
    setProviderConfig('ollama', { enabled: false })
    setProviderConfig('openai', { enabled: false })
    setProviderConfig('anthropic', { enabled: false })

    // Enable selected
    if (preset.providerId === 'ollama') {
      setProviderConfig('ollama', { enabled: true, baseUrl: preset.baseUrl })
    } else if (preset.providerId === 'anthropic') {
      setProviderConfig('anthropic', { enabled: true, name: preset.name, baseUrl: preset.baseUrl, isLocal: false })
    } else {
      setProviderConfig('openai', { enabled: true, name: preset.name, baseUrl: preset.baseUrl, isLocal: preset.isLocal })
    }

    setDropdownOpen(false)
    setStatus('idle')
  }

  const handleTest = async () => {
    if (!activeProviderId) return
    setTesting(true)
    setStatus('idle')
    try {
      const client = getProvider(activeProviderId)
      const ok = await client.checkConnection()
      setStatus(ok ? 'connected' : 'failed')
    } catch {
      setStatus('failed')
    }
    setTesting(false)
  }

  // Group presets for dropdown
  const localPresets = PROVIDER_PRESETS.filter(p => p.isLocal)
  const cloudPresets = PROVIDER_PRESETS.filter(p => !p.isLocal)

  const noBackend = !activeProviderId

  return (
    <div className="space-y-2">
      {/* Backend Dropdown */}
      <div className="relative">
        <button
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className="w-full flex items-center justify-between px-2 py-1 rounded bg-white/5 border border-white/8 text-[0.65rem] text-gray-400 hover:text-gray-300 transition-colors"
        >
          <div className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${activePreset ? 'bg-green-500' : 'bg-gray-600'}`} />
            <span className="text-gray-300">{activePreset?.name || 'No backend selected'}</span>
            {activeConfig?.isLocal && <span className="text-[0.5rem] px-1 py-0.5 rounded bg-green-500/10 text-green-400">LOCAL</span>}
            {activeConfig && !activeConfig.isLocal && <span className="text-[0.5rem] px-1 py-0.5 rounded bg-blue-500/10 text-blue-400">CLOUD</span>}
          </div>
          <ChevronDown size={10} className={`transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
        </button>
        {dropdownOpen && (
          <div className="absolute z-50 top-full mt-1 w-full bg-[#2a2a2a] border border-white/10 rounded-lg shadow-xl max-h-56 overflow-y-auto scrollbar-thin">
            {/* Local group */}
            <div className="px-2.5 py-1 text-[0.5rem] uppercase tracking-wider text-gray-600 font-semibold">Local</div>
            {localPresets.map(preset => (
              <button
                key={preset.id}
                onClick={() => selectPreset(preset)}
                className={`w-full text-left px-2.5 py-1.5 text-[0.65rem] transition-colors ${
                  activePreset?.id === preset.id ? 'bg-white/10 text-white' : 'text-gray-300 hover:bg-white/5'
                }`}
              >
                <span className="font-medium">{preset.name}</span>
                {preset.baseUrl && <span className="block text-[0.55rem] text-gray-500 font-mono">{preset.baseUrl}</span>}
              </button>
            ))}

            {/* Cloud group */}
            <div className="px-2.5 py-1 mt-1 border-t border-white/[0.06] text-[0.5rem] uppercase tracking-wider text-gray-600 font-semibold">Cloud</div>
            {cloudPresets.map(preset => (
              <button
                key={preset.id}
                onClick={() => selectPreset(preset)}
                className={`w-full text-left px-2.5 py-1.5 text-[0.65rem] transition-colors ${
                  activePreset?.id === preset.id ? 'bg-white/10 text-white' : 'text-gray-300 hover:bg-white/5'
                }`}
              >
                <span className="font-medium">{preset.name}</span>
                {preset.baseUrl && <span className="block text-[0.55rem] text-gray-500 font-mono">{preset.baseUrl}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* No backend warning */}
      {noBackend && (
        <p className="text-[0.6rem] text-red-400">No backend configured. Select one above to start chatting.</p>
      )}

      {/* Endpoint + Key + Test (only when a backend is selected) */}
      {activeConfig && activeProviderId && (
        <>
          {/* Endpoint */}
          <div>
            <label className="text-[0.6rem] text-gray-500 mb-0.5 block">Endpoint</label>
            <input
              value={activeConfig.baseUrl}
              onChange={(e) => setProviderConfig(activeProviderId, { baseUrl: e.target.value })}
              placeholder="http://localhost:..."
              className="w-full px-2 py-1 rounded bg-white/5 border border-white/8 text-[0.65rem] text-gray-300 font-mono focus:outline-none focus:border-white/20"
            />
          </div>

          {/* API Key (cloud only) */}
          {needsKey && (
            <div>
              <label className="text-[0.6rem] text-gray-500 mb-0.5 block">API Key</label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={currentKey}
                  onChange={(e) => setProviderApiKey(activeProviderId, e.target.value)}
                  placeholder={activePreset?.placeholder || 'sk-...'}
                  className="w-full px-2 py-1 pr-7 rounded bg-white/5 border border-white/8 text-[0.65rem] text-gray-300 font-mono focus:outline-none focus:border-white/20"
                />
                <button
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                >
                  {showKey ? <EyeOff size={10} /> : <Eye size={10} />}
                </button>
              </div>
            </div>
          )}

          {/* Test */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleTest}
              disabled={testing}
              className="px-2 py-0.5 rounded bg-white/5 border border-white/8 text-[0.6rem] text-gray-400 hover:text-gray-200 hover:bg-white/8 transition-colors disabled:opacity-50"
            >
              {testing ? <Loader2 size={10} className="animate-spin" /> : 'Test'}
            </button>
            {status === 'connected' && (
              <span className="flex items-center gap-1 text-[0.6rem] text-green-400">
                <Wifi size={10} /> Connected
              </span>
            )}
            {status === 'failed' && (
              <span className="flex items-center gap-1 text-[0.6rem] text-red-400">
                <WifiOff size={10} /> Failed
              </span>
            )}
          </div>
        </>
      )}

      {/* Cloud privacy warning popup */}
      <Modal open={showCloudWarning} onClose={() => { setShowCloudWarning(false); setPendingPreset(null) }} title="">
        <div className="space-y-4 text-center">
          <h3 className="text-base font-semibold text-white">Enable Cloud Provider</h3>
          <p className="text-[0.75rem] text-gray-400 leading-relaxed">
            Cloud providers send your data to external servers. Your conversations will no longer be fully private or offline.
          </p>
          <p className="text-[0.75rem] text-gray-400 leading-relaxed">
            For maximum privacy, use Ollama or a local backend instead.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={() => { setShowCloudWarning(false); setPendingPreset(null) }}
              className="px-4 py-1.5 rounded-lg text-[0.7rem] text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                if (pendingPreset) applyPreset(pendingPreset)
                setShowCloudWarning(false)
                setPendingPreset(null)
              }}
              className="px-4 py-1.5 rounded-lg text-[0.7rem] font-medium bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 transition-colors"
            >
              Continue
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
