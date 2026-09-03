/**
 * Sperrklinken fuer die reinen Regeln der Hintergrundagenten (2026-09-02).
 *
 * Geprueft wird hier nur, was ohne Fenster, Store und Netz gilt: wer aus dem
 * Ring faellt, wieviel eine Aufgabe behalten darf, wie ihre Zeile aussieht und
 * wie sie sich beim Elternagenten meldet. Genau diese vier Regeln sind
 * Lebensdauer-Regeln — ihre Fehler zeigen sich nicht im Screenshot, sondern
 * erst Stunden spaeter in einer Rechnung oder in einem Abbruchknopf, der ins
 * Leere zeigt.
 *
 * Run: npx vitest run src/lib/__tests__/agent-tasks.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  applyTaskRing,
  clampTaskResult,
  renderTaskOneLine,
  renderTaskReport,
  taskElapsedSeconds,
  isTerminal,
  AGENT_TASKS_MAX_PER_CONV,
  TASK_RESULT_CHARS,
  type AgentTask,
  type AgentTaskStatus,
  describeToolCalls,
  ACTIVITY_MAX_TOOLS,
  makeTaskId,
} from '../agent-tasks'
import { truncateToolResult } from '../truncate-tool-result'
import { renderBgStatusOneLine } from '../../api/agents/bg-tasks'

let laufendeNummer = 0

/** Eine Aufgabe mit sprechender Kennung; per Ueberschreibung angepasst. */
function aufgabe(over: Partial<AgentTask> = {}): AgentTask {
  laufendeNummer++
  const nr = String(laufendeNummer).padStart(4, '0')
  return {
    id: `id${nr}aa-bbbb-cccc`,
    convId: 'conv-1',
    goal: `Ziel ${nr}`,
    context: '',
    status: 'done',
    background: true,
    startedAt: 1_000_000,
    endedAt: 1_005_000,
    output: `Antwort ${nr}`,
    toolCalls: 2,
    iterations: 3,
    inbox: [],
    reported: false,
    ...over,
  }
}

const laufend = (over: Partial<AgentTask> = {}): AgentTask =>
  aufgabe({ status: 'running', endedAt: undefined, output: undefined, ...over })

const idsVon = (liste: AgentTask[]) => liste.map((t) => t.id)

describe('applyTaskRing — unter dem Deckel', () => {
  it('gibt die Liste unveraendert zurueck: gleiche Reihenfolge, dieselben Objekte', () => {
    // Der Ring darf nichts kosten, solange er nicht greift. Wuerde er hier
    // kopieren oder umsortieren, saehe der Store bei JEDEM Anlegen einer
    // Aufgabe neue Objektidentitaeten und wuerde das ganze Panel neu zeichnen.
    const liste = [aufgabe(), aufgabe(), laufend()]
    const raus = applyTaskRing(liste, 5)
    expect(idsVon(raus)).toEqual(idsVon(liste))
    expect(raus[0]).toBe(liste[0])
    expect(raus[1]).toBe(liste[1])
    expect(raus[2]).toBe(liste[2])
  })

  it('laesst genau den Deckel voll stehen — erst der naechste Eintrag draengt', () => {
    const voll = Array.from({ length: AGENT_TASKS_MAX_PER_CONV }, () => aufgabe())
    expect(applyTaskRing(voll)).toHaveLength(AGENT_TASKS_MAX_PER_CONV)
    expect(idsVon(applyTaskRing(voll))).toEqual(idsVon(voll))

    const einerZuViel = [...voll, aufgabe()]
    expect(applyTaskRing(einerZuViel)).toHaveLength(AGENT_TASKS_MAX_PER_CONV)
  })
})

