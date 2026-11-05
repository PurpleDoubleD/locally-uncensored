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
import { trackEngineSwap, waitForEngineSwap } from './engine-swap-gate'
import { log } from '../lib/logger'
import { platformText } from '../lib/platform-text'
import { useProviderStore } from '../stores/providerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { builtinSlotStatus, type SlotStatus } from '../lib/builtin-slot-status'
import { baseUrlNeedingEnginePort } from '../lib/engine-port'
import { AGENT_CONTEXT_CAP } from '../lib/context-window'
import { ENGINE_DEFAULT_CTX, preservedSwapCtx } from '../lib/builtin-ctx'
import {
  bareBuiltinModelName,
  builtinModelMatches,
  builtinModelMismatchMessage,
  builtinModelNameFromPath,
} from '../lib/builtin-model-identity'
import { hostOf, isLocalTransportFailure } from '../lib/local-backend-transport'
import { announceEngineCpuFallback } from '../lib/engine-offload'
import { customModelDirs } from '../lib/custom-model-dirs'
import { singleModelSlot } from '../lib/capabilities'
import { claimSlotForChatLoad, getMobileContextCap } from '../lib/model-slot'
import { clampContextWindow } from '../lib/number-limits'

interface EngineStatusLite {
  running: boolean
  healthy: boolean
  /** The `--ctx-size` the chat engine was started with (ENG-3). */
  ctx?: number | null
  /** The context that start ASKED for (3.0.8, A25). A context nobody chose
   *  is the VRAM plan's to pick: `ctx` can be more (the card had room) or
   *  less (the asked one would have cost layers) than this. */
  ctxRequested?: number | null
  /** Absolute path of the GGUF the engine was started with, null when it is
   *  not running. The ONLY honest answer to "which model is loaded": the
   *  `model` field of a request is a label llama-server ignores. */
  model_path?: string | null
  /** Which port it really holds, and whether the app had to drop GPU offload
   *  to get it serving. Both only so the fallback note below can be said from
   *  the send path, which is the only status read the chat ever makes. */
  port?: number | null
  cpuOnly?: boolean
}

interface BundledList {
  models?: Array<{ name: string; path: string; ctx_train?: number | null }>
}

/** The GGUFs the engine can be started on: the app models dir AND the folder
 *  named under Storage, exactly the set the picker lists.
 *
 *  Discord 2026-10-01 (3.0.3, RTX 4090): a group chat of two models
 *  from that folder answered with the loaded one only. The other speaker got
 *  "The LU Engine has X loaded, but this request asked for Y", because the
 *  lookup here walked the app dir alone, found no Y, and called a model the
 *  picker had just offered a missing file. */
function listEngineModels(): Promise<BundledList> {
  return backendCall<BundledList>('list_bundled_models', { extraDirs: customModelDirs() })
}

/** What `start_bundled_engine` / `swap_bundled_model` answer. `port` is the
 *  port the engine ACTUALLY came up on, which since GH #118 need not be the
 *  preferred one. */
interface EngineStartResult {
  status?: string
  port?: number
}

// Coalesce concurrent sends (chat + title generation) into ONE health-check /
// restart. start_bundled_engine blocks until /health is green, so awaiting the
// same promise is exactly "wait for the restart the other call kicked off".
//
// Keyed by model since 2.6.7: the call can now SWAP the loaded model, and a
// second caller asking for a different model must not be handed the first
// caller's promise and told the engine is ready. Same model rides along, a
// different model waits its turn and then runs its own check.
let inflight: { key: string; promise: Promise<void> } | null = null

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
  const friendly = explainEngineTransportMessage(msg, baseUrl)
  return friendly ? new Error(friendly) : err
}

/**
 * The same translation for a message that arrived as a RESPONSE BODY rather
 * than as a thrown error, which is the shape the counter-check actually hit.
 *
 * `localFetchStream` does not reject when the Rust proxy cannot reach the
 * engine: it hands back `Response(503, {"error": "proxy_localhost_stream_chunked:
 * error sending request for url (http://127.0.0.1:8127/v1/chat/completions)"})`.
 * So `sendOrExplain` never saw a throw, `parseError` lifted the body verbatim,
 * and the user read an internal Rust command name in their chat bubble.
 *
 * Returns the replacement text, or null when the message is not a transport
 * failure against this engine (a real HTTP status carries the server's own
 * words and must survive untouched). The raw text is not appended: it names a
 * Rust function and a port, which tells the user nothing they can act on.
 */
