// The cloud renders this device is still waiting for, kept across a restart.
//
// A cloud job is booked and paid the moment the submit returns. Its id used to
// live in a module variable of hooks/useCloudCreate.ts and nowhere else. A
// phone that kills the app in the background (it does, routinely, during a 5
// minute video render) lost the id, and with it the only way to reach a result
// the customer paid for.
//
// This file is the small ledger: one entry per booked job, written right after
// the submit, removed when the job reached an end state and its result is in
// the gallery. lib/cloud-job-resume.ts reads it after a start and after every
// return to the foreground.
//
// localStorage on purpose, not the create store: the entry has to be on disk
// before the next line of code runs (the system may freeze the WebView at any
// point), and it must not ride on a store that rewrites its whole gallery.
//
// Before the ledger there is the intent (durchsicht-mobile H2): the id of a
// job used to exist only in memory between the tap and the answer of the
// submit. A phone that killed the app in exactly that window left a booked,
// paid job nobody could reach, and the next tap booked a second one. So the
// `client_request_id` is written down BEFORE the request leaves ("sent, answer
// open"). The server books the first job of a run under exactly that id
// (the id is the key of the first job there, further images of one run get
// siblingId(id, index)), so after a restart the
// app only has to ASK for that id. It never sends the submit a second time by
// itself: a job that exists is picked up, a job that does not exist was never
// booked, and no tap can end in two paid jobs.
//
// Only a phone writes entries. The desktop keeps its own rule (the window
// stays open for the length of a render), so its ledger is always empty and
// everything that reads it finds nothing to do.

import { isMobile } from './device-kind'

export const PENDING_CLOUD_JOBS_KEY = 'lu-pending-cloud-jobs'

/** More entries than this are never kept, the oldest go first. */
export const PENDING_CLOUD_JOBS_CAP = 40

/** What kind of landing the finished job gets. */
export type PendingCloudJobLanding =
  /** A picture, clip or sound that goes into the gallery. */
  | 'gallery'
  /** A voice made for a talking character: gallery item plus the voice pick. */
  | 'voice'
  /** A trained character: no media, the character shelf is refreshed. */
  | 'character'

export interface PendingCloudJob {
  /** The id of the job on the server. */
  id: string
  kind: 'image' | 'video' | 'audio' | '3d'
  /** The op of the run (generate, edit, tts, upscale, lora-train, studio ...). */
  op: string
  model: string
  prompt: string
  /** Wall clock, ms, when the submit returned. */
  startedAt: number
  /** Wall clock, ms, until which the live run would have waited. */
  deadlineAt: number
  landing: PendingCloudJobLanding
  /** The gallery fields the live run would have added to the bare job, so a
   *  result that lands after a restart looks like one that landed live. Never
   *  media bytes. */
  item?: Record<string, unknown>
}

export const CLOUD_SUBMIT_INTENTS_KEY = 'lu-cloud-submit-intents'

/** A submit that left the phone and whose answer has not been read yet. */
export interface CloudSubmitIntent {
  /** The client_request_id of the submit, and with it the id of its first job. */
  requestId: string
  /** How many jobs the run asked for (several images). */
  count: number
  kind: 'image' | 'video' | 'audio' | '3d'
  op: string
  model: string
  prompt: string
  /** Wall clock, ms, right before the request left. */
  sentAt: number
  /** How long the live run would have waited for the result. */
  timeoutMs: number
  landing: PendingCloudJobLanding
  /** Gallery fields per job of the run, see PendingCloudJob.item. */
  items?: Record<string, unknown>[]
}

