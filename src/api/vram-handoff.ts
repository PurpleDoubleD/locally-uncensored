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

import { setChatBackendsRestore, holdChatBackends } from '../lib/chat-backends-gate'
import { gpuRolesSeparate } from '../lib/gpu-roles'
import { backendCall, ollamaUrl, localFetch, isOllamaLocal, isWindows } from './backend'
import type { ComfyApiGraph } from '../types/comfy-graph'
import { asNumber, asRecordArray, asString, prop } from '../types/json-guards'
import { listRunningModels, loadModel, unloadModel } from './ollama'
import { startBundledEngine } from './engine'
import { getAmdGpuArch } from '../lib/hardware'
import { useSettingsStore } from '../stores/settingsStore'
import { portraitFrame, wantsFullFigure } from '../lib/subject-framing'
import {
  getImageModels,
  getVideoModels,
  detectVideoBackend,
  getSystemVRAM,
  submitWorkflow,
  getHistory,
  freeMemory,
  checkComfyConnection,
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
  hidreamSampling,
  isPromptQueued,
  type VideoBackend,
} from './comfyui'
import type { ModelCapabilities } from './comfyui-nodes'
import { getActiveAgentModel } from './agent-context'
import { comfyWS, CLIENT_ID } from './comfyui-ws'
import { PaceTracker, overBudget, renderBudgetNotice, renderTimeoutNotice, warmupExceeded, swapWarmupNotice, loadPhaseGraceMs, finishGraceMs, warmupBudgetMs, SWAP_WARMUP_BUDGET_MS, type CpuRenderFacts } from '../lib/render-budget'
import { asComfyGpuMode } from '../lib/comfy-cpu-banner'
import { comfyHoldsNoVram } from '../lib/comfy-device'
import { log } from '../lib/logger'
import { renderStallLimitMs } from '../lib/tool-timeout'
import { aspectFrame, parseAspectRatio } from '../lib/aspect-frame'
import { buildWithFixups, wasDeclined } from '../lib/render-fixups'
import { renderFixupDeps } from './render-fixup-deps'
import { cancelFreeAfterRender, freeAfterRenderMode, scheduleFreeAfterRender } from '../lib/free-after-render'

/**
 * Is the ComfyUI we are about to render on running on the processor?
 *
 * R14 Nebenbefund 1: both hand-off paths below evicted the chat engine before
 * every render, including renders on a ComfyUI started with `--cpu`, which
 * holds no VRAM at all. Same reply `cpuRenderFacts` reads, asked separately so
 * this decision never disturbs the cached facts the failure notices use, and
 * so a missing reply (web build, ComfyUI never started by LU) answers `false`
 * and leaves the hand-off exactly as it was.
 */
async function comfyRendersOnCpu(): Promise<boolean> {
  try {
    const s = await backendCall<{ startedCpu?: boolean | null; mode?: string | null }>('get_comfy_gpu_status')
    return comfyHoldsNoVram({ startedCpu: s?.startedCpu === true, mode: asComfyGpuMode(s?.mode) })
  } catch {
    return false
  }
}

/**
 * Resolve a casual model name the user/LLM typed (e.g. "FramePack", "wan",
 * "sdxl") to an actually-installed model FILENAME. 2026-06-04: no end user
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
    const data: unknown = await res.json()
    return asRecordArray(prop(data, 'models')).map((m) => ({
      // `||`, not `??`: an empty `name` has to fall through to `model` the way
      // it always did.
      name: asString(m.name) || asString(m.model) || '',
      sizeVram: asNumber(m.size_vram) ?? 0,
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
  // Qwen-Image 2.1, int8_convrot pipeline: about 16 GiB with the DiT, the
  // Qwen3-VL 8B encoder and the VAE all resident. Rounded up, like the rest
  // of this table, so 'auto' errs toward freeing memory.
  qwenimage: 18,
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

/** True only when ComfyUI is neither running nor installed here: a remote
 *  host and a server the user started by hand both count as there. */
