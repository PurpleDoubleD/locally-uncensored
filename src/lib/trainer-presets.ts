/**
 * Die drei Stufen des lokalen Character-Trainers, an EINER Stelle.
 *
 * Die Zahlen standen bisher nur im Waehler von SpecialIntentControls, und der
 * Hinweistext darunter nannte die wirksame Zahl ohne den Namen der Stufe. Fund
 * 2 der E2E-Kampagne 3.0.0 (T3, Box, 11.09.2026) ist genau diese Luecke: der
 * Tester klickte `Quick`, las weiter `(400 STEPS)` und hielt die Stufe fuer
 * wirkungslos. Sie war es nicht. Seine eigene Messung eine Minute vor dem Klick
 * (`p-5a-out.json`) zeigt denselben Text schon mit 400, weil die gespeicherte
 * Wahl der Box laengst auf Quick stand. 400 IST Quick, und Quick ist die
 * kleinste der drei Stufen; das Handbuch sagt dasselbe (docs/guide/create:
 * "Quick" (400 steps), "Standard" (1200) or "Thorough" (2400)).
 *
 * Der Hinweistext nennt deshalb jetzt die Stufe neben der Zahl. Wer das liest,
 * kann nicht mehr raten, welche der drei gerade gilt.
 */

export interface TrainPreset {
  /** `--max_train_steps` des Laufs (src-tauri/src/commands/trainer.rs). */
  steps: number
  /** Was im Waehler steht. UI-Text, also englisch. */
  label: string
}

export const TRAIN_PRESETS: TrainPreset[] = [
  { steps: 400, label: 'Quick' },
  { steps: 1200, label: 'Standard' },
  { steps: 2400, label: 'Thorough' },
]

/**
 * Die Voreinstellung. Muss der Voreinstellung des Trainers gleichen, die ohne
 * Angabe greift (`steps.unwrap_or(1200)` in trainer.rs), sonst traegt eine
 * Oberflaeche eine andere Zahl vor als der Lauf nimmt.
 */
export const TRAIN_STEPS_DEFAULT = 1200

/** Die Stufe zu einer Schrittzahl, oder null fuer eine Zahl, die keine ist. */
export function trainPresetLabel(steps: number, presets: TrainPreset[] = TRAIN_PRESETS): string | null {
  return presets.find((p) => p.steps === steps)?.label ?? null
}

/**
 * Was im Hinweistext in der Klammer steht: die wirksame Zahl, und davor die
 * Stufe, wenn es eine ist.
 */
export function trainStepsNote(steps: number, presets: TrainPreset[] = TRAIN_PRESETS): string {
  const label = trainPresetLabel(steps, presets)
  return label ? `${label}, ${steps} steps` : `${steps} steps`
}

/**
 * 3.0.8 D20: die zwei Rezepte des lokalen Trainers. Die Argumente selbst
 * baut der Rust-Teil (`TrainPreset` in src-tauri/src/commands/trainer.rs);
 * hier stehen nur Name, Untergrenze und der Satz dazu.
 */
export type TrainVramPreset = 'standard' | 'low-vram'

export const TRAIN_VRAM_PRESETS: { value: TrainVramPreset; label: string }[] = [
  { value: 'standard', label: 'Normal' },
  { value: 'low-vram', label: 'Low VRAM' },
]

export const TRAIN_VRAM_PRESET_DEFAULT: TrainVramPreset = 'standard'

/** Gleiche Zahlen wie `TRAINER_VRAM_FLOOR_MIB_FP8` und
 *  `TRAINER_VRAM_FLOOR_MIB_LOW_VRAM_FP8` in trainer.rs (ein Test vergleicht
 *  beide). Low VRAM ist gerechnet, nicht auf einer Karte gemessen. */
export const TRAIN_VRAM_FLOOR_MIB: Record<TrainVramPreset, number> = {
  standard: 11 * 1024,
  'low-vram': 7 * 1024 + 512,
}

export function isTrainVramPreset(v: unknown): v is TrainVramPreset {
  return v === 'standard' || v === 'low-vram'
}

/** Was unter dem Waehler steht, solange Low VRAM gewaehlt ist. */
export const LOW_VRAM_NOTE =
  'Low VRAM trains at 512 px and keeps most of the model in system memory. Each step takes clearly longer than Normal, and fine detail comes out softer. Needs about 8 GB on the card.'

function gb(mib: number): string {
  return `${Math.round(mib / 1024)} GB`
}

/**
 * Der Vorschlag zur Karte: null, wenn das gewaehlte Rezept passt oder die
 * Karte unbekannt ist. `switchTo` ist das Rezept, das der Knopf daneben
 * waehlt; fehlt es, passt auch Low VRAM nicht.
 *
 * `cardGb` ist die Zahl aus `useGraphicsCardGb` (ganze GB der groessten
 * Karte, auf dem Mac null), dieselbe Karte, die der Trainer ohne Auswahl im
 * Hardware-Tab nimmt (`choose_trainer_gpu`). Eine andere Auswahl dort
 * faengt die Pruefung im Rust-Teil ab, deren Meldung ebenfalls Low VRAM nennt.
 */
export function trainVramSuggestion(
  cardGb: number | null,
  preset: TrainVramPreset,
): { text: string; switchTo?: TrainVramPreset } | null {
  if (cardGb === null || cardGb <= 0) return null
  const cardMib = cardGb * 1024
  if (cardMib < TRAIN_VRAM_FLOOR_MIB['low-vram']) {
    return { text: `This card has ${gb(cardMib)}, less than local training needs even with Low VRAM (about 8 GB). Cloud mode trains the same character without this limit.` }
  }
  if (preset === 'standard' && cardMib < TRAIN_VRAM_FLOOR_MIB.standard) {
    return {
      text: `This card has ${gb(cardMib)}. Normal training needs ${gb(TRAIN_VRAM_FLOOR_MIB.standard)}, Low VRAM is made for cards like this one.`,
      switchTo: 'low-vram',
    }
  }
  return null
}
