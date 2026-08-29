/**
 * Self-heal for the managed built-in engine (llama-server on 127.0.0.1:8127).
 *
 * The Create tab and the music/video lanes call `offload_local_models` before
 * a render to free VRAM, which STOPS the bundled chat engine — by design, with
 * the promise that it "reloads lazily on the next message". This module is
 * that lazy reload: the OpenAI provider calls it right before a send when its
 * slot is the app-managed engine (`config.managed === true`). Without it the
 * first message after a render hits a dead port, and to the user the whole
 * backend looks crashed until an app restart (RTX 5080 field report: use
 * Create/ACE-Step once → chat dead until relaunch).
 *
 * Deliberately imports only `backend` + the provider store so it can sit
 * below `api/providers` without an import cycle.
 */

import { backendCall } from './backend'
import { useProviderStore } from '../stores/providerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { AGENT_CONTEXT_CAP } from '../lib/context-window'

interface EngineStatusLite {
  running: boolean
  healthy: boolean
  /** The `--ctx-size` the chat engine was started with (ENG-3). */
  ctx?: number | null
}

interface BundledList {
  models?: Array<{ name: string; path: string; ctx_train?: number | null }>
}

// Coalesce concurrent sends (chat + title generation) into ONE health-check /
// restart. start_bundled_engine blocks until /health is green, so awaiting the
// same promise is exactly "wait for the restart the other call kicked off".
let inflight: Promise<void> | null = null

/**
 * Rewrite a transport failure against our own engine into something a user can
 * act on. The Rust proxy reports a refused connection verbatim
 * ("proxy_localhost_stream_chunked: error sending request for url
 * (http://127.0.0.1:8127/v1/chat/completions)"), which reads like the app is
 * broken rather than like the engine is down. Only touches errors that never
 * reached an HTTP response — a real status code carries the server's own words
 * and must survive untouched.
 */
export function explainDeadEngine(err: unknown, baseUrl: string): unknown {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  const host = baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const isTransport = /error sending request|connection refused|failed to fetch|ECONNREFUSED|tcp connect/i.test(msg)
  if (!isTransport || !msg.includes(host.split(':')[0])) return err
  return new Error(
    `The built-in engine is not answering on ${host}. It either failed to start or was shut down. Open Settings, AI Backends, Built-in Engine and start it again, or pick a different backend. Original error: ${msg}`,
  )
}

/** True when the `openai` slot is the app-managed built-in engine. */
export function isManagedBuiltinSlot(): boolean {
  const cfg = useProviderStore.getState().providers.openai
  return !!cfg?.enabled && cfg.managed === true
}

/**
 * Make sure the built-in engine is up before a send. No-op when the slot is
 * not managed, the engine is already healthy, or `modelName` is not a bundled
 * GGUF (nothing we own to heal). Throws only when an actual restart attempt
 * fails — that error carries llama-server's stderr tail and IS the honest
 * thing to show in the chat instead of a bare "fetch failed".
 */
export async function ensureBuiltinEngineAlive(modelName: string): Promise<void> {
  if (!isManagedBuiltinSlot()) return
  if (inflight) return inflight
  inflight = (async () => {
    try {
      let status: EngineStatusLite | null
      try {
        status = await backendCall<EngineStatusLite>('bundled_engine_status')
      } catch {
        return // non-Tauri context (tests/browser) — nothing to manage
      }
      if (status?.healthy) return

      let models: Array<{ name: string; path: string }>
      try {
        const res = await backendCall<BundledList>('list_bundled_models')
        models = res?.models ?? []
      } catch {
        return
      }
      const bare = modelName.includes('::') ? modelName.split('::')[1] : modelName
      const hit = models.find((m) => m.name === bare)
      if (!hit) {
        // The slot IS our engine (managed), the engine is NOT healthy, and the
        // model the picker is holding is not on disk where the engine looks.
        // Returning quietly here sent the send straight into a dead port, and
        // the user got "proxy_localhost_stream_chunked: error sending request
        // for url (http://127.0.0.1:8127/v1/chat/completions)" as their first
        // impression of the app (applejames, Discord 2026-08-01, fresh install
        // on Windows 10 — they gave up on the built-in engine and moved to
        // Ollama). Say what is actually wrong instead.
        throw new Error(
          `The built-in engine has no model file named "${bare}". It may have been deleted, moved, or the download did not finish. Open Models, install it again, then pick it in the chat.`,
        )
      }

      // Restart with the user's expert tuning, not bare defaults — otherwise a
      // self-heal would silently drop a configured ctx/KV-quant until the next
      // manual model pick.
      const tuning = useSettingsStore.getState().settings.builtinEngine
      await backendCall('start_bundled_engine', { modelPath: hit.path, tuning })
    } finally {
      inflight = null
    }
  })()
  return inflight
}

