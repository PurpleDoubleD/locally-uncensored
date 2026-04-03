import { Trash2, Info, MessageSquare, Image, Video } from 'lucide-react'
import { formatBytes } from '../../lib/formatters'
import type { AIModel } from '../../types/models'

interface Props {
  model: AIModel
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
  onInfo: () => void
  canDelete?: boolean
}

const TYPE_CONFIG = {
  text: { label: 'Text', icon: MessageSquare, color: 'text-blue-400' },
  image: { label: 'Image', icon: Image, color: 'text-purple-400' },
  video: { label: 'Video', icon: Video, color: 'text-green-400' },
}

export function ModelCard({ model, isActive, onSelect, onDelete, onInfo, canDelete = true }: Props) {
  const typeInfo = TYPE_CONFIG[model.type] || TYPE_CONFIG.text
  const TypeIcon = typeInfo.icon

  return (
    <div
      onClick={onSelect}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-all group ${
        isActive
          ? 'bg-white/[0.04] border-l-2 border-l-blue-400'
          : 'hover:bg-white/[0.02] border-l-2 border-l-transparent'
      }`}
    >
      {/* Type icon */}
      <TypeIcon size={13} className={`${typeInfo.color} shrink-0`} />

      {/* Name + details */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[0.72rem] text-gray-200 font-medium truncate">{model.name}</span>
          {isActive && <span className="text-[0.5rem] text-blue-400 font-medium uppercase">Active</span>}
        </div>
        <div className="flex items-center gap-2 text-[0.6rem] text-gray-500">
          {model.size > 0 && <span>{formatBytes(model.size)}</span>}
          {model.type === 'text' && 'details' in model && (
            <>
              {model.details?.family && <span>{model.details.family}</span>}
              {model.details?.parameter_size && <span>{model.details.parameter_size}</span>}
              {model.details?.quantization_level && <span>{model.details.quantization_level}</span>}
            </>
          )}
          {(model.type === 'image' || model.type === 'video') && (
            <span>{model.format || 'safetensors'}</span>
          )}
        </div>
      </div>

      {/* Actions (visible on hover) */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <button
          onClick={(e) => { e.stopPropagation(); onInfo() }}
          className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-gray-300 transition-colors"
          title="Details"
        >
          <Info size={12} />
        </button>
        {canDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            className="p-1 rounded hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-colors"
            title="Delete"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  )
}
