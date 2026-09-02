/**
 * Hintergrund-Delegation: der Platz gehoert dem LAUF, nicht dem AUFRUF.
 *
 * `delegate_task` mit `background: true` kehrt sofort zurueck — der Sub-Agent
 * rechnet danach noch minutenlang weiter, sichtbar im rechten Panel, per
 * message_agent erreichbar, per Abbrechen-Knopf zu stoppen. Genau diese
 * Trennung von "der Aufruf ist fertig" und "die Arbeit ist fertig" ist die
 * Stelle, an der die Nebenlaeufigkeitskappe kaputtgeht, wenn man nicht
 * hinsieht. Deshalb liegt hier der Schwerpunkt.
 *
 * Aufbau wie im Nachbarn sub-agent.test.ts: der Runner ist gestubbt, die
 * Werkzeug-Registry gedoppelt, und `_setDepth()` setzt den Modulzaehler vor
 * jedem Fall zurueck. Der Aufgaben-Store ist ECHT — er ist nicht das, was hier
 * geprueft wird, aber die Lebensdauer einer Aufgabe ist genau sein Werk, und
 * eine Attrappe haette den halben Testgegenstand mitgenommen.
 *
 * Lauf: npx vitest run src/api/agents/__tests__/background-delegation.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Dieselbe Naht wie im Nachbarn: sub-agent.ts haelt `toolRegistry` seit der
// INEFFECTIVE_DYNAMIC_IMPORT-Aufloesung statisch aus mcp/tool-registry. Ein
// gestubbter Runner ruft nie hinein, aber der Modulgraph laedt sie beim
// Import — die Attrappe haelt den Test von der echten Registry frei.
vi.mock('../../mcp/tool-registry', () => ({
  toolRegistry: {
    getAll: () => [],
    resolveExecutable: () => undefined,
    execute: async () => 'tool output',
    getPermissionLevelWithOverrides: () => 'auto',
  },
}))

/**
 * Der Verlauf als Attrappe: geprueft wird HIER, ob eine fertige
 * Hintergrundaufgabe ueberhaupt eine Zeile absetzt und wie die aussieht —
 * nicht, ob Zustand sie nach IndexedDB schreibt. Der echte Store haengt am
 * persist-Middleware-Pfad, den ein Node-Testlauf gar nicht hat.
 */
const verlaufsZeilen: Array<{ convId: string; msg: Record<string, unknown> }> = []
vi.mock('../../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      addMessage: (convId: string, msg: Record<string, unknown>) => {
        verlaufsZeilen.push({ convId, msg })
      },
    }),
  },
}))

import {
  SUB_AGENT_MAX_PARALLEL,
  SUB_AGENT_BUDGET,
  buildDelegateExecutor,
  resolveSubAgentBudget,
  _getDepth,
  _setDepth,
  type SubAgentRunner,
} from '../sub-agent'
import {
  buildCheckTasksExecutor,
  buildMessageAgentExecutor,
} from '../agent-task-tools'
import { useAgentTaskStore } from '../../../stores/agentTaskStore'
import type { AgentRunContext } from '../../agent-context'

const HERE = dirname(fileURLToPath(import.meta.url))

const makeRun = (over: Partial<AgentRunContext> = {}): AgentRunContext => ({
  token: 'run-test',
  chatId: null,
  conversationId: 'conv-1',
  workspace: null,
  artifactMode: false,
  readOnlyShellTurn: false,
  mode: null,
  artifacts: [],
  ...over,
})

const tick = () => new Promise((r) => setTimeout(r, 0))

/** Wartet auf einen Zustand statt auf eine Zeit — dieselbe Form wie waitForPrompt. */
async function warteBis(pruefung: () => boolean, was: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (pruefung()) return
    await tick()
  }
  throw new Error(`Zeitueberschreitung beim Warten auf: ${was}`)
}

/**
 * Ein Runner, der erst zurueckkehrt, wenn dieser Test es erlaubt.
 *
 * Das ist das ganze Werkzeug fuer Teil A: nur so laesst sich der Zustand
 * "Aufruf zurueck, Lauf laeuft noch" ueberhaupt beobachten.
 */
function haltbarerRunner() {
  const aufloeser: Array<(v: string) => void> = []
  const runner: SubAgentRunner = () =>
    new Promise<string>((resolve) => { aufloeser.push(resolve) })
  return {
    runner,
    gestartet: () => aufloeser.length,
    alleFertigWerdenLassen: (antwort = 'fertig') => {
      for (const r of aufloeser) r(antwort)
    },
  }
}

