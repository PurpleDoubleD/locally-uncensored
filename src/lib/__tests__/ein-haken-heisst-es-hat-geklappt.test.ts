import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolResultIsFailure } from '../tool-result-failure'
import { applyResultToToolCall } from '../../api/agents/tool-executor'
import type { AgentToolCall } from '../../types/agent-mode'

/**
 * Ein Haken in der Schrittliste muss heissen, dass es geklappt hat.
 *
 * Ein Persona-Lauf am 03.09.2026 sah dreimal `web_search ✓` mit Laufzeit und
 * gruenem Haken. Der Antwortkoerper war jedes Mal
 * `{"results":[],"error":"All search tiers failed: Wikipedia returned no
 * results"}`, HTTP 200. Das Modell bekam den Fehlertext durchaus zu lesen —
 * es hat trotzdem eine Vergleichstabelle mit erfundenen Paragraphen und
 * Fristen gebaut, und der Kunde hatte keinen Grund zu zweifeln: drei Haken.
 *
 * Die Ursache ist strukturell: Werkzeuge geben `Promise<string>` zurueck, es
 * gibt keinen Fehlerkanal. Wer nicht wirft, gilt als erfolgreich. Fuer die
 * Medien-Werkzeuge hat dieses Haus das schon einmal geloest
 * (`media-result.ts`, D#81) — nur eben nur fuer die.
 *
 * Wie dort bewusst konservativ: erkannt wird ausschliesslich, was wir SELBST
 * am Anfang der Antwort ausgeben. Alles Unbekannte gilt als Erfolg. Ein
 * Waechter, der einen echten Treffer rot faerbt, ist schlimmer als der Fehler,
 * den er verhindern soll.
 */

const hier = dirname(fileURLToPath(import.meta.url))
const werkzeuge = readFileSync(resolve(hier, '..', '..', 'api', 'mcp', 'builtin-tools.ts'), 'utf8')

describe('unsere eigenen Fehlerformen werden erkannt', () => {
  const echt = [
    'Web search failed: All search tiers failed: Wikipedia returned no results',
    'Error: No URL provided',
    'Error (1):\nbash: nope',
    'Error: web_fetch failed: timeout (the backend path failed first: 500)',
    'Image generation failed: ComfyUI returned 400',
    'Video generation failed: mlx-video failed',
    'git_commit failed (exit 1):\nnothing to commit',
    'git_status failed: not a repository',
    'Refused: this turn is read-only (/review, Code-Review Mode or Plan mode).',
    'run_tests: could not detect a test runner. Pass `command` or `runner`.',
    'pr_resume: unparseable gh output (SyntaxError)',
  ]
  it.each(echt)('%s gilt als Fehlschlag', (t) => expect(toolResultIsFailure(t)).toBe(true))

  const erfolge = [
    '1. Transparenzgesetz Hamburg\n   https://example.org\n   Das HmbTG regelt…',
    'Die Datei wurde geschrieben (2.140 Zeichen).',
    // Der gefaehrliche Fall: „failed" MITTEN im Ergebnis, nicht am Anfang.
    '1. Warum das Projekt scheiterte\n   https://example.org\n   The mission failed: a retrospective.',
    'On branch main\nnothing to commit, working tree clean',
    '',
  ]
  it.each(erfolge)('%s gilt als Erfolg', (t) => expect(toolResultIsFailure(t)).toBe(false))
})

describe('die Erkennung bleibt an den Werkzeugen dran', () => {
  it('jede Fehlerform aus builtin-tools.ts wird erkannt', () => {
    // Selbsttragend: kommt ein neues Werkzeug mit einer neuen Fehlerform, faellt
    // das hier auf, statt still als Haken durchzugehen.
    const formen = [...werkzeuge.matchAll(/return\s+([`'"])((?:[^\\]|\\.)*?)\1/g)]
      .map((m) => m[2])
      .filter((t) => /^\s*(Error|Refused|[\w ]{0,40}\bfailed\b|[\w_]+:\s*(could not|unparseable))/i.test(t))
      // Platzhalter durch etwas Harmloses ersetzen, sonst prueft der Test die
      // Schreibweise von Template-Literalen und nicht die Erkennung.
      .map((t) => t.replace(/\$\{[^}]*\}/g, 'X'))

    expect(formen.length, 'es muessen Fehlerformen gefunden werden').toBeGreaterThan(20)
    const uebersehen = formen.filter((t) => !toolResultIsFailure(t))
    expect(uebersehen).toEqual([])
  })
})


describe('die Schrittliste uebernimmt das Urteil', () => {
  const anruf = () => ({ id: 't1', name: 'web_search', arguments: {}, status: 'running' }) as unknown as AgentToolCall
  const ergebnis = (result: string) =>
    ({ id: 't1', status: 'completed', result, durationMs: 1234, startedAt: 1, completedAt: 2 }) as never

  it('macht aus einem erledigten Fehlschlag einen Fehlschlag', () => {
    const c = applyResultToToolCall(anruf(), ergebnis('Web search failed: All search tiers failed'))
    expect(c.status).toBe('failed')
    // Die erste Zeile steht als Fehler daneben, damit man nicht aufklappen muss.
    expect(c.error).toContain('All search tiers failed')
    // Und der Text selbst bleibt unveraendert — das Modell hat ihn ja gelesen.
    expect(c.result).toContain('Web search failed')
  })

  it('laesst einen echten Treffer in Ruhe', () => {
    const c = applyResultToToolCall(anruf(), ergebnis('1. Ein Treffer\n   https://example.org'))
    expect(c.status).toBe('completed')
    expect(c.error).toBeUndefined()
  })

  it('ueberschreibt einen bereits gemeldeten Fehler nicht', () => {
    const mitFehler = { id: 't1', status: 'completed', result: 'Error: kaputt', error: 'der echte Grund', durationMs: 1 } as never
    expect(applyResultToToolCall(anruf(), mitFehler).error).toBe('der echte Grund')
  })
})
