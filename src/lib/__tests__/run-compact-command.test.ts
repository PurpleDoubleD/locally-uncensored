/**
 * Sperrklinken fuer den einen Kompaktier-Lauf (2.6.8, Compact-Schritt 4).
 *
 * Drei Aufrufstellen teilen sich diese Funktion — Chat, Agenten-Schleife,
 * Coding-Schleife. Was hier still kaputtgeht, geht in allen dreien kaputt, und
 * zwar unsichtbar: eine Kompaktierung entfernt nichts, sie legt einen Datensatz
 * an. Ein falscher Schnitt faellt daher nicht als Fehler auf, sondern erst
 * Wochen spaeter daran, dass ein langer Lauf vergessen hat, was er getan hat.
 *
 * Der Zusammenfasser (compact-run) ist der EINZIGE Ersatz hier: er ist der
 * Modellaufruf. Speicher und Auswertung laufen echt.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../compact-run', () => ({
  runCompactSummary: vi.fn(),
}))

import {
  runCompactForConversation,
  newestCompaction,
  compactOutcomeMessage,
  KEEP_AFTER_COMPACT,
  type CompactOutcome,
} from '../run-compact-command'
import { runCompactSummary } from '../compact-run'
import { useChatStore } from '../../stores/chatStore'
import { COMPACT_OPEN, COMPACT_CLOSE, type CompactSummary, type TranscriptTurn } from '../compact-summary'
import type { CompactionRecord, Conversation, Message, Role } from '../../types/chat'

const zusammenfasser = runCompactSummary as unknown as ReturnType<typeof vi.fn>

const SUMME: CompactSummary = {
  task: 'Den Login reparieren.',
  requests: '', progress: 'auth.ts gelesen, Nullwert in Zeile 40 gefunden.',
  decisions: 'Kein Refactoring — der Rest ist getestet.',
  facts: 'src/auth.ts:40, verifyToken.',
  open: 'Der Test fehlt.',
  rest: '',
}

const CHAT_ID = 'conv-1'

const nachricht = (id: string, content: string, role: Role = 'user'): Message => ({
  id,
  role,
  content,
  timestamp: 1,
})

/** N sichtbare Nachrichten, m0 … m(N-1), abwechselnd Nutzer und Modell. */
const verlauf = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) =>
    nachricht(`m${i}`, `Zug ${i}: Inhalt`, i % 2 ? 'assistant' : 'user'),
  )

function chatMit(messages: Message[], compactions?: CompactionRecord[]): string {
  const conv: Conversation = {
    id: CHAT_ID,
    title: 'Test',
    messages,
    model: 'qwen:4b',
    systemPrompt: '',
    compactions,
    createdAt: 1,
    updatedAt: 1,
  }
  useChatStore.setState({ conversations: [conv] })
  return CHAT_ID
}

const datensatz = (upToMessageId: string): CompactionRecord => ({
  id: 'rec-alt',
  summary: 'alt',
  upToMessageId,
  replaced: 1,
  atMessageCount: 1,
  tokensBefore: 100,
  tokensAfter: 10,
  trigger: 'manual',
  at: 1,
})

/** Was der Zusammenfasser tatsaechlich zu sehen bekam. */
function gesehene(): TranscriptTurn[] {
  expect(zusammenfasser).toHaveBeenCalledTimes(1)
  return zusammenfasser.mock.calls[0][0].turns as TranscriptTurn[]
}

const lauf = (extra: Record<string, unknown> = {}) =>
  runCompactForConversation({
    conversationId: CHAT_ID,
    activeModel: 'qwen:4b',
    trigger: 'manual',
    ...extra,
  })

beforeEach(() => {
  zusammenfasser.mockReset()
  zusammenfasser.mockResolvedValue({ ok: true, summary: SUMME, reason: 'ok' })
  useChatStore.setState({ conversations: [] })
})

