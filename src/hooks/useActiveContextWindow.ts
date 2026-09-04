import { useState, useEffect } from 'react'
import { useModelStore } from '../stores/modelStore'
import { useSettingsStore } from '../stores/settingsStore'
import { getProviderIdFromModel, displayModelName } from '../api/providers'
import { getModelContextCached } from '../api/ollama'
import { getLmStudioModelContext } from '../api/lmstudio'
import { getModelMaxTokens } from '../lib/context-compaction'
import { effectiveContextWindow } from '../lib/context-window'
import { effectiveSendWindow } from '../lib/send-window'
import { isManagedBuiltinSlot } from '../api/builtin-ensure'
import { ENGINE_DEFAULT_CTX } from '../lib/builtin-ctx'
import { bundledEngineStatus, bundledCtxTrain } from '../api/engine'

export type CtxProvider = 'ollama' | 'lmstudio' | 'builtin' | 'cloud' | 'unknown'

export interface ActiveContext {
  /** Which backend the active model runs on. */
  provider: CtxProvider
  /** The context window the model is ACTUALLY using right now — the TRUE
   *  denominator for the token counter. */
  contextWindow: number
  /** The model's ceiling, used to cap the dropdown presets (0 = unknown). */
  modelMax: number
  /**
   * The window one request may actually SEND (2.6.6, plan A2). Equal to
   * contextWindow on local backends; on a paid provider it is the send cap,
   * which is the only honest denominator for the token counter. A 262k model
   * whose steps are capped at 64k is not "25 percent full", it is full.
   */
  sendWindow: number
  /** True when the value is the model's real, confirmed live context (Ollama
   *  num_ctx, or LM Studio's loaded_context_length) rather than a fallback. */
  isTrue: boolean
  /** Whether the user can change it from the dropdown (local backends only). */
  adjustable: boolean
}

/** What the hook reports while there is no model, or none resolved yet. */
const NO_CONTEXT: ActiveContext = {
  provider: 'unknown', contextWindow: 0, modelMax: 0, sendWindow: 0, isTrue: false, adjustable: false,
}

/**
 * Resolve the REAL context window of the active model, provider-aware, so the
 * TokenCounter denominator and the Context dropdown agree and never lie:
 *   - Ollama:    num_ctx we send = effectiveContextWindow(realCtx, override).
 *   - LM Studio: loaded_context_length from the enhanced REST API — the value
 *                the model is genuinely running with (NOT its theoretical max).
 *   - Cloud:     the model's fixed max (can't be changed; not adjustable).
 *
 * `reloadTick` lets the dropdown force a re-read right after it reloads a model.
 */
