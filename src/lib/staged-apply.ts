/**
 * Applying staged changes to disk — shared by the StagedChangesPanel buttons
 * and Codex auto-apply (settings.codexAutoApply), so both paths write through
 * the exact same trusted call.
 *
 * Writes go via fs_write DIRECTLY, not the `file_write` model tool. Two
 * reasons: (1) by apply time the loop's finally may have cleared the active
 * chat/workspace, so file_write's chatCtx() is empty and the write would jail
 * to agent-workspace/default — rejecting the absolute project path. (2)
 * file_write deliberately does NOT let its caller pick the jail root (2.5.7
 * security review: a prompt-injected model could set workingDirectory to
 * escape the sandbox). Apply is a trusted, user-gated action, so it is safe
 * to pass the workspace root captured at stage time as the jail root.
 */

import { backendCall } from '../api/backend'
import { useStagedChangesStore, type StagedChange } from '../stores/stagedChangesStore'
import { useChatStore } from '../stores/chatStore'
import { resolveChatWorkspaceSlug } from '../api/workspace-slug'
import { mergeThreeWay } from './three-way-merge'
import { contentWithDecisions, describeHunk } from './hunks'

/**
 * Line endings, the difference between "merged" and "we refused your own edit".
 *
 * Measured against the real queue on the Windows box, 2026-08-14: `oldContent`
 * and the file on disk both carry CRLF, because that is what a Windows editor
 * writes, and the model writes `newContent` with LF. Compared as bytes, EVERY
 * line differs from the baseline, so mergeThreeWay sees one replaced block
 * spanning the whole file and any foreign edit inside it reads as a collision.
 * The user is told their edit touches the same place, which is not true.
 *
 * The quieter half is on the happy path: writing LF content over a CRLF file
 * flips the whole file and turns a three-line change into a full rewrite in
 * everyone's diff.
 *
 * So compare and merge on LF, and write back in the form the FILE has. The
 * model's choice of ending is an artefact of the model, never a decision.
 */
const toLf = (text: string) => text.replace(/\r\n/g, '\n')

function eolOf(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  return crlf > lf ? '\r\n' : '\n'
}

const withEol = (text: string, eol: '\r\n' | '\n') =>
  eol === '\r\n' ? toLf(text).replace(/\n/g, '\r\n') : toLf(text)

/**
 * Decide what to write when the file moved on since it was staged.
 *
 * A staged change carries the file as it looked when the model wrote it. The
 * user reviews the diff and clicks Apply minutes later, and in between the file
 * may well have changed: they fixed a line themselves, another tool ran in the
 * same folder, or an earlier entry of this very queue landed. Writing
 * `newContent` blindly reverts all of that, with no undo.
 *
 * Refusing was the first answer to that, and it turned into its own bug: every
 * file in Morgan's finished run refused, so a plan the app reported as done
 * wrote nothing (2026-08-11). Refusing is only correct when the two edits
 * really collide. So:
 *
 *   1. baseline intact       -> write what was approved
 *   2. already that content  -> nothing to do, treat as applied
 *   3. foreign edit elsewhere-> merge both and write the result
 *   4. same lines both sides -> refuse, this one needs a human
 *
 * An empty `oldContent` means "there was no file here", and that used to skip
 * the whole check. It is also what useCodex writes when the stage-time read
 * merely FAILED, so a new-file write could land on top of a file that exists
 * now, with no drift check, no merge and no warning. Empty is a baseline like
 * any other: an empty base against a file that has content is exactly the
 * insert-against-insert case mergeThreeWay already refuses, and refusing with
 * the message below beats overwriting somebody's file in silence. A file that
 * genuinely is not there still throws on the read and takes the create path.
 */
async function reconcile(
  jail: string,
  change: StagedChange,
): Promise<{ content: string; merged: number }> {
  const base = change.oldContent ?? ''
  let res: { content?: string; encoding?: string } | undefined
  try {
    res = await backendCall<{ content?: string; encoding?: string }>('fs_read', {
      path: change.resolvedPath || change.path,
      chatId: jail,
      workingDirectory: change.workingDirectory,
    })
  } catch {
    // gone or unreadable, the write recreates it, which is what the user asked for
    return { content: change.newContent, merged: 0 }
  }
  // Not UTF-8 on disk (bug hunt 01.10.2026, C8): read as '' it matched an
  // empty base and was overwritten without the drift check ever seeing it.
  if (typeof res?.content !== 'string' && (res?.encoding === 'binary' || res?.encoding === 'base64')) {
    throw new Error(
      `${change.path} is not a UTF-8 text file on disk, so this edit cannot be checked against it and was not applied. Reject this one and let the model read the file again.`,
    )
  }
  const current = res?.content ?? ''
  // The file on disk decides the form; an empty file inherits the model's.
  const eol = current ? eolOf(current) : eolOf(change.newContent)
  const baseLf = toLf(base)
  const currentLf = toLf(current)
  const newLf = toLf(change.newContent)
  if (currentLf === baseLf || currentLf === newLf) {
    return { content: withEol(change.newContent, eol), merged: 0 }
  }
  const merged = mergeThreeWay(baseLf, currentLf, newLf)
  if (merged.ok) {
    return { content: withEol(merged.content, eol), merged: merged.mergedRegions }
  }
  throw new Error(
    `${change.path} changed on disk in the same ${merged.conflicts === 1 ? 'place' : 'places'} this edit touches, so applying it would drop those changes. Everything else was left alone. Reject this one and let the model read the file again.`,
  )
}

