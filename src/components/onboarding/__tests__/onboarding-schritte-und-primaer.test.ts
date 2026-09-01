/**
 * Onboarding: wie viele Schritte es sind, wie der Primaerknopf aussieht, wie
 * gross die Willkommens-Ueberschrift ist, wo die Fortschrittspunkte haengen
 * und was in Schritt 3 statt eines Icons stand.
 *
 * Deckt D-S35, D-S36, D-S37, D-S38 und D-S39 des Design-Audits.
 *
 * Zwei Sorten Zusicherung stehen hier nebeneinander, und der Unterschied ist
 * wichtig:
 *
 *   — Die Schrittrechnung ist ECHTES Verhalten. `wizardProgress()` ist eine
 *     reine Funktion, sie wird hier aufgerufen und ihr Ergebnis geprueft.
 *   — Alles andere ist Quelltext- und Farbrechnung. Es gibt in diesem Projekt
 *     keinen Renderer (`vitest.config.ts`: `environment: 'node'`, kein jsdom,
 *     kein testing-library), also kann kein Test dieser Datei sagen, wie das
 *     Fenster aussieht. Was er sagen kann: welche Regel gilt und was sie
 *     rechnerisch bedeutet.
 *
 * Was ausdruecklich NICHT geprueft ist: die 294px aus D-S38. Die sind eine
 * Messung an gerendertem DOM; AUDIT-COVERAGE fuehrt D-S38 aus genau diesem
 * Grund als „nicht verifizierbar hier". Geprueft ist hier nur die URSACHE,
 * die das Audit benennt — `fixed top-10` plus zentrierter Inhalt.
 *
 * Lauf: npx vitest run src/components/onboarding/__tests__/onboarding-schritte-und-primaer.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { contrast, luminance } from '../../__tests__/wcag-contrast'
import { STEP_ORDER, WORK_STEPS, workStepsFor, wizardProgress } from '../wizard-steps'

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/**
 * Zwei Heuhaufen, und der Unterschied ist die halbe Aussage dieses Tests.
 *
 * Seit W-T3 ist der Assistent kein Einzelstueck mehr: die SCHALE haelt den
 * Rahmen (Fensterbalken, Fortschrittsanzeiger, Willkommen, Fertig), die vier
 * Arbeitsschritte liegen daneben, und die gemeinsame Formsprache steht in
 * `onboarding-skin.ts`.
 *
 *   SRC  — nur die Schale. Alles, was der RAHMEN behauptet, muss dort stehen
 *          und nirgends sonst: D-S37 (die H1), D-S38 (eine Spalte, ein fester
 *          Anzeiger, genau ein `fixed`), D-S35 (die Schrittrechnung).
 *   ALL  — der ganze Assistent. Alles, was eine VOKABEL ist, gilt ueberall:
 *          das Primaerrezept, die Negativkontrollen, das Icon aus D-S39.
 *
 * Waere alles gegen ALL geprueft, koennte der Fensterbalken in einen Schritt
 * wandern und der Test bliebe gruen. Waere alles gegen SRC geprueft, waere
 * er seit der Zerlegung fast leer.
 */
const DIR = resolve(__dirname, '..')
const SRC = codeOnly(readFileSync(resolve(DIR, 'Onboarding.tsx'), 'utf8'))
const ALL = [
  'Onboarding.tsx', 'BackendsStep.tsx', 'ComfyStep.tsx', 'ModelsStep.tsx',
  'EmbeddingsStep.tsx', 'onboarding-skin.ts', 'use-backend-scan.ts',
  'use-installer-fleet.ts', 'onboarding-host.ts', 'wait-for-download.ts',
  'wizard-steps.ts', 'installer-state.ts',
].map((n) => codeOnly(readFileSync(resolve(DIR, n), 'utf8'))).join('\n')
const CSS = readFileSync(resolve(__dirname, '..', '..', '..', 'index.css'), 'utf8')

const MAC = true
const WIN = false

// ── D-S35 — sechs Bildschirme, aber nicht sechs Aufgaben ──────────────────

