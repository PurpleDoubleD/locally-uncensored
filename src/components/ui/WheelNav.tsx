import { Children, cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from 'react'
import { MOTION_MS } from './motion'

/**
 * Das Drehrad: eine endlose Walze, deren aktiver Eintrag IMMER in der Mitte
 * steht und links wie rechts von gleich vielen Nachbarn umgeben ist.
 *
 * David, 03.09.2026: „3 Optionen zur linken und 3 zur rechten sollen immer
 * blasser werden und bei Anklicken drauf scrollen mit smooth Effekt und dann
 * klar deutlich zu lesen sein."
 *
 * David, 04.09.2026: „links und rechts sollen immer gleich viele optionen sein
 * nicht alles nach links und alles nach rechts wenn man durch klickt."
 *
 * ## Zwei Fassungen, die es nicht konnten, und warum
 *
 * Die erste war eine GERADE Liste: beim ersten Eintrag stand links nichts und
 * rechts alles.
 *
 * Die zweite haengte `radius` Kopien an beide Enden und deckelte den Radius
 * auf `floor((n - 1) / 2)`, damit kein Wort zweimal im Bild steht. Beides war
 * falsch, und die Gegenpruefung vom 04.09.2026 hat es ausgerechnet:
 *
 * - Die Kopfspur ist 416 px breit, der Ring aus sechs Reitern misst 349,6 px
 *   (Inter 500 bei 10,88 px, `px-2` und `gap-0.5`). Die Spur ist also breiter
 *   als eine ganze Umdrehung. Die Dublette stand ohnehin im Bild, nur an einer
 *   Stelle, die niemand geplant hatte, und gegenueber klaffte ein Loch. Der
 *   Deckel bezahlte mit Davids drittem Nachbarn und kaufte dafuer nichts.
 * - Ein Klick auf eine Kopie fuhr die lange Strecke. `zielIndex` war
 *   `r + activeIndex` und wusste nie, welche der beiden Darstellungen
 *   angeklickt wurde. Wer links neben „Chat" auf „Settings" klickte, sah das
 *   Wort unter dem Zeiger nach links wegfahren und ein zweites „Settings" von
 *   rechts hereinkommen, fuenf Feldbreiten weit.
 *
 * ## Wie es jetzt geht
 *
 * Die Reihe traegt `K` volle Umdrehungen, und `K` haengt an der Breite der
 * Spur, nicht am Radius (siehe {@link umdrehungen}). Damit ist die Spur an
 * jeder Stelle voll, es gibt kein Loch und keine ungeplante Dublette mehr. Die
 * Wiederholung ist Absicht: eine Walze zeigt dieselbe Beschriftung wieder,
 * wenn man weit genug dreht, und die Kante loest sich unter der Maske auf.
 *
 * Gefahren wird IMMER in die mittlere Umdrehung. Vor einer weichen Fahrt wird
 * die Stellung um ein ganzes Vielfaches der Ringbreite an das Ziel
 * herangeholt. Das ist unsichtbar, weil der Inhalt sich genau so wiederholt,
 * und danach ist der kurze Weg der einzige, der noch bleibt.
 *
 * `radius` bedeutet nur noch, wie viele Nachbarn blasser werden. Der Deckel
 * ist weg, die Kopfzeile bekommt damit Davids drei je Seite.
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
 * ## Warum die Mitte von selbst zurueckkommt
 *
 * „Hard in der Mitte, keine Ausnahme." Ein Wisch am Trackpad, ein Tastendruck
 * mitten in der Fahrt oder ein Fokussprung schoben die Mitte vorher fuer
 * immer weg: die einzige Positionierung hing am Wechsel des Ziels, und der
 * Klick auf den bereits aktiven Reiter war die eine Geste, die beweisbar
 * nichts tat. Jetzt sieht {@link RUHE_MS} nach, sobald die Spur zur Ruhe
 * gekommen ist, und holt die Mitte zurueck. Nach einer eigenen Fahrt steht
 * sie schon dort, dann passiert nichts.
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

/** Wie lange die Spur still stehen muss, bis die Mitte zurueckgeholt wird. */
export const RUHE_MS = 500

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
 * Wie viele volle Umdrehungen die Reihe tragen muss.
 *
 * Immer ungerade, damit es eine mittlere gibt, in die gefahren wird. Zu jeder
 * Seite der Mitte stehen `m` Umdrehungen, und `m` muss zwei Dinge decken: die
 * halbe Spur, die neben dem zentrierten Eintrag sichtbar ist, und die halbe
 * Ringbreite, um die die Stellung vor einer weichen Fahrt hoechstens neben dem
 * Ziel liegt. Also `m * ring >= (spur + ring) / 2`.
 *
 * Ohne Messung (erstes Zeichnen) drei: genug, um die Ringbreite ueberhaupt
 * messen zu koennen, und wenig genug, um nicht zu flackern.
 */
export function umdrehungen(spurBreite: number, ringBreite: number): number {
  if (ringBreite <= 0 || spurBreite <= 0) return 3
  const m = Math.max(1, Math.ceil((spurBreite + ringBreite) / (2 * ringBreite)))
  return 2 * m + 1
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
  const reiheRef = useRef<HTMLDivElement>(null)
  const feldRefs = useRef<(HTMLDivElement | null)[]>([])
  const schonPlatziert = useRef(false)
  const zuletztGefahren = useRef(-1)
  const [spurBreite, setSpurBreite] = useState(0)
  const [ringBreite, setRingBreite] = useState(0)

  const kinder = Children.toArray(children)
  const n = kinder.length
  const r = Math.max(0, radius)

  // `activeIndex` kann -1 sein: in der Kopfzeile, solange kein Ziel aktiv ist,
  // und in Create, wenn ein Werkzeug gewaehlt bleibt, das dieses Geraet nicht
  // kann. Dann gibt es keine Mitte. Eine Walze ohne Mitte ist keine: die Reihe
  // steht einmal da, voll lesbar, und faehrt nicht.
  const hatMitte = activeIndex >= 0 && activeIndex < n
  const kopien = hatMitte ? umdrehungen(spurBreite, ringBreite) : 1
  const mitteKopie = (kopien - 1) / 2
  const zielIndex = hatMitte ? mitteKopie * n + activeIndex : -1

  type Feld = { kind: ReactNode; key: string; datenIndex: number; echt: boolean }
  const felder: Feld[] = []
  for (let k = 0; k < kopien; k++) {
    for (let i = 0; i < n; i++) {
      felder.push({ kind: kinder[i], key: `u${k}-${i}`, datenIndex: i, echt: k === mitteKopie })
    }
  }

  // Spurbreite und Ringbreite messen. Die Ringbreite ist der Abstand zwischen
  // zwei aufeinanderfolgenden Darstellungen desselben Eintrags, also genau
  // eine Umdrehung samt der Luecke dazwischen. Sie haengt nicht an `kopien`,
  // die Rechnung kommt deshalb nach einem Durchgang zur Ruhe.
  useLayoutEffect(() => {
    const spur = spurRef.current
    const reihe = reiheRef.current
    if (!spur || !reihe) return
    const messen = () => {
      setSpurBreite(spur.clientWidth)
      const erstes = feldRefs.current[0]
      const zweites = feldRefs.current[n]
      if (erstes && zweites) {
        const breite = zweites.offsetLeft - erstes.offsetLeft
        // Nur bei echter Aenderung schreiben: ein Halbpixel hin und her wuerde
        // sonst `kopien` und damit diese Messung endlos neu ausloesen.
        if (breite > 0) setRingBreite((alt) => (Math.abs(alt - breite) > 0.5 ? breite : alt))
      }
    }
    messen()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(messen)
    ro.observe(spur)
    ro.observe(reihe)
    return () => ro.disconnect()
  }, [n, kopien])

  // Die Mitte anfahren. Nur die Spur bewegt sich, nicht die Seite darum:
  // `scrollIntoView` wuerde jeden scrollbaren Vorfahren mitziehen, und in der
  // Kopfzeile ist das die ganze Ansicht.
  //
  // `offsetLeft` misst gegen den naechsten POSITIONIERTEN Vorfahren, nicht
  // gegen den Behaelter. Deshalb traegt die Spur `relative`: ohne das kam die
  // Zahl aus der Kopfzeile darum, die Rechnung war um deren linken Rand
  // verschoben, und das Rad stand beim ersten Zeichnen mehrere hundert Pixel
  // daneben (gemessen am 03.09.2026: 505 statt 224).
  useEffect(() => {
    const spur = spurRef.current
    const ziel = zielIndex >= 0 ? feldRefs.current[zielIndex] : null
    if (!spur || !ziel) return
    const soll = ziel.offsetLeft - (spur.clientWidth - ziel.clientWidth) / 2

    // Weich nur, wenn sich das ZIEL geaendert hat. Eine Breitenaenderung ist
    // keine Navigation, sondern eine Korrektur, und eine Korrektur muss
    // sofort sitzen. Sonst fuhr die ganze Reihe bei jedem Zug am Rand der
    // Seitenleiste und bei jedem Sprung ueber den lg-Umbruch von links herein,
    // obwohl niemand geklickt hatte.
    const weich = schonPlatziert.current && zuletztGefahren.current !== zielIndex && !wenigerBewegung()
    if (weich && ringBreite > 0) {
      // Der kurze Weg: die Stellung um ganze Umdrehungen an das Ziel
      // heranholen. Unsichtbar, weil der Inhalt sich genau so wiederholt.
      const versatz = Math.round((soll - spur.scrollLeft) / ringBreite)
      if (versatz !== 0) spur.scrollLeft = spur.scrollLeft + versatz * ringBreite
    }
    spur.scrollTo({ left: Math.max(0, soll), behavior: weich ? 'smooth' : 'auto' })
    schonPlatziert.current = true
    zuletztGefahren.current = zielIndex
  }, [zielIndex, ringBreite, spurBreite, felder.length])

  // Kommt die Spur woanders zur Ruhe, als sie soll, wird die Mitte zurueck
  // geholt. Das deckt alles ab, was das Ziel nicht aendert und die Stellung
  // trotzdem verschiebt: eigenes Wischen, ein Tastendruck mitten in der Fahrt,
  // ein Fokussprung, und den Klick auf den bereits aktiven Reiter.
  //
  // Nach einer eigenen Fahrt steht die Spur schon richtig, der Rest ist null,
  // und es passiert nichts. Eine Fahne dafuer braucht es nicht.
  useEffect(() => {
    const spur = spurRef.current
    if (!spur || zielIndex < 0) return
    let uhr: ReturnType<typeof setTimeout> | undefined
    const nachsehen = () => {
      const ziel = feldRefs.current[zielIndex]
      if (!ziel) return
      const soll = ziel.offsetLeft - (spur.clientWidth - ziel.clientWidth) / 2
      if (ringBreite > 0) {
        const versatz = Math.round((soll - spur.scrollLeft) / ringBreite)
        if (versatz !== 0) spur.scrollLeft = spur.scrollLeft + versatz * ringBreite
      }
      if (Math.abs(soll - spur.scrollLeft) > 1) {
        spur.scrollTo({ left: Math.max(0, soll), behavior: wenigerBewegung() ? 'auto' : 'smooth' })
      }
    }
    const angestossen = () => {
      if (uhr) clearTimeout(uhr)
      uhr = setTimeout(nachsehen, RUHE_MS)
    }
    spur.addEventListener('scroll', angestossen, { passive: true })
    return () => {
      spur.removeEventListener('scroll', angestossen)
      if (uhr) clearTimeout(uhr)
    }
  }, [zielIndex, ringBreite])

  // Wer eine Kopie anklickt, soll danach nicht mit dem Fokus auf einem Feld
  // stehen, das gerade aus dem Bild faehrt. Der Fokus geht auf den echten
  // Zwilling, ohne dass der Browser dabei selbst scrollt und gegen die Fahrt
  // arbeitet.
  const beiKlick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const ziel = e.target as HTMLElement | null
    const feld = ziel?.closest?.('[data-wheel-kopie="1"]')
    if (!feld) return
    const i = Number(feld.getAttribute('data-wheel-datenindex'))
    if (!Number.isInteger(i)) return
    requestAnimationFrame(() => {
      const echt = feldRefs.current[mitteKopie * n + i]
      echt?.querySelector<HTMLElement>('button, a[href], [tabindex]')?.focus({ preventScroll: true })
    })
  }

  return (
    <div
      ref={spurRef}
      data-testid="wheel-nav"
      data-wheel-radius={r}
      data-wheel-kopien={kopien}
      // Die Kante loest sich auf, statt abgeschnitten zu werden. Das ist die
      // Stelle, an der die Walze sich wiederholt: dort steht dasselbe Wort ein
      // zweites Mal, angeschnitten und auf dem Boden der Deckkraft, und der
      // Verlauf macht daraus eine weiterlaufende Walze statt eines Fehlers.
      className={`relative overflow-x-auto lu-wheel-track lu-wheel-maske min-w-0 ${className ?? ''}`}
    >
      <div ref={reiheRef} className={`flex items-center w-max ${reihenClass ?? ''}`} onClickCapture={beiKlick}>
        {felder.map((feld, i) => {
          const d = hatMitte ? Math.abs(i - zielIndex) : 0
          // Eine Kopie ist fuer die Maus dasselbe Ziel wie das Original, fuer
          // Tastatur und Screenreader aber nicht: sonst haette jedes Ziel
          // mehrere Tab-Stationen und wuerde mehrfach vorgelesen. `inert` waere
          // die Hausform, sperrt aber auch den Klick, und der Klick auf den
          // Nachbarn IST die Geste, um die es hier geht.
          const kind = !feld.echt && isValidElement(feld.kind)
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
              data-wheel-datenindex={feld.datenIndex}
              data-wheel-kopie={feld.echt ? undefined : '1'}
              aria-hidden={feld.echt ? undefined : true}
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
