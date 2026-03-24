import { motion } from 'framer-motion'
import { Download, Maximize2 } from 'lucide-react'
import { getImageUrl } from '../../api/comfyui'
import { useCreateStore, type GalleryItem } from '../../stores/createStore'
import { ProgressBar } from '../ui/ProgressBar'

interface Props {
  onFullscreen?: (item: GalleryItem) => void
}

export function OutputDisplay({ onFullscreen }: Props) {
  const { isGenerating, progress, gallery } = useCreateStore()
  const latest = gallery[0]

  if (isGenerating) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="w-full max-w-sm space-y-4">
          <motion.div
            className="w-16 h-16 mx-auto rounded-2xl bg-gray-100 dark:bg-white/5 flex items-center justify-center"
            animate={{ rotate: 360 }}
            transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
          >
            <span className="text-2xl">🎨</span>
          </motion.div>
          <p className="text-center text-gray-500 text-sm">Generating...</p>
          <ProgressBar progress={progress} />
        </div>
      </div>
    )
  }

  if (!latest) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-gray-100 dark:bg-white/5 flex items-center justify-center mb-4">
            <span className="text-2xl">🖼️</span>
          </div>
          <p className="text-gray-500 text-sm">Your creations will appear here</p>
        </div>
      </div>
    )
  }

  const url = getImageUrl(latest.filename, latest.subfolder)

  const handleDownload = () => {
    const a = document.createElement('a')
    a.href = url
    a.download = latest.filename
    a.click()
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4 relative group">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative max-w-full max-h-full"
      >
        {latest.type === 'video' ? (
          <video
            src={url}
            controls
            autoPlay
            loop
            className="max-w-full max-h-[60vh] rounded-xl border border-gray-200 dark:border-white/10"
          />
        ) : (
          <img
            src={url}
            alt={latest.prompt}
            className="max-w-full max-h-[60vh] rounded-xl border border-gray-200 dark:border-white/10 object-contain"
          />
        )}
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {onFullscreen && (
            <button
              onClick={() => onFullscreen(latest)}
              className="p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
            >
              <Maximize2 size={14} />
            </button>
          )}
          <button
            onClick={handleDownload}
            className="p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
          >
            <Download size={14} />
          </button>
        </div>
      </motion.div>
      <p className="text-xs text-gray-400 mt-2 truncate max-w-md">{latest.prompt}</p>
    </div>
  )
}
