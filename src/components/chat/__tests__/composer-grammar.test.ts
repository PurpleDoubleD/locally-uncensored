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
 * NACHGEZOGEN (Welle 3, Ton- und Craft-Paket): `chat/VoiceButton.tsx`.
 * Der Composer-Commit 8198495f hatte das Mikrofon ausdruecklich GEMELDET
 * statt geaendert — „die einzige verbliebene eigene Formsprache in der
 * Chat-Leiste", Datei lag ausserhalb des damaligen Auftrags. Bei der
 * Re-Verifikation stand es noch genau so da: `p-1.5 rounded-lg` (Radius
 * 9,2 statt 8, Polster 6,9 statt der 26x26-Box), im Aufnahmezustand ein
 * rotes Pill mit 2px-Ring, im Transkribieren-Zustand ein eigenes BLAUES
 * Rezept (`bg-blue-500/20 border-blue-500/40 text-blue-400`) — dieselbe
 * Farbe, die der Fokusring fuehrt. Drei Zustaende, drei Rezepte, in einem
 * einzigen Knopf.
 *
 * Der Test WAECHST deshalb mit, statt umgangen zu werden: VoiceButton ist
 * jetzt eine gleichberechtigte Region, die Zaehlung geht von neun auf
 * zwoelf (die drei Zustaende des Mikrofons rendern drei getrennte
 * `<button>`), und die drei Knoepfe laufen durch dieselbe
 * Formsprachen-Pruefung wie alle anderen.
 *
 * Ausdruecklich NICHT geprueft, weil ausserhalb dieser Dateien:
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

/**
 * Kommentare raus. Die Begruendungen im Quelltext ZITIEREN die alten
 * Klassen (`bg-blue-500/20`), damit der naechste Leser weiss, was da
 * stand — ein Scanner, der Kommentare mitliest, meldet genau diese
 * Erklaerung als Verstoss. Gleiches Werkzeug wie in
 * `components/__tests__/hellmodus-restluecken.test.ts`.
 */
function ohneKommentare(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
}

const INPUT = read('../ChatInput.tsx')
const VOICE = read('../VoiceButton.tsx')
const VIEW = read('../ChatView.tsx')
const PLUGINS = read('../PluginsDropdown.tsx')
const SELECTOR = read('../../models/ModelSelector.tsx')
const SHELL = read('../../layout/AppShell.tsx')
const CSS = read('../../../index.css')
/** VoiceButton ohne seine Begruendungen — siehe `ohneKommentare` oben. */
const MIC = ohneKommentare(VOICE)

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

/**
 * Das Mikrofon haengt als KOMPONENTE in der Leiste (`<VoiceButton />` in
 * ChatInput), nicht als `<button>` — deshalb hat die Zaehlung ueber
 * INPUT_BAR es nie gesehen. Die ganze Datei ist die Region: sie enthaelt
 * nichts ausser diesem einen Control in seinen drei Zustaenden.
 */