/** True where booked jobs are written down. */
export function tracksPendingCloudJobs(): boolean {
  return isMobile()
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function isEntry(value: unknown): value is PendingCloudJob {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && v.id.length > 0
    && typeof v.kind === 'string' && typeof v.model === 'string'
    && typeof v.startedAt === 'number' && typeof v.deadlineAt === 'number'
}

/** Every job this device still waits for, oldest first. Never throws. */
export function pendingCloudJobs(): PendingCloudJob[] {
  const ls = storage()
  if (!ls) return []
  try {
    const raw = ls.getItem(PENDING_CLOUD_JOBS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry).map((e) => ({
      ...e,
      op: typeof e.op === 'string' ? e.op : 'generate',
      prompt: typeof e.prompt === 'string' ? e.prompt : '',
      landing: e.landing === 'voice' || e.landing === 'character' ? e.landing : 'gallery',
    }))
  } catch {
    return []
  }
}

function write(list: PendingCloudJob[]): void {
  const ls = storage()
  if (!ls) return
  try {
    // An emptied list is written as `[]`, not removed. The backup carries a
    // key it no longer sees over from the previous file (lib/store-backup.ts),
    // so a removed key would leave the finished jobs in the backup for good,
    // and a restore would land their results a second time.
    ls.setItem(PENDING_CLOUD_JOBS_KEY, JSON.stringify(list.slice(-PENDING_CLOUD_JOBS_CAP)))
  } catch {
    // A full disk must not stop a render that is already booked.
  }
}

function isIntent(value: unknown): value is CloudSubmitIntent {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.requestId === 'string' && v.requestId.length > 0
    && typeof v.kind === 'string' && typeof v.model === 'string'
    && typeof v.sentAt === 'number' && typeof v.timeoutMs === 'number'
}

/** Every submit whose answer this device never read, oldest first. Never throws. */
export function cloudSubmitIntents(): CloudSubmitIntent[] {
  const ls = storage()
  if (!ls) return []
  try {
    const raw = ls.getItem(CLOUD_SUBMIT_INTENTS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isIntent).map((e) => ({
      ...e,
      count: typeof e.count === 'number' && e.count >= 1 ? Math.floor(e.count) : 1,
      op: typeof e.op === 'string' ? e.op : 'generate',
      prompt: typeof e.prompt === 'string' ? e.prompt : '',
      landing: e.landing === 'voice' || e.landing === 'character' ? e.landing : 'gallery',
    }))
  } catch {
    return []
  }
}

function writeIntents(list: CloudSubmitIntent[]): void {
  const ls = storage()
  if (!ls) return
  try {
    // `[]` and not removed, for the same reason as the list of jobs above.
    ls.setItem(CLOUD_SUBMIT_INTENTS_KEY, JSON.stringify(list.slice(-PENDING_CLOUD_JOBS_CAP)))
  } catch {
    // A full disk must not stop the submit itself.
  }
}

// Submits of this session that are still on their way. In memory only: after
// a kill nobody is sending anything, and the restart asks for every intent.
const sending = new Set<string>()

/** True while the submit of this session is still waiting for its answer. */
export function isLiveCloudSubmit(requestId: string): boolean {
  return sending.has(requestId)
}

/**
 * Write a submit down BEFORE it is sent. Synchronous, so the entry is on disk
 * before the request leaves. Does nothing on a desktop.
 */
export function noteCloudSubmitIntent(intent: CloudSubmitIntent): void {
  if (!tracksPendingCloudJobs()) return
  sending.add(intent.requestId)
  const rest = cloudSubmitIntents().filter((e) => e.requestId !== intent.requestId)
  writeIntents([...rest, intent])
}

/**
 * The submit of this session ended. `answered` true: the server said yes (the
 * jobs are in the ledger by now) or a clear no (nothing was booked), the
 * intent is done. False: nobody knows whether the job was booked, the intent
 * stays and the next resume pass asks the server for it.
 */
export function settleCloudSubmitIntent(requestId: string, answered: boolean): void {
  sending.delete(requestId)
  if (answered) forgetCloudSubmitIntent(requestId)
}

export function forgetCloudSubmitIntent(requestId: string): void {
  sending.delete(requestId)
  const list = cloudSubmitIntents()
  if (!list.some((e) => e.requestId === requestId)) return
  writeIntents(list.filter((e) => e.requestId !== requestId))
}

/**
 * The id the server gives the i-th job of a run (its siblingId): the first
 * keeps the client's id, the others are derived from it. Kept in step with the server by a fixed vector in the test.
 */
export async function cloudSiblingJobId(requestId: string, index: number): Promise<string> {
  if (index === 0) return requestId
  const bytes = new TextEncoder().encode(`${requestId}:${index}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const h = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// Jobs somebody in this session is polling right now. In memory only: after a
// kill nobody is watching anything, which is exactly what a restart must see.
const watched = new Set<string>()

/** True while a poll loop of this session owns the job. */
export function isWatchedCloudJob(id: string): boolean {
  return watched.has(id)
}

/** A poll loop took the job. Returns false if another one already has it. */
export function watchCloudJob(id: string): boolean {
  if (watched.has(id)) return false
  watched.add(id)
  return true
}

export function unwatchCloudJob(id: string): void {
  watched.delete(id)
}

/**
 * Write a booked job down. Call right after the submit returned an id. Does
 * nothing on a desktop. The live run that calls this is its first watcher.
 */
export function notePendingCloudJob(job: PendingCloudJob): void {
  if (!tracksPendingCloudJobs()) return
  watched.add(job.id)
  const rest = pendingCloudJobs().filter((e) => e.id !== job.id)
  write([...rest, job])
}

/**
 * A job found on the server for an intent of an earlier session. Written to
 * the ledger WITHOUT a watcher, so the resume pass that follows polls it.
 */
export function adoptPendingCloudJob(job: PendingCloudJob): void {
  if (!tracksPendingCloudJobs()) return
  const rest = pendingCloudJobs().filter((e) => e.id !== job.id)
  write([...rest, job])
}

/** The job reached an end (landed, failed, cancelled, unknown to the server). */
export function forgetPendingCloudJob(id: string): void {
  watched.delete(id)
  const list = pendingCloudJobs()
  if (!list.some((e) => e.id === id)) return
  write(list.filter((e) => e.id !== id))
}

/** Test-only. */
export function __resetPendingCloudJobsForTests(): void {
  watched.clear()
  sending.clear()
  storage()?.removeItem(PENDING_CLOUD_JOBS_KEY)
  storage()?.removeItem(CLOUD_SUBMIT_INTENTS_KEY)
}
