/**
 * GH #238 (A28): "Max memories injected" set to 100 on a 256K model still sent
 * 4 to 8 of 41 project memories, and a Japanese block stopped after about
 * 1,300 to 1,800 characters. The override grew the budget to n x 150 tokens,
 * and renderMemoryContext cut it back to the fixed 1k ceiling.
 *
 * The override now lifts the ceiling, up to a tenth of the context window.
 * Without an override, and on a small window, the 1k stays.
 *
 * NEGATIVE CONTROL: put `Math.min(budgetTokens, MEMORY_CONTEXT_TOKEN_CAP)`
 * back in renderMemoryContext and the 256K tests go red.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  useMemoryStore, MEMORY_CONTEXT_TOKEN_CAP, memoryContextCeiling,
} from '../memoryStore'
import { estimateTokens } from '../../lib/token-estimate'

const WINDOW_256K = 262144

function seedProject(count: number, content: (i: number) => string, title: (i: number) => string) {
  const store = useMemoryStore.getState()
  store.clearAll()
  for (let i = 0; i < count; i++) {
    store.addMemory({
      type: 'project',
      title: title(i),
      description: 'project note',
      content: content(i),
      tags: ['project'],
    } as never)
  }
}

function injectedCount(block: string): number {
  return block.split('\n').filter((l) => l.startsWith('- ')).length
}

beforeEach(() => {
  useMemoryStore.getState().clearAll()
  useMemoryStore.getState().updateMemorySettings({ maxMemoriesOverride: null })
})

describe('memoryContextCeiling', () => {
  it('stays at 1k without an override', () => {
    expect(memoryContextCeiling(WINDOW_256K, null)).toBe(MEMORY_CONTEXT_TOKEN_CAP)
    expect(memoryContextCeiling(WINDOW_256K, undefined)).toBe(MEMORY_CONTEXT_TOKEN_CAP)
    expect(memoryContextCeiling(WINDOW_256K, 0)).toBe(MEMORY_CONTEXT_TOKEN_CAP)
  })

  it('grows with the window when an override is set', () => {
    expect(memoryContextCeiling(WINDOW_256K, 100)).toBe(Math.floor(WINDOW_256K * 0.1))
  })

  it('keeps a small window at 1k even with an override', () => {
    expect(memoryContextCeiling(8192, 100)).toBe(MEMORY_CONTEXT_TOKEN_CAP)
    expect(memoryContextCeiling(4096, 100)).toBe(MEMORY_CONTEXT_TOKEN_CAP)
    expect(memoryContextCeiling(Number.NaN, 100)).toBe(MEMORY_CONTEXT_TOKEN_CAP)
  })
})

describe('GH #238: the override reaches past 1k tokens', () => {
  it('sends all 41 project memories at override 100 on 256K', () => {
    seedProject(41, (i) => `project ${i} ${'detail of the build '.repeat(10)}`, (i) => `Project fact ${i}`)
    useMemoryStore.getState().updateMemorySettings({ maxMemoriesOverride: 100 })

    const block = useMemoryStore.getState().getMemoriesForPrompt('project', WINDOW_256K)

    expect(injectedCount(block)).toBe(41)
    expect(estimateTokens(block)).toBeGreaterThan(MEMORY_CONTEXT_TOKEN_CAP)
  })

  it('does the same on the async path', async () => {
    seedProject(41, (i) => `project ${i} ${'detail of the build '.repeat(10)}`, (i) => `Project fact ${i}`)
    useMemoryStore.getState().updateMemorySettings({ maxMemoriesOverride: 100 })

    const block = await useMemoryStore.getState().getMemoriesForPromptAsync('project', WINDOW_256K)

    expect(injectedCount(block)).toBe(41)
  })

  it('carries a long Japanese block whole', () => {
    // About 120 characters each, 41 of them: some 5,000 characters, far past
    // the 1,300 to 1,800 where the report saw it stop.
    const jp = 'このプロジェクトでは毎週金曜日にリリースを行い、テストはすべて自動で実行されます。'
    seedProject(41, (i) => `${jp}${jp}${jp}（${i}）`, (i) => `プロジェクト ${i}`)
    useMemoryStore.getState().updateMemorySettings({ maxMemoriesOverride: 100 })

    const block = useMemoryStore.getState().getMemoriesForPrompt('', WINDOW_256K)

    expect(injectedCount(block)).toBe(41)
    expect(block.length).toBeGreaterThan(4000)
    expect(block).toContain('（40）')
  })

  it('still caps at 1k without an override (default unchanged)', () => {
    seedProject(41, (i) => `project ${i} ${'detail of the build '.repeat(10)}`, (i) => `Project fact ${i}`)

    const block = useMemoryStore.getState().getMemoriesForPrompt('project', WINDOW_256K)

    expect(injectedCount(block)).toBeLessThan(25)
    expect(block.length).toBeLessThanOrEqual(MEMORY_CONTEXT_TOKEN_CAP * 4 + 64)
  })

  it('still caps a small window at 1k with an override', () => {
    seedProject(41, (i) => `project ${i} ${'detail of the build '.repeat(10)}`, (i) => `Project fact ${i}`)
    useMemoryStore.getState().updateMemorySettings({ maxMemoriesOverride: 100 })

    const block = useMemoryStore.getState().getMemoriesForPrompt('project', 8192)

    expect(block).not.toBe('')
    expect(block.length).toBeLessThanOrEqual(MEMORY_CONTEXT_TOKEN_CAP * 4 + 64)
  })
})
