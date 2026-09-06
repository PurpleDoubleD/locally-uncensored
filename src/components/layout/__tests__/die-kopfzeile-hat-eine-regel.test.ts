/**
 * Die Kopfzeile — D-S19, D-S20, D-S21 und D-S47.
 *
 *   D-S19  „Rechts stehen 9 Elemente in `gap-2.5`, links nur Burger + Logo,
 *          der Center-Slot ist leer."
 *   D-S20  „Der Overflow-Breakpoint ist `lg` oder `xl` je nach View — dieselbe
 *          Leiste bricht auf Create bei anderer Breite als auf Chat."
 *   D-S21  „Das Overflow-Menue ist kein Menue: Textzeilen ohne Padding, ohne
 *          Hover-Flaeche, ohne `role=menu`."
 *   D-S47  „Im Header klappen 6 Links ins Kebab-Menue, CloudSwitch/Download/
 *          Theme bleiben draussen — ohne erkennbare Regel."
 *
 * Alle vier sind Symptome einer Sache: die Leiste hatte keine Ordnung, nach
 * der man haette sagen koennen, was wohin gehoert. Sie hat jetzt eine, und
 * dieser Test haelt genau diese Ordnung fest — Navigation in die Mitte, alles
 * was einen ZUSTAND zeigt nach rechts, und die Regel ist an der Anordnung
 * ablesbar, nicht nur in einem Kommentar.
 *
 * Run: npx vitest run src/components/layout/__tests__/die-kopfzeile-hat-eine-regel.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const LAYOUT = resolve(__dirname, '..')
const SRC = readFileSync(resolve(LAYOUT, 'Header.tsx'), 'utf-8')
const CODE = SRC.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ')

/** Der Abschnitt zwischen zwei Markern im Code. */
const between = (from: string | RegExp, to: string) => {
  const a = typeof from === 'string' ? CODE.indexOf(from) : CODE.search(from)
  const b = CODE.indexOf(to, a)
  expect(a, `Marker fehlt: ${from}`).toBeGreaterThan(-1)
  expect(b, `Marker fehlt: ${to}`).toBeGreaterThan(a)
  return CODE.slice(a, b)
}

// Seit dem 04.09.2026 steht die Begruendung der harten Mitte zwischen dem
// Namen und der Klasse, das Element hat also je Attribut eine Zeile. Der
// Marker ist deshalb ein Muster und keine feste Zeichenkette: was er pruefen
// soll, ist ein <nav> mit diesem Namen, nicht dessen Zeilenumbrueche.
const NAV_MARKE = /<nav\s+aria-label="Main"/
const NAV = between(NAV_MARKE, '</nav>')
const RIGHT = CODE.slice(CODE.indexOf('</nav>'), CODE.indexOf('</header>'))

