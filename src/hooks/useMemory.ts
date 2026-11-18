/**
 * useMemory — Hook for memory operations including LLM-based auto-extraction.
 *
 * Fires a separate inference call to analyze conversation exchanges and
 * extract memorable information. Errors are caught silently — extraction
 * failures must never disrupt the chat experience.
 */

import { memoryExtractionRunId } from '../lib/silent-runs'
import { useMemoryStore } from '../stores/memoryStore'
import { useModelStore } from '../stores/modelStore'
import { useProviderStore } from '../stores/providerStore'
import { isCompatProviderId } from '../api/providers/compat-id'
import { getProviderForModel, getProviderIdFromModel } from '../api/providers'
import { useSettingsStore } from '../stores/settingsStore'
import { isMobile } from '../lib/device-kind'
import { isThinkingCompatible } from '../lib/model-compatibility'
import {
  buildExtractionPrompt,
  extractionContextRules,
  PHONE_EXTRACTION_RULES,
  alreadyKept,
  plainSelfStatement,
  retellsAQuestion,
  retellsTheAnswer,
  saysSomethingAboutTheUser,
  parseExtractionResponse,
  buildResolutionPrompt,
  parseResolutionResponse,
  type ExtractedMemory,
  type SimilarExisting,
} from '../lib/memory-extraction'
import { generateEmbeddings, cosineSimilarity } from '../api/rag'
import { singleModelSlot } from '../lib/capabilities'
import { loadVectors } from '../lib/memoryEmbedDB'
import { isForgotten } from '../lib/memory-forget'
import { silentCallAllowed, pickSilentCallModel } from '../lib/silent-model-calls'
import type { MemoryFile } from '../types/agent-mode'
import { useCloudAuthStore } from '../stores/cloudAuthStore'
import { runInLane } from '../lib/run-slot'
import { laneOf, currentLaneFacts } from '../lib/run-lane-of-model'

interface MemoryWriteGuard {
  current: () => boolean
  wrote: () => void
}

// Rate limit: only extract every Nth turn to reduce cost
let _extractCounter = 0
const EXTRACT_EVERY_N = 3
const MIN_RESPONSE_LENGTH = 100

/**
 * How long one silent extraction may hold the model, from the moment it gets
 * the lane until its last call is back. Everything in it counts: the
 * extraction call and each write-decision call after it.
 *
 * A warm model reads the pair (a voice digest is at most 12,000 characters)
 * and writes a short JSON object well inside a minute. One that needs longer
 * is being reloaded or is too slow for work nobody asked for, and for all of
 * that time the next visible turn waits behind it on the local lane. Measured
 * on 10.10.2026: a 27B that Ollama reloaded for this call ran 91 seconds.
 * When the limit is reached the request is closed, nothing more is saved and
 * nothing is shown.
 */
export const SILENT_EXTRACTION_LIMIT_MS = 60_000

/**
 * `false` where the model has a switch for its reasoning, otherwise undefined
 * (the field is left out). An extraction is one JSON object; a long think in
 * front of it only makes the model busy for longer.
 */
function silentThinking(callModel: string): false | undefined {
  const meta = useModelStore.getState().models.find((m) => m.name === callModel)
  const thinkMode = meta && 'thinkMode' in meta ? meta.thinkMode : undefined
  const canSwitchOff = thinkMode ? thinkMode === 'toggle' : isThinkingCompatible(callModel)
  return canSwitchOff ? false : undefined
}

// ── Write-decision similarity bands (Feature FF) ──────────────────
// Cosine of the new fact's embedding against the most-similar SAME-TYPE
// existing memory decides the write path:
//   sim <  ADD_THRESHOLD   → clearly new → addMemory (no extra LLM call)
//   ADD..NOOP (the "merge band") → ambiguous → one temp:0.1 resolution call
//   sim >= NOOP_THRESHOLD   → already captured → skip (no LLM call, no write)
// Thresholds are first-pass; need live MV3/MV4 validation before "tuned".
const ADD_THRESHOLD = 0.6
const NOOP_THRESHOLD = 0.92
// How many similar existing memories to show the resolver.
const RESOLUTION_TOP_K = 3

