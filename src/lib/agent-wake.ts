/**
 * Aufwecken: ein fertiger Hintergrundagent bringt den Hauptagenten zurueck.
 *
 * ── DAS LOCH ───────────────────────────────────────────────────────────────
 *
 * Der Weg, auf dem ein Ergebnis das MODELL erreicht, ist `appendTaskReport`,
 * und der steht oben in der ReAct-Schleife. Eine Hintergrundaufgabe endet aber
 * typischerweise DANACH — sie laeuft ja laenger als der Zug, der sie startete.
 * Dann gibt es keine Schleife mehr, die sie abholt: das Ergebnis liegt im
 * Store, eine Zeile steht im Verlauf, und der Hauptagent weiss nichts davon,
 * bis der Mensch das naechste Mal etwas schreibt. Wer drei Recherchen
 * bestellt und dann wartet, wartet fuer immer.
 *
 * ── WAS DIESE DATEI IST UND WAS NICHT ──────────────────────────────────────
 *
 * Hier stehen nur die REGELN — wann geweckt werden darf und was der Weckzug
 * mitbringt. Das Anstossen selbst braucht einen Hook, einen Store und einen
 * Sendeweg; das steht in hooks/useBackgroundAgentWake.ts. Getrennt, weil die
 * Regeln die Stelle sind, an der man sich vertun kann, und weil sie sich
 * einzeln pruefen lassen, ohne einen Lauf zu starten.
 */
import type { AgentTask } from './agent-tasks'

/**
 * Wie lange nach einem Abschluss gewartet wird, bevor geweckt wird.
 *
 * Nicht zum Entprellen von Renderern, sondern zum BUENDELN: schickt das Modell
 * fuenf Agenten in einem Zug los, kommen ihre Ergebnisse oft im Abstand von
 * Sekundenbruchteilen. Ohne Sammelfrist waeren das fuenf Weckzuege, von denen
 * die ersten vier veraltet sind, bevor sie fertig gedacht haben — und auf
 * einem lokalen Modell fuenfmal die volle Rechenzeit.
 *
 * Eine Sekunde ist lang genug fuer den Fall "zusammen losgeschickt, zusammen
 * fertig" und kurz genug, dass ein wartender Mensch sie nicht als Haenger
 * liest.
 */
export const WAKE_BUNDLE_MS = 1000

/**
 * Der Text des Weckzugs.
 *
 * ── WARUM DIESER SATZ UEBERHAUPT NOETIG IST ────────────────────────────────
 *
 * Ein Zug braucht eine Nutzernachricht, sonst gibt es nichts abzuschicken. Das
 * ERGEBNIS steht aber nicht hier drin: das traegt `appendTaskReport` oben in
 * der Schleife bei, mit demselben Mechanismus wie bei jedem anderen Zug. Und
 * das ist keine Schoenheitsfrage, sondern der Grund, warum hier nichts
 * verlorengehen kann: `takeUnreported` markiert die Aufgaben als gemeldet, und
 * es laeuft INNERHALB des Laufs. Kommt der Lauf nie zustande, bleiben sie
 * ungemeldet und der naechste Versuch holt sie.
 *
 * Haette der Weckzug den Bericht selbst gebaut, muesste er vorher nehmen — und
 * ein Zug, der zwischen Nehmen und Starten scheitert, haette die Ergebnisse
 * still verschluckt.
 *
 * ── WARUM ER VERSTECKT REIST ───────────────────────────────────────────────
 *
 * Als sichtbare Nutzernachricht stuende im Verlauf ein Satz, den der Mensch
 * nie geschrieben hat. Der Nutzlastbau filtert `role:'system'`, aber nicht
 * `hidden` — eine versteckte Nutzernachricht erreicht also das Modell und
 * nicht das Auge. Was der Mensch sieht, ist die Notiz, die der fertige Agent
 * selbst hinterlassen hat, und danach die Antwort.
 */
export const WAKE_PROMPT =
  'A background agent you delegated to has finished. '
  + 'Its result is included above. Continue the work with it: '
  + 'if it answers what you were waiting for, say so and carry on. '
  + 'If it changes nothing, say that in one line instead of repeating it.'

/** Eine Aufgabe, deren Ergebnis noch niemand an das Modell weitergereicht hat. */
export function isUnreportedTerminal(t: AgentTask): boolean {
  return t.status !== 'running' && !t.reported
}

export interface WakeDecision {
  wake: boolean
  /** Warum nicht — fuer Tests und Fehlersuche, nicht fuer die Oberflaeche. */
  reason: 'has-results' | 'nothing-new' | 'run-active' | 'user-stopped' | 'no-model' | 'no-conversation'
}