describe('applyTaskRing — ueber dem Deckel', () => {
  it('opfert die AELTESTEN beendeten Aufgaben, und genau so viele wie noetig', () => {
    // Aeltest zuerst, weil die juengste Antwort die ist, nach der der
    // Hauptagent gleich noch fragt. Und nicht mehr als noetig: jede geopferte
    // Aufgabe verliert ihr Gespraechsprotokoll und damit ihre Fortsetzbarkeit.
    const liste = Array.from({ length: 6 }, () => aufgabe())
    const raus = applyTaskRing(liste, 4)
    expect(raus).toHaveLength(4)
    expect(idsVon(raus)).toEqual(idsVon(liste.slice(2)))
  })

  it('wirft auch abgebrochene und gescheiterte weg — jeder Endzustand zaehlt', () => {
    const zustaende: AgentTaskStatus[] = ['done', 'failed', 'cancelled']
    for (const s of zustaende) expect(isTerminal(s)).toBe(true)
    expect(isTerminal('running')).toBe(false)

    const liste = [
      aufgabe({ status: 'cancelled', output: undefined, error: 'abgebrochen' }),
      aufgabe({ status: 'failed', output: undefined, error: 'kaputt' }),
      aufgabe(),
    ]
    const raus = applyTaskRing(liste, 1)
    expect(idsVon(raus)).toEqual([liste[2].id])
  })

  it('wirft eine LAUFENDE Aufgabe nie weg, auch nicht als aeltesten Eintrag', () => {
    // Die tragende Regel dieses Moduls. Eine laufende Aufgabe aus dem Store zu
    // werfen heisst, ihren Abbruchknopf wegzuwerfen, waehrend sie auf dem
    // Rechner des Nutzers weiter Werkzeuge ausfuehrt: sie schreibt Dateien und
    // startet Prozesse, und niemand kann sie mehr stoppen. Der Deckel ist
    // gegen Anhaeufung gedacht; gegen Nebenlaeufigkeit steht
    // SUB_AGENT_MAX_PARALLEL, und zwar vor dem Start.
    const alteste = laufend({ goal: 'laeuft seit einer Ewigkeit' })
    const liste = [
      alteste,
      ...Array.from({ length: AGENT_TASKS_MAX_PER_CONV + 9 }, () => aufgabe()),
    ]
    expect(liste).toHaveLength(AGENT_TASKS_MAX_PER_CONV + 10)

    const raus = applyTaskRing(liste)
    expect(raus).toHaveLength(AGENT_TASKS_MAX_PER_CONV)
    expect(raus[0]).toBe(alteste)
    expect(idsVon(raus)).toContain(alteste.id)
    // Geopfert wurden die zehn aeltesten BEENDETEN, nicht der Kopf der Liste.
    expect(idsVon(raus).slice(1)).toEqual(idsVon(liste.slice(11)))
  })

  it('bleibt lieber ueber dem Deckel, als eine laufende Aufgabe zu opfern', () => {
    const liste = [laufend(), laufend(), laufend(), laufend(), aufgabe()]
    const raus = applyTaskRing(liste, 3)
    // Nur eine einzige beendete war da; die ist weg, die vier laufenden bleiben.
    expect(raus).toHaveLength(4)
    expect(raus.every((t) => t.status === 'running')).toBe(true)
    expect(raus.length).toBeGreaterThan(3)
  })

  it('laesst eine Liste aus lauter laufenden Aufgaben vollstaendig stehen', () => {
    const liste = Array.from({ length: AGENT_TASKS_MAX_PER_CONV + 12 }, () => laufend())
    const raus = applyTaskRing(liste)
    expect(idsVon(raus)).toEqual(idsVon(liste))
  })
})

describe('clampTaskResult — das Gedaechtnis einer Aufgabe', () => {
  it('reicht kurzen Text Zeichen fuer Zeichen durch', () => {
    // Kein Trimmen, kein Normalisieren: was der Sub-Agent gelesen hat, steht
    // spaeter unveraendert in seiner Fortsetzung. Ein stilles Umschreiben hier
    // waere in einem Diff oder einer Pfadangabe nicht wiedergutzumachen.
    const text = '  Zeile 1\n\tZeile 2 mit Umlauten: aeoeue äöü\n\n'
    expect(clampTaskResult(text)).toBe(text)
    expect(clampTaskResult('')).toBe('')

    const genauAmDeckel = 'x'.repeat(TASK_RESULT_CHARS)
    expect(clampTaskResult(genauAmDeckel)).toBe(genauAmDeckel)
  })

  it('kappt langen Text und sagt im Text selbst, dass gekappt wurde', () => {
    // Die Marke muss im Ergebnis stehen, nicht nur in einem Feld daneben: das
    // Modell liest diesen String spaeter als sein eigenes Gedaechtnis und darf
    // nicht glauben, die Datei hoere in der Mitte auf.
    const roh = 'A'.repeat(20_000) + 'ENDE'
    const kurz = clampTaskResult(roh)
    expect(kurz.length).toBeLessThan(roh.length)
    expect(kurz).toContain('truncated')
    // Kopf und Schwanz ueberleben — der Anfang traegt meist das Signal, das
    // Ende die Zusammenfassung oder den Fehler.
    expect(kurz.startsWith('AAAA')).toBe(true)
    expect(kurz.endsWith('ENDE')).toBe(true)
  })

  it('ist absichtlich grosszuegiger als die 1500 der beiden Hauptschleifen', () => {
    // 1500 ist ein PROMPT-Budget: was dort gekappt wird, geht in den naechsten
    // Modellaufruf. Dieses Feld ist dagegen das Gedaechtnis fuer eine
    // moegliche Fortsetzung per message_agent. Waere es ebenso eng, koennte
    // ein fortgesetzter Sub-Agent seine eigene vorherige Werkzeugausgabe nicht
    // mehr lesen — und wuerde sie ein zweites Mal holen.
    expect(TASK_RESULT_CHARS).toBeGreaterThan(1500)

    const mittel = 'B'.repeat(4000)
    expect(truncateToolResult(mittel).length).toBeLessThan(mittel.length)
    expect(truncateToolResult(mittel)).toContain('truncated')
    expect(clampTaskResult(mittel)).toBe(mittel)
  })
})