/**
 * The provider + model a SILENT memory call may run on, or null when the cost
 * policy forbids the call outright (plan 2.6.6 A7).
 *
 * Resolving it HERE, one level below every extraction path, is the point: the
 * gate and the cheap-model choice apply to `extractMemoriesFromPair` and to
 * the write-decision resolution alike, so no hook, listener or background job
 * has to remember them. Adding a caller cannot add a silent cloud call.
 *
 * lu-cloud without the opt-in → null → no request leaves the app.
 * lu-cloud with the opt-in → the cheapest catalogue model, not the active one.
 * Local / BYOK → the active model, ungated, exactly as before.
 */
function resolveSilentCall(
  activeModel: string,
): { provider: ReturnType<typeof getProviderForModel>['provider']; modelId: string; callModel: string } | null {
  const providerId = getProviderIdFromModel(activeModel)
  const { memoryCloudOptIn } = useSettingsStore.getState().settings
  if (!silentCallAllowed(providerId, memoryCloudOptIn)) return null
  const callModel = pickSilentCallModel(activeModel, providerId, useModelStore.getState().models)
  const { provider, modelId } = getProviderForModel(callModel)
  return { provider, modelId, callModel }
}

/**
 * Pure extraction routine — safe to call from anywhere (hooks, Tauri listeners,
 * background jobs). Fire-and-forget: never throws, errors are swallowed.
 *
 * The A7 cost policy lives INSIDE (see resolveSilentCall), so every caller
 * below inherits it without a line of its own.
 *
 * Used by:
 *  - useMemory().extractAndSave (LU chat)
 *  - useAgentChat (agent loop)
 *  - useCodex (codex loop)
 *  - AppShell.tsx remote-chat-message listener (Remote chats)
 *  - api/voice-history.ts (a voice session, once, when it ends)
 */
/** Did the last answer of this chat come with sources from its documents (hooks/useChat.ts, `sources`)? */
async function answeredFromDocuments(conversationId: string): Promise<boolean> {
  // Loaded here and not at the top: only a phone asks, and the chat store brings stores along that the
  // desktop paths of this file never needed.
  const { useChatStore } = await import('../stores/chatStore')
  const conversation = useChatStore.getState().conversations.find((c) => c.id === conversationId)
  const last = conversation?.messages.filter((m) => m.role === 'assistant' && !m.hidden).at(-1)
  return (last?.sources?.length ?? 0) > 0
}

