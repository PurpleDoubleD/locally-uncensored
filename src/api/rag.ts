import { v4 as uuid } from "uuid"
import type { DocumentMeta, TextChunk, RAGContext, VectorSearchResult } from "../types/rag"
import { ollamaUrl, localFetch } from "./backend"
import {
  isManagedBuiltinActive, embedBaseUrl, bundledEmbedStatus, ensureBundledEmbedAlive,
  isEmbeddingGgufName, listBundledModels, stopBundledEmbed,
  bundledEngineStatus, startBundledEngine, stopBundledEngine,
} from "./engine"
import { singleModelSlot } from "../lib/capabilities"
import { isMobile } from "../lib/device-kind"
import { ensureWebViewPolyfills } from "../lib/webview-polyfills"
import {
  EMBEDDER_NO_ROOM_ALONE_MESSAGE, EMBEDDER_PORT_BUSY_MESSAGE, EmbedderNotAllowedError, NO_EMBED_MODEL_MOBILE_MESSAGE, isEmbedPortBusy,
  SingleSlotConflictError, beginDocumentJob, beginSearchJob, chatModelLoading, documentJobRunning, embedderFit,
  embedderMayLoad, embedderReleasesAfterUse, markDocumentJobWaiting, setSlotTurn, subscribeSlotTurn,
  type EmbedPurpose,
} from "../lib/model-slot"
import { searchStoppedError, stopHandleFor } from "../lib/slot-wait"
import { useSettingsStore } from "../stores/settingsStore"
import { useGenerationStore } from "../stores/generationStore"
import { log } from "../lib/logger"
import { asNumber, errorText, prop } from "../types/json-guards"

/**
 * One embedding row's vector, or `[]`.
 *
 * The number sibling of json-guards' `asStringArray`, kept local because rag.ts
 * is its only caller. All-or-nothing on purpose: a vector with a hole in it is
 * not a shorter vector, it is not a vector, and silently shortening one would
 * defeat the dimension check in cosineSimilarity.
 */
function asNumberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  const out: number[] = []
  for (const x of v) {
    if (typeof x !== "number" || !Number.isFinite(x)) return []
    out.push(x)
  }
  return out
}

export async function extractText(file: File): Promise<string> {
  const ext = file.name.split(".").pop()?.toLowerCase()
  try {
    if (ext === "pdf") return await extractTextFromPDF(file)
    if (ext === "docx") return await extractTextFromDOCX(file)
    return await file.text()
  } catch (err) {
    const failed = new Error(
      `Failed to extract text from "${file.name}": ${err instanceof Error ? err.message : String(err)}`
    )
    // The file was gone or no longer readable, not broken (a WebView's copy of a picked file can be
    // removed by the system while LU still holds it). The phone says so in its own words.
    const name = err && typeof err === "object" ? (err as { name?: unknown }).name : undefined
    if (name === "NotFoundError" || name === "NotReadableError") Object.assign(failed, { code: "file_gone" })
    throw failed
  }
}

/**
 * A dropped PDF is attacker-controlled input, and only the packaged app has a
 * CSP behind it — the browser and from-source lanes run this with nothing else
 * in the way.
 *
 * GHSA-hq66-cqwq-w95j (pdfjs-dist >= 5.6.83, < 6.2.108, which is what 2.6.7
 * shipped): a PostScript calculator function (`/FunctionType 4`) inside a
 * document was compiled to JavaScript source and handed to `new Function`
 * whenever the `getDocument` option `isEvalSupported` kept its default `true`.
 *
 * That sink sat one call away, not zero: measured on 5.6.205, the sequence
 * below — getDocument, getPage, getTextContent — compiles nothing, while
 * `getOperatorList` on the same file hands the document's own program to
 * `new Function`. Text extraction never renders, so this path did not execute
 * the payload; the next person to reach for a thumbnail or a page preview
 * would have. 6.2.108 replaced the compiler with a WebAssembly one and DELETED
 * the option, so the floor in package.json is the fix and there is no flag
 * left to pass. rag-pdf-eval.test.ts holds the sink shut by measurement,
 * pdfjs-supply-chain.test.ts holds the floor.
 *
 * `enableScripting` is not a `getDocument` option in any 5.x or 6.x; it gates
 * the AnnotationLayer, which text extraction never constructs, so a document's
 * own /JavaScript actions have nothing to run in.
 */
