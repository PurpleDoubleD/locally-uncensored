/**
 * Die Vordergrundzeile und was sie kostet.
 *
 * Zwei Vorbereitungen fuer die Bauauftraege danach, und beide haben eine
 * Falle, die man erst sieht, wenn man sie sucht:
 *
 *  1. VORDERGRUNDZEILEN. Eine Delegation, auf die der Elternzug wartet, bekam
 *     bisher gar keine Zeile. Sobald sie eine bekommt, laeuft sie durch zwei
 *     Sperrklinken, die beide auf `reported` gebaut sind, und dieser Merker
 *     wird bei ihr NIE gesetzt, weil ihre Antwort den direkten Weg nimmt. Am
 *     rohen Merker gemessen verdraengt sie ungelesene Hintergrundantworten
 *     aus dem Ring und meldet sich dem Modell ein zweites Mal.
 *
 *  2. TOKENS. Die Zahlen liegen vor (`promptEvalCount`/`evalCount`), fehlen
 *     aber bei jedem Anbieter ohne `usage` und beim Hermes-XML-Transport.
 *     Eine Schaetzung ist erlaubt und muss sich als solche zu erkennen geben,
 *     auch nachdem sie mit gemessenen Zahlen zusammengezaehlt wurde.
 *
 * Lauf: npx vitest run src/lib/__tests__/vordergrundzeile-und-tokens.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'

import {
  addTaskTokens,
  applyTaskRing,
  describeTaskTokens,
  formatTaskTokens,
  sumTaskTokens,
  taskAnswerDelivered,
  taskTokenTotal,
  tokensFromTurn,
  NO_TASK_TOKENS,
  type AgentTask,
  type TaskTokens,
} from '../agent-tasks'
import { estimateTokens } from '../context-compaction'
import { useAgentTaskStore, _controllerCount } from '../../stores/agentTaskStore'

const S = () => useAgentTaskStore.getState()

function aufgabe(id: string, extra: Partial<AgentTask> = {}): AgentTask {
  return {
    id, convId: 'c1', goal: `Ziel ${id}`, context: '',
    status: 'done', background: true, startedAt: 1_000, endedAt: 2_000,
    toolCalls: 0, iterations: 0, inbox: [], reported: false,
    ...extra,
  }
}

beforeEach(() => {
  for (const convId of Object.keys(S().byConv)) S().clearConv(convId)
  useAgentTaskStore.setState({ byConv: {} })
  expect(_controllerCount()).toBe(0)
})

// ── 1) Die Vordergrundzeile ────────────────────────────────────────────────

describe('eine Vordergrundzeile gilt als zugestellt, ohne je gemeldet zu sein', () => {
  it('ihr Ergebnis war der Rueckgabewert, der Merker bleibt trotzdem false', () => {
    const vordergrund = aufgabe('v', { background: false, reported: false })
    expect(vordergrund.reported).toBe(false)
    expect(taskAnswerDelivered(vordergrund)).toBe(true)
  })

  it('eine Hintergrundzeile dagegen erst, wenn sie wirklich gemeldet wurde', () => {
    expect(taskAnswerDelivered(aufgabe('h', { background: true, reported: false }))).toBe(false)
    expect(taskAnswerDelivered(aufgabe('h', { background: true, reported: true }))).toBe(true)
  })
})

describe('SPERRKLINKE 1: der Ring', () => {
  it('opfert die Vordergrundzeile VOR der ungelesenen Hintergrundantwort', () => {
    // Der teure Fall in vier Zeilen: die Vordergrundzeile ist schon
    // abgeliefert, die Hintergrundantwort hat noch nie jemand gesehen. Am
    // rohen `reported` gemessen sehen beide gleich aus, und der Ring wuerfe
    // die falsche weg, naemlich die Arbeit eines Agenten, von der niemand je
    // erfaehrt.
    // Die ungelesene steht ZUERST, und das ist kein Zufall: Rang 2 raeumt in
    // Listenreihenfolge. Stuende die Vordergrundzeile vorn, fiele sie auch
    // ohne die Regel als erste heraus, und der Waechter waere still gruen:
    // er maesse die Reihenfolge der Liste statt der Rangfolge.
    const tasks = [
      aufgabe('ungelesen', { background: true, reported: false }),
      aufgabe('vordergrund', { background: false }),
    ]
    const rest = applyTaskRing(tasks, 1)
    expect(rest.map((t) => t.id)).toEqual(['ungelesen'])
  })

  it('und eine gemeldete Hintergrundzeile steht mit ihr im selben Rang', () => {
    const tasks = [
      aufgabe('ungelesen', { background: true, reported: false }),
      aufgabe('gemeldet', { background: true, reported: true }),
      aufgabe('vordergrund', { background: false }),
    ]
    expect(applyTaskRing(tasks, 1).map((t) => t.id)).toEqual(['ungelesen'])
  })

  it('GEGENPROBE: laufende Vordergrundzeilen fallen nie heraus', () => {
    // Sie wegzuwerfen hiesse, ihren Abbrechen-Knopf wegzuwerfen, waehrend der
    // Elternzug noch auf sie wartet.
    const tasks = [
      aufgabe('laeuft-1', { background: false, status: 'running', endedAt: undefined }),
      aufgabe('laeuft-2', { background: false, status: 'running', endedAt: undefined }),
    ]
    expect(applyTaskRing(tasks, 1).map((t) => t.id)).toEqual(['laeuft-1', 'laeuft-2'])
  })
})

describe('SPERRKLINKE 2: die Meldung an das Modell', () => {
  it('takeUnreported holt die Vordergrundzeile NICHT', () => {
    // Sonst laese das Modell dieselbe Antwort zweimal: einmal als Ergebnis
    // seines eigenen Werkzeugaufrufs, einmal als [background-task].
    S().start({ id: 'v', convId: 'c1', goal: 'Z', context: '', background: false, startedAt: 1, controller: new AbortController() })
    S().finish('v', { status: 'done', output: 'die Antwort', endedAt: 2 })

    expect(S().forConv('c1').map((t) => t.id)).toEqual(['v'])
    expect(S().takeUnreported('c1')).toEqual([])
  })

  it('GEGENPROBE: die Hintergrundzeile daneben wird sehr wohl gemeldet', () => {
    S().start({ id: 'v', convId: 'c1', goal: 'Z', context: '', background: false, startedAt: 1, controller: new AbortController() })
    S().start({ id: 'h', convId: 'c1', goal: 'Z', context: '', background: true, startedAt: 1, controller: new AbortController() })
    S().finish('v', { status: 'done', output: 'vorne', endedAt: 2 })
    S().finish('h', { status: 'done', output: 'hinten', endedAt: 2 })

    expect(S().takeUnreported('c1').map((t) => t.id)).toEqual(['h'])
    // Und die Einbahnstrasse gilt weiter.
    expect(S().takeUnreported('c1')).toEqual([])
  })
})

describe('SPERRKLINKE 3: die Controller-Karte sinkt wieder', () => {
  it('eine Vordergrundzeile gibt ihren Abbruchgriff beim Beenden zurueck', () => {
    // `_controllerCount` ist Modulzustand neben dem Store. Wer eine Zeile
    // anlegt, ohne sie ueber `finish` zu beenden, laesst einen Griff liegen,
    // den nie wieder jemand aufraeumt, denn der Ring entfernt nur die Zeile.
    S().start({ id: 'v', convId: 'c1', goal: 'Z', context: '', background: false, startedAt: 1, controller: new AbortController() })
    expect(_controllerCount()).toBe(1)
    S().finish('v', { status: 'done', output: 'x', endedAt: 2 })
    expect(_controllerCount()).toBe(0)
  })

  it('auch wenn der Ring die Zeile im selben Zug hinauswirft', () => {
    // Der Ring greift bei `finish` mit zu. Die Zeile verschwindet, der Griff
    // muss trotzdem weg sein, und er ist es, weil `finish` ihn vor dem
    // Schreiben loescht und nicht danach.
    for (let i = 0; i < 3; i++) {
      S().start({ id: `v${i}`, convId: 'c1', goal: 'Z', context: '', background: false, startedAt: 1, controller: new AbortController() })
    }
    for (let i = 0; i < 3; i++) S().finish(`v${i}`, { status: 'done', output: 'x', endedAt: 2 })
    useAgentTaskStore.setState((s) => ({
      byConv: { ...s.byConv, c1: applyTaskRing(s.byConv.c1, 1) },
    }))
    expect(S().forConv('c1')).toHaveLength(1)
    expect(_controllerCount()).toBe(0)
  })

  it('ein geloeschter Chat nimmt seine Vordergrundagenten mit', () => {
    const griff = new AbortController()
    S().start({ id: 'v', convId: 'c1', goal: 'Z', context: '', background: false, startedAt: 1, controller: griff })
    expect(griff.signal.aborted).toBe(false)
    S().clearConv('c1')
    expect(griff.signal.aborted).toBe(true)
    expect(_controllerCount()).toBe(0)
  })
})

// ── 2) Tokens ──────────────────────────────────────────────────────────────

const echt: TaskTokens = { prompt: 1000, completion: 200, estimated: false }
const geraten: TaskTokens = { prompt: 40, completion: 10, estimated: true }

describe('summieren, und die Schaetzung steckt an', () => {
  it('zwei gemessene Staende bleiben gemessen', () => {
    expect(addTaskTokens(echt, echt)).toEqual({ prompt: 2000, completion: 400, estimated: false })
  })

  it('EINE geratene Haelfte macht die ganze Summe zu einer Schaetzung', () => {
    // Die Regel, die man leicht falsch baut. Ohne sie verliert ein Lauf seine
    // Tilde beim ersten Zug mit echten Zahlen und behauptet danach
    // Genauigkeit fuer neunzehn geratene.
    const summe = addTaskTokens(echt, geraten)
    expect(summe).toEqual({ prompt: 1040, completion: 210, estimated: true })
    // Und in der anderen Reihenfolge genauso, sonst haenge das Urteil daran,
    // welcher Zug zufaellig zuerst kam.
    expect(addTaskTokens(geraten, echt).estimated).toBe(true)
  })

  it('ein fehlender Stand aendert nichts', () => {
    expect(addTaskTokens(undefined, echt)).toEqual(echt)
    expect(addTaskTokens(echt, undefined)).toEqual(echt)
    expect(addTaskTokens(undefined, undefined)).toEqual(NO_TASK_TOKENS)
  })

  it('sumTaskTokens zaehlt ueber Aufgaben und erbt die Ansteckung', () => {
    expect(sumTaskTokens([{ tokens: echt }, { tokens: echt }])).toEqual({ prompt: 2000, completion: 400, estimated: false })
    expect(sumTaskTokens([{ tokens: echt }, { tokens: geraten }]).estimated).toBe(true)
    expect(sumTaskTokens([{ tokens: undefined }, {}])).toEqual(NO_TASK_TOKENS)
    expect(sumTaskTokens([])).toEqual(NO_TASK_TOKENS)
  })

  it('taskTokenTotal rechnet die Summe aus, statt sie mitzufuehren', () => {
    expect(taskTokenTotal(echt)).toBe(1200)
    expect(taskTokenTotal(undefined)).toBe(0)
  })
})

describe('die Zahlen eines Zuges: gemessen wo moeglich, sonst geraten', () => {
  const texte = { prompt: 'x'.repeat(400), completion: 'y'.repeat(80) }

  it('beide gemeldet: gemessen, und die Texte werden gar nicht angefasst', () => {
    const t = tokensFromTurn({ promptEvalCount: 1234, evalCount: 56 }, texte, () => {
      throw new Error('darf nicht geschaetzt werden')
    })
    expect(t).toEqual({ prompt: 1234, completion: 56, estimated: false })
  })

  it('keiner gemeldet: Hausschaetzung, und die Zeile sagt es', () => {
    // Die Hausschaetzung ist `ceil(Zeichen/4)+1` (context-compaction.ts:22),
    // nicht das blosse Zeichen/4, das man erwartet. Sie kommt als Argument
    // herein, damit es im Haus genau eine gibt.
    const t = tokensFromTurn({}, texte, estimateTokens)
    expect(t).toEqual({ prompt: 101, completion: 21, estimated: true })
  })

  it('NUR EINE Haelfte gemeldet: die andere geraten, die Zeile bleibt geschaetzt', () => {
    // Der Hermes-XML-Transport meldet gerne die eine und nicht die andere.
    // Eine halb gemessene Zeile als Messung auszugeben waere die teuerste
    // Variante: sie sieht genau wie eine echte aus.
    const t = tokensFromTurn({ promptEvalCount: 900 }, texte, estimateTokens)
    expect(t).toEqual({ prompt: 900, completion: 21, estimated: true })
  })

  it('eine gemeldete 0 gilt als nicht gemeldet, wie bei reportTurnUsage', () => {
    const t = tokensFromTurn({ promptEvalCount: 0, evalCount: 0 }, texte, estimateTokens)
    expect(t.estimated).toBe(true)
    expect(t.prompt).toBe(101)
  })
})

describe('die Anzeige gibt die Schaetzung zu', () => {
  it('Tilde bei geraten, nackte Zahl bei gemessen', () => {
    // Die Tilde ist die Hauskonvention fuer eine geratene Zahl in einer engen
    // Zeile (formatters.ts:23). TokenCounter.tsx traegt sie nicht, weil dort
    // ein Balken danebensteht und das Wort in den Tooltip passt.
    expect(formatTaskTokens({ prompt: 1000, completion: 200, estimated: false })).toBe('1.2k tok')
    expect(formatTaskTokens({ prompt: 1000, completion: 200, estimated: true })).toBe('~1.2k tok')
    expect(formatTaskTokens({ prompt: 40, completion: 10, estimated: true })).toBe('~50 tok')
  })

  it('nichts gezaehlt heisst nichts anzeigen, keine Null', () => {
    expect(formatTaskTokens(undefined)).toBe('')
    expect(formatTaskTokens(NO_TASK_TOKENS)).toBe('')
    expect(describeTaskTokens(undefined)).toBe('')
  })

  it('der Tooltip benennt die Schaetzung im Wort und trennt die Haelften', () => {
    expect(describeTaskTokens({ prompt: 1000, completion: 200, estimated: true })).toContain('Estimated')
    expect(describeTaskTokens({ prompt: 1000, completion: 200, estimated: false })).not.toContain('Estimated')
    const text = describeTaskTokens({ prompt: 1000, completion: 200, estimated: false })
    expect(text).toContain('1,000 in')
    expect(text).toContain('200 out')
    // Der Satz, der die Verwechslung mit dem Fuellstand verhindert.
    expect(text).toContain('summed over every step')
  })
})

describe('das Feld haengt an der Aufgabe', () => {
  it('eine Aufgabe ohne gezaehlte Tokens ist gueltig, das Feld ist optional', () => {
    // Absicht: ein Pflichtfeld verlangte sofort eine Aenderung an jeder
    // Aufrufstelle in sub-agent.ts, und die soll unabhaengig aenderbar
    // bleiben.
    const ohne = aufgabe('a')
    expect(ohne.tokens).toBeUndefined()
    expect(formatTaskTokens(ohne.tokens)).toBe('')
  })

  it('und der Store traegt sie durch update herein', () => {
    S().start({ id: 'a', convId: 'c1', goal: 'Z', context: '', background: false, startedAt: 1, controller: new AbortController() })
    S().update('a', { tokens: echt })
    expect(S().get('a')?.tokens).toEqual(echt)
    S().update('a', { tokens: addTaskTokens(S().get('a')?.tokens, geraten) })
    expect(S().get('a')?.tokens).toEqual({ prompt: 1040, completion: 210, estimated: true })
    S().finish('a', { status: 'done', output: 'x', endedAt: 2 })
    expect(S().get('a')?.tokens?.estimated).toBe(true)
  })
})
