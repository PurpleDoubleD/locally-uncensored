/**
 * Feature EE (v2.5.0) — VRAM hand-off orchestrator for image/video generation.
 *
 * The problem: the local text model (Ollama) and the ComfyUI image/video model
 * both want the GPU. On a single-GPU machine with, say, 12 GB VRAM, a resident
 * 14 B chat model (~9 GB) plus a FLUX/Wan pipeline (~10 GB+) does not fit — the
 * second one to load OOMs. Pre-EE the agent's `image_generate` would just hand
 * the OOM straight back as "generation failed", which read as a broken feature.
 *
 * The fix: when (and ONLY when) the resident text model + the image/video
 * footprint won't co-exist, evict the text model from VRAM first, run the
 * generation, then reload the text model afterwards. The conversation itself
 * lives in chatStore and is never touched — unloading an Ollama model discards
 * only its KV cache (a one-message re-eval cost on the next turn), NOT any
 * message history. The LLM is stateless; "state preservation" here means we
 * never lose the chat, we just pay a small warm-up on the next reply.
 *
 * HONEST UX: this is an OOM-avoidance + state-preservation mechanism, NOT a
 * speed feature. A warm swap is ~30-90 s; a cold ComfyUI start is longer. The
 * VramSwitchCard + the tool descriptions say so plainly — we never imply a
 * zero-latency "seamless" experience.
 *
 * Sequence (vramHandoffGenerate):
 *   (a) DECIDE   — pure, no side effects. Resolve the target image/video model
 *                  and the text model to reload. Cloud/remote text models hold
 *                  no local VRAM → skip all juggling. decideUnload() does the
 *                  fits-or-not math, governed by settings.exclusiveVramMode.
 *   (b) HANDOFF-OUT — only when unloading: capture resident models, unload the
 *                  text model, then POLL /api/ps until it's actually gone (race
 *                  guard: do NOT start ComfyUI until Ollama confirms eviction).
 *   (c) GENERATE — start ComfyUI if needed (poll until up), build the workflow
 *                  (image: buildDynamicWorkflow; video: buildTxt2VidWorkflow),
 *                  submit, poll history, extract outputs. ComfyUI errors are
 *                  surfaced VERBATIM (an OOM must read as an OOM, not "failed").
 *   (d) HANDOFF-BACK — in `finally` (runs on success/failure/timeout): freeMemory
 *                  then best-effort loadModel(textModel) (non-fatal — Ollama
 *                  lazy-loads on the next message anyway).
 *   (e) RETURN   — the SAME string shape as the legacy image_generate so
 *                  ToolCallBlock renders it inline and useAgentChat feeds it
 *                  back to the model unchanged.
 *
 * A module-level in-flight mutex serialises calls so a 2nd generation awaits
 * the first — without it, the finally-reload of call #1 could fire mid-generation
 * of call #2 and re-trigger the exact OOM we are avoiding.
 */

import { backendCall, ollamaUrl, localFetch, isOllamaLocal, isWindows } from './backend'
import { listRunningModels, loadModel, unloadModel } from './ollama'
import { startBundledEngine } from './engine'
import { useSettingsStore } from '../stores/settingsStore'
import {
  getImageModels,
  getVideoModels,
  detectVideoBackend,
  getSystemVRAM,
  submitWorkflow,
  getHistory,
  freeMemory,
  cancelGeneration,
  clearComfyQueue,
  abandonPrompt,
  sweepOrphanedLuJobs,
  extractComfyOutputFiles,
  getImageUrl,
  classifyModel,
  isI2VModel,
  isT2VCapable,
  uploadImage,
  buildTxt2VidWorkflow,
  snapToVideoGrid,
  MODEL_TYPE_DEFAULTS,
  isPromptQueued,
  type VideoBackend,
} from './comfyui'
import type { ModelCapabilities } from './comfyui-nodes'
import { getActiveAgentModel } from './agent-context'
import { comfyWS, CLIENT_ID } from './comfyui-ws'
import { PaceTracker, overBudget, renderBudgetNotice, renderTimeoutNotice, warmupExceeded, swapWarmupNotice, loadPhaseGraceMs, finishGraceMs, warmupBudgetMs, SWAP_WARMUP_BUDGET_MS, type CpuRenderFacts } from '../lib/render-budget'
import { log } from '../lib/logger'

/**
 * Resolve a casual model name the user/LLM typed (e.g. "FramePack", "wan",
 * "sdxl") to an actually-installed model FILENAME. David 2026-06-04: no end user
 * types `FramePackI2V_HY_fp8_e4m3fn.safetensors`. Tries, in order: normalized
 * exact match, requested-is-substring-of-model, model-is-substring, then token
 * overlap. Returns null when nothing matches confidently, so the caller reports
 * it instead of silently generating with the wrong model.
 */
export function resolveModelName(
  requested: string,
  installed: { name: string }[],
): string | null {
  const norm = (s: string) =>
    s.toLowerCase().replace(/\.(safetensors|ckpt|pt|pth|gguf|sft|bin)$/i, '').replace(/[^a-z0-9]+/g, '')
  const r = norm(requested)
  if (!r || installed.length === 0) return null
  // 1) exact normalized filename match
  let hit = installed.find((m) => norm(m.name) === r)
  if (hit) return hit.name
  // 2) casual name contained in a model filename ("framepack" → "framepacki2v…")
  hit = installed.find((m) => norm(m.name).includes(r))
  if (hit) return hit.name
  // 3) a model filename contained in the (longer) requested string
  hit = installed.find((m) => norm(m.name).length >= 3 && r.includes(norm(m.name)))
  if (hit) return hit.name
  // 4) token overlap — most request words appear in the model filename
  const tokens = requested.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2)
  let best: { name: string } | null = null
  let bestScore = 0
  for (const m of installed) {
    const mn = norm(m.name)
    const score = tokens.filter((t) => mn.includes(t)).length
    if (score > bestScore) { bestScore = score; best = m }
  }
  return best && bestScore > 0 ? best.name : null
}

export type HandoffPhase =
  | 'deciding'
  | 'freeing_vram'
  | 'loading_image_model'
  | 'generating'
  | 'restoring_text'
  | 'done'
  | 'error'

export interface HandoffEventDetail {
  phase: HandoffPhase
  /** 'image' | 'video' — which generation kind is in flight. */
  kind?: 'image' | 'video'
  /** Free-text detail for the card (e.g. a model name or an error message). */
  detail?: string
  /** True only on the final 'done'/'error' so the card knows to fade out. */
  terminal?: boolean
}

// ── Status channel (pure TS, no Rust round-trip) ──────────────────
//
// A tiny browser EventTarget the orchestrator pushes phase events onto. The
// VramSwitchCard subscribes via useVramHandoff. Emitting is best-effort and
// NEVER throws — in a non-DOM context (vitest node env) `EventTarget` may be
// unavailable, so we guard creation and swallow any failure. The orchestrator
// must keep working with or without a UI listening.

export const HANDOFF_EVENT = 'lu-vram-handoff'

let _channel: EventTarget | null = null
function getChannel(): EventTarget | null {
  if (_channel) return _channel
  try {
    if (typeof EventTarget !== 'undefined') {
      _channel = new EventTarget()
      return _channel
    }
  } catch { /* no EventTarget in this runtime */ }
  return null
}

/** Subscribe to hand-off phase events. Returns an unsubscribe fn (no-op if unavailable). */
export function onHandoff(listener: (d: HandoffEventDetail) => void): () => void {
  const ch = getChannel()
  if (!ch) return () => {}
  const wrapped = (e: Event) => {
    const detail = (e as CustomEvent<HandoffEventDetail>).detail
    if (detail) listener(detail)
  }
  ch.addEventListener(HANDOFF_EVENT, wrapped as EventListener)
  return () => ch.removeEventListener(HANDOFF_EVENT, wrapped as EventListener)
}

/** Emit a phase event. No-throw — a failed emit must never break a generation. */
function emitHandoff(phase: HandoffPhase, opts?: Omit<HandoffEventDetail, 'phase'>): void {
  try {
    const ch = getChannel()
    if (!ch) return
    const terminal = phase === 'done' || phase === 'error'
    const evt = new CustomEvent<HandoffEventDetail>(HANDOFF_EVENT, {
      detail: { phase, terminal, ...opts },
    })
    ch.dispatchEvent(evt)
  } catch { /* best effort */ }
}

// ── Resident-model VRAM probe (/api/ps) ───────────────────────────
//
// listRunningModels() in ollama.ts throws away the per-model sizes, but the
// fits-or-not decision needs `size_vram` (bytes of the model actually resident
// in GPU memory). So we hit /api/ps directly here, mirroring that function's
// transport + soft-fail-to-empty behaviour.

interface ResidentModel {
  name: string
  /** Bytes of this model currently resident in VRAM (0 if CPU-only / unknown). */
  sizeVram: number
}

async function getResidentModels(): Promise<ResidentModel[]> {
  try {
    // Short cap: /api/ps is a quick status read. Bounding it keeps the DECIDE
    // phase from inheriting the proxy's 5-min default if Ollama is wedged.
    const res = await localFetch(ollamaUrl('/ps'), { timeoutMs: 8_000 })
    if (!res.ok) return []
    const data = await res.json()
    return (data.models || []).map((m: any) => ({
      name: m.name || m.model || '',
      sizeVram: typeof m.size_vram === 'number' ? m.size_vram : 0,
    }))
  } catch {
    return []
  }
}

// ── Footprint estimate for the image/video model ──────────────────
//
// We don't know the exact runtime VRAM a ComfyUI pipeline will take before we
// run it (it depends on resolution, dtype, the VAE, text encoder, etc.), so we
// use a conservative per-architecture estimate in GB. The number is the
// *checkpoint/diffusion + typical aux* footprint — deliberately on the high
// side so 'auto' errs toward freeing rather than toward an OOM. These are
// estimates, not measurements (Bug-G lesson: only live E2E confirms the real
// number on a given GPU); they exist solely to make the fits/doesn't-fit
// comparison meaningful, never to gate the generation hard.
const MODEL_FOOTPRINT_GB: Record<string, number> = {
  // Image
  sd15: 4,
  sdxl: 8,
  flux: 16,
  flux2: 22,
  zimage: 12,
  ernie_image: 18,
  // Video (heavier — UNet + VAE + big text encoder all resident)
  wan: 18,
  hunyuan: 20,
  ltx: 12,
  mochi: 22,
  cosmos: 24,
  cogvideo: 18,
  svd: 12,
  framepack: 18,
  pyramidflow: 16,
  allegro: 20,
}

/** Best-effort footprint for a model name. Unknown → null (caller treats as unknown). */
export function estimateModelFootprintGB(modelName: string): number | null {
  const type = classifyModel(modelName)
  return MODEL_FOOTPRINT_GB[type] ?? null
}

export type ExclusiveVramMode = 'auto' | 'always' | 'never'

export interface DecideUnloadInput {
  /** Bytes of text model currently resident in VRAM (from /api/ps size_vram). 0/undefined = unknown. */
  textVramBytes: number | undefined
  /** Estimated image/video footprint in GB (from estimateModelFootprintGB). null = unknown. */
  modelFootprintGB: number | null
  /** Total system VRAM in GB (from getSystemVRAM). null = unknown. */
  systemVramGB: number | null
  /** Governing setting. */
  mode: ExclusiveVramMode
}

export interface DecideUnloadResult {
  unload: boolean
  reason: string
}

const BYTES_PER_GB = 1024 * 1024 * 1024

// Fallback FramePack frame ceiling. FramePack is duration-driven (total_second_length),
// so /object_info exposes no per-model frame max — getModelCapabilities() returns this
// same 600 for framepack, and generateVideo passes it as resolveClip's maxFrames fallback
// when capabilities are unavailable. Guards a typo'd seconds×fps from queuing an
// hours-long render. ~15 s @ 40 fps / ~37 s @ 16 fps.
const FRAMEPACK_MAX_FRAMES = 600

