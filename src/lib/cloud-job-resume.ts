// Picks the booked cloud renders back up after a restart or a return.
//
// lib/pending-cloud-jobs.ts holds the ids. This file asks the server about
// each one nobody in this session is polling, keeps polling the ones that are
// still rendering, and lands every finished result in the gallery, the same
// way the live run would have.
//
// Runs on a phone at the start and on every return to the foreground (wired in
// lib/mobile-lifecycle.ts). On a desktop the ledger is always empty, so a call
// returns at once and asks nobody.
//
// It never touches isGenerating or the progress bar: a result from the last
// session lands quietly, the screen stays free for the next run.

import { getJob, pollJob, CloudJobError } from '../api/cloud/jobs'
import { waitForTrainedLora } from '../api/cloud/loras'
import type { CloudJob } from '../api/cloud/jobs'
import { galleryItemFromJob } from './render/cloud-jobs'
import { useCreateStore } from '../stores/createStore'
import { useCloudAuthStore } from '../stores/cloudAuthStore'
import type { GalleryItem } from '../stores/createStore'
import {
  adoptPendingCloudJob, cloudSiblingJobId, cloudSubmitIntents, forgetCloudSubmitIntent, forgetPendingCloudJob,
  isLiveCloudSubmit, isWatchedCloudJob, pendingCloudJobs, unwatchCloudJob, watchCloudJob,
} from './pending-cloud-jobs'
import type { CloudSubmitIntent, PendingCloudJob } from './pending-cloud-jobs'
import { log } from './logger'

/** An entry older than this is asked exactly once more and then dropped: the
 *  server has long finished or failed it either way. */
export const PENDING_MAX_AGE_MS = 48 * 60 * 60_000

/** However little is left of the original deadline, a resumed job gets at
 *  least this long before the loop lets go of it until the next return. */
export const RESUME_MIN_WINDOW_MS = 2 * 60_000

const TERMINAL = new Set(['succeeded', 'failed', 'canceled'])

export interface CloudJobResumeSummary {
  /** Results that are in the gallery now (or a character on the shelf). */
  landed: string[]
  /** Jobs the server ended without a result, with its own sentence. */
  failed: { id: string; error: string | null }[]
  /** Still rendering or not reachable right now. Asked again next time. */
  waiting: string[]
  /** Unknown to the server, cancelled, or too old to wait for. */
  dropped: string[]
}

type Listener = (summary: CloudJobResumeSummary) => void
const listeners = new Set<Listener>()

/**
 * Hear about every resume pass that changed something. The shell uses it to
 * refresh the credit meter and to say that a render finished meanwhile.
 * Returns the unsubscribe.
 */
