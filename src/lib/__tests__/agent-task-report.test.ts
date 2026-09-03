/**
 * Wie ein fertiger Hintergrundagent den Hauptagenten erreicht — und wo er das
 * NICHT darf.
 *
 * Zwei Regeln hängen an dieser Datei, und beide kosten echtes Geld, wenn sie
 * brechen:
 *
 *  - DIE FORM. Die Meldung reitet als NUTZER-Material in den Verlauf. Als
 *    `role:'system'` ginge sie nicht: eine Systemnachricht an anderer Stelle
 *    als Index 0 lehnen strenge Jinja-Vorlagen ab ("System message must be at
 *    the beginning") — dieselbe Regel, an der schon die Verdichtungsnotiz
 *    hängt (compaction-system-position.test.ts). Als `role:'tool'` ginge sie
 *    auch nicht: die braucht eine `tool_call_id`, die zu einem WIRKLICH
 *    gestellten Aufruf gehört, sonst brechen openai, anthropic und lu-cloud
 *    mit 400/422 ab. Nutzer-Material ist der einzige Kanal, der über alle vier
 *    Anbieter und alle drei Werkzeugschemata (native, template_fix,
 *    hermes_xml) gleich gültig ist.
 *
 *  - DER PLATZ. Zwischen einer Assistenten-Nachricht mit `tool_calls` und
 *    deren Antworten darf nichts Fremdes stehen. Deshalb wartet die Meldung
 *    eine Runde, wenn die Werkzeugantworten noch fehlen — und, das ist der
 *    tragende Teil, sie holt in dieser Runde auch nichts ab. Das Abholen
 *    markiert im Store als "gemeldet"; abholen und dann doch nicht anhängen
 *    hiesse, die Antwort eines Hintergrundagenten still zu verlieren. Genau
 *    dann, wenn viele Werkzeuge laufen, also im vollsten Lauf.
 *
 * Dazu eine Quellprüfung über beide Aufrufstellen: die Zeile muss INNERHALB
 * der ReAct-Schleife stehen. Einmal pro Nutzerzug aufgerufen erreichte sie
 * einen laufenden Agenten nie — und das ist das ganze Feature.
 *
 * Lauf: npx vitest run src/lib/__tests__/agent-task-report.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { awaitingToolResults, appendTaskReport } from '../agent-task-report'
import type { AgentTask } from '../agent-tasks'

const here = dirname(fileURLToPath(import.meta.url))
const hooksDir = resolve(here, '../../hooks')
const liesHook = (datei: string) => readFileSync(resolve(hooksDir, datei), 'utf8')

type Turn = { role: string; content?: unknown; tool_calls?: unknown }

const JETZT = 1_700_000_100_000

/** Eine fertige Aufgabe, wie sie der Store nach takeUnreported herausgibt. */
function fertig(over: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    convId: 'c1',
    goal: 'Zaehle die Zeilen in main.rs',
    context: '',
    status: 'done',
    background: true,
    startedAt: JETZT - 4000,
    endedAt: JETZT - 1000,
    output: '412 Zeilen.',
    toolCalls: 2,
    iterations: 3,
    inbox: [],
    reported: false,
    ...over,
  }
}

/** Ein Assistentenzug, der Werkzeuge angekündigt hat. */
const mitAufrufen: Turn = {
  role: 'assistant',
  content: '',
  tool_calls: [{ id: 'call_1', function: { name: 'file_read', arguments: '{}' } }],
}

// ── A) awaitingToolResults ─────────────────────────────────────────────────

describe('awaitingToolResults: nur der letzte Zug zählt, und nur ein echter Aufruf', () => {
  it('wahr, wenn die letzte Nachricht Werkzeugaufrufe trägt', () => {
    // Der einzige Fall, in dem ein fremder Zug wirklich einen Anbieterfehler
    // auslöst: die Antworten zu diesen Aufrufen fehlen noch.
    expect(awaitingToolResults([{ role: 'user', content: 'los' }, mitAufrufen])).toBe(true)
  })

  it('falsch bei einem LEEREN tool_calls-Array', () => {
    // Ein leeres Array ist truthy. Wer nur auf das Feld prüft statt auf seine
    // Länge, lässt die Meldung ab hier für immer warten: der Agent bekäme sein
    // Ergebnis nie, ohne dass irgendetwas bricht.
    expect(awaitingToolResults([{ role: 'assistant', content: 'fertig', tool_calls: [] }])).toBe(false)
  })

  it('falsch bei einem Assistentenzug ganz ohne das Feld', () => {
    // Der Normalfall am Ende eines Zuges. Hier ist Anhängen erlaubt.
    expect(awaitingToolResults([{ role: 'assistant', content: 'fertig' }])).toBe(false)
  })

  it('falsch, wenn zuletzt ein Nutzerzug steht', () => {
    expect(awaitingToolResults([mitAufrufen, { role: 'user', content: 'weiter' }])).toBe(false)
  })

  it('falsch, wenn zuletzt eine Werkzeugantwort steht', () => {
    // Genau die Stelle, an der beide Schleifen die Meldung anhängen: die
    // Aufrufe der vorigen Runde sind beantwortet, das Paar ist geschlossen.
    expect(
      awaitingToolResults([
        mitAufrufen,
        { role: 'tool', content: '412' },
      ]),
    ).toBe(false)
  })

  it('falsch bei leerer Nachrichtenliste', () => {
    // Erster Durchlauf einer Schleife, die noch nichts gebaut hat. Kein
    // Zugriff auf messages[-1] darf hier werfen.
    expect(awaitingToolResults([])).toBe(false)
  })
})

