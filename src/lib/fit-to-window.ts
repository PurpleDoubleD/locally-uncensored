/**
 * The last check before a request leaves: does it fit the window at all?
 * (CA, 14.11.2026.)
 *
 * Compaction and the mechanical trim run before this, in every path. Neither
 * promised the result fits: compaction keeps the newest turns whole and needs
 * enough of them to summarise, the trim always keeps the newest four. A chat of
 * a few very long turns stayed over the window, and nothing checked. On LU's
 * own engine that is a 400 the paths explain; on Ollama it is silent: Ollama
 * cuts the start of the prompt and the model answers a conversation it never
 * saw whole, or, as David saw with a local 27B in Agent mode, not at all.
 *
 * So: measured once more on what is actually sent. Too big, and the longest
 * older turns are shortened (head and tail kept, shortenLongTurns, the request
 * copy only; the chat keeps every word). Still too big, and nothing is sent:
 * the turn ends with the honest sentence instead of a silent cut or a hang.
 */
import { estimateMessageTokens, shortenLongTurns } from './context-compaction'
import { CONTEXT_OVERFLOW_REFUSAL_SENTENCE } from './template-refusal'
import type { OllamaChatMessage } from '../types/agent-mode'

/** Room the answer needs beside the prompt, as in compact-trigger. */
const ANSWER_ROOM_SHARE = 0.12
const ANSWER_ROOM_MIN_TOKENS = 1024

export function answerRoom(window: number): number {
  return Math.min(Math.floor(window / 2), Math.max(ANSWER_ROOM_MIN_TOKENS, Math.floor(window * ANSWER_ROOM_SHARE)))
}

export interface FitResult<T> {
  messages: T[]
  /** Turns shortened for this request. */
  shortened: number
  /** Estimated prompt tokens after shortening (tools included). */
  tokens: number
  fits: boolean
}

/**
 * Fit `messages` (plus `extraTokens`, e.g. the tool catalogue) into `window`,
 * leaving room for the answer. A window of 0 or less is unknown: nothing is
 * checked, nothing changes.
 */
export function fitToWindow<T extends { role: string; content: string }>(
  messages: T[],
  window: number,
  extraTokens = 0,
): FitResult<T> {
  const size = (ms: T[]) => estimateMessageTokens(ms as unknown as OllamaChatMessage[]) + extraTokens
  const before = size(messages)
  if (!(Number.isFinite(window) && window > 0)) return { messages, shortened: 0, tokens: before, fits: true }
  const budget = window - answerRoom(window)
  if (before <= budget) return { messages, shortened: 0, tokens: before, fits: true }
  const cut = shortenLongTurns(messages, Math.max(0, budget - extraTokens))
  const after = size(cut.messages)
  return { messages: cut.messages, shortened: cut.shortened, tokens: after, fits: after <= window - Math.min(512, answerRoom(window)) }
}

/** Thrown by a send path when even the shortened request does not fit. */
export class ContextFullError extends Error {
  readonly tokens: number
  readonly window: number
  constructor(tokens: number, window: number) {
    super(CONTEXT_OVERFLOW_REFUSAL_SENTENCE)
    this.name = 'ContextFullError'
    this.tokens = tokens
    this.window = window
  }
}

export function isContextFull(err: unknown): err is ContextFullError {
  return err instanceof Error && err.name === 'ContextFullError'
}
