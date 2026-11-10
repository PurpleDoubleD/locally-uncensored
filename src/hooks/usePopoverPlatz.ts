import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import {
  ankerInSicht,
  festeLage,
  lokaleMasse,
  platzFuerPopover,
  schubInDieFlaeche,
  type Kasten,
  type Massstab,
} from '../lib/popover-placement'

/**
 * Die EINE Platzlogik fuer alles, was in dieser App aufklappt.
 *
 * GitHub #149 (Hyprland, AppImage): die Modellauswahl in Create lag
 * unter dem Fensterrand, kein Modell war waehlbar. Jedes Aufklappmenue hatte
 * bis dahin seine eigene Vorstellung vom Platz: eine feste Richtung, eine
 * Mindesthoehe, das Fenster statt der abschneidenden Flaeche, oder gar keine.
 * Dieser Haken misst fuer alle gleich: Platz unter und ueber dem Ausloeser,
 * die Seite, die reicht, die Hoehe, die bleibt, und die seitliche Kante. Die
 * Entscheidung selbst steht rein in `lib/popover-placement`; hier steht nur
 * das Ablesen.
 *
 * Zwei Bauarten:
 *   - im Baum (`absolute` in einem `relative`-Ausloeser): der Haken liefert
 *     `nachOben` fuer die Klasse und `style` mit `max-height` und, wenn das
 *     Popover seitlich hinausragt, dem Schub zurueck in die Flaeche.
 *   - herausgehoben (`fest`, Portal auf `body`): `style` traegt zusaetzlich
 *     die Koordinaten.
 *
 * Das Popover scrollt selbst (`overflow-y-auto`) oder nennt mit `rolle` die
 * innere Liste, die es tut.
 */
export interface PopoverOptionen {
  /** Die Seite, auf der es aufgeht, solange es dort passt. Ohne Angabe unten. */
  bevorzugt?: 'unten' | 'oben'
  /** Abstand zum Ausloeser in px, passend zur Klasse (`mt-1` = 4). */
  abstand?: number
  /** Luft zur Kante der abschneidenden Flaeche in px. */
  luft?: number
  /** Hoeher wird es nie (ersetzt ein festes `max-h-*`). */
  deckel?: number
  /** Der Ausloeser. Ohne Angabe der `offsetParent` des Popovers. */
  anker?: RefObject<HTMLElement | null>
  /** Die innere Liste, falls sie scrollt und nicht das Popover selbst. */
  rolle?: RefObject<HTMLElement | null>
  /** Herausgehoben mit `position: fixed`, an dieser Kante des Ausloesers ausgerichtet. */
  fest?: 'links' | 'rechts'
  /**
   * Im Baum: breiter als die abschneidende Flaeche wird es nie. Fuer ein
   * Popover mit fester Breite, das breiter sein kann als ein schmales Fenster
   * (die Modellauswahl im Cloud-Modus, 400 px). Der Schub allein rettet dann
   * nur die linke Kante, die rechte bliebe geschnitten.
   */
  breiteDeckeln?: boolean
}

export interface PopoverLage {
  nachOben: boolean
  style: CSSProperties
}

const KEIN_STIL: CSSProperties = {}

/** Was die Engine ueber Zoom und Kastenmass verraet, an der App-Wurzel des Elements abgelesen. */
export function massstab(el: Element): Massstab {
  // Seit 3.1.0 (C42) kann zwischen Wurzel und Element ein zweiter Zoom
  // liegen, der Lese-Zoom des Transkripts (.lu-chat-zoom). Gezaehlt wird
  // deshalb die KETTE: das Produkt aller Zooms bis zum Body, gemessen am
  // tiefsten gezoomten Vorfahren, denn dort ist das Verhaeltnis von Kasten
  // zu CSS-Mass genau dieses Produkt (oder 1, je nach Engine). Ohne Lese-
  // Zoom ist der tiefste gezoomte Vorfahr die Wurzel, alles wie bisher.
  let wurzel = el
  let zoom = 1
  let tiefster: Element | null = null
  for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) {
    const z = parseFloat(getComputedStyle(p).zoom) || 1
    if (z !== 1) {
      zoom *= z
      tiefster ??= p
    }
    wurzel = p
  }
  const messen = tiefster ?? wurzel
  const r = messen.getBoundingClientRect()
  const css = messen instanceof HTMLElement ? messen.offsetWidth + messen.offsetHeight : 0
  return {
    zoom,
    verhaeltnis: css > 0 ? (r.width + r.height) / css : zoom,
    fensterBreite: window.innerWidth,
    fensterHoehe: window.innerHeight,
  }
}