describe('runCompactForConversation — die Ausgaenge vor dem Modellaufruf', () => {
  it('ohne aktives Modell: no-model', async () => {
    chatMit(verlauf(20))
    const r = await lauf({ activeModel: null })
    expect(r).toEqual({ ok: false, reason: 'no-model' })
    expect(zusammenfasser).not.toHaveBeenCalled()
  })

  // Die Reihenfolge ist Absicht, nicht Zufall: das Fenster aufzuloesen fragt
  // das Modell. Wandert die Modellpruefung hinter den Speicherzugriff, zahlt
  // jeder Aufruf ohne Modell trotzdem den Weg dorthin — dieselbe Regel, die
  // maybeAutoCompact im Kopf ausdruecklich festhaelt.
  it('ohne aktives Modell wird der Chat-Speicher gar nicht erst gelesen', async () => {
    chatMit(verlauf(20))
    const spion = vi.spyOn(useChatStore, 'getState')
    try {
      const r = await lauf({ activeModel: null })
      expect(r.ok).toBe(false)
      expect(spion).not.toHaveBeenCalled()
    } finally {
      spion.mockRestore()
    }
  })

  it('unbekannte Chat-Id: no-conversation', async () => {
    chatMit(verlauf(20))
    const r = await runCompactForConversation({
      conversationId: 'gibt-es-nicht',
      activeModel: 'qwen:4b',
      trigger: 'manual',
    })
    expect(r).toEqual({ ok: false, reason: 'no-conversation' })
    expect(zusammenfasser).not.toHaveBeenCalled()
  })

  it('zu kurzer Chat: nothing-to-compact', async () => {
    chatMit(verlauf(KEEP_AFTER_COMPACT))
    const r = await lauf()
    expect(r).toEqual({ ok: false, reason: 'nothing-to-compact' })
    expect(zusammenfasser).not.toHaveBeenCalled()
  })

  // Systemzeilen sind App-Hinweise; kein Modell hat sie je gesehen. Zaehlten
  // sie mit, liefe eine Kompaktierung auf einem Chat an, der aus Modellsicht
  // noch aus sechs Zuegen besteht — und fasste Text zusammen, den niemand las.
  it('Systemhinweise zaehlen nicht als Material', async () => {
    chatMit([
      ...verlauf(KEEP_AFTER_COMPACT),
      nachricht('sys-1', 'Modell gewechselt', 'system'),
      nachricht('leer', '   '),
    ])
    const r = await lauf()
    expect(r).toEqual({ ok: false, reason: 'nothing-to-compact' })
  })
})

describe('KEEP_AFTER_COMPACT — die juengsten Zuege bleiben woertlich', () => {
  // Ohne diese Grenze verliert ein "mach das nochmal, aber kleiner" das "das".
  // Der Schnitt darf nie an die juengsten sechs sichtbaren Nachrichten heran.
  it('die letzten sechs sichtbaren Nachrichten gehen nie in die Zusammenfassung', async () => {
    chatMit(verlauf(20))
    const r = await lauf()
    expect(r.ok).toBe(true)

    const turns = gesehene()
    expect(turns).toHaveLength(20 - KEEP_AFTER_COMPACT)
    const text = turns.map((t) => t.content).join('\n')
    for (let i = 20 - KEEP_AFTER_COMPACT; i < 20; i++) {
      expect(text).not.toContain(`Zug ${i}:`)
    }
    expect(text).toContain('Zug 0:')
    expect(text).toContain(`Zug ${20 - KEEP_AFTER_COMPACT - 1}:`)
  })

  it('der Anker ist die letzte zusammengefasste Nachricht, nicht die letzte des Chats', async () => {
    chatMit(verlauf(20))
    const r = await lauf()
    expect(r.ok && r.record.upToMessageId).toBe(`m${20 - KEEP_AFTER_COMPACT - 1}`)
    expect(r.ok && r.record.replaced).toBe(20 - KEEP_AFTER_COMPACT)
  })

  it('eine Nachricht mehr als die Sperre reicht fuer genau einen Zug', async () => {
    chatMit(verlauf(KEEP_AFTER_COMPACT + 1))
    const r = await lauf()
    expect(r.ok).toBe(true)
    expect(gesehene()).toHaveLength(1)
  })

  it('der Datensatz landet im Speicher', async () => {
    chatMit(verlauf(20))
    const r = await lauf()
    expect(r.ok).toBe(true)
    const gespeichert = useChatStore.getState().conversations[0].compactions
    expect(gespeichert).toHaveLength(1)
    expect(gespeichert![0].summary).toContain(COMPACT_OPEN)
    expect(gespeichert![0].trigger).toBe('manual')
  })
})

