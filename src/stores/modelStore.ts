import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AIModel, PullProgress, ModelCategory } from '../types/models'
import { unloadModel } from '../api/ollama'
import { unloadLmStudioModel } from '../api/lmstudio'
import { activateBuiltinModel } from '../api/engine'
import { isLmStudioProvider } from '../lib/hf-to-provider'
import { isTauri, backendCall } from '../api/backend'
import { log } from '../lib/logger'

export interface PullState {
  progress: PullProgress
  controller: AbortController
  paused: boolean
  complete: boolean
}

interface ModelState {
  models: AIModel[]
  activeModel: string | null
  activePulls: Record<string, PullState>
  isModelLoading: boolean
  categoryFilter: ModelCategory
  /** Has a model list ever landed here. A counter must show a loading mark
   *  until it has, never a 0 (Befund 2 of the abnahme counter-check
   *  2026-08-29: "Installed 0" next to three Installed cards). */
  inventoryLoaded: boolean
  /** How many inventory refreshes are in flight. A number, not a flag,
   *  because fetchModels is called from several mounted components at once
   *  and the first one to finish must not declare the count settled. */
  inventoryRefreshes: number
  beginInventoryRefresh: () => void
  endInventoryRefresh: () => void
  setModels: (models: AIModel[]) => void
  setActiveModel: (name: string | null) => void
  startPull: (name: string, controller: AbortController) => void
  updatePullProgress: (name: string, progress: PullProgress) => void
  pausePull: (name: string) => void
  completePull: (name: string) => void
  dismissPull: (name: string) => void
  setIsModelLoading: (loading: boolean) => void
  setCategoryFilter: (category: ModelCategory) => void
}

