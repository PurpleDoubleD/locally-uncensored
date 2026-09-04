import { Children, cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { MOTION_MS } from './motion'

/**
 * Das Drehrad: eine RUNDE Reihe, deren aktiver Eintrag IMMER in der Mitte
 * steht und die zu beiden Seiten immer gleich viele Nachbarn zeigt.
 *
 * David, 03.09.2026: „3 Optionen zur linken und 3 zur rechten sollen immer
 * blasser werden und bei Anklicken drauf scrollen mit smooth Effekt und dann
 * klar deutlich zu lesen sein." Fuer Chat/Create/Benchmark im Kopf, fuer die
 * zwoelf Create-Werkzeuge mit fuenf je Seite.
 *
 * David, 04.09.2026: „links und rechts sollen immer gleich viele optionen sein
 * nicht alles nach links und alles nach rechts wenn man durch klickt."
 *
 * ## Warum die erste Fassung das nicht konnte
 *
 * Sie war eine GERADE Liste. Beim ersten Eintrag stand links nichts und rechts
 * alles, beim letzten umgekehrt. Ein Rad, das an zwei Stellen anschlaegt, ist
 * kein Rad, sondern ein Schieberegler mit Verlauf. Die Symmetrie war nur in
 * der Mitte der Liste zufaellig da.
 *
 * Jetzt wird die Liste geschlossen: vor den ersten Eintrag kommen die LETZTEN
 * `radius`, hinter den letzten die ERSTEN `radius`. Damit hat jeder Eintrag zu
 * beiden Seiten mindestens `radius` Nachbarn, ohne Ausnahme, auch der erste und
 * der letzte. Die angehaengten Kopien sind dieselben Kinder und tragen deshalb
 * denselben Klick: wer links neben „Chat" auf „Settings" klickt, landet auf
 * Settings.
 *
 * ## Warum der Radius gedeckelt wird
 *
 * Ein Rad kann hoechstens so viele Nachbarn je Seite zeigen, wie es hat, ohne
 * dasselbe Wort zweimal zu zeigen. Bei sechs Eintraegen sind das zwei je Seite:
 * bei dreien waeren der dritte links und der dritte rechts derselbe Eintrag.
 * Deshalb `min(radius, floor((n - 1) / 2))`. Die zwoelf Create-Werkzeuge
 * behalten damit ihre fuenf, die sechs Kopfziele bekommen zwei statt der
 * gewuenschten drei. Zwei echte Nachbarn sind besser als drei, von denen einer
 * doppelt dasteht.
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

/**
 * Wie viele Nachbarn je Seite ein Rad mit `n` Eintraegen wirklich zeigen kann.
 *
 * Hoechstens so viele, dass der aeusserste links und der aeusserste rechts
 * nicht derselbe Eintrag sind. Bei sechs Eintraegen sind das zwei: bei dreien
 * waere der dritte links der dritte rechts. Ein Rad mit weniger als drei
 * Eintraegen hat keine Nachbarn zu zeigen.
 */
export function sichtbarerRadius(gewuenscht: number, n: number): number {
  if (n < 3) return 0
  return Math.max(0, Math.min(gewuenscht, Math.floor((n - 1) / 2)))
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
  const n = kinder.length
  const r = sichtbarerRadius(radius, n)

  // Die geschlossene Reihe: die letzten `r` vorn, die ersten `r` hinten. Der
  // aktive Eintrag sitzt damit immer bei `r + activeIndex`, und links wie
  // rechts von ihm stehen mindestens `r` Nachbarn.
  //
  // `activeIndex` kann -1 sein (in der Kopfzeile, solange kein Ziel aktiv ist).
  // Dann gibt es keine Mitte, und die Reihe steht am Anfang, statt eine zu
  // erfinden.
  const hatMitte = activeIndex >= 0 && activeIndex < n
  const zielIndex = hatMitte ? r + activeIndex : 0

  type Feld = { kind: ReactNode; key: string; kopie: boolean }
  const felder: Feld[] = []
  if (r > 0) {
    for (let i = n - r; i < n; i++) felder.push({ kind: kinder[i], key: `vor-${i}`, kopie: true })
  }
  for (let i = 0; i < n; i++) felder.push({ kind: kinder[i], key: `echt-${i}`, kopie: false })
  if (r > 0) {
    for (let i = 0; i < r; i++) felder.push({ kind: kinder[i], key: `nach-${i}`, kopie: true })
  }

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
    const ziel = feldRefs.current[zielIndex]
    if (!spur || !ziel || polster === 0) return
    const links = ziel.offsetLeft - (spur.clientWidth - ziel.clientWidth) / 2
    spur.scrollTo({
      left: Math.max(0, links),
      behavior: schonPlatziert.current && !wenigerBewegung() ? 'smooth' : 'auto',
    })
    schonPlatziert.current = true
  }, [zielIndex, polster, felder.length])

  return (
    <div
      ref={spurRef}
      data-testid="wheel-nav"
      data-wheel-radius={r}
      // Die Kante loest sich auf, statt abgeschnitten zu werden. Das ist nicht
      // nur Schmuck: die Spur ist meist breiter als die `2r+1` Felder, die das
      // Rad zeigen soll, und dahinter faengt die geschlossene Reihe an sich zu
      // wiederholen. Ohne den Verlauf blitzte dort ein zweites Mal dasselbe
      // Wort auf.
      className={`relative overflow-x-auto lu-wheel-track lu-wheel-maske min-w-0 ${className ?? ''}`}
    >
      <div
        className={`flex items-center w-max ${reihenClass ?? ''}`}
        style={{ paddingLeft: polster, paddingRight: polster }}
      >
        {felder.map((feld, i) => {
          const d = hatMitte ? Math.abs(i - zielIndex) : r
          // Eine Kopie ist fuer die Maus dasselbe Ziel wie das Original, fuer
          // Tastatur und Screenreader aber nicht: sonst haette jedes Ziel
          // mehrere Tab-Stationen und wuerde mehrfach vorgelesen.
          const kind = feld.kopie && isValidElement(feld.kind)
            ? cloneElement(feld.kind as ReactElement<{ tabIndex?: number; 'aria-hidden'?: boolean }>, {
                tabIndex: -1,
                'aria-hidden': true,
              })
            : feld.kind
          return (
            <div
              key={feld.key}
              ref={(el) => { feldRefs.current[i] = el }}
              data-wheel-distance={d}
              data-wheel-kopie={feld.kopie ? '1' : undefined}
              className="shrink-0"
              style={{
                opacity: deckkraft(d, r),
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
