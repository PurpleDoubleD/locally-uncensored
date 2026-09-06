import { formatBytes } from './formatters'
import type { DownloadProgress } from '../types/downloads'

/**
 * The download half of the Create tab's "Download & install" cards, pulled out
 * of CreateContext so every branch is unit-testable without a live ComfyUI.
 *
 * David 2026-07-25, on the Motion Control card: he clicked Download & install,
 * got a spinner, and had no way to tell whether anything was still downloading.
 * Three separate defects sat behind that:
 *
 *  1. The card was the ONLY place progress showed. installModelBundle called
 *     the Rust downloader directly and never registered with downloadStore, so
 *     the header Downloads tray said "No active downloads" through a 10.5 GB
 *     transfer, and the tray's cancel + retry buttons were unreachable.
 *  2. There was no way out. No cancel on the card, no cancel in the tray.
 *  3. One dropped connection killed the whole bundle. His run died at 1.2 GB of
 *     4.3 GB with the raw reqwest text "Stream error: error decoding response
 *     body" and no retry. The Rust side resumes from the .download temp file on
 *     the next start_model_download, so a retry is nearly free, it just was
 *     never wired.
 */

/** User pressed Cancel (on the card or in the Downloads tray). Rendered as a
 *  plain "Cancelled." line, never as a red failure. */
export class InstallCancelled extends Error {
  constructor(message = 'Cancelled.') {
    super(message)
    this.name = 'InstallCancelled'
  }
}

/** A sleep that returns the moment the user cancels, so Cancel does not have to
 *  wait out a poll tick. Throws before AND after the wait: cancelling during the
 *  sleep must not let one more poll round run. */
export async function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new InstallCancelled()
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
  if (signal?.aborted) throw new InstallCancelled()
}

/** The status line under the card spinner. Bytes and speed are the whole point:
 *  a bare percentage still leaves "is this thing moving" unanswered. */
export function formatProgressLine(p: DownloadProgress, filename: string, fileLabel = ''): string {
  const parts: string[] = []
  if (p.total > 0) parts.push(`${Math.round((p.progress / p.total) * 100)}%`)
  if (p.total > 0) parts.push(`${formatBytes(p.progress)} of ${formatBytes(p.total)}`)
  if (p.speed > 0) parts.push(`${formatBytes(p.speed)}/s`)
  const detail = parts.length > 0 ? ` ${parts.join(', ')}` : ''
  return `${fileLabel}Downloading ${filename}.${detail}`
}

/**
 * Turn a downloader error into something a person can act on. The raw strings
 * come from reqwest ("Stream error: error decoding response body", "os error
 * 10054") and mean nothing to anyone who is not us. Every message says what to
 * do next, and the resume note is literally true: the partial .download file
 * stays on disk and the next attempt continues from its length.
 */
export function friendlyDownloadError(raw: string, filename: string): string {
  const low = (raw || '').toLowerCase()
  const resume = 'Nothing is lost, the part already on disk is kept and the next try continues from there.'
  if (
    low.includes('stream error') || low.includes('decoding response') ||
    low.includes('connection') || low.includes('timed out') || low.includes('timeout') ||
    low.includes('10054') || low.includes('dns') || low.includes('reset')
  ) {
    return `The connection dropped while downloading ${filename}. ${resume} Hit Download & install again when your network is back.`
  }
  if (low.includes('no space') || low.includes('disk full') || low.includes('os error 112')) {
    return `The drive ran out of space while downloading ${filename}. Free some room, then hit Download & install again. ${resume}`
  }
  if (low.includes('permission') || low.includes('access is denied') || low.includes('os error 5')) {
    return `Windows blocked writing ${filename} to the ComfyUI models folder. Check that folder is not read only, then try again.`
  }
  if (low.includes('404') || low.includes('not found')) {
    return `The download link for ${filename} is gone (404). This one is on us, please report it.`
  }
  return `Could not download ${filename}: ${raw}. ${resume}`
}

/** One file of a bundle. Mirrors the DiscoverModel fields the downloader needs. */
export interface BundleFile {
  filename: string
  subfolder: string
  downloadUrl: string
  sizeGB?: number
}

