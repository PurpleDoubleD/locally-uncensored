/**
 * "Rewind to here" (CA U4).
 *
 * Claude Code, Cursor and Codex keep the files an agent touches, per user
 * turn, so a run that went wrong can be taken back with one click. LU only had
 * `/undo`, which asks the model to sort it out with git and does nothing
 * outside a repository.
 *
 * How it works: before the FIRST write to a file after a user message, the old
 * text of that file is kept (or the fact that it did not exist). Rewinding to a
 * message puts every file written since then back the way it was before that
 * message: old text written back, files that were new deleted again.
 *
 * What it does not cover, said in the menu: changes made by shell commands
 * (`npm install`, `git checkout`, a script that writes files). Only the file
 * tools (file_write, file_edit) and applied Ask-mode changes are kept. The
 * copies live in memory for this app session, capped, and are gone after a
 * restart.
 */
import { create } from 'zustand'
import { backendCall } from '../../api/backend'
import type { FsReadResult } from '../../types/bridge'

/** The fs arguments a write went out with; a restore uses the same ones. */
export interface FsTarget {
  path: string
  chatId?: string
  workingDirectory?: string
}

export type Before =
  | { kind: 'text'; content: string }
  | { kind: 'missing' }
  | { kind: 'unkept'; why: 'binary' | 'too-big' | 'unreadable' }

interface Entry {
  target: FsTarget
  before: Before
}

export interface Checkpoint {
  /** The user message whose turn made these writes. */
  messageId: string
  /** When the first write of the turn happened. */
  at: number
  /** Keyed by the absolute path the backend reported. */
  files: Record<string, Entry>
}

/** One file larger than this is not kept (the menu names it). */
export const MAX_FILE_CHARS = 2_000_000
/** All kept text together; the oldest checkpoints go first beyond it. */
export const MAX_TOTAL_CHARS = 64_000_000

interface CheckpointState {
  byConv: Record<string, Checkpoint[]>
  /** Per chat: checkpoints from before this time were dropped for space. */
  trimmedBefore: Record<string, number>
}

export const useCheckpointStore = create<CheckpointState>(() => ({ byConv: {}, trimmedBefore: {} }))

function sizeOf(before: Before): number {
  return before.kind === 'text' ? before.content.length : 0
}

function totalChars(byConv: Record<string, Checkpoint[]>): number {
  let n = 0
  for (const list of Object.values(byConv)) for (const cp of list) for (const e of Object.values(cp.files)) n += sizeOf(e.before)
  return n
}

type TurnLookup = (convId: string) => { id: string; timestamp: number } | null
let turnLookup: TurnLookup = () => null

/**
 * The chat store tells this module which user message the current turn of a
 * chat belongs to. Registered from there instead of imported here: the file
 * tools import this module, and the chat store importing the tools' world back
 * made an import cycle (stores/chatStore.ts calls this at load).
 */
export function registerTurnLookup(fn: TurnLookup): void {
  turnLookup = fn
}

function currentTurnMessage(convId: string): { id: string; timestamp: number } | null {
  try { return turnLookup(convId) } catch { return null }
}

/** Read what a file holds now, before a write replaces it. */
export async function readBefore(target: FsTarget): Promise<Before> {
  try {
    const r = await backendCall<FsReadResult>('fs_read', { ...target })
    if (r.encoding !== 'utf8' || typeof r.content !== 'string') return { kind: 'unkept', why: 'binary' }
    if (r.content.length > MAX_FILE_CHARS) return { kind: 'unkept', why: 'too-big' }
    return { kind: 'text', content: r.content }
  } catch (e) {
    return beforeFromError(e)
  }
}

/** A read that failed: the file was not there, or it could not be read. */
export function beforeFromError(e: unknown): Before {
  const msg = e instanceof Error ? e.message : String(e)
  return /not found|no such file/i.test(msg) ? { kind: 'missing' } : { kind: 'unkept', why: 'unreadable' }
}

/** Text the caller already read (file_edit reads before it edits). */
export function textBefore(content: string): Before {
  return content.length > MAX_FILE_CHARS ? { kind: 'unkept', why: 'too-big' } : { kind: 'text', content }
}

/**
 * Note a write that went through. Only the first write to a file per turn
 * counts: that is the state the turn started from.
 */
export function recordWrite(convId: string | null | undefined, target: FsTarget, before: Before, writtenPath?: string): void {
  if (!convId) return
  const turn = currentTurnMessage(convId)
  if (!turn) return
  const key = writtenPath || `${target.workingDirectory ?? target.chatId ?? ''}::${target.path}`
  useCheckpointStore.setState((s) => {
    const list = [...(s.byConv[convId] ?? [])]
    let cp = list[list.length - 1]
    if (!cp || cp.messageId !== turn.id) {
      cp = { messageId: turn.id, at: Date.now(), files: {} }
      list.push(cp)
    } else {
      cp = { ...cp, files: { ...cp.files } }
      list[list.length - 1] = cp
    }
    if (cp.files[key]) return s
    cp.files[key] = { target: { ...target, path: writtenPath || target.path }, before }
    const byConv = { ...s.byConv, [convId]: list }
    return trim({ byConv, trimmedBefore: s.trimmedBefore })
  })
}

