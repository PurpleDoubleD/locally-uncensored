import { afterEach, expect, it, vi } from 'vitest'
import { renderMemoryContext, useMemoryStore, __setMemoryEmbedFn } from '../memoryStore'
import type { MemoryFile } from '../../types/agent-mode'
const entry = (id: string, extra: Partial<MemoryFile> = {}): MemoryFile => ({
  id, title: 'Same title', description: '', content: 'Synthetic preference', type: 'user',
  tags: [], source: 'manual', createdAt: Date.now(), updatedAt: Date.now(), ...extra,
})
afterEach(() => { __setMemoryEmbedFn() })

it('reports only IDs whose rows fit the final rendered budget, not matching titles', () => {
  const result = renderMemoryContext([entry('fits'), entry('too-large', { content: 'x'.repeat(500) })], 20)
  expect(result.memoryIds).toEqual(['fits'])
  expect(result.text).toContain('Synthetic preference')
  expect(result.text).not.toContain('x'.repeat(100))
})

it('does not report header-only blocks or oversized candidates as context', () => {
  expect(renderMemoryContext([entry('large', { content: 'x'.repeat(5000) })], 20)).toMatchObject({ text: '', memoryIds: [], leftOut: ['large'] })
  expect(renderMemoryContext([entry('zero')], 0)).toMatchObject({ text: '', memoryIds: [] })
})

it('reports an ID when its sanitized and truncated content fits', () => {
  // GH #255: cut at the per-memory limit (default 3000), not at 500, and marked.
  const result = renderMemoryContext([entry('trimmed', { content: 'x'.repeat(5000) })], 4000)
  expect(result.memoryIds).toEqual(['trimmed'])
  expect(result.shortened).toEqual(['trimmed'])
  expect(result.text).toContain('[cut: 3000 of 5000 characters]')
  expect(result.text.length).toBeLessThan(3200)
})

it('retrieval IDs preserve scope and sensitive/stale filtering', async () => {
  useMemoryStore.setState({ entries: [entry('global'), entry('a', { scope: 'a' }), entry('b', { scope: 'b' }),
    entry('private', { sensitive: true }), entry('old', { stale: true })] })
  const result = await useMemoryStore.getState().getMemoryContextAsync('', 8192, { scope: 'a' })
  expect(new Set(result.memoryIds)).toEqual(new Set(['global', 'a']))
  expect(result.text.match(/Synthetic preference/g)).toHaveLength(2)
})

it('async retrieval does not retain forgotten IDs while awaiting embeddings', async () => {
  let finish!: (vectors: number[][]) => void
  const embed = vi.fn(() => new Promise<number[][]>(resolve => { finish = resolve }))
  __setMemoryEmbedFn(embed)
  useMemoryStore.setState({ entries: [entry('forgotten')] })
  const pending = useMemoryStore.getState().getMemoryContextAsync('synthetic preference', 8192)
  await vi.waitFor(() => expect(embed).toHaveBeenCalled())
  useMemoryStore.getState().removeMemory('forgotten')
  finish([])
  expect(await pending).toEqual({ text: '', memoryIds: [] })
})
