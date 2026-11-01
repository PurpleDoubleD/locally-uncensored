/**
 * The Installed half of Models > LoRAs.
 *
 * A LoRA is not a model you switch to, it is a file the LoRA stack in Create
 * layers on top of one, so this list carries no Use button and nothing here
 * can be made the active model. What it does carry is the two things the user
 * came for: what each file weighs, and a way to take one off the disk again.
 *
 * The rows come from the same ComfyUI inventory the Image tab reads (they are
 * the `source: 'lora'` half of it), so there is no second reader and no second
 * answer about what is installed.
 */
import { Info, Layers, Trash2 } from 'lucide-react'
import { parseLocalCharacterLora } from '../../api/trainer'
import { formatBytes } from '../../lib/formatters'
import { ModelEmptyState, SectionHead } from './ModelPageParts'
import { ICON_SM } from '../ui/icon-size'

export interface LoraRow {
  name: string
  /** Bytes on disk, 0 when the size probe could not answer. */
  size: number
}

export interface LoraManagerProps {
  /** The rows to draw, already narrowed by the header search. */
  rows: LoraRow[]
  /** How many LoRAs are installed in total, search or no search. The empty
   *  state is a claim about the DISK, so it hangs off this and never off the
   *  filtered list: ten installed LoRAs and a query that matches none of them
   *  used to read "No LoRAs installed yet". */
  total: number
  /** What the header search currently holds, for the no-match line. */
  searchQuery: string
  /** Opens the shared delete confirmation of the Models view. */
  onDelete: (name: string) => void
  /** Opens the Details dialog of that file (D1). */
  onInfo?: (name: string) => void
  /** Sends the user to the Get new segment of this same rail. */
  onGetNew: () => void
}

/** The one sentence that says where a downloaded LoRA is actually used. The
 *  three names are the labels Create really shows: the drawer is titled
 *  "Advanced settings" (AdvancedDrawer.tsx), the group inside it "Expert" and
 *  the list "LoRA stack" (ParamGroups.tsx). */
export const LORA_USE_HINT = 'Use them in Create, Advanced settings, Expert, LoRA stack.'

export function LoraManager({ rows, total, searchQuery, onDelete, onInfo, onGetNew }: LoraManagerProps) {
  if (total === 0) {
    return (
      <ModelEmptyState
        icon={<Layers size={28} />}
        title="No LoRAs installed yet"
        action={(
          <button onClick={onGetNew} className="lu-primary lu-control">
            <Layers size={ICON_SM} /> Get new LoRAs
          </button>
        )}
      >
        Get new has ready-made LoRAs, a field for a CivitAI or Hugging Face link and a CivitAI search. What you pick lands in ComfyUI&apos;s models/loras folder. {LORA_USE_HINT}
      </ModelEmptyState>
    )
  }

  return (
    <section className="space-y-2">
      <SectionHead level="h2" icon={<Layers size={ICON_SM} />} title="Installed LoRAs" count={rows.length} />
      <p className="t-micro text-gray-500 dark:text-gray-400">{LORA_USE_HINT}</p>
      <div className="space-y-1.5">
        {rows.map((row) => {
          const character = parseLocalCharacterLora(row.name)
          return (
            <div
              key={row.name}
              data-testid="lora-row"
              className="lu-tile flex items-center gap-3 px-3.5 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-xs font-medium text-gray-900 dark:text-gray-100">{row.name}</span>
                  {character && (
                    // The ink in the light: the edge colour that stood here
                    // reaches 3.37:1 on a light row, enough for a border and
                    // not for a word.
                    <span className="shrink-0 px-1.5 py-0.5 rounded t-micro border border-lu-accent/30 bg-lu-accent-soft text-lu-accent-ink dark:text-lu-accent">
                      Character
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1 t-micro text-gray-500 dark:text-gray-400">
                  {row.size > 0 && <span className="tabular-nums">{formatBytes(row.size)}</span>}
                  {character && <span className="font-mono">Trigger word: {character.trigger}</span>}
                </div>
              </div>
              {onInfo && (
                <button
                  onClick={() => onInfo(row.name)}
                  title="Details"
                  aria-label={`Details of ${row.name}`}
                  className="lu-control lu-control--icon lu-control--outline shrink-0"
                >
                  <Info size={ICON_SM} />
                </button>
              )}
              <button
                onClick={() => onDelete(row.name)}
                title="Delete"
                aria-label={`Delete ${row.name}`}
                className="lu-control lu-control--icon lu-control--outline shrink-0"
              >
                <Trash2 size={ICON_SM} />
              </button>
            </div>
          )
        })}
        {/* Same shape as the other rails: the section heading and its count
            stay, and the filtered-away list says so instead of claiming
            anything about what is installed. */}
        {rows.length === 0 && (
          <p className="text-center text-xs text-gray-500 dark:text-gray-400 py-6">No installed LoRAs match "{searchQuery}"</p>
        )}
      </div>
    </section>
  )
}
