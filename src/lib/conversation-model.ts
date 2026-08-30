/**
 * Which model a conversation ran on.
 *
 * Meldung 4 of the R5 re-measure on the 2.6.7 Windows build (2026-08-30). The
 * app names a model beside every chat, and that name was always the globally
 * picked one, never the chat's. Three measured cases on the box:
 *
 *   - global set to mlabonne_gemma-3-4b, then the 12 hour old chat PROBE-C
 *     opened: it read mlabonne_gemma-3-4b. Every answer in it came from Hermes.
 *   - global set to Qwen3-4B, then KANARIE2 (13 h old) and R5N-A opened: both
 *     read Qwen3-4B.
 *   - the display read Hermes while the last answer of the open chat came
 *     provably from Qwen3-4B.
 *
 * The saved history could not have answered better: it kept a `model` field
 * per CONVERSATION and none per message (0 hits for a message level "model" in
 * store_backup.json). Once two models have answered in one chat, the model of
 * the last answer is not derivable from that at all. And a single-answer chat
 * was wrong too: a slip into Cloud mode sent one question to
 * google/gemma-4-26B-A4B-it while the saved record for that same conversation
 * read openai::Hermes-3-Llama-3.2-3B.Q4_K_M.
 *
 * So every assistant turn now records the model that produced it, and this is
 * the one reader for "which model does this conversation speak with". It never
 * looks at the global pick.
 *
 * Old messages carry no model field and none is invented for them. No
 * migration writes anything into them either: a guess written to disk is
 * indistinguishable from a measurement a week later. They fall back to the
 * conversation field, which is exactly what was known before and no more.
 */

import type { Conversation, Message } from '../types/chat'

/** The conversation shape this needs. Kept structural so a caller with a
 *  partial conversation (a test, an export of one chat) can ask too. */
export interface ConversationModelSource {
  model?: string
  messages?: Pick<Message, 'role' | 'modelId'>[]
}

/**
 * The model of the last assistant answer, or the conversation field when no
 * answer names one, or '' when neither does.
 *
 * `''` on purpose rather than the active pick: a chat that has never run is a
 * chat with nothing to claim, and the picker beside it already says what the
 * NEXT answer would run on.
 */
export function conversationModel(conv: ConversationModelSource | null | undefined): string {
  if (!conv) return ''
  const messages = conv.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const id = m.modelId?.trim()
    if (id) return id
    // An assistant turn from before this was recorded. It is the newest thing
    // we have and it says nothing, so nothing further back can say more:
    // fall through to what the conversation knows.
    break
  }
  return conv.model?.trim() ?? ''
}

/**
 * Does the open chat need to say what it ran on, next to a picker that says
 * something else.
 *
 * Only then. A chat whose answers came from the model that is picked right now
 * would just have the same name printed twice, and a chat with no answers yet
 * has nothing to report.
 */
export function conversationModelDiffers(
  conv: ConversationModelSource | null | undefined,
  activeModel: string | null,
): boolean {
  const ran = conversationModel(conv)
  if (!ran) return false
  const hasAnswer = (conv?.messages ?? []).some((m) => m.role === 'assistant')
  if (!hasAnswer) return false
  return ran !== (activeModel ?? '')
}

/** Full conversation objects go through the same reader. */
export function conversationModelOf(conv: Conversation): string {
  return conversationModel(conv)
}
