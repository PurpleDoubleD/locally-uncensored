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
import { deckkraft, sichtbarerRadius, WHEEL_BODEN, WheelNav } from '../WheelNav'

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

describe('der Deckel auf dem Radius', () => {
  it('ein Rad zeigt nie denselben Eintrag links und rechts', () => {
    // Bei n Eintraegen und r Nachbarn je Seite sind 2r+1 Felder im Fenster.
    // Sobald 2r+1 groesser als n ist, muss sich etwas wiederholen.
    for (let n = 3; n <= 20; n++) {
      for (const gewuenscht of [1, 3, 5, 99]) {
        const r = sichtbarerRadius(gewuenscht, n)
        expect(2 * r + 1, `n=${n}, gewuenscht=${gewuenscht}`).toBeLessThanOrEqual(n)
        expect(r).toBeLessThanOrEqual(gewuenscht)
      }
    }
  })

  it('die beiden echten Einsatzorte bekommen, was sie brauchen', () => {
    // Zwoelf Create-Werkzeuge tragen die fuenf je Seite, die David wollte.
    expect(sichtbarerRadius(5, 12)).toBe(5)
    // Sechs Kopfziele tragen zwei statt drei.
    expect(sichtbarerRadius(3, 6)).toBe(2)
    // Im Cloud-Modus fallen Benchmark und Models weg, dann bleibt einer.
    expect(sichtbarerRadius(3, 4)).toBe(1)
  })

  it('zu kurze Listen bekommen gar keinen Verlauf', () => {
    // Negativkontrolle gegen einen Deckel, der bei kleinem n negativ wird.
    expect(sichtbarerRadius(3, 2)).toBe(0)
    expect(sichtbarerRadius(3, 1)).toBe(0)
    expect(sichtbarerRadius(3, 0)).toBe(0)
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

  /** Die Abstaende in der Reihenfolge, in der sie gerendert werden. */
  const abstaende = () =>
    [...host.querySelectorAll('[data-wheel-distance]')].map((f) =>
      Number(f.getAttribute('data-wheel-distance')),
    )

  /** Der Text jedes Feldes, in der Reihenfolge der Reihe. */
  const texte = () =>
    [...host.querySelectorAll('[data-wheel-distance]')].map((f) => f.textContent ?? '')

  it('jeder Eintrag traegt seinen Abstand zur Mitte', () => {
    // Sechs Ziele, gewuenschter Radius drei, also gedeckelt auf zwei. Die
    // geschlossene Reihe ist [4,5, 0,1,2,3,4,5, 0,1], zehn Felder, und der
    // aktive (Index 2) sitzt bei 2 + 2 = 4.
    act(() => root.render(rad(2, 3, 6)))
    expect(abstaende()).toEqual([4, 3, 2, 1, 0, 1, 2, 3, 4, 5])
  })

  it('und die Deckkraft, die zu diesem Abstand gehoert', () => {
    // Vier Ziele, Radius gedeckelt auf eins. Reihe [3, 0,1,2,3, 0], aktiv bei 1.
    act(() => root.render(rad(0, 3, 4)))
    const felder = [...host.querySelectorAll<HTMLElement>('[data-wheel-distance]')]
    expect(felder.map((f) => f.style.opacity)).toEqual(
      [1, 0, 1, 2, 3, 4].map((d) => String(deckkraft(d, 1))),
    )
  })

  it('die Kinder bleiben Kinder, das Rad schiebt sich nicht dazwischen', () => {
    // Ein Rad, das die Knoepfe durch eigene ersetzt, verloere jeden Handler
    // und jede ARIA-Auszeichnung der Aufrufstelle. Es sind jetzt drei echte
    // und zwei Kopien, also fuenf Knoepfe, und der erste ist die Kopie des
    // letzten Ziels.
    act(() => root.render(rad(1, 3, 3)))
    expect(host.querySelectorAll('button')).toHaveLength(5)
    expect(host.querySelector('button')?.textContent).toBe('Ziel 2')
    expect(texte()).toEqual(['Ziel 2', 'Ziel 0', 'Ziel 1', 'Ziel 2', 'Ziel 0'])
  })

  it('links und rechts stehen IMMER gleich viele Nachbarn', () => {
    // David, 04.09.2026: „links und rechts sollen immer gleich viele optionen
    // sein nicht alles nach links und alles nach rechts wenn man durch
    // klickt." Das ist die Zusage, und sie gilt fuer JEDEN aktiven Eintrag,
    // auch fuer den ersten und den letzten. Genau dort war die gerade Liste
    // vorher einseitig.
    for (const n of [3, 4, 6, 12]) {
      const r = sichtbarerRadius(5, n)
      for (let a = 0; a < n; a++) {
        act(() => root.render(rad(a, 5, n)))
        const d = abstaende()
        const mitte = d.indexOf(0)
        expect(mitte, `n=${n} a=${a}: keine Mitte`).toBeGreaterThan(-1)
        expect(mitte, `n=${n} a=${a}: links zu wenig`).toBeGreaterThanOrEqual(r)
        expect(d.length - 1 - mitte, `n=${n} a=${a}: rechts zu wenig`).toBeGreaterThanOrEqual(r)
      }
    }
  })

  it('und im sichtbaren Fenster steht kein Wort zweimal', () => {
    // Der Grund fuer den Deckel. Zeigte das Rad drei Nachbarn je Seite bei
    // sechs Eintraegen, waere der dritte links derselbe wie der dritte rechts.
    for (const n of [3, 4, 6, 12]) {
      const r = sichtbarerRadius(5, n)
      for (let a = 0; a < n; a++) {
        act(() => root.render(rad(a, 5, n)))
        const t = texte()
        const mitte = abstaende().indexOf(0)
        const fenster = t.slice(mitte - r, mitte + r + 1)
        expect(new Set(fenster).size, `n=${n} a=${a}: ${fenster.join(', ')}`).toBe(fenster.length)
      }
    }
  })

  it('die Kopien sind fuer die Maus da, nicht fuer die Tastatur', () => {
    // Sonst haette jedes Ziel mehrere Tab-Stationen und wuerde vom
    // Screenreader mehrfach vorgelesen. Der Klick bleibt: wer links neben dem
    // ersten Eintrag auf den letzten klickt, landet auf dem letzten.
    act(() => root.render(rad(0, 3, 6)))
    const kopien = [...host.querySelectorAll('[data-wheel-kopie="1"] button')]
    const echte = [...host.querySelectorAll('[data-wheel-distance]:not([data-wheel-kopie]) button')]
    expect(kopien.length).toBe(4)
    expect(echte.length).toBe(6)
    for (const k of kopien) {
      expect(k.getAttribute('tabindex')).toBe('-1')
      expect(k.getAttribute('aria-hidden')).toBe('true')
    }
    for (const e of echte) {
      expect(e.getAttribute('tabindex')).toBeNull()
      expect(e.getAttribute('aria-hidden')).toBeNull()
    }
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

  it('die Kopfnavigation bittet um drei Nachbarn je Seite', () => {
    // Sie bekommt zwei: sechs Ziele lassen nicht mehr zu, ohne dass derselbe
    // Reiter links und rechts steht. Der Wunsch bleibt trotzdem im Aufruf
    // stehen, denn er gilt, sobald ein siebtes Ziel dazukommt.
    const src = lies('layout/Header.tsx')
    expect(src).toContain('<WheelNav')
    expect(src).toMatch(/radius=\{3\}/)
    expect(src).toContain('activeIndex={navTargets.findIndex(isNavActive)}')
    expect(sichtbarerRadius(3, 6)).toBe(2)
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

  it('die Kopfzeile ist kein Raster mit ungleichen Aussenspalten mehr', () => {
    const src = ohneKommentare(lies('layout/Header.tsx'))
    expect(src).not.toContain('grid-cols-[auto_1fr_auto]')
  })

  it('die Navigation haengt an der echten Mitte der Leiste', () => {
    const src = ohneKommentare(lies('layout/Header.tsx'))
    // Der Anker muss auch da sein, sonst haengt die absolute Position am
    // naechsten positionierten Vorfahren irgendwo weiter oben.
    expect(src).toMatch(/<header className="relative /)
    const nav = src.slice(src.indexOf('<nav'), src.indexOf('</nav>'))
    expect(nav).toContain('absolute')
    expect(nav).toContain('left-1/2')
    expect(nav).toContain('-translate-x-1/2')
  })

  it('die leere Flaeche neben dem Rad schluckt keine Klicks', () => {
    // Unterhalb von `lg` ist die Huelle breiter als das Kebab darin und liegt
    // ueber dem Hell-Dunkel-Schalter. Ohne diese Zeile waere die harte Mitte
    // mit einem toten Schalter bezahlt.
    const src = ohneKommentare(lies('layout/Header.tsx'))
    const nav = src.slice(src.indexOf('<nav'), src.indexOf('</nav>'))
    expect(nav).toContain('pointer-events-none')
    expect(nav).toContain('[&>*]:pointer-events-auto')
  })

  it('nichts anderes teilt sich die Mitte mit dem Rad', () => {
    // Der Stale-Hinweis stand in dieser Gruppe und schob das Rad zur Seite,
    // sobald er auftauchte. „Keine Ausnahme" heisst auch: keine Ausnahme,
    // wenn ein Modell kaputt ist.
    const src = ohneKommentare(lies('layout/Header.tsx'))
    const nav = src.slice(src.indexOf('<nav'), src.indexOf('</nav>'))
    expect(nav).not.toContain('staleError')
  })

  it('die Create-Leiste zentriert ihr Rad ebenso hart', () => {
    // Dort steht nichts neben dem Rad, deshalb reicht der zentrierte
    // Blockkasten. Ein Deckel muss trotzdem sein, sonst stuenden alle zwoelf
    // Werkzeuge nebeneinander und der Klick bewegte nichts.
    const src = ohneKommentare(lies('create/experimental/IntentBar.tsx'))
    const ruf = src.slice(src.indexOf('<WheelNav'), src.indexOf('>', src.indexOf('reihenClass')))
    expect(ruf).toContain('mx-auto')
    expect(ruf).toMatch(/max-w-\[\d+rem\]/)
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
