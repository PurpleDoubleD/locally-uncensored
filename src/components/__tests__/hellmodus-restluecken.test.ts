/**
 * Die drei Hellmodus-Luecken, die f336b91e offen liess.
 *
 * Der Commit hat den Welle-2-Posten „Light-Mode-Luecken" groesstenteils
 * erledigt und drei Stellen ausdruecklich GEMELDET statt geaendert:
 *
 *   • `ProviderConfig.tsx:697` — „eine echte Luecke, liegt aber in
 *     gesperrtem Gebiet."
 *   • `UpdateBadge.tsx:109` und das QR-Modal in `Sidebar.tsx:710` —
 *     „tragen zwar Hex-Flaechen ohne `dark:`, ihr Inneres ist aber
 *     durchgehend dunkelmodus-only gefaerbt. Nur die Flaeche umzustellen
 *     waere eine Verschlimmbesserung."
 *
 * Alle drei standen bei der Re-Verifikation noch genau dort. Die Ursache
 * ist an allen drei Stellen dieselbe und sie ist zweiteilig — deshalb ist
 * sie so schlecht sichtbar:
 *
 *   1. Die Flaeche ist ein Hex-Literal OHNE `dark:`, bleibt im Hellmodus
 *      also dunkel.
 *   2. Der Rescue-Layer in index.css dreht die Schrift DARIN gleichzeitig
 *      nach unten (`.light .text-gray-500 → rgb(55 65 81)`), weil er
 *      annimmt, unter `.light` sei der Grund hell.
 *
 * Beides zusammen ergibt dunkle Schrift auf dunkler Flaeche. Genau das
 * rechnet dieser Test nach — aus den ECHTEN Werten in index.css, nicht aus
 * abgeschriebenen Zahlen: 1,17:1 waere das Ergebnis gewesen, wenn man die
 * Flaeche stehen laesst.
 *
 * Die Kontrastrechnung ist die aus `primary-recipe.test.ts`, jetzt in
 * `./wcag-contrast` — eine Implementierung, zwei Nutzer.
 *
 * Run: npx vitest run src/components/__tests__/hellmodus-restluecken.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { contrast, over, rgbToHex } from './wcag-contrast'

const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf-8')
const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf-8')

/**
 * Kommentare raus, bevor gescannt wird. Die Begruendungen im Quelltext
 * ZITIEREN die alten Klassen (`bg-[#363636]`), damit der naechste Leser
 * weiss, was da stand — ein Scanner, der Kommentare mitliest, wuerde
 * genau diese Erklaerung als Verstoss melden.
 */
function ohneKommentare(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
}

const PROVIDER = read('../settings/ProviderConfig.tsx')
const BADGE = read('../layout/UpdateBadge.tsx')
const SIDEBAR = read('../layout/Sidebar.tsx')

const WHITE = '#ffffff'

