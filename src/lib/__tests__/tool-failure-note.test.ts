/**
 * Nach einem gescheiterten Werkzeug soll das Modell nicht raten.
 *
 * Siehe den Kopf von `tool-failure-note.ts` fuer die beiden Persona-Faelle vom
 * 03.09.2026 (erfundene Betriebssystemversion, erfundener Name mit erfundener
 * Quelle).
 *
 * Run: npx vitest run src/lib/__tests__/tool-failure-note.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { toolFailureNote } from '../tool-failure-note'

describe('toolFailureNote', () => {
  it('sagt nach einem Fehlschlag ausdruecklich, dass es keine Ausgabe gibt', () => {
    const n = toolFailureNote('failed')
    expect(n).toMatch(/did NOT run/)
    expect(n).toMatch(/[Dd]o not state or guess/)
  })

  it('schweigt, wenn alles gut ging', () => {
    for (const s of ['completed', 'cached', 'running', 'pending']) {
      expect(toolFailureNote(s)).toBe('')
    }
  })

  it('schweigt bei einer Ablehnung — die hat schon ihren eigenen Satz', () => {
    // 'User rejected this action. Try a different approach.' steht bereits in
    // der Historie; ein zweiter Satz davor waere nur Laerm.
    expect(toolFailureNote('rejected')).toBe('')
  })

  it('die Notiz haengt wirklich an der Historie, nicht nur an dieser Datei', () => {
    // Ohne diesen Riegel waere die Funktion oben Dekoration: sie muss an der
    // Stelle stehen, an der die Werkzeugantwort in die Nachrichten geht.
    const hook = readFileSync(join(process.cwd(), 'src/hooks/useAgentChat.ts'), 'utf-8')
    expect(hook).toContain('toolFailureNote(r.status)')
  })

  it('sie steht NACH dem Kuerzen', () => {
    // Sonst schneidet ein langes Fehlerprotokoll genau den Satz weg, der
    // gebraucht wird. Gemessen an einem Ergebnis, das die Kappe reisst.
    const hook = readFileSync(join(process.cwd(), 'src/hooks/useAgentChat.ts'), 'utf-8')
    const kuerzen = hook.indexOf('truncateToolResult(text,')
    const notiz = hook.indexOf('toolFailureNote(r.status)')
    expect(kuerzen).toBeGreaterThan(-1)
    expect(notiz).toBeGreaterThan(kuerzen)
  })
})
