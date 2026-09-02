/**
 * Is a Discover row already on this machine, and if so, which local model is it.
 *
 * Pulled out of DiscoverModels.tsx (GH #118) because the answer is the whole
 * bug. nayffy's fresh Windows 11 install downloaded a chat model, the tile said
 * Installed, a restart flipped it back to "Get", and the button then did
 * nothing while the multi-gigabyte file sat on the disk the entire time.
 *
 * THE RULE, and the reason this file exists: installed is a question about the
 * DISK, never about a port. Every input below is filesystem evidence:
 *
 *  - `downloads`: this session's finished downloads, which are files that were
 *    written. Fastest path, gone after a restart, never the only source.
 *  - `installedModels`: what the model refresh read off the disk. For the
 *    built-in engine that list comes from `list_bundled_models`, a Rust
 *    directory scan that does not talk to the engine at all, and for Ollama and
 *    LM Studio from their own on-disk stores.
 *
 * Nothing here may ever consult engine health, a `/v1/models` request or a
 * provider connection state. An engine that is down is a reason to start it,
 * never a reason to tell the user their 8 GB file is not there.
 */

import { hfUrlToOllamaRef } from './hf-to-provider'
import { findLocalGgufInstalled, type InstalledModelLike } from './lmstudio-match'

/** The Discover-row fields this decision needs. */
export interface InstalledLookupModel {
  /** GGUF file name of the row, when it names one. */
  filename?: string
  /** Direct download URL, used to derive the canonical Ollama reference. */
  downloadUrl?: string
  /** Ollama tag, for rows that are Ollama-native. */
  ollamaModel?: string
}

/** The download-store shape this decision needs. */
export type DownloadStatuses = Record<string, { status?: string } | undefined>

/**
 * The installed model behind a Discover row, or null.
 *
 * The returned entry carries the picker id (`name`), which is what turns the
 * tile's badge into an action: a row that knows WHICH model it is can load it
 * into the chat.
 */
export function findInstalledForDiscoverModel(
  model: InstalledLookupModel,
  downloads: DownloadStatuses,
  installedModels: InstalledModelLike[],
): InstalledModelLike | null {
  const installedOllamaTags = installedModels
    .filter((m) => m.provider === 'ollama')
    .map((m) => (m.model || m.name || '').toLowerCase())

  const ollamaEntry = (tag: string): InstalledModelLike | null =>
    installedModels.find(
      (m) => m.provider === 'ollama' && (m.model || m.name || '').toLowerCase() === tag,
    ) ?? null

  if (model.ollamaModel) {
    const tag = model.ollamaModel.toLowerCase()
    if (installedOllamaTags.includes(tag)) return ollamaEntry(tag)
    // Ollama appends `:latest` to bare model names — accept either form
    if (!tag.includes(':') && installedOllamaTags.includes(`${tag}:latest`)) {
      return ollamaEntry(`${tag}:latest`)
    }
  }

  if (model.filename && model.downloadUrl) {
    const ref = hfUrlToOllamaRef(model.downloadUrl, model.filename)?.toLowerCase()
    if (ref && installedOllamaTags.includes(ref)) return ollamaEntry(ref)
  }

  // LM Studio AND the built-in engine, both read off the disk. The matcher
  // (lib/lmstudio-match.ts) bridges the id forms: LM Studio's basename ids and
  // its modern quant-less publisher/short key, and the built-in engine's file
  // stem.
  if (model.filename) {
    const local = findLocalGgufInstalled(model.filename, installedModels)
    if (local) return local
  }

  // A download that finished in THIS session is a file on the disk too, and it
  // is the only evidence that exists before the next model refresh runs. It
  // comes last because it carries no picker id, so an entry from the disk scan
  // is always the more useful answer.
  if (model.filename && downloads[model.filename]?.status === 'complete') return {}

  return null
}

/** The badge question, unchanged in meaning from the pre-2.6.8 closure. */
export function isDiscoverModelInstalled(
  model: InstalledLookupModel,
  downloads: DownloadStatuses,
  installedModels: InstalledModelLike[],
): boolean {
  return findInstalledForDiscoverModel(model, downloads, installedModels) !== null
}
