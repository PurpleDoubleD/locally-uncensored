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
import { runEngineResume } from '../lib/engine-resume-policy'
import { engineStartIsWorthRetrying } from '../lib/engine-start-failure'
import { commandIsUnavailable } from '../lib/engine-command-availability'
import { dropDuplicateLuEngineRows } from '../lib/lu-engine-rows'
import { isBuiltinEngineEntry, type InstalledModelLike } from '../lib/lmstudio-match'
import {
  ensureLuEngineIsChatProvider, LU_ENGINE_SWITCH_NOTE, LU_ENGINE_FILE_GONE, luEngineStartFailureNote,
} from '../api/lu-engine-switch'
import { useLuEngineSwitchStore } from '../stores/luEngineSwitchStore'
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

// A14 third review: `fetchModels` runs from several mounted components at
// once, and the flag above was READ before the await and WRITTEN after it, so
// two first passes that overlapped both read "first pass" and both fired the
// resume. That is two llama-server starts on one port, on the machine with the
// least room to spare.
//
// The claim is taken here, before the await, and only the pass holding it may
// spend the shot or hand it back. A pass that answered while the claim holder
// was still waiting must NOT spend it: it skipped the resume, so spending it
// would leave the resume owed forever. A claim holder that got no answer gives
// the claim back, which keeps the Runde-3 contract (a timeout does not eat the
// shot) intact under concurrency.
let builtinResumeClaimed = false

