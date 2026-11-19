// The brain of a voice session: which model answers, and where it lives.
//
// A voice session talks to the chat model that is selected right now, through
// the same provider system as the chat. The voice loop process calls that
// model itself (it streams the answer straight into the speech engine), so
// this file works out what it needs for that: an OpenAI-compatible base URL,
// the model id, and the credential when the endpoint wants one.
//
// The credential is returned to the caller and goes into ONE request to the
// voice loop on this machine. It is never written to a store and never logged
// (`describeVoiceBrain` is the only thing meant for a log line).

import { resolveToolCallingStrategy } from '../lib/agent-strategy'
import { clampEffort, hasEffortLadder } from '../lib/effort'
import { isThinkingCompatible } from '../lib/model-compatibility'
import { buildSamplingRequest } from '../lib/sampling'
import { useModelStore } from '../stores/modelStore'
import { useProviderStore } from '../stores/providerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { hostnameOf, isPrivateOrLanHost } from './backend'
import { ensureBuiltinAgentCtx, ensureBuiltinEngineAlive } from './builtin-ensure'
import { CLOUD_BASE } from './cloud/config'
import { getAccessToken } from './cloud/supabase'
import { backendCall } from './backend'
import { ollamaNumCtx } from './ollama'
import { displayModelName, openaiEntryOfModel } from './providers/model-name'

/** The `llm` block of the voice loop's session request. */
export interface VoiceLlmConfig {
  base_url: string
  model: string
  api_key?: string
  temperature?: number
  extra?: Record<string, unknown>
  /**
   * Only for a model that Ollama serves: the context window the chat sends
   * for this model. The voice loop then talks to Ollama's own chat API, the
   * only one that takes a window, so Ollama does not load the model again
   * between a chat and a voice session.
   */
  ollama_num_ctx?: number
}

export interface VoiceBrain {
  llm: VoiceLlmConfig
  providerId: string
  /** The model as the picker names it. */
  modelLabel: string
  /** False for a model that cannot call tools through its own API. */
  toolsSupported: boolean
  /** The endpoint is on this machine or the local network. */
  local: boolean
  /**
   * Only for a model on the app's own engine, which holds one model at a
   * time: puts this model back after something else used the engine.
   */
  restore?: () => Promise<void>
  /** What to tell the voice loop about thinking, switched on or off. */
  thinking: (wanted: boolean) => VoiceThinkingPlan
}

/**
 * True when another model takes the engine away from the brain: both run on
 * the app's own engine and they are not the same model. While that other
 * model works, the brain cannot answer (see `set_hold` in the voice loop).
 */
export function takesTheEngineFrom(brain: Pick<VoiceBrain, 'llm' | 'restore'>, otherModel: string): boolean {
  if (!brain.restore) return false
  const parts = otherModel.split('::')
  if (parts.length !== 2 || parts[0] !== 'openai') return false
  return parts[1] !== brain.llm.model
}

export type VoiceBrainErrorKind = 'no-model' | 'unsupported-model' | 'signed-out' | 'model-error'

export class VoiceBrainError extends Error {
  readonly kind: VoiceBrainErrorKind
  constructor(kind: VoiceBrainErrorKind, message: string) {
    super(message)
    this.name = 'VoiceBrainError'
    this.kind = kind
  }
}

export interface VoiceThinkingInput {
  providerId: string
  /** The endpoint is on this machine or the local network. */
  local: boolean
  /** What the server declared for this model, when it declared anything. */
  thinkMode?: 'toggle' | 'always' | 'never'
  effortLevels?: readonly string[]
  effortDefault?: string
  /** The model family is known to reason (the picker's own heuristic). */
  reasons: boolean
}

/**
 * The request fields that make a reasoning model answer without thinking.
 *
 * A spoken answer that starts after ten seconds of silent reasoning feels
 * broken, so unless the user switched thinking on, voice asks for none. It
 * uses the knobs the provider system already knows:
 *
 *   - A model that never reasons: nothing.
 *   - A model that always reasons: its cheapest declared rung, nothing when
 *     it declares none ('none' would not stop it, see lib/effort.ts).
 *   - Ollama: `reasoning_effort: 'none'`, for every model. Ollama takes it
 *     for a model without the capability too, and the name of a model says
 *     too little about whether it reasons (a build that reasons inside its
 *     answer reports no capability at all).
 *   - LU Cloud: the same off switch, for a model that can switch.
 *   - A local OpenAI-compatible server (LU Engine, LM Studio, llama.cpp):
 *     the off switch plus `enable_thinking: false` for the model's own chat
 *     template, which is the knob such a server really reads.
 *   - Any other endpoint: its cheapest declared rung, else nothing.
 *
 * A server that refuses one of these is asked again without them by the
 * voice loop, so a field too many costs one request and never a session.
 */
