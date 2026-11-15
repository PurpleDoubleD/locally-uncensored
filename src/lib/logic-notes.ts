/**
 * The sentences the logic layer writes into an answer that are not the answer.
 *
 * The chat hook and the agent loop tell the desktop what went wrong by writing
 * a sentence into `content`: the bubble of the desktop shows it. Some of these
 * paths also write the field (`Message.error`), most do not. A reader that
 * takes `content` for the text of the answer then shows the sentence as if the
 * model had said it, copies it, reads it aloud and puts it into the preview of
 * the chat list (acceptance on the large iPhone, G8: "The connection dropped
 * before the model finished its answer" as the answer of a model on the phone).
 *
 * `splitLogicNote` is the one place that knows these sentences. It is built
 * from the constants the writers use, so a changed wording is followed. The
 * few sentences that are literals in the hooks are pinned by a test that reads
 * the hooks (lib/__tests__/logic-notes.test.ts).
 *
 * Pure. `lib/message-error.ts` asks it for every message without the field.
 */
import type { MessageErrorKind } from '../types/chat'
import { DISCONNECT_WITHOUT_ANSWER } from './answer-notes'
import { CREDITS_EXHAUSTED_MESSAGE } from './credits-exhausted'
import { SERVER_LOOP_MESSAGE } from './agent-core/server-loop-cut'
import { MULTIMODAL_UNSUPPORTED_MESSAGE } from './ollama-errors'
import { IMAGE_PART_NONE_HEAD, IMAGE_PART_NOT_LOADED_HEAD, IMAGE_PART_RELOADED_HEAD } from './image-part-notes'
import { PLATFORM_TEXTS } from './platform-text'
import { requestLimitMessage } from './request-limit'
import { BAD_REQUEST_SENTENCE, TEMPLATE_REFUSAL_SENTENCE } from './template-refusal'

export interface LogicNote {
  /** The text of the answer in front of the sentence. */
  body: string
  /** 'empty' is the reader's word for "nothing came back". */
  kind: MessageErrorKind | 'empty'
  /** What the error box says under its title. Empty when the kind says it all. */
  detail: string
  /** `detail` is the raw reason of a failed run: the reader finds the kind from its wording, as for "Error: ...". */
  raw?: true
}

/** Start of the sentence of lib/answer-notes.ts for a token budget that ran out before any text. */
export const HIT_TOKEN_LIMIT = 'The model hit its token limit before writing an answer.'
/** Start of the sentence of lib/answer-notes.ts for an answer that lost its model to a pick before any text (lib/model-switch-stop.ts). */
export const SWITCHED_MODEL_HEAD = 'Stopped because you switched to another model before this answer was written.'
/** The sentence of lib/answer-notes.ts for an empty turn with nothing to explain it. */
export const NO_VISIBLE_ANSWER = "I didn't return a visible answer that time, please try again."
/** The two sentences of lib/answer-notes.ts for "it thought and never answered". */
export const THINKING_ATE_ANSWER = /^The model (finished thinking but never wrote an answer|spent its entire token budget thinking)/
/** Literal in hooks/useChat.ts and hooks/useAgentChat.ts. */
export const THINKING_UNSUPPORTED_HEAD = 'This model does not support thinking mode.'
/** What the agent loop wrote after a rate limit that did not clear, up to 2.5. It stands in chats saved back then. */
export const RATE_LIMIT_HEAD = 'The server is limiting how many requests this account may send'
/**
 * Start of the app's own sentence for a request limit (lib/request-limit.ts),
 * for a message without the field. The sentence of the server has no wording
 * to know it by: the agent loop writes the field for it (kind 'limit').
 */
export const REQUEST_LIMIT_FALLBACK_HEAD = requestLimitMessage({}).split('. ')[0] + '.'
/** Literal in hooks/useAgentChat.ts, the last branch of its catch. */
export const AGENT_ERROR_HEAD = 'Agent error: '

/** What the phone says for a model that cannot think. The sentence of the hook names a button of the desktop. */
const THINKING_UNSUPPORTED_DETAIL = 'This model does not support thinking. Turn Thinking off for this chat, or pick another model.'

function bothWordings(key: keyof typeof PLATFORM_TEXTS): string[] {
  const w = PLATFORM_TEXTS[key]
  return [w.desktop, w.mobile]
}

/** Up to the first variable of a platform text, so a sentence with details is found by its start. */
function headOf(text: string): string {
  const at = text.indexOf('{')
  const head = at < 0 ? text : text.slice(0, at)
  // The start of the first paragraph is enough to know the sentence, and it survives a changed ending.
  return head.split('\n')[0].trim()
}