async function extractTextFromPDF(file: File): Promise<string> {
  // The `legacy` build, not the default one. pdfjs 6's modern bundle calls
  // Uint8Array.prototype.toHex / Uint8Array.fromBase64 while parsing, and those
  // shipped only in Safari 18.2, Firefox 133 and Chrome 140 — every older
  // WKWebView, WebKitGTK and WebView2 dies with "toHex is not a function", and
  // so does Node (measured on 24.15), which is what the tests run in. `legacy`
  // carries the polyfills for exactly this.
  //
  // `legacy` still calls two functions it does not bring along, and
  // Android System WebView before 119 and iOS before 17.4 do not have them:
  // "Promise.withResolvers is not a function" (acceptance on Android 8 GB,
  // B5). They are installed here, where they are missing and nowhere else
  // (lib/webview-polyfills.ts).
  const missing = ensureWebViewPolyfills()
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs")
  // pdf.js parses in a worker, and a worker has globals of its own: what was
  // installed above does not exist there. Where something was missing, the
  // worker is one that installs the same functions before pdf.js runs
  // (lib/pdf-worker-compat.ts). Everywhere else it is the file of pdf.js as
  // it comes. Local in both cases, never from a CDN, to protect privacy.
  let port: Worker | null = null
  let worker: InstanceType<typeof pdfjsLib.PDFWorker> | null = null
  if (missing.length > 0 && typeof Worker === "function") {
    port = new Worker(new URL("../lib/pdf-worker-compat.ts", import.meta.url), { type: "module" })
    // The port is typed as never set: the class takes any worker (pdf.js, PDFWorker).
    worker = new pdfjsLib.PDFWorker({ port: port as unknown as null })
  } else {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).href
  }
  try {
    const arrayBuffer = await file.arrayBuffer()
    const doc = await pdfjsLib.getDocument({
      data: arrayBuffer,
      ...(worker ? { worker } : {}),
      // XFA is a second, script-carrying document format that pdf.js only parses
      // on request. Pinned off so a future change of the default cannot reopen
      // it under us.
      enableXfa: false,
      // CMap / standard-font / wasm URLs stay unset on purpose: each one is a
      // fetch whose path comes out of the document, and this app promises that a
      // dropped file is processed locally. Absence is the property, not an
      // oversight: the legacy build carries what it needs inline.
    }).promise
    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const items = await readTextItems(page.streamTextContent())
      // `items` mixes TextItem (has `str`) with TextMarkedContent (has not).
      // Mapping the marked-content entries to '' keeps the joined spacing
      // identical to the old `item.str` read, which produced `undefined` there
      // and `join` rendered that as the empty string anyway.
      pages.push(items.map((item) => ("str" in item ? item.str : "")).join(" "))
    }
    const text = pages.join("\n\n")
    // A scanned PDF is pages of pictures: pdf.js finds no text in it, and the
    // empty string used to go on to the embedding server, which answered
    // `HTTP 500: "prompt" must not be empty` — true, and no help to anyone.
    if (!text.trim()) {
      throw new Error("the PDF has no text layer, so it is probably a scan. Run it through text recognition (OCR) and add it again.")
    }
    return text
  } finally {
    // A worker of our own is ours to end. The one pdf.js starts itself is
    // left as it always was.
    if (worker) {
      try { worker.destroy() } catch { /* already gone */ }
    }
    port?.terminate()
  }
}

type PDFPageProxy = import("pdfjs-dist/legacy/build/pdf.mjs").PDFPageProxy
type PdfTextItems = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>["items"]

/**
 * `page.getTextContent()` without its `for await (… of readableStream)`.
 *
 * pdf.js 6 reads the text stream with async iteration, and WebKit has no
 * `ReadableStream.prototype[Symbol.asyncIterator]` — not in the macOS 26
 * WKWebView the Mac app runs in, where every PDF failed with
 * "undefined is not a function (near '...e of t...')" (3.0.7, tester report
 * 2026-10-20). The legacy build does not polyfill it and Node has it, so the
 * tests never saw the gap. A reader loop works on every engine.
 */