/**
 * Die Flaeche, die ein Popover im Baum wirklich abschneidet: das Fenster,
 * geschnitten mit jedem Vorfahren, der nicht `visible` ist. Im Chat ist das
 * der `<main>` mit `overflow-hidden`, dessen Unterkante 9 px ueber der des
 * Fensters liegt.
 */
function abschneidendeFlaeche(anker: Element, fenster: Kasten, kasten: (k: Kasten) => Kasten): Kasten {
  let g = fenster
  for (let p = anker.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p)
    if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue
    const r = kasten(p.getBoundingClientRect())
    g = {
      top: Math.max(g.top, r.top),
      bottom: Math.min(g.bottom, r.bottom),
      left: Math.max(g.left, r.left),
      right: Math.min(g.right, r.right),
    }
  }
  return g
}

/**
 * The area in which a trigger can be scrolled out of sight: the boxes of all
 * its ancestors that scroll, cut with each other. Only scrolling counts. A
 * trigger that the window or a plain `overflow: hidden` cuts off (the pane in
 * a window that got very short) keeps its popover, as it always did, and
 * without a scrolling ancestor the area has no edge at all.
 *
 * Unlike `abschneidendeFlaeche` this follows the containing blocks, because a
 * trigger may sit in a positioned layer that leaves its scroller, and a
 * trigger in plain sight must never count as gone. An ancestor skipped by
 * mistake only keeps a popover shown, which is the old behaviour.
 */
function scrollFlaeche(anker: Element, kasten: (k: Kasten) => Kasten): Kasten {
  const scrollt = (overflow: string) => overflow === 'auto' || overflow === 'scroll'
  let g: Kasten = { top: -Infinity, bottom: Infinity, left: -Infinity, right: Infinity }
  let lage = getComputedStyle(anker).position
  for (let p = anker.parentElement; p && p !== document.body; p = p.parentElement) {
    if (lage === 'fixed') break
    const cs = getComputedStyle(p)
    // An absolute box is clipped only from its containing block upward.
    if (lage === 'absolute' && cs.position === 'static') continue
    lage = cs.position
    const senkrecht = scrollt(cs.overflowY)
    const waagerecht = scrollt(cs.overflowX)
    if (!senkrecht && !waagerecht) continue
    const r = kasten(p.getBoundingClientRect())
    g = {
      top: senkrecht ? Math.max(g.top, r.top) : g.top,
      bottom: senkrecht ? Math.min(g.bottom, r.bottom) : g.bottom,
      left: waagerecht ? Math.max(g.left, r.left) : g.left,
      right: waagerecht ? Math.min(g.right, r.right) : g.right,
    }
  }
  return g
}

function gleich(a: PopoverLage | null, b: PopoverLage): boolean {
  return a !== null && a.nachOben === b.nachOben && JSON.stringify(a.style) === JSON.stringify(b.style)
}

