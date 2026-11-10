/**
 * Pure: what of an answer is not plain text. The thinking of the model, its
 * tool calls and the notes it wrote between them. The answer text itself is
 * drawn by the chat page.
 */
import type { AgentToolCall } from '../../../../types/agent-mode'
import type { CompactionRecord, Message } from '../../../../types/chat'
import { compactionAnchors } from '../../../../lib/compact-summary'
import { explicitSearchQuery } from '../../../../lib/explicit-search'
import { hasUnrecoveredFailure } from '../../../../lib/recovered-failure'
import { stripModelNoise } from '../../../../lib/strip-model-noise'
import { hiddenFromTranscript } from '../../../../lib/transcript-visibility'

export type BlockItem = { kind: 'call'; call: AgentToolCall } | { kind: 'note'; id: string; text: string; phase: 'thinking' | 'reflection' | 'planning' }

export interface BlocksView {
  /** The reasoning the model sent next to its answer, cleaned of template noise. */
  thinking: string
  /** Tool calls and notes in the order they happened. */
  items: BlockItem[]
  calls: AgentToolCall[]
}

export function viewBlocks(message: Pick<Message, 'thinking' | 'agentBlocks'>): BlocksView {
  const items: BlockItem[] = []
  const calls: AgentToolCall[] = []
  for (const block of message.agentBlocks ?? []) {
    if (block.phase === 'tool_call') {
      const own = block.toolCalls?.length ? block.toolCalls : block.toolCall ? [block.toolCall] : []
      for (const call of own) {
        // The plan has its own band above the transcript; showing the call again would say it twice.
        if (hiddenFromTranscript(call)) continue
        items.push({ kind: 'call', call })
        calls.push(call)
      }
      continue
    }
    if (block.phase === 'answer') continue
    const text = stripModelNoise(block.content ?? '', { aggressive: true }).trim()
    if (text) items.push({ kind: 'note', id: block.id, text, phase: block.phase })
  }
  return { thinking: stripModelNoise(message.thinking ?? '').trim(), items, calls }
}

/**
 * Words with which an answer presents something as the result of a tool:
 * a source tag, "search results", "according to my search", a "Source:" line.
 * Deliberately few and plain. Missing a claim is cheaper than accusing an
 * honest answer.
 */
