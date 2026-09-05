/**
 * Agent slash commands (v2.5.3, extended in 2.5.9).
 *
 * Each command is a high-quality prompt template. A slash command is shorthand
 * for an AGENT task: the hook expands it to the full instruction below and runs
 * it through the normal executor with the full tool catalog (file_*,
 * shell_execute, git_*, web_*, …). So the templates are written for an agent
 * that ACTS via tools, not one that describes.
 *
 * Because a command is only text, it works the same on every tool-calling
 * schema — native function calling, the Hermes XML fallback, and the
 * template-fix path all receive the identical expansion.
 *
 * `readOnly` is ENFORCED, not decorative: useCodex strips the mutating tools
 * from the catalog for the turn a read-only command starts. Before 2.5.9 the
 * flag existed but nothing read it, so /review and /security could and did
 * rewrite files they were only meant to look at.
 *
 * Pure data + pure functions here — no React, no side effects — so it unit-tests
 * cleanly and the ChatInput autocomplete + the hooks share one source.
 */

import { READ_ONLY_SHELL_HINT } from './shell-command-classify'

export interface AgentCommand {
  /** Command word without the leading slash, e.g. "review". */
  name: string
  /** One-line summary shown in the autocomplete dropdown. */
  summary: string
  /** Argument hint shown after the name, e.g. "[file | \"changes\"]". */
  argHint?: string
  /**
   * True when the hook handles the command itself and never calls the model.
   * `/goal` is the only one: setting an objective is bookkeeping, and spending
   * a cloud round-trip to have a model acknowledge it would be theatre.
   * `build()` still returns text for these, used as the confirmation shown in
   * the transcript.
   */
  handledLocally?: true
  /**
   * True when the command must not touch anything. Enforced by the runner:
   * file_write / file_edit / shell_execute / code_execute / run_tests /
   * git_commit / git_push and the other mutating tools are removed from the
   * catalog for that turn, and read-only shell inspection is still available
   * through the read tools.
   */
  readOnly?: boolean
  /**
   * Where this command may be offered and parsed. Default `'agent'`.
   *
   * Every command in this file except one expands to an instruction for an
   * agent WITH TOOLS: /fix edits files, /test runs them, /review reads them.
   * In plain chat there is no tool catalogue, so offering them there would be
   * offering twenty ways to have the model narrate work it cannot do — which
   * is exactly why the menu was gated to Agent and Coding in the first place
   * (ChatView.tsx passes `isAgentActive`).
   *
   * `/compact` is the exception, and it is an exception of kind, not of
   * degree: it does not ask the model to DO anything in the workspace. It is
   * about the conversation, and every surface has one of those. So the gate
   * stops being "is the agent on?" and becomes "does this command need the
   * agent?" — which is the question it was always standing in for.
   */
  scope?: CommandScope
  /** Expand to the full agent instruction. `args` is the trimmed text after the command. */
  build: (args: string) => string
}

/**
 * Which surface is asking. `'agent'` covers Agent and Coding mode — both carry
 * the tool catalogue and both accept every command. `'chat'` is plain chat,
 * which only sees commands explicitly marked for it.
 */
export type CommandScope = 'agent' | 'chat'

/** May this command be offered on that surface? */
export function commandInScope(command: AgentCommand, scope: CommandScope): boolean {
  return scope === 'agent' || (command.scope ?? 'agent') === 'chat'
}

/** Shared closing line so every command nudges the agent to act, not narrate. */
const ACT = 'Use your tools to do this for real — do not just describe the steps. Be concise in text; the work happens in tool calls. Reply in the user\'s language.'

/** Pause between passes when the user names none. Short, because the value of a
 *  loop is the re-check, not the waiting. */
export const DEFAULT_LOOP_INTERVAL_MS = 5 * 1000
/** Longest pause we will sit idle between passes. */
export const MAX_LOOP_INTERVAL_MS = 30 * 60 * 1000

