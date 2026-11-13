/**
 * One timeout rule for every tool call, shared by useCodex and useAgentChat
 * (audit B8/B9): the two loops used to disagree — Codex raced every call
 * against a generous cap while Agent mode had NO ceiling at all (a hung tool
 * wedged the whole run), and Agent never injected the long shell default, so
 * the same build that passed in the Code tab died at the Rust side's 120 s
 * default in Agent mode.
 *
 * The cap is a BACKSTOP above the tool's own deadline, never the working
 * limit: shell/code/test/git enforce their real timeout in the Rust backend
 * (args.timeout), image/video in the vram-handoff poll
 * (imageGen/videoGenTimeoutMinutes). The JS race only exists so a tool whose
 * own timer never fires cannot hold the loop forever.
 */

/** Default args.timeout the loops inject for the exec tools (ms). Building an
 * app (npm install, cargo/gradle) routinely runs minutes; the old 30 s
 * default + 60 s JS cap killed every real build (2026-06-04). */
import { hasMlx } from './capabilities'

export const SHELL_EXECUTE_DEFAULT_TIMEOUT_MS = 600_000

const LONG_RUNNING = new Set([
  'shell_execute',
])

/**
 * `setTimeout`'s own practical ceiling: a delay above roughly 24.8 days
 * overflows the 32-bit int it uses internally and fires almost at once
 * instead of never (the opposite of "no cap"). Used below for tools that
 * must not race against a made-up deadline at all.
 */
export const NO_PRACTICAL_CAP_MS = 2_147_483_000

/**
 * `delegate_task` (foreground only) and `run_workflow`: a nested ReAct loop
 * / step chain with its OWN termination, namely iteration and step caps
 * (SUB_AGENT_BUDGET, MAX_STEPS_EXECUTED/MAX_LOOP_ITERATIONS) and Stop wired
 * straight into the run, not a timer this file could ever see (klaerung-n5a,
 * Frage 1). Before this, both fell through to the generic 60 s default,
 * exactly the "actual working limit" this file's own header says the cap
 * must never become, and the measured cause of two real 60,0 s aborts whose
 * sub-agent then kept running, orphaned, holding the local lane (see Fix 2
 * in raceWithToolTimeout below).
 *
 * `delegate_task`'s BACKGROUND branch is excluded on purpose: it books its
 * own conversation slot under a task id and returns in milliseconds (it
 * never runs inside this race at all in practice), so raising its cap would
 * only hide a real hang instead of a false one.
 *
 * `check_tasks` and `message_agent` were checked too and do NOT belong here:
 * both only read or write the in-memory agentTaskStore, no lane, no I/O, no
 * network, so neither can legitimately run anywhere near 60 s, and the
 * generic default stays their real backstop.
 */
const AGENT_LOOP_TOOLS = new Set(['delegate_task', 'run_workflow'])

/**
 * `computer_use` and `computer_task` wait for a person: every call can stop
 * at a question (allow this app, confirm this action) that the user answers
 * whenever they look at the screen, and a screen task runs up to its own
 * step and time limit (TASK_MAX_STEPS, TASK_TIME_LIMIT_MS in
 * api/computer-task.ts). Both end through their own Stop (the bar, the
 * shortcut, the chat's Stop through the run signal). Under the generic 60 s
 * default a question nobody answered within a minute failed the call, and
 * the abort that followed was shown as "The user stopped computer control".
 */
const HUMAN_PACED_TOOLS = new Set(['computer_use', 'computer_task', 'set_setting'])

/**
 * P-L (3.1.0): web tools that may stop for the user's yes before an address
 * (lib/web-url-provenance.ts). The page itself has its own deadline in Rust
 * (20 s for a fetch, 30 s for a browser load), so a long cap here only waits
 * for a person, never for a hung connection.
 */
export const URL_CARD_TOOLS = new Set(['web_fetch', 'browser_open', 'browser_click_link'])
export const URL_CARD_CAP_MS = 10 * 60_000

