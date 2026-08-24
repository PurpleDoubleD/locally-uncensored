// One-click local media setup on macOS — the Create-tab counterpart to the
// per-model panel in Settings → Local Media (Apple MLX).
//
// A fresh Mac has neither the MLX engine nor any model, and Create's local
// lanes are dead until both exist. Settings can already fix that, but only if
// the user knows to go there: the Create tab said "a one-time setup is needed"
// and offered no way to do it. This module is that way — engine first, then the
// smallest model of the requested kind, which is what "just make it work"
// means here.
//
// The install itself runs in Rust and survives this page, so `signal` stops us
// WATCHING, not the download. Callers say so in their copy rather than
// promising a cancel we cannot deliver (unlike the ComfyUI bundle path, whose
// downloader really is abortable).

import { waitOrAbort } from '../lib/bundle-install'
import { useMlxInstallStore } from '../stores/mlxInstallStore'
import {
  mlxStatus,
  listMlxImageModels,
  installMlxImageModel,
  getMlxImageInstallStatus,
  installMlxImageEngine,
  getMlxImageEngineStatus,
  type MlxInstallStatus,
} from './mlx-image'
import {
  getVideoStatus,
  listVideoModels,
  installMlxVideo,
  getMlxInstallStatus,
  installVideoModel,
  getModelInstallStatus,
  type InstallStatus,
} from './mlx-video'
import { formatBytes } from '../lib/formatters'

const POLL_MS = 1500

/** Byte progress, when the installer reports it (the video lane does). */
export function mlxProgressLine(s: MlxInstallStatus | InstallStatus): string | null {
  if (!('download_total' in s) || !s.download_total) return null
  const pct = Math.min(100, Math.round((s.download_progress / s.download_total) * 100))
  const speed = s.download_speed > 0 ? ` · ${formatBytes(s.download_speed)}/s` : ''
  return `${pct}% — ${formatBytes(s.download_progress)} of ${formatBytes(s.download_total)}${speed}`
}

/**
 * Poll one Rust install slot to completion.
 *
 * Terminal states are 'complete' and 'error'; anything else keeps polling. A
 * failed poll is transient (the slot is being written) and must not end the
 * wait, or a single hiccup would report a finished install as failed.
 */
async function awaitSlot(
  read: () => Promise<MlxInstallStatus | InstallStatus>,
  label: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    await waitOrAbort(POLL_MS, signal)
    let s: MlxInstallStatus | InstallStatus
    try {
      s = await read()
    } catch {
      continue
    }
    const last = s.logs?.length ? String(s.logs[s.logs.length - 1]) : ''
    onProgress?.(mlxProgressLine(s) || last || label)
    if (s.status === 'error') throw new Error(s.error || `${label} failed.`)
    if (s.status === 'complete') return
  }
}

/** Smallest model wins: the setup path should not pull 14 GB to prove it works. */
function smallest<T extends { sizeGB: number; installed: boolean }>(models: T[]): T | null {
  const missing = models.filter((m) => !m.installed)
  if (missing.length === 0) return null
  return missing.reduce((a, b) => (b.sizeGB < a.sizeGB ? b : a))
}

/** The image-engine install already pre-pulls the smallest model. If any image
 * model is now installed, the local lane is usable and setup is finished; do
 * not interpret the next missing catalog entry as another required download. */
export function starterForEmptyImageLane<T extends { sizeGB: number; installed: boolean }>(
  models: T[],
): T | null {
  return models.some((m) => m.installed) ? null : smallest(models)
}

/**
 * Bring local MLX media for `kind` from nothing to usable.
 *
 * Idempotent by design: each step checks the live state first, so a run that
 * died halfway (or a user who already installed the engine in Settings)
 * resumes instead of reinstalling.
 */
export async function installMlxStack(
  kind: 'image' | 'video',
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (kind === 'image') {
    const st = await mlxStatus().catch(() => null)
    if (!st?.installed) {
      onProgress?.('Setting up the image engine (about 3 GB, one time)…')
      await installMlxImageEngine()
      useMlxInstallStore.getState().watch('image-engine', 'MLX image engine')
      await awaitSlot(getMlxImageEngineStatus, 'Image engine install', onProgress, signal)
    }
    const pick = starterForEmptyImageLane(await listMlxImageModels())
    // The engine installer pre-pulls the starter. Null therefore means the
    // local image lane is already usable; do not fetch a second model.
    if (!pick) return
    onProgress?.(`Downloading ${pick.name} (${pick.sizeGB} GB)…`)
    await installMlxImageModel(pick.id)
    useMlxInstallStore.getState().watch('image-model', pick.name)
    await awaitSlot(getMlxImageInstallStatus, `${pick.name} download`, onProgress, signal)
    return
  }

  const vs = await getVideoStatus().catch(() => null)
  if (vs && !vs.appleSilicon) {
    throw new Error('Local video generation needs Apple Silicon. Use LU Cloud for video on this Mac.')
  }
  if (!vs?.mlxInstalled) {
    onProgress?.('Setting up the video engine (one time)…')
    await installMlxVideo()
    useMlxInstallStore.getState().watch('video-engine', 'MLX video engine')
    await awaitSlot(getMlxInstallStatus, 'Video engine install', onProgress, signal)
  }
  const pick = smallest(await listVideoModels())
  if (!pick) return
  onProgress?.(`Downloading ${pick.name} (${pick.sizeGB} GB)…`)
  await installVideoModel(pick.id)
  useMlxInstallStore.getState().watch('video-model', pick.name)
  await awaitSlot(getModelInstallStatus, `${pick.name} download`, onProgress, signal)
}
