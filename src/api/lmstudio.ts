// LM Studio per-model load/unload, mirroring the Ollama API surface in
// api/ollama.ts. The bridge wraps the `lms` CLI for state changes and reads
// the loaded list from `/api/v0/models` where each entry has a `state` field.
// The frontend talks only to the bridge, there is no CLI shell-out from the
// browser.

import { isLfm3Model, lmStudioRuntimeNote } from '../lib/lmstudio-runtime'
import { backendCall } from './backend'
import { callLimit, CallTimeoutError, type CallLimitOptions } from '../lib/call-limit'
import { lmStudioReason } from '../lib/lmstudio-switch'
import { log } from '../lib/logger'
import { detailOf } from '../lib/error-text'
import {
  noteEndedLmStudioLoad, claimEndedLmStudioLoad, isEndedLmStudioLoad, settleEndedLmStudioLoad,
  endedLmStudioLoads, type EndedLmStudioLoad,
} from '../lib/lmstudio-ended-loads'

/** How long a load may take before the app stops waiting. The limit an Ollama load has. */
export const LMSTUDIO_LOAD_LIMIT_MS = 300_000

/** How long an unload may take. */
export const LMSTUDIO_UNLOAD_LIMIT_MS = 15_000

/**
 * How long after an unload the model may still be listed before it counts as
 * not unloaded.
 */
export const LMSTUDIO_UNLOAD_SETTLE_MS = 3_000
const UNLOAD_SETTLE_STEP_MS = 250

/** How long an ended load is given to report that its `lms` process is gone. */
const CANCEL_SETTLE_MS = 2_000

/**
 * How often LM Studio is asked about a load the app ended. The beat the
 * picker reads the loaded list at.
 */
export const LMSTUDIO_ENDED_LOAD_LOOK_MS = 1_500

/**
 * How long after its `lms` was gone an ended load has to stay neither loading
 * nor loaded before it counts as never begun. LM Studio reported `loading`
 * within a second of the start of `lms load` in every measured run, and once
 * `lms` is gone nothing can ask for the load any more, so this is a wide
 * margin for a request that was already on its way. Two looks in a row have
 * to agree as well.
 */
export const LMSTUDIO_ENDED_LOAD_QUIET_MS = 4_500

/**
 * How long an ended load is watched at most. Twice the limit of a load: LM
 * Studio finishes what it began at its own pace, and a large model from a
 * slow disk takes minutes.
 */
export const LMSTUDIO_ENDED_LOAD_WATCH_LIMIT_MS = 2 * LMSTUDIO_LOAD_LIMIT_MS

/** The slack the bridge gets over our own limit, so ours is the one that ends the call. */
const BRIDGE_SLACK_MS = 5_000

export type LmStudioCallOptions = CallLimitOptions

/** A load or unload that ran into its time limit. The message is for the screen. */
export class LmStudioTimeoutError extends CallTimeoutError {
  constructor(message: string) {
    super(message)
    this.name = 'LmStudioTimeoutError'
  }
}

/**
 * A load or unload LM Studio refused. `reason` is what the `lms` command
 * wrote, cleaned for one line on screen, or undefined when it wrote nothing.
 */
export class LmStudioSwitchError extends Error {
  readonly reason: string | undefined
  constructor(message: string, reason: string | undefined) {
    super(message)
    this.name = 'LmStudioSwitchError'
    this.reason = reason
  }
}

function bridgeFailure(what: string, e: unknown): LmStudioSwitchError {
  const raw = detailOf(e)
  return new LmStudioSwitchError(`${what}: ${raw || 'no reason given'}`, lmStudioReason(raw))
}

/**
 * The loaded list for the picker's poll. An LM Studio that cannot be asked
 * reads as an empty list here: the poll runs every 1.5 s and has nothing to
 * say about a server that is off.
 */
export async function listLoadedLmStudioModels(): Promise<string[]> {
  try {
    const data = await backendCall<{ loaded: string[] }>('lmstudio_list_loaded')
    return data.loaded ?? []
  } catch {
    return []
  }
}

