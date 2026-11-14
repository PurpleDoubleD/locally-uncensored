// Swap Character in two steps (14.11.2026, part A of the Character Hub, port
// of the web's lib/create/swap-frame.ts).
//
// SCAIL 2 and Kling Motion Control swap people cleanly when their image is the
// first frame of the video with the new people already in it (real runs of
// 13./14.11.: two and three people swapped, stable over the whole clip). Nano
// Banana Pro builds that frame from the first frame and the photos of the
// people. The customer sees it before the video run ("Does this look right?"),
// can have it built again and confirms it with Continue. Only then does Create
// start the video, with this frame as an own result (adopt).
//
// The frame step without React and without the store, like swap-run.ts:
// upload, submit and poll come from outside. The server and worker parts
// (studio-prepare, swap-length, submit-job) live on the web only; the desktop
// sends the same params.

import type { CloudJob, CloudJobSubmit, UploadRole } from '../../api/cloud/jobs'
import { studioPreviewCredits } from '../render/studio-contract'
import { dataUrlToBlob } from '../render/data-url'
import {
  swapFigureRoles, swapFrameKey, swapFrameOptionsFor, swapFramePrompt, swapMaxPeople,
  SWAP_CONSENT_MISSING, SWAP_FRAME_MODEL, type SwapMark,
} from '../render/swap'

/** A person as the frame step reads it. */
export interface SwapFrameFigure { imageUrl: string | null; role: string; mark?: SwapMark | null }

/** What the frame step needs. */
export interface SwapFrameRequest {
  /** The first frame of the video as a data: URL, with its size. */
  frame: { url: string; width: number; height: number } | null
  figures: SwapFrameFigure[]
  /** The video model, for its limit of people. */
  model: string
  consent: boolean
  /** "What's wrong?" on a second try. */
  extra?: string
  /** The price the button shows: the ceiling of the booking. */
  credits: number | null
  /** One click swap (only with the account switch): the editor of the frame
   *  step. Without it Nano Banana Pro as before. */
  frameModel?: string
}

/** The price of the frame step from the catalogue (Nano Banana Pro, 2k, or
 *  the editor picked). */
export function swapFrameCredits(width: number, height: number, people: number, model: string = SWAP_FRAME_MODEL): number | null {
  return studioPreviewCredits(model, swapFrameOptionsFor(model, width, height), undefined, people + 1)
}

/** What is missing before the frame step can start, as a sentence for the
 *  customer. */
export function swapFrameProblem(req: SwapFrameRequest): string | null {
  if (!req.frame) return 'Add the original video first.'
  if (!req.figures.length || req.figures.some((f) => !f.imageUrl)) {
    const missing = req.figures.findIndex((f) => !f.imageUrl)
    return missing <= 0 ? 'Add a photo of the new person.' : `Add a photo for person ${missing + 1}, or remove that person.`
  }
  if (req.figures.length > swapMaxPeople(req.model)) {
    return swapMaxPeople(req.model) === 1
      ? 'This model replaces one person. Use SCAIL-2 for up to 3 people, or remove the others.'
      : `This model replaces at most ${swapMaxPeople(req.model)} people.`
  }
  if (req.figures.some((f) => f.role.length > 200)) return 'Keep each role under 200 characters.'
  if (!req.consent) return SWAP_CONSENT_MISSING
  return null
}

/** The body for POST /api/jobs: the first frame first, then the photo of each
 *  person, in the order of the people. */
export function swapFrameSubmit(framePath: string, figurePaths: string[], req: SwapFrameRequest): CloudJobSubmit {
  const roles = swapFigureRoles(req.figures)
  const model = req.frameModel ?? SWAP_FRAME_MODEL
  return {
    kind: 'image',
    model,
    prompt: swapFramePrompt(roles, req.extra),
    params: {
      op: 'studio',
      image_paths: [framePath, ...figurePaths],
      studio_options: swapFrameOptionsFor(model, req.frame?.width ?? 0, req.frame?.height ?? 0),
      swap_step: 'frame',
      swap_consent: true,
      ...(req.credits != null ? { max_credits: req.credits } : {}),
      label: 'Swap Character first frame',
    },
  }
}

/** The fingerprint of the current inputs (lib/render/swap.ts, swapFrameKey). */
export function swapKeyOf(videoUrl: string | undefined, figures: { image: { url: string } | null; role: string; mark?: SwapMark | null }[]): string {
  return swapFrameKey(videoUrl ?? '', figures.map((f) => ({ imageUrl: f.image?.url ?? null, role: f.role, mark: f.mark ?? null })))
}

/** The confirmed frame job, if it still fits the inputs, else null. */
export function swapConfirmedFrame(
  built: { jobId: string; key: string; confirmed: boolean } | null,
  videoUrl: string | undefined,
  figures: { image: { url: string } | null; role: string; mark?: SwapMark | null }[],
): string | null {
  return built?.confirmed && built.key === swapKeyOf(videoUrl, figures) ? built.jobId : null
}

/** The three ways to the queue, handed in like the engine's RunDeps. Not
 *  imported from engine.ts: the Create tab's start (useCloudCreate) reads this
 *  file, and the engine pulls the chat's catalogue mirror with it. */
export interface SwapFrameDeps {
  submitCloudJob: (submit: CloudJobSubmit) => Promise<{ id: string }>
  pollJob: (id: string, opts: { signal?: AbortSignal; timeoutMs?: number }) => Promise<CloudJob>
  cancelJob: (id: string) => Promise<unknown>
  uploadInput: (file: Blob, role: UploadRole) => Promise<string>
  signal?: AbortSignal
  onStep?: (text: string) => void
}

/** Uploads the frame and the photos, starts the frame step and waits for it.
 *  Throws with the text for the customer when something is missing. */
export async function runSwapFrame(req: SwapFrameRequest, deps: SwapFrameDeps): Promise<CloudJob> {
  const problem = swapFrameProblem(req)
  if (problem) throw new Error(problem)
  deps.onStep?.('Uploading…')
  const framePath = await deps.uploadInput(dataUrlToBlob(req.frame!.url), 'source')
  const figurePaths: string[] = []
  for (const f of req.figures) figurePaths.push(await deps.uploadInput(dataUrlToBlob(f.imageUrl!), 'source'))
  if (deps.signal?.aborted) throw new Error('Canceled.')
  deps.onStep?.('Building the first frame…')
  const { id } = await deps.submitCloudJob(swapFrameSubmit(framePath, figurePaths, req))
  // A Cancel during the submit found no id yet: the job just taken is
  // canceled at once, so its credits go back (as runCloudJob in engine.ts).
  if (deps.signal?.aborted) {
    void deps.cancelJob(id).catch(() => {})
    throw new Error('Canceled.')
  }
  return deps.pollJob(id, { signal: deps.signal, timeoutMs: 10 * 60_000 })
}
