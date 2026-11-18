import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import type { MemoryCategory, MemoryFile, MemoryType, MemorySettings, MemoryBudgetTier } from '../types/agent-mode'
import { MEMORY_MIGRATION_MAP, MEMORY_BUDGET_TIERS } from '../types/agent-mode'
import { memoryPersistence } from '../lib/memory-persistence'
import { generateEmbeddings } from '../api/rag'
import { singleModelSlot } from '../lib/capabilities'
import { saveVector, loadVectors, deleteVector, clearAll as clearAllVectors, type MemoryVectorRecord } from '../lib/memoryEmbedDB'
import { scoreMemoriesBlended, isStale, type BlendCandidate } from '../lib/memory-retrieval'
import { onlyStatesAGap } from '../lib/memory-gap'
import type { ResolutionDecision } from '../lib/memory-extraction'
import { isRecord, prop, asString, asNumber, asStringArray } from '../types/json-guards'
import { log } from '../lib/logger'
import { charsPerToken } from '../lib/token-estimate'
import { useCloudAuthStore } from './cloudAuthStore'
import type { MemorySyncBaseline } from '../lib/memory-sync-plan'
import { forgetMark, isForgotten, liftForgotten, readForgotten, withForgotten, type ForgottenMemory } from '../lib/memory-forget'
import { hasCjk as hasCjkQuery, searchTerms } from '../lib/search-terms'

// ── Embedding model + dim (mirrors rag.ts default) ────────────────
const MEMORY_EMBED_MODEL = 'nomic-embed-text'

// ── Embedding fn (dependency-injected so tests stub without Ollama) ──
// Defaults to the real RAG embedder. Tests call __setMemoryEmbedFn to inject
// a fake (or a thrower, to exercise the offline fallback).
type MemoryEmbedFn = (texts: string[]) => Promise<number[][]>
let _embedFn: MemoryEmbedFn = (texts) => generateEmbeddings(texts, MEMORY_EMBED_MODEL, { purpose: 'memory' })
/** Test hook, override the embedding function. Pass nothing to reset. */
export function __setMemoryEmbedFn(fn?: MemoryEmbedFn): void {
  _embedFn = fn ?? ((texts) => generateEmbeddings(texts, MEMORY_EMBED_MODEL, { purpose: 'memory' }))
}

// ── Content hashing (djb2, same trick as embedding-router) ───────
// The text we embed is title + content; re-embed only when this hash changes.
function embedText(m: Pick<MemoryFile, 'title' | 'content'>): string {
  return `${m.title}\n${m.content}`
}

// ── Injection options ──────────────────────────────────────────────
export interface MemoryInjectOpts {
  /** Internal selection observer, after filtering and the final render budget. */
  onInjected?: (ids: readonly string[]) => void
  /** A scoped memory is eligible only for this exact nonempty project ID. */
  scope?: string
  /**
   * Drop memories that are raw TOOL RESULTS (extracted from agent sessions as
   * "web_search result: web_search({...}) → …"). Injected into a PLAIN chat
   * they read as worked tool-call examples and prime the model to attempt a
   * tool call it was never offered, gemma4 then spends the whole turn in its
   * thinking channel deciding to "use the web_search tool", emits zero
   * content, and the user stares at a silent empty bubble (live find
   * 2026-06-11, the owner's no-answer report). Agent chats keep them: there the
   * tools actually exist.
   */
  excludeToolResults?: boolean
  /**
   * The chat this request belongs to. What was sent is kept per chat, so the
   * brain icon shows what the last request of THIS chat carried (GH #255).
   */
  conversationId?: string
  /** The chat's own switch is off (Conversation.memoryOff): nothing is sent. */
  chatOff?: boolean
}

/**
 * What one request carried, per chat, for the brain icon (GH #255). Kept for
 * the session only. `leftOut` are memories that belonged to the question but
 * did not fit the count or the token budget; `shortened` reached the model
 * cut at the per-memory limit, with a mark.
 */
export interface MemoryInjectionReport {
  at: number
  text: string
  sent: string[]
  leftOut: string[]
  shortened: string[]
  /** Memories this chat may receive at all (scope, sensitive, outdated). */
  eligible: number
  tokens: number
  budget: number
  /** Why nothing was sent: switched off app wide, or for this chat. */
  off?: 'all' | 'chat'
}

/**
 * A memory the user wrote or imported, not one the extractor wrote. Only an
 * automatic writer sets `sourceKind` without the source "manual" (useMemory);
 * the phone's "remember this" sets both and is the user's own words. A record
 * from before `sourceKind` existed counts as written by hand, so the doubt
 * always protects the text (GH #255: the merge step turned a hand-written
 * story day of 1,200 characters into two English sentences).
 */
export function isHandWritten(m: Pick<MemoryFile, 'source' | 'sourceKind'>): boolean {
  return m.source === 'manual' || m.sourceKind === undefined
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

export function memoryMatchesScope(memory: Pick<MemoryFile, 'scope'>, scope?: string): boolean {
  return memory.scope === undefined ||
    (typeof memory.scope === 'string' && memory.scope.trim().length > 0 && memory.scope === scope)
}

/**
 * Same memory inside one collection: same content, same type, same scope.
 * addMemory has always refused a second record on this rule; the importers
 * reuse it, so reading the app's own export back in cannot double a collection
 * (box test T5 punkt 4, 11.09.2026: import of a 4-entry export gave 8 entries).
 */
export function isSameMemory(
  a: Pick<MemoryFile, 'content' | 'type' | 'scope'>,
  b: Pick<MemoryFile, 'content' | 'type' | 'scope'>,
): boolean {
  return a.content === b.content && a.type === b.type && a.scope === b.scope
}

/**
 * Everything an import did. Every usable entry of the file lands in exactly one
 * counter, so the UI can name the numbers instead of claiming a flat import.
 */
export interface MemoryImportResult {
  /** Written as new records. */
  added: number
  /** Known records (same id) refreshed from the file because fields changed. */
  updated: number
  /** Already in this collection, left untouched. */
  alreadyPresent: number
  /**
   * How many of the refreshed records lost their "sensitive" mark because the
   * file said so. Only present when it actually happened: a mark falling is a
   * privacy event and gets its own number, but a clean import must not carry a
   * zero about sensitive memories through every sentence.
   */
  unmarkedSensitive?: number
}

/** Everything that decides whether a known record still matches the file. */
function importDigest(m: MemoryFile): string {
  return JSON.stringify([m.type, m.title, m.description, m.content, [...m.tags].sort(), m.source,
    m.sourceKind ?? null, m.confirmedAt ?? null, m.sensitive === true, m.scope ?? null,
    m.stale === true, m.validFrom ?? null, m.supersededBy ?? null, m.supersedesId ?? null])
}

/** The sentence the settings page shows after an import. Desktop and web share the wording. */
export function describeMemoryImport(result: MemoryImportResult): string {
  const noun = (n: number) => (n === 1 ? 'memory' : 'memories')
  if (result.updated === 0 && result.alreadyPresent === 0) {
    return `Imported ${result.added} ${noun(result.added)}.`
  }
  const parts = [`Imported ${result.added} new ${noun(result.added)}`]
  if (result.updated > 0) parts.push(`${result.updated} updated`)
  if (result.alreadyPresent > 0) parts.push(`${result.alreadyPresent} already present`)
  if (result.unmarkedSensitive) parts.push(`${result.unmarkedSensitive} no longer marked sensitive`)
  return `${parts.join(', ')}.`
}

function hashContent(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i)
  return (h >>> 0).toString(16)
}

/**
 * Best-effort: embed a single memory and persist its vector to IndexedDB.
 * Fire-and-forget, never throws (Ollama down, IDB missing in tests, etc.).
 * Skips when the existing stored vector already matches the content hash.
 */
async function enqueueEmbedding(entry: Pick<MemoryFile, 'id' | 'title' | 'content'>): Promise<void> {
  // One model slot (lib/model-slot.ts): a phone never loads the embedder for
  // memory. Adding, editing and the lazy backfill all end here, so this one
  // line keeps every one of them from pushing the chat model out of memory.
  // Memories are found by keyword there (getMemoriesForPrompt).
  if (singleModelSlot()) return
  const collectionRevision = useMemoryStore.getState().memoryCollectionRevision
  try {
    const text = embedText(entry)
    const contentHash = hashContent(text)
    const isCurrent = () => {
      const current = useMemoryStore.getState().entries.find((item) => item.id === entry.id)
      return useMemoryStore.getState().memoryCollectionRevision === collectionRevision &&
        !!current && !current.sensitive && !isStale(current) && embedText(current) === text
    }
    const existing = await loadVectors([entry.id])
    if (!isCurrent()) return
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
    await saveVector(entry.id, record, isCurrent)
  } catch {
    // Embedding is best-effort, retrieval falls back to keyword scoring.
  }
}