/** The model ends a pass with one of these so the driver knows what to do. */
export const LOOP_DONE_MARKER = 'LOOP_DONE'
export const LOOP_CONTINUE_MARKER = 'LOOP_CONTINUE'

/**
 * Did the model declare this pass finished?
 *
 * Deliberately generous about what follows the marker, because the template
 * ASKS for a reason after it. Qwen3-32B wrote `LOOP_DONE (verified by
 * code_execute test)` and an end-anchored match missed it, so the loop kept
 * re-running an already-finished task (caught live on the ship exe,
 * 2026-07-25). A CONTINUE anywhere wins: if the model said both, it is not
 * done.
 */
export function loopPassSaysDone(answer: string): boolean {
  if (!answer) return false
  const hasContinue = new RegExp(`\\b${LOOP_CONTINUE_MARKER}\\b`).test(answer)
  if (hasContinue) return false
  return new RegExp(`\\b${LOOP_DONE_MARKER}\\b`).test(answer)
}

/**
 * Pull a leading interval off `/loop`'s arguments: `30s`, `20m`, `2h`,
 * `1h30m`, or a bare number read as minutes. Returns the interval in ms plus
 * the remaining task text.
 *
 * This is the PAUSE BETWEEN PASSES, not a deadline. `/loop 30s <task>` means
 * "work on it, then every 30 seconds look again and keep going until it is
 * genuinely done" — the point is the repeated re-examination, so a model that
 * declares victory early gets caught. An earlier version read it as a time
 * limit, and Qwen3-32B then tried to cram the whole task into 30 seconds
 * (David, 2026-07-25).
 *
 * Only a compact token at the very start counts, so "fix 20m of flakiness"
 * stays a task.
 */
export function parseLoopSpec(args: string): { intervalMs: number; rest: string } {
  const text = args.trim()
  const m = /^(\d+\s*h(?:\s*\d+\s*m)?|\d+\s*m(?:in)?|\d+\s*s(?:ec)?|\d+)\b[\s,:-]*/i.exec(text)
  if (!m) return { intervalMs: DEFAULT_LOOP_INTERVAL_MS, rest: text }

  const token = m[1].replace(/\s+/g, '').toLowerCase()
  let ms = 0
  const hm = /^(\d+)h(?:(\d+)m)?$/.exec(token)
  if (hm) ms = Number(hm[1]) * 3_600_000 + Number(hm[2] ?? 0) * 60_000
  else if (/^\d+m(in)?$/.test(token)) ms = parseInt(token, 10) * 60_000
  else if (/^\d+s(ec)?$/.test(token)) ms = parseInt(token, 10) * 1000
  else ms = parseInt(token, 10) * 60_000 // bare number = minutes

  if (!ms) return { intervalMs: DEFAULT_LOOP_INTERVAL_MS, rest: text }
  return { intervalMs: Math.min(ms, MAX_LOOP_INTERVAL_MS), rest: text.slice(m[0].length).trim() }
}

/**
 * The instruction for pass 2 and beyond. The whole point of the loop: make the
 * model re-read the ORIGINAL task and audit its own last pass, because "done"
 * from a model that just did work is the least reliable claim it makes.
 */
export function buildLoopRecheck(task: string, pass: number): string {
  return `This is pass ${pass} of a loop on this task:

${task}

Do not assume the previous pass was right. Re-read the task, then check the actual current state with your tools — the files, the test run, the build. Specifically:
- Anything claimed as done that you have not PROVEN is still open. Prove it or fix it.
- Anything the task asks for that has not been touched at all.
- Anything the last pass broke on the way.

If work remains, do it now and end your reply with ${LOOP_CONTINUE_MARKER} on its own line.
If everything the task asks for is done AND verified, end your reply with ${LOOP_DONE_MARKER} on its own line, and name the check that proved it. Do not write ${LOOP_DONE_MARKER} on a hunch — an honest ${LOOP_CONTINUE_MARKER} costs one more pass, a wrong ${LOOP_DONE_MARKER} ships a broken result. ${ACT}`
}

