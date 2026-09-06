// 2.5.8 — typed wrappers for the local character trainer (musubi-tuner).
// The Rust side (src-tauri/src/commands/trainer.rs) owns the pinned repo,
// the dedicated venv and the whole train -> convert -> loras/ pipeline; this
// module is only the IPC surface the Create page talks to.

import { backendCall } from './backend'

export interface TrainerInstallState {
  status: string
  logs: string[]
}

export interface TrainerStatus {
  envReady: boolean
  basesReady: boolean
  dit: string | null
  textEncoder: string | null
  vae: string | null
  root: string
  install: TrainerInstallState
}

export interface TrainingRunStatus {
  status: 'idle' | 'running' | 'complete' | 'error' | 'cancelled' | string
  /** The current headline (environment check, repair step, training step).
   *  `logs` ends in whatever the child printed last, which is pip chatter for
   *  minutes at a time, so the progress line reads this instead. */
  phase?: string
  logs: string[]
  step: number
  totalSteps: number
}

/** The Z-Image training bases the trainer resolves by exact filename.
 *  Subfolders match the ComfyUI models tree so the regular download
 *  pipeline (download_model) drops them where both sides find them. */
export const TRAINER_BASE_FILES = [
  {
    filename: 'z_image_bf16.safetensors',
    subfolder: 'diffusion_models',
    url: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/diffusion_models/z_image_bf16.safetensors',
    label: 'Z Image base model',
  },
  {
    filename: 'qwen_3_4b.safetensors',
    subfolder: 'text_encoders',
    url: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors',
    label: 'Text encoder',
  },
  {
    filename: 'ae.safetensors',
    subfolder: 'vae',
    url: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/vae/ae.safetensors',
    label: 'VAE',
  },
] as const

/**
 * Is one of the base files still coming in? The download outlives the
 * Character Studio panel: leave the tab while 19 GB flow and come back, and
 * the button read "Download base files" again with no note while the tray kept
 * counting (Phase G, Windows box, 2026-09-06). The panel asks this on mount.
 */
export function baseDownloadRunning(
  progress: Record<string, { status: string } | undefined>,
): boolean {
  return TRAINER_BASE_FILES.some((f) => {
    const row = progress[f.filename]
    return !!row && (row.status === 'downloading' || row.status === 'connecting')
  })
}

/**
 * Progress over the three base files together, the way the tray sums its
 * group. The note under the button used to quote the first running file only
 * ("z_image 3%") while 15 percent of the 19 GB were already on disk (Phase G,
 * 06.09.2026). null when none of them is moving.
 */
export function baseDownloadPercent(
  progress: Record<string, { progress: number; total: number; status: string } | undefined>,
): number | null {
  if (!baseDownloadRunning(progress)) return null
  const rows = TRAINER_BASE_FILES.flatMap((f) => { const r = progress[f.filename]; return r ? [r] : [] })
  const total = rows.reduce((a, r) => a + Math.max(r.total, 0), 0)
  if (total <= 0) return 0
  const done = rows.reduce((a, r) => a + Math.min(Math.max(r.progress, 0), Math.max(r.total, 0)), 0)
  return Math.min(100, Math.round((done / total) * 100))
}

export async function installCharacterTrainer(installPath?: string): Promise<{ status: string }> {
  return backendCall('install_character_trainer', { installPath: installPath ?? null })
}

export async function characterTrainerStatus(): Promise<TrainerStatus> {
  return backendCall('character_trainer_status')
}

export async function stageTrainingImage(
  setId: string,
  filename: string,
  fileBytes: number[],
  caption: string,
): Promise<{ staged: string }> {
  return backendCall('stage_training_image', { setId, filename, fileBytes, caption })
}

export async function clearTrainingSet(setId: string): Promise<void> {
  await backendCall('clear_training_set', { setId })
}

export async function startCharacterTraining(
  setId: string,
  name: string,
  triggerWord: string,
  steps?: number,
): Promise<{ status: string }> {
  return backendCall('start_character_training', { setId, name, triggerWord, steps: steps ?? null })
}

export async function characterTrainingStatus(): Promise<TrainingRunStatus> {
  return backendCall('character_training_status')
}

export async function cancelCharacterTraining(): Promise<void> {
  await backendCall('cancel_character_training')
}

/** Local character LoRAs are recognized by the trainer's own naming
 *  (`char_<name>_zimage.safetensors`); the trigger word IS the name part —
 *  start_character_training writes it that way on purpose so the Use shelf
 *  can recover it without a sidecar database. */
export function parseLocalCharacterLora(file: string): { file: string; trigger: string } | null {
  // ComfyUI lists loras with their subfolder prefix — keep the full enum
  // string as `file` (LoraLoader needs it verbatim), match on the basename.
  const m = /(?:^|[\\/])char_(.+)_zimage\.safetensors$/i.exec(file.trim())
  if (!m) return null
  return { file: file.trim(), trigger: m[1] }
}
