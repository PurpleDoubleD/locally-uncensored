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
  let current: string
  try {
    const res = await backendCall<{ content?: string }>('fs_read', {
      path: change.resolvedPath || change.path,
      chatId: jail,
      workingDirectory: change.workingDirectory,
    })
    current = res?.content ?? ''
  } catch {
    // gone or unreadable, the write recreates it, which is what the user asked for
    return { content: change.newContent, merged: 0 }
  }
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

export async function applyStagedChange(chatId: string, change: StagedChange): Promise<void> {
  const jail = await jailFor(chatId)
  const { content, merged } = await reconcile(jail, change)
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
    content: merged > 0
      ? `Applied staged change: ${change.path} (merged with ${merged} change${merged === 1 ? '' : 's'} made on disk since it was staged, so this file is not byte for byte the diff you approved)`
      : `Applied staged change: ${change.path}`,
    timestamp: Date.now(),
    notice: merged > 0 ? 'warn' : 'info',
  })
}

/** Apply every pending change for a chat, sequentially (fs_write serializes
 *  per path anyway). Failures stay in the queue for manual retry and are
 *  reported by path instead of throwing, so one bad write never blocks the
 *  rest. */
export async function applyAllStagedChanges(
  chatId: string,
): Promise<{ applied: string[]; failed: string[] }> {
  const applied: string[] = []
  const failed: string[] = []
  for (const change of [...useStagedChangesStore.getState().list(chatId)]) {
    try {
      await applyStagedChange(chatId, change)
      applied.push(change.path)
    } catch {
      failed.push(change.path)
    }
  }
  return { applied, failed }
}
