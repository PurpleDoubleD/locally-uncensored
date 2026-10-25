/**
 * Built-in Engine client (2.5.7)
 *
 * Thin typed wrappers over the P1 Rust sidecar commands (see
 * `src-tauri/src/commands/engine.rs`). The built-in engine is a bundled
 * `llama.cpp` `llama-server` — OpenAI-compatible on `127.0.0.1:8127`, whose
 * lifecycle the app owns. Chat itself flows through the existing
 * `OpenAIProvider` + Rust proxy; this module only manages start/stop/swap and
 * sources the model list (the downloaded GGUFs, not just the loaded one).
 *
 * `backendCall` maps camelCase args → snake_case Rust params (Tauri).
 */

import { backendCall, isLinux } from './backend'
import { syncBuiltinEnginePort } from './builtin-ensure'
import { trackEngineSwap } from './engine-swap-gate'
import { prefixModelName } from './providers/model-name'
import { useProviderStore } from '../stores/providerStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { CloudModel } from '../types/models'
import type { BuiltinEngineTuning } from '../types/settings'
import { LU_ENGINE_NAME } from '../lib/engine-name'
import { customModelDirs } from '../lib/custom-model-dirs'
import { announceEngineCpuFallback } from '../lib/engine-offload'
import { ENGINE_EFFORT_LEVELS } from '../lib/local-effort'

/** The user's Built-in Engine expert tuning (settings-backed). Injected into
 * every start/swap below, so Onboarding, Discover, the model picker and the
 * post-offload self-heal all honor it without threading it through callsites.
 * Undefined (pre-migration blob) is fine — Rust falls back to its defaults. */
function tuningFromSettings(): BuiltinEngineTuning | undefined {
  return useSettingsStore.getState().settings.builtinEngine
}

export interface BundledModel {
  /** File name without the `.gguf` extension. The id shown in the picker. */
  name: string
  /** Absolute path to the GGUF file — passed back to `swapBundledModel`. */
  path: string
  /** File size in bytes (0 if unknown). */
  size: number
  /** Whether this model is the one currently loaded by the engine. */
  loaded: boolean
  /** Context length the model was TRAINED with, read from the GGUF header
   * (ENG-6c). null/absent when the header doesn't carry it — presets then
   * stay uncapped, exactly the pre-2.6.0 behavior. */
  ctx_train?: number | null
  /** Can the built-in engine show this model a picture? True only when the
   * vision projector sits next to the GGUF, which is the same file Rust turns
   * into `--mmproj` at start (engine.rs model_can_see_images). Absent when the
   * installed backend predates the field, and the callers then fall back to
   * the model-name heuristic exactly as before. For the model that is loaded
   * this is a fact about the running process: false when it was started
   * without its image part (no room on the card), even with the part on disk. */
  vision?: boolean
  /** The image part lies next to the GGUF. False for a model that has none
   * installed, which is what the offer to add it is decided on. Absent on an
   * older backend. */
  imagePart?: boolean
}

/** What a start / swap answers. `port` is the port the engine ACTUALLY came
 *  up on: since GH #118 the Rust side may take the next free one when the
 *  preferred port is held, and every caller has to follow it there. */
export interface EngineStartResult {
  status: string
  port: number
  model_path: string
  ctx?: number | null
  retried?: boolean
  /** The start ended up on the processor: either the first attempt died and
   * the retry dropped GPU offload, or the sanity probe below found the card's
   * answer unreadable. */
  cpuOnly?: boolean
  /** Bug a (GitHub 128 and two Discord reports): the engine reported healthy
   * and then answered the start-time probe in question marks or symbol salad.
   * Set whether or not the restart on the processor repaired it. */
  garbled?: boolean
  /** One English sentence for the user when something was worked around,
   * written by the Rust side (engine_sanity.rs). Absent on a healthy start,
   * which is every start on a machine that has no such problem. */
  note?: string
}