beforeEach(() => {
  _setDepth(0)
  useAgentTaskStore.setState({ byConv: {} })
  verlaufsZeilen.length = 0
})

// ── A) Die Lebensdauer des Platzes ────────────────────────────────────────

describe('Hintergrund-Delegation — der Platz bleibt belegt, bis der LAUF endet', () => {
  /**
   * WARUM diese Sperrklinke: der erste Entwurf zaehlte in einem
   * try/finally um `await runner(...)` herunter. Fuer einen Vordergrundlauf
   * ist das richtig; fuer einen Hintergrundlauf kehrt der Aufruf sofort
   * zurueck, das finally lief also sofort mit, und der Platz war frei,
   * waehrend der Agent noch rechnete. SUB_AGENT_MAX_PARALLEL waere damit
   * genau fuer den Pfad tot gewesen, der es am noetigsten braucht: im
   * Vordergrund haelt der wartende Elternzug die Zahl ohnehin klein, im
   * Hintergrund haelt sie gar nichts — ein Modell koennte in einem einzigen
   * Zug zwanzig Agenten losschicken. Der Zaehler haengt darum am
   * `.finally()` der Laufkette, nicht am Ende des Aufrufs.
   */
  it('vier Hintergrundlaeufe belegen vier Plaetze, obwohl alle vier Aufrufe zurueck sind', async () => {
    const { runner, gestartet } = haltbarerRunner()
    const exec = buildDelegateExecutor(runner)
    const run = makeRun()

    for (let i = 0; i < SUB_AGENT_MAX_PARALLEL; i++) {
      const out = await exec({ goal: `ziel ${i}`, background: true }, run)
      expect(out).toMatch(/^Started background task task-/)
    }

    // Alle vier Aufrufe sind zurueck …
    expect(gestartet()).toBe(SUB_AGENT_MAX_PARALLEL)
    // … und trotzdem sind alle vier Plaetze belegt.
    expect(_getDepth()).toBe(SUB_AGENT_MAX_PARALLEL)
    expect(
      useAgentTaskStore.getState().forConv('conv-1').filter((t) => t.status === 'running'),
    ).toHaveLength(SUB_AGENT_MAX_PARALLEL)

    // Der fuenfte prallt ab — und startet nichts.
    const fuenfter = await exec({ goal: 'einer zu viel', background: true }, run)
    expect(fuenfter).toMatch(/Maximum sub-agent concurrency/)
    expect(gestartet()).toBe(SUB_AGENT_MAX_PARALLEL)
    expect(useAgentTaskStore.getState().forConv('conv-1')).toHaveLength(SUB_AGENT_MAX_PARALLEL)
  })

  it('sind die Laeufe fertig, faellt der Zaehler und die naechste Delegation wird angenommen', async () => {
    const { runner, alleFertigWerdenLassen } = haltbarerRunner()
    const exec = buildDelegateExecutor(runner)
    const run = makeRun()

    for (let i = 0; i < SUB_AGENT_MAX_PARALLEL; i++) {
      await exec({ goal: `ziel ${i}`, background: true }, run)
    }
    expect(await exec({ goal: 'zu frueh', background: true }, run))
      .toMatch(/Maximum sub-agent concurrency/)

    alleFertigWerdenLassen('antwort')
    await warteBis(() => _getDepth() === 0, 'freigegebene Plaetze')

    // Der Store hat die Antworten und meldet sie als erledigt.
    const fertige = useAgentTaskStore.getState().forConv('conv-1')
    expect(fertige).toHaveLength(SUB_AGENT_MAX_PARALLEL)
    expect(fertige.every((t) => t.status === 'done' && t.output === 'antwort')).toBe(true)

    const nochEiner = await exec({ goal: 'jetzt aber', background: true }, run)
    expect(nochEiner).toMatch(/^Started background task task-/)
    expect(_getDepth()).toBe(1)
  })
})

// ── B) Die Reihenfolge von Pruefung und Hochzaehlen ───────────────────────