describe('D-S19: der Center-Slot traegt jetzt etwas, und rechts steht weniger', () => {
  it('die Navigation steht in der Mitte, in einem echten <nav>', () => {
    expect(CODE).toMatch(NAV_MARKE)
    expect(NAV).toContain('navTargets.map')
  })

  it('und nicht mehr rechts', () => {
    // Alle sechs Ziele stehen in der Datenliste …
    for (const label of ['Chat', 'Create', 'Compare', 'Benchmark', 'Models', 'Settings']) {
      expect(CODE, `${label} fehlt in NAV_TARGETS`).toContain(`label: '${label}'`)
    }
    // … und die rechte Gruppe rendert keins davon mehr.
    expect(RIGHT).not.toContain('navTargets')
    expect(RIGHT).not.toContain('navClass')
    expect(RIGHT).not.toContain('openCompare')
  })

  it('rechts stehen nur Zustandsanzeigen und Schalter', () => {
    const komponenten = [...RIGHT.matchAll(/<([A-Z][A-Za-z]*)\s*\/>/g)].map((m) => m[1])
    expect(komponenten).toEqual(['CloudSwitch', 'DownloadBadge', 'UpdateBadge'])
    // Der Theme-Knopf ist kein eigenes Bauteil und deshalb oben nicht dabei.
    expect(RIGHT).toContain('onClick={toggleTheme}')
  })

  it('und der Stale-Hinweis steht seit dem 04.09.2026 auch hier', () => {
    // Er stand in der Mitte-Gruppe und schob dort das Drehrad zur Seite,
    // sobald ein Modell kaputt war. David: "das ausgewaehlte im drehrad ist
    // immer hardstuck mittig. keine ausnahme."
    //
    // Er gehoert ohnehin hierher, denn er zeigt einen ZUSTAND, und genau das
    // ist die Regel dieser Gruppe. Er bringt zwei eigene Knoepfe mit
    // (nachladen und wegklicken), und beide haengen an der Bedingung: ohne
    // kaputtes Modell steht hier nichts.
    expect(RIGHT).toContain('staleError && (')
    expect(RIGHT).toContain('onClick={handleRefreshStale}')
    expect(RIGHT).toContain('aria-label="Dismiss"')
    expect(NAV).not.toContain('staleError')
  })

  it('und trotzdem steht rechts keine Navigation, auch nicht als Knopf', () => {
    // Die Regel dieser Gruppe ist nicht "wenig", sondern "kein Ziel". Ein
    // Zaehler auf die Knoepfe war die schwaechere Fassung davon: er ging rot,
    // als ein Zustandsanzeiger mit zwei Bedienelementen dazukam, und waere
    // gruen geblieben, wenn jemand einen Navigationsknopf gegen einen
    // anderen getauscht haette.
    for (const t of ['Chat', 'Create', 'Compare', 'Benchmark', 'Models', 'Settings']) {
      expect(RIGHT, `${t} steht rechts`).not.toContain(`>${t}<`)
    }
    expect(RIGHT).not.toContain('setView(')
    expect(RIGHT).not.toContain('navClass')
  })

  it('die Ziele stehen einmal als Daten da, nicht viermal als JSX', () => {
    // Vorher: jeder Eintrag zweimal (Leiste + Menue), „Compare" zusaetzlich in
    // einer eigenen Fassung, weil es keine View ist. Vier Kopien.
    expect(CODE).toMatch(/const NAV_TARGETS: readonly NavTarget\[\] = \[/)
    expect([...CODE.matchAll(/navTargets\.map/g)]).toHaveLength(2) // Leiste + Menue
    expect(CODE).not.toContain('const textNav =')
    expect(CODE).not.toContain('const dropdownNav =')
  })
})

describe('D-S20: ein Breakpoint, nicht zwei', () => {
  it('kein `xl` mehr in dieser Datei', () => {
    expect(CODE).not.toMatch(/\bxl:/)
  })

  it('Leiste und Kebab schalten am selben Punkt', () => {
    // Die Leiste ist seit dem Scrollrad (03.09.2026) ein `block`-Behaelter mit
    // einer eigenen Scrollspur darin und kein `flex`-Behaelter mehr. Der
    // Umschaltpunkt ist derselbe geblieben, und genau das haelt dieser Test
    // fest, nicht die Art des Behaelters.
    expect(NAV).toContain('hidden lg:block')
    expect(NAV).toContain('relative lg:hidden')
  })

  it('und der Punkt haengt nicht mehr an der View', () => {
    // `isCreateView` war die Variable, die den Umbruch view-abhaengig machte.
    expect(CODE).not.toContain('isCreateView')
  })
})

describe('D-S21: das Klappmenue ist ein Menue', () => {
  it('Rollen — die Datei hatte vorher null `role=`-Treffer', () => {
    expect(NAV).toContain('role="menu"')
    expect(NAV).toContain('role="menuitem"')
  })

  it('der Ausloeser sagt, dass er ein Menue oeffnet, und ob es offen ist', () => {
    expect(NAV).toMatch(/aria-haspopup="menu"/)
    expect(NAV).toMatch(/aria-expanded=\{showMoreMenu\}/)
    expect(NAV).toMatch(/aria-label="Main navigation"/)
  })

  it('der aktive Eintrag ist als solcher ausgezeichnet, in Leiste und Menue', () => {
    expect([...NAV.matchAll(/aria-current=\{isNavActive\(t\) \? 'page' : undefined\}/g)]).toHaveLength(2)
  })

  it('wanderndes tabIndex — nur ein Eintrag ist tabbar', () => {
    expect(NAV).toMatch(/tabIndex=\{i === menuActive \? 0 : -1\}/)
  })

  it('Pfeile, Home und End, ueber dieselbe Rechnung wie die Fokusfalle der Modals', () => {
    expect(CODE).toMatch(/case 'ArrowDown':\s*case 'ArrowUp':/)
    expect(CODE).toMatch(/nextFocusIndex\(navTargets\.length, i, e\.key === 'ArrowUp'\)/)
    expect(CODE).toMatch(/case 'Home':/)
    expect(CODE).toMatch(/case 'End':/)
  })

  it('Escape ueber den Stapel — ein Menue ueber einem Dialog schliesst nur sich', () => {
    expect(CODE).toMatch(/if \(!isTopDialog\(menuId\)\) return/)
    expect(CODE).toMatch(/openDialog\(menuId\)/)
    expect(CODE).toMatch(/closeDialog\(menuId\)/)
    expect(CODE).toMatch(/case 'Escape':/)
  })

  it('und der Fokus kommt beim Schliessen zurueck', () => {
    expect(CODE).toMatch(/if \(restoreFocus\) menuTriggerRef\.current\?\.focus\(\)/)
    expect(CODE).toMatch(/menuItemRefs\.current\[menuActive\]\?\.focus\(\)/)
  })

  it('das ist kein drittes Muster — es kommt aus denselben Bausteinen wie ContextMenu', () => {
    expect(SRC).toMatch(
      /import \{ closeDialog, isTopDialog, nextFocusIndex, openDialog \} from '\.\.\/ui\/dialog-a11y'/,
    )
    const CTX = readFileSync(resolve(LAYOUT, '..', 'ui', 'ContextMenu.tsx'), 'utf-8')
    for (const baustein of ['nextFocusIndex', 'isTopDialog', 'openDialog', 'closeDialog']) {
      expect(CTX, `ContextMenu benutzt ${baustein} auch`).toContain(baustein)
    }
  })
})

describe('D-S47: die Kebab-Regel ist an der Anordnung ablesbar', () => {
  it('das Kebab steht bei dem, was es aufnimmt', () => {
    // Vorher stand es rechts, bei CloudSwitch/Download/Theme — also genau bei
    // den drei Dingen, die es NIE aufnimmt.
    expect(NAV).toContain('<MoreVertical')
    expect(RIGHT).not.toContain('<MoreVertical')
  })

  it('und nimmt genau die Ziele auf, die die Leiste zeigt — dieselbe Liste', () => {
    const leiste = NAV.slice(NAV.indexOf('hidden lg:block'), NAV.indexOf('relative lg:hidden'))
    const menue = NAV.slice(NAV.indexOf('relative lg:hidden'))
    expect(leiste).toContain('navTargets.map')
    expect(menue).toContain('navTargets.map')
    // Ein Ziel, das nur in einer der beiden steht, kann es nicht mehr geben.
  })

  it('die rechte Gruppe klappt nie — sie hat kein `lg:`-Verhalten', () => {
    expect(RIGHT).not.toMatch(/\blg:/)
  })

  it('Cloud-Modus blendet dieselben zwei Ziele in beiden Fassungen aus', () => {
    // Vorher stand `settings.appMode !== 'cloud'` viermal im JSX. Jetzt einmal
    // als Filter — Leiste und Menue koennen nicht auseinanderlaufen.
    expect(CODE).toMatch(
      /const navTargets = NAV_TARGETS\.filter\(\(t\) => !t\.localOnly \|\| settings\.appMode !== 'cloud'\)/,
    )
    expect([...CODE.matchAll(/appMode !== 'cloud'/g)]).toHaveLength(1)
  })
})

describe('D-A9: die Marke in der Kopfzeile', () => {
  it('Vektorfassung statt 512px-PNG', () => {
    expect(CODE).toContain('src={MONOGRAM}')
    expect(SRC).not.toContain('LU-monogram-bw.png')
    expect(SRC).toMatch(/import \{ MONOGRAM, MONOGRAM_INVERT \} from '\.\/brand'/)
  })

  it('20px, nicht 33 — die Groesse, die der Audit fuer diese Stelle nennt', () => {
    expect(CODE).toMatch(/src=\{MONOGRAM\} alt="" width=\{20\} height=\{20\}/)
  })
})
