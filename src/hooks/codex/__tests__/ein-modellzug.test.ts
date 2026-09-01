/**
 * Was ein einzelner Modellzug im Coding-Agenten ergibt.
 *
 * ── WARUM ES DIESE TESTS VORHER NICHT GAB ──────────────────────────────────
 * Alle vier Regeln hier standen inline in der Schleife von `useCodex.ts`, in
 * einem `useCallback` von 2358 Zeilen. Erreichbar waren sie nur ueber einen
 * kompletten Zug — also mit Modell, Anbieter und Netz daran. Drei von ihnen
 * hatten dabei eine dokumentierte Fehlergeschichte, und keine davon einen Test:
 *
 *   • der Live-Anstrich (Pruefung D1: ein wartendes Bild malte alten Inhalt
 *     ueber den fertigen Text);
 *   • die Bergung von Werkzeugaufrufen aus dem Fliesstext (qwen2.5-coder:3b);
 *   • das Urteil "steckengeblieben oder fertig" (David 2026-06-02: der Agent
 *     "antwortet in loops" auf eine simple Frage);
 *   • der Denk-Abstieg, der in DREI Transporten in drei Schreibweisen stand.
 *
 * ── WAS HIER ECHT IST ──────────────────────────────────────────────────────
 * Echt: `useChatStore` (der wirkliche Speicher), `extractToolCallsWithRanges`,
 * `stripRanges`, `httpStatusOf`, `errorText`, `estimateTokens`. Die Muster und
 * die Zahlen sind die echten.
 *
 * Der Bildplaner des Live-Anstrichs kommt von aussen. Nicht als Attrappe: die
 * node-Umgebung dieser Testreihe HAT kein `requestAnimationFrame`, und die
 * Regel, um die es geht ("settle loescht ein noch nicht gefeuertes Bild"),
 * laesst sich nur zeigen, wenn man das Feuern in der Hand hat.
 *
 * Run: npx vitest run src/hooks/codex/__tests__/ein-modellzug.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createLivePaint } from '../live-paint'
import { recoverToolCallsFromContent } from '../tool-call-recovery'
import { codexStallVerdict } from '../stall-verdict'
import { isThinkingUnsupportedError } from '../thinking-downgrade'
import { seedEstimatedUsage, reportTurnUsage } from '../turn-usage'
import { useChatStore } from '../../../stores/chatStore'

// ── Der Live-Anstrich ───────────────────────────────────────────────────────

/** Ein echter Planer, dessen Bilder man von Hand feuert. */
function manualFrames() {
  const queued: Array<() => void> = []
  return {
    schedule: (cb: () => void) => { queued.push(cb) },
    fire: () => { const q = queued.splice(0); for (const cb of q) cb() },
    pending: () => queued.length,
  }
}

function paintRig(opts: { prefix?: string; suppress?: (c: string) => boolean } = {}) {
  const painted: string[] = []
  const frames = manualFrames()
  const lp = createLivePaint({
    suppress: opts.suppress ?? (() => false),
    prefix: () => opts.prefix ?? '',
    paint: (t) => painted.push(t),
    schedule: frames.schedule,
  })
  return { lp, painted, frames }
}

describe('Der Live-Anstrich: ein Puffer, ein Bild pro Runde', () => {
  it('malt gar nichts, solange das Bild nicht gefeuert hat', () => {
    const { lp, painted } = paintRig()
    lp.feed('abc')
    expect(painted).toEqual([])
  })

  it('fasst mehrere Einspeisungen zu EINEM Schreibvorgang zusammen, mit dem LETZTEN Text', () => {
    const { lp, painted, frames } = paintRig()
    lp.feed('a'); lp.feed('ab'); lp.feed('abc')
    expect(frames.pending()).toBe(1)
    frames.fire()
    expect(painted).toEqual(['abc'])
  })

  it('settle() verhindert das Nachmalen — das ist Pruefung D1', () => {
    const { lp, painted, frames } = paintRig()
    lp.feed('alter zwischenstand')
    lp.settle()
    frames.fire()
    // Ohne settle stuende hier der alte Zwischenstand, GESCHRIEBEN NACH dem
    // fertigen Text, den der Transport direkt gesetzt hat.
    expect(painted).toEqual([])
  })

  it('setzt den Vorspann dieses Zuges davor, mit Leerzeile', () => {
    const { lp, painted, frames } = paintRig({ prefix: 'FRUEHER' })
    lp.feed('jetzt')
    frames.fire()
    expect(painted).toEqual(['FRUEHER\n\njetzt'])
  })

  it('unterdrueckter Text landet nicht einmal im Puffer', () => {
    const { lp, painted, frames } = paintRig({ suppress: (c) => c.startsWith('Hello, I am the Coding Agent') })
    lp.feed('Hello, I am the Coding Agent, an autonomous coding agent')
    expect(frames.pending()).toBe(0)
    frames.fire()
    expect(painted).toEqual([])
  })

  it('nach einem gefeuerten Bild wird das naechste wieder geplant', () => {
    const { lp, painted, frames } = paintRig()
    lp.feed('eins'); frames.fire()
    lp.feed('zwei'); frames.fire()
    expect(painted).toEqual(['eins', 'zwei'])
  })
})

