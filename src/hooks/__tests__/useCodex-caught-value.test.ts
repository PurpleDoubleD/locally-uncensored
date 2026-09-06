/**
 * Der gefangene Wert im aeusseren catch von useCodex ist eine Behauptung, keine
 * Zusage.
 *
 * `catch (err)` faengt, was geworfen wurde — nicht, was ein Error waere. Der
 * Block las fuenf Felder ueber `const e = err as any`, und die erste dieser
 * Zeilen war
 *
 *     if ((err as Error).name !== 'AbortError')
 *
 * OHNE optionale Verkettung. Bei einem `throw null` (oder einem geworfenen
 * String, den ein Transport-Wrapper durchreicht) wirft diese Zeile SELBST einen
 * TypeError — mitten im einzigen Handler, der dem Nutzer sagen soll, warum der
 * Lauf gescheitert ist. Der Turn endete dann ohne jede Meldung im Chat, und die
 * Ursache stand nirgends. Die Guards antworten stattdessen `undefined`, und der
 * Zweig laeuft wie fuer jeden anderen unbekannten Fehler.
 *
 * Was dieser Test ist und was nicht: er liest die QUELLE, wie die
 * Struktur-Pins in useCodex-path-resolution.test.ts. Einen Test, der den echten
 * Turn faehrt, gibt es hier nicht — useCodex ist ein React-Hook, die
 * vitest-Umgebung ist `node`, und weder @testing-library/react noch
 * react-test-renderer sind Abhaengigkeiten dieses Projekts. Keine der Dateien
 * in diesem Verzeichnis rendert einen Hook. Diese Sonde ist damit ein Pin gegen
 * das Zurueckbauen der Pruefung, kein Verhaltensbeweis — und sie ist als
 * solcher benannt.
 *
 * Run: npx vitest run src/hooks/__tests__/useCodex-caught-value.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../useCodex.ts'),
  'utf8',
).replace(/\r\n/g, '\n')

/**
 * Der Rumpf des aeusseren catch — aus der Quelle GEHOLT, nicht abgeschrieben.
 * Verschwindet der Block, scheitert der Test hier laut, statt still auf einer
 * leeren Zeichenkette weiterzulaufen.
 */
function outerCatchBody(source: string): string {
  const at = source.indexOf('\n    } catch (err) {')
  if (at < 0) {
    throw new Error(
      'useCodex.ts hat keinen aeusseren `} catch (err) {`-Block mehr auf dieser ' +
      'Einrueckung — dieser Test muss mit dem Umbau mitziehen statt stumm gruen zu bleiben',
    )
  }
  const end = source.indexOf('\n    } finally {', at)
  if (end < 0) throw new Error('auf den aeusseren catch folgt kein `finally` mehr')
  return source.slice(at, end)
}

/**
 * Derselbe Block ohne Zeilenkommentare.
 *
 * Die Negativ-Zusicherungen unten muessen auf CODE laufen: der Kommentar im
 * Block ZITIERT die alte Fassung (`err as any`), und ein `not.toContain` faende
 * genau dieses Zitat. Dieselbe Falle, vor der useCodex-path-resolution.test.ts
 * schon warnt.
 */
function withoutComments(block: string): string {
  return block
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')
}

describe('useCodex reads the caught value instead of asserting about it', () => {
  const body = outerCatchBody(src)
  const code = withoutComments(body)

  it('has an outer catch that is long enough to be the real one', () => {
    // Absicherung des Extraktors selbst: der Block baut die Fehlermeldung des
    // Nutzers, er ist keine Zeile.
    expect(body.length).toBeGreaterThan(400)
    expect(body).toContain('Coding Agent error')
  })

  it('never re-asserts the thrown value as `any` or as an Error', () => {
    expect(code).not.toContain('err as any')
    expect(code).not.toContain('(err as Error)')
  })

  it('reads name and code through the boundary guards', () => {
    expect(body).toContain("asString(prop(err, 'name'))")
    expect(body).toContain("asString(prop(err, 'code'))")
  })

  it('decides the AbortError branch on the guarded name, not on a raw read', () => {
    // Der Vergleich muss auf dem GEPRUEFTEN Namen stehen. Stuende hier wieder
    // ein direkter Feldzugriff, waere `throw null` erneut ein TypeError im
    // Handler.
    expect(code).toMatch(/if \(errName !== 'AbortError'\)/)
    expect(code).not.toMatch(/\.name !== 'AbortError'/)
  })

  it('builds the user-facing message from errorText, which handles a non-Error', () => {
    expect(body).toContain('errorText(err)')
  })

  it('still routes the two codes that carry their own sentence', () => {
    // Die beiden Zweige, die es vorher ueber `e?.code` gab, muessen den
    // geprueften Code lesen — sonst ist die Verengung eine Verhaltensaenderung
    // statt einer Haertung.
    expect(body).toContain("code === 'credits_exhausted'")
    expect(body).toContain("code === 'tools_unsupported'")
  })
})
