/**
 * Grouping for the tool-call band (2026-07-31): consecutive tool_call
 * blocks in a message render as ONE band that morphs from tool to tool while
 * running and collapses to an expandable "N steps" row when done, instead of
 * stacking a chip per call and flooding the chat.
 *
 * G14-4 (2026-08-07): narration BETWEEN tool calls no longer ends the
 * band. Any model that talks between calls ("Step 3 done, proceeding…", and
 * gpt-oss does it on every turn) used to shatter the run into band(1), note,
 * band(1), note, which is exactly the stack this module exists to prevent.
 * Interior reflection/answer blocks are now absorbed into the band as `notes`,
 * anchored after the call they followed, and render inside the expanded view.
 * A note is interior only when another tool call comes LATER; the message's
 * trailing answer always stands alone, because that is the model's actual
 * reply and must never disappear into a collapse.
 *
 * G21-2 (2026-08-07): per-round thinking blocks are interior notes too.
 * "Die Denkblasen muessen zwischen den Tool Calls dann genau da kommen, in der
 * richtigen Reihenfolge." Round k's thought sits anchored after the last call
 * of round k-1, inside the band, rendered as its own collapsed ThinkingBlock
 * (the G14-7 bubble). A TRAILING thought stays a single, in chronological
 * position before the final answer.
 *
 * Pure helpers, shared by MessageBubble (Agent) and CodexView (Code tab).
 */

import type { AgentBlock, AgentToolCall } from '../types/agent-mode'

export interface BandNote {
  /** Index into `calls` of the call this note followed. */
  afterCall: number
  block: AgentBlock
}

export type AgentBlockGroup =
  | { kind: 'tools'; blocks: AgentBlock[]; calls: AgentToolCall[]; notes: BandNote[] }
  | { kind: 'single'; block: AgentBlock }

const INTERIOR_NOTE_PHASES = new Set<AgentBlock['phase']>(['reflection', 'answer', 'thinking'])

/** Blocks must already be filtered + timestamp-sorted by the caller. */
export function groupAgentBlocks(blocks: AgentBlock[]): AgentBlockGroup[] {
  let lastCallAt = -1
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].phase === 'tool_call' && blocks[i].toolCall) lastCallAt = i
  }

  const groups: AgentBlockGroup[] = []
  // Notes seen since the last call, held back until we know whether the band
  // continues (absorbed) or ends here (rendered as singles, in order).
  let held: AgentBlock[] = []
  const flushHeld = () => {
    for (const b of held) groups.push({ kind: 'single', block: b })
    held = []
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const last = groups[groups.length - 1]
    if (block.phase === 'tool_call' && block.toolCall) {
      if (last && last.kind === 'tools') {
        for (const b of held) last.notes.push({ afterCall: last.calls.length - 1, block: b })
        held = []
        last.blocks.push(block)
        last.calls.push(block.toolCall)
      } else {
        flushHeld()
        groups.push({ kind: 'tools', blocks: [block], calls: [block.toolCall], notes: [] })
      }
    } else if (
      // A message from the user is never folded into a band (CA U2).
      !block.steer &&
      INTERIOR_NOTE_PHASES.has(block.phase) &&
      i < lastCallAt &&
      last &&
      last.kind === 'tools'
    ) {
      held.push(block)
    } else {
      flushHeld()
      groups.push({ kind: 'single', block })
    }
  }
  flushHeld()
  return groups
}

/** A band is live while any of its calls still needs attention or runtime. */
export function groupIsLive(calls: AgentToolCall[]): boolean {
  return calls.some((c) => c.status === 'running' || c.status === 'pending_approval')
}

/**
 * The call the collapsed band shows: an approval request beats everything
 * (its buttons must be visible), then the earliest still-running call (so
 * parallel batches display in order), else the last call of the group.
 */
export function activeToolCall(calls: AgentToolCall[]): AgentToolCall {
  return (
    calls.find((c) => c.status === 'pending_approval') ??
    calls.find((c) => c.status === 'running') ??
    calls[calls.length - 1]
  )
}

/** Summed duration over the group, formatted like the per-chip label. */
export function groupDurationLabel(calls: AgentToolCall[]): string | null {
  let total = 0
  let seen = false
  for (const c of calls) {
    if (c.duration != null) {
      total += c.duration
      seen = true
    }
  }
  if (!seen) return null
  return total < 1000 ? `${total}ms` : `${(total / 1000).toFixed(1)}s`
}
