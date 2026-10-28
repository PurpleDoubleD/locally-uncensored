/**
 * Compact layers (3.0.9): the transcript as it stood before each compaction.
 *
 * Every compaction of a chat is a cut. The current view starts at the newest
 * cut, with the line "Compacted, 28.9K → 17.9K" on top, the way the Claude
 * Code desktop app shows it. Each earlier cut opens one layer more: layer k is
 * the stretch the model was working with right before compaction k, from the
 * cut before it up to the moment it ran. The rail on the left of the
 * transcript switches between them.
 *
 * Nothing is copied for this. Compaction never deleted a message (the store
 * keeps every turn and every tool result, see CompactBlock and
 * run-compact-midway), so a layer is a window onto the stored messages, made
 * of two kinds of cut:
 *
 *  - a CompactionRecord (per turn, /compact or the auto trigger). The view
 *    after it starts behind `upToMessageId`; the one before it ends at the
 *    newest message when it ran (`endMessageId`, else `atMessageCount`).
 *  - an agent block with `compaction` set (in the middle of an Agent or Code
 *    run). It sits inside the answer being written, so the cut runs through
 *    that answer: the steps before the block belong to the layer before, the
 *    steps from it on to the view after.
 *
 * A cut whose anchor is gone (the message was deleted, a fork was switched)
 * is no cut any more and is left out, the same rule compactionAnchors follows.
 */

import type { CompactionRecord, Message } from '../types/chat'
import type { AgentBlock } from '../types/agent-mode'

/**
 * Up to 3.0.8 a successful auto-compaction wrote the sentence of /compact as
 * a notice with this id prefix, because success left no other trace (tester,
 * 2026-09-03: „Ich glaube, das Werkzeug hat alles"). The record is drawn as a
 * line now and says the same, so old chats leave those notices out.
 */
export const AUTO_OK_PREFIX = 'autocompact-ok-'

/** Where in the stored messages: message index, block index inside it. */
interface Pos {
  msg: number
  block: number
}

/** One compaction, as the transcript draws it. */
export interface CompactCut {
  key: string
  /** Payload estimate before and after. */
  before: number
  after: number
  trigger: 'auto' | 'manual'
  at: number
  /** The rendered summary, for the per-turn record (the run's summary rides
   *  in the working copy only and is not stored). */
  summary?: string
  /** The record itself, when this cut is one. */
  record?: CompactionRecord
  /** First position of the view after the cut. */
  start: Pos
  /** Position right after the end of the view before the cut. */
  end: Pos
}

/** What a view is made of: the line at its top, then messages. */
export type LayerItem =
  | { kind: 'line'; cut: CompactCut }
  | { kind: 'message'; message: Message }

const isCompactionBlock = (b: AgentBlock): boolean => !!b.compaction

const before = (a: Pos, b: Pos): boolean => a.msg < b.msg || (a.msg === b.msg && a.block < b.block)

/** Every usable cut of a chat, oldest first. */
export function compactCuts(
  messages: readonly Message[],
  compactions: readonly CompactionRecord[] | undefined,
): CompactCut[] {
  const indexOf = new Map(messages.map((m, i) => [m.id, i]))
  const cuts: CompactCut[] = []

  for (const record of compactions ?? []) {
    const anchor = indexOf.get(record.upToMessageId)
    if (anchor === undefined) continue
    const endIdx = record.endMessageId !== undefined ? indexOf.get(record.endMessageId) : undefined
    const end = endIdx !== undefined ? endIdx + 1 : Math.min(record.atMessageCount, messages.length)
    cuts.push({
      key: record.id,
      before: record.contextBefore ?? record.tokensBefore,
      after: record.contextAfter ?? record.tokensAfter,
      trigger: record.trigger,
      at: record.at,
      summary: record.summary,
      record,
      start: { msg: anchor + 1, block: 0 },
      end: { msg: Math.max(end, anchor + 1), block: 0 },
    })
  }

  messages.forEach((m, msg) => {
    m.agentBlocks?.forEach((b, block) => {
      if (!b.compaction) return
      cuts.push({
        key: b.id,
        before: b.compaction.before,
        after: b.compaction.after,
        trigger: 'auto',
        at: b.timestamp,
        start: { msg, block },
        end: { msg, block },
      })
    })
  })

  // In the order they happened. A cut that would start before the one it
  // follows (data from a hand-edited or imported chat) cannot make a layer
  // and is dropped instead of producing a view that runs backwards.
  cuts.sort((a, b) => a.at - b.at)
  const out: CompactCut[] = []
  for (const cut of cuts) {
    const prev = out[out.length - 1]
    if (prev && before(cut.start, prev.start)) continue
    out.push(cut)
  }
  return out
}

/** The messages between two positions, an answer cut through where needed. */
function messagesBetween(messages: readonly Message[], from: Pos, to: Pos | null): Message[] {
  const out: Message[] = []
  for (let i = from.msg; i < messages.length; i++) {
    if (to && (i > to.msg || (i === to.msg && to.block === 0))) break
    const m = messages[i]
    const blocks = m.agentBlocks
    const cutsHere = !!blocks?.some(isCompactionBlock)
    const head = i === from.msg ? from.block : 0
    const tail = to && i === to.msg ? to.block : null
    if (!blocks || (head === 0 && tail === null && !cutsHere)) {
      out.push(m)
      continue
    }
    const kept = blocks.slice(head, tail ?? undefined).filter((b) => !isCompactionBlock(b))
    if (tail === null) {
      // The answer from the cut on: its text, usage and error belong to it.
      out.push({ ...m, agentBlocks: kept })
    } else {
      // The answer up to the cut: only the steps it had taken by then. Its
      // final text and numbers came later and stay with the view after.
      out.push({
        ...m,
        agentBlocks: kept,
        content: '',
        thinking: undefined,
        usage: undefined,
        requestUsage: undefined,
        error: undefined,
        finishReason: undefined,
      })
    }
  }
  return out
}

/**
 * The items of one view.
 *
 * `layer` null (or cuts.length) is the current view. 0 is the stretch before
 * the first compaction, 1 the one before the second, and so on.
 */
export function layerItems(
  messages: readonly Message[],
  cuts: readonly CompactCut[],
  layer: number | null,
): LayerItem[] {
  const k = layer === null || layer >= cuts.length ? cuts.length : Math.max(0, layer)
  const opening = k > 0 ? cuts[k - 1] : null
  const from = opening ? opening.start : { msg: 0, block: 0 }
  const to = k < cuts.length ? cuts[k].end : null
  const items: LayerItem[] = []
  if (opening) items.push({ kind: 'line', cut: opening })
  for (const message of messagesBetween(messages, from, to)) {
    // The notice a successful auto-compaction wrote up to 3.0.8 says what
    // the line says.
    if (message.id.startsWith(AUTO_OK_PREFIX)) continue
    items.push({ kind: 'message', message })
  }
  return items
}