describe('taskElapsedSeconds', () => {
  it('misst eine laufende Aufgabe gegen das uebergebene Jetzt', () => {
    const t = laufend({ startedAt: 10_000 })
    expect(taskElapsedSeconds(t, 10_000)).toBe(0)
    expect(taskElapsedSeconds(t, 15_000)).toBe(5)
    expect(taskElapsedSeconds(t, 22_400)).toBe(12)
  })

  it('misst eine beendete Aufgabe gegen ihr eigenes Ende und laesst sie nicht weiterwachsen', () => {
    // Sonst zaehlte die Dauer einer laengst fertigen Aufgabe im Panel ewig
    // hoch und der Bericht an den Hauptagenten haette bei jedem Anhaengen eine
    // andere Zahl fuer dasselbe Ereignis.
    const t = aufgabe({ startedAt: 10_000, endedAt: 17_000 })
    expect(taskElapsedSeconds(t, 17_000)).toBe(7)
    expect(taskElapsedSeconds(t, 900_000)).toBe(7)
  })

  it('wird nie negativ, wenn die Uhr rueckwaerts geht', () => {
    const t = laufend({ startedAt: 50_000 })
    expect(taskElapsedSeconds(t, 40_000)).toBe(0)
  })
})

describe('renderTaskOneLine', () => {
  // Die gemeinsame Form ist die STRUKTUR — Kennung, Zustand, Dauer, Sache —
  // und nicht die Laenge der Kennung. Die alte Fassung schrieb `{8}` hinein
  // und band damit zwei Dinge aneinander, die nichts miteinander zu tun haben:
  // eine Shell-Aufgabe hat einen Hash als Kennung (acht Zeichen davon sind
  // eindeutig), eine Agentenaufgabe `task-<lfd>-<zufall6>` (acht Zeichen davon
  // sind es nicht). Das `{8}` hat den Fehler nicht gefunden, sondern gehalten.
  const FORM = /^\[[^\]]+\] .+ \(\d+s\), .+$/

  it('hat dieselbe Form wie renderBgStatusOneLine bei den Shell-Aufgaben', () => {
    // Die App hat schon einen Begriff von "Hintergrundaufgabe". Ein zweiter,
    // leicht anderer waere eine Zumutung fuer den, der beide Listen sieht —
    // deshalb: Kennung, Zustand, Dauer, dann worum es ging.
    const id = makeTaskId(3)
    const meine = renderTaskOneLine(
      aufgabe({ id, goal: 'Die Tests gruen bekommen' }),
      1_005_000,
    )
    const shell = renderBgStatusOneLine({
      id: 'abcdefgh-ijkl',
      command: 'npm test',
      cwd: null,
      started_at: 100,
      finished_at: 105,
      exit_code: 0,
      running: false,
      cancelled: false,
      output_tail: '',
    })
    expect(meine).toMatch(FORM)
    expect(shell).toMatch(FORM)
    expect(meine).toBe(`[${id}] ok (5s), Die Tests gruen bekommen`)
    // Die Shell-Aufgabe kuerzt weiter, und das ist dort RICHTIG: ihre Kennung
    // ist ein Hash, acht Zeichen davon sind eindeutig und wieder auffindbar.
    expect(shell).toBe('[abcdefgh] ok (5s), npm test')
  })

  it('traegt die Kennung UNGEKUERZT — sie ist ein Handgriff, kein Schmuck', () => {
    // Hier stand "kuerzt die Kennung auf acht Zeichen", mit einer erfundenen
    // Kennung `0123456789abcdef` — einer Form, die es in der App nirgends
    // gibt. Der Test hat damit den Fehler festgeschrieben statt ihn zu finden:
    // eine echte Kennung `task-1-a4f2k9` wurde zu `task-1-a`, und der
    // Zufallsteil, der als einziger unterscheidet, fiel weg.
    //
    // Das war keine Kosmetik. `check_tasks` gibt diese Zeile an das MODELL,
    // und `message_agent` verlangt die Kennung zurueck. Das Modell las
    // `task-1-a`, schickte `task-1-a` und bekam "unbekannte Aufgabe".
    const id = makeTaskId(1)
    const zeile = renderTaskOneLine(aufgabe({ id }), 1_005_000)
    expect(zeile.startsWith(`[${id}] `)).toBe(true)

    // Und im Klartext, warum acht Zeichen nicht reichen: `task-` ist schon
    // fuenf davon. Ab einer ZWEISTELLIGEN laufenden Nummer — also ab der
    // zehnten Aufgabe einer Sitzung — bleibt vom Zufallsteil, dem einzigen
    // der zwei Aufgaben unterscheidet, gar nichts mehr uebrig:
    expect(makeTaskId(12).slice(0, 8)).toBe('task-12-')
    expect(makeTaskId(99).slice(0, 8)).toBe('task-99-')
    // Ab dreistellig frisst die Nummer selbst den Trenner mit.
    expect(makeTaskId(100).slice(0, 8)).toBe('task-100')
    // Zwei verschiedene Aufgaben, dieselben acht Zeichen. Genau die
    // Verwechslung, mit der `message_agent` ins Leere lief.
    expect(makeTaskId(12)).not.toBe(makeTaskId(12))
    expect(makeTaskId(12).slice(0, 8)).toBe(makeTaskId(12).slice(0, 8))
  })

  it('gibt eine Kennung, mit der message_agent auch wirklich etwas anfangen kann', () => {
    // Die Zusage, um die es eigentlich geht: was das Modell in der Zeile
    // liest, muss es unveraendert zurueckschicken koennen.
    const id = makeTaskId(7)
    const zeile = renderTaskOneLine(aufgabe({ id, goal: 'x' }), 1_005_000)
    const gelesen = zeile.match(/^\[([^\]]+)\]/)![1]
    expect(gelesen).toBe(id)
  })

  it('nennt done "ok" und die uebrigen Zustaende beim Namen', () => {
    const now = 1_005_000
    expect(renderTaskOneLine(aufgabe({ status: 'done' }), now)).toContain('] ok (')
    expect(renderTaskOneLine(laufend(), now)).toContain('] running (')
    expect(renderTaskOneLine(aufgabe({ status: 'failed' }), now)).toContain('] failed (')
    expect(renderTaskOneLine(aufgabe({ status: 'cancelled' }), now)).toContain('] cancelled (')
  })

  it('laesst die Dauer einer laufenden Aufgabe mit dem Jetzt wachsen, die einer fertigen nicht', () => {
    const laufId = makeTaskId(1)
    const laeuft = laufend({ id: laufId, startedAt: 0, goal: 'laeuft' })
    expect(renderTaskOneLine(laeuft, 3_000)).toBe(`[${laufId}] running (3s), laeuft`)
    expect(renderTaskOneLine(laeuft, 30_000)).toBe(`[${laufId}] running (30s), laeuft`)

    const fertigId = makeTaskId(2)
    const fertig = aufgabe({ id: fertigId, startedAt: 0, endedAt: 3_000, goal: 'fertig' })
    expect(renderTaskOneLine(fertig, 3_000)).toBe(`[${fertigId}] ok (3s), fertig`)
    expect(renderTaskOneLine(fertig, 999_000)).toBe(`[${fertigId}] ok (3s), fertig`)
  })
})

