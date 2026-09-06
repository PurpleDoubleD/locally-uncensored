/**
 * Hintergrund-Agenten: die Buchfuehrung.
 *
 * Der Store ist die einzige Stelle, an der steht, WAS gerade laeuft, was schon
 * geantwortet hat und was davon der Hauptagent bereits gesehen hat. Alles, was
 * der Nutzer im rechten Panel sieht, und alles, was das Modell als Meldung
 * bekommt, wird hier entschieden. Zwei Fehlerarten sind hier teuer, und beide
 * sind still:
 *
 *  - Doppelt melden. Der Hauptagent bekommt fertige Aufgaben als NUTZER-Material
 *    in den Verlauf (renderTaskReport; als role:'system' waere es an einer
 *    Stelle != 0 von strengen Jinja-Vorlagen abgelehnt, als role:'tool' braeuchte
 *    es eine echte tool_call_id, sonst 400/422 bei openai, anthropic, lu-cloud).
 *    Eine zweimal gemeldete Antwort sieht fuer das Modell aus wie zwei
 *    Ergebnisse und wird zweimal beantwortet — einmal handeln statt einmal
 *    lesen. Deshalb ist `reported` eine Einbahnstrasse.
 *  - Zustaende behaupten, die es nicht gibt. `cancel` bricht ab, aber setzt
 *    NICHT 'cancelled'; das tut der Lauf, wenn sein Signal feuert. Ein Panel,
 *    das dem Wunsch statt der Wirklichkeit folgt, ist schlimmer als keins.
 *
 * Alles hier wird gegen den echten Store gefahren, keine Attrappe.
 *
 * Run: npx vitest run src/stores/__tests__/agentTaskStore.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useAgentTaskStore, _controllerCount } from '../agentTaskStore'
import { AGENT_TASKS_MAX_PER_CONV, type AgentTask } from '../../lib/agent-tasks'

const S = () => useAgentTaskStore.getState()

type StartExtra = Partial<Pick<AgentTask, 'goal' | 'context' | 'background' | 'startedAt'>> & {
  controller?: AbortController
}

/** Eine laufende Aufgabe anlegen; nur was der Test braucht, steht im Aufruf. */
function starte(id: string, convId = 'c1', extra: StartExtra = {}) {
  S().start({
    id,
    convId,
    goal: `Ziel ${id}`,
    context: '',
    background: true,
    startedAt: 1_000,
    // Seit 2.6.8 verlangt `start` einen Abbruchgriff, damit eine laufende
    // Zeile ohne Stoppmoeglichkeit gar nicht erst baubar ist. Die Helferin
    // liefert eine Vorgabe; Tests, die den Abbruch pruefen, reichen ihre
    // eigene herein und beobachten sie.
    controller: new AbortController(),
    ...extra,
  })
}

/** Sauber beenden, wie es der Lauf tut. */
function beende(id: string, status: AgentTask['status'] = 'done', output = `Antwort ${id}`) {
  S().finish(id, { status, output, endedAt: 2_000 })
}

beforeEach(() => {
  // clearConv statt setState: die Controller-Karte ist Modulzustand und
  // ueberlebt ein blosses Zuruecksetzen von byConv. Ein uebriggebliebener
  // Controller wuerde dem naechsten Test einen Abbrechen-Knopf vorgaukeln.
  for (const convId of Object.keys(S().byConv)) S().clearConv(convId)
  useAgentTaskStore.setState({ byConv: {} })
  expect(_controllerCount()).toBe(0)
})

