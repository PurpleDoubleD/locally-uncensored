/**
 * Which agent profile a run gets (C59 A2).
 *
 * - 'tiny'    Small-Model Mode, switched on by the user: the lean prompt, six
 *             tools, results cut to 1 500 characters. Built for 3–8B models.
 * - 'compact' a local model of up to ~35B, automatically: the normal prompt,
 *             a short tool list with one-line descriptions plus tool_search,
 *             results capped at 16 000 characters.
 * - 'full'    everything else, cloud and big local models: unchanged.
 *
 * Why automatic: Small-Model Mode is off by default (lib/constants.ts) and a
 * user with a 9B model never finds it, so a 9B saw the same ~5k tokens of
 * tool schemas as a cloud model (useAgentChat measured 17 tools ≈ 4.9k
 * tokens). The harness study of Fan et al. 2026 (arXiv 2609.20804) and
 * RAG-MCP both find that weaker models pick tools better from a short list.
 * 'tiny' stays as it was: it is the user's explicit choice.
 */

export type AgentProfile = 'tiny' | 'compact' | 'full'

/** Above this many billion parameters a local model gets the full profile. */
export const COMPACT_MAX_PARAMS_B = 35

/** The tool list of a compact run, before tool_search and unlocked tools. */
export const COMPACT_MAX_TOOLS = 8

/** A tool result in a compact run: about 4k tokens, an eighth of a 32k window. */
export const COMPACT_RESULT_CHARS = 16_000

/**
 * Billions of parameters as the model's name or its metadata says, or null.
 * A mixture of experts counts with its total (30B-A3B → 30): memory and
 * knowledge follow the total, and the profile is about the model's skill,
 * not its speed.
 */
export function paramsBillions(name: string, parameterSize?: string | null): number | null {
  const fromMeta = parameterSize?.match(/(\d+(?:\.\d+)?)\s*B/i)
  if (fromMeta) return Number(fromMeta[1])
  // The last path segment carries the size; a repo owner like "Qwen3.5" must
  // not be read as 3.5B, so a size needs a B right after the number.
  const tail = name.split(/[/:]/).slice(-2).join(' ')
  const all = [...tail.matchAll(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s?[bB](?![a-z0-9])/gi)].map((m) => Number(m[1]))
  const sizes = all.filter((n) => n > 0 && n < 2000)
  return sizes.length ? Math.max(...sizes) : null
}

export interface ProfileInput {
  /** settings.smallModelMode */
  smallModelMode?: boolean
  /** settings.agentCompactAuto; undefined counts as on. */
  compactAuto?: boolean
  /** The model runs on this machine (agents/model-locality). */
  local: boolean
  modelName: string
  parameterSize?: string | null
}

export function agentProfileFor(input: ProfileInput): AgentProfile {
  if (input.smallModelMode) return 'tiny'
  if (input.compactAuto === false || !input.local) return 'full'
  const b = paramsBillions(input.modelName, input.parameterSize)
  // Unknown size on this machine: compact. Most local models are small, and a
  // big one with a short list still reaches everything through tool_search.
  return b === null || b <= COMPACT_MAX_PARAMS_B ? 'compact' : 'full'
}

/** How many characters of one tool result go back to the model. */
export function resultCharsFor(profile: AgentProfile): number {
  return profile === 'tiny' ? 1500 : profile === 'compact' ? COMPACT_RESULT_CHARS : 60000
}
