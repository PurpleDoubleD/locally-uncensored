/**
 * R14 Nebenbefund 1 (2026-08-30, ergebnis-r14-nachmessung.md): every image
 * generation evicted the chat engine, including generations on a ComfyUI that
 * LU had started with `--cpu`.
 *
 * Measured on the Windows box, Force CPU run: engine PID 4420 was alive before
 * the render, PID 16896 after it, started 20:19:32, the moment the CPU render
 * ended. ComfyUI's command line was
 * `main.py --listen 127.0.0.1 --port 8188 --enable-cors-header * --cpu`,
 * so nothing on the card was freed and nothing on the card was needed. The
 * user paid a full cold reload of his chat model for a picture the processor
 * rendered.
 *
 * Both hand-off paths get the same guard: the agent path in runHandoff and the
 * Create tab path in evictBody. The GPU case is the negative control in every
 * test below and must behave exactly as it did before.
 *
 * Run: npx vitest run src/api/__tests__/cpu-comfy-keeps-the-chat-engine.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const localFetch = vi.fn()
const listRunningModels = vi.fn()
const loadModel = vi.fn()
const unloadModel = vi.fn()
const getImageModels = vi.fn()
const getSystemVRAM = vi.fn()
const submitWorkflow = vi.fn()
const getHistory = vi.fn()
const freeMemory = vi.fn()
const buildDynamicWorkflow = vi.fn()
const backendCall = vi.fn()
const getActiveAgentModel = vi.fn()
let isOllamaLocalReturn = true

vi.mock('../backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...a),
  localFetch: (...a: unknown[]) => localFetch(...a),
  ollamaUrl: (p: string) => `http://localhost:11434/api${p.startsWith('/') ? p : '/' + p}`,
  comfyuiUrl: (p: string) => `http://localhost:8188${p}`,
  isOllamaLocal: () => isOllamaLocalReturn,
  isWindows: () => true,
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
    getSystemVRAM: (...a: unknown[]) => getSystemVRAM(...a),
    submitWorkflow: (...a: unknown[]) => submitWorkflow(...a),
    getHistory: (...a: unknown[]) => getHistory(...a),
    freeMemory: (...a: unknown[]) => freeMemory(...a),
  }
})

vi.mock('../dynamic-workflow', () => ({
  buildDynamicWorkflow: (...a: unknown[]) => buildDynamicWorkflow(...a),
}))

vi.mock('../agent-context', () => ({
  getActiveAgentModel: () => getActiveAgentModel(),
}))

vi.mock('../comfyui-ws', () => ({
  comfyWS: { on: () => () => {}, connect: () => Promise.resolve(), connected: false },
  CLIENT_ID: 'lu-test-client',
}))

import {
  vramHandoffGenerate,
  evictChatBackendsForRender,
  __resetGenerationStateForTests,
  __resetRenderJuggleForTests,
} from '../vram-handoff'
import { comfyHoldsNoVram } from '../../lib/comfy-device'
import { useSettingsStore } from '../../stores/settingsStore'

const GB = 1024 * 1024 * 1024

/** What `get_comfy_gpu_status` answers in this test run. */
let gpuStatus: { startedCpu: boolean; mode: string; hasAmd: boolean } = {
  startedCpu: false,
  mode: 'auto',
  hasAmd: false,
}

/** The box's layout: built-in engine up with a GGUF, one Ollama model resident. */
function mockBackends() {
  backendCall.mockImplementation(async (cmd: unknown, args?: unknown) => {
    if (cmd === 'get_comfy_gpu_status') return gpuStatus
    if (cmd === 'bundled_engine_status') {
      return { running: true, port: 8127, model_path: 'C:/models/qwen3-8b.gguf', modelBytes: 5 * GB }
    }
    if (cmd === 'kv_slot_action') {
      const a = args as { action?: string } | undefined
      return a?.action === 'save' ? { ok: true } : { ok: true }
    }
    if (cmd === 'lmstudio_list_loaded') return { loaded: [] }
    if (cmd === 'comfyui_status') return { running: true }
    return {}
  })
}

function completedHistory() {
  return {
    status: { completed: true },
    outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
  }
}

const callsTo = (cmd: string) => backendCall.mock.calls.filter((c) => c[0] === cmd)

