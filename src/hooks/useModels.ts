import { useCallback, useEffect, useMemo } from 'react'
import { listModels, pullModel as pullModelApi, pullModelTauri, deleteModel as deleteModelApi } from '../api/ollama'
import { isTauri, isMacOS, backendCall } from '../api/backend'
import {
  inventoryOwesRetry, refetchWhenComfyReady, type ComfyReadyStatus,
} from '../lib/comfy-ready-retry'
import {
  getInstalledImageModels as getComfyImageModels,
  getInstalledVideoModels as getComfyVideoModels,
  checkComfyConnection,
  readModelDiskSizes,
} from '../api/comfyui'
import { parseNDJSONStream } from '../api/stream'
import { log } from '../lib/logger'
import { cloudModelRow } from '../lib/cloud-model-row'
import { RESUME_ATTEMPTS, resumeBackoffMs } from '../lib/engine-resume-policy'
import { useModelStore } from '../stores/modelStore'
import { useProviderStore } from '../stores/providerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { getEnabledProviders, prefixModelName, getProviderIdFromModel } from '../api/providers'
import {
  listBundledModels, bundledToAIModels, activateBuiltinModel, isManagedBuiltinActive,
  bundledEngineStatus, bundledEmbedStatus, startBundledEmbed,
  isEmbeddingGgufName as isEmbeddingModel,
} from '../api/engine'
import type { BundledModel } from '../api/engine'
import type { PullProgress, AIModel, ModelCategory, ImageModel, VideoModel, CloudModel } from '../types/models'


// Boot-resume for the managed built-in engine (2.5.7): the llama-server
// children are reaped on app quit and nothing on the Rust side respawns them,
// so after a relaunch the persisted active model points at a dead
// 127.0.0.1:8127 (and RAG at a dead 8128) until the user re-picks the model.
// Runs at most once per app session (fetchModels fires repeatedly), and only
// starts a server that reports running:false.
let builtinResumeAttempted = false

// GH #118: the boot resume used to be a single shot, and a failure was
// swallowed without a word. The one moment it runs is the worst moment to ask
// a machine for a GPU: right after login, with the antivirus scanning the
// fresh install and the graphics driver still settling. A start that loses
// that race left the user with a dead 127.0.0.1 port and no second attempt
// until they re-picked the model by hand. Bounded on purpose, because the
// other failure (a model this box genuinely cannot load) must not turn into an
// endless restart loop. The policy lives in lib/engine-resume-policy.
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function resumeBuiltinEngines(bundled: BundledModel[]) {
  for (let attempt = 0; attempt < RESUME_ATTEMPTS; attempt++) {
    try {
      const status = await bundledEngineStatus()
      if (status.running) break
      const { activeModel } = useModelStore.getState()
      if (
        !activeModel ||
        getProviderIdFromModel(activeModel) !== 'openai' ||
        !bundled.some((m) => prefixModelName('openai', m.name) === activeModel)
      ) {
        break // nothing to resume, and no number of retries changes that
      }
      // False means the GGUF is gone from disk. Retrying cannot conjure it.
      if (await activateBuiltinModel(activeModel)) break
      break
    } catch (err) {
      log.warn('[useModels] built-in engine resume failed', { attempt: attempt + 1, err })
      const delay = resumeBackoffMs(attempt)
      if (delay === null) break
      await wait(delay)
    }
  }
  await resumeEmbedServer(bundled)
}

/** One arm at a time. fetchModels runs from several mounted components, and a
 *  cold start would otherwise start a wait per caller. */
let comfyRetryRunning = false

/**
 * Meldung 2 of the R5 re-measure (2026-08-30): opening the Model Manager while
 * ComfyUI was still coming up left the counter on `Installed 0` for good,
 * beside cards that carried green Installed ticks. The first pass asked an
 * engine that could not answer, wrote the empty answer down as the count, and
 * nothing ever asked again. Only a manual Refresh repaired it.
 *
 * The counter stays on "counting" for as long as this runs, because that is
 * the truth: nothing has been counted. beginInventoryRefresh is what says so,
 * and it is held until the wait settles one way or the other.
 */
