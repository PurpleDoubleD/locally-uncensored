import { useState } from 'react'
import { Info } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { ICON_SM } from '../ui/icon-size'

/**
 * The Details button of a tile whose description is cut to a line or two,
 * and the dialog with the whole text. Chat tiles have their own (DiscoverModels,
 * with tags and the image part); the image, video, add-on, Mac media and
 * CivitAI tiles had none, and the rest of their description was out of reach
 * (Discord #bug-reports 30.10.2026).
 */
export function DescriptionDetails({ name, description, className }: { name: string; description: string; className: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={className}
        title="Details"
        aria-label={`Details for ${name}`}
      >
        <Info size={ICON_SM} />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={name}>
        <p className="t-small text-gray-700 dark:text-gray-200 leading-relaxed whitespace-pre-line" data-testid="description-details">{description}</p>
      </Modal>
    </>
  )
}
