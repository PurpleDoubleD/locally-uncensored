import type { OllamaModel, PullProgress } from "../types/models"
import { ollamaUrl, localFetch, localFetchStream, isTauri } from "./backend"
import { isRecord, prop, asString, asNumber, asStringArray, asRecordArray } from "./providers/wire"
import { parseOllamaShowContext } from "./providers/context-probe"
import { log } from "../lib/logger"
import { oneEntryPerName } from "../lib/one-entry-per-name"
import { isLocalTransportFailure, localBackendUnreachableMessage } from "../lib/local-backend-transport"
import { ollamaWindowFor, type WindowChoice, type WindowUse } from "../lib/context-window"
import { useSettingsStore } from "../stores/settingsStore"
import { callLimit, CallTimeoutError, type CallLimitOptions } from "../lib/call-limit"
import { clampContextWindow } from "../lib/number-limits"

/**
 * How long a load may take before the app stops waiting.
 *
 * Five minutes, because that is what the wait already was in practice: the
 * local proxy ends a request without its own limit after 300 seconds. A large
 * model from a slow disk can honestly take minutes, so a shorter limit would
 * end loads that work today. What changes is that the limit is ours, covers
 * the whole call, and can be ended earlier by the caller's signal.
 */
export const OLLAMA_LOAD_LIMIT_MS = 300_000

/**
 * How long an unload may take. Ollama answers `keep_alive: 0` at once, also
 * for a model that is busy (it marks it to go when the running request ends).
 */
export const OLLAMA_UNLOAD_LIMIT_MS = 15_000

/**
 * How long after an unload the model may still be listed before it counts as
 * busy. An idle model leaves /api/ps well under a second after the answer; one
 * that is still there after this is finishing a request.
 */
export const OLLAMA_UNLOAD_SETTLE_MS = 3_000
const UNLOAD_SETTLE_STEP_MS = 250

/** The slack the proxy gets over our own limit, so ours is the one that ends the call. */
const PROXY_SLACK_MS = 5_000

export type OllamaCallOptions = CallLimitOptions

/** A load or unload that ran into its time limit. The message is for the screen. */
export class OllamaTimeoutError extends CallTimeoutError {
  constructor(message: string) {
    super(message)
    this.name = "OllamaTimeoutError"
  }
}

/**
 * One entry of Ollama's `/api/tags` response.
 *
 * The identity fields mirror `OllamaModel` because the mapper below spreads
 * the entry straight through, exactly as it always has — this type documents
 * that spread instead of hiding it behind `any`. `capabilities` is the one
 * field we do NOT trust: it only appeared in newer Ollama builds, so it stays
 * `unknown` and is checked with `Array.isArray` before it is read.
 */
type OllamaTagsEntry = Omit<
  OllamaModel,
  'type' | 'provider' | 'providerName' | 'contextLength' | 'supportsTools'
> & { capabilities?: unknown }

export async function listModels(): Promise<OllamaModel[]> {
  const res = await localFetch(ollamaUrl("/tags"))
  if (!res.ok) throw new Error("Failed to fetch models")
  const data: unknown = await res.json()
  // Boundary check: `models` must be an array before anything iterates it.
  // A body that is not shaped that way yields an empty list, which is what
  // the old `data.models || []` did for a missing field.
  const rawModels = prop(data, 'models')
  const entries: OllamaTagsEntry[] = Array.isArray(rawModels)
    ? (rawModels as OllamaTagsEntry[])
    : []
  return oneEntryPerName(entries).map((m) => ({
    ...m,
    type: "text" as const,
    // /api/tags states this per model. Without the mapping the field arrives as
    // `capabilities` and nothing ever looks at it, so every Ollama model
    // reached the picker and resolveToolSupport with `supportsTools:
    // undefined` and fell through to the family-name list in
    // model-compatibility. A completion-only build whose name merely contains
    // a known family then got a wrench in the picker and a `tools` payload it
    // cannot accept.
    //
    // THIS is the path the app uses for Ollama: useModels calls this function
    // directly (useModels.ts:168). OllamaProvider.listModels carries the same
    // mapping, but nothing routes Ollama through the provider class, which is
    // why fixing only there changed nothing on the real build.
    //
    // Absent field stays undefined, never false: no answer must not read as a
    // denial, or an older Ollama would push every model onto the hermes path.
    supportsTools: Array.isArray(m.capabilities) ? m.capabilities.includes("tools") : undefined,
  }))
}