// The default the engine ships with. A settings ctx equal to it is treated as
// "never touched", anything else as an explicit user choice that wins in both
// directions (see ensureBuiltinAgentCtx below).
const ENGINE_DEFAULT_CTX = 8192

// Models whose raise attempt failed once (path -> refused ctx). Without this
// a card that cannot allocate the bigger KV cache would retry the failing
// restart on every single agent turn.
const refusedCtxByPath = new Map<string, number>()

/** Test-only: forget refused raises so unit tests stay isolated. */
export function __resetAgentCtxStateForTests(): void {
  refusedCtxByPath.clear()
}

/**
 * Z36 finding 2 (W3 run 2026-08-16): an agent turn carries the full tool
 * catalogue and routinely outgrows the engine's 8192 default, while the GGUF
 * itself was trained for far more (ctx_train 32k live). llama-server's ctx is
 * a START-time flag, so unlike Ollama's per-request num_ctx somebody has to
 * restart the engine bigger, and nobody did: the prompt silently overflowed.
 *
 * This raises the managed built-in engine to the same ceiling the Ollama
 * agent path already uses: min(ctx_train, AGENT_CONTEXT_CAP), floored at the
 * 8192 default. It only ever raises, never shrinks, and only when the GGUF
 * header states the model can take it (no RoPE extrapolation on a guess).
 * A user-set engine ctx (anything other than the untouched 8192 default) or
 * a contextWindowOverride wins outright, matching resolveAgentNumCtx.
 *
 * When the raise attempt fails (a small card may not fit the bigger KV
 * cache), the engine is restarted with the previous tuning so chat survives,
 * and the (path, ctx) pair is remembered so we never retry-loop. Never
 * throws: an agent run must start even when none of this works.
 */
export async function ensureBuiltinAgentCtx(modelName: string): Promise<void> {
  if (!isManagedBuiltinSlot()) return
  const settings = useSettingsStore.getState().settings
  const tuning = settings.builtinEngine as (typeof settings.builtinEngine) | undefined
  if (tuning && typeof tuning.ctx === 'number' && tuning.ctx > 0 && tuning.ctx !== ENGINE_DEFAULT_CTX) {
    return // explicit expert choice, do not second-guess it
  }

  let status: EngineStatusLite | null
  try {
    status = await backendCall<EngineStatusLite>('bundled_engine_status')
  } catch {
    return // non-Tauri context (tests/browser)
  }

  let models: Array<{ name: string; path: string; ctx_train?: number | null }>
  try {
    const res = await backendCall<BundledList>('list_bundled_models')
    models = res?.models ?? []
  } catch {
    return
  }
  const bare = modelName.includes('::') ? modelName.split('::')[1] : modelName
  const hit = models.find((m) => m.name === bare)
  if (!hit) return

  const override = settings.contextWindowOverride
  let want = 0
  if (typeof override === 'number' && override > 0) {
    want = override
  } else if (typeof hit.ctx_train === 'number' && hit.ctx_train > 0) {
    want = Math.max(ENGINE_DEFAULT_CTX, Math.min(hit.ctx_train, AGENT_CONTEXT_CAP))
  } else {
    return // the GGUF does not state a trained context, never raise on a guess
  }

  if (refusedCtxByPath.get(hit.path) === want) return
  const current = status?.running && typeof status.ctx === 'number' && status.ctx > 0 ? status.ctx : 0
  if (current >= want) return

  const raised = { ...(tuning ?? {}), ctx: want }
  try {
    await backendCall(status?.running ? 'swap_bundled_model' : 'start_bundled_engine', {
      modelPath: hit.path,
      tuning: raised,
    })
  } catch {
    refusedCtxByPath.set(hit.path, want)
    // Fall back to the previous tuning so the chat engine is not left dead.
    try {
      await backendCall('start_bundled_engine', { modelPath: hit.path, tuning })
    } catch { /* the lazy self-heal on the next send takes over */ }
  }
}

