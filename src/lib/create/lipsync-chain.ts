// The second step of "New voice, lips in sync" (14.11.2026, port of the web's
// lib/create/lipsync-chain.ts): after a finished Swap or Motion video,
// LatentSync (or Lipsync-2) lays the new voice under it and moves the lips to
// it.
//
// The video is the own result of the first run (adopt, as the first frame of
// a swap), the sound the chosen voice: uploaded, or an own earlier run (adopt
// as well). A voice longer than the clip is cut by the server (fit_audio).
// No React, no store. The queue calls are handed in like swap-frame.ts does:
// not imported from engine.ts, which pulls the chat's catalogue mirror in.

import type { AdoptRole, CloudJob, CloudJobSubmit, UploadRole } from '../../api/cloud/jobs'
import { lipsyncSubmit } from '../render/sound'

export interface LipsyncStepRequest {
  /** The finished run whose video gets the lips. */
  videoJobId: string
  /** The voice: a file in the app or an own earlier run. */
  audio: { type: 'blob'; blob: Blob } | { type: 'job'; jobId: string }
  model: string
  /** The price the customer saw: the ceiling of the booking. */
  credits: number | null
  /** In Swap it is a swap step and carries the consent tick. */
  swap: boolean
}

export interface LipsyncStepDeps {
  submitCloudJob: (submit: CloudJobSubmit) => Promise<{ id: string }>
  pollJob: (id: string, opts: { signal?: AbortSignal; timeoutMs?: number; onTick?: (job: CloudJob) => void }) => Promise<CloudJob>
  cancelJob: (id: string) => Promise<unknown>
  uploadInput: (file: Blob, role: UploadRole) => Promise<string>
  adoptInput: (jobId: string, role: AdoptRole) => Promise<string>
  signal?: AbortSignal
  timeoutMs?: number
  /** The id of the step, as soon as the server took it (for Cancel). */
  onSubmitted?: (id: string) => void
  onTick?: (job: CloudJob) => void
}

const EXPIRED: Record<'video' | 'audio', string> = {
  video: 'That video has expired, so the lip sync could not start.',
  audio: 'That voice has expired. Pick it again or upload it.',
}

async function adoptOwn(deps: LipsyncStepDeps, jobId: string, role: 'video' | 'audio'): Promise<string> {
  try {
    return await deps.adoptInput(jobId, role)
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status
    if (status === 404 || status === 409) throw new Error(EXPIRED[role])
    throw err
  }
}

/** Stages video and voice, starts the lip sync step and waits for it. */
export async function runLipsyncStep(req: LipsyncStepRequest, deps: LipsyncStepDeps): Promise<CloudJob> {
  const videoPath = await adoptOwn(deps, req.videoJobId, 'video')
  const audioPath = req.audio.type === 'blob'
    ? await deps.uploadInput(req.audio.blob, 'audio')
    : await adoptOwn(deps, req.audio.jobId, 'audio')
  if (deps.signal?.aborted) throw new Error('polling aborted')
  const { id } = await deps.submitCloudJob(lipsyncSubmit(req.model, videoPath, audioPath, req.credits, req.swap))
  deps.onSubmitted?.(id)
  // A Cancel during the submit found no id yet: the job just taken is
  // canceled at once, so its credits go back (as runCloudJob in engine.ts).
  if (deps.signal?.aborted) {
    void deps.cancelJob(id).catch(() => {})
    throw new Error('polling aborted')
  }
  return deps.pollJob(id, { signal: deps.signal, timeoutMs: deps.timeoutMs ?? 30 * 60_000, onTick: deps.onTick })
}

/** The text when the second step fails: the video is already there. */
export function lipsyncFailedText(reason: string | null | undefined): string {
  return `Your video is in the gallery, but the lip sync failed${reason ? `: ${reason}` : ''}. The lip sync was not charged.`
}
