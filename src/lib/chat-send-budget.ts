/**
 * The send budget for the CONVERSATION surfaces (2.6.6, plan A4).
 *
 * A2 put a ceiling on what one agent step may send. The three chat surfaces had
 * none, and two of them multiply every byte:
 *
 *  - plain chat rebuilds the full history on every send, so turn 60 of a long
 *    chat pays for turns 1 to 59 again to ask "and shorter please";
 *  - a group round sends that same full history to two to four models, so one
 *    round costs history level times N;
 *  - compare sends it to both sides of the panel, every round, uncapped.
 *
 * So all three get the A2 number: min(0.8 x model window,
 * codexSendWindowTokens) on a paid provider. Since 2.6.8 a local backend gets
 * the same shape without the cost ceiling — 0.8 x its own window — because an
 * overflowing window is not a billing problem; see chatBudgetApplies below,
 * "WARUM DAS TOR AUFGEHT". The contextDecay notaus still returns every
 * surface to exactly the payload it sent before, which is what makes this
 * supportable in the field without a rollback release.
 *
 * The message-COUNT cap (capMessageCount) stays where it is on every path. It
 * guards a different failure: a chat of many short turns fits every token
 * budget while the count climbs past the proxy's 400-message gate.
 */

import { compactMessages, estimateMessageTokens } from './context-compaction'
import { ageOutImages } from './context-images'
import { effectiveSendWindow } from './send-window'

export interface ChatSendBudgetInput {
  /** Provider id of the model this payload goes to. */
  providerId: string
  /** The model's context window, as getModelMaxTokens resolved it. */
  modelWindow: number
  /** settings.codexSendWindowTokens. */
  sendWindowTokens?: number
  /** settings.contextDecay. The notaus switches the whole cap off. */
  contextDecay?: boolean
}

/**
 * Whether a payload to this provider is capped at all, answerable before the
 * model window has been looked up.
 *
 * Since 2.6.8 (Compact-Schritt 2) the answer is yes for every provider, so
 * the only thing that switches it off is the contextDecay notaus. The window
 * lookup behind it now goes through the Ollama context cache, so asking is
 * one round trip per model for the life of the app instead of one per send.
 *
 * ── WARUM DAS TOR AUFGEHT ──────────────────────────────────────────────────
 *
 * The gate used to ask `isPaidProvider`, which answers a COST question: is a
 * token sent a token billed? That is the right question for the size of the
 * cap, and it is still what decides it — a paid step is held to
 * codexSendWindowTokens, a local one is not. It was the wrong question for
 * whether to cap AT ALL, because a history that outgrows the window is not a
 * billing problem, it is a correctness problem, and a local model has it too:
 * it truncates, silently, from the front — which is where the task is.
 *
 * That local chat had no cap was measurable as an inconsistency inside the app
 * rather than a judgement call. The SAME local model in Agent and in Coding
 * mode has been compacted all along (useAgentChat.ts, useCodex.ts, both via
 * trimWorkingHistory). Only plain chat and compare were uncapped, and nothing
 * about a chat turn makes a local model's window bigger than an agent turn
 * does.
 *
 * ── WAS SICH DAMIT AENDERT, UND WAS NICHT ──────────────────────────────────
 *
 * A local payload is now held to effectiveSendWindow's base, 0.8 x the model
 * window. Compaction runs with the A3 hysteresis on top, so it does not engage
 * at 0.8 but at 1.15 x 0.8 = 0.92 of the window, and then drops to 0.7 x 0.8 =
 * 0.56. So:
 *
 *   - below 92% of the window, a local chat is byte-identical to 2.6.7;
 *   - above it, the trim engages exactly where the model was about to drop the
 *     oldest turns itself, without saying so;
 *   - the 8% left over is not spare, it is the room the ANSWER needs. num_ctx
 *     covers prompt plus completion, and a prompt filled to the brim leaves a
 *     model no space to reply in.
 *
 * The contextDecay notaus still returns every surface, local included, to the
 * untouched 2.6.5 payload. That is what keeps this supportable in the field
 * without a rollback release, and it is the reason the notaus outranks the
 * provider question in the line above rather than sitting beside it.
 */