export async function extractMemoriesFromPair(
  userMessage: string,
  assistantResponse: string,
  conversationId: string,
  options: {
    /**
     * Left out by every caller whose turn this app sent itself: the silent
     * calls in here then go out with the window the model was last sent
     * (`ollamaNumCtx` in api/ollama.ts), so Ollama never loads the model again
     * for them. `backend-default` is for the one turn the app did not send:
     * the phone talks to the backend through the remote bridge and names no
     * window, so the calls that follow it name none either.
     */
    window?: 'backend-default'
    scope?: string
    sourceKind?: MemoryFile['sourceKind']
    /**
     * The pair is a whole session in one piece (a voice session hands over
     * everything that was said when it ends). It is one call per session by
     * construction, so the every-Nth-turn limit below does not apply to it.
     * Every other gate does.
     */
    digest?: boolean
    /**
     * GH #255: the persona the chat speaks as (lib/chat-persona.ts,
     * extractionPersonaOf). The extraction spells its names the way it does.
     */
    persona?: { name: string; text: string }
  },
): Promise<void> {
  const scope = options.scope
  const sourceKind = options.sourceKind ?? 'chat'
  const turnWindow = options.window
  let unsubscribe: (() => void) | undefined
  let limit: ReturnType<typeof setTimeout> | undefined
  /** Phone only, see keepPlainSelfStatement. Stays null on a desktop. */
  let plainStatement: ExtractedMemory | null = null
  try {
    const { activeModel } = useModelStore.getState()
    if (!activeModel) return

    const memState = useMemoryStore.getState()
    if (!memState.settings.autoExtractEnabled) return

    // Skip short responses (not enough signal to extract)
    if (assistantResponse.length < MIN_RESPONSE_LENGTH) return

    // Phone only (second check on Android, F12; small iPhone, K12). A message
    // that says nothing about the user is not asked about, and an answer that
    // was written out of a document is not either: what a file says is never
    // "About you". Before the counter, so such a turn does not use up the slot
    // of a turn that does say something.
    const phone = isMobile()
    if (phone && (!saysSomethingAboutTheUser(userMessage) || (await answeredFromDocuments(conversationId)))) return

    // Rate limit: only extract every Nth turn. Not on a phone: the filter
    // above already drops every turn that says nothing about the user, and
    // of the turns that do say something two of three were thrown away here
    // (check 4 on Android, F1: "I am a nurse" twice, and nothing was asked).
    if (!phone && !options.digest) {
      _extractCounter++
      if (_extractCounter % EXTRACT_EVERY_N !== 0) return
    }

    // Warn-check: if cloud provider, check if user has opted in
    const providerState = useProviderStore.getState()
    const isCloud = (providerState.providers.openai.enabled && !providerState.providers.openai.isLocal) ||
      providerState.providers.anthropic.enabled ||
      // An extra OpenAI-compatible slot that points at a hosted API counts
      // the same as the shared slot doing so.
      Object.values(providerState.providers).some((p) => isCompatProviderId(p.id) && p.enabled && !p.isLocal)
    if (isCloud && !memState.settings.autoExtractInAllModes) return

    // Cost gate + cheapest suitable model (plan A7). Null = this call is not
    // allowed to happen at all; on lu-cloud without the opt-in that is the
    // default, and the turn ends here with no request on the wire.
    const call = resolveSilentCall(activeModel)
    if (!call) return
    const { provider, modelId, callModel } = call
    // Phone only: what the user said about themselves in plain words is kept
    // also when the model does not get it out, or is ended by the next
    // question (see keepPlainSelfStatement below).
    if (phone) plainStatement = plainSelfStatement(userMessage)
    let expectedEntries = memState.entries
    const collectionRevision = memState.memoryCollectionRevision
    let revoked = false
    unsubscribe = useCloudAuthStore.subscribe((state, previous) => {
      if (state.status !== previous.status || state.user?.id !== previous.user?.id) revoked = true
    })
    const extractionAbort = new AbortController()
    const guard: MemoryWriteGuard = {
      current: () => {
        const current = useMemoryStore.getState()
        // A call that was cut short (a model control, the time limit, sign-out)
        // writes nothing after the cut, whatever is still in flight.
        if (extractionAbort.signal.aborted) revoked = true
        if (current.entries !== expectedEntries || current.memoryCollectionRevision !== collectionRevision || !current.settings.autoExtractEnabled) revoked = true
        return !revoked
      },
      wrote: () => { expectedEntries = useMemoryStore.getState().entries },
    }

    // Runde 4 (review-lanes.md Blocker 1+6): this silent call books into the
    // local lane too. Before this it ran straight against
    // `provider.chatStream`, unregistered anywhere run-lanes.ts could see it.
    // The visible turn that triggers it (`void extractMemoriesFromPair(...)`
    // in useAgentChat.ts and useCodex.ts) fires this call WHILE ITS OWN
    // `runInLane` body is still running, unawaited. An unmanaged local call
    // here could then land on the built-in engine or Ollama at the exact
    // moment the visible turn finishes and the next queued conversation gets
    // admitted: the VRAM-swap race this whole module exists to prevent,
    // started one level up from where run-lanes.ts can see it.
    //
    // The booking identity below is deliberately NOT `conversationId` itself.
    // `run-slot.ts` tracks same-conversation re-entry with a depth counter so
    // a foreground sub-agent can call back into its own parent's lane without
    // deadlocking; that counter is still greater than zero right now, because
    // the visible turn's own `runInLane` body has not returned yet. Booking
    // under the real id would silently take the fast re-entry path, run this
    // call immediately, and register nothing that keeps the lane held once
    // the visible turn's own body finishes and releases behind it: exactly
    // the unmanaged race this change is meant to close. A distinct suffixed
    // id is a different identity to `admit`, so it queues for real behind
    // whichever run currently holds the lane (the visible turn, still
    // running) and gets its own real `release`. It cannot deadlock the way
    // the sub-agent case can: extraction never blocks the visible turn on
    // itself (it is `void`-fired, never awaited by the turn), so there is no
    // cycle for a real queue wait to close.
    //
    // Runde 5 Folgeposten 3 (review-lanes.md Runde 2, Punkt 5 Fund 4): a
    // RUNNING extraction used to be unstoppable: `abort: () => {}` was a
    // literal no-op, so `stopAllBackgroundWork` (sign-out, window close, app
    // quit) reached a QUEUED extraction (pulls it out of the waiting room,
    // it never runs) but not a running one: the stream kept going to
    // completion after the user believed they had signed out, on a silent
    // model call that still bills lu-cloud. A real `AbortController` closes
    // that: `abort()` cancels the in-flight fetch, the `for await` loop below
    // sees its `AbortError`, and the outer `catch` already swallows every
    // extraction failure (silent by contract, always was).
    const thinking = silentThinking(callModel)
    await runInLane(
      { conversationId: memoryExtractionRunId(conversationId), lane: laneOf(callModel, currentLaneFacts()), abort: () => extractionAbort.abort() },
      async () => {
        // The clock starts when the call gets the lane, not while it waits
        // behind a visible turn: only from here on does it hold the model.
        limit = setTimeout(() => extractionAbort.abort(), SILENT_EXTRACTION_LIMIT_MS)
        if (!guard.current()) return

        // Re-read immediately before the request; protected or other-project
        // titles must not leak through the extraction deduplication summary.
        const existingSummary = useMemoryStore.getState().entries
          .filter(e => !e.sensitive && !e.stale && e.scope === scope)
          .slice(-20).map(e => `- [${e.type}] ${e.title}`).join('\n')
        const rules = [...extractionContextRules(options.persona), ...(phone ? PHONE_EXTRACTION_RULES : [])]
        const messages = buildExtractionPrompt(userMessage, assistantResponse, existingSummary, rules)
        // Collect full response via streaming
        let fullResponse = ''
        const stream = provider.chatStream(modelId, messages, {
          temperature: 0.1,
          // 800 tokens leaves headroom for models that pad the JSON with prose
          // or a short think block. At 500 the extraction tore off mid-object
          // and the whole turn was lost without a word. Same number as the web.
          maxTokens: 800,
          // No window of its own (see the option).
          window: turnWindow,
          thinking,
          signal: extractionAbort.signal,
        })

        for await (const chunk of stream) {
          if (!guard.current()) return
          if (chunk.content) fullResponse += chunk.content
          if (chunk.done) break
        }

        // Parse and save: each memory goes through embedding-based
        // write-decision resolution (ADD / UPDATE / NOOP) instead of a blind
        // addMemory.
        const result = parseExtractionResponse(fullResponse)
        if (result.shouldSave) {
          for (const memory of result.memories) {
            if (!guard.current()) return
            // A27: the user deleted this fact. Not written back, not merged
            // into another memory either (the merge band would carry it over).
            if (isForgotten(useMemoryStore.getState().forgotten, memory)) continue
            // Phone only: "User Inquiry about ..." is the question told again, not a fact about the user,
            // and "Assistant explained ..." is the answer told again.
            if (phone && (retellsAQuestion(memory) || retellsTheAnswer(memory))) continue
            if (memory.type === 'user') plainStatement = null
            // Serial per-memory so the second (resolution) LLM call is
            // bounded and we don't fire N concurrent inferences. Each is
            // wrapped so one bad memory never aborts the rest.
            try {
              await resolveAndSaveMemory(memory, conversationId, scope, sourceKind, guard, extractionAbort.signal, turnWindow)
            } catch {
              if (!guard.current()) return
              // Per-memory failure: fall back to a plain add so the fact
              // isn't lost.
              memState.addMemory({
                type: memory.type,
                title: memory.title,
                description: memory.description,
                content: memory.content,
                tags: memory.tags,
                source: conversationId,
                scope,
                sourceKind,
              }, { auto: true })
              guard.wrote()
            }
          }
        }
      },
    )
  } catch {
    // Extraction failures are non-critical — silently swallowed
  } finally {
    clearTimeout(limit)
    unsubscribe?.()
    if (plainStatement) keepPlainSelfStatement(plainStatement, conversationId, scope, sourceKind)
  }
}

