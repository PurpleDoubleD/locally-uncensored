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
import { Info, Layers, Trash2, Pencil, Eye, EyeOff, FolderOpen } from 'lucide-react'
import { parseLocalCharacterLora } from '../../api/trainer'
import { formatBytes } from '../../lib/formatters'
import { ModelEmptyState, SectionHead } from './ModelPageParts'
import { ICON_SM } from '../ui/icon-size'
import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { ContextMenu } from '../ui/ContextMenu'
import { buildLoraRowMenu } from '../ui/menu-actions'

export interface LoraRow {
  name: string
  /** Bytes on disk, 0 when the size probe could not answer. */
  size: number
  /** C41: the name the user gave it in LU. The file keeps its own. */
  label?: string
  /** C41: the user's note (trigger words, a strength that works). */
  note?: string
  /** C41: hidden from the LoRA stack in Create. */
  hidden?: boolean
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
  /** C41: rename and note. Absent: no button. */
  onEdit?: (name: string) => void
  /** C41: hide from (or bring back to) the LoRA stack in Create. */
  onToggleHidden?: (name: string) => void
  /** C41: show the file in Finder or Explorer. */
  onReveal?: (name: string) => void
  /** C41: how many LoRAs are hidden, and the switch that lists them too. */
  hiddenCount?: number
  showHidden?: boolean
  onShowHidden?: (show: boolean) => void
}

/** C41: the name, the file name under it when the user gave another, and
 *  the note. The same in both faces. */
export function LoraRowName({ row, nameClass }: { row: LoraRow; nameClass: string }) {
  return (
    <>
      <span className={`truncate ${nameClass}`} title={row.name}>{row.label || row.name}</span>
      {row.hidden && (
        <span className="shrink-0 px-1.5 py-0.5 rounded t-micro bg-gray-100 dark:bg-white/[0.06] text-gray-500 dark:text-gray-400" data-testid="lora-hidden-mark">
          Hidden in Create
        </span>
      )}
    </>
  )
}

/** C41: the file name (when renamed) and the note, under the name. */
export function LoraRowDetails({ row }: { row: LoraRow }) {
  if (!row.label && !row.note) return null
  return (
    <div className="mt-0.5 space-y-0.5">
      {row.label && <p className="t-micro font-mono text-gray-500 dark:text-gray-400 truncate" data-testid="lora-file-name">{row.name}</p>}
      {row.note && <p className="t-micro text-gray-600 dark:text-gray-300 whitespace-pre-line line-clamp-3" data-testid="lora-note">{row.note}</p>}
    </div>
  )
}

/** W33: the right click on a LoRA row. Returns the row's onContextMenu and
 *  the menu itself (render it once, next to the rows). */
export function useLoraRowMenu(h: { onDelete: (name: string) => void; onInfo?: (name: string) => void; onEdit?: (name: string) => void; onReveal?: (name: string) => void }) {
  const [menu, setMenu] = useState<{ name: string; x: number; y: number } | null>(null)
  const open = (name: string) => (e: ReactMouseEvent) => { e.preventDefault(); setMenu({ name, x: e.clientX, y: e.clientY }) }
  const element = menu ? (
    <ContextMenu
      items={buildLoraRowMenu({
        reveal: h.onReveal ? () => h.onReveal!(menu.name) : undefined,
        rename: h.onEdit ? () => h.onEdit!(menu.name) : undefined,
        info: h.onInfo ? () => h.onInfo!(menu.name) : undefined,
        remove: () => h.onDelete(menu.name),
      })}
      x={menu.x}
      y={menu.y}
      label={`Actions for ${menu.name}`}
      onClose={() => setMenu(null)}
    />
  ) : null
  return { open, element }
}

/** C41: the buttons a LoRA row has beside Details and Delete. */
export function LoraRowActions({ row, onEdit, onToggleHidden, onReveal, buttonClass, iconSize }: {
  row: LoraRow
  onEdit?: (name: string) => void
  onToggleHidden?: (name: string) => void
  onReveal?: (name: string) => void
  buttonClass: string
  iconSize: number
}) {
  return (
    <>
      {onEdit && (
        <button onClick={() => onEdit(row.name)} title="Rename and note" aria-label={`Rename ${row.name}`} className={buttonClass}>
          <Pencil size={iconSize} />
        </button>
      )}
      {onToggleHidden && (
        <button
          onClick={() => onToggleHidden(row.name)}
          title={row.hidden ? 'Show it in the LoRA stack of Create again' : 'Hide it from the LoRA stack of Create. The file stays.'}
          aria-label={`${row.hidden ? 'Show' : 'Hide'} ${row.name}`}
          className={buttonClass}
        >
          {row.hidden ? <Eye size={iconSize} /> : <EyeOff size={iconSize} />}
        </button>
      )}
      {onReveal && (
        <button onClick={() => onReveal(row.name)} title="Show the file in its folder" aria-label={`Show ${row.name} in its folder`} className={buttonClass}>
          <FolderOpen size={iconSize} />
        </button>
      )}
    </>
  )
}

/** C41: "Show hidden (3)", where there are hidden ones. */
export function ShowHiddenLoras({ count, show, onShow, className }: { count?: number; show?: boolean; onShow?: (v: boolean) => void; className: string }) {
  if (!onShow || !count) return null
  return (
    <label className={`flex items-center gap-1.5 shrink-0 ${className}`}>
      <input type="checkbox" checked={!!show} onChange={(e) => onShow(e.target.checked)} data-testid="lora-show-hidden" />
      Show hidden ({count})
    </label>
  )
}

/** The one sentence that says where a downloaded LoRA is actually used. The
 *  three names are the labels Create really shows: the drawer is titled
 *  "Advanced settings" (AdvancedDrawer.tsx), the group inside it "Expert" and
 *  the list "LoRA stack" (ParamGroups.tsx). */
export const LORA_USE_HINT = 'Use them in Create, Advanced settings, Expert, LoRA stack.'

export function LoraManager({ rows, total, searchQuery, onDelete, onInfo, onGetNew, onEdit, onToggleHidden, onReveal, hiddenCount, showHidden, onShowHidden }: LoraManagerProps) {
  const rowMenu = useLoraRowMenu({ onDelete, onInfo, onEdit, onReveal })
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
      <div className="flex items-center gap-3">
        <p className="t-micro text-gray-500 dark:text-gray-400 flex-1">{LORA_USE_HINT}</p>
        <ShowHiddenLoras count={hiddenCount} show={showHidden} onShow={onShowHidden} className="t-micro text-gray-500 dark:text-gray-400" />
      </div>
      <div className="space-y-1.5">
        {rows.map((row) => {
          const character = parseLocalCharacterLora(row.name)
          return (
            <div
              key={row.name}
              data-testid="lora-row"
              onContextMenu={rowMenu.open(row.name)}
              className="lu-tile flex items-center gap-3 px-3.5 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <LoraRowName row={row} nameClass="text-xs font-medium text-gray-900 dark:text-gray-100" />
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
                <LoraRowDetails row={row} />
              </div>
              <LoraRowActions
                row={row}
                onEdit={onEdit}
                onToggleHidden={onToggleHidden}
                onReveal={onReveal}
                buttonClass="lu-control lu-control--icon lu-control--outline shrink-0"
                iconSize={ICON_SM}
              />
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
      {rowMenu.element}
    </section>
  )
}
