import { Trash2, Info, MessageSquare, Image, Video, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { formatBytes } from '../../lib/formatters'
import { BenchmarkButton } from './ModelBenchmark'
import { ContextMenu } from '../ui/ContextMenu'
import { buildModelCardMenu, type ModelMenuHandlers } from '../ui/menu-actions'
import type { AIModel } from '../../types/models'

interface Props {
  model: AIModel
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
  onInfo: () => void
  canDelete?: boolean
  /**
   * A16 (A14-4a): the Use button the 2.6.8 notes promise twice on this tile.
   *
   * The Windows counter-check found only Bench and Details here. The tile
   * itself was the switch, which works and is invisible: nothing on the row
   * said that clicking it would move the chat backend and load the model, so
   * the counter-check read the notes as broken and the button as missing.
   *
   * Passed only for rows where the word means something, an LU Engine row that
   * is not already the active one, and it goes through `onSelect`, the same
   * path the tile click takes.
   */
  onUse?: () => void
  /** While that swap runs. The engine can take seconds to load a cold GGUF. */
  useBusy?: boolean
}

const TYPE_CONFIG = {
  text: { label: 'Text', icon: MessageSquare, color: 'text-blue-400' },
  image: { label: 'Image', icon: Image, color: 'text-purple-400' },
  video: { label: 'Video', icon: Video, color: 'text-green-400' },
}

export function ModelCard({ model, isActive, onSelect, onDelete, onInfo, canDelete = true, onUse, useBusy = false }: Props) {
  const typeInfo = TYPE_CONFIG[model.type] || TYPE_CONFIG.text
  const TypeIcon = typeInfo.icon
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  // EIN Satz Aktionen fuer die Karte. Die sichtbaren Knoepfe unten lesen aus
  // diesem Objekt, das Kontextmenue bekommt dasselbe Objekt gereicht — es gibt
  // also keinen zweiten Aufrufweg, der irgendwann anders werden koennte.
  const actions: ModelMenuHandlers = { select: onSelect, info: onInfo, remove: onDelete }

  return (
    <>
    <div
      onClick={actions.select}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      className={`flex items-center gap-2.5 px-3 py-1.5 rounded-lg border cursor-pointer transition-all group ${
        isActive
          ? 'bg-blue-50 dark:bg-white/[0.05] border-blue-400/40 ring-1 ring-blue-400/40'
          : 'bg-gray-50 dark:bg-white/[0.03] border-gray-200 dark:border-white/[0.06] hover:bg-gray-100 dark:hover:bg-white/[0.05]'
      }`}
    >
      {/* Type icon */}
      <TypeIcon size={13} className={`${typeInfo.color} shrink-0`} />

      {/* Name — grows to fill the row (single-line, LM-Studio style) */}
      <span className="flex-1 min-w-0 text-[0.7rem] text-gray-800 dark:text-gray-200 font-medium truncate">{model.name}</span>

      {isActive && <span className="shrink-0 text-[0.5rem] text-blue-400 font-medium uppercase">Active</span>}

      {/* Compact meta — size · params · quant, dot-separated, mono figures */}
      <span className="hidden md:flex items-center gap-1.5 shrink-0 t-micro text-gray-500 lu-hud-num">
        {model.size > 0 && <span>{formatBytes(model.size)}</span>}
        {model.type === 'text' && 'details' in model && model.details?.parameter_size && (
          <><span className="opacity-40">·</span><span>{model.details.parameter_size}</span></>
        )}
        {model.type === 'text' && 'details' in model && model.details?.quantization_level && (
          <><span className="opacity-40">·</span><span>{model.details.quantization_level}</span></>
        )}
        {(model.type === 'image' || model.type === 'video') && (
          <><span className="opacity-40">·</span><span>{model.format || 'safetensors'}</span></>
        )}
      </span>

      {/* Actions — always visible (LM-Studio: no hover-to-reveal) */}
      <div className="flex items-center gap-0.5 shrink-0">
        {/* The pick marks the row Active at once, while the engine is still
            loading the GGUF, so the button stays for as long as its own swap
            runs. Dropping it there would take the Loading state off screen at
            the exact moment it is the answer to "did that work". */}
        {onUse && (!isActive || useBusy) && (
          <button
            onClick={(e) => { e.stopPropagation(); if (!useBusy) onUse() }}
            disabled={useBusy}
            data-testid="model-card-use"
            className="px-2 py-0.5 mr-1 rounded text-[0.58rem] font-medium bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/15 border border-gray-200 dark:border-white/10 transition-colors disabled:opacity-60 disabled:cursor-default inline-flex items-center gap-1"
            title="Load this model on the LU Engine and use it for chat"
          >
            {useBusy && <Loader2 size={9} className="animate-spin" />}
            {useBusy ? 'Loading…' : 'Use'}
          </button>
        )}
        {model.type === 'text' && (
          <div onClick={(e) => e.stopPropagation()}>
            <BenchmarkButton modelName={model.name} />
          </div>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); actions.info() }}
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          title="Details"
        >
          <Info size={12} />
        </button>
        {canDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); actions.remove() }}
            className="p-1 rounded hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors"
            title="Delete"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>

    {menu && (
      <ContextMenu
        items={buildModelCardMenu(actions, { isActive, canDelete })}
        x={menu.x}
        y={menu.y}
        label={`Actions for ${model.name}`}
        onClose={() => setMenu(null)}
      />
    )}
    </>
  )
}