/**
 * Phone only. The model was asked and kept nothing about the user (or could
 * not be read, or was ended by the next question), and the message carries a
 * plain statement about the user: that statement is kept in the user's own
 * words. Never twice, and never when learning was switched off meanwhile.
 */
function keepPlainSelfStatement(memory: ExtractedMemory, conversationId: string, scope: string | undefined, sourceKind: MemoryFile['sourceKind']): void {
  try {
    const state = useMemoryStore.getState()
    if (!state.settings.autoExtractEnabled) return
    if (alreadyKept(memory, state.entries.filter((e) => e.scope === scope))) return
    state.addMemory({ type: memory.type, title: memory.title, description: memory.description, content: memory.content, tags: memory.tags, source: conversationId, scope, sourceKind })
  } catch {
    // Silent by contract, like everything in here.
  }
}

/** Pure: the same words, case, spaces and the closing mark aside. */
function sameWords(a: string, b: string): boolean {
  const norm = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
  return norm(a) !== '' && norm(a) === norm(b)
}

/**
 * Resolve a single freshly-extracted memory against existing SAME-TYPE
 * memories using embedding similarity, then write it via the right path:
 *
 *   - sim < ADD_THRESHOLD          → addMemory (today's behavior)
 *   - ADD_THRESHOLD ≤ sim < NOOP   → "merge band": one temp:0.1 resolution
 *                                    call → applyWriteDecision (ADD/UPDATE/NOOP)
 *   - sim ≥ NOOP_THRESHOLD         → near-duplicate → skip (NO LLM call)
 *
 * Fire-and-forget contract: any embedding/LLM failure falls back to a plain
 * addMemory so a fact is never silently dropped. Never blocks the chat turn.
 */