export function explainEngineTransportMessage(message: string, baseUrl: string): string | null {
  const msg = String(message ?? '')
  const host = hostOf(baseUrl)
  if (!isLocalTransportFailure(msg, baseUrl)) return null
  // The raw line still exists for a bug report, it just lives in the app log
  // now instead of in the chat bubble. House rule: no raw Rust error in front
  // of a user.
  log.warn('[builtin-engine] transport failure hidden behind a plain sentence', { raw: msg, host })
  return platformText('engineNotAnswering', { host })
}

/** True when the `openai` slot is the app-managed built-in engine. */
export function isManagedBuiltinSlot(): boolean {
  const cfg = useProviderStore.getState().providers.openai
  return !!cfg?.enabled && cfg.managed === true
}

/**
 * The built-in slot exists, but the user turned it off in Settings.
 *
 * This is the second half of `isManagedBuiltinSlot`, and it matters because the
 * two false cases mean opposite things. A slot that is not managed at all is
 * someone else's endpoint and we have nothing to say about it. A managed slot
 * that is switched off is our engine, deliberately stopped, and a send aimed at
 * it can only fail. Saying so beats letting the request run into a dead port
 * and explaining the wreck afterwards.
 */
export function builtinSlotSwitchedOff(): boolean {
  const cfg = useProviderStore.getState().providers.openai
  return !!cfg && cfg.managed === true && !cfg.enabled
}

/** What the chat says when the send was aimed at a switched-off engine. */
export const BUILTIN_SLOT_OFF_MESSAGE = platformText('engineSwitchedOff')

/**
 * Point the managed slot at the port the engine really came up on.
 *
 * GH #118: the Rust side may now take the next free port when 8127 is held, so
 * the one place that knows the answer is the start/status result. Without this
 * the slot would keep asking 8127 and the user would get a refused connection
 * to a healthy engine, which is the ticket's symptom with a different cause.
 *
 * Only the app's OWN managed slot on a loopback URL is ever touched, and only
 * when the port really differs. Never throws: a slot that cannot be updated is
 * not a reason to fail a start.
 */
export function syncBuiltinEnginePort(port: unknown): void {
  try {
    const store = useProviderStore.getState()
    const cfg = store.providers.openai
    if (!cfg?.enabled || cfg.managed !== true) return
    const next = baseUrlNeedingEnginePort(cfg.baseUrl, port)
    if (!next) return
    log.info('[builtin-engine] the engine moved port, the slot follows', { from: cfg.baseUrl, to: next })
    store.setProviderConfig('openai', { baseUrl: next })
  } catch (err) {
    log.warn('[builtin-engine] could not follow the engine port', { err })
  }
}

/**
 * Is the engine about to answer with the wrong model.
 *
 * Answers the question `ensureBuiltinEngineAlive` acts on, without acting:
 * null when nothing has to happen, otherwise the bare id that has to be loaded
 * first. The group round asks this so it can put a loading line in the bubble
 * BEFORE it waits, because a swap stops and restarts llama-server and a large
 * GGUF takes long enough that a silent wait reads as a hang.
 *
 * Never throws and never changes anything.
 */
export async function builtinReloadNeeded(modelName: string): Promise<string | null> {
  if (!isManagedBuiltinSlot()) return null
  // A model from another provider slot travels through its own provider and
  // has nothing to do with our engine.
  const parts = modelName.split('::')
  if (parts.length === 2 && parts[0] !== 'openai') return null
  const bare = bareBuiltinModelName(modelName)
  if (!bare) return null
  try {
    const status = await backendCall<EngineStatusLite>('bundled_engine_status')
    if (!status?.healthy) return bare
    return builtinModelMatches(status.model_path, bare) ? null : bare
  } catch {
    return null // non-Tauri context (tests/browser), nothing to manage
  }
}

/**
 * Make sure the built-in engine is up AND holding `modelName` before a send.
 * No-op when the slot is not managed or the engine already has that exact
 * model. Throws only when an actual start/swap attempt fails, and that error
 * carries llama-server's stderr tail and IS the honest thing to show in the
 * chat instead of a bare "fetch failed".
 *
 * The model half is new in 2.6.7 and is the app-side cure for the counter-check
 * finding: llama-server answers whatever it holds, whatever the `model` field
 * says, so "the engine is healthy" was never enough to send.
 */