async function readTextItems(stream: ReadableStream): Promise<PdfTextItems> {
  const reader = stream.getReader()
  const items: PdfTextItems = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return items
      for (const item of (value as { items: PdfTextItems }).items) items.push(item)
    }
  } finally {
    reader.releaseLock()
  }
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

export interface EmbedOptions {
  /** Who is asking. On a single slot device only 'document-chat' may load the
   *  embedder (lib/model-slot.ts); everything else is refused there so its
   *  caller takes its keyword fallback. Ignored on a desktop. */
  purpose?: EmbedPurpose
}

/**
 * The chat model that stepped aside for the embedder, to be loaded again when
 * the embedder is done. null while nobody borrows the slot.
 */
interface BorrowedSlot {
  /** Path of the chat model that was unloaded, null when none was loaded. */
  chatModelPath: string | null
  /** The context it ran with, so it comes back as it was. */
  ctx: number | null
}

let borrowed: BorrowedSlot | null = null

/**
 * How many callers are using the embedder right now (a reading, a search).
 * The embedder is given back when the last one is done, never under one that
 * is still sending passages to it.
 */
let embedderHolds = 0

/**
 * The steps that load and unload a model, one after the other.
 *
 * Two readings (or a reading and a search) that started together both found
 * "nobody has borrowed the slot yet", and both went on to unload the chat
 * model. The second one then either unloaded it twice, or found it gone,
 * took that for "no room on this device" and gave back the slot the first
 * one was still reading with (review of round 6, the race in borrowSlot,
 * proven in __tests__/durchsicht-r6-modellplatz.test.ts). Every such step
 * now waits for the one before it, so the second caller sees what the first
 * one did.
 *
 * A step must never wait for another step: that would be a wait for itself.
 */
let slotSteps: Promise<void> = Promise.resolve()

function inSlotStep<T>(step: () => Promise<T>): Promise<T> {
  const run = slotSteps.then(step, step)
  slotSteps = run.then(() => undefined, () => undefined)
  return run
}

/** Test-only. */
export function __resetSlotTurnForTests(): void {
  borrowed = null
  embedderHolds = 0
  slotSteps = Promise.resolve()
  setSlotTurn("idle")
}

async function embedderRunning(): Promise<boolean> {
  return bundledEmbedStatus().then((s) => !!s?.running).catch(() => false)
}

/**
 * Unload the chat model so the embedder can have the slot. Remembers what was
 * loaded, so giveSlotBack can load it again. True when a chat model was
 * actually unloaded, false when there was none to unload.
 */
async function borrowSlot(): Promise<boolean> {
  if (borrowed) return false
  const status = await bundledEngineStatus().catch(() => null)
  if (!status?.running) return false
  setSlotTurn("unloading-chat")
  borrowed = {
    chatModelPath: status.model_path ?? null,
    ctx: typeof status.ctx === "number" && status.ctx > 0 ? status.ctx : null,
  }
  try {
    await stopBundledEngine()
  } catch (err) {
    borrowed = null
    setSlotTurn("idle")
    throw err
  }
  return true
}

/** The embedder is done or failed: unload it and load the chat model again. */
function giveSlotBack(): Promise<void> {
  return inSlotStep(giveSlotBackNow)
}

async function giveSlotBackNow(): Promise<void> {
  const mine = borrowed
  if (!mine) return
  borrowed = null
  try { await stopBundledEmbed() } catch { /* nothing was running */ }
  if (mine.chatModelPath) {
    setSlotTurn("reloading-chat")
    try {
      const tuning = useSettingsStore.getState().settings.builtinEngine
      await startBundledEngine(mine.chatModelPath, mine.ctx ? { ...(tuning ?? {}), ctx: mine.ctx } : tuning)
    } catch (err) {
      // Not fatal: the next send loads the model itself (builtin-ensure) and
      // reports a real failure there, in the chat.
      log.warn("[rag] the chat model did not come back after reading a document", { err: String(err) })
    }
  }
  setSlotTurn("idle")
}