/** Drop the oldest checkpoints, across chats, until the kept text fits. */
function trim(s: CheckpointState): CheckpointState {
  let total = totalChars(s.byConv)
  if (total <= MAX_TOTAL_CHARS) return s
  const byConv: Record<string, Checkpoint[]> = {}
  for (const [k, v] of Object.entries(s.byConv)) byConv[k] = [...v]
  const trimmedBefore = { ...s.trimmedBefore }
  while (total > MAX_TOTAL_CHARS) {
    let oldest: { conv: string; at: number } | null = null
    for (const [conv, list] of Object.entries(byConv)) {
      if (list.length > 1 && (!oldest || list[0].at < oldest.at)) oldest = { conv, at: list[0].at }
    }
    if (!oldest) break // only the current turns are left; keep them
    const cp = byConv[oldest.conv].shift()!
    for (const e of Object.values(cp.files)) total -= sizeOf(e.before)
    trimmedBefore[oldest.conv] = Math.max(trimmedBefore[oldest.conv] ?? 0, (byConv[oldest.conv][0]?.at ?? Date.now()))
  }
  return { byConv, trimmedBefore }
}

/** Checkpoints from this user message on: its own turn and every later one. */
function checkpointsFrom(convId: string, since: number): Checkpoint[] {
  return (useCheckpointStore.getState().byConv[convId] ?? []).filter((cp) => cp.at >= since)
}

export interface RewindPlan {
  /** Files that get their old text back. */
  restore: Entry[]
  /** Files that did not exist and are deleted again. */
  remove: Entry[]
  /** Files written since then that cannot be put back, with why. */
  unkept: Array<{ path: string; why: 'binary' | 'too-big' | 'unreadable' }>
  /** Some writes since then were dropped for space and are not in the plan. */
  partial: boolean
}

/**
 * What rewinding to the message with this timestamp would do. The state of a
 * file before the turn is the "before" of its FIRST write from then on.
 */
export function rewindPlan(convId: string, messageTimestamp: number): RewindPlan {
  const first = new Map<string, Entry>()
  for (const cp of checkpointsFrom(convId, messageTimestamp)) {
    for (const [key, e] of Object.entries(cp.files)) if (!first.has(key)) first.set(key, e)
  }
  const plan: RewindPlan = { restore: [], remove: [], unkept: [], partial: false }
  for (const e of first.values()) {
    if (e.before.kind === 'text') plan.restore.push(e)
    else if (e.before.kind === 'missing') plan.remove.push(e)
    else plan.unkept.push({ path: e.target.path, why: e.before.why })
  }
  const trimmed = useCheckpointStore.getState().trimmedBefore[convId]
  plan.partial = trimmed !== undefined && messageTimestamp < trimmed
  return plan
}

export function planSize(plan: RewindPlan): number {
  return plan.restore.length + plan.remove.length + plan.unkept.length
}

export interface RewindResult {
  restored: number
  removed: number
  failed: string[]
}

/** Put the files back. The checkpoints used are dropped afterwards. */
export async function rewindFiles(convId: string, messageTimestamp: number): Promise<RewindResult> {
  const plan = rewindPlan(convId, messageTimestamp)
  const out: RewindResult = { restored: 0, removed: 0, failed: [] }
  for (const e of plan.restore) {
    try {
      await backendCall('fs_write', { ...e.target, content: (e.before as { content: string }).content })
      out.restored++
    } catch {
      out.failed.push(e.target.path)
    }
  }
  for (const e of plan.remove) {
    try {
      await backendCall('fs_delete', { ...e.target })
      out.removed++
    } catch (err) {
      // Already gone is the state we want.
      const msg = err instanceof Error ? err.message : String(err)
      if (/not found/i.test(msg)) out.removed++
      else out.failed.push(e.target.path)
    }
  }
  dropCheckpointsFrom(convId, messageTimestamp)
  return out
}

/** Forget the checkpoints of this turn and every later one. */
export function dropCheckpointsFrom(convId: string, messageTimestamp: number): void {
  useCheckpointStore.setState((s) => {
    const list = s.byConv[convId]
    if (!list) return s
    return { ...s, byConv: { ...s.byConv, [convId]: list.filter((cp) => cp.at < messageTimestamp) } }
  })
}

/** One line for the notice after a rewind. */
export function rewindSummary(r: RewindResult): string {
  const parts: string[] = []
  if (r.restored) parts.push(`${r.restored} ${r.restored === 1 ? 'file' : 'files'} put back`)
  if (r.removed) parts.push(`${r.removed} new ${r.removed === 1 ? 'file' : 'files'} removed`)
  if (!parts.length && !r.failed.length) return 'Nothing to put back.'
  const head = parts.length ? parts.join(', ') + '.' : ''
  const fail = r.failed.length ? ` Could not restore ${r.failed.map((p) => p.split('/').pop()).join(', ')}.` : ''
  return (head + fail).trim()
}