describe('A) start, finish, get, forConv', () => {
  it('start legt eine laufende Aufgabe mit leeren Zaehlern an', () => {
    starte('t1')
    const t = S().get('t1')!
    expect(t.status).toBe('running')
    expect(t.inbox).toEqual([])
    expect(t.reported).toBe(false)
    expect(t.toolCalls).toBe(0)
    expect(t.iterations).toBe(0)
    expect(t.goal).toBe('Ziel t1')
    expect(S().forConv('c1')).toHaveLength(1)
  })

  it('eine Aufgabe landet unter ihrer Konversation und ist fuer eine andere unsichtbar', () => {
    // Das Panel haengt an forConv. Leckte eine Aufgabe in den Nachbarchat,
    // saehe der Nutzer dort einen Abbrechen-Knopf fuer etwas, das er nie
    // gestartet hat — und takeUnreported meldete es dem falschen Elternzug.
    starte('t1', 'c1')
    starte('t2', 'c2')
    expect(S().forConv('c1').map((t) => t.id)).toEqual(['t1'])
    expect(S().forConv('c2').map((t) => t.id)).toEqual(['t2'])
  })

  it('get findet quer ueber alle Konversationen, forConv nicht', () => {
    // get bekommt nur eine Kennung — message_agent und check_tasks nennen die
    // Aufgabe, nicht den Chat. Deshalb sucht get global, forConv aber strikt.
    starte('t2', 'c2')
    expect(S().get('t2')?.convId).toBe('c2')
    expect(S().forConv('c1')).toEqual([])
  })

  it('finish schreibt Ergebnis, Endzeit und Endzustand in dieselbe Zeile', () => {
    starte('t1')
    beende('t1', 'done', 'fertig')
    const t = S().get('t1')!
    expect(t.status).toBe('done')
    expect(t.output).toBe('fertig')
    expect(t.endedAt).toBe(2_000)
    // Die Zeile bleibt im Panel stehen, sie verschwindet nicht mit dem Ende.
    expect(S().forConv('c1')).toHaveLength(1)
  })

  it('finish auf eine unbekannte Kennung veraendert nichts', () => {
    starte('t1')
    const vorher = S().byConv
    S().finish('gibtsnicht', { status: 'done', endedAt: 2_000 })
    expect(S().byConv).toBe(vorher)
    expect(S().get('t1')?.status).toBe('running')
  })

  it('get auf eine unbekannte Kennung ist undefined, forConv auf einen leeren Chat ist leer', () => {
    expect(S().get('nix')).toBeUndefined()
    expect(S().forConv('leer')).toEqual([])
  })
})

describe('B) takeUnreported meldet jede Aufgabe genau einmal', () => {
  it('eine laufende Aufgabe wird nie gemeldet', () => {
    // Ein Zwischenstand als Meldung waere eine halbe Antwort, auf die der
    // Hauptagent aufbaut — und die endgueltige kaeme spaeter noch einmal.
    starte('t1')
    expect(S().takeUnreported('c1')).toEqual([])
    expect(S().get('t1')?.reported).toBe(false)
  })

  it('eine fertige Aufgabe kommt einmal, der zweite Aufruf ist leer', () => {
    // Der teure Fall. Eine fehlende Meldung merkt der Nutzer und fragt nach;
    // eine doppelte merkt niemand — der Hauptagent liest dieselbe Antwort
    // zweimal und handelt zweimal danach (zweimal committen, zweimal schreiben).
    starte('t1')
    beende('t1')
    const erste = S().takeUnreported('c1')
    expect(erste.map((t) => t.id)).toEqual(['t1'])
    expect(erste[0].output).toBe('Antwort t1')
    expect(S().takeUnreported('c1')).toEqual([])
    expect(S().takeUnreported('c1')).toEqual([])
  })

  it('die Rueckgabe stimmt mit dem ueberein, was im Speicher steht', () => {
    // Frueher war die Rueckgabe eine Momentaufnahme von VOR dem Schreiben und
    // trug `reported: false`, waehrend die Zeile im Store schon `true` hatte.
    // Harmlos, solange nur id/status/output gelesen werden — und eine Falle
    // fuer den ersten Aufrufer, der die Objekte behaelt. Eine Rueckgabe, die
    // dem Speicher widerspricht, ist ein Fehler mit Verfallsdatum.
    starte('r1')
    S().finish('r1', { status: 'done', output: 'fertig', endedAt: 2_000 })
    const [zeile] = S().takeUnreported('c1')
    expect(zeile.reported).toBe(true)
    expect(S().get('r1')!.reported).toBe(true)
  })

  it('meldet failed und cancelled ebenso, aber nur Endzustaende', () => {
    starte('a')
    starte('b')
    starte('c')
    S().finish('a', { status: 'failed', error: 'kaputt', endedAt: 2_000 })
    S().finish('b', { status: 'cancelled', endedAt: 2_000 })
    expect(S().takeUnreported('c1').map((t) => t.id).sort()).toEqual(['a', 'b'])
    expect(S().get('c')?.status).toBe('running')
  })

  it('der Haken haengt an der Aufgabe, nicht an der Konversation', () => {
    // Sonst wuerde die zweite Aufgabe, die nach der ersten Meldung fertig
    // wird, stumm bleiben — ein Ergebnis, das niemand je zu sehen bekommt.
    starte('t1')
    starte('t2')
    beende('t1')
    expect(S().takeUnreported('c1').map((t) => t.id)).toEqual(['t1'])
    beende('t2')
    expect(S().takeUnreported('c1').map((t) => t.id)).toEqual(['t2'])
  })

  it('meldet nur die Aufgaben der gefragten Konversation', () => {
    starte('t1', 'c1')
    starte('t2', 'c2')
    beende('t1')
    beende('t2')
    expect(S().takeUnreported('c1').map((t) => t.id)).toEqual(['t1'])
    // c2 ist unberuehrt: sein Ergebnis wartet weiter auf seinen eigenen Zug.
    expect(S().get('t2')?.reported).toBe(false)
    expect(S().takeUnreported('c2').map((t) => t.id)).toEqual(['t2'])
  })

  it('eine unbekannte Konversation liefert eine leere Liste', () => {
    expect(S().takeUnreported('gibtsnicht')).toEqual([])
  })
})