interface TailRule {
  heads: readonly string[]
  read: (tail: string, cloud: boolean) => Pick<LogicNote, 'kind' | 'detail'>
}

/** After "Details: " in the sentence for a lost backend stands what the transport said. */
function detailsOf(tail: string): string {
  const at = tail.lastIndexOf('Details: ')
  return at < 0 ? '' : tail.slice(at + 'Details: '.length).trim()
}

const whole = (tail: string): Pick<LogicNote, 'kind' | 'detail'> => ({ kind: 'generic', detail: tail.trim() })

/**
 * Sentences that stand at the END of `content`: alone, or after the part of
 * the answer that arrived and an empty line. The order matters only where one
 * head is the start of another.
 */
const TAIL_RULES: readonly TailRule[] = [
  { heads: [DISCONNECT_WITHOUT_ANSWER], read: () => ({ kind: 'network', detail: '' }) },
  { heads: [HIT_TOKEN_LIMIT], read: (tail) => ({ kind: 'empty', detail: tail.trim() }) },
  { heads: [SWITCHED_MODEL_HEAD], read: (tail) => ({ kind: 'empty', detail: tail.trim() }) },
  { heads: [NO_VISIBLE_ANSWER], read: () => ({ kind: 'empty', detail: '' }) },
  { heads: [headOf(CREDITS_EXHAUSTED_MESSAGE)], read: () => ({ kind: 'credits', detail: '' }) },
  { heads: bothWordings('cloudSessionEndedMidRun').map(headOf), read: () => ({ kind: 'session', detail: '' }) },
  { heads: bothWordings('agentBackendLost').map(headOf), read: (tail, cloud) => ({ kind: cloud ? 'network' : 'engine', detail: detailsOf(tail) }) },
  { heads: [...bothWordings('agentNoToolSupport'), ...bothWordings('agentToolTransportSwitched')].map(headOf), read: whole },
  { heads: [MULTIMODAL_UNSUPPORTED_MESSAGE, IMAGE_PART_NONE_HEAD, IMAGE_PART_NOT_LOADED_HEAD, IMAGE_PART_RELOADED_HEAD], read: whole },
  { heads: [headOf(TEMPLATE_REFUSAL_SENTENCE), headOf(BAD_REQUEST_SENTENCE)], read: whole },
  { heads: [THINKING_UNSUPPORTED_HEAD], read: () => ({ kind: 'generic', detail: THINKING_UNSUPPORTED_DETAIL }) },
  { heads: [RATE_LIMIT_HEAD], read: whole },
  // LU Cloud cut a step for repeating (agent-core/server-loop-cut.ts, 15.11.2026).
  { heads: [headOf(SERVER_LOOP_MESSAGE)], read: whole },
  { heads: [REQUEST_LIMIT_FALLBACK_HEAD], read: (tail) => ({ kind: 'limit', detail: tail.trim() }) },
]

/** Where `head` begins a paragraph of `content`, searched from the end. -1 when it does not. */
function paragraphStart(content: string, head: string): number {
  if (content.startsWith(head)) return 0
  const at = content.lastIndexOf(`\n\n${head}`)
  return at < 0 ? -1 : at + 2
}

/**
 * Pure: the sentence of the logic layer in `content`, and the answer in front
 * of it. null for a text that carries none, which is every answer of a model.
 *
 * A sentence only counts at the start of a paragraph, and an answer that
 * merely talks about errors is left alone ("Error handling in Rust ...").
 */
export function splitLogicNote(content: string, opts: { cloud?: boolean } = {}): LogicNote | null {
  const text = content ?? ''
  if (!text.trim()) return null
  const cloud = !!opts.cloud

  // The model thought and wrote nothing: the sentence is the whole text, next to the thoughts that were kept.
  if (THINKING_ATE_ANSWER.test(text.trim())) return { body: '', kind: 'empty', detail: text.trim() }

  let best: { at: number; rule: TailRule } | null = null
  for (const rule of TAIL_RULES) {
    for (const head of rule.heads) {
      if (!head) continue
      const at = paragraphStart(text, head)
      if (at >= 0 && (best === null || at < best.at)) best = { at, rule }
    }
  }
  if (best) {
    const tail = text.slice(best.at)
    return { body: text.slice(0, best.at).trimEnd(), ...best.rule.read(tail, cloud) }
  }

  // "Agent error: <reason>" after the text of the run, the last branch of the agent loop.
  const agentAt = paragraphStart(text, AGENT_ERROR_HEAD)
  if (agentAt >= 0) {
    return { body: text.slice(0, agentAt).trimEnd(), kind: 'generic', detail: text.slice(agentAt + AGENT_ERROR_HEAD.length).trim(), raw: true }
  }
  return null
}
