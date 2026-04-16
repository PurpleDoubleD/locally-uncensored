import { describe, it, expect } from 'vitest'
import {
  getBlockToolCalls,
  getFirstToolCall,
  migrateBlockInPlace,
  hasToolCalls,
  stableArgsHash,
} from '../block-helpers'
import type { AgentBlock, AgentToolCall } from '../../../types/agent-mode'

const mkCall = (id: string, overrides: Partial<AgentToolCall> = {}): AgentToolCall => ({
  id,
  toolName: 'web_search',
  args: { query: 'x' },
  status: 'completed',
  timestamp: 1,
  ...overrides,
})

const mkBlock = (overrides: Partial<AgentBlock> = {}): AgentBlock => ({
  id: 'b1',
  phase: 'tool_call',
  content: '',
  timestamp: 1,
  ...overrides,
})

describe('block-helpers — getBlockToolCalls', () => {
  it('returns [] when no tool calls present', () => {
    expect(getBlockToolCalls(mkBlock())).toEqual([])
  })

  it('returns legacy singular call wrapped in array', () => {
    const call = mkCall('a')
    expect(getBlockToolCalls(mkBlock({ toolCall: call }))).toEqual([call])
  })

  it('returns new plural array as-is', () => {
    const calls = [mkCall('a'), mkCall('b')]
    expect(getBlockToolCalls(mkBlock({ toolCalls: calls }))).toBe(calls)
  })

  it('prefers plural over singular when both present (post-migration shape)', () => {
    const legacy = mkCall('old')
    const current = [mkCall('new1'), mkCall('new2')]
    const block = mkBlock({ toolCall: legacy, toolCalls: current })
    expect(getBlockToolCalls(block)).toBe(current)
  })

  it('falls back to singular when plural array is empty', () => {
    const legacy = mkCall('old')
    const block = mkBlock({ toolCall: legacy, toolCalls: [] })
    expect(getBlockToolCalls(block)).toEqual([legacy])
  })
})

describe('block-helpers — getFirstToolCall', () => {
  it('returns undefined when no tool calls', () => {
    expect(getFirstToolCall(mkBlock())).toBeUndefined()
  })

  it('returns first of plural array', () => {
    const calls = [mkCall('a'), mkCall('b')]
    expect(getFirstToolCall(mkBlock({ toolCalls: calls }))).toBe(calls[0])
  })

  it('falls back to legacy singular', () => {
    const legacy = mkCall('old')
    expect(getFirstToolCall(mkBlock({ toolCall: legacy }))).toBe(legacy)
  })
})

describe('block-helpers — migrateBlockInPlace', () => {
  it('wraps legacy singular into plural array', () => {
    const call = mkCall('a')
    const block = mkBlock({ toolCall: call })
    migrateBlockInPlace(block)
    expect(block.toolCalls).toEqual([call])
    // Legacy field preserved during transition.
    expect(block.toolCall).toBe(call)
  })

  it('is idempotent when already migrated', () => {
    const calls = [mkCall('a')]
    const block = mkBlock({ toolCalls: calls })
    migrateBlockInPlace(block)
    expect(block.toolCalls).toBe(calls)
  })

  it('does nothing when there are no calls at all', () => {
    const block = mkBlock()
    migrateBlockInPlace(block)
    expect(block.toolCall).toBeUndefined()
    expect(block.toolCalls).toBeUndefined()
  })

  it('prefers existing plural array over legacy field', () => {
    // Defensive: if both somehow exist with non-empty plural, do not overwrite.
    const legacy = mkCall('old')
    const plural = [mkCall('new')]
    const block = mkBlock({ toolCall: legacy, toolCalls: plural })
    migrateBlockInPlace(block)
    expect(block.toolCalls).toBe(plural)
  })

  it('replaces empty plural with legacy-wrapped array', () => {
    const legacy = mkCall('old')
    const block = mkBlock({ toolCall: legacy, toolCalls: [] })
    migrateBlockInPlace(block)
    expect(block.toolCalls).toEqual([legacy])
  })
})

describe('block-helpers — hasToolCalls', () => {
  it('detects plural present', () => {
    expect(hasToolCalls(mkBlock({ toolCalls: [mkCall('a')] }))).toBe(true)
  })
  it('detects legacy singular', () => {
    expect(hasToolCalls(mkBlock({ toolCall: mkCall('a') }))).toBe(true)
  })
  it('empty plural + no legacy → false', () => {
    expect(hasToolCalls(mkBlock({ toolCalls: [] }))).toBe(false)
  })
  it('neither → false', () => {
    expect(hasToolCalls(mkBlock())).toBe(false)
  })
})

describe('block-helpers — stableArgsHash', () => {
  it('produces same hash regardless of key order', () => {
    const a = stableArgsHash({ query: 'x', limit: 3 })
    const b = stableArgsHash({ limit: 3, query: 'x' })
    expect(a).toBe(b)
  })

  it('differs for different values', () => {
    expect(stableArgsHash({ q: 'a' })).not.toBe(stableArgsHash({ q: 'b' }))
  })

  it('hashes empty object', () => {
    expect(stableArgsHash({})).toBeTypeOf('string')
    expect(stableArgsHash({}).length).toBeGreaterThan(0)
  })

  it('canonicalises nested objects and arrays', () => {
    const a = stableArgsHash({ a: { x: 1, y: [1, 2, 3] } })
    const b = stableArgsHash({ a: { y: [1, 2, 3], x: 1 } })
    expect(a).toBe(b)
  })

  it('distinguishes array order', () => {
    expect(stableArgsHash({ v: [1, 2] })).not.toBe(stableArgsHash({ v: [2, 1] }))
  })

  it('handles null / undefined / boolean / number', () => {
    expect(stableArgsHash({ n: null, u: undefined, b: true, x: 3 })).toBeTypeOf('string')
  })

  it('differentiates string "1" from number 1', () => {
    expect(stableArgsHash({ v: '1' })).not.toBe(stableArgsHash({ v: 1 }))
  })
})