/**
 * Darf jetzt geweckt werden?
 *
 * Die Reihenfolge der Ausgaenge ist Absicht: von billig nach teuer, und die
 * drei Zustaende, in denen Wecken WEHTUT, stehen vorn.
 *
 *  - `user-stopped`: der Mensch hat Stop gedrueckt. Das ist der teuerste
 *    Fehler von allen, und er stand hier bis zum 11.09.2026 nicht.
 *
 *    Ein Hintergrundagent laeuft nach Stop absichtlich weiter — sub-agent.ts
 *    schreibt aus, warum: der Mensch wollte den Satz beenden, nicht die
 *    bestellte Recherche. Sein ERGEBNIS holte danach aber den Hauptagenten
 *    zurueck, und das ist ein voller Agentenzug in die Wolke, eine Sekunde
 *    nach Stop, ohne dass jemand etwas geschrieben haette. Gemessen in der
 *    Gegenprobe: ein Modellaufruf bis zum Stop, zweihundert danach. Genau der
 *    Fehler, den ein Nutzer am 03.09.2026 gemeldet hat.
 *
 *    Der Merker in `lib/run-stop.ts` ist absichtlich klebrig bis zur naechsten
 *    echten Anweisung. Genau das wird hier gebraucht: nach Stop schweigt das
 *    Wecken, und die erste selbst getippte Nachricht macht es wieder scharf,
 *    weil `beginRun` den Merker loescht. Die Ergebnisse gehen dabei nicht
 *    verloren — `takeUnreported` laeuft im naechsten Zug und holt sie nach.
 *  - `run-active`: laeuft schon ein Zug, holt dessen eigene Schleife die
 *    Ergebnisse beim naechsten Durchgang von selbst ab. Hier zusaetzlich zu
 *    wecken hiesse, zwei Zuege in dasselbe Gespraech zu schicken — beide
 *    schreiben in dieselbe Antwortblase.
 *  - `no-model`: ohne aktives Modell gibt es niemanden, der antworten koennte.
 *    Ein Weckversuch endete in einer Fehlermeldung, die der Mensch nicht
 *    angefordert hat.
 */
export function shouldWakeParent(input: {
  conversationId: string | null | undefined
  tasks: readonly AgentTask[]
  isRunning: boolean
  /** Hat der Mensch fuer dieses Gespraech Stop gedrueckt? (lib/run-stop.ts) */
  isStopped: boolean
  activeModel: string | null | undefined
}): WakeDecision {
  if (!input.conversationId) return { wake: false, reason: 'no-conversation' }
  if (input.isStopped) return { wake: false, reason: 'user-stopped' }
  if (input.isRunning) return { wake: false, reason: 'run-active' }
  if (!input.activeModel) return { wake: false, reason: 'no-model' }
  const offen = input.tasks.some(isUnreportedTerminal)
  return offen
    ? { wake: true, reason: 'has-results' }
    : { wake: false, reason: 'nothing-new' }
}


// ── Der Wächter ───────────────────────────────────────────────────────────

export interface WakeWatcherPorts {
  /** Das Gespräch, um das es GERADE geht — kann sich unter dem Wächter ändern. */
  conversationId: () => string | null | undefined
  tasks: (convId: string) => readonly AgentTask[]
  isRunning: (convId: string) => boolean
  /** Hat der Mensch fuer dieses Gespraech Stop gedrueckt? (lib/run-stop.ts) */
  isStopped: (convId: string) => boolean
  activeModel: () => string | null | undefined
  /** Der Weckzug. Fehler daraus dürfen den Wächter nicht umbringen. */
  send: (text: string) => Promise<unknown>
  /**
   * Kennung der letzten Nachricht, die der Mensch selbst geschickt hat (keine
   * versteckte Weck-Nachricht). Aendert sie sich, zaehlt die Weckreihe neu.
   * Ohne diesen Anschluss gilt die Grenze pro Waechter-Leben.
   */
  lastUserTurn?: (convId: string) => string | null
  /** Hoechstens so viele Weckzuege hintereinander ohne Menschen dazwischen. */
  maxWakesInARow?: number
  /** Nur für Tests austauschbar; sonst die echten Zeitgeber. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  bundleMs?: number
}

export interface WakeWatcher {
  /** Einmal hinsehen. Idempotent — mehrfach zu rufen weckt nicht mehrfach. */
  check: () => void
  /** Aufräumen: einen ausstehenden Zeitgeber verwerfen. */
  dispose: () => void
  /** Nur für Tests: läuft gerade ein Weckzug? */
  _busy: () => boolean
}

