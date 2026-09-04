/**
 * Nachpruefung G3, 04.09.2026: das Fehlerbanner zu einer kaputten GGUF stand
 * ueber ZWOELF MINUTEN und ueberlebte jeden Ansichtswechsel, bis der Tester
 * sein x anklickte. Er hatte laengst wieder ein gesundes Modell gewaehlt.
 *
 * Dass eine Fehlerzeile keine Uhr hat, ist Absicht und bleibt so: sie verlangt
 * eine Handlung, und eine Zeile, die vor der Handlung weggeht, hat ihre
 * Aufgabe verfehlt. Was fehlte, war der Ausgang: ein geglueckter Start IST die
 * verlangte Handlung.
 *
 * Lauf: npx vitest run src/api/__tests__/ein-geglueckter-start-raeumt-die-fehlerzeile.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { clearEngineErrorAfterSuccess } from '../lu-engine-switch'
import { useLuEngineSwitchStore } from '../../stores/luEngineSwitchStore'

beforeEach(() => {
  useLuEngineSwitchStore.setState({ note: null, tone: 'info' })
})

describe('clearEngineErrorAfterSuccess', () => {
  it('raeumt die Fehlerzeile weg, an der der Nutzer vorbeigekommen ist', () => {
    useLuEngineSwitchStore.getState().announce('Couldn\'t start "kaputt.gguf". The file is damaged.', 'error')
    expect(useLuEngineSwitchStore.getState().note).not.toBeNull()
    clearEngineErrorAfterSuccess()
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
  })

  it('laesst eine Info-Zeile in Ruhe, die hat ihre eigene Uhr', () => {
    useLuEngineSwitchStore.getState().announce('Switched your chat provider to the LU Engine for this model.', 'info')
    clearEngineErrorAfterSuccess()
    expect(useLuEngineSwitchStore.getState().note)
      .toBe('Switched your chat provider to the LU Engine for this model.')
  })

  it('tut nichts, wenn gar nichts steht', () => {
    clearEngineErrorAfterSuccess()
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
  })
})

/**
 * Nachpruefung G4, 04.09.2026: zwei der vier Erfolgswege raeumten nicht.
 *
 * Der Weg dorthin ist der alltaegliche: eine kaputte GGUF waehlen, das Banner
 * kommt, und dann im SELBEN Menue ein Ollama-Modell nehmen. Der Chat
 * antwortete wieder, und darueber stand weiter die Fehlermeldung zu einer
 * Datei, mit der der Nutzer nichts mehr zu tun hatte. Dasselbe ueber den
 * LM-Studio-Weg.
 *
 * Warum an jedem Ausgang und nicht einmal am Anfang von `selectModelInner`:
 * ein Klick, der in der Mitte scheitert, hat die Zeile dann schon weggeraeumt,
 * bevor er eine neue schreibt, und ein Klick, der gar nichts bewirkt (Riegel
 * belegt), haette den einzigen Hinweis geloescht, der noch dastand.
 */
describe('jeder Erfolgsweg raeumt sie, nicht nur der ueber die Engine', () => {
  const lies = async (rel: string) => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve } = await import('node:path')
    return readFile(resolve(dirname(fileURLToPath(import.meta.url)), rel), 'utf8')
  }

  it('der Waehler, nachdem der Swap durch ist', async () => {
    const src = await lies('../../components/models/ModelSelector.tsx')
    const i = src.indexOf('const swapped = await activateBuiltinModel(model.name)')
    expect(i).toBeGreaterThan(-1)
    expect(src.slice(i, i + 400)).toContain('clearEngineErrorAfterSuccess()')
  })

  it('die Kachel, auf demselben Weg', async () => {
    const src = await lies('../../hooks/useModels.ts')
    expect(src).toContain('else clearEngineErrorAfterSuccess()')
  })

  it('der gewoehnliche Ausgang des Waehlers, ueber den jedes Ollama-Modell geht', async () => {
    const src = await lies('../../components/models/ModelSelector.tsx')
    const i = src.indexOf("// Non-LM-Studio, or an already-loaded LM Studio model: activate now.")
    expect(i).toBeGreaterThan(-1)
    const ausgang = src.slice(i, src.indexOf('setOpen(false)', i))
    expect(ausgang).toContain('setActiveModel(model.name)')
    expect(ausgang).toContain('clearEngineErrorAfterSuccess()')
  })

  it('und der Erfolgsausgang des LM-Studio-Vorladens', async () => {
    const src = await lies('../../components/models/ModelSelector.tsx')
    const i = src.indexOf("return // keep dropdown open; don't activate an unloaded model")
    expect(i).toBeGreaterThan(-1)
    expect(src.slice(i, i + 300)).toContain('clearEngineErrorAfterSuccess()')
  })
})
