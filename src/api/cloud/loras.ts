// Desktop client for the Character-Studio shelf (server: user_loras via
// /api/loras). Training happens through the normal render queue (op
// 'lora-train'); the worker persists each delivered training onto the shelf,
// and generation references shelf rows by id — URLs never travel client-side.

import { cloudFetch, jsonOrError } from './client'
import { CLOUD_BASE } from './config'
import { getAccessToken } from './supabase'
import { isTauri } from '../backend'
import { loraFileName } from '../../lib/render/lora-file-name'

export interface CloudLora {
  id: string
  name: string
  trigger_word: string
  /** Which generation endpoints accept it: 'flux' | 'z-image' | 'qwen-image' | 'ltx-2'. */
  base_family: string
  created_at: string
  /** Trained here or uploaded as a file (server 3.0.7). Optional: older servers. */
  source?: 'trained' | 'uploaded'
  /** The last picture made with it, signed for an hour, or null. */
  preview_url?: string | null
  /** Its base look (B42), signed for an hour, or null. The Character area
   *  shows it as the picture of the character. */
  base_url?: string | null
}

export async function listLoras(): Promise<CloudLora[]> {
  const res = await cloudFetch('/api/loras')
  const { loras } = await jsonOrError<{ loras: CloudLora[] }>(res)
  return loras
}

/** How long the app waits, step by step, for a finished training to show up
 *  on the shelf. About 17 seconds in all. */
export const TRAINED_LORA_WAITS_MS = [500, 1000, 1500, 2000, 3000, 4000, 5000]

/** When the first waits were not enough: asked again in the background for
 *  about two more minutes. */
export const TRAINED_LORA_LATE_WAITS_MS = [10_000, 20_000, 30_000, 60_000]

/** A shelf entry counts as the new one when the server wrote it at most this
 *  long before the job said it was done. The worker and the database each
 *  keep their own clock; an older character is minutes older, not seconds. */
const SAME_TRAINING_SLACK_MS = 30_000

/** Said when a training is done but its character did not show up on the
 *  shelf within the waits. The character is on the account either way. */
export const TRAINED_NOT_YET_LISTED =
  'Your character is trained and saved to your account. It can take a minute to show up here. Open Use character again in a moment.'

/** True when the shelf holds the character a training finished at
 *  `completedAt` (ISO time of the job). */
export function shelfHasTraining(shelf: CloudLora[], completedAt: string | null | undefined): boolean {
  const done = completedAt ? Date.parse(completedAt) : NaN
  if (!Number.isFinite(done)) return false
  return shelf.some((l) => {
    const at = Date.parse(l.created_at)
    return Number.isFinite(at) && at >= done - SAME_TRAINING_SLACK_MS
  })
}

/** Waits until a finished training is on the shelf.
 *
 *  The server marks a training job done first and puts the character on the
 *  shelf about a second later (render worker: succeed, then persistLora). An
 *  app that reads the shelf the moment the job says done gets the list
 *  without the new character, and the customer sees "No characters yet" after
 *  a paid training (Fall E7, 07.11.2026). So this asks again a few times.
 *
 *  Resolves the shelf that holds the character, or null when it did not show
 *  within the waits (or `signal` ended the wait). A failed read is just
 *  another try. Never throws. */
export async function waitForTrainedLora(
  job: { completed_at: string | null },
  opts: {
    waitsMs?: number[]
    signal?: AbortSignal
    list?: () => Promise<CloudLora[]>
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<CloudLora[] | null> {
  const list = opts.list ?? listLoras
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const waits = opts.waitsMs ?? TRAINED_LORA_WAITS_MS
  for (let i = 0; i <= waits.length; i++) {
    if (opts.signal?.aborted) return null
    try {
      const shelf = await list()
      if (shelfHasTraining(shelf, job.completed_at)) return shelf
    } catch {
      // The next try asks again.
    }
    if (i < waits.length) await sleep(waits[i])
  }
  return null
}

export async function deleteLora(id: string): Promise<void> {
  const res = await cloudFetch(`/api/loras/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await jsonOrError<{ ok: boolean }>(res)
}

/** How far a download is. `total` is 0 when the storage states no size. */
export interface LoraDownloadProgress {
  received: number
  total: number
}

type SaveAnswer =
  | { status: 'cancelled' }
  | { status: 'saved'; path: string; bytes: number }
  | { status: 'refused'; code: number }
  | { status: 'stopped' }

/** The sentence for an answer the server gave instead of the file. */
export function loraDownloadRefusal(code: number): string {
  if (code === 401 || code === 403) return 'You are signed out of LU Cloud. Sign in and try again.'
  if (code === 404) return 'This character is no longer on your account.'
  if (code === 429) return 'Too many downloads at once. Wait a minute and try again.'
  if (code >= 500) return `LU Cloud could not prepare the file (${code}). Try again in a moment.`
  return `The file could not be loaded (${code}). Try again.`
}

let downloadRuns = 0

/** Saves a trained character as a .safetensors file where the user picks.
 *
 *  The weights are a few hundred megabytes, and the route answers with a
 *  redirect to a short-lived storage address that a WebView may not read. So
 *  the backend asks with the session token, follows the redirect without it
 *  and streams the file to disk (save_cloud_file_dialog). Resolves 'saved',
 *  'cancelled' when the Save dialog was closed, or 'stopped' when `signal`
 *  ended a running download: the backend has then dropped the connection and
 *  removed the unfinished file. Throws an English sentence otherwise.
 *
 *  `onProgress` is first called when the place is picked and the download
 *  begins, before any byte. */
export async function downloadLora(
  lora: Pick<CloudLora, 'id' | 'name' | 'trigger_word'>,
  onProgress?: (p: LoraDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<'saved' | 'cancelled' | 'stopped'> {
  if (!isTauri()) throw new Error('Saving a character needs the desktop app.')
  const token = await getAccessToken()
  if (!token) throw new Error(loraDownloadRefusal(401))
  const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')])
  // One id per run, not per character: a cancel that arrives just after its
  // download ended must not end the next download of the same character.
  downloadRuns += 1
  const id = `lora-${lora.id}-${downloadRuns}`
  const cancel = () => { void invoke('cancel_cloud_file', { id }).catch(() => { /* nothing left to cancel */ }) }
  const unlisten = onProgress
    ? await listen<LoraDownloadProgress & { id: string }>('cloud-file-progress', (event) => {
        if (event.payload.id === id) onProgress({ received: event.payload.received, total: event.payload.total })
      })
    : null
  signal?.addEventListener('abort', cancel)
  try {
    if (signal?.aborted) cancel()
    const answer = await invoke<SaveAnswer>('save_cloud_file_dialog', {
      id,
      url: `${CLOUD_BASE}/api/loras/${encodeURIComponent(lora.id)}/file`,
      authToken: token,
      defaultName: loraFileName(lora.name, lora.trigger_word),
      extension: 'safetensors',
      extLabel: 'Character weights',
    })
    if (answer.status === 'refused') throw new Error(loraDownloadRefusal(answer.code))
    return answer.status
  } finally {
    signal?.removeEventListener('abort', cancel)
    unlisten?.()
  }
}
