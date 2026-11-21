/**
 * Which row the LU Engine holds (3.1.3, David on purple): GGUF rows had no
 * way to unload one model, in the picker or on the Models page.
 *
 * `builtinModelMatches` answers "is there a contradiction", so it says yes
 * when nothing is loaded. A switch needs the stricter question.
 */
import { builtinModelMatches, builtinModelNameFromPath } from './builtin-model-identity'

export function luEngineHolds(loadedPath: string | null | undefined, rowName: string): boolean {
  return !!builtinModelNameFromPath(loadedPath) && builtinModelMatches(loadedPath, rowName)
}

/** Inside the desktop app, where an LU Engine can run at all. */
export function inDesktopApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** The GGUF the running engine holds, null when none runs or nobody answers. */
export async function readLuEnginePath(): Promise<string | null> {
  if (!inDesktopApp()) return null
  const { bundledEngineStatus } = await import('../api/engine')
  const status = await bundledEngineStatus().catch(() => null)
  return status?.running ? status.model_path : null
}