describe('Hintergrund-Delegation — pruefen, zaehlen, DANN awaiten', () => {
  /**
   * Die Kappe ist nur so gut wie die Reihenfolge, in der sie gelesen und
   * gesetzt wird. Der erste Anlauf holte zwischen beidem die Einstellungen
   * (`await import(...)`, also ein Mikrotask). Fuenf im selben Zug
   * abgesetzte Aufrufe laufen bis zum ersten `await` synchron durch: alle
   * fuenf lasen `_inFlight === 0`, alle fuenf kamen an der Schranke vorbei,
   * und erst danach zaehlte der erste hoch. Die Kappe war weg, ohne dass
   * eine Zeile davon falsch aussah.
   *
   * Das laesst sich mit einem gestubbten Runner nicht mehr zuverlaessig
   * nachstellen — der Verhaltenstest dafuer steht als
   * 'a 5th parallel sibling is refused' im Nachbarn. Hier wird die REGEL
   * selbst festgenagelt, damit sie einen kuenftigen Umbau ueberlebt: im
   * Quelltext liegt zwischen der Schranke und dem `_inFlight++` kein `await`.
   */
  it('zwischen der Schranke und dem Hochzaehlen steht kein await', () => {
    const quelle = readFileSync(join(HERE, '..', 'sub-agent.ts'), 'utf8')
    const executor = quelle.slice(quelle.indexOf('export function buildDelegateExecutor'))
    expect(executor).not.toBe('')

    // Die Schranke liest seit 2.6.8 `effectiveParallelCap`, weil eine
    // ausdrueckliche Ansage des Nutzers („nutze 5 agenten") sie anheben darf.
    // Gesucht wird deshalb der Vergleich selbst und nicht mehr die Konstante —
    // der Waechter haengt an der REGEL, nicht an einem Namen.
    const schranke = executor.indexOf('if (_inFlight >= ')
    const hochzaehlen = executor.indexOf('_inFlight++')
    expect(schranke).toBeGreaterThanOrEqual(0)
    expect(hochzaehlen).toBeGreaterThanOrEqual(0)
    // Gelesen wird vor dem Setzen — sonst waere die Schranke keine.
    expect(schranke).toBeLessThan(hochzaehlen)

    // Ohne Kommentare, denn der erklaerende Text dazwischen nennt `await`
    // ausdruecklich beim Namen; die Regel gilt fuer den Code, nicht fuer die
    // Begruendung.
    const dazwischen = executor
      .slice(schranke, hochzaehlen)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(dazwischen).not.toMatch(/\bawait\b/)

    // Und die Kappe selbst wird SYNCHRON ermittelt. Waere
    // `effectiveParallelCap` je asynchron, laege das `await` vor der
    // Schranke statt dahinter — dieselbe Luecke, nur eine Zeile hoeher.
    const quelltext = readFileSync(join(HERE, '..', 'sub-agent.ts'), 'utf8')
    expect(quelltext).toMatch(/export function effectiveParallelCap/)
    expect(quelltext).not.toMatch(/export async function effectiveParallelCap/)
  })
})

// ── C) Ohne Konversation wird nichts gestartet ────────────────────────────