export const useModelStore = create<ModelState>()(
  persist(
    (set, get) => ({
      models: [],
      activeModel: null,
      activePulls: {},
      isModelLoading: false,
      categoryFilter: 'all',
      inventoryLoaded: false,
      inventoryRefreshes: 0,

      beginInventoryRefresh: () => set((state) => ({ inventoryRefreshes: state.inventoryRefreshes + 1 })),
      endInventoryRefresh: () =>
        set((state) => ({ inventoryRefreshes: Math.max(0, state.inventoryRefreshes - 1) })),

      setModels: (models) =>
        set((state) => {
          // Keep the persisted activeModel only if it's actually still
          // present in the freshly fetched list. Without this validation a
          // model name persists in the picker after the underlying provider
          // (e.g. Ollama) was uninstalled or the model was deleted — the
          // dropdown then shows a dead name and clicking it opens an empty
          // list. Falls back to the first available model, mirroring the
          // first-launch behavior so a user is never stuck with no
          // selection while a model exists.
          const stillValid = !!state.activeModel && models.some((m) => m.name === state.activeModel)
          // Chat models only for the auto-select — ComfyUI image/video
          // checkpoints share this list and must never become the active CHAT
          // model (an unprefixed checkpoint name routes to Ollama and every
          // send fails with model-not-found).
          const firstChat = models.find((m) => m.type !== 'image' && m.type !== 'video')
          return {
            models,
            inventoryLoaded: true,
            activeModel: stillValid
              ? state.activeModel
              : (firstChat ? firstChat.name : null),
          }
        }),

      setActiveModel: (name) => {
        const prev = get().activeModel
        const prevModel = prev ? get().models.find((m) => m.name === prev) : undefined
        set({ activeModel: name })
        if (!prev || prev === name) return
        // Exactly ONE local model stays in VRAM at a time (David 2026-06-12:
        // "darf niemals 2 gleichzeitig geladen sein, außer man macht Compare").
        // Compare uses its own store + provider calls, NOT setActiveModel, so it
        // is unaffected. Unload the PREVIOUS local model via the right provider.
        //   - Ollama (no provider prefix)  → unloadModel
        //   - LM Studio (openai:: + LM-Studio providerName) → unloadLmStudioModel
        //   - Cloud (anthropic:: / OpenRouter / OpenAI etc.) → no local VRAM, skip
        // The old `!prev.includes('::')` guard skipped LM Studio entirely, so
        // switching AWAY from an LM Studio model left it loaded → two models in
        // VRAM at once. (David live find.)
        const prevIsLms = isLmStudioProvider(
          (prevModel && 'providerName' in prevModel && prevModel.providerName) as string | undefined,
        )
        // The built-in engine (llama.cpp sidecar) occupies the `openai::` slot
        // with providerName 'Built-in Engine' and holds its GGUF in VRAM with
        // -ngl 999. It is NOT caught by the LM-Studio or the bare-Ollama branch
        // below, so before 2.5.7 wired this in, switching away from a built-in
        // model to an Ollama/LM-Studio model left the sidecar resident → two
        // models in VRAM at once (the exact case this guard exists to prevent).
        const prevIsBuiltin =
          !!prevModel && 'providerName' in prevModel && prevModel.providerName === 'Built-in Engine'
        if (prevIsLms) {
          const bareKey = prev.replace(/^[^:]+::/, '') // strip LU's routing prefix
          unloadLmStudioModel(bareKey).catch((e) =>
            log.warn('[modelStore] failed to unload previous LM Studio model', { model: prev, err: e }),
          )
        } else if (prevIsBuiltin) {
          const nextModel = get().models.find((m) => m.name === name)
          const nextIsBuiltin =
            !!nextModel && 'providerName' in nextModel && nextModel.providerName === 'Built-in Engine'
          if (!nextIsBuiltin) {
            backendCall('stop_bundled_engine').catch((e) =>
              log.warn('[modelStore] failed to stop built-in engine on switch-away', { err: e }),
            )
          } else if (name) {
            // built-in → DIFFERENT built-in: llama-server serves exactly ONE
            // gguf and ignores the request's model field, and the send-path
            // self-heal only revives a DEAD server — so without a swap right
            // here, a pick on the Models page would keep every chat silently
            // answering from the OLD model. The composer picker awaits this
            // same call itself before setting the store; Rust's argv
            // idempotence turns that double-swap into a no-op. (A cleared
            // selection, name = null, has nothing to swap to; nextIsBuiltin
            // is false then anyway, this branch just spells it out for tsc.)
            activateBuiltinModel(name).catch((e) =>
              log.warn('[modelStore] failed to swap built-in engine to the picked model', { model: name, err: e }),
            )
          }
        } else if (!prev.includes('::')) {
          unloadModel(prev).catch((e) =>
            log.warn('[modelStore] failed to unload previous model', { model: prev, err: e }),
          )
        }
      },

      startPull: (name, controller) =>
        set((state) => ({
          activePulls: {
            ...state.activePulls,
            [name]: { progress: { status: 'Starting download...' }, controller, paused: false, complete: false },
          },
        })),

      updatePullProgress: (name, progress) =>
        set((state) => {
          if (!state.activePulls[name]) return state
          return {
            activePulls: {
              ...state.activePulls,
              [name]: { ...state.activePulls[name], progress, paused: false },
            },
          }
        }),

      pausePull: (name) => {
        const pull = get().activePulls[name]
        if (pull && !pull.complete) {
          pull.controller.abort()
          set((state) => ({
            activePulls: {
              ...state.activePulls,
              [name]: { ...state.activePulls[name], paused: true, progress: { ...state.activePulls[name].progress, status: 'Paused' } },
            },
          }))
        }
      },

      completePull: (name) =>
        set((state) => {
          if (!state.activePulls[name]) return state
          return {
            activePulls: {
              ...state.activePulls,
              [name]: { ...state.activePulls[name], complete: true, paused: false, progress: { status: 'Complete' } },
            },
          }
        }),

      dismissPull: (name) => {
        // Bug #5 (phantomderp v2.4.3): the X-button used to remove the
        // entry from `activePulls` without telling Rust to stop the
        // underlying stream. The Tauri-side `pull_model_stream` kept
        // emitting `pull-progress` events that re-created the entry via
        // `pullModelTauri`'s listener — the item visually respawned within
        // 100 ms and the disk-write kept running. Fix: cancel both sides.
        //
        // 1. Abort the AbortController so the listener inside
        //    `useModels.pullModel` sees the abort and the controller's
        //    "abort" handler fires `cancel_model_pull`.
        // 2. Best-effort: invoke `cancel_model_pull` directly too. This
        //    covers the rare case where the controller was already
        //    consumed (e.g. completed-but-not-yet-dismissed entries) and
        //    is idempotent on the Rust side.
        const existing = get().activePulls[name]
        if (existing) {
          try { existing.controller.abort() } catch { /* already aborted */ }
        }
        if (isTauri()) {
          // Fire-and-forget — the Rust command returns Ok(()) even when
          // there's nothing to cancel, so failure here is non-fatal.
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke('cancel_model_pull', { name }).catch(() => {})
          }).catch(() => {})
        }
        set((state) => {
          const { [name]: _, ...rest } = state.activePulls
          return { activePulls: rest }
        })
      },

      setIsModelLoading: (loading) => set({ isModelLoading: loading }),
      setCategoryFilter: (category) => set({ categoryFilter: category }),
    }),
    {
      name: 'chat-models',
      partialize: (state) => ({ activeModel: state.activeModel, categoryFilter: state.categoryFilter }),
    }
  )
)
