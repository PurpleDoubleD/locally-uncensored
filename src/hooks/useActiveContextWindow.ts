import { useState, useEffect } from 'react'
import { useModelStore } from '../stores/modelStore'
import { useSettingsStore } from '../stores/settingsStore'
import { getProviderIdFromModel, displayModelName, openaiEntryOfModel, isOpenAISlotModel } from '../api/providers'
import { getModelContextInfoCached } from '../api/ollama'
import { getLmStudioModelContext } from '../api/lmstudio'
import { getModelMaxTokens } from '../lib/context-compaction'
import { ollamaWindowFor, type WindowUse } from '../lib/context-window'
import { useChatStore } from '../stores/chatStore'
import { useAgentModeStore } from '../stores/agentModeStore'
import { effectiveSendWindow, isPaidProvider, sendWindowFor } from '../lib/send-window'
import { isManagedBuiltinSlot } from '../api/builtin-ensure'
import { ENGINE_DEFAULT_CTX } from '../lib/builtin-ctx'
import { bundledEngineStatus, bundledCtxTrain } from '../api/engine'
import { getProviderForModel } from '../api/providers'
import type { ContextSource } from '../lib/context-source'
import type { ProviderClient } from '../api/providers/types'
import { resolveActiveWindow } from '../lib/context-source'
import { lmStudioLoadContext, savedLmStudioContext } from '../lib/lmstudio-context-pick'
import { sendsToALanBackend, openaiConfigOfModel } from '../lib/lan-openai-slot'
import { hasForeignBackends } from '../lib/capabilities'

/** `custom` ist jeder andere OpenAI-kompatible Server auf diesem Rechner oder
 *  im LAN: llama.cpp, vLLM, KoboldCpp, text-generation-webui (GH #129). */
export type CtxProvider = 'ollama' | 'lmstudio' | 'builtin' | 'cloud' | 'custom' | 'unknown'

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
  /**
   * Woher die Zahl stammt: vom Server, vom Nutzer, oder geraten (GH #129).
   * Der Zaehler schreibt es in seinen Werkzeugtext, und `applyMaxTokens`
   * leitet nur aus den ersten beiden ein `max_tokens` ab.
   */
  source: ContextSource
  /**
   * Der Schluessel, unter dem die Wahl des Nutzers gespeichert wird
   * (`<baseUrl>|<modelId>`). Leer, wo es keine modellgenaue Wahl gibt.
   */
  windowKey: string
  /**
   * Die gespeicherte Wahl, die ueber dem laufenden Fenster des Servers lag und
   * darauf geklemmt wurde (0 oder fehlend = nichts geklemmt). Nur der eigene
   * OpenAI-kompatible Endpunkt kennt diesen Fall: Ollama, LM Studio und der
   * LU-Motor laden bei einer Wahl neu, ein fremder Server nicht.
   */
  clampedFrom?: number
  /**
   * Ollama only: no source named the model's maximum (GH #166). `modelMax` is
   * then 0, and the picker says that it cannot check the values it offers.
   */
  maxUnknown?: boolean
  /** Ollama only: what Auto sends, which an unknown maximum keeps small. */
  autoWindow?: number
  /**
   * C77 (Discord, 11.11.2026): a hosted OpenAI-compatible API
   * that names no window for its model. The window was then a guess from the
   * name, 8192 at the floor, and nothing could change it: the picker of a
   * paid model only sets the send window, and "Context window (Ollama)" is
   * Ollama's. Here the user may say what the model really has; saved per
   * endpoint and model under `modelWindowKey` in `contextWindowByModel`,
   * which the provider's cascade already reads (step 2, GH #129).
   * Absent where the server says its window, or for other providers.
   */
  modelWindowSettable?: boolean
  modelWindowKey?: string
  /** The model's own window and where it comes from (cloud branch). */
  modelWindow?: number
  modelWindowSource?: ContextSource
  /** Cloud only: the send window can be set (a paid provider with the cap on). */
  sendAdjustable?: boolean
}

