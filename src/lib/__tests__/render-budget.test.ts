/**
 * Render budget for agent-triggered generations (G19-1, R32 witness 2026-08-07):
 * the app queued a 30 to 60 minute Wan render inside an interactive run, polled
 * it 354 times with nothing on screen, and the timeout would have walked away
 * leaving the job burning the GPU. The pace tracker projects the sampling pass
 * off ComfyUI's own progress events and gives up early, cancelling the job.
 *
 * Run: npx vitest run src/lib/__tests__/render-budget.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  PaceTracker,
  overBudget,
  renderBudgetNotice,
  renderTimeoutNotice,
  warmupExceeded,
  swapWarmupNotice,
  loadPhaseGraceMs,
  finishGraceMs,
  MIN_STEPS_FOR_VERDICT,
  HOPELESS_FACTOR,
  SWAP_WARMUP_BUDGET_MS,
  SWAP_WARMUP_ALIVE_BUDGET_MS,
  warmupBudgetMs,
  LOAD_PHASE_GRACE_CAP_MS,
  FINISH_GRACE_CAP_MS,
  cpuCauseSuffix,
} from '../render-budget'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

describe('PaceTracker projection', () => {
  it('projects the R32 case: 30 steps at 80s each is a 40 minute job', () => {
    const t = new PaceTracker()
    // first tick anchors, three more ticks give a measurable pace
    t.tick(1, 30, 0)
    t.tick(2, 30, 80_000)
    t.tick(3, 30, 160_000)
    t.tick(4, 30, 240_000)
    expect(t.projectedTotalMs()).toBe(30 * 80_000)
  })

  it('NEGATIVE CONTROL: stays silent before enough steps are in', () => {
    const t = new PaceTracker()
    t.tick(1, 30, 0)
    t.tick(2, 30, 80_000)
    expect(t.projectedTotalMs()).toBeNull()
    // and a tracker that never saw a tick (no WS) never judges
    expect(new PaceTracker().projectedTotalMs()).toBeNull()
  })

  it('re-anchors when a second sampler pass starts (value moves backwards)', () => {
    const t = new PaceTracker()
    t.tick(28, 30, 0)
    t.tick(30, 30, 4_000)
    t.tick(1, 30, 10_000)
    t.tick(2, 30, 12_000)
    t.tick(3, 30, 14_000)
    t.tick(4, 30, 16_000)
    // pace comes from the NEW pass (2s per step), not the stale anchor
    expect(t.projectedTotalMs()).toBe(30 * 2_000)
  })
})

describe('the verdict', () => {
  it('a hopeless projection is over budget, a close one is not', () => {
    const budget = 10 * 60_000
    expect(overBudget(40 * 60_000, budget)).toBe(true)
    // NEGATIVE CONTROL: a render that lands a LITTLE late gets to finish
    expect(overBudget(11 * 60_000, budget)).toBe(false)
    expect(overBudget(null, budget)).toBe(false)
    expect(HOPELESS_FACTOR).toBeGreaterThan(1)
    expect(MIN_STEPS_FOR_VERDICT).toBeGreaterThanOrEqual(2)
  })

  it('both notices are honest and actionable, without inventing model prose', () => {
    const early = renderBudgetNotice('Video', 40 * 60_000, 10 * 60_000)
    expect(early).toContain('about 40 minutes')
    expect(early).toContain('10 minute budget')
    expect(early).toContain('cancelled')
    const flat = renderTimeoutNotice('Video', 10 * 60_000)
    expect(flat).toContain('10 minute budget')
    for (const msg of [early, flat]) {
      expect(msg).toContain('Settings')
      expect(msg).toMatch(/^Video generation/)
    }
  })
})

describe('the warm-up budget (G24, R17c witness)', () => {
  it('R17c: WS alive, nothing on the GPU ever progressed, budget spent, job dies', () => {
    expect(warmupExceeded(false, true, SWAP_WARMUP_BUDGET_MS + 1)).toBe(true)
  })

  it('the budget sits well above the promised 30 to 90 s swap', () => {
    expect(SWAP_WARMUP_BUDGET_MS).toBeGreaterThanOrEqual(3 * 60_000)
  })

  it('NEGATIVE CONTROL: without a WS we stay blind, only the flat deadline applies', () => {
    expect(warmupExceeded(false, false, SWAP_WARMUP_BUDGET_MS * 10)).toBe(false)
  })

  it('NEGATIVE CONTROL: a slow load that is still inside the budget gets to finish', () => {
    expect(warmupExceeded(false, true, SWAP_WARMUP_BUDGET_MS - 1)).toBe(false)
  })

  it('NEGATIVE CONTROL: progress on ANY prompt means busy, not wedged, no kill', () => {
    // A healthy job queued behind another client's render must not be punished.
    expect(warmupExceeded(true, true, SWAP_WARMUP_BUDGET_MS * 10)).toBe(false)
  })

  it('the notice says what was observed and how to get out of it', () => {
    const msg = swapWarmupNotice('Video', 5 * 60_000)
    expect(msg).toContain('5 minutes')
    expect(msg).toContain('still loading into VRAM')
    expect(msg).toContain('cancelled')
    expect(msg).toContain('Settings')
    expect(msg).toMatch(/^Video generation/)
  })
})

describe('the load phase does not eat the render budget (Z36 finding 4)', () => {
  const IMAGE_BUDGET = 5 * 60_000
  // The Z36 witness, W3 run 2026-08-16: a forced z_image_bf16 render in the
  // chat tool. The big bf16 checkpoint loads first, sampling only starts after
  // it, and the whole thing lands at 352.6 s against a 5 minute budget.
  const LOAD_MS = 300_000
  const TOTAL_MS = 352_600

  const deadlineAt = (firstOwnProgressAt: number | null, now: number, wsConnected = true) =>
    IMAGE_BUDGET + loadPhaseGraceMs(wsConnected, 0, firstOwnProgressAt, now)

  it('the Z36 render survives: at 352.6 s the deadline has not been reached', () => {
    // sampling started at 300 s, so the budget only starts counting there
    expect(TOTAL_MS).toBeLessThan(deadlineAt(LOAD_MS, TOTAL_MS))
  })

  it('the same render dies without the grace, which is exactly what was reported', () => {
    expect(TOTAL_MS).toBeGreaterThan(IMAGE_BUDGET)
  })

  it('the grace freezes at the measured load once sampling has started', () => {
    expect(loadPhaseGraceMs(true, 0, LOAD_MS, TOTAL_MS)).toBe(LOAD_MS)
    // and it does not keep growing with the clock afterwards
    expect(loadPhaseGraceMs(true, 0, LOAD_MS, TOTAL_MS + 600_000)).toBe(LOAD_MS)
  })

  it('while the checkpoint is still loading the grace grows with the clock', () => {
    expect(loadPhaseGraceMs(true, 0, null, 60_000)).toBe(60_000)
    expect(loadPhaseGraceMs(true, 0, null, 120_000)).toBe(120_000)
  })

  it('the whole wait stays bounded: the grace never exceeds its cap', () => {
    expect(loadPhaseGraceMs(true, 0, null, 60 * 60_000)).toBe(LOAD_PHASE_GRACE_CAP_MS)
    expect(loadPhaseGraceMs(true, 0, 60 * 60_000, 60 * 60_000)).toBe(LOAD_PHASE_GRACE_CAP_MS)
    // and the cap the poll loop really passes is the warm-up budget in force
    expect(loadPhaseGraceMs(true, 0, null, 60 * 60_000, warmupBudgetMs(false))).toBe(SWAP_WARMUP_BUDGET_MS)
  })

  it('the cap matches the warm-up ceiling, so a wedged load trips G24 first', () => {
    // The two guards cannot disagree about how long a load may take: the
    // warm-up verdict lands first, with the message that names the real cause.
    expect(LOAD_PHASE_GRACE_CAP_MS).toBe(SWAP_WARMUP_ALIVE_BUDGET_MS)
    expect(warmupExceeded(false, true, SWAP_WARMUP_ALIVE_BUDGET_MS + 1, SWAP_WARMUP_ALIVE_BUDGET_MS)).toBe(true)
  })

  it('NEGATIVE CONTROL: without a WS there is no grace, the old flat deadline stands', () => {
    expect(loadPhaseGraceMs(false, 0, null, 120_000)).toBe(0)
    expect(loadPhaseGraceMs(false, 0, LOAD_MS, TOTAL_MS)).toBe(0)
    expect(deadlineAt(LOAD_MS, TOTAL_MS, false)).toBe(IMAGE_BUDGET)
  })

  it('NEGATIVE CONTROL: a render that starts sampling at once gets no free time', () => {
    expect(loadPhaseGraceMs(true, 0, 0, 10_000)).toBe(0)
    expect(deadlineAt(0, 10_000)).toBe(IMAGE_BUDGET)
  })

  it('NEGATIVE CONTROL: R32 is untouched, the pace verdict still uses the raw budget', () => {
    // 30 steps at 80 s each after a 4 minute load: the projection is hopeless
    // against the 5 minute budget and must stay hopeless.
    const t = new PaceTracker()
    t.tick(1, 30, 240_000)
    t.tick(2, 30, 320_000)
    t.tick(3, 30, 400_000)
    t.tick(4, 30, 480_000)
    expect(overBudget(t.projectedTotalMs(), IMAGE_BUDGET)).toBe(true)
  })
})

describe('a render seconds from done is adopted, not thrown away (Z36 finding 4)', () => {
  const paceAt = (value: number, max: number, stepMs: number) => {
    const t = new PaceTracker()
    for (let i = 0; i <= 4; i++) t.tick(value - 4 + i, max, (value - 4 + i) * stepMs)
    return t
  }

  it('20 steps of 25 done at 1 s each: the rest fits, the job gets the grace', () => {
    const t = paceAt(20, 25, 1000)
    expect(t.projectedRemainingMs()).toBeCloseTo(5000, -2)
    expect(finishGraceMs(t.projectedRemainingMs())).toBe(FINISH_GRACE_CAP_MS)
  })

  it('the grace is bounded and granted from one measurement only', () => {
    expect(finishGraceMs(FINISH_GRACE_CAP_MS)).toBe(FINISH_GRACE_CAP_MS)
    expect(finishGraceMs(0)).toBe(FINISH_GRACE_CAP_MS)
  })

  it('NEGATIVE CONTROL: half an hour of work left buys nothing', () => {
    expect(finishGraceMs(30 * 60_000)).toBe(0)
    expect(finishGraceMs(FINISH_GRACE_CAP_MS + 1)).toBe(0)
  })

  it('NEGATIVE CONTROL: no measured pace, no grace', () => {
    expect(finishGraceMs(null)).toBe(0)
    expect(finishGraceMs(Number.NaN)).toBe(0)
    expect(new PaceTracker().projectedRemainingMs()).toBe(null)
    const barely = new PaceTracker()
    barely.tick(1, 30, 0)
    barely.tick(2, 30, 1000)
    expect(barely.projectedRemainingMs()).toBe(null)
  })

  it('the timeout notice names the real elapsed time when the load stretched it', () => {
    const n = renderTimeoutNotice('Image', 5 * 60_000, 9 * 60_000)
    expect(n).toContain('5 minute budget')
    expect(n).toContain('about 9 minutes')
    expect(n).toContain('loading')
    // NEGATIVE CONTROL: no stretch, no extra sentence
    expect(renderTimeoutNotice('Image', 5 * 60_000, 4 * 60_000)).not.toContain('about')
    expect(renderTimeoutNotice('Image', 5 * 60_000)).not.toContain('about')
  })
})

describe('a confirmed-alive load is not a wedged load (Z36 finding 4)', () => {
  it('the plain budget still ends a load nothing can vouch for', () => {
    expect(warmupBudgetMs(false)).toBe(SWAP_WARMUP_BUDGET_MS)
    expect(warmupExceeded(false, true, SWAP_WARMUP_BUDGET_MS + 1, warmupBudgetMs(false))).toBe(true)
  })

  it('a prompt ComfyUI still has in its queue buys the doubled budget', () => {
    expect(warmupBudgetMs(true)).toBe(SWAP_WARMUP_ALIVE_BUDGET_MS)
    expect(SWAP_WARMUP_ALIVE_BUDGET_MS).toBe(2 * SWAP_WARMUP_BUDGET_MS)
    // the Z36 load, past the plain budget, survives on the life signal
    expect(warmupExceeded(false, true, SWAP_WARMUP_BUDGET_MS + 1, warmupBudgetMs(true))).toBe(false)
  })

  it('NEGATIVE CONTROL: R17c still dies, 19 wedged minutes beat both budgets', () => {
    const R17C = 19 * 60_000
    expect(warmupExceeded(false, true, R17C, warmupBudgetMs(false))).toBe(true)
    expect(warmupExceeded(false, true, R17C, warmupBudgetMs(true))).toBe(true)
  })

  it('NEGATIVE CONTROL: the life signal never overrides the WS and progress gates', () => {
    // no WS, we are blind by design
    expect(warmupExceeded(false, false, 60 * 60_000, warmupBudgetMs(true))).toBe(false)
    // something on the GPU moved, so the load is not wedged and nothing dies
    expect(warmupExceeded(true, true, 60 * 60_000, warmupBudgetMs(true))).toBe(false)
  })
})

describe('wiring in the poll loop', () => {
  const handoff = read('../../api/vram-handoff.ts')

  it('the poll loop feeds progress events into the tracker and checks the budget', () => {
    expect(handoff).toContain("if (ev.type === 'progress') {")
    expect(handoff).toContain('pace.tick(ev.data.value, ev.data.max, at)')
    expect(handoff).toContain('if (overBudget(projected, timeoutMs))')
  })

  it('ALL THREE exits abandon the job instead of orphaning it', () => {
    // pace verdict, warm-up verdict (G24), flat deadline
    expect(handoff.match(/await abandonPrompt\(promptId\)/g)?.length).toBe(3)
    expect(handoff).not.toContain('generation timed out after')
  })

  it('G24: the loop tracks warm-up with ANY-prompt progress and the live WS state', () => {
    expect(handoff).toContain('sawAnyProgress = true')
    expect(handoff).toContain('warmupExceeded(sawAnyProgress, comfyWS.connected, warmupElapsed, warmupBudgetMs(promptAlive))')
    // own-prompt ticks still feed the pace tracker underneath the any-progress flag
    expect(handoff).toContain("if (ev.data.prompt_id === promptId) {")
  })

  it('the WS listener is always released', () => {
    expect(handoff).toContain('offProgress()')
  })

  it('Z36 finding 4: the deadline is recomputed per tick and carries the load phase', () => {
    // the old fixed wall clock is gone from the poll loop (other helpers keep
    // their own plain deadlines, this pin must not reach into them)
    const loop = handoff.slice(handoff.indexOf('async function pollAndExtract'))
    expect(loop).not.toContain('const deadline = Date.now() + timeoutMs')
    expect(handoff).toContain('loadPhaseGraceMs(comfyWS.connected, startedAt, firstOwnProgressAt, Date.now(),')
    expect(handoff).toContain('if (firstOwnProgressAt === null) firstOwnProgressAt = at')
    // the pace verdict keeps the RAW budget, so R32 dies as early as before
    expect(handoff).toContain('if (overBudget(projected, timeoutMs))')
  })

  it('Z36 finding 4: the loop asks ComfyUI whether a long load is still alive', () => {
    expect(handoff).toContain('promptAlive = await isPromptQueued(promptId)')
    // the question is only asked once the plain budget is spent, and throttled
    expect(handoff).toContain('warmupElapsed > SWAP_WARMUP_BUDGET_MS && Date.now() - aliveCheckedAt > 30_000')
    // and the same budget bounds the flat deadline's load grace
    expect(handoff).toContain('warmupBudgetMs(promptAlive))')
  })

  it('Z36 finding 4: a nearly finished render is adopted once, then the job ends', () => {
    expect(handoff).toContain('finishGraceUsed === 0 ? finishGraceMs(pace.projectedRemainingMs()) : 0')
    expect(handoff).toContain('finishGraceUsed = grace')
    expect(handoff).toContain('renderTimeoutNotice(kindLabel, timeoutMs, elapsedMs,')
  })

  it('abandonPrompt kills only OUR job: pending delete first, interrupt only if ours runs', () => {
    const comfy = read('../../api/comfyui.ts')
    const fn = comfy.slice(comfy.indexOf('export async function abandonPrompt'))
    expect(fn.indexOf('delete: [promptId]')).toBeGreaterThan(-1)
    expect(fn.indexOf('delete: [promptId]')).toBeLessThan(fn.indexOf('cancelGeneration()'))
    expect(fn).toContain('if (running) await cancelGeneration()')
  })

  it('NEGATIVE CONTROL: the user cancel path is untouched', () => {
    expect(handoff).toContain('if (_genCancelRequested) return `${kindLabel} generation cancelled.`')
  })
})

/**
 * Runde 12, Punkt 2. A render that ran on the processor got three different
 * failure messages and not one of them said so: renderBudgetNotice told the
 * customer to use fewer steps, swapWarmupNotice told him to free VRAM on a
 * machine that was not using any, and renderTimeoutNotice said nothing at all.
 * shd_scorpion sent us the screenshot of one of them, and the cause was not in
 * it, so the support answer had to guess.
 */