export interface EngineStatus {
  running: boolean
  healthy: boolean
  port: number
  model_path: string | null
  /** Context size the chat engine was started with (null when not running or
   * for the embed server). The TRUE token-counter denominator. */
  ctx?: number | null
  /** The engine is on the processor because a start WITH the graphics card
   * died first (3.0.0, ccdc2d14). Not the same as a GPU Layers of 0 typed
   * into Settings, which is an answer rather than an accident. */
  cpuOnly?: boolean
  /** The `-ngl` the running process carries, null when it asked for every
   * layer. See lib/engine-offload. */
  gpuLayers?: number | null
  /** Auto fitting uses backend memory estimates; its final layer count is unknown here. */
  gpuLayerMode?: 'auto' | 'all' | 'explicit' | null
  /** Bug a: what the start-time sanity probe worked around for this process,
   * as the sentence the user is shown (engine_sanity.rs). Null on every
   * ordinary start. Outlives the start call on purpose, see lib/engine-offload. */
  sanityNote?: string | null
  /** Why the loaded model came up without its image part, as the sentence the
   * user is shown (engine.rs). Null when it has its part or has none. */
  imageNote?: string | null
}

/** Loopback base URL of the managed embeddings server (P5). Mirrors the Rust
 * `DEFAULT_EMBED_PORT` (8128). Document-Chat/RAG POSTs `/v1/embeddings` here
 * when the built-in engine is active, instead of Ollama's `/api/embed`. */
/** Preferred loopback port of the managed chat engine. Mirrors the Rust
 *  `DEFAULT_ENGINE_PORT`. Since GH #118 it is a preference, not a promise: the
 *  engine takes the next free port when this one is held. */
export const ENGINE_PORT = 8127

export const EMBED_PORT = 8128
export function embedBaseUrl(): string {
  return `http://127.0.0.1:${EMBED_PORT}/v1`
}

// name → absolute GGUF path, populated by listBundledModels(). Lets callers
// activate a model by its picker id (which is what the model store carries)
// without threading the path through AIModel, which has no path field.
const pathByName = new Map<string, string>()
// name → trained context limit (GGUF header). Feeds the Context dropdown's
// preset cap via useActiveContextWindow.modelMax.
const ctxTrainByName = new Map<string, number>()

/** Trained context limit of a bundled model by picker id (`openai::<name>`
 * or bare), or 0 when unknown / listing not fetched yet (= uncapped). */
export function bundledCtxTrain(nameOrPrefixed: string): number {
  const name = nameOrPrefixed.includes('::') ? nameOrPrefixed.split('::')[1] : nameOrPrefixed
  return ctxTrainByName.get(name) ?? 0
}

/**
 * True when the active OpenAI-compat backend is the app-managed built-in engine
 * (occupies the `openai` slot with `managed: true`). Drives the model-list
 * source: bundled GGUFs via `list_bundled_models`, not `/v1/models`.
 */
export function isManagedBuiltinActive(): boolean {
  const cfg = useProviderStore.getState().providers.openai
  return cfg.enabled && cfg.managed === true
}

/** Start the built-in engine with a specific GGUF. Idempotent for the same
 * model + tuning (the Rust side compares the resulting argv).
 *
 * Registered with the swap gate so a send that arrives while the engine is
 * still coming up waits for it instead of hitting the dead port (counter-check
 * round 2, 2026-08-29). */
export async function startBundledEngine(modelPath: string, tuning?: BuiltinEngineTuning) {
  const res = await trackEngineSwap(
    backendCall<EngineStartResult>('start_bundled_engine', {
      modelPath,
      tuning: tuning ?? tuningFromSettings(),
    }),
  )
  // The engine may have landed on another port (GH #118). The slot that talks
  // to it has to be told, or the very next request is refused by a port
  // nobody is listening on, which is the ticket's own symptom.
  syncBuiltinEnginePort(res?.port)
  return res
}

/** Stop the managed engine child if one is running. */
/** Delete an LU Engine row's file(s): the GGUF, or every part of a split.
 *  The backend refuses the loaded model, so the caller stops the engine first
 *  when the row is the active one. */