export function chatBudgetApplies(_providerId: string, contextDecay?: boolean): boolean {
  // `_providerId` steht noch in der Signatur, traegt die Entscheidung aber
  // nicht mehr — und der Unterstrich sagt das, statt es zu verschweigen.
  //
  // Er bleibt aus einem Grund, der KEIN Bequemlichkeitsgrund ist: die Frage
  // "welcher Anbieter" ist an dieser Stelle richtig GESTELLT und nur falsch
  // BEANTWORTET worden. Ein Ueberlauf ist ein Korrektheitsproblem und kein
  // Kostenproblem, darum haengt das Kappen nicht mehr am bezahlten Anbieter.
  // Sollte je ein Anbieter auftauchen, der wirklich anders gekappt gehoert
  // (weil sein Fenster anders zaehlt, nicht weil er billiger ist), ist das
  // hier die Stelle — und sie ist noch verkabelt. Ihn zu entfernen hiesse,
  // 12 Aufrufstellen und ihre Tests umzuschreiben, um eine Frage zu loeschen,
  // die legitim ist.
  return contextDecay !== false
}

/**
 * The budget one send may carry, or null when this surface is not capped at
 * all. Null is not "unlimited by accident": it is the explicit 2.6.5 path, and
 * callers hand the untouched array straight through on it.
 */
export function chatSendBudget(input: ChatSendBudgetInput): number | null {
  if (!chatBudgetApplies(input.providerId, input.contextDecay)) return null
  const window = effectiveSendWindow({
    providerId: input.providerId,
    modelWindow: input.modelWindow,
    sendWindowTokens: input.sendWindowTokens,
    capEnabled: true,
  })
  return window > 0 ? window : null
}

/**
 * The budget for a payload that goes to SEVERAL models at once (compare, and
 * conceptually a group round): the tightest of the applicable ones.
 *
 * Both sides of a compare have to receive the same prompt or the comparison is
 * not a comparison, so a mixed pairing takes the paid side's budget for both.
 */
export function sharedChatSendBudget(inputs: ChatSendBudgetInput[]): number | null {
  const budgets = inputs.map(chatSendBudget).filter((b): b is number => b !== null)
  return budgets.length ? Math.min(...budgets) : null
}

export interface ChatSendResult<T> {
  messages: T[]
  /** The budget that was applied, or null when the payload passed through. */
  budget: number | null
  /** Estimated size of the payload as it goes out. */
  promptTokens: number
  /** Attachments left behind by the image rule. */
  droppedImages: number
}

export interface ApplyBudgetOptions {
  /** How many of the newest user turns keep their attachments. */
  keepImages?: number
}

/**
 * Apply a resolved budget to a message array.
 *
 * Order is the same as the agent builder's: attachments first (they are the
 * bytes the token estimator cannot see), then the token budget. Compaction runs
 * with the A3 hysteresis, so a chat sitting at the ceiling keeps the same
 * prompt prefix for several turns running instead of shifting the window on
 * every single send and paying full price for the whole history again.
 */
export function applySendBudget<T extends { role: string; content?: unknown }>(
  messages: T[],
  budget: number | null,
  opts: ApplyBudgetOptions = {},
): ChatSendResult<T> {
  type Estimated = Parameters<typeof estimateMessageTokens>[0]
  if (budget === null) {
    // The untouched array, by reference: this is the 2.6.5 payload, and
    // nothing about it may change on a local backend or with the notaus off.
    return {
      messages,
      budget: null,
      promptTokens: estimateMessageTokens(messages as unknown as Estimated),
      droppedImages: 0,
    }
  }
  const aged = ageOutImages(messages, { keepRecent: opts.keepImages })
  const compacted = compactMessages(aged.messages as unknown as Estimated, budget, {
    hysteresis: true,
  }) as unknown as T[]
  return {
    messages: compacted,
    budget,
    promptTokens: estimateMessageTokens(compacted as unknown as Estimated),
    droppedImages: aged.strippedImages,
  }
}

/** Resolve the budget for one model and apply it in one call. */
export function applyChatSendBudget<T extends { role: string; content?: unknown }>(
  messages: T[],
  input: ChatSendBudgetInput & ApplyBudgetOptions,
): ChatSendResult<T> {
  return applySendBudget(messages, chatSendBudget(input), { keepImages: input.keepImages })
}
