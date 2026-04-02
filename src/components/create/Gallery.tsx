import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Trash2, Download, ChevronDown, ChevronUp } from 'lucide-react'
import { getImageUrl } from '../../api/comfyui'
import { useCreateStore, type GalleryItem } from '../../stores/createStore'

const PAGE_SIZE = 20

export function Gallery() {
  const { gallery, removeFromGallery, clearGallery } = useCreateStore()
  const [expanded, setExpanded] = useState(true)
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<GalleryItem | null>(null)

  if (gallery.length === 0) {
    return (
      <div className="border-t border-gray-200 dark:border-white/5 px-4 py-3">
        <p className="text-xs text-gray-400 text-center">No images generated yet</p>
      </div>
    )
  }

  const totalPages = Math.ceil(gallery.length / PAGE_SIZE)
  const visible = gallery.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const handleDownload = (item: GalleryItem) => {
    const url = getImageUrl(item.filename, item.subfolder)
    const a = document.createElement('a')
    a.href = url
    a.download = item.filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  return (
    <>
      <div className="border-t border-gray-200 dark:border-white/5">
        {/* Header */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center justify-between w-full px-4 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
          aria-label="Toggle gallery"
        >
          <span>Gallery ({gallery.length})</span>
          <div className="flex items-center gap-2">
            {gallery.length > 0 && (
              <span
                onClick={(e) => { e.stopPropagation(); if (confirm('Clear all gallery items?')) clearGallery() }}
                className="text-red-400 hover:text-red-500 transition-colors"
                role="button"
                aria-label="Clear gallery"
              >
                Clear
              </span>
            )}
            {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </div>
        </button>

        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: 'auto' }}
              exit={{ height: 0 }}
              className="overflow-hidden"
            >
              <div className="flex gap-2 overflow-x-auto scrollbar-thin px-4 pb-3">
                {visible.map((item, i) => {
                  const url = getImageUrl(item.filename, item.subfolder)
                  return (
                    <motion.div
                      key={item.id}
                      className={`relative group shrink-0 cursor-pointer rounded-lg overflow-hidden border-2 transition-colors ${
                        selected?.id === item.id ? 'border-purple-500' : 'border-transparent'
                      }`}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: i * 0.02 }}
                      onClick={() => setSelected(selected?.id === item.id ? null : item)}
                    >
                      {item.type === 'video' ? (
                        <video
                          src={url}
                          className="w-20 h-20 object-cover"
                          muted
                          playsInline
                          onMouseEnter={(e) => e.currentTarget.play()}
                          onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0 }}
                        />
                      ) : (
                        <img src={url} alt="" className="w-20 h-20 object-cover" loading="lazy" />
                      )}
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDownload(item) }}
                          className="p-1.5 rounded bg-white/20 text-white hover:bg-white/30"
                          title="Download"
                          aria-label="Download image"
                        >
                          <Download size={12} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); removeFromGallery(item.id) }}
                          className="p-1.5 rounded bg-red-500/50 text-white hover:bg-red-500/70"
                          title="Delete"
                          aria-label="Delete image"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </motion.div>
                  )
                })}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 px-4 pb-2 text-xs text-gray-400">
                  <button
                    onClick={() => setPage(Math.max(0, page - 1))}
                    disabled={page === 0}
                    className="disabled:opacity-30"
                    aria-label="Previous page"
                  >
                    Prev
                  </button>
                  <span>{page + 1} / {totalPages}</span>
                  <button
                    onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                    disabled={page >= totalPages - 1}
                    className="disabled:opacity-30"
                    aria-label="Next page"
                  >
                    Next
                  </button>
                </div>
              )}

              {/* Selected item info */}
              {selected && (
                <div className="px-4 pb-2 flex items-center gap-2 text-xs text-gray-400">
                  <span className="truncate flex-1">{selected.prompt}</span>
                  <span>{selected.width}x{selected.height}</span>
                  <span>Seed: {selected.seed}</span>
                  <span>{selected.sampler}/{selected.scheduler}</span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  )
}
