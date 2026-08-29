/**
 * Z36 finding 4 (W3 run 2026-08-16): a forced z_image_bf16 render in the CHAT
 * tool was abandoned after 352.6 s, while the Create tab renders the same job.
 * The first load of the big bf16 checkpoint on a 3060 outlasted the 5 minute
 * warm-up budget, which cannot tell a slow load from a wedged one. The image
 * budget itself defaults to 20 minutes, so the flat deadline was never the one
 * that fired; it is fixed here too because a shorter user budget hits it next.
 *
 * These tests drive the REAL poll loop on a virtual clock and replay that
 * timeline. The pure budget maths lives in render-budget.test.ts; this file
 * proves the loop behaves.
 *
 * Run: npx vitest run src/api/__tests__/render-load-phase.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => {
  const handlers: ((ev: unknown) => void)[] = []
  return {
    handlers,
    wsConnected: { value: true },
    getImageModels: vi.fn(),
    getSystemVRAM: vi.fn(),
    submitWorkflow: vi.fn(),
    getHistory: vi.fn(),
    isPromptQueued: vi.fn(),
    abandonPrompt: vi.fn(),
    sweepOrphanedLuJobs: vi.fn(),
    freeMemory: vi.fn(),
    cancelGeneration: vi.fn(),
    clearComfyQueue: vi.fn(),
    buildDynamicWorkflow: vi.fn(),
    backendCall: vi.fn(),
    listRunningModels: vi.fn(),
    loadModel: vi.fn(),
    unloadModel: vi.fn(),
    getActiveAgentModel: vi.fn(),
  }
})

vi.mock('../backend', () => ({
  backendCall: (...a: unknown[]) => h.backendCall(...a),
  localFetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
  ollamaUrl: (p: string) => `http://localhost:11434/api${p}`,
  comfyuiUrl: (p: string) => `http://localhost:8188${p}`,
  isOllamaLocal: () => true,
}))

vi.mock('../ollama', () => ({
  listRunningModels: (...a: unknown[]) => h.listRunningModels(...a),
  loadModel: (...a: unknown[]) => h.loadModel(...a),
  unloadModel: (...a: unknown[]) => h.unloadModel(...a),
}))

vi.mock('../comfyui', async () => {
  const actual = await vi.importActual<typeof import('../comfyui')>('../comfyui')
  return {
    ...actual,
    getImageModels: (...a: unknown[]) => h.getImageModels(...a),
    getSystemVRAM: (...a: unknown[]) => h.getSystemVRAM(...a),
    submitWorkflow: (...a: unknown[]) => h.submitWorkflow(...a),
    getHistory: (...a: unknown[]) => h.getHistory(...a),
    isPromptQueued: (...a: unknown[]) => h.isPromptQueued(...a),
    abandonPrompt: (...a: unknown[]) => h.abandonPrompt(...a),
    sweepOrphanedLuJobs: (...a: unknown[]) => h.sweepOrphanedLuJobs(...a),
    freeMemory: (...a: unknown[]) => h.freeMemory(...a),
    cancelGeneration: (...a: unknown[]) => h.cancelGeneration(...a),
    clearComfyQueue: (...a: unknown[]) => h.clearComfyQueue(...a),
  }
})

vi.mock('../dynamic-workflow', () => ({
  buildDynamicWorkflow: (...a: unknown[]) => h.buildDynamicWorkflow(...a),
}))

vi.mock('../agent-context', () => ({
  getActiveAgentModel: () => h.getActiveAgentModel(),
}))

// A LIVE websocket, unlike the sibling suite: the load phase can only be told
// apart from the sampling phase by ComfyUI's own progress events.
vi.mock('../comfyui-ws', () => ({
  comfyWS: {
    on: (cb: (ev: unknown) => void) => {
      h.handlers.push(cb)
      return () => { const i = h.handlers.indexOf(cb); if (i >= 0) h.handlers.splice(i, 1) }
    },
    connect: () => Promise.resolve(),
    get connected() { return h.wsConnected.value },
  },
  CLIENT_ID: 'lu-test-client',
}))

import { vramHandoffGenerate, __resetGenerationStateForTests } from '../vram-handoff'
import { SWAP_WARMUP_BUDGET_MS, SWAP_WARMUP_ALIVE_BUDGET_MS } from '../../lib/render-budget'
import { useSettingsStore } from '../../stores/settingsStore'
import { DEFAULT_SETTINGS } from '../../lib/constants'

const PROMPT_ID = 'z-image-run'

/** The witness numbers: the checkpoint load outlasts the warm-up budget and
 *  the whole job lands at 352.6 s. */
const SAMPLING_STARTS_AT = 320_000
const COMPLETED_AT = 352_600

/** Shrink the image budget so the flat-deadline half is reachable in a test.
 *  The shipped default is 20 minutes, which the witness never came near. */
function useImageBudgetMinutes(mins: number): number {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, imageGenTimeoutMinutes: mins } })
  return mins * 60_000
}

