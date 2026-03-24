import { Trash2, Info, MessageSquare, Image, Video } from 'lucide-react'
import { GlassCard } from '../ui/GlassCard'
import { formatBytes } from '../../lib/formatters'
import type { AIModel } from '../../types/models'

interface Props {
  model: AIModel
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
  onInfo: () => void
}

const TYPE_CONFIG = {
  text: { label: 'Text', icon: MessageSquare, color: 'bg-blue-500/15 text-blue-300' },
  image: { label: 'Image', icon: Image, color: 'bg-purple-500/15 text-purple-300' },
  video: { label: 'Video', icon: Video, color: 'bg-green-500/15 text-green-300' },
}

export function ModelCard({ model, isActive, onSelect, onDelete, onInfo }: Props) {
  const typeInfo = TYPE_CONFIG[model.type] || TYPE_CONFIG.text
  const TypeIcon = typeInfo.icon

  return (
    <GlassCard hover className={`cursor-pointer ${isActive ? 'border-white/15' : ''}`}>
      <div onClick={onSelect}>
        <div className="flex items-start justify-between mb-2">
          <h3 className="font-semibold text-gray-900 dark:text-white text-sm truncate flex-1">{model.name}</h3>
          {isActive && (
            <span className="text-xs bg-gray-200 dark:bg-white/10 text-gray-700 dark:text-white px-2 py-0.5 rounded-full ml-2 shrink-0">
              Active
            </span>
          )}
        </div>
        <div className="space-y-1 text-xs text-gray-500 dark:text-gray-400">
          <div className="flex items-center gap-1.5 mb-1">
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex items-center gap-1 ${typeInfo.color}`}>
              <TypeIcon size={10} /> {typeInfo.label}
            </span>
          </div>
          {model.size > 0 && <p>Size: {formatBytes(model.size)}</p>}
          {model.type === 'text' && 'details' in model && (
            <>
              <p>Family: {model.details?.family || 'unknown'}</p>
              <p>Parameters: {model.details?.parameter_size || 'unknown'}</p>
              <p>Quantization: {model.details?.quantization_level || 'unknown'}</p>
            </>
          )}
          {(model.type === 'image' || model.type === 'video') && 'architecture' in model && (
            <p>Format: {model.format || 'safetensors'}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-200 dark:border-white/5">
        <button
          onClick={(e) => { e.stopPropagation(); onInfo() }}
          className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
        >
          <Info size={14} /> Details
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-red-400 transition-colors ml-auto"
        >
          <Trash2 size={14} /> Delete
        </button>
      </div>
    </GlassCard>
  )
}
