// GH #235 follow-up (LU-Admin, 15.11.2026): "Unload all models" in the model
// picker unloaded Ollama and nothing else, and it was only there when the list
// had an Ollama model. It now frees whatever is loaded: Ollama, the LU Engine,
// LM Studio and ComfyUI's memory, and says per engine what did not go.
import { unloadAllModels, type UnloadAllResult } from '../api/ollama'
import { readLoadedLmStudioModels } from '../api/lmstudio'
import { backendCall, isTauri } from '../api/backend'
import { log } from './logger'

export type UnloadEngine = 'ollama' | 'engine' | 'lmstudio' | 'comfyui'

/** One engine's part of the answer. `problem` is set when it did not go. */
export interface UnloadOutcome {
  engine: UnloadEngine
  freed: boolean
  problem?: string
}

export interface UnloadEverythingResult {
  outcomes: UnloadOutcome[]
  /** Ollama's own answer, for the per-model switches. Null when not asked. */
  ollama: UnloadAllResult | null
}

/** Which engines to ask. Ollama and LM Studio only when the list has them;
 *  the LU Engine and ComfyUI are freed by the app itself (desktop only). */
export interface UnloadScope {
  ollama: boolean
  lmstudio: boolean
}

interface OffloadReply { offloaded?: string[]; notOurs?: Array<{ backend?: string }> }

export interface UnloadDeps {
  unloadOllama: () => Promise<UnloadAllResult>
  offload: () => Promise<OffloadReply>
  lmsLoaded: () => Promise<string[]>
  lmsUnloadAll: () => Promise<unknown>
  desktop: () => boolean
}

const defaultDeps: UnloadDeps = {
  unloadOllama: () => unloadAllModels(),
  offload: () => backendCall<OffloadReply>('offload_local_models', { includeComfyui: true }),
  lmsLoaded: () => readLoadedLmStudioModels(),
  lmsUnloadAll: () => backendCall('lmstudio_unload_model', { model: '--all' }),
  desktop: () => isTauri(),
}

const NAME: Record<UnloadEngine, string> = { ollama: 'Ollama', engine: 'The LU Engine', lmstudio: 'LM Studio', comfyui: 'ComfyUI' }

export async function unloadEverything(scope: UnloadScope, deps: UnloadDeps = defaultDeps): Promise<UnloadEverythingResult> {
  const outcomes: UnloadOutcome[] = []
  let ollama: UnloadAllResult | null = null

  if (scope.ollama) {
    try {
      ollama = await deps.unloadOllama()
      if (ollama.failed.length > 0) {
        outcomes.push({ engine: 'ollama', freed: false, problem: `Ollama refused to unload ${ollama.failed.join(', ')}.` })
      } else if (ollama.stillBusy.length > 0) {
        outcomes.push({ engine: 'ollama', freed: false, problem: `Ollama is still answering with ${ollama.stillBusy.join(', ')} and unloads it when that is done.` })
      } else {
        outcomes.push({ engine: 'ollama', freed: ollama.unloaded.length > 0 })
      }
    } catch (err) {
      log.warn('unload_everything.ollama_failed', { err })
      outcomes.push({ engine: 'ollama', freed: false, problem: 'Ollama did not answer, so its models may still be loaded.' })
    }
  }

  if (deps.desktop()) {
    // The LU Engine (with its embedding helper and dictation) and ComfyUI's
    // memory, in one call of the app. Ollama was asked above; asked again here
    // it has nothing left.
    try {
      const reply = await deps.offload()
      const freed = new Set(reply.offloaded ?? [])
      outcomes.push({ engine: 'engine', freed: freed.has('bundled-engine') })
      if ((reply.notOurs ?? []).some((n) => n.backend === 'comfyui')) {
        outcomes.push({ engine: 'comfyui', freed: false, problem: 'ComfyUI runs on another computer, so LU cannot free its memory from here.' })
      } else {
        outcomes.push({ engine: 'comfyui', freed: freed.has('comfyui') })
      }
    } catch (err) {
      log.warn('unload_everything.offload_failed', { err })
      outcomes.push({ engine: 'engine', freed: false, problem: 'The LU Engine did not stop, so its model may still be loaded.' })
      outcomes.push({ engine: 'comfyui', freed: false, problem: 'ComfyUI did not answer, so its memory may still be in use.' })
    }

    if (scope.lmstudio) {
      try {
        const before = await deps.lmsLoaded()
        if (before.length === 0) {
          outcomes.push({ engine: 'lmstudio', freed: false })
        } else {
          await deps.lmsUnloadAll()
          const after = await deps.lmsLoaded()
          outcomes.push(after.length === 0
            ? { engine: 'lmstudio', freed: true }
            : { engine: 'lmstudio', freed: false, problem: `LM Studio still has ${after.join(', ')} loaded.` })
        }
      } catch (err) {
        log.warn('unload_everything.lmstudio_failed', { err })
        outcomes.push({ engine: 'lmstudio', freed: false, problem: 'LM Studio did not answer, so its models may still be loaded.' })
      }
    }
  }

  return { outcomes, ollama }
}

/** The sentence under the button: every engine that did not go, one by one. */
export function unloadProblems(outcomes: readonly UnloadOutcome[]): string | null {
  const problems = outcomes.filter((o) => o.problem).map((o) => o.problem!)
  return problems.length > 0 ? problems.join(' ') : null
}

/** What was freed, for the log and the done line. */
export function unloadedNames(outcomes: readonly UnloadOutcome[]): string[] {
  return outcomes.filter((o) => o.freed).map((o) => NAME[o.engine].replace(/^The /, ''))
}
