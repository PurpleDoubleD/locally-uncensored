import type { OllamaModel, PullProgress } from "../types/models"
import { ollamaUrl, localFetch, localFetchStream, isTauri } from "./backend"
import { log } from "../lib/logger"

export async function listModels(): Promise<OllamaModel[]> {
  const res = await localFetch(ollamaUrl("/tags"))
  if (!res.ok) throw new Error("Failed to fetch models")
  const data = await res.json()
  return (data.models || []).map((m: any) => ({
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

export async function showModel(name: string) {
  const res = await localFetch(ollamaUrl("/show"), {
    method: "POST",
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error("Failed to show model")
  return res.json()
}

export async function getModelContext(name: string): Promise<number> {
  try {
    const info = await showModel(name)

    // Try model_info fields (various architectures use different keys)
    const modelInfo = info?.model_info || {}
    const contextFromInfo =
      modelInfo["general.context_length"] ||
      // Architecture-specific keys (gemma2.context_length, llama.context_length, etc.)
      Object.entries(modelInfo).find(([k]) => k.endsWith('.context_length'))?.[1]

    if (contextFromInfo && Number(contextFromInfo) > 0) {
      return Number(contextFromInfo)
    }

    // Try parameters (can be a string like "num_ctx 8192" or an object)
    const params = info?.parameters
    if (params) {
      if (typeof params === 'object' && params.num_ctx) {
        return Number(params.num_ctx)
      }
      if (typeof params === 'string') {
        const match = params.match(/num_ctx\s+(\d+)/)
        if (match) return Number(match[1])
      }
    }

    return 4096
  } catch {
    return 4096
  }
}

// Cached model-context lookup so the chat hooks can forward a correct num_ctx
// to Ollama on EVERY send without an /api/show round-trip each time. A model's
// trained context length doesn't change at runtime; cache lives for the session.
const _ctxCache = new Map<string, number>()
export async function getModelContextCached(name: string): Promise<number> {
  const hit = _ctxCache.get(name)
  if (hit !== undefined) return hit
  const v = await getModelContext(name)
  _ctxCache.set(name, v)
  return v
}

/**
 * Force Ollama to (re)load a model with a specific num_ctx RIGHT NOW, so a
 * context-window change from the dropdown takes effect immediately instead of
 * silently on the next chat. Ollama keys its loaded runner by num_ctx, so an
 * `/api/generate` with an empty prompt + `options.num_ctx` swaps the resident
 * KV cache to the new size; `keep_alive` keeps the reloaded model warm.
 * Best-effort — failures are swallowed (the next real chat still sends num_ctx).
 */
export async function warmupOllamaContext(model: string, numCtx: number): Promise<void> {
  if (!model || !numCtx || numCtx <= 0) return
  try {
    await localFetch(ollamaUrl("/generate"), {
      method: "POST",
      body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: "30m", options: { num_ctx: numCtx } }),
    })
  } catch { /* best-effort warmup — non-fatal */ }
}

export async function chatStream(
  model: string,
  messages: { role: string; content: string }[],
  options: { temperature?: number; top_p?: number; top_k?: number; num_predict?: number } = {},
  signal?: AbortSignal
): Promise<Response> {
  // v2.4.6 Bug L: dropped hardcoded `num_gpu: 99`. Old code forced ALL layers
  // onto the GPU regardless of free VRAM, which on 8 GB laptop cards (e.g.
  // 4070 laptop + gemma3:4b) pushed the KV cache out into system RAM and
  // dropped chat throughput from 30 tok/s (ollama CLI auto-detect) to 6.9
  // tok/s in LU (nightmare13740 Discord 2026-05-18). Letting Ollama do its
  // own layer/VRAM decision restores parity with the CLI on tight cards
  // and is a no-op on cards with headroom (Ollama already maxes layers
  // when it can fit them).
  const opts = { ...options }
  const res = await localFetchStream(ollamaUrl("/chat"), {
    method: "POST",
    body: JSON.stringify({ model, messages, options: opts, stream: true }),
  })
  if (!res.ok) throw new Error("Failed to start chat")
  return res
}

// Agent Mode: chat with tool calling support
export async function chatStreamWithTools(
  model: string,
  messages: { role: string; content: string; tool_calls?: any[] }[],
  tools: { type: string; function: { name: string; description: string; parameters: any } }[],
  options: { temperature?: number; top_p?: number; top_k?: number; num_predict?: number } = {},
  signal?: AbortSignal
): Promise<Response> {
  // v2.4.6 Bug L: see chatStream() above — same num_gpu:99 removal.
  const opts = { ...options }
  const res = await localFetchStream(ollamaUrl("/chat"), {
    method: "POST",
    body: JSON.stringify({ model, messages, tools, options: opts, stream: true }),
  })
  if (!res.ok) {
    // Try to extract Ollama's error message
    try {
      const errorData = await res.json()
      throw new Error(errorData.error || "Failed to start agent chat")
    } catch (e) {
      if (e instanceof Error && e.message !== "Failed to start agent chat") throw e
      throw new Error("Failed to start agent chat")
    }
  }
  return res
}

// Agent Mode: non-streaming tool call (more reliable for detecting tool calls)
export async function chatWithTools(
  model: string,
  messages: { role: string; content: string; tool_calls?: any[] }[],
  tools: { type: string; function: { name: string; description: string; parameters: any } }[],
  options: { temperature?: number; top_p?: number; top_k?: number; num_predict?: number } = {},
): Promise<{ content: string; tool_calls?: any[] }> {
  // v2.4.6 Bug L: see chatStream() above — same num_gpu:99 removal.
  const res = await localFetch(ollamaUrl("/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools, options: { ...options }, stream: false }),
  })
  if (!res.ok) {
    try {
      const errorData = await res.json()
      throw new Error(errorData.error || "Failed to start agent chat")
    } catch (e) {
      if (e instanceof Error && e.message !== "Failed to start agent chat") throw e
      throw new Error("Failed to start agent chat")
    }
  }
  const data = await res.json()
  return {
    content: data.message?.content || '',
    tool_calls: data.message?.tool_calls,
  }
}

export async function pullModel(name: string, signal?: AbortSignal): Promise<Response> {
  const res = await localFetchStream(isTauri() ? ollamaUrl("/pull") : "/api/pull", {
    method: "POST",
    body: JSON.stringify({ name, stream: true }),
    signal,
  })
  if (!res.ok) throw new Error("Failed to pull model")
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

export async function listRunningModels(): Promise<string[]> {
  try {
    const res = await localFetch(ollamaUrl("/ps"))
    if (!res.ok) return []
    const data = await res.json()
    return (data.models || []).map((m: any) => m.name || m.model)
  } catch {
    return []
  }
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
    const data = await res.json()
    const caps: string[] = Array.isArray(data?.capabilities) ? data.capabilities : []
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
      try { await res.json() } catch {}
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

export async function loadModel(name: string, numCtx?: number): Promise<void> {
  const options = typeof numCtx === 'number' && numCtx > 0 ? { num_ctx: numCtx } : undefined
  const res = await localFetch(ollamaUrl("/generate"), {
    method: "POST",
    body: JSON.stringify({ model: name, prompt: "", stream: false, keep_alive: "10m", ...(options ? { options } : {}) }),
  })
  if (!res.ok) {
    const { parseOllamaError, ModelLoadError } = await import("../lib/ollama-errors")
    // Pass the active name in as fallbackModel — Bug C missing-blob errors
    // only carry the on-disk blob hash, not the model name.
    const parsed = await parseOllamaError(res, `HTTP ${res.status}`, name)
    log.warn(`[ollama] failed to load model "${name}"`, { status: res.status, message: parsed.message })
    throw new ModelLoadError(parsed, name)
  }
  // Consume response to ensure model is fully loaded
  try { await res.json() } catch {}
}

export async function unloadModel(name: string): Promise<void> {
  const res = await localFetch(ollamaUrl("/generate"), {
    method: "POST",
    body: JSON.stringify({ model: name, prompt: "", keep_alive: 0 }),
  })
  if (!res.ok) {
    const { parseOllamaError, ModelLoadError } = await import("../lib/ollama-errors")
    const parsed = await parseOllamaError(res, `HTTP ${res.status}`)
    log.warn(`[ollama] failed to unload model "${name}"`, { status: res.status, message: parsed.message })
    throw new ModelLoadError(parsed, name)
  }
}

export async function unloadAllModels(): Promise<number> {
  const running = await listRunningModels()
  for (const name of running) {
    try { await unloadModel(name) } catch (e) { log.warn(`[ollama] unloadAll: failed for "${name}"`, { err: e }) }
  }
  return running.length
}

export async function checkConnection(): Promise<boolean> {
  try {
    await localFetch(ollamaUrl("/tags"))
    return true
  } catch {
    return false
  }
}