/**
 * The loaded list for whoever tells a person what a load or unload did.
 * Throws when LM Studio could not be asked: an unreadable list is not an
 * empty one, and nothing true can be said from it.
 */
export async function readLoadedLmStudioModels(): Promise<string[]> {
  const data = await backendCall<{ loaded?: string[]; readable?: boolean }>('lmstudio_list_loaded')
  if (data.readable === false) throw new Error('LM Studio did not answer the question which models are loaded.')
  return data.loaded ?? []
}

/**
 * Load (or RELOAD) a model in LM Studio. When `contextLength` is given the
 * bridge unloads the current instance first and reloads with `lms load -c <N>`,
 * because LM Studio fixes the context window at load time (the OpenAI-compat
 * HTTP API has no per-request num_ctx). Omit it for a plain load.
 *
 * `lms load` returns only when the model is in memory, so the call has a limit
 * and takes a signal. Aborted by the caller it throws an AbortError; at the
 * limit it throws an `LmStudioTimeoutError`. Either way the bridge ends the
 * `lms` process. LM Studio may go on loading without it, so the load is
 * written down as ended and watched until the model is really not there
 * (lib/lmstudio-ended-loads.ts, `watchEndedLoads` below).
 */
export async function loadLmStudioModel(model: string, contextLength?: number, options?: LmStudioCallOptions): Promise<void> {
  const limitMs = options?.timeoutMs ?? LMSTUDIO_LOAD_LIMIT_MS
  const limit = callLimit(limitMs, options?.signal)
  const window = contextLength && contextLength > 0 ? contextLength : null
  const callId = crypto.randomUUID()
  const endLoad = () => {
    backendCall('lmstudio_cancel_load', { callId }).catch((e) =>
      log.warn(`[lmstudio] could not end the load of "${model}"`, { err: e }))
  }
  // Asked for again: whatever was cancelled before is wanted now.
  const endedBefore = claimEndedLmStudioLoad(model)
  let bridge: Promise<unknown> | null = null
  // Whether the model LM Studio ends up with is this call's doing.
  let ours = false
  try {
    if (limit.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    // LM Studio may still be on the load that was ended a moment ago. Asking
    // for a second one would put the model in memory twice, so the one that
    // is under way is waited for when it is the same load.
    if (endedBefore) {
      ours = true
      // An unload the watch has sent must land before anything is asked for:
      // arriving later it would end the load that is wanted now.
      if (endedBefore.unloading) await limit.race(endedBefore.unloading.catch(() => undefined))
      if (endedBefore.contextLength === window && await limit.race(arrivalOfEndedLoad(model, limit.signal))) return
    }
    // With a window the bridge unloads the model first, so what is there
    // afterwards is this load's. Without one, a model that is already loaded
    // stays somebody else's, and so does one behind a list nobody could read.
    ours = window !== null
      || await limit.race(readLoadedLmStudioModels().then((loaded) => !loaded.includes(model), () => false))
    // N1: LFM3 needs LM Studio's runtime 2.65.1+; an older one fails the load
    // without saying why, so LU says it first (lib/lmstudio-runtime.ts).
    if (isLfm3Model(model)) {
      const runtime = await limit.race(backendCall<string | null>('lmstudio_gguf_runtime').catch(() => null))
      const note = lmStudioRuntimeNote(model, runtime)
      if (note) throw new LmStudioSwitchError(note, note)
    }
    limit.signal.addEventListener('abort', endLoad, { once: true })
    bridge = backendCall('lmstudio_load_model', {
      model,
      contextLength: window,
      timeoutMs: limitMs + BRIDGE_SLACK_MS,
      callId,
    })
    await limit.race(bridge)
  } catch (e) {
    // An ended load is over when the bridge says the `lms` process is gone,
    // which it does within a moment of the cancel. Waited for, briefly, so
    // the look at the loaded list that follows does not race the kill.
    if (limit.signal.aborted && bridge) {
      await Promise.race([
        bridge.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, CANCEL_SETTLE_MS)),
      ])
    }
    if (limit.signal.aborted && ours) {
      noteEndedLmStudioLoad(model, window)
      watchEndedLoads(0)
    }
    if (limit.timedOut()) {
      log.warn(`[lmstudio] load of "${model}" ran into its limit of ${limitMs} ms`)
      throw new LmStudioTimeoutError(`Loading ${model} took longer than ${Math.round(limitMs / 60_000)} minutes and was stopped.`)
    }
    if (limit.signal.aborted) throw e
    log.warn(`[lmstudio] failed to load model "${model}"`, { err: e })
    throw bridgeFailure(`LM Studio could not load ${model}`, e)
  } finally {
    limit.signal.removeEventListener('abort', endLoad)
    limit.clear()
  }
}

