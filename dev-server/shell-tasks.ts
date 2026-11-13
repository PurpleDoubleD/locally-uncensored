import type { ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'

/**
 * The dev server's twin of the app's background-task registry
 * (src-tauri/src/commands/bg_tasks.rs), for T1: a `/local-api/shell-execute`
 * that outruns its timeout with `backgroundOnTimeout: true` is not killed but
 * moved here, and the bench reads and stops it through the same
 * `shell_task_status` / `shell_task_kill` / `shell_task_list` calls the app
 * makes (src/api/backend.ts maps them to the routes in exec-routes.ts).
 *
 * The status has the Rust shape (`BgTaskStatus`, snake_case, seconds), so
 * the tool layer cannot tell the two backends apart.
 *
 * The process is already inside the bench sandbox when it gets here: it was
 * spawned through `fenceShell` by the shell route, and adopting it changes
 * nothing about how it runs.
 */

/** How much output a task keeps, from its end. The Rust side keeps head and tail; here the end is enough for the bench. */
export const DEV_TASK_OUTPUT_MAX = 256 * 1024
/** Same cap as the Rust registry. */
const DEV_TASKS_MAX = 200

export interface DevTaskStatus {
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

interface DevTask {
  status: DevTaskStatus
  proc: ChildProcess | null
  /** Spawned with `detached: true` on POSIX: the pid is a process group. */
  group: boolean
}

const TASKS = new Map<string, DevTask>()
let exitHookArmed = false

const nowSecs = () => Math.floor(Date.now() / 1000)

function append(task: DevTask, text: string): void {
  const next = task.status.output_tail + text
  task.status.output_tail = next.length > DEV_TASK_OUTPUT_MAX ? next.slice(-DEV_TASK_OUTPUT_MAX) : next
}

/** The shell and everything it started. A process group when there is one. */
export function killProcessTree(proc: ChildProcess, group: boolean): void {
  if (proc.pid === undefined) return
  try {
    if (group && process.platform !== 'win32') process.kill(-proc.pid, 'SIGKILL')
    else proc.kill('SIGKILL')
  } catch {
    // Already gone.
  }
}

/** Kill every task that still runs. Armed on process exit, so a dev server that stops leaves nothing behind. */
export function killAllDevTasks(): void {
  for (const t of TASKS.values()) {
    if (t.status.running && t.proc) killProcessTree(t.proc, t.group)
  }
}

function insert(id: string, task: DevTask): void {
  if (TASKS.size >= DEV_TASKS_MAX) {
    for (const [k, t] of TASKS) {
      if (!t.status.running) { TASKS.delete(k); break }
    }
  }
  TASKS.set(id, task)
  if (!exitHookArmed) {
    exitHookArmed = true
    process.on('exit', killAllDevTasks)
  }
}

/**
 * Take over a running shell process. `soFar` is what the route collected
 * until the timeout; everything after it is appended as it arrives.
 */
export function adoptProcess(input: {
  proc: ChildProcess
  group: boolean
  command: string
  cwd: string | null
  soFar: string
}): string {
  const id = randomUUID()
  const task: DevTask = {
    status: {
      id,
      command: input.command,
      cwd: input.cwd,
      started_at: nowSecs(),
      finished_at: null,
      exit_code: null,
      running: true,
      cancelled: false,
      output_tail: '',
    },
    proc: input.proc,
    group: input.group,
  }
  append(task, input.soFar)
  input.proc.stdout?.on('data', (d: Buffer) => append(task, d.toString()))
  input.proc.stderr?.on('data', (d: Buffer) => append(task, d.toString()))
  input.proc.on('exit', (code) => {
    task.status.running = false
    task.status.finished_at = nowSecs()
    task.status.exit_code = task.status.cancelled ? null : code
    task.proc = null
  })
  insert(id, task)
  return id
}

export function devTaskStatus(id: string): DevTaskStatus | undefined {
  const t = TASKS.get(id)
  return t ? { ...t.status } : undefined
}

export function devTaskKill(id: string): { ok: boolean; cancelled: boolean; reason?: string } | undefined {
  const t = TASKS.get(id)
  if (!t) return undefined
  if (!t.status.running || !t.proc) return { ok: true, cancelled: false, reason: 'already finished' }
  t.status.cancelled = true
  killProcessTree(t.proc, t.group)
  return { ok: true, cancelled: true }
}

/** Newest first, like the Rust listing. */
export function devTaskList(): DevTaskStatus[] {
  return [...TASKS.values()].map((t) => ({ ...t.status })).reverse()
}
