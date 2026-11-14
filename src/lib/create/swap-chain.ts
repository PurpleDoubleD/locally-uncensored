// Swap with one click (14.11.2026, David's call, only with the account switch
// features.characterHub; port of the web's lib/create/swap-chain.ts,
// 4395e8d1). One press on "Create · total" runs the whole chain: first the
// first frame with the new people (frame step), then the video on that frame
// (SCAIL 2 or Kling), then, when chosen, the new voice with the lips. With
// "Check first frame before video" the chain stops after the frame (Try
// again / Continue).
//
// The steps are the jobs that exist already (swap_step 'frame', 'video',
// 'lipsync' with swap_consent). New is only the steering, and it runs in the
// app. To survive a reload or a restart, every input is on the server before
// the first job (video, photos, voice uploaded), and the state of the chain
// stands in localStorage: which jobs run and what is sent next. Whoever opens
// the panel again carries on at exactly that place (resumeSwapChain). While
// the app is closed only the job that is due runs; the next one is sent by
// the reopened panel, never twice.
//
// Without React and without the Create store, like swap-frame.ts: upload,
// adopt, submit, poll and cancel are handed in.

import { createStore } from 'zustand/vanilla'
import { CloudJobError } from '../../api/cloud/client'
import type { AdoptRole, CloudJob, CloudJobSubmit, UploadRole } from '../../api/cloud/jobs'
import { dataUrlToBlob } from '../render/data-url'
import { lipsyncSubmit } from '../render/sound'
import {
  swapFigureRoles, swapFrameFiltered, swapFrameMaxPeople, swapFrameOptionsFor, swapFramePrompt,
  SWAP_CONSENT_MISSING, SWAP_FRAME_MODEL, SWAP_FRAME_OPEN_MODEL, type SwapMark,
} from '../render/swap'
import { adoptResult, describeSubmitError, failedJobText, type RunDeps } from './engine'
import { swapFrameCredits, swapFrameSubmit } from './swap-frame'
import { lipsyncFailedText } from './lipsync-chain'

export type SwapChainStage = 'frame' | 'review' | 'video' | 'sound' | 'done' | 'refused' | 'failed' | 'canceled'

/** Stages in which a job runs or is about to be sent. */
export const SWAP_CHAIN_RUNNING: readonly SwapChainStage[] = ['frame', 'video', 'sound']

export interface SwapChainState {
  v: 1
  stage: SwapChainStage
  startedAt: number
  /** "Bean and Sam": who comes into the picture, for the caption. */
  who: string
  /** Frame step: editor, size of the video frame, people, roles. */
  frameModel: string
  frameSize: { width: number; height: number }
  people: number
  roles: string[]
  frameSubmit: CloudJobSubmit
  frameCredits: number
  frameJobId: string | null
  frameUrl: string | null
  /** Stop after the frame ("Check first frame before video"). */
  check: boolean
  /** Video step, built except for the image (source_path), which only comes
   *  from the frame step. */
  videoSubmit: CloudJobSubmit
  videoCredits: number
  videoJobId: string | null
  /** New voice with lips: the voice is on the server already. */
  lipsync: { model: string; audioPath: string; credits: number } | null
  lipJobId: string | null
  /** The job whose result stands at the end. */
  resultJobId: string | null
  resultUrl: string | null
  error: string | null
}

export const SWAP_CHAIN_STORAGE_KEY = 'lu.swapChain.v1'