export function voiceThinkingExtra(input: VoiceThinkingInput): Record<string, unknown> {
  const ladder = hasEffortLadder(input.effortLevels)
  const cheapest = () => (ladder ? { reasoning_effort: clampEffort(input.effortLevels, 'low', input.effortDefault) } : {})
  if (input.thinkMode === 'never') return {}
  if (input.thinkMode === 'always') return cheapest()
  if (input.providerId === 'ollama') return { reasoning_effort: 'none' }
  const canSwitchOff = input.thinkMode === 'toggle' || input.reasons
  if (!canSwitchOff) return {}
  if (input.providerId === 'lu-cloud') return { reasoning_effort: 'none' }
  if (input.providerId === 'openai' && input.local) {
    return { reasoning_effort: 'none', extra_body: { chat_template_kwargs: { enable_thinking: false } } }
  }
  return cheapest()
}

/**
 * The request fields for a session in which the user switched thinking on.
 * Voice asks for the cheapest rung a model declares: the thought is silence
 * for the listener. A model without rungs thinks the way its server decides,
 * and a local server is told to let the chat template reason.
 */
export function voiceThinkingOnExtra(input: VoiceThinkingInput): Record<string, unknown> {
  if (input.thinkMode === 'never') return {}
  // Local models have rungs too since issue 176. The template switch must
  // still ride along there, or a rung would cost the local model its thought.
  if (input.providerId === 'openai' && input.local && (input.thinkMode === 'toggle' || input.reasons)) {
    const on = { extra_body: { chat_template_kwargs: { enable_thinking: true } } }
    return hasEffortLadder(input.effortLevels)
      ? { reasoning_effort: clampEffort(input.effortLevels, 'low', input.effortDefault), ...on }
      : on
  }
  if (hasEffortLadder(input.effortLevels)) {
    return { reasoning_effort: clampEffort(input.effortLevels, 'low', input.effortDefault) }
  }
  return {}
}

/** What the voice loop is told about thinking, for a session or a change in it. */
export interface VoiceThinkingPlan {
  /** Sent with every request. */
  extra: Record<string, unknown>
  /** Sent when a turn is asked again without thinking. */
  directExtra: Record<string, unknown>
  /** The user wants the model to think, and wants to see it. */
  wanted: boolean
  /**
   * The model thinks whatever it is asked. Its thought is neither cut nor
   * shown: cutting it would only make every turn ask twice.
   */
  always: boolean
}

export function voiceThinkingPlan(input: VoiceThinkingInput, wanted: boolean): VoiceThinkingPlan {
  const off = voiceThinkingExtra(input)
  if (input.thinkMode === 'always') return { extra: off, directExtra: off, wanted: false, always: true }
  return { extra: wanted ? voiceThinkingOnExtra(input) : off, directExtra: off, wanted, always: false }
}

/** Why the Thinking switch of the Voice surface cannot be moved, or null. */
export function voiceThinkingLock(input: Pick<VoiceThinkingInput, 'thinkMode' | 'reasons'>): 'always' | 'never' | null {
  if (input.thinkMode === 'always') return 'always'
  if (input.thinkMode === 'never') return 'never'
  return null
}

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Resolve the selected chat model into what the voice loop needs.
 *
 * Throws a VoiceBrainError with a sentence for the user when no model is
 * selected, the model's provider cannot be used for voice, or the cloud
 * account is signed out.
 */