/**
 * The single slot path: the embedder is loaded on demand, for Document Chat
 * only. When it has room beside the chat model it loads beside it. When it
 * has not, the two take turns: the chat model is unloaded, the embedder does
 * its work, and releaseEmbedderAfterUse loads the chat model again. There is
 * no Ollama fallback on a phone, so every failure ends in a sentence about
 * this device instead of "Cannot reach Ollama".
 */
async function embedOnSingleSlot(texts: string[], model: string, opts?: EmbedOptions): Promise<number[][]> {
  const purpose = opts?.purpose ?? "background"
  if (!embedderMayLoad(purpose)) throw new EmbedderNotAllowedError(purpose)
  try {
    await inSlotStep(loadEmbedderOnSingleSlot)
    if (borrowed) setSlotTurn("reading")
    return await embedViaBuiltin(texts, model)
  } catch (err) {
    // The chat model must not stay unloaded because the reading failed. But
    // not under somebody else who is still embedding: the last one out gives
    // it back (releaseEmbedderAfterUse).
    if (embedderHolds <= 1) await giveSlotBack()
    throw err
  }
}

/** One slot step: bring the embedder up, moving the chat model out of the way when it must. */
async function loadEmbedderOnSingleSlot(): Promise<void> {
  if (!borrowed && !(await embedderRunning()) && (await embedderFit()) === "no-room") {
    // No room beside the chat model. Without a chat model to move out of
    // the way, or with no room even then, memory is the honest reason.
    if (!(await borrowSlot()) || (await embedderFit()) === "no-room") {
      throw new SingleSlotConflictError(EMBEDDER_NO_ROOM_ALONE_MESSAGE)
    }
  }
  let why = await ensureBundledEmbedAlive()
  if (await embedderRunning()) return
  // Three reasons it is not running, and the user can act on each: nothing
  // to load, its port taken, or no room to load it.
  const installed = await listBundledModels()
    .then((models) => models.some((m) => isEmbeddingGgufName(m.name)))
    .catch(() => false)
  if (!installed) throw new Error(NO_EMBED_MODEL_MOBILE_MESSAGE)
  // A taken port is no memory problem. Unloading the chat model frees no
  // port, so it stays loaded, and the sentence names the port instead of
  // memory (iOS check of package 17, N-1: "address already in use" was
  // shown as "not enough free memory", and every try unloaded the chat model).
  if (isEmbedPortBusy(why)) throw new SingleSlotConflictError(EMBEDDER_PORT_BUSY_MESSAGE)
  // The fit check said yes or did not know, and the system said no. Move
  // the chat model out of the way and try once more.
  if (!borrowed && (await borrowSlot())) {
    why = await ensureBundledEmbedAlive()
  }
  if (await embedderRunning()) return
  // The chat model comes back through the caller's catch (giveSlotBack).
  throw new SingleSlotConflictError(isEmbedPortBusy(why) ? EMBEDDER_PORT_BUSY_MESSAGE : EMBEDDER_NO_ROOM_ALONE_MESSAGE)
}

/**
 * Give the slot back after Document Chat is done with the embedder. Does
 * nothing on a desktop. On a phone where the two took turns, the embedder is
 * unloaded and the chat model is loaded again. On a phone whose shell said
 * the device has room to keep the embedder, it stays.
 */
export async function releaseEmbedderAfterUse(): Promise<void> {
  // Somebody else is still embedding: stopping the server now fails their
  // request ("Embedding failed (HTTP 500)", N1). The last one out gives it back.
  if (embedderHolds > 0) return
  if (borrowed) {
    await giveSlotBack()
    return
  }
  if (!embedderReleasesAfterUse()) return
  try { await stopBundledEmbed() } catch { /* nothing was running, or the command is missing */ }
}

