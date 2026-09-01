/**
 * Settings: die Rail, der Rang der Ueberschriften, die zwei Reset-Aktionen
 * und der Unterschied zwischen Zustand und Aktion.
 *
 * Deckt D-S27, D-S28, D-S29, D-S30 und D-S48 des Design-Audits.
 *
 * Warum als Quelltext- und Rechen-Test und nicht als Sichtpruefung: die
 * Testumgebung ist `environment: 'node'` (vitest.config.ts), es gibt kein DOM
 * und keinen Renderer im Projekt. Was sich OHNE DOM pruefen laesst, ist
 * (a) die Struktur, um die es geht — Rail vorhanden, Spalte nicht mehr
 * freischwebend, Sprungziele decken die Sektionen — und (b) die
 * Kontrastwerte, die dabei behauptet werden. Die werden hier AUSGERECHNET,
 * aus derselben Rechnung, die `primary-recipe.test.ts` benutzt, nicht
 * abgeschrieben.
 *
 * Was hier NICHT geprueft werden kann: wie breit die Spalte im laufenden
 * Fenster wirklich wird und wo die Fortschrittsanker beim Klick landen. Das
 * braucht ein gerendertes Fenster; die 294px/524px-Messungen des Audits sind
 * genau deshalb dort als „nicht verifizierbar hier" gefuehrt.
 *
 * Lauf: npx vitest run src/components/settings/__tests__/settings-rail-und-rang.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { contrast, over } from '../../__tests__/wcag-contrast'
import { sectionAnchorId, sectionsFor, type SettingsSectionFlags } from '../settings-nav'
import type { SettingsTab } from '../../../lib/settings-reset'

/**
 * Nur der Code, ohne Kommentare. Die Zusicherungen unten sind teils
 * NEGATIV ("dieser Klassenname kommt nicht mehr vor") — und ein Kommentar,
 * der den alten Wert zitiert, um die Aenderung zu erklaeren, waere sonst
 * ausgerechnet das, was den Test rot faerbt. Dieselbe Vorsichtsmassnahme
 * wie in src/components/layout/__tests__/listen-ladezustaende.test.ts.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const SRC = codeOnly(readFileSync(resolve(__dirname, '..', 'SettingsPage.tsx'), 'utf8'))
const CSS = readFileSync(resolve(__dirname, '..', '..', '..', 'index.css'), 'utf8')

/** Die Palettenwerte, die in den Klassen unten wirklich stehen. */
const PAL = {
  white: '#ffffff',
  appDark: '#202020', // die Flaeche, auf der Settings im Dunkelmodus liegt
  gray200: '#e5e7eb',
  gray400: '#9ca3af',
  gray500: '#6b7280',
  gray900: '#111827',
  red400: '#f87171',
  red600: '#dc2626',
  accent: '#a094f8',
  accentEdge: '#8b7cf0',
}

// ── D-S27 / D-S48 — die Spalte haengt an etwas ────────────────────────────

describe('D-S27 / D-S48: die Inhaltsspalte schwebt nicht mehr frei', () => {
  it('`max-w-lg mx-auto` ist weg — das WAR die freischwebende Spalte', () => {
    expect(SRC).not.toContain('max-w-lg mx-auto')
  })

  it('es gibt eine 200px-Rail und eine auf 640px gedeckelte Inhaltsspalte', () => {
    // Die beiden Zahlen des Audit-Solls: „200px-Rail links mit den Sektionen,
    // 640px Content daneben, linksbuendig".
    expect(SRC).toMatch(/w-\[200px\]/)
    expect(SRC).toMatch(/max-w-\[640px\]/)
  })

  it('die Rail ist eine benannte Navigation und klebt beim Scrollen', () => {
    const rail = SRC.match(/<nav[\s\S]*?>/)?.[0] ?? ''
    expect(rail).toContain('aria-label="Settings sections"')
    expect(rail).toContain('sticky')
  })

  it('unter `lg` bleibt genau EINE Navigation stehen, nicht zwei', () => {
    // Die Rail erscheint ab lg, die waagerechte Tableiste verschwindet dort.
    // Beides gleichzeitig sichtbar waere zwei Navigationen fuer dieselbe
    // Sache — der Befund, den D-S27 an anderer Stelle beschreibt.
    expect(SRC).toMatch(/hidden lg:flex w-\[200px\]/)
    expect(SRC).toMatch(/lg:hidden sticky top-0/)
  })

  it('der aktive Tab ist als solcher ausgezeichnet, nicht nur eingefaerbt', () => {
    expect((SRC.match(/aria-current=\{tab === t\.id \? 'page' : undefined\}/g) ?? []).length).toBe(2)
  })
})

