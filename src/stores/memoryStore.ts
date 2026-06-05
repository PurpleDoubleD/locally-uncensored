import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import type { MemoryEntry, MemoryCategory, MemoryFile, MemoryType, MemorySettings } from '../types/agent-mode'
import { MEMORY_MIGRATION_MAP, MEMORY_BUDGET_TIERS } from '../types/agent-mode'
import { createSafeStorage } from '../lib/storage-quota'

// ── Memory Budget Helper ──────────────────────────────────────

export function getMemoryBudget(contextTokens: number) {
  for (const tier of MEMORY_BUDGET_TIERS) {
    if (contextTokens <= tier.maxContext) return tier
  }
  return MEMORY_BUDGET_TIERS[MEMORY_BUDGET_TIERS.length - 1]
}

// ── Injection Sanitization ────────────────────────────────────

function sanitizeForInjection(text: string): string {
  return text
    // Strip common prompt injection patterns
    .replace(/<\|im_start\|>[\s\S]*?<\|im_end\|>/g, '')
    .replace(/<\|im_start\|>/g, '')
    .replace(/<\|im_end\|>/g, '')
    .replace(/<system>[\s\S]*?<\/system>/gi, '')
    .replace(/<\/?system>/gi, '')
    .replace(/\[INST\][\s\S]*?\[\/INST\]/g, '')
    .replace(/\[\/?INST\]/g, '')
    .replace(/<\|user\|>/g, '')
    .replace(/<\|assistant\|>/g, '')
    // Escape heading markers at line start (prevent prompt structure manipulation)
    .replace(/^#{1,6}\s/gm, '\\# ')
    // Collapse multiple newlines
    .replace(/\n{3,}/g, '\n\n')
    // Truncate per entry
    .substring(0, 500)
    .trim()
}

// ── Search Scoring ────────────────────────────────────────────

function scoreMemory(memory: MemoryFile, queryWords: string[]): number {
  if (queryWords.length === 0) return 1

  const titleLower = memory.title.toLowerCase()
  const descLower = memory.description.toLowerCase()
  const contentLower = memory.content.toLowerCase()
  const tagsLower = memory.tags.map(t => t.toLowerCase())

  let score = 0
  for (const w of queryWords) {
    if (titleLower.includes(w)) score += 4
    if (descLower.includes(w)) score += 3
    if (tagsLower.some(t => t.includes(w))) score += 3
    if (contentLower.includes(w)) score += 1
  }

  // Bonuses only apply when there's at least one word match
  if (score > 0) {
    // Recency bonus
    const age = Date.now() - memory.updatedAt
    const oneDay = 86400000
    if (age < oneDay) score += 2
    else if (age < 7 * oneDay) score += 1

    // User and feedback types get slight boost (most actionable)
    if (memory.type === 'user' || memory.type === 'feedback') score += 0.5
  }

  return score
}

// ── Type Labels ───────────────────────────────────────────────

const TYPE_SECTION_HEADERS: Record<MemoryType, string> = {
  user: 'About the user',
  feedback: 'User feedback / corrections',
  project: 'Project context',
  reference: 'References',
}

// ── Store Interface ───────────────────────────────────────────

interface MemoryState {
  entries: MemoryFile[]
  settings: MemorySettings
  lastSynced: number

  // CRUD
  addMemory: (memory: Omit<MemoryFile, 'id' | 'createdAt' | 'updatedAt'>) => string
  updateMemory: (id: string, updates: Partial<Pick<MemoryFile, 'title' | 'description' | 'content' | 'type' | 'tags'>>) => void
  removeMemory: (id: string) => void
  clearAll: () => void

  // Search & Inject
  searchMemories: (query: string, options?: { type?: MemoryType; limit?: number }) => MemoryFile[]
  getMemoriesForPrompt: (query: string, contextTokens: number) => string

  // Settings
  updateMemorySettings: (updates: Partial<MemorySettings>) => void

  // Export / Import
  exportAsMarkdown: () => string
  importFromMarkdown: (markdown: string) => void
  exportAsJSON: () => string
  importFromJSON: (json: string) => void

  // Legacy compat (used by old code paths during transition)
  addEntry: (category: MemoryCategory, content: string, source?: string) => void
  getMemoryForPrompt: (query: string, maxChars?: number) => string
}

// ── Migration from v1 (old MemoryEntry[]) to v2 (MemoryFile[]) ──

function migrateV1toV2(oldState: any): any {
  if (!oldState || !Array.isArray(oldState.entries)) return oldState

  // Check if already migrated (MemoryFile has 'type' field)
  if (oldState.entries.length > 0 && 'type' in oldState.entries[0]) {
    return oldState
  }

  // Migrate old MemoryEntry[] to MemoryFile[]
  const migratedEntries: MemoryFile[] = (oldState.entries as MemoryEntry[]).map((e) => ({
    id: e.id,
    type: MEMORY_MIGRATION_MAP[e.category] || 'project',
    title: e.content.substring(0, 60).replace(/\n/g, ' '),
    description: e.content.substring(0, 120).replace(/\n/g, ' '),
    content: e.content,
    tags: e.source ? [e.source] : [],
    createdAt: e.timestamp,
    updatedAt: e.timestamp,
    source: e.source || 'migration',
  }))

  return {
    ...oldState,
    entries: migratedEntries,
    settings: {
      autoExtractEnabled: true,
      autoExtractInAllModes: true,
      maxMemoriesInPrompt: 10,
      maxMemoryChars: 3000,
    },
  }
}

// ── Store ─────────────────────────────────────────────────────

export const useMemoryStore = create<MemoryState>()(
  persist(
    (set, get) => ({
      entries: [],
      settings: {
        autoExtractEnabled: true,
        autoExtractInAllModes: true,
        maxMemoriesInPrompt: 10,
        maxMemoryChars: 3000,
      },
      lastSynced: 0,

      // ── CRUD ────────────────────────────────────────────────

      addMemory: (memory) => {
        const trimmedContent = memory.content.trim()
        if (!trimmedContent) return ''

        // Deduplicate: don't add if exact same content + type exists
        const existing = get().entries
        if (existing.some(e => e.content === trimmedContent && e.type === memory.type)) return ''

        const id = uuid()
        set((state) => ({
          entries: [
            ...state.entries,
            {
              ...memory,
              id,
              content: trimmedContent,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
          lastSynced: Date.now(),
        }))
        return id
      },

      updateMemory: (id, updates) =>
        set((state) => ({
          entries: state.entries.map((e) =>
            e.id === id ? { ...e, ...updates, updatedAt: Date.now() } : e
          ),
          lastSynced: Date.now(),
        })),

      removeMemory: (id) =>
        set((state) => ({
          entries: state.entries.filter((e) => e.id !== id),
          lastSynced: Date.now(),
        })),

      clearAll: () => set({ entries: [], lastSynced: Date.now() }),

      // ── Search ──────────────────────────────────────────────

      searchMemories: (query, options) => {
        const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
        let results = get().entries

        // Filter by type
        if (options?.type) {
          results = results.filter(e => e.type === options.type)
        }

        // Score and sort
        const scored = results
          .map((entry) => ({ entry, score: scoreMemory(entry, words) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)

        const limit = options?.limit || 20
        return scored.slice(0, limit).map(({ entry }) => entry)
      },

      // ── Context-Aware Prompt Injection ──────────────────────

      getMemoriesForPrompt: (query, contextTokens) => {
        const budget = getMemoryBudget(contextTokens)

        // No budget for tiny models
        if (budget.budgetTokens === 0 || budget.maxMemories === 0) return ''

        const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
        let candidates = get().entries

        // Filter by allowed types for this tier
        if (budget.typesAllowed !== 'all') {
          candidates = candidates.filter(e => (budget.typesAllowed as MemoryType[]).includes(e.type))
        }

        // Score and sort
        const scored = candidates
          .map((entry) => ({ entry, score: scoreMemory(entry, words) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, budget.maxMemories)

        if (scored.length === 0) return ''

        // Group by type for structured output
        const grouped: Record<MemoryType, MemoryFile[]> = {
          user: [], feedback: [], project: [], reference: [],
        }
        for (const { entry } of scored) {
          grouped[entry.type].push(entry)
        }

        // Build output within char budget (tokens * 4 chars/token)
        const maxChars = budget.budgetTokens * 4
        let result = ''
        const typeOrder: MemoryType[] = ['user', 'feedback', 'project', 'reference']

        for (const type of typeOrder) {
          const items = grouped[type]
          if (items.length === 0) continue

          const header = `### ${TYPE_SECTION_HEADERS[type]}\n`
          if (result.length + header.length > maxChars) break
          result += header

          for (const item of items) {
            const sanitized = sanitizeForInjection(item.content).replace(/\n/g, ' ')
            const line = `- ${item.title}: ${sanitized}\n`
            if (result.length + line.length > maxChars) break
            result += line
          }
          result += '\n'
        }

        if (!result.trim()) return ''
        return `<remembered_context>\n${result.trim()}\n</remembered_context>`
      },

      // ── Settings ────────────────────────────────────────────

      updateMemorySettings: (updates) =>
        set((state) => ({
          settings: { ...state.settings, ...updates },
        })),

      // ── Export / Import ─────────────────────────────────────

      exportAsMarkdown: () => {
        const entries = get().entries
        if (entries.length === 0) return '# Memory\n\nNo entries yet.\n'

        const typeOrder: MemoryType[] = ['user', 'feedback', 'project', 'reference']
        const typeTitles: Record<MemoryType, string> = {
          user: 'User', feedback: 'Feedback', project: 'Project', reference: 'References',
        }

        let md = '# Memory\n\n'

        for (const type of typeOrder) {
          const typeEntries = entries.filter(e => e.type === type)
          if (typeEntries.length === 0) continue

          md += `## ${typeTitles[type]}\n\n`
          for (const entry of typeEntries) {
            const date = new Date(entry.updatedAt).toLocaleDateString()
            md += `- **${entry.title}** — ${entry.content}`
            if (entry.tags.length > 0) md += ` [${entry.tags.join(', ')}]`
            md += ` *(${entry.source})* — ${date}\n`
          }
          md += '\n'
        }

        return md
      },

      importFromMarkdown: (markdown) => {
        const lines = markdown.split('\n')
        const newEntries: MemoryFile[] = []
        let currentType: MemoryType = 'user'

        const typeMap: Record<string, MemoryType> = {
          'user': 'user', 'feedback': 'feedback', 'project': 'project', 'references': 'reference',
          // Legacy support
          'facts': 'user', 'tool results': 'reference', 'decisions': 'project', 'context': 'project',
        }

        for (const line of lines) {
          const headerMatch = line.match(/^##\s+(.+)/)
          if (headerMatch) {
            const header = headerMatch[1].toLowerCase().trim()
            if (typeMap[header]) currentType = typeMap[header]
            continue
          }

          const itemMatch = line.match(/^-\s+(?:\*\*(.+?)\*\*\s*—\s*)?(.+?)(?:\s+\[(.+?)\])?(?:\s+\*\((.+?)\)\*)?(?:\s+—\s+.+)?$/)
          if (itemMatch) {
            const title = itemMatch[1] || itemMatch[2].substring(0, 60)
            const content = itemMatch[2].trim()
            const tags = itemMatch[3] ? itemMatch[3].split(',').map(t => t.trim()) : []
            const source = itemMatch[4] || 'import'

            if (content) {
              newEntries.push({
                id: uuid(),
                type: currentType,
                title: title.substring(0, 60),
                description: content.substring(0, 120),
                content,
                tags,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                source,
              })
            }
          }
        }

        if (newEntries.length > 0) {
          set((state) => ({
            entries: [...state.entries, ...newEntries],
            lastSynced: Date.now(),
          }))
        }
      },

      exportAsJSON: () => {
        const { entries, settings } = get()
        return JSON.stringify({ entries, settings }, null, 2)
      },

      importFromJSON: (json) => {
        try {
          const data = JSON.parse(json)
          if (Array.isArray(data.entries)) {
            set((state) => ({
              entries: [...state.entries, ...data.entries],
              lastSynced: Date.now(),
            }))
          }
        } catch {
          console.error('Failed to parse memory JSON import')
        }
      },

      // ── Legacy Compat ───────────────────────────────────────

      addEntry: (category, content, source) => {
        const type = MEMORY_MIGRATION_MAP[category] || 'project'
        get().addMemory({
          type,
          title: content.substring(0, 60).replace(/\n/g, ' '),
          description: content.substring(0, 120).replace(/\n/g, ' '),
          content,
          tags: source ? [source] : [],
          source: source || 'agent',
        })
      },

      getMemoryForPrompt: (query, maxChars = 2000) => {
        // Legacy: assume 8K context for backward compat
        return get().getMemoriesForPrompt(query, 8192)
      },
    }),
    {
      name: 'locally-uncensored-memory',
      version: 2,
      storage: createJSONStorage(() => createSafeStorage()),
      migrate: (persistedState, version) => {
        if (version < 2) {
          return migrateV1toV2(persistedState)
        }
        return persistedState as MemoryState
      },
      partialize: (state) => ({
        entries: state.entries,
        settings: state.settings,
        lastSynced: state.lastSynced,
      }),
    }
  )
)