const TOOL_CLAIMS: readonly RegExp[] = [
  /<\/?source\b[^>]*>/i,
  /\b(?:web )?search results?\b/i,
  /\b(?:according to|based on|from) (?:the|my|these|this) (?:web )?(?:search|results?|sources?)\b/i,
  /\bI(?: have|'ve)? (?:searched|looked (?:it|this|that) up|found the following)\b/i,
  /^\s*(?:[-*]\s*)?\**(?:sources?|references?)\**\s*:/im,
  /\bsource:\s*\S/i,
]

/** Pure: does this text present something as found by a tool. */
export function claimsToolResults(text: string): boolean {
  return !!text && TOOL_CLAIMS.some((pattern) => pattern.test(text))
}

/**
 * Pure: an answer of an agent run that names search results or sources
 * although no tool ran for it (acceptance Android, re-run, N4, and iOS small,
 * N6: a model too small for tools answered "<source></source>", another one
 * invented a list of search results). The answer stays as the model wrote
 * it. The chat says under it that nothing was looked up, so invented results
 * are not read as sources.
 *
 * Only for a message of an agent run (it carries `agentBlocks`, even when
 * empty), only once the run ended, and never when a tool did run: then the
 * check for links no tool returned (lib/unbacked-links.ts) is the right one.
 */
export function claimsResultsWithoutTool(message: Pick<Message, 'role' | 'content' | 'agentBlocks'>): boolean {
  if (message.role !== 'assistant' || !Array.isArray(message.agentBlocks)) return false
  const ranTool = message.agentBlocks.some((block) => block.phase === 'tool_call' && ((block.toolCalls?.length ?? 0) > 0 || !!block.toolCall))
  if (ranTool) return false
  const answers = message.agentBlocks.filter((block) => block.phase === 'answer').map((block) => block.content ?? '')
  return claimsToolResults([message.content ?? '', ...answers].join('\n'))
}

const DONE_CLAIMS: readonly RegExp[] = [
  /\b(?:has|have|was|were) (?:now )?(?:been )?(?:successfully )?(?:written|saved|created|updated|edited|deleted|removed|sent|added|stored)\b/i,
  /\bsuccessfully (?:written|wrote|saved|created|updated|edited|deleted|removed|sent|added|stored)\b/i,
  /\bI(?: have|'ve)? (?:written|wrote|saved|created|updated|edited|deleted|removed|added|stored)\b/i,
  /\bfile saved\b/i,
]

/** A sentence with one of these says that something did not happen. */
const NOT_DONE = /\b(?:not|nothing|never|no|unable|cannot|failed|without)\b|n't\b/i

/**
 * Pure: does this text say that something was written, saved or changed.
 * Sentence by sentence, so "nothing was written" is not read as "was written".
 */
export function claimsDone(text: string): boolean {
  if (!text) return false
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .some((sentence) => !NOT_DONE.test(sentence) && DONE_CLAIMS.some((pattern) => pattern.test(sentence)))
}

/**
 * Pure: an answer of an agent run that says something was done, although
 * every step of the run was declined or failed (round 9, N7 on Android: the
 * user tapped "Deny", and Qwen3 1.7B answered "The file notes.md has been
 * successfully written" under "2 steps, 2 failed"). The model was told that
 * nothing ran (lib/rejected-call.ts); a small one says so anyway. The answer
 * stays as it was written, and the chat says under it that nothing was done.
 *
 * Not when one step went through: then something was done, and which claim
 * belongs to which step is not for a pattern to decide.
 */
export function claimsDoneWithoutStep(message: Pick<Message, 'role' | 'content' | 'agentBlocks'>): boolean {
  if (message.role !== 'assistant' || !Array.isArray(message.agentBlocks)) return false
  const calls = message.agentBlocks.flatMap((block) => (block.phase === 'tool_call' ? (block.toolCalls?.length ? block.toolCalls : block.toolCall ? [block.toolCall] : []) : []))
  if (calls.length === 0) return false
  if (calls.some((call) => call.status !== 'rejected' && call.status !== 'failed' && call.status !== 'stopped')) return false
  const answers = message.agentBlocks.filter((block) => block.phase === 'answer').map((block) => block.content ?? '')
  return claimsDone([message.content ?? '', ...answers].join('\n'))
}

/**
 * Pure: the user ordered a web search in so many words, and the answer of
 * that run carries no search and no page read (re-check on Android 8 GB, N2:
 * "Search the web: ...", an invented answer or "I cannot search the web", and
 * nothing under it). On a phone the loop runs an ordered search itself
 * (lib/explicit-search.ts); this is what is left where it could not, for
 * example with the web blocked for this chat. Said under the answer, so an
 * answer from memory is not read as one from the web.
 */
export function orderedSearchDidNotRun(userText: string | undefined, message: Pick<Message, 'role' | 'content' | 'agentBlocks'>): boolean {
  if (message.role !== 'assistant' || !Array.isArray(message.agentBlocks)) return false
  if (!userText || explicitSearchQuery(userText) === null) return false
  const calls = message.agentBlocks.flatMap((block) => (block.phase === 'tool_call' ? (block.toolCalls?.length ? block.toolCalls : block.toolCall ? [block.toolCall] : []) : []))
  return !calls.some((call) => call.toolName === 'web_search' || call.toolName === 'web_fetch' || call.toolName === 'web_research')
}

/** Pure: what the user typed for the run this answer belongs to. */
export function userTextBefore(messages: readonly Pick<Message, 'id' | 'role' | 'content' | 'displayContent'>[], messageId: string): string | undefined {
  const at = messages.findIndex((m) => m.id === messageId)
  for (let i = at - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user') return m.displayContent ?? m.content
  }
  return undefined
}

export type BandState = 'running' | 'failed' | 'done'

export interface BandSummary {
  count: number
  failed: number
  state: BandState
}

/** Pure: the head line of several calls. A failure the model repaired later does not count. */
export function summarizeCalls(calls: readonly AgentToolCall[]): BandSummary {
  const running = calls.some((c) => c.status === 'running' || c.status === 'pending_approval')
  const failed = calls.filter((c) => c.status === 'failed' || c.status === 'rejected').length
  const bad = hasUnrecoveredFailure(calls)
  return { count: calls.length, failed, state: running ? 'running' : bad ? 'failed' : 'done' }
}

/**
 * Pure: the compactions drawn after this message. The chat page calls the
 * slot only for answers, so the line of a compaction sits on the last
 * visible answer at or before its cut.
 */
export function compactionsAfter(messages: readonly Message[], compactions: readonly CompactionRecord[] | undefined, messageId: string): CompactionRecord[] {
  if (!compactions?.length) return []
  const visible = messages.filter((m) => !m.hidden && m.role === 'assistant').map((m) => m.id)
  return compactionAnchors(messages, visible, compactions).get(messageId) ?? []
}

/** Cut a long result for the first view. The rest is one tap away. */
export const RESULT_PREVIEW_CHARS = 1500

export function previewOf(text: string, max = RESULT_PREVIEW_CHARS): { shown: string; more: number } {
  if (text.length <= max) return { shown: text, more: 0 }
  return { shown: text.slice(0, max), more: text.length - max }
}

/** How much of a thought is shown while it is still being written. */
export const THOUGHT_TAIL_CHARS = 480

/**
 * The end of a thought that is still growing, cut at a word. The whole text
 * would push the transcript away line by line; the end is what moves, and
 * that is what says "the model is working". The finished block shows all.
 */
export function thoughtTail(thinking: string, max = THOUGHT_TAIL_CHARS): string {
  if (thinking.length <= max) return thinking
  const tail = thinking.slice(-max)
  const space = tail.indexOf(' ')
  return `... ${space >= 0 && space < 40 ? tail.slice(space + 1) : tail}`
}