function armComfyInventoryRetry(refetch: () => Promise<void>): void {
  if (comfyRetryRunning) return
  if (isMacOS()) return
  comfyRetryRunning = true
  useModelStore.getState().beginInventoryRefresh()
  void refetchWhenComfyReady({
    status: async () => {
      try {
        return await backendCall<ComfyReadyStatus>('comfyui_status')
      } catch {
        return null
      }
    },
    refetch: async () => { await refetch() },
  })
    .then((outcome) => { log.info('[useModels] ComfyUI inventory second pass', { outcome }) })
    .catch((err) => { log.warn('[useModels] ComfyUI inventory second pass failed', { err }) })
    .finally(() => {
      comfyRetryRunning = false
      useModelStore.getState().endInventoryRefresh()
    })
}

/** Test seam. The arm is module state on purpose (one per app, not one per
 *  mounted component), so a test needs a way back to a clean slate. */
export function __resetComfyInventoryRetryForTests(): void {
  comfyRetryRunning = false
}

// The bundled embeddings server serves RAG/memory for ANY local backend that
// downloaded the embed GGUF in onboarding (LM Studio/openai-compat too), so
// its resume must not depend on the chat engine being the managed builtin.
async function resumeEmbedServer(bundled: BundledModel[]) {
  try {
    const embed = bundled.find((m) => isEmbeddingModel(m.name))
    if (embed) {
      const embedStatus = await bundledEmbedStatus()
      if (!embedStatus.running) await startBundledEmbed(embed.path)
    }
  } catch { /* embeddings server unavailable — non-critical */ }
}