/**
 * The sandbox the bridge falls back to when no folder is picked is keyed by
 * the chat's WORKSPACE SLUG (`resolveChatWorkspaceSlug`), which is what the
 * run passes as `chatId` on every tool call. Apply used to pass the raw
 * conversation id instead, so with no folder picked "Apply all" wrote into
 * `agent-workspace/<conversation id>` while the run had read, listed and
 * executed in `agent-workspace/<slug>`: the model then found nothing where it
 * had put it and wrote the files a second time by shell (t10 measurement on
 * the box, 2026-09-06). Same resolver, same pin, same folder.
 */
async function jailFor(chatId: string): Promise<string> {
  const title = useChatStore.getState().conversations?.find((c) => c.id === chatId)?.title
  return resolveChatWorkspaceSlug(chatId, title)
}

/** True when the change is still queued. A Reject removes it from the store;
 *  the Apply loops run over a snapshot and the reconcile read is async, so
 *  without this check a change the user rejected mid "Apply all" was written
 *  anyway. */
function stillPending(chatId: string, change: StagedChange): boolean {
  return useStagedChangesStore.getState().list(chatId).some((c) => c.id === change.id)
}

type AppliedListener = (chatId: string, changeId: string) => void
const appliedListeners = new Set<AppliedListener>()

/** Hears every staged change that landed on disk, just before it leaves the
 *  queue (lib/remote-chats-bridge tells "applied" from "rejected" by it). */
export function subscribeStagedApplied(fn: AppliedListener): () => void {
  appliedListeners.add(fn)
  return () => { appliedListeners.delete(fn) }
}

type FailedListener = (chatId: string, changeId: string, reason: string) => void
const failedListeners = new Set<FailedListener>()

/** Hears every apply that failed; the change stays in the queue. */
export function subscribeStagedFailed(fn: FailedListener): () => void {
  failedListeners.add(fn)
  return () => { failedListeners.delete(fn) }
}

/** Writes one staged change. Returns false, without writing, when the user
 *  rejected it before the write happened. */
export async function applyStagedChange(chatId: string, change: StagedChange): Promise<boolean> {
  try {
    return await applyStagedChangeInner(chatId, change)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    for (const fn of failedListeners) {
      try { fn(chatId, change.id, reason) } catch { /* a listener never changes the outcome */ }
    }
    throw e
  }
}

async function applyStagedChangeInner(chatId: string, staged: StagedChange): Promise<boolean> {
  if (!stillPending(chatId, staged)) return false
  // Hunks the user rejected are left out: the file gets the original text
  // there. The latest decisions count, read from the store, since the caller
  // may hold a snapshot from before the last click.
  const latest = useStagedChangesStore.getState().get(chatId, staged.id) ?? staged
  const partial = contentWithDecisions(latest.oldContent ?? '', latest.newContent, latest.hunkDecisions)
  const change: StagedChange = { ...latest, newContent: partial.content }
  const jail = await jailFor(chatId)
  const { content, merged } = await reconcile(jail, change)
  if (!stillPending(chatId, change)) return false
  const res = await backendCall<{ status?: string; path?: string }>('fs_write', {
    path: change.resolvedPath || change.path,
    content,
    chatId: jail,
    workingDirectory: change.workingDirectory,
  })
  // 'saved' and 'unchanged' are both success ('unchanged' = the file already
  // matched byte-for-byte). Anything else is a real failure worth retrying.
  if (res?.status && res.status !== 'saved' && res.status !== 'unchanged') {
    throw new Error(`fs_write returned status "${res.status}"`)
  }
  for (const fn of appliedListeners) {
    try { fn(chatId, change.id) } catch { /* a listener never stops the write */ }
  }
  const total = partial.model.hunks.length
  const left = partial.rejected.length
  if (left > 0) {
    useStagedChangesStore.getState().addNote(chatId, {
      changeId: change.id,
      path: change.path,
      text: partialNote(change.path, partial.rejected.map(describeHunk), total),
    })
  }
  useStagedChangesStore.getState().remove(chatId, change.id)
  // Mirror the apply in the chat log so the user sees a confirmation in the
  // main pane, not just the side-pane entry disappearing. A merge is named as
  // one: the file that landed is not byte for byte the diff that was reviewed.
  //
  // This used to carry `hidden: true`, which made the sentence above a lie.
  // MessageList drops `hidden` AND every system role, CodexView drops
  // `hidden`, so the notice rendered nowhere at all, and the only line that
  // ever said "what landed is not what you approved" reached nobody. On a
  // write to disk that has no undo, that is the one thing the user must not
  // miss. The role stays 'system' so it still never reaches the model
  // (useCodex's payload builder filters that role out); `notice` is what tells
  // the view to render a plain line instead of an assistant bubble.
  useChatStore.getState().addMessage(chatId, {
    id: crypto.randomUUID(),
    role: 'system',
    content: (merged > 0
      ? `Applied staged change: ${change.path} (merged with ${merged} change${merged === 1 ? '' : 's'} made on disk since it was staged, so this file is not byte for byte the diff you approved)`
      : `Applied staged change: ${change.path}`)
      + (left > 0 ? ` (${total - left} of ${total} parts, ${left} rejected)` : ''),
    timestamp: Date.now(),
    notice: merged > 0 ? 'warn' : 'info',
  })
  return true
}