describe('C) post und drainInbox', () => {
  it('post an eine laufende Aufgabe landet, drainInbox holt es genau einmal', () => {
    // Der Posteingang ist der einzige Weg, einer laufenden Aufgabe noch etwas
    // zu sagen. Zweimal ausliefern hiesse: dieselbe Zusatzanweisung zweimal
    // befolgen, in der naechsten Runde derselben Schleife.
    starte('t1', 'c1', { controller: new AbortController() })
    expect(S().post('t1', 'nimm lieber Datei B')).toBe(true)
    expect(S().get('t1')?.inbox).toEqual(['nimm lieber Datei B'])
    expect(S().drainInbox('t1')).toEqual(['nimm lieber Datei B'])
    expect(S().get('t1')?.inbox).toEqual([])
    expect(S().drainInbox('t1')).toEqual([])
  })

  it('mehrere posts kommen in der Reihenfolge, in der sie gerufen wurden', () => {
    starte('t1')
    S().post('t1', 'eins')
    S().post('t1', 'zwei')
    expect(S().drainInbox('t1')).toEqual(['eins', 'zwei'])
  })

  it('post an eine FERTIGE Aufgabe ist false und laesst den Posteingang leer', () => {
    // Niemand liest ihn mehr. Ein stilles true waere die schlimmere Antwort:
    // der Hauptagent glaubte, seine Anweisung sei angekommen, und wartete.
    starte('t1')
    beende('t1')
    expect(S().post('t1', 'zu spaet')).toBe(false)
    expect(S().get('t1')?.inbox).toEqual([])
  })

  it('post gilt fuer alle drei Endzustaende, nicht nur fuer done', () => {
    starte('a')
    starte('b')
    S().finish('a', { status: 'failed', error: 'x', endedAt: 2_000 })
    S().finish('b', { status: 'cancelled', endedAt: 2_000 })
    expect(S().post('a', 'noch was')).toBe(false)
    expect(S().post('b', 'noch was')).toBe(false)
    expect(S().get('a')?.inbox).toEqual([])
    expect(S().get('b')?.inbox).toEqual([])
  })

  it('post auf eine unbekannte Kennung ist false', () => {
    expect(S().post('gibtsnicht', 'hallo')).toBe(false)
  })

  it('drainInbox auf eine unbekannte Kennung liefert eine leere Liste statt zu werfen', () => {
    // Der Lauf leert seinen Posteingang in jeder Runde. Faellt die Aufgabe
    // vorher aus dem Ring oder wird der Chat geloescht, darf das die Schleife
    // nicht mit einer Ausnahme abreissen — sie soll nur nichts vorfinden.
    expect(() => S().drainInbox('gibtsnicht')).not.toThrow()
    expect(S().drainInbox('gibtsnicht')).toEqual([])
  })
})

