/**
 * Feature EE (v2.5.0) — VRAM hand-off orchestrator unit tests.
 *
 * What these CAN prove (pure logic + control flow, all services mocked):
 *   1. decideUnload() math — fits / doesn't-fit / unknown sizes / mode matrix.
 *   2. The cloud/remote SKIP path — a non-local text model must NOT be evicted.
 *   3. The finally-ALWAYS-reloads invariant — loadModel runs even when the
 *      generation throws (success/failure/timeout all hit the finally).
 *   4. pollGone() timeout behaviour — gives up after the deadline.
 *
 * What they CANNOT prove (per the Bug-G lesson, only live E2E can): whether a
 * real ComfyUI OOMs on low-VRAM hardware, or whether the chosen footprint
 * estimates actually keep the two models from colliding on a given GPU. Those
 * numbers are conservative guesses; this file only checks that the DECISION and
 * the ORCHESTRATION are correct given known inputs.
 *
 * Run: npx vitest run src/api/__tests__/vram-handoff.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Mocks (hoisted) ───────────────────────────────────────────────
// Mirror the bg-tasks.test.ts pattern: top-level vi.fn()s referenced via the
// mock factory so each test can program return values per case.

const localFetch = vi.fn()
const listRunningModels = vi.fn()
const loadModel = vi.fn()
const unloadModel = vi.fn()
const getImageModels = vi.fn()
const getVideoModels = vi.fn()
const detectVideoBackend = vi.fn()
const getSystemVRAM = vi.fn()
const submitWorkflow = vi.fn()
const getHistory = vi.fn()
const cancelGeneration = vi.fn()
const clearComfyQueue = vi.fn()
const abandonPrompt = vi.fn()
const checkComfyConnection = vi.fn()
const freeMemory = vi.fn()
const buildDynamicWorkflow = vi.fn()
const buildTxt2VidWorkflow = vi.fn()
const backendCall = vi.fn()
const getActiveAgentModel = vi.fn()
let isOllamaLocalReturn = true

vi.mock('../backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...a),
  localFetch: (...a: unknown[]) => localFetch(...a),
  ollamaUrl: (p: string) => `http://localhost:11434/api${p.startsWith('/') ? p : '/' + p}`,
  comfyuiUrl: (p: string) => `http://localhost:8188${p}`,
  isOllamaLocal: () => isOllamaLocalReturn,
}))

vi.mock('../ollama', () => ({
  listRunningModels: (...a: unknown[]) => listRunningModels(...a),
  loadModel: (...a: unknown[]) => loadModel(...a),
  unloadModel: (...a: unknown[]) => unloadModel(...a),
}))

vi.mock('../comfyui', async () => {
  const actual = await vi.importActual<typeof import('../comfyui')>('../comfyui')
  return {
    ...actual,
    getImageModels: (...a: unknown[]) => getImageModels(...a),
    getVideoModels: (...a: unknown[]) => getVideoModels(...a),
    detectVideoBackend: (...a: unknown[]) => detectVideoBackend(...a),
    getSystemVRAM: (...a: unknown[]) => getSystemVRAM(...a),
    submitWorkflow: (...a: unknown[]) => submitWorkflow(...a),
    getHistory: (...a: unknown[]) => getHistory(...a),
    cancelGeneration: (...a: unknown[]) => cancelGeneration(...a),
    clearComfyQueue: (...a: unknown[]) => clearComfyQueue(...a),
    abandonPrompt: (...a: unknown[]) => abandonPrompt(...a),
    checkComfyConnection: (...a: unknown[]) => checkComfyConnection(...a),
    freeMemory: (...a: unknown[]) => freeMemory(...a),
    buildTxt2VidWorkflow: (...a: unknown[]) => buildTxt2VidWorkflow(...a),
    // classifyModel, snapToVideoGrid, extractComfyOutputFiles, getImageUrl,
    // MODEL_TYPE_DEFAULTS keep their real implementations (pure helpers).
  }
})

vi.mock('../dynamic-workflow', () => ({
  buildDynamicWorkflow: (...a: unknown[]) => buildDynamicWorkflow(...a),
}))

vi.mock('../agent-context', () => ({
  getActiveAgentModel: () => getActiveAgentModel(),
}))

// The real WS client would call isTauri()/WebSocket at connect time, which a
// unit test has no business doing. Disconnected here, so the pace tracker and
// the G24 warm-up guard stay silent and only the flat deadline applies.
vi.mock('../comfyui-ws', () => ({
  comfyWS: { on: () => () => {}, connect: () => Promise.resolve(), connected: false },
  CLIENT_ID: 'lu-test-client',
}))

// settingsStore is the real module — pure, no services. The orchestrator reads
// settings.exclusiveVramMode through it; default DEFAULT_SETTINGS = 'auto'.

import { decideUnload, vramHandoffGenerate, pollGone, resolveClip, resolveModelName, resolveI2VResolution, comfyErrorHint, requestGenerationCancel, resolveTunables, __resetGenerationStateForTests } from '../vram-handoff'
import { useSettingsStore } from '../../stores/settingsStore'

const GB = 1024 * 1024 * 1024

beforeEach(() => {
  localFetch.mockReset()
  listRunningModels.mockReset()
  loadModel.mockReset()
  unloadModel.mockReset()
  getImageModels.mockReset()
  getVideoModels.mockReset()
  detectVideoBackend.mockReset()
  getSystemVRAM.mockReset()
  submitWorkflow.mockReset()
  getHistory.mockReset()
  cancelGeneration.mockReset()
  clearComfyQueue.mockReset()
  cancelGeneration.mockResolvedValue(undefined)
  clearComfyQueue.mockResolvedValue(undefined)
  abandonPrompt.mockReset()
  abandonPrompt.mockResolvedValue(undefined)
  checkComfyConnection.mockReset()
  checkComfyConnection.mockResolvedValue(true)
  freeMemory.mockReset()
  buildDynamicWorkflow.mockReset()
  buildTxt2VidWorkflow.mockReset()
  backendCall.mockReset()
  getActiveAgentModel.mockReset()
  isOllamaLocalReturn = true
  // Default: no model resident, ComfyUI already running.
  listRunningModels.mockResolvedValue([])
  freeMemory.mockResolvedValue(undefined)
  loadModel.mockResolvedValue(undefined)
  unloadModel.mockResolvedValue(undefined)
  backendCall.mockImplementation(async (cmd: string) => {
    if (cmd === 'comfyui_status') return { running: true }
    return {}
  })
  // Reset exclusiveVramMode to default each test.
  useSettingsStore.getState().updateSettings({ exclusiveVramMode: 'auto' })
})

// ── 1. decideUnload() math ────────────────────────────────────────

describe('decideUnload', () => {
  it("auto: doesn't-fit → unload (text + footprint > VRAM)", () => {
    const r = decideUnload({ textVramBytes: 9 * GB, modelFootprintGB: 16, systemVramGB: 12, mode: 'auto' })
    expect(r.unload).toBe(true)
  })

  it('auto: fits → do NOT unload (text + footprint <= VRAM)', () => {
    const r = decideUnload({ textVramBytes: 4 * GB, modelFootprintGB: 8, systemVramGB: 24, mode: 'auto' })
    expect(r.unload).toBe(false)
  })

  it('auto: unknown footprint → do NOT unload (no eviction on a guess)', () => {
    const r = decideUnload({ textVramBytes: 9 * GB, modelFootprintGB: null, systemVramGB: 12, mode: 'auto' })
    expect(r.unload).toBe(false)
  })

  it('auto: unknown system VRAM → do NOT unload', () => {
    const r = decideUnload({ textVramBytes: 9 * GB, modelFootprintGB: 16, systemVramGB: null, mode: 'auto' })
    expect(r.unload).toBe(false)
  })

  it('auto: no text model resident (0 bytes) → nothing to free', () => {
    const r = decideUnload({ textVramBytes: 0, modelFootprintGB: 16, systemVramGB: 12, mode: 'auto' })
    expect(r.unload).toBe(false)
  })

  it("always: resident text model → unload regardless of fit", () => {
    const r = decideUnload({ textVramBytes: 2 * GB, modelFootprintGB: 4, systemVramGB: 80, mode: 'always' })
    expect(r.unload).toBe(true)
  })

  it('always: but no resident text model → nothing to unload', () => {
    const r = decideUnload({ textVramBytes: 0, modelFootprintGB: 4, systemVramGB: 8, mode: 'always' })
    expect(r.unload).toBe(false)
  })

  it('never: always false even when it clearly would not fit', () => {
    const r = decideUnload({ textVramBytes: 20 * GB, modelFootprintGB: 24, systemVramGB: 12, mode: 'never' })
    expect(r.unload).toBe(false)
  })

  it('auto: exact boundary (== VRAM) does NOT unload (fits)', () => {
    // 4GB text + 8GB model = 12GB, system 12GB → not strictly greater → fits.
    const r = decideUnload({ textVramBytes: 4 * GB, modelFootprintGB: 8, systemVramGB: 12, mode: 'auto' })
    expect(r.unload).toBe(false)
  })
})

// ── resolveClip: video length from seconds/frames/fps (David: "video nur 1s") ──

describe('resolveClip', () => {
  const SVD = { defFps: 8, defFrames: 25, maxFrames: 25 }
  const WAN = { defFps: 16, defFrames: 81, maxFrames: 161 }

  it('SVD default (no args) → full 25-frame clip, not a stubby 14 (~3s @ 8fps)', () => {
    expect(resolveClip({ prompt: 'x' }, SVD)).toEqual({ frames: 25, fps: 8 })
  })

  it('SVD seconds=2 → 16 frames @ 8fps (fits under the cap)', () => {
    expect(resolveClip({ prompt: 'x', seconds: 2 }, SVD)).toEqual({ frames: 16, fps: 8 })
  })

  it('SVD seconds=4 → caps at 25 frames but LOWERS fps so it still lasts ~4s', () => {
    const r = resolveClip({ prompt: 'x', seconds: 4 }, SVD)
    expect(r.frames).toBe(25)
    expect(r.fps).toBe(6) // 25/4 ≈ 6 → 25 frames @ 6fps ≈ 4.2s (duration honored)
  })

  it('explicit frames is respected (advanced) and clamped to the model cap', () => {
    expect(resolveClip({ prompt: 'x', frames: 14 }, SVD)).toEqual({ frames: 14, fps: 8 })
    expect(resolveClip({ prompt: 'x', frames: 999 }, SVD).frames).toBe(25)
  })

  it('Wan seconds=4 → 64 frames @ 16fps (text-to-video can run longer)', () => {
    expect(resolveClip({ prompt: 'x', seconds: 4 }, WAN)).toEqual({ frames: 64, fps: 16 })
  })

  it('Wan default → the model default length', () => {
    expect(resolveClip({ prompt: 'x' }, WAN)).toEqual({ frames: 81, fps: 16 })
  })

  // FramePack packs long video, so its I2V branch uses a high ceiling instead of
  // SVD's 25 (David 2026-06-04: "FramePacks frame cap anheben durch input von uns").
  const FRAMEPACK = { defFps: 16, defFrames: 49, maxFrames: 600 }

  it('FramePack default → 49 frames @ 16fps (model default)', () => {
    expect(resolveClip({ prompt: 'x' }, FRAMEPACK)).toEqual({ frames: 49, fps: 16 })
  })

  it('FramePack honors the request beyond SVD: seconds=7 fps=40 → 280 frames @ 40fps (true 40fps, NOT capped to 25)', () => {
    expect(resolveClip({ prompt: 'x', seconds: 7, fps: 40 }, FRAMEPACK)).toEqual({ frames: 280, fps: 40 })
  })

  it('FramePack clamps a runaway request to the 600-frame safety ceiling', () => {
    expect(resolveClip({ prompt: 'x', seconds: 60, fps: 40 }, FRAMEPACK).frames).toBe(600)
  })
})

// ── resolveI2VResolution: pick native res from source aspect (David 2026-06-11:
//    "I2V results are never what the source image showed" — portrait stills came
//    back as squished 768×448 landscape) ──
describe('resolveI2VResolution', () => {
  it('SVD square source → landscape 1024×576 (square is closer to landscape; center-crop fills it)', () => {
    expect(resolveI2VResolution('svd', 1024, 1024)).toEqual({ width: 1024, height: 576 })
  })

  it('SVD portrait source → portrait native 576×1024 (no more squish to landscape)', () => {
    expect(resolveI2VResolution('svd', 1024, 1536)).toEqual({ width: 576, height: 1024 })
  })

  it('SVD landscape source → landscape native 1024×576', () => {
    expect(resolveI2VResolution('svd', 1920, 1080)).toEqual({ width: 1024, height: 576 })
  })

  it('SVD unknown dimensions → safe landscape default', () => {
    expect(resolveI2VResolution('svd', 0, 0)).toEqual({ width: 1024, height: 576 })
  })

  it('FramePack keeps the source aspect, snapped to a 16-multiple under the 768 cap', () => {
    // 1024×1024 → scaled to 768×768 (cap), already 16-aligned.
    expect(resolveI2VResolution('framepack', 1024, 1024)).toEqual({ width: 768, height: 768 })
    // 1920×1080 → long edge 1920>768 → ×0.4 → 768×432 (both 16-aligned).
    expect(resolveI2VResolution('framepack', 1920, 1080)).toEqual({ width: 768, height: 432 })
  })

  it('FramePack small source is not upscaled past its size, just 16-snapped', () => {
    const r = resolveI2VResolution('framepack', 500, 500)
    expect(r.width % 16).toBe(0)
    expect(r.height % 16).toBe(0)
    expect(r.width).toBeLessThanOrEqual(512)
  })
})

// ── comfyErrorHint: actionable hints for cryptic ComfyUI node errors ──
describe('comfyErrorHint', () => {
  it('FramePack HyVideoModel error → points at the custom-node, not LU', () => {
    const h = comfyErrorHint('FramePackSampler', 'AttributeError', "'HyVideoModel' object has no attribute 'diffusion_model'")
    expect(h).toMatch(/FramePackWrapper/)
    expect(h).toMatch(/not in LU/i)
    expect(h).toMatch(/SVD|Wan 2\.2/)
  })

  it('OOM error → actionable VRAM advice', () => {
    expect(comfyErrorHint('KSampler', 'torch.OutOfMemoryError', 'Allocation on device')).toMatch(/GPU memory/i)
    expect(comfyErrorHint(undefined, undefined, 'CUDA out of memory')).toMatch(/GPU memory/i)
  })

  it('Windows pagefile too small (os error 1455) → virtual-memory advice, not an LU bug (#61)', () => {
    const h = comfyErrorHint('CLIPLoader', undefined, 'The paging file is too small for this operation to complete. (os error 1455)')
    expect(h).toMatch(/virtual memory|page file/i)
    expect(h).toMatch(/not an LU bug/i)
    // matches on the bare os-error code too, regardless of node
    expect(comfyErrorHint(undefined, undefined, 'os error 1455')).toMatch(/virtual memory/i)
  })

  it('unknown error → no hint (verbatim error stands alone)', () => {
    expect(comfyErrorHint('KSampler', 'ValueError', 'something weird')).toBe('')
  })

  it('does not false-positive the FramePack hint on an unrelated node', () => {
    expect(comfyErrorHint('KSampler', 'AttributeError', 'diffusion_model missing')).toBe('')
  })

  // Runde 12: an AMD card the ROCm wheels carry no kernels for. Everything
  // upstream succeeded, so the raw error reads like a broken install and sends
  // the user rebuilding the environment forever. The wheel choice holds back
  // the families it can name from the card's own name, but a Ryzen APU calls
  // itself "AMD Radeon(TM) Graphics" and tells us nothing, so this catches the
  // ones we cannot place.
  it('a HIP kernel that does not exist for this chip is explained, not dumped', () => {
    // the three error texts this failure actually produces
    for (const msg of [
      'HIP error: invalid device function',
      'hipErrorNoBinaryForGPU: Unable to find code object for all current devices!',
      'rocBLAS error: Cannot read TensileLibrary.dat: No such file or directory for GPU arch : gfx1031',
    ]) {
      const h = comfyErrorHint('KSampler', 'RuntimeError', msg)
      expect(h).toMatch(/no compute kernels/i)
      // it must talk the user OUT of the rebuild, which cannot help here
      expect(h).toMatch(/will not change this/i)
      // and give him something that does complete
      expect(h).toContain('Force CPU')
    }
  })

  it('NEGATIVE CONTROL: the kernel hint does not fire on ordinary GPU errors', () => {
    expect(comfyErrorHint('KSampler', 'RuntimeError', 'CUDA error: device-side assert triggered')).toBe('')
    expect(comfyErrorHint('KSampler', 'torch.OutOfMemoryError', 'HIP out of memory')).toMatch(/GPU memory/i)
  })
})

// ── helpers for the orchestrator tests ────────────────────────────

/** Program a completed history with one image output for a given promptId. */
function completedHistory() {
  return {
    status: { completed: true },
    outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
  }
}

