/**
 * Was das wartende Backend anbietet und unsere Engine aus derselben Datei
 * schon bedient, steht nur einmal in der Liste. Richtig. Aber es muss auch
 * dastehen, DASS es nur einmal dasteht.
 *
 * Persona P5, 03./04.09.2026, am echten Windows-Build: LM Studio meldet ueber
 * die eigene Schnittstelle 7 Modelle, der Waehler zeigt unter LM STUDIO nur
 * 4. Die drei fehlenden sind genau die, deren Datei auch als LU-Engine-Zeile
 * dasteht. "Fuer den Nutzer sieht es trotzdem so aus, als seien drei seiner
 * LM-Studio-Modelle verschwunden, und es gibt keinen Hinweis darauf."
 *
 * Run: npx vitest run src/lib/__tests__/eingeklappte-standby-zeilen-werden-gesagt.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dropStandbyRowsServedByLuEngine } from '../lu-engine-rows'
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

describe('die Zahl, die der Satz nennt', () => {
  it('ist die gemessene: 7 gemeldet, 4 uebrig, 3 eingeklappt', () => {
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
  })
})

describe('der Speicher merkt sich, was gesagt werden muss', () => {
  beforeEach(() => { useModelStore.getState().setFoldedStandby(null) })

  it('steht zu Anfang auf nichts', () => {
    expect(useModelStore.getState().foldedStandby).toBeNull()
  })

  it('nimmt Backend und Anzahl auf', () => {
    useModelStore.getState().setFoldedStandby({ backend: 'LM Studio', count: 3 })
    expect(useModelStore.getState().foldedStandby).toEqual({ backend: 'LM Studio', count: 3 })
  })
})

describe('verdrahtet', () => {
  it('die Liste zaehlt, was sie einklappt, und sagt es an', () => {
    const src = lies('hooks/useModels.ts')
    expect(src).toContain('const bleiben = dropStandbyRowsServedByLuEngine(standbyRows, allModels)')
    expect(src).toContain('setFoldedStandby(')
    expect(src).toContain('count: standbyRows.length - bleiben.length')
    // Und raeumt den Satz wieder weg, wenn es nichts mehr einzuklappen gibt.
    expect(src).toContain('setFoldedStandby(null)')
  })

  it('der Waehler schreibt den Satz hin', () => {
    const src = lies('components/models/ModelSelector.tsx')
    expect(src).toContain('useModelStore((s) => s.foldedStandby)')
    const zeile = src.slice(src.indexOf('data-testid="picker-folded-standby"'))
    expect(zeile.slice(0, 600)).toContain('listed once, under the LU Engine, because they are the same file')
    // Einzahl und Mehrzahl, sonst steht da "1 models are".
    expect(zeile.slice(0, 600)).toContain("count === 1 ? 'model is' : 'models are'")
  })
})