// ── Aufrufe im Fliesstext ───────────────────────────────────────────────────

describe('Werkzeugaufrufe, die das Modell in seinen Text geschrieben hat', () => {
  const fenced = '```json\n{"name": "file_read", "arguments": {"path": "a.ts"}}\n```'

  it('holt den Aufruf aus dem Text, wenn die native Liste leer ist', () => {
    const r = recoverToolCallsFromContent([], fenced)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].function.name).toBe('file_read')
    expect(r.toolCalls[0].function.arguments).toEqual({ path: 'a.ts' })
    expect(r.extractedFromContent).toBe(true)
  })

  it('BEHAELT die Prosa um den Aufruf herum — das ist die Regel, die man kaputtmacht', () => {
    const r = recoverToolCallsFromContent([], `Ich schaue mir die Datei an.\n${fenced}\nDanach geht es weiter.`)
    expect(r.content).toContain('Ich schaue mir die Datei an.')
    expect(r.content).toContain('Danach geht es weiter.')
    expect(r.content).not.toContain('file_read')
  })

  it('leert den Text nur, wenn nach dem Schnitt nichts als Satzzeichen bleibt', () => {
    const r = recoverToolCallsFromContent([], `${fenced}\n.\n`)
    expect(r.content).toBe('')
  })

  it('schneidet das JSON auch dann heraus, wenn die native Liste schon voll ist', () => {
    const nativ = [{ function: { name: 'file_read', arguments: { path: 'a.ts' } } }]
    const r = recoverToolCallsFromContent(nativ, `Lese jetzt.\n${fenced}`)
    // Die nativen Aufrufe bleiben unangetastet, nur die Blase wird lesbar.
    expect(r.toolCalls).toBe(nativ)
    expect(r.content).toContain('Lese jetzt.')
    expect(r.content).not.toContain('"file_read"')
  })

  it('laesst einen Zug ohne JSON voellig unveraendert', () => {
    const calls = [{ function: { name: 'x', arguments: {} } }]
    const r = recoverToolCallsFromContent(calls, 'Fertig, alle Tests laufen.')
    expect(r.content).toBe('Fertig, alle Tests laufen.')
    expect(r.toolCalls).toBe(calls)
    expect(r.extractedFromContent).toBe(false)
  })
})

// ── Steckengeblieben oder fertig ────────────────────────────────────────────

describe('Ein Zug ohne Werkzeugaufruf', () => {
  const nudge = (t: string, full = '') => codexStallVerdict(t, full).nudgeWorthy

  it('stupst, wenn das Modell den naechsten Schritt ERZAEHLT', () => {
    expect(nudge("I'm about to read the source file.")).toBe(true)
    expect(nudge('Let me check the config first.')).toBe(true)
    expect(nudge("Next, I will open package.json.")).toBe(true)
    expect(nudge('I need to read the test file.')).toBe(true)
  })

  it('stupst, wenn das Modell nach etwas fragt, das es selbst finden koennte', () => {
    // Der Live-Fund vom 2026-06-02 mit qwen2.5-coder:7b, woertlich.
    expect(nudge('it seems there is an issue with the file path … could you please verify the correct path to sum.js?')).toBe(true)
    expect(nudge('please provide the path')).toBe(true)
    expect(nudge('Which file should I look at?')).toBe(true)
  })

  it('stupst NICHT bei einer echten Antwort — das war die Schleife von David', () => {
    expect(nudge('2+2 is 4.')).toBe(false)
    expect(nudge('Task completed. The answer is 4.')).toBe(false)
    expect(nudge('The bug was a missing await in loadUser(); I added it and the suite passes.')).toBe(false)
  })

  it('stupst NICHT bei "please verify the changes" — nur Pfad/Datei zaehlt', () => {
    expect(nudge('I fixed it, please verify the changes.')).toBe(false)
    expect(nudge('Please verify the correct path to the config.')).toBe(true)
  })

  it('ein leerer Zug stupst nur, wenn noch NICHTS geliefert wurde', () => {
    expect(nudge('', '')).toBe(true)
    // Leer NACH einer echten Antwort heisst fertig, sonst bleiben die
    // Schreibpunkte stehen (David 2026-06-12).
    expect(nudge('', 'Die Antwort steht oben.')).toBe(false)
    expect(nudge('   \n  ', 'Die Antwort steht oben.')).toBe(false)
  })
})