// ── 2. cloud/remote SKIP path ─────────────────────────────────────

describe('vramHandoffGenerate — cloud/remote SKIP path', () => {
  it('cloud text model → never evicts, still generates', async () => {
    getActiveAgentModel.mockReturnValue({ name: 'gpt-4o', providerId: 'openai', remote: false })
    getImageModels.mockResolvedValue([{ name: 'sdxl.safetensors', type: 'sdxl', source: 'checkpoint' }])
    buildDynamicWorkflow.mockResolvedValue({ '9': { class_type: 'SaveImage' } })
    submitWorkflow.mockResolvedValue('pid-1')
    getHistory.mockResolvedValue(completedHistory())

    const out = await vramHandoffGenerate('image', { prompt: 'a cat' })

    expect(unloadModel).not.toHaveBeenCalled()
    expect(out).toContain('Image generated: out.png')
    expect(out).toContain('/view?filename=out.png')
  })

  it('remote Ollama base → never evicts (no LOCAL VRAM to free)', async () => {
    getActiveAgentModel.mockReturnValue({ name: 'llama3:8b', providerId: 'ollama', remote: true })
    getImageModels.mockResolvedValue([{ name: 'sdxl.safetensors', type: 'sdxl', source: 'checkpoint' }])
    buildDynamicWorkflow.mockResolvedValue({})
    submitWorkflow.mockResolvedValue('pid-1')
    getHistory.mockResolvedValue(completedHistory())

    await vramHandoffGenerate('image', { prompt: 'a dog' })
    expect(unloadModel).not.toHaveBeenCalled()
  })

  it('no image model installed → clear error, nothing unloaded', async () => {
    getActiveAgentModel.mockReturnValue({ name: 'llama3:8b', providerId: 'ollama', remote: false })
    getImageModels.mockResolvedValue([])

    const out = await vramHandoffGenerate('image', { prompt: 'x' })
    expect(out).toMatch(/no image model installed/i)
    expect(unloadModel).not.toHaveBeenCalled()
    expect(submitWorkflow).not.toHaveBeenCalled()
  })

  it('empty prompt → guard fires, nothing touched', async () => {
    const out = await vramHandoffGenerate('image', { prompt: '   ' })
    expect(out).toMatch(/No prompt provided/i)
    expect(getImageModels).not.toHaveBeenCalled()
    expect(unloadModel).not.toHaveBeenCalled()
  })
})

