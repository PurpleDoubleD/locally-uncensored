/**
 * Der Waehler schreibt die Wahl, BEVOR er auf die Engine wartet.
 *
 * Persona P5, 03./04.09.2026, am echten Windows-Build: nach einem Klick auf
 * Phi-4-mini nannte das Eingabefeld 11 s lang "Hermes-3-Llama-3.2-3B", ein
 * Modell, das an dem Wechsel gar nicht beteiligt war, und erst nach 41 s den
 * Namen, den der Nutzer angeklickt hatte. Beim gesunden Wechsel dasselbe
 * Nachlaufen mit dem VORHERIGEN Namen. "Wer in diesem Fenster eine Frage
 * abschickt, weiss nicht, welches Modell antwortet."
 *
 * Der Grund ist die Reihenfolge. Ein Modellstart dauert Sekunden bis Minuten;
 * solange stand die alte Wahl noch da. Waehrend des Wartens wechselt aber der
 * Steckplatz, die Modelliste wird neu gebaut, und die Regel in
 * lib/active-model-mode findet die ALTE Wahl darin nicht mehr wieder und
 * faellt auf den Kopf der Liste zurueck. Alphabetisch ist das Hermes.
 *
 * Die Kachel auf der Models-Seite macht es seit dem 03.09.2026 richtig
 * herum, mit Rueckweg, wenn der Start scheitert. Der Waehler tat es nicht.
 *
 * Run: npx vitest run src/components/models/__tests__/die-wahl-steht-vor-dem-warten.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Das ganze Bauteil haengt an Hooks, Stores und Tauri und hat kein
// Render-Gestell (siehe model-selector-lms.test.ts). Geprueft wird deshalb
// die Reihenfolge im Quelltext, so wie es die Wechselfunktion der Engine
// drueben in engine.rs auch tut.
const src = readFileSync(
  resolve(__dirname, '..', 'ModelSelector.tsx'), 'utf8',
)

/** Der Rumpf des Zweigs, der eine LU-Engine-Zeile startet. */
const zweig = (() => {
  const von = src.indexOf('switched = ensureLuEngineIsChatProvider()')
  const bis = src.indexOf('setSelectingLms(null)', von)
  expect(von).toBeGreaterThan(0)
  expect(bis).toBeGreaterThan(von)
  return src.slice(von, bis)
})()

describe('die Reihenfolge', () => {
  it('die Wahl wird gesetzt, bevor auf den Start gewartet wird', () => {
    const wahl = zweig.indexOf('useModelStore.getState().setActiveModel(model.name)')
    const warten = zweig.indexOf('await activateBuiltinModel(model.name)')
    expect(wahl).toBeGreaterThan(-1)
    expect(warten).toBeGreaterThan(-1)
    expect(wahl).toBeLessThan(warten)
  })

  it('und der vorherige Name wird vorher gemerkt', () => {
    const merken = src.indexOf('const vorherAktiv = useModelStore.getState().activeModel')
    const wahl = src.indexOf('useModelStore.getState().setActiveModel(model.name)')
    expect(merken).toBeGreaterThan(-1)
    expect(merken).toBeLessThan(wahl)
  })

  it('scheitert der Start, geht die Wahl zurueck', () => {
    // Ohne das stuende die Wahl auf einem Modell, das nirgends laeuft, genau
    // der Befund, den die Kachel am 03.09.2026 hatte.
    expect(zweig).toContain('useModelStore.getState().setActiveModel(vorherAktiv)')
    const rueck = zweig.indexOf('setActiveModel(vorherAktiv)')
    const fangen = zweig.indexOf('} catch (e) {')
    expect(fangen).toBeGreaterThan(-1)
    expect(rueck).toBeGreaterThan(fangen)
  })

  it('und nur dann, wenn wirklich noch unsere Wahl dasteht', () => {
    // Ein zweiter Klick, der waehrenddessen durchkam, darf nicht
    // ueberschrieben werden.
    expect(zweig).toContain("useModelStore.getState().activeModel === model.name")
  })
})