// ── B) appendTaskReport ────────────────────────────────────────────────────

describe('appendTaskReport: anhängen nur, wenn es auch sicher ist', () => {
  it('ohne fertige Aufgaben wird nichts angehängt', () => {
    // Der weitaus häufigste Fall — die Zeile steht in JEDER Iteration beider
    // Schleifen. Sie muss ein Vergleich sein und sonst nichts.
    const messages: Turn[] = [{ role: 'user', content: 'los' }]
    const take = vi.fn<() => AgentTask[]>(() => [])

    expect(appendTaskReport(messages, take, JETZT)).toBe(0)

    expect(messages).toHaveLength(1)
    expect(take).toHaveBeenCalledTimes(1)
  })

  it('an sicherer Stelle kommt GENAU EINE Nachricht dazu, mit den Antworten darin', () => {
    // Eine Nachricht, nicht eine pro Aufgabe: mehrere Meldungen hintereinander
    // sähen für das Modell aus wie mehrere Nutzerzüge in Folge, und manche
    // Vorlagen erlauben das nicht.
    const messages: Turn[] = [
      { role: 'user', content: 'los' },
      mitAufrufen,
      { role: 'tool', content: '412' },
    ]
    const take = vi.fn<() => AgentTask[]>(() => [
      fertig(),
      fertig({ id: 'bbbbbbbb-1111-2222-3333-444444444444', goal: 'Suche TODOs', output: 'Sieben Stück.' }),
    ])

    expect(appendTaskReport(messages, take, JETZT)).toBe(2)

    expect(messages).toHaveLength(4)
    const meldung = messages[3]
    expect(meldung.role).toBe('user')
    const text = String(meldung.content)
    expect(text).toContain('412 Zeilen.')
    expect(text).toContain('Sieben Stück.')
    expect(text).toContain('Zaehle die Zeilen in main.rs')
    expect(text).toContain('Suche TODOs')
  })

  it('TRAGEND: wartet die Runde AB und holt dabei nichts ab', () => {
    // Die eigentliche Sicherung. `take` markiert im Store als "gemeldet";
    // würde hier abgeholt und dann wegen der Platzierung doch nicht angehängt,
    // wäre die Antwort des Hintergrundagenten still weg — niemand fragt ein
    // zweites Mal danach. Deshalb zählt nicht nur, dass nichts angehängt wird,
    // sondern dass der Rückruf NULL Mal lief.
    const messages: Turn[] = [{ role: 'user', content: 'los' }, mitAufrufen]
    const take = vi.fn<() => AgentTask[]>(() => [fertig()])

    expect(appendTaskReport(messages, take, JETZT)).toBe(0)

    expect(take).toHaveBeenCalledTimes(0)
    expect(messages).toHaveLength(2)
    expect(messages[1]).toBe(mitAufrufen)
  })

  it('was in der wartenden Runde liegen blieb, kommt in der nächsten an', () => {
    // Gegenprobe zur vorigen: die Meldung ist aufgeschoben, nicht verloren.
    // Ohne diese Zeile wäre "gar nie anhängen" eine bestandene Prüfung.
    const messages: Turn[] = [{ role: 'user', content: 'los' }, mitAufrufen]
    const take = vi.fn<() => AgentTask[]>(() => [fertig()])

    expect(appendTaskReport(messages, take, JETZT)).toBe(0)

    messages.push({ role: 'tool', content: '412' })
    expect(appendTaskReport(messages, take, JETZT)).toBe(1)
    expect(take).toHaveBeenCalledTimes(1)
    expect(messages[3].role).toBe('user')
  })

  it('die angehängte Nachricht hat NUR role und content', () => {
    // Die Form ist die halbe Miete dieses Moduls. `role:'system'` an dieser
    // Stelle weisen strenge Jinja-Vorlagen ab ("System message must be at the
    // beginning"), und eine `tool_call_id`, die zu keinem wirklich gestellten
    // Aufruf gehört, lässt openai, anthropic und lu-cloud mit 400/422
    // abbrechen. Geprüft wird deshalb der Schlüsselsatz selbst und nicht nur
    // die Rolle: ein mitgeschlepptes Zusatzfeld ist derselbe Fehler.
    const messages: Turn[] = [{ role: 'user', content: 'los' }]
    appendTaskReport(messages, () => [fertig()], JETZT)

    const meldung = messages[messages.length - 1]
    expect(Object.keys(meldung).sort()).toEqual(['content', 'role'])
    expect(meldung.role).not.toBe('system')
    expect(meldung.role).not.toBe('tool')
    expect('tool_call_id' in meldung).toBe(false)
  })

  it('auch gescheiterte und abgebrochene Aufgaben werden gemeldet', () => {
    // Ein Hintergrundagent, der scheitert, muss das sagen. Sonst wartet der
    // Hauptagent auf ein Ergebnis, das nie kommt, und dreht Iterationen leer.
    const messages: Turn[] = [{ role: 'user', content: 'los' }]
    const anzahl = appendTaskReport(
      messages,
      () => [
        fertig({ status: 'failed', output: undefined, error: 'connection refused' }),
        fertig({ id: 'cccccccc-1111-2222-3333-444444444444', status: 'cancelled', output: undefined }),
      ],
      JETZT,
    )

    expect(anzahl).toBe(2)
    const text = String(messages[1].content)
    expect(text).toContain('connection refused')
    expect(text).toContain('cancelled')
  })

  it('eine leere Liste vom Store hängt nichts an und meldet 0', () => {
    // Der Store gibt bei nichts Fertigem ein leeres Array zurück, kein null.
    // Eine leere Meldung im Verlauf wäre ein Nutzerzug ohne Inhalt — Ballast,
    // den das Modell zu deuten versuchte.
    const messages: Turn[] = [{ role: 'assistant', content: 'fertig' }]
    expect(appendTaskReport(messages, () => [], JETZT)).toBe(0)
    expect(messages).toHaveLength(1)
  })
})

