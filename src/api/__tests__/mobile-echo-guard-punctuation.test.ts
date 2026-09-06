/**
 * Der Satzzeichen-Teil des mobilen Echo-Wächters, festgenagelt.
 *
 * ── Warum diese Datei existiert ──
 *
 * `isSystemPromptEcho` (mobile-client/agent-core.js) filtert die Zeile
 * „Hello, I am the Coding Agent…", die kleinere Modelle nach einem
 * Tool-Fehler statt einer Antwort schicken. Die Öffnung darf von einem von
 * drei Satzzeichen gefolgt sein: `!`, `,` oder `.` — als Zeichenklasse
 * `[!,.]`.
 *
 * Der Punkt stand dort bis zum 01.09.2026 als `\.` geschrieben, escaped.
 * Innerhalb einer Zeichenklasse ist das ein IdentityEscape und damit wirkungs-
 * los; eslint meldete es als `no-useless-escape`, und der Backslash ist jetzt
 * weg. Die Bytes dieser Datei SIND die ausgelieferte Seite, also ist jede
 * Änderung daran eine Änderung an dem, was auf dem Telefon läuft — und der
 * Rust-Test `mobile_landing_is_what_the_sources_say` vergleicht die Seite nur
 * mit sich selbst, er kann eine Verhaltensänderung nicht sehen.
 *
 * Diese Datei schließt genau diese Lücke: nicht „der Backslash ist weg",
 * sondern „die Klasse akzeptiert weiterhin alle drei Zeichen und nichts
 * sonst". Wer den Punkt beim nächsten Mal wirklich aus der Klasse entfernt,
 * läuft hier auf.
 *
 * `mobile-codex-parity.test.ts` prüft denselben Wächter, aber nur mit `!` und
 * `,` in den Beispielsätzen; der Punkt kam dort nie vor.
 */
import { describe, it, expect } from 'vitest'
import { isSystemPromptEcho } from '../../../mobile-client/agent-core.js'

describe('Der mobile Echo-Wächter und seine Satzzeichen', () => {
  // Beide Regexe mit einer Zeichenklasse: die Begrüßungs-Alternative in der
  // ersten Zeile und die „…ready"-Zeile in der dritten.
  const OPENERS = ['Hello', 'Hi', 'Hey']

  it('erkennt die Begrüßung mit jedem der drei Satzzeichen — Punkt eingeschlossen', () => {
    for (const opener of OPENERS) {
      for (const punct of ['!', ',', '.']) {
        const echo = `${opener}${punct} I am the coding agent`
        expect(isSystemPromptEcho(echo), echo).toBe(true)
      }
    }
  })

  it('erkennt die ready-Zeile mit jedem der drei Satzzeichen — Punkt eingeschlossen', () => {
    for (const opener of OPENERS) {
      for (const punct of ['!', ',', '.']) {
        const echo = `${opener}${punct} I'm ready`
        expect(isSystemPromptEcho(echo), echo).toBe(true)
      }
    }
  })

  it('das Satzzeichen bleibt optional', () => {
    expect(isSystemPromptEcho('Hello I am the coding agent')).toBe(true)
    expect(isSystemPromptEcho("Hey I'm ready")).toBe(true)
  })

  it('die Klasse ist auf diese drei Zeichen begrenzt und frisst kein viertes', () => {
    // Die Gegenrichtung. Ohne sie wäre die Klasse auch dann grün, wenn jemand
    // sie zu `[\s\S]` verbreitert — ein Wächter, der jede Begrüßung schluckt,
    // verschluckt auch echte Antworten des Modells.
    for (const punct of [';', ':', '?', '-', '*', 'x']) {
      const notAnEcho = `Hello${punct} I am the coding agent`
      expect(isSystemPromptEcho(notAnEcho), notAnEcho).toBe(false)
    }
  })

  it('eine echte Antwort, die mit derselben Silbe anfängt, bleibt unangetastet', () => {
    expect(isSystemPromptEcho('Hello. The bug is in src/main.ts, line 40.')).toBe(false)
    expect(isSystemPromptEcho('Hi. Done — three files written.')).toBe(false)
  })
})
