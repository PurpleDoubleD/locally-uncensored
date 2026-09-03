/**
 * Der Modellwaehler liest die Liste beim Aufklappen neu.
 *
 * Persona P5, 03./04.09.2026, am echten Windows-Build: eine gerade angelegte
 * GGUF fehlte im Waehler, und eine laengst geloeschte stand noch darin. Erst
 * der Refresh-Knopf auf Models, Installed hat die Liste in Ordnung gebracht.
 *
 * Der Modellordner ist eine Sache der Platte, nicht der Anwendung, und es
 * gibt keinen Waechter darauf. Der Takt, den der Waehler ohnehin faehrt,
 * fragt nur nach dem Ladezustand von LM Studio und Ollama, nicht nach dem
 * Ordner: ein Ordnerlauf ueber vier Ebenen alle paar Sekunden waere zu teuer
 * und hat deshalb dort nichts verloren. Beim Aufklappen dagegen ist er genau
 * einmal faellig, und das ist der Moment, in dem die Liste zaehlt.
 *
 * Run: npx vitest run src/components/models/__tests__/der-waehler-liest-beim-aufklappen-neu.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = readFileSync(resolve(__dirname, '..', 'ModelSelector.tsx'), 'utf8')

describe('wann die Liste neu gelesen wird', () => {
  it('beim Aufklappen', () => {
    expect(src).toContain('useEffect(() => { if (open) void fetchModels() }, [open, fetchModels])')
  })

  it('und beim Aufbauen wie bisher', () => {
    expect(src).toContain('useEffect(() => { fetchModels() }, [fetchModels])')
  })

  it('aber nicht beim Zuklappen', () => {
    // Negativkontrolle gegen die naheliegende Vereinfachung
    // `useEffect(..., [open])` ohne Bedingung: die liefe beim Zuklappen
    // genauso und waere ein Ordnerlauf fuer niemanden.
    expect(src).not.toMatch(/useEffect\(\(\) => \{ void fetchModels\(\) \}, \[open/)
  })

  it('der Takt daneben fasst den Ordner weiterhin nicht an', () => {
    // Der Ladezustand-Takt laeuft alle paar Sekunden. Ein Ordnerlauf ueber
    // vier Ebenen gehoert dort nicht hinein, egal wie verlockend es ist,
    // beides zusammenzulegen.
    const takt = src.slice(src.indexOf('const tick = () => {'), src.indexOf('const tick = () => {') + 400)
    expect(takt).not.toContain('fetchModels')
  })
})
