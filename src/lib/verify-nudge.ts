/**
 * The Code tab checks its own work before it says "done" (C59 A5).
 *
 * The prompt has always said "4. Verify, shell_execute to run tests, lint, or
 * build", and small models skip it: they edit, write a summary and stop. opencode
 * feeds diagnostics back after every edit, Fan et al. 2026 (arXiv 2609.20804)
 * count a verification step before "done" among the harness parts that matter.
 * Here the cheap half of that: a run that changed files and ran no check since
 * is told once, at the moment it wants to stop, to run one. The model picks the
 * command (it knows the project by then); a project with nothing to run gets to
 * say so and finish.
 */

const WRITE_TOOLS = new Set(['file_write', 'file_edit'])

/** A shell command that checks code: tests, a build, a type check, a linter. */
export function isCheckCommand(command: string): boolean {
  return /\b(?:test|tests|vitest|jest|mocha|pytest|unittest|tsc|eslint|ruff|mypy|flake8|clippy|lint|build|check|go\s+vet|make)\b|node\s+--test|cargo\s+(?:test|check|build|clippy)|python[0-9.]*\s+(?:-[a-zA-Z]+\s+)*\S+\.py/i.test(command)
}

export interface VerifyState {
  /** A file was written since the last check command. */
  unchecked: boolean
  nudged: boolean
}

export function newVerifyState(): VerifyState {
  return { unchecked: false, nudged: false }
}

/** Feed one round of finished calls. */
export function recordVerifyRound(
  state: VerifyState,
  results: Array<{ name: string; failed: boolean; command?: string }>,
): void {
  for (const r of results) {
    if (r.failed) continue
    if (WRITE_TOOLS.has(r.name)) state.unchecked = true
    else if (r.name === 'shell_execute' && r.command && isCheckCommand(r.command)) state.unchecked = false
  }
}

export const VERIFY_NUDGE =
  'You changed files but ran nothing to check them. Before you finish, run the project\'s tests, build or linter '
  + '(whatever this project has) with shell_execute and fix what fails. If there is nothing to run, say so in one sentence and finish.'

/** True once per run, when the run wants to stop with unchecked writes. */
export function verifyNudgeDue(state: VerifyState, opts: { readOnly: boolean; reviewMode: boolean }): boolean {
  if (state.nudged || !state.unchecked || opts.readOnly || opts.reviewMode) return false
  state.nudged = true
  return true
}