export async function deleteBundledModel(path: string): Promise<{ deleted: number; bytes: number }> {
  const res = await backendCall<{ deleted?: number; bytes?: number }>('delete_bundled_model', {
    path,
    extraDirs: customModelDirs(),
  })
  return { deleted: res?.deleted ?? 0, bytes: res?.bytes ?? 0 }
}

export function stopBundledEngine() {
  return backendCall('stop_bundled_engine')
}

/** Engine health + which model is loaded on which port. */
export async function bundledEngineStatus() {
  const status = await backendCall<EngineStatus>('bundled_engine_status')
  // Running: the port the engine really holds. Stopped: back to the preferred
  // port, because the next start begins its walk at 8127 and a fallback port
  // must not outlive the conflict that caused it. The slot is persisted, so
  // without the reset a one-off collision would keep the app on 8129 for good
  // and the Settings test would read "failed" on a free 8127 (review S5).
  syncBuiltinEnginePort(status?.running ? status.port : ENGINE_PORT)
  // An engine the app pushed onto the processor by itself says so, once per
  // engine. This is the poll behind Settings and the models view; the chat's
  // own pre-send probe says it from builtin-ensure, because the chat does not
  // poll and this note would otherwise never reach the screen it hangs over.
  announceEngineCpuFallback(status)
  return status
}

/** Swap the loaded model (stop, then start again).
 *
 * The port is NOT preserved. A15: handing the current port back in turned a
 * one-off collision into a permanent move, so the Rust side picks the port
 * fresh on every swap, starting at ENGINE_PORT.
 *
 * This is the call the model picker makes on every activation, and the one the
 * counter-check raced: two switches in a row, then a send into the restart gap.
 * Registering it here is what lets the send path wait it out. */
export async function swapBundledModel(modelPath: string, tuning?: BuiltinEngineTuning) {
  const res = await trackEngineSwap(
    backendCall<EngineStartResult>('swap_bundled_model', {
      modelPath,
      tuning: tuning ?? tuningFromSettings(),
    }),
  )
  syncBuiltinEnginePort(res?.port)
  return res
}

/** Start the built-in embeddings server (P5) with a specific embedding GGUF.
 * Idempotent for the same model. Runs on EMBED_PORT, separate from chat. */
export function startBundledEmbed(modelPath: string) {
  return backendCall('start_bundled_embed', { modelPath })
}

/** Stop the managed embeddings server if one is running. */
export function stopBundledEmbed() {
  return backendCall('stop_bundled_embed')
}

/** Embeddings-server health + which model is loaded on which port. */
export function bundledEmbedStatus() {
  return backendCall<EngineStatus>('bundled_embed_status')
}

// Embedding-model GGUFs: never offered in the chat dropdown, and the
// candidates for the bundled embeddings server. Single source of truth —
// useModels and the RAG self-heal below share it.
const EMBEDDING_GGUF_PATTERNS = [/embed/, /nomic-embed/, /bge-/, /e5-/, /gte-/, /sentence-/]
export function isEmbeddingGgufName(name: string): boolean {
  const lower = name.toLowerCase()
  return EMBEDDING_GGUF_PATTERNS.some((p) => p.test(lower))
}

// Coalesce concurrent RAG calls into one status-probe/restart.
let embedEnsureInflight: Promise<void> | null = null

/**
 * Revive the bundled embeddings server after a VRAM offload stopped it —
 * Create/Music renders call `offload_local_models`, which kills BOTH managed
 * sidecars with the promise of a lazy reload. This is the embed half of that
 * reload (the chat half lives in `builtin-ensure.ts`); RAG awaits it before
 * hitting :8128. Best-effort: a real start failure surfaces on the embeddings
 * request itself with the server's honest error.
 */
export async function ensureBundledEmbedAlive(): Promise<void> {
  if (embedEnsureInflight) return embedEnsureInflight
  embedEnsureInflight = (async () => {
    try {
      const status = await bundledEmbedStatus()
      if (status?.healthy) return
      const models = await listBundledModels()
      const embed = models.find((m) => isEmbeddingGgufName(m.name))
      if (embed) await startBundledEmbed(embed.path)
    } catch {
      /* best-effort — embedViaBuiltin reports the real error */
    } finally {
      embedEnsureInflight = null
    }
  })()
  return embedEnsureInflight
}

