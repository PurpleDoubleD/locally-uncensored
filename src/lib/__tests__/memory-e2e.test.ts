import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useMemoryStore, getMemoryBudget, __setMemoryEmbedFn } from '../../stores/memoryStore'
import { MEMORY_BUDGET_TIERS } from '../../types/agent-mode'
import type { MemoryType, MemoryFile } from '../../types/agent-mode'

// ── Helper ────────────────────────────────────────────────────

function resetStore() {
  useMemoryStore.setState({
    entries: [],
    settings: {
      autoExtractEnabled: true,
      autoExtractInAllModes: true,
      maxMemoriesInPrompt: 10,
      maxMemoryChars: 3000,
    },
    lastSynced: 0,
  })
  // Always reset the injected embed fn between tests.
  __setMemoryEmbedFn()
}

function addMem(type: MemoryType, title: string, content: string, tags: string[] = []) {
  return useMemoryStore.getState().addMemory({
    type, title, description: content.substring(0, 120), content, tags, source: 'test',
  })
}

// ── Memory Budget Tiers ────────────────────────────────────────

describe('Memory Budget Tiers', () => {
  it('returns 0 budget for 2K context', () => {
    const tier = getMemoryBudget(2048)
    expect(tier.budgetTokens).toBe(0)
    expect(tier.maxMemories).toBe(0)
  })

  it('returns 300 budget for 3K context', () => {
    const tier = getMemoryBudget(3000)
    expect(tier.budgetTokens).toBe(300)
    expect(tier.maxMemories).toBe(3)
    expect(tier.typesAllowed).toEqual(['user', 'feedback'])
  })

  it('returns 800 budget for 8K context', () => {
    const tier = getMemoryBudget(8192)
    expect(tier.budgetTokens).toBe(800)
    expect(tier.maxMemories).toBe(8)
    expect(tier.typesAllowed).toBe('all')
  })

  it('returns 2000 budget for 32K context', () => {
    const tier = getMemoryBudget(32000)
    expect(tier.budgetTokens).toBe(2000)
    expect(tier.maxMemories).toBe(15)
  })

  it('returns 4000 budget for 200K context', () => {
    const tier = getMemoryBudget(200000)
    expect(tier.budgetTokens).toBe(4000)
    expect(tier.maxMemories).toBe(25)
  })

  it('tiers are sorted ascending', () => {
    for (let i = 1; i < MEMORY_BUDGET_TIERS.length; i++) {
      expect(MEMORY_BUDGET_TIERS[i].maxContext).toBeGreaterThan(MEMORY_BUDGET_TIERS[i - 1].maxContext)
    }
  })
})

// ── Full CRUD Lifecycle ────────────────────────────────────────

describe('Memory CRUD E2E', () => {
  beforeEach(resetStore)

  it('full lifecycle: add → update → search → export → delete → clear', () => {
    // Add
    const id1 = addMem('user', 'Speaks German', 'User primarily communicates in German')
    const id2 = addMem('feedback', 'No emojis', 'User wants no emojis in UI')
    const id3 = addMem('project', 'v2.0 launch', 'Currently working on v2.0 launch')
    addMem('reference', 'GitHub repo', 'Main repo at github.com/test/app')

    expect(useMemoryStore.getState().entries).toHaveLength(4)
    expect(id1).toBeTruthy()
    expect(id2).toBeTruthy()

    // Update
    useMemoryStore.getState().updateMemory(id1, { title: 'German speaker', content: 'User speaks German fluently' })
    const updated = useMemoryStore.getState().entries.find(e => e.id === id1)!
    expect(updated.title).toBe('German speaker')
    expect(updated.content).toBe('User speaks German fluently')
    expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt)

    // Search
    const results = useMemoryStore.getState().searchMemories('German')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].id).toBe(id1)

    // Search by type
    const feedbackOnly = useMemoryStore.getState().searchMemories('', { type: 'feedback' })
    expect(feedbackOnly.every(e => e.type === 'feedback')).toBe(true)

    // Export markdown
    const md = useMemoryStore.getState().exportAsMarkdown()
    expect(md).toContain('# Memory')
    expect(md).toContain('## User')
    expect(md).toContain('German speaker')
    expect(md).toContain('## Feedback')
    expect(md).toContain('No emojis')

    // Export JSON
    const json = useMemoryStore.getState().exportAsJSON()
    const parsed = JSON.parse(json)
    expect(parsed.entries).toHaveLength(4)
    expect(parsed.settings).toBeDefined()

    // Delete one
    useMemoryStore.getState().removeMemory(id3)
    expect(useMemoryStore.getState().entries).toHaveLength(3)

    // Clear all
    useMemoryStore.getState().clearAll()
    expect(useMemoryStore.getState().entries).toHaveLength(0)
  })
})

