/**
 * Das Drehrad: der aktive Eintrag in der Mitte, die Nachbarn nach aussen
 * blasser, ein Klick faehrt weich und auf dem KURZEN Weg dorthin.
 *
 * David, 03.09.2026: „3 Optionen zur linken und 3 zur rechten sollen immer
 * blasser werden und bei Anklicken drauf scrollen mit smooth Effekt und dann
 * klar deutlich zu lesen sein."
 * David, 04.09.2026: „links und rechts sollen immer gleich viele optionen sein
 * ... hardstuck mittig. keine ausnahme."
 *
 * ## Was hier geprueft werden kann und was nicht
 *
 * jsdom hat kein Layout: `offsetLeft`, `clientWidth` und `scrollLeft` sind
 * ueberall null, und `scrollTo` ist eine Attrappe. Die vorige Fassung dieser
 * Datei hat daraus gefolgert, dass man ueber die Bewegung nichts sagen kann,
 * und genau deshalb ist der schwerste Fehler durchgerutscht: ein Klick auf
 * einen Nachbarn fuhr fuenf Feldbreiten in die falsche Richtung.
 *
 * Man kann darueber sehr wohl etwas sagen, wenn man ein Layout STELLT. Der
 * Block „die Fahrt" unten legt feste Feldbreiten und eine feste Spurbreite auf
 * die Prototypen, fuehrt scrollLeft als echten Speicher und laesst die
 * Attrappe von scrollTo den Speicher mitschreiben. Damit sind Richtung und
 * Weglaenge nachrechenbar. Was weiterhin NICHT geprueft wird, ist, wie es
 * aussieht: Schriftbreiten, der Verlauf der Maske und die weiche Bewegung
 * selbst gehoeren an ein laufendes Fenster.
 *
 * Run: npx vitest run src/components/ui/__tests__/das-scrollrad.test.ts
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { deckkraft, umdrehungen, RUHE_MS, WHEEL_BODEN, WheelNav } from '../WheelNav'

describe('die Rechnung hinter dem Verlauf', () => {
  it('der aktive Eintrag steht auf genau 1', () => {
    // „klar deutlich zu lesen" ist die Zusage. Ein Verlauf, der bei 0,95
    // anfaengt, bricht sie leise und niemand sieht es im Bild.
    for (const radius of [1, 3, 5, 12]) {
      expect(deckkraft(0, radius)).toBe(1)
    }
  })

  it('jeder Schritt nach aussen ist blasser als der davor', () => {
    for (const radius of [3, 5]) {
      for (let d = 1; d <= radius; d++) {
        expect(deckkraft(d, radius)).toBeLessThan(deckkraft(d - 1, radius))
      }
    }
  })

  it('am Rand des Radius steht der Boden, und darunter geht es nicht weiter', () => {
    for (const radius of [3, 5]) {
      expect(deckkraft(radius, radius)).toBeCloseTo(WHEEL_BODEN, 10)
      // Was weiter draussen liegt, wird nicht unsichtbar. Ein Eintrag mit
      // Deckkraft null waere ein Eintrag, den man anklicken kann, ohne ihn zu
      // sehen.
      expect(deckkraft(radius + 7, radius)).toBe(WHEEL_BODEN)
    }
  })

  it('der Boden ist noch lesbar', () => {
    // Gegen die naheliegende Vereinfachung „dann eben 0,1". Text auf 10
    // Prozent Deckkraft ist auf beiden Grundflaechen nicht mehr zu entziffern.
    expect(WHEEL_BODEN).toBeGreaterThanOrEqual(0.3)
    expect(WHEEL_BODEN).toBeLessThan(1)
  })

  it('drei und fuenf Nachbarn ergeben verschiedene Verlaeufe', () => {
    // Sonst waere `radius` ein Argument, das nichts tut, und beide Einsatzorte
    // saehen gleich aus.
    expect(deckkraft(2, 3)).not.toBeCloseTo(deckkraft(2, 5), 3)
    expect(deckkraft(2, 5)).toBeGreaterThan(deckkraft(2, 3))
  })

  it('ein Radius von null faellt nicht auseinander', () => {
    // Negativkontrolle gegen eine Division durch null.
    expect(deckkraft(1, 0)).toBe(WHEEL_BODEN)
    expect(deckkraft(0, 0)).toBe(1)
  })
})

describe('wie viele Umdrehungen die Reihe traegt', () => {
  // Der Kern der Reparatur vom 04.09.2026. Vorher hingen die Kopien am
  // Radius, und der wurde auf `floor((n - 1) / 2)` gedeckelt, damit kein Wort
  // zweimal im Bild steht. Nachgemessen war die Kopfspur 416px breit und der
  // Ring aus sechs Reitern 349,6px: die Dublette stand ohnehin im Bild, nur
  // ungeplant, und gegenueber klaffte ein Loch. Jetzt haengt die Zahl der
  // Umdrehungen an der Breite.

  it('immer ungerade, damit es eine Mitte gibt', () => {
    for (const spur of [100, 400, 416, 992, 2000]) {
      for (const ring of [80, 300, 349.6, 930]) {
        expect(umdrehungen(spur, ring) % 2, `${spur}/${ring}`).toBe(1)
      }
    }
  })

  it('zu jeder Seite steht genug, um die halbe Spur und die halbe Fahrt zu decken', () => {
    // Die Bedingung, aus der die Formel kommt: `m * ring >= (spur + ring) / 2`.
    // Der erste Summand ist die halbe Spur, die neben dem zentrierten Eintrag
    // sichtbar ist, der zweite die halbe Ringbreite, um die die Stellung vor
    // einer weichen Fahrt hoechstens neben dem Ziel liegt. Faellt einer der
    // beiden weg, laeuft die Spur an ihren Anschlag und es klafft ein Loch.
    for (const spur of [100, 400, 416, 992, 1600, 2000]) {
      for (const ring of [80, 300, 349.6, 930]) {
        const m = (umdrehungen(spur, ring) - 1) / 2
        expect(m * ring, `${spur}/${ring}`).toBeGreaterThanOrEqual((spur + ring) / 2)
      }
    }
  })

  it('und nicht mehr als noetig', () => {
    // Gegenrichtung. Ohne diese Schranke waere „nimm einfach 99 Umdrehungen"
    // eine gueltige Loesung, und die Kopfzeile truege hunderte Knoepfe.
    for (const spur of [400, 416, 992, 2000]) {
      for (const ring of [80, 300, 349.6, 930]) {
        const m = (umdrehungen(spur, ring) - 1) / 2
        expect((m - 1) * ring, `${spur}/${ring}`).toBeLessThan((spur + ring) / 2)
      }
    }
  })

  it('die beiden echten Faelle ergeben fuenf Umdrehungen', () => {
    // Kopfzeile: 416px Spur, Ring 349,6px (gemessen am 04.09.2026, Inter 500
    // bei 10,88px, px-2 und gap-0.5). Create: 832px Spur, Ring 928,7px in
    // Layout-Pixeln.
    expect(umdrehungen(416, 349.6)).toBe(5)
    expect(umdrehungen(832, 928.7)).toBe(3)
  })

  it('ohne Messung drei, nicht null und nicht eine', () => {
    // Beim ersten Zeichnen ist noch nichts gemessen. Eine einzelne Umdrehung
    // liesse die Ringbreite nie messen (dafuer braucht es zwei Darstellungen
    // desselben Eintrags), null waere eine leere Reihe.
    expect(umdrehungen(0, 0)).toBe(3)
    expect(umdrehungen(400, 0)).toBe(3)
    expect(umdrehungen(0, 300)).toBe(3)
  })
})

describe('was das Bauteil wirklich rendert', () => {
  let host: HTMLDivElement
  let root: Root
  let altScrollTo: PropertyDescriptor | undefined

  beforeEach(() => {
    // jsdom kennt `scrollTo` auf Elementen nicht. Hier geht es um das
    // Gerenderte, nicht um die Fahrt, also reicht eine stumme Attrappe. Wohin
    // gefahren wird, prueft der Block darunter mit gestelltem Layout.
    altScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo')
    Object.defineProperty(Element.prototype, 'scrollTo', {
      configurable: true, writable: true, value: () => {},
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    if (altScrollTo) Object.defineProperty(Element.prototype, 'scrollTo', altScrollTo)
    else delete (Element.prototype as unknown as Record<string, unknown>).scrollTo
  })

  // Die Kinder stehen IN den Props, nicht als Restargumente: die
  // `createElement`-Ueberladung mit Restargumenten fuettert sie nicht in P
  // zurueck, also fehlte dem Aufruf das verlangte `children` und tsc brach ab.
  const rad = (activeIndex: number, radius: number, n: number) =>
    createElement(WheelNav, {
      activeIndex,
      radius,
      children: Array.from({ length: n }, (_, i) =>
        createElement('button', { key: i, type: 'button' }, `Ziel ${i}`),
      ),
    })

  const felder = () => [...host.querySelectorAll<HTMLElement>('[data-wheel-distance]')]
  const abstaende = () => felder().map((f) => Number(f.getAttribute('data-wheel-distance')))
  const texte = () => felder().map((f) => f.textContent ?? '')
  const kopien = () => Number(host.querySelector('[data-testid="wheel-nav"]')?.getAttribute('data-wheel-kopien'))

  it('ohne Messung stehen drei Umdrehungen da', () => {
    // jsdom liefert clientWidth null, die Messung kommt also nie zustande.
    // Das ist genau der Zustand des ersten Zeichnens.
    act(() => root.render(rad(2, 3, 6)))
    expect(kopien()).toBe(3)
    expect(felder()).toHaveLength(18)
  })

  it('der aktive Eintrag sitzt in der MITTLEREN Umdrehung', () => {
    // Drei Umdrehungen mal sechs Ziele, aktiv ist Index 2, also Feld
    // 1 * 6 + 2 = 8. Alles andere waere eine Reihe mit einem Anschlag.
    act(() => root.render(rad(2, 3, 6)))
    expect(abstaende().indexOf(0)).toBe(8)
    expect(texte()[8]).toBe('Ziel 2')
  })

  it('jeder Eintrag traegt seinen Abstand zur Mitte', () => {
    act(() => root.render(rad(1, 3, 3)))
    // Drei Umdrehungen mal drei Ziele, aktiv Index 1, Mitte bei Feld 4.
    expect(abstaende()).toEqual([4, 3, 2, 1, 0, 1, 2, 3, 4])
  })

  it('und die Deckkraft, die zu diesem Abstand gehoert', () => {
    act(() => root.render(rad(1, 1, 3)))
    expect(felder().map((f) => f.style.opacity)).toEqual(
      [4, 3, 2, 1, 0, 1, 2, 3, 4].map((d) => String(deckkraft(d, 1))),
    )
  })

  it('links und rechts steht mindestens eine volle Umdrehung, fuer JEDEN Eintrag', () => {
    // David, 04.09.2026: „links und rechts sollen immer gleich viele optionen
    // sein nicht alles nach links und alles nach rechts wenn man durch
    // klickt." Gleich viele SICHTBARE kann nur ein Fenster mit Layout sagen.
    // Was diese Zusage ueberhaupt erst moeglich macht, ist hier pruefbar: zu
    // beiden Seiten der Mitte steht mindestens eine ganze Umdrehung, sonst
    // liefe die Spur an ihren Anschlag und auf einer Seite klaffte ein Loch.
    // Genau daran ist die gerade Liste gescheitert, und der gedeckelte Ring
    // ebenso.
    for (const n of [3, 4, 6, 12]) {
      for (let a = 0; a < n; a++) {
        act(() => root.render(rad(a, 5, n)))
        const d = abstaende()
        const mitte = d.indexOf(0)
        expect(mitte, `n=${n} a=${a}: keine Mitte`).toBeGreaterThan(-1)
        expect(mitte, `n=${n} a=${a}: links zu wenig`).toBeGreaterThanOrEqual(n)
        expect(d.length - 1 - mitte, `n=${n} a=${a}: rechts zu wenig`).toBeGreaterThanOrEqual(n)
      }
    }
  })

  it('die Wiederholung ist Absicht und traegt denselben Text', () => {
    // Die alte Zusage „kein Wort zweimal" ist gestorben, und zwar bewusst:
    // sie war nie wahr, die Spur ist breiter als eine Umdrehung. Statt sie zu
    // verstecken, steht die Walze jetzt so da, wie eine Walze aussieht. Was
    // dabei stimmen MUSS: die Kopie zeigt denselben Eintrag wie das Original,
    // sonst waere es keine Wiederholung, sondern eine falsche Beschriftung.
    act(() => root.render(rad(0, 3, 4)))
    const t = texte()
    expect(t).toHaveLength(12)
    for (let i = 0; i < 4; i++) {
      expect(t[i], `Feld ${i}`).toBe(t[i + 4])
      expect(t[i + 4], `Feld ${i + 4}`).toBe(t[i + 8])
    }
  })

  it('die Kinder bleiben Kinder, das Rad schiebt sich nicht dazwischen', () => {
    // Ein Rad, das die Knoepfe durch eigene ersetzt, verloere jeden Handler
    // und jede ARIA-Auszeichnung der Aufrufstelle.
    act(() => root.render(rad(1, 3, 3)))
    expect(host.querySelectorAll('button')).toHaveLength(9)
    expect(host.querySelector('button')?.textContent).toBe('Ziel 0')
  })

  it('genau eine Umdrehung ist echt, alle anderen sind fuer die Maus da', () => {
    // Sonst haette jedes Ziel mehrere Tab-Stationen und wuerde vom
    // Screenreader mehrfach vorgelesen. Der Klick bleibt: wer auf den Nachbarn
    // klickt, landet auf dem Nachbarn, und das ist die Geste, um die es geht.
    act(() => root.render(rad(0, 3, 6)))
    const alleKopien = [...host.querySelectorAll('[data-wheel-kopie="1"] button')]
    const echte = [...host.querySelectorAll('[data-wheel-distance]:not([data-wheel-kopie]) button')]
    expect(echte).toHaveLength(6)
    expect(alleKopien).toHaveLength(12)
    for (const k of alleKopien) {
      expect(k.getAttribute('tabindex')).toBe('-1')
      expect(k.getAttribute('aria-hidden')).toBe('true')
    }
    for (const e of echte) {
      expect(e.getAttribute('tabindex')).toBeNull()
      expect(e.getAttribute('aria-hidden')).toBeNull()
    }
  })

  it('die echte Umdrehung ist die mittlere, nicht die erste', () => {
    // Wichtig, weil die Fahrt genau dorthin geht. Waere die echte die erste,
    // liefe der Tastaturfokus dem Bild dauerhaft hinterher.
    act(() => root.render(rad(0, 3, 6)))
    const alle = felder()
    const echteIndizes = alle
      .map((f, i) => (f.hasAttribute('data-wheel-kopie') ? -1 : i))
      .filter((i) => i >= 0)
    expect(echteIndizes).toEqual([6, 7, 8, 9, 10, 11])
  })

  it('die Spur ist eine echte Scrollflaeche ohne Balken, mit Maske', () => {
    act(() => root.render(rad(1, 3, 3)))
    const spur = host.querySelector('[data-testid="wheel-nav"]')
    expect(spur?.className).toContain('overflow-x-auto')
    expect(spur?.className).toContain('lu-wheel-track')
    // Die Maske ist keine Zier: an der Kante steht die Stelle, an der die
    // Walze sich wiederholt. Ohne Verlauf liest sich das als Fehler.
    expect(spur?.className).toContain('lu-wheel-maske')
  })

  it('die Maske misst in Pixeln, nicht in Prozent', () => {
    // Dieselbe Regel bedient zwei verschieden breite Spuren. Ein Prozentwert
    // waere in der Create-Leiste doppelt so breit wie in der Kopfzeile,
    // obwohl die Eintraege dieselbe Groesse haben.
    const css = readFileSync(resolve(__dirname, '..', '..', '..', 'index.css'), 'utf8')
    const regel = css.slice(css.indexOf('.lu-wheel-maske'), css.indexOf('}', css.indexOf('.lu-wheel-maske')) + 400)
    expect(regel).toContain('mask-image')
    expect(regel).toMatch(/#000 \d+px/)
    expect(regel).toMatch(/calc\(100% - \d+px\)/)
    expect(regel).not.toMatch(/#000 \d+%/)
  })

  it('ohne aktiven Eintrag steht die Reihe einmal da, voll lesbar', () => {
    // Kommt zweimal vor: in der Kopfzeile liefert `findIndex` -1, solange
    // keins der Ziele aktiv ist, und in Create, wenn ein Werkzeug gewaehlt
    // bleibt, das dieses Geraet nicht kann. Vorher stand dann die GANZE Leiste
    // auf dem Boden der Deckkraft und die Spur sprang auf eine Kopie. Das sah
    // aus wie ein Ladefehler. Eine Walze ohne Mitte ist keine Walze.
    act(() => root.render(rad(-1, 3, 6)))
    expect(kopien()).toBe(1)
    expect(felder()).toHaveLength(6)
    for (const f of felder()) expect(f.style.opacity).toBe('1')
    // Und keine der sechs ist eine Kopie, es gibt also volle sechs Tab-Stationen.
    expect(host.querySelectorAll('[data-wheel-kopie="1"]')).toHaveLength(0)
  })
})

describe('die Fahrt: Richtung, Weglaenge und wann sie weich ist', () => {
  // Hier wird ein Layout GESTELLT. Ohne das ist der schwerste Fehler dieser
  // Datei unsichtbar, und genau so ist er entstanden.
  const FELD = 50
  const SPUR = 400
  let host: HTMLDivElement
  let root: Root
  let rufe: ScrollToOptions[]
  let stand: number
  let vorher: number[]
  let alt: Record<string, PropertyDescriptor | undefined>
  let media: typeof window.matchMedia

  const istSpur = (el: Element) => (el as HTMLElement).dataset?.testid === 'wheel-nav'
  const istFeld = (el: Element) => (el as HTMLElement).hasAttribute?.('data-wheel-distance')

  const stelleMedia = (reduziert: boolean) => {
    window.matchMedia = ((q: string) =>
      ({ matches: reduziert, media: q }) as MediaQueryList) as typeof window.matchMedia
  }

  beforeEach(() => {
    rufe = []
    stand = 0
    vorher = []
    media = window.matchMedia
    alt = {
      scrollTo: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo'),
      scrollLeft: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft'),
      clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth'),
      offsetLeft: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft'),
    }
    Object.defineProperty(Element.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value(this: Element, o: ScrollToOptions) {
        if (!istSpur(this)) return
        // Die Stellung VOR dem Ruf ist die eine Zahl, aus der sich Richtung
        // und Weglaenge ergeben. Ohne sie waere nur das Ziel bekannt.
        vorher.push(stand)
        rufe.push(o)
        stand = o.left ?? stand
      },
    })
    Object.defineProperty(Element.prototype, 'scrollLeft', {
      configurable: true,
      get(this: Element) { return istSpur(this) ? stand : 0 },
      set(this: Element, v: number) { if (istSpur(this)) stand = v },
    })
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get(this: Element) {
        if (istSpur(this)) return SPUR
        if (istFeld(this)) return FELD
        return 0
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
      configurable: true,
      get(this: HTMLElement) {
        if (!istFeld(this) || !this.parentElement) return 0
        return [...this.parentElement.children].indexOf(this) * FELD
      },
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    window.matchMedia = media
    for (const [name, d] of Object.entries(alt)) {
      const ziel = name === 'offsetLeft' ? HTMLElement.prototype : Element.prototype
      if (d) Object.defineProperty(ziel, name, d)
      else delete (ziel as unknown as Record<string, unknown>)[name]
    }
  })

  const rad = (activeIndex: number, n = 6) =>
    createElement(WheelNav, {
      activeIndex,
      radius: 3,
      children: Array.from({ length: n }, (_, i) =>
        createElement('button', { key: i, type: 'button' }, `Ziel ${i}`),
      ),
    })

  const spur = () => host.querySelector<HTMLElement>('[data-testid="wheel-nav"]')!
  const ring = () => 6 * FELD

  it('die Ringbreite wird gemessen und die Umdrehungen danach gewaehlt', () => {
    // Sechs Felder à 50px sind 300px Ring, die Spur ist 400px breit.
    // m = ceil((400 + 300) / 600) = 2, also fuenf Umdrehungen.
    stelleMedia(false)
    act(() => root.render(rad(2)))
    expect(umdrehungen(SPUR, ring())).toBe(5)
    expect(spur().getAttribute('data-wheel-kopien')).toBe('5')
  })

  it('das erste Zeichnen springt, es faehrt nicht von links herein', () => {
    stelleMedia(false)
    act(() => root.render(rad(2)))
    expect(rufe.length).toBeGreaterThan(0)
    expect(rufe[0].behavior).toBe('auto')
  })

  it('das Ziel steht mittig in der Spur', () => {
    stelleMedia(false)
    act(() => root.render(rad(0)))
    // Fuenf Umdrehungen, Mitte ist Umdrehung 2, also Feld 12.
    // 12 * 50 - (400 - 50) / 2 = 600 - 175 = 425.
    expect(rufe.at(-1)?.left).toBe(425)
  })

  it('ein Klick danach faehrt weich', () => {
    stelleMedia(false)
    act(() => root.render(rad(2)))
    rufe.length = 0
    act(() => root.render(rad(5)))
    expect(rufe.at(-1)?.behavior).toBe('smooth')
  })

  it('DER KURZE WEG: ueber die Naht wird nie die ganze Reihe gefahren', () => {
    // Der schwerste Fehler der vorigen Fassung, gemessen von der
    // Gegenpruefung: Chat aktiv, Klick auf das Settings links daneben, und die
    // Spur fuhr fuenf Feldbreiten nach RECHTS. Das Wort unter dem Zeiger fuhr
    // weg, ein zweites kam von der anderen Seite herein.
    //
    // Die Zusage: kein Weg ist laenger als eine halbe Umdrehung. Bei sechs
    // Zielen sind das drei Felder, also 150px.
    stelleMedia(false)
    for (const [von, nach] of [[0, 5], [5, 0], [0, 1], [3, 2], [1, 4], [4, 1]]) {
      act(() => root.render(rad(von)))
      rufe.length = 0
      vorher.length = 0
      act(() => root.render(rad(nach)))
      const weg = (rufe.at(-1)!.left ?? 0) - vorher.at(-1)!
      expect(Math.abs(weg), `${von} nach ${nach}: ${weg}px`).toBeLessThanOrEqual(ring() / 2)
    }
  })

  it('und die Richtung stimmt, nicht nur die Laenge', () => {
    // Von 0 auf 5 ist ein Schritt nach links, also negativ. Von 5 auf 0 ein
    // Schritt nach rechts, also positiv. Eine Fassung, die nur den Betrag
    // klein haelt, aber falsch herum faehrt, faellt hier durch.
    stelleMedia(false)
    const weg = (von: number, nach: number) => {
      act(() => root.render(rad(von)))
      rufe.length = 0
      vorher.length = 0
      act(() => root.render(rad(nach)))
      return (rufe.at(-1)!.left ?? 0) - vorher.at(-1)!
    }
    expect(weg(0, 5)).toBe(-FELD)
    expect(weg(5, 0)).toBe(FELD)
    expect(weg(1, 2)).toBe(FELD)
    expect(weg(2, 1)).toBe(-FELD)
  })

  it('die Fahrt endet immer in der mittleren Umdrehung', () => {
    // Sonst wanderte die Stellung ueber viele Klicks an ein Ende, und
    // irgendwann waere auf einer Seite nichts mehr da.
    stelleMedia(false)
    act(() => root.render(rad(0)))
    for (const a of [5, 4, 5, 0, 1, 0, 3]) {
      act(() => root.render(rad(a)))
      const soll = (12 + a) * FELD - (SPUR - FELD) / 2
      expect(rufe.at(-1)?.left, `nach ${a}`).toBe(soll)
    }
  })

  it('eine Breitenaenderung faehrt nicht weich, sie sitzt sofort', () => {
    // Eine Korrektur ist keine Navigation. Vorher fuhr die ganze Reihe bei
    // jedem Zug am Rand der Seitenleiste und bei jedem Sprung ueber den
    // lg-Umbruch von links herein, obwohl niemand geklickt hatte.
    stelleMedia(false)
    act(() => root.render(rad(2)))
    rufe.length = 0
    act(() => {
      spur().dispatchEvent(new Event('resize'))
      root.render(rad(2))
    })
    for (const ruf of rufe) expect(ruf.behavior).toBe('auto')
  })

  it('wer weniger Bewegung bestellt hat, bekommt auch beim Klick keine', () => {
    stelleMedia(true)
    act(() => root.render(rad(2)))
    rufe.length = 0
    act(() => root.render(rad(5)))
    expect(rufe.at(-1)?.behavior).toBe('auto')
  })

  it('nach eigenem Wischen kommt die Mitte von selbst zurueck', () => {
    // „hardstuck mittig. keine ausnahme." Vorher hing die einzige
    // Positionierung am Wechsel des Ziels: ein Wisch, ein Tastendruck mitten
    // in der Fahrt oder ein Fokussprung schoben die Mitte fuer immer weg, und
    // der Klick auf den bereits aktiven Reiter war die eine Geste, die
    // beweisbar nichts tat.
    vi.useFakeTimers()
    try {
      stelleMedia(false)
      act(() => root.render(rad(2)))
      const soll = rufe.at(-1)!.left!
      rufe.length = 0
      act(() => {
        stand = soll + 137
        spur().dispatchEvent(new Event('scroll'))
      })
      expect(rufe, 'sofort darf nichts passieren, der Nutzer schiebt noch').toHaveLength(0)
      act(() => { vi.advanceTimersByTime(RUHE_MS + 10) })
      expect(rufe.at(-1)?.left).toBe(soll)
    } finally {
      vi.useRealTimers()
    }
  })

  it('steht die Spur schon richtig, wird sie in Ruhe gelassen', () => {
    // Negativkontrolle zum Fall davor. Nach einer eigenen Fahrt darf die
    // Rueckholung nicht noch einmal feuern, sonst zappelt die Reihe nach jedem
    // Klick nach.
    vi.useFakeTimers()
    try {
      stelleMedia(false)
      act(() => root.render(rad(2)))
      rufe.length = 0
      act(() => { spur().dispatchEvent(new Event('scroll')) })
      act(() => { vi.advanceTimersByTime(RUHE_MS + 10) })
      expect(rufe).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ein Wisch um genau eine Umdrehung wird stumm zurueckgesetzt', () => {
    // Das Bild ist danach identisch, eine weiche Fahrt ueber eine ganze
    // Umdrehung waere reine Bewegung ohne Aussage.
    vi.useFakeTimers()
    try {
      stelleMedia(false)
      act(() => root.render(rad(2)))
      const soll = rufe.at(-1)!.left!
      rufe.length = 0
      act(() => {
        stand = soll + ring()
        spur().dispatchEvent(new Event('scroll'))
      })
      act(() => { vi.advanceTimersByTime(RUHE_MS + 10) })
      expect(rufe, 'kein scrollTo, der Sprung ist unsichtbar').toHaveLength(0)
      expect(stand).toBe(soll)
    } finally {
      vi.useRealTimers()
    }
  })

  it('der Klick auf eine Kopie setzt den Fokus auf den echten Zwilling', () => {
    // Sonst stuende der Fokus danach auf einem Feld, das gerade aus dem Bild
    // faehrt, und der naechste Tab spraenge irgendwohin.
    stelleMedia(false)
    act(() => root.render(rad(0)))
    const kopie = host.querySelector<HTMLButtonElement>('[data-wheel-kopie="1"][data-wheel-datenindex="3"] button')!
    act(() => { kopie.click() })
    return new Promise<void>((fertig) => {
      requestAnimationFrame(() => {
        const echt = host.querySelector<HTMLButtonElement>(
          '[data-wheel-distance]:not([data-wheel-kopie])[data-wheel-datenindex="3"] button',
        )
        expect(document.activeElement).toBe(echt)
        fertig()
      })
    })
  })
})

describe('beide Einsatzorte sind wirklich verdrahtet', () => {
  const lies = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')
  // Kommentare raus, wie im Block darunter: sonst genuegt ein Satz ueber eine
  // Klasse, um einen Waechter zufriedenzustellen.
  const ohneKommentare = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

  it('die Kopfnavigation bekommt ihre drei Nachbarn je Seite', () => {
    // Und jetzt bekommt sie sie wirklich. Der Deckel, der aus den drei zwei
    // machte, ist weg: die Wiederholung an der Kante ist Absicht, nicht ein
    // Fehler, den man mit einem kleineren Radius wegkauft.
    const src = ohneKommentare(lies('layout/Header.tsx'))
    expect(src).toContain('<WheelNav')
    expect(src).toMatch(/radius=\{3\}/)
    expect(src).toContain('activeIndex={navTargets.findIndex(isNavActive)}')
  })

  it('die Create-Werkzeuge mit fuenf', () => {
    const src = ohneKommentare(lies('create/experimental/IntentBar.tsx'))
    expect(src).toContain('<WheelNav')
    expect(src).toMatch(/radius=\{5\}/)
    expect(src).toMatch(/activeIndex=\{intents\.findIndex/)
  })

  it('und die zwoelf Werkzeuge sind wirklich zwoelf', () => {
    // Die Fuenf je Seite ergeben nur Sinn, solange die Liste lang genug ist.
    const src = lies('create/experimental/intents.ts')
    expect((src.match(/^ {4}id: '/gm) ?? []).length).toBe(12)
  })
})

describe('die Mitte des Rades ist die Mitte der Leiste', () => {
  // David, 04.09.2026: „der ist viel zu weit links ... das ausgewaehlte im
  // drehrad ist immer hardstuck mittig. keine ausnahme."
  //
  // Das Rad zentriert seinen aktiven Eintrag in SEINER SPUR. Ob diese Spur in
  // der Leiste mittig sitzt, ist eine Frage des Aufrufers, und genau dort war
  // der Fehler: die Kopfzeile war ein Raster `auto | 1fr | auto`, und die
  // Mitte der mittleren Spalte liegt nur dann auf der Mitte der Leiste, wenn
  // die beiden Aussenspalten gleich breit sind. Sie waren es nie (links rund
  // 62px, rechts rund 150px), also stand das Rad rund 44px zu weit links.
  //
  // Geprueft wird die Bauweise, nicht die Pixel: vitest laeuft hier ohne
  // Fenster, jede Pixelzahl waere eine Behauptung. Die Zahlen stehen in den
  // Kommentaren der beiden Dateien.
  const lies = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')
  const ohneKommentare = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  const navTeil = () => {
    const src = ohneKommentare(lies('layout/Header.tsx'))
    return src.slice(src.indexOf('<nav'), src.indexOf('</nav>'))
  }

  it('die Kopfzeile ist kein Raster mit ungleichen Aussenspalten mehr', () => {
    expect(ohneKommentare(lies('layout/Header.tsx'))).not.toContain('grid-cols-[auto_1fr_auto]')
  })

  it('die Navigation haengt an der echten Mitte der Leiste', () => {
    const src = ohneKommentare(lies('layout/Header.tsx'))
    // Der Anker muss auch da sein, sonst haengt die absolute Position am
    // naechsten positionierten Vorfahren irgendwo weiter oben.
    expect(src).toMatch(/<header className="relative /)
    const nav = navTeil()
    expect(nav).toContain('absolute')
    expect(nav).toContain('left-1/2')
    expect(nav).toContain('-translate-x-1/2')
  })

  it('die leere Flaeche neben dem Rad schluckt keine Klicks', () => {
    // Unterhalb von `lg` ist die Huelle breiter als das Kebab darin und liegt
    // ueber dem Hell-Dunkel-Schalter. Ohne diese Zeile waere die harte Mitte
    // mit einem toten Schalter bezahlt.
    const nav = navTeil()
    expect(nav).toContain('pointer-events-none')
    expect(nav).toContain('[&>*]:pointer-events-auto')
  })

  it('nichts anderes teilt sich die Mitte mit dem Rad', () => {
    // Der Stale-Hinweis stand einmal in dieser Gruppe und schob das Rad zur
    // Seite, sobald er auftauchte. „Keine Ausnahme" heisst auch: keine
    // Ausnahme, wenn ein Modell kaputt ist. Geprueft wird deshalb nicht ein
    // einzelner Bezeichner, sondern jedes Bauteil der Kopfzeile, das einen
    // Zustand zeigt oder umschaltet.
    const nav = navTeil()
    for (const fremd of ['staleError', 'CloudSwitch', 'DownloadBadge', 'UpdateBadge', 'ModelSelector']) {
      expect(nav, `${fremd} steht in der Mitte`).not.toContain(fremd)
    }
  })

  it('die Kopfspur hat einen Deckel, sonst ist sie kein Ausschnitt', () => {
    // Ohne Deckel fuellte das Rad die ganze Leistenbreite, und der Verlauf
    // waere Dekoration statt Orientierung.
    const nav = navTeil()
    expect(nav).toMatch(/max-w-\[\d+rem\]/)
  })

  it('die Create-Leiste zentriert ihr Rad ebenso hart', () => {
    const src = ohneKommentare(lies('create/experimental/IntentBar.tsx'))
    const ruf = src.slice(src.indexOf('<WheelNav'), src.indexOf('>', src.indexOf('reihenClass')))
    expect(ruf).toContain('mx-auto')
    expect(ruf).toMatch(/max-w-\[\d+rem\]/)
  })

  it('und ihr Deckel ist in Layout-Pixeln gerechnet, nicht in gerenderten', () => {
    // Genau daran ist der alte Deckel gescheitert: 62rem sind 992px, die
    // gemessenen 1068px stammen aber von einem Fenster mit --ui-scale 1,15,
    // in Layout-Pixeln also 928,7. Der Deckel lag ueber der Breite aller
    // zwoelf Pillen und tat das Gegenteil dessen, was sein Kommentar sagte.
    const src = ohneKommentare(lies('create/experimental/IntentBar.tsx'))
    const treffer = src.match(/max-w-\[(\d+)rem\]/)
    expect(treffer).not.toBeNull()
    expect(Number(treffer![1]) * 16).toBeLessThan(928.7)
  })
})
