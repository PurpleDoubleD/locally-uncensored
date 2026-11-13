/**
 * Loop guard for the agent ReAct loops (Codex + Chat agent).
 *
 * Born from a live failure (Morgan, 2026-07-26): the coding agent repeated
 * the same file_read and the same narration line for 5 minutes. The old
 * detector only halted on the same batch signature 3× IN A ROW — alternating
 * batches, an injected nudge, or one varying argument reset the counter every
 * time, so a real loop never tripped it while the budget allowed 200
 * iterations of it.
 *
 * Four complementary detectors, all pure and cheap. The dividing line is the
 * mutation epoch: any side-effecting call (shell, write, git mutation) may
 * change what the next identical call returns, so repeat detection that spans
 * a mutation would punish legitimate edit → test → edit → test cycles. Every
 * epoch-scoped counter therefore resets on a mutating batch.
 *
 *  1. Identical batches back-to-back (old-guard parity, any tool class):
 *     3 in a row halts. Survives mutations on purpose — three byte-identical
 *     batches with nothing else between them is a stall even for shell.
 *
 *  2. Windowed signatures among PURE-READ batches: the same signature 3×
 *     within the last 6 read-only batches halts, consecutive or not. Catches
 *     the A,B,A,B,A alternation that detector 1 can never see.
 *
 *  3. Identical read calls within an epoch: a repeated read with
 *     byte-identical arguments cannot return new information while the
 *     workspace is unchanged. The 3rd identical read steers the model once,
 *     the 5th halts.
 *
 *  4. Repeated narration: the model emitting the same non-trivial text 3×
 *     in a row ("Let me check the rotation engine…") halts even when its
 *     tool calls vary enough to dodge 1-3. The same plan coming back in
 *     alternation (A, B, A, B, A) is counted over a window: steered on its
 *     third time, halted on its fourth (A37, xxcoder 26.10.2026, Qwen 3.8 27B
 *     on REA: "Let me first check the file details and set up the project." /
 *     "Let me create the project and run analysis. I'll use the
 *     analyzeHeadless script." over and over, reading the docs between, and
 *     never three times in a row). Only text the length of a plan counts
 *     there, so "Now let me run the tests." in an edit-test cycle does not.
 *
 *  5. Rounds that only ever fail: detectors 1-4 look at what the model ASKED
 *     for, never at what came back, and 2-3 are scoped to reads because a
 *     side-effecting call may legitimately repeat. A shell command that FAILS
 *     changes nothing, so a run of failing rounds with no success in between
 *     is a stall no matter how the arguments wobble. Found on the installed
 *     2.6.2 build, Coding + Ollama + hermes: after one git error the model
 *     fired 18 `icacls` calls in a row, alternating `Everyone=RX` and
 *     `Everyone=R,X`. Detector 1 never saw three identical in a row, and 2 and
 *     3 skip shell entirely, so six minutes of the run burned untouched.
 *
 *  6. Variants of the same failing executable (G36, R18b witness 2026-08-07):
 *     detector 5 resets the moment ANY call in the round succeeds, and a
 *     model grinding on create-vite interleaved every retry with a file_list
 *     that worked, so 15/30 circling minutes never tripped it. This detector
 *     counts consecutive FAILURES per executable (first token of the shell
 *     command, path and .exe/.cmd stripped, so `npm init vite@latest` and
 *     `C:\nodejs\npm.cmd install -g create-vite` pool into one streak). Only
 *     a successful MUTATING call resets the streaks, because only a mutation
 *     can change what the retry will find; a read-only success proves
 *     nothing. Steer at 3 per executable, halt at 6.
 *
 *  7. The user keeps declining the same command: a declined call has its own
 *     status and counted as neither success nor failure, so it reset detector
 *     5 and never fed detector 6. Steer at 3 per command, halt at 6. A
 *     declined call also no longer counts as a success anywhere.
 *
 *  8. Near-identical silent batches (C83, support case 10.11.2026): 233 tool
 *     calls of one tool, one every ~4 s, no text at all, each request
 *     420-447k tokens of input on a paid model. The arguments were 487-492
 *     characters and never byte-identical, so detectors 1-3 never saw a
 *     repeat. This one compares each batch with the one before it: same
 *     tool, arguments at least NEAR_SIMILARITY alike (character bigrams),
 *     and no new text from the model in between. Steer at NEAR_STEER_AT
 *     such batches in a row, halt at NEAR_HALT_AT. A read that only pages
 *     on (the arguments differ in numbers alone) is not counted, and any
 *     new text, a different tool or clearly different arguments start over.
 */

