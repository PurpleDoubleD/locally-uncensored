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
  swapClipSeconds, swapDefaultOptions, swapFigureRoles, swapFixedOptions, swapMaxPeople, swapNeedsConsent,
  swapReadsRoles, swapRoles, swapUsesFrame, swapWholeSeconds, SWAP_CONSENT_MISSING, SWAP_INTENT, type SwapMark,
} from '../render/swap'
import type { CloudJobParams } from '../../api/cloud/jobs'

/** One new person as the run sees it. `image` is whatever the caller uploads. */
export interface SwapRunFigure<T> { image: T | null; role: string; mark?: SwapMark | null }

export interface SwapRunState<T> {
  /** The original video is there. */
  hasVideo: boolean
  figures: SwapRunFigure<T>[]
  /** The consent box is ticked. */
  consent: boolean
  /** SCAIL 2 and Kling (two steps): the job of the confirmed first frame, only
   *  while it still fits video, photos, marks and roles (swapConfirmedFrame). */
  frameJobId?: string | null
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
      ? 'This model replaces one person. Use SCAIL-2 for up to 3 people, or remove the others.'
      : `This model replaces at most ${swapMaxPeople(model)} people.`
  }
  if (figures.some((f) => f.role.length > 200)) return 'Keep each role under 200 characters.'
  if (swapNeedsConsent(model) && !s.consent) return SWAP_CONSENT_MISSING
  // Two steps: build and confirm the first frame, then the video.
  if (swapUsesFrame(SWAP_INTENT, model) && !s.frameJobId) return 'Build the first frame and check it before you start the video.'
  return null
}

/** The confirmed first frame as an input of the video run: the server copies
 *  the own result into the customer's folder (POST /api/jobs/adopt). A frame
 *  that is gone (404) or not finished (409) reads like the engine's adopt. */
export async function adoptSwapFrame(adopt: (jobId: string, role: 'image') => Promise<string>, jobId: string): Promise<string> {
  try {
    return await adopt(jobId, 'image')
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status
    if (status === 404 || status === 409) throw new Error('That first frame has expired. Build it again.')
    throw err
  }
}

/** Is the Create button armed for these inputs? The same rule as above. */
export function swapReady<T>(model: string, s: SwapRunState<T>): boolean {
  return swapInputError(model, s) === null
}

type SwapParams = Pick<CloudJobParams, 'image_paths' | 'source_path' | 'studio_options' | 'clip_seconds' | 'swap_consent' | 'swap_step'>

/** The part of the params a swap run adds: the photos (a list with roles for
 *  OpenJutsu, the first photo as the still for a one-person model), the
 *  options the mode presets and fixes, the chosen length and the consent.
 *  Uploads go through `upload` in the order of the people; `roles` and the
 *  provider's picture order point at that order.
 *
 *  SCAIL 2 and Kling (two steps): the confirmed first frame is the image of
 *  the run. It is an own result; the server copies it into the customer's
 *  folder (`adopt`, POST /api/jobs/adopt), no outside address goes to the
 *  provider. The length runs on whole seconds of the measured video. */
export async function swapRunParams<T>(
  model: string,
  s: SwapRunState<T> & { chosenSeconds: number | null; videoSeconds?: number },
  studioOptions: Record<string, unknown>,
  upload: (image: T, index: number, total: number) => Promise<string>,
  adopt?: (jobId: string) => Promise<string>,
): Promise<SwapParams> {
  const out: SwapParams = {}
  const figures = s.figures.filter((f): f is SwapRunFigure<T> & { image: T } => f.image !== null)
  const reads = Object.values(STUDIO_MODELS[model]?.inputs ?? {})
  // What Swap presets (SCAIL 2: 720p) while the customer picks nothing; what
  // the mode fixes wins (SCAIL 2: replace).
  let options: Record<string, unknown> = { ...swapDefaultOptions(SWAP_INTENT, model), ...studioOptions, ...swapFixedOptions(SWAP_INTENT, model) }
  const twoStep = swapUsesFrame(SWAP_INTENT, model)
  if (twoStep) {
    if (s.frameJobId) {
      if (!adopt) throw new Error('Build the first frame and check it before you start the video.')
      out.source_path = await adopt(s.frameJobId)
    }
    out.swap_step = 'video'
  } else if (figures.length && reads.includes('image_paths')) {
    const paths: string[] = []
    for (const [i, f] of figures.entries()) paths.push(await upload(f.image, i, figures.length))
    out.image_paths = paths
    // Roles: what the customer writes, else where their mark sits in the frame.
    const placed = swapFigureRoles(figures)
    const roles = swapReadsRoles(model) ? swapRoles(placed.map((role) => ({ role }))) : undefined
    if (roles) options = { ...options, roles }
  } else if (figures.length && reads.includes('source_path')) {
    out.source_path = await upload(figures[0].image, 0, 1)
  }
  out.studio_options = options
  // The length that runs, never more than the model reads. The server cuts a
  // longer video to exactly these seconds.
  out.clip_seconds = twoStep
    ? swapWholeSeconds(model, s.chosenSeconds, s.videoSeconds)
    : swapClipSeconds(model, s.chosenSeconds)
  if (swapNeedsConsent(model) && s.consent) out.swap_consent = true
  return out
}