describe('Hintergrund-Delegation — fail closed ohne Konversation', () => {
  /**
   * Ein Hintergrundagent ohne Konversation waere unsichtbar: kein Panel, kein
   * Abbrechen-Knopf, und kein Weg, das Ergebnis je zu melden — die Meldung
   * reitet als NUTZER-Material im Verlauf genau dieser Konversation mit
   * (role:'system' ausserhalb Index 0 weisen strenge Jinja-Vorlagen ab,
   * role:'tool' braeuchte eine echte tool_call_id). Er wuerde also rechnen,
   * Werkzeuge feuern und dann ins Leere antworten. Die Absage muss dabei den
   * Zaehler wieder abgeben: `_inFlight++` steht VOR der Pruefung, und ein
   * vergessenes Dekrement haette nach vier solchen Fehlversuchen jede
   * weitere Delegation der Sitzung abgewiesen — mit einer Meldung ueber
   * Nebenlaeufigkeit, die niemand mit der fehlenden Konversation in
   * Verbindung gebracht haette.
   */
  it('background:true ohne run startet nichts, benennt das Problem und gibt den Platz zurueck', async () => {
    const runner = vi.fn(async () => 'darf nicht laufen')
    const exec = buildDelegateExecutor(runner)

    const out = await exec({ goal: 'x', background: true })

    expect(out).toMatch(/^Error:/)
    expect(out).toMatch(/background delegation needs a conversation/)
    expect(runner).not.toHaveBeenCalled()
    expect(_getDepth()).toBe(0)
    expect(useAgentTaskStore.getState().byConv).toEqual({})
  })

  it('gilt auch fuer einen run mit conversationId null — und wiederholt sich ohne Zaehlerleck', async () => {
    const runner = vi.fn(async () => 'darf nicht laufen')
    const exec = buildDelegateExecutor(runner)
    const run = makeRun({ conversationId: null })

    for (let i = 0; i < SUB_AGENT_MAX_PARALLEL + 1; i++) {
      const out = await exec({ goal: 'x', background: true }, run)
      expect(out).toMatch(/background delegation needs a conversation/)
    }
    // Nach fuenf Fehlversuchen waere bei einem Leck die Kappe erreicht und
    // die Meldung waere auf einmal eine ganz andere.
    expect(_getDepth()).toBe(0)
    expect(runner).not.toHaveBeenCalled()
  })

  it('ohne background laeuft derselbe Aufruf ohne Konversation ganz normal', async () => {
    // Die Absage gilt der HINTERGRUND-Delegation, nicht der Delegation. Ein
    // Vordergrundlauf hat einen wartenden Aufrufer, der die Antwort
    // entgegennimmt — er braucht kein Panel, um sie loszuwerden.
    const runner = vi.fn(async () => 'antwort')
    const exec = buildDelegateExecutor(runner)
    expect(await exec({ goal: 'x' })).toBe('antwort')
    expect(_getDepth()).toBe(0)
  })
})

// ── D) Die Kappen eines delegierten Laufs ─────────────────────────────────

describe('resolveSubAgentBudget', () => {
  /**
   * 0 heisst hier "nimm die Vorgabe", nicht "unbegrenzt" — anders als bei den
   * Kappen des Hauptlaufs. Der Unterschied ist Absicht: beim Hauptlauf sitzt
   * der Nutzer davor und kann Stop druecken, ein Sub-Agent laeuft ohne
   * Zuschauer, im Hintergrund sogar ohne dass jemand auf ihn wartet.
   * Unbegrenztheit soll man dort nicht aus Versehen einstellen koennen,
   * indem man ein Eingabefeld leert.
   */
  it('faellt fuer undefined, 0, negativ und NaN auf SUB_AGENT_BUDGET zurueck', () => {
    const vorgabe = { maxToolCalls: SUB_AGENT_BUDGET.maxToolCalls, maxIterations: SUB_AGENT_BUDGET.maxIterations }
    expect(resolveSubAgentBudget()).toEqual(vorgabe)
    expect(resolveSubAgentBudget({})).toEqual(vorgabe)
    expect(resolveSubAgentBudget({ subAgentMaxToolCalls: 0, subAgentMaxIterations: 0 })).toEqual(vorgabe)
    expect(resolveSubAgentBudget({ subAgentMaxToolCalls: -3, subAgentMaxIterations: -1 })).toEqual(vorgabe)
    expect(resolveSubAgentBudget({ subAgentMaxToolCalls: NaN, subAgentMaxIterations: NaN })).toEqual(vorgabe)
  })

  it('nimmt eine positive Einstellung, auch wenn sie groesser als die Vorgabe ist', () => {
    expect(resolveSubAgentBudget({ subAgentMaxToolCalls: 3, subAgentMaxIterations: 2 }))
      .toEqual({ maxToolCalls: 3, maxIterations: 2 })
    expect(resolveSubAgentBudget({ subAgentMaxToolCalls: 99, subAgentMaxIterations: 40 }))
      .toEqual({ maxToolCalls: 99, maxIterations: 40 })
  })

  it('rundet Bruchzahlen ab, statt sie durchzulassen', () => {
    // Eine halbe Iteration gibt es nicht, und `i < 5.9` liefe sechsmal —
    // eine Kappe, die um eins zu hoch greift, ist die falsche Kappe.
    expect(resolveSubAgentBudget({ subAgentMaxToolCalls: 7.9, subAgentMaxIterations: 3.5 }))
      .toEqual({ maxToolCalls: 7, maxIterations: 3 })
  })

  it('entscheidet die beiden Felder getrennt', () => {
    expect(resolveSubAgentBudget({ subAgentMaxToolCalls: 6 }))
      .toEqual({ maxToolCalls: 6, maxIterations: SUB_AGENT_BUDGET.maxIterations })
    expect(resolveSubAgentBudget({ subAgentMaxIterations: 2 }))
      .toEqual({ maxToolCalls: SUB_AGENT_BUDGET.maxToolCalls, maxIterations: 2 })
  })
})