/**
 * Pure decision: should we evict the text model before generating?
 *
 *   - mode 'never'  → never unload (user opted out of juggling).
 *   - mode 'always' → always unload when there IS a resident text model.
 *   - mode 'auto'   → unload only when the math says they won't co-exist:
 *                     (textVram + footprint) > systemVram. If ANY input is
 *                     unknown we DON'T unload — better to attempt the gen and
 *                     surface a real OOM than to evict the user's model on a
 *                     guess (the unload itself costs a re-eval next turn).
 *
 * Exported + side-effect-free so the unit tests can exhaustively cover the
 * fits / doesn't-fit / unknown matrix without any live services.
 */
export function decideUnload(input: DecideUnloadInput): DecideUnloadResult {
  const { textVramBytes, modelFootprintGB, systemVramGB, mode } = input

  if (mode === 'never') {
    return { unload: false, reason: 'exclusiveVramMode=never' }
  }

  const textGB = textVramBytes && textVramBytes > 0 ? textVramBytes / BYTES_PER_GB : 0

  if (mode === 'always') {
    // Only meaningful to unload if the text model is actually resident in VRAM.
    if (textGB > 0) return { unload: true, reason: 'exclusiveVramMode=always (text model resident)' }
    return { unload: false, reason: 'exclusiveVramMode=always but no text model resident in VRAM' }
  }

  // mode === 'auto'
  if (textGB <= 0) {
    return { unload: false, reason: 'auto: no text model resident in VRAM (nothing to free)' }
  }
  if (modelFootprintGB == null || systemVramGB == null) {
    // Unknown sizes → don't unload on auto. Attempt the gen; if it OOMs the
    // user sees the verbatim ComfyUI error and can switch to 'always'.
    return { unload: false, reason: 'auto: unknown footprint or system VRAM, not unloading on a guess' }
  }
  const needed = textGB + modelFootprintGB
  if (needed > systemVramGB) {
    return {
      unload: true,
      reason: `auto: text ${textGB.toFixed(1)}GB + model ${modelFootprintGB}GB = ${needed.toFixed(1)}GB > ${systemVramGB}GB VRAM`,
    }
  }
  return {
    unload: false,
    reason: `auto: text ${textGB.toFixed(1)}GB + model ${modelFootprintGB}GB = ${needed.toFixed(1)}GB fits in ${systemVramGB}GB VRAM`,
  }
}

// ── ComfyUI lifecycle helpers ─────────────────────────────────────

interface ComfyStatus {
  running?: boolean
  starting?: boolean
  found?: boolean
}

async function comfyIsRunning(): Promise<boolean> {
  try {
    const s = await backendCall<ComfyStatus>('comfyui_status')
    return !!s?.running
  } catch {
    return false
  }
}

/**
 * Ensure ComfyUI is up. If `comfyui_status` already reports running, return
 * immediately. Otherwise fire `start_comfyui` and poll status until running or
 * the cold-start budget (~90 s) elapses. Non-fatal: returns false on timeout so
 * the caller can still attempt the workflow (the submit will surface a clear
 * connection error if ComfyUI truly never came up).
 */
async function ensureComfyRunning(timeoutMs = 90_000): Promise<boolean> {
  if (await comfyIsRunning()) return true
  try {
    await backendCall('start_comfyui')
  } catch (e) {
    log.warn('vram_handoff.start_comfyui_failed', { err: String(e) })
    // Fall through to poll anyway — it may already be starting.
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // Bail fast if the user cancelled during the cold start (the caller checks
    // _genCancelRequested right after us and reports it as "cancelled").
    if ((await raceCancel(sleep(1500))) === CANCELLED) return false
    if (await comfyIsRunning()) return true
  }
  return false
}

/**
 * Race guard: after unloadModel(textModel), poll /api/ps until that model is no
 * longer resident (or timeout). Starting ComfyUI before Ollama has actually
 * released the VRAM defeats the whole point — the two would briefly co-exist
 * and OOM. 15 s is generous; a `keep_alive:0` evict is usually sub-second.
 */
// ── LM Studio text-model juggling (v2.5.3) ───────────────────────

export interface LmsTextModel {
  /** Bare LM Studio model id (no `openai::` routing prefix). */
  id: string
  /** Context length it was loaded with — restored on reload via `lms load -c`. */
  contextLength: number | null
}

/** Empirically detect whether the active 'openai' provider model is a LOCAL
 *  LM Studio model currently holding VRAM. Asks the local LM Studio REST
 *  (lmstudio_model_context → state === 'loaded'); anything else — cloud
 *  OpenAI, other openai-compat endpoints, LM Studio not running — returns
 *  null and the orchestrator skips juggling exactly as before. */
export async function detectLmsTextModel(
  active: { name: string; providerId: string } | null,
): Promise<LmsTextModel | null> {
  if (!active || active.providerId !== 'openai' || !active.name) return null
  const bare = active.name.startsWith('openai::')
    ? active.name.slice('openai::'.length)
    : active.name
  try {
    const info = await backendCall<{ loaded: number | null; state: string | null }>(
      'lmstudio_model_context',
      { model: bare },
    )
    if (info && info.state === 'loaded') {
      return { id: bare, contextLength: typeof info.loaded === 'number' ? info.loaded : null }
    }
  } catch { /* LM Studio absent → no local VRAM held */ }
  return null
}

/** Live-truth fallback (v2.5.3 follow-up): whatever the LOCAL LM Studio REST
 *  reports as loaded holds VRAM — regardless of which provider the chat uses
 *  or whether the agent-loop pin survived (rolldown chunk duplication ate it
 *  in the release build, and Codex never pinned). Returns the first loaded
 *  model with its loaded context length, or null when LM Studio is absent /
 *  nothing is loaded. */
export async function detectAnyLoadedLmsModel(): Promise<LmsTextModel | null> {
  try {
    const list = await backendCall<{ loaded: string[] }>('lmstudio_list_loaded', {})
    const id = Array.isArray(list?.loaded) ? list.loaded.find((m) => typeof m === 'string' && m) : undefined
    if (!id) return null
    let contextLength: number | null = null
    try {
      const info = await backendCall<{ loaded: number | null }>('lmstudio_model_context', { model: id })
      contextLength = typeof info?.loaded === 'number' ? info.loaded : null
    } catch { /* context unknown — reload without -c */ }
    return { id, contextLength }
  } catch {
    return null
  }
}

/** Pure pick: which resident Ollama model is the evict-then-reload target?
 *  The pinned agent-loop model wins when it is actually resident; otherwise
 *  the largest resident one (in practice: the chat model). Exported for the
 *  unit tests — the live-state fallback this feeds exists because the pin
 *  alone proved unreliable (chunk duplication / unpinned callers). */
export function pickResidentOllamaTarget(
  resident: { name: string; sizeVram?: number }[],
  active: { name: string; providerId: string; remote: boolean } | null,
): { name: string; sizeVram?: number } | null {
  if (resident.length === 0) return null
  const preferred =
    active && active.providerId === 'ollama' && active.remote === false
      ? resident.find((m) => m.name === active.name)
      : undefined
  return (
    preferred ??
    resident.reduce((a, b) => (((b.sizeVram ?? 0) > (a.sizeVram ?? 0)) ? b : a))
  )
}

/** Rough VRAM estimate for an LM Studio text model from its id's parameter
 *  count ("…-7b…" → ~5.3 GB at Q4 + context overhead). LM Studio's REST has
 *  no VRAM figure, so this feeds decideUnload the same way Ollama's
 *  sizeVram does; no parseable size → undefined → safe no-evict in 'auto'. */
export function estimateLmsTextVramBytes(id: string): number | undefined {
  const m = id.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b\b/)
  if (!m) return undefined
  const params = parseFloat(m[1])
  if (!Number.isFinite(params) || params <= 0) return undefined
  return Math.round(params * 0.75 * 1e9)
}

// ── Built-in engine (llama-server) juggling + KV-slot carry (GH #85) ──
// I-Am-LongXi: llama.cpp can serialize a slot's KV cache to disk and restore
// it after a reload. The handoff uses that, so evicting the built-in engine
// for a render no longer costs a full history re-process on the next turn.
// The HTTP rides the Rust side (kv_slot_action): the webview cannot reach the
// engine port, all engine traffic goes through the proxy anyway.

export interface BundledTarget {
  port: number
  modelPath: string
  /** GGUF size on disk, a close proxy for its VRAM at full offload. */
  modelBytes: number
}

/** The built-in llama-server, when it is running and holding VRAM. */
export async function detectBundledEngine(): Promise<BundledTarget | null> {
  try {
    const s = await backendCall<{ running?: boolean; port?: number; model_path?: string | null; modelBytes?: number }>('bundled_engine_status')
    if (s?.running && typeof s.port === 'number' && typeof s.model_path === 'string' && s.model_path) {
      return { port: s.port, modelPath: s.model_path, modelBytes: typeof s.modelBytes === 'number' ? s.modelBytes : 0 }
    }
  } catch { /* command absent (web build) or engine idle */ }
  return null
}