// A14 third review, the other half: two LU Engine cards clicked in quick
// succession fired two `swap_bundled_model` calls at one engine. The picker
// has had a bolt against this since ENG-4 (`selectingLms`); the Installed card
// had none, and a hook-local ref would not have been one either, because the
// two clicks can land in two different mounted components.
let luEngineSwapInFlight = false

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
  // The embeddings server is a different process on a different port with a
  // different model, so it starts NOW and not behind up to three chat-engine
  // attempts. Waiting its turn is how a slow chat start used to take
  // Document-Chat down with it (review S3).
  const embedResumed = resumeEmbedServer(bundled)
  const outcome = await runEngineResume({
    status: () => bundledEngineStatus(),
    eligible: () => {
      const { activeModel } = useModelStore.getState()
      return (
        !!activeModel &&
        getProviderIdFromModel(activeModel) === 'openai' &&
        bundled.some((m) => prefixModelName('openai', m.name) === activeModel)
      )
    },
    activate: () => activateBuiltinModel(useModelStore.getState().activeModel as string),
    // Only a start that DIED is worth repeating. A health-budget timeout means
    // the engine is still loading, and repeating it spends the whole budget
    // again (up to ten minutes on a big GGUF) plus another ComfyUI cache drop
    // and another Ollama eviction (review S3).
    worthRetrying: engineStartIsWorthRetrying,
    sleep: wait,
    onError: (attempt, err) =>
      log.warn('[useModels] built-in engine resume failed', { attempt, err }),
  })
  log.info('[useModels] built-in engine resume', outcome)
  await embedResumed
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
      // LU Engine model list (the downloaded GGUFs and the user's own folder).
      //
      // A14 (2.6.8): asked whether or not the LU Engine is the active chat
      // backend. It used to be asked only while it was, so on David's Mac with
      // Ollama in front, the GGUF in his own model folder existed on disk,
      // Model Storage promised in writing that the folder is read, and the
      // file appeared nowhere. The command answering at all IS the presence
      // check for the engine: it is a Tauri command with no bridge route, so
      // the web and remote-bridge builds, which have no sidecar to start,
      // still get nothing and are unchanged.
      //
      // A14 review 6 and its follow-up: the once-per-session flag is spent on
      // an ANSWER, not on an attempt and not on a success.
      //
      //  - answered with a list  the resume runs, once, and never again.
      //  - answered "no such command"  this build has no sidecar, so the shot
      //    is spent too and the web, bridge and broken-install cases stop
      //    re-attempting the whole resume on every refresh forever.
      //  - no answer at all (timeout, dead transport)  nothing was learned,
      //    so nothing is spent. This is the launch race: the command layer
      //    coming up behind the window. Spending the shot there left the
      //    engine the user had running yesterday dead for the session.
      //
      // A14 third review: the claim is taken BEFORE the await, so two passes
      // racing out of two mounted components cannot both be the first one.
      const firstPassThisSession = !builtinResumeAttempted && !builtinResumeClaimed
      if (firstPassThisSession) builtinResumeClaimed = true
      let bundledRaw: BundledModel[] | null = null
      let backendAnswered = false
      try {
        bundledRaw = await listBundledModels()
        backendAnswered = true
      } catch (e) {
        backendAnswered = commandIsUnavailable(e)
      }
      // Only the pass that holds the claim may spend the shot or give it back.
      // A pass that skipped the resume must not spend it on the holder's
      // behalf, or the resume it skipped would never happen.
      if (firstPassThisSession) {
        if (backendAnswered) builtinResumeAttempted = true
        else builtinResumeClaimed = false
      }
      if (bundledRaw) {
        const bundled = bundledToAIModels(bundledRaw).filter(m => !isEmbeddingModel(m.name))
        // One file, one row: with the folder pointed at ~/.lmstudio/models,
        // LM Studio lists the model over its own API and the folder walk finds
        // the same file. The row that is already serving the chat wins.
        allModels.push(...dropDuplicateLuEngineRows(bundled, allModels))
        if (firstPassThisSession) {
          // Unchanged in both directions: the chat engine is only resumed when
          // it holds the slot, and the embeddings server is resumed when it
          // does not, so RAG survives a relaunch under a foreign backend.
          if (managedBuiltin) void resumeBuiltinEngines(bundledRaw)
          else void resumeEmbedServer(bundledRaw)
        }
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

  // Selecting an LU Engine model must also swap the loaded GGUF: the managed
  // engine serves one model per process, so activation means swap_bundled_model.
  // Other providers just set the active model as before.
  //
  // A14 second review: this did half the job and the half it skipped was the
  // whole point. The guard was "is the openai slot already ours", so a click
  // on an LU Engine card under Installed while Ollama held the chat wrote
  // openai::<gguf> into the store, unloaded the Ollama model to make room, and
  // then started nothing and switched nothing. The user was left on a model
  // that answered from nowhere. Same route as the picker and the Use button
  // now: hand the slot over, say so, then start.
  const activateModel = useCallback((name: string) => {
    const row = useModelStore.getState().models.find((m) => m.name === name)
    const isLuRow = isBuiltinEngineEntry(row as unknown as InstalledModelLike | undefined)
    // Did THIS click move the chat backend. A failure afterwards has to keep
    // saying so: the slot has already changed hands and the model the user was
    // talking to has already been unloaded to make room.
    let switched = false
    if (isLuRow) {
      // A14 third review: the bolt the picker has had since ENG-4. Two LU
      // cards clicked in quick succession used to send two swap_bundled_model
      // calls at one engine, and the second one lands on a process the first
      // one is still restarting.
      if (luEngineSwapInFlight) return
      switched = ensureLuEngineIsChatProvider()
      if (switched) useLuEngineSwitchStore.getState().announce(LU_ENGINE_SWITCH_NOTE)
    }
    setActiveModel(name)
    const cfg = useProviderStore.getState().providers.openai
    if (cfg.enabled && cfg.managed && getProviderIdFromModel(name) === 'openai') {
      // A14 third review: this used to be `.catch(() => {})`. A dead
      // llama-server then left the slot handed over, the Ollama model already
      // unloaded to make room, and one cheerful line on screen saying the chat
      // provider had moved. The picker names the real reason with the stderr
      // tail Rust appends; the card says the same sentence now, from the same
      // helper, in the status row that is drawn right above the list.
      if (isLuRow) luEngineSwapInFlight = true
      const sayItFailed = (reason: unknown) => {
        const line = luEngineStartFailureNote(name, reason)
        useLuEngineSwitchStore.getState()
          .announce(switched ? `${LU_ENGINE_SWITCH_NOTE} ${line}` : line, 'error')
      }
      void activateBuiltinModel(name)
        // False is not a shrug: the path could not be resolved even after a
        // refresh, so the row stands for a file that is no longer there.
        .then((swapped) => { if (!swapped && isLuRow) sayItFailed(LU_ENGINE_FILE_GONE) })
        // Not an LU row: some other model in the openai slot, and the engine
        // has nothing to say about it. Unchanged, non-critical.
        .catch((e) => { if (isLuRow) sayItFailed(e) })
        .finally(() => { if (isLuRow) luEngineSwapInFlight = false })
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