describe('a render without a GPU says so (Runde 12)', () => {
  // `mode: 'auto'` is what these three cases really were: LU fell back to the
  // processor on its own. Round 14 added the field because the same notices
  // were reporting that fallback to a user who had picked Force CPU himself.
  const onCpu = { startedCpu: true, mode: 'auto', hasAmd: false, isWindows: false } as const
  const amdLinux = { startedCpu: true, mode: 'auto', hasAmd: true, isWindows: false } as const
  const amdWindows = { startedCpu: true, mode: 'auto', hasAmd: true, isWindows: true } as const

  it('names the processor as the cause, in one shared sentence', () => {
    const s = cpuCauseSuffix(onCpu)
    expect(s).toContain('running on the CPU')
    expect(s).toContain('no supported GPU path is active')
    expect(s).toContain('many times slower')
  })

  it('an AMD card is told the way out its own OS actually has', () => {
    // Linux: LU installs ROCm wheels since 2.6.7, so a rebuild is a real fix.
    expect(cpuCauseSuffix(amdLinux)).toContain('Repair environment')
    // Windows: no rebuild can conjure a wheel, so it must not be offered.
    expect(cpuCauseSuffix(amdWindows)).not.toContain('Repair environment')
    expect(cpuCauseSuffix(amdWindows)).toContain('on Windows')
  })

  it('NEGATIVE CONTROL: says nothing when the render had a GPU or we do not know', () => {
    expect(cpuCauseSuffix({ startedCpu: false, mode: 'auto', hasAmd: true, isWindows: true })).toBe('')
    // and a Force CPU pick that LU has not (re)started ComfyUI under yet is
    // still no render on the processor, so still nothing to say
    expect(cpuCauseSuffix({ startedCpu: false, mode: 'cpu', hasAmd: false, isWindows: true })).toBe('')
    expect(cpuCauseSuffix(null)).toBe('')
    expect(cpuCauseSuffix(undefined)).toBe('')
  })

  it('the pace verdict stops blaming the step count for a hardware switch', () => {
    const n = renderBudgetNotice('Image', 40 * 60_000, 10 * 60_000, onCpu)
    expect(n).toContain('running on the CPU')
    // the measured facts are still there, the cause is added, not swapped in
    expect(n).toContain('about 40 minutes')
    expect(n).toContain('10 minute budget')
    // NEGATIVE CONTROL: on a GPU the message is byte for byte what it was
    expect(renderBudgetNotice('Image', 40 * 60_000, 10 * 60_000)).not.toContain('CPU')
    expect(renderBudgetNotice('Image', 40 * 60_000, 10 * 60_000, null))
      .toBe(renderBudgetNotice('Image', 40 * 60_000, 10 * 60_000))
  })

  it('the flat deadline names the cause too', () => {
    const n = renderTimeoutNotice('Video', 20 * 60_000, 30 * 60_000, amdLinux)
    expect(n).toContain('running on the CPU')
    expect(n).toContain('20 minute budget')
    // NEGATIVE CONTROL
    expect(renderTimeoutNotice('Video', 20 * 60_000, 30 * 60_000, null))
      .toBe(renderTimeoutNotice('Video', 20 * 60_000, 30 * 60_000))
  })

  it('the warm-up abort stops advising VRAM on a machine that uses none', () => {
    const n = swapWarmupNotice('Image', 6 * 60_000, onCpu)
    expect(n).not.toContain('VRAM')
    expect(n).not.toContain('GPU is free again')
    expect(n).toContain('running on the CPU')
    expect(n).toContain('6 minutes')
    // NEGATIVE CONTROL: on a real GPU the VRAM advice is correct and stays.
    const gpu = swapWarmupNotice('Image', 6 * 60_000)
    expect(gpu).toContain('Free some VRAM')
    expect(gpu).toContain('loading into VRAM')
    expect(swapWarmupNotice('Image', 6 * 60_000, null)).toBe(gpu)
  })
})