describe('D-S35: der Anzeiger zaehlt Arbeitsschritte, nicht Bildschirme', () => {
  it('die Bildschirmliste ist unveraendert sechsteilig — daran wird nicht gelogen', () => {
    expect(STEP_ORDER).toEqual(['welcome', 'backends', 'comfyui', 'models', 'embeddings', 'done'])
    expect(STEP_ORDER).toHaveLength(6)
  })

  it('Willkommen und Fertig sind keine Arbeitsschritte', () => {
    const steps = WORK_STEPS.map((s) => s.step)
    expect(steps).not.toContain('welcome')
    expect(steps).not.toContain('done')
    expect(steps).toEqual(['backends', 'comfyui', 'models', 'embeddings'])
  })

  it('macOS hat wirklich drei, Windows und Linux vier', () => {
    expect(workStepsFor(MAC).map((s) => s.step)).toEqual(['backends', 'models', 'embeddings'])
    expect(workStepsFor(WIN)).toHaveLength(4)
  })

  it('das Titelbild bekommt keinen Fortschritt', () => {
    expect(wizardProgress('welcome', MAC)).toBeNull()
    expect(wizardProgress('welcome', WIN)).toBeNull()
  })

  it('jeder Arbeitsschritt sagt in Worten, der wievielte von wie vielen er ist', () => {
    expect(wizardProgress('backends', MAC)).toMatchObject({ position: 1, total: 3, filled: 1 })
    expect(wizardProgress('models', MAC)).toMatchObject({ position: 2, total: 3, filled: 2 })
    expect(wizardProgress('embeddings', MAC)).toMatchObject({ position: 3, total: 3, filled: 3 })
    expect(wizardProgress('backends', MAC)?.caption).toBe('Step 1 of 3 · Engine')
    expect(wizardProgress('comfyui', WIN)?.caption).toBe('Step 2 of 4 · Image & video')
    expect(wizardProgress('embeddings', WIN)?.caption).toBe('Step 4 of 4 · Documents')
  })

  it('der Abschluss faerbt alles voll und sagt es', () => {
    expect(wizardProgress('done', MAC)).toEqual({ position: null, total: 3, caption: 'Setup complete', filled: 3 })
    expect(wizardProgress('done', WIN)?.filled).toBe(4)
  })

  it('ein Schritt, den die Plattform ueberspringt, erzeugt keine falsche Zahl', () => {
    // ComfyUI existiert auf dem Mac nicht. Vorher waere das ein indexOf()
    // von -1 gewesen und haette alle Punkte leer gelassen.
    expect(wizardProgress('comfyui', MAC)).toBeNull()
    expect(wizardProgress('comfyui', WIN)?.position).toBe(2)
  })

  it('die Punkte im JSX haengen an den Arbeitsschritten, nicht mehr an STEP_ORDER', () => {
    expect(SRC).toContain('workStepsFor(isMacOS())')
    expect(SRC).toContain('wizardProgress(step, isMacOS())')
    expect(SRC).toContain('{workSteps.map((s, i) => (')
    expect(SRC).toContain('{progressNow.caption}')
    // Die alte Zaehlung ist weg: `visibleStepOrder` und `stepIndex` gab es
    // nur, um sechs Bildschirme als sechs Schritte zu zeichnen.
    expect(ALL).not.toContain('visibleStepOrder')
    expect(ALL).not.toContain('const stepIndex')
  })
})

// ── D-S36 — der Primaerknopf ──────────────────────────────────────────────