// ── E) Die Steuerwerkzeuge ────────────────────────────────────────────────

describe('message_agent', () => {
  const laufendeAufgabe = (id: string, convId: string) => {
    useAgentTaskStore.getState().start({
      id, convId, goal: 'irgendwas', context: '', background: true, startedAt: Date.now(),
      controller: new AbortController(),
    })
  }

  /**
   * Ein Modell, das "Error: not found" liest, raet weiter. Deshalb benennt
   * jede Absage hier das FEHLENDE STUECK. Bei den beiden Pflichtfeldern ist
   * das billig zu haben und spart einen ganzen Fehlversuch: `task_id` ohne
   * `message` sieht sonst genauso aus wie eine tote Kennung.
   */
  it('benennt das fehlende Feld statt nur "ungueltig" zu sagen', async () => {
    const exec = buildMessageAgentExecutor()
    expect(await exec({ message: 'mach weiter' })).toMatch(/requires a "task_id"/)
    expect(await exec({ task_id: '   ', message: 'mach weiter' })).toMatch(/requires a "task_id"/)
    expect(await exec({ task_id: 'task-1' })).toMatch(/requires a "message"/)
    expect(await exec({ task_id: 'task-1', message: '  ' })).toMatch(/requires a "message"/)
  })

  it('sagt bei unbekannter Kennung, dass nichts fortgesetzt wurde — und startet auch nichts', async () => {
    // Kein stilles Neustarten: eine Aufgabe, die aus dem Ring gefallen ist,
    // hat ihr Gespraech verloren. Bei null anzufangen und es "Fortsetzung" zu
    // nennen waere die teuerste Art, freundlich zu sein — das Modell glaubt
    // dann, sein Zusatzauftrag sei angekommen.
    const exec = buildMessageAgentExecutor()
    const out = await exec({ task_id: 'task-weg', message: 'noch etwas' }, makeRun())
    expect(out).toMatch(/^Error:/)
    expect(out).toMatch(/no background task task-weg/)
    expect(out).toMatch(/Start a new one/)
    expect(useAgentTaskStore.getState().byConv).toEqual({})
  })

  it('weist eine Aufgabe aus einer fremden Konversation ab', async () => {
    // Eine Aufgabe gehoert dem Gespraech, in dem sie gestartet wurde. Sonst
    // koennte ein Zug in Chat A einem Agenten in Chat B hineinreden — und der
    // Nutzer von Chat B saehe eine Anweisung, die er nie gegeben hat.
    laufendeAufgabe('task-fremd', 'conv-B')
    const exec = buildMessageAgentExecutor()
    const out = await exec({ task_id: 'task-fremd', message: 'hallo' }, makeRun({ conversationId: 'conv-A' }))
    expect(out).toMatch(/belongs to another conversation/)
    // Und die Nachricht liegt nicht doch im Posteingang.
    expect(useAgentTaskStore.getState().get('task-fremd')?.inbox).toEqual([])
  })

  it('legt die Nachricht bei einer eigenen laufenden Aufgabe in den Posteingang', async () => {
    laufendeAufgabe('task-eigen', 'conv-1')
    const exec = buildMessageAgentExecutor()
    const out = await exec({ task_id: 'task-eigen', message: 'nur die erste Datei' }, makeRun())
    expect(out).toMatch(/Delivered to task-eigen/)
    expect(useAgentTaskStore.getState().get('task-eigen')?.inbox).toEqual(['nur die erste Datei'])
  })
})

