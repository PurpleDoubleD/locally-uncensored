/**
 * Where the Coding Agent actually works, and when that may be changed.
 *
 * Both halves used to live inline in useCodex and in the two views, which is
 * how A8 (2.6.8) got as far as it did: the precedence was a three-line boolean
 * chain nobody could test, and "is a run in flight" was a different expression
 * on every surface. They are pure functions here, with the tests next to them.
 */

export interface CodexWorkDirInput {
  /** The folder pinned on this conversation's thread. */
  threadDir: string | null | undefined
  /** Per-chat agent workspace, or settings.defaultWorkspace, when folder-kind. */
  workspacePath: string | null | undefined
  /** The folder the Code tab's picker currently shows. */
  storeDir: string | null | undefined
}

/** The bridge's per-chat sandbox under ~/agent-workspace. */
export const CODEX_SANDBOX = '.'

/**
 * Precedence, unchanged from the inline version it replaces:
 *   1. the thread's own folder (the picker value, synced at every send)
 *   2. the resolved agent workspace, when it names a real folder
 *   3. the picker value again, for a thread that has not been synced yet
 *   4. the per-chat sandbox
 *
 * A thread carrying the literal '.' does NOT count as a pick. It is what
 * `initThread` writes when there is no folder, and treating it as one used to
 * hide a per-chat workspace behind a placeholder.
 */
export function resolveCodexWorkDir({
  threadDir,
  workspacePath,
  storeDir,
}: CodexWorkDirInput): string {
  const fromThread = threadDir && threadDir !== CODEX_SANDBOX ? threadDir : null
  return fromThread || workspacePath || storeDir || CODEX_SANDBOX
}

/**
 * What the agent falls back to when the picker is empty, in the words the user
 * needs. The empty state used to promise "~/agent-workspace" flat out, which is
 * a lie for anybody who set a default workspace in Settings or pinned a folder
 * on this chat: those win over an empty picker (see the precedence above).
 */
export function codexFallbackLabel(workspacePath: string | null | undefined): string {
  return workspacePath || '~/agent-workspace'
}

/**
 * Why the working directory is held right now, or null when it is free.
 *
 * 'run'  a coding turn is in flight, from the moment the send starts.
 * 'loop' a /loop is standing between two passes: the thread says idle, the
 *        next pass is on a timer, and moving the folder under it would send
 *        that pass somewhere else without anybody watching.
 */
export type CodexBusyReason = 'run' | 'loop'

export interface CodexBusyInput {
  /**
   * Sends that have started and not yet finished. Counted synchronously at the
   * top of sendInstruction: the thread status only flips to 'running' after
   * five awaits (workspace slug, tool support, token budget, memory, rules),
   * and the whole gap was unlocked before.
   */
  sendsInFlight: number
  /** codexStore.threads, for a turn that is past those awaits. */
  threads: Record<string, { status: string }>
  /** agentLoopStore.loop, or null when no /loop is standing. */
  loop: unknown | null
}

/**
 * Only Coding Agent signals count. The first cut read every conversation's
 * generating flag, so a streaming Chat tab in another conversation locked the
 * folder picker on Code for no reason at all.
 */
export function codexBusyReason({ sendsInFlight, threads, loop }: CodexBusyInput): CodexBusyReason | null {
  if (sendsInFlight > 0) return 'run'
  if (Object.values(threads).some((t) => t.status === 'running')) return 'run'
  if (loop) return 'loop'
  return null
}

/** One sentence per reason, so the two buttons cannot drift apart. */
export const CODEX_WORKDIR_LOCK_TITLE: Record<CodexBusyReason, string> = {
  run: 'Wait for the current run to finish, then you can change the folder.',
  loop: 'A loop is still running. Stop it first, then you can change the folder.',
}