const REGIONS: Array<[string, string]> = [
  ['ChatInput, Aktionszeile', INPUT_BAR],
  ['VoiceButton, drei Zustaende', VOICE],
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

  it('findet zusammen genau die zwoelf Controls der Leiste', () => {
    // Paperclip · Think · Stop · Send (ChatInput) · Mikrofon nicht
    // verfuegbar · Mikrofon transkribiert · Mikrofon bereit/aufnehmend
    // (VoiceButton) · Docs · Tools (ChatView) · Plugins-Icon ·
    // Plugins-Label (PluginsDropdown) · Modellwaehler (ModelSelector).
    // Der Dismiss-Knopf im Tools-Menue liegt ausserhalb von
    // composerActions. Aendert sich die Zahl, ist ein Control
    // dazugekommen oder verschwunden — beides gehoert angesehen.
    const all = REGIONS.flatMap(([, region]) => controlClassNames(region))
    expect(all).toHaveLength(12)
  })

  it('das Mikrofon steckt wirklich in dieser Leiste, nicht irgendwo sonst', () => {
    // Sonst pruefte die Region oben eine Datei, die mit dem Composer
    // nichts mehr zu tun hat, und niemand merkte es.
    expect(INPUT_BAR).toContain('<VoiceButton')
    expect(controlClassNames(VOICE)).toHaveLength(3)
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
    // `--` (Modifikator, gleiche Form) und `__` (Element IM Control, heute
    // der Aufnahme-Ring) sind ausgenommen: `:not(.lu-primary)` grenzt das
    // neutrale Rezept gegen das betonte ab, und beide Fragen stellen sich
    // nur fuer Regeln, die auf DEM Control selbst landen. Ein Kindelement
    // erbt die Abgrenzung nicht und kann sie auch nicht tragen.
    const skinRules = [...CSS.matchAll(/^(\.light )?\.lu-control(?!--|__)[^{\n]*\{([^}]*)\}/gm)]
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

  it('das Mikrofon meldet Aufnahme als aria-pressed, nicht als rotem Pill', () => {
    expect(VOICE).toMatch(/aria-pressed=\{isRecording\}/)
    // Rot heisst in dieser App „kaputt oder wird geloescht". Ein Mikrofon,
    // das gerade zuhoert, ist keins von beidem — dieselbe Begruendung, aus
    // der Stop neutral wurde. Geprueft werden die KNOEPFE, nicht die Datei:
    // die Fehlerblase darunter ist ein echter Fehler und behaelt ihr Rot.
    expect(controlClassNames(VOICE).join(' ')).not.toMatch(/red-\d/)
    expect(MIC).not.toContain('bg-red-100')
    expect(MIC).not.toContain('border-red-500')
    expect(MIC).toContain('bg-red-600/95')
  })

  it('das Mikrofon meldet Transkribieren als aria-busy, nicht als blauem Pill', () => {
    expect(VOICE).toContain('aria-busy="true"')
    // Das war die einzige Stelle der Leiste, die den Fokusring-Blau noch
    // als Zustandsfarbe zweitverwendet hat. Ohne `ohneKommentare` faende
    // dieser Ausdruck die Begruendung im Quelltext, die die alten Klassen
    // ZITIERT — derselbe Stolperstein wie in hellmodus-restluecken.test.ts.
    expect(MIC).not.toMatch(/blue-\d/)
  })

  it('der Aufnahme-Puls ist ein Rezept in index.css, kein Literal am Knopf', () => {
    // Vorher: eine framer-motion-Schleife am Element
    // (`animate={{ scale: [1, 1.15, 1] }}`, `repeat: Infinity`), die an
    // CSS vorbei animiert und deshalb von „Bewegung reduzieren" gar nicht
    // erreicht werden KONNTE.
    expect(VOICE).toContain('lu-control__pulse')
    expect(VOICE).not.toContain('repeat: Infinity')
    expect(CSS).toMatch(/^\.lu-control__pulse\s*\{/m)
    expect(CSS).toMatch(/@keyframes lu-control-pulse/)
    // Dauer aus der Motion-Leiter gerechnet, nicht als fuenfte Zahl
    // danebengeschrieben.
    const puls = CSS.match(/^\.lu-control__pulse\s*\{[^}]*\}/m)?.[0] ?? ''
    expect(puls).toMatch(/animation:\s*lu-control-pulse calc\(var\(--motion-slow\) \* 4\)/)
    // Und „Bewegung reduzieren" haelt ihn an.
    const reduce = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduce).toContain('.lu-control__pulse')
  })

  it('der Puls braucht den Bezugsrahmen, den die Basisregel setzt', () => {
    // `inset: 0` haengt am naechsten positionierten Vorfahren. Faellt
    // `position: relative` aus `.lu-control`, legt sich der Ring ueber die
    // ganze Composer-Zeile statt ueber den 26x26-Knopf.
    const base = CSS.match(/^\.lu-control\s*\{[^}]*\}/m)?.[0] ?? ''
    expect(base).toMatch(/position:\s*relative/)
    const puls = CSS.match(/^\.lu-control__pulse\s*\{[^}]*\}/m)?.[0] ?? ''
    expect(puls).toMatch(/position:\s*absolute/)
    expect(puls).toMatch(/inset:\s*0/)
  })
})

describe('der Aufnahme-Ring ist gerechnet, nicht geschaetzt', () => {
  // Der Grund, auf dem der Ring wirklich steht: die Composer-Flaeche, und
  // darunter der Behaelter, den `aria-pressed` im Aufnahmezustand setzt.
  const paneDark = SHELL.match(/dark:bg-\[(#[0-9a-fA-F]{6})\][^"]*ring-1/)?.[1] ?? ''
  const grundDunkel = over('#ffffff', paneDark, 0.03)
  const grundHell = '#f9fafb'
  const behaelterDunkel = over('#ffffff', grundDunkel, 0.07)
  const behaelterHell = over('#000000', grundHell, 0.05)

  /** Ein `--color-*: #rrggbb;`-Token aus dem @theme-Block. */
  function token(name: string): string {
    const m = CSS.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`))
    if (!m) throw new Error(`Token fehlt: --${name}`)
    return m[1]
  }

  it('er nimmt Tokens, keine Literale', () => {
    const puls = CSS.match(/^\.lu-control__pulse\s*\{[^}]*\}/m)?.[0] ?? ''
    expect(puls).toMatch(/border:\s*1px solid var\(--color-lu-accent\)/)
    expect(CSS).toMatch(/^\.light \.lu-control__pulse \{ border-color: var\(--color-lu-accent-edge\); \}$/m)
    expect(puls).not.toMatch(/#[0-9a-fA-F]{6}/)
  })

  it('und beide Modi kommen auf der Flaeche ueber 3:1 (WCAG 1.4.11)', () => {
    expect(contrast(token('color-lu-accent'), grundDunkel)).toBeGreaterThanOrEqual(3)
    expect(contrast(token('color-lu-accent-edge'), grundHell)).toBeGreaterThanOrEqual(3)
  })

  it('der halbdurchsichtige Ring-Token waere hier zu schwach gewesen', () => {
    // Festgehalten, damit niemand ihn „der Konsistenz halber" zurueckdreht:
    // --color-lu-accent-ring ist rgba(...,0.55) und faellt auf dieser
    // Flaeche unter jede Schwelle, die es gibt.
    const ring = over(token('color-lu-accent'), grundDunkel, 0.55)
    expect(contrast(ring, grundDunkel)).toBeLessThan(3)
  })

  it('auf dem aktiven Behaelter bleibt der dunkle Modus drueber', () => {
    expect(contrast(token('color-lu-accent'), behaelterDunkel)).toBeGreaterThanOrEqual(3)
    // Der helle liegt knapp darunter (2.90:1) und ist deshalb bewusst nur
    // Zugabe — genau wie der aria-pressed-Rand, den index.css schon so
    // begruendet. Der Wert steht hier, damit er nicht unbemerkt weiter faellt.
    expect(contrast(token('color-lu-accent-edge'), behaelterHell)).toBeGreaterThan(2.8)
  })
})