// ── Memory Budget Helper ──────────────────────────────────────

/**
 * The budget of a phone whose engine runs with a window of 2048 tokens or
 * less (M9, acceptance on the small iPhone, 08.10.2026).
 *
 * The first tier gives such a window nothing, which is right for a desktop
 * where 2048 is an accident of a missing setting. On a small phone 2048 IS
 * the setting the app recommends, so every memory the user wrote in the
 * settings was silently left out of every chat. Two short facts about the
 * user cost about a hundred tokens, and that the window has.
 */
export const MOBILE_SMALL_WINDOW_BUDGET: MemoryBudgetTier = {
  maxContext: 2048, budgetTokens: 150, maxMemories: 2, typesAllowed: ['user', 'feedback'],
}

export function getMemoryBudget(contextTokens: number) {
  for (const tier of MEMORY_BUDGET_TIERS) {
    if (contextTokens <= tier.maxContext) {
      return tier.maxMemories === 0 && contextTokens > 0 && singleModelSlot() ? MOBILE_SMALL_WINDOW_BUDGET : tier
    }
  }
  return MEMORY_BUDGET_TIERS[MEMORY_BUDGET_TIERS.length - 1]
}

/** Words of a question for the keyword search: letters and digits, so "drink?" is "drink". */
function queryWords(query: string): string[] {
  return query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2)
}

/**
 * What the keyword search hands on, on a phone (M9).
 *
 * A desktop finds "Mara likes tea" for "what is my favourite beverage" by
 * meaning, through the embedder. A phone holds one model and never loads the
 * embedder for memory, so only a shared word finds a memory there, and a
 * question rarely repeats the words of the fact it asks about. What the user
 * told LU about themselves is short and is exactly what such a question is
 * after: on a phone the places a word match left free go to the newest of
 * those notes. The tier still caps count, kind and tokens.
 */
function fillWithUserNotes(matched: MemoryFile[], candidates: MemoryFile[], maxMemories: number): MemoryFile[] {
  if (!singleModelSlot() || matched.length >= maxMemories) return matched
  const taken = new Set(matched.map(m => m.id))
  const notes = candidates
    .filter(m => !taken.has(m.id) && (m.type === 'user' || m.type === 'feedback'))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return [...matched, ...notes.slice(0, maxMemories - matched.length)]
}

/**
 * Memory budget after applying the user's manual override. null / <=0 → the
 * context-tier budget unchanged. A positive override sets the injected count,
 * grows the token budget (~150 tok/memory, never below the tier's) so the extra
 * entries actually fit, and allows all types, so the user isn't locked to
 * "32k ctx = 15 memories" (2026-06-07). Exported for unit testing.
 */
export function effectiveMemoryBudget(contextTokens: number, override?: number | null, tokenBudget?: number | null): MemoryBudgetTier {
  const tier = getMemoryBudget(contextTokens)
  const count = override != null && override > 0 ? Math.floor(override) : null
  const tokens = tokenBudget != null && tokenBudget > 0 ? Math.floor(tokenBudget) : null
  if (count === null && tokens === null) return tier
  return {
    ...tier,
    // GH #255: a token budget without a count lets the tokens decide; the
    // count then stops only at the largest number the count field takes.
    maxMemories: count ?? MEMORY_COUNT_MAX,
    budgetTokens: tokens ?? Math.max(tier.budgetTokens, (count ?? 0) * 150),
    typesAllowed: 'all',
  }
}

/** The largest count "Max memories injected" takes. */
export const MEMORY_COUNT_MAX = 100

/** The largest token budget the setting takes, and its share of the window. */
export const MEMORY_TOKEN_BUDGET_MAX = 200_000
export const MEMORY_TOKEN_BUDGET_WINDOW_SHARE = 0.5

/** Characters of one memory in a prompt: the setting's range and default. */
export const MEMORY_CHARS_MIN = 200
export const MEMORY_CHARS_MAX = 20_000
export const MEMORY_CHARS_DEFAULT = 3000

export function memoryCharLimit(setting: unknown): number {
  const n = typeof setting === 'number' && Number.isFinite(setting) ? Math.floor(setting) : MEMORY_CHARS_DEFAULT
  return Math.min(MEMORY_CHARS_MAX, Math.max(MEMORY_CHARS_MIN, n))
}

/**
 * One memory, cut to `maxChars` when it is longer (GH #255).
 *
 * Until 3.1.2 every memory was cut at character 500, mid-sentence and without
 * a mark, so the model answered half a story day as if it were the whole. The
 * cut now falls on the end of a sentence in the last third before the limit
 * (Japanese and Chinese stops count), else on a space, and the line says that
 * it was cut and how much is missing.
 */
export function fitMemoryText(text: string, maxChars: number): { text: string; cut: boolean } {
  const chars = [...text]
  if (chars.length <= maxChars) return { text, cut: false }
  const head = chars.slice(0, maxChars).join('')
  const floor = Math.floor(head.length * 0.66)
  let end = -1
  for (const m of head.matchAll(/[.!?。！？](?=\s|$|[^.!?。！？])|\n/g)) {
    if (m.index !== undefined && m.index >= floor) end = m.index + 1
  }
  if (end < 0) {
    const space = head.lastIndexOf(' ')
    end = space >= floor ? space : head.length
  }
  const kept = head.slice(0, end).trimEnd()
  return { text: `${kept} [cut: ${[...kept].length} of ${chars.length} characters]`, cut: true }
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
    // The length limit is not here any more: fitMemoryText cuts at the
    // user's setting and marks the cut (GH #255).
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
 * model, and that block rides along in EVERY request of EVERY turn, it is
 * paid for again on each step of an agent run, forever, whether or not a
 * single memory was relevant. 1k is the ceiling; a block that already fits
 * under it is injected in full and unchanged, so the cap only ever bites the
 * oversized case.
 */
export const MEMORY_CONTEXT_TOKEN_CAP = 1000

/**
 * GH #238 (A28): with "Max memories injected" set, the user asked for more
 * memory than the 1k ceiling holds. The override then lifts the ceiling, but
 * never past this share of the model's context window, so a small model keeps
 * the 1k (10 percent of 8K is under it) and a 256K model may carry the
 * override's full budget (100 memories x 150 tokens = 15K, under its 26K).
 */
export const MEMORY_OVERRIDE_CONTEXT_SHARE = 0.1

/** The ceiling of the memory block for this window and override. Without an
 *  override it is MEMORY_CONTEXT_TOKEN_CAP, as before. */
export function memoryContextCeiling(contextTokens: number, override?: number | null, tokenBudget?: number | null): number {
  // GH #255: a token budget the user set is the ceiling itself, up to half of
  // the window (the rest must hold the chat). Unknown window: the budget.
  if (tokenBudget != null && tokenBudget > 0) {
    const wanted = Math.min(Math.floor(tokenBudget), MEMORY_TOKEN_BUDGET_MAX)
    const half = Number.isFinite(contextTokens) && contextTokens > 0 ? Math.floor(contextTokens * MEMORY_TOKEN_BUDGET_WINDOW_SHARE) : wanted
    return Math.max(1, Math.min(wanted, half))
  }
  if (override == null || !(override > 0)) return MEMORY_CONTEXT_TOKEN_CAP
  const share = Number.isFinite(contextTokens) && contextTokens > 0 ? Math.floor(contextTokens * MEMORY_OVERRIDE_CONTEXT_SHARE) : 0
  return Math.max(MEMORY_CONTEXT_TOKEN_CAP, share)
}

/**
 * Render an ALREADY-ORDERED, ALREADY-FILTERED list of memories into the
 * grouped <remembered_context> block, respecting the tier's char budget and
 * sanitizing every injected line. Shared by the sync (keyword) and async
 * (embedding-blended) retrieval paths, ONLY the candidate ordering differs
 * between them, so the output formatting lives here once.
 *
 * The A7 cap is applied HERE, at the one place the string is built, so every
 * injection site (useChat, useAgentChat, useCodex, the remote dispatcher)
 * inherits it and none of them can drift.
 */
export interface MemoryContext {
  text: string
  memoryIds: string[]
  /** Absent for the local collection. Captured together with selected IDs. */
  owner?: string
}

/** What renderMemoryContext also works out, for the report (GH #255). */
export interface RenderedMemoryContext extends MemoryContext {
  /** In `ordered` but over the token budget. */
  leftOut: string[]
  /** Sent, but cut at the per-memory limit. */
  shortened: string[]
  tokens: number
  budget: number
}

/** Estimated tokens of a text, with the same density the budget uses. */
function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / charsPerToken(text)) : 0
}

