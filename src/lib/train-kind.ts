/**
 * 3.0.9 P8: was der lokale Trainer lernt, eine Figur oder einen Stil.
 *
 * Bis 3.0.8 kannte der Trainer nur Figuren: Triggerwort Pflicht, jede Zeile
 * `${trigger}, a photo of ${trigger}`, Datei `char_<trigger>_zimage`. Fuer
 * einen Malstil, ein Konzept oder eine Pose passt davon wenig (Discord,
 * 28.10.2026): "a photo of" zieht jedes Bild Richtung Foto, und die Figuren-
 * Ablage zeigt den Stil dann als Figur.
 *
 * Modus "Style / concept":
 *  - Beschriftung: der optionale Triggerwort-Anfang und dann, was AUF dem Bild
 *    ist (Motiv, Ort). Was ungenannt bleibt, lernt der LoRA: der Stil, die Pose.
 *  - Triggerwort optional. Ohne wirkt der LoRA bei jedem Bild, sobald er aktiv
 *    ist; die Staerke im LoRA-Regler bestimmt, wie sehr.
 *  - Datei `style_<name>_zimage.safetensors`. Die Bild-Lane erkennt sie als
 *    Z-Image-LoRA (lib/lora-stack.ts), die Figuren-Ablage zeigt sie nicht.
 *  - Mehr Schritte: ein Stil muss ueber viele Motive hinweg gelernt werden.
 *    Lernrate und Rang bleiben die des Figuren-Rezepts (1e-4, siehe
 *    trainer.rs / mlx_train.rs); die Schritte sind der Hebel.
 */
import { TRAIN_PRESETS, TRAIN_STEPS_DEFAULT, type TrainPreset } from './trainer-presets'
import { cleanTrainDescription } from './train-captions'

export type TrainKind = 'character' | 'style'

export const TRAIN_KIND_DEFAULT: TrainKind = 'character'

export function isTrainKind(v: unknown): v is TrainKind {
  return v === 'character' || v === 'style'
}

export const TRAIN_KINDS: { value: TrainKind; label: string }[] = [
  { value: 'character', label: 'Character' },
  { value: 'style', label: 'Style / concept' },
]

/** Die drei Stufen im Stil-Modus. Standard ist die Voreinstellung. */
export const STYLE_TRAIN_PRESETS: TrainPreset[] = [
  { steps: 600, label: 'Quick' },
  { steps: 1600, label: 'Standard' },
  { steps: 3000, label: 'Thorough' },
]

export const STYLE_TRAIN_STEPS_DEFAULT = 1600

export function trainPresetsFor(kind: TrainKind): TrainPreset[] {
  return kind === 'style' ? STYLE_TRAIN_PRESETS : TRAIN_PRESETS
}

export function trainStepsDefaultFor(kind: TrainKind): number {
  return kind === 'style' ? STYLE_TRAIN_STEPS_DEFAULT : TRAIN_STEPS_DEFAULT
}

/** Die Zeile fuer ein Bild im Stil-Modus. `trigger` leer heisst: kein
 *  Triggerwort, die Zeile ist nur die Beschreibung (auch leer erlaubt, dann
 *  lernt der LoRA alles unbedingt). */
export function buildStyleCaption(trigger: string, description?: string | null): string {
  const t = trigger.trim()
  const extra = cleanTrainDescription(description ?? '')
  if (t && extra) return `${t}, ${extra}`
  if (t) return t
  return extra
}

/** Der Dateiname, den der Trainer schreibt, wie `sanitize_component` in
 *  trainer.rs: alles ausser ASCII-Buchstaben, Ziffern, `-` und `_` wird `_`,
 *  `_` an den Enden faellt weg, hoechstens 48 Zeichen. */
export function trainedLoraFile(kind: TrainKind, name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
  return `${kind === 'style' ? 'style' : 'char'}_${clean}_zimage.safetensors`
}

// ── Texte (UI, also englisch) ───────────────────────────────────────────

/** Was unter dem Modus-Waehler steht, solange "Style / concept" gilt. */
export const STYLE_MODE_NOTE =
  'Teaches a look, a concept or a pose instead of one person. Use 10 to 30 pictures that share the style but show different subjects. The result is a LoRA in the Image tab: switch it on and set its strength there.'

export const STYLE_NAME_PLACEHOLDER = 'Name, e.g. inkwash'

export const STYLE_TRIGGER_LABEL = 'Use the name as trigger word'

export const STYLE_TRIGGER_HINT_ON =
  'Put the name in a prompt to call the style up; without it the LoRA stays mild.'

export const STYLE_TRIGGER_HINT_OFF =
  'No trigger word: the style applies to every picture while the LoRA is on. The strength slider sets how much.'

export const STYLE_CAPTION_HELP =
  'Optional: under each picture, name what is in it, like the subject and the place. Do not name the style, the colors or the pose you want to teach: what is left unnamed is what the LoRA learns.'

export const STYLE_CAPTION_PLACEHOLDER = 'e.g. a fox in a forest'

export const STYLE_DROP_TITLE = 'pictures in the style here'

export const STYLE_DROP_HINT = 'One look, concept or pose, shown on many different subjects'

/** Die Systemzeile fuer "Describe photos" im Stil-Modus: der Inhalt, nie der
 *  Stil. Gegenstueck zu `DESCRIBE_SYSTEM` (lib/render/describe-train-photos). */
export const DESCRIBE_STYLE_SYSTEM = [
  'You caption images for training a style LoRA.',
  'Name ONLY what is shown: the subject, objects, the place or background.',
  'Never describe the art style, medium, technique, brushwork, color palette, lighting mood or the pose, and never name an artist.',
  'Answer with one line of short comma separated phrases, at most 15 words, no sentence, no quotes, nothing else.',
].join('\n')

/** Die Fertig-Meldung im Fortschritt. */
export function trainedLine(kind: TrainKind): string {
  return kind === 'style' ? 'Style ready! It is switched on in the Image tab.' : 'Character ready!'
}

/** Fehler, wenn das Namensfeld leer ist. */
export function missingNameLine(kind: TrainKind): string {
  return kind === 'style'
    ? 'Give the style a name first, e.g. inkwash. It becomes the name of the LoRA file.'
    : 'Pick a trigger word first, e.g. davechar. It becomes the token that summons your character.'
}