describe('renderTaskReport', () => {
  const now = 1_005_000

  it('gibt bei nichts zu melden den leeren String zurueck', () => {
    // appendTaskReport haengt genau dann nichts an. Ein leerer Rahmen waere
    // eine Nutzernachricht ohne Inhalt in jeder Runde — Ballast im Verlauf und
    // fuer manche Anbieter ein Fehler.
    expect(renderTaskReport([], now)).toBe('')
  })

  it('meldet eine einzelne Aufgabe mit Rahmen, Zeile und ANTWORT', () => {
    // Der Bericht reist als NUTZER-Material: role:'system' lehnen strenge
    // Jinja-Vorlagen ausserhalb von Index 0 ab, und role:'tool' braeuchte eine
    // tool_call_id zu einem wirklich gestellten Aufruf. Deshalb muss der Text
    // selbst alles tragen — vor allem die Antwort, nicht nur eine Kennung.
    const berichtId = makeTaskId(4)
    const t = aufgabe({
      id: berichtId,
      goal: 'Die Migration pruefen',
      output: 'Alle 12 Migrationen laufen sauber durch.',
      startedAt: 1_000_000,
      endedAt: 1_004_000,
    })
    const text = renderTaskReport([t], now)
    expect(text.startsWith('[background-task]\n')).toBe(true)
    expect(text.endsWith('\n[/background-task]')).toBe(true)
    expect(text).toContain(`[${berichtId}] ok (4s), Die Migration pruefen`)
    expect(text).toContain('Alle 12 Migrationen laufen sauber durch.')
  })

  it('meldet mehrere Aufgaben in einem Rahmen, jede mit ihrer eigenen Antwort', () => {
    const a = aufgabe({ id: 'aaaa1111-x', goal: 'Ziel A', output: 'Antwort A' })
    const b = aufgabe({ id: 'bbbb2222-x', goal: 'Ziel B', output: 'Antwort B' })
    const c = aufgabe({ id: 'cccc3333-x', goal: 'Ziel C', output: 'Antwort C' })
    const text = renderTaskReport([a, b, c], now)
    expect(text.startsWith('[background-tasks]\n')).toBe(true)
    expect(text.endsWith('\n[/background-tasks]')).toBe(true)
    for (const s of ['Antwort A', 'Antwort B', 'Antwort C', 'Ziel A', 'Ziel B', 'Ziel C']) {
      expect(text).toContain(s)
    }
    // Reihenfolge wie uebergeben, damit die Antwort unter ihrer eigenen Zeile steht.
    expect(text.indexOf('Antwort A')).toBeLessThan(text.indexOf('Antwort B'))
    expect(text.indexOf('Antwort B')).toBeLessThan(text.indexOf('Antwort C'))
  })

  it('meldet einen Fehlschlag als Fehlschlag und nicht als Erfolg', () => {
    // Der Hauptagent handelt allein aufgrund dieses Textes weiter. Liest er
    // eine gescheiterte Aufgabe als erledigt, baut er auf einem Ergebnis auf,
    // das es nicht gibt.
    const kaputt = aufgabe({
      id: 'f00df00d-1',
      goal: 'Das Protokoll holen',
      status: 'failed',
      output: undefined,
      error: 'ENOENT: /var/log/lu.log gibt es nicht',
    })
    const text = renderTaskReport([kaputt], now)
    expect(text).toContain('] failed (')
    expect(text).not.toContain('] ok (')
    expect(text).toContain('ENOENT: /var/log/lu.log gibt es nicht')
  })

  it('sagt es ausdruecklich, wenn eine Aufgabe ohne Antwort endet', () => {
    const stumm = aufgabe({ id: 'c0ffee00-1', status: 'done', output: undefined })
    expect(renderTaskReport([stumm], now)).toContain('(no answer)')

    const abgebrochen = aufgabe({
      id: 'c0ffee01-1',
      status: 'cancelled',
      output: undefined,
      error: undefined,
    })
    expect(renderTaskReport([abgebrochen], now)).toContain('(cancelled)')
  })
})

