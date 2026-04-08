import { Download, Check, ExternalLink, RotateCcw, Star } from 'lucide-react'
import type { WorkflowSearchResult } from '../../types/workflows'
import type { ModelType } from '../../api/comfyui'
import { proxyImageUrl } from '../../lib/privacy'
import { openExternal } from '../../api/backend'

interface Props {
  result: WorkflowSearchResult
  isInstalled: boolean
  isActive: boolean
  currentModelType?: ModelType
  onInstall: (result: WorkflowSearchResult) => void
}

const SOURCE_BADGE: Record<string, { label: string; color: string }> = {
  civitai: { label: 'CivitAI', color: 'bg-blue-500/20 text-blue-300' },
  manual: { label: 'Template', color: 'bg-emerald-500/20 text-emerald-300' },
}

export function WorkflowCard({ result, isInstalled, isActive, currentModelType, onInstall }: Props) {
  const badge = SOURCE_BADGE[result.source] ?? SOURCE_BADGE.manual
  const displayName = result.name || result.sourceUrl?.split('/').pop() || 'Unnamed Workflow'
  const isCompatible = currentModelType && result.modelTypes.includes(currentModelType)

  return (
    <div className={`flex gap-3 p-3 rounded-xl border transition-colors ${
      isActive
        ? 'bg-white/8 border-emerald-500/30'
        : 'bg-white/5 border-white/10 hover:border-white/20'
    }`}>
      {/* Thumbnail */}
      {result.thumbnailUrl ? (
        <img
          src={proxyImageUrl(result.thumbnailUrl)}
          alt={displayName}
          className="w-16 h-16 rounded-lg object-cover flex-shrink-0 bg-white/5"
          loading="lazy"
        />
      ) : (
        <div className="w-16 h-16 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
          <Download size={20} className="text-gray-500" />
        </div>
      )}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-semibold text-white truncate" title={displayName}>
            {displayName}
          </span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${badge.color}`}>
            {badge.label}
          </span>
          {isCompatible && (
            <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/20 text-emerald-300 flex-shrink-0">
              <Star size={8} /> Match
            </span>
          )}
        </div>

        {result.description && (
          <p className="text-xs text-gray-400 line-clamp-2 mb-1.5" title={result.description}>
            {result.description}
          </p>
        )}

        {result.modelTypes.length > 0 && result.modelTypes[0] !== 'unknown' && (
          <div className="flex gap-1 mb-1.5">
            {result.modelTypes.map((mt) => (
              <span key={mt} className="px-1 py-0.5 rounded text-[9px] font-medium bg-white/10 text-gray-300">
                {mt.toUpperCase()}
              </span>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2">
          {isActive ? (
            <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 text-xs">
              <Check size={12} /> Active
            </span>
          ) : isInstalled ? (
            <button
              onClick={() => onInstall(result)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs transition-colors"
            >
              <RotateCcw size={12} /> Use
            </button>
          ) : (
            <button
              onClick={() => onInstall(result)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs transition-colors"
            >
              <Download size={12} /> Install
            </button>
          )}
          {result.sourceUrl && (
            <button
              onClick={() => openExternal(result.sourceUrl!)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white text-xs transition-colors"
            >
              <ExternalLink size={12} /> Source
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