describe('Wiederholtes Zusammenfassen', () => {
  // Der Kern des ganzen Features. Faengt der neue Schnitt vor dem Anker des
  // alten Datensatzes an, wandert Material, das eine Zusammenfassung schon
  // abdeckt, ein zweites Mal durch das Modell — Zusammenfassung einer
  // Zusammenfassung, und genau so vergisst ein langer Lauf seinen Anfang.
  it('der neue Schnitt beginnt HINTER dem Anker des letzten Datensatzes', async () => {
    chatMit(verlauf(20), [datensatz('m5')])
    const r = await lauf()
    expect(r.ok).toBe(true)

    const turns = gesehene()
    expect(turns).toHaveLength(20 - KEEP_AFTER_COMPACT - 6)
    const text = turns.map((t) => t.content).join('\n')
    for (let i = 0; i <= 5; i++) expect(text).not.toContain(`Zug ${i}:`)
    expect(text).toContain('Zug 6:')
    expect(text).toContain('Zug 13:')
    expect(r.ok && r.record.upToMessageId).toBe('m13')
  })

  // Nur der NEUESTE Datensatz formt die Nutzlast; ein aelterer darf den
  // Schnitt nicht nach vorne ziehen und schon abgedecktes Material zurueckholen.
  it('massgeblich ist der letzte Datensatz, nicht der erste', async () => {
    chatMit(verlauf(20), [datensatz('m1'), datensatz('m9')])
    const r = await lauf()
    expect(r.ok).toBe(true)
    const text = gesehene().map((t) => t.content).join('\n')
    expect(text).not.toContain('Zug 9:')
    expect(text).toContain('Zug 10:')
  })

  it('steht der alte Anker schon auf dem Schnitt: nothing-to-compact', async () => {
    chatMit(verlauf(20), [datensatz(`m${20 - KEEP_AFTER_COMPACT - 1}`)])
    const r = await lauf()
    // `detail` unterscheidet die beiden Wege in denselben Grund: hier ist der
    // Chat NICHT zu kurz, sondern schon verdichtet. Dem Nutzer zu sagen, er
    // sei „still short enough to send whole", waehrend darueber eine
    // Verdichtungslinie steht, war schlicht falsch (2.6.8).
    expect(r).toEqual({ ok: false, reason: 'nothing-to-compact', detail: 'already-compacted' })
    expect(zusammenfasser).not.toHaveBeenCalled()
  })

  it('steht der alte Anker hinter dem Schnitt: nothing-to-compact', async () => {
    chatMit(verlauf(20), [datensatz('m17')])
    const r = await lauf()
    expect(r).toEqual({ ok: false, reason: 'nothing-to-compact', detail: 'already-compacted' })
    expect(zusammenfasser).not.toHaveBeenCalled()
  })

  // Ein Anker, dessen Nachricht geloescht wurde, findet sich nicht mehr.
  // Dann ist der ganze Verlauf wieder Material — lieber doppelt zusammenfassen
  // als den Lauf mit einem stillen "nichts zu tun" haengen lassen.
  it('ein verwaister Anker faellt auf den vollen Verlauf zurueck', async () => {
    chatMit(verlauf(20), [datensatz('weg')])
    const r = await lauf()
    expect(r.ok).toBe(true)
    expect(gesehene()).toHaveLength(20 - KEEP_AFTER_COMPACT)
  })
})