export async function generateEmbeddings(
  texts: string[],
  model = "nomic-embed-text",
  opts?: EmbedOptions,
): Promise<number[][]> {
  if (singleModelSlot()) return embedOnSingleSlot(texts, model, opts)
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
      const body: unknown = await res.json()
      // errorText covers both shapes this used to spell out by hand: a plain
      // string error and an `{ message }` object.
      detail = errorText(prop(body, "error"))
    } catch { /* ignore parse errors */ }
    throw new Error(
      `Embedding failed (HTTP ${res.status}): ${detail || "the LU Engine embeddings server may still be loading"}`
    )
  }

  const data: unknown = await res.json()
  // OpenAI shape: { data: [{ embedding: number[], index }] }. Sort by index so
  // the vectors line up with the input order even if the server reorders them.
  const rows = prop(data, "data")
  if (!rows || !Array.isArray(rows)) {
    throw new Error("Unexpected response from the LU Engine /v1/embeddings endpoint")
  }
  return [...rows]
    .sort((a, b) => (asNumber(prop(a, "index")) ?? 0) - (asNumber(prop(b, "index")) ?? 0))
    .map((d) => asNumberArray(prop(d, "embedding")))
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
      const body: unknown = await res.json()
      // Must end up a STRING: `detail.includes` two lines down threw a
      // TypeError whenever the error field was an object (an OpenAI-shaped
      // proxy in front of Ollama sends `{ error: { message } }`), and the
      // "run: ollama pull …" hint the user needs never got built.
      detail = errorText(prop(body, "error"))
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

  const data: unknown = await res.json()
  const embeddings = prop(data, "embeddings")
  if (!embeddings || !Array.isArray(embeddings)) {
    throw new Error("Unexpected response from Ollama /embed endpoint")
  }
  return embeddings.map(asNumberArray)
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

/**
 * `terms` cuts a text into its terms. Left out, the words between spaces, as
 * always. The memory search hands in lib/search-terms.ts for a question in
 * Japanese, Chinese or Korean, which has no spaces to cut at (GH #255).
 */