export async function ensureBuiltinEngineAlive(modelName: string): Promise<void> {
  // Switched off by hand: nothing here may start it again, and nothing may let
  // the send through either. Without this the request went to the dead port,
  // the proxy failure lost its race against the stream's end marker, and the
  // chat blamed the user's network for a switch the user had flipped
  // (counter-check P1, 2026-09-04).
  if (builtinSlotSwitchedOff()) throw new Error(BUILTIN_SLOT_OFF_MESSAGE)
  if (!isManagedBuiltinSlot()) return
  // One model slot: while a document is being read the chat model stays out
  // (lib/model-slot.ts). Loading it now would put it next to the document
  // model, and the reading would unload it again under the answer. Resolves
  // at once on a desktop and whenever the slot is free.
  //
  // The engine gives a load 120 seconds. That limit starts when the engine is
  // asked, which is below this line: a send that waits a minute for a long
  // document spends none of it (acceptance Android 8 GB, B4). From here to
  // the end of the load a reading does not start either (claimSlotForChatLoad).
  const loadDone = singleModelSlot() ? await claimSlotForChatLoad() : null
  try {
    await ensureWithSlot(modelName)
  } finally {
    loadDone?.()
  }
}

/** `ensureBuiltinEngineAlive` once the slot is this caller's. */
async function ensureWithSlot(modelName: string): Promise<void> {
  // Self-heal before an error message: a swap the app itself started is still
  // tearing down and restarting llama-server, and a send fired into that gap
  // is a guaranteed transport failure. Wait it out, then probe. The wait has a
  // deadline so a wedged swap can never hold a send forever; past it the
  // health check below decides what happens and says so in English.
  // (Counter-check round 2, 2026-08-29: two picks in a row, then send.)
  await waitForEngineSwap()
  const key = bareBuiltinModelName(modelName)
  if (inflight && inflight.key === key) return inflight.promise
  const earlier = inflight?.promise
  const run = (async () => {
    // A swap for another model is already running: let it finish rather than
    // fight it for the one engine process. Its failure is its own caller's to
    // report, so it is swallowed here.
    if (earlier) await earlier.catch(() => undefined)
    await loadBuiltinModel(modelName)
  })()
  inflight = { key, promise: run }
  try {
    await run
  } finally {
    if (inflight?.promise === run) inflight = null
  }
}