async function resolveAndSaveMemory(memory: ExtractedMemory, conversationId: string, scope: string | undefined, sourceKind: MemoryFile['sourceKind'], guard: MemoryWriteGuard, abortSignal: AbortSignal, turnWindow: 'backend-default' | undefined): Promise<void> {
  const memState = useMemoryStore.getState()
  const addPlain = (): string => {
    if (!guard.current()) return ''
    const id = memState.addMemory({
      type: memory.type,
      title: memory.title,
      description: memory.description,
      content: memory.content,
      tags: memory.tags,
      source: conversationId,
      sourceKind,
      scope,
    }, { auto: true })
    guard.wrote()
    return id
  }

  // Same-type, non-stale existing memories are the only merge candidates —
  // a "user" fact never merges into a "reference", etc.
  const sameType: MemoryFile[] = memState.entries.filter(
    (e) => e.type === memory.type && e.stale !== true && !e.sensitive && e.scope === scope,
  )
  if (sameType.length === 0) {
    addPlain()
    return
  }

  // Embed the new fact (title + content, mirroring the store's embedText).
  let newVec: number[] | null = null
  try {
    // One model slot: a phone does not load the embedder to compare two
    // memories. Without a vector the fact is simply added, as when the
    // embedding backend is unreachable.
    if (!singleModelSlot()) {
      const [vec] = await generateEmbeddings([`${memory.title}\n${memory.content}`], 'nomic-embed-text', { purpose: 'memory' })
      if (vec && vec.length > 0) newVec = vec
    }
  } catch {
    // Ollama unreachable → can't compute similarity → just add (offline-safe).
  }
  if (!guard.current()) return
  if (!newVec) {
    // Phone only: without a vector the one comparison left is the words. The same fact, said in
    // three messages, comes back from the model three times and was kept three times.
    if (isMobile() && sameType.some((e) => sameWords(e.title, memory.title) || sameWords(e.content, memory.content))) return
    addPlain()
    return
  }

  // Hydrate vectors for same-type candidates and find the most similar one.
  const vecMap = await loadVectors(sameType.map((e) => e.id))
  if (!guard.current()) return
  let bestSim = -1
  let bestEntry: MemoryFile | null = null
  const scored: Array<{ entry: MemoryFile; sim: number }> = []
  for (const e of sameType) {
    const rec = vecMap.get(e.id)
    if (!rec || rec.dim !== newVec.length) continue
    const sim = cosineSimilarity(newVec, rec.vector)
    scored.push({ entry: e, sim })
    if (sim > bestSim) {
      bestSim = sim
      bestEntry = e
    }
  }

  // No comparable vectors yet (candidates not embedded) → treat as new.
  if (!bestEntry || bestSim < 0) {
    addPlain()
    return
  }

  // Near-duplicate → already captured → skip entirely (NO second LLM call).
  if (bestSim >= NOOP_THRESHOLD) return

  // Clearly distinct → add as new (NO second LLM call).
  if (bestSim < ADD_THRESHOLD) {
    addPlain()
    return
  }

  // ── Merge band: ambiguous. Ask the LLM to resolve. ────────────
  const topK: SimilarExisting[] = scored
    .sort((a, b) => b.sim - a.sim)
    .slice(0, RESOLUTION_TOP_K)
    .map(({ entry }) => ({ id: entry.id, title: entry.title, content: entry.content }))

  // Add the candidate first so an UPDATE can mark it superseded and a parse
  // failure (→ ADD) still keeps the fact. NOOP removes it again below.
  const newId = addPlain()

  let decision
  try {
    const { activeModel } = useModelStore.getState()
    if (!activeModel) return // candidate already added; leave as ADD
    // Second silent call of the turn — same cost policy as the extraction
    // itself (plan A7). Gated out means the candidate simply stays a plain
    // ADD, which is the same outcome a failed resolution already produces.
    const call = resolveSilentCall(activeModel)
    if (!call) return
    const { provider, modelId, callModel } = call
    if (!guard.current()) return
    const currentEntries = useMemoryStore.getState().entries
    if (topK.some(candidate => !currentEntries.some(entry => entry.id === candidate.id && !entry.sensitive && entry.scope === scope && entry.content === candidate.content))) return
    const messages = buildResolutionPrompt(
      { title: memory.title, content: memory.content },
      topK,
    )
    let full = ''
    // Like the extraction call a moment ago, no window of its own.
    const stream = provider.chatStream(modelId, messages, {
      temperature: 0.1, maxTokens: 300, window: turnWindow, thinking: silentThinking(callModel), signal: abortSignal,
    })
    for await (const chunk of stream) {
      if (!guard.current()) return
      if (chunk.content) full += chunk.content
      if (chunk.done) break
    }
    decision = parseResolutionResponse(full, topK.map((t) => t.id))
  } catch {
    // Resolution call failed → leave the candidate as a plain ADD.
    return
  }

  if (!guard.current()) return

  if (decision.action === 'ADD') {
    // Already added as `newId` — nothing more to do.
    return
  }
  if (decision.action === 'NOOP') {
    // Duplicate after all → undo the speculative add.
    if (newId) useMemoryStore.getState().removeMemory(newId)
    guard.wrote()
    return
  }
  // UPDATE: merge into the target, mark the speculative candidate superseded.
  useMemoryStore.getState().applyWriteDecision(decision, { newId: newId || undefined })
  guard.wrote()
}

/**
 * The hook's surface, built once at module load.
 *
 * `extractMemoriesFromPair` is a module function — it closes over nothing from
 * a render, so it is already as stable as a value gets and there was nothing
 * for `useCallback` to memoise. Wrapping it also broke React 19's `use-memo`
 * rule, which insists the memo hooks take an inline function so the compiler
 * can see what it is memoising. Handing back a frozen object keeps the
 * identity every consumer had.
 */
const MEMORY_API = Object.freeze({
  /**
   * Fire-and-forget extraction: asks the active LLM to analyze a conversation
   * exchange and save any extracted memories. Rate-limited to every 3rd turn
   * and skips short responses.
   */
  extractAndSave: extractMemoriesFromPair,
})

export function useMemory() {
  return MEMORY_API
}