/** What the model hears when some hunks of a file were left out. */
export function partialNote(path: string, rejected: string[], total: number): string {
  return `The user applied your change to ${path} but rejected ${rejected.length} of ${total} parts (${rejected.join('; ')}). Those parts keep the original text. Read the file before you edit it again.`
}

/** What the model hears about a file the user rejected as a whole. */
export function rejectedNote(path: string): string {
  return `The user rejected your change to ${path}. Nothing was written to it.`
}

/** Reject one staged change and tell the model at its next tool result. */
export function rejectStagedChange(chatId: string, change: Pick<StagedChange, 'id' | 'path'>): void {
  const store = useStagedChangesStore.getState()
  if (!store.get(chatId, change.id)) return
  store.remove(chatId, change.id)
  store.addNote(chatId, { changeId: change.id, path: change.path, text: rejectedNote(change.path) })
}

/** Reject every staged change of a chat. */
export function rejectAllStagedChanges(chatId: string): void {
  for (const change of useStagedChangesStore.getState().list(chatId)) rejectStagedChange(chatId, change)
}

/** Apply the pending changes of a chat staged at or after `since` (all of
 *  them without it), sequentially (fs_write serializes per path anyway).
 *  Failures stay in the queue for manual retry and are reported by path
 *  instead of throwing, so one bad write never blocks the rest. */
export async function applyAllStagedChanges(
  chatId: string,
  since = 0,
): Promise<{ applied: string[]; failed: string[] }> {
  const applied: string[] = []
  const failed: string[] = []
  for (const change of useStagedChangesStore.getState().list(chatId).filter((c) => c.stagedAt >= since)) {
    try {
      if (await applyStagedChange(chatId, change)) applied.push(change.path)
    } catch {
      failed.push(change.path)
    }
  }
  return { applied, failed }
}

/** How the review of one staged change ended. */
export type StagedReview =
  | { outcome: 'applied' }
  | { outcome: 'rejected' }
  | { outcome: 'replaced' }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'stopped' }

/**
 * Waits until a staged change is decided: written (Apply at the desktop, or
 * once/chat on the paired phone), rejected (Reject, or deny), replaced by a
 * later write of the same file, or its apply failed (then it leaves the
 * queue, the model hears why). A stopped run stops waiting and leaves the
 * change for the desktop.
 */
export function waitForStagedReview(chatId: string, changeId: string, path: string, signal?: AbortSignal): Promise<StagedReview> {
  return new Promise((resolve) => {
    let landed = false
    let done = false
    const offs: Array<() => void> = []
    const finish = (r: StagedReview) => {
      if (done) return
      done = true
      for (const off of offs) off()
      resolve(r)
    }
    const check = () => {
      const list = useStagedChangesStore.getState().list(chatId)
      if (list.some((c) => c.id === changeId)) return
      if (landed) return finish({ outcome: 'applied' })
      return finish(list.some((c) => c.path === path) ? { outcome: 'replaced' } : { outcome: 'rejected' })
    }
    offs.push(subscribeStagedApplied((c, id) => { if (c === chatId && id === changeId) landed = true }))
    offs.push(subscribeStagedFailed((c, id, reason) => {
      if (c !== chatId || id !== changeId) return
      finish({ outcome: 'failed', reason })
      useStagedChangesStore.getState().remove(chatId, changeId)
    }))
    offs.push(useStagedChangesStore.subscribe(check))
    if (signal) {
      if (signal.aborted) return finish({ outcome: 'stopped' })
      const onAbort = () => finish({ outcome: 'stopped' })
      signal.addEventListener('abort', onAbort, { once: true })
      offs.push(() => signal.removeEventListener('abort', onAbort))
    }
    check()
  })
}
