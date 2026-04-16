/**
 * Helpers for reading AgentBlock tool calls uniformly across legacy
 * (singular `toolCall`) and v2.4+ (plural `toolCalls[]`) shapes.
 *
 * Phase 1 migration (v2.4.0): blocks can carry either:
 *   - legacy `block.toolCall?: AgentToolCall` — written by pre-v2.4 code
 *   - v2.4  `block.toolCalls?: AgentToolCall[]` — written by parallel executor
 *
 * All READS must go through `getBlockToolCalls(block)`. All WRITES in new
 * code MUST populate `toolCalls` and leave `toolCall` untouched.
 */

import type { AgentBlock, AgentToolCall } from '../../types/agent-mode'

/**
 * Uniform accessor: returns all tool calls on a block, regardless of shape.
 * Returns an empty array if the block has none.
 */
export function getBlockToolCalls(block: AgentBlock): AgentToolCall[] {
  if (block.toolCalls && block.toolCalls.length > 0) return block.toolCalls
  if (block.toolCall) return [block.toolCall]
  return []
}

/**
 * Returns the first tool call on a block, or undefined.
 * Convenience for UI renderers that only show one at a time during legacy display.
 */
export function getFirstToolCall(block: AgentBlock): AgentToolCall | undefined {
  if (block.toolCalls && block.toolCalls.length > 0) return block.toolCalls[0]
  return block.toolCall
}

/**
 * Rehydration shim for persisted blocks. If a block carries the legacy
 * `toolCall` field and no `toolCalls`, wrap the single call into the array
 * form IN PLACE (mutates input — suitable for use inside a persist merger).
 *
 * Leaves both fields populated when migrating, so anything reading either
 * shape still works mid-migration. A future release can drop `toolCall`
 * after enough users have rehydrated.
 */
export function migrateBlockInPlace(block: AgentBlock): AgentBlock {
  if (block.toolCall && (!block.toolCalls || block.toolCalls.length === 0)) {
    block.toolCalls = [block.toolCall]
  }
  return block
}

/**
 * Returns true if the block has at least one tool call in either shape.
 */
export function hasToolCalls(block: AgentBlock): boolean {
  return (block.toolCalls?.length ?? 0) > 0 || !!block.toolCall
}

/**
 * Compute stable args-hash for cache/audit keying. Sorts object keys so
 * `{a:1,b:2}` and `{b:2,a:1}` hash identically. Non-cryptographic.
 */
export function stableArgsHash(args: Record<string, any>): string {
  const normalized = canonicalize(args)
  return djb2(normalized)
}

function canonicalize(value: any): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']'
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}'
  }
  return JSON.stringify(String(value))
}

// djb2 hash — compact, stable, not crypto. Plenty for an in-turn cache key.
function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i)
  }
  // Unsigned 32-bit hex.
  return (h >>> 0).toString(16)
}
