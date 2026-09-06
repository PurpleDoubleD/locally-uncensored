/**
 * Provider Registry — singleton that manages provider instances.
 *
 * Resolves which provider to use for a given model name.
 * Creates/caches provider client instances based on store config.
 */

import type { ProviderId, ProviderClient, ProviderConfig } from './types'
import { OllamaProvider } from './ollama-provider'
import { OpenAIProvider } from './openai-provider'
import { AnthropicProvider } from './anthropic-provider'
import { LuCloudProvider } from './lu-cloud-provider'
import { useProviderStore } from '../../stores/providerStore'
import { cachedClient } from './client-cache'

// Cache und Namens-Helfer sind aus diesem Modul herausgezogen (Audit W-T2,
// Begründung steht in client-cache.ts bzw. model-name.ts). Re-Export, damit
// bestehende Importpfade unverändert bleiben.
export { clearProviderCache } from './client-cache'
export { getProviderIdFromModel, prefixModelName, displayModelName } from './model-name'

/**
 * Create a provider client from config.
 */
function createClient(config: ProviderConfig): ProviderClient {
  switch (config.id) {
    case 'ollama':
      return new OllamaProvider(config)
    case 'openai':
      return new OpenAIProvider(config)
    case 'anthropic':
      return new AnthropicProvider(config)
    case 'lu-cloud':
      return new LuCloudProvider(config)
    default:
      throw new Error(`Unknown provider: ${config.id}`)
  }
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Get a provider client by ID. Uses cached instance if config hasn't changed.
 */
export function getProvider(id: ProviderId): ProviderClient {
  const state = useProviderStore.getState()
  const stored = state.providers[id]
  if (!stored) throw new Error(`Provider not configured: ${id}`)

  // The store keeps apiKey OBFUSCATED in memory (see providerStore). Handing
  // the raw state to the client sent a garbled Bearer token on every chat /
  // agent / Test-button request, while the model list (getEnabledProviders,
  // which deobfuscates) worked — Groq answered "Invalid API Key", OpenRouter's
  // public /models made Test claim "connected" and chat then 401ed
  // (m9mx Discord 2026-07-26, four providers).
  const config = { ...stored, apiKey: state.getProviderApiKey(id) }

  return cachedClient(config, () => createClient(config))
}

/**
 * Get the provider for a specific model.
 *
 * Model names are stored with a provider prefix in the model store:
 *   "ollama::llama3.1:8b"  →  Ollama
 *   "openai::gpt-4o"       →  OpenAI
 *   "anthropic::claude-sonnet-4-20250514"  →  Anthropic
 *
 * If no prefix, defaults to Ollama (backward compatibility).
 */
export function getProviderForModel(modelName: string): { provider: ProviderClient; modelId: string } {
  const parts = modelName.split('::')

  if (parts.length === 2) {
    const providerId = parts[0] as ProviderId
    return { provider: getProvider(providerId), modelId: parts[1] }
  }

  // No prefix → Ollama (backward compat)
  return { provider: getProvider('ollama'), modelId: modelName }
}

/**
 * Get all enabled provider clients.
 */
export function getEnabledProviders(): ProviderClient[] {
  const configs = useProviderStore.getState().getEnabledProviders()
  return configs.map(c => cachedClient(c, () => createClient(c)))
}