describe('check_tasks', () => {
  /**
   * Beide leeren Faelle sind normal, nicht aussergewoehnlich: das Modell darf
   * nachsehen, bevor es etwas delegiert hat. Ein geworfener Fehler landete
   * als Werkzeugfehler im Verlauf und liesse ein kleines Modell glauben, das
   * Werkzeug sei kaputt — es probiert dann Varianten, statt weiterzuarbeiten.
   */
  it('antwortet ohne Konversation mit einem Satz statt zu werfen', async () => {
    const exec = buildCheckTasksExecutor()
    const out = await exec({})
    expect(out).toBe('No conversation, so there are no background tasks to list.')
  })

  it('antwortet ohne Aufgaben mit einem Satz statt zu werfen', async () => {
    const exec = buildCheckTasksExecutor()
    const out = await exec({}, makeRun())
    expect(out).toBe('No background tasks in this conversation.')
  })

  it('zaehlt die eigenen Aufgaben auf und traegt die Antwort einer fertigen gleich mit', async () => {
    // Sonst haette das Modell nur die Kennung und muesste ein zweites
    // Werkzeug rufen, um an das Ergebnis zu kommen — dafuer reicht ein
    // kleines Modell nicht.
    const store = useAgentTaskStore.getState()
    store.start({ id: 'task-a1b2c3d4', convId: 'conv-1', goal: 'Datei lesen', context: '', background: true, startedAt: Date.now(), controller: new AbortController() })
    store.start({ id: 'task-e5f6a7b8', convId: 'conv-1', goal: 'Tests zaehlen', context: '', background: true, startedAt: Date.now(), controller: new AbortController() })
    store.finish('task-e5f6a7b8', { status: 'done', output: '17 Tests', endedAt: Date.now() })

    const out = await buildCheckTasksExecutor()({}, makeRun())
    // Die Zeile traegt die GANZE Kennung. Sie ist das, was das Modell an
    // `message_agent` zurueckgeben muss — eine gekuerzte waere eine Sackgasse.
    expect(out).toMatch(/\[task-a1b2c3d4\] running \(\d+s\), Datei lesen/)
    expect(out).toMatch(/\[task-e5f6a7b8\] ok \(\d+s\), Tests zaehlen/)
    expect(out).toMatch(/17 Tests/)
  })
})


// ── E) Die Meldung, wenn der Elternzug schon vorbei ist ────────────────────

