// 2.5.8 — typed wrappers for the local character trainer (musubi-tuner).
// The Rust side (src-tauri/src/commands/trainer.rs) owns the pinned repo,
// the dedicated venv and the whole train -> convert -> loras/ pipeline; this
// module is only the IPC surface the Create page talks to.

import { backendCall } from './backend'
import { customModelDirs } from '../lib/custom-model-dirs'
import type { TrainVramPreset } from '../lib/trainer-presets'
import type { TrainKind } from '../lib/train-kind'

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
  /** The base downloads still missing, with their size. Older backends do not
   *  send it; `missingTrainerBases` then falls back to dit/textEncoder/vae. */
  missingBases?: { filename: string; subfolder?: string; bytes: number }[]
  root: string
  /** Whether `root` is a customer-set override, not the built-in default.
   *  K5 Nachbesserung (Opus review of `4fda5a0a`): the frontend used to
   *  assume the default and say so unconditionally; this lets the setup
   *  gate tell the truth instead. */
  customized: boolean
  /** A folder to offer as the install-path placeholder when the customer
   *  already moved ComfyUI off the system drive but has not set a trainer
   *  folder yet (K5 architecture point 5). A suggestion only: it never
   *  fills the field's value. */
  suggestedRoot: string | null
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
    bytes: 12_309_866_400,
  },
  {
    filename: 'qwen_3_4b.safetensors',
    subfolder: 'text_encoders',
    url: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors',
    label: 'Text encoder',
    bytes: 8_044_982_048,
  },
  {
    filename: 'ae.safetensors',
    subfolder: 'vae',
    url: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/vae/ae.safetensors',
    label: 'VAE',
    bytes: 335_304_388,
  },
] as const

export type TrainerBaseFile = (typeof TRAINER_BASE_FILES)[number]

/**
 * The base files this machine still lacks. The panel used to call it "about
 * 19 GB" whatever was missing; on the box only z_image_bf16 (11.46 GB) was
 * absent and the line still said 19 GB. Uses the backend's `missingBases`
 * when it sends one, else the three resolved paths.
 */
export function missingTrainerBases(
  status: Pick<TrainerStatus, 'dit' | 'textEncoder' | 'vae' | 'missingBases'>,
): TrainerBaseFile[] {
  if (Array.isArray(status.missingBases)) {
    const names = new Set(status.missingBases.map((m) => m.filename))
    return TRAINER_BASE_FILES.filter((f) => names.has(f.filename))
  }
  return TRAINER_BASE_FILES.filter((f) =>
    (f.subfolder === 'diffusion_models' && !status.dit) ||
    (f.subfolder === 'text_encoders' && !status.textEncoder) ||
    (f.subfolder === 'vae' && !status.vae))
}

/** "about 11 GB", "about 7.5 GB", "about 320 MB": a rounded size for the
 *  download line, in the binary GB the rest of the app quotes (11.46 GB for
 *  z_image_bf16, the three together about 19 GB). */
export function aboutSize(bytes: number): string {
  const gb = bytes / 1_073_741_824
  if (gb < 1) return `about ${Math.max(10, Math.round((bytes / 1_048_576) / 10) * 10)} MB`
  return `about ${gb < 10 ? Math.round(gb * 10) / 10 : Math.round(gb)} GB`
}

/** The bytes of a set of base files together. */
export function baseBytes(files: readonly { bytes: number }[]): number {
  let total = 0
  for (const f of files) total += f.bytes
  return total
}

/** The line above "Download base files": what is missing and how big it is. */
export function missingBasesLine(missing: readonly { label: string; bytes: number }[]): string {
  const files = missing.length ? missing : TRAINER_BASE_FILES
  const size = aboutSize(baseBytes(files))
  if (files.length === TRAINER_BASE_FILES.length) return `Z Image training base files are missing (${size}, one time).`
  return `Missing for Z Image training: ${files.map((f) => f.label).join(', ')} (${size}, one time).`
}

/**
 * What the panel says when "Download base files" started nothing (Discord
 * 25.10.2026, Comfy Desktop). `download_model` answers "exists" for a file it
 * finds in a ComfyUI model folder and an error object for one it refuses, and
 * the panel used to drop both: it read "Starting the downloads..." forever and
 * the Downloads tray stayed empty.
 */
export function baseStartFailedNote(
  alreadyThere: readonly { label: string }[],
  problems: readonly string[],
): string {
  const lines: string[] = []
  if (alreadyThere.length) {
    const one = alreadyThere.length === 1
    lines.push(`${alreadyThere.map((f) => f.label).join(', ')} ${one ? 'is' : 'are'} already in a ComfyUI model folder, but the trainer does not find ${one ? 'it' : 'them'} there. Open Settings, AI Backends, ComfyUI and check that the path is the folder with ComfyUI's main.py and models folder, press Connect, then come back to this tab.`)
  }
  for (const p of problems) lines.push(`Did not start: ${p}`)
  return lines.join('\n')
}

