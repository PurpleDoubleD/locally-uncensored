import { itemHasAlpha } from '../../../lib/transparent-image'
import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Images, Play, PanelRightClose, Trash2, Download, MonitorOff, AudioLines, FolderInput, Check, X } from 'lucide-react'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { galleryLabel } from '../../../lib/render/gallery-label'
import { GALLERY_DRAG_TYPE, playsAsVideo } from './galleryUrl'
import { deleteTitle, unavailableTitle } from './galleryWording'
import { isMlxImageHost } from '../../../api/mlx-image'
import { downloadGalleryItem } from './galleryDownload'
import { useComfyMedia } from './useComfyMedia'
import { cn } from '../ui/cn'
import { itemsInFolder } from '../../../lib/gallery-folders'
import { FolderFilter, MoveToFolderModal, OnBody } from './GalleryFolders'
import { ContextMenu } from '../../ui/ContextMenu'
import { Modal } from '../../ui/Modal'
import { ModalActions, ModalButton } from '../../ui/ModalActions'
import {
  EMPTY_SELECTION, buildGalleryMenu, clickSelection, deleteConfirmLine, keepShown, menuSelection, selectAll,
  type GallerySelection,
} from './gallerySelection'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  activeId: string | null
  onSelect: (id: string) => void
}

/**
 * The right-hand Gallery panel — matched 1:1 with the web companion: a floating
 * bubble that collapses to a slim icon rail (default) and expands into a
 * vertical thumbnail grid, replacing the old bottom strip. Keeps the desktop's
 * local-availability affordances (recover/mark, the "unavailable" overlay).
 */
