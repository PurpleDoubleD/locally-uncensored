import { backendCall } from '../backend'

export interface BgTaskStatus {
  id: string
  command: string
  cwd: string | null
  started_at: number
  finished_at: number | null
  exit_code: number | null
  running: boolean
  cancelled: boolean
  output_tail: string
}

export interface BgTaskListResult {
  tasks: BgTaskStatus[]
}

/** Starts a long-running shell command in the bridge. Returns the new task id. */
export async function bgStart(input: {
  command: string
  cwd?: string
  shell?: string
  /** Chat context, so the task defaults to the same workspace the foreground
   *  shell tool uses instead of LU own process directory. */
  chatId?: string
  workingDirectory?: string
}): Promise<{ id: string }> {
  if (!input.command?.trim()) throw new Error('command is required')
  // The Rust bg_tasks commands take a SINGLE `args: serde_json::Value` param
  // (manually deserialized into StartArgs/IdArgs) — unlike `shell_execute`,
  // which uses flat params. So every payload MUST be wrapped in `{ args: … }`.
  // Sending the fields top-level (as the flat convention does) makes Tauri
  // reject the call with "missing required key args" — which silently broke
  // shell_execute_background / shell_task_status / _kill / _list for every
  // model (confirmed live 2026-06-02 via the Tauri bridge).
  return backendCall<{ id: string }>('shell_task_start', {
    args: {
      command: input.command,
      cwd: input.cwd,
      shell: input.shell,
      chat_id: input.chatId,
      working_directory: input.workingDirectory,
    },
  })
}

export async function bgStatus(id: string): Promise<BgTaskStatus> {
  return backendCall<BgTaskStatus>('shell_task_status', { args: { id } })
}

export async function bgKill(id: string): Promise<{ ok: boolean; cancelled: boolean }> {
  return backendCall<{ ok: boolean; cancelled: boolean }>('shell_task_kill', { args: { id } })
}

export async function bgList(): Promise<BgTaskListResult> {
  return backendCall<BgTaskListResult>('shell_task_list', { args: {} })
}

/**
 * Which shell tasks a conversation started (T1). The Rust registry knows no
 * conversations, and check_tasks must list only the tasks of the chat that
 * asks, so the frontend keeps the pairing. Module state: a task dies with the
 * app (exit sweep, Job Object on Windows), so there is nothing to persist.
 * After a webview reload the pairing is gone while a task may still run; it
 * stays reachable through shell_execute with task "list".
 */
const SHELL_TASKS_BY_CONV = new Map<string, string[]>()
/** Per conversation; the registry itself caps at 200 tasks. */
const SHELL_TASKS_PER_CONV_MAX = 20

export function rememberShellTask(convId: string | null | undefined, id: string): void {
  if (!convId || !id) return
  const ids = (SHELL_TASKS_BY_CONV.get(convId) ?? []).filter((x) => x !== id)
  ids.push(id)
  SHELL_TASKS_BY_CONV.set(convId, ids.slice(-SHELL_TASKS_PER_CONV_MAX))
}

export function shellTasksOf(convId: string | null | undefined): string[] {
  return convId ? [...(SHELL_TASKS_BY_CONV.get(convId) ?? [])] : []
}

/** Tests only. */
export function _resetShellTasksForTests(): void {
  SHELL_TASKS_BY_CONV.clear()
}

/** Renders a status payload as a one-line summary for the model / UI. */
export function renderBgStatusOneLine(s: BgTaskStatus): string {
  const phase = s.running
    ? 'running'
    : s.cancelled
      ? 'cancelled'
      : s.exit_code === 0
        ? 'ok'
        : `exit ${s.exit_code ?? '?'}`
  const elapsed = s.finished_at
    ? `${s.finished_at - s.started_at}s`
    : `${Math.max(0, Math.floor(Date.now() / 1000) - s.started_at)}s`
  return `[${s.id.slice(0, 8)}] ${phase} (${elapsed}), ${s.command}`
}