/** What LM Studio says about a model: `loaded`, `loading`, `not-loaded`, or null when it could not be asked. */
async function lmStudioStateOf(model: string): Promise<string | null> {
  try {
    return (await backendCall<LmStudioModelContext | null>('lmstudio_model_context', { model }))?.state ?? null
  } catch {
    return null
  }
}

/**
 * Wait for a load LM Studio is still working on. True when the model arrived,
 * false when LM Studio has nothing under way and the load has to be asked for.
 */
async function arrivalOfEndedLoad(model: string, signal: AbortSignal): Promise<boolean> {
  for (;;) {
    const state = await lmStudioStateOf(model)
    if (state === 'loaded') return true
    if (state !== 'loading' || signal.aborted) return false
    await new Promise((resolve) => setTimeout(resolve, LMSTUDIO_ENDED_LOAD_LOOK_MS))
  }
}

let endedLoadWatch: ReturnType<typeof setTimeout> | null = null
let endedLoadRound = false

/**
 * Look after the ended loads until none is left: one look at LM Studio per
 * beat and per load, no look while the list is empty. A load that was just
 * ended is looked at right away (`inMs` 0), because that is the moment an
 * unload can still end it.
 */
function watchEndedLoads(inMs: number = LMSTUDIO_ENDED_LOAD_LOOK_MS): void {
  if (endedLoadRound || endedLmStudioLoads().length === 0) return
  if (endedLoadWatch !== null) {
    if (inMs > 0) return
    clearTimeout(endedLoadWatch)
  }
  endedLoadWatch = setTimeout(() => {
    endedLoadWatch = null
    endedLoadRound = true
    void Promise.all(endedLmStudioLoads().map(lookAtEndedLoad)).finally(() => {
      endedLoadRound = false
      watchEndedLoads()
    })
  }, inMs)
}

/**
 * One unload for an ended load, kept on the entry while it is on its way so
 * whoever asks for the model again can wait for it. True when it was answered.
 */
function unloadEndedLoad<T>(entry: EndedLmStudioLoad, unload: () => Promise<T>): Promise<T | undefined> {
  const run = unload()
    .catch((e) => {
      // Nothing for the screen: the next look asks LM Studio again.
      log.info(`[lmstudio] the unload of "${entry.model}" after its load was ended did not go through`, { err: e })
      return undefined
    })
    .finally(() => { if (entry.unloading === run) entry.unloading = null })
  entry.unloading = run
  return run
}

