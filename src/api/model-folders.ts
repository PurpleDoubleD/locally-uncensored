/**
 * Read-only questions about the model folders LU does NOT own.
 *
 * Deliberately separate from `detectProviderModelPath` in discover.ts: that
 * one asks the backend for a DOWNLOAD TARGET and the backend creates the
 * folder to hand one back. Model Storage asks a different question ("where is
 * it, and is it there at all") and must not leave a folder behind on a machine
 * that has no LM Studio.
 */

import { backendCall } from './backend'
import type { LmStudioModelDir } from '../lib/model-storage-rows'

/**
 * LM Studio's models folder, without creating anything.
 *
 * Any failure (web build, bridge without the command, older backend) answers
 * "not installed, no path", which is what the panel should say when it cannot
 * find out: the row is informational and must never block Settings.
 */
export async function lmStudioModelDir(): Promise<LmStudioModelDir> {
  try {
    const res = await backendCall<{ installed?: boolean; path?: string | null }>('lmstudio_model_dir')
    return { installed: res?.installed === true, path: res?.path ?? null }
  } catch {
    return { installed: false, path: null }
  }
}
