/**
 * The thinking downgrade must have something to drop.
 *
 * All three agent branches answer a 400 (DeepInfra: 422) by resending without
 * `thinking`. When the turn never asked for thinking in the first place, that
 * resend is byte for byte the request that just failed: a second refusal, a
 * second charge on the cloud path, and a second wait for the user. useChat has
 * guarded this since it was written; the agent path never did until the review
 * of 2026-08-14.
 *
 * ── WAS DIESE PINS SEIT KF-21b HALTEN ──────────────────────────────────────
 * Bis KF-21b stand die Fehlerform hier dreimal woertlich im File, und diese
 * Datei pinnte sie als Text. Jetzt gibt es EINE Stelle —
 * hooks/codex/thinking-downgrade.ts, `shouldDowngradeThinking` —, und die Pins
 * sind mitgezogen: sie halten nicht mehr die ausgeschriebene Bedingung fest,
 * sondern den AUFRUF MIT UEBERGEBENER OPTION.
 *
 * Das ist genau die Eigenschaft, die beim Zusammenziehen verlorengehen kann.
 * `shouldDowngradeThinking(true, err)` waere ein gruener Aufruf der einen
 * Stelle und trotzdem derselbe alte Fehler: die Zusatzbedingung durch die
 * Hintertuer abgewaehlt. Jeder Zweig muss den Wert hereinreichen, den SEINE
 * Wiederholung fallen liesse.
 *
 * Run: npx vitest run src/hooks/__tests__/agent-think-downgrade.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Normalize to LF: a Windows checkout with core.autocrlf=true materializes
// CRLF, and the multi-line pins below would fail on line endings alone.
const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../useAgentChat.ts'), 'utf8',
).replace(/\r\n/g, '\n')

// Jeder Zweig mit dem Optionsobjekt, das er tatsaechlich abgeschickt hat.
const ZWEIGE = [
  ['the ollama branch', 'chatOptions'],
  ['the provider branch', 'streamOpts'],
  ['the hermes branch', 'hermesOpts'],
] as const

describe('all three branches decide through the one place', () => {
  for (const [name, optionsVar] of ZWEIGE) {
    it(`${name} passes the value it would drop`, () => {
      expect(src).toContain(`shouldDowngradeThinking(${optionsVar}.thinking, thinkErr)`)
    })
  }

  it('the one place is imported, not re-declared here', () => {
    expect(src).toContain("import { shouldDowngradeThinking } from './codex/thinking-downgrade'")
  })

  it('exactly three call sites — no branch downgrades past the guard', () => {
    expect(src.match(/shouldDowngradeThinking\(/g) ?? []).toHaveLength(3)
  })
})

describe('nothing opts back out of the guard', () => {
  it('no call hardcodes the first argument', () => {
    // Ein festes `true`/`false` waere ein gruener Aufruf der einen Stelle und
    // trotzdem der alte Fehler: es gaebe wieder nichts fallen zu lassen.
    expect(src).not.toMatch(/shouldDowngradeThinking\(\s*(?:true|false|undefined)\s*,/)
  })

  it('the guard is not re-asked in front of the call', () => {
    expect(src).not.toMatch(/thinking !== undefined\s*\n?\s*&&\s*shouldDowngradeThinking/)
  })

  it('no copy of the error form is left in the file', () => {
    // Die drei woertlichen Kopien, die hier bis KF-21b standen. Der Modelltext
    // darf bleiben, wo er KEINE Entscheidung trifft (der Erklaersatz fuer den
    // Nutzer, wenn der Abstieg endgueltig gescheitert ist) — verboten ist die
    // Verbindung aus Modelltext und Status, also die Fehlerform als Ausdruck.
    expect(src).not.toMatch(
      /'does not support thinking'[^;{}]{0,160}\|\|[^;{}]{0,160}\b4(?:00|22)\b/,
    )
    expect(src).not.toMatch(/httpStatusOf\(thinkErr\)/)
    // Auch nicht die halbe Frage: wer sie direkt stellt, umgeht die
    // Zusatzbedingung.
    expect(src).not.toContain('isThinkingUnsupportedError')
  })
})

describe('the call sites name why, so nobody removes them as noise', () => {
  it('the ollama branch keeps the reason the guard exists', () => {
    expect(src).toContain('charging the user twice (review')
    expect(src).toContain('2026-08-14')
  })

  it('the provider branch names where its 422 comes from', () => {
    // Die 422-Entscheidung: DeepInfra hinter dem LU-Cloud-Proxy, erreicht ueber
    // provider.chatStream. Ohne diesen Satz sieht die Nummer beim naechsten
    // Aufraeumen wieder wie useChat-Folklore aus.
    expect(src).toContain('DeepInfra behind the LU Cloud proxy')
    expect(src).toContain('422')
  })
})
