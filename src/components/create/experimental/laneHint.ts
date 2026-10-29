// The caption under the prompt field for lanes that take no prompt — shared,
// pure, testable.
//
// 2026-07-26, watching a Motion Control run: the card kept saying "add a
// character image and a driving dance/pose video above, then hit Create" while
// both chips were filled and the sampler was already counting steps. The
// caption was rendered on `!needsPrompt` alone, so it never reacted to anything
// the user did.
import type { CreateBackend, CreateIntent } from '../../../stores/createStore'
import { MIN_TRAIN_IMAGES, maxTrainImages } from '../../../lib/train-image-cap'
import type { TrainKind } from '../../../lib/train-kind'

/** Captions that name the inputs a lane is waiting for. These go stale the
 *  moment the chips are filled, so they hide once the lane reports ready. */
const INPUT_HINT_INTENTS: ReadonlySet<CreateIntent> =
  new Set(['character', 'lipsync', 'motion'] as CreateIntent[])

/**
 * Does the caption name inputs the lane waits for? Such a caption stands
 * above the prompt window as a note, never inside it.
 *
 * Discord report (3.0.7), Motion Control: the caption sat inside the prompt
 * window in the place and padding of the field, grey like a placeholder. It
 * was taken for a field that would not take typing, and when both inputs
 * were in it hid, so the "field" seemed to vanish. A note outside the window
 * can go without the window changing.
 */
export function isInputHint(id: CreateIntent): boolean {
  return INPUT_HINT_INTENTS.has(id)
}

/** Caption for prompt-less intents so each reads honestly (the old copy said
 *  "remove the background" for every one of them — misleading the eraser into
 *  a guaranteed "Paint a mask first" error). */
export function noPromptHint(id: CreateIntent, backend: CreateBackend = 'local', mac = false, trainKind: TrainKind = 'character'): string {
  switch (id) {
    case 'upscale':
      return 'No prompt needed. Just hit Create to enhance the image.'
    case 'eraser':
      return 'No prompt needed. Paint a mask over the object to remove, then hit Create.'
    case 'character':
      // 3.0.9 P8 (FEHLER-P8 #1): the style mode of the local trainers wants
      // pictures in one style and a name, not one person and a trigger word.
      // The cloud trains characters only, so it keeps the character line.
      if (trainKind === 'style' && backend === 'local') {
        return `Add ${MIN_TRAIN_IMAGES} to ${maxTrainImages(backend)} pictures that share the style above, give it a name, then hit Create to train.`
      }
      return `Add ${MIN_TRAIN_IMAGES} to ${maxTrainImages(backend)} photos of one person or character above, pick a trigger word, then hit Create to train.`
    case 'lipsync':
      // A Mac makes the clip from a portrait; it has no clip to resync.
      return mac
        ? 'Add a portrait and a voice recording above, then hit Create to make it speak.'
        : 'Add the portrait (or clip) and a voice above, then hit Create to make it speak.'
    case 'motion':
      // It stands above the prompt window (Discord report, 3.0.7: the caption
      // was taken for the field). The local lanes read an optional prompt;
      // the cloud model takes none.
      return backend === 'local'
        ? 'Add a character image and a driving dance/pose video above, then hit Create. The prompt is optional.'
        : 'No prompt needed. Add a character image and a driving dance/pose video above, then hit Create.'
    default:
      return 'No prompt needed. Just hit Create to remove the background.'
  }
}

/**
 * What the Create button says while it waits for the image on the Stage. The
 * Stage shows the drop area, and the button names the same thing, so a
 * disabled Create is never a riddle. Null while nothing of the kind is
 * missing: a lane without a source, or a source that is there.
 */
export function missingSourceHint(opts: { intent: CreateIntent; needsSource: boolean; hasSource: boolean }): string | null {
  if (!opts.needsSource || opts.hasSource) return null
  return opts.intent === 'animate' ? 'Add a start image first.' : 'Add an image first.'
}

/**
 * Should the caption be on screen right now?
 *
 * Never while a run is going (nothing there is an instruction any more), and
 * never for an "add X above" caption whose inputs are already in. The action
 * captions (cutout, upscale, eraser) stay: they describe the click rather than
 * a missing input, and the eraser's mask is deliberately not part of
 * `specialReady`, so hiding on readiness would drop the one line that tells
 * people to paint a mask.
 */
export function shouldShowLaneHint(opts: {
  /** meta.needsPrompt || characterUse — a lane with a prompt field shows none of this. */
  needPrompt: boolean
  /** A run is in flight. */
  isGenerating: boolean
  intent: CreateIntent
  /** Per-intent input readiness, as computed by the Composer. */
  specialReady: boolean
}): boolean {
  if (opts.needPrompt) return false
  if (opts.isGenerating) return false
  return !(INPUT_HINT_INTENTS.has(opts.intent) && opts.specialReady)
}
