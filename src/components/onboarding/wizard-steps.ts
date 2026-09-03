/**
 * Die Schrittfolge des Einrichtungsassistenten — als Daten und reine
 * Funktionen, nicht als 1920 Zeilen JSX.
 *
 * Warum es diese Datei gibt (Design-Audit D-S35): das Onboarding hat sechs
 * Eintraege in `STEP_ORDER` und zeigt sechs anonyme Punkte. Angekuendigt sind
 * drei. Der Audit haelt das ausdruecklich fest: „Die ‚Onboarding-Kuerze'
 * existiert nicht: es sind 6 Schritte."
 *
 * Was hier passiert, ist keine Umbenennung des Befundes, sondern eine
 * Unterscheidung, die im Code vorher nicht existierte: `welcome` ist ein
 * Titelbild mit einem Satz und einem Knopf, `done` eine Bestaetigung. Beides
 * sind keine Schritte, die jemand ERLEDIGT — sie stehen nur in derselben
 * Liste, weil dieselbe `step`-Variable auch den Bildschirm auswaehlt. Der
 * Fortschrittsanzeiger zaehlt ab jetzt die Arbeitsschritte:
 *
 *   Windows/Linux  Engine · Image & video · Model · Documents   = 4
 *   macOS          Engine · Model · Documents                   = 3
 *
 * Auf dem Mac sind es damit wirklich drei. Auf Windows vier, und der
 * Anzeiger sagt es in Worten („Step 2 of 4") statt es in vier gleich grossen
 * Punkten zu verstecken. Die BILDSCHIRME sind unveraendert sechs: was hier
 * faellt, ist die Behauptung, es seien sechs Aufgaben.
 *
 * Alles hier ist rein und ohne React — deshalb pruefbar in einer Umgebung
 * ohne DOM (`vitest.config.ts`: `environment: 'node'`).
 */

export type Step = 'welcome' | 'backends' | 'comfyui' | 'models' | 'embeddings' | 'done'

/** Alle Bildschirme in ihrer Reihenfolge. Auswahlliste, kein Fortschritt. */
export const STEP_ORDER: Step[] = ['welcome', 'backends', 'comfyui', 'models', 'embeddings', 'done']

/**
 * Die Schritte, in denen der Nutzer etwas entscheidet oder installiert —
 * und ihre Beschriftung im Anzeiger. `welcome` und `done` fehlen hier mit
 * Absicht (siehe Kopf).
 */
export const WORK_STEPS: { step: Step; label: string }[] = [
  { step: 'backends', label: 'Engine' },
  { step: 'comfyui', label: 'Image & video' },
  { step: 'models', label: 'Model' },
  { step: 'embeddings', label: 'Documents' },
]

/**
 * Die Arbeitsschritte dieser Plattform. Auf macOS faellt ComfyUI weg —
 * `nextStepAfterBackends()` springt dort darueber hinweg, lokale Bild- und
 * Videoerzeugung laeuft auf Apple Silicon ausschliesslich ueber MLX.
 */
export function workStepsFor(skipComfyUI: boolean): { step: Step; label: string }[] {
  return skipComfyUI ? WORK_STEPS.filter((s) => s.step !== 'comfyui') : WORK_STEPS
}

/**
 * Was der Anzeiger ueber den aktuellen Bildschirm sagt.
 *
 *  - `welcome`  → `null`: das Titelbild bekommt keinen Fortschritt, weil es
 *                 keiner ist. (Und damit auch keine 294px Niemandsland
 *                 zwischen einem festgenagelten Anzeiger und dem Inhalt.)
 *  - ein Arbeitsschritt → Position (1-basiert) und Gesamtzahl.
 *  - `done`     → alles voll, mit eigenem Text.
 */
export interface WizardProgress {
  /** 1-basierte Position, `null` auf dem Abschlussbildschirm. */
  position: number | null
  total: number
  /** Was unter den Punkten steht. */
  caption: string
  /** Wie viele Punkte gefuellt sind. */
  filled: number
}

export function wizardProgress(step: Step, skipComfyUI: boolean): WizardProgress | null {
  const steps = workStepsFor(skipComfyUI)
  const total = steps.length
  if (step === 'welcome') return null
  if (step === 'done') {
    return { position: null, total, caption: 'Setup complete', filled: total }
  }
  const at = steps.findIndex((s) => s.step === step)
  // Ein Schritt, den diese Plattform ueberspringt (comfyui auf dem Mac), darf
  // den Anzeiger nicht auf -1 setzen. Er kann hier nur ankommen, wenn jemand
  // die Weiche in nextStepAfterBackends() aendert und diese Liste vergisst;
  // dann ist „kein Anzeiger" das ehrlichere Ergebnis als eine falsche Zahl.
  if (at < 0) return null
  return {
    position: at + 1,
    total,
    caption: `Step ${at + 1} of ${total} · ${steps[at].label}`,
    filled: at + 1,
  }
}