// ── "Why is the built-in engine not answering?" ──────────────────────────────

export interface BuiltinEngineDiagnosis {
  /** The engine answers /v1 on its port right now. */
  ok: boolean
  /** English, user-facing, empty when `ok` or when this slot is not ours. */
  reason: string
  /** True when this diagnosis actually started the engine. */
  repaired: boolean
}

const OK: BuiltinEngineDiagnosis = { ok: true, reason: '', repaired: false }
const NOT_OURS: BuiltinEngineDiagnosis = { ok: false, reason: '', repaired: false }

/**
 * GH #118 (nayffy, 2026-08-27): the Built-in Engine test in Settings, AI
 * Backends answered with nothing but a red dot while the console carried
 * `GET http://127.0.0.1:8127/v1/models net::ERR_CONNECTION_REFUSED`. A refused
 * connection to a server the app owns is not a verdict, it is a question the
 * app can answer itself, so this asks it: is the engine up, is there a model
 * to run at all, and does a start attempt succeed. House rule is self-healing
 * before an error message, so with `repair` the obvious repair (start the
 * engine on an installed GGUF) is attempted before anything is reported.
 *
 * Never throws. A missing Tauri backend (browser/dev) reports `NOT_OURS`, so
 * the caller keeps whatever it did before.
 */
export async function diagnoseBuiltinEngine(
  opts: { repair?: boolean; preferModel?: string | null } = {},
): Promise<BuiltinEngineDiagnosis> {
  if (!isManagedBuiltinSlot()) return NOT_OURS

  let status: EngineStatusLite | null
  try {
    status = await backendCall<EngineStatusLite>('bundled_engine_status')
  } catch {
    return NOT_OURS
  }
  if (status?.healthy) return OK

  let models: Array<{ name: string; path: string }>
  try {
    const res = await backendCall<BundledList>('list_bundled_models')
    models = res?.models ?? []
  } catch (e) {
    return {
      ok: false,
      repaired: false,
      reason: `The built-in engine is not running and its model folder could not be read: ${errText(e)}`,
    }
  }

  const runnable = models.filter((m) => !isEmbeddingGguf(m.name))
  if (runnable.length === 0) {
    return {
      ok: false,
      repaired: false,
      reason:
        'The built-in engine is installed but has no chat model to load yet. Open Models, Discover and install one, then test again.',
    }
  }

  if (!opts.repair) {
    return {
      ok: false,
      repaired: false,
      reason: `The built-in engine is not running. ${runnable.length} model${runnable.length === 1 ? ' is' : 's are'} installed. Pick one in the chat model picker to start the engine.`,
    }
  }

  const bare = opts.preferModel
    ? opts.preferModel.includes('::')
      ? opts.preferModel.split('::')[1]
      : opts.preferModel
    : ''
  const pick = runnable.find((m) => m.name === bare) ?? runnable[0]
  try {
    const tuning = useSettingsStore.getState().settings.builtinEngine
    await backendCall('start_bundled_engine', { modelPath: pick.path, tuning })
    return { ok: true, reason: '', repaired: true }
  } catch (e) {
    return {
      ok: false,
      repaired: false,
      reason: `The built-in engine could not start "${pick.name}": ${errText(e)}`,
    }
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? 'unknown error')
}

// Duplicated from api/engine.ts on purpose: importing it would pull the
// provider/model layer into this module and reintroduce the import cycle the
// header warns about. Two patterns, one meaning, both covered by tests.
const EMBED_NAME_PATTERNS = [/embed/, /nomic-embed/, /bge-/, /e5-/, /gte-/, /sentence-/]
function isEmbeddingGguf(name: string): boolean {
  const lower = name.toLowerCase()
  return EMBED_NAME_PATTERNS.some((p) => p.test(lower))
}
