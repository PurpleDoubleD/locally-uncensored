// A character trained in LU Cloud, brought onto the local shelf. The local
// shelf knows a character by the trainer's file name, char_<trigger>_zimage,
// so the backend (commands/character_files.rs) saves the weights under that
// name in this host's LoRA folder and reads their header first.

import { isTauri } from './backend'
import { CLOUD_BASE } from './cloud/config'
import { getAccessToken } from './cloud/supabase'
import { loraDownloadRefusal, type CloudLora, type LoraDownloadProgress } from './cloud/loras'

/** How the tensor names compare with what the local trainer writes. */
export type KeyFormat = 'same' | 'known' | 'unknown'

type ImportAnswer =
  | { status: 'saved'; file: string; path: string; bytes: number; keyFormat: KeyFormat }
  | { status: 'exists'; file: string }
  | { status: 'refused'; code: number }
  | { status: 'stopped' }
  | { status: 'no_comfy' }

export type ImportResult =
  | { status: 'saved'; file: string; keyFormat: KeyFormat }
  | { status: 'stopped' }

/** Only Z-Image characters run on the local shelf. */
export function canUseLocally(lora: Pick<CloudLora, 'base_family'>): boolean {
  return lora.base_family.toLowerCase().replace(/[-_\s]/g, '') === 'zimage'
}

export const ONLY_ZIMAGE_LOCALLY =
  'Only Z-Image characters run locally. This one was trained for another model, so it stays in LU Cloud.'

/** The fixed label on a cloud character of another family (3.0.8). */
export const CLOUD_ONLY_LABEL = 'Cloud only'

/** Under the model pick of cloud training (3.0.8): which characters can come
 *  to this computer is said before the training, not after it. */
export const CLOUD_TRAINING_FAMILY_NOTE =
  'Characters trained on Flux or Qwen run in LU Cloud only. Pick Z-Image to use the character on your machine too.'

/** Under the local trainer (GH #210, 31.10.2026): it trains on Z-Image Base
 *  alone, whatever image model is picked at the top. A tester on Qwen-Image
 *  2.1 read the finished Z-Image character as the wrong model trained. */
export function localTrainingFamilyNote(kind: 'character' | 'style'): string {
  return `The local trainer makes a Z-Image ${kind}, whatever image model is picked. Use it with a Z-Image model.`
}

/** The line under a saved import, or null when nothing needs saying. */
export function keyFormatNote(format: KeyFormat): string | null {
  if (format === 'unknown') {
    return 'The file is laid out differently from the characters LU trains on this computer. The image model may ignore it. If the character does not show, use it in LU Cloud.'
  }
  return null
}

let importRuns = 0

/**
 * Saves the cloud character as a local one. Throws an English sentence when
 * it cannot: another family, a character of that name already on this
 * computer, no LoRA folder, or a download that failed. Resolves 'stopped'
 * when `signal` ended it; the backend has then removed the unfinished file.
 */
export async function importCloudCharacter(
  lora: Pick<CloudLora, 'id' | 'name' | 'trigger_word' | 'base_family'>,
  onProgress?: (p: LoraDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<ImportResult> {
  if (!canUseLocally(lora)) throw new Error(ONLY_ZIMAGE_LOCALLY)
  if (!isTauri()) throw new Error('Using a character locally needs the desktop app.')
  const token = await getAccessToken()
  if (!token) throw new Error(loraDownloadRefusal(401))
  const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')])
  importRuns += 1
  const id = `lora-import-${lora.id}-${importRuns}`
  const cancel = () => { void invoke('cancel_cloud_file', { id }).catch(() => { /* nothing left to cancel */ }) }
  const unlisten = onProgress
    ? await listen<LoraDownloadProgress & { id: string }>('cloud-file-progress', (event) => {
        if (event.payload.id === id) onProgress({ received: event.payload.received, total: event.payload.total })
      })
    : null
  signal?.addEventListener('abort', cancel)
  try {
    if (signal?.aborted) cancel()
    const answer = await invoke<ImportAnswer>('import_cloud_character', {
      id,
      url: `${CLOUD_BASE}/api/loras/${encodeURIComponent(lora.id)}/file`,
      authToken: token,
      triggerWord: lora.trigger_word,
      name: lora.name,
    })
    switch (answer.status) {
      case 'saved': return { status: 'saved', file: answer.file, keyFormat: answer.keyFormat }
      case 'stopped': return { status: 'stopped' }
      case 'refused': throw new Error(loraDownloadRefusal(answer.code))
      case 'exists':
        throw new Error(`A local character named ${answer.file} is already on this computer. Delete it under Use character in the local lane first if you want to replace it.`)
      case 'no_comfy':
        throw new Error('No LoRA folder was found on this computer. Set up ComfyUI first, then try again.')
    }
    throw new Error('The character could not be saved locally.')
  } finally {
    signal?.removeEventListener('abort', cancel)
    unlisten?.()
  }
}
