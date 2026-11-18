import { afterEach, beforeEach, expect, it } from 'vitest'
import { useMemoryStore, __setMemoryEmbedFn, memoryMatchesScope } from '../memoryStore'

beforeEach(() => {
  useMemoryStore.setState({ entries: [] })
  __setMemoryEmbedFn(async () => [])
})
afterEach(() => __setMemoryEmbedFn())
const add = (scope?: string, content = 'Project fixture') => useMemoryStore.getState().addMemory({
  type: 'project', title: content, description: content, content, tags: [], source: 'manual', scope,
})
/** Written by the extractor: only these may be merged (GH #255). */
const addAuto = (scope?: string, content = 'Project fixture') => useMemoryStore.getState().addMemory({
  type: 'project', title: content, description: content, content, tags: [], source: 'conv-1', sourceKind: 'chat', scope,
})

it('includes global and exact-project entries without crossing project boundaries', async () => {
  add(undefined, 'Global fixture')
  add('A', 'Alpha fixture')
  add('B', 'Beta fixture')
  const store = useMemoryStore.getState()
  expect(store.getMemoriesForPrompt('fixture', 8192)).toContain('Global fixture')
  expect(store.getMemoriesForPrompt('fixture', 8192)).not.toMatch(/Alpha|Beta/)
  expect(store.getMemoriesForPrompt('fixture', 8192, { scope: 'A' })).toContain('Alpha fixture')
  expect(await store.getMemoriesForPromptAsync('fixture', 8192, { scope: 'A' })).not.toContain('Beta fixture')
})
it('does not deduplicate the same fact across projects', () => {
  expect(add('A')).not.toBe('')
  expect(add('B')).not.toBe('')
  expect(add('A')).toBe('')
})
it('preserves JSON scope and never promotes malformed scope to global', () => {
  add('A')
  const json = useMemoryStore.getState().exportAsJSON()
  useMemoryStore.getState().clearAll()
  expect(useMemoryStore.getState().importFromJSON(json).added).toBe(1)
  expect(useMemoryStore.getState().entries[0].scope).toBe('A')
  for (const scope of [null, 12, '', ' ']) {
    expect(useMemoryStore.getState().importFromJSON(JSON.stringify([{ content: 'bad scope', scope }])).added).toBe(0)
  }
  expect(useMemoryStore.getState().exportAsMarkdown()).not.toContain('Project fixture')
})
it('rejects cross-project automatic merges and accepts matching scopes', () => {
  const targetId = addAuto('A')
  const wrongId = addAuto('B')
  const decision = { action: 'UPDATE' as const, targetId, mergedContent: 'Merged fixture' }
  useMemoryStore.getState().applyWriteDecision(decision, { newId: wrongId })
  expect(useMemoryStore.getState().entries[0].content).toBe('Project fixture')
  const newId = addAuto('A', 'New fixture')
  useMemoryStore.getState().applyWriteDecision(decision, { newId })
  expect(useMemoryStore.getState().entries[0].content).toBe('Merged fixture')
})
it('R2-36: an UPDATE without a candidate still merges (no ctx.newId to compare scope against)', () => {
  const targetId = addAuto('A')
  const decision = { action: 'UPDATE' as const, targetId, mergedContent: 'Merged fixture' }
  useMemoryStore.getState().applyWriteDecision(decision)
  expect(useMemoryStore.getState().entries[0].content).toBe('Merged fixture')
})
it('pins the requested scope across asynchronous fallback', async () => {
  add('A', 'Alpha fixture')
  add('B', 'Beta fixture')
  let finish!: (value: number[][]) => void
  __setMemoryEmbedFn(() => new Promise(resolve => { finish = resolve }))
  const opts = { scope: 'A' }
  const pending = useMemoryStore.getState().getMemoriesForPromptAsync('fixture', 8192, opts)
  opts.scope = 'B'
  finish([])
  const result = await pending
  expect(result).toContain('Alpha fixture')
  expect(result).not.toContain('Beta fixture')
})
it('does not match absent or blank project IDs to scoped entries', () => {
  expect(memoryMatchesScope({ scope: 'A' })).toBe(false)
  expect(memoryMatchesScope({ scope: ' ' }, ' ')).toBe(false)
  expect(memoryMatchesScope({ scope: 'A' }, 'a')).toBe(false)
})

/**
 * R2-26: die leere Anfrage der Remote-Bruecke lieferte die AELTESTEN
 * Erinnerungen.
 *
 * `scoreMemory` gibt bei leerer Anfrage jeder Erinnerung die 1, und der
 * Frischebonus haengt an mindestens einem Worttreffer, greift dort also nicht.
 * Die Sortierung ist stabil, also gewann die Einfuegereihenfolge. Genau so
 * ruft `remoteStore` an, und das Handy bekam dauerhaft den aeltesten Stand.
 */
describe('R2-26: ohne Anfrage entscheidet die Frische', () => {
  it('die leere Anfrage liefert die neuesten, nicht die aeltesten', () => {
    useMemoryStore.setState({ entries: [] })
    for (let i = 0; i < 20; i++) {
      useMemoryStore.getState().addMemory({
        type: 'user', title: `M${i}`, description: `Eintrag ${i}`,
        content: `Eintrag Nummer ${i}`, tags: [], source: 'manual',
      })
    }
    // Aufsteigendes Alter in Einfuegereihenfolge: der letzte ist der neueste.
    useMemoryStore.setState({
      entries: useMemoryStore.getState().entries.map((e, i) => ({ ...e, updatedAt: 1000 + i })),
    })

    const text = useMemoryStore.getState().getMemoriesForPrompt('', 8192)
    // Acht passen ins Budget, und es muessen die acht NEUESTEN sein.
    const genannt = [...text.matchAll(/Eintrag Nummer (\d+)/g)].map((m) => Number(m[1]))
    expect(genannt).toHaveLength(8)
    expect(genannt).toEqual([19, 18, 17, 16, 15, 14, 13, 12])
  })

  it('NEGATIVKONTROLLE: mit echter Anfrage entscheidet weiter die Wortdeckung', () => {
    useMemoryStore.setState({ entries: [] })
    useMemoryStore.getState().addMemory({
      type: 'user', title: 'bread', description: 'The favourite bread is rye.',
      content: 'The favourite bread is rye.', tags: [], source: 'manual',
    })
    useMemoryStore.getState().addMemory({
      type: 'user', title: 'tea', description: 'The favourite tea is rooibos.',
      content: 'The favourite tea is rooibos.', tags: [], source: 'manual',
    })
    // Der Tee ist der NEUERE, das Brot der gesuchte.
    useMemoryStore.setState({
      entries: useMemoryStore.getState().entries.map((e, i) => ({ ...e, updatedAt: 1000 + i })),
    })

    const text = useMemoryStore.getState().getMemoriesForPrompt('bread', 8192)
    expect(text).toContain('rye')
    expect(text, 'das Alter hat die Wortdeckung geschlagen').not.toContain('rooibos')
  })
})
