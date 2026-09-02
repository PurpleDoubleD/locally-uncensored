/**
 * Die Weckregeln.
 *
 * Der Gegenstand ist klein und die Folgen sind es nicht: jedes Wecken ist eine
 * Inferenz, die der Mensch nicht angefordert hat. Auf einem lokalen Modell
 * heisst das Luefter, Akku und eine halbe Minute; bei einem bezahlten Anbieter
 * Geld. Deshalb liegt hier der Schwerpunkt nicht auf "weckt es", sondern auf
 * "weckt es NICHT, wenn es nicht darf".
 *
 * Lauf: npx vitest run src/lib/__tests__/agent-wake.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shouldWakeParent, isUnreportedTerminal, createWakeWatcher, WAKE_PROMPT, WAKE_BUNDLE_MS } from '../agent-wake'
import type { AgentTask } from '../agent-tasks'
import { makeTaskId } from '../agent-tasks'

const aufgabe = (over: Partial<AgentTask> = {}): AgentTask => ({
  id: makeTaskId(1),
  convId: 'conv-1',
  goal: 'etwas nachsehen',
  context: '',
  status: 'done',
  background: true,
  startedAt: 0,
  endedAt: 1000,
  output: 'Antwort',
  toolCalls: 2,
  iterations: 1,
  inbox: [],
  reported: false,
  ...over,
})

const basis = {
  conversationId: 'conv-1',
  isRunning: false,
  activeModel: 'llama3:8b',
}

describe('shouldWakeParent — wann ein fertiger Agent den Hauptagenten zurueckholt', () => {
  it('weckt bei einem fertigen, noch nicht gemeldeten Ergebnis', () => {
    expect(shouldWakeParent({ ...basis, tasks: [aufgabe()] }))
      .toEqual({ wake: true, reason: 'has-results' })
  })

  it('weckt NICHT, solange schon ein Zug laeuft', () => {
    // Der teuerste Fehler von allen: die laufende Schleife holt die Ergebnisse
    // beim naechsten Durchgang selbst ab (`appendTaskReport` steht oben in der
    // Iteration). Ein zweiter Zug schriebe parallel in dieselbe
    // Antwortblase — zwei Modelle, ein Textfeld.
    expect(shouldWakeParent({ ...basis, isRunning: true, tasks: [aufgabe()] }))
      .toEqual({ wake: false, reason: 'run-active' })
  })

  it('weckt NICHT ohne aktives Modell', () => {
    // Sonst endete ein Weckversuch in einer Fehlermeldung, die der Mensch
    // nicht angefordert hat.
    expect(shouldWakeParent({ ...basis, activeModel: null, tasks: [aufgabe()] }))
      .toEqual({ wake: false, reason: 'no-model' })
    expect(shouldWakeParent({ ...basis, activeModel: '', tasks: [aufgabe()] }).wake).toBe(false)
  })

  it('weckt NICHT wegen einer Aufgabe, die noch laeuft', () => {
    expect(shouldWakeParent({ ...basis, tasks: [aufgabe({ status: 'running', endedAt: undefined })] }))
      .toEqual({ wake: false, reason: 'nothing-new' })
  })

  it('weckt NICHT wegen eines Ergebnisses, das schon gemeldet wurde', () => {
    // DER Dauerlauf-Schutz. `reported` wird vom Bericht INNERHALB des Laufs
    // gesetzt; ohne diese Bedingung faende der naechste Blick dieselbe
    // Aufgabe wieder und weckte erneut — ein Modell, das sich selbst im Kreis
    // aufweckt, bis der Mensch die App schliesst.
    expect(shouldWakeParent({ ...basis, tasks: [aufgabe({ reported: true })] }))
      .toEqual({ wake: false, reason: 'nothing-new' })
  })

  it('weckt auch fuer eine gescheiterte oder abgebrochene Aufgabe', () => {
    // Ein Fehlschlag ist eine Auskunft, keine Nicht-Auskunft: der Hauptagent
    // wartet sonst auf eine Antwort, die nie kommt, und plant weiter mit einem
    // Ergebnis, das es nicht gibt.
    expect(shouldWakeParent({ ...basis, tasks: [aufgabe({ status: 'failed', error: 'kaputt' })] }).wake).toBe(true)
    expect(shouldWakeParent({ ...basis, tasks: [aufgabe({ status: 'cancelled' })] }).wake).toBe(true)
  })

  it('weckt einmal, egal wie viele gleichzeitig fertig sind', () => {
    // Die Bedingung ist "es gibt etwas", nicht "wie viel". Das Buendeln selbst
    // macht die Sammelfrist; hier zaehlt nur, dass fuenf Ergebnisse dieselbe
    // eine Entscheidung ergeben wie eines.
    const fuenf = [aufgabe(), aufgabe(), aufgabe(), aufgabe(), aufgabe()]
    expect(shouldWakeParent({ ...basis, tasks: fuenf }))
      .toEqual({ wake: true, reason: 'has-results' })
  })

  it('weckt nicht ohne Gespraech', () => {
    expect(shouldWakeParent({ ...basis, conversationId: null, tasks: [aufgabe()] }))
      .toEqual({ wake: false, reason: 'no-conversation' })
  })

  it('prueft die teuren Gruende ZUERST', () => {
    // Laeuft ein Zug UND fehlt das Modell, ist "run-active" die Antwort —
    // nicht, weil es wichtiger waere, sondern weil die Reihenfolge festliegen
    // muss, damit ein Test ueber den Grund etwas aussagt.
    expect(shouldWakeParent({
      ...basis, isRunning: true, activeModel: null, tasks: [aufgabe()],
    }).reason).toBe('run-active')
  })
})

describe('isUnreportedTerminal', () => {
  it('kennt genau die drei Endzustaende', () => {
    expect(isUnreportedTerminal(aufgabe({ status: 'done' }))).toBe(true)
    expect(isUnreportedTerminal(aufgabe({ status: 'failed' }))).toBe(true)
    expect(isUnreportedTerminal(aufgabe({ status: 'cancelled' }))).toBe(true)
    expect(isUnreportedTerminal(aufgabe({ status: 'running' }))).toBe(false)
  })
})

describe('WAKE_PROMPT — was der Weckzug mitbringt', () => {
  it('traegt das Ergebnis NICHT selbst', () => {
    // Der Bericht kommt von `appendTaskReport`, innerhalb des Laufs. Haette
    // der Weckzug ihn selbst gebaut, muesste er die Aufgaben vorher als
    // gemeldet markieren — und ein Zug, der zwischen Nehmen und Starten
    // scheitert, haette sie still verschluckt.
    expect(WAKE_PROMPT).not.toContain('[background-task')
    expect(WAKE_PROMPT).toContain('included above')
  })

  it('erlaubt ausdruecklich die kurze Antwort', () => {
    // Ohne diesen Satz erzaehlt ein Modell das Ergebnis noch einmal nach —
    // und der Mensch liest dasselbe zweimal, einmal als Notiz des Agenten und
    // einmal als Antwort.
    expect(WAKE_PROMPT).toMatch(/one line/i)
  })

  it('die Sammelfrist ist eine Sekunde', () => {
    // Lang genug fuer "zusammen losgeschickt, zusammen fertig", kurz genug,
    // dass ein wartender Mensch sie nicht als Haenger liest.
    expect(WAKE_BUNDLE_MS).toBe(1000)
    expect(WAKE_BUNDLE_MS).toBeGreaterThanOrEqual(500)
    expect(WAKE_BUNDLE_MS).toBeLessThanOrEqual(3000)
  })
})

// ── Der Waechter: die drei Sicherungen im Ablauf ──────────────────────────

describe('createWakeWatcher — ein Weckzug, nicht fuenf', () => {
  /** Ein Pruefstand mit steuerbarer Zeit und zaehlbarem Sendeweg. */
  function stand(over: Partial<{ tasks: AgentTask[]; running: boolean; model: string | null }> = {}) {
    const zustand = {
      tasks: over.tasks ?? [] as AgentTask[],
      running: over.running ?? false,
      model: over.model === undefined ? 'llama3:8b' : over.model,
      convId: 'conv-1' as string | null,
    }
    const gesendet: string[] = []
    let aufloesen: (() => void) | null = null
    const zeitgeber: Array<{ id: number; fn: () => void }> = []
    let seq = 1

    const watcher = createWakeWatcher({
      conversationId: () => zustand.convId,
      tasks: () => zustand.tasks,
      isRunning: () => zustand.running,
      activeModel: () => zustand.model,
      send: (t) => {
        gesendet.push(t)
        // Bleibt offen, bis der Test ihn schliesst: nur so ist der Zustand
        // "Weckzug unterwegs" ueberhaupt beobachtbar.
        return new Promise<void>((r) => { aufloesen = () => r() })
      },
      setTimer: (fn) => { const id = seq++; zeitgeber.push({ id, fn }); return id },
      clearTimer: (h) => {
        const i = zeitgeber.findIndex((z) => z.id === h)
        if (i >= 0) zeitgeber.splice(i, 1)
      },
      bundleMs: 1000,
    })

    return {
      watcher, zustand, gesendet,
      offeneZeitgeber: () => zeitgeber.length,
      /** Die Frist verstreichen lassen. */
      fristAblaufen: () => {
        const alle = zeitgeber.splice(0, zeitgeber.length)
        for (const z of alle) z.fn()
      },
      /** Den laufenden Weckzug beenden. */
      antwortFertig: async () => { aufloesen?.(); await Promise.resolve(); await Promise.resolve() },
    }
  }

  it('weckt nach der Frist, nicht sofort', () => {
    const p = stand({ tasks: [aufgabe()] })
    p.watcher.check()
    // Sofort zu wecken hiesse, den zweiten und dritten Agenten zu verpassen,
    // die eine Zehntelsekunde spaeter fertig werden.
    expect(p.gesendet).toHaveLength(0)
    p.fristAblaufen()
    expect(p.gesendet).toEqual([WAKE_PROMPT])
  })

  it('buendelt fuenf Abschluesse zu EINEM Zug', () => {
    // Der Fall, fuer den die Frist da ist: fuenf zusammen losgeschickte
    // Agenten werden im Abstand von Sekundenbruchteilen fertig. Ohne
    // Buendelung fuenf Weckzuege, von denen vier veraltet sind, bevor sie
    // fertig gedacht haben — auf einem lokalen Modell fuenfmal die volle
    // Rechenzeit.
    const p = stand({ tasks: [aufgabe()] })
    for (let i = 0; i < 5; i++) {
      p.zustand.tasks = [...p.zustand.tasks, aufgabe()]
      p.watcher.check()
    }
    // Immer nur EIN ausstehender Zeitgeber: jeder Anstoss setzt ihn neu.
    expect(p.offeneZeitgeber()).toBe(1)
    p.fristAblaufen()
    expect(p.gesendet).toHaveLength(1)
  })

  it('weckt nicht, waehrend ein Zug laeuft', () => {
    const p = stand({ tasks: [aufgabe()], running: true })
    p.watcher.check()
    expect(p.offeneZeitgeber()).toBe(0)
    expect(p.gesendet).toHaveLength(0)
  })

  it('bricht ab, wenn der Mensch WAEHREND der Frist selbst schreibt', () => {
    // Die zweite Pruefung nach der Frist, und sie ist keine Vorsicht auf
    // Verdacht: genau diese Sekunde ist die wahrscheinlichste, in der der
    // Mensch etwas abschickt — er hat ja gerade die Notiz des fertigen
    // Agenten gelesen. Ohne sie liefen zwei Zuege in dasselbe Gespraech.
    const p = stand({ tasks: [aufgabe()] })
    p.watcher.check()
    p.zustand.running = true
    p.fristAblaufen()
    expect(p.gesendet).toHaveLength(0)
  })

  it('bricht ab, wenn das Ergebnis waehrend der Frist schon gemeldet wurde', () => {
    const p = stand({ tasks: [aufgabe()] })
    p.watcher.check()
    p.zustand.tasks = [aufgabe({ reported: true })]
    p.fristAblaufen()
    expect(p.gesendet).toHaveLength(0)
  })

  it('schickt keinen zweiten Weckzug los, solange der erste unterwegs ist', () => {
    // DIE Luecke, die die Laueft-schon-Sicherung nicht deckt: zwischen
    // "abgeschickt" und "der Generierungs-Schalter steht auf an" vergeht Zeit,
    // und in genau der saehe ein zweiter Anstoss noch `running: false`.
    const p = stand({ tasks: [aufgabe()] })
    p.watcher.check()
    p.fristAblaufen()
    expect(p.gesendet).toHaveLength(1)
    expect(p.watcher._busy()).toBe(true)

    p.zustand.tasks = [...p.zustand.tasks, aufgabe()]
    p.watcher.check()
    p.fristAblaufen()
    expect(p.gesendet).toHaveLength(1)
  })

  it('weckt wieder, sobald der vorige Zug durch ist', async () => {
    // Die Gegenprobe: die Sperre muss sich auch wieder LOESEN, sonst weckt es
    // nach dem ersten Mal nie wieder.
    const p = stand({ tasks: [aufgabe()] })
    p.watcher.check()
    p.fristAblaufen()
    await p.antwortFertig()
    expect(p.watcher._busy()).toBe(false)

    p.zustand.tasks = [aufgabe()]
    p.watcher.check()
    p.fristAblaufen()
    expect(p.gesendet).toHaveLength(2)
  })

  it('ueberlebt einen gescheiterten Weckzug', async () => {
    // Ein Sendeweg, der wirft, darf den Waechter nicht mitnehmen — sonst
    // waere nach einem einzigen Netzfehler das ganze Wecken tot, still.
    const gesendet: string[] = []
    const zeit: Array<() => void> = []
    const w = createWakeWatcher({
      conversationId: () => 'conv-1',
      tasks: () => [aufgabe()],
      isRunning: () => false,
      activeModel: () => 'llama3:8b',
      send: (t) => { gesendet.push(t); return Promise.reject(new Error('kein Netz')) },
      setTimer: (fn) => { zeit.push(fn); return zeit.length },
      clearTimer: () => {},
      bundleMs: 1,
    })
    w.check()
    zeit.pop()!()
    await Promise.resolve(); await Promise.resolve()
    expect(gesendet).toHaveLength(1)
    expect(w._busy()).toBe(false)
  })

  it('dispose verwirft einen ausstehenden Zeitgeber', () => {
    // Sonst weckte ein Gespraech, das der Nutzer gerade verlassen hat, eine
    // Sekunde spaeter noch.
    const p = stand({ tasks: [aufgabe()] })
    p.watcher.check()
    p.watcher.dispose()
    p.fristAblaufen()
    expect(p.gesendet).toHaveLength(0)
  })

  it('weckt nach, wenn die Aufgabe WAEHREND des Laufs fertig wurde', () => {
    // DER Fall, an dem die erste Fassung im laufenden Fenster scheiterte
    // (02.09.2026): der Sub-Agent scheiterte sofort, war also fertig, waehrend
    // der Elternzug noch lief. Der Blick kam korrekt zu "darf nicht" — und
    // danach aenderte sich der Aufgaben-Store nie wieder, es sah also nie
    // wieder jemand hin. Das Ergebnis lag da, bis der Mensch von sich aus
    // etwas schrieb: genau das Loch, das der Haken schliessen sollte.
    //
    // Die Antwort ist die zweite Quelle im Hook — das Ende des Laufs stoesst
    // ebenfalls einen Blick an. Hier steht die REGEL dazu: derselbe Waechter,
    // zweimal befragt, muss beim zweiten Mal wecken.
    const p = stand({ tasks: [aufgabe()], running: true })
    p.watcher.check()
    expect(p.offeneZeitgeber()).toBe(0)

    p.zustand.running = false
    p.watcher.check()
    p.fristAblaufen()
    expect(p.gesendet).toEqual([WAKE_PROMPT])
  })

  it('weckt das Gespraech, das beim Ablauf der Frist AKTUELL ist', () => {
    // Der Wechsel mitten in der Frist: die Kennung wird bei Ablauf erneut
    // gelesen, nicht beim Setzen gemerkt.
    const p = stand({ tasks: [aufgabe()] })
    p.watcher.check()
    p.zustand.convId = null
    p.fristAblaufen()
    expect(p.gesendet).toHaveLength(0)
  })
})