export function useModels() {
  const {
    models: allModels, activeModel, activePulls, categoryFilter,
    inventoryLoaded, inventoryRefreshes,
    setModels, setActiveModel, startPull, updatePullProgress,
    pausePull, completePull, dismissPull, setCategoryFilter,
  } = useModelStore()

  // Global Local/Cloud switch: one choke point for every picker — cloud mode
  // surfaces only the hosted catalog, local mode hides it. The store keeps
  // the full list (no refetch on flip); this is a view, not a mutation.
  const appMode = useSettingsStore((s) => s.settings.appMode)
  const models = useMemo(
    () => allModels.filter((m) => (appMode === 'cloud' ? m.provider === 'lu-cloud' : m.provider !== 'lu-cloud')),
    [allModels, appMode],
  )

  const isPulling = Object.keys(activePulls).length > 0

  // Refresh trigger: any code path that just installed a model (onboarding,
  // DiscoverModels, the Ollama in-app installer) dispatches this event so
  // every mounted consumer of useModels re-fetches without needing a manual
  // RefreshCw click.
  useEffect(() => {
    const handler = () => { fetchModels().catch(() => {}) }
    window.addEventListener('lu-models-refresh', handler)
    // A finished ComfyUI image/video download fires 'comfyui-model-downloaded' —
    // from the download-store poller on completion AND from installBundleComplete
    // after it rescans ComfyUI. useModels must refetch on it too, or a freshly
    // downloaded model stays missing from the Installed tab + the chat/create
    // pickers until a manual reload (d37d7bf5 + neejuh, 2026-06-24, v2.5.5).
    // 'lu-models-refresh' alone did NOT cover this: installBundleComplete can bail
    // before any dispatch when ComfyUI is not fully up, while the file still
    // downloads and only the poller's event fires (verified live 2026-06-25).
    window.addEventListener('comfyui-model-downloaded', handler)
    return () => {
      window.removeEventListener('lu-models-refresh', handler)
      window.removeEventListener('comfyui-model-downloaded', handler)
    }
    // fetchModels is reassigned below on every render but always wraps the
    // same setModels — depending on it would just churn listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchModels = useCallback(async () => {
    // Announced before the first await, cleared in the finally below. A
    // counter reading 0 while this is up has not counted anything yet and
    // says so instead of stating a number (Befund 2, abnahme counter-check
    // 2026-08-29: the Models page opened on "Installed 0" beside three
    // Installed cards, and was right again five seconds later).
    useModelStore.getState().beginInventoryRefresh()
    try {
      const allModels: AIModel[] = []
      // Built-in engine (2.5.7): when the managed OpenAI-compat backend is the
      // active provider, its model list is the downloaded GGUFs (via the Tauri
      // `list_bundled_models` command), NOT `/v1/models` (which reports only the
      // single loaded model). Skip the openai client's listModels for it.
      const managedBuiltin = isManagedBuiltinActive()
      const providers = getEnabledProviders().filter(
        (p) => !(managedBuiltin && p.id === 'openai'),
      )
      const providerResults = await Promise.allSettled(
        providers.map(async (provider) => {
          const providerModels = await provider.listModels()
          return providerModels.map((pm): AIModel => {
            if (pm.provider === 'ollama') {
              return {
                name: pm.id, model: pm.id, size: 0, digest: '', modified_at: '',
                details: { parent_model: '', format: '', family: '', families: [], parameter_size: '', quantization_level: '' },
                type: 'text' as const, provider: 'ollama', providerName: 'Ollama',
                // This literal rebuilds the model field by field and used to
                // stop one field short, while the branch right below it passes
                // supportsTools straight through. So Ollama's own per-model
                // tool answer died here, every model arrived with `undefined`,
                // the picker read that as "not false" and drew a wrench on a
                // completion-only model, and resolveToolSupport fell through to
                // the family-name list. Caught on the installed build
                // 2026-08-06, after two fixes further upstream changed nothing,
                // because `hasOllamaModels` is true by the time the api/ollama
                // path below would have run.
                contextLength: pm.contextLength, supportsTools: pm.supportsTools,
              }
            }
            // ONE place decides what a cloud row carries (lib/cloud-model-row).
            // The Ollama branch above is the standing warning: a literal that
            // rebuilds the model and stops one field short is how a server
            // answer dies quietly halfway to the composer.
            return cloudModelRow(pm) satisfies CloudModel
          })
        })
      )
      for (const result of providerResults) {
        if (result.status === 'fulfilled') {
          // Filter out embedding models (e.g. nomic-embed-text) — not usable for chat
          allModels.push(...result.value.filter(m => !isEmbeddingModel(m.name)))
        }
      }
      // Built-in engine model list (downloaded GGUFs). Guarded: a missing/older
      // backend or non-Tauri dev context just yields no built-in models.
      if (managedBuiltin) {
        try {
          const bundledRaw = await listBundledModels()
          const bundled = bundledToAIModels(bundledRaw)
          allModels.push(...bundled.filter(m => !isEmbeddingModel(m.name)))
          if (!builtinResumeAttempted) {
            builtinResumeAttempted = true
            void resumeBuiltinEngines(bundledRaw)
          }
        } catch { /* engine command unavailable — non-critical */ }
      } else if (!builtinResumeAttempted) {
        // Non-builtin chat backend (LM Studio etc.): still resume the bundled
        // embeddings server when its GGUF exists, so RAG survives a relaunch.
        builtinResumeAttempted = true
        try {
          void resumeEmbedServer(await listBundledModels())
        } catch { /* engine command unavailable — non-critical */ }
      }
      const ollamaEnabled = useProviderStore.getState().providers.ollama.enabled
      const hasOllamaModels = allModels.some(m => m.provider === 'ollama')
      if (ollamaEnabled && !hasOllamaModels) {
        try {
          const ollamaModels = await listModels()
          allModels.push(...ollamaModels
            .filter(m => !isEmbeddingModel(m.name))
            .map(m => ({ ...m, provider: 'ollama' as const, providerName: 'Ollama' })))
        } catch { /* Ollama might not be running */ }
      }

      let comfyModels: AIModel[] = []
      // Did the ComfyUI lanes produce an answer at all this pass. Not whether
      // the answer had anything in it: an engine that is up and holds no
      // models is a counted zero, an engine that could not be reached has
      // counted nothing. Drives the second pass at the bottom of this
      // function (Meldung 2, R5 re-measure 2026-08-30).
      // True on the Mac and in the web build, where there is nothing to ask.
      let comfyAnswered = true
      // Hard rule: Mac local media is MLX-only — ComfyUI never auto-starts
      // there (process.rs::auto_start_comfyui), so skip the probe outright
      // instead of a doomed connection check on every model-list refresh.
      const comfyOk = !isMacOS() && (await checkComfyConnection())
      if (!isMacOS() && !comfyOk) comfyAnswered = false
      if (comfyOk) {
        // Settled, not all: a folder ComfyUI cannot read costs that one lane,
        // never the whole list. The old code lost both to a single throw.
        // BOTH sides ask an inventory reader, not a picker reader. The
        // inventory has to agree with the bundle cards: a bundle whose card
        // says Installed must be in this count and in the Installed list.
        // The four ComfyUI\models loaders alone cannot do that. Video needed
        // the AnimateDiff pack, which keeps its motion modules under
        // custom_nodes (counter-check 2026-08-29: two cards Installed, rail
        // counter 3, neither bundle in the list). Image needed the addon
        // folders: the abnahme counter-check the same day found Pixel Art XL
        // in loras\ and the SDXL VAE in vae\ with Installed cards, present on
        // the disk, and in no list and no counter anywhere.
        const [imageResult, videoResult] = await Promise.allSettled([
          getComfyImageModels(),
          getComfyVideoModels(),
        ])
        if (imageResult.status === 'rejected') {
          log.warn('[useModels] ComfyUI image discovery failed', { err: imageResult.reason })
        }
        if (videoResult.status === 'rejected') {
          log.warn('[useModels] ComfyUI video discovery failed', { err: videoResult.reason })
        }
        const imageModels = imageResult.status === 'fulfilled' ? imageResult.value : []
        const videoModels = videoResult.status === 'fulfilled' ? videoResult.value : []
        // Both lanes down is not an inventory, it is an engine that answered
        // the handshake and then nothing else.
        if (imageResult.status === 'rejected' && videoResult.status === 'rejected') {
          comfyAnswered = false
        }

        // No second partial filter here. The inventory readers above are the
        // one reader for this list and they already decided what is on the
        // disk; asking the catalogue a second time is what hid
        // llava_llama3_fp8_scaled.safetensors (2.4 GB on the box, 8.5 GB in
        // our catalogue) from every surface in the app while its three folder
        // neighbours showed up (R5 re-measure, 2026-08-30). A catalogue size
        // is a claim about the file we ship, not about the file the user has.
        const format = (name: string) =>
          name.toLowerCase().endsWith('.gguf') ? 'gguf' : 'safetensors'
        // What each file weighs, asked once for both lanes. Every ComfyUI
        // entry used to carry size 0, and the card hides a zero size, so the
        // Installed list answered "what is this costing me" with silence.
        const sizes = await readModelDiskSizes([...imageModels, ...videoModels])
        const toModel = <T extends 'image' | 'video'>(m: { name: string; type: string }, type: T) => ({
          name: m.name, model: m.name, size: sizes.get(m.name) ?? 0, format: format(m.name),
          architecture: m.type, type, providerName: 'ComfyUI' as const,
        })
        comfyModels = [
          ...imageModels.map((m) => toModel(m, 'image') as ImageModel),
          ...videoModels.map((m) => toModel(m, 'video') as VideoModel),
        ]
      }
      setModels([...allModels, ...comfyModels])
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      if (inventoryOwesRetry(comfyAnswered)) armComfyInventoryRetry(fetchModels)
    } catch (err) {
      log.warn('[useModels] Model list refresh failed', { err })
    } finally {
      useModelStore.getState().endInventoryRefresh()
    }
  }, [setModels])

  const pullModel = useCallback(
    async (name: string) => {
      const existing = activePulls[name]
      // If already active and not paused, don't restart
      if (existing && !existing.paused && !existing.complete) return

      const controller = new AbortController()
      startPull(name, controller)

      if (isTauri()) {
        const { promise, cancel } = pullModelTauri(name, (progress) => {
          updatePullProgress(name, progress)
        })
        controller.signal.addEventListener('abort', cancel)
        try {
          await promise
          completePull(name)
          try { await fetchModels() } catch { /* model list refresh failed — non-critical */ }
          // Auto-activate the freshly downloaded chat model so the chat actually
          // switches to it instead of silently staying on the old default
          // (forte_exe 2026-06-14: downloaded models didn't appear selected and
          // the chat kept reverting). Chat models only — image/video live in the
          // Create view. Matched by exact list name so a mismatch just no-ops.
          {
            const freshly = useModelStore.getState().models.find((m) => m.name === name)
            if (freshly && freshly.type !== 'image' && freshly.type !== 'video') setActiveModel(name)
          }
          // Auto-dismiss after 5s
          setTimeout(() => dismissPull(name), 5000)
        } catch (err) {
          // Bug Z/a v2.5.0 — leonsk29 GH #48. Pre-v2.5.0 this catch was
          // silent ("card stays visible"), which combined with the Rust-
          // side Ok(()) on stream-ended-without-success made LU flip the
          // badge to "Completed" even when Ollama returned a 400 or the
          // stream cut off after just the manifest. Now we surface the
          // real error string as the card's last status, so the user can
          // see *why* the pull failed (e.g. "Repo not GGUF compatible").
          // The cancellation case is still distinguished from real errors.
          const msg = (err as Error)?.message || String(err)
          if (!/cancelled/i.test(msg) && controller.signal.aborted !== true) {
            updatePullProgress(name, { status: `Failed: ${msg}` })
          }
        }
        return
      }

      // Dev mode: streaming fetch
      try {
        const response = await pullModelApi(name, controller.signal)
        let streamError: string | null = null
        for await (const chunk of parseNDJSONStream<PullProgress>(response)) {
          updatePullProgress(name, chunk)
          // Surface an error the NDJSON stream reports mid-pull instead of
          // falsely flipping the card to "complete" (adhney; mirrors the
          // Tauri-path Bug Z/a handling above).
          if (chunk.error) { streamError = chunk.error; break }
        }
        if (streamError) {
          updatePullProgress(name, { status: `Error: ${streamError}` })
        } else {
          completePull(name)
          try { await fetchModels() } catch { /* non-critical */ }
          // Auto-activate the freshly downloaded chat model (see note above).
          {
            const freshly = useModelStore.getState().models.find((m) => m.name === name)
            if (freshly && freshly.type !== 'image' && freshly.type !== 'video') setActiveModel(name)
          }
          setTimeout(() => dismissPull(name), 5000)
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          updatePullProgress(name, { status: `Error: ${(err as Error).message}` })
        }
        // On abort (pause): card stays with "Paused" status
      }
    },
    [activePulls, fetchModels, startPull, updatePullProgress, completePull, dismissPull, setActiveModel]
  )

  const isPullingModel = useCallback(
    (name: string) => {
      const pull = activePulls[name]
      return !!pull && !pull.paused && !pull.complete
    },
    [activePulls]
  )

  const removeModel = useCallback(
    async (name: string) => {
      await deleteModelApi(name)
      await fetchModels()
    },
    [fetchModels]
  )

  const getFilteredModels = (filter: ModelCategory = categoryFilter) => {
    if (filter === 'all') return models
    return models.filter((m: AIModel) => m.type === filter)
  }

  // Selecting a built-in model must also swap the loaded GGUF: the managed
  // engine serves one model per process, so activation → swap_bundled_model.
  // Other providers just set the active model as before.
  const activateModel = useCallback((name: string) => {
    setActiveModel(name)
    const cfg = useProviderStore.getState().providers.openai
    if (cfg.enabled && cfg.managed && getProviderIdFromModel(name) === 'openai') {
      void activateBuiltinModel(name).catch(() => { /* engine unavailable — non-critical */ })
    }
  }, [setActiveModel])

  return {
    models, activeModel, activePulls, isPulling, categoryFilter,
    // What the counters need to tell "nothing installed" apart from "not
    // counted yet". See lib/inventory-counter.ts.
    inventoryLoaded, inventoryRefreshing: inventoryRefreshes > 0,
    fetchModels, pullModel, pausePull, dismissPull,
    removeModel, setActiveModel: activateModel, setCategoryFilter, getFilteredModels, isPullingModel,
  }
}
