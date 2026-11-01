// The classic face of the installed LoRA list: Windows and Linux. The build
// is the one from before the Model Manager redesign (commit 9339daa7), the
// colours are the Mac's since 10.10.2026 (see classic.tsx). The Mac face is
// ../LoraManager.tsx, which also owns the row type and the hint sentence both
// faces say. Which one is drawn is decided in skin/which.ts.
import { Info, Layers, Trash2 } from 'lucide-react'
import { parseLocalCharacterLora } from '../../../api/trainer'
import { formatBytes } from '../../../lib/formatters'
import { LORA_USE_HINT, type LoraManagerProps } from '../LoraManager'

export function ClassicLoraManager({ rows, total, searchQuery, onDelete, onInfo, onGetNew }: LoraManagerProps) {
  if (total === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center py-16 px-6 gap-3">
        <div className="w-14 h-14 rounded-full bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/[0.08] flex items-center justify-center">
          <Layers size={28} className="text-gray-400 dark:text-gray-500" />
        </div>
        <div className="space-y-1">
          <p className="t-control text-gray-900 dark:text-white">No LoRAs installed yet</p>
          <p className="t-micro text-gray-500 dark:text-gray-400 max-w-[300px] leading-relaxed">
            Get new has ready-made LoRAs, a field for a CivitAI or Hugging Face link and a CivitAI search. What you pick lands in ComfyUI&apos;s models/loras folder. {LORA_USE_HINT}
          </p>
        </div>
        <button
          onClick={onGetNew}
          className="lu-primary flex items-center gap-1.5 mt-1 px-3 py-1.5 rounded-md t-micro transition-colors"
        >
          <Layers size={11} /> Get new LoRAs
        </button>
      </div>
    )
  }

  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2 px-1">
        <Layers size={11} className="text-gray-500 dark:text-gray-400" />
        <h2 className="t-micro font-semibold uppercase tracking-[0.12em] text-gray-700 dark:text-gray-300">LoRAs</h2>
        <span className="text-[0.55rem] text-gray-500 dark:text-gray-400 tabular-nums">{rows.length}</span>
        <div className="flex-1 h-px bg-gray-200 dark:bg-white/[0.07]" />
      </div>
      <p className="px-1 text-[0.55rem] text-gray-500 dark:text-gray-400">{LORA_USE_HINT}</p>
      <div className="space-y-1.5">
        {rows.map((row) => {
          const character = parseLocalCharacterLora(row.name)
          return (
            <div
              key={row.name}
              data-testid="lora-row"
              className="lu-tile rounded-lg! flex items-center gap-3 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate t-control text-gray-900 dark:text-gray-100">{row.name}</span>
                  {character && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded t-micro border border-lu-accent/30 bg-lu-accent-soft text-lu-accent-ink dark:text-lu-accent">
                      Character
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5 t-micro text-gray-500 dark:text-gray-400">
                  {row.size > 0 && <span className="tabular-nums">{formatBytes(row.size)}</span>}
                  {character && <span className="font-mono">Trigger word: {character.trigger}</span>}
                </div>
              </div>
              {onInfo && (
                <button
                  onClick={() => onInfo(row.name)}
                  title="Details"
                  aria-label={`Details of ${row.name}`}
                  className="shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
                >
                  <Info size={13} />
                </button>
              )}
              <button
                onClick={() => onDelete(row.name)}
                title="Delete"
                aria-label={`Delete ${row.name}`}
                className="shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
              >
                <Trash2 size={13} />
              </button>
            </div>
          )
        })}
        {/* Same shape as the other rails: the section heading and its count
            stay, and the filtered-away list says so instead of claiming
            anything about what is installed. */}
        {rows.length === 0 && (
          <p className="text-center t-micro text-gray-500 dark:text-gray-400 py-6">No installed LoRAs match "{searchQuery}"</p>
        )}
      </div>
    </section>
  )
}