describe('Fertige Hintergrundaufgabe — jemand erfaehrt davon, auch im Leerlauf', () => {
  /**
   * WARUM diese Sperrklinke: der Weg zum MODELL laeuft ueber
   * `appendTaskReport`, und das steht oben in der ReAct-Schleife. Eine
   * Hintergrundaufgabe endet aber typischerweise DANACH — sie laeuft ja
   * laenger als der Zug, der sie startete. Es gab damit ein Zeitfenster, in
   * dem ein Agent fertig gerechnet hatte und niemand es erfuhr: das Modell
   * nicht, weil keine Schleife lief, und der Mensch nicht, wenn das Panel
   * zugeklappt war. Diese Zeile im Verlauf schliesst es.
   */
  it('schreibt eine Zeile in den Verlauf, wenn der Lauf endet — nicht schon beim Aufruf', async () => {
    const { runner, alleFertigWerdenLassen } = haltbarerRunner()
    const exec = buildDelegateExecutor(runner)

    await exec({ goal: 'Tests zaehlen', context: '', background: true }, makeRun())
    // Der Aufruf ist zurueck, der Lauf laeuft: es darf noch NICHTS gemeldet
    // sein. Sonst meldete die Zeile den Start, nicht das Ergebnis.
    await tick()
    expect(verlaufsZeilen).toHaveLength(0)

    alleFertigWerdenLassen('17 Tests, alle gruen')
    await warteBis(() => verlaufsZeilen.length > 0, 'die Meldung im Verlauf')

    const [{ convId, msg }] = verlaufsZeilen
    expect(convId).toBe('conv-1')
    // `role:'system'` mit `notice`: der Verlauf zeigt die Zeile, die Nutzlast
    // verwirft sie. Als Assistentenblase waere es eine Luege — das Modell hat
    // diesen Satz nie gesagt.
    expect(msg.role).toBe('system')
    expect(msg.notice).toBe('info')
    expect(String(msg.content)).toContain('finished')
    expect(String(msg.content)).toContain('Tests zaehlen')
    // Das ERGEBNIS steht mit drin. Ohne das waere die Zeile eine
    // Benachrichtigung ohne Inhalt, und der Mensch muesste das Panel
    // aufklappen, um zu erfahren, was eigentlich herauskam.
    expect(String(msg.content)).toContain('17 Tests, alle gruen')
  })

  it('meldet einen Fehlschlag als warn, mit dem Grund', async () => {
    const runner: SubAgentRunner = () => Promise.reject(new Error('Modell nicht erreichbar'))
    const exec = buildDelegateExecutor(runner)

    await exec({ goal: 'Datei lesen', context: '', background: true }, makeRun())
    await warteBis(() => verlaufsZeilen.length > 0, 'die Fehlermeldung im Verlauf')

    const { msg } = verlaufsZeilen[0]
    // 'warn' und nicht 'info': ein gescheiterter Agent ist etwas, das der
    // Mensch wissen MUSS, sonst wartet er auf eine Antwort, die nie kommt.
    expect(msg.notice).toBe('warn')
    expect(String(msg.content)).toContain('failed')
    expect(String(msg.content)).toContain('Modell nicht erreichbar')
  })

  it('meldet einen VORDERGRUNDlauf nicht in den Verlauf', async () => {
    // Der Vordergrundaufruf gibt sein Ergebnis als Werkzeugausgabe zurueck,
    // das Modell hat es also ohnehin in der Hand. Eine zusaetzliche Zeile
    // waere die Antwort doppelt — einmal als Werkzeugergebnis, einmal als
    // Hinweis — und der Nutzer laese dasselbe zweimal.
    const exec = buildDelegateExecutor(async () => 'direkt geantwortet')
    const out = await exec({ goal: 'kurz', context: '' }, makeRun())
    expect(out).toContain('direkt geantwortet')
    await tick()
    expect(verlaufsZeilen).toHaveLength(0)
  })

  it('laesst eine gelungene Aufgabe nicht an ihrer Benachrichtigung scheitern', async () => {
    // Zwei getrennte Zusagen, beide noetig, und die erste allein reicht NICHT:
    //
    //  1. Die Reihenfolge — `finish()` steht VOR der Meldung. Wirft der
    //     Verlauf, hat der Store das Ergebnis laengst.
    //  2. Das try/catch in `meldeInDenVerlauf` — die Meldung wird ge`void`et,
    //     eine geworfene Ausnahme waere also eine unbehandelte Ablehnung.
    //     Punkt 1 faengt die nicht: die Aufgabe stuende trotzdem auf 'done',
    //     und der Test waere gruen, waehrend Node im Ernstfall den Prozess
    //     mit einer Ablehnung ohne Empfaenger stehen laesst.
    const abgelehnt: unknown[] = []
    const horcher = (grund: unknown) => { abgelehnt.push(grund) }
    process.on('unhandledRejection', horcher)

    const { useChatStore } = await import('../../../stores/chatStore')
    const echt = useChatStore.getState
    ;(useChatStore as { getState: unknown }).getState = () => { throw new Error('Verlauf kaputt') }
    try {
      const exec = buildDelegateExecutor(async () => 'trotzdem fertig')
      await exec({ goal: 'robust', context: '', background: true }, makeRun())
      await warteBis(
        () => useAgentTaskStore.getState().forConv('conv-1').some((t) => t.status === 'done'),
        'den Abschluss trotz kaputtem Verlauf',
      )
      const [aufgabe] = useAgentTaskStore.getState().forConv('conv-1')
      expect(aufgabe.output).toBe('trotzdem fertig')

      // Node meldet eine unbehandelte Ablehnung erst, wenn der Microtask-Stapel
      // leer ist — ein Makrotask spaeter ist sie da, wenn es sie gibt.
      await new Promise((r) => setTimeout(r, 10))
      expect(abgelehnt).toHaveLength(0)
    } finally {
      ;(useChatStore as { getState: unknown }).getState = echt
      process.off('unhandledRejection', horcher)
    }
  })
})

// ── F) Stopp trifft die Antwort, nicht die Hintergrundarbeit ──────────────

/**
 * Ein Runner, der das Signal festhaelt, mit dem er losgeschickt wurde.
 *
 * Der Griff der Aufgabe liegt in einer modulprivaten Karte des Stores. Das
 * Signal, das der LAUF bekommt, ist derselbe Griff — und zugleich das, worauf
 * es hier ankommt: ob der Sub-Agent stehenbleibt oder nicht.
 */
function signalFangenderRunner() {
  let signal: AbortSignal | undefined
  const aufloeser: Array<(v: string) => void> = []
  const runner: SubAgentRunner = (_g, _c, opts) => {
    signal = opts?.run?.abortSignal
    return new Promise<string>((resolve) => { aufloeser.push(resolve) })
  }
  return {
    runner,
    signal: () => signal,
    fertigWerdenLassen: (antwort = 'fertig') => { for (const r of aufloeser) r(antwort) },
  }
}