// ── 3. finally-ALWAYS-reloads invariant ───────────────────────────

describe('vramHandoffGenerate — finally always restores the text model', () => {
  it('reloads the evicted model even when submitWorkflow throws', async () => {
    // Local Ollama model that is resident with a big footprint on a small GPU →
    // decideUnload says unload. listRunningModels reports it resident, then gone.
    getActiveAgentModel.mockReturnValue({ name: 'qwen:14b', providerId: 'ollama', remote: false })
    getImageModels.mockResolvedValue([{ name: 'flux1-dev.safetensors', type: 'flux', source: 'diffusion_model' }])
    getSystemVRAM.mockResolvedValue(12)
    // /api/ps: first call (decision probe) shows the model resident w/ 9GB VRAM.
    // listRunningModels (capture-before-unload) shows it resident, then pollGone
    // sees it gone.
    localFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/ps')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen:14b', size_vram: 9 * GB }] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    listRunningModels
      .mockResolvedValueOnce(['qwen:14b']) // capture-before-unload
      .mockResolvedValueOnce([])           // pollGone: already gone
    submitWorkflow.mockRejectedValue(new Error('CUDA out of memory'))
    buildDynamicWorkflow.mockResolvedValue({})

    const out = await vramHandoffGenerate('image', { prompt: 'render this' })

    // It DID evict…
    expect(unloadModel).toHaveBeenCalledWith('qwen:14b')
    // …and the finally block DID restore it despite the throw…
    expect(loadModel).toHaveBeenCalledWith('qwen:14b')
    expect(freeMemory).toHaveBeenCalled()
    // …and the OOM is surfaced VERBATIM, not masked.
    expect(out).toContain('CUDA out of memory')
  })

  it('reloads is best-effort: a loadModel throw does not reject the call', async () => {
    getActiveAgentModel.mockReturnValue({ name: 'qwen:14b', providerId: 'ollama', remote: false })
    getImageModels.mockResolvedValue([{ name: 'flux1-dev.safetensors', type: 'flux', source: 'diffusion_model' }])
    getSystemVRAM.mockResolvedValue(12)
    localFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/ps')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen:14b', size_vram: 9 * GB }] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    listRunningModels.mockResolvedValueOnce(['qwen:14b']).mockResolvedValueOnce([])
    buildDynamicWorkflow.mockResolvedValue({})
    submitWorkflow.mockResolvedValue('pid-1')
    getHistory.mockResolvedValue(completedHistory())
    loadModel.mockRejectedValue(new Error('ollama busy'))

    // Must still resolve with the successful generation result.
    const out = await vramHandoffGenerate('image', { prompt: 'render this' })
    expect(out).toContain('Image generated: out.png')
    expect(loadModel).toHaveBeenCalledWith('qwen:14b')
  })

  it('auto-fits: local model that co-exists is NOT evicted', async () => {
    getActiveAgentModel.mockReturnValue({ name: 'llama3:8b', providerId: 'ollama', remote: false })
    getImageModels.mockResolvedValue([{ name: 'sd15.safetensors', type: 'sd15', source: 'checkpoint' }])
    getSystemVRAM.mockResolvedValue(24) // plenty
    localFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/ps')) {
        return new Response(JSON.stringify({ models: [{ name: 'llama3:8b', size_vram: 5 * GB }] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    buildDynamicWorkflow.mockResolvedValue({})
    submitWorkflow.mockResolvedValue('pid-1')
    getHistory.mockResolvedValue(completedHistory())

    await vramHandoffGenerate('image', { prompt: 'a fox' })
    // 5GB + ~4GB sd15 = 9GB < 24GB → fits → no eviction.
    expect(unloadModel).not.toHaveBeenCalled()
    // Bug C (David 2026-06-16): when nothing was evicted we now SKIP the ComfyUI
    // freeMemory in the finally so the checkpoint stays resident and the NEXT
    // generation reuses it warm instead of cold-loading every time. Nothing
    // evicted → no reload either.
    expect(freeMemory).not.toHaveBeenCalled()
    expect(loadModel).not.toHaveBeenCalled()
  })

  it("'never' mode: never evicts even when it would not fit", async () => {
    useSettingsStore.getState().updateSettings({ exclusiveVramMode: 'never' })
    getActiveAgentModel.mockReturnValue({ name: 'qwen:14b', providerId: 'ollama', remote: false })
    getImageModels.mockResolvedValue([{ name: 'flux1-dev.safetensors', type: 'flux', source: 'diffusion_model' }])
    getSystemVRAM.mockResolvedValue(8)
    localFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/ps')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen:14b', size_vram: 9 * GB }] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    buildDynamicWorkflow.mockResolvedValue({})
    submitWorkflow.mockResolvedValue('pid-1')
    getHistory.mockResolvedValue(completedHistory())

    await vramHandoffGenerate('image', { prompt: 'big render' })
    expect(unloadModel).not.toHaveBeenCalled()
  })
})

