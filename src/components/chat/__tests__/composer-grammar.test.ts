/**
 * Die Composer-Grammatik kennt ZWEI Rezepte, nicht neun.
 *
 * Audit Welle 2, Zeile „Composer-Grammatik": die Prompt-Leiste trug sieben
 * Formsprachen nebeneinander (`ChatInput.tsx:383/411/445/455`,
 * `ChatView.tsx:348`, `PluginsDropdown.tsx:69`, `ModelSelector.tsx:711`).
 * Am Stand von 1dd8db52 waren es neun — die Zeile ist seit dem Audit um den
 * Cloud-Zustand und um Send gewachsen, das in f336b91e schon auf
 * `.lu-primary` gezogen wurde. Aus den Klassen gerechnet bei
 * html-font-size 18,4px (NICHT im laufenden Fenster nachgemessen —
 * die Radien und Polsterungen sind exakt, die Hoehen bis auf die
 * Zeilenhoehe der 11,04px-Beschriftung):
 *
 *   Paperclip   p-1.5 rounded-md               Radius 6,9 · Polster 6,9
 *   Mikrofon    p-1.5 rounded-lg               Radius 9,2 · Polster 6,9
 *   Think       px-1.5 py-1.5 rounded-md       Radius 6,9 · Rand nur EIN
 *   Cloud       px-1.5 py-1.5 rounded-md       Radius 6,9 · Dauer-Rand
 *   Docs        px-2 py-1.5 rounded-md         Radius 6,9 · Rand nur EIN
 *   Tools       px-2 py-1.5 rounded-md         Radius 6,9 · nie ein Rand
 *   Plugins     px-2 py-0.5 rounded            Radius 4,6 · Dauer-Rand
 *   Modell      h-[26px] px-2 rounded-md       Radius 6,9 · Dauer-Rand
 *   Stop        rounded-md bg-red-500/15       Radius 6,9 · 26x26
 *   Send        .lu-primary                    Radius 6,9 · 26x26
 *
 * Vier Hoehenformeln (fest 26px · Polster 6,9 · Polster 6,9 mit Rand ·
 * Polster 2,3), drei Radien (4,6 / 6,9 / 9,2), drei Schriftgroessen
 * (10,12 / 11,04 / 12,88px). Zwei Controls bekommen ihren Rand erst im
 * Ein-Zustand, wachsen beim Umschalten also um 2px.
 *
 * Was dieser Test festhaelt: jedes CONTROL in der Leiste traegt jetzt
 * `.lu-control` (neutral) und hoechstens zusaetzlich `.lu-primary`
 * (betont) — und KEINE eigene Formsprache mehr. Der Test liest die
 * Klassenketten aus dem echten Quelltext, nicht aus einer Liste, die
 * jemand pflegen muesste: wer einen achten Knopf mit eigenem
 * `rounded-*`/`bg-*`/`border-*`/`h-[..]`/`px-*` in die Leiste haengt,
 * faellt hier durch (Mutationssonde, siehe Commit-Text).
 *
 * Ausdruecklich NICHT geprueft, weil ausserhalb dieser Dateien:
 *   • `chat/VoiceButton.tsx` — das Mikrofon ist die einzige verbliebene
 *     eigene Formsprache in der Chat-Leiste. Datei lag ausserhalb des
 *     Auftrags, gemeldet statt blind geaendert.
 *   • `chat/CodexModeDropdown.tsx` — das einzige Control der CODE-Leiste,
 *     eigene Datei, und `the-code-composer-is-one-quiet-row.test.ts` pinnt
 *     seine Klassen bereits.
 *
 * Run: npx vitest run src/components/chat/__tests__/composer-grammar.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { contrast, over, rgbToHex } from '../../__tests__/wcag-contrast'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

const INPUT = read('../ChatInput.tsx')
const VIEW = read('../ChatView.tsx')
const PLUGINS = read('../PluginsDropdown.tsx')
const SELECTOR = read('../../models/ModelSelector.tsx')
const SHELL = read('../../layout/AppShell.tsx')
const CSS = read('../../../index.css')

// ── Quelltext-Werkzeug ───────────────────────────────────────────────

/** Der Ausdruck hinter `prop={`, geschweift-balanciert. */
function propValue(src: string, prop: string): string {
  const start = src.indexOf(`${prop}={`)
  if (start < 0) return ''
  let depth = 0
  for (let i = start + prop.length + 1; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return src.slice(start)
}

/**
 * Alle `className`-Werte der `<button>`/`<motion.button>`-Elemente eines
 * Quelltextabschnitts. Zeichenkette, Template-Literal und Verkettung im
 * geschweiften Ausdruck werden gleichermassen erfasst — es wird ab
 * `className=` geschweift- bzw. anfuehrungszeichen-balanciert gelesen.
 */
function controlClassNames(region: string): string[] {
  const out: string[] = []
  for (const m of region.matchAll(/<(?:motion\.)?button\b/g)) {
    const tagStart = m.index
    const at = region.indexOf('className=', tagStart)
    if (at < 0) continue
    // Nicht ueber das Ende des oeffnenden Tags hinaus suchen: sonst wuerde
    // ein Knopf OHNE className die Kette des naechsten einsammeln.
    const nextTag = region.indexOf('<', tagStart + 1)
    if (nextTag >= 0 && at > nextTag) {
      out.push('')
      continue
    }
    let i = at + 'className='.length
    if (region[i] === '"' || region[i] === "'") {
      const quote = region[i]
      const end = region.indexOf(quote, i + 1)
      out.push(region.slice(i + 1, end))
    } else if (region[i] === '{') {
      let depth = 0
      for (; i < region.length; i++) {
        if (region[i] === '{') depth++
        else if (region[i] === '}') {
          depth--
          if (depth === 0) break
        }
      }
      out.push(region.slice(at + 'className='.length, i + 1))
    }
  }
  return out
}

/**
 * Die Utilities, die eine eigene Formsprache AUSMACHEN: Hoehe, Radius,
 * Polsterung, Rahmen, Flaeche, Schriftgroesse/-gewicht, Schatten, Deckung.
 * Layout-Utilities (`flex`, `items-center`, `truncate`) sind erlaubt, sie
 * beschreiben keine Form.
 */
const FORM_LANGUAGE = [
  /\brounded(?:-|\b)/,
  /(?:^|[\s'"`:])bg-(?!transparent\b)/,
  /(?:^|[\s'"`:])border(?:-|\b)/,
  /(?:^|[\s'"`:])h-(?!full\b)/,
  /(?:^|[\s'"`:])w-(?!full\b)/,
  /(?:^|[\s'"`:])p[xy]?-\d/,
  /(?:^|[\s'"`:])text-(?:\[|gray-|white\b|black\b|blue-|red-|green-|emerald-|amber-|purple-)/,
  /(?:^|[\s'"`:])font-(?:medium|semibold|bold)\b/,
  /(?:^|[\s'"`:])shadow(?:-|\b)/,
  /(?:^|[\s'"`:])opacity-\d/,
]

/**
 * `w-full h-full` bleibt an Send und Stop stehen, weil
 * `the-code-composer-is-one-quiet-row.test.ts` genau das seit 2026-08-22
 * festnagelt („beide fuellen den Slot, statt sich per Padding zu
 * bemessen"). Es ist keine Formsprache: der Slot ist 26x26 und
 * `.lu-control--icon` ist es auch, das Ergebnis ist identisch. Die
 * Ausnahme steht deshalb hier namentlich statt als Loch in FORM_LANGUAGE.
 */
const SLOT_FILL = /\bw-full h-full\b/

function formLanguageIn(className: string): string[] {
  const cleaned = className.replace(SLOT_FILL, ' ')
  return FORM_LANGUAGE.filter((re) => re.test(cleaned)).map(String)
}

// ── Die Leiste, Datei fuer Datei ─────────────────────────────────────

/** Die Aktionszeile von ChatInput: ab der Zeile bis zum Dateiende. */
const INPUT_BAR = INPUT.slice(INPUT.indexOf('flex flex-nowrap items-center gap-1 px-2 py-1.5'))
/** Die view-eigenen Controls, die Chat in die Leiste haengt. */
const VIEW_ACTIONS = propValue(VIEW, 'composerActions')
/** Beide Trigger-Zweige von Plugins, ohne das Menue darunter. */
const PLUGINS_TRIGGER = PLUGINS.slice(
  PLUGINS.indexOf('{iconOnly ? ('),
  PLUGINS.indexOf('{open && ('),
)
/** Der Trigger des Modellwaehlers, ohne die Liste darunter. */
const SELECTOR_TRIGGER = SELECTOR.slice(
  SELECTOR.indexOf('{/* ── Trigger Button ── */}'),
  SELECTOR.indexOf('{/* ── Dropdown ── */}'),
)

const REGIONS: Array<[string, string]> = [
  ['ChatInput, Aktionszeile', INPUT_BAR],
  ['ChatView, composerActions', VIEW_ACTIONS],
  ['PluginsDropdown, Trigger', PLUGINS_TRIGGER],
  ['ModelSelector, Trigger', SELECTOR_TRIGGER],
]

describe('die Abschnitte, die dieser Test liest, existieren ueberhaupt', () => {
  // Ohne diese Wache wuerde ein Umbau, der einen Anker umbenennt, den
  // Rest des Tests still auf einen leeren String laufen lassen — und alles
  // waere gruen, weil nichts mehr geprueft wird.
  it.each(REGIONS)('%s ist nicht leer', (_name, region) => {
    expect(region.length).toBeGreaterThan(200)
  })

  it('findet in jedem Abschnitt mindestens ein Control', () => {
    for (const [name, region] of REGIONS) {
      expect(controlClassNames(region).length, name).toBeGreaterThan(0)
    }
  })

  it('findet zusammen genau die neun Controls der Leiste', () => {
    // Paperclip · Think · Stop · Send (ChatInput) · Docs · Tools
    // (ChatView) · Plugins-Icon · Plugins-Label (PluginsDropdown) ·
    // Modellwaehler (ModelSelector). Der Dismiss-Knopf im Tools-Menue
    // liegt ausserhalb von composerActions. Aendert sich die Zahl, ist ein
    // Control dazugekommen oder verschwunden — beides gehoert angesehen.
    const all = REGIONS.flatMap(([, region]) => controlClassNames(region))
    expect(all).toHaveLength(9)
  })
})

describe('jedes Control der Leiste traegt eins der zwei Rezepte', () => {
  it.each(REGIONS)('%s: alle Knoepfe tragen .lu-control', (name, region) => {
    const missing = controlClassNames(region).filter((c) => !c.includes('lu-control'))
    expect(missing, `${name}: Knopf ohne Rezept`).toEqual([])
  })

  it('genau ein Control ist betont, und das ist Send', () => {
    const emphasised = REGIONS.flatMap(([, region]) => controlClassNames(region)).filter((c) =>
      c.includes('lu-primary'),
    )
    expect(emphasised).toHaveLength(1)
    const send = INPUT.slice(INPUT.indexOf('aria-label="Send message"') - 400, INPUT.indexOf('aria-label="Send message"'))
    expect(send).toContain('lu-primary')
  })

  it('Stop bleibt NEUTRAL — kein Rot, kein Primaer-Rezept', () => {
    // Der Grund steht in index.css und im Audit: Stop ist der
    // Normalabschluss, kein destruktiver Bestaetigungsknopf, und Rot heisst
    // in dieser App an 94 Stellen „kaputt oder wird geloescht".
    const at = INPUT.indexOf('aria-label="Stop generation"')
    expect(at).toBeGreaterThan(-1)
    const stop = INPUT.slice(at - 500, at)
    expect(stop).toContain('lu-control')
    expect(stop).not.toContain('lu-primary')
    expect(stop).not.toMatch(/red-\d/)
    // Und in der ganzen Datei kommt die Fehlerfarbe am Stop nicht zurueck.
    expect(INPUT).not.toContain('bg-red-500/15')
  })
})

describe('keine achte Formsprache — die Mutationssonde greift hier', () => {
  it.each(REGIONS)('%s: kein Knopf bringt eine eigene Form mit', (name, region) => {
    const offenders = controlClassNames(region)
      .map((c) => [c, formLanguageIn(c)] as const)
      .filter(([, hits]) => hits.length > 0)
      .map(([c, hits]) => `${c.slice(0, 120)} → ${hits.join(' ')}`)
    expect(offenders, `${name}: eigene Formsprache am Control`).toEqual([])
  })

  it('die Leiste kennt nur noch eine Hoehe, einen Radius, eine Schriftgroesse', () => {
    // Nicht als Zahl abgeschrieben, sondern aus dem Rezept gelesen: es gibt
    // genau EINE Stelle, an der die Geometrie steht.
    const base = CSS.match(/^\.lu-control\s*\{[^}]*\}/m)?.[0] ?? ''
    expect(base).toMatch(/height:\s*var\(--control-h-sm\)/)
    expect(base).toMatch(/border-radius:\s*var\(--radius-control\)/)
    expect(base).toMatch(/font-size:\s*0\.6rem/)
    // Und die Zahlen selbst kommen aus dem Token-Block, nicht aus dem Rezept.
    expect(CSS).toMatch(/--control-h-sm:\s*26px/)
    expect(CSS).toMatch(/--radius-control:\s*8px/)
  })
})

describe('das neutrale Rezept ist genau einmal definiert', () => {
  it('.lu-control hat genau eine Basisregel in index.css', () => {
    expect(CSS.match(/^\.lu-control\s*\{/gm) ?? []).toHaveLength(1)
  })

  it('deckt Ruhe, Hover, aktiv, beschaeftigt, Fokus und disabled ab', () => {
    // `NP` = die Abgrenzung gegen das betonte Rezept, siehe unten.
    const NP = String.raw`\.lu-control:not\(\.lu-primary\)`
    expect(CSS).toMatch(new RegExp(`${NP}:hover:not\\(:disabled\\)\\s*\\{`))
    expect(CSS).toMatch(new RegExp(`${NP}\\[aria-pressed='true'\\]`))
    expect(CSS).toMatch(new RegExp(`${NP}\\[aria-expanded='true'\\]`))
    expect(CSS).toMatch(new RegExp(`${NP}\\[data-active='true'\\]`))
    expect(CSS).toMatch(new RegExp(`${NP}\\[aria-busy='true'\\]\\s*\\{`))
    expect(CSS).toMatch(/\.lu-control:focus-visible\s*\{/)
    expect(CSS).toMatch(/\.lu-control:disabled\s*\{/)
  })

  it('der Rand ist im Ruhezustand durchsichtig, nicht abwesend', () => {
    // Sonst wuechse die Leiste um 2px, sobald ein Control aktiv wird —
    // genau der Sprung, den Think und Docs vorher hatten.
    const base = CSS.match(/^\.lu-control\s*\{[^}]*\}/m)?.[0] ?? ''
    expect(base).toMatch(/border:\s*1px solid transparent/)
  })

  it('deaktiviert liest sich als gedimmt, nicht als defekt', () => {
    const dis = CSS.match(/\.lu-control:disabled\s*\{[^}]*\}/)?.[0] ?? ''
    expect(dis).toMatch(/opacity:\s*0\.4/)
  })

  it('beide Modi sind bedient, nicht nur der dunkle', () => {
    expect(CSS).toMatch(/\.light \.lu-control:not\(\.lu-primary\)\s*\{[^}]*color/)
    expect(CSS).toMatch(/\.light \.lu-control:not\(\.lu-primary\):hover:not\(:disabled\)\s*\{/)
    expect(CSS).toMatch(/\.light \.lu-control:not\(\.lu-primary\)\[aria-pressed='true'\]/)
  })

  it('steht VOR .lu-primary, sonst gewaenne das neutrale Rezept gegen das betonte', () => {
    // Beide sind ungeschichtet und einklassig — bei gleicher Spezifitaet
    // entscheidet die Reihenfolge. Send traegt beide Klassen.
    expect(CSS.indexOf('\n.lu-control {')).toBeLessThan(CSS.indexOf('\n.lu-primary {'))
  })

  it('die neutrale HAUT tritt ueberall zurueck, wo .lu-primary daraufliegt', () => {
    // Reihenfolge allein reicht NICHT, und das ist beim Nachbauen im
    // gebauten CSS aufgefallen: `.light .lu-control:hover:not(:disabled)`
    // ist 0,4,0 und schlaegt `.lu-primary:hover:not(:disabled)` mit 0,3,0.
    // Ohne diese Abgrenzung wuerde der Senden-Knopf im Hellmodus beim
    // Ueberfahren grau. Jede Regel, die Farbe/Flaeche setzt, traegt daher
    // `:not(.lu-primary)`; die Geometrie-Regeln ausdruecklich nicht, die
    // sind ja der gemeinsame Teil.
    const skinRules = [...CSS.matchAll(/^(\.light )?\.lu-control(?!--)[^{\n]*\{([^}]*)\}/gm)]
      .map((m) => ({ selector: m[0].slice(0, m[0].indexOf('{')).trim(), body: m[2] }))
      .filter(({ body }) => /(^|\s)(color|background-color|border-color)\s*:/.test(body))

    expect(skinRules.length).toBeGreaterThanOrEqual(5)
    const unguarded = skinRules
      // Die BASISREGEL darf ungeschuetzt bleiben: sie ist 0,1,0, genau wie
      // `.lu-primary`, und steht davor — dort entscheidet die Reihenfolge,
      // und die ist eine Zeile weiter oben festgenagelt. Jede spezifischere
      // Regel braucht die Abgrenzung.
      .filter(({ selector }) => selector !== '.lu-control')
      .filter(({ selector }) => !selector.includes(':not(.lu-primary)'))
      .map(({ selector }) => selector)
    expect(unguarded).toEqual([])
  })

  it('die Geometrie gilt dagegen fuer BEIDE — sonst haette Send keine Form', () => {
    const base = CSS.match(/^\.lu-control\s*\{[^}]*\}/m)?.[0] ?? ''
    expect(base).not.toContain(':not(.lu-primary)')
    expect(CSS).toMatch(/^\.lu-control--icon\s*\{/m)
    expect(CSS.match(/^\.lu-control--icon[^{\n]*\{/m)?.[0]).not.toContain(':not(')
  })
})

describe('die Farben des neutralen Rezepts sind gerechnet, nicht geschaetzt', () => {
  /** Die `color:`-Deklaration einer Regel aus index.css, als #rrggbb. */
  function farbeVon(selectorRegex: RegExp): string {
    const block = CSS.match(selectorRegex)?.[0]
    if (!block) throw new Error(`Regel fehlt in index.css: ${selectorRegex}`)
    const m = block.match(/color:\s*(rgb\([^)]*\))/)
    if (!m) throw new Error(`Kein color: in ${selectorRegex}`)
    return rgbToHex(m[1])
  }

  /**
   * Der Grund, auf dem die Leiste WIRKLICH steht — aus den Dateien gelesen,
   * nicht angenommen: AppShell malt die Chat-Flaeche (`bg-white
   * dark:bg-[#1e1e1e]`), ChatInput legt seine Composer-Flaeche darauf
   * (`bg-gray-50 dark:bg-white/[0.03]`).
   */
  const paneDark = SHELL.match(/dark:bg-\[(#[0-9a-fA-F]{6})\][^"]*ring-1/)?.[1]
  const grundDunkel = over('#ffffff', paneDark ?? '', 0.03)
  const grundHell = '#f9fafb' // gray-50, die Composer-Flaeche im Hellmodus

  it('der Grund wird aus dem Quelltext gelesen, nicht angenommen', () => {
    expect(paneDark).toBe('#1e1e1e')
    expect(SHELL).toContain('bg-white dark:bg-[#1e1e1e]')
    expect(INPUT).toContain('bg-gray-50 dark:bg-white/[0.03]')
  })

  const ruheDunkel = () => farbeVon(/^\.lu-control \{[^}]*\}/m)
  const ruheHell = () => farbeVon(/^\.light \.lu-control:not\(\.lu-primary\) \{[^}]*\}/m)
  const aktivDunkel = () => farbeVon(/^\.lu-control:not\(\.lu-primary\):hover:not\(:disabled\) \{[^}]*\}/m)
  const aktivHell = () => farbeVon(/^\.light \.lu-control:not\(\.lu-primary\):hover:not\(:disabled\) \{[^}]*\}/m)

  it('Ruhezustand erreicht AA in beiden Modi (11,04px zaehlt als Fliesstext)', () => {
    expect(contrast(ruheDunkel(), grundDunkel)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(ruheHell(), grundHell)).toBeGreaterThanOrEqual(4.5)
  })

  it('der aktive/gehoverte Zustand ist deutlich staerker als der Ruhezustand', () => {
    // Das ist die eigentliche Zustandsaussage. Der 1px-Rand bei 14 % Deckung
    // erfuellt 1.4.11 fuer sich genommen NICHT und ist deshalb nur Zugabe —
    // getragen wird der Unterschied von der Schrift.
    expect(contrast(aktivDunkel(), grundDunkel)).toBeGreaterThan(
      contrast(ruheDunkel(), grundDunkel) * 2,
    )
    expect(contrast(aktivHell(), grundHell)).toBeGreaterThan(
      contrast(ruheHell(), grundHell) * 2,
    )
  })

  it('die Zahlen im Kommentar stimmen mit der Rechnung ueberein', () => {
    // Sonst veraltet die Begruendung in index.css still, waehrend der Code
    // weiterlaeuft — der haeufigste Weg, auf dem eine Design-Notiz luegt.
    const block = CSS.slice(CSS.indexOf('.lu-control — DAS neutrale'), CSS.indexOf('\n.lu-control {'))
    for (const [wert, gerechnet] of [
      ['6.57', contrast(ruheDunkel(), '#1e1e1e')],
      ['15.15', contrast(aktivDunkel(), '#1e1e1e')],
      ['7.56', contrast(ruheHell(), '#ffffff')],
      ['17.74', contrast(aktivHell(), '#ffffff')],
    ] as const) {
      expect(block, `${wert} steht nicht im Kommentar`).toContain(wert)
      expect(Number(wert)).toBeCloseTo(gerechnet, 1)
    }
  })
})

describe('der Zustand kommt aus ARIA, nicht aus einer zweiten Klassenkette', () => {
  it('Think meldet seinen Ein-Zustand als aria-pressed', () => {
    expect(INPUT).toMatch(/aria-pressed=\{\(thinkingEnabled && canThink\) \|\| thinkLockedOn\}/)
    // Und das blaue Pill ist weg — es trug dieselbe Farbe wie der Fokusring.
    expect(INPUT).not.toContain('bg-blue-500/15')
  })

  it('Docs meldet seinen Ein-Zustand als aria-pressed', () => {
    expect(VIEW_ACTIONS).toMatch(/aria-pressed=\{ragPanelOpen \|\| ragEnabled\}/)
    expect(VIEW_ACTIONS).not.toContain('bg-green-500/15')
  })

  it('die drei Aufklapper melden aria-expanded', () => {
    expect(VIEW_ACTIONS).toMatch(/aria-expanded=\{toolsDropdownOpen\}/)
    expect(PLUGINS_TRIGGER.match(/aria-expanded=\{open\}/g)).toHaveLength(2)
    expect(SELECTOR_TRIGGER).toMatch(/aria-expanded=\{open\}/)
  })

  it('der Modellwaehler meldet Laden als aria-busy statt als blauem Leuchten', () => {
    expect(SELECTOR_TRIGGER).toMatch(/aria-busy=\{isModelLoading\}/)
    expect(SELECTOR_TRIGGER).not.toContain('shadow-[0_0_6px')
  })
})
