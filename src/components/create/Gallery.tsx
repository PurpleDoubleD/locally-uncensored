import { motion } from 'framer-motion'
import { Trash2, Download } from 'lucide-react'
import { getImageUrl } from '../../api/comfyui'
import { useCreateStore, type GalleryItem } from '../../stores/createStore'

interface Props {
  onSelect?: (item: GalleryItem) => void
}

export function Gallery({ onSelect }: Props) {
  const { gallery, removeFromGallery } = useCreateStore()

  if (gallery.length === 0) return null

  return (
    <div className="border-t border-gray-200 dark:border-white/5 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-600 dark:text-gray-400">Gallery ({gallery.length})</h3>
      </div>
      <div className="flex gap-2 overflow-x-auto scrollbar-thin pb-2">
        {gallery.map((item, i) => {
          const url = getImageUrl(item.filename, item.subfolder)
          return (
            <motion.div
              key={item.id}
              className="relative group shrink-0 cursor-pointer"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.03 }}
              onClick={() => onSelect?.(item)}
            >
              {item.type === 'video' ? (
                <video
                  src={url}
                  className="w-20 h-20 object-cover rounded-lg border border-gray-200 dark:border-white/10"
                  muted
                />
              ) : (
                <img
                  src={url}
                  alt={item.prompt}
                  className="w-20 h-20 object-cover rounded-lg border border-gray-200 dark:border-white/10"
                />
              )}
              <div className="absolute inset-0 bg-black/50 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    const a = document.createElement('a')
                    a.href = url
                    a.download = item.filename
                    a.click()
                  }}
                  className="p-1 rounded bg-white/20 text-white hover:bg-white/30"
                >
                  <Download size={12} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    removeFromGallery(item.id)
                  }}
                  className="p-1 rounded bg-red-500/50 text-white hover:bg-red-500/70"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}
