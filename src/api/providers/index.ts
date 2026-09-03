// Multi-Provider System — re-exports

export type {
  ProviderId, ProviderConfig, ProviderPreset, ProviderModel,
  ChatMessage, ChatOptions, ChatStreamChunk, ToolCall, ToolDefinition,
  ProviderClient,
} from './types'
export { ProviderError, PROVIDER_PRESETS } from './types'

export { OllamaProvider } from './ollama-provider'
export { OpenAIProvider } from './openai-provider'
export { AnthropicProvider } from './anthropic-provider'

export { getProvider, getProviderForModel, getEnabledProviders } from './registry'
// Aus den Blattmodulen, nicht über registry.ts: wer nur einen Modellnamen
// zerlegen oder den Client-Cache leeren will, soll dafür nicht die
// Provider-Fabrik und den providerStore mitziehen (Audit W-T2).
export { getProviderIdFromModel, prefixModelName, displayModelName } from './model-name'
export { clearProviderCache } from './client-cache'