export async function resolveVoiceBrain(activeModel: string | null | undefined, wantsThinking = false): Promise<VoiceBrain> {
  if (!activeModel) {
    throw new VoiceBrainError('no-model', 'Pick a chat model first. Voice uses the model that is selected in Chat.')
  }
  const { strategy, modelToUse, providerId } = await resolveToolCallingStrategy(activeModel)
  const meta = useModelStore.getState().models.find((m) => m.name === activeModel)
  const thinkMode = meta && 'thinkMode' in meta ? meta.thinkMode : undefined
  const settings = useSettingsStore.getState().settings
  // A ladder read from a local server waits for the user's own pick there
  // (3.0.7, after issue 176); until then voice asks the way it did before.
  const localWaits = !!meta && 'effortLocal' in meta && meta.effortLocal === true && settings.localEffortChosen !== true
  const effortLevels = meta && 'effortLevels' in meta && !localWaits ? meta.effortLevels : undefined
  const effortDefault = meta && 'effortDefault' in meta ? meta.effortDefault : undefined

  let baseUrl: string
  let apiKey: string | undefined
  let local: boolean
  let restore: (() => Promise<void>) | undefined
  let ollamaNumCtxForVoice: number | undefined

  if (providerId === 'lu-cloud') {
    let token: string | null
    try {
      token = await getAccessToken()
    } catch (error) {
      throw new VoiceBrainError('model-error', error instanceof Error ? error.message : 'LU Cloud is unreachable. Check your connection.')
    }
    if (!token) throw new VoiceBrainError('signed-out', 'Sign in to your LU Cloud account to use a cloud model for voice.')
    // Pinned, never read from the provider store: the token is a live bearer
    // and must not follow a tampered base URL (same rule as LuCloudProvider).
    baseUrl = `${CLOUD_BASE}/api/inference/v1`
    apiKey = token
    local = false
  } else if (providerId === 'ollama') {
    const state = useProviderStore.getState()
    baseUrl = `${trimSlashes(state.providers.ollama.baseUrl)}/v1`
    apiKey = state.getProviderApiKey('ollama') || undefined
    local = state.providers.ollama.isLocal === true || isPrivateOrLanHost(hostnameOf(baseUrl))
    // A voice session is a chat that is spoken: it runs in the chat window of
    // this model, from the one place every request to Ollama gets its window.
    ollamaNumCtxForVoice = await ollamaNumCtx(modelToUse, 'chat')
  } else if (providerId === 'openai' && openaiEntryOfModel(activeModel)) {
    // GitHub #258 / A42: a model of an additional OpenAI-compatible entry
    // (LM Studio, Unsloth, any second server) lives at THAT entry's address
    // with THAT entry's key. Reading the fixed slot sent it to the LU Engine.
    // The app manages no entry's lifecycle, so nothing is woken here.
    const entryId = openaiEntryOfModel(activeModel) as string
    const state = useProviderStore.getState()
    const entry = state.openaiEntries.find((e) => e.entryId === entryId)
    if (!entry) {
      throw new VoiceBrainError('model-error', 'The provider of this model was removed. Pick the model again in Chat.')
    }
    baseUrl = trimSlashes(entry.baseUrl)
    apiKey = state.getOpenAIEntryApiKey(entryId) || undefined
    local = entry.isLocal === true || isPrivateOrLanHost(hostnameOf(baseUrl))
  } else if (providerId === 'openai') {
    // The app's own engine sleeps after a render and may hold another model.
    // Wake it on this model before the session starts, exactly as a chat
    // message would. It can come back on another port, so read the URL after.
    if (useProviderStore.getState().providers.openai.managed === true) {
      try {
        await ensureBuiltinEngineAlive(modelToUse)
      } catch (error) {
        throw new VoiceBrainError('model-error', error instanceof Error ? error.message : 'The LU Engine did not start.')
      }
      // Tool schemas need room. Same lift the agent chat gives the engine
      // before a run with tools. Never throws.
      if (strategy === 'native') await ensureBuiltinAgentCtx(modelToUse)
      restore = async () => {
        await ensureBuiltinEngineAlive(modelToUse)
        if (strategy === 'native') await ensureBuiltinAgentCtx(modelToUse)
      }
    }
    const state = useProviderStore.getState()
    baseUrl = trimSlashes(state.providers.openai.baseUrl)
    apiKey = state.getProviderApiKey('openai') || undefined
    // The LU Engine answers to its own key only (src-tauri engine_key.rs), and
    // the voice service talks to it directly. The Rust side hands it out for an
    // address that is one of its engines and for nothing else.
    if (state.providers.openai.managed === true) {
      apiKey = (await backendCall<string | null>('engine_key_for', { url: `${baseUrl}/chat/completions` }).catch(() => null)) ?? apiKey
    }
    local = state.providers.openai.isLocal === true || isPrivateOrLanHost(hostnameOf(baseUrl))
  } else {
    throw new VoiceBrainError(
      'unsupported-model',
      'Voice needs a model with an OpenAI-compatible endpoint. Pick a local model, an OpenAI-compatible provider or an LU Cloud model in Chat.',
    )
  }

  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new VoiceBrainError('model-error', 'The address of this model\'s provider is not a valid http or https URL. Check it under AI Backends in Settings.')
  }

  const thinkingInput: VoiceThinkingInput = {
    providerId,
    local,
    thinkMode,
    effortLevels,
    effortDefault,
    reasons: isThinkingCompatible(activeModel),
  }
  const extra = voiceThinkingPlan(thinkingInput, wantsThinking).extra
  const sampling = buildSamplingRequest(settings)
  const llm: VoiceLlmConfig = { base_url: baseUrl, model: modelToUse }
  if (apiKey) llm.api_key = apiKey
  if (sampling.temperature !== undefined) llm.temperature = sampling.temperature
  if (Object.keys(extra).length > 0) llm.extra = extra
  if (ollamaNumCtxForVoice !== undefined) llm.ollama_num_ctx = ollamaNumCtxForVoice

  return {
    llm,
    providerId,
    modelLabel: displayModelName(activeModel),
    // Only a model that takes a native `tools` field can be offered tools
    // here: the voice loop has no text protocol to fall back to.
    toolsSupported: strategy === 'native',
    local,
    ...(restore ? { restore } : {}),
    thinking: (wanted) => voiceThinkingPlan(thinkingInput, wanted),
  }
}

/** What may be said about a brain in a log line: no key, no URL path. */
export function describeVoiceBrain(brain: VoiceBrain): Record<string, unknown> {
  return {
    providerId: brain.providerId,
    model: brain.llm.model,
    host: hostnameOf(brain.llm.base_url),
    hasKey: Boolean(brain.llm.api_key),
    tools: brain.toolsSupported,
    local: brain.local,
  }
}