// ── Der Denk-Abstieg ────────────────────────────────────────────────────────

describe('"Dieses Modell kann nicht denken"', () => {
  it('erkennt die 400 auf BEIDEN Feldern, die die Transporte benutzen', () => {
    expect(isThinkingUnsupportedError(Object.assign(new Error('bad request'), { status: 400 }))).toBe(true)
    expect(isThinkingUnsupportedError(Object.assign(new Error('bad request'), { statusCode: 400 }))).toBe(true)
  })

  it('erkennt den Satz auch ohne Statusfeld', () => {
    expect(isThinkingUnsupportedError(new Error('model xyz does not support thinking'))).toBe(true)
  })

  it('steigt bei einem anderen Fehler NICHT ab', () => {
    expect(isThinkingUnsupportedError(Object.assign(new Error('nope'), { status: 500 }))).toBe(false)
    expect(isThinkingUnsupportedError(new Error('Failed to fetch'))).toBe(false)
  })

  it('ueberlebt einen geworfenen Nicht-Fehler statt selbst zu werfen', () => {
    // Das ist der Grund, warum die Frage ueber die Grenzwaechter laeuft und
    // nicht ueber `(e as Error).message`.
    expect(() => isThinkingUnsupportedError(null)).not.toThrow()
    expect(isThinkingUnsupportedError(null)).toBe(false)
    expect(isThinkingUnsupportedError('does not support thinking')).toBe(true)
  })
})

// ── Die Verbrauchsanzeige ───────────────────────────────────────────────────

describe('Das Feld usage: eine Schaetzung ueberschreibt nie eine echte Zahl', () => {
  let convId = ''
  const MSG = 'msg-usage'
  const usage = () =>
    useChatStore.getState().conversations.find((c) => c.id === convId)
      ?.messages.find((m) => m.id === MSG)?.usage

  beforeEach(() => {
    useChatStore.setState({ conversations: [], activeConversationId: null })
    convId = useChatStore.getState().createConversation('m', '', 'codex')
    useChatStore.getState().addMessage(convId, {
      id: MSG, role: 'assistant', content: '', timestamp: Date.now(),
    })
  })

  it('setzt die Schaetzung, solange nichts dasteht', () => {
    seedEstimatedUsage(convId, MSG, [{ role: 'user', content: 'hallo welt' }], [])
    expect(usage()?.estimated).toBe(true)
    expect(usage()?.promptTokens).toBeGreaterThan(0)
  })

  it('die echte Zahl des Modells setzt estimated auf false', () => {
    seedEstimatedUsage(convId, MSG, [{ role: 'user', content: 'hallo' }], [])
    reportTurnUsage(convId, MSG, { promptEvalCount: 1234, evalCount: 56 })
    expect(usage()).toMatchObject({ promptTokens: 1234, completionTokens: 56, totalTokens: 1290, estimated: false })
  })

  it('eine spaetere Schaetzung ruehrt die echte Zahl NICHT an', () => {
    reportTurnUsage(convId, MSG, { promptEvalCount: 1234, evalCount: 56 })
    seedEstimatedUsage(convId, MSG, [{ role: 'user', content: 'x'.repeat(10000) }], [])
    expect(usage()?.promptTokens).toBe(1234)
    expect(usage()?.estimated).toBe(false)
  })

  it('ein Zug ohne Zahlen schreibt gar nichts', () => {
    seedEstimatedUsage(convId, MSG, [{ role: 'user', content: 'hallo' }], [])
    const before = usage()
    reportTurnUsage(convId, MSG, {})
    expect(usage()).toEqual(before)
  })

  it('der Werkzeugkatalog zaehlt mit — er steht mit auf der Rechnung des Anbieters', () => {
    const nurNachrichten = (() => {
      seedEstimatedUsage(convId, MSG, [{ role: 'user', content: 'hallo' }], [])
      return usage()!.promptTokens
    })()
    useChatStore.getState().updateMessageUsage(convId, MSG, {
      promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: true,
    })
    seedEstimatedUsage(convId, MSG, [{ role: 'user', content: 'hallo' }], [
      { type: 'function', function: { name: 'file_read', description: 'Read a file from disk', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    ])
    expect(usage()!.promptTokens).toBeGreaterThan(nurNachrichten)
  })
})