/**
 * Raw `/api/show` metadata. Ollama's payload differs per architecture
 * (`llama.context_length` vs `gemma2.context_length` vs …), so there is no
 * fixed shape to promise — a checked record is the honest return type, and
 * every reader below probes it field by field.
 */
export async function showModel(name: string): Promise<Record<string, unknown>> {
  const res = await localFetch(ollamaUrl("/show"), {
    method: "POST",
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error("Failed to show model")
  const body: unknown = await res.json()
  return isRecord(body) ? body : {}
}

/**
 * What a server that speaks the Ollama API says about one model's context.
 *
 * `known` is false when no source named a length. `max` is then the old
 * conservative 4096, so what Auto sends does not change; but the number is a
 * stand in and not a fact, and the context picker must not end its list there
 * (GH #166: a KoboldCpp started with 262144 behind its Ollama emulation got a
 * picker that offered "Auto · 4K" and "4K · max" and nothing else).
 */
export interface OllamaModelContext {
  max: number
  known: boolean
}

/** What Auto runs with when nobody named the model's length. */
export const UNKNOWN_MODEL_CONTEXT = 4096

const positiveNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null

/** One GET that answers `{ value: N }` (KoboldCpp), or null. */
async function koboldValue(path: string): Promise<number | null> {
  try {
    const res = await localFetch(ollamaUrl(path), { timeoutMs: 5000 })
    if (!res.ok) return null
    const body: unknown = await res.json()
    return typeof body === 'number' ? positiveNumber(body) : positiveNumber(prop(body, 'value'))
  } catch {
    return null
  }
}

/**
 * The context window of one model, and whether anyone actually named it.
 *
 * Order, each only asked when the one before said nothing:
 *   1. `/api/show` (`parseOllamaShowContext`). Ollama itself always answers here.
 *   2. KoboldCpp's own endpoints on the same port, for its Ollama emulation,
 *      whose `/api/show` carries an empty `model_info` (GH #166):
 *      `/api/extra/true_max_context_length`, then the KoboldAI
 *      `/api/v1/config/max_context_length`. Both answer `{ "value": N }`, the
 *      context the server was started with. (`/api/v1/model` only names the
 *      model and carries no length.)
 *   3. `/api/ps`: the `context_length` the model is loaded with right now. Not
 *      its maximum, but a window the server demonstrably runs.
 *
 * Nobody answered: `{ max: 4096, known: false }`. `answered` says whether the
 * server could be reached at all, so a server that is down does not leave a
 * stand in cached for the whole session.
 */
export async function getModelContextInfo(name: string): Promise<OllamaModelContext & { answered: boolean }> {
  let answered = false
  try {
    const info = await showModel(name)
    answered = true
    const fromShow = parseOllamaShowContext(info)
    if (fromShow) return { max: fromShow, known: true, answered }
  } catch { /* fall through to the other sources */ }

  const kobold =
    (await koboldValue('/extra/true_max_context_length')) ??
    (await koboldValue('/v1/config/max_context_length'))
  if (kobold) return { max: kobold, known: true, answered: true }

  try {
    const loaded = (await readLoadedModels()).find((m) => m.name === name)
    answered = true
    if (loaded && loaded.contextLength > 0) return { max: loaded.contextLength, known: true, answered }
  } catch { /* nothing more to ask */ }

  return { max: UNKNOWN_MODEL_CONTEXT, known: false, answered }
}

export async function getModelContext(name: string): Promise<number> {
  return (await getModelContextInfo(name)).max
}

// Cached model-context lookup so the chat hooks can forward a correct num_ctx
// to Ollama on EVERY send without an /api/show round-trip each time. A model's
// trained context length doesn't change at runtime; cache lives for the session.
const _ctxCache = new Map<string, OllamaModelContext>()
export async function getModelContextInfoCached(name: string): Promise<OllamaModelContext> {
  const hit = _ctxCache.get(name)
  if (hit !== undefined) return hit
  const { max, known, answered } = await getModelContextInfo(name)
  const v = { max, known }
  if (answered) _ctxCache.set(name, v)
  return v
}

export async function getModelContextCached(name: string): Promise<number> {
  return (await getModelContextInfoCached(name)).max
}

/**
 * The window each model was last sent, by model name.
 *
 * Ollama keeps a model loaded for exactly one num_ctx and loads it again for
 * a request that names another. So the window a model was last sent IS the
 * window it is loaded with, as far as this app can know it, and it is what a
 * call that picks no window of its own has to repeat.
 */
const lastSentWindow = new Map<string, number>()

/**
 * THE num_ctx of a request to an Ollama model. Every request this app sends
 * to Ollama gets its window here and nowhere else.
 *
 *   - `use` named ('chat' or 'agent'): the window of that use. Only a turn a
 *     person started names one (see `WindowUse`).
 *   - `use` left out: the window this model was last sent, and the chat
 *     window for a model that was sent nothing yet. This is what every call
 *     nobody sees uses, so none of them can make Ollama load the model again.
 *
 * The user's own setting (Settings, or the context menu in the header) wins
 * over both, at once, for every caller.
 */
export async function ollamaNumCtx(model: string, use?: WindowUse): Promise<number> {
  // Clamped (B13): a typo of 999999999 is a KV-cache reservation of that size.
  const override = clampContextWindow(useSettingsStore.getState().settings.contextWindowOverride)
  let window: number
  if (override > 0) {
    // With an override the model's own maximum is never read, so nothing is asked.
    window = override
  } else if (use) {
    window = ollamaWindowFor(use, await getModelContextCached(model))
  } else {
    window = lastSentWindow.get(model) ?? ollamaWindowFor('chat', await getModelContextCached(model))
  }
  lastSentWindow.set(model, window)
  return window
}

/**
 * The `options` entry that carries the window, for a request body. The one
 * place in the app that writes `num_ctx`. `backend-default` writes nothing.
 */
export async function ollamaWindowOption(model: string, choice?: WindowChoice): Promise<{ num_ctx?: number }> {
  if (choice === 'backend-default') return {}
  return { num_ctx: await ollamaNumCtx(model, choice) }
}

/** Forget what was sent. For tests, which share this module between cases. */
export function forgetSentWindows(): void {
  lastSentWindow.clear()
  _ctxCache.clear()
}

/**
 * Make Ollama load a model with the window of `use` RIGHT NOW, so a change of
 * the context window in the header takes effect immediately instead of
 * silently on the next message. An `/api/generate` with an empty prompt and
 * the new num_ctx makes Ollama load the model again at that size;
 * `keep_alive` keeps it warm. Best-effort: a failure is logged and not thrown
 * (the next message sends the same window). It is a load like any other, so
 * it has the same limit.
 */
export async function reloadOllamaWithWindow(model: string, use: WindowUse): Promise<void> {
  if (!model) return
  const limit = callLimit(OLLAMA_LOAD_LIMIT_MS)
  try {
    const window = await limit.race(ollamaWindowOption(model, use))
    await localFetch(ollamaUrl("/generate"), {
      method: "POST",
      body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: "30m", options: window }),
      signal: limit.signal,
      timeoutMs: OLLAMA_LOAD_LIMIT_MS + PROXY_SLACK_MS,
    })
  } catch (e) {
    log.warn(`[ollama] reloading "${model}" with the new context window did not finish`, { timedOut: limit.timedOut(), err: e })
  } finally {
    limit.clear()
  }
}

