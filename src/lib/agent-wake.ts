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
  reason: 'has-results' | 'nothing-new' | 'run-active' | 'no-model' | 'no-conversation'
}

/**
 * Darf jetzt geweckt werden?
 *
 * Die Reihenfolge der Ausgaenge ist Absicht: von billig nach teuer, und die
 * beiden Zustaende, in denen Wecken WEHTUT, stehen vorn.
 *
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
  activeModel: string | null | undefined
}): WakeDecision {
  if (!input.conversationId) return { wake: false, reason: 'no-conversation' }
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
  activeModel: () => string | null | undefined
  /** Der Weckzug. Fehler daraus dürfen den Wächter nicht umbringen. */
  send: (text: string) => Promise<unknown>
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
export function createWakeWatcher(ports: WakeWatcherPorts): WakeWatcher {
  const setTimer = ports.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = ports.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const bundleMs = ports.bundleMs ?? WAKE_BUNDLE_MS

  let timer: unknown = null
  let busy = false

  const urteilen = (convId: string) => shouldWakeParent({
    conversationId: convId,
    tasks: ports.tasks(convId),
    isRunning: ports.isRunning(convId),
    activeModel: ports.activeModel(),
  })

  const check = () => {
    const convId = ports.conversationId()
    if (!convId) return
    if (!urteilen(convId).wake) return

    // Sammelfrist, bei jedem weiteren Abschluss neu gesetzt: es weckt erst,
    // wenn eine Weile lang keiner mehr fertig geworden ist.
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      const jetzt = ports.conversationId()
      if (!jetzt || busy) return
      // ZWEITE Pruefung nach der Frist. In dieser Sekunde kann der Mensch
      // selbst etwas geschickt haben — dann laeuft ein Zug, und dessen eigene
      // Schleife nimmt die Ergebnisse ohnehin mit.
      if (!urteilen(jetzt).wake) return

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
