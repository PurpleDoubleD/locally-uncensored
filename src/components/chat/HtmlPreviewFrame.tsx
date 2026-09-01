/**
 * The sandboxed iframe plus its viewport switcher, shared by the model-snippet
 * modal (HtmlPreviewModal) and the Explorer panel's file preview (2.6.6 C3).
 *
 * `allowScripts` is the whole reason this is a prop and not a constant. A
 * snippet the model just wrote is code the user asked for; a file the user
 * clicked in their repository is code they asked to LOOK at. The panel passes
 * false and offers a per-file opt-in, the modal keeps its old behaviour.
 * `allow-same-origin` is never set on either path.
 */

import { Smartphone, Tablet, Monitor } from 'lucide-react'
import { VIEWPORTS, type Viewport } from '../../lib/html-preview'
import { sandboxAttr } from '../../lib/file-preview'

interface FrameProps {
  doc: string
  viewport: Viewport
  allowScripts: boolean
  /** Bumping this remounts the iframe, which is how "reload" works. */
  reloadKey?: number
  title?: string
  className?: string
}

export function HtmlPreviewFrame({
  doc,
  viewport,
  allowScripts,
  reloadKey = 0,
  title = 'HTML Preview',
  className,
}: FrameProps) {
  const dims = VIEWPORTS[viewport]
  return (
    <iframe
      key={reloadKey}
      srcDoc={doc}
      sandbox={sandboxAttr(allowScripts)}
      referrerPolicy="no-referrer"
      title={title}
      className={
        className ??
        'bg-white border border-gray-200 dark:border-white/10 shadow-lg rounded transition-[width,height]'
      }
      style={{
        width: viewport === 'desktop' ? '100%' : `${dims.width}px`,
        height: viewport === 'desktop' ? '100%' : `${dims.height}px`,
        maxWidth: '100%',
        maxHeight: '100%',
      }}
    />
  )
}

interface SwitcherProps {
  viewport: Viewport
  onChange: (v: Viewport) => void
  /** The panel sits in a 280px column, so its buttons are smaller. */
  compact?: boolean
}

export function ViewportSwitcher({ viewport, onChange, compact }: SwitcherProps) {
  return (
    <div className="flex items-center gap-0.5 bg-gray-100 dark:bg-white/[0.04] rounded-md p-0.5">
      <ViewportBtn icon={Smartphone} active={viewport === 'mobile'} onClick={() => onChange('mobile')} label="Mobile" compact={compact} />
      <ViewportBtn icon={Tablet} active={viewport === 'tablet'} onClick={() => onChange('tablet')} label="Tablet" compact={compact} />
      <ViewportBtn icon={Monitor} active={viewport === 'desktop'} onClick={() => onChange('desktop')} label="Desktop" compact={compact} />
    </div>
  )
}

interface ViewportBtnProps {
  icon: typeof Smartphone
  active: boolean
  onClick: () => void
  label: string
  compact?: boolean
}

function ViewportBtn({ icon: Icon, active, onClick, label, compact }: ViewportBtnProps) {
  return (
    <button
      onClick={onClick}
      className={
        // D-T07: der normale Knopf stand auf `w-7 h-7` (28px) — zwei Pixel neben
        // `--control-h-sm`, der Hoehe, auf der `.lu-control` und der
        // Modellwaehler schon stehen. Die kompakte Variante bleibt bei 20px:
        // sie sitzt in einer Leiste, die selbst nur 26px hoch ist, und hat
        // unterhalb der kleinsten Stufe bewusst keine Sprosse.
        `flex items-center justify-center ${compact ? 'w-5 h-5' : 'w-[var(--control-h-sm)] h-[var(--control-h-sm)]'} rounded transition-colors ` +
        (active
          ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm'
          : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white')
      }
      aria-label={label}
      title={label}
    >
      <Icon size={compact ? 10 : 13} />
    </button>
  )
}
