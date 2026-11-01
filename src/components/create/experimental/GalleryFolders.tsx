import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FolderCog, Trash2 } from 'lucide-react'
import { Modal } from '../../ui/Modal'
import { ModalActions, ModalButton } from '../../ui/ModalActions'
import { useCreateStore } from '../../../stores/createStore'
import { folderCounts, FOLDER_CAP, FOLDER_NAME_MAX } from '../../../lib/gallery-folders'
import { Select, type SelectOption } from '../ui/Select'

// Gallery folders (D3). Folders are labels inside the app: moving an entry,
// renaming or removing a folder never touches a file (lib/gallery-folders.ts).

const ALL = '__all'
const NONE = '__none'

/** A dialog opened from the narrow gallery panel goes onto the page itself, so
 *  no clipping or stacking of the panel can cut it off. */
export function OnBody({ children }: { children: ReactNode }) {
  return typeof document === 'undefined' ? null : createPortal(children, document.body)
}

const FIELD =
  'h-[var(--control-h-md)] px-2.5 rounded-[var(--radius-control)] bg-white/[0.04] border border-white/[0.08] focus:border-white/20 outline-none t-control text-gray-100'
/** A field in a row next to a button. In the column of the move dialog
 *  flex-1 shrank its height to the text (FEHLER-D3 #1, side finding). */
const ROW_FIELD = `flex-1 min-w-0 ${FIELD}`

/** The filter at the top of the gallery: "All" and every folder, with counts,
 *  and the button that manages the folders. */
export function FolderFilter() {
  const gallery = useCreateStore((s) => s.gallery)
  const folders = useCreateStore((s) => s.galleryFolders)
  const open = useCreateStore((s) => s.galleryFolderOpen)
  const setOpen = useCreateStore((s) => s.setGalleryFolderOpen)
  const [managing, setManaging] = useState(false)
  const counts = folderCounts(gallery)
  const options: SelectOption[] = [
    { value: ALL, label: `All (${gallery.length})` },
    ...folders.map((f) => ({ value: f.id, label: `${f.name} (${counts.get(f.id) ?? 0})` })),
  ]
  return (
    <div className="flex items-center gap-1.5 px-3 pt-2 shrink-0" data-testid="gallery-folder-filter">
      {folders.length > 0 && (
        <Select
          size="sm"
          className="flex-1 min-w-0"
          ariaLabel="Show folder"
          options={options}
          value={open ?? ALL}
          onChange={(v) => setOpen(v === ALL ? null : v)}
        />
      )}
      <button
        type="button"
        onClick={() => setManaging(true)}
        title="Folders" aria-label="Folders"
        className="flex items-center justify-center gap-1 h-[var(--control-h-sm)] px-1.5 rounded t-label text-gray-500 hover:text-gray-200 hover:bg-white/5 transition-colors"
      >
        <FolderCog size={13} />
        {folders.length === 0 && <span>Folders</span>}
      </button>
      <OnBody><ManageFoldersModal open={managing} onClose={() => setManaging(false)} /></OnBody>
    </div>
  )
}

/** Make, rename and remove folders. Removing one keeps its items in "All". */
export function ManageFoldersModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Gallery folders" maxWidth="max-w-md">
      <ManageFolders />
      <ModalActions>
        <ModalButton variant="primary" onClick={onClose}>Done</ModalButton>
      </ModalActions>
    </Modal>
  )
}

function ManageFolders() {
  const folders = useCreateStore((s) => s.galleryFolders)
  const gallery = useCreateStore((s) => s.gallery)
  const add = useCreateStore((s) => s.addGalleryFolder)
  const rename = useCreateStore((s) => s.renameGalleryFolder)
  const remove = useCreateStore((s) => s.removeGalleryFolder)
  const [name, setName] = useState('')
  const counts = folderCounts(gallery)
  const full = folders.length >= FOLDER_CAP
  const create = () => {
    if (add(name)) setName('')
  }
  return (
    <div className="flex flex-col gap-3" data-testid="gallery-folders">
      <p className="t-body text-gray-500">
        Folders only sort the gallery. Your files stay where they are, and removing a folder keeps its items in All.
      </p>
      {folders.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {folders.map((f) => (
            <li key={f.id} className="flex items-center gap-2">
              <input
                defaultValue={f.name}
                maxLength={FOLDER_NAME_MAX}
                aria-label={`Name of folder ${f.name}`}
                onBlur={(e) => {
                  if (e.currentTarget.value.trim()) rename(f.id, e.currentTarget.value)
                  else e.currentTarget.value = f.name
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                className={ROW_FIELD}
              />
              <span className="t-mono text-gray-500 w-8 text-right">{counts.get(f.id) ?? 0}</span>
              <button
                type="button"
                onClick={() => remove(f.id)}
                title="Remove folder. Its items stay in All." aria-label={`Remove folder ${f.name}`}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-200 hover:bg-white/5"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <input
          value={name}
          maxLength={FOLDER_NAME_MAX}
          placeholder={full ? 'No room for more folders' : 'New folder'}
          aria-label="New folder name"
          disabled={full}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') create() }}
          className={ROW_FIELD}
        />
        <ModalButton onClick={create} disabled={full || !name.trim()}>Add</ModalButton>
      </div>
    </div>
  )
}

/** "Move to folder" for one or more gallery entries. */
export function MoveToFolderModal({ ids, onClose }: { ids: readonly string[]; onClose: () => void }) {
  return (
    <Modal open={ids.length > 0} onClose={onClose} title="Move to folder" maxWidth="max-w-md">
      <MoveToFolder ids={ids} onClose={onClose} />
    </Modal>
  )
}

function MoveToFolder({ ids, onClose }: { ids: readonly string[]; onClose: () => void }) {
  const folders = useCreateStore((s) => s.galleryFolders)
  const current = useCreateStore((s) => s.gallery.find((g) => g.id === ids[0])?.folderId)
  const add = useCreateStore((s) => s.addGalleryFolder)
  const move = useCreateStore((s) => s.moveToGalleryFolder)
  const [target, setTarget] = useState<string>(current ?? folders[0]?.id ?? NONE)
  const [name, setName] = useState('')
  const options: SelectOption[] = [
    ...folders.map((f) => ({ value: f.id, label: f.name })),
    { value: NONE, label: 'No folder (All only)' },
  ]
  const full = folders.length >= FOLDER_CAP
  const go = () => {
    let dest: string | null = target === NONE ? null : target
    if (name.trim()) {
      const made = add(name)
      if (!made) return
      dest = made
    }
    move(ids, dest)
    onClose()
  }
  return (
    <div className="flex flex-col gap-3" data-testid="move-to-folder">
      {folders.length > 0 && (
        <Select ariaLabel="Folder" options={options} value={target} onChange={setTarget} />
      )}
      <input
        value={name}
        maxLength={FOLDER_NAME_MAX}
        placeholder={folders.length > 0 ? 'Or a new folder' : 'New folder'}
        aria-label="New folder name"
        disabled={full}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') go() }}
        className={`w-full ${FIELD}`}
      />
      <ModalActions>
        <ModalButton variant="quiet" onClick={onClose}>Cancel</ModalButton>
        <ModalButton variant="primary" onClick={go} disabled={folders.length === 0 && !name.trim()}>Move</ModalButton>
      </ModalActions>
    </div>
  )
}
