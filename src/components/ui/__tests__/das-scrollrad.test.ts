/**
 * Das Scrollrad: der aktive Eintrag in der Mitte, die Nachbarn nach aussen
 * blasser, ein Klick faehrt weich dorthin.
 *
 * David, 03.09.2026: „3 Optionen zur linken und 3 zur rechten sollen immer
 * blasser werden und bei Anklicken drauf scrollen mit smooth Effekt und dann
 * klar deutlich zu lesen sein. Fuer Chat Create Benchmark etc in der Mitte des
 * Top-Panels, und bei Create mit allen 12 auch genau gleiches Prinzip aber mit
 * 5 sichtbar zu jeder Seite."
 *
 * Was hier geprueft wird, ist die Rechnung und die Verdrahtung. Was hier NICHT
 * geprueft werden kann, ist das Scrollen selbst: jsdom hat kein Layout, also
 * sind `offsetLeft` und `clientWidth` immer null, und `scrollTo` ist eine
 * Attrappe. Die weiche Bewegung ist am laufenden Fenster nachzusehen, nicht
 * hier. Deshalb steht unten kein Fall, der behauptet, gescrollt worden zu
 * sein.
 *
 * Run: npx vitest run src/components/ui/__tests__/das-scrollrad.test.ts
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { deckkraft, WHEEL_BODEN, WheelNav } from '../WheelNav'

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

describe('was das Bauteil wirklich rendert', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
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

  it('jeder Eintrag traegt seinen Abstand zur Mitte', () => {
    act(() => root.render(rad(2, 3, 6)))
    const felder = [...host.querySelectorAll('[data-wheel-distance]')]
    expect(felder.map((f) => f.getAttribute('data-wheel-distance'))).toEqual(
      ['2', '1', '0', '1', '2', '3'],
    )
  })

  it('und die Deckkraft, die zu diesem Abstand gehoert', () => {
    act(() => root.render(rad(0, 3, 4)))
    const felder = [...host.querySelectorAll<HTMLElement>('[data-wheel-distance]')]
    expect(felder.map((f) => f.style.opacity)).toEqual(
      [0, 1, 2, 3].map((d) => String(deckkraft(d, 3))),
    )
  })

  it('die Kinder bleiben Kinder, das Rad schiebt sich nicht dazwischen', () => {
    // Ein Rad, das die Knoepfe durch eigene ersetzt, verloere jeden Handler
    // und jede ARIA-Auszeichnung der Aufrufstelle.
    act(() => root.render(rad(1, 3, 3)))
    expect(host.querySelectorAll('button')).toHaveLength(3)
    expect(host.querySelector('button')?.textContent).toBe('Ziel 0')
  })

  it('die Spur ist eine echte Scrollflaeche ohne Balken', () => {
    act(() => root.render(rad(1, 3, 3)))
    const spur = host.querySelector('[data-testid="wheel-nav"]')
    expect(spur?.className).toContain('overflow-x-auto')
    expect(spur?.className).toContain('lu-wheel-track')
  })

  it('ein Index ausserhalb der Liste laesst alles auf dem Boden stehen', () => {
    // Kommt vor: in der Kopfzeile liefert `findIndex` -1, solange keins der
    // Ziele aktiv ist. Das darf keine NaN-Deckkraft ergeben.
    act(() => root.render(rad(-1, 3, 3)))
    const felder = [...host.querySelectorAll<HTMLElement>('[data-wheel-distance]')]
    for (const f of felder) {
      const wert = Number(f.style.opacity)
      expect(Number.isFinite(wert)).toBe(true)
      expect(wert).toBeGreaterThanOrEqual(WHEEL_BODEN)
      expect(wert).toBeLessThanOrEqual(1)
    }
  })
})

describe('beide Einsatzorte sind wirklich verdrahtet', () => {
  const lies = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')

  it('die Kopfnavigation faehrt mit drei Nachbarn je Seite', () => {
    const src = lies('layout/Header.tsx')
    expect(src).toContain('<WheelNav')
    expect(src).toMatch(/radius=\{3\}/)
    expect(src).toContain('activeIndex={navTargets.findIndex(isNavActive)}')
  })

  it('die Create-Werkzeuge mit fuenf', () => {
    const src = lies('create/experimental/IntentBar.tsx')
    expect(src).toContain('<WheelNav')
    expect(src).toMatch(/radius=\{5\}/)
    expect(src).toMatch(/activeIndex=\{intents\.findIndex/)
  })

  it('und die zwoelf Werkzeuge sind wirklich zwoelf', () => {
    // Die Fuenf je Seite ergeben nur Sinn, solange die Liste lang genug ist.
    // Schrumpft sie auf sieben, ist der Radius groesser als die halbe Liste
    // und der Verlauf erreicht seinen Boden nie.
    const src = lies('create/experimental/intents.ts')
    expect((src.match(/^ {4}id: '/gm) ?? []).length).toBe(12)
  })
})

describe('wann die Fahrt weich ist und wann nicht', () => {
  // jsdom hat kein Layout: `clientWidth` ist ueberall null, also bliebe das
  // Polster null und der Effekt stiege sofort wieder aus. Eine gestellte
  // Breite macht genau den Zweig pruefbar, um den es hier geht. Gemessen wird
  // NICHT, wohin gefahren wird (das kann nur ein Fenster mit Layout sagen),
  // sondern nur WIE.
  let host: HTMLDivElement
  let root: Root
  let rufe: ScrollToOptions[]
  let breite: PropertyDescriptor | undefined
  let scrollTo: PropertyDescriptor | undefined
  let media: typeof window.matchMedia

  const stelleBreite = () => {
    breite = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 400,
    })
  }

  const stelleMedia = (reduziert: boolean) => {
    window.matchMedia = ((q: string) =>
      ({ matches: reduziert, media: q }) as MediaQueryList) as typeof window.matchMedia
  }

  beforeEach(() => {
    rufe = []
    media = window.matchMedia
    scrollTo = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo')
    Object.defineProperty(Element.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: (o: ScrollToOptions) => { rufe.push(o) },
    })
    stelleBreite()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    window.matchMedia = media
    if (breite) Object.defineProperty(HTMLElement.prototype, 'clientWidth', breite)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
    if (scrollTo) Object.defineProperty(Element.prototype, 'scrollTo', scrollTo)
    else delete (Element.prototype as unknown as Record<string, unknown>).scrollTo
  })

  const rad = (activeIndex: number) =>
    createElement(WheelNav, {
      activeIndex,
      radius: 3,
      children: Array.from({ length: 6 }, (_, i) =>
        createElement('button', { key: i, type: 'button' }, `Ziel ${i}`),
      ),
    })

  it('das erste Zeichnen springt, es faehrt nicht von links herein', () => {
    stelleMedia(false)
    act(() => root.render(rad(2)))
    expect(rufe.length).toBeGreaterThan(0)
    expect(rufe[0].behavior).toBe('auto')
  })

  it('ein Klick danach faehrt weich', () => {
    stelleMedia(false)
    act(() => root.render(rad(2)))
    rufe.length = 0
    act(() => root.render(rad(5)))
    expect(rufe.at(-1)?.behavior).toBe('smooth')
  })

  it('wer weniger Bewegung bestellt hat, bekommt auch beim Klick keine', () => {
    stelleMedia(true)
    act(() => root.render(rad(2)))
    rufe.length = 0
    act(() => root.render(rad(5)))
    expect(rufe.at(-1)?.behavior).toBe('auto')
  })
})
