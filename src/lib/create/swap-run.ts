// What a Swap Character run checks and sends. Pure, apart from the upload
// callback it is handed, so the rules are tested without a store or network.
//
// On the web these rules sit in lib/create/engine.ts (validateCreateJob,
// buildCreateParams). The desktop's engine.ts is the mirror of the web engine
// for Create in chat, which cannot order a swap; the Create tab starts its
// runs in hooks/useCloudCreate.ts and reads them from here. Sentences and
// fields are the web's, so a desktop run books and fails like a web run.

import { STUDIO_MODELS } from '../render/studio-contract'
import {
  swapClipSeconds, swapFixedOptions, swapMaxPeople, swapNeedsConsent, swapReadsRoles, swapRoles,
  SWAP_CONSENT_MISSING, SWAP_INTENT,
} from '../render/swap'
import type { CloudJobParams } from '../../api/cloud/jobs'

/** One new person as the run sees it. `image` is whatever the caller uploads. */
export interface SwapRunFigure<T> { image: T | null; role: string }

export interface SwapRunState<T> {
  /** The original video is there. */
  hasVideo: boolean
  figures: SwapRunFigure<T>[]
  /** The consent box is ticked. */
  consent: boolean
}

/** Why this run cannot start, or null. The same order as the web engine. */
export function swapInputError<T>(model: string, s: SwapRunState<T>): string | null {
  if (!s.hasVideo) return 'Add the original video first.'
  const figures = s.figures
  if (!figures.length || !figures[0].image) return 'Add a photo of the new person.'
  const missing = figures.findIndex((f) => !f.image)
  if (missing >= 0) return `Add a photo for person ${missing + 1}, or remove that person.`
  // No silent model switch: the panel switches to the main model when a
  // second person is added, and says so.
  if (figures.length > swapMaxPeople(model)) {
    return swapMaxPeople(model) === 1
      ? 'This model replaces one person. Use OpenJutsu for up to 4 people, or remove the others.'
      : `This model replaces at most ${swapMaxPeople(model)} people.`
  }
  if (figures.some((f) => f.role.length > 200)) return 'Keep each role under 200 characters.'
  if (swapNeedsConsent(model) && !s.consent) return SWAP_CONSENT_MISSING
  return null
}

/** Is the Create button armed for these inputs? The same rule as above. */
export function swapReady<T>(model: string, s: SwapRunState<T>): boolean {
  return swapInputError(model, s) === null
}

/** The part of the params a swap run adds: the photos (a list with roles for
 *  the main model, the first photo as the still for a one-person model), the
 *  options the mode fixes, the chosen length and the consent. Uploads go
 *  through `upload` in the order of the people; `roles` and the provider's
 *  picture order point at that order. */
export async function swapRunParams<T>(
  model: string,
  s: SwapRunState<T> & { chosenSeconds: number | null },
  studioOptions: Record<string, unknown>,
  upload: (image: T, index: number, total: number) => Promise<string>,
): Promise<Pick<CloudJobParams, 'image_paths' | 'source_path' | 'studio_options' | 'clip_seconds' | 'swap_consent'>> {
  const out: Pick<CloudJobParams, 'image_paths' | 'source_path' | 'studio_options' | 'clip_seconds' | 'swap_consent'> = {}
  const figures = s.figures.filter((f): f is SwapRunFigure<T> & { image: T } => f.image !== null)
  const reads = Object.values(STUDIO_MODELS[model]?.inputs ?? {})
  let options: Record<string, unknown> = { ...studioOptions, ...swapFixedOptions(SWAP_INTENT, model) }
  if (figures.length && reads.includes('image_paths')) {
    const paths: string[] = []
    for (const [i, f] of figures.entries()) paths.push(await upload(f.image, i, figures.length))
    out.image_paths = paths
    const roles = swapReadsRoles(model) ? swapRoles(figures) : undefined
    if (roles) options = { ...options, roles }
  } else if (figures.length && reads.includes('source_path')) {
    out.source_path = await upload(figures[0].image, 0, 1)
  }
  out.studio_options = options
  // The length that runs, never more than the model reads. The server cuts a
  // longer video to exactly these seconds.
  out.clip_seconds = swapClipSeconds(model, s.chosenSeconds)
  if (swapNeedsConsent(model) && s.consent) out.swap_consent = true
  return out
}
