/**
 * Character training on the Mac (src-tauri commands/mlx_train.rs).
 *
 * Windows and Linux train a character with musubi-tuner on CUDA
 * (api/trainer.ts). A Mac has no CUDA, so it trains with the trainer of its
 * own image engine, mflux, on the Z-Image Turbo pack Create already runs.
 * The result is the same kind of file, `char_<trigger>_zimage.safetensors`,
 * and lands in the Mac's LoRA folder, where the Use shelf finds it.
 *
 * The functions of api/trainer.ts call these on a Mac, so the run in
 * useCreate is the same on every system.
 */
import { invokeMedia } from './mlx-invoke'

export interface MacTrainStatus {
  engineReady: boolean
  /** The pack a run trains on, or null when no Z-Image Turbo pack is there. */
  base: string | null
  /** Whether the training adapter is on disk. The first run fetches it. */
  adapterReady: boolean
  adapterBytes: number
  minRamGB: number
  /** Why this Mac cannot train at all, or null. */
  memoryRefusal: string | null
  running: boolean
}

export interface MacTrainProgress {
  job: string | null
  status: 'idle' | 'running' | 'complete' | 'error' | 'cancelled'
  phase: string
  percent: number
  step: number
  steps: number
  trigger: string | null
  error: string | null
  output: string | null
  logs: string[]
  running: boolean
}

/** The run the Mac trains under, so a Cancel reaches this run and no other. */
const RUN = 'character-training'

export async function getMacTrainStatus(): Promise<MacTrainStatus> {
  return invokeMedia<MacTrainStatus>('mlx_train_status')
}

export async function clearMacTrainSet(set: string): Promise<void> {
  await invokeMedia('mlx_train_clear', { set })
}

export async function stageMacTrainPhoto(set: string, bytes: number[] | Uint8Array, caption: string): Promise<{ staged: string }> {
  return invokeMedia<{ staged: string }>('mlx_train_stage', { set, data: bytesToBase64(bytes), caption })
}

/** `trigger` is the name the file is made of (`char_<trigger>_zimage`, or
 *  `style_<trigger>_zimage` for kind 'style'); the captions carry the trigger
 *  word itself. */
export async function startMacTraining(set: string, trigger: string, steps?: number, kind?: 'character' | 'style'): Promise<{ status: string }> {
  await invokeMedia('mlx_train_start', { set, trigger, steps: steps ?? null, run: RUN, kind: kind ?? null })
  return { status: 'started' }
}

export async function getMacTrainProgress(): Promise<MacTrainProgress> {
  return invokeMedia<MacTrainProgress>('mlx_train_progress')
}

export async function cancelMacTraining(): Promise<void> {
  await invokeMedia('mlx_train_cancel', { run: RUN })
}

/** The progress of a Mac run in the shape the Windows trainer reports it
 *  (`TrainingRunStatus` of api/trainer.ts). A failed run carries its reason
 *  as the phase, which is where useCreate reads the message of a failure. */
export function macTrainRunStatus(p: MacTrainProgress): { status: string; phase: string; logs: string[]; step: number; totalSteps: number } {
  return {
    status: p.status,
    phase: p.status === 'error' ? (p.error ?? p.phase) : p.phase,
    logs: Array.isArray(p.logs) ? p.logs : [],
    step: p.step,
    totalSteps: p.steps,
  }
}

/** The line under the train inputs: how long and what the first run fetches. */
/** What a Mac lacks before it can train, or null. The standard Mac setup
 *  brings the image engine with SD-Turbo; the engine a run trains with
 *  arrives with Z-Image Turbo, so one install answers both (GH #194). */
export function macTrainMissing(s: Pick<MacTrainStatus, 'engineReady' | 'base'>): string | null {
  if (s.engineReady && s.base) return null
  // Said for a character and a style alike (3.0.9 P8): both train on it.
  return 'Training on this Mac needs Z-Image Turbo, about 6 GB. The standard setup does not install it.'
}

export function macTrainNote(stepsNote: string, s: Pick<MacTrainStatus, 'adapterReady' | 'adapterBytes'>, kind: 'character' | 'style' = 'character'): string {
  const first = s.adapterReady ? '' : ` The first run also downloads a ${Math.round(s.adapterBytes / 1_000_000)} MB training adapter.`
  return `Runs on this Mac and takes a while (${stepsNote}). The local chat model pauses for the run.${first} The ${kind === 'style' ? 'style' : 'character'} lands in your LoRA folder.`
}

function bytesToBase64(bytes: number[] | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)
  let binary = ''
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}
