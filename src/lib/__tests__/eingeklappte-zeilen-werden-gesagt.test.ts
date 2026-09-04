/**
 * Was zwei Backends aus derselben Datei anbieten, steht nur einmal in der
 * Liste. Richtig. Aber es muss auch dastehen, DASS es nur einmal dasteht, und
 * zwar in BEIDE Richtungen und auf BEIDEN Oberflaechen.
 *
 * Persona P5, 03./04.09.2026, am echten Windows-Build: LM Studio meldet ueber
 * die eigene Schnittstelle 7 Modelle, der Waehler zeigt unter LM STUDIO nur
 * 4. Die drei fehlenden sind genau die, deren Datei auch als LU-Engine-Zeile
 * dasteht. "Fuer den Nutzer sieht es trotzdem so aus, als seien drei seiner
 * LM-Studio-Modelle verschwunden, und es gibt keinen Hinweis darauf."
 *
 * Gegenprobe G1, 04.09.2026: dieselbe Sache in der anderen Richtung, und dort
 * schwerer. Sobald LM Studio den Steckplatz haelt, faellt `Qwen3-4B-Q4_K_M`,
 * eine echte installierte Datei des Kunden von 2,3 GB, aus dem Waehler UND von
 * der Models-Seite. Die Seite zeigte "Installed 11" und unter LU ENGINE vier
 * statt fuenf Dateien. Kein Hinweis, keine Erklaerung, waehrend fuer die
 * Gegenrichtung ein Satz existierte und angezeigt wurde.
 *
 * Ein Feld, ein Satz, beide Richtungen, beide Oberflaechen.
 *
 * Run: npx vitest run src/lib/__tests__/eingeklappte-zeilen-werden-gesagt.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  dropStandbyRowsServedByLuEngine, dropDuplicateLuEngineRows,
  foldedRowsSentence, zeileZumEinklappen, LU_ENGINE_GROUP,
} from '../lu-engine-rows'
import { LU_ENGINE_NAME } from '../engine-name'
import { useModelStore } from '../../stores/modelStore'

const lies = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')

/** Die echte Aufstellung von der Box, Nacht zum 04.09.2026. */
const UNSERE = [
  'Hermes-3-Llama-3.2-3B.Q4_K_M',
  'Phi-4-mini-instruct-Q4_K_M',
  'Qwen3-4B-Q4_K_M',
  'mlabonne_gemma-3-4b-it-abliterated-Q4_K_M',
].map((n) => ({ provider: 'openai', providerName: LU_ENGINE_NAME, name: n, model: n }))

const LM_STUDIO = [
  'qwen/qwen3-4b',
  'qwen/qwen3-4b/qwen3-4b-q4_k_m.gguf',
  'qwen2.5-0.5b',
  'qwen/qwen2.5-vl-7b',
  'qwen2.5-0.5b-instruct@q4_k_m',
  'qwen2.5-0.5b-instruct@q8_0',
  'mlabonne_gemma-3-4b-it-abliterated',
].map((n) => ({ provider: 'openai', providerName: 'LM Studio', name: n, model: n, lmsKey: n }))

describe('Richtung 1: unsere Engine haelt den Steckplatz, wartende Zeilen fallen', () => {
  it('die Zahl ist die gemessene: 7 gemeldet, 4 uebrig, 3 eingeklappt', () => {
    const bleiben = dropStandbyRowsServedByLuEngine(LM_STUDIO, UNSERE)
    expect(LM_STUDIO.length).toBe(7)
    expect(bleiben.length).toBe(4)
    expect(LM_STUDIO.length - bleiben.length).toBe(3)
  })

  it('und die drei sind genau die, die P5 vermisst hat', () => {
    const bleiben = dropStandbyRowsServedByLuEngine(LM_STUDIO, UNSERE).map((r) => r.name)
    for (const weg of [
      'qwen/qwen3-4b',
      'qwen/qwen3-4b/qwen3-4b-q4_k_m.gguf',
      'mlabonne_gemma-3-4b-it-abliterated',
    ]) {
      expect(bleiben).not.toContain(weg)
    }
  })

  it('ohne eigene Zeilen wird nichts eingeklappt und nichts gesagt', () => {
    // Negativkontrolle: der Satz darf nicht auf einer Maschine stehen, auf der
    // gar nichts doppelt ist.
    const bleiben = dropStandbyRowsServedByLuEngine(LM_STUDIO, [])
    expect(bleiben.length).toBe(LM_STUDIO.length)
    expect(zeileZumEinklappen(LM_STUDIO.length - bleiben.length, 'LM Studio', LU_ENGINE_GROUP)).toBeNull()
  })
})

