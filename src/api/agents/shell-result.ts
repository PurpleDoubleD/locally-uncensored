/**
 * What the terminal tool hands back to the model when a command printed a
 * lot, or is still running at its timeout (T1, CA rebuild).
 *
 * Pure text rules, no backend: the executor in builtin-tools.ts calls these,
 * the tests read them directly.
 *
 * The shape follows Claude Code and Codex: the start of a long output (the
 * command echo, the first error) and its end (the summary, the last error)
 * travel, the middle does not, and the cut says how much went missing and
 * where the rest is. The agent profile's own cap (16 000 characters for the
 * compact profile, `resultCharsFor` in lib/agent-profile.ts) still applies on
 * top, in the run loop, to whatever this returns.
 */

/** Characters kept from the start of a long output. */
export const SHELL_HEAD_CHARS = 2000
/** Characters kept from the end of a long output. */
export const SHELL_TAIL_CHARS = 6000

/**
 * Keep the first SHELL_HEAD_CHARS and the last SHELL_TAIL_CHARS of `text`,
 * with a marker in between that says how much was cut. `outputId` names the
 * task under which the whole output can be read; without it the marker says
 * only what was cut.
 *
 * Rust keeps a task for every output of 8000 bytes or more
 * (`KEEP_OUTPUT_FROM_BYTES` in shell.rs), and a character is never shorter
 * than a byte there, so whenever this cuts, Rust has kept the output.
 */
export function cutShellOutput(text: string, outputId?: string): string {
  if (text.length <= SHELL_HEAD_CHARS + SHELL_TAIL_CHARS) return text
  const head = text.slice(0, SHELL_HEAD_CHARS)
  const tail = text.slice(text.length - SHELL_TAIL_CHARS)
  const middle = text.slice(SHELL_HEAD_CHARS, text.length - SHELL_TAIL_CHARS)
  const lines = middle.split('\n').length - 1
  const where = outputId
    ? ` Full output: shell_execute with task "status" and task_id "${outputId}".`
    : ''
  return `${head}\n\n[… ${middle.length} characters (${lines} lines) cut …${where}]\n\n${tail}`
}

/** stdout and stderr as one text, stderr under a marker when both have something. */
export function joinShellStreams(stdout: string, stderr: string): string {
  const out = stdout.replace(/\s+$/, '')
  const err = stderr.replace(/\s+$/, '')
  if (!err) return out
  if (!out) return `[stderr]\n${err}`
  return `${out}\n[stderr]\n${err}`
}

/**
 * The result for a command that was still running at its timeout and now
 * runs on as a background task. The id is the one `shell_execute` with
 * `task: "status" | "kill"` and check_tasks know.
 *
 * The stop path is named as a shell_execute call and not as check_tasks:
 * check_tasks only reads, it runs without a confirmation, and killing a
 * process stays behind the same gate as starting one (and is refused in a
 * read-only turn).
 */
export function renderHandedOver(input: {
  taskId: string
  timeoutMs?: number
  stdout: string
  stderr: string
}): string {
  const secs = input.timeoutMs ? `${Math.round(input.timeoutMs / 1000)} s` : 'its timeout'
  const soFar = joinShellStreams(input.stdout, input.stderr)
  const body = soFar ? `Output so far:\n${cutShellOutput(soFar)}` : '(no output so far)'
  return (
    `Still running after ${secs}, so it was not stopped: it keeps running in the background as task ${input.taskId}.\n`
    + `${body}\n`
    + `Use check_tasks to read its output, or shell_execute with task "kill" and task_id "${input.taskId}" to stop it.`
  )
}
