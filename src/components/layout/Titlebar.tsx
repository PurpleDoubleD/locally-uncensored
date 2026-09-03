import { useEffect, useState } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { isMacOS } from '../../api/backend'
import { ICON_SM } from '../ui/icon-size'
import { MONOGRAM, MONOGRAM_INVERT } from './brand'

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
 *
 * NACHTRAG 01.09.2026 (D-W3-7, zweite Haelfte): Pfad und Invertierungsrezept
 * standen hier bis eben als eigene Kopie neben `layout/brand.ts` — die
 * Doppelung, die `b3f0f786` als offenen Rest gemeldet hat. Sie ist weg; der
 * Test, der den Literalpfad DORT festgenagelt hat, nagelt jetzt den Import
 * fest. Zwei Quellen fuer einen Pfad koennen auseinanderlaufen, eine nicht.
 */

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

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
  // native lights (David 2026-07-11). The whole strip stays a drag region.
  //
  // D-W3-7, erste Haelfte: „Titlebar-Monogramm streichen." Hier ist es
  // gestrichen, auf dem Windows/Linux-Zweig unten NICHT — und der Unterschied
  // ist keine Inkonsequenz, sondern der Grund:
  //
  //   mac: das System zeichnet in einem Fensterbalken KEIN App-Symbol. Das
  //   Monogramm sass hier rechts, also nicht einmal dort, wo mac ueberhaupt
  //   etwas hinsetzt (der Proxy-Icon-Slot sitzt links neben dem Dokumenttitel,
  //   den dieses Fenster nicht hat). Es war eine erfundene Marke 32px ueber
  //   der zweiten Marke im `Header` — und seit `b3f0f786` sind die beiden mit
  //   18px und 20px auch noch fast gleich gross. Genau die Doppelung, die der
  //   Audit meint. Der Streifen selbst BLEIBT: er reserviert die Hoehe fuer
  //   die nativen Lichter, sonst rutscht der Inhalt darunter.
  //
  //   Windows/Linux: `decorations: false` — die App ERSETZT den Systembalken.
  //   Der native haette links das App-Symbol getragen (Explorer, Notepad,
  //   VS Code tun das alle); es dort wegzunehmen liefert weniger als der
  //   Balken, den man ersetzt hat. Das ist kein Markenzeichen an dieser
  //   Stelle, sondern das Fenstersymbol. Es bleibt.
  //
  // Zaehlbar: eine der zwoelf Einbindungen faellt weg, statt umgestellt zu
  // werden. Auf mac zeigt die App die Marke jetzt einmal statt zweimal.
  if (isMacOS()) {
    return (
      <div
        data-tauri-drag-region
        className="h-8 bg-gray-200 dark:bg-lu-canvas select-none"
      />
    )
  }

  return (
    <div
      data-tauri-drag-region
      className="h-8 flex items-center justify-between bg-gray-200 dark:bg-lu-canvas select-none"
    >
      {/* Links: das Fenstersymbol. Siehe die Begruendung am mac-Zweig oben —
          hier ist es NICHT das Markenzeichen aus dem Header noch einmal,
          sondern der Slot, den der ersetzte Systembalken an dieser Stelle
          hatte. */}
      <div data-tauri-drag-region className="flex items-center gap-1.5 pl-3">
        <img src={MONOGRAM} alt="" width={18} height={18} className={`pointer-events-none ${MONOGRAM_INVERT} opacity-80`} />
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
