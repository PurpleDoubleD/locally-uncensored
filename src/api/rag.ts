import { v4 as uuid } from "uuid"
import type { DocumentMeta, TextChunk, RAGContext, VectorSearchResult } from "../types/rag"
import { ollamaUrl, localFetch } from "./backend"
import { isManagedBuiltinActive, embedBaseUrl, bundledEmbedStatus, ensureBundledEmbedAlive } from "./engine"

export async function extractText(file: File): Promise<string> {
  const ext = file.name.split(".").pop()?.toLowerCase()
  try {
    if (ext === "pdf") return await extractTextFromPDF(file)
    if (ext === "docx") return await extractTextFromDOCX(file)
    return await file.text()
  } catch (err) {
    throw new Error(
      `Failed to extract text from "${file.name}": ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

async function extractTextFromPDF(file: File): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist")
  // Use local worker — never load from CDN to protect privacy
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
  const arrayBuffer = await file.arrayBuffer()
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const textContent = await page.getTextContent()
    pages.push(textContent.items.map((item: any) => item.str).join(" "))
  }
  return pages.join("\n\n")
}

async function extractTextFromDOCX(file: File): Promise<string> {
  const mammoth = await import("mammoth")
  const arrayBuffer = await file.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer })
  return result.value
}

/**
 * Hard ceiling per chunk, in characters. The embedding server processes one
 * chunk in a single batch, and llama-server's default physical batch is 512
 * tokens, so an oversized chunk comes back as
 * "input (658 tokens) is too large to process" and the whole document fails
 * to index (ChrisMcSheehy, D#91, 2026-07-27). ~4 chars per token puts 1200
 * characters near 300 tokens, comfortably inside 512 even for token-dense
 * text like code or CJK.
 */
const MAX_CHUNK_CHARS = 1200

/** Split a run of text that carries no sentence break into pieces that fit,
 *  preferring word boundaries. A PDF table, a bullet list, OCR output or a
 *  code block is one "sentence" to the splitter below, and before this it
 *  went to the embedder whole. */
function splitOversized(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const cut = window.lastIndexOf(" ")
    // No space in a whole window (CJK, a long URL, minified text) — cut hard.
    const at = cut > limit * 0.5 ? cut : limit
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) out.push(rest)
  return out.filter(Boolean)
}

export function chunkText(
  text: string,
  chunkSize = 500,
  overlap = 50
): string[] {
  const chunks: string[] = []
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .flatMap((s) => splitOversized(s, MAX_CHUNK_CHARS))
  let current = ""

  for (const sentence of sentences) {
    if ((current + " " + sentence).length > chunkSize && current) {
      chunks.push(current.trim())
      const words = current.split(" ")
      const overlapWords = words.slice(-Math.ceil(overlap / 5))
      current = overlapWords.join(" ") + " " + sentence
    } else {
      current += (current ? " " : "") + sentence
    }
  }
  if (current.trim()) chunks.push(current.trim())
  // Final guarantee: the overlap prefix can push a chunk back over the ceiling,
  // and one oversized chunk fails the whole document at the embedder.
  return chunks
    .flatMap((c) => splitOversized(c, MAX_CHUNK_CHARS))
    .filter((c) => c.length > 20)
}

export async function generateEmbeddings(
  texts: string[],
  model = "nomic-embed-text"
): Promise<number[][]> {
  // P5: when the app-managed built-in engine is the active backend, embed
  // against the bundled `llama-server --embeddings` (OpenAI `/v1/embeddings`)
  // so Document-Chat/RAG works with zero Ollama. The bundled embed server also
  // serves LM Studio/openai-compat setups that downloaded the embed GGUF in
  // onboarding — use it whenever it is running. Otherwise fall back to the
  // Ollama `/api/embed` path (still supported as an "Advanced" backend).
  if (isManagedBuiltinActive()) {
    // A Create/Music render may have offloaded the embed sidecar — revive it
    // before the request instead of failing with "cannot reach :8128".
    await ensureBundledEmbedAlive()
    // It revives a server, it cannot create the model one needs. Without this
    // the next line dies on a bare transport error and the panel shows
    // `proxy_localhost: error sending request`, which names the pipe instead
    // of the missing part (measured on the Windows box, 2026-08-15).
    if (!(await bundledEmbedStatus().then((s) => s.running).catch(() => false))) {
      throw new Error(
        "No embedding model is installed for the LU Engine. Open Document Chat and use the install card to download it (84 MB), then drop the file again."
      )
    }
    return embedViaBuiltin(texts, model)
  }
  try {
    if ((await bundledEmbedStatus()).running) {
      return embedViaBuiltin(texts, model)
    }
  } catch { /* engine command unavailable — fall through to Ollama */ }
  return embedViaOllama(texts, model)
}

/** OpenAI `/v1/embeddings` against the bundled embeddings server (P5). */
async function embedViaBuiltin(texts: string[], model: string): Promise<number[][]> {
  let res: Response
  try {
    res = await localFetch(`${embedBaseUrl()}/embeddings`, {
      method: "POST",
      body: JSON.stringify({ model, input: texts }),
    })
  } catch (err) {
    throw new Error(
      `Cannot reach the LU Engine embeddings server. (${err instanceof Error ? err.message : String(err)})`
    )
  }

  if (!res.ok) {
    let detail = ""
    try {
      const body = await res.json()
      detail = body?.error?.message || body?.error || ""
    } catch { /* ignore parse errors */ }
    throw new Error(
      `Embedding failed (HTTP ${res.status}): ${detail || "the LU Engine embeddings server may still be loading"}`
    )
  }

  const data = await res.json()
  // OpenAI shape: { data: [{ embedding: number[], index }] }. Sort by index so
  // the vectors line up with the input order even if the server reorders them.
  if (!data?.data || !Array.isArray(data.data)) {
    throw new Error("Unexpected response from the LU Engine /v1/embeddings endpoint")
  }
  return [...data.data]
    .sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
    .map((d: any) => d.embedding as number[])
}

/** Ollama `/api/embed` — the legacy/Advanced path (unchanged). */
async function embedViaOllama(texts: string[], model: string): Promise<number[][]> {
  let res: Response
  try {
    res = await localFetch(ollamaUrl("/embed"), {
      method: "POST",
      body: JSON.stringify({ model, input: texts }),
    })
  } catch (err) {
    throw new Error(
      `Cannot reach Ollama. Is it running? (${err instanceof Error ? err.message : String(err)})`
    )
  }

  if (!res.ok) {
    let detail = ""
    try {
      const body = await res.json()
      detail = body?.error || ""
    } catch { /* ignore parse errors */ }

    if (res.status === 404 || detail.includes("not found")) {
      throw new Error(
        `Embedding model "${model}" not found. Run: ollama pull ${model}`
      )
    }
    throw new Error(
      `Embedding failed (HTTP ${res.status}): ${detail || "Unknown error"}`
    )
  }

  const data = await res.json()
  if (!data.embeddings || !Array.isArray(data.embeddings)) {
    throw new Error("Unexpected response from Ollama /embed endpoint")
  }
  return data.embeddings
}

export function cosineSimilarity(a: number[], b: number[]): number {
  // Vectors of different length are not comparable — that happens for real:
  // chunks embedded with one model and a query embedded with another (switching
  // the embedding model, or the move from Ollama embeddings to the built-in
  // engine) have different dimensions, and a chunk whose embedding call failed
  // can be stored empty. The old loop read past the shorter vector, multiplied
  // by `undefined` and returned NaN — and a single NaN then poisoned the whole
  // ranking (see hybridSearch), so retrieval silently returned the first chunks
  // of the document instead of the relevant ones.
  if (!a.length || a.length !== b.length) return 0
  let dot = 0,
    magA = 0,
    magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const score = dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1)
  return Number.isFinite(score) ? score : 0
}

export function bm25Score(query: string, document: string, allDocs: string[]): number {
  const queryTerms = query.toLowerCase().split(/\s+/)
  const docTerms = document.toLowerCase().split(/\s+/)
  const docLen = docTerms.length
  const numDocs = allDocs.length || 1
  const avgDl = allDocs.reduce((sum, d) => sum + d.split(/\s+/).length, 0) / numDocs || 200
  const k1 = 1.2
  const b = 0.75

  let score = 0
  for (const term of queryTerms) {
    const tf = docTerms.filter((t) => t === term).length
    const docsWithTerm = allDocs.filter(d => d.toLowerCase().includes(term)).length
    const idf = Math.log((numDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5) + 1)
    score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docLen) / avgDl)))
  }
  return score
}

function hybridSearch(
  queryEmbedding: number[],
  query: string,
  chunks: TextChunk[],
  topK = 5
): VectorSearchResult[] {
  // Get vector scores
  const vectorResults = chunks.map((chunk) => ({
    chunk,
    vectorScore: cosineSimilarity(queryEmbedding, chunk.embedding),
  }))

  // Get BM25 scores (pass all docs for proper IDF calculation)
  const allDocTexts = chunks.map(c => c.content)
  const bm25Results = chunks.map((chunk) => ({
    chunk,
    bm25Score: bm25Score(query, chunk.content, allDocTexts),
  }))

  // Normalize both score sets to 0-1. Non-finite scores are dropped from the
  // max: Math.max with a single NaN returns NaN, which would turn EVERY
  // normalized score into NaN and leave the sort comparing NaNs — i.e. no
  // ranking at all.
  const finite = (xs: number[]) => xs.filter((x) => Number.isFinite(x))
  const maxVector = Math.max(...finite(vectorResults.map((r) => r.vectorScore)), 0.001)
  const maxBm25 = Math.max(...finite(bm25Results.map((r) => r.bm25Score)), 0.001)

  // Combine with 0.7 vector + 0.3 BM25 weighting
  const safe = (x: number) => (Number.isFinite(x) ? x : 0)
  const combined = chunks.map((chunk, i) => ({
    chunk,
    score:
      0.7 * (safe(vectorResults[i].vectorScore) / maxVector) +
      0.3 * (safe(bm25Results[i].bm25Score) / maxBm25),
  }))

  return combined.sort((a, b) => b.score - a.score).slice(0, topK)
}

export function searchVectors(
  queryEmbedding: number[],
  chunks: TextChunk[],
  topK = 5
): VectorSearchResult[] {
  return chunks
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

export async function indexDocument(
  file: File,
  embeddingModel = "nomic-embed-text"
): Promise<{ meta: DocumentMeta; chunks: TextChunk[] }> {
  const text = await extractText(file)
  const rawChunks = chunkText(text)
  const embeddings = await generateEmbeddings(rawChunks, embeddingModel)

  const docId = uuid()
  const chunks: TextChunk[] = rawChunks.map((content, index) => ({
    id: uuid(),
    documentId: docId,
    content,
    embedding: embeddings[index],
    index,
  }))

  const meta: DocumentMeta = {
    id: docId,
    name: file.name,
    type: file.name.split(".").pop()?.toLowerCase() as "pdf" | "docx" | "txt",
    size: file.size,
    addedAt: Date.now(),
    chunkCount: chunks.length,
  }

  return { meta, chunks }
}

export interface RetrieveResult {
  context: RAGContext
  scoredChunks: VectorSearchResult[]
}

export async function retrieveContext(
  query: string,
  chunks: TextChunk[],
  embeddingModel = "nomic-embed-text",
  topK = 5
): Promise<RetrieveResult> {
  const [queryEmb] = await generateEmbeddings([query], embeddingModel)
  const results = hybridSearch(queryEmb, query, chunks, topK)
  return {
    context: {
      chunks: results.map((r) => r.chunk),
      query,
      documentIds: [...new Set(results.map((r) => r.chunk.documentId))],
    },
    scoredChunks: results,
  }
}