/**
 * Die ganze Weckmechanik, ohne React.
 *
 * ── WARUM NICHT EINFACH IM HOOK ────────────────────────────────────────────
 *
 * Weil vitest in diesem Haus nur `.test.ts` einsammelt: was in einer `.tsx`
 * steht oder eine React-Umgebung braucht, hat keinen Test, der je laeuft. Und
 * das hier ist nicht die Stelle, an der man auf Tests verzichten moechte —
 * jedes Wecken ist eine Inferenz, die der Mensch nicht angefordert hat, und
 * die drei Sicherungen unten sind genau die Art Regel, die beim naechsten
 * Umbau still verlorengeht.
 *
 * Der Hook drumherum reicht nur noch Stores und einen Sendeweg herein.
 */
/** Weckzuege hintereinander, ohne dass der Mensch dazwischen etwas schickt. */
export const MAX_WAKES_IN_A_ROW = 3

export function createWakeWatcher(ports: WakeWatcherPorts): WakeWatcher {
  const setTimer = ports.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = ports.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const bundleMs = ports.bundleMs ?? WAKE_BUNDLE_MS

  let timer: unknown = null
  let busy = false
  // CA (13.11.2026): jeder Weckzug ist ein voller, bezahlter Agentenlauf, den
  // niemand getippt hat, und er darf neue Hintergrundagenten bestellen, deren
  // Abschluss wieder weckt. Ohne Obergrenze lief eine Kette aus Bestellen,
  // Wecken, Bestellen so lange, bis das Modell von selbst aufhoerte. Jetzt:
  // hoechstens drei in Folge, dann wartet der Waechter auf den Menschen.
  const maxRow = ports.maxWakesInARow ?? MAX_WAKES_IN_A_ROW
  const reihe = new Map<string, { turn: string | null; n: number }>()
  const reiheVoll = (convId: string) => {
    const turn = ports.lastUserTurn?.(convId) ?? null
    const r = reihe.get(convId)
    if (!r || r.turn !== turn) return false
    return r.n >= maxRow
  }
  const zaehlen = (convId: string) => {
    const turn = ports.lastUserTurn?.(convId) ?? null
    const r = reihe.get(convId)
    reihe.set(convId, r && r.turn === turn ? { turn, n: r.n + 1 } : { turn, n: 1 })
  }

  const urteilen = (convId: string) => shouldWakeParent({
    conversationId: convId,
    tasks: ports.tasks(convId),
    isRunning: ports.isRunning(convId),
    isStopped: ports.isStopped(convId),
    activeModel: ports.activeModel(),
  })

  const check = () => {
    const convId = ports.conversationId()
    if (!convId) return
    if (!urteilen(convId).wake) return
    if (reiheVoll(convId)) return

    // Sammelfrist, bei jedem weiteren Abschluss neu gesetzt: es weckt erst,
    // wenn eine Weile lang keiner mehr fertig geworden ist.
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      const jetzt = ports.conversationId()
      if (!jetzt || busy) return
      // ZWEITE Pruefung nach der Frist. In dieser Sekunde kann der Mensch
      // selbst etwas geschickt haben — dann laeuft ein Zug, und dessen eigene
      // Schleife nimmt die Ergebnisse ohnehin mit. Oder er hat Stop gedrueckt:
      // die Sammelfrist ist eine volle Sekunde, in der der Weckzug schon
      // beschlossen, aber noch nicht abgeschickt ist, und ein Zug, der eine
      // Sekunde NACH Stop losgeht, ist genau der, den niemand bestellt hat.
      if (!urteilen(jetzt).wake) return
      if (reiheVoll(jetzt)) return
      zaehlen(jetzt)

      // `busy` deckt die Luecke zwischen "wir schicken los" und "der
      // Generierungs-Schalter steht auf an". Genau darin saehe ein zweiter
      // Anstoss die Laueft-schon-Sicherung noch nicht.
      //
      // Dieselbe Pruefung stand einmal auch oben in `check`. Eine Rotprobe hat
      // sie als wirkungslos entlarvt: der Zeitgeber waere dann zwar gesetzt
      // worden, aber hier abgefangen, und bis er ablaeuft hat der laufende Zug
      // die Ergebnisse per `appendTaskReport` ohnehin geholt. Eine Zeile, die
      // kein Test rot bekommt, ist keine Sicherung, sondern eine Behauptung —
      // sie ist weg.
      busy = true
      void Promise.resolve(ports.send(WAKE_PROMPT))
        .catch(() => { /* Ein misslungener Weckzug darf den Waechter nicht mitnehmen. */ })
        .finally(() => { busy = false })
    }, bundleMs)
  }

  return {
    check,
    dispose: () => { if (timer !== null) { clearTimer(timer); timer = null } },
    _busy: () => busy,
  }
}
