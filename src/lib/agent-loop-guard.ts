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
 *     tool calls vary enough to dodge 1-3.
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
  private lastSig: string | null = null
  private consecutive = 0
  /** Batch signatures since the last mutating batch (pure-read epoch). */
  private pureWindow: string[] = []
  private readCounts = new Map<string, number>()
  private steeredKeys = new Set<string>()
  private lastNarration = ''
  private narrationSeen = 0
  private failingRounds = 0
  private failSteered = false
  /** Detector 6: consecutive failures per executable, reset by mutations. */
  private execFailStreaks = new Map<string, number>()
  private execSteeredKeys = new Set<string>()

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
    if (calls.length === 0) return { action: 'ok' }
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
    }
    if (this.consecutive >= CONSECUTIVE_HALT_AT) {
      return { action: 'halt', reason: `same tool sequence repeated ${this.consecutive}× in a row` }
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
        return {
          action: 'halt',
          reason: `same tool sequence repeated ${repeats}× within the last ${this.pureWindow.length} steps with no workspace change`,
        }
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
    return steer ?? { action: 'ok' }
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
    results: Array<{ name: string; failed: boolean; error?: string; args?: Record<string, unknown> }>,
  ): LoopGuardVerdict {
    if (results.length === 0) return { action: 'ok' }

    // ── Detector 6: per-executable failure streaks ──
    // The reset runs BEFORE this round's failures are counted, so a retry
    // that follows a real fix (a successful file_edit, a successful other
    // command) starts a fresh streak. Read-only successes keep the streaks:
    // listing the directory again does not change what the retry will find.
    if (results.some((r) => !r.failed && !READ_ONLY_TOOLS.has(r.name))) {
      this.execFailStreaks.clear()
    }
    let execSteer: LoopGuardVerdict | null = null
    for (const r of results) {
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
    if (results.some((r) => !r.failed)) {
      this.failingRounds = 0
      this.failSteered = false
      return execSteer ?? { action: 'ok' }
    }

    this.failingRounds++
    const names = [...new Set(results.map((r) => r.name))].join(', ')
    if (this.failingRounds >= FAIL_HALT_AT) {
      return {
        action: 'halt',
        reason: `${this.failingRounds} rounds in a row where every tool call failed (${names}) and nothing changed in between`,
      }
    }
    if (execSteer) return execSteer
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
    const norm = text.trim().replace(/\s+/g, ' ').toLowerCase()
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
    }
    if (this.narrationSeen >= NARRATION_HALT_AT) {
      return {
        action: 'halt',
        reason: `the model repeated the same message ${this.narrationSeen}× without making progress`,
      }
    }
    return { action: 'ok' }
  }
}
