/**
 * Die Auskunftsseite muss Auskunft geben, nicht ihren eigenen Befehlsnamen.
 *
 * Rot vor dem Fix: die Seite rendert `system_health failed: {error}` direkt aus
 * dem geworfenen Fehler. Eine Persona las am 03.09.2026 „system_health failed:
 * Unknown backend command: system_health" und hielt die App fuer kaputt,
 * obwohl sie nur in der Browser-Oberflaeche ohne Rust-Prozess sass.
 *
 * Lauf: npx vitest run src/components/settings/__tests__/troubleshoot-hinweis.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { troubleshootHinweis } from '../troubleshoot-message'

const UNBEKANNT = new Error('Unknown backend command: system_health')

describe('Troubleshoot-Hinweis', () => {
  it('nennt im Browser die Grenze statt eines Fehlers', () => {
    const h = troubleshootHinweis(UNBEKANNT, false)
    expect(h.titel).toMatch(/desktop app/i)
    expect(h.detail).toBeNull()
    // Und kein roter Kasten: eine Grenze ist kein Fehler.
    expect(h.art).toBe('grenze')
    // Der entscheidende Punkt: kein interner Name im sichtbaren Text.
    expect(`${h.titel} ${h.detail ?? ''}`).not.toMatch(/system_health|backend command/i)
  })

  it('derselbe Fehler heisst in der Desktop-App etwas anderes', () => {
    const h = troubleshootHinweis(UNBEKANNT, true)
    expect(h.titel).toMatch(/updating/i)
    expect(h.art).toBe('fehler')
    // Hier ist die technische Zeile hilfreich — sie geht in einen Bericht.
    expect(h.detail).toBe(UNBEKANNT.message)
  })

  it('ein echter Fehler behaelt seine Ursache, aber bekommt einen Satz davor', () => {
    const h = troubleshootHinweis(new Error('connection refused'), true)
    expect(h.titel).toMatch(/could not finish/i)
    expect(h.detail).toBe('connection refused')
  })

  it('vertraegt auch etwas, das kein Error ist', () => {
    expect(troubleshootHinweis('kaputt', true).detail).toBe('kaputt')
    expect(troubleshootHinweis(undefined, true).detail).toBe('undefined')
  })

  it('die Seite baut den Satz nicht mehr selbst aus dem Fehler', () => {
    // Sonst waere die Funktion oben nur Dekoration. Der Wortlaut, den die
    // Persona gelesen hat, darf im JSX nicht mehr vorkommen.
    const jsx = readFileSync(join(process.cwd(), 'src/components/settings/SettingsPage.tsx'), 'utf-8')
    expect(jsx).not.toContain('system_health failed')
    expect(jsx).toContain('troubleshootHinweis')
  })
})