// ── 4. video path + start-ComfyUI ─────────────────────────────────

describe('vramHandoffGenerate — video path', () => {
  it('no video backend → clear error, nothing unloaded', async () => {
    getActiveAgentModel.mockReturnValue({ name: 'llama3:8b', providerId: 'ollama', remote: false })
    getVideoModels.mockResolvedValue([{ name: 'wan2.1.safetensors', type: 'wan', source: 'diffusion_model' }])
    detectVideoBackend.mockResolvedValue('none')

    const out = await vramHandoffGenerate('video', { prompt: 'a wave' })
    expect(out).toMatch(/no text-to-video model installed/i)
    expect(unloadModel).not.toHaveBeenCalled()
  })

  it('text-to-video does NOT pick an I2V-only model (SVD) → would mis-load as UNet', async () => {
    // Scenario 3c live: gemma omitted inputImage; T2V must skip the SVD
    // checkpoint and use the real T2V model, else ComfyUI rejects the workflow.
    getActiveAgentModel.mockReturnValue({ name: 'gpt-4o', providerId: 'openai', remote: false })
    getVideoModels.mockResolvedValue([
      { name: 'svd_xt_1_1.safetensors', type: 'svd', source: 'checkpoint' },
      { name: 'wan2.1_t2v.safetensors', type: 'wan', source: 'diffusion_model' },
    ])
    detectVideoBackend.mockResolvedValue('wan')
    buildTxt2VidWorkflow.mockResolvedValue({ '9': { class_type: 'VHS_VideoCombine' } })
    submitWorkflow.mockResolvedValue('vpid-2')
    getHistory.mockResolvedValue({ status: { completed: true }, outputs: { '9': { gifs: [{ filename: 'c.mp4', subfolder: '', type: 'output' }] } } })

    await vramHandoffGenerate('video', { prompt: 'a wave' })
    // The model handed to buildTxt2VidWorkflow must be the Wan one, never SVD.
    expect(buildTxt2VidWorkflow.mock.calls[0][0].model).toBe('wan2.1_t2v.safetensors')
  })

  it('builds a video workflow via buildTxt2VidWorkflow and returns the URL', async () => {
    getActiveAgentModel.mockReturnValue({ name: 'gpt-4o', providerId: 'openai', remote: false })
    getVideoModels.mockResolvedValue([{ name: 'wan2.1.safetensors', type: 'wan', source: 'diffusion_model' }])
    detectVideoBackend.mockResolvedValue('wan')
    buildTxt2VidWorkflow.mockResolvedValue({ '9': { class_type: 'VHS_VideoCombine' } })
    submitWorkflow.mockResolvedValue('vpid-1')
    getHistory.mockResolvedValue({
      status: { completed: true },
      outputs: { '9': { gifs: [{ filename: 'clip.mp4', subfolder: '', type: 'output' }] } },
    })

    const out = await vramHandoffGenerate('video', { prompt: 'a wave', frames: 81, fps: 16 })
    expect(buildTxt2VidWorkflow).toHaveBeenCalled()
    // Spec: video uses Wan backend; the backend arg is the 2nd param.
    expect(buildTxt2VidWorkflow.mock.calls[0][1]).toBe('wan')
    expect(out).toContain('Video generated: clip.mp4')
  })
})