export interface ToolTimeoutSettings {
  imageGenTimeoutMinutes?: number
  videoGenTimeoutMinutes?: number
  /** 'cloud' renders on the server; anything else is this machine. */
  appMode?: string
}

/**
 * How long a Create render may go without any life sign from ComfyUI before
 * it is called stalled, in ms. Reads the same two settings as the tool cap
 * (Settings, Generation timeout); 20 min for images and 60 min for video
 * when they are unset or not a number. D27: useCreate used to hard code the
 * defaults, so raising the setting never reached the Create tab.
 */
export function renderStallLimitMs(kind: 'image' | 'video', settings: ToolTimeoutSettings): number {
  const minutes = kind === 'video'
    ? Number(settings.videoGenTimeoutMinutes) || 60
    : Number(settings.imageGenTimeoutMinutes) || 20
  return Math.max(1, minutes) * 60_000
}

/** The sentence a stalled Create render ends with: "1 minute", "20 minutes". */
export function renderStallMessage(limitMs: number): string {
  const minutes = Math.max(1, Math.round(limitMs / 60_000))
  return `Generation stalled: no progress from ComfyUI for ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`
}

/**
 * What one media call spends outside its render budget, at most (A13). The
 * render's own clock grants the first load of a checkpoint up to 10 minutes
 * and a render seconds from done one more minute (lib/render-budget); before
 * it come a ComfyUI cold start of up to 90 s (twice: before and after the
 * VRAM hand-off), the model picker's 90 s, and freeing the chat model. The
 * cap used to be the budget plus two minutes, so it fired in the middle of a
 * render the inner clock still allowed and told the model "timed out" for a
 * render that went on. The cap now sits behind all of that and only catches
 * a call that hangs; the render ends by its own budget, with its own words.
 */
export const MEDIA_CALL_OVERHEAD_MS = 18 * 60_000

/** The JS race ceiling for one tool call, in ms. */
export function toolCallCapMs(
  name: string,
  args: Record<string, unknown> | undefined,
  settings: ToolTimeoutSettings,
): number {
  if (name === 'image_generate') {
    // C71: a local image on a Mac runs on MLX, and Rust ends it the moment it
    // stops moving (commands/mlx.rs, the Image timeout; the second engine has
    // its own hour per image). A wall clock here would cut a long render that
    // is still making steps, Chroma1-HD at 40 steps on an M1 Max among them.
    // Stop still ends it.
    if (settings.appMode !== 'cloud' && hasMlx()) return NO_PRACTICAL_CAP_MS
    return renderStallLimitMs('image', settings) + MEDIA_CALL_OVERHEAD_MS
  }
  if (name === 'video_generate') return renderStallLimitMs('video', settings) + MEDIA_CALL_OVERHEAD_MS
  if (AGENT_LOOP_TOOLS.has(name) && args?.background !== true) {
    return NO_PRACTICAL_CAP_MS
  }
  if (HUMAN_PACED_TOOLS.has(name)) {
    return NO_PRACTICAL_CAP_MS
  }
  if (URL_CARD_TOOLS.has(name)) return URL_CARD_CAP_MS
  if (LONG_RUNNING.has(name)) {
    const own = Number(args?.timeout)
    return Number.isFinite(own) && own > 0 ? own + 15_000 : SHELL_EXECUTE_DEFAULT_TIMEOUT_MS + 15_000
  }
  return 60_000
}