/** "20m" / "1h 30m" / "45s" for the prompt and the UI. */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const mins = Math.round(total / 60)
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

/**
 * Wie ein Nur-Lesen-Zug schauen darf, und zwar genau so weit, wie er es wirklich
 * darf.
 *
 * Der zweite Satz stand bis zum 05.09.2026 als "You have no write or shell
 * tools on this turn, so do not plan to use them". Seit dem 2.6.6-Werkzeugschnitt
 * ist das falsch: `shell_execute` UEBERLEBT den Strip mit Absicht
 * (`allowedInReadOnlyTurn`), weil die frueheren Einzelwerkzeuge git_status,
 * git_log und git_diff darin aufgegangen sind, und der Executor laesst die
 * Inspektionsbefehle durch. Ein `/review` ohne Argument prueft "the current
 * uncommitted changes" und bekam gesagt, es duerfe genau das Werkzeug nicht
 * anfassen, mit dem es diese Aenderungen ueberhaupt findet.
 *
 * Der erlaubte Teil kommt jetzt aus derselben Konstante wie die Ablehnung im
 * Executor. Modell und Waechter koennen also nicht mehr auseinanderlaufen.
 */
const LOOK =
  'Read the real code with file_read / file_list / file_search first, never answer from memory. ' +
  `You cannot write files on this turn, and you cannot run arbitrary commands. ${READ_ONLY_SHELL_HINT}`