export function renderMemoryContext(ordered: MemoryFile[], budgetTokens: number, ceilingTokens: number = MEMORY_CONTEXT_TOKEN_CAP, maxChars: number = MEMORY_CHARS_DEFAULT): RenderedMemoryContext {
  const cappedTokens = Math.min(budgetTokens, ceilingTokens)
  if (ordered.length === 0) return { text: '', memoryIds: [], leftOut: [], shortened: [], tokens: 0, budget: cappedTokens }

  // Group by type for structured output (preserve incoming order within type).
  const grouped: Record<MemoryType, MemoryFile[]> = {
    user: [], feedback: [], project: [], reference: [],
  }
  for (const entry of ordered) grouped[entry.type].push(entry)

  // GH #167: the cap is in tokens. A flat 4 characters per token let a
  // Japanese memory block run to about 2.8 times its budget; the script aware
  // density keeps it at the budget, and pure ASCII still reads 4.
  const overBudget = (text: string) => text.length > cappedTokens * charsPerToken(text)
  let result = ''
  const memoryIds: string[] = []
  const shortened: string[] = []

  for (const type of TYPE_ORDER) {
    const items = grouped[type]
    if (items.length === 0) continue

    const header = `### ${TYPE_SECTION_HEADERS[type]}\n`
    if (overBudget(result + header)) break
    let section = header

    for (const item of items) {
      const clean = sanitizeForInjection(item.content)
      const lineOf = (fit: { text: string }) => `- ${item.title}: ${fit.text.replace(/\n/g, ' ')}\n`
      let fitted = fitMemoryText(clean, maxChars)
      let line = lineOf(fitted)
      if (overBudget(result + section + line)) {
        // The rest of the budget holds part of it: that part goes, cut at a
        // sentence and marked, rather than nothing.
        const before = result + section
        const room = Math.floor(cappedTokens * charsPerToken(before + line)) - before.length - item.title.length - 48
        if (room >= MEMORY_CHARS_MIN) {
          fitted = fitMemoryText(clean, Math.min(maxChars, room))
          line = lineOf(fitted)
        }
      }
      // A memory that does not fit is left out and named in the report; a
      // shorter one behind it may still fit (GH #255: the budget used to stop
      // at the first one that did not, without a word).
      if (overBudget(result + section + line)) continue
      section += line
      memoryIds.push(item.id)
      if (fitted.cut) shortened.push(item.id)
    }
    if (section !== header) result += `${section}\n`
  }

  const sent = new Set(memoryIds)
  const leftOut = ordered.filter(m => !sent.has(m.id)).map(m => m.id)
  if (memoryIds.length === 0) return { text: '', memoryIds: [], leftOut, shortened: [], tokens: 0, budget: cappedTokens }
  const text = `<remembered_context>\n${result.trim()}\n</remembered_context>`
  return { text, memoryIds, leftOut, shortened, tokens: estimateTokens(text), budget: cappedTokens }
}

// ── Store Interface ───────────────────────────────────────────

/**
 * What one delete took away, enough to put it back (A27: every delete in the
 * Memory panel and in Settings offers Undo). `positions` are the indexes the
 * entries had, so Undo restores the order the user saw. `revision` ties the
 * removal to the collection it came from: after a switch of account the undo
 * would otherwise write one account's memories into another's.
 */
export interface MemoryRemoval {
  entries: MemoryFile[]
  positions: number[]
  revision: number
  owner: string | null
}

interface MemoryState {
  entries: MemoryFile[]
  localEntries: MemoryFile[]
  accountCollections: Record<string, MemoryFile[]>
  memorySyncBaselines: Record<string, Record<string, MemorySyncBaseline>>
  memorySyncPending: Record<string, Record<string, MemorySyncBaseline>>
  activeMemoryOwner: string | null
  memoryCollectionRevision: number
  selectMemoryCollection: (owner: string | null) => boolean
  settings: MemorySettings
  lastSynced: number
  /** Marks of deleted memories, see lib/memory-forget.ts. Hashes, never text. */
  forgotten: ForgottenMemory[]
  /**
   * Memories pinned "always send" (GH #255). Ids, kept apart from the records
   * so the cloud sync format stays as it is; an id of a deleted memory is
   * dropped with it.
   */
  pinnedMemoryIds: string[]
  setMemoryPinned: (id: string, pinned: boolean) => void
  /** What the last request of each chat carried, this session only (GH #255). */
  lastInjection: Record<string, MemoryInjectionReport>

  // CRUD
  /** `auto`: the writer is the extractor, not the user, so a deleted fact is refused. */
  addMemory: (memory: Omit<MemoryFile, 'id' | 'createdAt' | 'updatedAt'>, opts?: { auto?: boolean }) => string
  updateMemory: (id: string, updates: Partial<Pick<MemoryFile, 'title' | 'description' | 'content' | 'type' | 'tags' | 'sensitive' | 'scope'>>) => void
  removeMemory: (id: string) => MemoryRemoval | null
  /** Removes every listed id in one write. Null when none of them was there. */
  removeMemories: (ids: readonly string[]) => MemoryRemoval | null
  /** Undo of a removal. False when the collection changed in between (other account). */
  restoreMemories: (removal: MemoryRemoval) => boolean
  confirmMemory: (id: string) => void
  clearAll: () => MemoryRemoval | null

  // Search & Inject
  searchMemories: (query: string, options?: { type?: MemoryType; limit?: number }) => MemoryFile[]
  getMemoriesForPrompt: (query: string, contextTokens: number, opts?: MemoryInjectOpts) => string
  /** Embedding-first retrieval; falls back to getMemoriesForPrompt on any error. */
  getMemoriesForPromptAsync: (query: string, contextTokens: number, opts?: MemoryInjectOpts) => Promise<string>
  getMemoryContextAsync: (query: string, contextTokens: number, opts?: MemoryInjectOpts) => Promise<MemoryContext>

  // Write-decision + embedding maintenance (Feature FF)
  applyWriteDecision: (decision: ResolutionDecision, ctx?: { newId?: string }) => void
  ensureMemoryEmbeddings: (batchSize?: number) => Promise<number>

  // Settings
  updateMemorySettings: (updates: Partial<MemorySettings>) => void

  // Export / Import: importers report what they did with every usable entry
  // of the file so the UI can give feedback (a user-session 2026-06-07: silent
  // 0-import; box test T5 2026-09-11: re-import doubled the collection).
  exportAsMarkdown: () => string
  importFromMarkdown: (markdown: string) => MemoryImportResult
  exportAsJSON: () => string
  importFromJSON: (json: string) => MemoryImportResult

  // Legacy compat (used by old code paths during transition)
  addEntry: (category: MemoryCategory, content: string, source?: string) => void
}

// ── Migration from v1 (old MemoryEntry[]) to v2 (MemoryFile[]) ──
//
// WHY EVERY FIELD IS CHECKED HERE. A migration reads data an OLDER build of
// this app wrote, and zustand gives it no second chance: a migrate that throws
// lands in persist's `.catch`, hydration is abandoned, the store keeps its
// empty default, and the next write persists that empty list back over the
// stored blob. One entry the migration cannot read would take every memory
// with it, permanently. So each entry is checked on its own and a broken one
// is dropped alone.

/** The v1 fields a MemoryEntry must have to be worth carrying forward. */
function asLegacyEntry(v: unknown): { id: string; category: string; content: string; timestamp: number; source?: string } | null {
  if (!isRecord(v)) return null
  const content = asString(v.content)
  if (!content) return null
  return {
    id: asString(v.id) ?? uuid(),
    category: asString(v.category) ?? '',
    content,
    timestamp: asNumber(v.timestamp) ?? Date.now(),
    source: asString(v.source),
  }
}

