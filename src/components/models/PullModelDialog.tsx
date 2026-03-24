import { useState } from 'react'
import { Download } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { GlowButton } from '../ui/GlowButton'
import { ProgressBar } from '../ui/ProgressBar'
import { useModels } from '../../hooks/useModels'
import { formatBytes } from '../../lib/formatters'

interface Props {
  open: boolean
  onClose: () => void
}

export function PullModelDialog({ open, onClose }: Props) {
  const [modelName, setModelName] = useState('')
  const { pullModel, isPulling, pullProgress } = useModels()

  const handlePull = () => {
    if (!modelName.trim() || isPulling) return
    pullModel(modelName.trim())
  }

  const progress =
    pullProgress?.total && pullProgress?.completed
      ? (pullProgress.completed / pullProgress.total) * 100
      : 0

  return (
    <Modal open={open} onClose={onClose} title="Pull Model">
      <div className="space-y-4">
        <div>
          <label className="text-sm text-gray-400 mb-1 block">Model Name</label>
          <input
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handlePull()}
            placeholder="e.g. llama3.1:8b or mannix/llama3.1-8b-abliterated"
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:border-white/20 text-sm"
            disabled={isPulling}
          />
        </div>

        {isPulling && pullProgress && (
          <div className="space-y-2">
            <p className="text-sm text-gray-300">{pullProgress.status}</p>
            {pullProgress.total && pullProgress.completed !== undefined && (
              <>
                <ProgressBar progress={progress} />
                <p className="text-xs text-gray-500">
                  {formatBytes(pullProgress.completed || 0)} / {formatBytes(pullProgress.total)}
                </p>
              </>
            )}
          </div>
        )}

        <GlowButton onClick={handlePull} disabled={!modelName.trim() || isPulling} className="w-full flex items-center justify-center gap-2">
          <Download size={16} />
          {isPulling ? 'Downloading...' : 'Pull Model'}
        </GlowButton>
      </div>
    </Modal>
  )
}