/** The body of `ensureBuiltinEngineAlive`, minus the coalescing. */
async function loadBuiltinModel(modelName: string): Promise<void> {
  let status: EngineStatusLite | null
  try {
    status = await backendCall<EngineStatusLite>('bundled_engine_status')
  } catch {
    return // non-Tauri context (tests/browser) — nothing to manage
  }
  // The chat draws the standing line and never polls the engine, so this is
  // the one read on that side of the app. Says nothing when there is nothing
  // to say, and nothing twice about the same engine (lib/engine-offload).
  announceEngineCpuFallback(status)
  // Healthy AND holding what the caller wants: the only case that may skip
  // out. An engine whose status carries no model_path cannot be judged, so it
  // counts as a match and the send proceeds exactly as it did before.
  const rightModel = builtinModelMatches(status?.model_path, modelName)
  if (status?.healthy && rightModel) return

  let models: Array<{ name: string; path: string; ctx_train?: number | null }>
  try {
    const res = await listEngineModels()
    models = res?.models ?? []
  } catch {
    return
  }
  const bare = bareBuiltinModelName(modelName)
  const hit = models.find((m) => m.name === bare)
  if (!hit && status?.healthy) {
    // The engine runs, it holds something else, and the model the caller named
    // is not on disk. Loading it is impossible, and letting the send through
    // would hand the user another model's answer under this model's name.
    // Say which is which instead.
    throw new Error(builtinModelMismatchMessage(builtinModelNameFromPath(status.model_path), bare))
  }
  if (!hit) {
    // The slot IS our engine (managed), the engine is NOT healthy, and the
    // model the picker is holding is not on disk where the engine looks.
    // Returning quietly here sent the send straight into a dead port, and
    // the user got "proxy_localhost_stream_chunked: error sending request
    // for url (http://127.0.0.1:8127/v1/chat/completions)" as their first
    // impression of the app (Discord 2026-08-01, fresh install
    // on Windows 10 — they gave up on the built-in engine and moved to
    // Ollama). Say what is actually wrong instead.
    throw new Error(
      platformText('engineModelFileMissing', { name: bare }),
    )
  }

  // Restart with the user's expert tuning, not bare defaults — otherwise a
  // self-heal would silently drop a configured ctx/KV-quant until the next
  // manual model pick.
  const settingsTuning = useSettingsStore.getState().settings.builtinEngine
  // ... and do not hand back context the engine already holds. A group round
  // restarts the engine before every speaker; with the raw 8192 default in the
  // tuning that shrank a 32K engine to 8K on each swap while the header still
  // promised 32K (counter-check round 2, 2026-08-29). See lib/builtin-ctx.ts.
  const keepCtx = preservedSwapCtx({
    tuningCtx: settingsTuning?.ctx,
    tuningChosen: settingsTuning?.ctxChosen,
    // What the running engine was asked for, not what the plan gave it: a
    // context the plan raised because one model's card had room is no
    // promise for the next model (3.0.8, A25).
    currentCtx: status?.ctxRequested ?? status?.ctx,
    ctxTrain: hit.ctx_train,
  })
  const tuning = keepCtx ? { ...(settingsTuning ?? {}), ctx: keepCtx } : settingsTuning
  // A running engine holding the WRONG model is a swap (stop, then start on
  // the same port). Everything else is a plain start, which is idempotent for
  // the same model and tuning, so an engine that is merely still warming up is
  // never torn down and restarted for nothing.
  const cmd = status?.running && !rightModel ? 'swap_bundled_model' : 'start_bundled_engine'
  syncBuiltinEnginePort(
    (await trackEngineSwap(backendCall<EngineStartResult>(cmd, { modelPath: hit.path, tuning })))?.port,
  )
  // The engine is a different process with a different ctx now. Tell the
  // header and the token counter to re-read it, so the number on screen is the
  // one llama-server actually started with even when the raise above was
  // refused or skipped. Second half of the same finding: the display must not
  // be able to lie, whatever the swap ended up asking for.
  announceContextReload()
}

/** Ask every context consumer to re-read the engine. No-op outside a DOM. */
function announceContextReload(): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new Event('lu-context-reloaded'))
    }
  } catch { /* a missing DOM is not a reason to fail a send */ }
}

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
  // A phone raises only as far as the injected cap allows, and not at all
  // until the shell has set one (lib/model-slot.ts, setMobileContextCap).
  const mobileCap = singleModelSlot() ? getMobileContextCap() : null
  if (mobileCap !== null && mobileCap <= 0) return
  const settings = useSettingsStore.getState().settings
  const tuning = settings.builtinEngine as (typeof settings.builtinEngine) | undefined
  // GH #129: die Marke zuerst. Ohne sie war "Nutzer hat 8K gewaehlt" von "nie
  // angefasst" nicht zu unterscheiden, und der Deckel hob den Motor auf
  // min(ctx_train, 32768) gegen den ausdruecklichen Wunsch. Jede andere Zahl
  // war schon vorher eine Entscheidung.
  if (tuning && typeof tuning.ctx === 'number' && tuning.ctx > 0 &&
      (tuning.ctxChosen === true || tuning.ctx !== ENGINE_DEFAULT_CTX)) {
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
    const res = await listEngineModels()
    models = res?.models ?? []
  } catch {
    return
  }
  const bare = modelName.includes('::') ? modelName.split('::')[1] : modelName
  const hit = models.find((m) => m.name === bare)
  if (!hit) return

  // Clamped (B13), the same bound the Settings field and set_setting use.
  const override = clampContextWindow(settings.contextWindowOverride)
  let want = 0
  if (override > 0) {
    want = override
  } else if (typeof hit.ctx_train === 'number' && hit.ctx_train > 0) {
    want = Math.max(ENGINE_DEFAULT_CTX, Math.min(hit.ctx_train, AGENT_CONTEXT_CAP))
  } else {
    return // the GGUF does not state a trained context, never raise on a guess
  }
  // On a phone the cap wins over everything above, the user's override and
  // the 8192 floor included: it is what the device can hold, not a preference.
  if (mobileCap !== null) want = Math.min(want, mobileCap)

  if (refusedCtxByPath.get(hit.path) === want) return
  const current = status?.running && typeof status.ctx === 'number' && status.ctx > 0 ? status.ctx : 0
  if (current >= want) return
  // Asked for already: the plan answered with less because the full raise
  // would have cost layers on the card (3.0.8, A25). Asking again would
  // restart the engine on every turn for the same answer.
  if (status?.running && typeof status.ctxRequested === 'number' && status.ctxRequested >= want) return

  const raised = { ...(tuning ?? {}), ctx: want }
  try {
    // S2: this restart moves the engine like any other, so the slot has to be
    // told. Without it an agent run that raised the context could leave the
    // slot pointing at the port the engine had before a fallback.
    syncBuiltinEnginePort(
      (await trackEngineSwap(
        backendCall<EngineStartResult>(
          status?.running ? 'swap_bundled_model' : 'start_bundled_engine',
          { modelPath: hit.path, tuning: raised },
        ),
      ))?.port,
    )
    announceContextReload()
  } catch {
    refusedCtxByPath.set(hit.path, want)
    // Fall back to the previous tuning so the chat engine is not left dead.
    try {
      syncBuiltinEnginePort(
        (await trackEngineSwap(
          backendCall<EngineStartResult>('start_bundled_engine', { modelPath: hit.path, tuning }),
        ))?.port,
      )
      announceContextReload()
    } catch { /* the lazy self-heal on the next send takes over */ }
  }
}

