import { motion, AnimatePresence } from 'framer-motion'
import { Images, Play, PanelRightClose, PanelRightOpen, Trash2, Download, MonitorOff } from 'lucide-react'
import { downloadMediaUrl } from '../../../lib/download-media'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { markGalleryItemAvailable, recoverGalleryUrl, revokeGalleryBlob } from './galleryUrl'
import { useResolvedMediaUrl } from './useResolvedMediaUrl'
import { cn } from '../ui/cn'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  activeId: string | null
  onSelect: (id: string) => void
}

/** One gallery thumbnail. A component (not inline JSX) so useResolvedMediaUrl —
 *  which proxies remote-ComfyUI media into a blob: URL — can run per item; hooks
 *  can't be called inside a .map callback. */
function GalleryTile({ g, active, onSelect, onRemove }: {
  g: GalleryItem
  active: boolean
  onSelect: (id: string) => void
  onRemove: (id: string) => void
}) {
  const url = useResolvedMediaUrl(g)
  return (
    <div className="relative group">
      <button
        onClick={() => onSelect(g.id)}
        className={cn(
          'w-full aspect-square rounded-lg overflow-hidden border-2 transition-colors relative',
          active ? 'border-white/60' : 'border-transparent hover:border-white/20',
          g.intent === 'removebg' && 'lu-checker',
        )}
      >
        {g.type === 'video' ? (
          <>
            <video src={url} muted playsInline onError={() => recoverGalleryUrl(g)} onLoadedData={() => markGalleryItemAvailable(g)} className="w-full h-full object-cover" />
            <span className="absolute inset-0 flex items-center justify-center bg-black/20"><Play size={16} className="text-white/90" /></span>
          </>
        ) : (
          <img src={url} alt="" onError={() => recoverGalleryUrl(g)} onLoad={() => markGalleryItemAvailable(g)} className="w-full h-full object-cover" />
        )}
        {g.unavailable && (
          <span
            className="absolute inset-0 flex items-center justify-center bg-black/50 text-gray-500"
            title="Local render — the local engine isn't reachable"
          >
            <MonitorOff size={16} />
          </span>
        )}
      </button>
      <button
        onClick={() => onRemove(g.id)}
        className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-red-600/90 hover:bg-red-600 text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
        title="Delete"
      >
        <Trash2 size={12} />
      </button>
      <button
        onClick={() => { void downloadMediaUrl(url, g.filename || undefined) }}
        className="absolute bottom-1 right-1 w-6 h-6 rounded-md bg-black/55 hover:bg-black/70 text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
        title="Download"
      >
        <Download size={12} />
      </button>
    </div>
  )
}

/**
 * The right-hand Gallery panel — matched 1:1 with the web companion: a floating
 * bubble that collapses to a slim icon rail (default) and expands into a
 * vertical thumbnail grid, replacing the old bottom strip. Keeps the desktop's
 * local-availability affordances (recover/mark, the "unavailable" overlay).
 */
export function CreatePanel({ open, onOpenChange, activeId, onSelect }: Props) {
  const gallery = useCreateStore((s) => s.gallery)
  const removeFromGallery = useCreateStore((s) => s.removeFromGallery)
  const count = gallery.length

  // Revoke any proxied blob: URL before dropping the item, so a long session
  // doesn't leak object URLs for deleted remote-ComfyUI renders.
  const handleRemove = (id: string) => { revokeGalleryBlob(id); removeFromGallery(id) }

  const bubble =
    'my-2 mr-2 rounded-xl bg-gray-50 dark:bg-[#1e1e1e] ring-1 ring-black/[0.04] dark:ring-white/[0.05] flex flex-col overflow-hidden shrink-0'

  return (
    <AnimatePresence mode="wait" initial={false}>
      {!open ? (
        /* Collapsed: slim icon rail (default). */
        <motion.aside
          key="rail"
          className={cn(bubble, 'items-center py-2 gap-1')}
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 52, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.15 }}
          style={{ width: 52 }}
        >
          <button onClick={() => onOpenChange(true)} title="Expand gallery" aria-label="Expand gallery" className="flex items-center justify-center w-9 h-9 rounded-md text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-all">
            <PanelRightOpen size={16} />
          </button>
          <div className="w-6 h-px bg-gray-200 dark:bg-white/10 my-1" />
          <button
            onClick={() => onOpenChange(true)}
            title="Gallery" aria-label="Gallery"
            className="relative flex items-center justify-center w-9 h-9 rounded-md text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-all"
          >
            <Images size={16} />
            {count > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 flex items-center justify-center rounded-full text-[0.5rem] font-bold bg-gray-300 dark:bg-white/20 text-gray-700 dark:text-gray-200">
                {count}
              </span>
            )}
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

          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-3">
            {count === 0 ? (
              <p className="t-body text-gray-500 py-2">Nothing generated yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {gallery.map((g) => (
                  <GalleryTile
                    key={g.id}
                    g={g}
                    active={(activeId ?? gallery[0]?.id) === g.id}
                    onSelect={onSelect}
                    onRemove={handleRemove}
                  />
                ))}
              </div>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