export async function pollGone(modelName: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  // Check immediately first (cheap) before sleeping.
  for (;;) {
    let running: string[]
    try {
      running = await listRunningModels()
    } catch {
      running = []
    }
    if (!running.includes(modelName)) return true
    if (Date.now() >= deadline) return false
    await sleep(750)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── In-flight mutex ───────────────────────────────────────────────
//
// One generation at a time. A 2nd call chains onto the 1st's promise so the
// reload-in-finally of call #1 can never overlap the generate of call #2.
let _inFlight: Promise<unknown> = Promise.resolve()

// ── User-initiated cancel (David 2026-06-16) ────────────────────────────────
// The agent's AbortController never reached the ComfyUI poll loop, so "Stop"
// left ComfyUI rendering (a ~500 s SVD video kept burning the GPU after the UI
// said it stopped). This module-level flag + ComfyUI /interrupt give the
// in-chat cancel button a REAL abort. Only one generation runs at a time
// (serialised via _inFlight), so one flag suffices.
//
// David 2026-06-16 (bug B): a bare flag checked only BETWEEN getHistory calls
// wasn't enough — `image_generate` Stop "hung at stopping…". The hang: each
// poll tick blocks in `await getHistory` (15 s cap) while ComfyUI COLD-LOADS the
// checkpoint (RealVisXL is a long, non-interruptible load), and /interrupt is a
// no-op during a model load. So the flag wasn't re-checked for up to 15 s and
// the UI sat on "stopping…". Fix: a notify-promise (_cancelWait) that every long
// await RACES against, so Stop bails within milliseconds regardless of which
// phase we're in (eviction, ComfyUI cold-start, model-load, or sampling). We
// also clear the ComfyUI queue, not just /interrupt, so a queued item can't
// start after the running one is interrupted. runHandoff's finally still
// restores the text model into VRAM exactly as before.
const CANCELLED = '__lu_cancelled__' as const

let _genCancelRequested = false
let _cancelNotify: (() => void) | null = null
// A promise that resolves to CANCELLED the instant Stop is pressed. Re-armed per
// run by resetCancel() and built ONCE per gen (not per raceCancel call) so a long
// poll doesn't accumulate thousands of derived `.then` promises on it.
let _cancelSignal: Promise<typeof CANCELLED> = new Promise<typeof CANCELLED>(() => { /* until reset */ })

// Monotonic generation sequence + cancel epoch (back-to-back Stop fix). Each
// vramHandoffGenerate() claims a seq when CREATED (before it parks on the
// previous gen). requestGenerationCancel records the highest seq seen so far as
// "cancelled-through"; a gen queued at/before the Stop bails the instant it
// dequeues — its per-run resetCancel() clears the flag, but the epoch persists.
let _genSeq = 0
let _cancelledThrough = 0
// Count of runHandoff bodies actually executing. Lets a Stop on a PLAIN text
// chat (no media gen in flight) skip the ComfyUI /interrupt + full /queue-clear
// that would otherwise nuke an unrelated Create-tab render or another client.
let _activeHandoffs = 0

/** Re-arm the cancel channel at the start of each generation. */
function resetCancel(): void {
  _genCancelRequested = false
  _cancelSignal = new Promise<typeof CANCELLED>((resolve) => { _cancelNotify = () => resolve(CANCELLED) })
}

/**
 * Race a long await against a user cancel. Returns the wrapped promise's value
 * normally, or the CANCELLED sentinel the moment Stop is pressed — so a 15 s
 * getHistory tick or a 90 s ComfyUI cold-start can't keep "stopping…" on screen.
 */
function raceCancel<T>(p: Promise<T>): Promise<T | typeof CANCELLED> {
  if (_genCancelRequested) return Promise.resolve(CANCELLED)
  return Promise.race([p, _cancelSignal])
}

export function requestGenerationCancel(): void {
  _genCancelRequested = true
  _cancelledThrough = _genSeq  // cancel every gen created so far (running + queued)
  _cancelNotify?.()            // wake every pending raceCancel immediately
  // Only touch ComfyUI when a chat-initiated generation is actually running.
  // A plain text-chat Stop must NOT /interrupt + clear the ENTIRE queue (that
  // would kill an unrelated Create-tab render or another client's job).
  if (_activeHandoffs > 0) {
    void cancelGeneration()  // /interrupt the running job (no-op mid model-load)
    void clearComfyQueue()   // drop anything still queued so it can't start next
  }
}

// Last image LU actually produced this session. Small models routinely pass a
// hallucinated filename (e.g. "locally_saved_image.png") to a follow-up
// video_generate; when the given name can't be resolved we fall back to this so
// the "animate the image you just made" chain still works. Set after each
// successful image generation.
let _lastImageFilename: string | null = null

/**
 * Test-only: reset the module-level serialisation/cancel state so each unit test
 * starts from a clean slate. These vars intentionally persist across a real
 * session (one in-flight queue, one monotonic seq), so production never calls
 * this — it exists solely to keep the cancel/epoch/active-handoffs tests isolated.
 */
export function __resetGenerationStateForTests(): void {
  _inFlight = Promise.resolve()
  _genSeq = 0
  _cancelledThrough = 0
  _activeHandoffs = 0
  _genCancelRequested = false
  _lastImageFilename = null
}

// ── Public orchestrator ───────────────────────────────────────────

export interface VramHandoffArgs {
  prompt?: string
  negativePrompt?: string
  model?: string
  // Image-to-image / image-to-video: a filename from a prior generate result.
  inputImage?: string
  // Image-to-image denoise strength (0.05–1.0).
  denoise?: number
  // Video-only
  frames?: number
  fps?: number
  // Desired clip length in seconds. Preferred over raw frames for the agent —
  // LU converts it to frames/fps per model (honoring the duration even when a
  // model like SVD caps the frame count).
  seconds?: number
  [k: string]: unknown
}

/**
 * Orchestrate one image/video generation with VRAM hand-off. Always resolves to
 * a result string (never rejects) so the agent loop gets a clean tool message.
 */
export async function vramHandoffGenerate(kind: 'image' | 'video', args: VramHandoffArgs): Promise<string> {
  // Serialise. We park on the previous call's settled promise (success OR
  // failure — `.catch` swallows so a prior error doesn't reject our chain),
  // then run our own body and expose it as the new tail.
  const seq = ++_genSeq
  const run = _inFlight
    .catch(() => {})
    .then(() => runHandoff(kind, args, seq))
    // Defensive: runHandoff is written to always RETURN a string (the finally
    // block never rethrows), but if anything unexpected slips through we still
    // hand the agent a clean tool message instead of rejecting the chain.
    .catch((e) => `${kind === 'video' ? 'Video' : 'Image'} generation failed: ${e instanceof Error ? e.message : String(e)}`)
  _inFlight = run.catch(() => {})
  return run
}

async function runHandoff(kind: 'image' | 'video', args: VramHandoffArgs, seq: number): Promise<string> {
  // Fresh run — re-arm the cancel channel (clears any flag/notify left over from
  // a previous cancelled gen).
  resetCancel()
  // If Stop arrived while THIS gen was still queued behind another (its seq was
  // created at/before the cancel), bail now. resetCancel() above just cleared the
  // per-run flag, but the cancel epoch persists — without this, a back-to-back
  // gen survives the user's Stop.
  if (seq <= _cancelledThrough) return `${label(kind)} generation cancelled.`
  // Robustness for small local models (gemma4:e4b live): they frequently emit a
  // snake_case `input_image` alias and sometimes omit `prompt` on a video call.
  // Normalize the alias so the I2V path still finds the source image.
  if (args.inputImage == null) {
    const alt = (args as Record<string, unknown>).input_image ?? (args as Record<string, unknown>).image
    if (typeof alt === 'string' && alt) args.inputImage = alt
  }
  // Duration alias: models say duration / length / durationSeconds for `seconds`
  // (gemma4 live passed {"duration": 4}). Normalize so resolveClip honors it.
  if (args.seconds == null) {
    const d = (args as Record<string, unknown>).duration ?? (args as Record<string, unknown>).length ?? (args as Record<string, unknown>).durationSeconds
    const n = typeof d === 'number' ? d : Number(d)
    if (Number.isFinite(n) && n > 0) args.seconds = n
  }
  let prompt = String(args.prompt ?? args.description ?? '').trim()
  if (!prompt) {
    // A video call (esp. image-to-video / SVD) can animate without an explicit
    // prompt — default a gentle motion rather than hard-failing on "prompt
    // required" (which made gemma give up mid-chain). Images still need a prompt.
    if (kind === 'video') prompt = 'gentle, subtle natural motion'
    else return `Error: No prompt provided for ${kind} generation.`
  }

  emitHandoff('deciding', { kind })

  // ── (a) DECIDE — resolve target model (no side effects yet) ──────
  let targetModel: string
  let videoBackend: VideoBackend = 'none'
  try {
    if (kind === 'image') {
      const models = await getImageModels()
      if (models.length === 0) {
        emitHandoff('error', { kind, detail: 'no image model installed' })
        return 'Error: No image model installed. Download one from Models → Discover (e.g. "FLUX.1 [schnell] FP8", "Z-Image Turbo", or "Juggernaut XL V9") and try again.'
      }
      if (typeof args.model === 'string' && args.model) {
        const resolved = resolveModelName(args.model, models)
        if (!resolved) {
          emitHandoff('error', { kind, detail: 'model not found' })
          return `Error: No installed image model matches "${args.model}". Installed: ${models.map((m) => m.name).join(', ')}. Try one of those names (a partial name like "FLUX" or "SDXL" works).`
        }
        targetModel = resolved
      } else {
        targetModel = models[0].name
      }
    } else {
      const [models, backend] = await Promise.all([getVideoModels(), detectVideoBackend()])
      const wantI2V = typeof args.inputImage === 'string' && !!args.inputImage
      if (wantI2V) {
        // Image-to-video needs an I2V-capable model (SVD / FramePack). Those use
        // built-in ComfyUI nodes, so a 'none' text-to-video backend is fine here.
        const i2vModels = models.filter((m) => isI2VModel(m.name))
        if (i2vModels.length === 0) {
          emitHandoff('error', { kind, detail: 'no i2v model installed' })
          return 'Error: Image-to-video needs an I2V model such as SVD. Install one from Models → Discover (e.g. "SVD-XT 1.1 (Image to Video)"), then try again.'
        }
        if (typeof args.model === 'string' && args.model) {
          const resolved = resolveModelName(args.model, i2vModels)
          if (!resolved) {
            emitHandoff('error', { kind, detail: 'i2v model not found' })
            return `Error: No installed image-to-video model matches "${args.model}". Installed I2V: ${i2vModels.map((m) => m.name).join(', ')}. A partial name like "SVD" or "FramePack" works.`
          }
          targetModel = resolved
        } else {
          targetModel = i2vModels[0].name
        }
        videoBackend = backend
      } else {
        // Text-to-video must NOT pick an image-to-video-ONLY checkpoint (SVD /
        // FramePack) — those load via ImageOnlyCheckpointLoader, so feeding one
        // into a Wan/UNet T2V workflow yields ComfyUI "UNETLoader: value not in
        // list" (gemma4 live, scenario 3c). isT2VCapable keeps Wan 2.2 TI2V (dual
        // T2V/I2V) in the list while still excluding the I2V-only checkpoints.
        const t2vModels = models.filter((m) => isT2VCapable(m.name))
        if (t2vModels.length === 0 || backend === 'none') {
          emitHandoff('error', { kind, detail: 'no text-to-video model installed' })
          return 'Error: No text-to-video model installed. Download one from Models → Discover (e.g. "Wan 2.1 · 1.3B (Lightweight)" for 8 to 10 GB VRAM or "HunyuanVideo 1.5 T2V FP8" for 12+ GB). Or generate an image first and animate it with an I2V model like "SVD-XT 1.1".'
        }
        if (typeof args.model === 'string' && args.model) {
          const resolved = resolveModelName(args.model, t2vModels)
          if (!resolved) {
            emitHandoff('error', { kind, detail: 't2v model not found' })
            return `Error: No installed text-to-video model matches "${args.model}". Installed T2V: ${t2vModels.map((m) => m.name).join(', ')}. A partial name like "Wan" or "Hunyuan" works.`
          }
          targetModel = resolved
        } else {
          targetModel = t2vModels[0].name
        }
        videoBackend = backend
      }
    }
  } catch (e) {
    // ComfyUI unreachable while listing models — we have not unloaded anything,
    // so just report it. Don't mask the connection failure.
    emitHandoff('error', { kind, detail: String(e) })
    return `Error: Could not query ComfyUI models: ${e instanceof Error ? e.message : String(e)}. Is ComfyUI installed and reachable?`
  }

  // Which text model do we reload afterwards? The pinned agent-loop model is
  // the PREFERENCE — but the pin has proven fragile in the wild (the rolldown
  // build duplicated agent-context so the pin read null in the release app,
  // and Codex never pinned at all; live E2E 2026-06-11). What actually holds
  // VRAM is authoritative, so the decision now starts from the LIVE state:
  // /api/ps for a local Ollama, the LM Studio REST for a local LM Studio.
  // Cloud providers / remote bases never show up in either probe, so they
  // skip juggling exactly as before.
  const active = getActiveAgentModel()

  // ── Ollama side (live): resident models from /api/ps ──────────────
  let textModel: string | null = null
  let textVramBytes: number | undefined
  if (isOllamaLocal()) {
    try {
      const resident = await getResidentModels()
      const candidate = pickResidentOllamaTarget(resident, active)
      if (candidate) {
        textModel = candidate.name
        textVramBytes = candidate.sizeVram
      }
    } catch {
      // /api/ps unreachable → treat as nothing resident (no Ollama to juggle).
    }
  }

  // ── LM Studio side (live): pinned context first, then list_loaded ──
  // detectLmsTextModel covers the pinned 'openai' chat model; the fallback
  // covers everything the pin misses (Codex, cloud chat with a stray loaded
  // LMS model, lost pin). Both only ever match the LOCAL LM Studio REST.
  let lmsTarget = await detectLmsTextModel(active)
  if (!lmsTarget) lmsTarget = await detectAnyLoadedLmsModel()
  const lmsVramBytes = lmsTarget ? estimateLmsTextVramBytes(lmsTarget.id) : undefined

  // ── Built-in engine side (live): llama-server holding a GGUF (GH #85) ──
  const bundledTarget = await detectBundledEngine()

  // ── Decide: one shared fits/doesn't-fit call over EVERYTHING resident.
  // If the sum doesn't co-exist with the generation footprint, free BOTH
  // sides — over-evicting is lossless (both reload in the finally), while
  // under-evicting risks the exact 11.9/12 GB thrash this exists to avoid.
  let willUnload = false
  let willUnloadLms = false
  let willUnloadBundled = false
  if (textModel || lmsTarget || bundledTarget) {
    try {
      const [footprint, systemVram, mode] = await Promise.all([
        Promise.resolve(estimateModelFootprintGB(targetModel)),
        getSystemVRAM(),
        Promise.resolve(getExclusiveVramMode()),
      ])
      const residentBytes = (textVramBytes ?? 0) + (lmsVramBytes ?? 0) + (bundledTarget?.modelBytes ?? 0)
      const decision = decideUnload({
        textVramBytes: residentBytes > 0 ? residentBytes : undefined,
        modelFootprintGB: footprint,
        systemVramGB: systemVram,
        mode,
      })
      willUnload = decision.unload && !!textModel
      willUnloadLms = decision.unload && !!lmsTarget
      willUnloadBundled = decision.unload && !!bundledTarget
      log.info('vram_handoff.decision', {
        kind,
        targetModel,
        textModel,
        lmsModel: lmsTarget?.id ?? null,
        bundledModel: bundledTarget?.modelPath ?? null,
        textVramBytes,
        lmsVramBytes,
        bundledBytes: bundledTarget?.modelBytes,
        ...decision,
      })
    } catch (e) {
      // Decision probe failed — default to NOT unloading (safer; attempt gen).
      log.warn('vram_handoff.decision_failed', { err: String(e) })
      willUnload = false
      willUnloadLms = false
      willUnloadBundled = false
    }
  }

  // Capture resident text models BEFORE unload so the reload target is honest
  // even if `active` was somehow stale.
  let evictedModel: string | null = null
  let evictedLms: LmsTextModel | null = null
  let evictedBundled: (BundledTarget & { slotSaved: boolean }) | null = null

  try {
    // A chat-initiated ComfyUI gen is now ACTUALLY in flight — we are past every
    // model-listing early-return above. This gates the ComfyUI /interrupt +
    // queue-clear in requestGenerationCancel and is paired 1:1 with the
    // `_activeHandoffs--` in the finally below. It MUST live in THIS try: the
    // "no model installed" / "model not found" / ComfyUI-unreachable returns in
    // the DECIDE try return BEFORE here, so incrementing up there leaks the
    // counter and a later plain-chat Stop would wrongly /interrupt + clear an
    // unrelated Create-tab render (the exact bug this counter prevents).
    _activeHandoffs++
    // ── (b) HANDOFF-OUT — only if we decided to unload ─────────────
    if (willUnload && textModel) {
      emitHandoff('freeing_vram', { kind, detail: textModel })
      // Confirm it's actually resident right now (capture-before-unload).
      let runningBefore: string[]
      try {
        runningBefore = await listRunningModels()
      } catch {
        runningBefore = []
      }
      if (runningBefore.includes(textModel)) {
        try {
          await unloadModel(textModel)
          evictedModel = textModel
        } catch (e) {
          // Unload failed — don't block the gen, but log. ComfyUI may still OOM;
          // that error will surface verbatim below.
          log.warn('vram_handoff.unload_failed', { textModel, err: String(e) })
        }
        // RACE GUARD: wait until /api/ps confirms eviction before touching ComfyUI.
        if (evictedModel) {
          const gone = await pollGone(evictedModel)
          if (!gone) {
            log.warn('vram_handoff.evict_timeout', { textModel: evictedModel })
          }
        }
      }
    }

    // ── (b2) HANDOFF-OUT for a local LM Studio text model ──────────
    if (willUnloadLms && lmsTarget) {
      emitHandoff('freeing_vram', { kind, detail: lmsTarget.id })
      try {
        await backendCall('lmstudio_unload_model', { model: lmsTarget.id })
        evictedLms = lmsTarget
        // Race guard, mirroring pollGone: wait until the REST stops reporting
        // 'loaded' before ComfyUI starts grabbing VRAM.
        for (let i = 0; i < 10; i++) {
          const info = await backendCall<{ state: string | null }>(
            'lmstudio_model_context',
            { model: lmsTarget.id },
          ).catch(() => null)
          if (!info || info.state !== 'loaded') break
          await new Promise((r) => setTimeout(r, 1000))
        }
      } catch (e) {
        // Same policy as the Ollama path: never block the generation on a
        // failed unload — ComfyUI may still OOM and that surfaces verbatim.
        log.warn('vram_handoff.lms_unload_failed', { lmsModel: lmsTarget.id, err: String(e) })
      }
    }

    // ── (b3) HANDOFF-OUT for the built-in engine (GH #85) ──────────
    if (willUnloadBundled && bundledTarget) {
      emitHandoff('freeing_vram', { kind, detail: 'built-in engine' })
      // Carry the conversation across the eviction: serialize the KV cache to
      // disk, then stop the engine. Restore happens in the finally. When
      // either half fails, the next chat turn just re-processes the history,
      // which is exactly the pre-#85 cost — never block the render on it.
      const saved = await backendCall<{ ok?: boolean }>('kv_slot_action', { port: bundledTarget.port, action: 'save' }).catch(() => null)
      if (saved?.ok !== true) log.warn('vram_handoff.kv_save_failed', { port: bundledTarget.port })
      try {
        await backendCall('stop_bundled_engine')
        evictedBundled = { ...bundledTarget, slotSaved: saved?.ok === true }
      } catch (e) {
        log.warn('vram_handoff.bundled_stop_failed', { err: String(e) })
      }
    }

    // Cancelled while freeing VRAM / waiting for eviction — bail before we even
    // touch ComfyUI. The finally still restores the text model.
    if (_genCancelRequested) return `${label(kind)} generation cancelled.`

    // ── (c) GENERATE ───────────────────────────────────────────────
    emitHandoff('loading_image_model', { kind, detail: targetModel })
    const up = await ensureComfyRunning()
    // ensureComfyRunning returns false on a cancel too — distinguish so Stop
    // reads as "cancelled", not the misleading "ComfyUI did not start".
    if (_genCancelRequested) return `${label(kind)} generation cancelled.`
    if (!up) {
      // Surface clearly; the finally block still restores the text model.
      emitHandoff('error', { kind, detail: 'ComfyUI did not start' })
      return 'Error: ComfyUI did not start within 90s. Start it from the Create tab and try again.'
    }

    // A dead LU session cannot cancel its render, so clean its leftovers out
    // of the queue BEFORE we submit ours (G19-3): otherwise our job waits
    // behind an ownerless render burning the GPU (R32 sat at position 4).
    // Best effort and cheap (one GET /queue when nothing is stale).
    await sweepOrphanedLuJobs(CLIENT_ID)

    emitHandoff('generating', { kind, detail: targetModel })

    // Race the WHOLE generation against the cancel signal — not just the poll
    // loop. David 2026-06-16 (web build): "Stop" sat on "stopping…" forever
    // because generateImage was stuck BEFORE the poll loop (fetchCaps /
    // buildDynamicWorkflow — /object_info fetches that can hang through a web
    // proxy), and the cancel flag was only checked inside pollAndExtract /
    // ensureComfyRunning. Wrapping the entire generate call means Stop returns
    // "cancelled" within ms from ANY phase (caps fetch, workflow build, image
    // upload, submit, poll). The abandoned promise keeps running in the
    // background but its output is ignored; requestGenerationCancel already
    // fired /interrupt + queue-clear, and the finally restores the text model.
    const genPromise = kind === 'image'
      ? generateImage(prompt, targetModel, args)
      : generateVideo(prompt, targetModel, videoBackend, args)
    const result = await raceCancel(genPromise)
    if (result === CANCELLED) return `${label(kind)} generation cancelled.`
    return result
  } finally {
    _activeHandoffs-- // paired with the increment at the top of the try above
    // ── (d) HANDOFF-BACK — ALWAYS (success, failure, timeout) ──────
    // Free ComfyUI's VRAM first (so the text model has room to reload), then
    // best-effort reload the text model. The reload is non-fatal: if it throws,
    // Ollama will lazy-load on the user's next message anyway.
    emitHandoff('restoring_text', { kind, detail: evictedModel ?? evictedLms?.id ?? undefined })
    // David 2026-06-16 (bug C — RealVisXL "6 min+"): only force a ComfyUI VRAM
    // unload when we ACTUALLY evicted a text model (it needs the room to reload)
    // or the user cancelled (stop the burn). When nothing was evicted — the
    // common image case, where the small chat model and the SDXL checkpoint
    // co-exist — keep ComfyUI's checkpoint resident so the NEXT generation
    // reuses it warm instead of paying the full cold reload every single time.
    if (evictedModel || evictedLms || _genCancelRequested) {
      try {
        await freeMemory()
      } catch { /* best effort */ }
    }
    if (evictedModel) {
      try {
        await loadModel(evictedModel)
      } catch (e) {
        // A heavy video model (e.g. wan2.2 5B on a 12 GB GPU) can leave ComfyUI
        // holding a wedged CUDA context that blocks Ollama from re-initializing
        // the text model: loadModel throws "CUDA error: shared object
        // initialization failed" (David 2026-06-16, E2E). It is NOT an OOM — VRAM
        // is already free — and it survives even an Ollama restart; the only thing
        // that clears it is stopping ComfyUI's process to release its CUDA context.
        // So on that failure class, stop ComfyUI and retry the reload ONCE, so the
        // next chat turn finds the model loaded instead of a dead backend. Reactive
        // by design: svd / lighter models never throw here, so they never pay the
        // ComfyUI restart (the next generation lazily restarts it via ensureComfyRunning).
        const msg = String(e instanceof Error ? e.message : e)
        log.warn('vram_handoff.reload_failed', { textModel: evictedModel, err: msg })
        if (/cuda|shared object|0xc0000409/i.test(msg)) {
          try {
            log.warn('vram_handoff.reload_cuda_wedge_recover', { textModel: evictedModel })
            await backendCall('stop_comfyui')
            await sleep(5000) // let the GPU/driver settle after ComfyUI releases the context
            await loadModel(evictedModel)
            log.info('vram_handoff.reload_cuda_wedge_recovered', { textModel: evictedModel })
          } catch (e2) {
            log.warn('vram_handoff.reload_retry_failed', { textModel: evictedModel, err: String(e2 instanceof Error ? e2.message : e2) })
          }
        }
      }
    }
    if (evictedLms) {
      try {
        // Restore with the SAME context length it was loaded with (the REST
        // reported it at detect time) — `lms load` without -c would fall back
        // to the model default and silently shrink long chats.
        await backendCall('lmstudio_load_model', {
          model: evictedLms.id,
          ...(evictedLms.contextLength ? { contextLength: evictedLms.contextLength } : {}),
        })
      } catch (e) {
        log.warn('vram_handoff.lms_reload_failed', { lmsModel: evictedLms.id, err: String(e) })
      }
    }
    if (evictedBundled) {
      try {
        // Same model, same settings-derived tuning as every engine start;
        // start_bundled_engine blocks until /health is green, so the slot
        // restore below never races the model load.
        await startBundledEngine(evictedBundled.modelPath)
        if (evictedBundled.slotSaved) {
          const restored = await backendCall<{ ok?: boolean }>('kv_slot_action', { port: evictedBundled.port, action: 'restore' }).catch(() => null)
          if (restored?.ok !== true) {
            // Non-fatal by design: the next turn re-processes the history,
            // exactly the pre-#85 cost.
            log.warn('vram_handoff.kv_restore_failed', { port: evictedBundled.port })
          }
        }
      } catch (e) {
        log.warn('vram_handoff.bundled_reload_failed', { err: String(e) })
      }
    }
    emitHandoff('done', { kind })
  }
}

// ── Generation bodies ─────────────────────────────────────────────

/** Image path — mirrors the legacy executeImageGenerate, via buildDynamicWorkflow. */
async function generateImage(prompt: string, model: string, args: VramHandoffArgs): Promise<string> {
  const { buildDynamicWorkflow } = await import('./dynamic-workflow')
  try {
    // Capability-aware: read this model's REAL limits/enums from ComfyUI and
    // REJECT (not clamp) any explicit user value beyond them (decision 2).
    const caps = await fetchCaps(model, 'image')
    // Per-architecture defaults instead of one hardcoded cfg 7 / 1024² for every
    // image model: Flux/Flux2 are distilled and need cfg 1.0 (cfg 7 fries them),
    // Z-Image Turbo wants ~3.5 / 12 steps, SD1.5 must default to 512² not 1024².
    const idef = MODEL_TYPE_DEFAULTS[classifyModel(model)] ?? MODEL_TYPE_DEFAULTS.unknown
    const tun = resolveTunables(args, caps, { steps: idef.steps, cfg: idef.cfg, sampler: idef.sampler, scheduler: idef.scheduler })
    if (tun.reject) return `Cannot generate: ${tun.reject}`

    const a = args as Record<string, unknown>
    const width = clampInt(a.width, idef.width, 64, 4096)
    const height = clampInt(a.height, idef.height, 64, 4096)
    const seed = (typeof a.seed === 'number' && Number.isFinite(a.seed)) ? Math.floor(a.seed) : -1
    const batchSize = clampInt(a.batchSize ?? a.batch_size, 1, 1, 8)

    // Image-to-image: resolve the referenced output image into ComfyUI's input
    // folder, then let buildDynamicWorkflow wire LoadImage → VAEEncode + denoise.
    let inputImage: string | undefined
    let denoise: number | undefined
    if (typeof args.inputImage === 'string' && args.inputImage) {
      inputImage = (await resolveInputImage(args.inputImage)).name
      denoise = clampFloat(args.denoise, 0.6, 0.05, 1.0)
    }
    const workflow = await buildDynamicWorkflow(
      {
        prompt,
        negativePrompt: typeof args.negativePrompt === 'string' ? args.negativePrompt : '',
        model,
        sampler: tun.sampler,
        scheduler: tun.scheduler,
        steps: tun.steps,
        cfgScale: tun.cfg,
        width,
        height,
        seed,
        batchSize,
        // Multi-LoRA (konata): accept a single name, an array, or a comma-
        // joined string; same for strengths. buildDynamicWorkflow normalizes
        // and chains them — invalid shapes are simply dropped here.
        ...(typeof a.lora === 'string' && a.lora
          ? { lora: a.lora as string }
          : Array.isArray(a.lora) && (a.lora as unknown[]).some((x) => typeof x === 'string' && x)
            ? { lora: (a.lora as unknown[]).filter((x): x is string => typeof x === 'string' && !!x) }
            : {}),
        ...(typeof a.loraStrength === 'number'
          ? { loraStrength: a.loraStrength as number }
          : Array.isArray(a.loraStrength) && (a.loraStrength as unknown[]).some((x) => typeof x === 'number')
            ? { loraStrength: (a.loraStrength as unknown[]).filter((x): x is number => typeof x === 'number') }
            : {}),
        ...(typeof a.vae === 'string' && a.vae ? { vae: a.vae as string } : {}),
        ...(typeof a.clipSkip === 'number' ? { clipSkip: a.clipSkip as number } : {}),
        ...(inputImage ? { inputImage, denoise } : {}),
      },
      classifyModel(model),
    )
    // Phase markers (chat-agent hang 2026-06-03): make it obvious in the log
    // whether a stall is in the workflow build (/object_info) or the submit
    // (/prompt). Both are now timeout-bounded, so neither can strand the
    // hand-off with the text model unloaded — these logs just pinpoint where.
    log.info('vram_handoff.image.submit', { model, i2i: !!inputImage })
    const promptId = await submitWorkflow(workflow, CLIENT_ID)
    log.info('vram_handoff.image.submitted', { promptId })
    const result = await pollAndExtract(promptId, prompt, label('image'), getImageTimeoutMs())
    // Remember the produced filename so a follow-up "animate it" video call can
    // fall back to it when the model passes a wrong/hallucinated inputImage.
    const fn = result.match(/generated:\s*([^\s(]+\.(?:png|jpe?g|webp))/i)
    // Don't let an abandoned (cancelled) gen that finishes in the background
    // overwrite the filename a later "animate it" might pick up.
    if (fn && !_genCancelRequested) _lastImageFilename = fn[1]
    return result
  } catch (err) {
    // Surface ComfyUI's message verbatim — an OOM must NOT be masked.
    return `${label('image')} generation failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Video path — buildTxt2VidWorkflow with MODEL_TYPE_DEFAULTS + snapToVideoGrid. */
async function generateVideo(
  prompt: string,
  model: string,
  backend: VideoBackend,
  args: VramHandoffArgs,
): Promise<string> {
  try {
    const type = classifyModel(model)
    // Capability-aware (decision 2): real per-model limits/enums from ComfyUI.
    const caps = await fetchCaps(model, 'video')

    // ── Wan 2.2 TI2V-5B: one model, both modes ─────────────────────
    // Wan22ImageToVideoLatent takes an OPTIONAL start_image, so a single dynamic
    // path serves text-to-video (no still) AND image-to-video (still → the clip
    // opens on it). Handle it HERE, before the SVD/FramePack I2V branch — wan22 now
    // matches isI2VModel(), but that branch's 25-frame / 8-fps tuning would butcher
    // it (wan22 is 24 fps, up to ~7 s). buildDynamicWorkflow routes to buildWan22.
    if (type === 'wan22') {
      const { buildDynamicWorkflow } = await import('./dynamic-workflow')
      const d = MODEL_TYPE_DEFAULTS.wan22
      const av = args as Record<string, unknown>

      // Optional source still (I2V). A wrong/hallucinated name falls back to the
      // last image LU produced this session — same recovery as the SVD path.
      let inputImage: string | undefined
      let srcW = 0
      let srcH = 0
      if (typeof args.inputImage === 'string' && args.inputImage) {
        let resolved: ResolvedInputImage
        try {
          resolved = await resolveInputImage(args.inputImage)
        } catch (e) {
          if (_lastImageFilename) {
            log.warn('vram_handoff.i2v_input_fallback', { bad: String(args.inputImage), fallback: _lastImageFilename })
            resolved = await resolveInputImage(_lastImageFilename)
          } else {
            throw e
          }
        }
        inputImage = resolved.name
        srcW = resolved.width
        srcH = resolved.height
      }

      const frameRej = videoFrameReject(model, args, caps)
      if (frameRej) return frameRej
      // 24 fps native; up to ~7 s (169 frames). resolveClip honors `seconds`/`frames`.
      const vMax = caps?.frameRange?.max ?? 169
      const { frames, fps } = resolveClip(args, { defFps: d.fps, defFrames: d.frames, maxFrames: vMax })
      const tun = resolveTunables(args, caps, { steps: d.steps, cfg: d.cfg, sampler: d.sampler, scheduler: d.scheduler })
      if (tun.reject) return `Cannot generate: ${tun.reject}`
      // resolveTunables falls back to the generic KSampler caps default (cfg 8 /
      // 20 steps) over our model default. Wan 2.2 5B over-cooks at cfg 8 — its
      // known-good sampling is cfg ~5 / ~30 steps. Honor an explicit user ask,
      // else force the Wan default (David 2026-06-11: "Qualität muss stimmen").
      const avq = args as Record<string, unknown>
      const tunSteps = avq.steps !== undefined ? tun.steps : d.steps
      const tunCfg = (avq.cfg ?? avq.cfg_scale ?? avq.cfgScale) !== undefined ? tun.cfg : d.cfg

      // I2V → resolution from the source aspect (faithful framing); T2V → model default.
      const base = inputImage ? resolveI2VResolution('wan22', srcW, srcH) : { width: d.width, height: d.height }
      const snapped = snapToVideoGrid(clampInt(av.width, base.width, 64, 2048), clampInt(av.height, base.height, 64, 2048))
      const seed = (typeof av.seed === 'number' && Number.isFinite(av.seed)) ? Math.floor(av.seed) : -1

      const workflow = await buildDynamicWorkflow(
        {
          prompt,
          negativePrompt: typeof args.negativePrompt === 'string' ? args.negativePrompt : '',
          model,
          sampler: tun.sampler,
          scheduler: tun.scheduler,
          steps: tunSteps,
          cfgScale: tunCfg,
          width: snapped.width,
          height: snapped.height,
          seed,
          batchSize: 1,
          frames,
          fps,
          ...(inputImage ? { inputImage } : {}),
        },
        type,
      )
      log.info('vram_handoff.video.submit', { model, mode: inputImage ? 'i2v' : 't2v', wan22: true, steps: tunSteps, cfg: tunCfg })
      const promptId = await submitWorkflow(workflow, CLIENT_ID)
      log.info('vram_handoff.video.submitted', { promptId })
      return await pollAndExtract(promptId, prompt, label('video'), getVideoTimeoutMs())
    }

    // ── Image-to-video (SVD / FramePack) ───────────────────────────
    // Resolve the still into ComfyUI's input folder and route through the
    // dynamic builder's I2V strategy. Conservative size + low frame count keep
    // it inside 12 GB; SVD bundles its own CLIP-vision + VAE in the checkpoint.
    if (typeof args.inputImage === 'string' && args.inputImage && isI2VModel(model)) {
      const { buildDynamicWorkflow } = await import('./dynamic-workflow')
      // Resolve the source still; if the model gave a wrong/hallucinated name,
      // fall back to the last image LU actually produced this session.
      let resolved: ResolvedInputImage
      try {
        resolved = await resolveInputImage(args.inputImage)
      } catch (e) {
        if (_lastImageFilename) {
          log.warn('vram_handoff.i2v_input_fallback', { bad: String(args.inputImage), fallback: _lastImageFilename })
          resolved = await resolveInputImage(_lastImageFilename)
        } else {
          throw e
        }
      }
      const inputImage = resolved.name
      // SVD-XT genuinely caps ~25 frames. FramePack PACKS long video, so its real
      // ceiling comes from getModelCapabilities (request-driven — David 2026-06-04:
      // "FramePacks frame cap anheben durch input von uns"). REJECT (not clamp) an
      // explicit over-limit request so the user sees the actual max (decision 2).
      const defFps = type === 'framepack' ? 16 : 8
      const frameRej = videoFrameReject(model, args, caps)
      if (frameRej) return frameRej
      const i2vMax = caps?.frameRange?.max ?? (type === 'framepack' ? FRAMEPACK_MAX_FRAMES : 25)
      const { frames, fps } = resolveClip(args, { defFps, defFrames: type === 'framepack' ? 49 : 25, maxFrames: i2vMax })
      const tun = resolveTunables(args, caps, { steps: type === 'framepack' ? 25 : 20, cfg: 3, sampler: 'euler', scheduler: 'normal' })
      if (tun.reject) return `Cannot generate: ${tun.reject}`
      const av = args as Record<string, unknown>
      // Resolution from the SOURCE aspect ratio (David 2026-06-11: portrait
      // stills came back as squished landscape that no longer matched the
      // input). An explicit user width/height still wins; otherwise we pick the
      // model's native bucket and an ImageScale(crop:center) fills it cleanly.
      const native = resolveI2VResolution(type, resolved.width, resolved.height)
      const snapped = snapToVideoGrid(
        clampInt(av.width, native.width, 64, 2048),
        clampInt(av.height, native.height, 64, 2048),
      )
      const seed = (typeof av.seed === 'number' && Number.isFinite(av.seed)) ? Math.floor(av.seed) : -1
      const motionBucketId = clampInt(av.motionBucketId ?? av.motion_bucket_id, 90, 1, 255)
      const workflow = await buildDynamicWorkflow(
        {
          prompt,
          negativePrompt: typeof args.negativePrompt === 'string' ? args.negativePrompt : '',
          model,
          sampler: tun.sampler,
          scheduler: tun.scheduler,
          steps: tun.steps,
          cfgScale: tun.cfg,
          width: snapped.width,
          height: snapped.height,
          seed,
          batchSize: 1,
          frames,
          fps,
          inputImage,
          motionBucketId,
        },
        type,
      )
      log.info('vram_handoff.video.submit', { model, i2v: true })
      const promptId = await submitWorkflow(workflow, CLIENT_ID)
      log.info('vram_handoff.video.submitted', { promptId })
      return await pollAndExtract(promptId, prompt, label('video'), getVideoTimeoutMs())
    }

    // ── Text-to-video ──────────────────────────────────────────────
    const defaults = MODEL_TYPE_DEFAULTS[type] ?? MODEL_TYPE_DEFAULTS.wan
    // Text-to-video (Wan/Hunyuan/etc.) can run longer than SVD. Real ceiling from
    // getModelCapabilities; REJECT (not clamp) an explicit over-limit request.
    const tFrameRej = videoFrameReject(model, args, caps)
    if (tFrameRej) return tFrameRej
    const t2vMax = caps?.frameRange?.max ?? Math.max(defaults.frames, 161)
    const { frames, fps } = resolveClip(args, { defFps: defaults.fps, defFrames: defaults.frames, maxFrames: t2vMax })
    const tun = resolveTunables(args, caps, { steps: defaults.steps, cfg: defaults.cfg, sampler: defaults.sampler, scheduler: defaults.scheduler })
    if (tun.reject) return `Cannot generate: ${tun.reject}`
    const av = args as Record<string, unknown>
    const snapped = snapToVideoGrid(clampInt(av.width, defaults.width, 64, 2048), clampInt(av.height, defaults.height, 64, 2048))
    const seed = (typeof av.seed === 'number' && Number.isFinite(av.seed)) ? Math.floor(av.seed) : -1

    const workflow = await buildTxt2VidWorkflow(
      {
        prompt,
        negativePrompt: typeof args.negativePrompt === 'string' ? args.negativePrompt : '',
        model,
        sampler: tun.sampler,
        scheduler: tun.scheduler,
        steps: tun.steps,
        cfgScale: tun.cfg,
        width: snapped.width,
        height: snapped.height,
        seed,
        batchSize: 1,
        frames,
        fps,
      },
      backend,
    )
    log.info('vram_handoff.video.submit', { model, i2v: false, backend })
    const promptId = await submitWorkflow(workflow, CLIENT_ID)
    log.info('vram_handoff.video.submitted', { promptId })
    return await pollAndExtract(promptId, prompt, label('video'), getVideoTimeoutMs())
  } catch (err) {
    return `${label('video')} generation failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

let _cpuRenderFacts: CpuRenderFacts | null = null

/**
 * Which device LU's ComfyUI is actually on, for the failure messages.
 *
 * Asked only when a render is about to fail, so a healthy render never pays for
 * the call. `null` on any error and on the web build, where the notice simply
 * stays as it was. The answer is cached for the watchdogs in useCreate, which
 * fire from a timer and cannot await anything.
 */
export async function cpuRenderFacts(): Promise<CpuRenderFacts | null> {
  try {
    const s = await backendCall<{ startedCpu?: boolean | null; hasAmd?: boolean | null }>('get_comfy_gpu_status')
    if (!s) return null
    _cpuRenderFacts = { startedCpu: s.startedCpu === true, hasAmd: s.hasAmd === true, isWindows: isWindows() }
    return _cpuRenderFacts
  } catch {
    return null
  }
}

/** The last answer `cpuRenderFacts()` got, for callers that cannot await. */
export function lastCpuRenderFacts(): CpuRenderFacts | null {
  return _cpuRenderFacts
}

/**
 * Poll ComfyUI history until the prompt completes, then build the result string
 * in the exact legacy shape so ToolCallBlock renders it inline and useAgentChat
 * feeds it back to the model unchanged. On a ComfyUI-side error, surface the
 * message VERBATIM (Bug-G / honest-UX: an OOM reads as an OOM).
 */
async function pollAndExtract(promptId: string, prompt: string, kindLabel: string, timeoutMs: number): Promise<string> {
  // G19-1 render budget: read the pace off ComfyUI's own progress events and
  // give up EARLY, with the job cancelled, once the projection says the render
  // cannot land inside the budget (R32: a 30 to 60 minute Wan job burned the
  // GPU for the full deadline and was then orphaned by the timeout). No WS is
  // fine: the pace stays empty and only the flat deadline applies.
  const pace = new PaceTracker()
  // G24: the swap/model-load phase emits NO progress events, so the pace
  // tracker stays silent through it and a generous user timeout never ends it
  // (R17c: 19 minutes of "loading model into VRAM"). Track whether ANY prompt
  // progressed; if the WS is alive and nothing on the GPU has moved for the
  // whole warm-up budget, the load is wedged and the job gets abandoned.
  //
  // Z36 finding 4 (W3 run 2026-08-16): a forced z_image_bf16 render in the chat
  // tool was abandoned after 352.6 s while the Create tab renders the same job.
  // The first load of the big bf16 checkpoint on a 3060 outlasted the warm-up
  // budget, and neither guard here could tell a slow load from a wedged one.
  // Two things change. The warm-up guard asks ComfyUI whether the prompt is
  // still queued before calling the load wedged, the same life signal the
  // Create watchdog uses. And the flat deadline is recomputed every tick with
  // the measured load phase added, so the render budget is spent on the render.
  // The pace verdict keeps the RAW budget, so a hopeless render (R32) still
  // dies after three sampler steps.
  const startedAt = Date.now()
  let sawAnyProgress = false
  let firstOwnProgressAt: number | null = null
  let finishGraceUsed = 0
  // Z36 finding 4, second half: before calling a long load wedged, ask ComfyUI
  // whether our prompt is still in its queue. That is the same life signal the
  // Create watchdog uses (useCreate: isPromptQueued refreshes lastActivity), and
  // it is the reason the Create tab finishes a render the agent path abandoned.
  // Asked only once the plain warm-up budget is spent, and at most every 30 s,
  // so a healthy render never pays for the extra request.
  let promptAlive = false
  let aliveCheckedAt = 0
  const offProgress = comfyWS.on((ev) => {
    if (ev.type === 'progress') {
      sawAnyProgress = true
      if (ev.data.prompt_id === promptId) {
        const at = Date.now()
        if (firstOwnProgressAt === null) firstOwnProgressAt = at
        pace.tick(ev.data.value, ev.data.max, at)
      }
    }
  })
  void comfyWS.connect().catch(() => { /* degrade to the flat deadline */ })
  try {
    for (;;) {
      const deadline = startedAt + timeoutMs
        + loadPhaseGraceMs(comfyWS.connected, startedAt, firstOwnProgressAt, Date.now(), warmupBudgetMs(promptAlive))
        + finishGraceUsed
      if (Date.now() >= deadline) {
        // Adopt a render that is seconds from done instead of throwing away the
        // load and the sampling it already paid for. Granted at most once.
        const grace = finishGraceUsed === 0 ? finishGraceMs(pace.projectedRemainingMs()) : 0
        if (grace > 0) {
          finishGraceUsed = grace
          log.info('vram_handoff.render_finish_grace', { promptId, graceMs: grace })
          continue
        }
        // Deadline reached: the wait ends AND the job ends. The old return here
        // walked away and left the render burning the GPU with no owner.
        const elapsedMs = Date.now() - startedAt
        log.warn('vram_handoff.render_timeout_abort', { promptId, budgetMs: timeoutMs, elapsedMs })
        await abandonPrompt(promptId)
        return renderTimeoutNotice(kindLabel, timeoutMs, elapsedMs, await cpuRenderFacts())
      }
      // User hit the in-chat cancel button — ComfyUI was already sent /interrupt
      // + queue-clear by requestGenerationCancel(); stop polling so runHandoff's
      // finally can restore the text model into VRAM instead of waiting out the
      // timeout. RACE both the sleep AND the getHistory against the cancel signal
      // (bug B): a cold checkpoint load makes getHistory block for up to its 15 s
      // cap, so a between-ticks-only check kept "stopping…" on screen for seconds.
      if (_genCancelRequested) return `${kindLabel} generation cancelled.`
      if ((await raceCancel(sleep(1000))) === CANCELLED) return `${kindLabel} generation cancelled.`
      const history = await raceCancel(getHistory(promptId))
      if (history === CANCELLED) return `${kindLabel} generation cancelled.`
      if (history?.status?.completed) {
        const outputs = history.outputs ?? {}
        for (const nodeId of Object.keys(outputs)) {
          const files = extractComfyOutputFiles(outputs[nodeId])
          if (files.length > 0) {
            const f = files[0]
            const url = getImageUrl(f.filename, f.subfolder ?? '', f.type ?? 'output')
            return `${kindLabel} generated: ${f.filename} (prompt: "${prompt}")\n${url}`
          }
        }
        return `${kindLabel} generation completed but no output produced.`
      }
      if (history?.status?.status_str === 'error') {
        // Pull the richest detail ComfyUI gives us: an execution_error carries
        // node_type + exception_type + exception_message (the plain `message`
        // field is usually empty for node errors — David 2026-06-11, FramePack).
        const errEntry = history.status.messages?.find((m: any) => m?.[0] === 'execution_error')?.[1]
        const rawMsg = errEntry?.exception_message
          || history.status.messages?.map((m: any) => m?.[1]?.message).filter(Boolean).join(' | ')
          || history.status.messages?.[0]?.[1]?.message
          || 'Unknown ComfyUI error'
        const hint = comfyErrorHint(errEntry?.node_type, errEntry?.exception_type, String(rawMsg))
        return `${kindLabel} generation failed: ${rawMsg}${hint ? `\n\n${hint}` : ''}`
      }
      const projected = pace.projectedTotalMs()
      if (overBudget(projected, timeoutMs)) {
        log.warn('vram_handoff.render_budget_abort', { promptId, projectedMs: Math.round(projected!), budgetMs: timeoutMs })
        await abandonPrompt(promptId)
        return renderBudgetNotice(kindLabel, projected!, timeoutMs, await cpuRenderFacts())
      }
      const warmupElapsed = Date.now() - startedAt
      if (!sawAnyProgress && warmupElapsed > SWAP_WARMUP_BUDGET_MS && Date.now() - aliveCheckedAt > 30_000) {
        aliveCheckedAt = Date.now()
        promptAlive = await isPromptQueued(promptId)
      }
      if (warmupExceeded(sawAnyProgress, comfyWS.connected, warmupElapsed, warmupBudgetMs(promptAlive))) {
        log.warn('vram_handoff.swap_warmup_abort', { promptId, elapsedMs: warmupElapsed, promptAlive })
        await abandonPrompt(promptId)
        return swapWarmupNotice(kindLabel, warmupElapsed, await cpuRenderFacts())
      }
    }
  } finally {
    offProgress()
  }
}

// ── Small helpers ─────────────────────────────────────────────────

/**
 * Map a known-cryptic ComfyUI node error to an actionable hint (C-fix pattern).
 * Returns '' when we have nothing better to add than the verbatim error.
 * Exported + pure for the unit tests.
 */
export function comfyErrorHint(nodeType: string | undefined, _excType: string | undefined, message: string): string {
  const m = message.toLowerCase()
  // FramePack wrapper version mismatch (David 2026-06-11, RTX 3060): the
  // installed ComfyUI-FramePackWrapper's LoadFramePackModel produces a
  // HyVideoModel its OWN FramePackSampler can't consume. Upstream custom-node
  // bug — independent of LU's workflow (which now loads without OOM).
  if ((nodeType === 'FramePackSampler' || /framepack/i.test(nodeType ?? '')) &&
      m.includes('hyvideomodel') && m.includes('diffusion_model')) {
    return 'This is a bug in the installed ComfyUI-FramePackWrapper custom node (its model loader and sampler are out of sync), not in LU. Update the node from ComfyUI Manager (search "FramePack"), or pick a different image-to-video model (SVD works on 12 GB; Wan 2.2 5B is the recommended higher-quality option).'
  }
  if (m.includes('out of memory') || m.includes('outofmemory') || _excType === 'torch.OutOfMemoryError') {
    return 'Ran out of GPU memory. Try a shorter clip / lower resolution, set VRAM hand-off to "always" in Settings so the chat model is evicted first, or pick a lighter model.'
  }
  // Windows "paging file is too small" (os error 1455, bear5real0o0 GH #61):
  // ComfyUI couldn't commit enough memory while loading a node (often the text
  // encoder / CLIPLoader) because the OS ran out of RAM + pagefile. This is a
  // Windows virtual-memory setting, not an LU bug — point the user at the fix.
  if (m.includes('paging file') || m.includes('os error 1455')) {
    return 'Windows ran out of virtual memory while loading the model (its paging file is too small). This is a Windows setting, not an LU bug. Let Windows manage the page file, or raise it: Settings → System → About → Advanced system settings → Performance → Settings → Advanced → Virtual memory → Change, set a larger custom size, then reboot. Closing other heavy apps or picking a smaller model also helps.'
  }
  return ''
}

function label(kind: 'image' | 'video'): string {
  return kind === 'video' ? 'Video' : 'Image'
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function clampFloat(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

// ── Capability validation helpers (v2.5.0 — reject-and-report, decision 2) ──
//
// REJECT, don't clamp: when the user EXPLICITLY asks for a value beyond the
// installed model's real ComfyUI capability, return a clear message with the
// actual limit so they (or the LLM) can retry lower. Only explicit user values
// are checked — our own defaults are never rejected. Exported for unit tests.

export function clampOrReject(label: string, val: number | undefined, range: { min: number; max: number } | undefined): string | null {
  if (val === undefined || range === undefined) return null
  if (val < range.min) return `${label} ${val} is below this model's minimum ${range.min}. Increase it.`
  if (val > range.max) return `${label} ${val} exceeds this model's maximum ${range.max} (from its ComfyUI capabilities). Lower it to ≤${range.max}, or install a model that supports a higher ${label}.`
  return null
}

export function enumReject(label: string, val: string | undefined, options: string[] | undefined): string | null {
  if (!val || !options || options.length === 0) return null
  return options.includes(val) ? null : `${label} "${val}" is not available on this model. Available: ${options.join(', ')}.`
}

interface Tunables { steps: number; cfg: number; sampler: string; scheduler: string; reject: string | null }

/**
 * Resolve steps/cfg/sampler/scheduler from args (explicit user value → else the
 * model/sane default) and reject explicit out-of-range values. Shared by image +
 * video paths. `reject` is non-null only when the USER asked for something the
 * model can't do.
 */
export function resolveTunables(
  args: VramHandoffArgs,
  caps: ModelCapabilities | null,
  defs: { steps: number; cfg: number; sampler: string; scheduler: string },
): Tunables {
  const a = args as Record<string, unknown>
  // When the user doesn't specify, fall back to the per-MODEL default (defs) — NOT
  // caps?.stepsRange?.default / cfgRange?.default. Those come from ComfyUI's generic
  // KSampler node (20 steps / cfg 8.0 for EVERY model), which over-cooks architectures
  // that need a low cfg (Wan ~6, Flux/Z-Image distilled ~1-3.5) and under-samples ones
  // that want 30 (live 2026-06-22: Wan ran at cfg 8 / 20 steps instead of its 6 / 30).
  // Explicit user values are still range-checked + rejected against caps below.
  const steps = clampInt(args.steps, defs.steps, 1, 10000)
  const cfgRaw = a.cfg ?? a.cfg_scale ?? a.cfgScale
  const cfg = clampFloat(cfgRaw, defs.cfg, 0, 100)
  const samplerRaw = typeof a.sampler === 'string' ? a.sampler : (typeof a.sampler_name === 'string' ? a.sampler_name : undefined)
  const sampler = samplerRaw ?? defs.sampler
  const scheduler = typeof a.scheduler === 'string' ? a.scheduler : defs.scheduler
  // Report the user's RAW ask in the reject message, not the internally clamped value.
  const stepsAsk = a.steps !== undefined ? Number(a.steps) : undefined
  const cfgAsk = cfgRaw !== undefined ? Number(cfgRaw) : undefined
  const reject =
    clampOrReject('steps', stepsAsk, caps?.stepsRange)
    || clampOrReject('cfg', cfgAsk, caps?.cfgRange)
    || (caps?.usesKSampler
      ? (enumReject('sampler', samplerRaw, caps?.availableSamplers)
        || enumReject('scheduler', typeof a.scheduler === 'string' ? scheduler : undefined, caps?.availableSchedulers))
      : null)
  return { steps, cfg, sampler, scheduler, reject }
}

// resolveClip honors a `seconds` request by lowering playback fps down to a floor
// of 4, so the longest clip a frame-capped model can actually deliver is
// maxFrames / 4 seconds.
const MIN_PLAYBACK_FPS = 4

/**
 * Reject (decision 2) ONLY when the request genuinely exceeds what the model can
 * deliver — NOT when resolveClip would still satisfy it by capping frames and
 * slowing playback (that path is the intended behavior, e.g. SVD seconds=4 →
 * 25f@6fps≈4.2s). Two cases:
 *   - explicit `frames` (the exact-count advanced path) → reject if > model max.
 *   - `seconds` (the duration control) → resolveClip slows fps to honor it, so only
 *     reject when even the slowest playback (maxFrames / 4 fps) can't reach it.
 * Exported for unit tests.
 */
export function videoFrameReject(model: string, args: VramHandoffArgs, caps: ModelCapabilities | null): string | null {
  if (!caps) return null
  // Duration-driven models (FramePack): the real ceiling is seconds (total_second_length).
  if (typeof caps.maxSeconds === 'number' && typeof args.seconds === 'number' && args.seconds > caps.maxSeconds + 0.5) {
    return `Cannot generate: ${model} can make at most ${caps.maxSeconds}s of video (you asked for ${args.seconds}s). Shorten it, or install a model that makes longer clips.`
  }
  if (!caps.frameRange) return null
  const max = caps.frameRange.max
  if (typeof args.frames === 'number' && args.frames > 0 && Math.round(args.frames) > max) {
    return `Cannot generate: ${model} supports at most ${max} frames (you requested ${Math.round(args.frames)}). Lower the frame count, or install a model that makes longer clips (e.g. FramePack or Wan).`
  }
  if (typeof args.seconds === 'number' && args.seconds > 0) {
    const deliverableMaxSec = max / MIN_PLAYBACK_FPS
    if (args.seconds > deliverableMaxSec + 0.5) {
      return `Cannot generate: ${model} can make at most ~${Math.floor(deliverableMaxSec)}s (${max} frames). You asked for ${args.seconds}s. Shorten it, or install a model that makes longer clips (e.g. FramePack or Wan).`
    }
  }
  return null
}

/** Fetch model capabilities; non-fatal (null → caller proceeds with defaults, no validation). */
async function fetchCaps(model: string, kind: 'image' | 'video'): Promise<ModelCapabilities | null> {
  try {
    const m = await import('./comfyui-nodes')
    return await m.getModelCapabilities(model)
  } catch (e) {
    log.warn(`vram_handoff.${kind}.caps_failed`, { model, err: String(e) })
    return null
  }
}

/**
 * Resolve a clip's (frames, fps) from the agent's optional `seconds` / `frames`
 * / `fps`, capped to a model's frame limit.
 *
 * David 2026-06-03: chat videos came out ~1 s because the I2V default was a
 * stubby 14 frames @ 8 fps. Now:
 *  - `seconds` is the preferred control → frames = round(seconds * fps).
 *  - When the requested duration needs more frames than the model can make
 *    (SVD-XT tops out ~25), we KEEP the max frames and LOWER the playback fps
 *    so the clip still LASTS ~seconds (honoring the user's "4 second video";
 *    motion is just a touch slower since SVD can't synthesize more frames).
 *  - With no `seconds` and no `frames`, default to the model's full frame count
 *    (e.g. 25 for SVD ≈ ~3 s, not 1.75 s).
 */
export function resolveClip(
  args: VramHandoffArgs,
  opts: { defFps: number; defFrames: number; maxFrames: number },
): { frames: number; fps: number } {
  const fpsBase = clampInt(args.fps, opts.defFps, 1, 60)
  const wantSeconds = clampFloat(args.seconds, 0, 0, 60) // 0 = not requested
  let frames: number
  if (wantSeconds > 0) frames = Math.round(wantSeconds * fpsBase)
  else if (typeof args.frames === 'number' && Number.isFinite(args.frames)) frames = Math.round(args.frames)
  else frames = opts.defFrames
  frames = Math.max(1, Math.min(opts.maxFrames, frames))
  let fps = fpsBase
  // Duration won't fit at fpsBase (frame cap hit) → slow playback to honor it.
  if (wantSeconds > 0 && frames / fpsBase < wantSeconds - 0.25) {
    fps = Math.max(4, Math.min(60, Math.round(frames / wantSeconds)))
  }
  return { frames, fps }
}

/**
 * Turn an `inputImage` argument (a prior generate result's filename, or a /view
 * URL) into a filename inside ComfyUI's *input* folder, ready for LoadImage.
 * Generated images live in ComfyUI's *output* folder, but LoadImage reads from
 * *input* — so we fetch the referenced image and re-upload it via /upload/image.
 */
interface ResolvedInputImage {
  /** Filename in ComfyUI's input folder, ready for a LoadImage node. */
  name: string
  /** Source pixel dimensions (0 when they could not be probed). */
  width: number
  height: number
}

async function resolveInputImage(ref: string): Promise<ResolvedInputImage> {
  let url: string
  let name: string
  if (/^https?:\/\//i.test(ref)) {
    url = ref
    const m = ref.match(/[?&]filename=([^&]+)/)
    name = m ? decodeURIComponent(m[1]) : 'lu_input.png'
  } else {
    name = ref.replace(/^.*[\\/]/, '')
    url = getImageUrl(name, '', 'output')
  }
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`could not read input image "${ref}" (HTTP ${resp.status})`)
  const blob = await resp.blob()
  if (!blob || blob.size === 0) {
    throw new Error(`could not read input image "${ref}", ComfyUI returned an empty file`)
  }
  // Probe the source dimensions so the I2V path can pick the model's native
  // aspect ratio (David 2026-06-11: a portrait still forced into 768×448
  // landscape no longer resembled the source). Best-effort — a probe failure
  // just yields 0×0 and the caller falls back to a sane default.
  let width = 0
  let height = 0
  try {
    const bmp = await createImageBitmap(blob)
    width = bmp.width
    height = bmp.height
    bmp.close()
  } catch { /* dimensions unknown → caller uses defaults */ }
  const file = new File([blob], name, { type: blob.type || 'image/png' })
  const uploaded = await uploadImage(file)
  return { name: uploaded, width, height }
}

/**
 * Pick the generation resolution for an image-to-video model from the SOURCE
 * still's aspect ratio. SVD-XT was trained ONLY at 1024×576 (landscape) and
 * 576×1024 (portrait); feeding it the old fixed 768×448 squished every source
 * and the clip stopped resembling the input. We match the source ORIENTATION
 * to the nearest native bucket; an ImageScale(crop:center) in the workflow
 * then fills it exactly (aspect-fill, no squish). FramePack is far more
 * resolution-flexible, so it just gets a tidy 16-multiple of the source.
 *
 * Exported + pure for the unit tests.
 */
export function resolveI2VResolution(
  type: string,
  srcW: number,
  srcH: number,
): { width: number; height: number } {
  const landscapeDefault = { width: 1024, height: 576 }
  if (!srcW || !srcH || srcW <= 0 || srcH <= 0) {
    return (type === 'svd' || type === 'wan22') ? landscapeDefault : { width: 768, height: 768 }
  }
  const aspect = srcW / srcH
  if (type === 'svd') {
    // Square is closer to landscape than portrait; center-crop handles the rest.
    return aspect >= 0.95 ? { width: 1024, height: 576 } : { width: 576, height: 1024 }
  }
  if (type === 'wan22') {
    // Wan 2.2 5B trains at 1280×704 / 704×1280. Keep the SOURCE aspect (faithful
    // framing) and snap to 32 (the latent grid); an ImageScale(crop:center) in
    // the builder fills it. Budget by TOTAL PIXELS, not the long edge: a square
    // 1024² still (1.05 M px) sits at the VRAM ceiling on a 12 GB 3060 and can't
    // do 5-7 s, while a 16:9 1024×576 (0.59 M px) runs the whole matrix. ~0.6 M
    // px keeps every aspect tractable on 12 GB (David 2026-06-11: 5B I2V must be
    // PRACTICAL + good, not just native-res-but-OOM).
    const BUDGET_PX = 600_000
    let w = srcW
    let h = srcH
    const px = w * h
    if (px > BUDGET_PX) {
      const s = Math.sqrt(BUDGET_PX / px)
      w = Math.round(w * s)
      h = Math.round(h * s)
    }
    const snap = (v: number) => Math.max(64, Math.round(v / 32) * 32)
    return { width: snap(w), height: snap(h) }
  }
  // FramePack / others: keep the real aspect, snap to a 16-multiple, cap the
  // long edge so a 12 GB card stays safe.
  const cap = 768
  let w = srcW
  let h = srcH
  if (Math.max(w, h) > cap) {
    const s = cap / Math.max(w, h)
    w = Math.round(w * s)
    h = Math.round(h * s)
  }
  const snap = (v: number) => Math.max(64, Math.round(v / 16) * 16)
  return { width: snap(w), height: snap(h) }
}

function getImageTimeoutMs(): number {
  // ~5 min default per spec; respect the user's imageGenTimeoutMinutes if set.
  try {
    const mins = readSettingNumber('imageGenTimeoutMinutes')
    if (mins && mins > 0) return mins * 60_000
  } catch { /* ignore */ }
  return 5 * 60_000
}

function getVideoTimeoutMs(): number {
  // ~10 min default per spec; respect videoGenTimeoutMinutes if set.
  try {
    const mins = readSettingNumber('videoGenTimeoutMinutes')
    if (mins && mins > 0) return mins * 60_000
  } catch { /* ignore */ }
  return 10 * 60_000
}

function getExclusiveVramMode(): ExclusiveVramMode {
  try {
    const m = useSettingsStore.getState().settings.exclusiveVramMode
    if (m === 'auto' || m === 'always' || m === 'never') return m
  } catch { /* store not available */ }
  return 'auto'
}

function readSettingNumber(key: 'imageGenTimeoutMinutes' | 'videoGenTimeoutMinutes'): number | null {
  try {
    const v = useSettingsStore.getState().settings[key]
    return typeof v === 'number' ? v : null
  } catch {
    return null
  }
}

// ..................................................................
// Create-tab render juggling (Z36 finding 1, W3 run 2026-08-16)
//
// The Create/music/video lanes used to free VRAM with one bare
// `offload_local_models` call: both llama processes died with no KV save and
// nobody reloaded them, so the next chat turn paid a measured 62 s cold
// start. These two functions give that path the same discipline the agent
// hand-off above has: capture what is resident, save the built-in engine's
// KV slot, evict, and after the render bring everything back warm.
//
// The eviction itself stays as eager as before. The render should own the
// whole card; a resident chat model forces ComfyUI into heavy CPU offload
// even when nothing OOMs, so unlike the agent path there is no fits-or-not
// math here. One exception: exclusiveVramMode 'never' now really means
// never, matching decideUnload's contract for the agent path.

export interface RenderEviction {
  /** Ollama model that was resident in VRAM and should come back. */
  ollamaModel: string | null
  /** LM Studio model (with its loaded context length) to reload. */
  lms: LmsTextModel | null
  /** Built-in llama-server to restart, and whether its KV slot was saved. */
  bundled: (BundledTarget & { slotSaved: boolean }) | null
}

const EMPTY_EVICTION: RenderEviction = { ollamaModel: null, lms: null, bundled: null }

function evictionEmpty(e: RenderEviction): boolean {
  return !e.ollamaModel && !e.lms && !e.bundled
}

// Evict/restore pairs run serialised through one chain so they never overlap.
// A finished render parks its haul in _pendingRestore for a short grace
// window; a NEW eviction inside that window inherits the haul instead of
// letting it load, so back-to-back renders skip the pointless reload cycle.
let _renderJuggle: Promise<unknown> = Promise.resolve()
let _renderEpoch = 0
let _pendingRestore: RenderEviction | null = null
export const RENDER_RESTORE_GRACE_MS = 2_000

/** Test-only: reset the render-juggle chain state between unit tests. */
export function __resetRenderJuggleForTests(): void {
  _renderJuggle = Promise.resolve()
  _renderEpoch = 0
  _pendingRestore = null
}

function mergeEvictions(base: RenderEviction | null, add: RenderEviction): RenderEviction {
  if (!base) return add
  return {
    ollamaModel: add.ollamaModel ?? base.ollamaModel,
    lms: add.lms ?? base.lms,
    bundled: add.bundled ?? base.bundled,
  }
}

/**
 * Free the GPU for a Create-tab render, remembering what was evicted so
 * restoreChatBackendsAfterRender can bring it back. Never throws; a failed
 * probe just means that backend is not in the haul.
 */
export function evictChatBackendsForRender(): Promise<RenderEviction> {
  _renderEpoch++
  const run = _renderJuggle.catch(() => {}).then(() => evictBody())
  _renderJuggle = run.catch(() => {})
  return run.catch(() => ({ ...EMPTY_EVICTION }))
}

async function evictBody(): Promise<RenderEviction> {
  // A restore that has not run yet is inherited wholesale: whatever it wanted
  // to bring back stays evicted and becomes THIS render's restore duty.
  const inherited = _pendingRestore
  _pendingRestore = null

  if (getExclusiveVramMode() === 'never') {
    // The user opted out of VRAM juggling; do not touch the resident chat
    // backends. An inherited haul still needs restoring after this render.
    return inherited ?? { ...EMPTY_EVICTION }
  }

  const result: RenderEviction = { ...EMPTY_EVICTION }

  // Capture BEFORE the kill so the restore list is honest.
  if (isOllamaLocal()) {
    try {
      const resident = await getResidentModels()
      const target = pickResidentOllamaTarget(resident, getActiveAgentModel())
      if (target) result.ollamaModel = target.name
    } catch { /* nothing resident to remember */ }
  }
  try {
    const lms = (await detectLmsTextModel(getActiveAgentModel())) ?? (await detectAnyLoadedLmsModel())
    if (lms) result.lms = lms
  } catch { /* LM Studio absent */ }
  const bundled = await detectBundledEngine()
  if (bundled) {
    // GH #85 discipline for the Create path too: serialize the KV cache so
    // the reload after the render does not re-process the whole history.
    const saved = await backendCall<{ ok?: boolean }>('kv_slot_action', { port: bundled.port, action: 'save' }).catch(() => null)
    if (saved?.ok !== true) log.warn('render_juggle.kv_save_failed', { port: bundled.port })
    result.bundled = { ...bundled, slotSaved: saved?.ok === true }
  }

  // The actual eviction, exactly the pair of calls the Create tab always
  // made: offload_local_models stops Ollama residents and both managed
  // sidecars, lmstudio_unload_model clears LM Studio. Best effort, a failed
  // call must never block a render.
  await Promise.all([
    backendCall('offload_local_models', { includeComfyui: false }).catch(() => {}),
    backendCall('lmstudio_unload_model', { model: '--all' }).catch(() => {}),
  ])

  // Merge an inherited haul: it describes models that are STILL evicted from
  // an earlier render whose restore never ran. Fresh captures win on
  // conflict, they are the newer truth about the same backend.
  const merged = inherited ? mergeEvictions(inherited, result) : result
  log.info('render_juggle.evicted', {
    ollama: merged.ollamaModel,
    lms: merged.lms?.id ?? null,
    bundled: merged.bundled?.modelPath ?? null,
  })
  return merged
}

/**
 * Bring the evicted chat backends back after a render (success, failure or
 * cancel). Waits a short grace window first so a follow-up render can take
 * over the haul instead of paying reload-then-evict. Never throws.
 */
export function restoreChatBackendsAfterRender(
  evicted: RenderEviction,
  graceMs: number = RENDER_RESTORE_GRACE_MS,
): Promise<void> {
  // Snapshot the epoch AT CALL TIME, not when the body gets its turn on the
  // chain: an eviction that lands in between must count as "newer render".
  const myEpoch = _renderEpoch
  const run = _renderJuggle.catch(() => {}).then(() => restoreBody(evicted, graceMs, myEpoch))
  _renderJuggle = run.catch(() => {})
  return run.catch(() => {})
}

async function restoreBody(evicted: RenderEviction, graceMs: number, myEpoch: number): Promise<void> {
  if (evictionEmpty(evicted)) return
  _pendingRestore = mergeEvictions(_pendingRestore, evicted)
  if (_renderEpoch !== myEpoch) return // a newer render inherits the haul
  if (graceMs > 0) await sleep(graceMs)
  if (_renderEpoch !== myEpoch) return // a newer render inherits the haul
  const todo = _pendingRestore
  _pendingRestore = null
  if (!todo || evictionEmpty(todo)) return

  // Give the chat backends their VRAM back. freeMemory drops ComfyUI's
  // cached checkpoint; without it the reloads below can OOM right after a
  // big render.
  try { await freeMemory() } catch { /* best effort */ }
  if (todo.bundled) {
    try {
      await startBundledEngine(todo.bundled.modelPath)
      if (todo.bundled.slotSaved) {
        const restored = await backendCall<{ ok?: boolean }>('kv_slot_action', { port: todo.bundled.port, action: 'restore' }).catch(() => null)
        if (restored?.ok !== true) {
          // Non-fatal: the next turn re-processes the history, the pre-#85 cost.
          log.warn('render_juggle.kv_restore_failed', { port: todo.bundled.port })
        }
      }
    } catch (e) {
      log.warn('render_juggle.bundled_reload_failed', { err: String(e instanceof Error ? e.message : e) })
    }
  }
  if (todo.ollamaModel) {
    try {
      await loadModel(todo.ollamaModel)
    } catch (e) {
      // No ComfyUI-restart recovery here on purpose: on the Create tab the
      // user's next step is usually another render, so stopping ComfyUI to
      // rescue a chat model would be the wrong trade. Ollama lazy-loads on
      // the next message anyway.
      log.warn('render_juggle.ollama_reload_failed', { model: todo.ollamaModel, err: String(e instanceof Error ? e.message : e) })
    }
  }
  if (todo.lms) {
    try {
      await backendCall('lmstudio_load_model', {
        model: todo.lms.id,
        ...(todo.lms.contextLength ? { contextLength: todo.lms.contextLength } : {}),
      })
    } catch (e) {
      log.warn('render_juggle.lms_reload_failed', { model: todo.lms.id, err: String(e instanceof Error ? e.message : e) })
    }
  }
  log.info('render_juggle.restored', {
    ollama: todo.ollamaModel,
    lms: todo.lms?.id ?? null,
    bundled: todo.bundled?.modelPath ?? null,
  })
}