// ── C) Quellprüfung: die Zeile muss in der Schleife stehen ─────────────────

/**
 * Die ReAct-Schleifen-Hooks, aus dem Verzeichnis abgeleitet statt hier
 * aufgezählt.
 *
 * Merkmal ist `addIteration(`: das ist der Budgetzähler, den nur eine Schleife
 * pro Runde tickt. Das Merkmal ist ABSICHTLICH nicht `appendTaskReport` —
 * sonst nähme sich ein Hook, der den Aufruf vergisst, selbst aus der Prüfung,
 * und die Liste unten wäre still erfüllt.
 */
function reactSchleifenHooks(): string[] {
  return readdirSync(hooksDir)
    .filter((f) => f.startsWith('use') && f.endsWith('.ts'))
    .filter((f) => /\baddIteration\s*\(/.test(liesHook(f)))
    .sort()
}

/**
 * Wo die Schleife jedes Hooks aufgeht. Der Kopf ist pro Datei anders, also
 * steht er hier — die LISTE der Hooks kommt aber aus dem Verzeichnis.
 *
 * EHRLICHE GRENZE: taucht ein dritter Schleifen-Hook auf, kennt diese Tabelle
 * seinen Kopf nicht. Deshalb prüft der erste Test, dass Ableitung und Tabelle
 * deckungsgleich sind — der neue Hook lässt die Datei laut scheitern statt
 * still durchzurutschen.
 */
const SCHLEIFENKOPF: Record<string, string> = {
  'useAgentChat.ts': 'while (runningRef.current',
  'useCodex.ts': 'for (let i = 0; i < MAX_CODEX_ITERATIONS',
}

describe('Verdrahtung: beide ReAct-Schleifen melden fertige Agenten', () => {
  it('die Ableitung findet genau die beiden bekannten Schleifen', () => {
    // Bricht das Merkmal weg, wird die Liste leer und alle Prüfungen darunter
    // wären still erfüllt. Diese Zeile ist die Sicherung darunter.
    const hooks = reactSchleifenHooks()
    expect(hooks).toEqual(['useAgentChat.ts', 'useCodex.ts'])
    expect(hooks).toEqual(Object.keys(SCHLEIFENKOPF).sort())
  })

  it.each(reactSchleifenHooks())('%s ruft appendTaskReport auf', (datei) => {
    // Ein Hook ohne den Aufruf verliert das Feature auf einer ganzen
    // Oberfläche: nichts wirft, die Hintergrundagenten laufen und melden sich
    // nur nie. Der Import allein zählt nicht, es muss ein Aufruf sein.
    expect(/\bappendTaskReport\s*\(/.test(liesHook(datei))).toBe(true)
  })

  it.each(reactSchleifenHooks())('%s ruft ihn INNERHALB der Schleife', (datei) => {
    // Der Platz ist hier die Aussage. Einmal pro Nutzerzug angehängt erreichte
    // die Meldung einen laufenden Agenten nie — er sähe sie erst, wenn er
    // längst fertig ist und der Mensch wieder tippt. Genau das ist das
    // Feature: mitten im Lauf erfahren, dass der Delegierte geantwortet hat.
    const quelle = liesHook(datei)
    const kopf = quelle.indexOf(SCHLEIFENKOPF[datei])
    expect(kopf).toBeGreaterThanOrEqual(0)

    const stellen = [...quelle.matchAll(/\bappendTaskReport\s*\(/g)].map((m) => m.index ?? -1)
    expect(stellen.length).toBeGreaterThan(0)
    for (const stelle of stellen) expect(stelle).toBeGreaterThan(kopf)
  })
})
