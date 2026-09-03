/**
 * Memory Retrieval — blended multi-signal scorer (Feature FF, v2.5.0).
 *
 * The original memory injection (memoryStore.scoreMemory) was keyword-only:
 * it matched query words against title/description/content/tags. That misses
 * paraphrases ("what's my job?" never matches a memory titled "Senior
 * TypeScript developer"). This module moves retrieval to embedding-first
 * while keeping the keyword signal as a complementary term.
 *
 * It deliberately mirrors rag.ts `hybridSearch`: normalize each signal to
 * 0..1 across the candidate set, THEN apply fixed weights. That keeps the
 * weights interpretable and prevents one signal's raw scale from dominating.
 *
 * Signals (weights sum to 1.0):
 *   - semantic  0.60 — cosineSimilarity(queryVec, memoryVec)
 *   - keyword   0.25 — bm25Score over (title + description + content)
 *   - recency   0.15 — newer memories rank higher (exponential half-life)
 *   plus a small additive type boost for `user` / `feedback` (most actionable).
 *
 * PURE & SYNCHRONOUS: this function never touches Ollama or IndexedDB. The
 * caller embeds the query and hydrates candidate vectors first, then hands
 * everything in. That makes it unit-testable in the node vitest env with
 * hand-built vectors (mirrors rag.test.ts) and keeps the offline fallback in
 * the store trivial — if there's no query vector we just don't call this.
 */

import type { MemoryFile, MemoryType } from "../types/agent-mode"
import { cosineSimilarity, bm25Score } from "../api/rag"

// ── Tunable weights & thresholds (NAMED CONSTANTS) ────────────────
// NOTE: these are first-pass values. They need live MV3/MV4 validation
// against real conversation logs before they can be called "tuned".

/** Blend weights — must sum to ~1.0. */
export const SEMANTIC_WEIGHT = 0.6
export const KEYWORD_WEIGHT = 0.25
export const RECENCY_WEIGHT = 0.15

/** Additive boost (applied to the final blended score) for actionable types. */
export const TYPE_BOOST = 0.05
const BOOSTED_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>(["user", "feedback"])

/** Recency half-life: a memory this old scores 0.5 on the recency signal. */
export const RECENCY_HALF_LIFE_MS = 14 * 86_400_000 // 14 days

/**
 * Minimum blended score for a candidate to be retrieved at all. Keeps totally
 * irrelevant memories out of the prompt even when the budget has room.
 * Conservative on purpose — the keyword-only fallback used `> 0`, but with a
 * normalized blend the floor needs to be a small positive number.
 */
export const RETRIEVAL_FLOOR = 0.08

/**
 * Minimum RAW cosine for the semantic signal to count as evidence on its own.
 *
 * RETRIEVAL_FLOOR alone cannot keep a foreign memory out, and the reason is
 * structural: it sits on the blended score, which is normalized ACROSS THE
 * CANDIDATE SET. The best of two unrelated memories always gets semantic = 1.0,
 * and recency (0.15) plus the type boost (0.05) already clear 0.08 by
 * themselves — so a fresh, entirely unrelated memory was retrieved every time.
 * On 2026-09-03 that put two entries from a foreign dairy-farm conversation
 * into the conclusion AND into every sub-agent of an unrelated research run.
 *
 * So relevance is decided on the raw signal, before normalization. The number
 * is measured, not guessed — nomic-embed-text, German research question,
 * 2026-09-03:
 *
 *   unrelated 0.454 / 0.442 · half-related 0.559 · related 0.712 · same topic 0.947
 *
 * 0.5 sits in the gap between "unrelated" and "half-related". Recalibrate this
 * when the embedding model changes; the keyword hit below is the safety net
 * that keeps a literal match alive even if the number drifts.
 */
export const MIN_RAW_SEMANTIC = 0.5

export interface BlendCandidate {
  memory: MemoryFile
  /**
   * The memory's embedding, or null when it hasn't been embedded yet (lazy
   * backfill pending, or embedding failed). Null-vector candidates still
   * participate via the keyword + recency signals — they just get 0 on the
   * semantic term, exactly like an orthogonal vector.
   */
  vector: number[] | null
}

export interface BlendScored {
  memory: MemoryFile
  score: number
  /** Per-signal breakdown (post-normalization), handy for debugging/tests. */
  semantic: number
  keyword: number
  recency: number
  /**
   * The same signals BEFORE normalization. `semantic`/`keyword` above only say
   * how a candidate ranks inside its own set; these say whether it is related
   * to the question at all, which is what the evidence rule needs.
   */
  rawSemantic: number
  rawKeyword: number
}

