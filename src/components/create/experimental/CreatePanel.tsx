import { motion, AnimatePresence } from 'framer-motion'
import { Images, Play, PanelRightClose, Trash2, Download, MonitorOff, AudioLines } from 'lucide-react'
import { downloadMediaUrl } from '../../../lib/download-media'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { galleryItemUrl } from './galleryUrl'
import { useComfyMedia } from './useComfyMedia'
import { cn } from '../ui/cn'

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
  const gallery = useCreateStore((s) => s.gallery)
  const removeFromGallery = useCreateStore((s) => s.removeFromGallery)
  const count = gallery.length

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
              {count > 0 && (
                <span className="absolute -top-1.5 -right-2 min-w-[14px] h-[14px] px-0.5 flex items-center justify-center rounded-full text-[0.5rem] font-bold bg-gray-300 dark:bg-white/20 text-gray-700 dark:text-gray-200">
                  {count}
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

          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-3">
            {count === 0 ? (
              <p className="t-body text-gray-500 py-2">Nothing generated yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {gallery.map((g) => (
                  <div key={g.id} className="relative group">
                    <button
                      onClick={() => onSelect(g.id)}
                      className={cn(
                        'w-full aspect-square rounded-lg overflow-hidden border-2 transition-colors relative',
                        (activeId ?? gallery[0]?.id) === g.id ? 'border-white/60' : 'border-transparent hover:border-white/20',
                        g.intent === 'removebg' && 'lu-checker',
                      )}
                    >
                      <GalleryThumb g={g} />
                      {g.unavailable && (
                        <span
                          className="absolute inset-0 flex items-center justify-center bg-black/50 text-gray-500"
                          title="Local render, but the local engine isn't reachable"
                        >
                          <MonitorOff size={16} />
                        </span>
                      )}
                    </button>
                    <button
                      onClick={() => removeFromGallery(g.id)}
                      className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-red-600/90 hover:bg-red-600 text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                    <button
                      onClick={() => { void downloadMediaUrl(galleryItemUrl(g), g.filename || undefined) }}
                      className="absolute bottom-1 right-1 w-6 h-6 rounded-md bg-black/55 hover:bg-black/70 text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
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
        <span className="t-label truncate max-w-full px-1">{g.prompt || 'Audio'}</span>
      </span>
    )
  }
  return g.type === 'video' ? (
    <>
      <video src={src} muted playsInline onError={onError} onLoadedData={onLoad} className="w-full h-full object-cover" />
      <span className="absolute inset-0 flex items-center justify-center bg-black/20"><Play size={16} className="text-white/90" /></span>
    </>
  ) : (
    <img src={src} alt="" onError={onError} onLoad={onLoad} className="w-full h-full object-cover" />
  )
}