export async function pullModel(name: string, signal?: AbortSignal): Promise<Response> {
  const url = isTauri() ? ollamaUrl("/pull") : "/api/pull"
  const res = await localFetchStream(url, {
    method: "POST",
    body: JSON.stringify({ name, stream: true }),
    signal,
  })
  if (!res.ok) {
    // The body was thrown away here, and it is the only place the reason ever
    // lived: a stopped Ollama makes the proxy answer
    // Response(503, {"error": "proxy_localhost_stream_chunked: error sending
    // request ..."}), so the download card said "Failed to pull model" while the
    // real answer, that nothing is listening, went unread. Read it, and turn the
    // Rust line into a sentence rather than printing it (04.09.2026).
    const raw = (await res.text()).trim()
    throw new Error(
      isLocalTransportFailure(raw, url)
        ? localBackendUnreachableMessage("Ollama", url)
        : `Failed to pull model: HTTP ${res.status}${raw ? ` ${raw}` : ""}`,
    )
  }
  return res
}

/**
 * Tauri-only: stream a model pull via Rust command + events.
 * Events are tagged with model name so multiple concurrent pulls work.
 * Returns { promise, cancel } — cancel() stops both frontend + Rust backend.
 */
export function pullModelTauri(
  name: string,
  onProgress: (progress: PullProgress) => void,
): { promise: Promise<void>; cancel: () => void } {
  let cancelFn = () => {}

  const promise = (async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    const { listen } = await import("@tauri-apps/api/event")

    const unlisten = await listen<string>("pull-progress", (event) => {
      try {
        const envelope = JSON.parse(event.payload) as { model: string; data: PullProgress }
        // Only process events for THIS model
        if (envelope.model === name) {
          onProgress(envelope.data)
        }
      } catch { /* ignore parse errors */ }
    })

    cancelFn = () => {
      unlisten()
      // Also cancel the Rust-side download
      import("@tauri-apps/api/core").then(({ invoke: inv }) => {
        inv("cancel_model_pull", { name }).catch(() => {})
      })
    }

    try {
      await invoke("pull_model_stream", { name })
    } finally {
      unlisten()
    }
  })()

  return { promise, cancel: () => cancelFn() }
}

