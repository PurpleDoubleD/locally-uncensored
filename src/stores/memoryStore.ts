import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import type { MemoryEntry, MemoryCategory, MemoryFile, MemoryType, MemorySettings, MemoryBudgetTier } from '../types/agent-mode'
import { MEMORY_MIGRATION_MAP, MEMORY_BUDGET_TIERS } from '../types/agent-mode'
import { idbStorage } from '../lib/idbStorage'
import { generateEmbeddings } from '../api/rag'
import { saveVector, loadVectors, deleteVector, clearAll as clearAllVectors, type MemoryVectorRecord } from '../lib/memoryEmbedDB'
import { scoreMemoriesBlended, isStale, type BlendCandidate } from '../lib/memory-retrieval'
import type { ResolutionDecision } from '../lib/memory-extraction'
import { log } from '../lib/logger'

// ── Embedding model + dim (mirrors rag.ts default) ────────────────
const MEMORY_EMBED_MODEL = 'nomic-embed-text'

// ── Embedding fn (dependency-injected so tests stub without Ollama) ──
// Defaults to the real RAG embedder. Tests call __setMemoryEmbedFn to inject
// a fake (or a thrower, to exercise the offline fallback).
type MemoryEmbedFn = (texts: string[]) => Promise<number[][]>
let _embedFn: MemoryEmbedFn = (texts) => generateEmbeddings(texts, MEMORY_EMBED_MODEL)
/** Test hook — override the embedding function. Pass nothing to reset. */
export function __setMemoryEmbedFn(fn?: MemoryEmbedFn): void {
  _embedFn = fn ?? ((texts) => generateEmbeddings(texts, MEMORY_EMBED_MODEL))
}

// ── Content hashing (djb2 — same trick as embedding-router) ───────
// The text we embed is title + content; re-embed only when this hash changes.
function embedText(m: Pick<MemoryFile, 'title' | 'content'>): string {
  return `${m.title}\n${m.content}`
}

// ── Injection options ──────────────────────────────────────────────
export interface MemoryInjectOpts {
  /**
   * Drop memories that are raw TOOL RESULTS (extracted from agent sessions as
   * "web_search result: web_search({...}) → …"). Injected into a PLAIN chat
   * they read as worked tool-call examples and prime the model to attempt a
   * tool call it was never offered — gemma4 then spends the whole turn in its
   * thinking channel deciding to "use the web_search tool", emits zero
   * content, and the user stares at a silent empty bubble (live find
   * 2026-06-11, David's no-answer report). Agent chats keep them: there the
   * tools actually exist.
   */
  excludeToolResults?: boolean
}

/**
 * A memory whose content (or title) is a verbatim tool RESULT from an agent
 * session. The extractor writes them in the stable shape
 * "<tool_name> result: …" / title "<tool_name> result".
 * Exported + pure for the unit tests.
 */
export function isToolResultMemory(m: Pick<MemoryFile, 'title' | 'content'>): boolean {
  const probe = `${m.title || ''}\n${m.content || ''}`
  return /\b[a-z][a-z0-9_]* result:/i.test(probe)
}
function hashContent(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i)
  return (h >>> 0).toString(16)
}

/**
 * Best-effort: embed a single memory and persist its vector to IndexedDB.
 * Fire-and-forget — never throws (Ollama down, IDB missing in tests, etc.).
 * Skips when the existing stored vector already matches the content hash.
 */
async function enqueueEmbedding(entry: Pick<MemoryFile, 'id' | 'title' | 'content'>): Promise<void> {
  try {
    const text = embedText(entry)
    const contentHash = hashContent(text)
    const existing = await loadVectors([entry.id])
    const prior = existing.get(entry.id)
    if (prior && prior.contentHash === contentHash && prior.model === MEMORY_EMBED_MODEL) return
    const [vector] = await _embedFn([text])
    if (!vector || vector.length === 0) return
    const record: MemoryVectorRecord = {
      model: MEMORY_EMBED_MODEL,
      dim: vector.length,
      vector,
      contentHash,
    }
    await saveVector(entry.id, record)
  } catch {
    // Embedding is best-effort — retrieval falls back to keyword scoring.
  }
}

// ── Memory Budget Helper ──────────────────────────────────────