/**
 * Can the bundled lane actually embed right now.
 *
 * "The built-in engine is the active backend" is not the same question, which
 * is what RAG's pre-flight used to ask. Measured on the Windows box on
 * 2026-08-15: built-in engine active, the app models dir holding one chat GGUF
 * and no embedding GGUF, ports 8127 and 8128 both dead. The pre-flight said
 * yes, the dropped file was accepted, and the embedder then failed with
 * `proxy_localhost: error sending request`. `ensureBundledEmbedAlive` starts an
 * embedding GGUF, it cannot conjure one, so an installed embedding model is the
 * precondition and this is where it gets asked.
 */
export async function bundledEmbedLaneReady(): Promise<boolean> {
  try {
    if ((await bundledEmbedStatus()).running) return true
  } catch {
    /* engine command unavailable — fall through to the model scan */
  }
  try {
    return (await listBundledModels()).some((m) => isEmbeddingGgufName(m.name))
  } catch {
    return false
  }
}

export { customModelDirs }

/** How one scanned folder fared. `truncated` is a real answer: the walk has a
 *  wall-clock deadline and an entry budget per folder, because `fetchModels`
 *  awaits it and four levels below a home directory is tens of thousands of
 *  directory reads. A partial list within a few seconds beats a complete one
 *  nobody waited for, as long as the panel says it is partial. */
export interface ScannedDir {
  path: string
  /** `denied` is its own answer, not a shade of `unreachable`: the folder is
   *  there and this account may not read it, so telling the user to check the
   *  cable sends them after a fault that does not exist (P3, 7.4). */
  status: 'ok' | 'truncated' | 'unreachable' | 'denied' | 'unusable'
}

// The folders the LAST listing walked, app dir first. Kept here rather than
// returned, so no call site has to change to ignore it; Model Storage is the
// one surface that asks.
let lastDirs: ScannedDir[] = []

/** What the last `listBundledModels()` walked, and how each folder fared. */
export function lastScanDirs(): ScannedDir[] {
  return lastDirs
}

/** Same folder, written two ways. Windows arrives with backslashes and any
 *  case, and `C:\\` and `c:/` are one folder; the trailing separator is noise
 *  on every platform.
 *
 *  The case fold follows Rust's `bundled_scan_dirs`, which folds on Windows
 *  and macOS and NOT on Linux: `/mnt/Models` and `/mnt/models` really are two
 *  folders on ext4, and folding them here would let this answer a question
 *  about one folder with the verdict about the other. */
function samePath(a: string, b: string): boolean {
  // The mirror of Rust's `!cfg!(target_os = "linux")` in bundled_scan_dirs,
  // spelled the same way round so the two cannot drift apart.
  const fold = !isLinux()
  const key = (p: string) => {
    const normalised = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    return fold ? normalised.toLowerCase() : normalised
  }
  return key(a) === key(b)
}

/** The user's own folder from the last listing, or null when none was set or
 *  when the answer says nothing about it.
 *
 *  Matched by path rather than by position: the app dir is row 0 today, but a
 *  row read off an index is a row that silently reports the wrong folder the
 *  moment that stops being true. A folder that IS the app folder under another
 *  spelling is folded away by Rust, so the match then lands on row 0, which is
 *  the same folder and the right verdict for it. */
export function lastCustomScanDir(): ScannedDir | null {
  const wanted = customModelDirs()[0]
  if (!wanted) return null
  return lastDirs.find((d) => samePath(d.path, wanted)) ?? null
}

/** List downloaded GGUFs in the app models dir and in the user's own model
 *  folder. Refreshes the name→path map. */
