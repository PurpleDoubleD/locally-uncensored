/**
 * Context-fill computation for the TokenCounter.
 *
 * "Used" means: roughly what the NEXT request will send — that is the only
 * number worth alarming the user about. Two rules keep it honest:
 *
 * 1. Anchor on the newest model-reported usage when one exists. Its
 *    promptTokens is 100% real and already includes the system prompt, tools,
 *    RAG and the whole history up to that turn — things a char/4 estimate of
 *    the visible messages can never see.
 *
 * 2. Never count reasoning as context. `thinking` is stripped from outgoing
 *    requests (useChat sends role+content+images only), and completionTokens
 *    on a reasoning model is mostly hidden thinking. A looping cloud reasoner
 *    once burned its whole 16,384-token completion budget producing zero
 *    visible output; counting that (or high-watering totalTokens across the
 *    conversation, as this component used to) pinned the counter at "16.5k"
 *    forever while the next real prompt cost 65 tokens (David, 2026-07-12).
 *    Only the assistant's visible content joins future prompts, so only that
 *    is added on top of the anchor.
 */

import { estimateTokens } from './context-compaction'

export interface FillMessage {
  role: string
  content: string
  thinking?: string
  toolCallSummary?: string
  /** Written by an agent run, not by the user. See computeContextFill. */
  hidden?: boolean
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    estimated?: boolean
  }
}

export interface ContextFill {
  /** Estimated tokens the next request will carry. */
  used: number
  /** True when `used` is anchored on a non-estimated, model-reported usage. */
  real: boolean
  /** Where the number came from, so the tooltip can say so. */
  source: 'built' | 'usage' | 'estimate'
}

/**
 * The size of the request the builder last built for this conversation
 * (2.6.6, plan A2). It beats every other anchor because it is not a guess
 * about what will be sent: it IS what was sent, decay, plan pruning,
 * compaction and all. Messages added since are counted on top.
 */
export interface BuiltRequestAnchor {
  tokens: number
  /** Messages in the conversation at build time. */
  atMessageCount: number
}

/** Visible size of one message in a future prompt (content only, no thinking). */
function visibleTokens(m: FillMessage): number {
  let t = estimateTokens(m.content)
  if (m.toolCallSummary) t += estimateTokens(m.toolCallSummary)
  return t + 4 // role overhead
}

/**
 * Kostet diese gespeicherte Nachricht etwas in der NAECHSTEN Anfrage?
 *
 * `role:'system'` in einem gespeicherten Gespraech ist immer ein App-Hinweis —
 * der echte Systemprompt steht nicht im Verlauf, sondern wird beim Bauen der
 * Nutzlast vorangestellt. Die Nutzlast verwirft diese Zeilen; sie zu zaehlen
 * heisst, dem Nutzer Token in Rechnung zu stellen, die nie gesendet werden.
 *
 * DAS WURDE ERST 2026-09-02 ZUM PROBLEM, und zwar durch die App selbst: bis
 * dahin gab es kaum solche Zeilen. Seit `/compact` seine Ein- und Ausgabe als
 * Hinweis ablegt, seit eine fertige Hintergrundaufgabe ihr GANZES Ergebnis als
 * Hinweis meldet und seit die gescheiterte Auto-Kompaktierung sich meldet,
 * sind es viele — und die Hintergrund-Notiz kann mehrere tausend Token gross
 * sein. Der Balken sprang dann um ein Rechercheergebnis nach oben, das nie
 * jemand verschickt.
 *
 * DIESELBE REGEL steht als `isModelVisible` in run-compact-command.ts, wo sie
 * entscheidet, was zusammengefasst wird. Ein Waechter in
 * token-usage.test.ts haelt beide auf demselben Wort.
 */
function kostetEtwas(m: FillMessage): boolean {
  return m.role !== 'system'
}

export function computeContextFill(
  messages: FillMessage[],
  built?: BuiltRequestAnchor,
): ContextFill {
  // A real built request wins: it already contains the system prompt, the tool
  // catalogue, the decayed results and whatever compaction dropped, none of
  // which the visible conversation can show.
  if (built && built.tokens > 0 && built.atMessageCount <= messages.length) {
    let used = built.tokens
    for (let i = built.atMessageCount; i < messages.length; i++) {
      // A hidden message that shows up behind the anchor is the tool chain the
      // finished run wrote back into the store (useCodex splices it in BEFORE
      // its assistant message), and every byte of it was inside the request
      // this anchor measured. Counting it again doubled the meter on the first
      // run of a fresh chat: 15k of real prompt read as 30k, and it stayed
      // wrong until the next turn built a new anchor. Only what the user adds
      // after the build is new context.
      if (messages[i].hidden) continue
      if (!kostetEtwas(messages[i])) continue
      used += visibleTokens(messages[i])
    }
    return { used, real: false, source: 'built' }
  }

  // Newest message carrying usage (assistant turns store it when the model
  // reports real counts; the agent path stores a provisional estimated one).
  let anchorIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i].usage
    if (u && u.totalTokens > 0) { anchorIdx = i; break }
  }

  if (anchorIdx === -1) {
    // No usage anywhere yet — plain estimate over the visible conversation.
    return {
      used: messages.reduce((sum, m) => sum + (kostetEtwas(m) ? visibleTokens(m) : 0), 0),
      real: false,
      source: 'estimate',
    }
  }

  const anchor = messages[anchorIdx].usage!
  // promptTokens covers everything UP TO that turn's input; the anchored
  // message's own visible reply + every later message joins the next prompt.
  let used = anchor.promptTokens
  for (let i = anchorIdx; i < messages.length; i++) {
    if (!kostetEtwas(messages[i])) continue
    used += visibleTokens(messages[i])
  }
  return { used, real: !anchor.estimated, source: 'usage' }
}
