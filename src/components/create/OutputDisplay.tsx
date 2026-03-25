import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Download, Maximize2, X, Copy, Check, RefreshCw } from 'lucide-react'
import { getImageUrl } from '../../api/comfyui'
import { useCreateStore, type GalleryItem } from '../../stores/createStore'

export function OutputDisplay() {
  const { isGenerating, progress, progressText, gallery } = useCreateStore()
  const [fullscreen, setFullscreen] = useState<GalleryItem | null>(null)
  const [copiedSeed, setCopiedSeed] = useState(false)
  const latest = gallery[0]

  const handleDownload = (item: GalleryItem) => {
    const url = getImageUrl(item.filename, item.subfolder)
    const a = document.createElement('a')
    a.href = url
    a.download = item.filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const copySeed = (seed: number) => {
    navigator.clipboard.writeText(String(seed))
    setCopiedSeed(true)
    setTimeout(() => setCopiedSeed(false), 1500)
  }

  // Generating state
  if (isGenerating) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="w-full max-w-sm space-y-4">
          <motion.div
            className="w-16 h-16 mx-auto rounded-2xl bg-gray-100 dark:bg-white/5 flex items-center justify-center"
            animate={{ scale: [1, 1.1, 1] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          >
            <span className="text-2xl">{useCreateStore.getState().mode === 'video' ? '🎬' : '🎨'}</span>
          </motion.div>
          <div className="space-y-2">
            <div className="w-full bg-gray-200 dark:bg-white/10 rounded-full h-2 overflow-hidden">
              <motion.div
                className="bg-purple-500 h-full rounded-full"
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
            <p className="text-center text-gray-500 dark:text-gray-400 text-xs">{progressText || `${Math.round(progress)}%`}</p>
          </div>
        </div>
      </div>
    )
  }

  // Empty state
  if (!latest) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-gray-100 dark:bg-white/5 flex items-center justify-center mb-4">
            <span className="text-2xl">🖼</span>
          </div>
          <p className="text-gray-400 dark:text-gray-500 text-sm">Your creations will appear here</p>
          <p className="text-gray-300 dark:text-gray-600 text-xs mt-1">Write a prompt and hit Generate</p>
        </div>
      </div>
    )
  }

  // Show latest result
  const url = getImageUrl(latest.filename, latest.subfolder)

  return (
    <>
      <div className="flex-1 flex flex-col items-center justify-center p-4 relative group min-h-0">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="relative max-w-full max-h-full flex flex-col items-center"
        >
          {latest.type === 'video' ? (
            <video
              src={url}
              controls
              autoPlay
              loop
              className="max-w-full max-h-[50vh] rounded-xl border border-gray-200 dark:border-white/10"
            />
          ) : (
            <img
              src={url}
              alt={latest.prompt}
              className="max-w-full max-h-[50vh] rounded-xl border border-gray-200 dark:border-white/10 object-contain cursor-pointer"
              onClick={() => setFullscreen(latest)}
            />
          )}

          {/* Hover controls */}
          <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
            <button
              onClick={() => setFullscreen(latest)}
              className="p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
              title="Fullscreen"
            >
              <Maximize2 size={14} />
            </button>
            <button
              onClick={() => handleDownload(latest)}
              className="p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
              title="Download"
            >
              <Download size={14} />
            </button>
          </div>
        </motion.div>

        {/* Info bar */}
        <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
          <span className="truncate max-w-xs">{latest.prompt}</span>
          <span>·</span>
          <button
            onClick={() => copySeed(latest.seed)}
            className="flex items-center gap-1 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            title="Copy seed"
          >
            Seed: {latest.seed} {copiedSeed ? <Check size={10} /> : <Copy size={10} />}
          </button>
          <span>·</span>
          <span>{latest.width}x{latest.height}</span>
        </div>
      </div>

      {/* Fullscreen overlay */}
      <AnimatePresence>
        {fullscreen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
            onClick={() => setFullscreen(null)}
          >
            <button
              className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 z-50"
              onClick={() => setFullscreen(null)}
            >
              <X size={20} />
            </button>
            <button
              className="absolute top-4 right-14 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 z-50"
              onClick={(e) => { e.stopPropagation(); handleDownload(fullscreen) }}
            >
              <Download size={20} />
            </button>
            {fullscreen.type === 'video' ? (
              <video
                src={getImageUrl(fullscreen.filename, fullscreen.subfolder)}
                controls
                autoPlay
                loop
                className="max-w-[95vw] max-h-[95vh]"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <img
                src={getImageUrl(fullscreen.filename, fullscreen.subfolder)}
                alt={fullscreen.prompt}
                className="max-w-[95vw] max-h-[95vh] object-contain"
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