/** What the hook reports while there is no model, or none resolved yet. */
const NO_CONTEXT: ActiveContext = {
  provider: 'unknown', contextWindow: 0, modelMax: 0, sendWindow: 0, isTrue: false,
  adjustable: false, source: 'guess', windowKey: '',
}

/** Der Client zu einem Modellnamen, ohne zu werfen, wenn der Slot fehlt. */
function safeProviderFor(modelName: string): { provider: ProviderClient | null; modelId: string } {
  try {
    const { provider, modelId } = getProviderForModel(modelName)
    return { provider, modelId }
  } catch {
    return { provider: null, modelId: displayModelName(modelName) }
  }
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
/**
 * Woher das Fenster eines ferngesteuerten Modells stammt.
 *
 * R2-5: hier stand `?? 'probe'`, und "probe" heisst im Werkzeugtext des
 * Zaehlers "from server". Antwortet der Anbieter gar nicht, faellt `max` aber
 * auf die KNOWN_CONTEXT-Tabelle dieses Hauses, auf die Namensheuristik oder
 * ganz auf die 4096 aus `context-compaction.ts`. Der Nutzer las dann eine
 * geratene Zahl als Auskunft des Betreibers und richtete seinen Sendedeckel
 * danach. Eine Auskunft ist es nur, wenn der Anbieter sie wirklich gegeben hat
 * oder wenn es der eigene Katalog ist; sonst steht dort "estimated", was
 * `SOURCE_LABEL.guess` schon sagt.
 */
export function remoteWindowSource(
  providerId: string,
  resolved: ContextSource | undefined,
  max: number,
): ContextSource {
  if (resolved) return resolved
  return providerId === 'lu-cloud' && max > 0 ? 'probe' : 'guess'
}

/**
 * The last window each model resolved to, for the whole app session. The
 * counter mounts with a conversation's first message, and a fresh mount used
 * to start unresolved: for the length of the provider probe it divided by a
 * stand-in and read "18/16K", then "30/32K" (Gegenprobe 01.10.2026). A mount
 * now starts from what this model last resolved to and the probe refreshes
 * it, so the number only changes when the window really did.
 */
const lastResolved = new Map<string, ActiveContext>()

/**
 * Which of the two Ollama windows the conversation on screen runs in: the
 * agent window in the Code tab and with Agent mode on, the chat window
 * otherwise. The same split the turn hooks make when they send.
 */
export function useActiveWindowUse(): WindowUse {
  const id = useChatStore((s) => s.activeConversationId)
  const code = useChatStore((s) => s.conversations.find((c) => c.id === id)?.mode === 'codex')
  const agent = useAgentModeStore((s) => (id ? s.agentModeActive[id] ?? false : false))
  return code || agent ? 'agent' : 'chat'
}

/**
 * GitHub #173: is this model's backend an additional entry that points at LM
 * Studio on this machine, the one `getLmStudioModelContext` asks.
 */
function isThisMachinesLmStudio(model: string): boolean {
  if (!openaiEntryOfModel(model)) return false
  const cfg = openaiConfigOfModel(model)
  if (!cfg) return false
  try {
    const u = new URL(cfg.baseUrl)
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
    return loopback && u.port === '1234'
  } catch {
    return false
  }
}

/** The settings the window of a model depends on. */
export interface ContextKnobs {
  override: number
  builtinCtx: number
  globalSendWindow?: number
  cloudPicks?: Record<string, number>
  capEnabled?: boolean
  /** settings.contextWindowByModel: the per model picks (GH #129, GH #168). */
  byModel?: Record<string, number>
}

/** The same knobs, read from the settings store right now. */
export function currentContextKnobs(): ContextKnobs {
  const s = useSettingsStore.getState().settings
  return {
    override: s.contextWindowOverride,
    builtinCtx: s.builtinEngine.ctx,
    globalSendWindow: s.codexSendWindowTokens,
    cloudPicks: s.cloudSendWindowByModel,
    capEnabled: s.contextDecay,
    byModel: s.contextWindowByModel,
  }
}

/**
 * The real context window of one model, provider-aware. The body of
 * `useActiveContextWindow`, so a send (GH #171: how much of an attached file
 * fits) asks exactly what the counter shows instead of a second guess.
 */
export async function resolveModelContext(model: string, use: WindowUse, k: ContextKnobs): Promise<ActiveContext> {
  const providerId = getProviderIdFromModel(model)
  // ── Ollama: num_ctx is per-request, so what we send == what runs. ──
  if (providerId === 'ollama') {
    const info = await getModelContextInfoCached(model).catch(() => ({ max: 0, known: false }))
    // The same numbers `ollamaNumCtx` sends with, so counter, picker and
    // request agree. An unknown maximum still sends its stand in on Auto.
    const ollamaCtx = ollamaWindowFor(use, info.max, k.override)
    return {
      provider: 'ollama',
      contextWindow: ollamaCtx,
      // GH #166: a stand in is no ceiling. A server that named no length
      // (KoboldCpp behind its Ollama emulation) got a picker that ended at
      // the 4096 stand in. 0 opens the whole list, and `maxUnknown` makes
      // the picker say that LU cannot check the values.
      modelMax: info.known ? info.max : 0,
      maxUnknown: !info.known,
      autoWindow: ollamaWindowFor(use, info.max),
      // Local backend: nothing is billed, so the send window IS the window.
      sendWindow: ollamaCtx,
      isTrue: k.override > 0 || info.known,
      adjustable: true,
      source: k.override > 0 ? 'user' : info.known ? 'probe' : 'guess',
      windowKey: '',
    }
  }

  // ── Built-in engine (app-managed llama-server): status.ctx is the -c
  //    the server was STARTED with — the true denominator (ENG-3). Must
  //    come before the LM Studio probe: the bundled server is
  //    openai-compat too and would otherwise fall through to the cloud
  //    branch, where the counter lies. ──
  // GitHub #173: only a model of the slot itself. A model of an additional
  // OpenAI-compatible entry runs on that entry's server, and the engine's -c
  // says nothing about it.
  if (providerId === 'openai' && isOpenAISlotModel(model) && isManagedBuiltinSlot()) {
    const status = await bundledEngineStatus().catch(() => null)
    // Trained ceiling from the GGUF header (via the model listing) caps
    // the dropdown presets; 0 = unknown = uncapped (pre-listing or a
    // header without the key).
    const modelMax = bundledCtxTrain(model)
    if (status?.running && typeof status.ctx === 'number' && status.ctx > 0) {
      return {
        provider: 'builtin',
        contextWindow: status.ctx,
        modelMax,
        sendWindow: status.ctx,
        isTrue: true,
        adjustable: true,
        // Der laufende Motor hat gesagt, mit welchem -c er startete.
        source: 'probe',
        windowKey: '',
      }
    } else {
      // Managed but not up (offloaded / before first send): the next
      // start uses the tuning value, so that IS the honest prediction.
      // Dieselbe Konstante, mit der der Motor wirklich startet
      // (lib/builtin-ctx). Hier stand 8192 als Zahl: wer die Konstante auf
      // 16384 setzt, bekaeme sonst eine Klapplade, die 16K sagt, und einen
      // Zaehler, der weiter durch 8192 teilt.
      const { builtinCtx } = k
      const nextCtx = builtinCtx > 0 ? builtinCtx : ENGINE_DEFAULT_CTX
      return {
        provider: 'builtin',
        contextWindow: nextCtx,
        modelMax,
        sendWindow: nextCtx,
        isTrue: false,
        adjustable: true,
        // Eine Vorhersage des naechsten Starts, kein Messwert.
        source: 'guess',
        windowKey: '',
      }
    }
  }

  // ── openai-compat: probe LM Studio's enhanced API. A real loaded/max
  //    value means it IS LM Studio; null means a cloud/other openai server. ──
  // The question goes to LM Studio on this machine (127.0.0.1:1234, through
  // the app), so it is asked for the slot as before, and for an additional
  // entry only when that entry IS this machine's LM Studio. Any other entry
  // (KoboldCpp, llama.cpp, an LM Studio elsewhere) is asked through its own
  // server in the branch below; a model of the same name in the local LM
  // Studio must not lend it its window (GitHub #173).
  if (providerId === 'openai' && (isOpenAISlotModel(model) || isThisMachinesLmStudio(model))) {
    const modelId = displayModelName(model)
    // Not on a phone: there is no LM Studio to ask, and the command behind
    // the probe does not exist there.
    const info = hasForeignBackends()
      ? await getLmStudioModelContext(modelId)
      : { loaded: null, max: null, state: null }
    if (info.loaded || info.max) {
      const loaded = info.loaded ?? 0
      const max = info.max ?? loaded
      // Not loaded: the next load LU starts asks for this model's own
      // pick (GH #168), or the auto window. The shared Ollama override
      // is not LM Studio's number.
      const saved = savedLmStudioContext({ contextWindowByModel: k.byModel }, model)
      const lmCtx = loaded > 0
        ? loaded                                   // TRUE: what LM Studio actually loaded
        : lmStudioLoadContext(saved, max, 16384)
      return {
        provider: 'lmstudio',
        contextWindow: lmCtx,
        modelMax: max,
        sendWindow: lmCtx,
        isTrue: loaded > 0,
        adjustable: true,
        source: loaded > 0 ? 'probe' : saved > 0 ? 'user' : 'guess',
        windowKey: '',
      }
    }
  }

  /*
   * GH #129: jeder ANDERE OpenAI-kompatible Server auf diesem Rechner oder
   * im LAN. llama.cpp, vLLM, KoboldCpp, text-generation-webui, Jan.
   *
   * Bis hierher fielen sie alle in den Cloud-Zweig unten, und der tut
   * zweierlei, was fuer eine eigene Maschine falsch ist: er nennt das
   * Fenster nicht verstellbar (also kein Waehler, obwohl der Nutzer der
   * Einzige ist, der die Zahl kennt), und er zieht den BEZAHLTEN
   * Sendedeckel ab, obwohl hier niemand etwas bezahlt. Beim Melder ergab
   * das aus einer geratenen 8192 die Anzeige "6.4K" (8192 mal 0,8, geteilt
   * durch 1024) neben einem Modell mit 262144.
   */
  // A phone's extra OpenAI-compatible slot counts the same (sendsToALanBackend).
  if (sendsToALanBackend(providerId, model)) {
    const { provider, modelId } = safeProviderFor(model)
    const resolved = provider?.getContextWindow
      ? await provider.getContextWindow(modelId).catch(() => null)
      : null
    if (provider && resolved && resolved.tokens > 0) {
      const win = resolveActiveWindow({ resolved, localBackend: true })
      return {
        provider: 'custom',
        contextWindow: win.contextWindow,
        modelMax: win.modelMax,
        sendWindow: win.sendWindow,
        isTrue: win.isTrue,
        adjustable: win.adjustable,
        source: win.source,
        windowKey: provider.contextWindowKey?.(modelId) ?? '',
        clampedFrom: win.clampedFrom,
      }
    }
  }

  // ── Cloud / other: fixed context, not adjustable from here. The
  // DEFAULT_CONTEXT_CAP and the local num_ctx override are local-runtime
  // levers — applying them here would falsify the denominator for
  // 128k-context hosted models. ──
  const { provider: cloudClient, modelId: cloudId } = safeProviderFor(model)
  const cloudResolved = cloudClient?.getContextWindow
    ? await cloudClient.getContextWindow(cloudId).catch(() => null)
    : null
  const max = cloudResolved?.tokens || await getModelMaxTokens(model).catch(() => 4096)
  const sendAdjustable = isPaidProvider(providerId, sendsToALanBackend(providerId, model))
  const windowSource = remoteWindowSource(providerId, cloudResolved?.source, max)
  // C77: an OpenAI-compatible endpoint (it has a per model window key) that
  // did not say its window. A window the server named is never overridden
  // from here: the cascade clamps a pick to it anyway.
  const modelWindowKey = providerId !== 'lu-cloud' && cloudClient?.contextWindowKey ? cloudClient.contextWindowKey(cloudId) : ''
  const modelWindowSettable = !!modelWindowKey && !!cloudResolved && (cloudResolved.source === 'guess' || cloudResolved.source === 'user')
  return {
    provider: 'cloud',
    contextWindow: max,
    modelMax: max,
    // Meter honesty (plan A2): a paid step never sends more than the cap,
    // so the cap is what the counter divides by.
    sendWindow: effectiveSendWindow({
      providerId,
      modelWindow: max,
      sendWindowTokens: sendWindowFor({ codexSendWindowTokens: k.globalSendWindow, cloudSendWindowByModel: k.cloudPicks }, model),
      capEnabled: k.capEnabled,
      // Der Zweig oben kehrt nur um, wenn der eigene Server ein Fenster
      // GENANNT hat. Sagt er keins, faellt er bis hierher durch, und ohne
      // diese Zeile bekaeme er dann doch den bezahlten Deckel.
      localBackend: sendsToALanBackend(providerId, model),
    }),
    isTrue: false,
    // The model's own window belongs to the remote deployment, but on a
    // paid provider the send window is the user's lever: how much of the
    // conversation each step sends and pays for. The dropdown sets it per
    // model (settings.cloudSendWindowByModel). A LAN server that fell
    // through to here bills nobody, so there is nothing to choose.
    adjustable: sendAdjustable || modelWindowSettable,
    sendAdjustable,
    // Woher die Zahl kommt, auch wenn sie hier niemand verstellen kann.
    source: windowSource,
    windowKey: model,
    modelWindow: max,
    modelWindowSource: windowSource,
    ...(modelWindowSettable ? { modelWindowSettable, modelWindowKey } : {}),
  }
}

/**
 * `model` (GH #167): resolve the window of this model instead of the one the
 * picker stands on. The counter in a group chat passes the speaker it counts
 * for, so its number and its window describe the same model. Same probes,
 * same cache, nothing else differs.
 */
export function useActiveContextWindow(reloadTick = 0, model?: string): ActiveContext {
  const pickerModel = useModelStore((s) => s.activeModel)
  const activeModel = model || pickerModel
  const windowUse = useActiveWindowUse()
  const override = useSettingsStore((s) => s.settings.contextWindowOverride)
  const builtinCtx = useSettingsStore((s) => s.settings.builtinEngine.ctx)
  const globalSendWindow = useSettingsStore((s) => s.settings.codexSendWindowTokens)
  const cloudPicks = useSettingsStore((s) => s.settings.cloudSendWindowByModel)
  const capEnabled = useSettingsStore((s) => s.settings.contextDecay)
  const byModel = useSettingsStore((s) => s.settings.contextWindowByModel)
  // The resolved window carries the model it was resolved FOR. That tag does
  // two jobs: the "no model" case becomes a derivation instead of a setState
  // fired from the effect body (React 19 `set-state-in-effect`), and a model
  // switch no longer reports the PREVIOUS model's window during the probe.
  // The second one matters for this hook in particular — everything above is
  // about the counter never lying, and "62k of 262k" under a model that has
  // 8k is exactly the lie. Unresolved reads as unknown, which is the state
  // every consumer already handles on mount.
  const [resolved, setResolved] = useState<{ model: string; ctx: ActiveContext } | null>(() => {
    const known = activeModel ? lastResolved.get(activeModel) : undefined
    return activeModel && known ? { model: activeModel, ctx: known } : null
  })

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
    const setState = (ctx: ActiveContext) => {
      lastResolved.set(activeModel, ctx)
      setResolved({ model: activeModel, ctx })
    }

    resolveModelContext(activeModel, windowUse, { override, builtinCtx, globalSendWindow, cloudPicks, capEnabled, byModel })
      .then((ctx) => { if (!cancelled) setState(ctx) })
      .catch(() => { /* the counter keeps what it had; the next change asks again */ })

    return () => { cancelled = true }
  }, [activeModel, override, windowUse, builtinCtx, globalSendWindow, cloudPicks, capEnabled, reloadTick, reloadBump, byModel])

  return activeModel && resolved?.model === activeModel ? resolved.ctx : NO_CONTEXT
}
