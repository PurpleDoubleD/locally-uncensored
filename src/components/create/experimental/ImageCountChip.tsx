import { useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Images } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import { clampImageCount, composerImageCountMax } from '../../../lib/render/image-count'
import { usePopoverPlatz } from '../../../hooks/usePopoverPlatz'
import { useRunCredits } from './useRunCredits'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/Segmented'
import { cn } from '../ui/cn'
import { useClickAway } from '../ui/useClickAway'

/**
 * D23 (Discord): "several images per prompt" existed (Batch size 1 to 8
 * locally, Images 1 to 4 in the cloud) but only inside Advanced settings, so
 * nobody found it. This chip sits in the action bar next to Create: an icon
 * and the number, and one click opens the choice. It writes the same store
 * fields as the sliders in Advanced settings, which stay where they are.
 * It shows only where the run really makes more than one picture
 * (composerImageCountMax).
 */
export function ImageCountChip() {
  const intent = useCreateStore((s) => s.intent())
  const backend = useCreateStore((s) => s.backend)
  const batchSize = useCreateStore((s) => s.batchSize)
  const setBatchSize = useCreateStore((s) => s.setBatchSize)
  const cloudImageCount = useCreateStore((s) => s.cloudImageCount)
  const setCloudImageCount = useCreateStore((s) => s.setCloudImageCount)
  const run = useRunCredits()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panel = usePopoverPlatz(panelRef, open, { bevorzugt: 'oben', abstand: 6 })
  useClickAway(ref, () => setOpen(false), open)

  const max = composerImageCountMax(backend, intent)
  if (max == null) return null
  const cloud = backend === 'cloud'
  const value = cloud ? clampImageCount(cloudImageCount) : Math.max(1, Math.min(max, batchSize))
  const setValue = cloud ? setCloudImageCount : setBatchSize
  const label = value === 1 ? '1 image per run' : `${value} images per run`

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="sm"
        icon={Images}
        active={open}
        title={`Images per run: ${value}`}
        ariaLabel={`Images per run: ${value}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="t-mono">{value}</span>
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            style={panel.style}
            initial={{ opacity: 0, y: panel.nachOben ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: panel.nachOben ? 4 : -4 }}
            transition={{ duration: 0.12 }}
            className={cn('lu-elevated absolute right-0 z-50 rounded-lg p-2 space-y-1.5', panel.nachOben ? 'bottom-full mb-1.5' : 'top-full mt-1.5')}
          >
            <span className="block t-label text-gray-500">Images per run</span>
            <Segmented
              size="sm"
              layoutId="composer-image-count"
              ariaLabel="Images per run"
              value={String(value)}
              onChange={(v) => setValue(Number(v))}
              options={Array.from({ length: max }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
            />
            <span className="block t-micro text-gray-600">
              {cloud && value > 1 && run ? `${label}, ${run.cost} credits in all` : label}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
