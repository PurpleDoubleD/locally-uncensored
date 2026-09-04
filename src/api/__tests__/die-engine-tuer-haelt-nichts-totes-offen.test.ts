/**
 * Was diese Datei nach aussen gibt, muss draussen auch jemand brauchen.
 *
 * Drei Stellen taten das nicht mehr, alle drei aus derselben Runde:
 *
 *  - `announceLuEngineStartFailure` baute den ganzen Satz und gab ihn zurueck,
 *    "hand it back for the door it came through". Beide Tueren in der
 *    Anwendung warfen ihn weg, und die eine, die ihn haette anzeigen koennen,
 *    darf es ausdruecklich nicht (der-waehler-verdeckt-seine-eigene-meldung-
 *    nicht: der Waehler geht in derselben Bewegung zu). Gelesen hat ihn nur
 *    noch ein Test, also war der Rueckgabewert ein Vertrag mit niemandem.
 *  - `chatModelReplacedNote` und `isStandbyBackendRow` trugen ein `export`,
 *    obwohl ihr einziger Leser drei Zeilen weiter unten in derselben Datei
 *    steht.
 *
 * Wer den Wortlaut ohne Ansage braucht, fragt `luEngineStartFailureNote`, und
 * die bleibt exportiert, weil der Waehler sie kennt.
 *
 * Run: npx vitest run src/api/__tests__/die-engine-tuer-haelt-nichts-totes-offen.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as tuer from '../lu-engine-switch'

const SRC = readFileSync(resolve(__dirname, '..', 'lu-engine-switch.ts'), 'utf8')

describe('die Fehlstart-Ansage sagt an und gibt nichts zurueck', () => {
  it('die Signatur nennt void, und der alte Rueckgabeweg ist weg', () => {
    expect(SRC).toMatch(
      /export function announceLuEngineStartFailure\([^)]*\):\s*void\s*\{/,
    )
    expect(SRC).not.toContain('return full')
  })

  it('und zur Laufzeit kommt auch nichts zurueck', () => {
    const alsFunktion = tuer.announceLuEngineStartFailure as unknown as
      (...a: unknown[]) => unknown
    expect(alsFunktion('openai::X', new Error('boom'), false)).toBeUndefined()
  })

  it('der Wortlaut selbst bleibt zu haben, ohne dass etwas angesagt wird', () => {
    expect(typeof tuer.luEngineStartFailureNote).toBe('function')
    expect(tuer.luEngineStartFailureNote('openai::X', new Error('boom')))
      .toContain('boom')
  })
})

describe('was nur das Haus liest, bleibt im Haus', () => {
  it('chatModelReplacedNote steht nicht mehr in der Aussenwand', () => {
    expect('chatModelReplacedNote' in tuer).toBe(false)
    expect(SRC).not.toContain('export function chatModelReplacedNote')
    // Die Ansage drumherum schon: AppShell und useModels rufen sie.
    expect(typeof tuer.announceChatModelReplaced).toBe('function')
  })

  it('isStandbyBackendRow ebenso', () => {
    expect('isStandbyBackendRow' in tuer).toBe(false)
    expect(SRC).not.toContain('export function isStandbyBackendRow')
    // Der Weg zurueck laeuft ueber die Funktion, die den Steckplatz wirklich
    // weiterreicht, und die bleibt die Tuer nach draussen.
    expect(typeof tuer.handBackChatProviderForRow).toBe('function')
  })
})
