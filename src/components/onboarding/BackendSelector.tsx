/**
 * Backend Selection Dialog
 *
 * Shown on startup when multiple local backends are detected.
 * User picks one as the primary backend.
 */

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { useProviderStore } from '../../stores/providerStore'
import { PROVIDER_PRESETS } from '../../api/providers/types'
import type { DetectedBackend } from '../../lib/backend-detector'

interface Props {
  open: boolean
  backends: DetectedBackend[]
  onClose: () => void
}

export function BackendSelector({ open, backends, onClose }: Props) {
  const [selected, setSelected] = useState<string>(backends[0]?.id || '')
  const { setProviderConfig } = useProviderStore()

  const handleConfirm = () => {
    const backend = backends.find(b => b.id === selected)
    if (!backend) { onClose(); return }

    // Find the preset to get the providerId
    const preset = PROVIDER_PRESETS.find(p => p.id === backend.id)
    if (!preset) { onClose(); return }

    if (preset.providerId === 'ollama') {
      // Ollama is already enabled by default, nothing to do
    } else {
      // Enable as local backend via the openai provider
      setProviderConfig('openai', {
        enabled: true,
        name: backend.name,
        baseUrl: backend.baseUrl,
        isLocal: true,
      })
    }

    onClose()
  }

  // Filter out Ollama from the list (it's always on)
  const nonOllamaBackends = backends.filter(b => b.id !== 'ollama')
  const ollamaDetected = backends.some(b => b.id === 'ollama')

  return (
    <Modal open={open} onClose={onClose} title="">
      <div className="space-y-4">
        <h3 className="text-base font-semibold text-white text-center">Local backends detected</h3>
        <p className="text-[0.75rem] text-gray-400 text-center leading-relaxed">
          {backends.length === 1
            ? `${backends[0].name} is running on your system.`
            : `${backends.length} local backends are running on your system. Select which one to use as your primary backend.`
          }
        </p>

        {/* Backend list */}
        <div className="space-y-1">
          {ollamaDetected && (
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-green-500/[0.05] border border-green-500/15">
              <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
              <div className="flex-1">
                <p className="text-[0.7rem] font-medium text-white">Ollama</p>
                <p className="text-[0.55rem] text-gray-500 font-mono">localhost:11434 — always active</p>
              </div>
            </div>
          )}

          {nonOllamaBackends.map(backend => (
            <button
              key={backend.id}
              onClick={() => setSelected(backend.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                selected === backend.id
                  ? 'bg-white/10 border border-white/15'
                  : 'bg-white/[0.02] border border-white/[0.06] hover:bg-white/5'
              }`}
            >
              <div className={`w-2 h-2 rounded-full shrink-0 ${
                selected === backend.id ? 'bg-white' : 'bg-gray-600'
              }`} />
              <div className="flex-1">
                <p className="text-[0.7rem] font-medium text-white">{backend.name}</p>
                <p className="text-[0.55rem] text-gray-500 font-mono">localhost:{backend.port}</p>
              </div>
            </button>
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-center gap-3 pt-1">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-[0.7rem] text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            Skip
          </button>
          {nonOllamaBackends.length > 0 && (
            <button
              onClick={handleConfirm}
              className="px-4 py-1.5 rounded-lg text-[0.7rem] font-medium bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 transition-colors"
            >
              Use selected
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}