/** Einen `--color-*: #rrggbb;`-Token aus dem @theme-Block lesen. */
function token(name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`))
  if (!m) throw new Error(`Token --${name} fehlt in index.css`)
  return m[1]
}

/** Was der Rescue-Layer im Hellmodus aus einer grauen Textklasse macht. */
function rescued(utility: string): string {
  const m = css.match(new RegExp(`\\.light \\.${utility} \\{ color: (rgb\\([^)]*\\)); \\}`))
  if (!m) throw new Error(`Rescue-Regel .light .${utility} fehlt in index.css`)
  return rgbToHex(m[1])
}

/**
 * Die Tailwind-v4-Standardpalette, soweit hier gebraucht. Hartkodiert und
 * damit die einzige abgeschriebene Zahlenreihe im Test — dafuer wird sie
 * unten gegen den Rescue-Layer gegengeprueft, der dieselben Werte in
 * index.css nochmal ausschreibt.
 */
const TW = {
  'gray-800': '#1f2937',
  'gray-900': '#111827',
  'green-400': '#4ade80',
  'green-600': '#16a34a',
  'green-700': '#15803d',
  'emerald-300': '#6ee7b7',
  'emerald-400': '#34d399',
  'emerald-600': '#059669',
  'emerald-700': '#047857',
  'blue-400': '#60a5fa',
  'blue-600': '#2563eb',
  'blue-700': '#1d4ed8',
  'red-400': '#f87171',
  'red-600': '#dc2626',
  'red-700': '#b91c1c',
  'amber-400': '#fbbf24',
  'amber-700': '#b45309',
} as const

describe('die Palette im Test stimmt mit der in index.css ueberein', () => {
  it('gray-800 und gray-900 sind dieselben Werte, die der Rescue-Layer schreibt', () => {
    // Ohne diese Wache koennte die Tabelle oben still veralten und der
    // ganze Rest waere Rechnen mit Fantasiefarben.
    expect(rescued('text-gray-200')).toBe(TW['gray-800'])
    expect(rescued('text-white')).toBe(TW['gray-900'])
  })
})

describe('WARUM es kaputt war: Rescue-Schrift auf stehengebliebener Hex-Flaeche', () => {
  // Die beiden Flaechen, die dort standen. Sie sind absichtlich als
  // Literale hier — sie stehen im Quelltext ja gerade NICHT mehr.
  const ALTE_FLAECHE_DROPDOWN = '#363636'
  const ALTE_FLAECHE_MODAL = '#212121'

  it('gray-500 auf #363636 war 1,17:1 — unter jedem Schwellwert, den es gibt', () => {
    const v = contrast(rescued('text-gray-500'), ALTE_FLAECHE_DROPDOWN)
    expect(v).toBeLessThan(1.5)
    expect(v).toBeCloseTo(1.17, 2)
  })

  it('gray-600 auf #363636 war 1,21:1', () => {
    expect(contrast(rescued('text-gray-600'), ALTE_FLAECHE_DROPDOWN)).toBeCloseTo(1.21, 2)
  })

  it('gray-400 im QR-Modal auf #212121 war 1,56:1', () => {
    expect(contrast(rescued('text-gray-400'), ALTE_FLAECHE_MODAL)).toBeCloseTo(1.56, 2)
  })

  it('auf der weissen Flaeche tragen dieselben Klassen sofort', () => {
    // Kein zusaetzlicher Eingriff noetig: der Rescue-Layer ist richtig,
    // sobald der Grund das ist, wofuer er gebaut wurde.
    expect(contrast(rescued('text-gray-500'), WHITE)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(rescued('text-gray-600'), WHITE)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(rescued('text-gray-400'), WHITE)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(rescued('text-gray-300'), WHITE)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('WARUM die Flaeche allein nicht gereicht haette', () => {
  // Das ist die Begruendung aus f336b91e, nachgerechnet: haette man nur
  // `bg-[#363636]` auf weiss gedreht, waeren die Akzente darin von
  // „lesbar" auf „unsichtbar" gekippt. Deshalb Flaeche UND Akzente.
  const DARK_ONLY: Array<[keyof typeof TW, string]> = [
    ['emerald-400', 'Statuszeile, Version, Aktionsknopf'],
    ['emerald-300', 'Trigger im Zustand „bereit"'],
    ['green-400', 'LIVE-Zeile im QR-Modal, „Active" in ProviderConfig'],
    ['blue-400', 'Trigger waehrend des Downloads'],
    ['red-400', 'Fehlerzustand'],
    ['amber-400', 'Passcode im QR-Modal'],
  ]

  it.each(DARK_ONLY)('%s faellt auf Weiss durch (%s)', (name) => {
    expect(contrast(TW[name], WHITE)).toBeLessThan(3)
  })

  it.each(DARK_ONLY.filter(([n]) => n !== 'red-400'))(
    '%s traegt dafuer auf der dunklen Flaeche',
    (name) => {
      expect(contrast(TW[name], token('color-lu-overlay'))).toBeGreaterThanOrEqual(4.5)
    },
  )

  it('NEBENBEFUND: red-400 traegt auch im Dunkelmodus nicht ganz', () => {
    // Beim Nachrechnen aufgefallen und NICHT geaendert, weil es eine
    // Dunkelmodus-Frage ist und der Auftrag der Hellmodus war: die
    // Fehlerfarbe steht auf der Overlay-Flaeche bei 4,37:1 und verfehlt AA
    // (4,5:1) knapp — mit `/80` Deckung, wie sie in UpdateBadge steht,
    // noch etwas mehr. Hier festgehalten, damit die Zahl nicht wieder
    // verlorengeht, statt sie stillschweigend wegzudefinieren.
    const auf = contrast(TW['red-400'], token('color-lu-overlay'))
    expect(auf).toBeCloseTo(4.37, 2)
    expect(auf).toBeLessThan(4.5)
    // Mit Deckung 80% auf derselben Flaeche wird es messbar schlechter.
    expect(contrast(over(TW['red-400'], token('color-lu-overlay'), 0.8), token('color-lu-overlay')))
      .toBeLessThan(auf)
  })
})