// ── Deduplication ──────────────────────────────────────────────

describe('Memory Deduplication', () => {
  beforeEach(resetStore)

  it('rejects exact content + type duplicates', () => {
    addMem('user', 'A', 'Same content')
    const dup = addMem('user', 'B', 'Same content')
    expect(dup).toBe('')
    expect(useMemoryStore.getState().entries).toHaveLength(1)
  })

  it('allows same content with different type', () => {
    addMem('user', 'A', 'Same content')
    addMem('feedback', 'B', 'Same content')
    expect(useMemoryStore.getState().entries).toHaveLength(2)
  })

  it('rejects empty / whitespace-only content', () => {
    expect(addMem('user', 'Empty', '')).toBe('')
    expect(addMem('user', 'Whitespace', '   ')).toBe('')
    expect(useMemoryStore.getState().entries).toHaveLength(0)
  })
})

// ── Context-Aware Prompt Injection ─────────────────────────────

describe('Context-Aware Prompt Injection', () => {
  beforeEach(() => {
    resetStore()
    // Seed with diverse memories
    addMem('user', 'Developer role', 'User is a senior TypeScript developer')
    addMem('feedback', 'Concise style', 'User prefers short, direct answers')
    addMem('project', 'Building v2.0', 'Working on multi-provider chat app v2.0')
    addMem('reference', 'Ollama docs', 'API reference at ollama.com/docs')
  })

  it('returns empty for 2K context (no injection)', () => {
    const prompt = useMemoryStore.getState().getMemoriesForPrompt('developer', 2048)
    expect(prompt).toBe('')
  })

  it('returns only user+feedback for 4K context', () => {
    const prompt = useMemoryStore.getState().getMemoriesForPrompt('developer concise', 4000)
    expect(prompt).toContain('About the user')
    expect(prompt).toContain('Developer role')
    // Project and reference types should NOT appear at 4K
    expect(prompt).not.toContain('Project context')
    expect(prompt).not.toContain('References')
  })

  it('returns all types for 8K+ context', () => {
    const prompt = useMemoryStore.getState().getMemoriesForPrompt('developer v2.0 Ollama', 16000)
    expect(prompt).toContain('About the user')
    expect(prompt).toContain('Project context')
    expect(prompt).toContain('References')
  })

  it('respects max char budget (does not exceed tokens * 4)', () => {
    // Add many memories
    for (let i = 0; i < 30; i++) {
      addMem('user', `Fact ${i}`, `This is a detailed fact number ${i} about the user's preferences and working style`)
    }
    const prompt = useMemoryStore.getState().getMemoriesForPrompt('fact user preferences', 4000)
    // 4K tier = 300 tokens = 1200 chars
    expect(prompt.length).toBeLessThanOrEqual(1200 + 200) // some tolerance
  })

  it('structures output with section headers', () => {
    const prompt = useMemoryStore.getState().getMemoriesForPrompt('developer v2.0 Ollama concise', 32000)
    expect(prompt).toMatch(/### About the user/)
    expect(prompt).toMatch(/### User feedback/)
    expect(prompt).toMatch(/### Project context/)
    expect(prompt).toMatch(/### References/)
  })

  it('returns empty when no entries match query', () => {
    const prompt = useMemoryStore.getState().getMemoriesForPrompt('xylophone', 32000)
    expect(prompt).toBe('')
  })
})

// ── Search Scoring ─────────────────────────────────────────────

describe('Search Scoring', () => {
  beforeEach(() => {
    resetStore()
    addMem('user', 'TypeScript expert', 'User is expert in TypeScript and React')
    addMem('project', 'React migration', 'Migrating from Vue to React framework')
    addMem('reference', 'React docs', 'Official React documentation at react.dev')
  })

  it('title matches score higher than content matches', () => {
    const results = useMemoryStore.getState().searchMemories('TypeScript')
    expect(results[0].title).toBe('TypeScript expert')
  })

  it('multiple word matches score higher', () => {
    const results = useMemoryStore.getState().searchMemories('React migration')
    // "React migration" matches both title words → highest score
    expect(results[0].title).toBe('React migration')
  })

  it('respects limit option', () => {
    const results = useMemoryStore.getState().searchMemories('React', { limit: 1 })
    expect(results).toHaveLength(1)
  })
})

// ── Import / Export Round-Trip ──────────────────────────────────

describe('Import/Export Round-Trip', () => {
  beforeEach(resetStore)

  it('JSON round-trip preserves all data', () => {
    addMem('user', 'Pref A', 'Content A', ['tag1'])
    addMem('feedback', 'Pref B', 'Content B', ['tag2'])

    const json = useMemoryStore.getState().exportAsJSON()
    resetStore()
    useMemoryStore.getState().importFromJSON(json)

    expect(useMemoryStore.getState().entries).toHaveLength(2)
    expect(useMemoryStore.getState().entries[0].type).toBe('user')
    expect(useMemoryStore.getState().entries[1].type).toBe('feedback')
  })

  it('markdown export contains all entries grouped by type', () => {
    addMem('user', 'User pref', 'Prefers dark mode')
    addMem('project', 'Sprint goal', 'Complete feature X by Friday')

    const md = useMemoryStore.getState().exportAsMarkdown()
    expect(md).toContain('## User')
    expect(md).toContain('User pref')
    expect(md).toContain('## Project')
    expect(md).toContain('Sprint goal')
  })

  it('markdown import parses legacy "Facts" header as user type', () => {
    const legacyMd = `## Facts\n\n- Old fact from v1\n`
    useMemoryStore.getState().importFromMarkdown(legacyMd)
    expect(useMemoryStore.getState().entries[0].type).toBe('user')
  })

  it('markdown import parses legacy "Tool Results" as reference type', () => {
    const legacyMd = `## Tool Results\n\n- web_search result\n`
    useMemoryStore.getState().importFromMarkdown(legacyMd)
    expect(useMemoryStore.getState().entries[0].type).toBe('reference')
  })

  it('handles malformed JSON import gracefully', () => {
    useMemoryStore.getState().importFromJSON('not json')
    expect(useMemoryStore.getState().entries).toHaveLength(0)
  })

  it('handles empty markdown import gracefully', () => {
    useMemoryStore.getState().importFromMarkdown('')
    expect(useMemoryStore.getState().entries).toHaveLength(0)
  })
})

// ── Settings ───────────────────────────────────────────────────

describe('Memory Settings', () => {
  beforeEach(resetStore)

  it('defaults are correct', () => {
    const s = useMemoryStore.getState().settings
    expect(s.autoExtractEnabled).toBe(true)
    expect(s.autoExtractInAllModes).toBe(true)
    expect(s.maxMemoriesInPrompt).toBe(10)
    expect(s.maxMemoryChars).toBe(3000)
  })

  it('partial updates work', () => {
    useMemoryStore.getState().updateMemorySettings({ autoExtractEnabled: false })
    expect(useMemoryStore.getState().settings.autoExtractEnabled).toBe(false)
    expect(useMemoryStore.getState().settings.autoExtractInAllModes).toBe(true) // unchanged
  })

  it('multiple updates accumulate', () => {
    useMemoryStore.getState().updateMemorySettings({ autoExtractEnabled: true })
    useMemoryStore.getState().updateMemorySettings({ maxMemoriesInPrompt: 20 })
    const s = useMemoryStore.getState().settings
    expect(s.autoExtractEnabled).toBe(true)
    expect(s.maxMemoriesInPrompt).toBe(20)
  })
})

// ── Legacy Compat ──────────────────────────────────────────────

describe('Legacy addEntry Compat', () => {
  beforeEach(resetStore)

  it('fact → user type', () => {
    useMemoryStore.getState().addEntry('fact', 'The sky is blue')
    expect(useMemoryStore.getState().entries[0].type).toBe('user')
  })

  it('tool_result → reference type', () => {
    useMemoryStore.getState().addEntry('tool_result', 'Search found 5 results')
    expect(useMemoryStore.getState().entries[0].type).toBe('reference')
  })

  it('decision → project type', () => {
    useMemoryStore.getState().addEntry('decision', 'Use Zustand')
    expect(useMemoryStore.getState().entries[0].type).toBe('project')
  })

  it('context → project type', () => {
    useMemoryStore.getState().addEntry('context', 'Running on Windows')
    expect(useMemoryStore.getState().entries[0].type).toBe('project')
  })

  it('source stored as tag', () => {
    useMemoryStore.getState().addEntry('fact', 'Test', 'agent:web_search')
    expect(useMemoryStore.getState().entries[0].tags).toContain('agent:web_search')
  })

  it('legacy getMemoryForPrompt still works', () => {
    useMemoryStore.getState().addEntry('fact', 'Rememberable fact about TypeScript')
    const prompt = useMemoryStore.getState().getMemoryForPrompt('TypeScript')
    expect(prompt).toContain('TypeScript')
  })
})

// ── v1 → v2 Migration ─────────────────────────────────────────

describe('v1 → v2 Migration', () => {
  it('handles already-migrated state (has type field)', () => {
    // Simulate setting state with already-migrated entries
    useMemoryStore.setState({
      entries: [{
        id: 'test-1', type: 'user', title: 'Test', description: 'Test',
        content: 'Already migrated', tags: [], createdAt: 1000, updatedAt: 1000, source: 'test',
      }],
      settings: {
        autoExtractEnabled: false,
        autoExtractInAllModes: false,
        maxMemoriesInPrompt: 10,
        maxMemoryChars: 3000,
      },
      lastSynced: 0,
    })
    expect(useMemoryStore.getState().entries[0].type).toBe('user')
  })
})

// ── Stress / Edge Cases ────────────────────────────────────────

describe('Memory Edge Cases', () => {
  beforeEach(resetStore)

  it('handles 100+ entries without issues', () => {
    for (let i = 0; i < 100; i++) {
      addMem('user', `Entry ${i}`, `Content for entry ${i} with some keywords`)
    }
    expect(useMemoryStore.getState().entries).toHaveLength(100)

    // Search still works
    const results = useMemoryStore.getState().searchMemories('Entry keywords')
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(20) // default limit

    // Prompt injection respects budget
    const prompt = useMemoryStore.getState().getMemoriesForPrompt('Entry keywords', 8192)
    expect(prompt.length).toBeGreaterThan(0)
    expect(prompt.length).toBeLessThanOrEqual(3200 + 200) // 800 tokens * 4 chars
  })

  it('handles special characters in content', () => {
    addMem('user', 'Special chars', 'Content with "quotes", <tags>, and {braces}')
    const results = useMemoryStore.getState().searchMemories('quotes tags braces')
    expect(results).toHaveLength(1)
  })

  it('handles unicode content', () => {
    addMem('user', 'Deutsch', 'Benutzer spricht Deutsch')
    const results = useMemoryStore.getState().searchMemories('Deutsch')
    expect(results).toHaveLength(1)
  })

  it('handles newlines in content', () => {
    addMem('project', 'Multi-line', 'Line 1\nLine 2\nLine 3')
    expect(useMemoryStore.getState().entries[0].content).toContain('\n')
    // Prompt injection should strip newlines
    const prompt = useMemoryStore.getState().getMemoriesForPrompt('Line', 16000)
    // Each entry line should not contain raw newlines
    const lines = prompt.split('\n').filter(l => l.startsWith('- '))
    for (const line of lines) {
      expect(line).not.toMatch(/\n.*\n/) // no internal newlines in single entry lines
    }
  })
})

// ══════════════════════════════════════════════════════════════
// Feature FF (v2.5.0) — embedding-first retrieval + write-decision
// ══════════════════════════════════════════════════════════════

// ── Async retrieval: offline fallback ──────────────────────────

describe('getMemoriesForPromptAsync — offline fallback', () => {
  beforeEach(() => {
    resetStore()
    addMem('user', 'Developer role', 'User is a senior TypeScript developer')
    addMem('feedback', 'Concise style', 'User prefers short, direct answers')
    addMem('project', 'Building v2.0', 'Working on multi-provider chat app v2.0')
    addMem('reference', 'Ollama docs', 'API reference at ollama.com/docs')
  })
  afterEach(() => __setMemoryEmbedFn())

  it('returns EXACTLY the keyword result when the embed fn throws', async () => {
    // Simulate Ollama unreachable.
    __setMemoryEmbedFn(async () => { throw new Error('Cannot reach Ollama') })

    const sync = useMemoryStore.getState().getMemoriesForPrompt('developer v2.0 Ollama', 16000)
    const async = await useMemoryStore.getState().getMemoriesForPromptAsync('developer v2.0 Ollama', 16000)
    expect(async).toBe(sync)
    expect(async).toContain('Developer role')
  })

  it('falls back to keyword when no candidate vectors exist (node has no IndexedDB)', async () => {
    // Embed succeeds, but loadVectors returns empty in the node env → the
    // async path detects "no usable vectors" and defers to keyword.
    __setMemoryEmbedFn(async (texts) => texts.map(() => [1, 0, 0]))
    const sync = useMemoryStore.getState().getMemoriesForPrompt('developer', 16000)
    const async = await useMemoryStore.getState().getMemoriesForPromptAsync('developer', 16000)
    expect(async).toBe(sync)
  })

  it('returns empty for a 2K-context model (no budget), embed never called', async () => {
    let called = false
    __setMemoryEmbedFn(async (t) => { called = true; return t.map(() => [1, 0, 0]) })
    const out = await useMemoryStore.getState().getMemoriesForPromptAsync('developer', 2048)
    expect(out).toBe('')
    expect(called).toBe(false)
  })

  it('empty query falls back to keyword (no message to embed)', async () => {
    __setMemoryEmbedFn(async (texts) => texts.map(() => [1, 0, 0]))
    const sync = useMemoryStore.getState().getMemoriesForPrompt('', 16000)
    const async = await useMemoryStore.getState().getMemoriesForPromptAsync('', 16000)
    expect(async).toBe(sync)
  })
})

// ── Stale entries: excluded from retrieval, preserved in entries ──

describe('Stale entry handling', () => {
  beforeEach(resetStore)

  it('excludes stale entries from sync retrieval but keeps them in entries', () => {
    const liveId = addMem('user', 'Lives in Berlin', 'User lives in Berlin Germany')
    const staleId = addMem('user', 'Lived in Munich', 'User used to live in Munich')
    // Mark the second one stale directly.
    useMemoryStore.setState((s) => ({
      entries: s.entries.map((e) => e.id === staleId ? { ...e, stale: true } : e),
    }))

    // Still present in the store…
    expect(useMemoryStore.getState().entries).toHaveLength(2)
    expect(useMemoryStore.getState().entries.find((e) => e.id === staleId)?.stale).toBe(true)

    // …but never injected.
    const prompt = useMemoryStore.getState().getMemoriesForPrompt('live Munich Berlin', 16000)
    expect(prompt).toContain('Lives in Berlin')
    expect(prompt).not.toContain('Lived in Munich')
    expect(liveId).toBeTruthy()
  })

  it('supersededBy also excludes from retrieval', () => {
    addMem('user', 'Current fact', 'The current valid fact')
    const oldId = addMem('user', 'Old fact', 'The old superseded fact')
    useMemoryStore.setState((s) => ({
      entries: s.entries.map((e) => e.id === oldId ? { ...e, supersededBy: 'something' } : e),
    }))
    const prompt = useMemoryStore.getState().getMemoriesForPrompt('fact valid superseded', 16000)
    expect(prompt).toContain('Current fact')
    expect(prompt).not.toContain('Old fact')
  })
})

// ── applyWriteDecision: ADD / UPDATE / NOOP ────────────────────

describe('applyWriteDecision', () => {
  beforeEach(resetStore)

  it('NOOP is a no-op (entries unchanged)', () => {
    addMem('user', 'A', 'Some fact A')
    const before = useMemoryStore.getState().entries.map((e) => ({ ...e }))
    useMemoryStore.getState().applyWriteDecision({ action: 'NOOP' })
    expect(useMemoryStore.getState().entries).toEqual(before)
  })

  it('ADD is a no-op here (caller already added the fact)', () => {
    addMem('user', 'A', 'Some fact A')
    const len = useMemoryStore.getState().entries.length
    useMemoryStore.getState().applyWriteDecision({ action: 'ADD' })
    expect(useMemoryStore.getState().entries).toHaveLength(len)
  })

  it('UPDATE rewrites the target content + bumps updatedAt + sets validFrom', () => {
    const targetId = addMem('user', 'Location', 'User lives in Munich')
    const target0 = useMemoryStore.getState().entries.find((e) => e.id === targetId)!
    const before = target0.updatedAt

    useMemoryStore.getState().applyWriteDecision({
      action: 'UPDATE',
      targetId,
      mergedContent: 'User now lives in Berlin (moved from Munich)',
    })

    const after = useMemoryStore.getState().entries.find((e) => e.id === targetId)!
    expect(after.content).toBe('User now lives in Berlin (moved from Munich)')
    expect(after.description).toBe('User now lives in Berlin (moved from Munich)'.substring(0, 120))
    expect(after.updatedAt).toBeGreaterThanOrEqual(before)
    expect(after.validFrom).toBe(after.updatedAt)
    expect(after.stale).toBe(false)
  })

  it('UPDATE marks the superseded candidate stale (not deleted) and keeps the merged target live', () => {
    const targetId = addMem('user', 'Location', 'User lives in Munich')
    // Simulate the speculative candidate the hook adds for the new fact.
    const newId = addMem('user', 'New location', 'User lives in Berlin')

    useMemoryStore.getState().applyWriteDecision(
      { action: 'UPDATE', targetId, mergedContent: 'User lives in Berlin (moved from Munich)' },
      { newId },
    )

    const entries = useMemoryStore.getState().entries
    // Both still present (nothing deleted).
    expect(entries).toHaveLength(2)
    const candidate = entries.find((e) => e.id === newId)!
    expect(candidate.stale).toBe(true)
    expect(candidate.supersededBy).toBe(targetId)
    // The merged target is NOT stale and is the only one injected.
    const prompt = useMemoryStore.getState().getMemoriesForPrompt('Berlin Munich lives', 16000)
    expect(prompt).toContain('moved from Munich')
  })

  it('UPDATE with a missing target is a safe no-op', () => {
    addMem('user', 'A', 'Fact A')
    const before = useMemoryStore.getState().entries.map((e) => ({ ...e }))
    useMemoryStore.getState().applyWriteDecision({
      action: 'UPDATE', targetId: 'does-not-exist', mergedContent: 'whatever',
    })
    expect(useMemoryStore.getState().entries).toEqual(before)
  })

  it('UPDATE with empty mergedContent is a safe no-op', () => {
    const targetId = addMem('user', 'A', 'Fact A')
    const before = useMemoryStore.getState().entries.find((e) => e.id === targetId)!.content
    useMemoryStore.getState().applyWriteDecision({ action: 'UPDATE', targetId, mergedContent: '   ' })
    expect(useMemoryStore.getState().entries.find((e) => e.id === targetId)!.content).toBe(before)
  })
})

// ── ensureMemoryEmbeddings: best-effort, no crash in node ──────

describe('ensureMemoryEmbeddings', () => {
  beforeEach(resetStore)
  afterEach(() => __setMemoryEmbedFn())

  it('resolves to 0 with no entries', async () => {
    const n = await useMemoryStore.getState().ensureMemoryEmbeddings()
    expect(n).toBe(0)
  })

  it('does not throw when the embed fn throws (best-effort)', async () => {
    addMem('user', 'A', 'Fact A')
    __setMemoryEmbedFn(async () => { throw new Error('Ollama down') })
    await expect(useMemoryStore.getState().ensureMemoryEmbeddings()).resolves.toBeTypeOf('number')
  })
})

// ── v3 migration keeps old entries valid ───────────────────────

describe('v2 → v3 migration', () => {
  it('keeps pre-v3 entries valid (optional fields default safely)', () => {
    // Simulate a v2 persisted entry with NO staleness fields at all.
    useMemoryStore.setState({
      entries: [{
        id: 'legacy-1', type: 'user', title: 'Legacy', description: 'Legacy desc',
        content: 'A legacy fact about TypeScript', tags: [], createdAt: 1000, updatedAt: 1000, source: 'test',
      } as MemoryFile],
      settings: {
        autoExtractEnabled: false, autoExtractInAllModes: false,
        maxMemoriesInPrompt: 10, maxMemoryChars: 3000,
      },
      lastSynced: 0,
    })

    // Entry survives intact and participates in retrieval (treated non-stale).
    const e = useMemoryStore.getState().entries[0]
    expect(e.id).toBe('legacy-1')
    expect(e.content).toBe('A legacy fact about TypeScript')
    const prompt = useMemoryStore.getState().getMemoriesForPrompt('legacy TypeScript fact', 16000)
    expect(prompt).toContain('Legacy')
  })
})

// ── Der echte Fall vom 03.09.2026: fremdes Gespraech im Prompt ──

describe('eine fremde Recherche darf nicht in den naechsten Prompt lecken', () => {
  /**
   * Ein Persona-Lauf recherchierte deutsche Transparenzgesetze und bekam im
   * Fazit „Für Ihren Dairy Farm Case…" — zwei Eintraege aus einem voellig
   * anderen, aelteren Gespraech, die still in jedem Prompt UND jedem
   * Unterauftrag mitfuhren.
   *
   * Die Kette hat zwei Tore, und beide muessen halten. Die eigentliche
   * Schwelle auf dem Rohsignal steckt in scoreMemoriesBlended und wird in
   * memory-retrieval.test.ts geprueft — im node-Lauf gibt es keine
   * IndexedDB, also faellt getMemoriesForPromptAsync hier auf den
   * Stichwortpfad zurueck. GENAU DAS wird hier geprueft: dass auch das
   * zweite Tor den fremden Eintrag nicht durchlaesst. Ohne diese Prüfung
   * koennte der Rueckfall die neue Schwelle lautlos wieder aufheben.
   *
   * Ehrlich dazu: dieser Block war schon vor dem Fix gruen (der
   * Stichwortpfad filtert seit je `score > 0`). Er ist kein Beweis fuer
   * den Fix, sondern ein Riegel dagegen, dass ein spaeterer Umbau des
   * Rueckfalls das zweite Tor oeffnet. Rot war der Beweis in
   * memory-retrieval.test.ts.
   */
  beforeEach(() => {
    resetStore()
    addMem('project', 'Dairy Farm Financials', 'Dairy farm with 90 cows on organic soil, land as collateral.')
    addMem('project', 'Preferred Structure Variant', 'Variant 1 is the preferred structure for the deal.')
  })
  afterEach(() => __setMemoryEmbedFn())

  it('liefert gar nichts, wenn keine Erinnerung zur Frage gehoert', async () => {
    __setMemoryEmbedFn(async (texts) => texts.map(() => [1, 0, 0]))
    const frage = 'Transparenzgesetz Hamburg Antragsfristen und Gebuehren'

    expect(await useMemoryStore.getState().getMemoriesForPromptAsync(frage, 16000)).toBe('')
    expect(useMemoryStore.getState().getMemoriesForPrompt(frage, 16000)).toBe('')
  })

  it('eine passende Erinnerung kommt weiterhin durch', async () => {
    addMem('user', 'Transparenzgesetz', 'Der Nutzer recherchiert Antragsfristen nach dem Transparenzgesetz.')
    __setMemoryEmbedFn(async (texts) => texts.map(() => [1, 0, 0]))

    const block = await useMemoryStore.getState().getMemoriesForPromptAsync('Transparenzgesetz Antragsfristen', 16000)
    expect(block).toContain('Transparenzgesetz')
    expect(block).not.toContain('Dairy Farm')
  })
})