export function CreatePanel({ open, onOpenChange, activeId, onSelect }: Props) {
  const all = useCreateStore((s) => s.gallery)
  const folderOpen = useCreateStore((s) => s.galleryFolderOpen)
  const removeFromGallery = useCreateStore((s) => s.removeFromGallery)
  // D3: the panel shows the open folder, "All" when none is open.
  const gallery = folderOpen === null ? all : itemsInFolder(all, folderOpen)
  const [moving, setMoving] = useState<string[]>([])
  const count = gallery.length
  // Several at once (D3, 3.0.9): Cmd/Ctrl-click, Shift range, Cmd/Ctrl+A,
  // Escape. The menu and the bar act on `sel.ids` with the tile's own code.
  const [stored, setSel] = useState<GallerySelection>(EMPTY_SELECTION)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirming, setConfirming] = useState<readonly string[]>([])
  const order = gallery.map((g) => g.id)
  // Items no longer shown (another folder, deleted) are not selected.
  const sel = keepShown(stored, order)
  const picked = new Set(sel.ids)
  const selecting = sel.ids.length > 0

  const onTileClick = (e: ReactMouseEvent, id: string) => {
    const mods = { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey }
    // From the state, not from this render: two clicks can land before the
    // next render (seen on the Mac), and the first must not be lost.
    setSel((prev) => clickSelection(keepShown(prev, order), order, id, mods))
    if (!mods.toggle && !mods.range) onSelect(id)
  }
  const onTileMenu = (e: ReactMouseEvent, id: string) => {
    e.preventDefault()
    // From the state too; the menu acts on whatever is selected when it shows.
    setSel((prev) => menuSelection(keepShown(prev, order), id))
    setMenu({ x: e.clientX, y: e.clientY })
  }
  const onGridKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && order.length > 0) {
      e.preventDefault()
      setSel(selectAll(order))
    } else if (e.key === 'Escape' && selecting) {
      e.stopPropagation()
      setSel(EMPTY_SELECTION)
    }
  }
  // The same ways a single tile goes: the move dialog, downloadGalleryItem
  // (one Save dialog after the other), removeFromGallery after the question.
  const downloadAll = async (ids: readonly string[]) => {
    for (const id of ids) {
      const g = useCreateStore.getState().gallery.find((x) => x.id === id)
      if (g) await downloadGalleryItem(g)
    }
  }
  const deleteAll = () => {
    for (const id of confirming) removeFromGallery(id)
    setConfirming([])
    setSel(EMPTY_SELECTION)
  }
  const actionsFor = (ids: readonly string[]) => ({
    move: () => setMoving([...ids]),
    download: () => { void downloadAll(ids) },
    remove: () => setConfirming(ids),
  })

  const bubble =
    'my-2 mr-2 rounded-xl bg-gray-50 dark:bg-[#1e1e1e] ring-1 ring-black/[0.04] dark:ring-white/[0.05] flex flex-col overflow-hidden shrink-0'

  return (
    <AnimatePresence mode="wait" initial={false}>
      {!open ? (
        /* Eingeklappt: EIN beschrifteter Knopf.
           Bis 2.6.7 standen hier zwei — PanelRightOpen („Expand gallery") und
           Images („Gallery"), getrennt durch einen Strich, der eine Gruppierung
           andeutete, die es nicht gab: beide riefen dasselbe
           `onOpenChange(true)` auf. Gemessen am 01.09.2026 (Chromium 149,
           1280x800): eine 59,8 x 273,9 px hohe Saeule, auf der zwei
           Piktogramme fuer denselben einen Befehl standen und der Name des
           Befehls nur im Hover-`title` stand.
           Der Strich und der zweite Knopf sind weg; der verbleibende traegt
           den Zaehler (dafuer war er da) und schreibt seinen Namen hin.
           „Gallery" misst in `t-label` 58,5 gerenderte px, deshalb 60 statt
           52 CSS-px Breite — die Buehne daneben gibt 9,2 px ab.
           Warum das ueberhaupt eine eigene Leiste bleibt: sie IST das Panel,
           nur zugeklappt. Beide Zustaende teilen `bubble` und liegen in
           derselben Layoutzeile wie die Buehne (siehe CreateExperimental), so
           dass Auf- und Zuklappen nur die Breite bewegt und nichts springt. */
        <motion.aside
          key="rail"
          className={cn(bubble, 'items-center py-2')}
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 60, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.15 }}
          style={{ width: 60 }}
        >
          <button
            onClick={() => onOpenChange(true)}
            title="Open the gallery" aria-label="Open the gallery"
            aria-expanded={false}
            className="relative flex flex-col items-center justify-center gap-1 w-full px-1 py-1.5 rounded-md text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-all"
          >
            <span className="relative">
              <Images size={16} />
              {all.length > 0 && (
                <span className="absolute -top-1.5 -right-2 min-w-[14px] h-[14px] px-0.5 flex items-center justify-center rounded-full text-[0.5rem] font-bold bg-gray-300 dark:bg-white/20 text-gray-700 dark:text-gray-200">
                  {all.length}
                </span>
              )}
            </span>
            <span className="t-label">Gallery</span>
          </button>
        </motion.aside>
      ) : (
        /* Expanded: vertical thumbnail grid. */
        <motion.aside
          key="full"
          className={bubble}
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 260, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.15 }}
          style={{ width: 260 }}
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-white/[0.05] shrink-0">
            <button
              onClick={() => onOpenChange(false)}
              title="Collapse gallery" aria-label="Collapse gallery"
              className="flex items-center justify-center w-6 h-6 rounded text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-all"
            >
              <PanelRightClose size={14} />
            </button>
            <Images size={13} className="text-gray-500" />
            <span className="t-label text-gray-400">Gallery</span>
            {count > 0 && <span className="t-mono text-gray-600">{count}</span>}
          </div>

          <FolderFilter />
          <OnBody><MoveToFolderModal ids={moving} onClose={() => setMoving([])} /></OnBody>
          <OnBody>
            <Modal open={confirming.length > 0} onClose={() => setConfirming([])} title="Delete from the gallery" maxWidth="max-w-md">
              <div data-testid="gallery-delete-confirm">
                <p className="t-body text-gray-700 dark:text-gray-200">{deleteConfirmLine(confirming.length, isMlxImageHost())}</p>
                <ModalActions>
                  <ModalButton onClick={() => setConfirming([])}>Cancel</ModalButton>
                  <ModalButton variant="danger" onClick={deleteAll}>
                    {confirming.length > 1 ? `Delete ${confirming.length}` : 'Delete'}
                  </ModalButton>
                </ModalActions>
              </div>
            </Modal>
          </OnBody>
          {menu && selecting && (
            <ContextMenu
              items={buildGalleryMenu(actionsFor(sel.ids), sel.ids.length)}
              x={menu.x}
              y={menu.y}
              label={sel.ids.length > 1 ? `Actions for ${sel.ids.length} items` : 'Actions for this item'}
              onClose={() => setMenu(null)}
            />
          )}
          {selecting && (
            <div
              role="toolbar"
              aria-label="Selected items"
              className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-200 dark:border-white/[0.05] shrink-0"
            >
              <span className="t-label text-gray-500 dark:text-gray-400 mr-auto" aria-live="polite">{sel.ids.length} selected</span>
              <BarBtn title="Move to folder" onClick={actionsFor(sel.ids).move}><FolderInput size={13} /></BarBtn>
              <BarBtn title="Download" onClick={actionsFor(sel.ids).download}><Download size={13} /></BarBtn>
              <BarBtn title="Delete" danger onClick={actionsFor(sel.ids).remove}><Trash2 size={13} /></BarBtn>
              <BarBtn title="Clear selection" onClick={() => setSel(EMPTY_SELECTION)}><X size={13} /></BarBtn>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-3">
            {count === 0 ? (
              <p className="t-body text-gray-500 py-2">{all.length > 0 ? 'Nothing in this folder yet.' : 'Nothing generated yet.'}</p>
            ) : (
              <div className="grid grid-cols-2 gap-2" role="group" aria-label="Gallery items" onKeyDown={onGridKey}>
                {gallery.map((g) => (
                  <div key={g.id} className="relative group">
                    <button
                      onClick={(e) => onTileClick(e, g.id)}
                      onContextMenu={(e) => onTileMenu(e, g.id)}
                      data-gallery-id={g.id}
                      aria-pressed={selecting ? picked.has(g.id) : undefined}
                      title={g.sourceName ? `From ${g.sourceName}` : undefined}
                      draggable={g.type === 'image' && !g.unavailable}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(GALLERY_DRAG_TYPE, g.id)
                        e.dataTransfer.effectAllowed = 'copy'
                      }}
                      className={cn(
                        'w-full aspect-square rounded-lg overflow-hidden border-2 transition-colors relative',
                        picked.has(g.id)
                          ? 'border-blue-500 dark:border-blue-400'
                          : (activeId ?? gallery[0]?.id) === g.id ? 'border-gray-900/60 dark:border-white/60' : 'border-transparent hover:border-white/20',
                        itemHasAlpha(g) && 'lu-checker',
                      )}
                    >
                      <GalleryThumb g={g} />
                      {g.unavailable && (
                        <span
                          className="lu-on-dark absolute inset-0 flex items-center justify-center bg-black/50 text-gray-500"
                          title={unavailableTitle(g.unavailableReason === 'gone', isMlxImageHost())}
                        >
                          <MonitorOff size={16} />
                        </span>
                      )}
                      {picked.has(g.id) && (
                        <span className="lu-on-dark absolute top-1 left-1 w-5 h-5 rounded-full bg-blue-500 text-white flex items-center justify-center shadow-sm" aria-hidden>
                          <Check size={12} />
                        </span>
                      )}
                    </button>
                    <button
                      onClick={() => removeFromGallery(g.id)}
                      className="lu-on-dark absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-red-600/90 hover:bg-red-600 text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
                      title={deleteTitle(isMlxImageHost())}
                    >
                      <Trash2 size={12} />
                    </button>
                    <button
                      onClick={() => setMoving([g.id])}
                      className="lu-on-dark absolute bottom-1 left-1 w-6 h-6 rounded-md bg-black/55 hover:bg-black/70 text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
                      title="Move to folder" aria-label="Move to folder"
                    >
                      <FolderInput size={12} />
                    </button>
                    <button
                      onClick={() => { void downloadGalleryItem(g) }}
                      className="lu-on-dark absolute bottom-1 right-1 w-6 h-6 rounded-md bg-black/55 hover:bg-black/70 text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
                      title="Download"
                    >
                      <Download size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

function BarBtn({ children, title, onClick, danger }: { children: React.ReactNode; title: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        'flex items-center justify-center w-6 h-6 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors',
        danger ? 'hover:text-red-600 dark:hover:text-red-400' : 'hover:text-gray-800 dark:hover:text-gray-200',
      )}
    >
      {children}
    </button>
  )
}

// One thumbnail. Its own component so it can use the useComfyMedia hook (which
// falls back to the Rust proxy when a user-managed ComfyUI 0.19+ 403s the
// direct /view load, #75) — hooks can't run inside the gallery .map().
function GalleryThumb({ g }: { g: GalleryItem }) {
  const { src, onError, onLoad } = useComfyMedia(g)
  if (g.type === 'audio') {
    // No visual to thumbnail — a labeled tile; the Stage viewer holds the
    // actual <audio> player.
    return (
      <span className="w-full h-full flex flex-col items-center justify-center gap-1 bg-white/[0.03] text-gray-400 p-1">
        <AudioLines size={16} />
        <span className="t-label truncate max-w-full px-1">{galleryLabel(g)}</span>
      </span>
    )
  }
  return playsAsVideo(g) ? (
    <>
      <video src={src} muted playsInline onError={onError} onLoadedData={onLoad} className="w-full h-full object-cover" />
      <span className="absolute inset-0 flex items-center justify-center bg-black/20"><Play size={16} className="text-white/90" /></span>
    </>
  ) : (
    <img src={src} alt="" onError={onError} onLoad={onLoad} className="w-full h-full object-cover" />
  )
}
