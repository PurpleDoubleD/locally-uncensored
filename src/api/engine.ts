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

import { backendCall } from './backend'
import { syncBuiltinEnginePort } from './builtin-ensure'
import { trackEngineSwap } from './engine-swap-gate'
import { prefixModelName } from './providers'
import { useProviderStore } from '../stores/providerStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { CloudModel } from '../types/models'
import type { BuiltinEngineTuning } from '../types/settings'

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
   * the model-name heuristic exactly as before. */
  vision?: boolean
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
}

export interface EngineStatus {
  running: boolean
  healthy: boolean
  port: number
  model_path: string | null
  /** Context size the chat engine was started with (null when not running or
   * for the embed server). The TRUE token-counter denominator. */
  ctx?: number | null
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
  return status
}

/** Swap the loaded model (stop → start on the same port).
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

/**
 * Every folder the GGUF scan walks: the app models dir (Rust adds that one)
 * plus the folder the user named under Settings → Model Storage.
 *
 * GH #122 (zrmdsxa, 2026-08-28): that setting was a download TARGET and
 * nothing else. A GGUF already sitting in it was never looked at, so the
 * Models tab stayed empty next to a folder full of models. Empty setting →
 * empty list, which is exactly the shipped single-folder scan.
 */
export function customModelDirs(): string[] {
  const dir = useSettingsStore.getState().settings.hfDownloadPathOverride?.trim() || ''
  return dir ? [dir] : []
}

/** How one scanned folder fared. `truncated` is a real answer: the walk has a
 *  wall-clock deadline and an entry budget per folder, because `fetchModels`
 *  awaits it and four levels below a home directory is tens of thousands of
 *  directory reads. A partial list within a few seconds beats a complete one
 *  nobody waited for, as long as the panel says it is partial. */
export interface ScannedDir {
  path: string
  status: 'ok' | 'truncated' | 'unreachable' | 'unusable'
}

// The folders the LAST listing walked, app dir first. Kept here rather than
// returned, so no call site has to change to ignore it; Model Storage is the
// one surface that asks.
let lastDirs: ScannedDir[] = []

/** What the last `listBundledModels()` walked, and how each folder fared. */
export function lastScanDirs(): ScannedDir[] {
  return lastDirs
}

/** The user's own folder from the last listing, or null when none was set (or
 *  when it was the app folder under another name, which Rust folds away). */
export function lastCustomScanDir(): ScannedDir | null {
  return lastDirs[1] ?? null
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
  const res = await backendCall<{ candidates: ImportCandidate[] }>('list_importable_models')
  return res?.candidates ?? []
}

/** Link one candidate into the app models dir. Errors come back user-readable. */
export async function importLocalModel(path: string, name: string): Promise<void> {
  await backendCall('import_local_model', { path, name })
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
    providerName: 'Built-in Engine',
    // The projector answer from disk, carried as the app-wide capability flag
    // so the composer and the agent loop stop guessing from the model name.
    // Deliberately left absent (not false) when the backend did not report it,
    // so an older sidecar keeps the old heuristic instead of losing vision.
    ...(typeof m.vision === 'boolean' ? { supportsVision: m.vision } : {}),
  }))
}

/**
 * Activate a built-in model by its picker id (`openai::<name>` or bare `<name>`).
 * Resolves the GGUF path from the last listBundledModels() and swaps the engine.
 * No-op if the path is unknown (list not yet fetched).
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
  await swapBundledModel(path, tuning)
  return true
}