// ── What the AI Backends row may say before anyone probed ────────────────────

/** Ask the app about its own engine, without a socket.
 *
 *  Returns null when this slot is not the managed built-in engine, when the
 *  backend command is unavailable (browser/dev), or when the answer does not
 *  settle the question. The caller then probes as it always did. */
export async function readBuiltinSlotStatus(): Promise<SlotStatus | null> {
  if (!isManagedBuiltinSlot()) return null
  try {
    return builtinSlotStatus(await backendCall<EngineStatusLite>('bundled_engine_status'))
  } catch {
    return null
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
 * GH #118 (2026-08-27): the Built-in Engine test in Settings, AI
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
    const res = await listEngineModels()
    models = res?.models ?? []
  } catch (e) {
    return {
      ok: false,
      repaired: false,
      reason: `The LU Engine is not running and its model folder could not be read: ${errText(e)}`,
    }
  }

  const runnable = models.filter((m) => !isEmbeddingGguf(m.name))
  if (runnable.length === 0) {
    return {
      ok: false,
      repaired: false,
      reason:
        platformText('engineNoChatModel'),
    }
  }

  if (!opts.repair) {
    return {
      ok: false,
      repaired: false,
      reason: `The LU Engine is not running. ${runnable.length} model${runnable.length === 1 ? ' is' : 's are'} installed. Pick one in the chat model picker to start the engine.`,
    }
  }

  const bare = opts.preferModel
    ? opts.preferModel.includes('::')
      ? opts.preferModel.split('::')[1]
      : opts.preferModel
    : ''
  // A caller that NAMES a model gets that model or an honest no. Falling
  // through to runnable[0] would load a stranger's GGUF into VRAM and report
  // success, and the caller's own pick would swap it right back out (review
  // B1). Only a caller that named nothing accepts whatever is installed.
  const pick = bare ? runnable.find((m) => m.name === bare) : runnable[0]
  if (!pick) {
    return {
      ok: false,
      repaired: false,
      reason: platformText('engineModelFileMissingShort', { name: bare }),
    }
  }
  try {
    const tuning = useSettingsStore.getState().settings.builtinEngine
    // Through the swap gate (S6): a send that arrives while this start is
    // still loading has to wait it out instead of hitting the dead port. Every
    // other start in this file is registered, and this one starts the engine
    // from a button the user just pressed, so it is the likeliest of all to
    // overlap with a send.
    const started = await trackEngineSwap(
      backendCall<EngineStartResult>('start_bundled_engine', { modelPath: pick.path, tuning }),
    )
    syncBuiltinEnginePort(started?.port)
    return { ok: true, reason: '', repaired: true }
  } catch (e) {
    return {
      ok: false,
      repaired: false,
      reason: `The LU Engine could not start "${pick.name}": ${errText(e)}`,
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
