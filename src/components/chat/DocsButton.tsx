/**
 * The Docs button in the composer action row.
 *
 * Its own file since A9, because it now has three states instead of two and a
 * state you cannot render in a test is a state nobody has checked.
 */
import { FileText } from 'lucide-react'
import type { DocsAvailability } from '../../lib/docs-availability'

interface Props {
  availability: DocsAvailability
  /** The RAG panel is open. */
  open: boolean
  /** RAG is switched on for this conversation. */
  ragEnabled: boolean
  /** Documents indexed for this conversation. */
  docCount: number
  onToggle: () => void
}

export function DocsButton({ availability, open, ragEnabled, docCount, onToggle }: Props) {
  if (!availability.visible) return null
  return (
    <button
      data-testid="docs-toggle"
      data-needs-setup={availability.needsSetup ? 'true' : 'false'}
      onClick={onToggle}
      disabled={!availability.enabled}
      // Der Ein-Zustand (Panel offen ODER RAG an) kommt aus ARIA, nicht aus
      // einer zweiten Klassenkette: `.lu-control` liest `aria-pressed` und
      // setzt den Behaelter. Vorher war Ein ein gruenes Pill mit eigenem
      // Rand, also eine achte Formsprache in einer Leiste, die nur noch zwei
      // kennt (composer-grammar.test.ts).
      aria-pressed={open || ragEnabled}
      title={availability.title}
      // Damped, not dead. The panel behind this button is the only place that
      // can install the embedding engine, so disabling it would lock the door
      // to the repair shop (review B1). Die Daempfung ist das EINZIGE, was
      // diese Call-Site dem Rezept hinzufuegt; Farbe, Hover und der
      // Ein-Behaelter kommen aus `.lu-control`.
      className={'lu-control' + (availability.needsSetup ? ' opacity-60' : '')}
    >
      <FileText size={11} />
      <span>Docs</span>
      {docCount > 0 && (
        <span
          className={
            'min-w-[12px] h-[12px] flex items-center justify-center rounded-full text-[0.45rem] font-bold ' +
            (ragEnabled ? 'bg-green-500 text-white' : 'bg-white/15 text-gray-300')
          }
        >
          {docCount}
        </span>
      )}
    </button>
  )
}
