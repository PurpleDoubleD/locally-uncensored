import { useState, useEffect } from 'react'
import { Wifi, WifiOff, Loader2, Eye, EyeOff, ChevronDown, Plus, Power } from 'lucide-react'
import { useProviderStore } from '../../stores/providerStore'
import { useMemoryStore } from '../../stores/memoryStore'
import { getProvider } from '../../api/providers'
import { PROVIDER_PRESETS } from '../../api/providers/types'
import { Modal } from '../ui/Modal'
import type { ProviderId } from '../../api/providers/types'

export function ProviderSettings() {
  const { providers, setProviderConfig, setProviderApiKey, getProviderApiKey } = useProviderStore()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [testing, setTesting] = useState<ProviderId | null>(null)
  const [statuses, setStatuses] = useState<Record<string, 'idle' | 'connected' | 'failed'>>({})
  const [showKey, setShowKey] = useState<Record<string, boolean>>({})
  const [showCloudWarning, setShowCloudWarning] = useState(false)
  const [pendingPreset, setPendingPreset] = useState<typeof PROVIDER_PRESETS[0] | null>(null)
  const [expandedProvider, setExpandedProvider] = useState<ProviderId | null>(null)

  const autoExtractEnabled = useMemoryStore((s) => s.settings.autoExtractEnabled)

  // Auto-check connection status for all enabled providers on mount
  useEffect(() => {
    const checkAll = async () => {
      const ids = (Object.keys(providers) as ProviderId[]).filter(id => providers[id].enabled)
      for (const id of ids) {
        try {
          const client = getProvider(id)
          const ok = await client.checkConnection()
          setStatuses(prev => ({ ...prev, [id]: ok ? 'connected' : 'failed' }))
        } catch {
          setStatuses(prev => ({ ...prev, [id]: 'failed' }))
        }
      }
    }
    checkAll()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Get all enabled providers
  const enabledProviderIds = (Object.keys(providers) as ProviderId[]).filter(id => providers[id].enabled)

  // Find the preset that matches a provider config
  function getPresetForProvider(id: ProviderId) {
    const config = providers[id]
    if (id === 'ollama') return PROVIDER_PRESETS.find(p => p.id === 'ollama')!
    if (id === 'anthropic') return PROVIDER_PRESETS.find(p => p.id === 'anthropic')!
    // For openai-compat, match by name or baseUrl
    return PROVIDER_PRESETS.find(p => p.providerId === 'openai' && (p.name === config.name || p.baseUrl === config.baseUrl)) ||
      PROVIDER_PRESETS.find(p => p.id === 'custom-openai')!
  }

  // Add a preset (enable a provider without disabling others)
  function selectPreset(preset: typeof PROVIDER_PRESETS[0]) {
    if (!preset.isLocal) {
      setPendingPreset(preset)
      setShowCloudWarning(true)
      return
    }
    applyPreset(preset)
  }

  function applyPreset(preset: typeof PROVIDER_PRESETS[0]) {
    // Enable the selected provider WITHOUT disabling others
    if (preset.providerId === 'ollama') {
      setProviderConfig('ollama', { enabled: true, baseUrl: preset.baseUrl })
    } else if (preset.providerId === 'anthropic') {
      setProviderConfig('anthropic', { enabled: true, name: preset.name, baseUrl: preset.baseUrl, isLocal: false })
    } else {
      setProviderConfig('openai', { enabled: true, name: preset.name, baseUrl: preset.baseUrl, isLocal: preset.isLocal })
    }

    setDropdownOpen(false)
    setStatuses(prev => ({ ...prev, [preset.providerId]: 'idle' }))
    setExpandedProvider(preset.providerId)
  }

  // Toggle a provider on/off independently
  function toggleProvider(id: ProviderId) {
    setProviderConfig(id, { enabled: !providers[id].enabled })
    setStatuses(prev => ({ ...prev, [id]: 'idle' }))
  }

  const handleTest = async (providerId: ProviderId) => {
    setTesting(providerId)
    setStatuses(prev => ({ ...prev, [providerId]: 'idle' }))
    try {
      const client = getProvider(providerId)
      const ok = await client.checkConnection()
      setStatuses(prev => ({ ...prev, [providerId]: ok ? 'connected' : 'failed' }))
    } catch {
      setStatuses(prev => ({ ...prev, [providerId]: 'failed' }))
    }
    setTesting(null)
  }

  // Group presets for the "Add provider" dropdown
  const localPresets = PROVIDER_PRESETS.filter(p => p.isLocal)
  const cloudPresets = PROVIDER_PRESETS.filter(p => !p.isLocal)

  const noBackend = enabledProviderIds.length === 0

  return (
    <div className="space-y-2">
      {/* Active Providers List */}
      {enabledProviderIds.map(id => {
        const config = providers[id]
        const preset = getPresetForProvider(id)
        const needsKey = !config.isLocal
        const currentKey = getProviderApiKey(id)
        const status = statuses[id] || 'idle'
        const isExpanded = expandedProvider === id
        const isTesting = testing === id
        const isKeyVisible = showKey[id] || false

        return (
          <div key={id} className="rounded-lg border border-white/8 bg-white/[0.02] overflow-hidden">
            {/* Provider header */}
            <div className="flex items-center gap-2 px-2 py-1.5">
              <button
                onClick={() => toggleProvider(id)}
                className="group flex items-center"
                title={config.enabled ? 'Disable provider' : 'Enable provider'}
              >
                <Power size={10} className="text-green-400 group-hover:text-red-400 transition-colors" />
              </button>
              <button
                onClick={() => setExpandedProvider(isExpanded ? null : id)}
                className="flex-1 flex items-center justify-between min-w-0"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    status === 'connected' ? 'bg-green-500' :
                    status === 'failed' ? 'bg-red-500' :
                    'bg-gray-500'
                  }`} />
                  <span className="text-[0.65rem] text-gray-300 font-medium truncate">{preset?.name || config.name}</span>
                  {config.isLocal && <span className="text-[0.5rem] px-1 py-0.5 rounded bg-green-500/10 text-green-400 shrink-0">LOCAL</span>}
                  {!config.isLocal && <span className="text-[0.5rem] px-1 py-0.5 rounded bg-blue-500/10 text-blue-400 shrink-0">CLOUD</span>}
                  {status === 'connected' && <Wifi size={8} className="text-green-400 shrink-0" />}
                  {status === 'failed' && <WifiOff size={8} className="text-red-400 shrink-0" />}
                </div>
                <ChevronDown size={10} className={`text-gray-500 transition-transform shrink-0 ${isExpanded ? 'rotate-180' : ''}`} />
              </button>
            </div>

            {/* Expanded config */}
            {isExpanded && (
              <div className="px-2 pb-2 space-y-1.5 border-t border-white/[0.04]">
                {/* Endpoint */}
                <div className="pt-1.5">
                  <label className="text-[0.6rem] text-gray-500 mb-0.5 block">Endpoint</label>
                  <input
                    value={config.baseUrl}
                    onChange={(e) => setProviderConfig(id, { baseUrl: e.target.value })}
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
                        type={isKeyVisible ? 'text' : 'password'}
                        value={currentKey}
                        onChange={(e) => setProviderApiKey(id, e.target.value)}
                        placeholder={preset?.placeholder || 'sk-...'}
                        className="w-full px-2 py-1 pr-7 rounded bg-white/5 border border-white/8 text-[0.65rem] text-gray-300 font-mono focus:outline-none focus:border-white/20"
                      />
                      <button
                        onClick={() => setShowKey(prev => ({ ...prev, [id]: !isKeyVisible }))}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                      >
                        {isKeyVisible ? <EyeOff size={10} /> : <Eye size={10} />}
                      </button>
                    </div>
                  </div>
                )}

                {/* Test + Disable */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleTest(id)}
                    disabled={isTesting}
                    className="px-2 py-0.5 rounded bg-white/5 border border-white/8 text-[0.6rem] text-gray-400 hover:text-gray-200 hover:bg-white/8 transition-colors disabled:opacity-50"
                  >
                    {isTesting ? <Loader2 size={10} className="animate-spin" /> : 'Test'}
                  </button>
                  <button
                    onClick={() => toggleProvider(id)}
                    className="px-2 py-0.5 rounded bg-red-500/5 border border-red-500/10 text-[0.6rem] text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                  >
                    Disable
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

                {/* API key storage disclaimer */}
                {needsKey && currentKey && (
                  <p className="text-[0.5rem] text-gray-600 mt-0.5 leading-tight">
                    Keys are stored locally with basic obfuscation, not encryption. Avoid shared computers.
                  </p>
                )}

                {/* Cloud + auto-extract cost warning */}
                {needsKey && autoExtractEnabled && (
                  <p className="text-[0.55rem] text-amber-400/80 mt-1 leading-tight">
                    Memory auto-extraction runs a secondary inference every 3rd turn, increasing API costs. Disable in Settings &gt; Memory if not needed.
                  </p>
                )}
              </div>
            )}
          </div>
        )
      })}

      {/* No backend warning */}
      {noBackend && (
        <p className="text-[0.6rem] text-red-400">No backend configured. Add one below to start chatting.</p>
      )}

      {/* Add Provider Dropdown */}
      <div className="relative">
        <button
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className="w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded bg-white/5 border border-white/8 border-dashed text-[0.65rem] text-gray-500 hover:text-gray-300 hover:border-white/15 transition-colors"
        >
          <Plus size={10} />
          <span>Add Provider</span>
        </button>
        {dropdownOpen && (
          <div className="absolute z-50 top-full mt-1 w-full bg-[#2a2a2a] border border-white/10 rounded-lg shadow-xl max-h-56 overflow-y-auto scrollbar-thin">
            {/* Local group */}
            <div className="px-2.5 py-1 text-[0.5rem] uppercase tracking-wider text-gray-600 font-semibold">Local</div>
            {localPresets.map(preset => {
              const isActive = enabledProviderIds.includes(preset.providerId) &&
                (preset.providerId !== 'openai' || providers.openai.name === preset.name)
              return (
                <button
                  key={preset.id}
                  onClick={() => selectPreset(preset)}
                  className={`w-full text-left px-2.5 py-1.5 text-[0.65rem] transition-colors ${
                    isActive ? 'bg-white/10 text-white' : 'text-gray-300 hover:bg-white/5'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{preset.name}</span>
                    {isActive && <span className="text-[0.5rem] text-green-400">Active</span>}
                  </div>
                  {preset.baseUrl && <span className="block text-[0.55rem] text-gray-500 font-mono">{preset.baseUrl}</span>}
                </button>
              )
            })}

            {/* Cloud group */}
            <div className="px-2.5 py-1 mt-1 border-t border-white/[0.06] text-[0.5rem] uppercase tracking-wider text-gray-600 font-semibold">Cloud</div>
            {cloudPresets.map(preset => {
              const isActive = enabledProviderIds.includes(preset.providerId) &&
                (preset.providerId !== 'openai' || providers.openai.name === preset.name)
              return (
                <button
                  key={preset.id}
                  onClick={() => selectPreset(preset)}
                  className={`w-full text-left px-2.5 py-1.5 text-[0.65rem] transition-colors ${
                    isActive ? 'bg-white/10 text-white' : 'text-gray-300 hover:bg-white/5'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{preset.name}</span>
                    {isActive && <span className="text-[0.5rem] text-green-400">Active</span>}
                  </div>
                  {preset.baseUrl && <span className="block text-[0.55rem] text-gray-500 font-mono">{preset.baseUrl}</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>

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
