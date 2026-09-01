/**
 * Die EINE Installer-Zustandsmaschine des Onboardings.
 *
 * ── Warum diese Datei existiert (AS-09) ───────────────────────────────────
 *
 * Der Technik-Audit fuehrt „Onboarding: 59 `useState` in einer Datei" und
 * verlangt eine Zerlegung „pro Schritt". Nachgezaehlt sind es 58 Aufrufe —
 * und die Verteilung ist der eigentliche Befund, nicht die Summe:
 *
 *     Ollama       10   installing · status · progress · total · speed
 *     LM Studio    10   logs · error · ready · startTime · elapsed
 *     ComfyUI       8   dasselbe, unter anderen Namen
 *     Python        6   dasselbe, ohne Fortschrittsbalken
 *     ───────────────
 *                  34   von 58 — vier Kopien EINER Zustandsmaschine
 *
 * Eine Zerlegung „pro Schritt" haette diese 34 auf vier Dateien verteilt und
 * damit nichts gewonnen: vier Kopien blieben vier Kopien, nur weiter
 * auseinander. Die Schnittlinie liegt nicht zwischen den Schritten, sondern
 * zwischen dem, was sich WIEDERHOLT, und dem, was einmalig ist. Hier steht
 * das Wiederholte, einmal, als reine Funktion — und damit auch als etwas,
 * das ohne DOM geprueft werden kann.
 *
 * Zwei Sorten Ersparnis stecken darin:
 *
 *  1. VIER KOPIEN → EINE. Aus 34 `useState` werden vier `useReducer`.
 *  2. ABGELEITET STATT GESPEICHERT. `elapsed` war viermal ein eigener
 *     `useState` plus ein eigenes `setInterval`, obwohl es nichts anderes
 *     ist als `jetzt − startedAt`. Es steht hier als Rechnung
 *     (`elapsedSeconds`), nicht als Zustand.
 *
 * ── Was die Maschine kann ─────────────────────────────────────────────────
 *
 * Alle vier Installer folgen demselben Ablauf: Knopf gedrueckt → Tauri-Befehl
 * → sekuendliches Polling eines `*_status`-Endpunkts → `complete` oder
 * `error`. Genau das ist unten abgebildet, mit den Regeln, die vorher
 * verstreut in den Klick-Handlern standen:
 *
 *   — Ein `progress` NACH dem Ende wird verworfen. Vorher konnte ein
 *     Poll-Tick, der zwischen `clearInterval` und dem letzten `setState`
 *     unterwegs war, den Fortschrittsbalken einer bereits fertigen
 *     Installation wieder auf „laeuft" ziehen.
 *   — `ready` und `fail` loeschen `startedAt`. Vorher war das eine eigene
 *     Zeile pro Ausstiegspfad, und es gab sechs davon je Installer.
 *   — `start` loescht den Fehler des vorigen Versuchs. Auch das war vorher
 *     eine eigene Zeile, die genau einmal (im Python-Pfad) fehlte.
 */

/** Wo ein Installer steht. Vier Zustaende, nicht drei Boolesche. */
export type InstallerPhase = 'idle' | 'running' | 'ready' | 'failed'

export interface InstallerState {
  phase: InstallerPhase
  /** Der rohe `status`-String der Rust-Seite: 'downloading' | 'installing' | 'starting' | … */
  status: string
  logs: string[]
  /** Leerer String heisst „kein Fehler" — so lasen es die vier Vorlagen auch. */
  error: string
  /** Heruntergeladene Bytes. */
  received: number
  /** Gesamtbytes, 0 solange unbekannt. */
  total: number
  /** Bytes pro Sekunde. */
  speed: number
  /** `Date.now()` beim Start; `null`, sobald der Lauf vorbei ist. */
  startedAt: number | null
}

export const IDLE_INSTALLER: InstallerState = {
  phase: 'idle',
  status: '',
  logs: [],
  error: '',
  received: 0,
  total: 0,
  speed: 0,
  startedAt: null,
}

export type InstallerAction =
  /** Knopf gedrueckt. `at` ist die Startzeit, `log` eine optionale erste Zeile. */
  | { type: 'start'; at: number; log?: string }
  /** Ein Poll-Tick. Alle Felder optional — das Backend liefert nicht immer alle. */
  | { type: 'progress'; status?: string; logs?: string[]; received?: number; total?: number; speed?: number }
  /** `status === 'complete'`. */
  | { type: 'ready' }
  /** `status === 'error'`, ein geworfener Fehler, oder ein Abbruch. */
  | { type: 'fail'; error: string }
  /**
   * Eine Meldung, die die Phase NICHT umwirft. Der ComfyUI-Schritt braucht
   * das: die Installation ist durch, aber `start_comfyui` danach nicht — die
   * Installation ist trotzdem gelungen, und „failed" waere dafuer die
   * falsche Auskunft. Leerer String loescht die Meldung.
   */
  | { type: 'warn'; error: string }
  /** Zurueck auf Anfang (neuer Anlauf ohne laufenden Poll). */
  | { type: 'reset' }

export function installerReducer(state: InstallerState, action: InstallerAction): InstallerState {
  switch (action.type) {
    case 'start':
      return {
        ...IDLE_INSTALLER,
        phase: 'running',
        startedAt: action.at,
        logs: action.log ? [action.log] : [],
      }
    case 'progress':
      // Ein Tick, der nach dem Ende eintrifft, aendert nichts mehr. Der Poll
      // laeuft asynchron; zwischen `clearInterval` und dem letzten Ergebnis
      // kann noch eine Antwort unterwegs sein.
      if (state.phase !== 'running') return state
      return {
        ...state,
        status: action.status ?? state.status,
        logs: action.logs ?? state.logs,
        received: action.received ?? state.received,
        total: action.total ?? state.total,
        speed: action.speed ?? state.speed,
      }
    case 'ready':
      return { ...state, phase: 'ready', error: '', startedAt: null }
    case 'fail':
      return { ...state, phase: 'failed', error: action.error, startedAt: null }
    case 'warn':
      return { ...state, error: action.error }
    case 'reset':
      return IDLE_INSTALLER
  }
}

/** Laeuft gerade etwas? Ersetzt die vier `*Installing`-Flags. */
export const isRunning = (s: InstallerState): boolean => s.phase === 'running'

/** Fertig und benutzbar? Ersetzt die vier `*Ready`-Flags. */
export const isReady = (s: InstallerState): boolean => s.phase === 'ready'

/**
 * Vergangene Sekunden — die Rechnung, die vorher viermal als `useState` plus
 * `setInterval` gespeichert war. Nie negativ: `now` kommt aus einem Takt, der
 * eine Sekunde alt sein kann, und ein Start liegt dann in der „Zukunft".
 */
export function elapsedSeconds(startedAt: number | null, now: number): number {
  if (startedAt === null) return 0
  return Math.max(0, Math.floor((now - startedAt) / 1000))
}

/** `m:ss`, wie die vier Anzeigen es bisher jeweils selbst zusammengesetzt haben. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Die letzte Logzeile — das, was die Fehlermeldungen der vier Installer als
 * „was hat das Installationsprogramm zuletzt gesagt" anhaengen.
 */
export const lastLog = (logs: string[] | undefined): string => logs?.[logs.length - 1] ?? ''
