import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import type { AIModel, PullProgress, ModelCategory } from '../types/models'
import { unloadModel } from '../api/ollama'
import { unloadLmStudioModel } from '../api/lmstudio'
import { activateBuiltinModel } from '../api/engine'
import { isLmStudioProvider } from '../lib/hf-to-provider'
import { isTauri, backendCall } from '../api/backend'
import { useChatStore } from './chatStore'
import { log } from '../lib/logger'
import { isLuEngineName } from '../lib/engine-name'
// Which provider slot a model name routes to. There is exactly one answer to
// that question in this app and it lives in api/providers/registry, the same
// function getProviderForModel uses to pick the client that actually sends the
// turn. A second implementation here disagreed with it on real names
// ('sdxl::x.safetensors' → null vs 'sdxl', 'a::b::c' → null vs 'ollama'), which
// is the worst possible place for two answers: the guard below would decline to
// clear a pick that the send path would then route to a dead backend.
import { getProviderIdFromModel } from '../api/providers/model-name'
import { onProviderSlotsDarkened } from '../lib/provider-slot-darkening'
import type { ProviderId } from '../api/providers/types'

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
  /**
   * Welche Zeilen eingeklappt wurden, weil ein anderes Backend dieselbe Datei
   * schon anbietet: wessen Zeilen es waren, wie viele, und wer sie stattdessen
   * bedient.
   *
   * Persona P5, 03./04.09.2026: LM Studio meldete ueber die eigene
   * Schnittstelle 7 Modelle, der Waehler zeigte unter LM STUDIO nur 4. Die
   * drei fehlenden sind genau die, deren Datei auch als LU-Engine-Zeile
   * dasteht. Das Einklappen ist richtig, das Schweigen darueber nicht: fuer
   * den Nutzer sehen drei seiner Modelle einfach verschwunden aus.
   *
   * Gegenprobe G1, 04.09.2026: dieselbe Sache in der anderen Richtung, und
   * dort war es schlimmer. Sobald LM Studio den Steckplatz haelt, faellt
   * `Qwen3-4B-Q4_K_M` weg, eine echte, installierte Datei des Kunden von
   * 2,3 GB, aus dem Waehler UND von der Models-Seite. Kein Hinweis, keine
   * Erklaerung, waehrend fuer die Gegenrichtung ein Satz existierte und
   * angezeigt wurde. Ein Feld statt zwei, damit die beiden Richtungen nicht
   * wieder auseinanderlaufen koennen.
   */
  foldedRows: { backend: string; count: number; servedBy: string } | null
  setFoldedRows: (folded: { backend: string; count: number; servedBy: string } | null) => void
  beginInventoryRefresh: () => void
  endInventoryRefresh: () => void
  setModels: (models: AIModel[]) => void
  /** Drop every inventory row for a file that is provably gone from the disk.
   *  Nebenbefund 2 of the R8 re-measure: after a confirmed delete the row and
   *  the counter stood unchanged for about ten seconds while the file was long
   *  gone, because the list only ever changed at the END of the reconcile
   *  chain (ComfyUI rescan, reachability probe, two /object_info reads, a stat
   *  over every remaining file). Nothing here guesses: the delete command has
   *  already returned Ok. The chain still runs and still has the last word.
   *  Every row, not the first: one checkpoint file is one row under Image and
   *  one under Video. `activeModel` is untouched on purpose, this serves the
   *  ComfyUI lanes and an image file is never the active chat model. */
  removeInventoryModel: (name: string) => void
  setActiveModel: (name: string | null) => void
  startPull: (name: string, controller: AbortController) => void
  updatePullProgress: (name: string, progress: PullProgress) => void
  pausePull: (name: string) => void
  completePull: (name: string) => void
  dismissPull: (name: string) => void
  setIsModelLoading: (loading: boolean) => void
  setCategoryFilter: (category: ModelCategory) => void
  /** Nothing across these two stores enforced that the picked model belongs to
   *  a backend that is still switched on. `setModels` only re-checks the pick
   *  against the next NON-EMPTY inventory, so between switching a provider off
   *  and the next successful refresh the composer showed a model whose backend
   *  was gone and every send failed with model-not-found. providerStore calls
   *  this the moment a slot goes dark. */
  dropActiveModelIfServedBy: (providerId: ProviderId) => void
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
          // An empty list validates nothing. fetchModels writes its result
          // here even when every provider failed, and dropping the pick on
          // that answer is how a transient failure turned into a silently
          // different model in the picker (Befund 3, abnahme counter-check
          // 2026-08-29). The pick has its own guard on the way in and its
          // own moment to be re-checked: the next non-empty list.
          const stillValid =
            !!state.activeModel &&
            (models.length === 0 || models.some((m) => m.name === state.activeModel))
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

      removeInventoryModel: (name) =>
        set((state) => {
          if (!name) return state
          const models = state.models.filter((m) => m.name !== name)
          // A no-op must stay a no-op: returning a fresh array for a name that
          // was not in the list would re-render every counter for nothing.
          if (models.length === state.models.length) return state
          return { models }
        }),

      setActiveModel: (name) => {
        const prev = get().activeModel
        const prevModel = prev ? get().models.find((m) => m.name === prev) : undefined
        set({ activeModel: name })
        // Befund 4 of the abnahme counter-check (2026-08-29): the open chat
        // kept the model it was created with while the wire of that same turn
        // already carried the new one. Every path that changes the selection
        // comes through here, so the record is written here, once. A cleared
        // selection has nothing to write.
        if (name) {
          try { useChatStore.getState().setActiveConversationModel(name) }
          catch (e) { log.warn('[modelStore] could not note the model on the open chat', { err: e }) }
        }
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
        // The LU Engine (llama.cpp sidecar) occupies the `openai::` slot
        // with providerName 'LU Engine' ('Built-in Engine' before 2.6.8, still
        // on disk in older chats) and holds its GGUF in VRAM with
        // -ngl 999. It is NOT caught by the LM-Studio or the bare-Ollama branch
        // below, so before 2.5.7 wired this in, switching away from a built-in
        // model to an Ollama/LM-Studio model left the sidecar resident → two
        // models in VRAM at once (the exact case this guard exists to prevent).
        const prevIsBuiltin =
          !!prevModel && 'providerName' in prevModel && isLuEngineName(prevModel.providerName)
        if (prevIsLms) {
          const bareKey = prev.replace(/^[^:]+::/, '') // strip LU's routing prefix
          unloadLmStudioModel(bareKey).catch((e) =>
            log.warn('[modelStore] failed to unload previous LM Studio model', { model: prev, err: e }),
          )
        } else if (prevIsBuiltin) {
          const nextModel = get().models.find((m) => m.name === name)
          const nextIsBuiltin =
            !!nextModel && 'providerName' in nextModel && isLuEngineName(nextModel.providerName)
          if (!nextIsBuiltin) {
            backendCall('stop_bundled_engine').catch((e) =>
              log.warn('[modelStore] failed to stop the LU Engine on switch-away', { err: e }),
            )
          } else if (name) {
            // built-in → DIFFERENT built-in: llama-server serves exactly ONE
            // gguf and ignores the request's model field, and the send-path
            // self-heal only revives a DEAD server, so without a swap right
            // here, a pick on the Models page would keep every chat silently
            // answering from the OLD model. The composer picker awaits this
            // same call itself before setting the store, so every activation
            // reaches the engine twice. Rust's argv idempotence swallows the
            // second call only for a model that LOADS: a GGUF that fails to
            // load leaves no running engine to compare argv against, and the
            // second command runs the whole try-and-retry routine again (four
            // llama-server spawns per click, measured 2026-09-03). The
            // coalescing that makes the double call harmless therefore lives
            // in api/engine.ts (activationsInFlight), at the one door both
            // callers come through. (A cleared selection, name = null, has
            // nothing to swap to; nextIsBuiltin is false then anyway, this
            // branch just spells it out for tsc.)
            activateBuiltinModel(name).catch((e) =>
              log.warn('[modelStore] failed to swap the LU Engine to the picked model', { model: name, err: e }),
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

      foldedRows: null,
      setFoldedRows: (folded) => set({ foldedRows: folded }),

      setIsModelLoading: (loading) => set({ isModelLoading: loading }),
      setCategoryFilter: (category) => set({ categoryFilter: category }),

      dropActiveModelIfServedBy: (providerId) => {
        const active = get().activeModel
        if (!active || getProviderIdFromModel(active) !== providerId) return
        log.warn('[modelStore] the picked model\'s backend was switched off, clearing the pick', {
          model: active, provider: providerId,
        })
        // Through setActiveModel, not a bare set(): the model that is going
        // away is also the one holding VRAM, and that release lives there.
        get().setActiveModel(null)
      },
    }),
    {
      name: 'chat-models',
      storage: safeJSONStorage(),
      partialize: (state) => ({ activeModel: state.activeModel, categoryFilter: state.categoryFilter }),
    }
  )
)

// Audit W-T2: Der providerStore hat sich diesen Store frueher selbst geholt
// (`void import('./modelStore')`), um bei abgeschalteten Slots die Modellwahl
// zu raeumen, ein dynamischer Import, der den Kreis providerStore zu
// modelStore und zurueck nur verdeckt hat. Jetzt wird dort angesagt und hier
// zugehoert; die Anmeldung passiert beim Laden dieses Moduls, wie
// registerBuiltinTools() sich beim Tool-Registry anmeldet.
onProviderSlotsDarkened((darkened) => {
  for (const id of darkened) useModelStore.getState().dropActiveModelIfServedBy(id)
})