/** The base downloads stopped (finished, paused or gone) and the trainer
 *  still misses files: say which, instead of a button that keeps spinning. */
export function basesStillMissingNote(missing: readonly { label: string }[]): string {
  const names = missing.length ? missing.map((f) => f.label).join(', ') : 'the base files'
  return `The trainer still misses ${names}. Resume a paused download in the Downloads tray, or check Settings, AI Backends, ComfyUI (the folder with ComfyUI's main.py), then press Download base files again.`
}

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
  /** Count only these files: the ones the panel is fetching. A finished row
   *  of a file that was already on disk would otherwise pad the percent. */
  only?: readonly string[],
): number | null {
  if (!baseDownloadRunning(progress)) return null
  const files = only ? TRAINER_BASE_FILES.filter((f) => only.includes(f.filename)) : TRAINER_BASE_FILES
  const rows = files.flatMap((f) => { const r = progress[f.filename]; return r ? [r] : [] })
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

// A Mac trains with the trainer of its own image engine (api/mlx-train.ts).
// The five calls of a run go there on a Mac, so the run in useCreate is the
// same on every system.
async function onMac(): Promise<typeof import('./mlx-train') | null> {
  const { isMlxImageHost } = await import('./mlx-image')
  return isMlxImageHost() ? import('./mlx-train') : null
}

export async function stageTrainingImage(
  setId: string,
  filename: string,
  fileBytes: number[],
  caption: string,
): Promise<{ staged: string }> {
  const mac = await onMac()
  if (mac) return mac.stageMacTrainPhoto(setId, fileBytes, caption)
  return backendCall('stage_training_image', { setId, filename, fileBytes, caption })
}

export async function clearTrainingSet(setId: string): Promise<void> {
  const mac = await onMac()
  if (mac) return mac.clearMacTrainSet(setId)
  await backendCall('clear_training_set', { setId })
}

export async function startCharacterTraining(
  setId: string,
  name: string,
  triggerWord: string,
  steps?: number,
  /** 3.0.8 D20: 'standard' or 'low-vram'. Unknown or missing means Normal on
   *  the Rust side (`TrainPreset::from_arg`). */
  preset?: TrainVramPreset,
  /** 3.0.9 P8: 'style' writes `style_<name>_zimage`. Missing means a
   *  character on the Rust side (`TrainKind::from_arg`). */
  kind?: TrainKind,
): Promise<{ status: string }> {
  const mac = await onMac()
  // The Mac trainer has one recipe; Normal / Low VRAM is a CUDA matter (D20).
  if (mac) return mac.startMacTraining(setId, name, steps, kind)
  return backendCall('start_character_training', { setId, name, triggerWord, steps: steps ?? null, preset: preset ?? null, kind: kind ?? null })
}

export async function characterTrainingStatus(): Promise<TrainingRunStatus> {
  const mac = await onMac()
  if (mac) return mac.macTrainRunStatus(await mac.getMacTrainProgress())
  return backendCall('character_training_status')
}

export async function cancelCharacterTraining(): Promise<void> {
  const mac = await onMac()
  if (mac) return mac.cancelMacTraining()
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

/** 3.0.9 P8: a local style / concept LoRA, `style_<name>_zimage.safetensors`
 *  (start_character_training with kind 'style'). Not a character: the Use
 *  shelf leaves it out, the LoRA stack offers it as a Z-Image LoRA. */
export function parseLocalStyleLora(file: string): { file: string; name: string } | null {
  const m = /(?:^|[\\/])style_(.+)_zimage\.safetensors$/i.exec(file.trim())
  if (!m) return null
  return { file: file.trim(), name: m[1] }
}

/** Takes a local character off the disk: its LoRA file goes to the system's
 *  Trash (the Recycle Bin on Windows), so a delete by mistake can be put back
 *  from there. The same backend command the Model Manager deletes with, so
 *  the file is found in the same folders; `trash` keeps it from going for
 *  good. */
export async function deleteLocalCharacter(file: string): Promise<void> {
  // A Mac keeps its characters in its own LoRA folder, not in ComfyUI's.
  // That delete moves the file to the Trash too (commands/mlx_loras.rs).
  const { isMlxImageHost } = await import('./mlx-image')
  if (isMlxImageHost()) {
    const { deleteMlxLora } = await import('./mlx-loras')
    await deleteMlxLora(file)
    return
  }
  await backendCall('delete_comfy_model', { filename: file, extraDirs: customModelDirs(), trash: true })
}