function readStored(): SwapChainState | null {
  try {
    const raw = globalThis.localStorage?.getItem(SWAP_CHAIN_STORAGE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as SwapChainState
    return s && s.v === 1 && typeof s.stage === 'string' ? s : null
  } catch { return null }
}

function writeStored(s: SwapChainState | null): void {
  try {
    if (s) globalThis.localStorage?.setItem(SWAP_CHAIN_STORAGE_KEY, JSON.stringify(s))
    else globalThis.localStorage?.removeItem(SWAP_CHAIN_STORAGE_KEY)
  } catch { /* storage refused: the chain still runs, only without resuming */ }
}

/** The state of the chain. `busy`: this window follows a job right now. */
export const swapChainStore = createStore<{ chain: SwapChainState | null; busy: boolean; note: string | null }>(() => ({
  chain: null, busy: false, note: null,
}))

/** Reads the stored state (once per start of the app). */
export function loadSwapChain(): SwapChainState | null {
  const stored = readStored()
  if (stored && !swapChainStore.getState().chain) swapChainStore.setState({ chain: stored })
  return swapChainStore.getState().chain
}

function patch(p: Partial<SwapChainState>): SwapChainState | null {
  const cur = swapChainStore.getState().chain
  if (!cur) return null
  const next = { ...cur, ...p }
  swapChainStore.setState({ chain: next })
  writeStored(next)
  return next
}

/** Clears the chain away (result seen, refused, start over). */
export function clearSwapChain(): void {
  abort?.abort()
  abort = null
  swapChainStore.setState({ chain: null, busy: false, note: null })
  writeStored(null)
}

/** Did a filtered editor refuse the image? The server then names an open
 *  alternative (fallback_model) or the sentence of a refusal. */
export function swapFrameRefused(job: Pick<CloudJob, 'status' | 'error' | 'fallback_model'>): boolean {
  if (job.status !== 'failed') return false
  return !!job.fallback_model || /declined|could not be rendered/i.test(job.error ?? '')
}

/** The sentence of a refusal. A failed run is refunded, so nothing is
 *  charged, not the image either. */
export const SWAP_REFUSED_TEXT = 'The first-frame model refused this image. Nothing was charged, and the video was not started.'

export interface SwapChainDeps extends RunDeps {
  uploadInput: (file: Blob, role: UploadRole) => Promise<string>
  adoptInput: (jobId: string, role: AdoptRole) => Promise<string>
  /** A finished result (video, or video with the new voice) into the gallery. */
  onResult?: (job: CloudJob) => void
  /** Read the credits again (after submit, cancel, failure). */
  onQuota?: () => void
}

/** A person as the chain reads it: a photo (data: URL). On the desktop a
 *  character from the list is its picture as a photo (hubPortrait). */
export interface SwapChainFigure {
  image: { url: string } | null
  role: string
  mark?: SwapMark | null
}

export interface SwapChainStart {
  frame: { url: string; width: number; height: number } | null
  figures: SwapChainFigure[]
  frameModel: string
  check: boolean
  consent: boolean
  who: string
  /** The video job without its image, built like every Create run. */
  videoSubmit: CloudJobSubmit
  videoCredits: number
  lipsync: { model: string; audio: { type: 'blob'; blob: Blob } | { type: 'job'; jobId: string }; credits: number } | null
}

/** What is missing before the chain can start, as a sentence for the customer. */
export function swapChainProblem(start: Pick<SwapChainStart, 'frame' | 'figures' | 'frameModel' | 'consent'>): string | null {
  if (!start.frame) return 'Add the original video first.'
  const missing = start.figures.findIndex((f) => !f.image)
  if (!start.figures.length || missing === 0) return 'Pick a character or a photo for the person you replace.'
  if (missing > 0) return `Pick a character or a photo for person ${missing + 1}, or remove that mark.`
  const max = swapFrameMaxPeople(start.frameModel)
  if (start.figures.length > max) {
    return `This first-frame model takes ${max} ${max === 1 ? 'person' : 'people'}. Pick another one under More options.`
  }
  if (start.figures.some((f) => f.role.length > 200)) return 'Keep each role under 200 characters.'
  if (!start.consent) return SWAP_CONSENT_MISSING
  return null
}

/** The price of the whole chain, as the button shows it. */
export function swapChainTotal(parts: { frame: number | null; video: number | null; lipsync?: number | null }): number | null {
  if (parts.frame == null || parts.video == null) return null
  return parts.frame + parts.video + (parts.lipsync ?? 0)
}

let abort: AbortController | null = null
let running: Promise<void> | null = null

/** Uploads the inputs, lays the chain down and runs it. Throws with the text
 *  for the customer when something is missing; nothing is booked then. */
export async function startSwapChain(start: SwapChainStart, deps: SwapChainDeps): Promise<void> {
  const problem = swapChainProblem(start)
  if (problem) throw new Error(problem)
  const cur = swapChainStore.getState().chain
  if (cur && SWAP_CHAIN_RUNNING.includes(cur.stage)) throw new Error('A swap is already running.')
  swapChainStore.setState({ busy: true, note: 'Uploading…' })
  try {
    const framePath = await deps.uploadInput(dataUrlToBlob(start.frame!.url), 'source')
    const figurePaths: string[] = []
    for (const f of start.figures) figurePaths.push(await deps.uploadInput(dataUrlToBlob(f.image!.url), 'source'))
    const lipsync = start.lipsync
      ? {
          model: start.lipsync.model,
          credits: start.lipsync.credits,
          audioPath: start.lipsync.audio.type === 'blob'
            ? await deps.uploadInput(start.lipsync.audio.blob, 'audio')
            : await adoptResult(deps.adoptInput, start.lipsync.audio.jobId, 'audio'),
        }
      : null
    const { width, height } = start.frame!
    const frameCredits = swapFrameCredits(width, height, start.figures.length, start.frameModel) ?? 0
    const roles = swapFigureRoles(start.figures.map((f) => ({ role: f.role, mark: f.mark ?? null })))
    const frameSubmit = swapFrameSubmit(framePath, figurePaths, {
      frame: start.frame, figures: start.figures.map((f) => ({ imageUrl: f.image!.url, role: f.role, mark: f.mark ?? null })),
      model: '', consent: start.consent, credits: frameCredits, frameModel: start.frameModel,
    })
    const chain: SwapChainState = {
      v: 1, stage: 'frame', startedAt: Date.now(), who: start.who,
      frameModel: start.frameModel, frameSize: { width, height }, people: start.figures.length, roles,
      frameSubmit, frameCredits, frameJobId: null, frameUrl: null, check: start.check,
      videoSubmit: start.videoSubmit, videoCredits: start.videoCredits, videoJobId: null,
      lipsync, lipJobId: null, resultJobId: null, resultUrl: null, error: null,
    }
    swapChainStore.setState({ chain, note: null })
    writeStored(chain)
  } catch (err) {
    swapChainStore.setState({ busy: false, note: null })
    throw err
  }
  swapChainStore.setState({ busy: false })
  await advanceSwapChain(deps)
}

/** Runs the chain on from the stored state until it stops (check, done,
 *  error) or this window no longer waits. Only once at a time. */
export function advanceSwapChain(deps: SwapChainDeps): Promise<void> {
  if (running) return running
  running = (async () => {
    const ac = new AbortController()
    abort = ac
    swapChainStore.setState({ busy: true })
    try {
      await drive(deps, ac.signal)
    } finally {
      if (abort === ac) abort = null
      running = null
      swapChainStore.setState({ busy: false })
    }
  })()
  return running
}

/** On reopening: follow a running chain on. */
export function resumeSwapChain(deps: SwapChainDeps): Promise<void> | null {
  const chain = loadSwapChain()
  if (!chain || !SWAP_CHAIN_RUNNING.includes(chain.stage)) return null
  return advanceSwapChain(deps)
}

async function follow(id: string, deps: SwapChainDeps, signal: AbortSignal, timeoutMs: number): Promise<CloudJob | null> {
  try {
    return await deps.pollJob(id, { signal, timeoutMs })
  } catch (err) {
    if (err instanceof CloudJobError && err.message === 'polling aborted') return null
    if (err instanceof CloudJobError && err.message === 'render timed out') {
      // The job lives on; the chain carries on the next time the panel opens.
      swapChainStore.setState({ note: 'Still rendering. This takes longer than usual; it continues when you come back.' })
      return null
    }
    throw err
  }
}

async function drive(deps: SwapChainDeps, signal: AbortSignal): Promise<void> {
  for (;;) {
    const s = swapChainStore.getState().chain
    if (!s || !SWAP_CHAIN_RUNNING.includes(s.stage) || signal.aborted) return
    try {
      if (s.stage === 'frame') {
        let id = s.frameJobId
        if (!id) {
          id = (await deps.submitCloudJob(s.frameSubmit)).id
          patch({ frameJobId: id })
          deps.onQuota?.()
        }
        const job = await follow(id, deps, signal, 10 * 60_000)
        if (!job) return
        if (job.status === 'succeeded' && job.result_url) {
          patch({ frameUrl: job.result_url, stage: s.check ? 'review' : 'video' })
        } else if (job.status === 'canceled') {
          patch({ stage: 'canceled' })
        } else {
          // Refused or failed: the video does not start, nothing of it is
          // booked (a failed run is refunded).
          deps.onQuota?.()
          patch(swapFrameFiltered(s.frameModel) && swapFrameRefused(job)
            ? { stage: 'refused', error: SWAP_REFUSED_TEXT }
            : { stage: 'failed', error: `The first frame failed: ${failedJobText(job)} The video was not started.` })
        }
      } else if (s.stage === 'video') {
        let id = s.videoJobId
        if (!id) {
          const sourcePath = await adoptResult(deps.adoptInput, s.frameJobId!, 'image')
          if (signal.aborted) return
          id = (await deps.submitCloudJob({ ...s.videoSubmit, params: { ...s.videoSubmit.params, source_path: sourcePath } })).id
          patch({ videoJobId: id })
          deps.onQuota?.()
        }
        const job = await follow(id, deps, signal, 45 * 60_000)
        if (!job) return
        if (job.status === 'succeeded' && job.result_url) {
          deps.onResult?.(job)
          patch(s.lipsync
            ? { stage: 'sound', resultJobId: job.id, resultUrl: job.result_url }
            : { stage: 'done', resultJobId: job.id, resultUrl: job.result_url })
        } else if (job.status === 'canceled') {
          patch({ stage: 'canceled' })
        } else {
          deps.onQuota?.()
          patch({ stage: 'failed', error: failedJobText(job) })
        }
      } else if (s.stage === 'sound' && s.lipsync) {
        let id = s.lipJobId
        if (!id) {
          const videoPath = await adoptResult(deps.adoptInput, s.videoJobId!, 'video')
          if (signal.aborted) return
          id = (await deps.submitCloudJob(lipsyncSubmit(s.lipsync.model, videoPath, s.lipsync.audioPath, s.lipsync.credits, true))).id
          patch({ lipJobId: id })
          deps.onQuota?.()
        }
        const job = await follow(id, deps, signal, 30 * 60_000)
        if (!job) return
        if (job.status === 'succeeded' && job.result_url) {
          deps.onResult?.(job)
          patch({ stage: 'done', resultJobId: job.id, resultUrl: job.result_url })
        } else {
          // The video is there already; only the voice is missing.
          deps.onQuota?.()
          patch({ stage: 'done', error: job.status === 'canceled' ? null : lipsyncFailedText(job.error) })
        }
      } else {
        return
      }
    } catch (err) {
      if (signal.aborted) return
      const failure = describeSubmitError(err)
      deps.onQuota?.()
      patch({ stage: s.stage === 'sound' ? 'done' : 'failed', error: s.stage === 'sound' ? lipsyncFailedText(failure.text) : failure.text })
      return
    }
  }
}

/** Continue after the check: the video starts on this frame. */
export function approveSwapFrame(deps: SwapChainDeps): Promise<void> {
  const s = swapChainStore.getState().chain
  if (!s || s.stage !== 'review') return Promise.resolve()
  patch({ stage: 'video' })
  return advanceSwapChain(deps)
}

/** Try again: only the frame step runs again, "What's wrong?" joins the
 *  sentence. With `model` (Turn on Uncensored and retry) on another editor;
 *  `check` sets anew whether the chain stops after the frame. */
export function retrySwapFrame(deps: SwapChainDeps, opts: { extra?: string; model?: string; check?: boolean } = {}): Promise<void> {
  const s = swapChainStore.getState().chain
  if (!s || !['review', 'refused', 'failed'].includes(s.stage) || s.videoJobId) return Promise.resolve()
  const model = opts.model ?? s.frameModel
  const credits = swapFrameCredits(s.frameSize.width, s.frameSize.height, s.people, model) ?? s.frameCredits
  const { max_credits: _old, ...params } = s.frameSubmit.params
  patch({
    stage: 'frame', frameModel: model, frameCredits: credits, frameJobId: null, frameUrl: null, error: null,
    check: opts.check ?? s.check,
    frameSubmit: {
      ...s.frameSubmit,
      model,
      prompt: swapFramePrompt(s.roles, opts.extra, { open: model !== SWAP_FRAME_MODEL }),
      params: {
        ...params,
        studio_options: swapFrameOptionsFor(model, s.frameSize.width, s.frameSize.height),
        max_credits: credits,
      },
    },
  })
  return advanceSwapChain(deps)
}

/** Turn on Uncensored and retry: the same frame step on the open editor.
 *  `check`: the switch "Check first frame" as it stands after the turn. */
export function retrySwapOpen(deps: SwapChainDeps, check?: boolean): Promise<void> {
  return retrySwapFrame(deps, { model: SWAP_FRAME_OPEN_MODEL, check })
}

/** Cancel: stops the running job. When a GPU has it already (409), it runs to
 *  its end, and the chain says so and sends nothing after it. */
export async function cancelSwapChain(deps: Pick<SwapChainDeps, 'cancelJob' | 'onQuota'>): Promise<'canceled' | 'running'> {
  const s = swapChainStore.getState().chain
  if (!s) return 'canceled'
  const id = s.stage === 'frame' ? s.frameJobId : s.stage === 'video' ? s.videoJobId : s.stage === 'sound' ? s.lipJobId : null
  if (id) {
    try {
      await deps.cancelJob(id)
    } catch (err) {
      if (err instanceof CloudJobError && err.status === 409) {
        swapChainStore.setState({ note: 'This step is already rendering and cannot be stopped. It finishes, and the next step is not started.' })
        // Nothing more after this step.
        patch({ check: true, lipsync: s.stage === 'video' ? null : s.lipsync })
        return 'running'
      }
    }
  }
  abort?.abort()
  patch({ stage: 'canceled' })
  deps.onQuota?.()
  return 'canceled'
}