/**
 * Race a tool run against its cap. The timer is CLEARED when the tool wins
 * (audit B10) — the old inline race left every winner's setTimeout parked
 * for up to 615 s with the whole closure alive, times 200 iterations.
 *
 * Fix 2 (klaerung-n5a, Frage 1): `Promise.race` never cancels its loser, it
 * only stops listening to it. Before this, a timed-out tool call reached the
 * model as an error while the real call underneath ran on, unseen, holding
 * whatever local resource it had booked (a sub-agent's local lane, a
 * workflow's), until it ended on its own: the user-visible "Tool execution
 * timed out" was true about the MESSAGE, not about the machine's state.
 *
 * `run` is now a factory, not an already-started promise: it receives the
 * AbortSignal this function owns, so it can build the call's OWN signal
 * (merged with `baseSignal`, the run's Stop) instead of racing a call that
 * was already wired to something else. On timeout that signal is aborted
 * BEFORE the rejection, so the loser gets exactly the same cancellation
 * path Stop already uses, and, for every tool that honours its signal
 * (shell_execute, and now delegate_task/run_workflow, see sub-agent.ts and
 * builtin-tools.ts), actually winds down and releases what it held.
 *
 * Review-Auflage 1 (Opus, review-dtimeout.md): `baseSignal` is the whole
 * run's Stop controller, alive for up to 200 iterations with several
 * parallel tool calls each. Every call used to add its own `abort` listener
 * to it and never remove it, win or lose, hundreds of dead listeners per run
 * pinning their own `AbortController` (and the closure around it) alive for
 * the rest of the run. The handler is a named const now so the SAME
 * reference goes into `removeEventListener` in the shared `.finally()`
 * below, whether the tool call wins, loses, or `run()` throws synchronously
 * (Auflage 4).
 *
 * Review-Auflage 4 (Opus, review-dtimeout.md): `run(controller.signal)` used
 * to be called directly inside the `Promise.race([...])` array literal. A
 * factory that throws SYNCHRONOUSLY (instead of returning a rejected
 * promise) would have thrown straight out of this function, before
 * `Promise.race` and its `.finally()` ever ran: the deadline's `setTimeout`
 * would stay armed for up to ~24.8 days (NO_PRACTICAL_CAP_MS) and its
 * eventual rejection would be unhandled, and `baseSignal`'s listener would
 * leak exactly like Auflage 1. No real factory here throws synchronously
 * today (both callers wrap an `async` function, which never does), so this
 * is hardening against a future caller's mistake, not a live bug.
 */
export function raceWithToolTimeout(
  name: string,
  capMs: number,
  run: (signal: AbortSignal) => Promise<string>,
  baseSignal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController()
  const onBaseAbort = () => controller.abort()
  if (baseSignal) {
    if (baseSignal.aborted) controller.abort()
    else baseSignal.addEventListener('abort', onBaseAbort, { once: true })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<string>((_, reject) => {
    timer = setTimeout(
      () => {
        // Abort BEFORE reject: a listener on the rejection path must see an
        // already-aborted signal, not a race between the two.
        controller.abort()
        // The tool name was passed in by both callers but never used, so every
        // timeout reached the model as an anonymous "Tool execution timed out",
        // and in a parallel batch it could not tell which tool had died.
        reject(new Error(`Tool execution timed out: ${name} (${Math.round(capMs / 1000)}s)`))
      },
      capMs,
    )
  })
  // Auflage 4: a factory call wrapped in try/catch instead of sitting bare
  // inside the array literal, so a synchronous throw becomes a rejected
  // promise that still goes through the race and its cleanup below, instead
  // of escaping this function before either ever runs.
  let started: Promise<string>
  try {
    started = run(controller.signal)
  } catch (err) {
    started = Promise.reject(err instanceof Error ? err : new Error(String(err)))
  }
  // The tool call is built to resolve, not reject, once it honours the
  // signal (registry.execute() and every builtin executor return an "Error:
  // ..."/"Cancelled: ..." STRING on abort, they do not throw), so the
  // settled-late loser here is a resolved promise nobody reads again, never
  // an unhandled rejection. Tools that DO throw on abort are caught the same
  // way any other tool error already is, inside registry.execute()'s own
  // try/catch, well before this race ever sees it.
  return Promise.race([started, deadline]).finally(() => {
    clearTimeout(timer)
    // Auflage 1: removed unconditionally, win or lose. `removeEventListener`
    // with a listener that was never added (baseSignal undefined, or the
    // `{ once: true }` listener already fired and removed itself) is a
    // documented no-op, not an error.
    baseSignal?.removeEventListener('abort', onBaseAbort)
  })
}