describe('D-S36: der Hover macht den Primaerknopf heller, nicht dunkler', () => {
  it('das Onboarding benutzt das vorhandene Rezept statt eines eigenen', () => {
    expect(ALL).toContain("const primaryBtn = 'lu-primary")
    // Und die vier weiteren Primaerknoepfe, die ihr Grau inline abgeschrieben
    // hatten, ebenfalls: Ollama, LM Studio (Server starten), ComfyUI,
    // „Install N models".
    expect((ALL.match(/lu-primary/g) ?? []).length).toBeGreaterThanOrEqual(5)
  })

  it('das Graphit-Rezept steht nirgends mehr in dieser Datei', () => {
    expect(ALL).not.toContain('bg-white text-black hover:bg-gray-200')
    expect(ALL).not.toContain('bg-gray-900 text-white hover:bg-gray-800')
  })

  it('das Rezept liegt weiterhin an EINER Stelle, in index.css', () => {
    expect((CSS.match(/^\.lu-primary\s*\{/gm) ?? [])).toHaveLength(1)
    expect(CSS).toMatch(/\.lu-primary:hover:not\(:disabled\)\s*\{/)
  })

  it('DER BEFUND, nachgerechnet: das alte Paar wurde im Hover dunkler', () => {
    // Dunkelmodus: Ruhe #ffffff, Hover #e5e7eb (gray-200).
    expect(luminance('#e5e7eb')).toBeLessThan(luminance('#ffffff'))
    // Hellmodus: Ruhe #111827 (gray-900), Hover #1f2937 (gray-800) — dort
    // wurde die Flaeche im Hover HELLER, also war die Bewegung in den beiden
    // Modi auch noch gegenlaeufig.
    expect(luminance('#1f2937')).toBeGreaterThan(luminance('#111827'))
  })

  it('DIE ABHILFE, nachgerechnet: der Akzent wird im Hover heller — in beiden Modi gleich', () => {
    const accent = CSS.match(/--color-lu-accent:\s*(#[0-9a-fA-F]{6})/)?.[1] ?? ''
    const hover = CSS.match(/--color-lu-accent-hover:\s*(#[0-9a-fA-F]{6})/)?.[1] ?? ''
    const onAccent = CSS.match(/--color-lu-on-accent:\s*(#[0-9a-fA-F]{6})/)?.[1] ?? ''
    expect([accent, hover, onAccent]).toEqual(['#a094f8', '#b1a6ff', '#111827'])
    expect(luminance(hover)).toBeGreaterThan(luminance(accent))
    // Und beide Zustaende bleiben lesbar: 6.83:1 bzw. 8.25:1.
    expect(contrast(accent, onAccent)).toBeCloseTo(6.83, 2)
    expect(contrast(hover, onAccent)).toBeCloseTo(8.25, 2)
  })

  it('die Sekundaerknoepfe bleiben sekundaer — sonst waere nur alles laut', () => {
    expect(ALL).toContain("const secondaryBtn = ")
    expect(ALL).not.toContain("const secondaryBtn = 'lu-primary")
  })
})

// ── D-S37 — die Willkommens-Ueberschrift ──────────────────────────────────

describe('D-S37: die H1 ist eine Ueberschrift, kein Label', () => {
  it('1.5rem / 1,21 / 600 — die Audit-Zahlen in einer Einheit, die mitskaliert', () => {
    expect(SRC).toContain('<h1 className="text-[1.5rem] leading-[1.21] font-semibold')
  })

  it('sie ist nicht mehr `text-base`', () => {
    expect(SRC).not.toContain('<h1 className="text-base font-semibold">')
  })

  /**
   * Das WIRKSAME Wurzelmass: Wurzel-`font-size` mal `--ui-scale`, denn der
   * Regler haengt als `zoom` an #root. Waehrend dieses Pakets lief die
   * D-A3-Umstellung parallel (18,4px ohne Regler → 16px mal 1,15); beide
   * Regime ergeben 18,4 gerenderte px, und genau deshalb steht die H1 in
   * rem und nicht in px. Ein `text-[28px]` waere im neuen Regime durch das
   * `zoom` auf 32,2px gelaufen.
   */
  function effectiveRootPx(): number {
    const root = Number(CSS.match(/html\s*\{[^}]*?font-size:\s*([\d.]+)px/s)?.[1])
    const scale = Number(CSS.match(/--ui-scale:\s*([\d.]+)/)?.[1] ?? 1)
    expect(Number.isFinite(root), 'Wurzel-font-size nicht gefunden').toBe(true)
    return root * scale
  }

  it('sie landet gerendert bei 27,6px — das Soll war 28', () => {
    const root = effectiveRootPx()
    expect(root).toBeCloseTo(18.4, 3)
    expect(1.5 * root).toBeCloseTo(27.6, 3)
    expect(Math.abs(1.5 * root - 28) / 28).toBeLessThan(0.02)
    // Zeilenhoehe: 1,21 × 27,6 = 33,4px, Soll 34.
    expect(Math.abs(1.21 * 1.5 * root - 34) / 34).toBeLessThan(0.02)
  })

  it('und ist damit gut die Haelfte groesser als das alte `text-base`', () => {
    // Der Befund im Verhaeltnis: 1rem war die Ueberschrift, 1rem ist auch
    // ein Settings-Label.
    expect(1.5).toBeGreaterThan(1)
    expect(1.5 * effectiveRootPx()).toBeGreaterThan(effectiveRootPx())
  })
})

// ── D-S38 — die Fortschrittspunkte ────────────────────────────────────────

describe('D-S38: die Punkte gehoeren zum Assistenten, nicht zur Titelleiste', () => {
  it('die Ursache aus dem Audit ist weg: kein `fixed top-10` mehr', () => {
    expect(ALL).not.toContain('fixed top-10')
  })

  it('Anzeiger und Karte stehen in EINER Spalte mit einem benannten Abstand', () => {
    expect(SRC).toContain('h-screen w-screen flex flex-col items-center justify-center gap-5 p-4')
  })

  it('der Anzeiger behaelt seine Hoehe, damit die Karte beim Schrittwechsel steht', () => {
    // Ohne feste Hoehe waechst der Block um die Textzeile, sobald der erste
    // Arbeitsschritt erreicht ist — und die Karte darunter springt.
    expect(SRC).toMatch(/<div className="h-8 flex flex-col items-center justify-end gap-1\.5"/)
  })

  it('der Fensterrahmen bleibt festgenagelt — nur er', () => {
    // `data-tauri-drag-region` MUSS fixed bleiben, das ist der Fensterbalken.
    expect(SRC).toContain('data-tauri-drag-region className="fixed top-0 left-0 right-0 h-8')
    expect((ALL.match(/className="fixed /g) ?? []).length).toBe(1)
  })
})

// ── D-S39 — der nackte Punkt ──────────────────────────────────────────────

describe('D-S39: Schritt 3 zeigt ein Zeichen statt eines Punktes', () => {
  it('der nackte Punkt ist weg', () => {
    expect(ALL).not.toContain('w-3 h-3 rounded-full bg-purple-400')
  })

  it('an seiner Stelle steht das Icon des Schrittes, auf einer Leiterstufe', () => {
    expect(ALL).toMatch(/<ImageIcon size=\{ICON_LG\} className="text-lu-accent" \/>/)
    expect(ALL).toContain("Image as ImageIcon")
    // Keine neue Icon-Groesse: ICON_LG ist die vorhandene 20er-Stufe. Die
    // Sperrklinke in src/components/__tests__/icon-leiter.test.ts zaehlt
    // distinkte numerische `size={n}` und darf nicht steigen.
    expect(ALL).not.toMatch(/<ImageIcon size=\{\d+\}/)
  })

  it('die Flaeche darunter ist dieselbe, die der Akzent sonst traegt', () => {
    expect(ALL).toContain('rounded-full bg-lu-accent-soft flex items-center justify-center')
    // Und der Akzent steht auf dem dunklen Grund des Onboardings fuer sich:
    // #a094f8 auf #202020 = 6.27:1.
    expect(contrast('#a094f8', '#202020')).toBeCloseTo(6.27, 2)
  })
})

// ── D-S39, zweite Haelfte — „vier Buttons in vier Behandlungen" ───────────
//
// Der Audit-Bullet hatte zwei Teile. Der erste (das Icon oben) war erledigt,
// der zweite nicht: auf DEM Bildschirm, den D-S39 benennt, standen vier
// Knoepfe in vier Behandlungen. Zwei liefen bereits ueber `.lu-primary`
// (`Install ComfyUI`, `Connect`), zwei nicht:
//
//   „I already have ComfyUI"  Sekundaerrezept fuer die Farbe, aber Breite und
//                             Ausrichtung aus einem INLINE-STIL — die Form kam
//                             aus einer zweiten Quelle.
//   „Cancel"                  ein Einzelstueck: 8,8px Schrift, 1px senkrechtes
//                             Polster, eigener Radius, rote Kante.
//
// Beide sind jetzt auf vorhandenen Rezepten, ohne eine neue Farbe und ohne
// eine neue Klasse: der eine auf der Sekundaerbehandlung dieser Datei, der
// andere auf `.lu-control` aus index.css.

describe('D-S39 (2): die vier Knoepfe des ComfyUI-Schrittes tragen zwei Rezepte', () => {
  const COMFY = codeOnly(readFileSync(resolve(DIR, 'ComfyStep.tsx'), 'utf8'))

  /** Die className-Kette jedes `<button>` im Abschnitt, in Reihenfolge. */
  function buttonClassNames(region: string): string[] {
    const out: string[] = []
    for (const m of region.matchAll(/<button\b/g)) {
      const tagStart = m.index
      const at = region.indexOf('className=', tagStart)
      if (at < 0) continue
      let i = at + 'className='.length
      if (region[i] === '"' || region[i] === "'") {
        const quote = region[i]
        out.push(region.slice(i + 1, region.indexOf(quote, i + 1)))
      } else if (region[i] === '{') {
        let depth = 0
        const start = i
        for (; i < region.length; i++) {
          if (region[i] === '{') depth++
          else if (region[i] === '}' && --depth === 0) break
        }
        out.push(region.slice(start + 1, i))
      }
    }
    return out
  }

  const KNOEPFE = buttonClassNames(COMFY)

  it('der Abschnitt wird wirklich gelesen — sonst prueft alles unten nichts', () => {
    expect(COMFY.length).toBeGreaterThan(2000)
    // Neun `<button>`: die beiden Listenformen (Install-Auswahl, „None of
    // these"), die vier aus dem Audit-Bullet und die drei der Fusszeile
    // (Re-Scan, Skip for now, Continue).
    expect(KNOEPFE).toHaveLength(9)
  })

  it('die zwei, die schon auf dem Rezept liefen, laufen weiter darauf', () => {
    expect(COMFY).toContain('className="lu-primary w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[0.7rem] transition-all"')
    expect(COMFY).toMatch(/className=\{primaryBtn\}\s*>\s*\n\s*Connect/)
  })

  it('„I already have ComfyUI" holt seine Form nicht mehr aus einem Inline-Stil', () => {
    expect(COMFY).toContain('className={`${secondaryBtn} w-full justify-center`}')
    // Die zweite Quelle ist weg — nicht nur hier, im ganzen Assistenten.
    expect(ALL).not.toContain("style={{ width: '100%', justifyContent: 'center' }}")
    // Und die Vokabel ist die seines Nachbarn, keine neue: derselbe
    // Install-Knopf darueber sagt Breite und Ausrichtung genauso.
    expect(COMFY).toContain('lu-primary w-full flex items-center justify-center')
  })

  it('„Cancel" traegt das neutrale Hausrezept, nicht mehr sein eigenes', () => {
    expect(COMFY).toContain('data-active="true"')
    expect(COMFY).toContain('className="lu-control"')
    // Das Einzelstueck ist fort: eigene Schriftgroesse, eigenes Polster,
    // eigener Radius, eigene Kante.
    expect(ALL).not.toContain('text-[0.55rem] px-1.5 py-[1px] rounded border transition-colors')
    expect(ALL).not.toContain('border-red-500/40 text-red-300 hover:bg-red-500/10')
    expect(ALL).not.toContain('border-red-300 text-red-600 hover:bg-red-50')
  })

  it('`.lu-control` ist nicht hier erfunden, sondern das Rezept aus index.css', () => {
    expect((CSS.match(/^\.lu-control\s*\{/gm) ?? [])).toHaveLength(1)
    // `data-active` ist dort ein echter Zustand, keine Dekoration.
    expect(CSS).toMatch(/\.lu-control:not\(\.lu-primary\)\[data-active='true'\]/)
  })

  it('DIE BEGRUENDUNG, nachgerechnet: neutral ist hier nicht die leisere Wahl', () => {
    // index.css schreibt fuer Stop auf, warum ein Ausstieg aus einem
    // LAUFENDEN Vorgang neutral bleibt und nicht rot wird — „Rot heisst in
    // dieser App kaputt oder wird geloescht". Abbrechen einer Installation
    // ist dieselbe Rolle. Die Zahlen sagen dazu, dass die Umstellung nichts
    // an Lesbarkeit kostet:
    //   dunkel  #9ca3af auf der Karte #202020
    //   hell    #4b5563 auf der Karte #f9fafb
    expect(contrast('#9ca3af', '#202020')).toBeCloseTo(6.42, 2)
    expect(contrast('#4b5563', '#f9fafb')).toBeCloseTo(7.23, 2)
    // Der hellere der beiden alten Zustaende lag bei 4.62:1, also knapp
    // ueber AA — die neutrale Fassung ist in beiden Modi deutlicher.
    expect(contrast('#dc2626', '#f9fafb')).toBeCloseTo(4.62, 2)
    expect(contrast('#4b5563', '#f9fafb')).toBeGreaterThan(contrast('#dc2626', '#f9fafb'))
  })

  it('NEGATIVKONTROLLE: der Schritt hat dadurch keine dritte Behandlung bekommen', () => {
    // Jeder Knopf traegt eins der vier bekannten Rezepte — ausser den zwei,
    // die keine Knoepfe im Sinne der Formsprache sind und deshalb hier
    // namentlich stehen: die Zeilen der Install-Auswahl (eine Liste) und
    // „None of these…" (ein Textlink).
    const fremd = KNOEPFE.filter((c) =>
      !/primaryBtn|secondaryBtn|lu-primary|lu-control/.test(c),
    )
    expect(fremd).toHaveLength(2)
    expect(fremd[0]).toContain('w-full text-left px-3 py-2 rounded-lg border')
    expect(fremd[1]).toContain('underline')
  })
})