async function lookAtEndedLoad(entry: EndedLmStudioLoad): Promise<void> {
  if (Date.now() - entry.endedAt >= LMSTUDIO_ENDED_LOAD_WATCH_LIMIT_MS) {
    log.warn(`[lmstudio] gave up watching the ended load of "${entry.model}"`)
    settleEndedLmStudioLoad(entry, 'unconfirmed')
    return
  }
  const state = await lmStudioStateOf(entry.model)
  // Asked for again while LM Studio answered: no longer ours to unload.
  if (!isEndedLmStudioLoad(entry)) return
  if (state === 'loaded') {
    entry.quietLooks = 0
    // Asked again at the next look when it did not take, until the watch limit.
    if (await unloadEndedLoad(entry, () => unloadLmStudioModelAndLook(entry.model)) === 'unloaded') {
      settleEndedLmStudioLoad(entry, 'gone')
    }
  } else if (state === 'loading') {
    entry.quietLooks = 0
    // LM Studio 0.4.12 ends a load when its model is unloaded, also when the
    // `lms` that asked for the load is gone (hand test, 11.10.2026). Sent
    // once: a version that does not take it finishes the load, and the
    // branch above unloads what arrives.
    if (entry.unloadedWhileLoading) return
    entry.unloadedWhileLoading = true
    const answered = await unloadEndedLoad(entry, () => unloadLmStudioModel(entry.model).then(() => true))
    if (answered && isEndedLmStudioLoad(entry) && await lmStudioStateOf(entry.model) === 'not-loaded') {
      settleEndedLmStudioLoad(entry, 'gone')
    }
  } else if (state === 'not-loaded') {
    entry.quietLooks += 1
    if (entry.quietLooks >= 2 && Date.now() - entry.endedAt >= LMSTUDIO_ENDED_LOAD_QUIET_MS) {
      settleEndedLmStudioLoad(entry, 'gone')
    }
  } else {
    // LM Studio did not answer: nothing is known to be gone.
    entry.quietLooks = 0
  }
}

/** Test-only: stop the watch between tests. */
export function __stopEndedLmStudioLoadWatchForTests(): void {
  if (endedLoadWatch !== null) clearTimeout(endedLoadWatch)
  endedLoadWatch = null
  endedLoadRound = false
}

/**
 * Ask LM Studio to unload a model. An answer means the `lms` command ran, not
 * that the model is gone: whoever reports the result to a person uses
 * `unloadLmStudioModelAndLook`.
 */
export async function unloadLmStudioModel(model: string, options?: LmStudioCallOptions): Promise<void> {
  const limitMs = options?.timeoutMs ?? LMSTUDIO_UNLOAD_LIMIT_MS
  const limit = callLimit(limitMs, options?.signal)
  try {
    await limit.race(backendCall('lmstudio_unload_model', { model, timeoutMs: limitMs + BRIDGE_SLACK_MS }))
  } catch (e) {
    if (limit.timedOut()) {
      log.warn(`[lmstudio] unload of "${model}" ran into its limit of ${limitMs} ms`)
      throw new LmStudioTimeoutError(`LM Studio did not answer the unload of ${model}.`)
    }
    if (limit.signal.aborted) throw e
    log.warn(`[lmstudio] failed to unload model "${model}"`, { err: e })
    throw bridgeFailure(`LM Studio could not unload ${model}`, e)
  } finally {
    limit.clear()
  }
}

/**
 * Unload one model and say what really happened: `unloaded` when it has left
 * LM Studio's loaded list, `still-loaded` when it is still there once the
 * unload had time to land. Throws when the unload or the look afterwards
 * fails.
 */
export async function unloadLmStudioModelAndLook(model: string, options?: LmStudioCallOptions): Promise<'unloaded' | 'still-loaded'> {
  await unloadLmStudioModel(model, options)
  const deadline = Date.now() + LMSTUDIO_UNLOAD_SETTLE_MS
  for (;;) {
    const loaded = await readLoadedLmStudioModels()
    if (!loaded.includes(model)) return 'unloaded'
    if (Date.now() >= deadline) return 'still-loaded'
    await new Promise((resolve) => setTimeout(resolve, UNLOAD_SETTLE_STEP_MS))
  }
}

export interface LmStudioModelContext {
  /** The context window the model is ACTUALLY running with (null = not loaded). */
  loaded: number | null
  /** The model's maximum context window. */
  max: number | null
  /** LM Studio state, e.g. "loaded" | "not-loaded". */
  state: string | null
}

/**
 * Read a model's real context window from LM Studio's enhanced REST API.
 * `loaded` is the source of truth for the TokenCounter denominator, it is what
 * the chat actually uses, not the model's theoretical max.
 */
export async function getLmStudioModelContext(model: string): Promise<LmStudioModelContext> {
  try {
    return await backendCall<LmStudioModelContext>('lmstudio_model_context', { model })
  } catch {
    return { loaded: null, max: null, state: null }
  }
}