describe('D) cancel bricht ab, behauptet aber nichts', () => {
  it('cancel auf eine laufende Aufgabe mit Controller bricht ab und liefert true', () => {
    const c = new AbortController()
    starte('t1', 'c1', { controller: c })
    expect(c.signal.aborted).toBe(false)
    expect(S().cancel('t1')).toBe(true)
    expect(c.signal.aborted).toBe(true)
  })

  it('cancel setzt den Zustand NICHT auf cancelled — das tut der Lauf', () => {
    // Die feine Stelle. Zwischen abort() und dem Moment, in dem die Schleife
    // ihr Signal bemerkt, rechnet das Modell weiter: der Strom laeuft, die
    // Token kosten. Wuerde hier schon 'cancelled' stehen, zeigte das Panel
    // ein Ende an, das es noch nicht gibt — eine Anzeige, die dem Wunsch
    // statt der Wirklichkeit folgt. Der Lauf schreibt den Endzustand, wenn er
    // wirklich stehengeblieben ist (sub-agent.ts: signal.aborted -> cancelled).
    const c = new AbortController()
    starte('t1', 'c1', { controller: c })
    S().cancel('t1')
    expect(S().get('t1')?.status).toBe('running')
    expect(S().get('t1')?.endedAt).toBeUndefined()

    // Und so sieht es aus, wenn der Lauf sein Signal dann bemerkt hat:
    S().finish('t1', { status: 'cancelled', endedAt: 2_000 })
    expect(S().get('t1')?.status).toBe('cancelled')
  })

  it('eine laufende Aufgabe ohne Abbruchgriff ist gar nicht baubar', () => {
    // Frueher durfte `controller` fehlen. Dann zaehlte `cancelAll` die Zeile
    // nicht mit und `cancel` brach nichts ab — das Panel zeigte trotzdem
    // einen Stopp-Knopf, denn der haengt nur am Zustand 'running'. Ein Knopf,
    // der nichts tut, ist schlimmer als keiner.
    //
    // Die Regel steht jetzt im TYP, also prueft dieser Waechter den Typ: der
    // Aufruf ohne Griff darf sich nicht uebersetzen lassen. Ein Laufzeittest
    // koennte das gar nicht mehr zeigen.
    const quelle = readFileSync(resolve(__dirname, '..', 'agentTaskStore.ts'), 'utf8')
    expect(quelle).toMatch(/controller:\s*AbortController\b/)
    expect(quelle).not.toMatch(/controller\?:\s*AbortController/)
    // Und der einzige echte Aufrufer reicht ihn wirklich durch.
    const aufrufer = readFileSync(
      resolve(__dirname, '..', '..', 'api', 'agents', 'sub-agent.ts'), 'utf8',
    )
    expect(aufrufer).toMatch(/startedAt: Date\.now\(\), controller/)
  })

  it('nach finish ist der Controller weg, cancel also false', () => {
    starte('t1', 'c1', { controller: new AbortController() })
    beende('t1')
    expect(_controllerCount()).toBe(0)
    expect(S().cancel('t1')).toBe(false)
  })

  it('cancelAll bricht jede laufende Aufgabe einer Konversation ab und zaehlt sie', () => {
    const a = new AbortController()
    const b = new AbortController()
    const fremd = new AbortController()
    starte('a', 'c1', { controller: a })
    starte('b', 'c1', { controller: b })
    starte('fertig', 'c1', { controller: new AbortController() })
    starte('fremd', 'c2', { controller: fremd })
    beende('fertig')

    expect(S().cancelAll('c1')).toBe(2)
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    // Der Nachbarchat bleibt in Ruhe: gestoppt wurde EIN Elternlauf, nicht die App.
    expect(fremd.signal.aborted).toBe(false)
    expect(S().get('fremd')?.status).toBe('running')
  })

  it('cancelAll laesst die Zustaende stehen, genau wie cancel', () => {
    starte('a', 'c1', { controller: new AbortController() })
    S().cancelAll('c1')
    expect(S().get('a')?.status).toBe('running')
  })

  it('cancelAll auf eine unbekannte Konversation ist 0', () => {
    expect(S().cancelAll('gibtsnicht')).toBe(0)
  })
})

describe('E) aufraeumen', () => {
  it('finish leert den Posteingang', () => {
    // Was niemand mehr liest, soll nicht als ungelesen dastehen — sonst
    // zeigte das Panel eine Aufgabe mit wartender Post, die nie ankommt.
    starte('t1')
    S().post('t1', 'noch eine Idee')
    expect(S().get('t1')?.inbox).toHaveLength(1)
    beende('t1')
    expect(S().get('t1')?.inbox).toEqual([])
  })

  it('clearConv entfernt die Aufgaben einer Konversation samt Controllern', () => {
    starte('t1', 'c1', { controller: new AbortController() })
    starte('t2', 'c2', { controller: new AbortController() })
    expect(_controllerCount()).toBe(2)

    S().clearConv('c1')
    expect(S().forConv('c1')).toEqual([])
    expect(S().get('t1')).toBeUndefined()
    // Ein zurueckgebliebener Controller waere ein Leck mit Nebenwirkung: die
    // Kennung koennte spaeter erneut vergeben werden und den falschen Lauf treffen.
    expect(_controllerCount()).toBe(1)
    // Der andere Chat behaelt alles.
    expect(S().get('t2')?.status).toBe('running')
  })

  it('clearConv auf eine unbekannte Konversation tut nichts', () => {
    starte('t1', 'c1')
    S().clearConv('gibtsnicht')
    expect(S().forConv('c1')).toHaveLength(1)
  })
})