// ── Der Rang im Ring: gemeldet vor ungemeldet ─────────────────────────────
//
// Gefunden am 02.09.2026 von einem Waechter, der den Store pruefen sollte, und
// deshalb steht die Regel hier: die erste Fassung des Rings opferte die
// aeltesten BEENDETEN Aufgaben, ohne zu fragen, ob ihre Antwort schon jemanden
// erreicht hat. Gemessen: 45 laufende Aufgaben, dann `finish` auf eine — und
// genau die eben fertig gewordene fiel im selben Zug heraus, weil sie die
// aelteste beendete war. Ihre Antwort war weg, bevor `takeUnreported` sie je
// gesehen hatte.
//
// Das ist der teuerste Fehler, den dieser Bereich haben kann: ein Agent hat
// gearbeitet, Werkzeuge auf der Maschine des Nutzers gefahren, und niemand
// erfaehrt je, was herauskam. Kein Absturz, keine Zeile im Protokoll.
describe('der Ring opfert zuerst, was schon angekommen ist', () => {
  it('eine gemeldete Antwort weicht einer ungemeldeten, auch wenn sie juenger ist', () => {
    // Reihenfolge im Speicher: die ungemeldete steht VORNE, ist also aelter.
    // Nach der alten Regel waere genau sie gegangen.
    const liste = [
      aufgabe({ id: 'ungemeldet-alt', reported: false }),
      aufgabe({ id: 'gemeldet-jung', reported: true }),
    ]
    const out = applyTaskRing(liste, 1).map((t) => t.id)
    expect(out).toEqual(['ungemeldet-alt'])
  })

  it('erst wenn nichts Gemeldetes mehr da ist, geht auch eine ungemeldete', () => {
    // Der Speicher hat Vorrang vor der Vollstaendigkeit, aber erst als
    // letztes Mittel — und dann trifft es die aelteste.
    const liste = [
      aufgabe({ id: 'ungemeldet-1', reported: false }),
      aufgabe({ id: 'ungemeldet-2', reported: false }),
      aufgabe({ id: 'ungemeldet-3', reported: false }),
    ]
    expect(applyTaskRing(liste, 2).map((t) => t.id)).toEqual(['ungemeldet-2', 'ungemeldet-3'])
  })

  it('gemeldete gehen in ihrer Reihenfolge, aelteste zuerst', () => {
    const liste = [
      aufgabe({ id: 'gemeldet-1', reported: true }),
      aufgabe({ id: 'gemeldet-2', reported: true }),
      aufgabe({ id: 'ungemeldet', reported: false }),
    ]
    expect(applyTaskRing(liste, 2).map((t) => t.id)).toEqual(['gemeldet-2', 'ungemeldet'])
  })

  it('eine laufende Aufgabe schlaegt beide Raenge', () => {
    // Selbst wenn nur noch sie und eine ungemeldete da sind: der
    // Abbrechen-Knopf einer rechnenden Aufgabe wiegt schwerer als der
    // Speicher, den ihre Zeile kostet.
    const liste = [
      aufgabe({ id: 'laeuft', status: 'running', endedAt: undefined, reported: false }),
      aufgabe({ id: 'ungemeldet', reported: false }),
    ]
    expect(applyTaskRing(liste, 1).map((t) => t.id)).toEqual(['laeuft'])
  })
})

