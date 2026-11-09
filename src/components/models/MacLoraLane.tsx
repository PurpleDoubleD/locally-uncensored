// The LoRA lane of the Model Manager on a Mac.
//
// On Windows and Linux this lane is ComfyUI's models/loras folder. The Mac
// has no ComfyUI: the LoRAs of its image engine are the .safetensors files in
// a folder of the app (src-tauri commands/mlx_loras.rs), and the LoRA stack
// in Create hands them to a run. So this lane lists that folder, opens it in
// Finder, takes a file out of it again, and searches CivitAI for LoRAs made
// for Qwen-Image 2.1, which land in the same folder.

import { useState } from 'react'
import { FolderOpen, Layers, Trash2 } from 'lucide-react'
import { CivitaiSearchPanel } from './CivitaiSearchPanel'
import { LoraLinkPanel } from './LoraLinkPanel'
import { ModelEmptyState, ModelQuietLine, SectionHead } from './ModelPageParts'
import { Hinweis } from '../ui/Hinweis'
import { Modal } from '../ui/Modal'
import { ModalActions, ModalButton } from '../ui/ModalActions'
import { ICON_SM } from '../ui/icon-size'
import { formatBytes } from '../../lib/formatters'
import { installedRowMatchesSearch } from '../../lib/model-search'
import { deleteMlxLora, mlxLoraAlphaNote, mlxLoraKeysNote, openMlxLoraFolder, MLX_LORAS_CHANGED, MAC_LORA_MODELS } from '../../api/mlx-loras'
import type { MlxLoraFolder } from '../../hooks/useMlxLoras'
import { useLoraNotesStore } from '../../stores/loraNotesStore'
import { usePageMemoryStore } from '../../stores/pageMemoryStore'
import { LoraRowActions, LoraRowDetails, LoraRowName, ShowHiddenLoras } from './LoraManager'

/** Where a LoRA is used. The names are the labels Create shows: the drawer
 *  "Advanced settings", the group "Expert", the list "LoRA stack". */
export const MAC_LORA_USE_HINT = `Use them in Create with ${MAC_LORA_MODELS}: Advanced settings, Expert, LoRA stack. The other image models take no LoRA.`

/** CivitAI's own name for the base model the search is narrowed to. */
export const MAC_LORA_BASE_MODEL = 'Qwen 2.1'

interface Props {
  folder: MlxLoraFolder
  tab: 'discover' | 'installed'
  search: string
  searchSubmitToken: number
  onGetNew: () => void
  /** C41: opens the rename-and-note dialog of the Models page. */
  onEdit?: (name: string) => void
}