export async function deleteModel(name: string): Promise<void> {
  const res = await localFetch(ollamaUrl("/delete"), {
    method: "DELETE",
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error("Failed to delete model")
}

/** One model as /api/ps reports it. */
export interface LoadedOllamaModel {
  name: string
  /** Bytes the loaded model takes in total, weights and context together. 0 = not reported. */
  size: number
  /** How many of those bytes sit in graphics memory. */
  sizeVram: number
  /** The window Ollama loaded it with. 0 on a server that does not report it. */
  contextLength: number
}

/**
 * What /api/ps reports about every loaded model, or a throw when it cannot be
 * read.
 */
export async function readLoadedModels(signal?: AbortSignal): Promise<LoadedOllamaModel[]> {
  const res = await localFetch(ollamaUrl("/ps"), { signal, timeoutMs: 8000 })
  if (!res.ok) throw new Error(`Ollama did not report its loaded models (HTTP ${res.status}).`)
  const data: unknown = await res.json()
  return asRecordArray(prop(data, 'models'))
    .map((m) => ({
      name: asString(m.name) || asString(m.model) || '',
      size: asNumber(m.size) ?? 0,
      sizeVram: asNumber(m.size_vram) ?? 0,
      contextLength: asNumber(m.context_length) ?? 0,
    }))
    .filter((m) => !!m.name)
}

/**
 * The names /api/ps lists, or a throw when it cannot be read.
 *
 * For a caller that is about to SAY something about the state: "nothing is
 * loaded" and "Ollama did not answer" must not look the same to it.
 */
export async function readRunningModels(signal?: AbortSignal): Promise<string[]> {
  return (await readLoadedModels(signal)).map((m) => m.name)
}

/** The same list for a caller that only shows it: an unreadable list is an empty one. */
export async function listRunningModels(): Promise<string[]> {
  try {
    return await readRunningModels()
  } catch {
    return []
  }
}

/**
 * The loaded models a pending load of `name` is waiting behind, or none.
 *
 * Ollama lists a model in /api/ps from the moment its runner starts, so while
 * `name` itself is listed it is loading and waits for nobody. While it is not
 * listed and others are, Ollama is making room first, and it cannot evict a
 * model that is still answering: the load waits until that request ends.
 * /api/ps does not say which model is busy, so all of them are returned.
 */
export async function modelsAheadOfLoad(name: string, signal?: AbortSignal): Promise<string[]> {
  const running = await readRunningModels(signal)
  return running.includes(name) ? [] : running
}

// ── Model capabilities (/api/show) ────────────────────────────────
//
// Ollama reports a model's modalities/skills as a `capabilities` array
// (e.g. ['completion','vision','tools','thinking']). The chat-agent vision
// feedback loop needs to know whether the active model can actually SEE an
// image before it bothers attaching the generated picture. Cached per model
// (capabilities don't change at runtime) and soft-fails to [] so a probe
// failure never blocks a generation.
const _capCache = new Map<string, string[]>()

export async function getModelCapabilities(model: string): Promise<string[]> {
  if (!model) return []
  if (_capCache.has(model)) return _capCache.get(model)!
  try {
    const res = await localFetch(ollamaUrl("/show"), {
      method: "POST",
      body: JSON.stringify({ model }),
      timeoutMs: 8000,
    })
    if (!res.ok) { _capCache.set(model, []); return [] }
    const data: unknown = await res.json()
    const caps: string[] = asStringArray(prop(data, 'capabilities'))
    _capCache.set(model, caps)
    return caps
  } catch {
    _capCache.set(model, [])
    return []
  }
}

/** True when the model can take image input (multimodal/vision). */
export async function modelSupportsVision(model: string): Promise<boolean> {
  return (await getModelCapabilities(model)).includes("vision")
}

export interface ModelCapabilityCheck {
  name: string
  ok: boolean
  stale: boolean
  error?: string
}

/**
 * Probe a model's loadability without committing VRAM or touching the runner.
 *
 * Uses /api/show (metadata endpoint) rather than /api/generate or /api/chat:
 *
 *   - Empty-prompt /api/generate and empty-messages /api/chat both bail out
 *     BEFORE Ollama's capability check fires, so they return 200 even for
 *     stale manifests — useless as a probe.
 *   - A real-content /api/chat triggers the capability check, but also loads
 *     the model into VRAM (~7 s for a 3 B, minutes for a 14 B) even with
 *     num_predict:1 + keep_alive:0. Prohibitively expensive for a startup
 *     scan over N installed models.
 *   - /api/show returns 200 with full metadata (~200 ms) for valid manifests
 *     and 404 "model '<name>' not found" (~100 ms) for stale ones. No runner,
 *     no VRAM, fast enough to run on every cold start.
 *
 * parseOllamaError handles both the 404 "not found" path AND the legacy 400
 * "does not support chat/generate" path, so callers don't need to know which
 * endpoint produced the error.
 */
export async function checkModelCapability(
  name: string,
  signal?: AbortSignal
): Promise<ModelCapabilityCheck> {
  try {
    const res = await localFetch(ollamaUrl("/show"), {
      method: "POST",
      body: JSON.stringify({ model: name }),
      signal,
    })
    if (res.ok) {
      // Drain the body so the socket is released; the VERDICT is the status,
      // not the payload. A malformed body on a 200 changes nothing this
      // function reports, so there is nothing here to handle or to log.
      try { await res.json() } catch { /* body only drained, never read */ }
      return { name, ok: true, stale: false }
    }
    const { parseOllamaError, parseShowNotFound } = await import("../lib/ollama-errors")
    const parsed = await parseOllamaError(res, `HTTP ${res.status}`)
    // CALLER CONTRACT: only call this for models that are present in /api/tags.
    // Under that assumption:
    //   - "does not support …" (legacy 400) → stale
    //   - "model '<name>' not found" from /api/show → stale (manifest on disk,
    //     runtime refuses to parse it — the Ollama 0.20.7 signature)
    //   - Anything else → propagate as non-stale (transient/network).
    // The `parseShowNotFound` call finds the pattern whether the body arrived
    // as a direct 404 OR as a Rust-proxy-wrapped fake-500.
    const stale = parsed.kind === 'stale-manifest' || !!parseShowNotFound(parsed.raw)
    return {
      name,
      ok: false,
      stale,
      error: parsed.message,
    }
  } catch (e) {
    return { name, ok: false, stale: false, error: String(e) }
  }
}

/**
 * Probe every installed Ollama model. Excludes embedding models (not usable
 * for chat/generate anyway) so they don't skew the "stale" count.
 * Runs probes in parallel — Ollama queues internally and each probe is ~100ms.
 */
export async function scanInstalledModels(): Promise<ModelCapabilityCheck[]> {
  const models = await listModels()
  const probeable = models.filter(m => {
    const lower = m.name.toLowerCase()
    return !lower.includes('embed') && !lower.includes('bge-') && !lower.includes('nomic')
  })
  return Promise.all(probeable.map(m => checkModelCapability(m.name)))
}

/**
 * Load a model and wait until it is resident.
 *
 * The request carries the window this model was last sent, and the chat
 * window for a model that was sent nothing yet (`ollamaNumCtx`). Without it
 * Ollama loads the model at its own default and the first message loads it a
 * second time.
 *
 * Ollama holds this request for as long as it cannot make room: a model that
 * is still answering is not evicted. So the call has a limit and takes a
 * signal. Aborted by the caller it throws an AbortError; at the limit it
 * throws an `OllamaTimeoutError`. Either way the request is closed, and Ollama
 * drops a load whose client has gone.
 */
export async function loadModel(name: string, options?: OllamaCallOptions): Promise<void> {
  const limitMs = options?.timeoutMs ?? OLLAMA_LOAD_LIMIT_MS
  const limit = callLimit(limitMs, options?.signal)
  try {
    const window = await limit.race(ollamaWindowOption(name))
    const res = await localFetch(ollamaUrl("/generate"), {
      method: "POST",
      body: JSON.stringify({ model: name, prompt: "", stream: false, keep_alive: "10m", options: window }),
      signal: limit.signal,
      timeoutMs: limitMs + PROXY_SLACK_MS,
    })
    if (!res.ok) {
      const { parseOllamaError, ModelLoadError } = await import("../lib/ollama-errors")
      // Pass the active name in as fallbackModel — Bug C missing-blob errors
      // only carry the on-disk blob hash, not the model name.
      const parsed = await parseOllamaError(res, `HTTP ${res.status}`, name)
      log.warn(`[ollama] failed to load model "${name}"`, { status: res.status, message: parsed.message })
      throw new ModelLoadError(parsed, name)
    }
    // Consume response to ensure model is fully loaded.
    //
    // Reading the body IS the wait — Ollama answers /api/generate with
    // stream:false only once the weights are resident. So a body that fails to
    // arrive means "we stopped waiting", not "loaded". We still do not throw:
    // every caller treats loadModel as a warm-up (Header/ModelSelector warm the
    // picked model, vram-handoff documents its restore as explicitly non-fatal),
    // and turning a torn read into a user-facing error would be a behaviour
    // change none of them asked for. What was wrong was doing it in SILENCE:
    // the one case where "loaded" is a lie left no trace anywhere.
    try {
      await limit.race(res.json())
    } catch (e) {
      if (limit.signal.aborted) throw e
      log.warn(`[ollama] load of "${name}" returned but its body did not read back`, { err: e })
    }
  } catch (e) {
    if (limit.timedOut()) {
      log.warn(`[ollama] load of "${name}" ran into its limit of ${limitMs} ms`)
      throw new OllamaTimeoutError(`Loading ${name} took longer than ${Math.round(limitMs / 60_000)} minutes and was stopped.`)
    }
    throw e
  } finally {
    limit.clear()
  }
}

/**
 * Ask Ollama to unload a model (`keep_alive: 0`).
 *
 * A 200 here means "noted", not "gone": a model that is still answering stays
 * loaded until that request ends. Whoever reports the result to a person uses
 * `unloadModelAndLook` or `unloadAllModels`, which read /api/ps afterwards.
 */
export async function unloadModel(name: string, options?: OllamaCallOptions): Promise<void> {
  const limitMs = options?.timeoutMs ?? OLLAMA_UNLOAD_LIMIT_MS
  const limit = callLimit(limitMs, options?.signal)
  try {
    const res = await localFetch(ollamaUrl("/generate"), {
      method: "POST",
      body: JSON.stringify({ model: name, prompt: "", keep_alive: 0 }),
      signal: limit.signal,
      timeoutMs: limitMs + PROXY_SLACK_MS,
    })
    if (!res.ok) {
      const { parseOllamaError, ModelLoadError } = await import("../lib/ollama-errors")
      const parsed = await parseOllamaError(res, `HTTP ${res.status}`)
      log.warn(`[ollama] failed to unload model "${name}"`, { status: res.status, message: parsed.message })
      throw new ModelLoadError(parsed, name)
    }
  } catch (e) {
    if (limit.timedOut()) {
      log.warn(`[ollama] unload of "${name}" ran into its limit of ${limitMs} ms`)
      throw new OllamaTimeoutError(`Ollama did not answer the unload of ${name}.`)
    }
    throw e
  } finally {
    limit.clear()
  }
}

/**
 * Which of `names` are still in /api/ps once an unload had time to land.
 * Looks until none is left or `OLLAMA_UNLOAD_SETTLE_MS` is over.
 */
async function stillLoadedAfterUnload(names: string[], signal?: AbortSignal): Promise<string[]> {
  const deadline = Date.now() + OLLAMA_UNLOAD_SETTLE_MS
  for (;;) {
    const running = await readRunningModels(signal)
    const left = names.filter((name) => running.includes(name))
    if (left.length === 0 || Date.now() >= deadline) return left
    await new Promise((resolve) => setTimeout(resolve, UNLOAD_SETTLE_STEP_MS))
  }
}

/**
 * Unload one model and say what really happened: `unloaded` when it has left
 * /api/ps, `busy` when it is still there (it goes when its running request
 * ends). Throws when the unload or the look afterwards fails.
 */
export async function unloadModelAndLook(name: string, options?: OllamaCallOptions): Promise<"unloaded" | "busy"> {
  await unloadModel(name, options)
  return (await stillLoadedAfterUnload([name], options?.signal)).length === 0 ? "unloaded" : "busy"
}

export interface UnloadAllResult {
  /** Loaded before, gone from /api/ps now. */
  unloaded: string[]
  /** Ollama accepted the unload and the model is still in /api/ps: it is answering. */
  stillBusy: string[]
  /** Ollama refused or did not answer the unload, and the model is still in /api/ps. */
  failed: string[]
}

/**
 * Unload every loaded model and report which of them are really gone. Throws
 * when /api/ps cannot be read, before or after: then nothing true can be said.
 */
export async function unloadAllModels(options?: OllamaCallOptions): Promise<UnloadAllResult> {
  const running = await readRunningModels(options?.signal)
  const refused: string[] = []
  for (const name of running) {
    try {
      await unloadModel(name, options)
    } catch (e) {
      if (options?.signal?.aborted) throw e
      log.warn(`[ollama] unloadAll: failed for "${name}"`, { err: e })
      refused.push(name)
    }
  }
  if (running.length === 0) return { unloaded: [], stillBusy: [], failed: [] }
  const stillLoaded = await stillLoadedAfterUnload(running, options?.signal)
  return {
    unloaded: running.filter((name) => !stillLoaded.includes(name)),
    stillBusy: stillLoaded.filter((name) => !refused.includes(name)),
    failed: stillLoaded.filter((name) => refused.includes(name)),
  }
}

/**
 * Is Ollama answering.
 *
 * `timeoutMs` matters more than it looks. Without one the Rust proxy applies its
 * own default of 300000 ms, and the base URL is user-configurable, so a LAN host
 * that is switched off does not refuse the connection, it swallows it: the probe
 * sits there for five minutes. Anything on a UI path has to pass a short budget
 * (see EMBED_PROBE_TIMEOUT_MS). A timeout counts as "not reachable", which is
 * the honest reading, because a backend that cannot answer in three seconds
 * cannot serve an embedding request either.
 */
export async function checkConnection(timeoutMs?: number): Promise<boolean> {
  try {
    // The STATUS decides, not the absence of a throw. In the packaged app
    // localFetch does not throw when nothing answers: the proxy fails, the
    // direct fetch fails, and it hands back a synthetic `Response` with status
    // 500 carrying the error text (api/backend.ts). Awaiting it and returning
    // true therefore said "Ollama is there" on every machine without Ollama,
    // and every caller that trusted it walked into the next error instead
    // (Document Chat tried `ollama pull` against nothing).
    const res = await localFetch(ollamaUrl("/tags"), timeoutMs ? { timeoutMs } : undefined)
    return res.ok
  } catch {
    return false
  }
}