beforeEach(() => {
  for (const m of [localFetch, listRunningModels, loadModel, unloadModel, getImageModels, getSystemVRAM, submitWorkflow, getHistory, freeMemory, buildDynamicWorkflow, backendCall, getActiveAgentModel]) m.mockReset()
  __resetGenerationStateForTests()
  __resetRenderJuggleForTests()
  isOllamaLocalReturn = true
  gpuStatus = { startedCpu: false, mode: 'auto', hasAmd: false }
  loadModel.mockResolvedValue(undefined)
  unloadModel.mockResolvedValue(undefined)
  freeMemory.mockResolvedValue(undefined)
  getActiveAgentModel.mockReturnValue({ name: 'qwen:14b', providerId: 'ollama', remote: false })
  // A model with a KNOWN footprint, so the fits-or-not math really says
  // "evict" and the CPU guard is the only thing that can stop it.
  getImageModels.mockResolvedValue([{ name: 'flux1-dev.safetensors', type: 'flux', source: 'diffusion_model' }])
  getSystemVRAM.mockResolvedValue(12)
  buildDynamicWorkflow.mockResolvedValue({ '9': { class_type: 'SaveImage' } })
  submitWorkflow.mockResolvedValue('pid-1')
  getHistory.mockResolvedValue(completedHistory())
  // /api/ps: the 14 B chat model sits in 9 GB of VRAM on a 12 GB card, so the
  // fits-or-not math says evict whenever it is asked.
  localFetch.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/api/ps')) {
      return new Response(JSON.stringify({ models: [{ name: 'qwen:14b', size_vram: 9 * GB }] }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
  listRunningModels.mockResolvedValueOnce(['qwen:14b']).mockResolvedValue([])
  mockBackends()
  useSettingsStore.getState().updateSettings({ exclusiveVramMode: 'auto' })
})

// ── The rule itself ───────────────────────────────────────────────

describe('comfyHoldsNoVram', () => {
  it('a --cpu start LU performed is proof, whichever pick led to it', () => {
    expect(comfyHoldsNoVram({ startedCpu: true, mode: 'cpu' })).toBe(true)
    // Auto that fell back to the processor holds no VRAM either.
    expect(comfyHoldsNoVram({ startedCpu: true, mode: 'auto' })).toBe(true)
  })

  it('NEGATIVE: a pick without a restart is NOT proof, and neither is nothing', () => {
    // Force CPU chosen, ComfyUI not restarted: that server is still on the
    // card, and skipping the hand-off here is the OOM this all exists to stop.
    expect(comfyHoldsNoVram({ startedCpu: false, mode: 'cpu' })).toBe(false)
    expect(comfyHoldsNoVram({ startedCpu: false, mode: 'auto' })).toBe(false)
    expect(comfyHoldsNoVram({ startedCpu: false, mode: 'gpu' })).toBe(false)
    expect(comfyHoldsNoVram(null)).toBe(false)
    expect(comfyHoldsNoVram(undefined)).toBe(false)
  })
})

// ── Agent path (chat tool) ────────────────────────────────────────

describe('vramHandoffGenerate on a CPU ComfyUI', () => {
  it('leaves the chat engine alone and still renders', async () => {
    gpuStatus = { startedCpu: true, mode: 'cpu', hasAmd: false }

    const out = await vramHandoffGenerate('image', { prompt: 'a small red cube' })

    expect(out).toContain('Image generated: out.png')
    // Nothing was evicted, so nothing has to be reloaded afterwards.
    expect(unloadModel).not.toHaveBeenCalled()
    expect(loadModel).not.toHaveBeenCalled()
    expect(callsTo('stop_bundled_engine')).toHaveLength(0)
    expect(callsTo('kv_slot_action')).toHaveLength(0)
  })

  it('NEGATIVE: on the card the hand-off runs exactly as before', async () => {
    gpuStatus = { startedCpu: false, mode: 'auto', hasAmd: false }

    const out = await vramHandoffGenerate('image', { prompt: 'a small red cube' })

    expect(out).toContain('Image generated: out.png')
    expect(unloadModel).toHaveBeenCalledWith('qwen:14b')
    expect(loadModel).toHaveBeenCalledWith('qwen:14b')
    expect(callsTo('stop_bundled_engine')).toHaveLength(1)
  })

  it('NEGATIVE: Force CPU picked but ComfyUI never restarted still hands over', async () => {
    // The user's pick alone says nothing about the server that is running.
    gpuStatus = { startedCpu: false, mode: 'cpu', hasAmd: false }

    await vramHandoffGenerate('image', { prompt: 'a small red cube' })

    expect(unloadModel).toHaveBeenCalledWith('qwen:14b')
    expect(callsTo('stop_bundled_engine')).toHaveLength(1)
  })
})

// ── Create tab path ───────────────────────────────────────────────

describe('evictChatBackendsForRender on a CPU ComfyUI', () => {
  it('evicts nothing, so there is nothing to restore', async () => {
    gpuStatus = { startedCpu: true, mode: 'cpu', hasAmd: false }

    const haul = await evictChatBackendsForRender()

    expect(haul).toEqual({ ollamaModel: null, lms: null, bundled: null })
    expect(callsTo('offload_local_models')).toHaveLength(0)
    expect(callsTo('lmstudio_unload_model')).toHaveLength(0)
    expect(callsTo('kv_slot_action')).toHaveLength(0)
  })

  it('NEGATIVE: on the card the eviction pair fires exactly as before', async () => {
    gpuStatus = { startedCpu: false, mode: 'auto', hasAmd: false }

    const haul = await evictChatBackendsForRender()

    expect(haul.ollamaModel).toBe('qwen:14b')
    expect(haul.bundled?.modelPath).toBe('C:/models/qwen3-8b.gguf')
    expect(callsTo('offload_local_models')[0][1]).toEqual({ includeComfyui: false })
    expect(callsTo('lmstudio_unload_model')).toHaveLength(1)
  })
})
