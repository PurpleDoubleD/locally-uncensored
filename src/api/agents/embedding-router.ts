/**
 * Phase 9 (v2.4.0) — Embedding-based tool routing.
 *
 * When the total tool count exceeds ~15 (typical once MCP servers are
 * connected), the keyword-only tool-selection misses the right tools for
 * novel requests. This module adds a semantic layer:
 *
 *   1. Precompute nomic-embed-text vectors for every tool description.
 *   2. Embed the user message.
 *   3. Return the top-N tools by cosine similarity + ALWAYS_INCLUDE.
 *
 * Design points:
 *   - Embeddings are cached by tool name + description hash so recompute
 *     only happens when a description actually changes.
 *   - All embedding work is best-effort: if Ollama is unreachable or the
 *     nomic-embed model is missing, the router falls back silently and
 *     signals the caller to use keyword routing.
 *   - The module is side-effect-light in node (no localStorage calls);
 *     the cache lives in a per-module Map that survives hot reload but
 *     resets between sessions.
 *   - The embedding client is dependency-injected so tests can stub it
 *     without pulling Ollama.
 */

export type EmbeddingFn = (texts: string[]) => Promise<number[][]>

interface ToolLike {
  name: string
  description: string
}

interface CachedVector {
  descriptionHash: string
  vector: number[]
}

const CACHE = new Map<string, CachedVector>()

function hashDescription(s: string): string {
  // djb2; plenty to detect description changes.
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i)
  return (h >>> 0).toString(16)
}

export function clearEmbeddingCache(): void {
  CACHE.clear()
}

/**
 * Precompute embeddings for each tool's description. Cheaply skips any
 * tool whose (name, descriptionHash) is already cached. Returns the
 * number of newly embedded tools (useful for logs/tests).
 */
export async function precomputeToolEmbeddings(
  tools: ToolLike[],
  embed: EmbeddingFn
): Promise<number> {
  const toEmbed: ToolLike[] = []
  for (const t of tools) {
    const hash = hashDescription(t.description)
    const cached = CACHE.get(t.name)
    if (!cached || cached.descriptionHash !== hash) toEmbed.push(t)
  }
  if (toEmbed.length === 0) return 0

  const vectors = await embed(toEmbed.map((t) => t.description))
  for (let i = 0; i < toEmbed.length; i++) {
    CACHE.set(toEmbed[i].name, {
      descriptionHash: hashDescription(toEmbed[i].description),
      vector: vectors[i],
    })
  }
  return toEmbed.length
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let magA = 0
  let magB = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Rank tools by cosine similarity against the query. Tools missing from
 * the embedding cache are skipped silently (caller is responsible for
 * precomputing or merging with keyword fallback).
 */
export async function rankToolsByEmbedding(
  query: string,
  tools: ToolLike[],
  embed: EmbeddingFn,
  opts: { topN?: number } = {}
): Promise<Array<{ tool: ToolLike; score: number }>> {
  const topN = opts.topN ?? 10
  const [queryVec] = await embed([query])
  if (!queryVec) return []

  const scored: Array<{ tool: ToolLike; score: number }> = []
  for (const t of tools) {
    const c = CACHE.get(t.name)
    if (!c) continue
    scored.push({ tool: t, score: cosine(queryVec, c.vector) })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topN)
}

/**
 * End-to-end helper: precompute + rank + union with always-include names.
 * Returns the final tool-name set ordered most-relevant-first. Callers
 * should treat this as a soft hint — keep permissions filtering, keep
 * your keyword fallback in case this module returns too few tools.
 */
export async function selectToolsByEmbedding(
  query: string,
  tools: ToolLike[],
  embed: EmbeddingFn,
  opts: { topN?: number; alwaysInclude?: string[] } = {}
): Promise<string[]> {
  const topN = opts.topN ?? 10
  const always = opts.alwaysInclude ?? []

  // Precompute on the way in — cheap once cached.
  await precomputeToolEmbeddings(tools, embed)

  const ranked = await rankToolsByEmbedding(query, tools, embed, { topN })
  const names = ranked.map((r) => r.tool.name)
  const out = [...names]
  for (const a of always) if (!out.includes(a)) out.push(a)
  return out
}

/** Exposed for tests. */
export const __internal = { CACHE, hashDescription, cosine }