export function usePopoverPlatz(
  popRef: RefObject<HTMLElement | null>,
  open: boolean,
  optionen: PopoverOptionen = {},
): PopoverLage {
  const { bevorzugt = 'unten', abstand = 4, luft = 8, deckel, anker: ankerRef, rolle: rolleRef, fest, breiteDeckeln = false } = optionen
  const [lage, setLage] = useState<PopoverLage | null>(null)

  /* `useLayoutEffect` und nicht `useEffect`: die Messung braucht das
   * gerenderte Popover, und die Korrektur muss vor dem Bild sitzen, sonst
   * blitzt es einmal an der falschen Stelle auf. Die Lage des letzten
   * Aufklappens bleibt stehen, bis neu gemessen ist; so behaelt auch die
   * Ausblendung ihren Platz. */
  useLayoutEffect(() => {
    if (!open) return
    const messen = () => {
      const pop = popRef.current
      const anker = ankerRef?.current ?? (pop?.offsetParent as HTMLElement | null | undefined)
      if (!pop || !anker) return
      const roh = anker.getBoundingClientRect()
      // Ein Ausloeser ohne Flaeche hat kein Layout (oder ist gerade
      // ausgeblendet); daraus laesst sich nichts schliessen.
      if (roh.width === 0 && roh.height === 0) return
      const masse = lokaleMasse(massstab(anker))
      const a = masse.kasten(roh)
      const rolle = rolleRef?.current
      // `scrollHeight` und nicht `offsetHeight`: sobald eine Hoehe gesetzt
      // ist, misst `offsetHeight` nur noch den Deckel und nicht den Inhalt.
      // Eine innere Liste, die das Popover gerade zusammendrueckt, zaehlt mit
      // dem, was sie ungedrueckt haette, hoechstens aber ihrem eigenen Deckel.
      const rolleDeckel = rolle ? parseFloat(getComputedStyle(rolle).maxHeight) || Infinity : 0
      const gedrueckt = rolle ? Math.max(0, Math.min(rolle.scrollHeight, rolleDeckel) - rolle.clientHeight) : 0
      const inhaltHoehe = pop.scrollHeight + (pop.offsetHeight - pop.clientHeight) + gedrueckt

      let neu: PopoverLage
      if (fest) {
        const l = festeLage({
          anker: a, fenster: masse.fenster, breite: pop.offsetWidth, inhaltHoehe,
          ausrichtung: fest, abstand, luft, bevorzugt, deckel,
        })
        neu = {
          nachOben: l.nachOben,
          style: {
            position: 'fixed', top: l.top, bottom: l.bottom, left: l.left, right: l.right,
            width: 'max-content', minWidth: l.minWidth, maxWidth: l.maxWidth, maxHeight: l.maxHoehe,
          },
        }
      } else {
        const grenze = abschneidendeFlaeche(anker, masse.fenster, masse.kasten)
        const platz = platzFuerPopover({
          ankerOben: a.top, ankerUnten: a.bottom, grenzeOben: grenze.top, grenzeUnten: grenze.bottom,
          inhaltHoehe, abstand, luft, bevorzugt, deckel,
        })
        // Der natuerliche Platz ist der ohne den Schub von eben.
        const p = masse.kasten(pop.getBoundingClientRect())
        const alt = parseFloat(pop.style.marginLeft) || 0
        const schub = schubInDieFlaeche({
          links: p.left - alt, rechts: p.right - alt,
          grenzeLinks: grenze.left, grenzeRechts: grenze.right, luft,
        })
        neu = {
          nachOben: platz.nachOben,
          // Beide Raender, weil das Popover links ODER rechts verankert sein
          // kann: der Rand an der freien Seite bleibt ohne Wirkung.
          style: {
            maxHeight: platz.maxHoehe,
            ...(breiteDeckeln ? { maxWidth: Math.max(0, Math.floor(grenze.right - grenze.left - 2 * luft)) } : {}),
            ...(schub === 0 ? {} : { marginLeft: schub, marginRight: -schub }),
          },
        }
      }
      // A trigger scrolled out of its panel takes its popover out of sight
      // with it. Hidden and not pinned to the edge: every rule here places a
      // popover on its trigger, and one held at an edge would sit on nothing
      // and cover what the user scrolled to. Hidden and not closed: the hook
      // only places, opening and closing belong to the component, and so the
      // popover is back on its trigger as soon as that is scrolled into view.
      if (!ankerInSicht(a, scrollFlaeche(anker, masse.kasten))) {
        neu = { nachOben: neu.nachOben, style: { ...neu.style, visibility: 'hidden' } }
      }
      setLage((vorher) => (gleich(vorher, neu) ? vorher : neu))
    }
    messen()

    // Capture, weil die abschneidende Flaeche meist selbst der Scroller ist.
    // Das eigene Scrollen der Liste aendert am Platz nichts.
    const beimScrollen = (e: Event) => {
      if (e.target instanceof Node && popRef.current?.contains(e.target)) return
      messen()
    }
    window.addEventListener('resize', messen)
    window.addEventListener('scroll', beimScrollen, true)
    // Inhalt, der spaeter kommt (Suche, nachgeladene Zeilen), aendert die Hoehe.
    const beobachter = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(messen)
    for (const el of [popRef.current, ankerRef?.current ?? popRef.current?.offsetParent, rolleRef?.current]) {
      if (el) beobachter?.observe(el)
    }
    // Ein Ausloeser kann wandern, ohne dass eines der Ereignisse oben davon
    // erzaehlt: das Layout setzt sich nach einer Groessenaenderung erst einen
    // Frame spaeter (gemessen in WebKit, die Liste blieb 79 px vom Ausloeser
    // entfernt stehen). Solange das Popover offen ist, wird deshalb je Frame
    // ein Kasten gelesen und nur bei einer Aenderung neu gemessen.
    let zuletzt = ''
    let frame = requestAnimationFrame(function wache() {
      const anker = ankerRef?.current ?? popRef.current?.offsetParent
      if (anker) {
        const r = anker.getBoundingClientRect()
        const jetzt = `${r.top}|${r.left}|${r.width}|${r.height}|${window.innerWidth}|${window.innerHeight}`
        if (zuletzt !== '' && jetzt !== zuletzt) messen()
        zuletzt = jetzt
      }
      frame = requestAnimationFrame(wache)
    })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', messen)
      window.removeEventListener('scroll', beimScrollen, true)
      beobachter?.disconnect()
    }
  }, [open, popRef, ankerRef, rolleRef, bevorzugt, abstand, luft, deckel, fest, breiteDeckeln])

  return lage ?? { nachOben: bevorzugt === 'oben', style: KEIN_STIL }
}