export const AGENT_COMMANDS: AgentCommand[] = [
  // ── Context ───────────────────────────────────────────────────────────
  {
    name: 'compact',
    summary: 'Summarise the older turns so the conversation keeps going',
    argHint: '[what to focus on]',
    scope: 'chat',
    // Handled by the hook, like /goal — but unlike /goal this one DOES spend a
    // round trip, because writing the summary is the work. `handledLocally`
    // means "the hook decides what happens", not "no model is involved": the
    // flag's job is to keep this text out of the model as an INSTRUCTION. If
    // it were expanded and sent like /fix, the model would be asked to
    // summarise inside the very turn whose context is the problem, and the
    // answer would land in the transcript as a reply rather than replacing
    // anything.
    //
    // build() is therefore the line the USER reads, same as /goal.
    handledLocally: true,
    build: (a) => {
      const focus = a.trim()
      return focus ? `compact: focus on ${focus}` : 'compact'
    },
  },

  // ── Steer ─────────────────────────────────────────────────────────────
  {
    name: 'goal',
    summary: 'Set the standing objective for this session',
    argHint: '[objective | "clear"]',
    handledLocally: true,
    // Never reaches a model. The hook writes agentGoalStore and prints this
    // confirmation; every later turn gets the goal in its system prompt.
    // build() is only the transcript line, so it is written for the USER.
    build: (a) => {
      const arg = a.trim()
      if (!arg) return 'goal: read'
      if (/^(clear|off|none|reset)$/i.test(arg)) return 'goal: clear'
      return `goal: set ${arg}`
    },
  },
  {
    name: 'loop',
    summary: 'Work, then re-check again and again until it is really done',
    argHint: '[30s] <task, and how you will know it is done>',
    build: (a) => {
      const { intervalMs, rest } = parseLoopSpec(a)
      const task = rest || 'the task the user just described'
      return `Work on this: ${task}

This is pass 1 of a LOOP. The app will bring you back roughly every ${formatDuration(intervalMs)} to look at it again, for as long as it takes, and each time you will be asked to prove what you claimed. So do not rush to a finish and do not pad the answer. The loop only ends when you say it is done or the user stops it, so a premature finish just wastes everyone's time.

Each pass:
1) Do the next concrete step.
2) VERIFY it — run the tests, the build, the command, whatever actually proves it. Reading your own change back is not verification.
3) If the check fails, fix the cause and check again.

End this reply with ${LOOP_CONTINUE_MARKER} on its own line if anything is left, or ${LOOP_DONE_MARKER} on its own line if everything the task asks for is done AND verified, naming the check that proved it. A wrong ${LOOP_DONE_MARKER} ships a broken result; an honest ${LOOP_CONTINUE_MARKER} costs one more pass.

Say so plainly and end with ${LOOP_DONE_MARKER} if you are genuinely stuck: the same fix failing twice, a decision only the user can make, or something you would have to guess at. Never loosen a check to make it pass, and never delete or skip a test to go green. ${ACT}`
    },
  },

  // ── Understand ────────────────────────────────────────────────────────
  {
    name: 'plan',
    summary: 'Work out the steps before changing anything',
    argHint: '<what you want done>',
    readOnly: true,
    build: (a) => {
      const goal = a.trim() || 'the task the user just described'
      return `Produce a concrete plan for: ${goal}. ${LOOK} Then give: the files that actually need to change and why each one, the order to do them in, the one risk most likely to bite, and how you would know it worked. Keep it to the steps a person would follow, no padding. Do not start implementing — this is the plan only. ${ACT}`
    },
  },
  {
    name: 'explain',
    summary: 'Explain how a file, function or the codebase works',
    argHint: '<file | function | topic>',
    readOnly: true,
    build: (a) => {
      const what = a.trim() || 'this project: scan the structure with file_list and read the entry points'
      return `Explain ${what}. ${LOOK} Give: a one-paragraph overview, then the key pieces (what each does and how they connect), the important data flow or control flow, and any non-obvious gotchas. Use short concrete references like file:line. ${ACT}`
    },
  },
  {
    name: 'find',
    summary: 'Locate where something is implemented',
    argHint: '<symbol | behaviour | string>',
    readOnly: true,
    build: (a) => {
      const what = a.trim() || 'the thing the user just asked about'
      return `Find where ${what} lives in this codebase. Use file_search for the obvious spellings, then widen: the same idea under a different name, the call sites, the tests that cover it, and the config that switches it on. ${LOOK} Report the definition first with its file:line, then the call sites, then anything closely related worth knowing. If it does not exist here, say so plainly rather than guessing at the nearest match. ${ACT}`
    },
  },
  {
    name: 'diff',
    summary: 'Show and explain what changed',
    argHint: '[file | ref]',
    readOnly: true,
    build: (a) => {
      const scope = a.trim()
        ? `the changes in "${a.trim()}"`
        : 'the current uncommitted changes'
      return `Explain ${scope}. Read the changed files with file_read and work out what actually changed and why it matters. ${LOOK} Group by intent, not by file: what behaviour is different now, what is pure refactor, what looks accidental. Flag anything that looks unintentional — a stray debug line, a commented-out block, a changed default. End with one line on whether this is safe to commit. ${ACT}`
    },
  },
  {
    name: 'log',
    summary: 'Summarize what happened recently in this repo',
    argHint: '[count | path]',
    build: (a) => {
      const scope = a.trim() ? `Focus on "${a.trim()}".` : 'Look at roughly the last 20 commits.'
      return `Summarize this repository's recent history. Run "git log" with a useful format via shell_execute (include stat so you can see scale). ${scope} Report: the themes of the work, which areas of the codebase moved most, anything that looks like a revert or a hotfix, and the current branch state versus its upstream. If this is not a git repository, say so and stop. ${ACT}`
    },
  },
  {
    name: 'todo',
    summary: 'Find and triage TODO, FIXME and HACK markers',
    argHint: '[path]',
    readOnly: true,
    build: (a) => {
      const scope = a.trim() ? `under "${a.trim()}"` : 'across the project'
      return `Find every TODO, FIXME, HACK and XXX marker ${scope} with file_search, then read enough around each one to judge it. ${LOOK} Report them grouped: still relevant and worth doing, already done and safe to delete, and vague notes that need their author. Give each a file:line and one line on what it would take. Put the ones that are actually load-bearing first. ${ACT}`
    },
  },

  // ── Change ────────────────────────────────────────────────────────────
  {
    name: 'fix',
    summary: 'Diagnose and fix a bug or failing test end-to-end',
    argHint: '<error text | file>',
    build: (a) => {
      const what = a.trim() || 'the failing test or error in the current project (run the tests / build to surface it first)'
      return `Diagnose and fix: ${what}. 1) Reproduce — run the test/build/command that fails and read the real error. 2) Locate the root cause with file_search / file_read (fix the cause, not the symptom). 3) Apply the minimal correct fix with file_edit. 4) Re-run to prove it's fixed. 5) Briefly state the root cause and the fix. ${ACT}`
    },
  },
  {
    name: 'types',
    summary: 'Fix type or compile errors until the build is clean',
    argHint: '[file | package]',
    build: (a) => {
      const scope = a.trim() ? `Start with "${a.trim()}".` : 'Start with whatever the checker reports first.'
      return `Get this project type-checking or compiling cleanly. 1) Find the right checker and run it via shell_execute (tsc --noEmit, mypy, cargo check, go build — whatever this project actually uses; read package.json / the build config first). 2) ${scope} 3) Fix the real cause of each error with file_edit — never silence one with "any", a blanket ignore comment, or a cast, unless you explain in the summary why nothing else was possible. 4) Re-run the checker until it is clean or only pre-existing unrelated errors remain. 5) Report what you fixed and what you deliberately left. ${ACT}`
    },
  },
  {
    name: 'test',
    summary: 'Find, run and report the project tests',
    argHint: '[file | pattern]',
    build: (a) => {
      const scope = a.trim() ? `Focus on tests matching "${a.trim()}".` : 'Run the most relevant test suite.'
      return `Run the project's tests and report the result. 1) Detect the test runner (look for package.json scripts, pytest, cargo test, go test, etc. via file_read / file_list). 2) ${scope} Run it with shell_execute. 3) Summarize pass/fail counts and quote the first few real failures with their file:line. 4) If a failure has an obvious, low-risk fix, apply it and re-run to confirm; otherwise just report it. ${ACT}`
    },
  },
  {
    name: 'refactor',
    summary: 'Refactor code for clarity without changing behavior',
    argHint: '<file | function>',
    build: (a) => {
      const what = a.trim() || 'the file the user is focused on (ask which if it is unclear)'
      return `Refactor ${what} to improve readability and structure WITHOUT changing its observable behavior. 1) Read it fully first. 2) Make the change with file_edit — improve names, remove duplication, simplify control flow, tighten types; keep the public API identical. 3) If tests exist, run them to prove behavior is unchanged. 4) Summarize what you changed and why. Do not mix in unrelated changes. ${ACT}`
    },
  },
  {
    name: 'clean',
    summary: 'Remove dead code, unused imports and leftovers',
    argHint: '[file | path]',
    build: (a) => {
      const scope = a.trim() || 'the files the user has been working in (identify them from git status if this is a repo)'
      return `Clean up ${scope}. Look for: unused imports, unreachable code, functions and constants nothing references, commented-out blocks, stray debug logging, and files nothing imports. Prove each one is unused with file_search BEFORE deleting it — a dynamic import, a string-keyed lookup or a test can be the only reference. Remove them with file_edit, then run the tests and the type checker to show nothing broke. List everything you removed and everything you suspected but left, with the reason. ${ACT}`
    },
  },
  {
    name: 'optimize',
    summary: 'Find and apply performance improvements',
    argHint: '<file | function>',
    build: (a) => {
      const what = a.trim() || 'the hottest path in the current project (identify it first by reading the code)'
      return `Optimize the performance of ${what}. 1) Read it and identify the real bottleneck (algorithmic complexity, redundant work, N+1 calls, unnecessary allocations, blocking I/O) — measure with a quick benchmark via shell_execute if feasible. 2) Apply the highest-impact change with file_edit, preserving behavior. 3) Verify correctness (run tests if present) and, if you benchmarked, report before/after. Don't micro-optimize cold paths. ${ACT}`
    },
  },

  // ── Check ─────────────────────────────────────────────────────────────
  {
    name: 'review',
    summary: 'Review code for bugs, security and style',
    argHint: '[file | "changes"]',
    readOnly: true,
    build: (a) => {
      const target = a.trim() || 'the current uncommitted changes (read the changed files directly; if this is not a repo, review the most relevant source files)'
      return `Do a focused code review of ${target}. ${LOOK} Report findings grouped by severity (Critical / Major / Minor), each with the file:line, what's wrong, and a concrete fix. Cover correctness/bugs, security, error handling, and clarity. End with a one-line verdict. ${ACT}`
    },
  },
  {
    name: 'security',
    summary: 'Security audit — find vulnerabilities by severity',
    argHint: '[file | "."]',
    readOnly: true,
    build: (a) => {
      const scope = a.trim() || 'the project (scan the most security-relevant files: auth, input handling, file/network/shell access, secrets, dependencies)'
      return `Do a security audit of ${scope}. ${LOOK} Look for: injection (SQL/command/path), unsafe input handling, auth/authorization gaps, SSRF, secrets committed in code, unsafe deserialization, and risky dependencies. Report each finding with severity (Critical/High/Medium/Low), the file:line, why it's exploitable, and the fix. If you find nothing serious, say so honestly rather than padding the list. ${ACT}`
    },
  },
  {
    name: 'deps',
    summary: 'Audit dependencies — outdated, unused, risky',
    argHint: '[package]',
    build: (a) => {
      const focus = a.trim() ? `Pay particular attention to "${a.trim()}".` : ''
      return `Audit this project's dependencies. 1) Read the manifest and lockfile (package.json, requirements.txt, Cargo.toml, go.mod — whichever exists). 2) Run the ecosystem's own audit and outdated commands via shell_execute where they exist (npm audit, pip-audit, cargo audit, …); if none is available say so instead of guessing at versions. 3) Cross-check for dependencies nothing imports, using file_search. ${focus} Report: known vulnerabilities worth acting on, majors that are far behind, and unused entries safe to drop. Do NOT upgrade anything yet — this is the report. ${ACT}`
    },
  },

  // ── Ship ──────────────────────────────────────────────────────────────
  {
    name: 'commit',
    summary: 'Stage changes and write a clean git commit',
    argHint: '[message hint]',
    build: (a) => {
      const hint = a.trim() ? `\nThe user suggests this focus for the message: "${a.trim()}".` : ''
      return `Create a git commit for the current changes. Steps, each as a real tool call: 1) "git status" and "git diff" to see what changed. 2) Group the changes and stage the right files ("git add"). 3) Write a clear Conventional-Commits message (type(scope): summary, then a short body explaining WHY). 4) Commit. 5) Show the resulting "git log -1 --stat".${hint} Do NOT push. If this is not a git repository, say so and stop. ${ACT}`
    },
  },
  {
    name: 'pr',
    summary: 'Push the branch and open a pull request',
    argHint: '[title or focus]',
    build: (a) => {
      const hint = a.trim() ? `\nThe user suggests this focus for the title: "${a.trim()}".` : ''
      return `Open a pull request for the current work. 1) "git status" and "git log" against the base branch so you know exactly what is going out. 2) If the work is still on the default branch, create a descriptive branch first. 3) Make sure everything intended is committed — if there are uncommitted changes, say what they are and ask before including them. 4) Push the branch. 5) Open the PR with a title that says what changed and a body covering what, why, and how it was verified.${hint} If this is not a git repository, or there is no remote, say so and stop. ${ACT}`
    },
  },
  {
    name: 'undo',
    summary: 'Revert the last change and explain what was rolled back',
    argHint: '[file]',
    build: (a) => {
      const scope = a.trim() ? `Limit this to "${a.trim()}".` : ''
      return `Roll back the most recent change. 1) FIRST show the user exactly what would be lost — "git status" and "git diff" (or "git show HEAD" if the change is already committed). 2) ${scope} Decide the right mechanism: restore the working tree for uncommitted edits, or revert the commit if it is already in history. Never rewrite published history and never force anything. 3) Do it. 4) Confirm the result with a fresh status and diff. If this is not a git repository there is no safety net, so stop and say so instead of deleting anything. ${ACT}`
    },
  },
  {
    name: 'docs',
    summary: 'Generate or update documentation',
    argHint: '[file | "readme"]',
    build: (a) => {
      const target = a.trim()
        ? `documentation for "${a.trim()}"`
        : 'the project README (create or update README.md)'
      return `Write or update ${target}. Read the real code first so the docs are accurate. For a README: a clear title + one-line description, install/setup, usage with a runnable example, and key features — match the project's actual stack. For a file/module: concise doc-comments on the public functions. Write the file(s) with file_write. Keep it accurate and skimmable, no filler. ${ACT}`
    },
  },
  {
    name: 'init',
    summary: 'Scan the project and write an AGENTS.md overview',
    argHint: '',
    build: () =>
      `Analyze this project and write an AGENTS.md at its root that helps an AI agent work here effectively. 1) Explore the structure with file_list and read the key config + entry-point files. 2) Write AGENTS.md with file_write containing: project purpose (one paragraph), the tech stack, how to build / run / test (the real commands), the directory layout (what lives where), and any important conventions or gotchas you observed. Keep it factual and based on what you actually read — no guessing. If an AGENTS.md already exists, update it. ${ACT}`,
  },
]