export interface DownloadDeps {
  /** start_model_download. Resolves once the transfer is registered, not done. */
  start: (url: string, subfolder: string, filename: string, expectedBytes?: number) =>
    Promise<{ status: string; error?: string }>
  /** download_progress, the whole Rust map keyed by filename. */
  progress: () => Promise<Record<string, DownloadProgress>>
  /** Streams the line under the card spinner. */
  onStatus?: (msg: string) => void
  /** Makes the transfer visible in the header Downloads tray (and its cancel +
   *  retry buttons reachable). Called before the first byte and again per file,
   *  because the tray's poller auto stops when it sees an idle window. */
  keepTrayLive?: () => void
  /** cancel_download for the file in flight. Aborting the JS loop alone would
   *  leave the Rust task happily eating bandwidth, so Cancel has to reach the
   *  transfer itself. */
  stop?: (filename: string) => void
  signal?: AbortSignal
  /** Injected so tests do not spend real seconds. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** A 10 GB transfer over a home line drops. Four tries, each resuming. */
export const MAX_FILE_ATTEMPTS = 4

/** How many empty poll rounds to allow before calling a download stillborn.
 *  Rust inserts the entry inside start_model_download, so this only ever
 *  covers a slow first round. */
const MAX_MISSING_ROUNDS = 8

async function downloadOneFile(file: BundleFile, fileLabel: string, deps: DownloadDeps): Promise<void> {
  const { start, progress, onStatus, keepTrayLive, signal } = deps
  const wait = deps.wait ?? waitOrAbort
  const expected = file.sizeGB ? Math.round(file.sizeGB * 1_073_741_824) : undefined

  onStatus?.(`${fileLabel}Starting ${file.filename}.`)
  const started = await start(file.downloadUrl, file.subfolder, file.filename, expected)
  if (started.status === 'error') {
    throw new Error(started.error || `Could not start the ${file.filename} download.`)
  }
  keepTrayLive?.()
  // 'exists' = already complete on disk, nothing to poll.
  if (started.status === 'exists') {
    onStatus?.(`${fileLabel}${file.filename} is already on disk.`)
    return
  }

  // Cancel has to stop the Rust transfer, not just this loop.
  const onAbort = () => deps.stop?.(file.filename)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    let seen = false
    let missing = 0
    for (;;) {
      await wait(1000, signal)
      const all = await progress()
      const p = all[file.filename] ?? Object.values(all).find((d) => d.filename === file.filename)
      if (!p) {
        // Rust drops an entry from the map only on cancel (a finished one keeps
        // status 'complete'), so a vanished entry we had already seen means the
        // user hit cancel somewhere. Before we ever saw it, it is just a slow
        // first round.
        if (seen) throw new InstallCancelled()
        if (++missing > MAX_MISSING_ROUNDS) {
          throw new Error(`The ${file.filename} download never started. Check Settings, AI Backends.`)
        }
        continue
      }
      seen = true
      if (p.status === 'complete') {
        onStatus?.(`${fileLabel}${file.filename} done.`)
        return
      }
      if (p.status === 'error') throw new Error(p.error || `Download failed: ${file.filename}`)
      if (p.status === 'paused' || p.status === 'pausing') {
        onStatus?.(`${fileLabel}${file.filename} is paused. Resume it from the Downloads tray up top.`)
        continue
      }
      onStatus?.(formatProgressLine(p, file.filename, fileLabel))
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Download every file of a bundle, in order, retrying a dropped transfer where
 * it left off. Cancel and a genuinely dead link both stop the whole bundle, a
 * flaky connection does not.
 */
export async function downloadBundleFiles(files: BundleFile[], deps: DownloadDeps): Promise<void> {
  const wait = deps.wait ?? waitOrAbort
  const usable = files.filter((f) => f.downloadUrl && f.filename && f.subfolder)
  for (let i = 0; i < usable.length; i++) {
    const file = usable[i]
    const fileLabel = usable.length > 1 ? `File ${i + 1} of ${usable.length}. ` : ''
    for (let attempt = 1; ; attempt++) {
      try {
        await downloadOneFile(file, fileLabel, deps)
        break
      } catch (err) {
        if (err instanceof InstallCancelled) throw err
        const raw = err instanceof Error ? err.message : String(err)
        if (attempt >= MAX_FILE_ATTEMPTS) throw new Error(friendlyDownloadError(raw, file.filename))
        deps.onStatus?.(
          `${fileLabel}The connection dropped. Resuming ${file.filename}, try ${attempt + 1} of ${MAX_FILE_ATTEMPTS}.`,
        )
        await wait(3000, deps.signal)
      }
    }
  }
}

/**
 * Wait until the running ComfyUI actually LISTS the files that were just
 * downloaded, and report what is still missing when it does not.
 *
 * Voxyl AI and Aldrich Ironhart, Discord 2026-08-13, both on Extend Video and
 * Animate Image: the download runs to the end and the card then sits on
 * "Refreshing the model list…" for good. Nothing was hanging. The install
 * refreshed once, called itself done, and left the card on its last status
 * line, because the card only disappears when the model lists refill and
 * ComfyUI had not finished its directory scan yet. A fetch that succeeds but
 * simply does not contain the new model is not an error either, so the retry
 * loop in useCreate never engaged: two dead ends meeting at a frozen line of
 * text. Image bundles fit through the old window because they are a fraction
 * of the size; the two lanes that broke carry the biggest files we ship.
 *
 * This knows nothing about ComfyUI on purpose. The caller says what is still
 * missing and how to refresh, which keeps every branch testable without a live
 * engine. `missing` must report everything as missing when it cannot reach the
 * engine at all: an answer we could not get is not a file we have seen.
 */
export async function waitForModelsVisible(opts: {
  missing: () => Promise<string[]>
  refresh: () => Promise<unknown>
  onStatus?: (msg: string) => void
  signal?: AbortSignal
  attempts?: number
  delayMs?: number
}): Promise<string[]> {
  const { missing, refresh, onStatus, signal, attempts = 20, delayMs = 3000 } = opts
  let left = await missing()
  const step = Math.max(1, Math.round(delayMs / 1000))
  for (let i = 0; left.length > 0 && i < attempts; i++) {
    onStatus?.(`Waiting for ComfyUI to list the new files… ${i * step}s`)
    await waitOrAbort(delayMs, signal)
    await refresh()
    left = await missing()
  }
  return left
}
