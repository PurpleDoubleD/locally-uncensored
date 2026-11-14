// Media models taken out of the pickers (24.10.2026, David's go).
//
// A retired model is not deleted. Its price, its upstream route and its name
// stay where they were, because old runs in the gallery carry its id, a
// shipped desktop app may still have it saved as its pick, and a preset a
// customer saved may name it. What changes:
//
//   * no picker, no catalogue route and no preset role lists it any more,
//     so nobody picks it new (CLOUD_MODELS and STUDIO_MODELS leave it out);
//   * the submit route and the studio quote look it up here first:
//       runsAs   the run goes to this model instead. Only where the
//                successor takes the same input, serves the same op and
//                costs no more, so the customer gets the same kind of
//                result for the same or less money;
//       refused  the run is refused with a plain sentence and nothing is
//                booked. For a model that failed every recent run: booking
//                it only to refund it costs the customer a wait and us the
//                upstream charge of a run that never delivers;
//       neither  the run goes through on the old model, at the old price.
//
// Leaf file without imports, so the browser catalogue (studio-catalog.ts),
// the cloud models and the routes all read the same list.

export interface RetiredMediaModel {
  /** The day it left the pickers. */
  since: string
  /** What to pick instead. Shown to a client that still sends the old id. */
  successor: string
  /** The submit route runs this model instead (same op, same inputs, not
   *  dearer). */
  runsAs?: string
  /** The submit route refuses the run instead of booking it. */
  refused?: true
}

export const RETIRED_MEDIA_MODELS: Readonly<Record<string, RetiredMediaModel>> = {
  // Text to image. FLUX 3 Klein is the successor in the picker; a saved pick
  // keeps its old route, because the successor is a studio model with its own
  // options and a classic run cannot be moved onto it.
  hidream: { since: '2026-10-24', successor: 'flux-3-klein' },
  'hunyuan-image': { since: '2026-10-24', successor: 'flux-3-klein' },
  // Clips. LTX-2 renders text and image to video at the same lengths (5 and
  // 8 s), takes the same trained characters and costs less.
  'hunyuan-video': { since: '2026-10-24', successor: 'ltx-2', runsAs: 'ltx-2' },
  'ltx-2.3': { since: '2026-10-24', successor: 'ltx-2', runsAs: 'ltx-2' },
  // Motion and music: the successors are dearer or a different kind of
  // model, so a saved pick keeps its old route.
  'wan-2.2-animate': { since: '2026-10-24', successor: 'wan-2.2-animate-2' },
  'ace-step': { since: '2026-10-24', successor: 'ace-step-1.5' },
  // Speech: v4 takes the same text and voice and costs less per character.
  'eleven-v3': { since: '2026-10-24', successor: 'eleven-v4', runsAs: 'eleven-v4' },
  // Extend. ltx-2-extend timed out on 7 of its last 7 runs, pixverse-extend
  // came back flagged on 5 of 5. The successor is the unfiltered extend under
  // the id the extend picker lists (presetModels('extend'), the studio twin of
  // wan-2.2-spicy-extend): Wan 3.0 Extend filters as well, and a flagged run
  // sent there comes back flagged again (08.11.2026).
  'ltx-2-extend': { since: '2026-10-24', successor: 'preset-wan-2.2-spicy-extend', refused: true },
  'pixverse-extend': { since: '2026-10-24', successor: 'preset-wan-2.2-spicy-extend', refused: true },
}

export function retiredMediaModel(id: string): RetiredMediaModel | undefined {
  return Object.prototype.hasOwnProperty.call(RETIRED_MEDIA_MODELS, id) ? RETIRED_MEDIA_MODELS[id] : undefined
}

export function isRetiredMediaModel(id: string): boolean {
  return retiredMediaModel(id) !== undefined
}

/** The id a run of `id` really goes to: the successor where the old model
 *  runs as it, else the id itself. */
export function submitModelId(id: string): string {
  return retiredMediaModel(id)?.runsAs ?? id
}

/** The sentence a client gets for a refused retired model. */
export function retiredRefusal(label: string): string {
  return `${label} is no longer offered. Pick another model and run it again. Nothing was charged.`
}