// ── Die Aktivitaetszeile ──────────────────────────────────────────────────

describe('describeToolCalls — woran der Agent gerade arbeitet', () => {
  it('fasst Wiederholungen zusammen', () => {
    // Drei gelesene Dateien sind EIN Vorgang. "read_file, read_file,
    // read_file" traegt keine zusaetzliche Auskunft und frisst die
    // Spaltenbreite, die fuer den zweiten Werkzeugnamen gebraucht wird.
    expect(describeToolCalls(['read_file', 'read_file', 'read_file'])).toBe('read_file')
  })

  it('behaelt die Reihenfolge des ersten Auftretens', () => {
    // Alphabetisch zu sortieren waere leichter zu lesen und falsch: die
    // Reihenfolge IST die Auskunft — erst gesucht, dann gelesen.
    expect(describeToolCalls(['read_file', 'grep', 'read_file'])).toBe('read_file, grep')
  })

  it('sagt "working" statt gar nichts, wenn kein Name ankam', () => {
    // Kaputtes Werkzeug-JSON eines kleinen Modells ist der Normalfall, nicht
    // der Ausnahmefall. Eine leere Zeile hiesse fuer den Nutzer "steht", und
    // genau da bricht er einen Lauf ab, der gleich fertig waere.
    expect(describeToolCalls([undefined, undefined])).toBe('working')
    expect(describeToolCalls([])).toBe('working')
    expect(describeToolCalls(['', '  '])).toBe('working')
  })

  it('kappt lange Listen mit einer ehrlichen Restzahl', () => {
    // Nicht abschneiden, sondern zaehlen: "+3" sagt, dass da noch etwas ist.
    // Ein mitten im Namen abgeschnittener String liest sich wie ein anderes,
    // falsches Werkzeug.
    const t = describeToolCalls(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(t).toBe(`a, b, c +${6 - ACTIVITY_MAX_TOOLS}`)
    expect(t.split(',').length).toBeLessThanOrEqual(ACTIVITY_MAX_TOOLS + 1)
  })

  it('zaehlt beim Kappen die EINDEUTIGEN, nicht die rohen Aufrufe', () => {
    // Sonst behauptete "+7" sieben weitere Werkzeuge, wo in Wahrheit
    // siebenmal dasselbe lief.
    expect(describeToolCalls(['a', 'b', 'c', 'd', 'd', 'd', 'd'])).toBe('a, b, c +1')
  })
})