export function getMemoryBudget(contextTokens: number) {
  for (const tier of MEMORY_BUDGET_TIERS) {
    if (contextTokens <= tier.maxContext) return tier
  }
  return MEMORY_BUDGET_TIERS[MEMORY_BUDGET_TIERS.length - 1]
}

/**
 * Memory budget after applying the user's manual override. null / <=0 → the
 * context-tier budget unchanged. A positive override sets the injected count,
 * grows the token budget (~150 tok/memory, never below the tier's) so the extra
 * entries actually fit, and allows all types — so the user isn't locked to
 * "32k ctx = 15 memories" (David 2026-06-07). Exported for unit testing.
 */
export function effectiveMemoryBudget(contextTokens: number, override?: number | null): MemoryBudgetTier {
  const tier = getMemoryBudget(contextTokens)
  if (override == null || override <= 0) return tier
  const n = Math.floor(override)
  return {
    ...tier,
    maxMemories: n,
    budgetTokens: Math.max(tier.budgetTokens, n * 150),
    typesAllowed: 'all',
  }
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

const TYPE_ORDER: MemoryType[] = ['user', 'feedback', 'project', 'reference']

/**
 * Hard ceiling for the injected memory block, in tokens (plan 2.6.6 A7).
 *
 * The budget tiers hand out up to 4000 tokens of memory on a large-context
 * model, and that block rides along in EVERY request of EVERY turn — it is
 * paid for again on each step of an agent run, forever, whether or not a
 * single memory was relevant. 1k is the ceiling; a block that already fits
 * under it is injected in full and unchanged, so the cap only ever bites the
 * oversized case.
 */
export const MEMORY_CONTEXT_TOKEN_CAP = 1000

/**
 * Render an ALREADY-ORDERED, ALREADY-FILTERED list of memories into the
 * grouped <remembered_context> block, respecting the tier's char budget and
 * sanitizing every injected line. Shared by the sync (keyword) and async
 * (embedding-blended) retrieval paths — ONLY the candidate ordering differs
 * between them, so the output formatting lives here once.
 *
 * The A7 cap is applied HERE, at the one place the string is built, so every
 * injection site (useChat, useAgentChat, useCodex, the remote dispatcher)
 * inherits it and none of them can drift.
 */
function renderRememberedContext(ordered: MemoryFile[], budgetTokens: number): string {
  if (ordered.length === 0) return ''
  const cappedTokens = Math.min(budgetTokens, MEMORY_CONTEXT_TOKEN_CAP)

  // Group by type for structured output (preserve incoming order within type).
  const grouped: Record<MemoryType, MemoryFile[]> = {
    user: [], feedback: [], project: [], reference: [],
  }
  for (const entry of ordered) grouped[entry.type].push(entry)

  const maxChars = cappedTokens * 4
  let result = ''

  for (const type of TYPE_ORDER) {
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
  getMemoriesForPrompt: (query: string, contextTokens: number, opts?: MemoryInjectOpts) => string
  /** Embedding-first retrieval; falls back to getMemoriesForPrompt on any error. */
  getMemoriesForPromptAsync: (query: string, contextTokens: number, opts?: MemoryInjectOpts) => Promise<string>

  // Write-decision + embedding maintenance (Feature FF)
  applyWriteDecision: (decision: ResolutionDecision, ctx?: { newId?: string }) => void
  ensureMemoryEmbeddings: (batchSize?: number) => Promise<number>

  // Settings
  updateMemorySettings: (updates: Partial<MemorySettings>) => void

  // Export / Import — importers return the number of entries actually added
  // so the UI can give feedback (konata-session 2026-06-07: silent 0-import).
  exportAsMarkdown: () => string
  importFromMarkdown: (markdown: string) => number
  exportAsJSON: () => string
  importFromJSON: (json: string) => number

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

// ── Migration from v2 to v3 (Feature FF) ──────────────────────
//
// v3 adds OPTIONAL MemoryFile fields (supersededBy / supersedesId / stale /
// validFrom). Existing entries are already valid without them — this
// migration is intentionally a near-identity that just guarantees the
// `stale` flag is a concrete boolean (false) on every entry, so retrieval's
// `isStale` and the "Show outdated" filter behave deterministically on
// freshly-rehydrated old stores. All other new fields stay undefined.
function migrateV2toV3(oldState: any): any {
  if (!oldState || !Array.isArray(oldState.entries)) return oldState
  const entries = (oldState.entries as MemoryFile[]).map((e) => ({
    ...e,
    stale: e.stale === true ? true : false,
  }))
  return { ...oldState, entries }
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
        // Embed in the background — never blocks the synchronous add.
        void enqueueEmbedding({ id, title: memory.title, content: trimmedContent })
        return id
      },

      updateMemory: (id, updates) => {
        set((state) => ({
          entries: state.entries.map((e) =>
            e.id === id ? { ...e, ...updates, updatedAt: Date.now() } : e
          ),
          lastSynced: Date.now(),
        }))
        // Re-embed when title/content changed (hashContent skips a no-op).
        if (updates.title !== undefined || updates.content !== undefined) {
          const updated = get().entries.find((e) => e.id === id)
          if (updated) void enqueueEmbedding({ id, title: updated.title, content: updated.content })
        }
      },

      removeMemory: (id) => {
        set((state) => ({
          entries: state.entries.filter((e) => e.id !== id),
          lastSynced: Date.now(),
        }))
        void deleteVector(id)
      },

      clearAll: () => {
        set({ entries: [], lastSynced: Date.now() })
        void clearAllVectors()
      },

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

      // ── Context-Aware Prompt Injection (sync, keyword) ──────
      //
      // This is the OFFLINE-SAFE fallback path. It never touches Ollama or
      // IndexedDB. getMemoriesForPromptAsync below layers embedding-blended
      // ordering on top and degrades to exactly this output on any error.
      getMemoriesForPrompt: (query, contextTokens, opts) => {
        const budget = effectiveMemoryBudget(contextTokens, get().settings.maxMemoriesOverride)

        // No budget for tiny models
        if (budget.budgetTokens === 0 || budget.maxMemories === 0) return ''

        const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
        let candidates = get().entries.filter(e => !isStale(e))
        if (opts?.excludeToolResults) {
          candidates = candidates.filter(e => !isToolResultMemory(e))
        }

        // Filter by allowed types for this tier
        if (budget.typesAllowed !== 'all') {
          candidates = candidates.filter(e => (budget.typesAllowed as MemoryType[]).includes(e.type))
        }

        // Score and sort (keyword)
        const ordered = candidates
          .map((entry) => ({ entry, score: scoreMemory(entry, words) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, budget.maxMemories)
          .map(({ entry }) => entry)

        return renderRememberedContext(ordered, budget.budgetTokens)
      },

      // ── Context-Aware Prompt Injection (async, embedding-first) ──
      //
      // Embed the query, hydrate candidate vectors from IndexedDB, blend-score
      // (semantic + keyword + recency + type boost), then reuse the EXACT same
      // budget tiers / type filter / sanitization / grouped output as the sync
      // path — only the candidate ORDERING changes. Wrapped so ANY failure
      // (Ollama unreachable, nomic missing, IDB absent, dim mismatch) falls
      // back to the keyword result. Offline correctness invariant: this never
      // returns empty/incorrect when the sync path would have returned text.
      getMemoriesForPromptAsync: async (query, contextTokens, opts) => {
        const fallback = () => get().getMemoriesForPrompt(query, contextTokens, opts)
        try {
          const budget = effectiveMemoryBudget(contextTokens, get().settings.maxMemoriesOverride)
          // No-op cases (no budget, no candidates, empty query) must return
          // EXACTLY what the sync keyword path would — defer to fallback()
          // rather than re-deriving '' so behaviour stays identical (and so a
          // stubbed sync method in tests is honoured).
          if (budget.budgetTokens === 0 || budget.maxMemories === 0) return fallback()

          let candidates = get().entries.filter(e => !isStale(e))
          if (opts?.excludeToolResults) {
            candidates = candidates.filter(e => !isToolResultMemory(e))
          }
          if (budget.typesAllowed !== 'all') {
            candidates = candidates.filter(e => (budget.typesAllowed as MemoryType[]).includes(e.type))
          }
          if (candidates.length === 0) return fallback()

          // Embed the query. Empty query has nothing to embed → no semantic
          // signal → keyword path is strictly better (it filters by score).
          if (!query.trim()) return fallback()
          let queryVec: number[] = []
          const [vec] = await _embedFn([query])
          if (vec && vec.length > 0) queryVec = vec

          // No usable query vector → fall back to keyword.
          if (queryVec.length === 0) return fallback()

          // Hydrate candidate vectors into a hot Map. dim-mismatched vectors
          // are dropped here (scorer also guards) → treated as keyword-only.
          const vecMap = await loadVectors(candidates.map(c => c.id))
          const blendCandidates: BlendCandidate[] = candidates.map((memory) => {
            const rec = vecMap.get(memory.id)
            const vector = rec && rec.dim === queryVec.length ? rec.vector : null
            return { memory, vector }
          })

          // If NOT A SINGLE candidate has a usable vector, the blend reduces to
          // keyword+recency with no semantic lift — the sync keyword path is
          // the better-tested equivalent, so fall back to it.
          if (!blendCandidates.some(c => c.vector)) return fallback()

          const scored = scoreMemoriesBlended(queryVec, query, blendCandidates)
          const ordered = scored.slice(0, budget.maxMemories).map(s => s.memory)

          // Defensive: a degenerate blend that filtered everything out should
          // not silently inject nothing when keyword would have found matches.
          if (ordered.length === 0) return fallback()

          return renderRememberedContext(ordered, budget.budgetTokens)
        } catch {
          return fallback()
        }
      },

      // ── Write-decision application (Feature FF) ─────────────
      //
      // Applies the resolver's ADD/UPDATE/NOOP decision for an
      // already-extracted, already-added candidate fact.
      //   - ADD:    nothing to do here (the fact was added by the caller).
      //   - NOOP:   skip (caller decided not to add it).
      //   - UPDATE: rewrite the target's content + re-embed + bump updatedAt
      //             + set validFrom, and mark the (separate) superseded entry
      //             stale rather than deleting it. The `newId` (the entry the
      //             caller just added for this fact, if any) is removed so the
      //             merge doesn't leave a near-duplicate behind.
      applyWriteDecision: (decision: ResolutionDecision, ctx?: { newId?: string }) => {
        if (decision.action === 'NOOP') return
        if (decision.action === 'ADD') return // caller already added it

        // UPDATE
        const { targetId, mergedContent } = decision
        if (!targetId || !mergedContent) return
        const target = get().entries.find((e) => e.id === targetId)
        if (!target) return

        const merged = mergedContent.trim()
        if (!merged) return

        const now = Date.now()
        set((state) => ({
          entries: state.entries.map((e) => {
            if (e.id === targetId) {
              return {
                ...e,
                content: merged,
                description: merged.substring(0, 120),
                updatedAt: now,
                validFrom: now,
                // Clearing stale/supersededBy in case we're refreshing a
                // previously-superseded entry.
                stale: false,
                supersededBy: undefined,
              }
            }
            // The freshly-added candidate (if provided) is the OLD shape of
            // this fact → mark it stale + point it at the merged target.
            if (ctx?.newId && e.id === ctx.newId) {
              return { ...e, stale: true, supersededBy: targetId }
            }
            return e
          }),
          lastSynced: now,
        }))

        // Re-embed the merged target; drop the superseded candidate's vector.
        const updated = get().entries.find((e) => e.id === targetId)
        if (updated) void enqueueEmbedding({ id: targetId, title: updated.title, content: updated.content })
        if (ctx?.newId && ctx.newId !== targetId) void deleteVector(ctx.newId)
      },

      // ── Lazy embedding backfill (Feature FF) ────────────────
      //
      // Idempotent, best-effort: embed any non-stale entries that don't yet
      // have a stored vector (e.g. memories created before v2.5.0, or while
      // Ollama was down). Processed in small serial batches so a large memory
      // store doesn't fire hundreds of /embed calls at once. Safe no-op in the
      // node test env (memoryEmbedDB guards on `indexedDB`). Returns the count
      // of entries (re)embedded.
      ensureMemoryEmbeddings: async (batchSize = 8) => {
        let embedded = 0
        try {
          const entries = get().entries.filter((e) => !isStale(e))
          if (entries.length === 0) return 0
          const ids = entries.map((e) => e.id)
          const existing = await loadVectors(ids)
          const missing = entries.filter((e) => {
            const rec = existing.get(e.id)
            if (!rec) return true
            // Re-embed if the content hash drifted or model changed.
            return rec.contentHash !== hashContent(embedText(e)) || rec.model !== MEMORY_EMBED_MODEL
          })
          for (let i = 0; i < missing.length; i += batchSize) {
            const slice = missing.slice(i, i + batchSize)
            // Serial within a slice keeps memory + Ollama pressure bounded;
            // enqueueEmbedding already swallows its own errors.
            for (const e of slice) {
              await enqueueEmbedding({ id: e.id, title: e.title, content: e.content })
              embedded++
            }
          }
        } catch {
          // Best-effort backfill — ignore failures.
        }
        return embedded
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
            md += `- **${entry.title}**, ${entry.content}`
            if (entry.tags.length > 0) md += ` [${entry.tags.join(', ')}]`
            md += ` *(${entry.source})*, ${date}\n`
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
        return newEntries.length
      },

      exportAsJSON: () => {
        const { entries, settings } = get()
        return JSON.stringify({ entries, settings }, null, 2)
      },

      importFromJSON: (json) => {
        let raw: any
        try {
          raw = JSON.parse(json)
        } catch {
          log.error('Failed to parse memory JSON import')
          return 0
        }
        // Tolerant shape handling: accept LU's own {entries:[...]} export, a
        // bare [...] array, or {memories:[...]} (konata-session 2026-06-07 —
        // imports silently produced 0 entries on any other shape).
        const arr: any[] = Array.isArray(raw) ? raw
          : Array.isArray(raw?.entries) ? raw.entries
          : Array.isArray(raw?.memories) ? raw.memories
          : []
        const VALID: MemoryType[] = ['user', 'feedback', 'project', 'reference']
        const now = Date.now()
        const newEntries: MemoryFile[] = []
        for (const e of arr) {
          const content = String(e?.content ?? e?.text ?? e?.value ?? '').trim()
          if (!content) continue
          newEntries.push({
            // Always mint a fresh id so a re-imported export can never collide
            // with an existing entry's id (which broke edit/remove-by-id).
            id: uuid(),
            type: VALID.includes(e?.type) ? e.type : 'user',
            title: String(e?.title ?? content).slice(0, 60).replace(/\n/g, ' '),
            description: String(e?.description ?? content).slice(0, 120),
            content,
            tags: Array.isArray(e?.tags) ? e.tags.map((t: any) => String(t)) : [],
            createdAt: typeof e?.createdAt === 'number' ? e.createdAt : now,
            updatedAt: now,
            source: String(e?.source ?? 'import'),
          })
        }
        if (newEntries.length > 0) {
          set((state) => ({
            entries: [...state.entries, ...newEntries],
            lastSynced: now,
          }))
        }
        return newEntries.length
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
        // Legacy: the current API budgets in context TOKENS, so the 8K
        // assumption stays. The caller's character cap used to be accepted and
        // then silently dropped, which is the one thing this signature
        // promises; it is honoured on the rendered block instead.
        const block = get().getMemoriesForPrompt(query, 8192)
        return block.length > maxChars ? block.slice(0, maxChars) : block
      },
    }),
    {
      name: 'locally-uncensored-memory',
      // v3 (Feature FF): adds optional staleness/supersession fields to
      // MemoryFile. They default to unset, so old entries remain valid — the
      // bump exists only to run migrateV2toV3 so the shape is explicit and
      // future migrations have a clean baseline.
      version: 3,
      // IndexedDB (idbStorage) instead of localStorage — memories + their growth
      // shouldn't be capped at ~5 MB; idb is disk-backed and migrates existing
      // localStorage data on first read. createJSONStorage wrap still required
      // (zustand v5 PersistStorage; raw StateStorage → "[object Object]", FIX-3).
      storage: createJSONStorage(() => idbStorage),
      migrate: (persistedState, version) => {
        let state: any = persistedState
        if (version < 2) {
          state = migrateV1toV2(state)
        }
        if (version < 3) {
          state = migrateV2toV3(state)
        }
        return state as MemoryState
      },
      partialize: (state) => ({
        entries: state.entries,
        settings: state.settings,
        lastSynced: state.lastSynced,
      }),
    }
  )
)