describe('NACHHER: die Hell-Pendants erreichen AA', () => {
  const HELL: Array<[keyof typeof TW, number]> = [
    ['green-700', 5.02],
    ['emerald-700', 5.48],
    ['blue-700', 6.7],
    ['red-700', 6.47],
    ['amber-700', 5.02],
  ]

  it.each(HELL)('%s auf Weiss = %s:1', (name, erwartet) => {
    expect(contrast(TW[name], WHITE)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(TW[name], WHITE)).toBeCloseTo(erwartet, 1)
  })

  it('die Nicht-Text-Signale erreichen 3:1 (WCAG 1.4.11)', () => {
    // Statuspunkt am Badge, Fortschrittsbalken, LIVE-Punkt im Modal: die
    // tragen keine Schrift, also gilt 1.4.11 statt 1.4.3.
    for (const name of ['emerald-600', 'blue-600', 'red-600', 'green-600'] as const) {
      expect(contrast(TW[name], WHITE), name).toBeGreaterThanOrEqual(3)
    }
  })

  it('und die dunkle Seite bleibt unangetastet gut', () => {
    expect(contrast(TW['emerald-400'], token('color-lu-overlay'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(TW['amber-400'], token('color-lu-base'))).toBeGreaterThanOrEqual(4.5)
  })
})

// ── Und jetzt: steht das auch wirklich so im Quelltext? ──────────────

/** Der Abschnitt, den diese Welle in ProviderConfig angefasst hat. */
const PROVIDER_DROPDOWN = PROVIDER.slice(
  PROVIDER.indexOf('{/* Add Provider Dropdown */}'),
  PROVIDER.indexOf('{/* Cloud privacy warning popup */}'),
)
/** Das QR-Modal in der Sidebar, ab seinem Key bis zum Dateiende. */
const QR_MODAL = SIDEBAR.slice(SIDEBAR.indexOf('key="qr-modal"'))

const REGIONEN: Array<[string, string]> = [
  ['ProviderConfig, Add-Provider-Dropdown', PROVIDER_DROPDOWN],
  ['UpdateBadge, ganze Datei', BADGE],
  ['Sidebar, QR-Modal', QR_MODAL],
]

describe('die drei Abschnitte, die dieser Test liest, existieren', () => {
  it.each(REGIONEN)('%s ist nicht leer', (_name, region) => {
    expect(region.length).toBeGreaterThan(400)
  })
})

describe('keine Hex-Flaeche ohne Modus mehr', () => {
  it.each(REGIONEN)('%s: jede Hex-Flaeche ist modus-bewusst', (name, region) => {
    const offenders: string[] = []
    for (const m of ohneKommentare(region).matchAll(/(\S*?)bg-\[(#[0-9a-fA-F]{3,8})\]/g)) {
      if (m[1].includes('dark:')) continue
      offenders.push(m[0])
    }
    expect(offenders, name).toEqual([])
  })

  it('die neuen Flaechen sind Tokens, keine zweiten Literale', () => {
    expect(PROVIDER_DROPDOWN).toContain('bg-white dark:bg-lu-overlay')
    expect(BADGE).toContain('bg-white dark:bg-lu-overlay')
    expect(QR_MODAL).toContain('bg-white dark:bg-lu-base')
  })
})

describe('kein dunkelmodus-only Akzent mehr in diesen Abschnitten', () => {
  // Der zweite Teil der Ursache. Ein `text-emerald-400` OHNE `dark:` ist
  // auf der neuen weissen Flaeche 1,92:1 — die Verschlimmbesserung, vor
  // der f336b91e gewarnt hat. Hier faellt sie auf.
  const AKZENT = /(^|[\s'"`])(?:hover:)?(?:text|bg)-(?:emerald|green|amber|red|blue|purple)-(?:300|400)\b/g

  it.each(REGIONEN)('%s: jeder 300/400-Akzent hat ein Hell-Pendant', (name, region) => {
    const offenders = [...ohneKommentare(region).matchAll(AKZENT)].map((m) => m[0].trim())
    expect(offenders, `${name}: Akzent ohne dark:`).toEqual([])
  })

  it('die Pendants stehen wirklich da, nicht nur die Abwesenheit der Sünde', () => {
    // Negativkontrolle zur Regel darueber: sie waere auch gruen, wenn
    // jemand die Akzente ersatzlos loeschte.
    expect(PROVIDER_DROPDOWN).toContain('text-green-700 dark:text-green-400')
    expect(BADGE).toContain('text-emerald-700 dark:text-emerald-400')
    expect(BADGE).toContain('bg-emerald-600 dark:bg-emerald-400')
    expect(QR_MODAL).toContain('text-amber-700 dark:text-amber-400')
    expect(QR_MODAL).toContain('text-green-700 dark:text-green-400')
  })
})