describe('Eine gespeicherte Zusammenfassung ist kein Verlauf', () => {
  // Reitet ein alter Block in einer gespeicherten Nachricht mit und wird
  // ungefiltert weitergereicht, fasst das Modell eine Zusammenfassung
  // zusammen. Was danach uebrig bleibt, wird mit jedem Durchlauf duenner.
  it('ein alter Block wird aus dem Zug entfernt, der Rest der Nachricht bleibt', async () => {
    const mitBlock = nachricht(
      'm0',
      `${COMPACT_OPEN}\nTASK\nEtwas ganz Altes${COMPACT_CLOSE}\nZug 0: Inhalt`,
    )
    chatMit([mitBlock, ...verlauf(19).slice(1)])
    const r = await lauf()
    expect(r.ok).toBe(true)

    const turns = gesehene()
    expect(turns[0].content).toBe('Zug 0: Inhalt')
    const text = turns.map((t) => t.content).join('\n')
    expect(text).not.toContain(COMPACT_OPEN)
    expect(text).not.toContain('Etwas ganz Altes')
  })
})

describe('newestCompaction', () => {
  it('ohne Datensaetze: undefined', () => {
    expect(newestCompaction(undefined)).toBeUndefined()
    expect(newestCompaction([])).toBeUndefined()
  })

  // Nur der letzte formt die Nutzlast — jeder aeltere deckt bereits alles vor
  // seinem eigenen Schnitt ab, zwei angewandte Datensaetze schickten dasselbe
  // Material doppelt.
  it('liefert den letzten, nicht den ersten', () => {
    const a = datensatz('m1')
    const b = { ...datensatz('m9'), id: 'rec-neu' }
    expect(newestCompaction([a, b])).toBe(b)
  })
})

describe('compactOutcomeMessage', () => {
  const quelle = (datei: string) => readFileSync(join(__dirname, '..', datei), 'utf8')

  /** Die Zeichenketten einer Union, direkt aus dem Quelltext. */
  function unionLiterale(src: string, deklaration: string): string[] {
    const start = src.indexOf(deklaration)
    expect(start).toBeGreaterThan(-1)
    const rest = src.slice(start + deklaration.length)
    const block = rest.split('\n\n')[0]
    return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])
  }

  // Die Liste wird NICHT abgeschrieben: ein neuer Grund, der spaeter ohne
  // eigenen Satz dazukommt, faellt sonst still in den Sammelfall und der
  // Nutzer liest "konnte nicht geschrieben werden", wo etwas anderes stimmt.
  const GRUENDE = [
    ...unionLiterale(quelle('compact-run.ts'), 'export type CompactRunReason ='),
    ...unionLiterale(quelle('run-compact-command.ts'), 'export type CompactOutcome ='),
  ]

  const satzZu = (reason: string) =>
    compactOutcomeMessage({ ok: false, reason } as CompactOutcome)

  it('liest die Gruende wirklich aus dem Quelltext', () => {
    expect(GRUENDE).toEqual(
      expect.arrayContaining([
        'ok', 'no-model', 'empty-input', 'aborted', 'call-failed', 'unusable',
        'no-conversation', 'nothing-to-compact',
      ]),
    )
  })

  it('jeder Grund ergibt einen nicht leeren Satz', () => {
    for (const g of GRUENDE) expect(satzZu(g).trim()).not.toBe('')
  })

  // Der Sammelfall ist genau drei Gruenden zugestanden. Kommt ein vierter
  // hinzu, ist das kein Zufall, sondern ein vergessener Satz — dann faellt
  // diese Pruefung, nicht der Nutzer.
  it('nur die drei bekannten Gruende teilen sich den Sammelsatz', () => {
    const sammel = satzZu('call-failed')
    const geteilt = GRUENDE.filter((g) => satzZu(g) === sammel).sort()
    expect(geteilt).toEqual(['call-failed', 'empty-input', 'ok'])
  })

  it('jeder eigens benannte Grund hat seinen eigenen Satz', () => {
    const sammel = satzZu('call-failed')
    const eigene = GRUENDE.filter((g) => satzZu(g) !== sammel).map(satzZu)
    expect(eigene.length).toBe(GRUENDE.length - 3)
    expect(new Set(eigene).size).toBe(eigene.length)
  })

  it('der Erfolgsfall nennt die Zahl und sagt, dass nichts verloren ist', () => {
    const record = { ...datensatz('m13'), replaced: 14, tokensBefore: 1000, tokensAfter: 120 }
    const satz = compactOutcomeMessage({ ok: true, record })
    expect(satz).toContain('14 earlier messages')
    expect(satz).toContain('880')
    expect(satz).toContain('The full conversation is still here')
  })
})