function migrateV1toV2(oldState: unknown): unknown {
  if (!isRecord(oldState) || !Array.isArray(oldState.entries)) return oldState

  // Check if already migrated (MemoryFile has 'type' field). Sampling the
  // first entry is the original test; `in` on a non-object used to throw.
  const first: unknown = oldState.entries[0]
  if (oldState.entries.length > 0 && isRecord(first) && 'type' in first) {
    return oldState
  }

  // Migrate old MemoryEntry[] to MemoryFile[]
  const migratedEntries: MemoryFile[] = []
  for (const raw of oldState.entries) {
    const e = asLegacyEntry(raw)
    if (!e) continue
    migratedEntries.push({
      id: e.id,
      type: MEMORY_MIGRATION_MAP[e.category as MemoryCategory] || 'project',
      title: e.content.substring(0, 60).replace(/\n/g, ' '),
      description: e.content.substring(0, 120).replace(/\n/g, ' '),
      content: e.content,
      tags: e.source ? [e.source] : [],
      createdAt: e.timestamp,
      updatedAt: e.timestamp,
      source: e.source || 'migration',
    })
  }

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
// validFrom). Existing entries are already valid without them, this
// migration is intentionally a near-identity that just guarantees the
// `stale` flag is a concrete boolean (false) on every entry, so retrieval's
// `isStale` and the "Show outdated" filter behave deterministically on
// freshly-rehydrated old stores. All other new fields stay undefined.
//
// This is the migration EVERY 2.5.x user runs, so the check above matters
// most here: `e.stale` on a non-object entry threw, and the throw cost the
// whole store.
function migrateV2toV3(oldState: unknown): unknown {
  if (!isRecord(oldState) || !Array.isArray(oldState.entries)) return oldState
  const entries: MemoryFile[] = []
  for (const raw of oldState.entries) {
    const e = asMemoryFile(raw)
    if (e) entries.push(e)
  }
  return { ...oldState, entries }
}

/**
 * A persisted MemoryFile, rebuilt from checked fields. The four required
 * strings and the two timestamps decide whether an entry is usable at all;
 * the optional staleness fields are carried over when they have the right
 * type and dropped when they do not.
 */
function asMemoryFile(v: unknown): MemoryFile | null {
  if (!isRecord(v)) return null
  if (v.scope !== undefined && (typeof v.scope !== 'string' || !v.scope.trim())) return null
  const content = asString(v.content)
  if (!content) return null
  const now = Date.now()
  const type = MEMORY_TYPES.find((t) => t === v.type) ?? 'project'
  return {
    id: asString(v.id) ?? uuid(),
    type,
    title: asString(v.title) ?? content.substring(0, 60).replace(/\n/g, ' '),
    description: asString(v.description) ?? content.substring(0, 120).replace(/\n/g, ' '),
    content,
    tags: asStringArray(v.tags),
    createdAt: asNumber(v.createdAt) ?? now,
    updatedAt: asNumber(v.updatedAt) ?? asNumber(v.createdAt) ?? now,
    source: asString(v.source) ?? 'migration',
    sourceKind: v.sourceKind === 'chat' || v.sourceKind === 'voice' || v.sourceKind === 'screen' ? v.sourceKind : undefined,
    confirmedAt: typeof v.confirmedAt === 'number' && Number.isFinite(v.confirmedAt) && v.confirmedAt > 0 && v.confirmedAt <= now ? v.confirmedAt : undefined,
    sensitive: v.sensitive === true,
    scope: asString(v.scope),
    supersededBy: asString(v.supersededBy),
    supersedesId: asString(v.supersedesId),
    stale: v.stale === true,
    validFrom: asNumber(v.validFrom),
  }
}

const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference']

/** Local account collections retain valid local records, including records
 * larger than the cloud protocol permits. Upload validation is separate. */
function readAccountMemory(raw: unknown): MemoryFile {
  const invalid = () => new Error('Could not open this memory collection')
  if (!isRecord(raw) || !['id', 'title', 'description', 'content', 'source'].every(key => typeof raw[key] === 'string') ||
    !raw.id || !(raw.content as string).trim() || !MEMORY_TYPES.some(type => type === raw.type) ||
    !Array.isArray(raw.tags) || !raw.tags.every(tag => typeof tag === 'string') ||
    !['createdAt', 'updatedAt'].every(key => typeof raw[key] === 'number' && Number.isFinite(raw[key]))) throw invalid()
  for (const key of ['sensitive', 'stale']) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw invalid()
  for (const key of ['scope', 'supersededBy', 'supersedesId']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].trim())) throw invalid()
  }
  for (const key of ['confirmedAt', 'validFrom']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]))) throw invalid()
  }
  if (raw.sourceKind !== undefined && !['chat', 'voice', 'screen'].some(kind => kind === raw.sourceKind)) throw invalid()
  return { ...raw, tags: [...raw.tags] } as unknown as MemoryFile
}

/**
 * The persist `migrate` hook. Exported so a test can drive it directly, the
 * persist internals are not reachable from vitest (same reason
 * migratePermissionState is exported).
 */
export function migrateMemoryState(persistedState: unknown, version: number): MemoryState {
  let state: unknown = persistedState
  if (version < 2) {
    state = migrateV1toV2(state)
  }
  if (version < 3) {
    state = migrateV2toV3(state)
  }
  // zustand types migrate as returning the FULL store, but a blob only ever
  // carries the partialized slice and `merge` puts the actions back. The cast
  // claims exactly what went in, nothing about the actions.
  return state as MemoryState
}

/**
 * One line of the markdown export, taken apart again.
 *
 * WHY THIS IS A NAMED CONSTANT WITH A STORY. Until 2026-07-25 the export wrote
 * the title, a long dash, then the content, and this expression required that
 * dash. The dash sweep (01a352bf) changed the EXPORT to a comma and left the
 * expression alone, so from 2.5.9 on the app could no longer read its own
 * export: the title came back as `**Title**, content ...` and tags, source and
 * date were dropped on the floor. Nobody noticed, because the only test fed the
 * OLD format in by hand.
 *
 * The separator is therefore a comma OR one of the two old dashes, and those
 * two are written as code points on purpose: the house rule bans the characters
 * themselves from this tree, and a character class is no exception.
 *
 * R5-23 (3.0.1): the web app writes a different pair of
 * separators again (`**title**: content ... *(source)* · date`, a colon and a
 * middle dot, plus the same two dashes as an accepted read variant). A memory
 * exported by one app and imported into the other silently dropped tags,
 * source and date exactly the way the 2.5.9 regression above did, just with a
 * different separator pair. Desktop's own EXPORT keeps writing comma and the
 * `isoTag` date format (that half of R5-23 is Desktop's to set), but the READ
 * side now accepts every separator either app has ever written, so a file
 * that crossed apps is never the one that gets silently truncated.
 *
 * The trailing date is only stripped when it follows the `*(source)*` group. A
 * bare `content, with a comma` keeps its comma, because there is no source to
 * anchor a date to.
 *
 * WHY THE TAG GROUP SITS INSIDE THE SOURCE GROUP. It used to hang free right
 * behind the lazy content, so any line that merely ENDED in a bracket group lost
 * it: `- Start the app with [debug]` came back as the content `Start the app
 * with` plus a tag `debug` nobody ever set. The bracket group is now only read
 * when the `*(source)*` group follows it, which is the only shape this app's own
 * export writes. A bracket at the end of a bare line stays part of the content.
 *
 * The remaining ambiguity is a content that ends in a bracket group AND carries a
 * source. `exportAsMarkdown` resolves it from the writing side: when there are no
 * tags and the content ends in `]`, it writes an empty group `[]`, so the tag
 * slot is always occupied and the content keeps its own bracket. That is why the
 * group accepts an EMPTY body.
 */
const MD_ITEM =
  /^-\s+(?:\*\*(.+?)\*\*\s*(?:,|:|[\u2013\u2014])\s*)?(.+?)(?:(?:\s+\[([^\]]*)\])?\s+\*\(([^)]+)\)\*(?:\s*(?:,|\u00b7|[\u2013\u2014])\s*(.+?))?)?$/

/**
 * R2-25 (Logikkontrolle, 3.0.1): a multi-line memory (several paragraphs, a
 * pasted snippet with its own line breaks) went into `exportAsMarkdown` as
 * literal newline CHARACTERS inside `entry.content`. Written straight into
 * the file, that turned ONE list item into several physical lines: the first
 * kept the `- **Title**,` prefix, the middle ones had no `- ` prefix at all,
 * and the LAST one carried `*(source)*, date` but no leading dash. `importFromMarkdown`
 * scans line by line with `MD_ITEM`'s `^...$` anchors, so only the first line
 * matched anything, the rest of the content, the source and the date were
 * silently dropped, not just truncated.
 *
 * The fix keeps every memory to exactly one physical line in the export,
 * which is what the whole per-line importer assumes. A real line break in the
 * content becomes the two-character escape `\n`; a literal backslash the
 * content already contained is doubled first so it can never be misread as
 * the start of that escape. `unescapeMdContent` reverses both in one pass.
 *
 * Opus-Review Nachbesserung 5 (3.0.1): `\n` alone was not the whole data-loss
 * class. `.` in a JS regex without the `s` flag never matches a LINE
 * TERMINATOR, and the spec's line terminator set is four characters, not one:
 * `\n`, `\r`, U+2028 (LINE SEPARATOR), U+2029 (PARAGRAPH SEPARATOR). A
 * Windows/browser/PDF paste routinely carries CRLF, and MD_ITEM's `(.+?)`
 * groups silently refuse to match any of the other three exactly the way
 * they refused `\n` before this file's first fix \u2014 the whole entry, title,
 * source and date included, vanished on import with no error. All four are
 * escaped now, the same one-pass, backslash-doubled-first scheme as before.
 */