let lastEmitted = 0

/**
 * Emit one sampler tick. ComfyUI goes quiet once the pass is done, so a value
 * that has already been sent is not repeated, and a dead socket delivers
 * nothing at all.
 */
function emitProgress(value: number, max: number, promptId = PROMPT_ID) {
  if (!h.wsConnected.value || value <= lastEmitted) return
  lastEmitted = value
  for (const cb of [...h.handlers]) cb({ type: 'progress', data: { prompt_id: promptId, value, max } })
}

const completedHistory = () => ({
  status: { completed: true },
  outputs: { '9': { images: [{ filename: 'z-image.png', subfolder: '', type: 'output' }] } },
})

/**
 * The FIRST generation in this module pays a one-time lazy init (the node-type
 * catalogue behind fetchCaps). It never reaches the poll loop on a virtual
 * clock, so pay it once on the real one before any case runs.
 */
beforeAll(async () => {
  h.getActiveAgentModel.mockReturnValue({ name: 'gpt-4o', providerId: 'openai', remote: false })
  h.getImageModels.mockResolvedValue([{ name: 'z_image_bf16.safetensors', type: 'sdxl', source: 'checkpoint' }])
  h.buildDynamicWorkflow.mockResolvedValue({ '9': { class_type: 'SaveImage' } })
  h.submitWorkflow.mockResolvedValue('warmup')
  h.getHistory.mockResolvedValue(completedHistory())
  h.getSystemVRAM.mockResolvedValue(null)
  h.listRunningModels.mockResolvedValue([])
  for (const fn of [h.freeMemory, h.loadModel, h.unloadModel, h.cancelGeneration, h.clearComfyQueue, h.abandonPrompt, h.sweepOrphanedLuJobs]) {
    fn.mockResolvedValue(undefined)
  }
  h.isPromptQueued.mockResolvedValue(false)
  h.backendCall.mockImplementation(async (cmd: string) => (cmd === 'comfyui_status' ? { running: true } : {}))
  await vramHandoffGenerate('image', { prompt: 'warm up the module' })
}, 30_000)

beforeEach(() => {
  vi.useFakeTimers()
  h.handlers.length = 0
  h.wsConnected.value = true
  for (const fn of Object.values(h)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset()
  }
  __resetGenerationStateForTests()
  h.getActiveAgentModel.mockReturnValue({ name: 'gpt-4o', providerId: 'openai', remote: false })
  h.getImageModels.mockResolvedValue([{ name: 'z_image_bf16.safetensors', type: 'sdxl', source: 'checkpoint' }])
  h.buildDynamicWorkflow.mockResolvedValue({ '9': { class_type: 'SaveImage' } })
  h.submitWorkflow.mockResolvedValue(PROMPT_ID)
  h.getSystemVRAM.mockResolvedValue(null)
  h.listRunningModels.mockResolvedValue([])
  h.freeMemory.mockResolvedValue(undefined)
  h.loadModel.mockResolvedValue(undefined)
  h.unloadModel.mockResolvedValue(undefined)
  h.cancelGeneration.mockResolvedValue(undefined)
  h.clearComfyQueue.mockResolvedValue(undefined)
  h.abandonPrompt.mockResolvedValue(undefined)
  h.sweepOrphanedLuJobs.mockResolvedValue(undefined)
  h.isPromptQueued.mockResolvedValue(false)
  h.backendCall.mockImplementation(async (cmd: string) => (cmd === 'comfyui_status' ? { running: true } : {}))
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
})

afterEach(() => { vi.useRealTimers() })

/**
 * Replay a render on the virtual clock. `script` is asked on every poll what
 * ComfyUI would say at that moment, and may emit progress events.
 */
let lastElapsed = 0

async function runRender(script: (elapsed: number) => unknown, forMs: number): Promise<string> {
  const t0 = Date.now()
  lastElapsed = 0
  lastEmitted = 0
  h.getHistory.mockImplementation(async () => {
    lastElapsed = Date.now() - t0
    return script(lastElapsed)
  })
  let settled: string | null = null
  void vramHandoffGenerate('image', { prompt: 'a lighthouse' }).then((r) => { settled = r })
  // Step the virtual clock in minutes and stop as soon as the loop is done, so
  // a case that ends early does not pay for the rest of the window.
  for (let spent = 0; spent < forMs && settled === null; spent += 60_000) {
    await vi.advanceTimersByTimeAsync(Math.min(60_000, forMs - spent))
  }
  if (settled === null) throw new Error(`render did not finish inside ${forMs} ms of virtual time (last poll at ${lastElapsed} ms, ${h.getHistory.mock.calls.length} polls)`)
  return settled
}

/** Virtual ms from the start of the render to where the loop finished. */
function finishedAfter(): number { return lastElapsed }