const BY_NAME = new Map(AGENT_COMMANDS.map((c) => [c.name, c]))

/** Look a command up by name (without the slash). */
export function getAgentCommand(name: string): AgentCommand | undefined {
  return BY_NAME.get(name.toLowerCase())
}

/**
 * Parse a chat input into a slash command + expanded agent prompt, or null if
 * it isn't a known command. Matches only `/<name>` at the very start (optionally
 * followed by args). `/notacommand` and a bare `/` return null so they fall
 * through to normal chat. The leading slash and name are case-insensitive.
 */
export function parseAgentCommand(
  input: string,
  scope: CommandScope = 'agent',
): { command: AgentCommand; args: string; expanded: string } | null {
  const m = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(input.trim())
  if (!m) return null
  const command = BY_NAME.get(m[1].toLowerCase())
  if (!command) return null
  // Out of scope is the same answer as unknown: null, so the text falls
  // through to normal chat unchanged. Anything else would mean a plain-chat
  // "/fix the login" silently becoming an agent instruction on a surface with
  // no tools to carry it out.
  if (!commandInScope(command, scope)) return null
  const args = (m[2] ?? '').trim()
  return { command, args, expanded: command.build(args) }
}

/**
 * Autocomplete: given what the user has typed after a leading `/`, return the
 * matching commands (prefix match on the name, case-insensitive). An empty
 * prefix returns all of them. Returns [] when the text isn't a lone slash token
 * (e.g. there's already a space → the user is typing args, not picking).
 *
 * Only LEADING whitespace is trimmed, matching parseAgentCommand. They
 * disagreed before 2.5.9: a leading space or newline killed the menu while
 * sending still expanded the command, so the feature looked broken exactly when
 * someone hit space first. A TRAILING space still closes the menu, because that
 * is the user moving on to type arguments.
 */
export function matchAgentCommands(
  input: string,
  scope: CommandScope = 'agent',
): AgentCommand[] {
  const m = /^\/([a-z0-9_-]*)$/i.exec(input.replace(/^\s+/, ''))
  if (!m) return []
  const prefix = m[1].toLowerCase()
  return AGENT_COMMANDS.filter((c) => c.name.startsWith(prefix) && commandInScope(c, scope))
}
