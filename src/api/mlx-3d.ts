/**
 * The 3D engine of the Mac: TripoSR, run by Rust as a Python process of its
 * own per model (`src-tauri/src/commands/mesh3d.rs`). One picture of one
 * object in, one GLB with colours per vertex out, written to `<outputs>/3d`.
 *
 * Public API, for `useCreate.ts`:
 *
 *   getMesh3dStatus()          -> Mesh3dStatus   installed, running, model card
 *   installMesh3d()            -> starts engine + source + weights, one slot
 *   getMesh3dInstallStatus()   -> MlxInstallStatus (poll like the music install)
 *   cancelMesh3dInstall()      -> stops it; what was fetched stays
 *   deleteMesh3dModel()        -> removes the weights, the engine stays
 *   generateMesh3d({ run, imagePath, resolution?, cutout? }) -> Mesh3dStarted
 *   getMesh3dProgress()        -> Mesh3dProgress (phase, percent, error, ...)
 *   cancelMesh3d(run)          -> ends that run and its process
 *
 *   runMacMesh3d({ imagePath, resolution?, cutout? }, { signal?, onProgress? })
 *     -> Promise<{ path, bytes, triangles?, seconds }>
 *     Starts a run, polls until it is through, rejects with
 *     `Mesh3dRunCancelled` when `signal` aborts (Rust ends the process) and
 *     with an Error in the user's words otherwise. A picture without an
 *     object rejects with `Mesh3dNoObject`.
 *
 *   mesh3dRunLine(progress, elapsedSec) -> the line under the progress bar
 *
 * `imagePath` must be a picture staged by Create (`video_stage_start_image`,
 * the `start-images` folder): Rust takes no other path. `cutout` (default
 * true) cuts the object out with Vision first; a transparent picture is
 * never cut again. `resolution` is the grid side (see `mac3dResolution`).
 * The GLB is served by `read_media_file` and moved to the Trash by
 * `mlx_output_trash` like every other render of the Mac.
 */
import { invokeMedia } from './mlx-invoke'
import type { MlxInstallStatus } from './mlx-image'
import { MESH3D_NO_OBJECT, mesh3dRunLine } from '../lib/mac-3d'

export { MAC_3D_MODEL_ID, MAC_3D_MODEL_NAME, MAC_3D_RESOLUTION, MESH3D_PHASE_TEXT, mac3dResolution, mesh3dRunLine } from '../lib/mac-3d'
export type { Mac3dDetail, Mesh3dPhase } from '../lib/mac-3d'

/** The one catalogue entry, in the fields `mesh3d_status` sends. */
export interface Mesh3dModel {
  id: string
  name: string
  repo: string
  sizeGB: number
  minRamGB: number
  unfiltered: boolean
  description: string
  installed: boolean
}

export interface Mesh3dStatus {
  available: boolean
  appleSilicon: boolean
  engineInstalled: boolean
  engineCommit: string
  /** Engine, source and weights. */
  installed: boolean
  running: boolean
  outputsRoot: string
  model: Mesh3dModel
}

export interface Mesh3dProgress {
  job: string | null
  run: string | null
  status: 'idle' | 'running' | 'complete' | 'error' | 'cancelled'
  /** load, cutout, shape, paint or save. */
  phase: string
  detail: string
  percent: number
  error: string | null
  /** 'no_object' when no object was found in the picture. */
  errorCode: string | null
  output: string | null
  triangles: number | null
  vertices: number | null
  /** 'mps' or 'cpu'. */
  device: string | null
  logs: string[]
  running: boolean
  pid: number | null
  /** Size of the GLB, once the run is complete. */
  bytes?: number
}

export interface Mesh3dRequest {
  /** A picture staged by Create. */
  imagePath: string
  resolution?: number
  cutout?: boolean
}

export interface Mesh3dStarted {
  ok: boolean
  jobId: string
  run: string
  output: string
  resolution: number
  cutout: boolean
}