// ── Die Rail zeigt auf das, was wirklich da ist ───────────────────────────

const TABS: SettingsTab[] = ['general', 'backends', 'agent', 'voice-remote']
const ALL_ON: SettingsSectionFlags = {
  gpuPicker: true, builtinExpert: true, comfyui: true, agentMode: true, agentWorkflows: true,
  mediaTimeouts: true,
}
const ALL_OFF: SettingsSectionFlags = {
  gpuPicker: false, builtinExpert: false, comfyui: false, agentMode: false, agentWorkflows: false,
  mediaTimeouts: false,
}

/** Der JSX-Zweig eines Tabs, von seinem Guard bis zum naechsten. */
function branch(tab: SettingsTab): string {
  const marks = TABS.map((t) => `{tab === '${t}' && (<>`)
  const start = SRC.indexOf(`{tab === '${tab}' && (<>`)
  expect(start, `Der Zweig fuer '${tab}' fehlt in SettingsPage.tsx`).toBeGreaterThan(-1)
  const ends = marks
    .map((m) => SRC.indexOf(m, start + 1))
    .filter((i) => i > start)
  const reset = SRC.indexOf('<ResetSection tab={tab} />')
  const end = Math.min(...[...ends, reset].filter((i) => i > start))
  return SRC.slice(start, end)
}

/** Die `<Section title="…">`-Literale eines Zweigs, in Renderreihenfolge. */
function renderedTitles(tab: SettingsTab): string[] {
  let text = branch(tab)
  // `<UpdateSection />` ist eine eigene Funktion mit einer eigenen Section
  // darin. Sie an ihrer Einbaustelle aufzuloesen ist die einzige
  // Sonderregel hier — ohne sie faehrt der Vergleich unten gegen eine
  // Sektion, die es sehr wohl gibt.
  const update = SRC.slice(SRC.indexOf('function UpdateSection()'))
  const updateTitles = [...update.matchAll(/<Section title="([^"]+)"/g)].map((m) => m[1])
  text = text.replace('<UpdateSection />', updateTitles.map((t) => `<Section title="${t}"`).join('\n'))
  return [...text.matchAll(/<Section title="([^"]+)"/g)].map((m) => m[1])
}