/*
 * C59 A5: every detector now says it once before it ends the run. Detectors
 * 1, 2 and the in-a-row half of 4 used to halt on first sight, with no word
 * to the model in between: a 9B model planning a logging change in the Code
 * tab re-listed the folder a third time and the run was over (bench CO6,
 * 09.11.2026), and morphantos asked for the guard to go (C44). Gemini CLI and
 * koda do the same: feedback on the first detection, stop on the second.
 * So: the threshold steers, one more of the same halts.
 */

export type LoopGuardVerdict =
  | { action: 'ok' }
  | { action: 'steer'; message: string }
  | { action: 'halt'; reason: string }

const CONSECUTIVE_HALT_AT = 3
const BATCH_WINDOW = 6
const WINDOW_HALT_REPEATS = 3
const READ_STEER_AT = 3
const READ_HALT_AT = 5
const NARRATION_HALT_AT = 3
/** Ignore trivial repeated lines ("Done.", "ok") — too easy to hit honestly. */
const MIN_NARRATION_LEN = 12
/** Detector 4, windowed: how many iterations back a repeated plan is counted. */
const NARRATION_WINDOW = 8
const NARRATION_WINDOW_STEER_AT = 3
const NARRATION_WINDOW_HALT_AT = 4
/** A plan, not a one-liner: shorter text may honestly repeat in a cycle. */
const MIN_PLAN_LEN = 50
/**
 * Failing rounds in a row, no success of any kind in between. Three is still
 * plausible probing (wrong flag, wrong quoting, wrong path), so that only
 * steers. Six is a model that has stopped reading its own error.
 */
const FAIL_STEER_AT = 3
const FAIL_HALT_AT = 6
/**
 * Consecutive failures of the SAME executable (detector 6). Three variants of
 * one command all failing is a model that argues with an error instead of
 * reading it; six is a stall. Matches detector 5's ladder on purpose.
 */
const EXEC_FAIL_STEER_AT = 3
const EXEC_FAIL_HALT_AT = 6
/**
 * The user said no to the same command this often in a row (detector 7).
 * A no is an answer, not an error to route around: the second ask is already
 * one too many, the third gets told so, and at six the turn ends. Seen on a
 * Windows test machine, 09.10.2026: 75 declined shell commands in one turn,
 * every one a new spelling of the same made up command.
 */
const DECLINED_STEER_AT = 3
const DECLINED_HALT_AT = 6

/** Scrolling moves the page with the same arguments each time (P-L, C53). */
const SCROLL_TOOLS = new Set<string>(['browser_scroll'])
const SCROLL_STEER_AT = 10
const SCROLL_HALT_AT = 20

/**
 * Web searches in a row with nothing read or done in between (C59 bench).
 * Each query differs by a word, so the repeat detectors never fire: a 9B
 * that lacked the shell searched the web 23 times for "mv" in one turn.
 * Six searches without opening a page is a model that has stopped reading
 * its results; twelve is a stall.
 */
const SEARCH_TOOLS = new Set<string>(['web_search'])
const SEARCH_STEER_AT = 6
const SEARCH_HALT_AT = 12

/**
 * Detector 8 (C83). Five silent near-copies in a row get one word, eight end
 * the run. In the incident that is 8 calls instead of 233.
 */
const NEAR_SIMILARITY = 0.85
const NEAR_STEER_AT = 5
const NEAR_HALT_AT = 8

/** Lower-cased, whitespace folded: the form two near-copies are compared in. */
function normArgs(args: string): string {
  return args.toLowerCase().replace(/\s+/g, ' ').trim()
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>()
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}