export function useActiveContextWindow(reloadTick = 0): ActiveContext {
  const activeModel = useModelStore((s) => s.activeModel)
  const override = useSettingsStore((s) => s.settings.contextWindowOverride)
  const builtinCtx = useSettingsStore((s) => s.settings.builtinEngine.ctx)
  const sendWindowTokens = useSettingsStore((s) => s.settings.codexSendWindowTokens)
  const capEnabled = useSettingsStore((s) => s.settings.contextDecay)
  // The resolved window carries the model it was resolved FOR. That tag does
  // two jobs: the "no model" case becomes a derivation instead of a setState
  // fired from the effect body (React 19 `set-state-in-effect`), and a model
  // switch no longer reports the PREVIOUS model's window during the probe.
  // The second one matters for this hook in particular — everything above is
  // about the counter never lying, and "62k of 262k" under a model that has
  // 8k is exactly the lie. Unresolved reads as unknown, which is the state
  // every consumer already handles on mount.
  const [resolved, setResolved] = useState<{ model: string; ctx: ActiveContext } | null>(null)

  // Re-read whenever a model reload finishes anywhere (the Context dropdown
  // fires this), so every consumer — counter AND dropdown — reflects the new
  // loaded context at the same time instead of drifting.
  const [reloadBump, setReloadBump] = useState(0)
  useEffect(() => {
    const onReloaded = () => setReloadBump((b) => b + 1)
    window.addEventListener('lu-context-reloaded', onReloaded)
    return () => window.removeEventListener('lu-context-reloaded', onReloaded)
  }, [])

  useEffect(() => {
    if (!activeModel) return
    let cancelled = false
    const providerId = getProviderIdFromModel(activeModel)
    const setState = (ctx: ActiveContext) => setResolved({ model: activeModel, ctx })

    ;(async () => {
      // ── Ollama: num_ctx is per-request, so what we send == what runs. ──
      if (providerId === 'ollama') {
        const max = await getModelContextCached(activeModel).catch(() => 0)
        if (cancelled) return
        const ollamaCtx = effectiveContextWindow(max, override)
        setState({
          provider: 'ollama',
          contextWindow: ollamaCtx,
          modelMax: max,
          // Local backend: nothing is billed, so the send window IS the window.
          sendWindow: ollamaCtx,
          isTrue: true,
          adjustable: true,
        })
        return
      }

      // ── Built-in engine (app-managed llama-server): status.ctx is the -c
      //    the server was STARTED with — the true denominator (ENG-3). Must
      //    come before the LM Studio probe: the bundled server is
      //    openai-compat too and would otherwise fall through to the cloud
      //    branch, where the counter lies. ──
      if (providerId === 'openai' && isManagedBuiltinSlot()) {
        const status = await bundledEngineStatus().catch(() => null)
        if (cancelled) return
        // Trained ceiling from the GGUF header (via the model listing) caps
        // the dropdown presets; 0 = unknown = uncapped (pre-listing or a
        // header without the key).
        const modelMax = bundledCtxTrain(activeModel)
        if (status?.running && typeof status.ctx === 'number' && status.ctx > 0) {
          setState({
            provider: 'builtin',
            contextWindow: status.ctx,
            modelMax,
            sendWindow: status.ctx,
            isTrue: true,
            adjustable: true,
          })
        } else {
          // Managed but not up (offloaded / before first send): the next
          // start uses the tuning value, so that IS the honest prediction.
          // Dieselbe Konstante, mit der der Motor wirklich startet
          // (lib/builtin-ctx). Hier stand 8192 als Zahl: wer die Konstante auf
          // 16384 setzt, bekaeme sonst eine Klapplade, die 16K sagt, und einen
          // Zaehler, der weiter durch 8192 teilt.
          const nextCtx = builtinCtx > 0 ? builtinCtx : ENGINE_DEFAULT_CTX
          setState({
            provider: 'builtin',
            contextWindow: nextCtx,
            modelMax,
            sendWindow: nextCtx,
            isTrue: false,
            adjustable: true,
          })
        }
        return
      }

      // ── openai-compat: probe LM Studio's enhanced API. A real loaded/max
      //    value means it IS LM Studio; null means a cloud/other openai server. ──
      if (providerId === 'openai') {
        const modelId = displayModelName(activeModel)
        const info = await getLmStudioModelContext(modelId)
        if (cancelled) return
        if (info.loaded || info.max) {
          const loaded = info.loaded ?? 0
          const max = info.max ?? loaded
          const lmCtx = loaded > 0
            ? loaded                                   // TRUE: what LM Studio actually loaded
            : (override > 0 ? override : Math.min(max || 8192, 16384))
          setState({
            provider: 'lmstudio',
            contextWindow: lmCtx,
            modelMax: max,
            sendWindow: lmCtx,
            isTrue: loaded > 0,
            adjustable: true,
          })
          return
        }
      }

      // ── Cloud / other: fixed context, not adjustable from here. The
      // DEFAULT_CONTEXT_CAP and the local num_ctx override are local-runtime
      // levers — applying them here would falsify the denominator for
      // 128k-context hosted models. ──
      const max = await getModelMaxTokens(activeModel).catch(() => 4096)
      if (cancelled) return
      setState({
        provider: 'cloud',
        contextWindow: max,
        modelMax: max,
        // Meter honesty (plan A2): a paid step never sends more than the cap,
        // so the cap is what the counter divides by.
        sendWindow: effectiveSendWindow({
          providerId,
          modelWindow: max,
          sendWindowTokens,
          capEnabled,
        }),
        isTrue: false,
        adjustable: false,
      })
    })()

    return () => { cancelled = true }
  }, [activeModel, override, builtinCtx, sendWindowTokens, capEnabled, reloadTick, reloadBump])

  return activeModel && resolved?.model === activeModel ? resolved.ctx : NO_CONTEXT
}