describe('the CPU cause is wired into all five failure exits (Runde 12)', () => {
  const handoff = read('../../api/vram-handoff.ts')
  const create = read('../../hooks/useCreate.ts')
  const process_rs = read('../../../src-tauri/src/commands/process.rs')

  it('the backend hands the frontend the vendor, not just the device', () => {
    expect(process_rs).toContain('"startedCpu": started_cpu, "hasAmd": has_amd')
  })

  it('the three agent-path exits ask before they blame', () => {
    expect(handoff).toContain('renderTimeoutNotice(kindLabel, timeoutMs, elapsedMs, await cpuRenderFacts())')
    expect(handoff).toContain('renderBudgetNotice(kindLabel, projected!, timeoutMs, await cpuRenderFacts())')
    expect(handoff).toContain('swapWarmupNotice(kindLabel, warmupElapsed, await cpuRenderFacts())')
    // asked only on the way out, so a healthy render pays nothing for it
    expect(handoff.match(/await cpuRenderFacts\(\)/g)?.length).toBe(3)
  })

  it('both Create stall watchdogs carry it too', () => {
    // They fire from a timer and cannot await, so the answer is fetched when
    // the render starts and read from the cache here.
    expect(create).toContain('void cpuRenderFacts()')
    expect(create.match(/cpuCauseSuffix\(lastCpuRenderFacts\(\)\)/g)?.length).toBe(2)
  })
})
