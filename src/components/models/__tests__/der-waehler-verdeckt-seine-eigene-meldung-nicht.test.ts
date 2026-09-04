/**
 * Der offene Waehler darf die Meldung nicht verdecken, die er selbst ausloest.
 *
 * Gegenprobe G1, 04.09.2026, im echten Windows-Build nachgemessen: nach dem
 * Klick auf eine kaputte GGUF-Datei steht die Diagnose an zwei Stellen, und
 * beide waren halb.
 *
 *   - Das offene Menue verdeckte 331 von 763 Pixeln des Banners ueber dem
 *     Eingabefeld, also 43 Prozent.
 *   - Der Text IM Menue war zu 69 Prozent abgeschnitten, scrollHeight 576
 *     gegen clientHeight 176, hinter einem zweiten, verschachtelten
 *     Rollbereich, den niemand sucht.
 *
 * Zwei Schriftstuecke, beide halb, keines ganz. Die Zeile ueber dem
 * Eingabefeld ist die dauerhafte: sie hat keine Uhr (tone 'error'), sie hat
 * ein X zum Wegdruecken, und sie ueberlebt jeden Ansichtswechsel. Also geht
 * das Menue zu, sobald der Start scheitert, und die Zeile liegt frei.
 *
 * Run: npx vitest run src/components/models/__tests__/der-waehler-verdeckt-seine-eigene-meldung-nicht.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(resolve(__dirname, '..', 'ModelSelector.tsx'), 'utf8')

/** Der Fangzweig des LU-Engine-Wegs, aus der Quelle geholt. */
function fangzweig(): string {
  const at = SRC.indexOf('announceLuEngineStartFailure(model.name, e, switched)')
  expect(at).toBeGreaterThan(0)
  const end = SRC.indexOf('} finally {', at)
  expect(end).toBeGreaterThan(at)
  return SRC.slice(at, end)
}

describe('ein gescheiterter Start', () => {
  it('schreibt die Zeile ueber dem Eingabefeld UND schliesst das Menue', () => {
    const zweig = fangzweig()
    expect(zweig).toContain('announceLuEngineStartFailure(model.name, e, switched)')
    expect(zweig).toContain('setOpen(false)')
    // Und NICHT zusaetzlich in den Kasten im Menue, das waere ein rotes
    // Aufblitzen fuer die Dauer der Ausblendung.
    expect(SRC).not.toContain('setSelectError(announceLuEngineStartFailure(')
  })

  it('erst schreiben, dann schliessen, sonst steht die Zeile nirgends', () => {
    const zweig = fangzweig()
    expect(zweig.indexOf('announceLuEngineStartFailure'))
      .toBeLessThan(zweig.indexOf('setOpen(false)'))
  })

  it('und stellt vorher das alte Modell zurueck', () => {
    const at = SRC.indexOf('announceLuEngineStartFailure(model.name, e, switched)')
    const catchAt = SRC.lastIndexOf('} catch (e) {', at)
    expect(catchAt).toBeGreaterThan(0)
    expect(SRC.slice(catchAt, at)).toContain('setActiveModel(vorherAktiv)')
  })
})

describe('die Zeile, die stehen bleibt', () => {
  const BAR = readFileSync(
    resolve(__dirname, '..', '..', 'chat', 'LuEngineSwitchBar.tsx'), 'utf8')
  const STORE = readFileSync(
    resolve(__dirname, '..', '..', '..', 'stores', 'luEngineSwitchStore.ts'), 'utf8')

  it('hat keine Uhr, wenn sie ein Fehler ist', () => {
    expect(STORE).toContain("if (tone === 'error') return")
  })

  it('und ein X, mit dem der Nutzer sie selbst wegnimmt', () => {
    expect(BAR).toContain('aria-label="Dismiss"')
    expect(BAR).toContain('dismiss()')
  })
})