export async function listBundledModels(): Promise<BundledModel[]> {
  const res = await backendCall<{ dir: string; dirs?: ScannedDir[]; models: BundledModel[] }>(
    'list_bundled_models',
    { extraDirs: customModelDirs() },
  )
  const models = res?.models ?? []
  // An older backend answers without `dirs`; an empty list then says "nothing
  // known about the folders", which is the truth and renders no line.
  lastDirs = Array.isArray(res?.dirs) ? res.dirs : []
  pathByName.clear()
  ctxTrainByName.clear()
  for (const m of models) {
    pathByName.set(m.name, m.path)
    if (typeof m.ctx_train === 'number' && m.ctx_train > 0) ctxTrainByName.set(m.name, m.ctx_train)
  }
  return models
}

/** A GGUF sitting in another local tool's store, importable via hard link. */
export interface ImportCandidate {
  name: string
  source: 'ollama' | 'lmstudio'
  path: string
  size: number
  already_imported: boolean
}

/**
 * GGUFs found in local Ollama and LM Studio stores. Ollama blobs ARE plain
 * GGUFs, so bringing them along is a hard link, not a second download.
 */
export async function listImportableModels(): Promise<ImportCandidate[]> {
  const res = await backendCall<{ candidates: ImportCandidate[] }>('list_importable_models', { destDir: importDestDir() })
  return res?.candidates ?? []
}

/**
 * The LU Engine folder set under Model Storage, or null for the app's own
 * models dir. The import links there, so the cross drive error's advice (set
 * that folder on the drive of the file) is a way out that works.
 */
function importDestDir(): string | null {
  return customModelDirs()[0] ?? null
}

/** Link one candidate into the LU Engine folder. Errors come back user-readable. */
export async function importLocalModel(path: string, name: string): Promise<void> {
  await backendCall('import_local_model', { path, name, destDir: importDestDir() })
}

/** Shard tail of a split GGUF: `<base>-00001-of-00003.gguf`. */
const SPLIT_GGUF = /-\d{5}-of-\d{5}\.gguf$/i

/** The model name a loose GGUF is imported under: its file name without the
 *  folder and without `.gguf`. */
export function ggufImportName(path: string): string {
  const leaf = path.split(/[\\/]/).pop() ?? path
  return leaf.replace(/\.gguf$/i, '')
}

/** Why a picked file cannot be a chat model on its own, or null when it can.
 *  The image part of a vision model and one part of a split model both load
 *  nothing by themselves. */
export function ggufPickProblem(path: string): string | null {
  const leaf = (path.split(/[\\/]/).pop() ?? path).toLowerCase()
  if (!leaf.endsWith('.gguf')) return 'That is not a GGUF file. Pick a file that ends in .gguf.'
  if (leaf.includes('mmproj')) {
    return 'This is the image part of a vision model, not the model. Pick the model file next to it; LU brings the image part along.'
  }
  if (SPLIT_GGUF.test(leaf)) {
    return 'This model is split into several files. Put all parts into the LU Engine folder (Settings, AI Backends, Model Storage) and LU lists it from there.'
  }
  return null
}

/**
 * D17 (Discord): use a GGUF that sits anywhere on the drive. The system file
 * dialog picks it, then the same link as the Ollama and LM Studio import puts
 * it into the LU Engine folder, image part included when it sits next to it.
 * Null when the dialog was cancelled; the model name otherwise. Throws a
 * readable message when the file cannot be used.
 */
export async function addGgufFile(): Promise<string | null> {
  const path = await backendCall<string | null>('pick_gguf_file')
  if (!path) return null
  const problem = ggufPickProblem(path)
  if (problem) throw new Error(problem)
  const name = ggufImportName(path)
  await importLocalModel(path, name)
  return name
}

/**
 * Map bundled GGUFs to the app's model list shape. Built-in models live in the
 * `openai` slot, so they are prefixed `openai::<name>` for provider routing.
 */
