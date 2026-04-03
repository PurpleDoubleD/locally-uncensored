/**
 * Model Compatibility for Agent Mode — now provider-aware.
 *
 * Cloud providers (OpenAI, Anthropic) always support native tool calling.
 * Ollama models need explicit compatibility checks.
 */

import { getProviderIdFromModel } from '../api/providers'
import type { ProviderId } from '../api/providers/types'

const AGENT_COMPATIBLE = [
  // ── Hermes: THE uncensored agent model ──
  'hermes3', 'hermes-3', 'hermes',
  // ── Standard models with native tool calling ──
  'qwen3', 'qwen2.5',
  'llama3.1', 'llama3.2', 'llama3.3', 'llama4',
  'mistral', 'mistral-nemo', 'mistral-small', 'mistral-large',
  'command-r',
  'phi-4', 'phi4',
  'deepseek-v2.5', 'deepseek-v3',
  'glm4', 'glm-4',
  'gemma3',
  'nemotron',
]

/**
 * Check if a model supports Agent Mode.
 * Cloud providers always support tools. Ollama needs explicit check.
 */
export function isAgentCompatible(modelName: string): boolean {
  const providerId = getProviderIdFromModel(modelName)

  // Cloud providers always support tool calling
  if (providerId === 'openai' || providerId === 'anthropic') return true

  // Ollama: check compatibility list
  const name = modelName.toLowerCase()
  if (name.includes('abliterated') || name.includes('uncensored')) return false
  const baseName = name.replace(/^[^/]+\//, '').replace(/-instruct/g, '').replace(/-chat/g, '').replace(/:.*$/, '')
  return AGENT_COMPATIBLE.some((f) => baseName.startsWith(f))
}

export const isToolCallingModel = isAgentCompatible
export const hasNativeToolCalling = isAgentCompatible

export type ToolCallingStrategy = 'native' | 'template_fix' | 'hermes_xml'

/**
 * Determine tool calling strategy for a model.
 * Cloud providers → native. Ollama → check compatibility.
 */
export function getToolCallingStrategy(modelName: string): ToolCallingStrategy {
  const providerId = getProviderIdFromModel(modelName)

  // Cloud providers always use native tool calling
  if (providerId === 'openai' || providerId === 'anthropic') return 'native'

  // Ollama
  return isAgentCompatible(modelName) ? 'native' : 'hermes_xml'
}

export interface RecommendedModel {
  name: string
  label: string
  reason: string
  hot?: boolean
  provider?: ProviderId
}

export function getRecommendedAgentModels(): RecommendedModel[] {
  return [
    { name: 'hermes3:8b', label: 'Hermes 3 8B', reason: 'Uncensored + native tool calling. THE agent model.', hot: true, provider: 'ollama' },
    { name: 'hermes3:70b', label: 'Hermes 3 70B', reason: 'Maximum power uncensored agent. Needs 48GB+.', hot: true, provider: 'ollama' },
    { name: 'qwen2.5:7b', label: 'Qwen 2.5 7B', reason: 'Fast, reliable tool calling', provider: 'ollama' },
    { name: 'llama3.1:8b', label: 'Llama 3.1 8B', reason: 'Proven tool calling all-rounder', provider: 'ollama' },
    { name: 'openai::gpt-4o', label: 'GPT-4o', reason: 'Cloud: powerful tool calling', provider: 'openai' },
    { name: 'anthropic::claude-sonnet-4-20250514', label: 'Claude Sonnet 4', reason: 'Cloud: fast + smart', provider: 'anthropic' },
  ]
}