export function MacLoraLane({ folder, tab, search, searchSubmitToken, onGetNew, onEdit }: Props) {
  // C41: names, notes and hidden marks, the same store the other lane uses.
  const notes = useLoraNotesStore((s) => s.notes)
  const showHidden = usePageMemoryStore((s) => s.lorasShowHidden)
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const openFolder = () => {
    setError(null)
    openMlxLoraFolder().catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  const remove = async (name: string) => {
    setRemoving(null)
    try {
      await deleteMlxLora(name)
      useLoraNotesStore.getState().forget(name)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    window.dispatchEvent(new CustomEvent(MLX_LORAS_CHANGED))
    await folder.refresh()
  }

  /** The folder and the way into it. Both views carry it: it is the answer
   *  to "where do I put a file" and to "where did my download go". */
  const folderRow = (
    <div className="lu-tile flex items-center gap-3 px-3.5 py-2.5" data-testid="mac-lora-folder">
      <FolderOpen size={ICON_SM} className="shrink-0 text-gray-400 dark:text-gray-500" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-gray-900 dark:text-gray-100">LoRA folder</p>
        <p className="mt-0.5 t-micro font-mono break-all text-gray-500 dark:text-gray-400">{folder.dir || 'In the data folder of the app'}</p>
      </div>
      <button onClick={openFolder} className="lu-tonal shrink-0">
        <FolderOpen size={ICON_SM} /> Open folder
      </button>
    </div>
  )

  const problems = (
    <>
      {error && <Hinweis ton="fehler" onDismiss={() => setError(null)}>{error}</Hinweis>}
      {folder.error && <Hinweis ton="fehler">{folder.error}</Hinweis>}
    </>
  )

  if (tab === 'discover') {
    return (
      <div className="space-y-4" data-testid="mac-lora-lane">
        {problems}
        <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          A LoRA is a .safetensors file in the LoRA folder. Put your own there, paste a link below, or search CivitAI: what you pick lands in that folder. {MAC_LORA_USE_HINT}
        </p>
        {folderRow}
        <LoraLinkPanel mac destDir={folder.dir || undefined} installed={folder.loras.map((l) => l.name)} />
        <CivitaiSearchPanel
          modelType="LORA"
          title="Search CivitAI for Qwen-Image 2.1 LoRAs"
          placeholder="e.g. detail, consistency, outpaint..."
          search={search}
          searchSubmitToken={searchSubmitToken}
          baseModel={MAC_LORA_BASE_MODEL}
          destDir={folder.dir || undefined}
          installed={folder.loras}
        />
        <p className="t-micro leading-relaxed text-gray-500 dark:text-gray-400">
          The search lists LoRAs made for Qwen-Image 2.1. A LoRA for another model (Z-Image, FLUX.2, Qwen-Image) comes in through a link above or by hand and works with that model.
        </p>
      </div>
    )
  }

  if (!folder.loaded) return <ModelQuietLine>Reading your LoRA folder…</ModelQuietLine>

  const withNotes = folder.loras.map((l) => {
    const n = notes[l.name]
    return { ...l, size: l.sizeBytes, ...(n?.label ? { label: n.label } : {}), ...(n?.note ? { note: n.note } : {}), ...(n?.hidden ? { hidden: true } : {}) }
  })
  const hiddenCount = withNotes.filter((l) => l.hidden).length
  const q = search.trim().toLowerCase()
  const rows = withNotes
    .filter((l) => showHidden || !l.hidden)
    .filter((l) => !search || installedRowMatchesSearch(l.name, search) || (!!l.label && installedRowMatchesSearch(l.label, search)) || (!!l.note && l.note.toLowerCase().includes(q)))

  return (
    <div className="space-y-4" data-testid="mac-lora-lane">
      {problems}
      {folderRow}
      {folder.loras.length === 0 ? (
        <ModelEmptyState
          icon={<Layers size={28} />}
          title="No LoRAs in the folder yet"
          action={(
            <button onClick={onGetNew} className="lu-primary lu-control">
              <Layers size={ICON_SM} /> Get new LoRAs
            </button>
          )}
        >
          Put .safetensors files into the LoRA folder and press Refresh, or find one under Get new. {MAC_LORA_USE_HINT}
        </ModelEmptyState>
      ) : (
        <section className="space-y-2">
          <SectionHead level="h2" icon={<Layers size={ICON_SM} />} title="Installed LoRAs" count={rows.length} />
          <div className="flex items-center gap-3">
            <p className="t-micro text-gray-500 dark:text-gray-400 flex-1">{MAC_LORA_USE_HINT}</p>
            <ShowHiddenLoras count={hiddenCount} show={showHidden} onShow={(v) => usePageMemoryStore.getState().setLorasShowHidden(v)} className="t-micro text-gray-500 dark:text-gray-400" />
          </div>
          <div className="space-y-1.5">
            {rows.map((row) => {
              const note = mlxLoraKeysNote(row.keys)
              const alphaNote = mlxLoraAlphaNote(row.alpha)
              return (
                <div key={row.name} data-testid="lora-row" className="lu-tile flex items-center gap-3 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <LoraRowName row={row} nameClass="text-xs font-medium text-gray-900 dark:text-gray-100" />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 mt-1 t-micro text-gray-500 dark:text-gray-400">
                      {row.sizeBytes > 0 && <span className="tabular-nums">{formatBytes(row.sizeBytes)}</span>}
                      {note && <span data-testid="lora-keys-note">{note}</span>}
                      {alphaNote && <span data-testid="lora-alpha-note">{alphaNote}</span>}
                    </div>
                    <LoraRowDetails row={row} />
                  </div>
                  <LoraRowActions
                    row={row}
                    onEdit={onEdit}
                    onToggleHidden={(name) => useLoraNotesStore.getState().setNote(name, { hidden: !notes[name]?.hidden })}
                    // The Mac's LoRAs all lie in the one folder.
                    onReveal={openFolder}
                    buttonClass="lu-control lu-control--icon shrink-0"
                    iconSize={ICON_SM}
                  />
                  <button
                    onClick={() => setRemoving(row.name)}
                    title="Delete"
                    aria-label={`Delete ${row.name}`}
                    className="lu-control lu-control--icon shrink-0"
                  >
                    <Trash2 size={ICON_SM} />
                  </button>
                </div>
              )
            })}
            {rows.length === 0 && (
              <p className="text-center text-xs text-gray-500 dark:text-gray-400 py-6">No installed LoRAs match "{search}"</p>
            )}
          </div>
        </section>
      )}

      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Delete LoRA">
        <p className="text-[0.7rem] text-gray-600 dark:text-gray-300 mb-3">
          Delete <span className="text-gray-900 dark:text-white font-mono break-all">{removing}</span> from the LoRA folder?
          The file moves to the Trash.
        </p>
        <ModalActions>
          <ModalButton variant="quiet" onClick={() => setRemoving(null)}>Cancel</ModalButton>
          <ModalButton variant="danger" onClick={() => { if (removing) void remove(removing) }}>Delete</ModalButton>
        </ModalActions>
      </Modal>
    </div>
  )
}