export function bundledToAIModels(models: BundledModel[]): CloudModel[] {
  return models.map((m) => ({
    name: prefixModelName('openai', m.name),
    model: m.name,
    size: m.size,
    type: 'text' as const,
    provider: 'openai' as const,
    providerName: LU_ENGINE_NAME,
    // Issue 176: the engine takes effort through the template variable and
    // the Think budget, so every model offers Low, Medium and High. The
    // button itself only shows while Think is on (lib/local-effort.ts).
    effortLevels: [...ENGINE_EFFORT_LEVELS],
    // Read from the engine, not from a catalogue: sent only once the user
    // picked a rung (settings.localEffortChosen), otherwise as before 3.0.7.
    effortLocal: true,
    // Carried through since 2.6.8 (A14): the row IS a file, and the Installed
    // list needs the path to tell "the same GGUF, seen twice" from "two
    // downloads of the same model". A file under LM Studio's own store is the
    // case that made this necessary.
    path: m.path,
    // The projector answer from disk, carried as the app-wide capability flag
    // so the composer and the agent loop stop guessing from the model name.
    // Deliberately left absent (not false) when the backend did not report it,
    // so an older sidecar keeps the old heuristic instead of losing vision.
    ...(typeof m.vision === 'boolean' ? { supportsVision: m.vision } : {}),
    // Whether the image part is on disk, which is not the same question: a
    // model loaded without its part has it installed and cannot see.
    ...(typeof m.imagePart === 'boolean' ? { imagePartInstalled: m.imagePart } : {}),
  }))
}

/** Activations already on their way, keyed by GGUF path plus tuning, so two
 *  callers asking for the SAME model share one engine start. */
const activationsInFlight = new Map<string, Promise<boolean>>()

/**
 * Activate a built-in model by its picker id (`openai::<name>` or bare `<name>`).
 * Resolves the GGUF path from the last listBundledModels() and swaps the engine.
 * No-op if the path is unknown (list not yet fetched).
 *
 * TWO CALLERS, ONE ENGINE (measured 2026-09-03, Windows release build).
 * Every activation happens twice. `useModels.activateModel` calls
 * `setActiveModel(name)`, and the store chokepoint (`stores/modelStore.ts`)
 * fires an activation of its own inside that update; the hook then calls this
 * function again in the same tick. The picker (`ModelSelector`) does the same
 * in the other order. The store's comment says Rust's argv idempotence turns
 * the second call into a no-op, and for a model that LOADS that is true.
 *
 * For a model that does not load it is false, and expensively so. There is no
 * running engine to compare argv against, so the second command runs the whole
 * routine again: Rust tries once, retries once, and does it all a second time.
 * One click on a broken GGUF spawned FOUR llama-server processes (measured:
 * 4 spawns, in two pairs 5.7 s apart, all with identical argv), while the
 * message on screen said "It was tried twice". Twice the wait, twice the VRAM
 * churn, and a sentence that is off by a factor of two.
 *
 * So the coalescing lives here, at the one door both callers come through,
 * rather than in either of them. Concurrent callers share the promise, failure
 * included. A LATER click is a fresh call, because the entry is dropped as soon
 * as the run settles, and a user retrying a failed start must really retry.
 */
export async function activateBuiltinModel(nameOrPrefixed: string, tuning?: BuiltinEngineTuning): Promise<boolean> {
  const name = nameOrPrefixed.includes('::') ? nameOrPrefixed.split('::')[1] : nameOrPrefixed
  let path = pathByName.get(name)
  if (!path) {
    // Callers outside the picker (Models page via the store chokepoint) can
    // run before any listBundledModels() populated the map — refresh once.
    await listBundledModels().catch(() => undefined)
    path = pathByName.get(name)
  }
  if (!path) return false
  // The tuning is part of the key: two callers wanting the same file with
  // different settings want two different engines, and the second must not be
  // handed the first one's promise.
  const key = `${path}\u0000${JSON.stringify(tuning ?? null)}`
  const laufend = activationsInFlight.get(key)
  if (laufend) return laufend
  const lauf = (async () => {
    await swapBundledModel(path as string, tuning)
    return true
  })()
  activationsInFlight.set(key, lauf)
  try {
    return await lauf
  } finally {
    if (activationsInFlight.get(key) === lauf) activationsInFlight.delete(key)
  }
}

/** Test-only: forget every in-flight activation. */
export function __resetActivationsForTests(): void {
  activationsInFlight.clear()
}
