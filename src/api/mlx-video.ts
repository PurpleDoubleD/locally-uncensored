/**
 * MLX-video pipeline (Apple Silicon), running IN-PROCESS — Rust
 * (`commands::video`) spawns `python -m mlx_video.<family>.generate` as a
 * subprocess directly, no separate lu-bridge daemon. Ported from
 * uselu/apps/web/api/video.ts; the transport is a direct Tauri `invoke` via
 * `invokeMedia` (see mlx-image.ts) and progress is exposed for the frontend
 * to poll.
 *
 * Hard rule: this is the Mac local video backend, NOT ComfyUI. Only Apple
 * Silicon Macs see a real surface — every call returns `available:false`
 * elsewhere so the UI can dim/skip it.
 */
import { backendCall } from './backend'
import type { ClassifiedModel, ModelType } from './comfyui'

/** See the `invokeMedia` doc comment in `mlx-image.ts` — the Rust wrappers
 *  take a single `args: serde_json::Value` param, so the payload must be
 *  nested under an `args` key. */
async function invokeMedia<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return backendCall<T>(command, { args: args ?? {} })
}

export interface VideoStatus {
  available: boolean
  appleSilicon: boolean
  mlxInstalled: boolean
  mlxVersion: string | null
  pythonBin: string | null
  modelsRoot: string
  outputsRoot: string
  installedModels: string[]
  running: boolean
}

export interface VideoModel {
  id: string
  name: string
  family: 'wan_2' | 'ltx_2' | string
  repo: string
  sizeGB: number
  minRamGB: number
  defaultFrames: number
  needsConvert: boolean
  unfiltered: boolean
  description: string
  installed: boolean
}

export interface VideoProgress {
  running: boolean
  status: 'idle' | 'installing' | 'complete' | 'error' | string
  logs: string[]
  error: string | null
}

export interface InstallStatus {
  status: 'idle' | 'installing' | 'complete' | 'error'
  logs: string[]
  download_progress: number
  download_total: number
  download_speed: number
  error: string | null
}

export interface GenerateParams {
  id: string
  prompt: string
  steps?: number
  width?: number
  height?: number
  seconds?: number
  fps?: number
  initImage?: string
  seed?: number
}

export interface GenerateResult {
  ok: boolean
  jobId: string
  pid: number
  output: string
}

export async function getVideoStatus(): Promise<VideoStatus> {
  return invokeMedia<VideoStatus>('video_status')
}

export async function listVideoModels(): Promise<VideoModel[]> {
  return invokeMedia<VideoModel[]>('video_list_models')
}

export async function installMlxVideo(): Promise<{ ok: boolean; status: string }> {
  return invokeMedia<{ ok: boolean; status: string }>('video_install_mlx')
}

export async function getMlxInstallStatus(): Promise<InstallStatus> {
  return invokeMedia<InstallStatus>('video_install_mlx_status')
}

export async function installVideoModel(
  id: string,
): Promise<{ ok: boolean; status: string; id?: string }> {
  return invokeMedia('video_install_model', { id })
}

export async function getModelInstallStatus(): Promise<InstallStatus> {
  return invokeMedia<InstallStatus>('video_install_model_status')
}

export async function deleteVideoModel(id: string): Promise<{ ok: boolean; id: string }> {
  return invokeMedia('video_delete_model', { id })
}

export async function generateVideo(params: GenerateParams): Promise<GenerateResult> {
  const body = {
    id: params.id,
    prompt: params.prompt,
    steps: params.steps,
    width: params.width,
    height: params.height,
    seconds: params.seconds,
    fps: params.fps,
    init_image: params.initImage,
    seed: params.seed,
  }
  // Kick off the subprocess; generation itself is polled via video_progress.
  return invokeMedia<GenerateResult>('video_generate', body)
}

export async function getVideoProgress(): Promise<VideoProgress> {
  return invokeMedia<VideoProgress>('video_progress')
}

export async function cancelVideo(): Promise<{ ok: boolean }> {
  return invokeMedia<{ ok: boolean }>('video_cancel')
}

/** Read a finished MLX video's bytes (via the `read_media_file` Rust command,
 *  guarded to the app's own video output dir) and turn them into a `blob:`
 *  URL — the CSP's `media-src` allows `blob:` but not `data:`, so this is
 *  the only way to get `<video>` playback + Download working now that the
 *  old lu-bridge (:47711/videos/<file>) is gone. Caller owns the returned
 *  URL's lifetime (revoke it when the gallery item is dropped, if ever). */
export async function readVideoAsBlobUrl(path: string): Promise<string> {
  const b64 = await backendCall<string>('read_media_file', { path })
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: 'video/mp4' })
  return URL.createObjectURL(blob)
}

// ── Create-tab wiring (mirrors mlx-image.ts's synthetic-model pattern) ──
//
// On macOS the video picker shows the installed MLX catalog directly — there
// is no ComfyUI video backend to merge with (hard rule: Mac video is MLX
// only). A "MLX " prefix keeps these display names visually distinct and
// guarantees a fresh persisted `videoModel` never collides with a stale
// ComfyUI checkpoint name from a pre-MLX session.

export const MLX_VIDEO_MODEL_PREFIX = 'MLX '

export function mlxVideoDisplayName(m: Pick<VideoModel, 'name'>): string {
  return `${MLX_VIDEO_MODEL_PREFIX}${m.name}`
}

const mlxVideoIdByDisplayName = new Map<string, string>()

/** Resolve a video dropdown selection back to the bridge catalog id. */
export function mlxVideoModelIdFor(displayName: string | null | undefined): string | null {
  return (displayName && mlxVideoIdByDisplayName.get(displayName)) || null
}

function mlxVideoModelType(family: string): ModelType {
  return family === 'ltx_2' ? 'ltx' : 'wan'
}

/** Build the Create-tab video model list from the installed MLX catalog. */
export function buildMlxVideoModels(catalog: VideoModel[]): ClassifiedModel[] {
  return catalog
    .filter((m) => m.installed)
    .map((m) => {
      mlxVideoIdByDisplayName.set(mlxVideoDisplayName(m), m.id)
      return { name: mlxVideoDisplayName(m), type: mlxVideoModelType(m.family), source: 'checkpoint' } satisfies ClassifiedModel
    })
}
