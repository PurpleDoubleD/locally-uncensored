/**
 * Read-your-writes for Stage-and-Approve (codexStageMode).
 *
 * Staged file_write / file_edit calls never touch the disk — they sit in
 * stagedChangesStore until the user applies them. Without an overlay the
 * model's next file_read went to the DISK, found nothing (or the old bytes),
 * concluded its write failed, and staged the same file again, forever
 * (Morgan, 2026-07-26: a 5-minute file_read loop with three pending files).
 * These helpers answer reads from the staging queue instead, so the model
 * always sees its own pending work.
 */

import type { StagedChange } from '../types/staged-changes'

/** Normalize for comparison: forward slashes, no leading "./", no trailing "/". */
export function normalizeStagedPath(p: string): string {
  let out = String(p ?? '').trim().replace(/\\/g, '/')
  out = out.replace(/^\.\//, '')
  out = out.replace(/\/+$/, '')
  // Windows paths compare case-insensitively (same rule as side-effect-key).
  const isWindowsLike = /^[A-Za-z]:\//.test(out) || out.startsWith('//')
  return isWindowsLike ? out.toLowerCase() : out
}

/** The staged entry a read of `path` must see, if any. Matches the path the
 *  model wrote with AND the workspace-resolved absolute path. */
export function findStagedForPath(
  list: readonly StagedChange[],
  path: string,
): StagedChange | undefined {
  const target = normalizeStagedPath(path)
  if (!target) return undefined
  return list.find(
    (c) =>
      normalizeStagedPath(c.path) === target ||
      (c.resolvedPath ? normalizeStagedPath(c.resolvedPath) === target : false),
  )
}

/** file_read payload for a staged path: the pending content, plus a short
 *  marker so the model does not stage the identical bytes again. */
export function stagedReadResult(change: StagedChange): string {
  return (
    `${change.newContent}\n\n` +
    `[staged: this is your own pending version of ${change.path}. ` +
    'It is queued for user approval and NOT on disk yet. Do not write the same content again.]'
  )
}

/** Suffix for file_list / file_search results so pending files stay
 *  discoverable even though the disk does not have them yet. */
export function stagedListingNote(list: readonly StagedChange[]): string {
  if (list.length === 0) return ''
  const names = list.map((c) => c.path).join(', ')
  return `\n\n[staged, pending user approval (not on disk yet): ${names}. Use file_read to see their staged content.]`
}