// ── Die Meldung darf dem Modell nicht anlasten, was Arithmetik war ────────
//
// Gefunden am 02.09.2026 im laufenden Fenster: /compact auf einen Chat mit 633
// zu ersetzenden Zeichen. Erlaubt waren 316, geliefert wurde eine korrekte
// Zusammenfassung ueber zehn Turns — zu lang, also abgelehnt. Der Nutzer las
// "The model did not produce a usable summary". Das Modell hatte sauber
// gearbeitet; zu klein war der Chat.
describe('unusable hat drei Ursachen und nicht eine Meldung', () => {
  const satz = (detail?: string) =>
    compactOutcomeMessage({ ok: false, reason: 'unusable', detail } as CompactOutcome)

  it('not-smaller nennt die Laenge des Chats, nicht das Versagen des Modells', () => {
    expect(satz('not-smaller')).not.toMatch(/model/i)
    expect(satz('not-smaller')).toMatch(/short/i)
  })

  it('die anderen beiden Ursachen liegen beim Modell und sagen das auch', () => {
    for (const d of ['too-short', 'empty']) {
      expect(satz(d)).toMatch(/model/i)
    }
  })

  it('ohne Angabe bleibt es bei der Modell-Meldung, statt zu raten', () => {
    // Ein fehlendes `detail` heisst "unbekannt". Daraus "der Chat war zu kurz"
    // zu machen waere dieselbe Sorte Luege, nur in die andere Richtung.
    expect(satz(undefined)).toMatch(/model/i)
  })

  it('die beiden Meldungen sind wirklich verschieden', () => {
    expect(satz('not-smaller')).not.toBe(satz('too-short'))
  })
})

// ── Derselbe Grund, zwei Bedeutungen ──────────────────────────────────────
describe('nothing-to-compact sagt, WELCHER der beiden Faelle vorliegt', () => {
  it('ein kurzer Chat ohne Vorgeschichte traegt kein detail', async () => {
    chatMit(verlauf(4))
    const r = await lauf()
    expect(r).toEqual({ ok: false, reason: 'nothing-to-compact' })
  })

  it('die beiden Saetze sind verschieden und benennen den richtigen Grund', () => {
    const kurz = compactOutcomeMessage({ ok: false, reason: 'nothing-to-compact' } as CompactOutcome)
    const schon = compactOutcomeMessage(
      { ok: false, reason: 'nothing-to-compact', detail: 'already-compacted' } as CompactOutcome,
    )
    expect(kurz).not.toBe(schon)
    // Der erste darf von der Laenge des Chats sprechen, der zweite nicht:
    // ueber einem schon verdichteten Chat steht eine Linie, und „still short
    // enough to send whole" widerspricht ihr sichtbar.
    expect(kurz).toMatch(/short enough/i)
    expect(schon).not.toMatch(/short enough/i)
    expect(schon).toMatch(/already covered/i)
  })
})
