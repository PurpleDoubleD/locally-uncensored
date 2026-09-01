/**
 * KF-21 — der Denk-Abstieg: EINE Stelle, und die Zusatzbedingung ueberlebt.
 *
 * ── DER BEFUND ─────────────────────────────────────────────────────────────
 * Die Frage "muss der Denkmodus herabgestuft werden?" stand dreimal in
 * useCodex.ts, in drei Schreibweisen. Zwei unterschieden sich nur in der
 * Reihenfolge der `||`-Operanden. Die Hermes-Kopie trug eine ZUSATZBEDINGUNG,
 * die den anderen beiden fehlte: nur absteigen, wenn ueberhaupt ein
 * Denk-Schalter gesetzt war.
 *
 * Das ist die gefaehrlichste Form der Doppelung: drei Kopien, die fast gleich
 * sind. Der Unterschied sieht aus wie ein Schreibfehler und wird beim
 * Vereinheitlichen still weggeraeumt.
 *
 * ── DAS URTEIL ─────────────────────────────────────────────────────────────
 * Die Zusatzbedingung ist KEINE Hermes-Eigenart, sondern eine Luecke in den
 * anderen beiden. Der Abstieg besteht darin, `thinking` fallen zu lassen — war
 * es schon `undefined`, ist die Wiederholung Byte fuer Byte die gescheiterte
 * Anfrage. useChat.ts fragt seit jeher so, useAgentChat.ts hat es am
 * 2026-08-14 in allen drei Zweigen nachgetragen. Die Begruendung steht an der
 * zusammengezogenen Stelle: codex/thinking-downgrade.ts.
 *
 * Diese Reihe misst beides: DASS es eine Stelle ist, und DASS sie die
 * Zusatzbedingung traegt. Eine Wache, die nur zaehlt, waere auch dann gruen,
 * wenn die Vereinheitlichung die Bedingung verloren haette.
 *
 * Run: npx vitest run src/hooks/codex/__tests__/ein-abstieg-eine-stelle.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { shouldDowngradeThinking, isThinkingUnsupportedError } from '../thinking-downgrade'

// Auf LF normiert: eine Windows-Auscheckung mit core.autocrlf=true legt CRLF
// an, und die mehrzeiligen Pins scheiterten sonst schon an den Zeilenenden.
const hier = dirname(fileURLToPath(import.meta.url))
const useCodex = readFileSync(resolve(hier, '../../useCodex.ts'), 'utf8').replace(/\r\n/g, '\n')
const modul = readFileSync(resolve(hier, '../thinking-downgrade.ts'), 'utf8').replace(/\r\n/g, '\n')

const vierhundert = () => Object.assign(new Error('bad request'), { status: 400 })

describe('die Zusatzbedingung: nur absteigen, wenn es etwas fallen zu lassen gibt', () => {
  it('mit angefragtem Denkmodus steigt der Lauf ab', () => {
    expect(shouldDowngradeThinking(true, vierhundert())).toBe(true)
  })

  it('ein ausdrueckliches AUS zaehlt auch — `false` ist ein gesetzter Schalter', () => {
    // `false` heisst "aus", `undefined` heisst "der Server entscheidet". Die
    // Wiederholung schickt also etwas anderes als der gescheiterte Zug.
    expect(shouldDowngradeThinking(false, vierhundert())).toBe(true)
  })

  it('OHNE angefragten Denkmodus steigt er NICHT ab — das ist die Bedingung', () => {
    // Ohne sie waere die Wiederholung Byte fuer Byte die Anfrage, die eben
    // gescheitert ist: zweite Absage, zweite Abrechnung, zweite Wartezeit.
    expect(shouldDowngradeThinking(undefined, vierhundert())).toBe(false)
    expect(shouldDowngradeThinking(undefined, new Error('does not support thinking'))).toBe(false)
  })

  it('ein anderer Fehler bleibt ein anderer Fehler', () => {
    expect(shouldDowngradeThinking(true, Object.assign(new Error('nope'), { status: 500 }))).toBe(false)
    expect(shouldDowngradeThinking(true, new Error('Failed to fetch'))).toBe(false)
  })

  it('ein geworfener Nicht-Fehler wirft hier nicht', () => {
    expect(() => shouldDowngradeThinking(true, null)).not.toThrow()
    expect(shouldDowngradeThinking(true, null)).toBe(false)
    expect(shouldDowngradeThinking(true, 'does not support thinking')).toBe(true)
  })

  it('die Fehlerform allein bleibt fuer sich pruefbar', () => {
    // `isThinkingUnsupportedError` ist die halbe Frage und bleibt exportiert;
    // entschieden wird aber ueber `shouldDowngradeThinking`.
    expect(isThinkingUnsupportedError(vierhundert())).toBe(true)
  })
})

describe('EINE Stelle entscheidet', () => {
  const aufrufe = useCodex.match(/shouldDowngradeThinking\(/g) ?? []

  it('useCodex.ts fragt an genau drei Transporten, und immer ueber die eine Stelle', () => {
    expect(aufrufe).toHaveLength(3)
  })

  it('jeder Transport reicht SEINE eigenen Optionen hinein', () => {
    // Ein fest verdrahtetes `true` waere die Zusatzbedingung durch die
    // Hintertuer wieder abgewaehlt.
    expect(useCodex).toContain('shouldDowngradeThinking(chatOptions.thinking, thinkErr)')
    expect(useCodex).toContain('shouldDowngradeThinking(streamOpts.thinking, thinkErr)')
    expect(useCodex).toContain('shouldDowngradeThinking(hermesOpts.thinking, thinkErr)')
  })

  it('keine Kopie der Fehlerform ist in useCodex.ts zurueckgeblieben', () => {
    expect(useCodex).not.toContain('does not support thinking')
    expect(useCodex).not.toMatch(/httpStatusOf\([^)]*\)\s*===\s*400/)
    // Auch nicht die halbe Frage: wer sie hier direkt stellt, umgeht die
    // Zusatzbedingung.
    expect(useCodex).not.toContain('isThinkingUnsupportedError')
  })

  it('die Zusatzbedingung steht nicht noch einmal VOR dem Aufruf', () => {
    expect(useCodex).not.toMatch(/thinking !== undefined\s*&&\s*shouldDowngradeThinking/)
  })
})

describe('die zusammengezogene Stelle haelt die Zusatzbedingung fest', () => {
  it('sie steht im Modul, nicht an den Aufrufstellen', () => {
    expect(modul).toContain('requestedThinking !== undefined')
  })

  it('und die Begruendung steht dabei, damit sie niemand als Rauschen entfernt', () => {
    // Ohne das WARUM sieht die Bedingung beim naechsten Aufraeumen wieder aus
    // wie ein Schreibfehler — genau so ist sie in zwei von drei Zweigen
    // verlorengegangen.
    expect(modul).toContain('die eben gescheitert ist')
    expect(modul).toContain('zweite Abrechnung')
    expect(modul).toContain('useChat.ts')
    expect(modul).toContain('useAgentChat.ts')
    expect(modul).toContain('2026-08-14')
  })

  it('die drei alten Schreibweisen bleiben als Fundstelle notiert', () => {
    expect(modul).toContain('Ollama:')
    expect(modul).toContain('OpenAI:')
    expect(modul).toContain('Hermes:')
  })
})