function escapeMdContent(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

const MD_ESCAPE = /\\\\|\\r|\\n|\\u2028|\\u2029/g
const MD_ESCAPE_BACK: Record<string, string> = {
  '\\\\': '\\', '\\r': '\r', '\\n': '\n', '\\u2028': '\u2028', '\\u2029': '\u2029',
}

function unescapeMdContent(s: string): string {
  return s.replace(MD_ESCAPE, (m) => MD_ESCAPE_BACK[m])
}

/**
 * Opus-Review Nachbesserung 5, second half: backward compatibility.
 *
 * Before this file's first R2-25 fix, an export with a LITERAL two-character
 * `\n` already in the content (a Windows path like `C:\nope`, a code snippet
 * with `print("a\nb")`) went out unescaped \u2014 because nothing escaped
 * anything yet. Running today's `unescapeMdContent` over such an OLD file
 * would silently rewrite that literal `\n` into a real line break: not data
 * loss, but a silent mutation of a file nobody asked to have rewritten.
 *
 * The marker below is written by every export from this fix onward and read
 * by every import: present means "this file's `\n`/`\r`/backslash sequences
 * are `escapeMdContent`'s doing, undo them", absent means "leave every
 * character exactly as written, this predates escaping".
 */
const MD_FORMAT_MARKER = '<!-- lu-memory-format: 2 -->'
const MD_FORMAT_MARKER_RE = /<!--\s*lu-memory-format:\s*2\s*-->/

/**
 * The date the export writes: `YYYY-MM-DD`, not a locale string.
 *
 * `toLocaleDateString()` produced `9/5/2026` on one machine and `05.09.2026` on
 * the next, and neither is readable back, so an exported memory always came
 * home stamped with today. Falls back to today when the entry carries a broken
 * timestamp, because an export must not throw.
 */
function isoTag(ms: number): string {
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10)
}

/**
 * The way back. STRICT on purpose: only `YYYY-MM-DD` is read, never a locale
 * string. `9/5/2026` is the ninth of May in one place and the fifth of
 * September in another, and a memory dated a wrong day is worse than one dated
 * today.
 */
function isoBack(tag: string | undefined): number | null {
  const m = tag?.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)
  return Number.isNaN(ms) ? null : ms
}


// ── Selection helpers (GH #255) ───────────────────────────────

/** Off app wide (Settings > Memory) or for this chat. */
function injectionOff(settings: MemorySettings, opts?: MemoryInjectOpts): 'all' | 'chat' | undefined {
  if (settings.injectEnabled === false) return 'all'
  if (opts?.chatOff) return 'chat'
  return undefined
}

/** Memories this request may carry at all. An entry that only says something
 *  is unknown would outvote the real fact next to it (memory-gap.ts, AG10). */
function eligibleMemories(entries: MemoryFile[], opts?: MemoryInjectOpts): MemoryFile[] {
  const out = entries.filter(e => !e.sensitive && !isStale(e) && !onlyStatesAGap(e) && memoryMatchesScope(e, opts?.scope))
  return opts?.excludeToolResults ? out.filter(e => !isToolResultMemory(e)) : out
}

/** The pinned ones among them, newest first. They go into every request
 *  before anything the search picked, and do not count against the count. */
function pinnedOf(eligible: MemoryFile[], ids: readonly string[]): MemoryFile[] {
  if (ids.length === 0) return []
  const pinned = new Set(ids)
  return eligible.filter(e => pinned.has(e.id)).sort((a, b) => b.updatedAt - a.updatedAt)
}

function recordInjection(opts: MemoryInjectOpts | undefined, report: MemoryInjectionReport): void {
  const id = opts?.conversationId
  if (!id) return
  useMemoryStore.setState(state => ({ lastInjection: { ...state.lastInjection, [id]: report } }))
}

function reportNothing(opts: MemoryInjectOpts | undefined, off?: 'all' | 'chat'): string {
  recordInjection(opts, { at: Date.now(), text: '', sent: [], leftOut: [], shortened: [], eligible: 0, tokens: 0, budget: 0, ...(off ? { off } : {}) })
  return ''
}

/** Render, tell the caller and the report, return the block. Both retrieval
 *  paths end here, so the brain icon always shows what was really sent. */
function deliverMemories(input: {
  ordered: MemoryFile[]
  overCount: MemoryFile[]
  eligible: number
  budget: MemoryBudgetTier
  contextTokens: number
  opts?: MemoryInjectOpts
}): string {
  const { settings } = useMemoryStore.getState()
  const ceiling = memoryContextCeiling(input.contextTokens, settings.maxMemoriesOverride, settings.memoryTokenBudget)
  const context = renderMemoryContext(input.ordered, input.budget.budgetTokens, ceiling, memoryCharLimit(settings.maxMemoryChars))
  input.opts?.onInjected?.(context.memoryIds)
  recordInjection(input.opts, {
    at: Date.now(), text: context.text, sent: context.memoryIds,
    leftOut: [...context.leftOut, ...input.overCount.map(m => m.id)],
    shortened: context.shortened, eligible: input.eligible, tokens: context.tokens, budget: context.budget,
  })
  return context.text
}

// ── Store ─────────────────────────────────────────────────────

