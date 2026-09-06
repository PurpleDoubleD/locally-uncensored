/**
 * Ein misslungener Engine-Start muss den Nutzer auch dann erreichen, wenn er
 * den Modellwaehler laengst geschlossen hat.
 *
 * Persona P5, 03./04.09.2026, am echten Windows-Build: Klick auf eine kaputte
 * GGUF, zwei Sekunden spaeter den Waehler mit Escape geschlossen, so wie ein
 * Mensch es tut. Die Antwort der Engine kam erst 12,2 bis 21,2 s nach dem
 * Klick. In der Zwischenzeit war der Chat 7,4 s ohne Engine, die App hat zwei
 * Prozesse gestartet und wieder abgeraeumt, und auf dem Bildschirm stand 75
 * Sekunden lang kein einziges neues Wort. Die Meldung lebte nur im Popover,
 * und das Popover war weg.
 *
 * Run: npx vitest run src/api/__tests__/der-fehlstart-bleibt-stehen.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  announceLuEngineStartFailure, luEngineStartFailureNote, LU_ENGINE_SWITCH_NOTE,
} from '../lu-engine-switch'
import { useLuEngineSwitchStore } from '../../stores/luEngineSwitchStore'

const lies = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')

describe('die Meldung landet in der stehenden Zeile', () => {
  beforeEach(() => {
    useLuEngineSwitchStore.setState({ note: null, tone: 'info', generation: 0 })
  })

  it('schreibt den Fehlstart ueber das Eingabefeld, nicht nur ins Popover', () => {
    announceLuEngineStartFailure('openai::Kaputt-Q4_K_M', new Error('header'), false)
    const s = useLuEngineSwitchStore.getState()
    expect(s.note).toContain('Kaputt-Q4_K_M')
    expect(s.note).toContain('header')
    expect(s.tone).toBe('error')
  })

  it('und schreibt genau die Zeile, die der gemeinsame Textbau liefert', () => {
    // Zwei Woerter fuer dieselbe Sache waeren zwei Stellen, an denen sie
    // auseinanderlaufen koennen. Die Zeile wurde frueher zusaetzlich
    // zurueckgegeben; keine der beiden Tueren hat sie je gelesen, und die
    // stehende Zeile ist ohnehin der Ort, an dem sie ankommen muss.
    announceLuEngineStartFailure('openai::X', new Error('boom'), false)
    expect(useLuEngineSwitchStore.getState().note)
      .toBe(luEngineStartFailureNote('openai::X', new Error('boom')))
  })

  it('nennt den verschobenen Steckplatz mit, wenn er verschoben wurde', () => {
    announceLuEngineStartFailure('openai::X', new Error('boom'), true)
    const note = useLuEngineSwitchStore.getState().note ?? ''
    expect(note.startsWith(LU_ENGINE_SWITCH_NOTE)).toBe(true)
    expect(note).toContain('boom')
  })

  it('ein Fehler hat keine Selbstloeschuhr', () => {
    // Sonst waere die Zeile weg, bevor der Nutzer vom Kaffee zurueck ist. Die
    // Info-Zeile darf sich raeumen, diese nicht.
    announceLuEngineStartFailure('openai::X', new Error('boom'), false)
    expect(useLuEngineSwitchStore.getState().tone).toBe('error')
    const s = lies('stores/luEngineSwitchStore.ts')
    expect(s).toMatch(/tone === 'error'|tone !== 'error'/)
  })
})

describe('beide Tueren schreiben aus derselben Hand', () => {
  it('der Waehler ruft die gemeinsame Stelle und textet nicht selbst', () => {
    const src = lies('components/models/ModelSelector.tsx')
    expect(src).toContain('announceLuEngineStartFailure(model.name, e, switched)')
    // Und schreibt seit G1 (04.09.2026) NICHT mehr zusaetzlich in den Kasten
    // im Menue: das Menue geht in derselben Bewegung zu, der Kasten waere ein
    // rotes Aufblitzen fuer die Dauer der Ausblendung.
    expect(src).not.toContain('setSelectError(announceLuEngineStartFailure(')
    // Die alte Fassung schrieb nur in den eigenen Kasten.
    expect(src).not.toContain('setSelectError(luEngineStartFailureNote(')
  })

  it('die Kachel ebenso', () => {
    const src = lies('hooks/useModels.ts')
    expect(src).toContain('announceLuEngineStartFailure(name, reason, switched)')
    expect(src).not.toContain('`${LU_ENGINE_SWITCH_NOTE} ${line}`')
  })
})

describe('das Aufklappmenue bleibt im Fenster', () => {
  const src = lies('components/models/ModelSelector.tsx')

  it('es misst, wie viel Platz ueber dem Ausloeser wirklich ist', () => {
    // Ein festes max-h in vh weiss nichts davon, wo der Ausloeser sitzt.
    expect(src).toContain('const frei = openUpward ? r.top : window.innerHeight - r.bottom')
    expect(src).toContain('setMenuePlatz(')
    expect(src).toContain('style={menuePlatz === null ? undefined : { maxHeight: menuePlatz }}')
  })

  it('und was nicht mehr hineinpasst, laesst sich scrollen', () => {
    // P5: das Menue trug overflow-hidden, also half weder Mausrad noch
    // scrollTop, und der Kopf der Meldung stand bei -149 px.
    const menue = src.slice(src.indexOf('data-testid="model-picker-menu"'))
    expect(menue).toContain('overflow-y-auto')
    expect(menue.slice(0, 400)).not.toContain('overflow-hidden')
  })

  it('der Fehlerkasten hat seinen eigenen Deckel', () => {
    const kasten = src.slice(src.indexOf('data-testid="model-picker-error"'))
    expect(kasten.slice(0, 400)).toContain('max-h-[22vh]')
    expect(kasten.slice(0, 400)).toContain('overflow-y-auto')
    // Und die Zeilenumbrueche der Maschine bleiben Zeilenumbrueche, sonst
    // klebt das ganze Protokoll zu einem Absatz zusammen.
    expect(kasten.slice(0, 400)).toContain('whitespace-pre-wrap')
  })
})
