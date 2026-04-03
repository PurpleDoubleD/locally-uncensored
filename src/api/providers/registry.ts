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
import { useProviderStore } from '../../stores/providerStore'

// ── Provider client cache ──────────────────────────────────────

const clientCache: Map<string, ProviderClient> = new Map()

/**
 * Create a unique cache key for a provider config.
 * Invalidates when URL or API key changes.
 */
function cacheKey(config: ProviderConfig): string {
  return `${config.id}:${config.baseUrl}:${config.apiKey?.slice(0, 8) || ''}`
}

/**
 * Create a provider client from config.
 */
function createClient(config: ProviderConfig): ProviderClient {
  switch (config.id) {
    case 'ollama':
      return new OllamaProvider()
    case 'openai':
      return new OpenAIProvider(config)
    case 'anthropic':
      return new AnthropicProvider(config)
    default:
      throw new Error(`Unknown provider: ${config.id}`)
  }
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Get a provider client by ID. Uses cached instance if config hasn't changed.
 */
export function getProvider(id: ProviderId): ProviderClient {
  const config = useProviderStore.getState().providers[id]
  if (!config) throw new Error(`Provider not configured: ${id}`)

  const key = cacheKey(config)
  let client = clientCache.get(key)
  if (!client) {
    client = createClient(config)
    clientCache.set(key, client)
  }
  return client
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
  return configs.map(c => {
    const key = cacheKey(c)
    let client = clientCache.get(key)
    if (!client) {
      client = createClient(c)
      clientCache.set(key, client)
    }
    return client
  })
}

/**
 * Extract the provider ID from a prefixed model name.
 * Returns 'ollama' if no prefix.
 */
export function getProviderIdFromModel(modelName: string): ProviderId {
  const parts = modelName.split('::')
  return parts.length === 2 ? parts[0] as ProviderId : 'ollama'
}

/**
 * Create a prefixed model name for storage.
 */
export function prefixModelName(provider: ProviderId, modelId: string): string {
  if (provider === 'ollama') return modelId // backward compat: Ollama models have no prefix
  return `${provider}::${modelId}`
}

/**
 * Get the display name for a model (strip provider prefix).
 */
export function displayModelName(modelName: string): string {
  const parts = modelName.split('::')
  return parts.length === 2 ? parts[1] : modelName
}

/**
 * Clear the client cache (e.g. when provider config changes).
 */
export function clearProviderCache(): void {
  clientCache.clear()
}
