// When may a self-control tool show its card at all? (C60 S3, 3.1.0)
//
// The card is the user's yes. These checks come before it, because a user who
// clicks cards away out of habit is the real risk (OWASP ASI09), and because a
// page the agent reads is not the user (David's hard rule of 24.10.2026):
//
//  1. Only on a surface that draws the card (run.settingsCard): chat, Agent,
//     Code. Sub-agents, voice, workflows and the local API never.
//  2. Intent: the user's own last message names what is to change (its area,
//     label or a synonym), or it is a short answer ("ja", "ok, 0.6") to the
//     model's own question that named it. Nothing that only a tool's output
//     asked for gets a card.
//  3. Strong changes (local API, phone remote, a download by link): the
//     user's message has to name them outright, the run must not have read
//     foreign content, and for a "ja" the run that asked must not have either.
//  4. At most MAX_CARDS_PER_RUN cards per run; several values go on one
//     set_settings card.
//
// Every refusal says "Nothing changed" and what the model should do instead,
// in one line a 9B model can follow.

import { useChatStore } from '../stores/chatStore'
import { previousRunOf, type AgentRunContext } from '../api/agent-context'
import { taintLabel } from './run-taint'
import { isPhoneTurn, PHONE_TURN_NO_CARD } from './remote-turn-caps'
import type { Message } from '../types/chat'

export const MAX_CARDS_PER_RUN = 3
/** "ja", "yes please", "ok, 0.6": an answer, not a new request. */
const SHORT_REPLY_CHARS = 120

export interface TurnText {
  /** The user's own last message. */
  user: string
  /** The model's answer before it, text and its self-control calls. */
  previousAssistant: string
}

function textOf(m: Message | undefined): string {
  if (!m) return ''
  const parts = [m.content ?? '']
  for (const b of m.agentBlocks ?? []) {
    if (b.phase !== 'tool_call') parts.push(b.content ?? '')
    for (const c of b.toolCalls ?? (b.toolCall ? [b.toolCall] : [])) {
      // Only the model's own words: arguments of its calls, never a result.
      parts.push(JSON.stringify(c.args ?? {}))
    }
  }
  return parts.join('\n')
}

/** The user's message of this turn and the model's answer before it. */
export function turnTextOf(conversationId: string | null): TurnText | null {
  if (!conversationId) return null
  const conv = useChatStore.getState().conversations.find((c) => c.id === conversationId)
  if (!conv) return null
  const msgs = conv.messages
  let u = -1
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { u = i; break }
  if (u < 0) return null
  let a: Message | undefined
  for (let i = u - 1; i >= 0; i--) if (msgs[i].role === 'assistant') { a = msgs[i]; break }
  // What the user typed: with an attached file or a slash command, `content`
  // carries the file or the command's template, foreign words that could
  // satisfy the intent check (found by S5, 09.11.2026).
  return { user: msgs[u].displayContent ?? msgs[u].content ?? '', previousAssistant: textOf(a) }
}

export type PolicyVerdict =
  | { ok: true; taintedBy?: string }
  | { ok: false; reply: string; why: 'surface' | 'taint' | 'cards' | 'intent' }

export interface PolicyAsk {
  /** Does this text name what is to change? `strict`: label, key or synonym
   *  only, the area alone is not enough. */
  names: (text: string, strict: boolean) => boolean
  strong: boolean
  /** What is to change, for the reply ("the local API", "Temperature"). */
  what: string
}

export function checkSelfControl(run: AgentRunContext | undefined, ask: PolicyAsk): PolicyVerdict {
  if (!run?.settingsCard) {
    return { ok: false, why: 'surface', reply: 'Error: LU can only be changed in a chat where the user sees the confirmation card. Nothing changed.' }
  }
  // A turn the paired phone started: the card would wait at the computer.
  if (isPhoneTurn(run.conversationId)) return { ok: false, why: 'surface', reply: PHONE_TURN_NO_CARD }
  const taintedBy = taintLabel(run)
  if (ask.strong && taintedBy) {
    return {
      ok: false, why: 'taint',
      reply: `Refused: this run read ${taintedBy} before. ${ask.what} changes only on the user's own request in a new message, never after foreign content. Nothing changed. Tell the user so.`,
    }
  }
  if ((run.selfControlCards ?? 0) >= MAX_CARDS_PER_RUN) {
    return {
      ok: false, why: 'cards',
      reply: `Refused: ${MAX_CARDS_PER_RUN} cards in this run already. Put several values on one set_settings card, or stop and tell the user. Nothing changed.`,
    }
  }
  const turn = turnTextOf(run.conversationId)
  if (!turn) {
    return { ok: false, why: 'intent', reply: 'Refused: the user\'s message could not be read, so there is no request to act on. Nothing changed.' }
  }
  if (ask.names(turn.user, ask.strong)) return { ok: true, taintedBy }
  const isAnswer = turn.user.trim().length <= SHORT_REPLY_CHARS && ask.names(turn.previousAssistant, ask.strong)
  if (isAnswer) {
    if (!ask.strong) return { ok: true, taintedBy }
    const prev = previousRunOf(run.conversationId, run.token)
    if (prev && !prev.taint) return { ok: true }
    return {
      ok: false, why: 'taint',
      reply: `Refused: ${ask.what} was suggested in a run that read foreign content (or one LU no longer knows). The user has to ask for it in their own words. Nothing changed.`,
    }
  }
  return {
    ok: false, why: 'intent',
    reply: `Refused: the user did not ask about ${ask.what}. Nothing changed. If it would help, suggest it in one sentence and change it only when they say yes.`,
  }
}

/** Count a card against the run's cap. */
export function noteCard(run: AgentRunContext | undefined): void {
  if (run) run.selfControlCards = (run.selfControlCards ?? 0) + 1
}
