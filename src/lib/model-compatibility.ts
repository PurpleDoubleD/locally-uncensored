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
  'qwen3.6', 'qwen3-coder-next', 'qwen3-coder', 'qwen3', 'qwen2.5',
  'llama3.1', 'llama3.2', 'llama3.3', 'llama4',
  'mistral', 'mistral-nemo', 'mistral-small', 'mistral-large',
  'command-r',
  'phi-4', 'phi4',
  'deepseek-v2.5', 'deepseek-v3',
  'glm4', 'glm-4',
  'gemma3', 'gemma4',
  'nemotron',
]

/**
 * Check if a model supports Agent Mode.
 * Cloud providers always support tools. Ollama needs explicit check.
 */
export function isAgentCompatible(modelName: string | null): boolean {
  if (!modelName) return false
  const providerId = getProviderIdFromModel(modelName)

  // Cloud providers always support tool calling
  if (providerId === 'openai' || providerId === 'anthropic') return true

  // Ollama: check compatibility list
  const name = modelName.toLowerCase()

  // Some abliterated models retain native tool calling
  const ABLITERATED_NATIVE = ['qwen3-coder', 'hermes3', 'hermes-3', 'hermes']
  if (name.includes('abliterated') || name.includes('uncensored')) {
    const baseName = name.replace(/^[^/]+\//, '').replace(/-abliterated/g, '').replace(/-uncensored/g, '').replace(/:.*$/, '')
    return ABLITERATED_NATIVE.some((f) => baseName.startsWith(f))
  }

  const baseName = name.replace(/^[^/]+\//, '').replace(/-instruct/g, '').replace(/-chat/g, '').replace(/:.*$/, '')
  return AGENT_COMPATIBLE.some((f) => baseName.startsWith(f))
}

export const isToolCallingModel = isAgentCompatible
export const hasNativeToolCalling = isAgentCompatible

/**
 * Models that support Ollama's native `think` parameter.
 * When think=true is sent to a non-thinking model, Ollama returns HTTP 400.
 */
const THINKING_COMPATIBLE = [
  'qwq',
  'deepseek-r1',
  'qwen3.6',     // Qwen 3.6 — thinking preservation
  'qwen3',       // Qwen 3.x has native thinking
  'qwen3.5',
  'qwen3-coder',
  'gemma3',      // Gemma 3+ supports thinking via Ollama
  'gemma4',
]

/**
 * Check if a model supports thinking/chain-of-thought mode.
 * Cloud providers handle it gracefully. Ollama needs explicit support.
 */
export function isThinkingCompatible(modelName: string | null): boolean {
  if (!modelName) return false
  const providerId = getProviderIdFromModel(modelName)
  if (providerId === 'openai' || providerId === 'anthropic') return true

  const name = modelName.toLowerCase()
  const baseName = name.replace(/^[^/]+\//, '').replace(/:.*$/, '').replace(/-abliterated/g, '').replace(/-uncensored/g, '')
  return THINKING_COMPATIBLE.some(f => baseName.startsWith(f))
}

/**
 * Gemma 3/4 are thinking-compatible but their `think: false` path produces
 * plain-text structured planning (`Plan:`, `Constraint Checklist:`,
 * `Confidence Score:`) that has no tags we can strip — the model trained
 * itself to talk its reasoning out loud when forced out of thinking mode.
 *
 * The `think: true` path produces `<|channel|>thought` tags instead, which
 * our thinking-stripper can remove cleanly.
 *
 * So when the user toggles Thinking OFF on a Gemma model, we actually pass
 * `thinking: undefined` (let Ollama default to on), and rely on the stripper
 * + the `keepThinking === false` gate to silently discard the tagged
 * reasoning content from the UI. The user gets the clean final answer; the
 * model doesn't leak a planning preamble.
 */
export function isPlainTextPlanner(modelName: string | null): boolean {
  if (!modelName) return false
  const name = modelName.toLowerCase()
  const baseName = name.replace(/^[^/]+\//, '').replace(/:.*$/, '').replace(/-abliterated/g, '').replace(/-uncensored/g, '')
  return baseName.startsWith('gemma3') || baseName.startsWith('gemma4')
}

/**
 * Models recommended for Claude Code (Anthropic API compat via Ollama 0.14+).
 * These models handle agentic tool-use loops well with the Claude Code CLI.
 */
const CLAUDE_CODE_COMPATIBLE = [
  'glm5', 'glm-5', 'glm4.7', 'glm-4.7',
  'qwen3.6',
  'qwen3.5-coder', 'qwen3-coder',
  'qwen3.5', 'qwen3',
  'hermes3', 'hermes-3', 'hermes',
  'deepseek-v3', 'deepseek-v2.5',
  'gemma4', 'gemma3',
]

/**
 * Check if a model works well with Claude Code via Ollama 0.14+.
 * Only relevant for Ollama provider since Claude Code uses Anthropic API format.
 */
export function isClaudeCodeCompatible(modelName: string | null): boolean {
  if (!modelName) return false
  const name = modelName.toLowerCase()
  const baseName = name.replace(/^[^/]+\//, '').replace(/:.*$/, '').replace(/-abliterated/g, '').replace(/-uncensored/g, '')
  return CLAUDE_CODE_COMPATIBLE.some(f => baseName.startsWith(f))
}

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
    // Local — HOT picks
    { name: 'qwen3.6:latest', label: 'Qwen 3.6 35B MoE', reason: '35B brain, 3B active. Vision + agentic coding + thinking. Brand new.', hot: true, provider: 'ollama' },
    { name: 'qwen3.5:35b-a3b', label: 'Qwen 3.5 35B MoE', reason: '35B brain, 3B active. Best agentic + 256K context. SWE-bench leader.', hot: true, provider: 'ollama' },
    { name: 'gemma4:26b', label: 'Gemma 4 26B MoE', reason: '26B brain, runs like 4B. Native tools + vision. Apache 2.0.', hot: true, provider: 'ollama' },
    { name: 'qwen3-coder:30b', label: 'Qwen3-Coder 30B MoE', reason: 'Built for code + agentic workflows. 256K context.', hot: true, provider: 'ollama' },
    { name: 'hermes3:8b', label: 'Hermes 3 8B', reason: 'Uncensored + native tool calling. Best small agent.', hot: true, provider: 'ollama' },
    // Local — solid picks
    { name: 'deepseek-v3.2', label: 'DeepSeek V3.2', reason: 'Frontier reasoning + tool use. Open-source.', provider: 'ollama' },
    { name: 'glm4.7', label: 'GLM 4.7', reason: 'Strong coding, reasoning, agentic execution.', provider: 'ollama' },
    // Cloud
    { name: 'anthropic::claude-opus-4-20250514', label: 'Claude Opus 4', reason: 'Cloud: most capable agent model.', provider: 'anthropic' },
    { name: 'anthropic::claude-sonnet-4-20250514', label: 'Claude Sonnet 4', reason: 'Cloud: fast + smart tool calling.', provider: 'anthropic' },
  ]
}