export function onCloudJobsResumed(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** The gallery item a job from the ledger becomes. Pure, exported for tests. */
export function galleryItemForResumedJob(entry: PendingCloudJob, job: CloudJob): GalleryItem {
  return {
    ...galleryItemFromJob(job),
    prompt: entry.prompt,
    ...(entry.item ?? {}),
    // The identity and the media always come from the server's answer, never
    // from what the ledger remembered.
    id: job.id,
    jobId: job.id,
    createdAt: Date.now(),
    remoteUrl: job.result_url ?? undefined,
    attestation: job.attestation,
    dataUrl: undefined,
  } as GalleryItem
}

type Outcome = 'landed' | 'failed' | 'waiting' | 'dropped'

function land(entry: PendingCloudJob, job: CloudJob): Outcome {
  const st = useCreateStore.getState()
  if (job.status === 'canceled') return 'dropped'
  if (job.status !== 'succeeded') return 'failed'
  if (entry.landing === 'character') {
    st.bumpCharactersVersion()
    // Fall E7: the character reaches the shelf a moment after the job says
    // done. Read the shelf once more when it is there.
    void waitForTrainedLora(job).then((shelf) => {
      if (shelf) useCreateStore.getState().bumpCharactersVersion()
    })
    return 'landed'
  }
  if (!job.result_url) return 'failed'
  // mergeGallery, not addToGallery: it is idempotent by job id (a result the
  // live run already landed is only re-signed) and it never moves the model
  // picker, which a result from the last session has no business doing.
  st.mergeGallery([galleryItemForResumedJob(entry, job)])
  if (entry.landing === 'voice' && !st.voiceFromJob) {
    const label = entry.prompt.length > 40 ? `${entry.prompt.slice(0, 40)}…` : entry.prompt
    st.setVoiceFromJob({ jobId: job.id, label })
  }
  return 'landed'
}

async function settle(entry: PendingCloudJob, signal?: AbortSignal): Promise<{ outcome: Outcome; job?: CloudJob }> {
  const tooOld = Date.now() - entry.startedAt > PENDING_MAX_AGE_MS
  try {
    const job = tooOld
      ? await getJob(entry.id)
      : await pollJob(entry.id, {
          signal,
          timeoutMs: Math.max(entry.deadlineAt - Date.now(), RESUME_MIN_WINDOW_MS),
        })
    if (!TERMINAL.has(job.status)) {
      // Only the too-old branch gets here: pollJob returns end states only.
      forgetPendingCloudJob(entry.id)
      return { outcome: 'dropped', job }
    }
    const outcome = land(entry, job)
    forgetPendingCloudJob(entry.id)
    return { outcome, job }
  } catch (err) {
    const status = err instanceof CloudJobError ? err.status : 0
    if (status === 401) sawSignedOut = true
    // The server knows no such job (or refuses it for good): waiting longer
    // changes nothing. 401, 408 and 429 pass, as they do in pollJob.
    const definitive = status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429
    if (definitive || tooOld) {
      forgetPendingCloudJob(entry.id)
      return { outcome: 'dropped' }
    }
    return { outcome: 'waiting' }
  } finally {
    unwatchCloudJob(entry.id)
  }
}

/**
 * A submit this young may still be on its way into the server's table. "No
 * such job" is only believed once the intent is older than this.
 */
export const INTENT_GRACE_MS = 2 * 60_000

function statusOf(err: unknown): number {
  return err instanceof CloudJobError ? err.status : 0
}

/**
 * A submit of an earlier session whose answer was never read (H2). The server
 * books the first job of a run under the client_request_id itself, so the id
 * is ASKED for, never sent again: a job that exists goes into the ledger and
 * is polled like any other, a job that does not exist was never booked and
 * the intent is dropped. Returns true while the question is still open.
 */
async function adoptIntent(intent: CloudSubmitIntent): Promise<boolean> {
  const age = Date.now() - intent.sentAt
  let first: CloudJob
  try {
    first = await getJob(intent.requestId)
  } catch (err) {
    const status = statusOf(err)
    if (status === 401) sawSignedOut = true
    const unknown = status === 404 || status === 400 || status === 403
    if ((unknown && age > INTENT_GRACE_MS) || age > PENDING_MAX_AGE_MS) {
      forgetCloudSubmitIntent(intent.requestId)
      return false
    }
    return true
  }
  const entry = (id: string, index: number): PendingCloudJob => ({
    id, kind: intent.kind, op: intent.op, model: intent.model, prompt: intent.prompt,
    startedAt: intent.sentAt, deadlineAt: intent.sentAt + intent.timeoutMs,
    landing: intent.landing, item: intent.items?.[index],
  })
  adoptPendingCloudJob(entry(first.id, 0))
  // Several images in one run: the others were booked under derived ids.
  let open = false
  for (let index = 1; index < intent.count; index++) {
    try {
      const id = await cloudSiblingJobId(intent.requestId, index)
      const job = await getJob(id)
      adoptPendingCloudJob(entry(job.id, index))
    } catch (err) {
      const status = statusOf(err)
      // 404: the run stopped before this image (empty wallet) and it was never booked.
      if (!(status === 404 || status === 400 || status === 403) && age <= PENDING_MAX_AGE_MS) open = true
    }
  }
  if (!open) forgetCloudSubmitIntent(intent.requestId)
  return open
}

/** How long after a pass that left jobs waiting the next one starts. */
export const RESUME_RETRY_MS = 60_000

let running: Promise<CloudJobResumeSummary> | null = null
let nextLook: ReturnType<typeof setTimeout> | null = null

// ── Nobody to ask (review N8) ───────────────────────────────────────────
//
// Signed out or without a network every question ends the same way. The loop
// used to ask anyway, five tries a pass and a new pass every minute, for up
// to two days. Now it stops and waits for the one thing that can change the
// answer: the next sign-in, or the network coming back. The entries stay on
// disk, a return to the app still looks once.

/** A 401 came back during the running pass. */
let sawSignedOut = false
let stopWaitingForSignIn: (() => void) | null = null
let stopWaitingForNetwork: (() => void) | null = null

function hasNoNetwork(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

function isSignedOut(): boolean {
  try {
    return useCloudAuthStore.getState().status === 'signed-out'
  } catch {
    return false
  }
}

/** Look again the moment somebody is signed in. One listener, however often it is asked for. */
function waitForSignIn(): void {
  if (stopWaitingForSignIn) return
  let was = useCloudAuthStore.getState().status
  const off = useCloudAuthStore.subscribe((state) => {
    const now = state.status
    const signedIn = now === 'signed-in' && was !== 'signed-in'
    was = now
    if (!signedIn) return
    off()
    stopWaitingForSignIn = null
    void resumePendingCloudJobs()
  })
  stopWaitingForSignIn = off
}

/** Look again the moment the phone has a network (the browser's own event, like onNetworkBack of the shell). */
function waitForNetwork(): void {
  if (stopWaitingForNetwork || typeof window === 'undefined') return
  const back = () => {
    stopWaitingForNetwork?.()
    void resumePendingCloudJobs()
  }
  window.addEventListener('online', back)
  stopWaitingForNetwork = () => {
    window.removeEventListener('online', back)
    stopWaitingForNetwork = null
  }
}

/** True when asking is pointless right now. The wait for what changes that is armed. */
function nobodyToAsk(): boolean {
  if (hasNoNetwork()) {
    waitForNetwork()
    return true
  }
  if (isSignedOut()) {
    waitForSignIn()
    return true
  }
  return false
}

function scheduleNextLook(): void {
  if (nextLook) return
  nextLook = setTimeout(() => {
    nextLook = null
    void resumePendingCloudJobs()
  }, RESUME_RETRY_MS)
}

/**
 * Ask the server about every booked job nobody is polling, keep polling the
 * ones still rendering, land the finished ones in the gallery.
 *
 * Safe to call as often as wanted: a pass that is still running is returned
 * instead of started twice, and a job a live run is polling is left to it.
 * Never throws.
 */
export function resumePendingCloudJobs(opts: { signal?: AbortSignal } = {}): Promise<CloudJobResumeSummary> {
  if (running) return running
  const summary: CloudJobResumeSummary = { landed: [], failed: [], waiting: [], dropped: [] }
  // Submits whose answer nobody read. One a live run is still sending is its own business.
  const intents = cloudSubmitIntents().filter((i) => !isLiveCloudSubmit(i.requestId))
  if (intents.length === 0 && !pendingCloudJobs().some((e) => !isWatchedCloudJob(e.id))) return Promise.resolve(summary)
  if (nobodyToAsk()) {
    // Nothing is asked and no timer is set. Everything stays as it is on disk.
    summary.waiting.push(...pendingCloudJobs().filter((e) => !isWatchedCloudJob(e.id)).map((e) => e.id))
    return Promise.resolve(summary)
  }
  sawSignedOut = false
  const pass = (async () => {
    let openIntents = 0
    for (const intent of intents) {
      try {
        if (await adoptIntent(intent)) openIntents += 1
      } catch (err) {
        openIntents += 1
        log.warn('[cloud-resume] an open submit could not be asked for', { id: intent.requestId, err: String(err) })
      }
    }
    const mine = pendingCloudJobs().filter((e) => watchCloudJob(e.id))
    await Promise.all(mine.map(async (entry) => {
      try {
        const { outcome, job } = await settle(entry, opts.signal)
        if (outcome === 'landed') summary.landed.push(entry.id)
        else if (outcome === 'failed') summary.failed.push({ id: entry.id, error: job?.error ?? null })
        else if (outcome === 'waiting') summary.waiting.push(entry.id)
        else summary.dropped.push(entry.id)
      } catch (err) {
        summary.waiting.push(entry.id)
        log.warn('[cloud-resume] a booked job could not be picked up', { id: entry.id, err: String(err) })
      }
    }))
    if (summary.landed.length || summary.failed.length || summary.dropped.length) {
      for (const fn of [...listeners]) {
        try { fn(summary) } catch { /* a listener must not break the pass */ }
      }
    }
    // Something is still rendering (or the line is down): look again by
    // itself, so a result does not wait for the next visit to the app.
    if (summary.waiting.length || openIntents > 0) {
      // The session is gone (401) or the network is: the minute timer would
      // only repeat that answer. Wait for the sign-in or the network instead.
      if (sawSignedOut) waitForSignIn()
      else if (hasNoNetwork()) waitForNetwork()
      else scheduleNextLook()
    }
    return summary
  })()
  running = pass
  void pass.finally(() => { if (running === pass) running = null })
  return pass
}

/** Test-only. */
export function __resetCloudJobResumeForTests(): void {
  running = null
  listeners.clear()
  if (nextLook) clearTimeout(nextLook)
  nextLook = null
  sawSignedOut = false
  stopWaitingForSignIn?.()
  stopWaitingForSignIn = null
  stopWaitingForNetwork?.()
}