// ── pollGone() timeout ────────────────────────────────────────────

describe('pollGone', () => {
  it('returns true immediately when the model is already gone', async () => {
    listRunningModels.mockResolvedValue(['other:model'])
    await expect(pollGone('qwen:14b', 15_000)).resolves.toBe(true)
  })

  it('times out (returns false) when the model never leaves VRAM', async () => {
    vi.useFakeTimers()
    try {
      // The model is ALWAYS still resident — eviction never lands.
      listRunningModels.mockResolvedValue(['qwen:14b'])
      const p = pollGone('qwen:14b', 3_000)
      // Drive the internal 750ms sleep loop past the 3s deadline.
      await vi.advanceTimersByTimeAsync(4_000)
      await expect(p).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns true once the model disappears mid-poll', async () => {
    vi.useFakeTimers()
    try {
      listRunningModels
        .mockResolvedValueOnce(['qwen:14b']) // still there at t=0
        .mockResolvedValueOnce(['qwen:14b']) // still there after 1st sleep
        .mockResolvedValue([])               // gone thereafter
      const p = pollGone('qwen:14b', 15_000)
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(p).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── 5. starts ComfyUI when not running ────────────────────────────

describe('vramHandoffGenerate — ComfyUI lifecycle', () => {
  it('calls start_comfyui when status reports not running, then proceeds', async () => {
    getActiveAgentModel.mockReturnValue({ name: 'gpt-4o', providerId: 'openai', remote: false })
    getImageModels.mockResolvedValue([{ name: 'sdxl.safetensors', type: 'sdxl', source: 'checkpoint' }])
    buildDynamicWorkflow.mockResolvedValue({})
    submitWorkflow.mockResolvedValue('pid-1')
    getHistory.mockResolvedValue(completedHistory())

    // First comfyui_status → not running, then running after start.
    let started = false
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_comfyui') { started = true; return {} }
      if (cmd === 'comfyui_status') return { running: started }
      return {}
    })

    const out = await vramHandoffGenerate('image', { prompt: 'a tree' })
    expect(backendCall).toHaveBeenCalledWith('start_comfyui')
    expect(out).toContain('Image generated: out.png')
  })
})

// ── Audit M1/M2 — cold start, Stop around the submit, dead ComfyUI ─────────

describe('vramHandoffGenerate — the chat lane can cold-start ComfyUI', () => {
  beforeEach(() => { __resetGenerationStateForTests() })

  it('starts ComfyUI BEFORE asking it which models are installed', async () => {
    // The regression: DECIDE queried the model list first, getCheckpoints throws
    // while ComfyUI is down, and the run died on "Could not query ComfyUI
    // models" — 250 lines above the cold start that would have fixed it. So
    // image_generate / video_generate from the chat were dead for everyone whose
    // ComfyUI was not already running, while the Create tab started it happily.
    getActiveAgentModel.mockReturnValue({ name: 'gpt-4o', providerId: 'openai', remote: false })
    let comfyRunning = false
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_comfyui') { comfyRunning = true; return {} }
      if (cmd === 'comfyui_status') return { running: comfyRunning }
      return {}
    })
    // The honest failure mode of a down ComfyUI.
    getImageModels.mockImplementation(async () => {
      if (!comfyRunning) throw new Error('fetch failed')
      return [{ name: 'sdxl.safetensors', type: 'sdxl', source: 'checkpoint' }]
    })
    buildDynamicWorkflow.mockResolvedValue({})
    submitWorkflow.mockResolvedValue('pid-cold')
    getHistory.mockResolvedValue(completedHistory())

    const out = await vramHandoffGenerate('image', { prompt: 'a tree' })

    expect(backendCall).toHaveBeenCalledWith('start_comfyui')
    expect(out).toContain('Image generated: out.png')
    expect(out).not.toMatch(/Could not query ComfyUI models/i)
  })

  it('the cold start sits BEFORE the model query and before any eviction', () => {
    // Order is the whole fix, and a 90 s cold-start poll is not something a unit
    // test can wait out — so the ordering itself is what is asserted, at the
    // three points that matter: ComfyUI is up, THEN we ask it what it has, and
    // only after that does anything get thrown out of VRAM.
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../vram-handoff.ts'),
      'utf8',
    )
    const ensureAt = src.indexOf('const comfyUp = await ensureComfyRunning()')
    const decideAt = src.indexOf('const models = await getImageModels()')
    const evictAt = src.indexOf('await unloadModel(textModel)')
    expect(ensureAt).toBeGreaterThan(0)
    expect(ensureAt).toBeLessThan(decideAt)
    expect(decideAt).toBeLessThan(evictAt)
    // And the failure is reported without having touched anything.
    expect(src).toContain("return 'Error: ComfyUI did not start within 90s.")
  })
})

describe('vramHandoffGenerate — Stop around the submit', () => {
  beforeEach(() => { __resetGenerationStateForTests() })

  it('a Stop during the workflow build never reaches /prompt', async () => {
    // buildDynamicWorkflow fetches /object_info and can hang for a long time
    // behind a proxy. runHandoff raced only the OVERALL promise, so the
    // abandoned one walked on and submitted the job the user just cancelled.
    getActiveAgentModel.mockReturnValue({ name: 'gpt-4o', providerId: 'openai', remote: false })
    getImageModels.mockResolvedValue([{ name: 'sdxl.safetensors', type: 'sdxl', source: 'checkpoint' }])
    submitWorkflow.mockResolvedValue('pid-never')
    let releaseBuild!: (v: unknown) => void
    buildDynamicWorkflow.mockReturnValue(new Promise((res) => { releaseBuild = res }))

    const genP = vramHandoffGenerate('image', { prompt: 'a cat' })
    await vi.waitFor(() => expect(buildDynamicWorkflow).toHaveBeenCalled())
    requestGenerationCancel()
    const out = await genP
    releaseBuild({})                       // the abandoned build finishes late
    await new Promise((r) => setTimeout(r, 20))

    expect(out).toMatch(/cancelled/i)
    expect(submitWorkflow).not.toHaveBeenCalled()
  })

  it('a Stop that lands WHILE /prompt is in flight takes the job straight back out', async () => {
    getActiveAgentModel.mockReturnValue({ name: 'gpt-4o', providerId: 'openai', remote: false })
    getImageModels.mockResolvedValue([{ name: 'sdxl.safetensors', type: 'sdxl', source: 'checkpoint' }])
    buildDynamicWorkflow.mockResolvedValue({})
    let releaseSubmit!: (v: string) => void
    submitWorkflow.mockReturnValue(new Promise<string>((res) => { releaseSubmit = res }))

    const genP = vramHandoffGenerate('image', { prompt: 'a cat' })
    await vi.waitFor(() => expect(submitWorkflow).toHaveBeenCalled())
    requestGenerationCancel()
    releaseSubmit('pid-raced')             // ComfyUI accepted it a moment later
    const out = await genP
    await vi.waitFor(() => expect(abandonPrompt).toHaveBeenCalledWith('pid-raced'))

    expect(out).toMatch(/cancelled/i)
    expect(getHistory).not.toHaveBeenCalled()
  })
})

describe('pollAndExtract — a dead ComfyUI ends the wait, with the reason', () => {
  beforeEach(() => { __resetGenerationStateForTests() })

  it('stops on a ComfyUI that died mid-render instead of parking for the whole budget', async () => {
    // getHistory swallows every transport error into `null`, which is also what
    // a healthy queued render returns — so a crashed ComfyUI was invisible and
    // the chat agent sat here for the full 5/10-minute budget with the text
    // model evicted from VRAM, unable to answer anything.
    getActiveAgentModel.mockReturnValue({ name: 'gpt-4o', providerId: 'openai', remote: false })
    getImageModels.mockResolvedValue([{ name: 'sdxl.safetensors', type: 'sdxl', source: 'checkpoint' }])
    buildDynamicWorkflow.mockResolvedValue({})
    submitWorkflow.mockResolvedValue('pid-dead')
    getHistory.mockResolvedValue(null)     // exactly what a dead server looks like
    checkComfyConnection.mockResolvedValue(false)

    const out = await vramHandoffGenerate('image', { prompt: 'a cat' })

    expect(out).toMatch(/ComfyUI stopped responding/i)
    expect(out).toMatch(/Create tab/)
  }, 20_000)

  it('NEGATIVE CONTROL: one flaky probe during a heavy sampler step kills nothing', async () => {
    getActiveAgentModel.mockReturnValue({ name: 'gpt-4o', providerId: 'openai', remote: false })
    getImageModels.mockResolvedValue([{ name: 'sdxl.safetensors', type: 'sdxl', source: 'checkpoint' }])
    buildDynamicWorkflow.mockResolvedValue({})
    submitWorkflow.mockResolvedValue('pid-flaky')
    checkComfyConnection.mockResolvedValueOnce(false).mockResolvedValue(true)
    getHistory.mockResolvedValueOnce(null).mockResolvedValue(completedHistory())

    const out = await vramHandoffGenerate('image', { prompt: 'a cat' })

    expect(out).toContain('Image generated: out.png')
  }, 20_000)
})

describe('resolveModelName — fuzzy model match (David 2026-06-04: "FramePack" must be enough)', () => {
  const installed = [
    { name: 'FramePackI2V_HY_fp8_e4m3fn.safetensors' },
    { name: 'svd_xt_1_1.safetensors' },
    { name: 'wan2.1_t2v_1.3B_bf16.safetensors' },
    { name: 'sd_xl_base_1.0.safetensors' },
  ]
  it('resolves a casual "FramePack" to the exact installed filename', () => {
    expect(resolveModelName('FramePack', installed)).toBe('FramePackI2V_HY_fp8_e4m3fn.safetensors')
  })
  it('resolves case-insensitively ("framepack")', () => {
    expect(resolveModelName('framepack', installed)).toBe('FramePackI2V_HY_fp8_e4m3fn.safetensors')
  })
  it('resolves "SVD" → svd_xt_1_1', () => {
    expect(resolveModelName('SVD', installed)).toBe('svd_xt_1_1.safetensors')
  })
  it('resolves "wan" → the wan t2v model', () => {
    expect(resolveModelName('wan', installed)).toBe('wan2.1_t2v_1.3B_bf16.safetensors')
  })
  it('resolves an exact filename unchanged', () => {
    expect(resolveModelName('svd_xt_1_1.safetensors', installed)).toBe('svd_xt_1_1.safetensors')
  })
  it('resolves "sdxl" via substring to the SDXL base', () => {
    expect(resolveModelName('sdxl', installed)).toBe('sd_xl_base_1.0.safetensors')
  })
  it('returns null when nothing matches (caller reports it, no silent wrong model)', () => {
    expect(resolveModelName('totally-unknown-xyz', installed)).toBeNull()
  })
  it('returns null for an empty installed list', () => {
    expect(resolveModelName('FramePack', [])).toBeNull()
  })
})

// ── Stop / cancel: epoch + active-handoffs gating (fb28854 review fixes) ──
//
// Three things this guards, all from the 2026-06-22 self-review:
//   - PLAIN-chat Stop (no media gen running) must NOT /interrupt + clear the
//     ENTIRE ComfyUI queue — that would kill an unrelated Create-tab render or
//     another client's job. Gated by _activeHandoffs.
//   - That gate must NOT leak: a gen that early-returns in the DECIDE phase
//     ("no model installed", "model not found", ComfyUI unreachable) used to
//     increment _activeHandoffs and never decrement it, so a LATER plain Stop
//     wrongly nuked ComfyUI. (The increment now lives in the generate try.)
//   - BACK-TO-BACK Stop: a 2nd gen queued behind the 1st on the in-flight mutex
//     must be cancelled by one Stop (cancel epoch), never reaching submit.
describe('vramHandoffGenerate — Stop / cancel gating', () => {
  beforeEach(() => {
    __resetGenerationStateForTests()
  })

  it('plain-chat Stop with NO media generation in flight is a no-op against ComfyUI', () => {
    requestGenerationCancel()
    expect(abandonPrompt).not.toHaveBeenCalled()
    expect(cancelGeneration).not.toHaveBeenCalled()
    expect(clearComfyQueue).not.toHaveBeenCalled()
  })

  it('a Stop AFTER a gen that failed in the DECIDE phase still does NOT touch ComfyUI (no _activeHandoffs leak)', async () => {
    // "no image model installed" returns inside the DECIDE try, before anything
    // is submitted. The active-handoffs counter must be back at 0, so a later
    // plain Stop is a no-op. (Regression guard: the increment used to sit in the
    // DECIDE try, so this early-return leaked it to 1.)
    getActiveAgentModel.mockReturnValue({ name: 'llama3:8b', providerId: 'ollama', remote: false })
    getImageModels.mockResolvedValue([])
    const out = await vramHandoffGenerate('image', { prompt: 'x' })
    expect(out).toMatch(/no image model installed/i)

    requestGenerationCancel()
    expect(abandonPrompt).not.toHaveBeenCalled()
    expect(cancelGeneration).not.toHaveBeenCalled()
    expect(clearComfyQueue).not.toHaveBeenCalled()
  })

  it('a Stop while a media gen IS in flight removes OUR job, and only ours', async () => {
    // Audit M1: this used to assert /interrupt + a full `clear: true` on the
    // queue. Both are indiscriminate — the interrupt kills whatever is
    // executing (ours only when ours is at the front) and the clear drops the
    // Create tab's render and every job an external ComfyUI tab on the same
    // server has queued. A chat-lane Stop may remove exactly one thing: the
    // prompt this lane submitted.
    getActiveAgentModel.mockReturnValue({ name: 'gpt-4o', providerId: 'openai', remote: false })
    getImageModels.mockResolvedValue([{ name: 'sdxl.safetensors', type: 'sdxl', source: 'checkpoint' }])
    buildDynamicWorkflow.mockResolvedValue({})
    submitWorkflow.mockResolvedValue('pid-stop')
    // Never completes → the gen sits in the poll loop (active) when we Stop.
    getHistory.mockResolvedValue({ status: { completed: false } })

    const genP = vramHandoffGenerate('image', { prompt: 'a cat' })
    await vi.waitFor(() => expect(submitWorkflow).toHaveBeenCalled())
    requestGenerationCancel()
    const out = await genP

    expect(abandonPrompt).toHaveBeenCalledWith('pid-stop')
    expect(clearComfyQueue).not.toHaveBeenCalled()
    expect(cancelGeneration).not.toHaveBeenCalled()
    expect(out).toMatch(/cancelled/i)
  })

  it('back-to-back: one Stop cancels BOTH the running gen and a 2nd queued behind it (epoch), 2nd never submits', async () => {
    getActiveAgentModel.mockReturnValue({ name: 'gpt-4o', providerId: 'openai', remote: false })
    getImageModels.mockResolvedValue([{ name: 'sdxl.safetensors', type: 'sdxl', source: 'checkpoint' }])
    buildDynamicWorkflow.mockResolvedValue({})
    submitWorkflow.mockResolvedValue('pid-1')
    getHistory.mockResolvedValue({ status: { completed: false } }) // gen #1 sits polling

    const g1 = vramHandoffGenerate('image', { prompt: 'first' })   // seq 1
    const g2 = vramHandoffGenerate('image', { prompt: 'second' })  // seq 2, parks on g1
    // Only gen #1 should have reached submit so far.
    await vi.waitFor(() => expect(submitWorkflow).toHaveBeenCalledTimes(1))

    requestGenerationCancel() // _cancelledThrough = 2 → cancels #1 (running) AND #2 (queued)
    const [o1, o2] = await Promise.all([g1, g2])

    expect(o1).toMatch(/cancelled/i)
    expect(o2).toMatch(/cancelled/i)
    // The key regression assertion: gen #2 bailed at the epoch check on dequeue
    // and never submitted a second workflow.
    expect(submitWorkflow).toHaveBeenCalledTimes(1)
  })
})

// ── Per-model auto-settings (David 2026-06-22: "setze die settings für jedes
//    image+video modell"). Two layers: resolveTunables must honor the MODEL
//    default over ComfyUI's generic KSampler caps default (20 steps / cfg 8.0),
//    and the chat-gen IMAGE path must use per-architecture defaults (Flux cfg 1,
//    SDXL cfg 7 / dpmpp_2m) instead of one hardcoded cfg 7 for everything. ──
describe('resolveTunables — honors the model default over the generic caps default', () => {
  const caps = {
    cfgRange: { default: 8.0, min: 0, max: 100 },
    stepsRange: { default: 20, min: 1, max: 200 },
    usesKSampler: true,
    availableSamplers: ['euler', 'dpmpp_2m'],
    availableSchedulers: ['normal', 'karras'],
  } as any

  it('no user value + caps present → MODEL default (Wan 30/6.0), NOT the generic caps 20/8.0', () => {
    const t = resolveTunables({ prompt: 'x' } as any, caps, { steps: 30, cfg: 6.0, sampler: 'euler', scheduler: 'normal' })
    expect(t.cfg).toBe(6.0)
    expect(t.steps).toBe(30)
    expect(t.reject).toBeNull()
  })

  it('explicit in-range user value still applies', () => {
    const t = resolveTunables({ prompt: 'x', cfg: 4, steps: 40 } as any, caps, { steps: 30, cfg: 6.0, sampler: 'euler', scheduler: 'normal' })
    expect(t.cfg).toBe(4)
    expect(t.steps).toBe(40)
    expect(t.reject).toBeNull()
  })

  it('explicit OUT-of-range user value is still rejected against the caps range', () => {
    const tight = { ...caps, stepsRange: { default: 20, min: 1, max: 30 } }
    const t = resolveTunables({ prompt: 'x', steps: 999 } as any, tight, { steps: 30, cfg: 6.0, sampler: 'euler', scheduler: 'normal' })
    expect(t.reject).toMatch(/steps/i)
  })
})

describe('chat-gen image path — per-architecture defaults (not one hardcoded cfg 7)', () => {
  beforeEach(() => { getActiveAgentModel.mockReturnValue({ name: 'gpt-4o', providerId: 'openai', remote: false }) })

  it('Flux → cfg 1.0 (distilled; cfg 7 fries it)', async () => {
    getImageModels.mockResolvedValue([{ name: 'flux1-dev.safetensors', type: 'flux', source: 'diffusion_model' }])
    buildDynamicWorkflow.mockResolvedValue({})
    submitWorkflow.mockResolvedValue('pid-1')
    getHistory.mockResolvedValue(completedHistory())
    await vramHandoffGenerate('image', { prompt: 'a cat' })
    expect(buildDynamicWorkflow.mock.calls[0][0].cfgScale).toBe(1.0)
  })

  it('SDXL → cfg 7.0 + dpmpp_2m / 1024 (architecture-appropriate)', async () => {
    getImageModels.mockResolvedValue([{ name: 'Juggernaut-XL_v9.safetensors', type: 'sdxl', source: 'checkpoint' }])
    buildDynamicWorkflow.mockResolvedValue({})
    submitWorkflow.mockResolvedValue('pid-1')
    getHistory.mockResolvedValue(completedHistory())
    await vramHandoffGenerate('image', { prompt: 'a fox' })
    const p = buildDynamicWorkflow.mock.calls[0][0]
    expect(p.cfgScale).toBe(7.0)
    expect(p.sampler).toBe('dpmpp_2m')
    expect(p.width).toBe(1024)
  })

  it('SD1.5 → defaults to 512², not 1024²', async () => {
    getImageModels.mockResolvedValue([{ name: 'sd15.safetensors', type: 'sd15', source: 'checkpoint' }])
    buildDynamicWorkflow.mockResolvedValue({})
    submitWorkflow.mockResolvedValue('pid-1')
    getHistory.mockResolvedValue(completedHistory())
    await vramHandoffGenerate('image', { prompt: 'a tree' })
    expect(buildDynamicWorkflow.mock.calls[0][0].width).toBe(512)
  })
})
