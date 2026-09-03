import { Children, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { MOTION_MS } from './motion'

/**
 * Das Scrollrad: eine Reihe, deren aktiver Eintrag IMMER in der Mitte steht
 * und deren Nachbarn nach aussen blasser werden.
 *
 * David, 03.09.2026: „3 Optionen zur linken und 3 zur rechten sollen immer
 * blasser werden und bei Anklicken drauf scrollen mit smooth Effekt und dann
 * klar deutlich zu lesen sein." Fuer Chat/Create/Benchmark im Kopf mit drei
 * Nachbarn je Seite, fuer die zwoelf Create-Werkzeuge mit fuenf.
 *
 * ## Warum eine Scrollflaeche und keine Verschiebung
 *
 * Ein `translateX` waere weniger Code und waere falsch: der Browser haelt ein
 * fokussiertes Element von sich aus im sichtbaren Bereich, aber nur in einer
 * echten Scrollflaeche. Mit einer Verschiebung wandert der Tastaturfokus aus
 * dem Bild, ohne dass jemand nachfuehrt, und die Reihe laesst sich am
 * Trackpad nicht mehr anfassen. Deshalb `overflow-x: auto`, Balken versteckt
 * (`.lu-wheel-track`), und die Mitte wird ueber `scrollTo` angefahren.
 *
 * ## Warum links und rechts immer ein Polster steht
 *
 * Ohne Polster kann der erste Eintrag nicht in die Mitte: die Spur ist am
 * linken Anschlag, und `scrollLeft` laesst sich nicht unter null druecken.
 * Ein halbe Spurbreite breites Polster auf beiden Seiten macht jeden Eintrag
 * erreichbar, auch den ersten und den letzten. Das gilt auch dann, wenn alle
 * Eintraege nebeneinander hineinpassen: sonst waere das Rad im breiten
 * Fenster kein Rad mehr, sondern eine feste Reihe, und ein Klick auf den
 * letzten Eintrag bewegte nichts.
 *
 * ## Warum die Deckkraft am Index haengt und nicht an der Position
 *
 * Sie koennte aus der gemessenen Entfernung zur Mitte kommen, dann muesste
 * aber bei jedem Scroll-Ereignis das Layout gelesen werden. Der Abstand im
 * Index sagt dasselbe, ist ohne Messung zu haben und laesst sich pruefen:
 * {@link deckkraft} ist eine reine Funktion, und ihr Test braucht kein
 * Fenster.
 */

/** Deckkraft des blassesten Nachbarn. Darunter liest sich Text nicht mehr. */
export const WHEEL_BODEN = 0.35

/**
 * Wie sichtbar ein Eintrag im Abstand `d` vom aktiven ist.
 *
 * Linear von 1 auf {@link WHEEL_BODEN} ueber `radius` Schritte, danach der
 * Boden. Der aktive Eintrag steht immer auf genau 1: „klar deutlich zu lesen"
 * ist die Zusage, und ein Verlauf, der bei 0,95 anfaengt, bricht sie leise.
 */
export function deckkraft(d: number, radius: number): number {
  if (d <= 0) return 1
  if (radius <= 0) return WHEEL_BODEN
  return Math.max(WHEEL_BODEN, 1 - (d * (1 - WHEEL_BODEN)) / radius)
}

/** Ob das Betriebssystem um weniger Bewegung gebeten hat. */
function wenigerBewegung(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

interface Props {
  /** Index des aktiven Kindes. Ausserhalb der Liste heisst: kein Eintrag aktiv. */
  activeIndex: number
  /** Wie viele Nachbarn je Seite den vollen Verlauf bekommen. */
  radius: number
  /** Klassen fuer die Reihe selbst, etwa der Abstand zwischen den Eintraegen. */
  reihenClass?: string
  className?: string
  children: ReactNode
}

export function WheelNav({ activeIndex, radius, reihenClass, className, children }: Props) {
  const spurRef = useRef<HTMLDivElement>(null)
  const feldRefs = useRef<(HTMLDivElement | null)[]>([])
  const schonPlatziert = useRef(false)
  const [polster, setPolster] = useState(0)

  const kinder = Children.toArray(children)

  // Halbe Spurbreite als Polster, und bei jeder Groessenaenderung neu.
  useLayoutEffect(() => {
    const spur = spurRef.current
    if (!spur) return
    const messen = () => setPolster(Math.round(spur.clientWidth / 2))
    messen()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(messen)
    ro.observe(spur)
    return () => ro.disconnect()
  }, [])

  // Die Mitte anfahren. Nur die Spur bewegt sich, nicht die Seite darum:
  // `scrollIntoView` wuerde jeden scrollbaren Vorfahren mitziehen, und in der
  // Kopfzeile ist das die ganze Ansicht.
  //
  // `offsetLeft` misst gegen den naechsten POSITIONIERTEN Vorfahren, nicht
  // gegen den Behaelter. Deshalb traegt die Spur `relative`: ohne das kam die
  // Zahl aus der Kopfzeile darum, die Rechnung war um deren linken Rand
  // verschoben, und das Rad stand beim ersten Zeichnen mehrere hundert Pixel
  // daneben (gemessen am 03.09.2026: 505 statt 224).
  //
  // Der erste Lauf springt (`auto`). Ein weicher Lauf beim ersten Zeichnen
  // waere eine Reihe, die von links hereinfaehrt, obwohl niemand geklickt
  // hat.
  useEffect(() => {
    const spur = spurRef.current
    const ziel = feldRefs.current[activeIndex]
    if (!spur || !ziel || polster === 0) return
    const links = ziel.offsetLeft - (spur.clientWidth - ziel.clientWidth) / 2
    spur.scrollTo({
      left: Math.max(0, links),
      behavior: schonPlatziert.current && !wenigerBewegung() ? 'smooth' : 'auto',
    })
    schonPlatziert.current = true
  }, [activeIndex, polster, kinder.length])

  return (
    <div
      ref={spurRef}
      data-testid="wheel-nav"
      className={`relative overflow-x-auto lu-wheel-track min-w-0 ${className ?? ''}`}
    >
      <div
        className={`flex items-center w-max ${reihenClass ?? ''}`}
        style={{ paddingLeft: polster, paddingRight: polster }}
      >
        {kinder.map((kind, i) => {
          const d = Math.abs(i - activeIndex)
          return (
            <div
              key={i}
              ref={(el) => { feldRefs.current[i] = el }}
              data-wheel-distance={d}
              className="shrink-0"
              style={{
                opacity: deckkraft(d, radius),
                transition: `opacity ${MOTION_MS.base}ms var(--motion-ease)`,
              }}
            >
              {kind}
            </div>
          )
        })}
      </div>
    </div>
  )
}