/** A memory is "stale" when it's been superseded or explicitly flagged. */
export function isStale(m: MemoryFile): boolean {
  return m.stale === true || typeof m.supersededBy === "string"
}

/**
 * Recency signal in 0..1 via exponential decay. updatedAt in the future (clock
 * skew) clamps to 1; very old clamps toward 0. `now` is injectable for tests.
 */
function recencyScore(updatedAt: number, now: number): number {
  const age = Math.max(0, now - updatedAt)
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS)
}

/**
 * Score & rank candidate memories against a query using the blended signal.
 *
 * @param queryVec  Embedding of the query (same model/dim as the candidate
 *                  vectors). Pass an empty array for an "empty query" (e.g.
 *                  the debug-panel / remote-dispatch preview) — semantic
 *                  collapses to 0 and recency + type boost drive the order.
 * @param query     Raw query text for the BM25 keyword signal.
 * @param candidates  Memories with their (possibly null) vectors.
 * @param opts.now    Injectable clock for deterministic recency tests.
 * @param opts.includeStale  When true, stale entries are NOT excluded
 *                           (used by the "Show outdated" debug toggle).
 *
 * Stale entries are excluded by default (never injected into a live prompt)
 * but the input `candidates` array is never mutated.
 */
/**
 * Does this candidate have any evidence of belonging to THIS question?
 *
 * Two independent kinds count: a shared word (bm25 > 0 means at least one
 * query term literally occurs in the memory) or a raw cosine above the
 * measured threshold. Recency is explicitly not evidence — being new says
 * nothing about being relevant, and letting it decide alone was the bug.
 */
function istRelevant(s: BlendScored): boolean {
  return s.rawKeyword > 0 || s.rawSemantic >= MIN_RAW_SEMANTIC
}

export function scoreMemoriesBlended(
  queryVec: number[],
  query: string,
  candidates: BlendCandidate[],
  opts: { now?: number; includeStale?: boolean } = {},
): BlendScored[] {
  const now = opts.now ?? Date.now()
  const includeStale = opts.includeStale ?? false

  const pool = includeStale
    ? candidates
    : candidates.filter((c) => !isStale(c.memory))
  if (pool.length === 0) return []

  const hasQueryVec = queryVec.length > 0

  // Documents for BM25 IDF — combine the index-friendly fields the keyword
  // scorer historically searched (title + description + content).
  const docTexts = pool.map(
    (c) => `${c.memory.title} ${c.memory.description} ${c.memory.content}`,
  )

  // ── Raw per-signal scores ──────────────────────────────────────
  const rawSemantic = pool.map((c) =>
    hasQueryVec && c.vector && c.vector.length === queryVec.length
      ? cosineSimilarity(queryVec, c.vector)
      : 0,
  )
  const rawKeyword = pool.map((_, i) => bm25Score(query, docTexts[i], docTexts))
  const rawRecency = pool.map((c) => recencyScore(c.memory.updatedAt, now))

  // ── Normalize each signal to 0..1 across the candidate set ─────
  // Same guard as rag.ts hybridSearch (max || 0.001) so an all-zero signal
  // (e.g. empty query → all semantic 0) doesn't divide by zero or blow up.
  const maxSemantic = Math.max(...rawSemantic, 0.001)
  const maxKeyword = Math.max(...rawKeyword, 0.001)
  // Recency is already in 0..1 (exp decay), so no per-set normalization —
  // normalizing it would make the single-candidate case meaningless.

  const scored: BlendScored[] = pool.map((c, i) => {
    const semantic = Math.max(0, rawSemantic[i]) / maxSemantic
    const keyword = rawKeyword[i] / maxKeyword
    const recency = rawRecency[i]
    let score =
      SEMANTIC_WEIGHT * semantic +
      KEYWORD_WEIGHT * keyword +
      RECENCY_WEIGHT * recency
    if (BOOSTED_TYPES.has(c.memory.type)) score += TYPE_BOOST
    return {
      memory: c.memory,
      score,
      semantic,
      keyword,
      recency,
      rawSemantic: rawSemantic[i],
      rawKeyword: rawKeyword[i],
    }
  })

  return scored
    .filter(istRelevant)
    .filter((s) => s.score >= RETRIEVAL_FLOOR)
    .sort((a, b) => b.score - a.score)
}
