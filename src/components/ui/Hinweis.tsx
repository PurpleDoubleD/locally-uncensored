import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { HINWEIS_TEXT, HINWEIS_ZEILE, type HinweisTon } from '../../lib/hinweis'

/**
 * Eine Anmerkung oder eine Fehlermeldung. Eine Zeile, kein Kasten.
 *
 * Die Begruendung fuer die zwei Toene und fuer das Fehlen des dritten steht in
 * `lib/hinweis.ts`. Hier steht nur, wie die Zeile gebaut ist.
 *
 * `role`: ein Fehler ist eine `alert` und wird vom Screenreader unterbrochen
 * vorgelesen, ein ruhiger Hinweis ist ein `status` und wartet, bis der Nutzer
 * ohnehin zuhoert. Das ist derselbe Unterschied, den die beiden Toene optisch
 * machen, nur fuer Ohren.
 */
interface Props {
  ton?: HinweisTon
  /** Ein Symbol vor dem Text. Ohne Symbol ist auch in Ordnung, oft besser. */
  icon?: ReactNode
  /** Wenn gesetzt, bekommt die Zeile ein Kreuz zum Wegklicken. */
  onDismiss?: () => void
  className?: string
  children: ReactNode
}

export function Hinweis({ ton = 'ruhig', icon, onDismiss, className, children }: Props) {
  return (
    <div
      role={ton === 'fehler' ? 'alert' : 'status'}
      className={`${HINWEIS_ZEILE} ${HINWEIS_TEXT[ton]} ${className ?? ''}`}
    >
      {icon}
      <span className="flex-1 min-w-0">{children}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="shrink-0 rounded p-[1px] opacity-70 hover:opacity-100 transition-opacity"
          aria-label="Dismiss"
          title="Dismiss"
        >
          <X size={11} />
        </button>
      )}
    </div>
  )
}