describe('F) der Ring greift beim Starten UND beim Beenden', () => {
  it(`kappt beim Starten auf ${AGENT_TASKS_MAX_PER_CONV} und opfert die aeltesten fertigen`, () => {
    // Eine Aufgabe haelt ein ganzes Modellgespraech samt Werkzeugausgaben.
    // Ohne Deckel waere das derselbe Speicherfehler, den codexStore und
    // toolAuditStore in diesem Repo schon zweimal bezahlt haben.
    const n = AGENT_TASKS_MAX_PER_CONV + 10
    for (let i = 0; i < n; i++) {
      starte(`t${i}`)
      beende(`t${i}`)
    }
    const liste = S().forConv('c1')
    expect(liste).toHaveLength(AGENT_TASKS_MAX_PER_CONV)
    // Von vorne geopfert: die zehn aeltesten sind weg, die juengste ist da.
    expect(S().get('t0')).toBeUndefined()
    expect(S().get('t9')).toBeUndefined()
    expect(S().get('t10')).toBeDefined()
    expect(liste[liste.length - 1].id).toBe(`t${n - 1}`)
  })

  it('laufende Aufgaben fallen nie heraus, auch weit ueber dem Deckel', () => {
    // Eine laufende Zeile wegzuwerfen hiesse, ihren Abbrechen-Knopf
    // wegzuwerfen, waehrend sie weiterrechnet. Die Nebenlaeufigkeit begrenzt
    // SUB_AGENT_MAX_PARALLEL vor dem Start, nicht der Ring danach.
    const n = AGENT_TASKS_MAX_PER_CONV + 5
    for (let i = 0; i < n; i++) starte(`r${i}`)
    expect(S().forConv('c1')).toHaveLength(n)
    expect(S().get('r0')?.status).toBe('running')
  })

  it('kappt auch beim Beenden — jedes finish holt die uebervolle Liste ein Stueck herunter', () => {
    // finish laeuft ebenfalls durch applyTaskRing. Ist die Liste ueber dem
    // Deckel (nur moeglich, wenn mehr als 40 gleichzeitig liefen), faellt die
    // gerade beendete Aufgabe im selben Zug heraus — mitsamt ihrer Antwort,
    // bevor takeUnreported sie je gesehen hat. Steht hier gemessen, damit es
    // eine benannte Grenze ist und keine Ueberraschung.
    const ueber = 5
    const n = AGENT_TASKS_MAX_PER_CONV + ueber
    for (let i = 0; i < n; i++) starte(`r${i}`)

    beende('r0')
    expect(S().forConv('c1')).toHaveLength(n - 1)
    expect(S().get('r0')).toBeUndefined()

    for (let i = 1; i < ueber; i++) beende(`r${i}`)
    expect(S().forConv('c1')).toHaveLength(AGENT_TASKS_MAX_PER_CONV)

    // Sobald die Liste wieder auf dem Deckel sitzt, bleibt eine fertige Aufgabe
    // stehen und kann gemeldet werden.
    beende(`r${ueber}`)
    expect(S().forConv('c1')).toHaveLength(AGENT_TASKS_MAX_PER_CONV)
    expect(S().get(`r${ueber}`)?.status).toBe('done')
    expect(S().takeUnreported('c1').map((t) => t.id)).toEqual([`r${ueber}`])
  })

  it('der Ring zaehlt je Konversation, nicht ueber alle', () => {
    for (let i = 0; i < AGENT_TASKS_MAX_PER_CONV + 5; i++) {
      starte(`a${i}`, 'c1')
      beende(`a${i}`)
    }
    starte('b1', 'c2')
    beende('b1')
    expect(S().forConv('c1')).toHaveLength(AGENT_TASKS_MAX_PER_CONV)
    expect(S().forConv('c2')).toHaveLength(1)
  })
})