describe('Z36 finding 4: the first checkpoint load stops eating the render budget', () => {
  // Each case steps a virtual clock through hundreds of one-second polls.

  it('the reported render survives: the load outlasts the warm-up budget', async () => {
    // Exactly the witness: nothing progresses for 320 s while the bf16
    // checkpoint loads, ComfyUI still has our prompt, sampling then finishes
    // the job at 352.6 s. Before the fix the warm-up guard killed it at 300 s.
    h.isPromptQueued.mockResolvedValue(true)
    const out = await runRender((elapsed) => {
      if (elapsed >= SAMPLING_STARTS_AT) {
        // Z-Image Turbo: eight quick steps once the checkpoint is finally in
        emitProgress(Math.min(8, Math.floor((elapsed - SAMPLING_STARTS_AT) / 4_000) + 1), 8)
      }
      return elapsed >= COMPLETED_AT ? completedHistory() : undefined
    }, 15 * 60_000)

    expect(out).toContain('Image generated: z-image.png')
    expect(h.isPromptQueued).toHaveBeenCalledWith(PROMPT_ID)
    expect(h.abandonPrompt).not.toHaveBeenCalled()
  }, 30_000)

  it('NEGATIVE CONTROL: a load nobody vouches for still dies on the plain budget', async () => {
    h.isPromptQueued.mockResolvedValue(false)
    const out = await runRender(() => undefined, 20 * 60_000)

    expect(out).toContain('still loading into VRAM')
    expect(h.abandonPrompt).toHaveBeenCalledWith(PROMPT_ID)
    expect(finishedAfter()).toBeLessThan(SWAP_WARMUP_ALIVE_BUDGET_MS)
    expect(finishedAfter()).toBeGreaterThanOrEqual(SWAP_WARMUP_BUDGET_MS)
  }, 30_000)

  it('NEGATIVE CONTROL: R17c, wedged but queued, still dies on the doubled budget', async () => {
    h.isPromptQueued.mockResolvedValue(true)
    const out = await runRender(() => undefined, 25 * 60_000)

    expect(out).toContain('still loading into VRAM')
    expect(h.abandonPrompt).toHaveBeenCalledWith(PROMPT_ID)
    expect(finishedAfter()).toBeGreaterThanOrEqual(SWAP_WARMUP_ALIVE_BUDGET_MS)
  }, 30_000)

  it('a short user budget spends its minutes on the render, not on the load', async () => {
    const budget = useImageBudgetMinutes(5)
    h.isPromptQueued.mockResolvedValue(true)
    // load until 4 min, then a 3 minute sampling pass: 7 min in total, more
    // than the 5 minute budget, but the render itself fits inside it
    const LOAD = 240_000
    const out = await runRender((elapsed) => {
      if (elapsed >= LOAD) emitProgress(Math.min(12, Math.floor((elapsed - LOAD) / 15_000) + 1), 12)
      return elapsed >= LOAD + 180_000 ? completedHistory() : undefined
    }, 20 * 60_000)

    expect(budget).toBe(5 * 60_000)
    expect(out).toContain('Image generated: z-image.png')
    expect(h.abandonPrompt).not.toHaveBeenCalled()
    expect(finishedAfter()).toBeGreaterThan(budget)
  }, 30_000)

  it('a render still sampling at the deadline is adopted, not thrown away', async () => {
    const budget = useImageBudgetMinutes(5)
    // sampling from the first seconds at a pace that lands just past the budget
    const out = await runRender((elapsed) => {
      emitProgress(Math.min(20, Math.floor(elapsed / 15_000) + 1), 20)
      return elapsed >= budget + 20_000 ? completedHistory() : undefined
    }, 20 * 60_000)

    expect(out).toContain('Image generated: z-image.png')
    expect(h.abandonPrompt).not.toHaveBeenCalled()
  }, 30_000)

  it('NEGATIVE CONTROL: R32, a hopeless sampling pace, still dies after three steps', async () => {
    const budget = useImageBudgetMinutes(5)
    // 30 steps at 80 s each, sampling from the very first second
    const out = await runRender((elapsed) => {
      emitProgress(Math.max(1, Math.floor(elapsed / 80_000) + 1), 30)
      return undefined
    }, 20 * 60_000)

    expect(out).toContain('stopped early')
    expect(h.abandonPrompt).toHaveBeenCalledWith(PROMPT_ID)
    // the verdict lands long before the budget, exactly as before the fix
    expect(finishedAfter()).toBeLessThan(budget)
  }, 30_000)

  it('NEGATIVE CONTROL: without a WS nothing is granted, the flat budget stands', async () => {
    const budget = useImageBudgetMinutes(5)
    h.wsConnected.value = false
    const out = await runRender((elapsed) => (elapsed >= COMPLETED_AT ? completedHistory() : undefined), 20 * 60_000)

    expect(out).toContain('hit the 5 minute budget')
    expect(h.abandonPrompt).toHaveBeenCalledWith(PROMPT_ID)
    expect(finishedAfter()).toBeLessThan(budget + 60_000)
  }, 30_000)
})
