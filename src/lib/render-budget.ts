/**
 * Render budget for agent-triggered generations (G19-1, R32 witness): the app
 * queued a 30 to 60 minute Wan render on an RTX 3060 inside an interactive
 * run, polled it 354 times and said nothing. The poll deadline alone is blind:
 * it burns its whole budget before admitting the job never had a chance.
 *
 * The tracker reads the pace off ComfyUI's own progress events (value/max per
 * sampler step) and projects how long the whole sampling pass will take. Once
 * enough steps are in, a projection clearly past the budget ends the wait
 * early with an honest, actionable message, and the job itself is abandoned so
 * the GPU stops burning (the timeout used to orphan it).
 */

/** Sampler steps observed before we trust the pace. */
export const MIN_STEPS_FOR_VERDICT = 3

/** A projection must overshoot the budget by this factor before we give up,
 *  so a render that would land a little late still gets to finish. */
export const HOPELESS_FACTOR = 1.25

interface PaceState {
  t0: number
  v0: number
  value: number
  max: number
  at: number
}

/**
 * Feed it ComfyUI `progress` ticks, ask it for the projected total. Pace is
 * measured from the FIRST tick, so model-load time never pollutes it. A value
 * that moves backwards means a new sampler node started (wan22 runs two
 * passes); re-anchor there. Projecting only the current pass under-estimates
 * multi-pass jobs, which errs on the side of letting them run.
 */
export class PaceTracker {
  private s: PaceState | null = null

  tick(value: number, max: number, at: number): void {
    if (!this.s || value < this.s.value) {
      this.s = { t0: at, v0: value, value, max, at }
      return
    }
    this.s.value = value
    this.s.max = max
    this.s.at = at
  }

  /** Projected ms for the whole sampling pass, or null before enough steps. */
  projectedTotalMs(): number | null {
    const s = this.s
    if (!s) return null
    const steps = s.value - s.v0
    if (steps < MIN_STEPS_FOR_VERDICT) return null
    return ((s.at - s.t0) / steps) * s.max
  }

  /**
   * Projected ms of sampling still to come, or null before enough steps. On a
   * multi-pass job this only sees the CURRENT pass, so it under-estimates. It
   * is only ever used to grant a small, capped grace, and under-estimating
   * there simply means no grace is granted.
   */
  projectedRemainingMs(): number | null {
    const s = this.s
    const total = this.projectedTotalMs()
    if (!s || total === null || s.max <= 0) return null
    const done = Math.min(1, Math.max(0, s.value / s.max))
    return total * (1 - done)
  }
}

export function overBudget(projectedTotalMs: number | null, budgetMs: number): boolean {
  return projectedTotalMs !== null && projectedTotalMs > budgetMs * HOPELESS_FACTOR
}

/**
 * Budget for the warm-up phase before the FIRST sampler progress event: model
 * load, VRAM swap, cold start (G24, R17c witness 2026-08-07: a Wan render sat
 * in "loading model into VRAM" for 19 minutes without one progress event, so
 * the pace tracker never engaged and a generous user timeout never fired; the
 * whole 20 minute run was lost to it). The promised swap is 30 to 90 s; this
 * sits well above that so only a genuinely wedged load trips it.
 */
export const SWAP_WARMUP_BUDGET_MS = 5 * 60_000

/**
 * True when the warm-up phase overran its budget. Deliberately narrow:
 *   - the WS must be connected, otherwise we are blind by design and only the
 *     flat deadline applies (exactly as before this guard existed);
 *   - NO prompt at all may have progressed. Progress on someone else's prompt
 *     means the GPU is busy, not wedged, and our job is just queued behind it;
 *     killing it there would punish a healthy queue.
 */
export function warmupExceeded(
  sawAnyProgress: boolean,
  wsConnected: boolean,
  elapsedMs: number,
  budgetMs: number = SWAP_WARMUP_BUDGET_MS,
): boolean {
  return wsConnected && !sawAnyProgress && elapsedMs > budgetMs
}

/**
 * Warm-up budget once ComfyUI CONFIRMS our prompt is still queued or running
 * (Z36 finding 4). The flat 5 minutes cannot tell a wedged load from the first
 * load of a big bf16 checkpoint on a small card, and it cut off a render the
 * Create tab completes: the Create watchdog counts a still-queued prompt as a
 * life signal (useCreate isPromptQueued), the agent path counted nothing.
 * Doubling the budget on that same signal buys the honest load its time while
 * still ending the R17c case, which sat wedged for 19 minutes.
 */
export const SWAP_WARMUP_ALIVE_BUDGET_MS = 10 * 60_000

/** The warm-up budget in force, given what ComfyUI says about our prompt. */
export function warmupBudgetMs(promptConfirmedAlive: boolean): number {
  return promptConfirmedAlive ? SWAP_WARMUP_ALIVE_BUDGET_MS : SWAP_WARMUP_BUDGET_MS
}