async function comfyMissing(): Promise<boolean> {
  try {
    const s = await backendCall<ComfyStatus>('comfyui_status')
    return !!s && s.running !== true && s.found === false
  } catch {
    return false
  }
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
 * ComfyUI up before a chat attachment is uploaded to it (A13, box run
 * 22.10.2026). The upload of "attachment 1" ran before the hand-off had
 * started ComfyUI, so every edit of an attached picture failed with
 * "could not hand attachment 1 to ComfyUI: Failed to upload image" whenever
 * ComfyUI was not already running. Not tied to the generation's cancel
 * channel (that one belongs to the run being built); the call's own signal
 * ends the wait. Returns the line for model and user, or null when it is up.
 */
export async function comfyUpForUpload(signal?: AbortSignal, timeoutMs = 90_000): Promise<string | null> {
  if (await comfyIsRunning()) return null
  if (await comfyMissing()) return 'ComfyUI is not installed on this computer, so the attached picture cannot be used. Install it once from the Create tab, then try again.'
  try { await backendCall('start_comfyui') } catch (e) { log.warn('vram_handoff.start_comfyui_failed', { err: String(e) }) }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return 'cancelled'
    await sleep(1500)
    if (await comfyIsRunning()) return null
  }
  return 'ComfyUI did not start within 90s, so the attached picture could not be handed to it. Start it from the Create tab and try again.'
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
// A user: llama.cpp can serialize a slot's KV cache to disk and restore
// it after a reload. The handoff uses that, so evicting the built-in engine
// for a render no longer costs a full history re-process on the next turn.
// The HTTP rides the Rust side (kv_slot_action): the webview cannot reach the
// engine port, all engine traffic goes through the proxy anyway.

/** What `kv_slot_action` answers. `skipped: 'multimodal'` is an engine running
 *  with its image part: llama-server refuses slot save and restore there with
 *  501, so the Rust side does not ask and logs that once per model. */
export interface KvSlotReply {
  ok?: boolean
  skipped?: string
}

/** Whether a KV save reply is worth a warning. A save that was never possible
 *  is not, or every render with a vision model would warn again (box runs
 *  d307-b and d307-c, H1). */
export function kvSaveWorthAWarning(reply: KvSlotReply | null): boolean {
  return reply?.ok !== true && reply?.skipped !== 'multimodal'
}

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

// ── User-initiated cancel (2026-06-16) ────────────────────────────────
// The agent's AbortController never reached the ComfyUI poll loop, so "Stop"
// left ComfyUI rendering (a ~500 s SVD video kept burning the GPU after the UI
// said it stopped). This module-level flag + ComfyUI /interrupt give the
// in-chat cancel button a REAL abort. Only one generation runs at a time
// (serialised via _inFlight), so one flag suffices.
//
// 2026-06-16 (bug B): a bare flag checked only BETWEEN getHistory calls
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

/**
 * Blocker 4 (review-lanes.md, 3.0.1 lanes Runde 3): every generation, queued
 * or running, remembers the conversation that started it. Without this,
 * `requestGenerationCancel()` had no way to tell "conversation A's still-
 * running image" from "conversation B's just-pressed Stop" apart; a Stop in
 * B killed A's render, literally the B2 "Abbrueche landen in der falschen
 * Unterhaltung" failure case. `null` means "no conversation context" (a
 * caller outside a chat, e.g. the Create tab); it still matches only other
 * `null`-owned generations, never a real conversation's.
 */
const _genOwner = new Map<number, string | null>()
/** Seqs cancelled by a conversation-scoped requestGenerationCancel(convId)
 *  call or by the signal of their own tool call, as opposed to the app-wide
 *  `_cancelledThrough` epoch below (still used by callers that pass no
 *  conversation at all). A13: kept after the run has settled. The run's
 *  promise settles when Stop wins the race, while the abandoned build under
 *  it is still on its way to submitCancellable; deleting the mark there let
 *  that build post its job as soon as the next run's resetCancel() cleared
 *  the flag. A number per stopped render is all it costs. */
const _cancelledSeqs = new Set<number>()
/** The seq of the generation actually executing right now, next to
 *  `_currentGenConvId`: a tool call's signal reaches the live cancel channel
 *  only when its own generation is the one running. */
let _currentSeq = 0
/** The conversation that owns the generation ACTUALLY executing right now
 *  (set at the top of runHandoff, cleared in its finally): generations are
 *  strictly serialised through `_inFlight`, so there is at most one. */
let _currentGenConvId: string | null = null
/**
 * The ComfyUI job THIS lane has in flight, or null.
 *
 * Stop used to fire a blanket `/interrupt` + a FULL `/queue` clear. Both are
 * indiscriminate: the interrupt kills whatever is executing (which is our job
 * only when ours happens to be at the front), and clearing the queue drops the
 * Create tab's render and every job an external ComfyUI tab on the same server
 * has queued. A chat-lane Stop is allowed to remove exactly one thing — the
 * prompt this lane submitted. That is what this id is for.
 */
let _currentPromptId: string | null = null
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

/**
 * `conversationId` scopes the cancel (Blocker 4, review-lanes.md): passing
 * it cancels only THAT conversation's own generations, running or still
 * queued behind another conversation's, and leaves everyone else's alone.
 * Omitting the argument entirely keeps the pre-3.0.1 app-wide behaviour
 * (every generation, any conversation) for callers with no conversation
 * context of their own (`ToolCallBlock`'s "nuke everything" Stop already
 * iterates every conversation's aborter right after this call, so it is
 * meant to be app-wide). Pass `null` for "no conversation, but scoped": it
 * only ever matches another `null`-owned generation, never a real one.
 */
export function requestGenerationCancel(conversationId?: string | null): void {
  if (conversationId === undefined) {
    _genCancelRequested = true
    _cancelledThrough = _genSeq  // cancel every gen created so far (running + queued)
    _cancelNotify?.()            // wake every pending raceCancel immediately
    if (_activeHandoffs > 0 && _currentPromptId) void abandonPrompt(_currentPromptId)
    return
  }
  // Mark every STILL-PENDING generation (queued or running) that belongs to
  // this conversation. runHandoff removes its own seq from `_genOwner` the
  // moment it finishes, so this never touches a generation that already
  // completed.
  for (const [seq, owner] of _genOwner) {
    if (owner === conversationId) _cancelledSeqs.add(seq)
  }
  // Only reach into ComfyUI / the live cancel channel when the ACTIVELY
  // running generation is this conversation's own; otherwise this call
  // owns nothing that is currently executing, and touching `_cancelNotify`
  // or `abandonPrompt` would hit whichever OTHER conversation is running.
  if (conversationId === _currentGenConvId) {
    _genCancelRequested = true
    _cancelNotify?.()
    if (_activeHandoffs > 0 && _currentPromptId) {
      // OUR job, by id, never `/interrupt` + `clear: true`. Those took down
      // the Create tab's render and the user's own ComfyUI tab along with
      // ours, and still missed ours whenever it sat behind someone else's in
      // the queue.
      void abandonPrompt(_currentPromptId)
    }
  }
  // No prompt id yet means nothing was submitted; the pre-submit check in
  // submitCancellable is what keeps it that way.
}

/** Every generation created at or before the last app-wide Stop is
 *  cancelled via the epoch, every generation individually marked by a
 *  conversation-scoped Stop is cancelled via `_cancelledSeqs`, and the
 *  per-run flag (cleared by resetCancel(), unlike either of those) covers
 *  the generation currently executing when ITS OWN conversation was
 *  targeted. An abandoned promise from a cancelled run must consult THIS,
 *  not the flag, or the next run's resetCancel() would quietly
 *  re-authorise it to submit. */
function cancelledFor(seq: number): boolean {
  return _genCancelRequested || seq <= _cancelledThrough || _cancelledSeqs.has(seq)
}

/**
 * Submit a workflow with the user's Stop honoured on BOTH sides of the request.
 *
 * `generateImage` used to go straight from buildDynamicWorkflow to
 * submitWorkflow with no cancel check between them, and runHandoff only raced
 * the OVERALL promise — the abandoned one kept running and posted the job
 * anyway. So Stop, pressed during the (slow, /object_info-bound) workflow
 * build, told the user the generation was cancelled while the GPU started
 * rendering something nobody was watching — with the text model already being
 * reloaded into the same VRAM by the hand-off's finally. Both sides could OOM.
 */
async function submitCancellable(
  workflow: ComfyApiGraph,
  seq: number,
): Promise<string | typeof CANCELLED> {
  if (cancelledFor(seq)) return CANCELLED
  const promptId = await submitWorkflow(workflow, CLIENT_ID)
  _currentPromptId = promptId
  // Stop can land DURING the submit — the check above is already stale by the
  // time ComfyUI answers. Take the job straight back out.
  if (cancelledFor(seq)) {
    log.info('vram_handoff.submit_raced_cancel', { promptId })
    await abandonPrompt(promptId)
    _currentPromptId = null
    return CANCELLED
  }
  return promptId
}


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
  _currentPromptId = null
  _genOwner.clear()
  _cancelledSeqs.clear()
  _currentGenConvId = null
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
 *
 * `conversationId` (Blocker 4, review-lanes.md) is the conversation this
 * generation belongs to, or `null` when there is none (e.g. the Create tab).
 * It is what lets `requestGenerationCancel(convId)` tell this generation
 * apart from one running for a different conversation.
 */
export interface HandoffOptions {
  /** The tool call's own Stop and timeout (A13). Aborting it cancels exactly
   *  this generation: queued, building, rendering, or still at the picker. */
  signal?: AbortSignal
  /** Ask which model to use (api/model-pick) when the call names none. Done
   *  after ComfyUI is up, so the installed list and the saved choice are
   *  read from a running server instead of falling back to the first file. */
  pickModel?: boolean
}

export async function vramHandoffGenerate(
  kind: 'image' | 'video', args: VramHandoffArgs, conversationId: string | null = null,
  opts: HandoffOptions = {},
): Promise<string> {
  const { signal } = opts
  if (signal?.aborted) return `${label(kind)} generation cancelled.`
  return enqueueHandoff(kind, conversationId, (seq) => runHandoff(kind, args, seq, conversationId, undefined, opts.pickModel === true), signal)
}

/**
 * A ComfyUI graph of its own through the same hand-off as image_generate:
 * queued behind any other generation, the chat model moved off the card when
 * the model would not fit next to it, the graph built with the same fix-up
 * question, submitted, polled and the chat model put back. Create over the
 * desktop runs Enhance, Remove Background and Music this way
 * (lib/remote-create-lanes.ts), with the builders the Create tab uses.
 * Resolves to the same result line as image_generate:
 * `<label> generated: <file> (prompt: "...")\n<ComfyUI /view URL>`.
 */
export interface HandoffLane {
  /** Which budget and events it counts as. */
  kind: 'image' | 'video'
  /** The first word of the result line, such as "Music". */
  label: string
  /** The model the footprint estimate reads; '' when there is none. */
  model: string
  /** Prompt text for the result line. */
  prompt: string
  build: () => Promise<ComfyApiGraph>
}

export function vramHandoffLane(lane: HandoffLane, conversationId: string | null = null): Promise<string> {
  return enqueueHandoff(lane.kind, conversationId, (seq) => runHandoff(lane.kind, { prompt: lane.prompt, model: lane.model }, seq, conversationId, lane))
}

function enqueueHandoff(
  kind: 'image' | 'video', conversationId: string | null, body: (seq: number) => Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  // Serialise. We park on the previous call's settled promise (success OR
  // failure — `.catch` swallows so a prior error doesn't reject our chain),
  // then run our own body and expose it as the new tail.
  const seq = ++_genSeq
  _genOwner.set(seq, conversationId)
  // The signal cancels this seq and nothing else: marked for the queue and
  // the abandoned build, and the live channel only when it is the one running.
  const onAbort = () => {
    _cancelledSeqs.add(seq)
    if (_currentSeq !== seq) return
    _genCancelRequested = true
    _cancelNotify?.()
    if (_activeHandoffs > 0 && _currentPromptId) void abandonPrompt(_currentPromptId)
  }
  signal?.addEventListener('abort', onAbort)
  const run = _inFlight
    .catch(() => {})
    .then(() => body(seq))
    // Defensive: runHandoff is written to always RETURN a string (the finally
    // block never rethrows), but if anything unexpected slips through we still
    // hand the agent a clean tool message instead of rejecting the chain.
    .catch((e) => `${kind === 'video' ? 'Video' : 'Image'} generation failed: ${e instanceof Error ? e.message : String(e)}`)
    // Centralised here rather than inside runHandoff's own try/finally:
    // runHandoff has several early returns BEFORE that try (no model
    // installed, ComfyUI unreachable, etc.), and every one of them needs
    // this same cleanup or a finished generation would keep answering
    // "yes" to `requestGenerationCancel`'s ownership checks forever.
    .finally(() => {
      _genOwner.delete(seq)
      signal?.removeEventListener('abort', onAbort)
      if (_currentSeq === seq) _currentSeq = 0
      if (_currentGenConvId === conversationId) _currentGenConvId = null
    })
  _inFlight = run.catch(() => {})
  return run
}

async function runHandoff(
  kind: 'image' | 'video', args: VramHandoffArgs, seq: number, conversationId: string | null, lane?: HandoffLane,
  pickModel = false,
): Promise<string> {
  // Fresh run — re-arm the cancel channel (clears any flag/notify left over from
  // a previous cancelled gen).
  resetCancel()
  // If Stop arrived while THIS gen was still queued behind another (its seq was
  // created at/before the cancel, app-wide epoch, or its OWN conversation
  // cancelled it specifically), bail now. resetCancel() above just cleared the
  // per-run flag, but neither the epoch nor a conversation-scoped mark persist
  // past this check; without it, a back-to-back gen survives the user's Stop.
  if (seq <= _cancelledThrough || _cancelledSeqs.has(seq)) {
    return `${label(kind)} generation cancelled.`
  }
  // From here on, THIS conversation owns the actively-running generation;
  // requestGenerationCancel(convId) reaches ComfyUI/the live cancel channel
  // only when convId matches this.
  _currentGenConvId = conversationId
  _currentSeq = seq
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
  if (!prompt && !lane) {
    // A video call (esp. image-to-video / SVD) can animate without an explicit
    // prompt — default a gentle motion rather than hard-failing on "prompt
    // required" (which made gemma give up mid-chain). Images still need a prompt.
    if (kind === 'video') prompt = 'gentle, subtle natural motion'
    else return `Error: No prompt provided for ${kind} generation.`
  }

  emitHandoff('deciding', { kind })

  // ComfyUI has to be UP before we ask it anything.
  //
  // DECIDE queries the installed models, and getCheckpoints throws while
  // ComfyUI is down — so the run died right here with "Could not query ComfyUI
  // models", and the cold start that would have fixed it sat 250 lines further
  // down, in a phase this return never reached. `image_generate` /
  // `video_generate` from the chat were therefore dead for every user whose
  // ComfyUI was not already running: the chat agent could never start it, while
  // the Create tab started it on the first render. The order is what was wrong,
  // so the order is what changed. Free when ComfyUI is already up (one
  // comfyui_status call), and nothing has been evicted yet if it fails.
  // A13: no install at all is said at once, not after 90 s of waiting for a
  // start that cannot happen, with advice to start what is not there.
  if (await comfyMissing()) {
    emitHandoff('error', { kind, detail: 'ComfyUI is not installed' })
    return `Error: ComfyUI is not installed on this computer, so local ${kind} generation cannot run. Install it once from the Create tab, then try again.`
  }
  const comfyUp = await ensureComfyRunning()
  if (_genCancelRequested) return `${label(kind)} generation cancelled.`
  if (!comfyUp) {
    emitHandoff('error', { kind, detail: 'ComfyUI did not start' })
    return 'Error: ComfyUI did not start within 90s. Start it from the Create tab and try again.'
  }
  // The model picker reads ComfyUI's list. Before A13 it ran before this
  // start, found nothing while ComfyUI was down, and the run took the first
  // file instead of the model chosen in Create or saved in the picker.
  if (pickModel && !(typeof args.model === 'string' && args.model)) {
    const { pickModelForGeneration } = await import('./model-pick')
    const picked = await raceCancel(pickModelForGeneration(kind, args))
    if (picked === CANCELLED) {
      const { useModelPickStore } = await import('../stores/modelPickStore')
      useModelPickStore.getState().cancel()
      return `${label(kind)} generation cancelled.`
    }
    if (picked) args.model = picked
  }

  // ── (a) DECIDE — resolve target model (no side effects yet) ──────
  let targetModel: string
  let videoBackend: VideoBackend = 'none'
  try {
    if (lane) {
      // A lane brings its model and its graph; nothing to pick here.
      targetModel = lane.model
    } else if (kind === 'image') {
      const models = await getImageModels()
      if (models.length === 0) {
        emitHandoff('error', { kind, detail: 'no image model installed' })
        return 'Error: No image model installed. Download one from Models → Get new (e.g. "FLUX.1 [schnell] FP8", "Z-Image Turbo", or "Juggernaut XL V9") and try again.'
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
          return 'Error: Image-to-video needs an I2V model such as SVD. Install one from Models → Get new (e.g. "SVD-XT 1.1 (Image to Video)"), then try again.'
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
          return 'Error: No text-to-video model installed. Download one from Models → Get new (e.g. "Wan 2.1 · 1.3B (Lightweight)" for 8 to 10 GB VRAM or "HunyuanVideo 1.5 T2V FP8" for 12+ GB). Or generate an image first and animate it with an I2V model like "SVD-XT 1.1".'
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
  // R14 Nebenbefund 1: a ComfyUI LU started with `--cpu` never touches the
  // card, so there is no VRAM to hand over. Evicting the chat engine for it
  // buys nothing and costs a full cold reload after every picture. Asked once
  // per generation, and only when there is something that WOULD be evicted.
  const comfyOnCpu = (textModel || lmsTarget || bundledTarget) ? await comfyRendersOnCpu() : false
  if (comfyOnCpu) {
    log.info('vram_handoff.skipped_cpu_comfy', {
      kind,
      targetModel,
      textModel,
      lmsModel: lmsTarget?.id ?? null,
      bundledModel: bundledTarget?.modelPath ?? null,
    })
  }
  if (!comfyOnCpu && (textModel || lmsTarget || bundledTarget)) {
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
      // Two cards, one per service (3.0.8, A2): the chat engine LU starts
      // (LU Engine, Ollama) is pinned to another card than ComfyUI, so taking
      // it off its card frees nothing the render can use and only costs the
      // chat its model. LM Studio picks its card itself, LU cannot pin it, so
      // it keeps the old rule.
      const apart = chatAndComfyApart()
      willUnload = decision.unload && !!textModel && !apart
      willUnloadLms = decision.unload && !!lmsTarget
      willUnloadBundled = decision.unload && !!bundledTarget && !apart
      if (apart && decision.unload && (textModel || bundledTarget)) {
        log.info('vram_handoff.skipped_separate_gpus', { kind, textModel, bundledModel: bundledTarget?.modelPath ?? null })
      }
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
  // While the chat model is off the card for this render, a chat request to a
  // local backend waits until it is back (lib/chat-backends-gate). Before
  // 3.0.8 nothing could ask: the chat waited for the tool. Now the render can
  // go on in the background, and a message sent meanwhile would load the
  // model into the card the render is using.
  let releaseChatHold: (() => void) | null = null

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
    cancelFreeAfterRender() // B27: about to use what was planned to be freed
    if (willUnload || willUnloadLms || willUnloadBundled) {
      releaseChatHold = holdChatBackends(kind === 'video' ? 'video' : 'image')
    }
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
      emitHandoff('freeing_vram', { kind, detail: 'LU Engine' })
      // Carry the conversation across the eviction: serialize the KV cache to
      // disk, then stop the engine. Restore happens in the finally. When
      // either half fails, the next chat turn just re-processes the history,
      // which is exactly the pre-#85 cost — never block the render on it.
      const saved = await backendCall<KvSlotReply>('kv_slot_action', { port: bundledTarget.port, action: 'save' }).catch(() => null)
      if (kvSaveWorthAWarning(saved)) log.warn('vram_handoff.kv_save_failed', { port: bundledTarget.port })
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
    // Re-check, not the first check (that moved above DECIDE). Free when
    // ComfyUI is up, and it earns its keep on the eviction path: unloading a
    // text model and waiting for the VRAM to be released takes seconds, and
    // ComfyUI can die in them.
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
    // loop. 2026-06-16 (web build): "Stop" sat on "stopping…" forever
    // because generateImage was stuck BEFORE the poll loop (fetchCaps /
    // buildDynamicWorkflow — /object_info fetches that can hang through a web
    // proxy), and the cancel flag was only checked inside pollAndExtract /
    // ensureComfyRunning. Wrapping the entire generate call means Stop returns
    // "cancelled" within ms from ANY phase (caps fetch, workflow build, image
    // upload, submit, poll). The abandoned promise keeps running in the
    // background but its output is ignored; requestGenerationCancel already
    // fired /interrupt + queue-clear, and the finally restores the text model.
    const genPromise = lane
      ? generateLane(lane, seq)
      : kind === 'image'
        ? generateImage(prompt, targetModel, args, seq)
        : generateVideo(prompt, targetModel, videoBackend, args, seq)
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
    // 2026-06-16 (bug C — RealVisXL "6 min+"): only force a ComfyUI VRAM
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
        // initialization failed" (2026-06-16, E2E). It is NOT an OOM — VRAM
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
    releaseChatHold?.()
    emitHandoff('done', { kind })
    // B27: ComfyUI's memory goes back when the setting says so, unless
    // another generation is running by then.
    scheduleFreeAfterRender(freeAfterRenderMode(useSettingsStore.getState().settings.freeAfterRender), () => _activeHandoffs > 0)
  }
}

// ── Generation bodies ─────────────────────────────────────────────

/** The agent's tool builds through the same question Create asks: a model
 *  whose companion file is missing or whose ComfyUI is too old gets the
 *  download or the update offered once, then the build runs again. Without it
 *  the chat only ever read "needs ComfyUI 0.37.0 or newer" as a failure. */
function buildFixable<T>(kind: 'image' | 'video', build: () => Promise<T>): Promise<T> {
  return buildWithFixups(build, renderFixupDeps((line) => emitHandoff('loading_image_model', { kind, detail: line })))
}

/** How a build error reads in the tool result. A no to the question is the
 *  user's own decision, not a failure. */
function buildErrorResult(kind: 'image' | 'video', err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return wasDeclined(err)
    ? `${label(kind)} generation was not started. ${message}`
    : `${label(kind)} generation failed: ${message}`
}

/** A lane's own graph: built with the fix-up question, submitted, polled. */
async function generateLane(lane: HandoffLane, seq: number): Promise<string> {
  try {
    const workflow = await buildFixable(lane.kind, lane.build)
    log.info('vram_handoff.lane.submit', { label: lane.label, model: lane.model })
    const submitted = await submitCancellable(workflow, seq)
    if (submitted === CANCELLED) return `${lane.label} generation cancelled.`
    return await pollAndExtract(submitted, lane.prompt, lane.label, lane.kind === 'video' ? getVideoTimeoutMs() : getImageTimeoutMs())
  } catch (err) {
    if (wasDeclined(err)) return `${lane.label} generation was not started. ${err instanceof Error ? err.message : String(err)}`
    return `${lane.label} generation failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Image path — mirrors the legacy executeImageGenerate, via buildDynamicWorkflow. */
async function generateImage(
  prompt: string,
  model: string,
  args: VramHandoffArgs,
  seq: number,
): Promise<string> {
  const { buildDynamicWorkflow } = await import('./dynamic-workflow')
  try {
    // Capability-aware: read this model's REAL limits/enums from ComfyUI and
    // REJECT (not clamp) any explicit user value beyond them (decision 2).
    const caps = await fetchCaps(model, 'image')
    // The family from the file header, the same list Create picks from
    // (Discord 2026-09-26..28): the name alone sent every file it could not
    // place to the checkpoint loader, and ComfyUI refused a model that sits in
    // diffusion_models. The header also says whether the file carries its own
    // text encoder and VAE.
    const listed = (await getImageModels().catch(() => [])).find((m) => m.name === model)
    const type = listed?.type ?? classifyModel(model)
    // Per-architecture defaults instead of one hardcoded cfg 7 / 1024² for every
    // image model: Flux/Flux2 are distilled and need cfg 1.0 (cfg 7 fries them),
    // Z-Image Turbo wants ~3.5 / 12 steps, SD1.5 must default to 512² not 1024².
    const idef = type === 'hidream'
      ? { ...MODEL_TYPE_DEFAULTS.hidream, ...hidreamSampling(model) }
      : MODEL_TYPE_DEFAULTS[type] ?? MODEL_TYPE_DEFAULTS.unknown
    const tun = resolveTunables(args, caps, { steps: idef.steps, cfg: idef.cfg, sampler: idef.sampler, scheduler: idef.scheduler })
    if (tun.reject) return `Cannot generate: ${tun.reject}`

    const a = args as Record<string, unknown>
    // GH #142: a whole figure in the model's square default comes out as a
    // close-up. Nobody named a size and the prompt wants the full figure, so
    // it gets the portrait frame the model was trained on (lib/subject-framing).
    // A13: an asked aspect ratio wins over the full-figure guess, at the
    // pixel count of the model's own size.
    const ratio = parseAspectRatio(a.aspectRatio)
    const frame = a.width == null && a.height == null && ratio != null
      ? aspectFrame(ratio, idef.width, idef.height)
      : a.width == null && a.height == null && !args.inputImage && wantsFullFigure(prompt)
        ? portraitFrame(idef.width)
        : { width: idef.width, height: idef.height }
    const width = clampInt(a.width, frame.width, 64, 4096)
    const height = clampInt(a.height, frame.height, 64, 4096)
    const seed = (typeof a.seed === 'number' && Number.isFinite(a.seed)) ? Math.floor(a.seed) : -1
    const batchSize = clampInt(a.batchSize ?? a.batch_size, 1, 1, 8)

    // Image-to-image: resolve the referenced output image into ComfyUI's input
    // folder, then let buildDynamicWorkflow wire LoadImage → VAEEncode + denoise.
    let inputImage: string | undefined
    let denoise: number | undefined
    if (typeof args.inputImage === 'string' && args.inputImage) {
      inputImage = (await resolveInputImage(args.inputImage)).name
      // 0.75 since A13: at 0.6 the A12 box run kept the picture and lost the
      // asked change ("make it snow" came back with hardly any snow).
      denoise = clampFloat(args.denoise, 0.75, 0.05, 1.0)
    }
    // Qwen-Image 2.1: the agent loads the text encoder the user picked in
    // Create's advanced settings, so a picture made in chat reads the prompt
    // with the same one.
    const { useCreateStore } = await import('../stores/createStore')
    const qwenTextEncoder = useCreateStore.getState().qwenTextEncoder
    const workflow = await buildFixable('image', () => buildDynamicWorkflow(
      {
        prompt,
        negativePrompt: typeof args.negativePrompt === 'string' ? args.negativePrompt : '',
        model,
        ...(qwenTextEncoder !== 'auto' ? { qwenTextEncoder } : {}),
        sampler: tun.sampler,
        scheduler: tun.scheduler,
        steps: tun.steps,
        cfgScale: tun.cfg,
        width,
        height,
        seed,
        batchSize,
        // Multi-LoRA: accept a single name, an array, or a comma-
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
        // Edit (Create over the desktop): further references and a mask,
        // already in ComfyUI's input folder, as Create hands them over.
        ...(inputImage && stagedNames(a.referenceImages).length ? { referenceImages: stagedNames(a.referenceImages) } : {}),
        ...(inputImage && stagedNames([a.maskImage]).length
          ? { maskImage: stagedNames([a.maskImage])[0], growMaskBy: clampInt(a.growMaskBy, 6, 0, 64) }
          : {}),
        ...(listed?.parts ? { modelParts: listed.parts } : {}),
      },
      type,
    ))
    // Phase markers (chat-agent hang 2026-06-03): make it obvious in the log
    // whether a stall is in the workflow build (/object_info) or the submit
    // (/prompt). Both are now timeout-bounded, so neither can strand the
    // hand-off with the text model unloaded — these logs just pinpoint where.
    log.info('vram_handoff.image.submit', { model, i2i: !!inputImage })
    const submitted = await submitCancellable(workflow, seq)
    if (submitted === CANCELLED) return `${label('image')} generation cancelled.`
    const promptId = submitted
    log.info('vram_handoff.image.submitted', { promptId })
    return await pollAndExtract(promptId, prompt, label('image'), getImageTimeoutMs())
  } catch (err) {
    // Surface ComfyUI's message verbatim — an OOM must NOT be masked.
    return buildErrorResult('image', err)
  }
}

/** Video path — buildTxt2VidWorkflow with MODEL_TYPE_DEFAULTS + snapToVideoGrid. */
async function generateVideo(
  prompt: string,
  model: string,
  backend: VideoBackend,
  args: VramHandoffArgs,
  seq: number,
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
    // MiniMax H3 takes the same road: its encode node has an optional first
    // frame, so one graph serves both modes, at 24 fps and up to ~15 s. LTX 2.5
    // does the same through a first frame pinned into its latent.
    if (type === 'wan22' || type === 'minimaxh3' || type === 'ltx25') {
      const { buildDynamicWorkflow } = await import('./dynamic-workflow')
      const d = MODEL_TYPE_DEFAULTS[type]
      const av = args as Record<string, unknown>

      // Optional source still (I2V). A13: a name that is not there is an
      // error that lists what is, never the last picture of some other chat.
      let inputImage: string | undefined
      let srcW = 0
      let srcH = 0
      if (typeof args.inputImage === 'string' && args.inputImage) {
        const resolved = await resolveInputImage(args.inputImage)
        inputImage = resolved.name
        srcW = resolved.width
        srcH = resolved.height
      }

      const frameRej = videoFrameReject(model, args, caps)
      if (frameRej) return frameRej
      // 24 fps native; Wan up to ~7 s (169 frames), MiniMax H3 up to ~15 s
      // (362, the top of its trained range). resolveClip honors `seconds`/`frames`.
      const vMax = caps?.frameRange?.max ?? (type === 'minimaxh3' ? 362 : type === 'ltx25' ? 242 : 169)
      const { frames, fps } = resolveClip(args, { defFps: d.fps, defFrames: d.frames, maxFrames: vMax })
      const tun = resolveTunables(args, caps, { steps: d.steps, cfg: d.cfg, sampler: d.sampler, scheduler: d.scheduler })
      if (tun.reject) return `Cannot generate: ${tun.reject}`
      // resolveTunables falls back to the generic KSampler caps default (cfg 8 /
      // 20 steps) over our model default. Wan 2.2 5B over-cooks at cfg 8 — its
      // known-good sampling is cfg ~5 / ~30 steps. Honor an explicit user ask,
      // else force the Wan default (2026-06-11: "Qualität muss stimmen").
      const avq = args as Record<string, unknown>
      const tunSteps = avq.steps !== undefined ? tun.steps : d.steps
      const tunCfg = (avq.cfg ?? avq.cfg_scale ?? avq.cfgScale) !== undefined ? tun.cfg : d.cfg

      // I2V → resolution from the source aspect (faithful framing); T2V → model default.
      // A13: from text, an asked aspect ratio at the model's own pixel count.
      const ratio = parseAspectRatio(av.aspectRatio)
      const base = inputImage
        ? resolveI2VResolution(type, srcW, srcH)
        : ratio != null ? aspectFrame(ratio, d.width, d.height, 32) : { width: d.width, height: d.height }
      const snapped = snapToVideoGrid(clampInt(av.width, base.width, 64, 2048), clampInt(av.height, base.height, 64, 2048))
      const seed = (typeof av.seed === 'number' && Number.isFinite(av.seed)) ? Math.floor(av.seed) : -1

      const workflow = await buildFixable('video', () => buildDynamicWorkflow(
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
      ))
      log.info('vram_handoff.video.submit', { model, mode: inputImage ? 'i2v' : 't2v', family: type, steps: tunSteps, cfg: tunCfg })
      const submitted = await submitCancellable(workflow, seq)
      if (submitted === CANCELLED) return `${label('video')} generation cancelled.`
      const promptId = submitted
      log.info('vram_handoff.video.submitted', { promptId })
      return await pollAndExtract(promptId, prompt, label('video'), getVideoTimeoutMs())
    }

    // ── Image-to-video (SVD / FramePack) ───────────────────────────
    // Resolve the still into ComfyUI's input folder and route through the
    // dynamic builder's I2V strategy. Conservative size + low frame count keep
    // it inside 12 GB; SVD bundles its own CLIP-vision + VAE in the checkpoint.
    if (typeof args.inputImage === 'string' && args.inputImage && isI2VModel(model)) {
      const { buildDynamicWorkflow } = await import('./dynamic-workflow')
      // Resolve the source still. A name that is not there fails with the
      // reason; the executor adds the pictures of this chat (A13).
      const resolved = await resolveInputImage(args.inputImage)
      const inputImage = resolved.name
      // SVD-XT genuinely caps ~25 frames. FramePack PACKS long video, so its real
      // ceiling comes from getModelCapabilities (request-driven — 2026-06-04:
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
      // Resolution from the SOURCE aspect ratio (2026-06-11: portrait
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
      const workflow = await buildFixable('video', () => buildDynamicWorkflow(
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
      ))
      log.info('vram_handoff.video.submit', { model, i2v: true })
      const submitted = await submitCancellable(workflow, seq)
      if (submitted === CANCELLED) return `${label('video')} generation cancelled.`
      const promptId = submitted
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
    const tRatio = parseAspectRatio(av.aspectRatio)
    const tBase = tRatio != null ? aspectFrame(tRatio, defaults.width, defaults.height) : { width: defaults.width, height: defaults.height }
    const snapped = snapToVideoGrid(clampInt(av.width, tBase.width, 64, 2048), clampInt(av.height, tBase.height, 64, 2048))
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
    const submitted = await submitCancellable(workflow, seq)
    if (submitted === CANCELLED) return `${label('video')} generation cancelled.`
    const promptId = submitted
    log.info('vram_handoff.video.submitted', { promptId })
    return await pollAndExtract(promptId, prompt, label('video'), getVideoTimeoutMs())
  } catch (err) {
    return buildErrorResult('video', err)
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
    const s = await backendCall<{ startedCpu?: boolean | null; mode?: string | null; hasAmd?: boolean | null }>('get_comfy_gpu_status')
    if (!s) return null
    // `mode` rides along since round 14: the notices used to report a missing
    // GPU path to a user who had picked Force CPU himself. Same reply, same
    // normaliser the Create tab's banner uses, so an unknown or absent value
    // reads as 'auto' and can never claim a press that never happened.
    _cpuRenderFacts = { startedCpu: s.startedCpu === true, mode: asComfyGpuMode(s.mode), hasAmd: s.hasAmd === true, isWindows: isWindows(), amdRocmServed: (s as { amdRocmServed?: boolean | null }).amdRocmServed === true }
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
  // Is ComfyUI still THERE? The loop used to ask only about the prompt, and
  // getHistory swallows every transport error into `null` — which is also what
  // a perfectly healthy queued render returns. So a ComfyUI that died mid-render
  // (crash, OOM kill, the user closing it) was indistinguishable from a slow one:
  // the chat agent sat here for the full 5/10-minute budget with the text model
  // evicted from VRAM, unable to answer anything, and then reported a timeout
  // instead of the truth. Probed on a timer, like the Create tab's heartbeat,
  // and only a SECOND consecutive failure counts — one refused /system_stats
  // during a heavy sampler step is not a dead server.
  // Probed from the FIRST tick (a ComfyUI that is already gone when polling
  // starts is the worst case: nothing will ever arrive), then every 15 s while
  // it answers, and every tick once a probe has failed — a suspected-dead
  // server deserves its second look now, not in fifteen seconds.
  let comfyProbedAt = 0
  let comfyMisses = 0
  const COMFY_PROBE_EVERY_MS = 15_000
  const COMFY_RECHECK_MS = 1_000
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
        // field is usually empty for node errors — 2026-06-11, FramePack).
        // ComfyHistoryEntry DECLARES `messages` as pairs; getHistory only
        // checked that the entry is an object, so the array-ness is tested
        // here rather than assumed by a `?.find` that would throw on a string.
        const messages = Array.isArray(history.status.messages) ? history.status.messages : []
        const errEntry = messages.find((m) => m?.[0] === 'execution_error')?.[1]
        const rawMsg = errEntry?.exception_message
          || messages.map((m) => m?.[1]?.message).filter(Boolean).join(' | ')
          || messages[0]?.[1]?.message
          || 'Unknown ComfyUI error'
        // The architecture only matters for the hipErrorInvalidValue branch, so
        // it is only fetched for that branch. detect_gpus shells out to several
        // vendor tools, each bounded at five seconds, and putting that in front
        // of EVERY ComfyUI failure would have delayed an out-of-memory message
        // or a missing-node message by seconds for nothing.
        const raw = String(rawMsg)
        const arch = /hiperrorinvalidvalue/i.test(raw) ? await getAmdGpuArch().catch(() => null) : null
        const hint = comfyErrorHint(errEntry?.node_type, errEntry?.exception_type, raw, arch)
        return `${kindLabel} generation failed: ${rawMsg}${hint ? `\n\n${hint}` : ''}`
      }
      const probeGap = comfyMisses > 0 ? COMFY_RECHECK_MS : COMFY_PROBE_EVERY_MS
      if (Date.now() - comfyProbedAt >= probeGap) {
        comfyProbedAt = Date.now()
        const alive = await raceCancel(checkComfyConnection())
        if (alive === CANCELLED) return `${kindLabel} generation cancelled.`
        comfyMisses = alive ? 0 : comfyMisses + 1
        if (comfyMisses >= 2) {
          const elapsedMs = Date.now() - startedAt
          log.warn('vram_handoff.comfy_died_mid_render', { promptId, elapsedMs })
          return comfyDiedNotice(kindLabel, elapsedMs, await comfyCrash())
        }
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
    // The job is settled (delivered, failed, abandoned or cancelled): a later
    // Stop must not go looking for it in ComfyUI's queue, where the id may by
    // then belong to nothing — or, after a wrap, to somebody else's work.
    if (_currentPromptId === promptId) _currentPromptId = null
  }
}

// ── Small helpers ─────────────────────────────────────────────────

/** Whether LU's ComfyUI process is gone, and the line it died with: the
 *  last fatal or error line of its output (comfyui_last_output). Null when
 *  that cannot be asked (web build, a ComfyUI the user started himself). */
async function comfyCrash(): Promise<{ exited: boolean; line: string | null } | null> {
  try {
    const out = await backendCall<{ exited?: boolean; lines?: unknown }>('comfyui_last_output')
    const lines = Array.isArray(out?.lines) ? out.lines.filter((l): l is string => typeof l === 'string') : []
    // eslint-disable-next-line no-control-regex
    const clean = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean)
    const line = [...clean].reverse().find((l) => /fatal|exception|error|out of memory|killed|segmentation/i.test(l) && !/^File "/.test(l)) ?? null
    return { exited: out?.exited === true, line: line ? line.slice(0, 200) : null }
  } catch {
    return null
  }
}

/**
 * The tool result when ComfyUI went away mid-render (A13). The box run of
 * 22.10.2026 had ComfyUI crash on every render ("Windows fatal exception:
 * access violation"), and the old line only said it "stopped responding",
 * so model and user retried a render that could never work. When the process
 * is known to have ended, it says so, with the line it ended on.
 */
export function comfyDiedNotice(kindLabel: string, elapsedMs: number, crash: { exited: boolean; line: string | null } | null): string {
  const secs = Math.round(elapsedMs / 1000)
  if (crash?.exited && crash.line) {
    return `${kindLabel} generation failed: ComfyUI crashed after ${secs}s while rendering. Its last error line: "${crash.line}". This is a fault in ComfyUI on this computer, so the same render will crash again: do not retry it. The user can restart ComfyUI from the Create tab, and should look at its log there if it keeps crashing.`
  }
  if (crash?.exited) {
    return `${kindLabel} generation failed: ComfyUI ended after ${secs}s while rendering, so the render cannot finish. Do not retry at once: the user can start ComfyUI again from the Create tab, and if it ends again, its log there says why.`
  }
  return `${kindLabel} generation failed: ComfyUI stopped responding after ${secs}s, so the render cannot finish. Start ComfyUI from the Create tab and try again.`
}

/**
 * Map a known-cryptic ComfyUI node error to an actionable hint (C-fix pattern).
 * Returns '' when we have nothing better to add than the verbatim error.
 * Exported + pure for the unit tests.
 */
export function comfyErrorHint(
  nodeType: string | undefined,
  _excType: string | undefined,
  message: string,
  gpuArch?: string | null,
): string {
  const m = message.toLowerCase()
  // FramePack wrapper version mismatch (2026-06-11, RTX 3060): the
  // installed ComfyUI-FramePackWrapper's LoadFramePackModel produces a
  // HyVideoModel its OWN FramePackSampler can't consume. Upstream custom-node
  // bug — independent of LU's workflow (which now loads without OOM).
  if ((nodeType === 'FramePackSampler' || /framepack/i.test(nodeType ?? '')) &&
      m.includes('hyvideomodel') && m.includes('diffusion_model')) {
    return 'This is a bug in the installed ComfyUI-FramePackWrapper custom node (its model loader and sampler are out of sync), not in LU. Update the node from ComfyUI Manager (search "FramePack"), or pick a different image-to-video model (SVD works on 12 GB; Wan 2.2 5B is the recommended higher-quality option).'
  }
  // An AMD card the ROCm wheels have no kernels for (Runde 12). The install
  // succeeded, torch imported, HIP enumerated the device, and the FIRST kernel
  // is where it falls apart. The wheel choice holds back the families we can
  // name from the card's own name, but a Ryzen APU reports itself as
  // "AMD Radeon(TM) Graphics" and tells us nothing, so this is the net under
  // the ones we cannot place. Without it the user gets a raw HIP traceback
  // that reads like a broken install and sends him rebuilding the environment
  // over and over, which cannot help.
  if (m.includes('invalid device function') ||
      m.includes('hiperrornobinaryforgpu') ||
      m.includes('tensilelibrary')) {
    return 'Your AMD card was found and used, but the ROCm build of PyTorch in this ComfyUI environment carries no compute kernels for this particular chip, so the first step of the render had nothing to run. Rebuilding the environment installs the same wheels and will not change this. Set Settings → Hardware → ComfyUI GPU to Force CPU to render on the processor instead: much slower, but it completes. Running ComfyUI with HSA_OVERRIDE_GFX_VERSION=10.3.0 is the community workaround for RDNA 2 cards; it is not supported by AMD and LU does not set it for you.'
  }
  // A12 (Discord 2026-09-02, RX 9070 XT): image generation
  // dies on `CUDA error: invalid argument / Search for 'hipErrorInvalidValue'`
  // while the same run on the processor completes. The card is RDNA 4, which is
  // new enough that a ROCm PyTorch built before it has no kernels for the
  // target, and HIP rejects the very first launch instead of saying so.
  //
  // The architecture is NAMED here when a tool named it (gpuArch comes from the
  // HIP SDK's hipinfo via detect_gpus) and otherwise the user is pointed at the
  // two commands that print it. Nothing in this string is a version or a table
  // of which card is which target: both sides are read off the machine.
  if (m.includes('hiperrorinvalidvalue')) {
    const mine = gpuArch ? `Your card reports ${gpuArch}. ` : ''
    const check = gpuArch
      ? `${gpuArch} has to appear in the list printed by`
      : 'Read your card\'s target from the gcnArchName line of hipinfo in the HIP SDK\'s bin folder, then check that it appears in the list printed by'
    return `Your AMD card was found and the render started, but the first HIP call came back with hipErrorInvalidValue. On a recent Radeon this is almost always an architecture mismatch: the chip reports one gfx target and the ROCm build of PyTorch in this ComfyUI environment carries kernels for other ones. ${mine}${check}: python -c "import torch; print(torch.cuda.get_arch_list())" run inside the ComfyUI environment. If it is missing there, rebuilding this environment installs the same wheels and will not add it; you need a PyTorch ROCm build that names your target. Set Settings, Hardware, ComfyUI GPU to Force CPU to finish the render on the processor in the meantime.`
  }
  // Discord #bug-reports (12.10. and 17.10.2026): "aimdo memory compile error"
  // on the KSampler of an edit with three images. comfy-aimdo's malloc graph,
  // the model compiler of ComfyUI 0.37 on NVIDIA and AMD cards, raises it
  // when it cannot get another page of graphics memory (src/malloc-graph.c),
  // so it is an out of memory under another name. "could not start recording"
  // is the same graph failing at its very start.
  if (m.includes('aimdo memory compile error')) {
    return 'ComfyUI ran out of graphics memory while it compiled the model for this run. Use fewer images or a smaller size, or pick a lighter model. If it keeps failing at a size that worked before, restart ComfyUI under Settings, AI Backends to free the memory it holds.'
  }
  if (m.includes('out of memory') || m.includes('outofmemory') || _excType === 'torch.OutOfMemoryError') {
    return 'Ran out of GPU memory. Try a shorter clip / lower resolution, set VRAM hand-off to "always" in Settings so the chat model is evicted first, or pick a lighter model.'
  }
  // "CUDA error: unknown error" (cudaErrorUnknown, GH discussion 130): the
  // driver lost the card mid-call and has no better name for it. It surfaces on
  // whichever node touched the GPU first (often CLIPTextEncode), so it reads
  // like a broken model or prompt when neither is at fault. Sits below the
  // out-of-memory branch on purpose: a real "CUDA out of memory" stays that.
  if (m.includes('cudaerrorunknown') || m.includes('cuda error: unknown error')) {
    return 'This error comes from the graphics driver, not from the model or your prompt. It usually clears after restarting ComfyUI or the computer. If it keeps coming back, update the graphics driver.'
  }
  // Windows "paging file is too small" (os error 1455, GH #61):
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

/** Names in ComfyUI's input folder, as a caller hands them over: plain file
 *  names only, never a path. */
function stagedNames(v: unknown): string[] {
  const list = Array.isArray(v) ? v : []
  return list.filter((x): x is string => typeof x === 'string' && /^[\w.-]+$/.test(x)).slice(0, 9)
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
 * 2026-06-03: chat videos came out ~1 s because the I2V default was a
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

/** The file a ComfyUI /view address names, in any of its forms: absolute,
 *  `/view?…` or the dev proxy's `/comfyui/view?…`. Null for anything else. */
export function comfyViewRef(ref: string): { filename: string; subfolder: string; type: string } | null {
  const at = ref.search(/\/view\?/i)
  if (at < 0) return null
  const q = new URLSearchParams(ref.slice(ref.indexOf('?', at) + 1))
  const filename = q.get('filename')
  if (!filename) return null
  return { filename, subfolder: q.get('subfolder') ?? '', type: q.get('type') || 'output' }
}

/** A clip, by its file name: LoadImage reads its first frame or refuses it
 *  with a raw PIL error, neither of which is what the model asked for. */
export const VIDEO_FILE_RE = /\.(mp4|webm|mov|mkv|avi|m4v|gif)$/i

export async function resolveInputImage(ref: string): Promise<ResolvedInputImage> {
  let url: string
  let name: string
  // A13: a /view address is read by its file, subfolder and folder type, and
  // asked of the ComfyUI configured NOW. Before, only an absolute address
  // was taken as one; `/comfyui/view?…` lost its subfolder to a basename
  // lookup in the output root, and an old host:port could never answer.
  const view = comfyViewRef(ref)
  if (view) {
    name = view.filename
    url = getImageUrl(view.filename, view.subfolder, view.type)
  } else if (/^https?:\/\//i.test(ref)) {
    url = ref
    name = 'lu_input.png'
  } else {
    name = ref.replace(/^.*[\\/]/, '')
    url = getImageUrl(name, '', 'output')
  }
  if (VIDEO_FILE_RE.test(name)) {
    throw new Error(`"${name}" is a video clip, and inputImage takes a still image. Pass a picture (a generated image or "attachment N"); continuing a clip is not something this tool does.`)
  }
  const resp = await fetch(url)
  // A12 (20.10.2026): a bare name that is not in the output folder may
  // already sit in ComfyUI's input folder, where a chat attachment is staged
  // (builtin-tools, stageChatAttachment) and where a user puts a picture by
  // hand. LoadImage reads from there, so it needs no second upload.
  if (resp.status === 404 && (view || !/^https?:\/\//i.test(ref))) {
    const fromInput = await fetch(getImageUrl(name, '', 'input'))
    if (fromInput.ok) {
      const blob = await fromInput.blob()
      if (blob && blob.size > 0) return { name, ...(await probeSize(blob)) }
    }
    throw new Error(`could not find input image "${ref}": there is no file of that name in ComfyUI's output or input folder. A picture the user attached in the chat is passed as "attachment 1" (its number in the chat), not by a filename.`)
  }
  if (!resp.ok) throw new Error(`could not read input image "${name}": ComfyUI answered HTTP ${resp.status}.`)
  const blob = await resp.blob()
  if (!blob || blob.size === 0) {
    throw new Error(`could not read input image "${ref}", ComfyUI returned an empty file`)
  }
  // Probe the source dimensions so the I2V path can pick the model's native
  // aspect ratio (2026-06-11: a portrait still forced into 768×448
  // landscape no longer resembled the source). Best-effort — a probe failure
  // just yields 0×0 and the caller falls back to a sane default.
  const size = await probeSize(blob)
  const file = new File([blob], name, { type: blob.type || 'image/png' })
  const uploaded = await uploadImage(file)
  return { name: uploaded, ...size }
}

async function probeSize(blob: Blob): Promise<{ width: number; height: number }> {
  try {
    const bmp = await createImageBitmap(blob)
    const size = { width: bmp.width, height: bmp.height }
    bmp.close()
    return size
  } catch {
    return { width: 0, height: 0 } // dimensions unknown → caller uses defaults
  }
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
    if (type === 'minimaxh3') return { width: 1344, height: 768 }
    if (type === 'ltx25') return { width: 1280, height: 704 }
    return (type === 'svd' || type === 'wan22') ? landscapeDefault : { width: 768, height: 768 }
  }
  const aspect = srcW / srcH
  if (type === 'svd') {
    // Square is closer to landscape than portrait; center-crop handles the rest.
    return aspect >= 0.95 ? { width: 1024, height: 576 } : { width: 576, height: 1024 }
  }
  if (type === 'ltx25') {
    // The official template's 1280x704 canvas on the 64 pixel grid its half
    // size first pass needs. Keeps the source aspect.
    const MAX_PX = 1280 * 704
    const scale = Math.sqrt(MAX_PX / (srcW * srcH))
    const snap = (v: number) => Math.max(256, Math.round(v / 64) * 64)
    return { width: snap(srcW * scale), height: snap(srcH * scale) }
  }
  if (type === 'minimaxh3') {
    // The official templates' canvas: a 768 short edge, capped at 1344x768
    // worth of pixels, snapped to 32. Keeps the source aspect.
    const MAX_PX = 1344 * 768
    let w = aspect >= 1 ? 768 * aspect : 768
    let h = aspect >= 1 ? 768 : 768 / aspect
    if (w * h > MAX_PX) {
      const s = Math.sqrt(MAX_PX / (w * h))
      w *= s
      h *= s
    }
    const snap = (v: number) => Math.max(32, Math.round(v / 32) * 32)
    return { width: snap(w), height: snap(h) }
  }
  if (type === 'wan22') {
    // Wan 2.2 5B trains at 1280×704 / 704×1280. Keep the SOURCE aspect (faithful
    // framing) and snap to 32 (the latent grid); an ImageScale(crop:center) in
    // the builder fills it. Budget by TOTAL PIXELS, not the long edge: a square
    // 1024² still (1.05 M px) sits at the VRAM ceiling on a 12 GB 3060 and can't
    // do 5-7 s, while a 16:9 1024×576 (0.59 M px) runs the whole matrix. ~0.6 M
    // px keeps every aspect tractable on 12 GB (2026-06-11: 5B I2V must be
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

/** The render budget of the chat tools, from the same setting and with the
 *  same defaults as the Create tab and the tool call's own cap (A13). It was
 *  5 and 10 minutes here while Settings showed 20 and 60, so a video the
 *  description promised an hour got ten. */
function getImageTimeoutMs(): number {
  try {
    return renderStallLimitMs('image', useSettingsStore.getState().settings)
  } catch {
    return renderStallLimitMs('image', {})
  }
}

function getVideoTimeoutMs(): number {
  try {
    return renderStallLimitMs('video', useSettingsStore.getState().settings)
  } catch {
    return renderStallLimitMs('video', {})
  }
}

/** Chat and ComfyUI are pinned to two different cards (lib/gpu-roles). */
function chatAndComfyApart(): boolean {
  try {
    return gpuRolesSeparate(useSettingsStore.getState().settings.gpuRoles)
  } catch {
    return false
  }
}

function getExclusiveVramMode(): ExclusiveVramMode {
  try {
    const m = useSettingsStore.getState().settings.exclusiveVramMode
    if (m === 'auto' || m === 'always' || m === 'never') return m
  } catch { /* store not available */ }
  return 'auto'
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
// A finished render parks its haul in _pendingRestore and the chat backends
// stay out until somebody needs them (see restoreChatBackendsAfterRender); a
// NEW eviction inherits the parked haul instead of letting it load, so
// back-to-back renders skip the pointless reload cycle.
let _renderJuggle: Promise<unknown> = Promise.resolve()
let _pendingRestore: RenderEviction | null = null
let _restoreHolds = 0
let _restoreTimer: ReturnType<typeof setTimeout> | null = null
/** True while the Create view is on screen: the next thing the user does is
 *  most likely another render. */
let _renderSurfaceOpen = false
/** True while a restore is reloading the chat backends. An eviction that
 *  arrives now has to wait for that reload. */
let _restoreInFlight = false
/** How long a parked haul waits when no render surface is open (a render that
 *  finished after the user left Create, the trainer). */
export const RENDER_RESTORE_GRACE_MS = 2_000
/** How long it waits while Create is open and nobody asks for the chat model.
 *  After that the machine is put back the way it was found. */
export const RENDER_RESTORE_IDLE_MS = 180_000

function park(haul: RenderEviction | null): void {
  _pendingRestore = haul
  // A chat request that arrives while the haul is parked brings it back first
  // (lib/chat-backends-gate, asked by the local providers).
  setChatBackendsRestore(haul ? restoreChatBackendsNow : null)
}

function clearRestoreTimer(): void {
  if (_restoreTimer) clearTimeout(_restoreTimer)
  _restoreTimer = null
}

/**
 * What the eviction is doing, for the waiting line of the run.
 *
 * Measured on the Windows box, 03.10.2026 (RTX 3060, LM Studio as the chat
 * backend, a 6 GB chat model): the eviction itself is quick, 0.3 s for
 * offload_local_models and 0.5 s for the LM Studio unload. The 25 to 30 s the
 * stage stood on "Preparing workflow..." were the step before it: the previous
 * render's restore was still reading the chat model back in, and an eviction
 * waits its turn on the same chain, so the model is loaded completely and then
 * unloaded again. The line now says which of the two is going on.
 */
export type RenderEvictionPhase = 'waiting-for-chat-model' | 'freeing'

/** Test-only: reset the render-juggle chain state between unit tests. */
export function __resetRenderJuggleForTests(): void {
  _renderJuggle = Promise.resolve()
  clearRestoreTimer()
  park(null)
  _restoreHolds = 0
  _renderSurfaceOpen = false
  _restoreInFlight = false
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
 * probe just means that backend is not in the haul. `onPhase` is told what
 * the wait is spent on (RenderEvictionPhase).
 */
export function evictChatBackendsForRender(onPhase?: (phase: RenderEvictionPhase) => void): Promise<RenderEviction> {
  // A restore that is only planned is called off here and now: this render
  // inherits its haul (evictBody) instead of waiting for a reload.
  clearRestoreTimer()
  if (_restoreInFlight) onPhase?.('waiting-for-chat-model')
  const run = _renderJuggle.catch(() => {}).then(() => {
    onPhase?.('freeing')
    return evictBody()
  })
  _renderJuggle = run.catch(() => {})
  return run.catch(() => ({ ...EMPTY_EVICTION }))
}

async function evictBody(): Promise<RenderEviction> {
  // A restore that has not run yet is inherited wholesale: whatever it wanted
  // to bring back stays evicted and becomes THIS render's restore duty.
  const inherited = _pendingRestore
  park(null)

  if (getExclusiveVramMode() === 'never') {
    // The user opted out of VRAM juggling; do not touch the resident chat
    // backends. An inherited haul still needs restoring after this render.
    return inherited ?? { ...EMPTY_EVICTION }
  }

  // R14 Nebenbefund 1: a ComfyUI LU started with `--cpu` renders without ever
  // claiming the card, so the eager eviction above has nothing to make room
  // for. On the box this cost a full reload of the chat model after every
  // picture. An inherited haul still gets restored after this render.
  if (await comfyRendersOnCpu()) {
    log.info('render_juggle.skipped_cpu_comfy', {})
    return inherited ?? { ...EMPTY_EVICTION }
  }

  const result: RenderEviction = { ...EMPTY_EVICTION }

  // Two cards, one per service (3.0.8, A2): what LU starts for the chat sits
  // on another card than ComfyUI, so only LM Studio, whose card LU cannot
  // choose, still has to make room.
  if (chatAndComfyApart()) {
    try {
      const lms = (await detectLmsTextModel(getActiveAgentModel())) ?? (await detectAnyLoadedLmsModel())
      if (lms) {
        result.lms = lms
        await backendCall('lmstudio_unload_model', { model: '--all' }).catch(() => {})
      }
    } catch { /* LM Studio absent */ }
    log.info('render_juggle.separate_gpus', { lms: result.lms?.id ?? null })
    return inherited ? mergeEvictions(inherited, result) : result
  }

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
    const saved = await backendCall<KvSlotReply>('kv_slot_action', { port: bundled.port, action: 'save' }).catch(() => null)
    if (kvSaveWorthAWarning(saved)) log.warn('render_juggle.kv_save_failed', { port: bundled.port })
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
 * A render is over (success, failure or cancel): park what it evicted. The
 * chat backends do NOT come straight back. The box, 04.10.2026 (LM Studio,
 * a 6 GB chat model): the reload started 2 s after every render, and a second
 * render started shortly after it waited up to 30 s for a model to finish
 * loading that it then unloaded again. They come back when they are needed:
 *
 *   - a chat request to a local backend (restoreChatBackendsNow through
 *     lib/chat-backends-gate), which covers the chat, the agents and
 *     "Improve my prompt" written by the chat model,
 *   - Create is left (setRenderSurfaceOpen),
 *   - or nobody asked for RENDER_RESTORE_IDLE_MS.
 *
 * With no render surface open the wait is the short grace window, as before.
 * A new render calls a planned restore off and inherits the haul. `delayMs`
 * of 0 restores at once. Never throws.
 */
export function restoreChatBackendsAfterRender(evicted: RenderEviction, delayMs?: number): Promise<void> {
  const run = _renderJuggle.catch(() => {}).then(() => {
    if (!evictionEmpty(evicted)) park(mergeEvictions(_pendingRestore, evicted))
    if (!_pendingRestore) return
    if (_restoreHolds > 0) return // the run restores once, at its end
    const wait = delayMs ?? (_renderSurfaceOpen ? RENDER_RESTORE_IDLE_MS : RENDER_RESTORE_GRACE_MS)
    if (wait <= 0) return restoreParked()
    clearRestoreTimer()
    _restoreTimer = setTimeout(() => { void restoreChatBackendsNow() }, wait)
  })
  _renderJuggle = run.catch(() => {})
  return run.catch(() => {})
}

/**
 * Bring the parked chat backends back now, because somebody needs them.
 * Resolves when they are loaded. Nothing parked, or a batch holding the
 * restore: resolves at once and touches nothing. Never throws.
 */
export function restoreChatBackendsNow(): Promise<void> {
  const run = _renderJuggle.catch(() => {}).then(() => (_restoreHolds > 0 ? undefined : restoreParked()))
  _renderJuggle = run.catch(() => {})
  return run.catch(() => {})
}

/**
 * Create came on screen or left it. While it is open a finished render keeps
 * the card for the next one; leaving it brings the chat backends back.
 */
export function setRenderSurfaceOpen(open: boolean): void {
  _renderSurfaceOpen = open
  if (!open) void restoreChatBackendsNow()
}

/**
 * A run of several renders in a row (batch edit) holds the restore: each
 * render still parks its haul, but nothing is freed or reloaded until the
 * returned release is called. Then the haul waits like the one of a single
 * render. Without the hold a picture of the batch could meet a restore that
 * the idle time or a chat request had started, and ComfyUI read the image
 * model back in before the next picture.
 */
export function holdRenderRestore(): () => void {
  _restoreHolds++
  let released = false
  return () => {
    if (released) return
    released = true
    _restoreHolds--
    void restoreChatBackendsAfterRender({ ...EMPTY_EVICTION })
  }
}

async function restoreParked(): Promise<void> {
  clearRestoreTimer()
  const todo = _pendingRestore
  park(null)
  if (!todo || evictionEmpty(todo)) return

  // Give the chat backends their VRAM back. freeMemory drops ComfyUI's
  // cached checkpoint; without it the reloads below can OOM right after a
  // big render.
  //
  // R16 Befund 6a, what this costs, written down because it was measured and
  // not guessed. On the Windows box (2026-08-30, 12 GB GPU, 16 GB RAM,
  // z_image_bf16 at 11.46 GB) ComfyUI dropped the model after every render,
  // RAM going 7.68 GB back to 672 MB, and every one of the five runs then
  // spent 69 s to 75 s reading it back in before the first sampling step.
  //
  // Where that unload comes from: `/free {unload_models, free_memory}` is the
  // only such call in LU, ComfyUI is started with no memory flags at all
  // (process.rs, `--cpu` and `--use-flash-attention` are the only conditional
  // ones), and smart memory is left on. So this line is the prime suspect, but
  // it only fires when a local chat backend was actually resident to evict,
  // and whether one was on the box that evening is not established here. The
  // log lines that settle it are `render_juggle.evicted` and
  // `render_juggle.restored` below; without them ComfyUI dropped the model by
  // itself and the 30+ s belongs to a 16 GB machine, not to us.
  //
  // Left as it is on purpose. It is the deliberate hand-off (a resident chat
  // model squatting the card is what forced heavy CPU offload and the OOMs on
  // the 14B lanes), and `exclusiveVramMode: 'never'` already turns the whole
  // juggle off. Trading a render's load time against a chat model's is the owner's
  // call, not a fixer's.
  _restoreInFlight = true
  try {
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
  } finally {
    _restoreInFlight = false
  }
  log.info('render_juggle.restored', {
    ollama: todo.ollamaModel,
    lms: todo.lms?.id ?? null,
    bundled: todo.bundled?.modelPath ?? null,
  })
}