/**
 * Sørensen–Dice over character bigrams, 0..1. Linear in the length, so a
 * pair of 500-character argument strings costs nothing per step.
 */
export function argSimilarity(a: string, b: string): number {
  const x = normArgs(a)
  const y = normArgs(b)
  if (x === y) return 1
  if (x.length < 2 || y.length < 2) return 0
  const ga = bigrams(x)
  const gb = bigrams(y)
  let both = 0
  for (const [g, n] of ga) {
    const m = gb.get(g)
    if (m) both += Math.min(n, m)
  }
  return (2 * both) / (x.length - 1 + (y.length - 1))
}

/** Arguments that differ in numbers alone: an offset, a page, a line range. */
function onlyNumbersDiffer(a: string, b: string): boolean {
  return a !== b && a.replace(/\d+/g, '#') === b.replace(/\d+/g, '#')
}

/** Tools whose args carry a shell command whose first token names the work. */
const EXEC_TOOLS = new Set<string>(['shell_execute', 'shell_execute_background'])

/**
 * `npm`, from any of: `npm init vite@latest`, `C:\nodejs\npm.cmd install -g
 * create-vite`, `/usr/bin/npm ci`. Null when there is no command to key on.
 */
function execKeyOf(name: string, args?: Record<string, unknown>): string | null {
  if (!EXEC_TOOLS.has(name)) return null
  const command = args?.command
  if (typeof command !== 'string') return null
  const first = command.trim().split(/\s+/)[0] ?? ''
  const base = first.replace(/["']/g, '').split(/[\\/]/).pop() ?? ''
  const key = base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
  return key || null
}

/**
 * Tools whose result is a pure function of the workspace state. Only these
 * feed the epoch-scoped repeat counters; everything else (shell, writes, web,
 * time) may legitimately repeat and instead RESETS the epoch.
 */
const READ_ONLY_TOOLS = new Set<string>([
  'file_read',
  'file_list',
  'file_search',
  'git_status',
  'git_log',
  'git_diff',
])

export class AgentLoopGuard {
  /** Off (Settings → Agent Permissions, C44): every verdict is `ok`, the run
   *  goes on until its step and tool call limits or the user's Stop. */
  private readonly enabled: boolean

  constructor(opts: { enabled?: boolean } = {}) {
    this.enabled = opts.enabled !== false
  }

  private lastSig: string | null = null
  private consecutive = 0
  /** Batch signatures since the last mutating batch (pure-read epoch). */
  private pureWindow: string[] = []
  private readCounts = new Map<string, number>()
  private steeredKeys = new Set<string>()
  /** Detectors 1, 2, 4 (in a row): the signature that has been warned once. */
  private consecutiveSteered = false
  /** Batches of nothing but browser_scroll in a row (P-L, C53). */
  private scrollStreak = 0
  private scrollSteered = false
  /** Batches of nothing but web_search in a row (C59). */
  private searchStreak = 0
  private searchSteered = false
  private windowSteered = new Set<string>()
  private narrationRowSteered = false
  private lastNarration = ''
  private narrationSeen = 0
  /** Detector 4, windowed: the last plans written, newest last. */
  private narrations: string[] = []
  private narrationSteered = new Set<string>()
  private failingRounds = 0
  private failSteered = false
  /** Detector 6: consecutive failures per executable, reset by mutations. */
  private execFailStreaks = new Map<string, number>()
  private execSteeredKeys = new Set<string>()
  /** Detector 7: how often in a row the user declined the same command or tool. */
  private declinedStreaks = new Map<string, number>()
  private declinedSteeredKeys = new Set<string>()
  /** Detector 8: the batch before, and how many silent near-copies in a row. */
  private prevBatch: Array<{ name: string; args: string }> | null = null
  private nearStreak = 0
  private nearSteered = false
  /**
   * What recordNarration saw for the step now being recorded: true when the
   * model wrote nothing new (no text, or the same text as the step before).
   * Null when recordNarration was not called for it, which counts as silent:
   * the guard can only judge the text it is shown.
   */
  private stepSilent: boolean | null = null

  /**
   * Record one iteration's tool-call batch BEFORE executing it. `args` must
   * be the serialized (stringified) arguments so identity is byte-exact —
   * the same convention the in-turn cache uses.
   *
   * `trimmedReadKeys` carries the reads whose newest result the request
   * builder sent CAPPED (2.6.6 age decay, plan A1). Those re-reads are the
   * feature working as designed, not a loop: the model cannot see the bytes
   * any more, so fetching them again is the correct move. Detectors 2 and 3
   * therefore skip them, and the steer text never tells the model to "use the
   * result from before" for a key whose result from before is a stub. That
   * sentence is an order to work against content it cannot see, which is the
   * exact failure the decay rules exist to prevent.
   */
  recordBatch(
    calls: Array<{ name: string; args: string }>,
    opts: { trimmedReadKeys?: ReadonlySet<string> } = {},
  ): LoopGuardVerdict {
    if (!this.enabled || calls.length === 0) return { action: 'ok' }
    // browser_scroll (P-L, C53) repeats its arguments by design: every call
    // moves the page and its answer names the new position. A batch of
    // nothing but scrolls is therefore not a repeat; it gets its own, wider
    // count instead, so a model scrolling forever still meets the guard.
    if (calls.every((c) => SCROLL_TOOLS.has(c.name))) {
      this.scrollStreak++
      if (this.scrollStreak >= SCROLL_HALT_AT) {
        return { action: 'halt', reason: `${this.scrollStreak} scroll steps in a row without reading or doing anything else` }
      }
      if (this.scrollStreak >= SCROLL_STEER_AT && !this.scrollSteered) {
        this.scrollSteered = true
        return {
          action: 'steer',
          message: `You scrolled ${this.scrollStreak} times in a row. Use what the page has shown so far: answer, or open a better page. Scroll on only if the part you need is still below.`,
        }
      }
      return { action: 'ok' }
    }
    this.scrollStreak = 0
    this.scrollSteered = false
    if (calls.every((c) => SEARCH_TOOLS.has(c.name))) {
      this.searchStreak++
      if (this.searchStreak >= SEARCH_HALT_AT) {
        return { action: 'halt', reason: `${this.searchStreak} web searches in a row without reading a page or doing anything else` }
      }
      if (this.searchStreak >= SEARCH_STEER_AT && !this.searchSteered) {
        this.searchSteered = true
        return {
          action: 'steer',
          message: `You searched the web ${this.searchStreak} times in a row. Stop searching: read the best result with web_fetch, or do the task with the tools you have. If a tool you need is missing, ask tool_search once.`,
        }
      }
    } else {
      this.searchStreak = 0
      this.searchSteered = false
    }
    const near = this.recordNear(calls)
    if (near.action === 'halt') return near
    const keys = calls.map((c) => `${c.name}|${c.args}`)
    const sig = [...keys].sort().join('||')
    const trimmed = opts.trimmedReadKeys
    const isTrimmed = (k: string) => trimmed?.has(k) ?? false
    const batchHasTrimmedRead = keys.some((k, i) => READ_ONLY_TOOLS.has(calls[i].name) && isTrimmed(k))

    // (1) Back-to-back identical batches, any tool class.
    if (sig === this.lastSig) {
      this.consecutive++
    } else {
      this.lastSig = sig
      this.consecutive = 1
      this.consecutiveSteered = false
    }
    if (this.consecutive >= CONSECUTIVE_HALT_AT) {
      if (this.consecutiveSteered) {
        return { action: 'halt', reason: `same tool sequence repeated ${this.consecutive}× in a row` }
      }
      this.consecutiveSteered = true
      return { action: 'steer', message: repeatSteer(calls.map((c) => c.name), this.consecutive, 'in a row') }
    }

    const hasMutation = calls.some((c) => !READ_ONLY_TOOLS.has(c.name))

    // (2) Windowed repeats among pure-read batches (alternation). A batch that
    // re-reads something the builder capped is not part of that pattern and is
    // kept out of the window entirely, so it neither halts nor pushes an
    // honest repeat out of the six-step view.
    if (!hasMutation && !batchHasTrimmedRead) {
      this.pureWindow.push(sig)
      if (this.pureWindow.length > BATCH_WINDOW) this.pureWindow.shift()
      const repeats = this.pureWindow.filter((s) => s === sig).length
      if (repeats >= WINDOW_HALT_REPEATS) {
        if (this.windowSteered.has(sig)) {
          return {
            action: 'halt',
            reason: `same tool sequence repeated ${repeats}× within the last ${this.pureWindow.length} steps with no workspace change`,
          }
        }
        this.windowSteered.add(sig)
        return { action: 'steer', message: repeatSteer(calls.map((c) => c.name), repeats, `within the last ${this.pureWindow.length} steps`) }
      }
    }

    // (3) Identical read calls within the epoch.
    let steer: LoopGuardVerdict | null = null
    for (let i = 0; i < calls.length; i++) {
      if (!READ_ONLY_TOOLS.has(calls[i].name)) continue
      if (isTrimmed(keys[i])) {
        // The result aged out of the prompt, so this read returns information
        // the model genuinely no longer has. Clear the counter rather than
        // just skipping it: the epoch before the cap says nothing about the
        // epoch after it.
        this.readCounts.delete(keys[i])
        continue
      }
      const n = (this.readCounts.get(keys[i]) ?? 0) + 1
      this.readCounts.set(keys[i], n)
      if (n >= READ_HALT_AT) {
        return {
          action: 'halt',
          reason: `${calls[i].name} repeated ${n}× with identical arguments and an unchanged workspace`,
        }
      }
      if (n >= READ_STEER_AT && !this.steeredKeys.has(keys[i])) {
        this.steeredKeys.add(keys[i])
        steer = {
          action: 'steer',
          message:
            `You have now called ${calls[i].name} ${n} times with exactly the same arguments. ` +
            'Nothing changed in between, so the result is identical to the one you already have. ' +
            'Do NOT repeat this call again. Use the result from before, or take a DIFFERENT action that moves the task forward.',
        }
      }
    }

    if (hasMutation) {
      // A side-effecting call may change what reads return — give the
      // epoch-scoped counters a clean slate so a legitimate re-read after a
      // change is never punished. steeredKeys survives: one steer per unique
      // call is enough for the whole run.
      this.readCounts.clear()
      this.pureWindow = []
    }
    return steer ?? (near.action === 'steer' ? near : { action: 'ok' })
  }

  /**
   * Detector 8: is this batch a silent near-copy of the one before it? Every
   * call must have a partner in the previous batch with the same tool and
   * arguments at least NEAR_SIMILARITY alike. Byte-identical partners count
   * too, so an exact repeat that slips past detector 1 (A, A', A, A') still
   * lands here.
   */
  private recordNear(calls: Array<{ name: string; args: string }>): LoopGuardVerdict {
    const silent = this.stepSilent !== false
    this.stepSilent = null
    // Searches differ by a word on purpose and have their own ladder above.
    if (calls.every((c) => SEARCH_TOOLS.has(c.name))) {
      this.prevBatch = null
      this.nearStreak = 0
      this.nearSteered = false
      return { action: 'ok' }
    }
    const prev = this.prevBatch
    this.prevBatch = calls.map((c) => ({ name: c.name, args: c.args }))
    const alike =
      silent &&
      prev !== null &&
      calls.every((c) =>
        prev.some(
          (p) =>
            p.name === c.name &&
            !(READ_ONLY_TOOLS.has(c.name) && onlyNumbersDiffer(normArgs(p.args), normArgs(c.args))) &&
            argSimilarity(p.args, c.args) >= NEAR_SIMILARITY,
        ),
      )
    if (!alike) {
      // The first batch of a new streak is its first member.
      this.nearStreak = 1
      this.nearSteered = false
      return { action: 'ok' }
    }
    this.nearStreak++
    const names = [...new Set(calls.map((c) => c.name))].join(', ')
    if (this.nearStreak >= NEAR_HALT_AT) {
      return {
        action: 'halt',
        reason: `${this.nearStreak} nearly identical ${names} calls in a row with no new text from the model`,
      }
    }
    if (this.nearStreak >= NEAR_STEER_AT && !this.nearSteered) {
      this.nearSteered = true
      return {
        action: 'steer',
        message:
          `You have now sent ${this.nearStreak} nearly identical ${names} calls in a row without writing anything. ` +
          'Changing a few characters does not make it a new step: the results will not change either. ' +
          'Stop calling it. Say in one or two sentences what you found and what is blocking you, then either take a clearly different step or give your final answer. ' +
          'The same call again ends the run.',
      }
    }
    return { action: 'ok' }
  }

  /**
   * Record what one iteration's tools actually RETURNED, after they ran.
   *
   * A round where every call failed moved nothing: the workspace is what it
   * was, and the next round starts from the same place. One success of any
   * kind clears the count, so edit → test → edit → test is never touched, and
   * neither is a model that fixes its command on the second or third try.
   */
  recordResults(
    results: Array<{ name: string; failed: boolean; rejected?: boolean; error?: string; args?: Record<string, unknown> }>,
  ): LoopGuardVerdict {
    if (!this.enabled || results.length === 0) return { action: 'ok' }

    // ── Detector 7: the user keeps saying no to the same thing ──
    // A declined call ran nothing, so it is no success: it resets no count
    // below. Its own count is per command (per tool where there is no
    // command), and only that same command being let through clears it. A
    // no followed by a different command is a fresh start for that command.
    let declinedSteer: LoopGuardVerdict | null = null
    for (const r of results) {
      const key = execKeyOf(r.name, r.args) ?? r.name
      if (!r.rejected) {
        this.declinedStreaks.delete(key)
        continue
      }
      const n = (this.declinedStreaks.get(key) ?? 0) + 1
      this.declinedStreaks.set(key, n)
      const what = EXEC_TOOLS.has(r.name) && key !== r.name ? `'${key}' commands` : `'${r.name}' calls`
      if (n >= DECLINED_HALT_AT) {
        return { action: 'halt', reason: `the user declined ${n} ${what} in a row` }
      }
      if (n >= DECLINED_STEER_AT && !this.declinedSteeredKeys.has(key)) {
        this.declinedSteeredKeys.add(key)
        declinedSteer = {
          action: 'steer',
          message:
            `The user has now declined ${n} ${what} in a row. A no is their answer. ` +
            'Do not ask for it again in another spelling. Tell the user what you wanted to do and why, and ask how they want to go on.',
        }
      }
    }
    const ran = results.filter((r) => !r.rejected)

    // ── Detector 6: per-executable failure streaks ──
    // The reset runs BEFORE this round's failures are counted, so a retry
    // that follows a real fix (a successful file_edit, a successful other
    // command) starts a fresh streak. Read-only successes keep the streaks:
    // listing the directory again does not change what the retry will find.
    if (ran.some((r) => !r.failed && !READ_ONLY_TOOLS.has(r.name))) {
      this.execFailStreaks.clear()
    }
    let execSteer: LoopGuardVerdict | null = null
    for (const r of ran) {
      if (!r.failed) continue
      const key = execKeyOf(r.name, r.args)
      if (!key) continue
      const n = (this.execFailStreaks.get(key) ?? 0) + 1
      this.execFailStreaks.set(key, n)
      if (n >= EXEC_FAIL_HALT_AT) {
        return {
          action: 'halt',
          reason: `${n} failed '${key}' commands in a row with nothing changing the workspace in between`,
        }
      }
      if (n >= EXEC_FAIL_STEER_AT && !this.execSteeredKeys.has(key)) {
        this.execSteeredKeys.add(key)
        execSteer = {
          action: 'steer',
          message:
            `You have now tried ${n} variants of the '${key}' command and every attempt failed. ` +
            (r.error ? `The error is still: ${r.error.slice(0, 300)}. ` : '') +
            'Another spelling of the same command will fail the same way. ' +
            'Write down the exact error for this step and MOVE ON to the next step.',
        }
      }
    }

    // ── Detector 5: rounds where every call failed ──
    if (ran.some((r) => !r.failed)) {
      this.failingRounds = 0
      this.failSteered = false
      return execSteer ?? declinedSteer ?? { action: 'ok' }
    }

    // Nothing ran to a good end: every call failed or the user declined it.
    this.failingRounds++
    const names = [...new Set(results.map((r) => r.name))].join(', ')
    const outcome = ran.length === 0 ? 'was declined by the user' : ran.length === results.length ? 'failed' : 'failed or was declined by the user'
    if (this.failingRounds >= FAIL_HALT_AT) {
      return {
        action: 'halt',
        reason: `${this.failingRounds} rounds in a row where every tool call ${outcome} (${names}) and nothing changed in between`,
      }
    }
    if (execSteer) return execSteer
    if (declinedSteer) return declinedSteer
    // A round of nothing but a no has no error to quote; detector 7 speaks for it.
    if (ran.length === 0) return { action: 'ok' }
    if (this.failingRounds >= FAIL_STEER_AT && !this.failSteered) {
      this.failSteered = true
      const lastError = results.find((r) => r.error)?.error
      return {
        action: 'steer',
        message:
          `The last ${this.failingRounds} rounds all failed (${names}) and nothing in the workspace changed. ` +
          (lastError ? `The error is still: ${lastError.slice(0, 300)}. ` : '') +
          'Retrying the same command with a slightly different spelling will not fix it. ' +
          'Either solve the cause, or say plainly that this step cannot be done here and move on to the next step.',
      }
    }
    return { action: 'ok' }
  }

  /** Record the assistant text of one iteration (before its tools run). */
  recordNarration(text: string): LoopGuardVerdict {
    if (!this.enabled) return { action: 'ok' }
    const norm = text.trim().replace(/\s+/g, ' ').toLowerCase()
    // Detector 8 (C83): text the step before did not already have is news.
    this.stepSilent = norm.length < MIN_NARRATION_LEN || norm === this.lastNarration
    if (norm.length < MIN_NARRATION_LEN) {
      this.lastNarration = ''
      this.narrationSeen = 0
      return { action: 'ok' }
    }
    if (norm === this.lastNarration) {
      this.narrationSeen++
    } else {
      this.lastNarration = norm
      this.narrationSeen = 1
      this.narrationRowSteered = false
    }
    if (this.narrationSeen >= NARRATION_HALT_AT) {
      if (this.narrationRowSteered) {
        return {
          action: 'halt',
          reason: `the model repeated the same message ${this.narrationSeen}× without making progress`,
        }
      }
      this.narrationRowSteered = true
      return {
        action: 'steer',
        message:
          `You wrote the same message ${this.narrationSeen} times in a row. Do not write it again. `
          + 'Make the one tool call that moves the task forward, or, if the task is done, give your final answer now.',
      }
    }
    if (norm.length < MIN_PLAN_LEN) return { action: 'ok' }
    this.narrations.push(norm)
    if (this.narrations.length > NARRATION_WINDOW) this.narrations.shift()
    const times = this.narrations.filter((n) => n === norm).length
    const quoted = text.trim().replace(/\s+/g, ' ')
    const quote = quoted.length > 90 ? `${quoted.slice(0, 90)}…` : quoted
    if (times >= NARRATION_WINDOW_HALT_AT) {
      return {
        action: 'halt',
        reason: `the model wrote the same plan ${times} times ("${quote}") and kept starting over instead of carrying it out`,
      }
    }
    if (times >= NARRATION_WINDOW_STEER_AT && !this.narrationSteered.has(norm)) {
      this.narrationSteered.add(norm)
      return {
        action: 'steer',
        message:
          `You have now written the same plan ${times} times ("${quote}") and started over each time. ` +
          'Do not restate it. Use what the earlier tool results already showed and make the next concrete tool call now. ' +
          'If something stops you from going on, say plainly what it is and end your turn.',
      }
    }
    return { action: 'ok' }
  }
}

/** What the model reads when it repeated a whole batch (detectors 1 and 2). */
function repeatSteer(names: string[], times: number, where: string): string {
  const list = [...new Set(names)].join(', ')
  return `You sent exactly the same tool calls (${list}) ${times} times ${where}, and the results did not change. `
    + 'Do not send them again: everything they return is already above. Take the next step of the task with what you have, '
    + 'or, if the task is done, give your final answer now. The same calls once more end the run.'
}