export function bm25Score(query: string, document: string, allDocs: string[], terms?: (text: string) => string[]): number {
  const cut = terms ?? ((text: string) => text.toLowerCase().split(/\s+/))
  const queryTerms = terms ? [...new Set(cut(query))] : cut(query)
  const docTerms = cut(document)
  const docLen = docTerms.length
  const numDocs = allDocs.length || 1
  const avgDl = allDocs.reduce((sum, d) => sum + cut(d).length, 0) / numDocs || 200
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

/** What bm25Score works out about the query and the whole collection, kept so
 *  it is worked out once per query instead of once per chunk. */
export interface Bm25Prepared {
  queryTerms: string[]
  /** Inverse document frequency per query term, by position in queryTerms. */
  idf: number[]
  avgDl: number
}

/**
 * The collection half of BM25, once per query.
 *
 * bm25Score above recomputes the average length and the document frequency
 * of every term over ALL documents for EVERY document it scores, so ranking
 * n chunks walked the collection n times: quadratic, on the main thread. The
 * numbers are the same for every chunk of one query, so they are taken here
 * once. bm25ScorePrepared then gives exactly the value bm25Score gives.
 */
export function bm25Prepare(query: string, allDocs: string[]): Bm25Prepared {
  const queryTerms = query.toLowerCase().split(/\s+/)
  const numDocs = allDocs.length || 1
  let totalLen = 0
  const docsWithTerm = new Array<number>(queryTerms.length).fill(0)
  for (const doc of allDocs) {
    totalLen += doc.split(/\s+/).length
    const lower = doc.toLowerCase()
    for (let i = 0; i < queryTerms.length; i++) {
      if (lower.includes(queryTerms[i])) docsWithTerm[i] += 1
    }
  }
  return {
    queryTerms,
    idf: docsWithTerm.map((n) => Math.log((numDocs - n + 0.5) / (n + 0.5) + 1)),
    avgDl: totalLen / numDocs || 200,
  }
}

/** One document against a prepared query. Same result as bm25Score. */
export function bm25ScorePrepared(prepared: Bm25Prepared, document: string): number {
  const docTerms = document.toLowerCase().split(/\s+/)
  const docLen = docTerms.length
  const k1 = 1.2
  const b = 0.75
  let score = 0
  for (let i = 0; i < prepared.queryTerms.length; i++) {
    const term = prepared.queryTerms[i]
    const tf = docTerms.filter((t) => t === term).length
    score += prepared.idf[i] * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docLen) / prepared.avgDl)))
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

  // Get BM25 scores (all docs for proper IDF calculation). The collection
  // statistics are taken once per query; scoring each chunk against the whole
  // collection again made this quadratic (see bm25Prepare).
  const prepared = bm25Prepare(query, chunks.map(c => c.content))
  const bm25Results = chunks.map((chunk) => ({
    chunk,
    bm25Score: bm25ScorePrepared(prepared, chunk.content),
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

/** Limits for one document on a phone. The vectors live in IndexedDB and in
 *  memory (about 7 KB per passage), and the whole file is parsed in memory. */
export interface MobileRagLimits {
  maxFileBytes: number
  maxChunks: number
  /** Passages per embedding request. */
  batchSize: number
}

export const DEFAULT_MOBILE_RAG_LIMITS: MobileRagLimits = {
  maxFileBytes: 20 * 1024 * 1024,
  maxChunks: 1500,
  batchSize: 16,
}

let mobileRagLimits: MobileRagLimits = { ...DEFAULT_MOBILE_RAG_LIMITS }

/** Seam for the mobile shell: tighten or widen the limits per device. */
export function setMobileRagLimits(limits: Partial<MobileRagLimits> | null): void {
  mobileRagLimits = { ...DEFAULT_MOBILE_RAG_LIMITS, ...(limits ?? {}) }
}

export function getMobileRagLimits(): MobileRagLimits {
  return mobileRagLimits
}

/** Thrown when a document is over a phone's limits. The message is for the user. */
export class DocumentTooLargeError extends Error {
  readonly code = "document_too_large"
  constructor(message: string) {
    super(message)
    this.name = "DocumentTooLargeError"
  }
}

export interface IndexOptions {
  /** Passages embedded so far, of how many. Called after every batch. */
  onProgress?: (done: number, total: number) => void
  /** Stops the indexing between two batches. Rejects with an AbortError. */
  signal?: AbortSignal
  /**
   * Called with the result while the reading still holds the model slot (a
   * phone), so whoever waits for the slot finds what the caller wrote here.
   * Without it the slot was free before the caller had the result, and a
   * question that waited for the reading searched the documents from before
   * it (N3 on Android). A throw ends the reading with that error. On a
   * desktop there is no slot and it is simply called before the return.
   */
  onRead?: (result: { meta: DocumentMeta; chunks: TextChunk[] }) => void
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Indexing was cancelled.", "AbortError")
}

/**
 * SHA-256 of a file as hex, or undefined where the platform cannot compute
 * it. The phone uses it to tell that a file is already in the chat, whatever
 * it is called (N4).
 */
export async function documentContentHash(file: File): Promise<string | undefined> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return undefined
    const digest = await subtle.digest("SHA-256", await file.arrayBuffer())
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
  } catch {
    return undefined
  }
}

/** Is an answer being written by the model on this device? A cloud answer does not use the slot. */
function localAnswerRunning(except?: string): boolean {
  const { generating, runs } = useGenerationStore.getState()
  return Object.keys(generating).some((id) => id !== except && generating[id] && runs[id]?.lane !== "cloud")
}

export interface RetrieveOptions {
  /** The chat that asks. Its own run is not "another answer", and Stop in it ends the wait. */
  conversationId?: string
  /** Ends the wait for the slot. Without one, Stop in `conversationId` does. */
  signal?: AbortSignal
}

/**
 * Single slot: start the search only between two answers and when no
 * document is being read, and mark it from then on (lib/model-slot.ts,
 * beginSearchJob).
 *
 * Round 5 gave this rule to the reading and not to the search. A chat with
 * documents that sent while ANOTHER chat was being answered by the model on
 * this device unloaded that model in the middle of the answer, which ended
 * as a broken connection (review of round 6, finding 1). The check and the
 * mark happen in one step, so neither a send nor a reading can slip in
 * between: a send waits in builtin-ensure until the search has given the
 * chat model back. Stop ends the wait with the error of lib/slot-wait.ts
 * (isSearchStopped).
 */
async function beginSearchBetweenAnswers(opts?: RetrieveOptions): Promise<() => void> {
  const clear = () => !documentJobRunning() && !localAnswerRunning(opts?.conversationId)
  if (!clear()) {
    const handle = !opts?.signal && opts?.conversationId ? stopHandleFor(opts.conversationId) : null
    const signal = opts?.signal ?? handle?.signal
    try {
      await new Promise<void>((resolve, reject) => {
        const done = (err?: unknown) => {
          unsubscribeAnswers()
          unsubscribeSlot()
          signal?.removeEventListener("abort", onAbort)
          if (err) reject(err)
          else resolve()
        }
        const check = () => { if (clear()) done() }
        const onAbort = () => done(searchStoppedError())
        const unsubscribeAnswers = useGenerationStore.subscribe(check)
        const unsubscribeSlot = subscribeSlotTurn(check)
        signal?.addEventListener("abort", onAbort)
        if (signal?.aborted) onAbort()
        else check()
      })
    } finally {
      handle?.release()
    }
  }
  return beginSearchJob()
}

/**
 * Single slot: start the reading only between two answers, and mark it from
 * then on (lib/model-slot.ts, beginDocumentJob). A reading that started under
 * a running answer unloaded the chat model in the middle of it, and the
 * answer ended as a broken connection (N2). The check and the mark happen in
 * one step, so a send cannot slip in between. Cancelling ends the wait.
 */
async function beginReadingBetweenAnswers(signal?: AbortSignal): Promise<() => void> {
  // Also not under a chat model that is still being loaded (round 6, B4): the
  // two would share the processor, and the load ran into the 120 seconds the
  // engine gives it. On a phone without room for both, the reading would have
  // found "no chat model to move out of the way" and failed for memory.
  const busy = () => localAnswerRunning() || chatModelLoading()
  if (busy()) {
    markDocumentJobWaiting(true)
    try {
      await new Promise<void>((resolve, reject) => {
        const done = (err?: unknown) => {
          unsubscribeAnswers()
          unsubscribeSlot()
          signal?.removeEventListener("abort", onAbort)
          if (err) reject(err)
          else resolve()
        }
        const onAbort = () => done(new DOMException("Indexing was cancelled.", "AbortError"))
        const check = () => { if (!busy()) done() }
        const unsubscribeAnswers = useGenerationStore.subscribe(check)
        const unsubscribeSlot = subscribeSlotTurn(check)
        signal?.addEventListener("abort", onAbort)
        if (signal?.aborted) onAbort()
        else check()
      })
    } finally {
      markDocumentJobWaiting(false)
    }
  }
  return beginDocumentJob()
}

export async function indexDocument(
  file: File,
  embeddingModel = "nomic-embed-text",
  opts?: IndexOptions,
): Promise<{ meta: DocumentMeta; chunks: TextChunk[] }> {
  const mobile = isMobile()
  if (mobile && file.size > mobileRagLimits.maxFileBytes) {
    const mb = (n: number) => Math.max(1, Math.round(n / (1024 * 1024)))
    throw new DocumentTooLargeError(
      `"${file.name}" is too large for this device (${mb(file.size)} MB, the limit is ${mb(mobileRagLimits.maxFileBytes)} MB). Split it into smaller files and add them one at a time.`
    )
  }
  throwIfAborted(opts?.signal)
  const text = await extractText(file)
  const rawChunks = chunkText(text)
  if (mobile && rawChunks.length > mobileRagLimits.maxChunks) {
    throw new DocumentTooLargeError(
      `"${file.name}" is too long for this device (${rawChunks.length} passages, the limit is ${mobileRagLimits.maxChunks}). Split it into smaller files and add them one at a time.`
    )
  }
  // A desktop sends the whole document in one request, as it always has. A
  // phone sends it in batches: a request for 500 passages has no progress to
  // show, cannot be cancelled, and comes back as one 8 MB response.
  const batchSize = mobile ? Math.max(1, mobileRagLimits.batchSize) : Math.max(1, rawChunks.length)
  const embeddings: number[][] = []
  const endJob = singleModelSlot() ? await beginReadingBetweenAnswers(opts?.signal) : null
  embedderHolds += 1
  let embedderHeld = true
  const releaseEmbedder = async () => {
    if (!embedderHeld) return
    embedderHeld = false
    embedderHolds -= 1
    await releaseEmbedderAfterUse()
  }
  try {
    for (let start = 0; start < rawChunks.length; start += batchSize) {
      throwIfAborted(opts?.signal)
      const batch = rawChunks.slice(start, start + batchSize)
      const vectors = await generateEmbeddings(batch, embeddingModel, { purpose: "document-chat" })
      // Keep positions aligned even when a server answers with fewer rows.
      for (let i = 0; i < batch.length; i++) embeddings.push(vectors[i] ?? [])
      opts?.onProgress?.(Math.min(start + batch.length, rawChunks.length), rawChunks.length)
    }
    throwIfAborted(opts?.signal)
    // The chat model comes back first, as before. The job itself stays open
    // until the result is built and handed over (onRead): a send that waits
    // for the slot starts with the new document, not beside it.
    await releaseEmbedder()
    const result = await builtDocument(file, rawChunks, embeddings, mobile)
    opts?.onRead?.(result)
    return result
  } finally {
    try {
      await releaseEmbedder()
    } finally {
      // Last, so a waiting send finds the chat model loaded again.
      endJob?.()
    }
  }
}

/** Passages and vectors as the document the store keeps. */
async function builtDocument(
  file: File,
  rawChunks: string[],
  embeddings: number[][],
  mobile: boolean,
): Promise<{ meta: DocumentMeta; chunks: TextChunk[] }> {
  const docId = uuid()
  const chunks: TextChunk[] = rawChunks.map((content, index) => ({
    id: uuid(),
    documentId: docId,
    content,
    // A server that answers with FEWER rows than it was given inputs leaves the
    // tail undefined here, and `TextChunk.embedding` promises number[]. The
    // undefined then reached cosineSimilarity, whose `!a.length` guard throws
    // on it — so every later query against that document died with a raw
    // TypeError. Empty is the failure state the ranking is built to absorb.
    embedding: embeddings[index] ?? [],
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
  if (mobile) {
    const contentHash = await documentContentHash(file)
    if (contentHash) meta.contentHash = contentHash
  }

  return { meta, chunks }
}

export interface RetrieveResult {
  context: RAGContext
  scoredChunks: VectorSearchResult[]
}

/**
 * The passages to search: a list, or a function that answers with the list.
 * The function is asked AFTER the wait for the slot, so a search that waited
 * for a reading searches the documents as they are then (N3 on Android: the
 * list was taken before the wait, and the answer never saw the new file).
 */
export type ChunkSource = TextChunk[] | (() => TextChunk[] | Promise<TextChunk[]>)

export async function retrieveContext(
  query: string,
  source: ChunkSource,
  embeddingModel = "nomic-embed-text",
  topK = 5,
  opts?: RetrieveOptions,
): Promise<RetrieveResult> {
  let queryEmb: number[]
  let chunks: TextChunk[] = []
  // Single slot: a document that is being read right now is part of the
  // answer once it is there, and its reading owns the embedder until then.
  // And an answer the model on this device is writing in another chat must
  // not lose that model to this search. Resolves at once on a desktop.
  const endSearch = singleModelSlot() ? await beginSearchBetweenAnswers(opts) : null
  embedderHolds += 1
  try {
    if (typeof source === "function") {
      chunks = await source()
      // Nothing to search: no reason to load the document model for the question.
      if (chunks.length === 0) return { context: { chunks: [], query, documentIds: [] }, scoredChunks: [] }
    } else {
      chunks = source
    }
    ;[queryEmb] = await generateEmbeddings([query], embeddingModel, { purpose: "document-chat" })
  } finally {
    embedderHolds -= 1
    try {
      // Single slot: the chat model needs the room back before it answers.
      await releaseEmbedderAfterUse()
    } finally {
      // Last, so a waiting send finds the chat model loaded again.
      endSearch?.()
    }
  }
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