export const useMemoryStore = create<MemoryState>()(
  persist(
    (set, get) => ({
      entries: [],
      localEntries: [],
      accountCollections: {},
      memorySyncBaselines: {},
      memorySyncPending: {},
      activeMemoryOwner: null,
      memoryCollectionRevision: 0,
      selectMemoryCollection: (owner) => {
        if (!useMemoryStore.persist.hasHydrated()) return false
        const state = get()
        const auth = useCloudAuthStore.getState()
        if (owner !== null && (auth.status !== 'signed-in' || auth.user?.id !== owner)) return false
        if (owner === state.activeMemoryOwner) return true
        const collections = { ...state.accountCollections }
        if (state.activeMemoryOwner !== null) collections[state.activeMemoryOwner] = state.entries
        const local = state.activeMemoryOwner === null ? state.entries : state.localEntries
        let entries = local
        if (owner !== null) {
          const stored: unknown = Object.hasOwn(collections, owner) ? collections[owner] : []
          // Preserve unreadable collections unchanged rather than hydrating
          // them as empty and later overwriting their data.
          if (!Array.isArray(stored)) return false
          try { entries = stored.map(readAccountMemory) } catch { return false }
          if (new Set(entries.map(entry => entry.id)).size !== entries.length) return false
        }
        set({ entries, localEntries: local, accountCollections: collections,
          activeMemoryOwner: owner, memoryCollectionRevision: state.memoryCollectionRevision + 1 })
        return true
      },
      settings: {
        autoExtractEnabled: true,
        autoExtractInAllModes: true,
        maxMemoriesInPrompt: 10,
        maxMemoryChars: 3000,
      },
      lastSynced: 0,
      forgotten: [],
      pinnedMemoryIds: [],
      lastInjection: {},
      setMemoryPinned: (id, pinned) => set((state) => {
        const has = state.pinnedMemoryIds.includes(id)
        if (pinned === has || (pinned && !state.entries.some(e => e.id === id))) return {}
        return { pinnedMemoryIds: pinned ? [...state.pinnedMemoryIds, id] : state.pinnedMemoryIds.filter(p => p !== id) }
      }),

      // ── CRUD ────────────────────────────────────────────────

      addMemory: (memory, opts) => {
        if (memory.scope !== undefined && !memory.scope.trim()) return ''
        const trimmedContent = memory.content.trim()
        if (!trimmedContent) return ''
        // A27: the user deleted this fact; the extractor does not get to write
        // it back. A hand-written or imported one lifts the mark below.
        if (opts?.auto && isForgotten(get().forgotten, { title: memory.title, content: trimmedContent })) return ''

        // Deduplicate: don't add if the same memory is already in the collection.
        //
        // The three extra conditions are the web's (R5-32), and each one is a
        // record the user can no longer reach: an outdated twin, one that a
        // newer record superseded, and one that is marked sensitive while this
        // one is not (or the other way round, which is a different record to
        // the app). Without them the form refused an entry against a twin the
        // collection no longer shows, and the caller reads the empty id, so the
        // user gets told why instead of watching the input vanish.
        const candidate = { content: trimmedContent, type: memory.type, scope: memory.scope }
        if (get().entries.some(e => isSameMemory(e, candidate) &&
          (e.sensitive === true) === (memory.sensitive === true) &&
          !e.stale && !e.supersededBy)) return ''

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
          ...(opts?.auto || state.forgotten.length === 0 ? {}
            : { forgotten: liftForgotten(state.forgotten, { title: memory.title, content: trimmedContent }) }),
        }))
        // Embed in the background, never blocks the synchronous add.
        void enqueueEmbedding({ id, title: memory.title, content: trimmedContent })
        return id
      },

      updateMemory: (id, updates) => {
        if (updates.scope !== undefined && !updates.scope.trim()) return
        set((state) => ({
          entries: state.entries.map((e) =>
            e.id === id ? { ...e, ...updates, updatedAt: Date.now(),
              confirmedAt: Object.keys(updates).some(key => key !== 'sensitive' && Reflect.get(e, key) !== Reflect.get(updates, key)) ? undefined : e.confirmedAt,
            } : e
          ),
          lastSynced: Date.now(),
        }))
        if (updates.sensitive === true) void deleteVector(id)
        // Re-embed when title/content changed (hashContent skips a no-op).
        if (updates.title !== undefined || updates.content !== undefined) {
          const updated = get().entries.find((e) => e.id === id)
          if (updated) void enqueueEmbedding({ id, title: updated.title, content: updated.content })
        }
      },

      confirmMemory: (id) => {
        const now = Date.now()
        set(state => ({ entries: state.entries.map(entry => entry.id === id && !isStale(entry)
          ? { ...entry, confirmedAt: now, updatedAt: now } : entry), lastSynced: now }))
      },

      removeMemory: (id) => get().removeMemories([id]),

      removeMemories: (ids) => {
        const wanted = new Set(ids)
        const state = get()
        const entries: MemoryFile[] = []
        const positions: number[] = []
        state.entries.forEach((entry, index) => {
          if (wanted.has(entry.id)) { entries.push(entry); positions.push(index) }
        })
        if (entries.length === 0) return null
        const now = Date.now()
        set({
          entries: state.entries.filter((e) => !wanted.has(e.id)),
          forgotten: withForgotten(state.forgotten, entries.map(e => forgetMark(e, now))),
          lastSynced: now,
          ...(state.pinnedMemoryIds.some(id => wanted.has(id)) ? { pinnedMemoryIds: state.pinnedMemoryIds.filter(id => !wanted.has(id)) } : {}),
        })
        if (entries.length === state.entries.length) void clearAllVectors()
        else for (const entry of entries) void deleteVector(entry.id)
        return { entries, positions, revision: state.memoryCollectionRevision, owner: state.activeMemoryOwner }
      },

      restoreMemories: (removal) => {
        const state = get()
        if (state.memoryCollectionRevision !== removal.revision || state.activeMemoryOwner !== removal.owner) return false
        const present = new Set(state.entries.map(e => e.id))
        const back = removal.entries.map((entry, i) => ({ entry, at: removal.positions[i] ?? Number.MAX_SAFE_INTEGER }))
          .filter(({ entry }) => !present.has(entry.id))
        if (back.length === 0) return true
        // Ascending positions: each one is the index the entry had in the list
        // that still contained the ones before it, so inserting in this order
        // rebuilds the old list exactly when nothing else changed meanwhile.
        const entries = [...state.entries]
        for (const { entry, at } of back.sort((a, b) => a.at - b.at)) entries.splice(Math.min(at, entries.length), 0, entry)
        let forgotten = state.forgotten
        for (const { entry } of back) forgotten = liftForgotten(forgotten, entry)
        set({ entries, forgotten, lastSynced: Date.now() })
        // The vectors went with the delete; sensitive entries never had one.
        for (const { entry } of back) if (!entry.sensitive) void enqueueEmbedding(entry)
        return true
      },

      clearAll: () => get().removeMemories(get().entries.map(e => e.id)),

      // ── Search ──────────────────────────────────────────────

      searchMemories: (query, options) => {
        // GH #255: pairs of characters for Japanese, Chinese and Korean.
        const words = searchTerms(query)
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

        // R2-39: `|| 20` turned an explicit limit of 0 into 20, since 0 is
        // falsy. `??` only falls back when the caller left it unset.
        const limit = options?.limit ?? 20
        return scored.slice(0, limit).map(({ entry }) => entry)
      },

      // ── Context-Aware Prompt Injection ──────────────────────

      // ── Context-Aware Prompt Injection (sync, keyword) ──────
      //
      // This is the OFFLINE-SAFE fallback path. It never touches Ollama or
      // IndexedDB. getMemoriesForPromptAsync below layers embedding-blended
      // ordering on top and degrades to exactly this output on any error.
      getMemoriesForPrompt: (query, contextTokens, opts) => {
        const { settings } = get()
        const budget = effectiveMemoryBudget(contextTokens, settings.maxMemoriesOverride, settings.memoryTokenBudget)
        const off = injectionOff(settings, opts)
        if (off) return reportNothing(opts, off)

        // No budget for tiny models
        if (budget.budgetTokens === 0 || budget.maxMemories === 0) return reportNothing(opts)

        // A phone has only this path, so its words are taken without the
        // punctuation ("drink?" must find "drink"). The desktop keeps its
        // split, except for a question in Japanese, Chinese or Korean, which
        // has no spaces to split at (GH #255).
        const words = singleModelSlot() ? queryWords(query)
          : hasCjkQuery(query) ? searchTerms(query)
          : query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
        const eligible = eligibleMemories(get().entries, opts)
        const pinned = pinnedOf(eligible, get().pinnedMemoryIds)
        let candidates = eligible.filter(e => !pinned.includes(e))

        // Filter by allowed types for this tier
        if (budget.typesAllowed !== 'all') {
          candidates = candidates.filter(e => (budget.typesAllowed as MemoryType[]).includes(e.type))
        }

        // Score and sort (keyword).
        //
        // R2-26: bei LEERER Anfrage gibt `scoreMemory` jeder Erinnerung die 1,
        // und der Frischebonus haengt an mindestens einem Worttreffer, greift
        // hier also nicht. Die Sortierung ist stabil, also gewann die
        // Einfuegereihenfolge und der Anrufer bekam die AELTESTEN Eintraege.
        // Genau so ruft die Remote-Bruecke an (`remoteStore`,
        // `getMemoriesForPromptAsync('', 8192)`), und das Handy bekam damit
        // dauerhaft den aeltesten Stand. Ohne Anfrage gibt es keine Abdeckung,
        // die entscheiden koennte, also entscheidet die Frische.
        const matched = candidates
          .map((entry) => ({ entry, score: scoreMemory(entry, words) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => (words.length === 0 ? b.entry.updatedAt - a.entry.updatedAt : b.score - a.score))
          .map(({ entry }) => entry)
        const ordered = matched.slice(0, budget.maxMemories)

        return deliverMemories({
          ordered: [...pinned, ...fillWithUserNotes(ordered, candidates, budget.maxMemories)],
          overCount: matched.slice(budget.maxMemories),
          eligible: eligible.length,
          budget, contextTokens, opts,
        })
      },

      // ── Context-Aware Prompt Injection (async, embedding-first) ──
      //
      // Embed the query, hydrate candidate vectors from IndexedDB, blend-score
      // (semantic + keyword + recency + type boost), then reuse the EXACT same
      // budget tiers / type filter / sanitization / grouped output as the sync
      // path, only the candidate ORDERING changes. Wrapped so ANY failure
      // (Ollama unreachable, nomic missing, IDB absent, dim mismatch) falls
      // back to the keyword result. Offline correctness invariant: this never
      // returns empty/incorrect when the sync path would have returned text.
      getMemoryContextAsync: async (query, contextTokens, opts) => {
        const collectionRevision = get().memoryCollectionRevision
        const owner = get().activeMemoryOwner
        let memoryIds: string[] = []
        const text = await get().getMemoriesForPromptAsync(query, contextTokens, {
          ...opts, onInjected: ids => { memoryIds = [...ids] },
        })
        return get().memoryCollectionRevision === collectionRevision
          ? { text, memoryIds, ...(owner === null ? {} : { owner }) } : { text: '', memoryIds: [] }
      },

      getMemoriesForPromptAsync: async (query, contextTokens, opts) => {
        const requestOpts = opts ? { ...opts } : undefined
        const collectionRevision = get().memoryCollectionRevision
        const fallback = () => get().memoryCollectionRevision === collectionRevision
          ? get().getMemoriesForPrompt(query, contextTokens, requestOpts) : ''
        const snapshot = get().entries
        try {
          const budget = effectiveMemoryBudget(contextTokens, get().settings.maxMemoriesOverride, get().settings.memoryTokenBudget)
          // No-op cases (no budget, no candidates, empty query) must return
          // EXACTLY what the sync keyword path would, defer to fallback()
          // rather than re-deriving '' so behaviour stays identical (and so a
          // stubbed sync method in tests is honoured).
          if (budget.budgetTokens === 0 || budget.maxMemories === 0) return fallback()
          if (injectionOff(get().settings, requestOpts)) return fallback()

          const eligible = eligibleMemories(get().entries, requestOpts)
          const pinned = pinnedOf(eligible, get().pinnedMemoryIds)
          let candidates = eligible.filter(e => !pinned.includes(e))
          if (budget.typesAllowed !== 'all') {
            candidates = candidates.filter(e => (budget.typesAllowed as MemoryType[]).includes(e.type))
          }
          if (candidates.length === 0) return fallback()

          // Embed the query. Empty query has nothing to embed → no semantic
          // signal → keyword path is strictly better (it filters by score).
          if (!query.trim()) return fallback()
          // One model slot: embedding the question would load the embedder
          // right before the chat request that needs the room. The keyword
          // path carries memory on its own there.
          if (singleModelSlot()) return fallback()
          let queryVec: number[] = []
          const [vec] = await _embedFn([query])
          if (vec && vec.length > 0) queryVec = vec

          // No usable query vector → fall back to keyword.
          if (queryVec.length === 0) return fallback()

          // Hydrate candidate vectors into a hot Map. dim-mismatched vectors
          // are dropped here (scorer also guards) → treated as keyword-only.
          const vecMap = await loadVectors(candidates.map(c => c.id))
          // Do not inject a deleted, edited or superseded snapshot after
          // asynchronous work. Recompute from the current store instead.
          if (get().entries !== snapshot) return fallback()
          const blendCandidates: BlendCandidate[] = candidates.map((memory) => {
            const rec = vecMap.get(memory.id)
            const vector = rec && rec.dim === queryVec.length ? rec.vector : null
            return { memory, vector }
          })

          // If NOT A SINGLE candidate has a usable vector, the blend reduces to
          // keyword+recency with no semantic lift, the sync keyword path is
          // the better-tested equivalent, so fall back to it.
          if (!blendCandidates.some(c => c.vector)) return fallback()

          const scored = scoreMemoriesBlended(queryVec, query, blendCandidates).map(s => s.memory)
          const ordered = scored.slice(0, budget.maxMemories)

          // An empty blend is a legitimate answer ("nothing here belongs to
          // this question"), not a degenerate one, see MIN_RAW_SEMANTIC. We
          // still ask the keyword path, because it is the second, independent
          // gate: it only returns entries that share a word with the query, so
          // it cannot re-admit what the blend just rejected as unrelated. What
          // it CAN still catch is an entry whose embedding is missing or bad.
          if (ordered.length === 0) return fallback()

          return deliverMemories({
            ordered: [...pinned, ...ordered],
            overCount: scored.slice(budget.maxMemories),
            eligible: eligible.length,
            budget, contextTokens, opts: requestOpts,
          })
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
        if (!target || target.sensitive) return
        const candidate = ctx?.newId ? get().entries.find(e => e.id === ctx.newId) : undefined
        // GH #255: a memory the user wrote is never rewritten by the
        // extractor. The fact is already there in the user's words, so the
        // speculative copy goes again (no forget mark: the user deleted
        // nothing) and the hand-written text stays exactly as it was.
        if (isHandWritten(target)) {
          if (candidate && candidate.id !== targetId && !isHandWritten(candidate)) {
            set((state) => ({ entries: state.entries.filter(e => e.id !== candidate.id), lastSynced: Date.now() }))
            void deleteVector(candidate.id)
          }
          return
        }
        // R2-36: `target.scope !== candidate?.scope` returned true whenever
        // there was no candidate at all (candidate?.scope undefined, target.scope
        // set), so an UPDATE without ctx.newId never applied. The scope check
        // only makes sense when there IS a candidate to compare against.
        if (candidate && target.scope !== candidate.scope) return

        const merged = mergedContent.trim()
        if (!merged) return

        const now = Date.now()
        set((state) => ({
          entries: state.entries.map((e) => {
            if (e.id === targetId) {
              return {
                ...e,
                content: merged,
                confirmedAt: undefined,
                description: merged.substring(0, 120),
                updatedAt: now,
                validFrom: now,
                // Clearing stale/supersededBy in case we're refreshing a
                // previously-superseded entry.
                stale: false,
                supersededBy: undefined,
              }
            }
            // The freshly-added candidate (if provided) becomes the record
            // of the OLD text: stale, pointing at the merged target, with the
            // target's title and content as they were before this merge. So
            // "Show outdated" keeps what was replaced (GH #255).
            if (ctx?.newId && e.id === ctx.newId) {
              return { ...e, title: target.title, description: target.description, content: target.content, stale: true, supersededBy: targetId }
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
          const entries = get().entries.filter((e) => !e.sensitive && !isStale(e))
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
          // Best-effort backfill, ignore failures.
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
        const entries = get().entries.filter(e => !e.sensitive && e.scope === undefined)
        if (entries.length === 0) return '# Memory\n\nNo entries yet.\n'

        const typeOrder: MemoryType[] = ['user', 'feedback', 'project', 'reference']
        const typeTitles: Record<MemoryType, string> = {
          user: 'User', feedback: 'Feedback', project: 'Project', reference: 'References',
        }

        // An HTML comment: invisible in a rendered preview, does not match
        // `##` headers or MD_ITEM, and survives a round trip through any
        // markdown-preserving editor. See MD_FORMAT_MARKER above.
        let md = `# Memory\n\n${MD_FORMAT_MARKER}\n\n`

        for (const type of typeOrder) {
          const typeEntries = entries.filter(e => e.type === type)
          if (typeEntries.length === 0) continue

          md += `## ${typeTitles[type]}\n\n`
          for (const entry of typeEntries) {
            const date = isoTag(entry.updatedAt)
            // R2-25: escaped so a multi-line entry stays ONE physical line,
            // see escapeMdContent. The bracket-ending check below still reads
            // the RAW content: `\n`-escaping never adds or removes a
            // trailing `]`, and checking the escaped form would be the same
            // answer read through an extra step.
            md += `- **${entry.title}**, ${escapeMdContent(entry.content)}`
            if (entry.tags.length > 0) md += ` [${entry.tags.join(', ')}]`
            // A content that ends in a bracket group would otherwise read back
            // as a tag list on import. The empty group occupies the tag slot,
            // so the content keeps its own bracket. See MD_ITEM.
            else if (entry.content.endsWith(']')) md += ' []'
            md += ` *(${entry.source})*, ${date}\n`
          }
          md += '\n'
        }

        return md
      },

      importFromMarkdown: (markdown) => {
        // Opus-Review Nachbesserung 5: only a file THIS fix wrote carries
        // escaped `\n`/`\r`/backslash sequences that need undoing. An older
        // export (or a hand-written one) never escaped anything, so its
        // literal backslash-n is content, not a line break waiting to be
        // restored, see MD_FORMAT_MARKER's comment.
        const escaped = MD_FORMAT_MARKER_RE.test(markdown)
        const lines = markdown.split('\n')
        const pool: MemoryFile[] = [...get().entries]
        const newEntries: MemoryFile[] = []
        let alreadyPresent = 0
        let currentType: MemoryType = 'user'

        const typeMap: Record<string, MemoryType> = {
          'user': 'user', 'feedback': 'feedback', 'project': 'project', 'references': 'reference',
          // Legacy support
          'facts': 'user', 'tool results': 'reference', 'decisions': 'project', 'context': 'project',
        }

        for (const rawLine of lines) {
          // Opus-Review Runde 2, Punkt 6: `markdown.split('\n')` leaves a
          // trailing `\r` on every physical line when the file carries CRLF
          // endings (a Windows text editor, `git core.autocrlf` on checkout).
          // MD_ITEM is `$`-anchored and `.` never matches `\r` (same class as
          // Nachbesserung 5 above), so every line would refuse to match and
          // the WHOLE import would silently yield zero entries, not just miss
          // the odd one. Stripping it here, before either regex sees the
          // line, is the one point both `headerMatch` and `MD_ITEM` share.
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
          const headerMatch = line.match(/^##\s+(.+)/)
          if (headerMatch) {
            const header = headerMatch[1].toLowerCase().trim()
            if (typeMap[header]) currentType = typeMap[header]
            continue
          }

          const itemMatch = line.match(MD_ITEM)
          if (itemMatch) {
            const title = itemMatch[1] || itemMatch[2].substring(0, 60)
            // R2-25: undo escapeMdContent's `\n`/backslash escaping so a
            // multi-line memory comes back with its real line breaks instead
            // of the literal two-character escape. Only when the format
            // marker says this file was escaped in the first place, see
            // MD_FORMAT_MARKER.
            const content = escaped ? unescapeMdContent(itemMatch[2].trim()) : itemMatch[2].trim()
            const tags = itemMatch[3] ? itemMatch[3].split(',').map(t => t.trim()).filter(Boolean) : []
            const source = itemMatch[4] || 'import'
            const stand = isoBack(itemMatch[5]) ?? Date.now()

            if (content) {
              const entry: MemoryFile = {
                id: uuid(),
                type: currentType,
                title: title.substring(0, 60),
                description: content.substring(0, 120),
                content,
                tags,
                createdAt: stand,
                updatedAt: stand,
                source,
              }
              // A markdown export carries no id, so the collection itself
              // decides what is already known.
              if (pool.some((known) => isSameMemory(known, entry))) { alreadyPresent++; continue }
              pool.push(entry)
              newEntries.push(entry)
            }
          }
        }

        if (newEntries.length > 0) {
          set((state) => ({
            entries: [...state.entries, ...newEntries],
            lastSynced: Date.now(),
          }))
        }
        return { added: newEntries.length, updated: 0, alreadyPresent }
      },

      exportAsJSON: () => {
        const { entries, settings } = get()
        return JSON.stringify({ entries, settings }, null, 2)
      },

      importFromJSON: (json) => {
        let raw: unknown
        try {
          raw = JSON.parse(json)
        } catch {
          log.error('Failed to parse memory JSON import')
          return { added: 0, updated: 0, alreadyPresent: 0 }
        }
        // Tolerant shape handling: accept LU's own {entries:[...]} export, a
        // bare [...] array, or {memories:[...]} (a user-session 2026-06-07,
        // imports silently produced 0 entries on any other shape).
        const entriesField = prop(raw, 'entries')
        const memoriesField = prop(raw, 'memories')
        const arr: unknown[] = Array.isArray(raw) ? raw
          : Array.isArray(entriesField) ? entriesField
          : Array.isArray(memoriesField) ? memoriesField
          : []
        const now = Date.now()
        // The collection as it stands, grown while the file is read, so a file
        // that carries the same memory twice cannot land twice either.
        const pool: MemoryFile[] = [...get().entries]
        const importedIds = new Map<string, string | null>()
        const landed: Array<{
          entry: MemoryFile
          links: { supersededBy?: string; supersedesId?: string }
          known?: MemoryFile
        }> = []
        for (const e of arr) {
          const scope = prop(e, 'scope')
          if (scope !== undefined && (typeof scope !== 'string' || !scope.trim())) continue
          // `content` may also arrive as `text` / `value`, a foreign export's
          // spelling. Only a real string counts: the old String(...) turned an
          // object into the literal "[object Object]" and imported that.
          const content = (asString(prop(e, 'content')) ?? asString(prop(e, 'text')) ?? asString(prop(e, 'value')) ?? '').trim()
          if (!content) continue
          const type = MEMORY_TYPES.find((t) => t === prop(e, 'type')) ?? 'user'
          const sourceKind = prop(e, 'sourceKind')
          const confirmedAt = prop(e, 'confirmedAt')
          const originalId = asString(prop(e, 'id'))
          const supersededBy = asString(prop(e, 'supersededBy'))
          const scopeValue = asString(scope)
          // The app's own export carries the record id, so the same file read
          // twice meets its own entries again. A file without ids still meets
          // them through content, type and scope, the only three fields
          // isSameMemory reads, which is why this can stand before the draft.
          //
          // It HAS to stand here: a 2.6.9 backup does not know the field
          // `sensitive` at all, and reading a missing field as `=== true` turned
          // it into `false`. Because importDigest carries the mark, that very
          // mark then made the record an update, and the follow-up below
          // re-embedded it. The memory was back in AI requests and back in
          // vector search. A file may only drop a mark by saying so.
          const known = (originalId ? pool.find((p) => p.id === originalId) : undefined)
            ?? pool.find((p) => isSameMemory(p, { content, type, scope: scopeValue }))
          const fileSensitive = prop(e, 'sensitive')
          const draft: Omit<MemoryFile, 'id' | 'createdAt'> = {
            type,
            title: (asString(prop(e, 'title')) ?? content).slice(0, 60).replace(/\n/g, ' '),
            description: (asString(prop(e, 'description')) ?? content).slice(0, 120),
            content,
            tags: asStringArray(prop(e, 'tags')),
            updatedAt: now,
            source: asString(prop(e, 'source')) ?? 'import',
            sourceKind: sourceKind === 'chat' || sourceKind === 'voice' || sourceKind === 'screen' ? sourceKind : undefined,
            confirmedAt: typeof confirmedAt === 'number' && Number.isFinite(confirmedAt) && confirmedAt > 0 && confirmedAt <= now ? confirmedAt : undefined,
            sensitive: fileSensitive === undefined ? known?.sensitive === true : fileSensitive === true,
            scope: scopeValue,
            // A missing replacement must not reactivate an outdated fact.
            stale: prop(e, 'stale') === true || supersededBy !== undefined,
            validFrom: asNumber(prop(e, 'validFrom')),
          }
          // A known record keeps its id and its birthday; only a genuinely new
          // one gets a fresh id, which is why no import can collide with an
          // existing entry's id (that once broke edit/remove-by-id).
          const entry: MemoryFile = {
            ...draft,
            id: known?.id ?? uuid(),
            createdAt: known?.createdAt ?? asNumber(prop(e, 'createdAt')) ?? now,
          }
          if (originalId) importedIds.set(originalId, importedIds.has(originalId) ? null : entry.id)
          landed.push({ entry, links: { supersededBy, supersedesId: asString(prop(e, 'supersedesId')) }, known })
          const at = known ? pool.indexOf(known) : -1
          if (at >= 0) pool[at] = entry
          else pool.push(entry)
        }
        // References may only bind to unique IDs of this file, never to an
        // unrelated local entry or an ambiguous duplicate ID. An ID the file
        // shares with a record already here names that record, because it is
        // the same memory.
        for (const { entry, links } of landed) {
          entry.supersededBy = links.supersededBy ? importedIds.get(links.supersededBy) ?? undefined : undefined
          entry.supersedesId = links.supersedesId ? importedIds.get(links.supersedesId) ?? undefined : undefined
        }
        const newEntries: MemoryFile[] = []
        const updates = new Map<string, MemoryFile>()
        let alreadyPresent = 0
        // A mark that falls is a privacy event, so it is counted and named.
        let unmarkedSensitive = 0
        for (const { entry, known } of landed) {
          if (!known) newEntries.push(entry)
          else if (importDigest(known) === importDigest(entry)) alreadyPresent++
          else {
            if (known.sensitive === true && entry.sensitive !== true) unmarkedSensitive++
            updates.set(entry.id, entry)
          }
        }
        if (newEntries.length > 0 || updates.size > 0) {
          set((state) => ({
            entries: [...state.entries.map((e) => updates.get(e.id) ?? e), ...newEntries],
            lastSynced: now,
          }))
        }
        // A refreshed record keeps its id, so its stored vector still carries
        // the old text until it is re-embedded.
        for (const entry of updates.values()) {
          if (entry.sensitive) void deleteVector(entry.id)
          else void enqueueEmbedding(entry)
        }
        return {
          added: newEntries.length,
          updated: updates.size,
          alreadyPresent,
          ...(unmarkedSensitive > 0 ? { unmarkedSensitive } : {}),
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
    }),
    {
      name: 'locally-uncensored-memory',
      // v3 (Feature FF): adds optional staleness/supersession fields to
      // MemoryFile. They default to unset, so old entries remain valid, the
      // bump exists only to run migrateV2toV3 so the shape is explicit and
      // future migrations have a clean baseline.
      version: 3,
      // IndexedDB (idbStorage) instead of localStorage, memories + their growth
      // shouldn't be capped at ~5 MB; idb is disk-backed and migrates existing
      // localStorage data on first read. createJSONStorage wrap still required
      // (zustand v5 PersistStorage; raw StateStorage → "[object Object]", FIX-3).
      storage: createJSONStorage(() => memoryPersistence),
      migrate: migrateMemoryState,
      merge: (persisted, current) => {
        const saved = isRecord(persisted) ? persisted : {}
        const local = current.activeMemoryOwner === null ? current.entries : current.localEntries
        const collections = current.activeMemoryOwner === null ? current.accountCollections
          : { ...current.accountCollections, [current.activeMemoryOwner]: current.entries }
        return { ...current, ...saved,
          // Never expose an account collection during session restoration.
          // Selection is explicit and checked against the signed-in owner.
          entries: Array.isArray(saved.entries) ? saved.entries : local,
          localEntries: Array.isArray(saved.entries) ? saved.entries : local,
          accountCollections: isRecord(saved.accountCollections) ? saved.accountCollections : collections,
          activeMemoryOwner: null,
          memoryCollectionRevision: current.memoryCollectionRevision + 1,
          forgotten: readForgotten(saved.forgotten),
          pinnedMemoryIds: Array.isArray(saved.pinnedMemoryIds) ? saved.pinnedMemoryIds.filter((id): id is string => typeof id === 'string') : [],
          lastInjection: {},
        } as MemoryState
      },
      partialize: (state) => ({
        entries: state.activeMemoryOwner === null ? state.entries : state.localEntries,
        accountCollections: state.activeMemoryOwner === null ? state.accountCollections
          : { ...state.accountCollections, [state.activeMemoryOwner]: state.entries },
        memorySyncBaselines: state.memorySyncBaselines,
        memorySyncPending: state.memorySyncPending,
        settings: state.settings,
        lastSynced: state.lastSynced,
        forgotten: state.forgotten,
        pinnedMemoryIds: state.pinnedMemoryIds,
      }),
    }
  )
)

useCloudAuthStore.subscribe((state, previous) => {
  if (state.status !== previous.status || state.user?.id !== previous.user?.id) {
    useMemoryStore.getState().selectMemoryCollection(null)
  }
})