export async function getMesh3dStatus(): Promise<Mesh3dStatus> {
  return invokeMedia<Mesh3dStatus>('mlx_mesh3d_status')
}

export async function installMesh3d(): Promise<{ ok: boolean; status: string; id?: string }> {
  return invokeMedia('mlx_mesh3d_install')
}

export async function getMesh3dInstallStatus(): Promise<MlxInstallStatus> {
  return invokeMedia<MlxInstallStatus>('mlx_mesh3d_install_status')
}

export async function cancelMesh3dInstall(): Promise<{ ok: boolean; cancelled: boolean }> {
  return invokeMedia('mlx_mesh3d_cancel_install')
}

export async function deleteMesh3dModel(): Promise<{ ok: boolean; id: string }> {
  return invokeMedia('mlx_mesh3d_delete')
}

export async function generateMesh3d(request: Mesh3dRequest & { run: string }): Promise<Mesh3dStarted> {
  const args: Record<string, unknown> = { run: request.run, imagePath: request.imagePath }
  if (request.resolution !== undefined) args.resolution = request.resolution
  if (request.cutout !== undefined) args.cutout = request.cutout
  return invokeMedia<Mesh3dStarted>('mlx_mesh3d_generate', args)
}

export async function getMesh3dProgress(): Promise<Mesh3dProgress> {
  return invokeMedia<Mesh3dProgress>('mlx_mesh3d_progress')
}

export async function cancelMesh3d(run: string): Promise<{ ok: boolean; stopped: boolean }> {
  return invokeMedia('mlx_mesh3d_cancel', { run })
}

/** A run that was stopped by the user. Not an error to show. */
export class Mesh3dRunCancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'Mesh3dRunCancelled'
  }
}

/** No object was found in the picture. The message is the app's sentence. */
export class Mesh3dNoObject extends Error {
  constructor() {
    super(MESH3D_NO_OBJECT)
    this.name = 'Mesh3dNoObject'
  }
}

export interface Mesh3dResult {
  /** The GLB on disk, for `read_media_file` and the gallery. */
  path: string
  bytes: number
  triangles?: number
  seconds: number
}

const POLL_MS = 1000

let runs = 0

async function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      resolve(ok)
    }
    const aborted = () => done(false)
    const timer = setTimeout(() => done(true), ms)
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

/**
 * Make one model and wait for it. `signal` stops the run: Rust ends the
 * engine's process, and this rejects with `Mesh3dRunCancelled`.
 */
export async function runMacMesh3d(
  request: Mesh3dRequest,
  watch: { signal?: AbortSignal; onProgress?: (percent: number, text: string) => void; now?: () => number } = {},
): Promise<Mesh3dResult> {
  const now = watch.now ?? Date.now
  const run = `mesh3d-${now()}-${++runs}`
  const started = now()
  const job = await generateMesh3d({ ...request, run })
  const stop = async (): Promise<never> => {
    try { await cancelMesh3d(run) } catch { /* already over */ }
    throw new Mesh3dRunCancelled()
  }
  if (watch.signal?.aborted) return stop()
  for (;;) {
    if (!(await pause(POLL_MS, watch.signal))) return stop()
    const p = await getMesh3dProgress()
    const seconds = Math.round((now() - started) / 1000)
    // A poll may still see the run before this one.
    if (p.job && p.job !== job.jobId) continue
    watch.onProgress?.(Math.min(99, p.percent), mesh3dRunLine(p, seconds))
    if (p.status === 'complete') {
      return {
        path: p.output || job.output,
        bytes: p.bytes ?? 0,
        triangles: p.triangles ?? undefined,
        seconds,
      }
    }
    if (p.status === 'cancelled') throw new Mesh3dRunCancelled()
    if (p.status === 'error') {
      if (p.errorCode === 'no_object') throw new Mesh3dNoObject()
      throw new Error(p.error || 'The 3D engine stopped without a model.')
    }
  }
}