/** Tool result for a warm-up abort. Says what was observed, not a guess. */
export function swapWarmupNotice(kindLabel: string, elapsedMs: number): string {
  const m = Math.max(1, Math.round(elapsedMs / 60_000))
  return `${kindLabel} generation stopped: after ${m} minute${m === 1 ? '' : 's'} the model was still loading into VRAM and sampling never started. The job was cancelled so the GPU is free again. Free some VRAM (close other GPU apps, or set VRAM hand-off to "always" in Settings so the chat model is evicted first), or pick a smaller model.`
}

/**
 * Cap on how far the FIRST load of the checkpoint may push the flat deadline
 * out (Z36 finding 4, W3 run 2026-08-16: a forced z_image_bf16 render in the
 * chat tool was abandoned after 352.6 s because loading the big bf16 checkpoint
 * on a 3060 outlasted the warm-up budget, while the Create tab renders the same
 * job, because its watchdog bounds the SILENT gap instead of the wall clock).
 * The warm-up guard below is the one that ended that render; this cap covers
 * the same phase for the flat deadline, which a slower card or a shorter user
 * budget would hit next. The load phase already has
 * its own guard in warmupExceeded, so this only has to cover a load that is
 * slow but healthy, and it keeps the whole wait bounded at budget + cap. The
 * cap is the warm-up ceiling, so the two guards cannot disagree about how long
 * a load may take: the warm-up guard always reaches its verdict first, with the
 * message that names the real cause.
 */
export const LOAD_PHASE_GRACE_CAP_MS = SWAP_WARMUP_ALIVE_BUDGET_MS

/**
 * Ms the flat deadline may move out because the checkpoint had to be loaded
 * before sampling could start. The load phase runs from submit to the first
 * sampler progress event for OUR prompt; while that tick is still missing the
 * grace grows with the clock, and once it arrives the grace freezes at the
 * measured load time.
 *
 * Without a live WS we cannot tell loading from sampling, so there is no grace
 * at all and the flat deadline applies exactly as it did before this existed.
 *
 * This moves the FLAT deadline only. The pace verdict keeps measuring the
 * sampling pass against the raw budget, so a hopeless render (R32) still dies
 * after three steps.
 */
export function loadPhaseGraceMs(
  wsConnected: boolean,
  startedAt: number,
  firstOwnProgressAt: number | null,
  now: number,
  cap: number = LOAD_PHASE_GRACE_CAP_MS,
): number {
  if (!wsConnected) return 0
  const loadEndedAt = firstOwnProgressAt ?? now
  const loadMs = loadEndedAt - startedAt
  if (!Number.isFinite(loadMs) || loadMs <= 0) return 0
  return Math.min(loadMs, cap)
}

/** One bounded extension for a render that is seconds away from done. */
export const FINISH_GRACE_CAP_MS = 60_000

/**
 * Ms of extra time a render past its deadline has earned by being nearly
 * finished (Z36 finding 4, second half: at the deadline the app threw away a
 * job that had already paid for the whole checkpoint load and almost all of the
 * sampling). A measured pace that says the rest of the pass fits inside the cap
 * buys the whole cap once, which also covers the VAE decode and save tail. No
 * measurement, or too much work left, buys nothing and the job is cancelled as
 * before.
 */
export function finishGraceMs(
  projectedRemainingMs: number | null,
  cap: number = FINISH_GRACE_CAP_MS,
): number {
  if (projectedRemainingMs === null) return 0
  if (!Number.isFinite(projectedRemainingMs) || projectedRemainingMs < 0) return 0
  return projectedRemainingMs <= cap ? cap : 0
}

const advice = 'Try fewer frames, a smaller resolution or fewer steps, or pick a lighter model. The generation timeout is adjustable in Settings.'

/** Tool result for a pace-based early stop. Honest about what was measured. */
export function renderBudgetNotice(kindLabel: string, projectedMs: number, budgetMs: number): string {
  const p = Math.max(1, Math.round(projectedMs / 60_000))
  const b = Math.max(1, Math.round(budgetMs / 60_000))
  return `${kindLabel} generation stopped early: at the measured pace this render needs about ${p} minutes, more than the ${b} minute budget. The job was cancelled so the GPU is free again. ${advice}`
}

/**
 * Tool result for the flat deadline. The job is abandoned, not orphaned. When
 * the wait outlasted the budget because the checkpoint had to load first, say
 * so instead of reporting a budget the run visibly overran.
 */
export function renderTimeoutNotice(kindLabel: string, budgetMs: number, elapsedMs?: number): string {
  const b = Math.max(1, Math.round(budgetMs / 60_000))
  const e = typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) ? Math.max(1, Math.round(elapsedMs / 60_000)) : null
  const spent = e !== null && e > b
    ? ` It ran for about ${e} minutes: the ${b} minute budget plus the time the model spent loading.`
    : ''
  return `${kindLabel} generation hit the ${b} minute budget and was cancelled so the GPU is free again.${spent} ${advice}`
}
