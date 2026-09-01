import { useEffect, useState } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { isMacOS } from '../../api/backend'
import { ICON_SM } from '../ui/icon-size'

/**
 * Das Monogramm im Fensterbalken — 18px gross, und bis hierher aus einem
 * 512x512-PNG heruntergerechnet (Audit §2, Iconografie: „512x512-PNG auf
 * 18px heruntergerechnet, `LU-monogram.svg` mit 0 Verwendungen").
 *
 * Warum das falsch war: der Browser skaliert 512px auf 18px, also auf 3,5 %
 * der Kantenlaenge — jedes Zielpixel mittelt ueber rund 800 Quellpixel. Was
 * dabei herauskommt, ist eine weiche graue Wolke ohne die Kanten, die das
 * Zeichen ausmachen; und da der Balken zusaetzlich `invert` fuer den
 * Hellmodus darueberlegt, wird der Matsch auch noch umgedreht. Dazu haelt
 * jede Instanz 512 x 512 x 4 Byte = 1.048.576 Byte dekodierte Bitmap im
 * Speicher, um 18 x 18 Punkte zu zeigen.
 *
 * Die SVG-Fassung liegt seit jeher daneben (`public/LU-monogram.svg`) und
 * wurde nirgends benutzt ausser im HTML-Splash. Sie rastert bei JEDER
 * Fenstergroesse und jeder Geraetedichte auf die echte Zielkantenlaenge.
 *
 * Was das NICHT tut: den Boot-Chunk verkleinern. Beide Dateien liegen in
 * `public/` und werden von Vite unveraendert kopiert, nie gebuendelt — im
 * JS-Bundle steht in beiden Faellen nur der Pfad als String. Die Datei
 * selbst ist sogar groesser (11.179 statt 3.219 Byte), dafuer bereits vom
 * Splash in `index.html` geladen und damit beim ersten React-Frame im Cache.
 * Der messbare Gewinn ist die Rasterung, nicht das Gewicht.
 */
const MONOGRAM = '/LU-monogram.svg'

const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__

export function Titlebar() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!isTauri) return

    let unlisten: (() => void) | undefined

    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const win = getCurrentWindow()
      // Check initial state
      win.isMaximized().then(setIsMaximized)

      // Listen for resize to update maximize state
      win.onResized(() => {
        win.isMaximized().then(setIsMaximized)
      }).then((fn) => { unlisten = fn })
    })

    return () => { unlisten?.() }
  }, [])

  if (!isTauri) return null

  const handleMinimize = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    getCurrentWindow().minimize()
  }

  const handleToggleMaximize = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    getCurrentWindow().toggleMaximize()
  }

  const handleClose = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    getCurrentWindow().close()
  }

  const btnBase = 'inline-flex items-center justify-center w-[46px] h-8 transition-colors'

  // macOS uses the OS-native traffic lights (close/minimize/zoom) rendered on
  // the LEFT by titleBarStyle:"Overlay" (tauri.macos.conf.json). So on mac we
  // draw NO custom window buttons — we just reserve space on the left for the
  // native lights and move the LU logo to the RIGHT (David 2026-07-11). The
  // whole strip stays a drag region.
  if (isMacOS()) {
    return (
      <div
        data-tauri-drag-region
        className="h-8 flex items-center justify-end bg-gray-200 dark:bg-lu-canvas select-none pl-[80px] pr-3"
      >
        <img src={MONOGRAM} alt="" width={18} height={18} className="pointer-events-none dark:invert-0 invert opacity-80" />
      </div>
    )
  }

  return (
    <div
      data-tauri-drag-region
      className="h-8 flex items-center justify-between bg-gray-200 dark:bg-lu-canvas select-none"
    >
      {/* Left: App icon + title */}
      <div data-tauri-drag-region className="flex items-center gap-1.5 pl-3">
        <img src={MONOGRAM} alt="" width={18} height={18} className="pointer-events-none dark:invert-0 invert opacity-80" />
      </div>

      {/* Right: Window controls (Windows/Linux — custom, since decorations:false)
          Drei Glyphen, drei Groessen (14 / 11 / 14) und drei handgesetzte
          Strichstaerken standen hier fuer eine einzige Aussage. Jetzt eine
          Leiterstufe (ICON_SM) fuer alle drei; die Strichstaerke kommt aus
          dem Provider in AppShell, damit sie nicht wieder auseinanderlaeuft.
          Der Ausschlag bleibt der Knopf (46x32), nicht der Glyph. */}
      <div className="flex items-center">
        <button
          onClick={handleMinimize}
          className={`${btnBase} text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10`}
          aria-label="Minimize"
        >
          <Minus size={ICON_SM} />
        </button>
        <button
          onClick={handleToggleMaximize}
          className={`${btnBase} text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10`}
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <Copy size={ICON_SM} /> : <Square size={ICON_SM} />}
        </button>
        <button
          onClick={handleClose}
          className={`${btnBase} text-gray-500 dark:text-gray-400 hover:bg-red-500 hover:text-white`}
          aria-label="Close"
        >
          <X size={ICON_SM} />
        </button>
      </div>
    </div>
  )
}