// ── Die Verdrahtung ───────────────────────────────────────────────────────

describe('Der Weckhaken haengt an beiden Sendewegen', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = resolve(here, '../..')
  const lies = (p: string) => readFileSync(resolve(src, p), 'utf8')

  /**
   * WARUM ALS QUELLTEXT-WAECHTER: eine Regel taugt nur so viel, wie es Stellen
   * gibt, die sie anwenden. Vergisst ein Umbau die Montage in einem der beiden
   * Wege, bricht NICHTS — es weckt dort nur nie wieder, still, und der Mensch
   * haelt seinen Agenten fuer haengengeblieben. Genau die Art Verlust, die
   * kein Verhaltenstest bemerkt, weil er die Montage selbst mitbringt.
   */
  it('ist im Agentenweg montiert (useChat)', () => {
    const t = lies('hooks/useChat.ts')
    expect(t).toContain('useBackgroundAgentWake(')
    // Mit der REAKTIVEN Kennung, nicht mit einer Momentaufnahme: ein
    // `getState()` im Render weckte nach einem Gespraechswechsel das falsche.
    expect(t).toMatch(/useBackgroundAgentWake\(\s*activeConversationId\s*,/)
  })

  it('ist im Codex-Weg montiert (CodexView)', () => {
    const t = lies('components/chat/CodexView.tsx')
    expect(t).toContain('useBackgroundAgentWake(')
    expect(t).toContain('sendInstruction')
  })

  it('horcht auf BEIDE Quellen — Aufgaben UND das Ende eines Laufs', () => {
    // Nur auf den Aufgaben-Store zu horchen war die erste Fassung, und sie
    // hatte ein Loch, das kein Verhaltenstest zeigen konnte: wird eine Aufgabe
    // fertig, WAEHREND ein Zug laeuft, kommt der Blick korrekt zu "darf
    // nicht" — und danach aendert sich der Aufgaben-Store nie wieder. Erst das
    // Umschalten des Generierungs-Stores auf "fertig" macht aus dem "darf
    // nicht" ein "darf".
    const t = lies('hooks/useBackgroundAgentWake.ts')
    expect(t).toContain('useAgentTaskStore.subscribe(watcher.check)')
    expect(t).toContain('useGenerationStore.subscribe(watcher.check)')
    // Und beide muessen beim Abbau wieder gelöst werden, sonst haelt ein
    // verlassenes Gespraech seinen Waechter am Leben.
    expect(t).toContain('abAufgaben()')
    expect(t).toContain('abLauf()')
  })

  it('beide Sendewege koennen die Nachricht verstecken', () => {
    // Ohne `hiddenUser` stuende im Verlauf ein Satz, den der Mensch nie
    // geschrieben hat — und zwar in seiner eigenen Blase.
    for (const datei of ['hooks/useAgentChat.ts', 'hooks/useCodex.ts']) {
      const t = lies(datei)
      expect(t, datei).toContain('hiddenUser?: boolean')
      expect(t, datei).toContain("...(opts?.hiddenUser ? { hidden: true } : {})")
    }
  })

  it('der Nutzlastbau laesst versteckte Nachrichten durch, die Ansicht nicht', () => {
    // Die ganze Sache haengt an dieser Asymmetrie. Faellt sie, ist der Weckzug
    // entweder unsichtbar fuer das Modell (dann antwortet es auf nichts) oder
    // sichtbar fuer den Menschen (dann liest er eine erfundene eigene
    // Nachricht).
    expect(lies('hooks/useAgentChat.ts')).toContain("m.role !== 'system' && m.content.trim() !== ''")
    expect(lies('hooks/useCodex.ts')).toContain("m.role !== 'system' && (m.content.trim() || m.hidden)")
    expect(lies('components/chat/MessageList.tsx')).toContain('!m.hidden')
  })
})
