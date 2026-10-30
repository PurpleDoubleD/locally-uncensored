/**
 * Recall for long chats (B33): the runner. Embeds the messages a compaction
 * keeps out of the payload, on this machine only, and picks the ones that
 * relate to the new message. See chat-recall.ts for the why.
 *
 * Local means local: it asks the same lane question as Document Chat
 * (api/embed-availability.ts) and runs only on the bundled embeddings server
 * or an Ollama on loopback. An Ollama on another host would receive every old
 * message of the chat, so that lane is refused, and so is "none". Any failure
 * answers '' and the turn goes on without recall.
 */
import { generateEmbeddings } from '../api/rag'
import { embeddingLane, laneIsOnThisMachine } from '../api/embed-availability'
import { log } from './logger'
import {
  RECALL_EMBED_PER_TURN, formatRecall, pickRecall, recallCandidates, recallHash,
  type RecallMessage,
} from './chat-recall'
import type { StoredCompaction } from './compact-summary'
import { loadRecallVectors, saveRecallVectors, type RecallVectorRecord } from './chatRecallDB'

export interface RecallTurn {
  conversationId: string
  messages: readonly RecallMessage[]
  compactions: readonly (StoredCompaction | null | undefined)[] | null | undefined
  /** The new user message. */
  query: string
  embeddingModel: string
}

/** The recall note for this turn, or ''. */
export async function recallForTurn(turn: RecallTurn): Promise<string> {
  const query = turn.query.trim()
  if (!query) return ''
  const candidates = recallCandidates(turn.messages, turn.compactions)
  if (candidates.length === 0) return ''
  try {
    const { lane } = await embeddingLane(turn.embeddingModel)
    if (!laneIsOnThisMachine(lane)) return ''

    const stored = await loadRecallVectors(turn.conversationId, candidates.map((c) => c.id))
    const fresh = (id: string, text: string) => {
      const rec = stored.get(id)
      return rec && rec.model === turn.embeddingModel && rec.contentHash === recallHash(text) ? rec : null
    }
    const missing = candidates.filter((c) => !fresh(c.id, c.text)).slice(-RECALL_EMBED_PER_TURN)
    const [queryVec, ...vectors] = await generateEmbeddings([query, ...missing.map((c) => c.text)], turn.embeddingModel)
    if (!queryVec?.length) return ''
    const records: Array<[string, RecallVectorRecord]> = []
    missing.forEach((c, i) => {
      const v = vectors[i]
      if (!v?.length) return
      const rec = { model: turn.embeddingModel, dim: v.length, vector: v, contentHash: recallHash(c.text) }
      stored.set(c.id, rec)
      records.push([c.id, rec])
    })
    void saveRecallVectors(turn.conversationId, records).catch((err) => log.warn('[recall] could not store vectors', { err: String(err) }))

    const picked = pickRecall(
      queryVec,
      candidates.map((c) => ({ ...c, vector: fresh(c.id, c.text)?.vector ?? null })),
    )
    // Counts only, never text: the log is for "did it run", not for content.
    log.info('[recall] turn', { lane, candidates: candidates.length, embedded: records.length, picked: picked.length })
    return formatRecall(picked)
  } catch (err) {
    log.warn('[recall] skipped for this turn', { err: String(err) })
    return ''
  }
}