describe('Richtung 2: LM Studio haelt den Steckplatz, unsere Zeilen fallen', () => {
  it('der Fund aus G1: Qwen3-4B-Q4_K_M faellt weg', () => {
    const bleiben = dropDuplicateLuEngineRows(UNSERE, LM_STUDIO).map((r) => r.name)
    expect(bleiben).not.toContain('Qwen3-4B-Q4_K_M')
    expect(UNSERE.length - bleiben.length).toBeGreaterThan(0)
  })

  it('und darueber wird jetzt geredet', () => {
    const bleiben = dropDuplicateLuEngineRows(UNSERE, LM_STUDIO)
    const satz = zeileZumEinklappen(UNSERE.length - bleiben.length, LU_ENGINE_GROUP, 'LM Studio')
    expect(satz).not.toBeNull()
    expect(satz!.backend).toBe(LU_ENGINE_GROUP)
    expect(satz!.servedBy).toBe('LM Studio')
    expect(foldedRowsSentence(satz!)).toContain('under LM Studio, because they are the same file')
  })

  it('ohne LM-Studio-Zeilen faellt nichts und wird nichts gesagt', () => {
    const bleiben = dropDuplicateLuEngineRows(UNSERE, [])
    expect(bleiben.length).toBe(UNSERE.length)
    expect(zeileZumEinklappen(0, LU_ENGINE_GROUP, 'LM Studio')).toBeNull()
  })
})

describe('der Satz', () => {
  it('nennt Anzahl, wessen Zeilen, und wer sie stattdessen bedient', () => {
    expect(foldedRowsSentence({ backend: 'LM Studio', count: 3, servedBy: 'LU Engine' }))
      .toBe('3 LM Studio models are listed once, under LU Engine, because they are the same file.')
  })

  it('spricht Einzahl, sonst stuende da "1 models are"', () => {
    expect(foldedRowsSentence({ backend: 'LU Engine', count: 1, servedBy: 'LM Studio' }))
      .toBe('1 LU Engine model is listed once, under LM Studio, because they are the same file.')
  })

  it('ohne einen der beiden Namen wird gar nichts gesagt, ein halber Satz waere schlimmer', () => {
    expect(zeileZumEinklappen(3, null, 'LM Studio')).toBeNull()
    expect(zeileZumEinklappen(3, 'LM Studio', null)).toBeNull()
  })
})

describe('der Speicher merkt sich, was gesagt werden muss', () => {
  beforeEach(() => { useModelStore.getState().setFoldedRows(null) })

  it('steht zu Anfang auf nichts', () => {
    expect(useModelStore.getState().foldedRows).toBeNull()
  })

  it('nimmt beide Namen und die Anzahl auf', () => {
    useModelStore.getState().setFoldedRows({ backend: 'LU Engine', count: 1, servedBy: 'LM Studio' })
    expect(useModelStore.getState().foldedRows)
      .toEqual({ backend: 'LU Engine', count: 1, servedBy: 'LM Studio' })
  })
})

describe('verdrahtet', () => {
  it('die Liste zaehlt beide Richtungen und sagt genau eine an', () => {
    const src = lies('hooks/useModels.ts')
    expect(src).toContain('const eigeneBleiben = dropDuplicateLuEngineRows(bundled, allModels)')
    expect(src).toContain('bundled.length - eigeneBleiben.length')
    expect(src).toContain('const bleiben = dropStandbyRowsServedByLuEngine(standbyRows, allModels)')
    expect(src).toContain('standbyRows.length - bleiben.length')
    expect(src).toContain('setFoldedRows(eingeklappt)')
  })

  it('der Waehler schreibt den Satz hin', () => {
    const src = lies('components/models/ModelSelector.tsx')
    expect(src).toContain('useModelStore((s) => s.foldedRows)')
    expect(src).toContain('data-testid="picker-folded-rows"')
    expect(src).toContain('foldedRowsSentence(foldedRows)')
  })

  it('und die Models-Seite jetzt auch, denn dort hat der Kunde gesucht', () => {
    const src = lies('components/models/ModelManager.tsx')
    expect(src).toContain('useModelStore((s) => s.foldedRows)')
    expect(src).toContain('data-testid="installed-folded-rows"')
    expect(src).toContain('foldedRowsSentence(foldedRows)')
  })
})