describe('die Rail und der Inhalt koennen nicht auseinanderlaufen', () => {
  it.each(TABS)('%s: die Rail kennt genau die Sektionen, die der Zweig rendert', (tab) => {
    const inJsx = new Set(renderedTitles(tab))
    // Die Vereinigung ueber beide Flag-Belegungen ist genau die Menge, die im
    // Quelltext steht: ComfyUI UND Local Media, Hardware, der Expertenblock,
    // die Agent-Sektionen hinter ihren Feature-Flags.
    const inRail = new Set([...sectionsFor(tab, ALL_ON), ...sectionsFor(tab, ALL_OFF)])
    expect(inJsx).toEqual(inRail)
  })

  /**
   * Die Sektionen eines Zweigs, die im JSX hinter einer Bedingung stehen.
   * Gemessen wird der Abstand zwischen dem SCHLIESSENDEN `</Section>` davor
   * (bzw. dem Zweiganfang) und dem oeffnenden Tag: nur was dort steht, ist
   * ein Guard fuer genau diese Sektion. Bedingungen INNERHALB der
   * vorangehenden Sektion zaehlen nicht — daran ist die erste, naive Fassung
   * dieser Pruefung gescheitert.
   */
  function guardedTitles(tab: SettingsTab): Set<string> {
    const seg = branch(tab).replace(/^\{tab === '[a-z-]+' && \(<>/, '')
    const out = new Set<string>()
    for (const m of seg.matchAll(/<Section title="([^"]+)"/g)) {
      const before = seg.slice(0, m.index)
      const lastClose = before.lastIndexOf('</Section>')
      const gap = before.slice(lastClose < 0 ? 0 : lastClose + '</Section>'.length)
      if (/&& \(|\? \(|: \(/.test(gap)) out.add(m[1])
    }
    return out
  }

  it.each(TABS)('%s: was im JSX eine Bedingung hat, hat sie auch in der Rail', (tab) => {
    // Der eigentliche Fehler, den diese Sperrklinke faengt: eine Sektion, die
    // im JSX hinter `settings.appMode !== 'cloud' && !isMlxImageHost()` haengt,
    // in der Rail aber unbedingt gelistet ist — die Rail bietet dann einen
    // Sprung an, den es nicht gibt. Genau das ist mir beim ersten Anlauf
    // passiert und im laufenden Fenster aufgefallen, nicht hier.
    const guarded = guardedTitles(tab)
    // „Immer da" heisst: bei JEDER Flag-Belegung in der Liste. Der Schnitt,
    // nicht eine der beiden Belegungen — ComfyUI und Local Media sind die
    // zwei Zweige EINES Ternaers, jeder einzeln bedingt, das Paar zusammen
    // unbedingt.
    const off = new Set(sectionsFor(tab, ALL_OFF))
    const always = new Set(sectionsFor(tab, ALL_ON).filter((t) => off.has(t)))
    for (const title of guarded) {
      expect(always.has(title), `"${title}" steht im JSX hinter einer Bedingung, in der Rail aber unbedingt`).toBe(false)
    }
    for (const title of sectionsFor(tab, ALL_ON)) {
      if (always.has(title)) {
        expect(guarded.has(title), `"${title}" ist in der Rail unbedingt, im JSX aber bedingt`).toBe(false)
      }
    }
  })

  it.each(TABS)('%s: und in derselben Reihenfolge', (tab) => {
    const order = renderedTitles(tab)
    const rail = sectionsFor(tab, ALL_ON)
    expect(rail.map((t) => order.indexOf(t))).toEqual([...rail.map((t) => order.indexOf(t))].sort((a, b) => a - b))
    expect(rail.every((t) => order.includes(t))).toBe(true)
  })

  it('der Ankername wird an EINER Stelle abgeleitet, von Section wie von der Rail', () => {
    expect(SRC).toContain('id={sectionAnchorId(title)}')
    expect(SRC).toContain('href={`#${sectionAnchorId(title)}`}')
  })

  it('kein Tab erzeugt zwei Sektionen mit demselben Anker', () => {
    for (const tab of TABS) {
      const ids = sectionsFor(tab, ALL_ON).map(sectionAnchorId)
      expect(new Set(ids).size, tab).toBe(ids.length)
    }
  })

  it('der Anker ist ein brauchbarer Fragmentname, auch fuer Titel mit Sonderzeichen', () => {
    expect(sectionAnchorId('ComfyUI (Image & Video)')).toBe('set-comfyui-image-video')
    expect(sectionAnchorId('Image / Video Generation Timeouts')).toBe('set-image-video-generation-timeouts')
    expect(sectionAnchorId('Speech')).toBe('set-speech')
    for (const tab of TABS) {
      for (const id of sectionsFor(tab, ALL_ON).map(sectionAnchorId)) {
        expect(id, id).toMatch(/^set-[a-z0-9-]+$/)
        expect(id.endsWith('-')).toBe(false)
      }
    }
  })
})

// ── D-S28 — Rang statt zwoelfmal derselben Betonung ───────────────────────

describe('D-S28: die Sektionskoepfe haben einen Rang bekommen', () => {
  it('die Versalien-plus-Sperrung-Behandlung ist weg', () => {
    expect(SRC).not.toContain('tracking-[0.15em]')
    const head = SRC.match(/<span className="text-\[0\.82rem\][^"]*">\s*\{title\}/)?.[0] ?? ''
    expect(head, 'Der Sektionskopf traegt nicht mehr die 0.82rem-Stufe').not.toBe('')
    expect(head).not.toContain('uppercase')
  })

  it('es gibt drei Stufen statt einer: H1 > Sektionskopf > Fliesstext', () => {
    // Gerechnet gegen das WIRKSAME Wurzelmass, nicht gegen eine abgeschriebene
    // Zahl: Wurzel-`font-size` mal `--ui-scale`, falls es den Regler gibt (er
    // haengt als `zoom` an #root). Waehrend dieses Pakets stellte D-A3
    // parallel von „18,4px, kein Regler" auf „16px mal 1,15" um und wieder
    // zurueck; beide Regime ergeben 18,4 gerenderte px. Genau deshalb stehen
    // die Stufen unten in rem und nicht in px.
    const rootDecl = Number(CSS.match(/html\s*\{[^}]*?font-size:\s*([\d.]+)px/s)?.[1])
    const scale = Number(CSS.match(/--ui-scale:\s*([\d.]+)/)?.[1] ?? 1)
    const root = rootDecl * scale
    expect(root).toBeCloseTo(18.4, 3)
    const px = (rem: number) => rem * root
    expect(px(1.15)).toBeCloseTo(21.16, 2)
    expect(px(0.82)).toBeCloseTo(15.09, 2)
    expect(px(0.7)).toBeCloseTo(12.88, 2)
    expect(px(1.15)).toBeGreaterThan(px(0.82))
    expect(px(0.82)).toBeGreaterThan(px(0.7))
    // Und die Stufen stehen wirklich in der Datei.
    expect(SRC).toContain('text-[1.15rem] font-semibold')
    expect(SRC).toContain('text-[0.82rem] font-semibold')
  })

  it('die H1 ist nicht mehr so gross wie ein Sektionskopf', () => {
    // Der Befund im Kleinen: vorher H1 `text-[0.8rem]` gegen Sektionskopf
    // `text-[0.65rem]` — zwei Stufen, die im Fenster als eine lesen.
    expect(SRC).not.toContain('text-[0.8rem] font-semibold text-gray-800 dark:text-gray-200">Settings')
  })

  it('der Kopf erreicht in BEIDEN Modi WCAG AA — vorher im Dunkelmodus nicht', () => {
    // Gerechnet, nicht behauptet:
    //   alt  gray-500 #6b7280 auf #202020 = 3.37:1  → unter AA (4.5:1)
    //   neu  gray-200 #e5e7eb auf #202020 = 13.16:1
    //   neu  gray-900 #111827 auf #ffffff = 17.74:1
    expect(contrast(PAL.gray500, PAL.appDark)).toBeCloseTo(3.37, 2)
    expect(contrast(PAL.gray500, PAL.appDark)).toBeLessThan(4.5)
    expect(contrast(PAL.gray200, PAL.appDark)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(PAL.gray900, PAL.white)).toBeGreaterThanOrEqual(4.5)
    expect(SRC).toContain('text-gray-900 dark:text-gray-200 group-hover:text-black')
  })
})

// ── D-S29 — zwei verschieden gefaehrliche Aktionen ────────────────────────

describe('D-S29: die gefaehrlichere Reset-Aktion sieht anders aus', () => {
  const resetBlock = () => {
    const at = SRC.indexOf('function ResetSection(')
    const end = SRC.indexOf('\nexport function SettingsPage()')
    return SRC.slice(at, end)
  }

  it('sie ist keine zweite Textzeile mehr, sondern ein umrandeter Knopf', () => {
    const block = resetBlock()
    expect(block).toContain("border-red-600 text-red-600 hover:bg-red-600/10 dark:border-red-400 dark:text-red-400")
    // Das alte, fast unsichtbare Grau ist weg.
    expect(block).not.toContain("text-gray-600 dark:text-gray-600 hover:text-red-400")
  })

  it('und sie sagt, was „alle" bedeutet', () => {
    expect(resetBlock()).toContain('Every tab, not just {tabLabel}.')
  })

  it('die beiden Knoepfe tragen NICHT mehr dieselben Klassen', () => {
    const block = resetBlock()
    const scoped = block.match(/armed === 'section' \? '([^']*)' : '([^']*)'/)
    const all = block.match(/armed === 'all'\s*\n?\s*\? '([^']*)'\s*\n?\s*: '([^']*)'/)
    expect(scoped, 'Der Zweig fuer die tab-weite Aktion fehlt').not.toBeNull()
    expect(all, 'Der Zweig fuer die App-weite Aktion fehlt').not.toBeNull()
    expect(all?.[2]).not.toBe(scoped?.[2])
  })

  it('die Gefahrfarbe traegt Text UND Kante durch WCAG', () => {
    // Text: AA braucht 4.5:1. Kante: 1.4.11 (Nicht-Text) braucht 3:1.
    // red-600 #dc2626 auf Weiss = 4.83:1, red-400 #f87171 auf #202020 = 5.89:1.
    expect(contrast(PAL.red600, PAL.white)).toBeCloseTo(4.83, 2)
    expect(contrast(PAL.red400, PAL.appDark)).toBeCloseTo(5.89, 2)
    expect(contrast(PAL.red600, PAL.white)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(PAL.red400, PAL.appDark)).toBeGreaterThanOrEqual(4.5)
    // Der scharf gestellte Zustand ist eine gefuellte Flaeche: Weiss auf
    // red-600 = 4.83:1, dieselbe Rechnung von der anderen Seite.
    expect(contrast(PAL.white, PAL.red600)).toBeGreaterThanOrEqual(4.5)
    expect(SRC).toContain("'bg-red-600 border-red-600 text-white font-medium'")
  })

  it('NEGATIVKONTROLLE: das alte Grau war im Dunkelmodus unlesbar — 2.16:1', () => {
    // gray-600 #4b5563 auf #202020. Genau das trug bisher die Aktion, die
    // ALLES zuruecksetzt: die gefaehrlichere war die unlesbarere.
    expect(contrast('#4b5563', PAL.appDark)).toBeCloseTo(2.16, 2)
  })

  it('NEGATIVKONTROLLE: der Arm-Mechanismus ist unangetastet', () => {
    // Die Optik zu aendern darf die Zwei-Klick-Bestaetigung nicht anfassen.
    const block = resetBlock()
    expect(block).toContain("if (armed !== which) {")
    expect(block).toContain('setTimeout(() => setArmed(null), 4000)')
    expect(block).toContain("armed === 'all' ? 'Click again to reset everything' : 'Reset all settings'")
  })
})

// ── D-S30 — Zustand ist nicht Aktion ──────────────────────────────────────

describe('D-S30: Zustand und Aktion tragen nicht mehr dieselbe Flaeche', () => {
  it('der aktive Tab traegt die Akzentflaeche, nicht die Aktionsflaeche', () => {
    expect(SRC).toMatch(/tab === t\.id\s*\n?\s*\? 'bg-lu-accent-soft/)
    // `bg-gray-200 dark:bg-white/10` als AUSGEWAEHLT-Markierung ist weg.
    expect(SRC).not.toContain("? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white'")
  })

  it('der gewaehlte Theme-Knopf spricht dieselbe Zustandssprache', () => {
    for (const t of ['light', 'dark']) {
      expect(SRC).toContain(`settings.theme === '${t}' ? 'bg-lu-accent-soft ring-1 ring-lu-accent-edge dark:ring-lu-accent`)
    }
  })

  it('die Aktion behaelt die neutrale graue Flaeche — sonst waere nur getauscht', () => {
    // „Upload" in AvatarSetting ist der Aktionsknopf aus dem Befund. Er sieht
    // aus wie vorher; verschoben hat sich der ZUSTAND.
    const avatar = SRC.slice(SRC.indexOf('function AvatarSetting()'), SRC.indexOf('function Section('))
    expect(avatar).toContain('bg-gray-200 dark:bg-white/10')
    expect(avatar).not.toContain('bg-lu-accent-soft')
  })

  it('die Zustandskante erfuellt 1.4.11 in beiden Modi', () => {
    // Die Flaeche selbst ist absichtlich blass (rgba(160,148,248,.14) ueber
    // Weiss = 1.12:1) — die Kante traegt die Unterscheidbarkeit.
    expect(contrast(over(PAL.accent, PAL.white, 0.14), PAL.white)).toBeLessThan(1.5)
    expect(contrast(PAL.accentEdge, PAL.white)).toBeCloseTo(3.37, 2)
    expect(contrast(PAL.accent, PAL.appDark)).toBeCloseTo(6.27, 2)
    expect(contrast(PAL.accentEdge, PAL.white)).toBeGreaterThanOrEqual(3)
    expect(contrast(PAL.accent, PAL.appDark)).toBeGreaterThanOrEqual(3)
  })

  it('und der Text auf der Zustandsflaeche bleibt lesbar', () => {
    // gray-900 auf der hellen Akzentflaeche, Weiss auf der dunklen.
    expect(contrast(PAL.gray900, over(PAL.accent, PAL.white, 0.14))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(PAL.white, over(PAL.accent, PAL.appDark, 0.14))).toBeGreaterThanOrEqual(4.5)
  })

  it('OFFEN, ausdruecklich: der tab-weite Reset-Link bleibt im Dunkelmodus bei 3.37:1', () => {
    // `text-gray-500` ohne dark:-Gegenstueck. Die Klasse ist in
    // src/lib/__tests__/reset-arming-is-visible.test.ts woertlich gepinnt
    // (fremde Datei, nicht Teil dieses Pakets) — sie hier zu aendern hiesse,
    // jenen Test zu brechen oder zu entschaerfen. Der Wert steht deshalb als
    // gemessene, offene Luecke da, nicht als stille.
    expect(SRC).toContain("'text-gray-500 hover:text-red-400'")
    expect(contrast(PAL.gray500, PAL.appDark)).toBeLessThan(4.5)
    expect(contrast(PAL.gray500, PAL.white)).toBeGreaterThanOrEqual(4.5)
    // Der neue Hinweistext daneben ist dagegen in beiden Modi lesbar.
    expect(contrast(PAL.gray400, PAL.appDark)).toBeGreaterThanOrEqual(4.5)
  })
})
