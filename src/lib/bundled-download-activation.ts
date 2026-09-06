/**
 * What happens to a GGUF the moment its download is complete.
 *
 * Measured on the Windows box, 2026-09-05 (build 4070cd91): the download
 * started the LU Engine on the new file, and nothing else followed. The
 * picker still named the previous model, the Installed tab still marked it
 * ACTIVE, `list_bundled_models` said `loaded: false` for every row, and the
 * first Use click tore the engine down and started it again on the very same
 * file. A first chat message would have done the same, because the send path
 * activates whatever the picker holds, and the picker held the old model.
 *
 * Two causes, one door. The engine was started with a path the frontend had
 * glued together (`${dir}/${file}`, a forward slash inside a Windows path), so
 * the argv never matched the path Rust lists and every later activation
 * counted as a change. And the picker was never told. Going through the
 * picker's own activation instead fixes both: the path comes from the model
 * list, and the model the user just downloaded is the model the chat uses.
 *
 * This module is the rule; the components call it. It is a .ts file so the
 * test below actually runs (vitest collects src/**\/__tests__/**\/*.test.ts).
 */
import { prefixModelName } from '../api/providers/model-name'
import { builtinModelNameFromPath } from './builtin-model-identity'

/** The picker id an LU Engine row gets for this file: `openai::<stem>`. */
export function bundledPickerIdForFile(filename: string): string {
  return prefixModelName('openai', builtinModelNameFromPath(filename))
}

export interface DownloadedModelActivation {
  /** The file that just finished, as it lies in the LU Engine folder. */
  filename: string
  /** Re-reads the model list so the new row exists before it is picked. */
  refresh: () => Promise<unknown>
  /** The picker's own activation: sets the active model and swaps the engine. */
  activate: (pickerId: string) => Promise<unknown>
}

/**
 * Make the downloaded file the active chat model, through the picker's
 * activation and never through a hand-built path. The refresh comes first:
 * a row that is not in the list yet cannot be picked, and the engine path is
 * read from that list.
 */
export async function activateDownloadedBundledModel(a: DownloadedModelActivation): Promise<string> {
  const id = bundledPickerIdForFile(a.filename)
  await a.refresh()
  await a.activate(id)
  return id
}