describe('Stopp auf den Elternzug laesst Hintergrundagenten weiterlaufen', () => {
  /**
   * WARUM: bis 2026-09-02 reichte diese Stelle das Abbruchsignal des
   * Elternzugs an die Hintergrundaufgabe durch. Der Ablauf, an dem das
   * auffiel: der Nutzer bestellt drei Hintergrund-Recherchen, die Hauptantwort
   * schweift ab, er drueckt Stopp — und bekommt drei abgebrochene Agenten mit
   * halben Ergebnissen. Er wollte den Satz stoppen, nicht die Arbeit.
   *
   * Die Claude-Code-Desktop-App trennt genau das: Esc beendet die Antwort, die
   * Hintergrundagenten laufen weiter und werden einzeln gestoppt.
   */
  it('das Abbruchsignal des Elternzugs erreicht eine HINTERGRUND-Aufgabe nicht', async () => {
    const { runner, signal, fertigWerdenLassen } = signalFangenderRunner()
    const exec = buildDelegateExecutor(runner)
    const abbruch = new AbortController()

    await exec(
      { goal: 'lange Recherche', context: '', background: true },
      makeRun({ abortSignal: abbruch.signal }),
    )
    const [aufgabe] = useAgentTaskStore.getState().forConv('conv-1')
    expect(aufgabe.status).toBe('running')
    // Der Lauf bekommt ein EIGENES Signal, nicht das des Elternzugs.
    expect(signal()).toBeDefined()
    expect(signal()).not.toBe(abbruch.signal)

    abbruch.abort()
    await tick()

    expect(signal()!.aborted).toBe(false)
    expect(useAgentTaskStore.getState().get(aufgabe.id)?.status).toBe('running')

    // Und sie kommt ganz normal zu Ende, nicht als 'cancelled'.
    fertigWerdenLassen('Ergebnis trotz Stopp')
    await warteBis(
      () => useAgentTaskStore.getState().get(aufgabe.id)?.status === 'done',
      'den Abschluss nach dem Stopp',
    )
    expect(useAgentTaskStore.getState().get(aufgabe.id)?.output).toBe('Ergebnis trotz Stopp')
  })

  it('der eigene Abbrechen-Knopf greift weiterhin', async () => {
    // Die Gegenprobe: haette man das Signal einfach gar nicht mehr verdrahtet,
    // waere die Aufgabe unstoppbar — schlimmer als vorher.
    const { runner, signal } = signalFangenderRunner()
    const exec = buildDelegateExecutor(runner)
    await exec({ goal: 'x', context: '', background: true }, makeRun())

    const [aufgabe] = useAgentTaskStore.getState().forConv('conv-1')
    expect(useAgentTaskStore.getState().cancel(aufgabe.id)).toBe(true)
    expect(signal()!.aborted).toBe(true)
  })

  it('das Loeschen des Chats bricht sehr wohl ab', async () => {
    // Der Grund, warum die Weiterleitung ueberhaupt gestrichen werden durfte:
    // ein Agent ohne Chat haette niemanden mehr, dem er berichten koennte.
    // `dropConversationSideState` ruft `clearConv`, und das bricht ab, bevor
    // es vergisst.
    const { runner, signal } = signalFangenderRunner()
    const exec = buildDelegateExecutor(runner)
    await exec({ goal: 'y', context: '', background: true }, makeRun())

    useAgentTaskStore.getState().clearConv('conv-1')
    expect(signal()!.aborted).toBe(true)
    expect(useAgentTaskStore.getState().forConv('conv-1')).toHaveLength(0)
  })

  it('ein VORDERGRUND-Agent erbt das Signal des Elternzugs weiterhin', async () => {
    // Dort ist das Durchreichen richtig: der Elternzug wartet auf ihn, ein
    // Stopp muss ihn also mitnehmen. Er bekommt `run` unveraendert.
    let gesehen: AbortSignal | undefined
    const exec = buildDelegateExecutor(async (_g, _c, opts) => {
      gesehen = opts?.run?.abortSignal
      return 'fertig'
    })
    const abbruch = new AbortController()
    await exec({ goal: 'z', context: '' }, makeRun({ abortSignal: abbruch.signal }))
    expect(gesehen).toBe(abbruch.signal)
  })
})
