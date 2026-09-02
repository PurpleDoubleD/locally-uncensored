/**
 * Regression guard for the chat-agent MCP image/video hand-off hang (2026-06-03).
 *
 * ROOT CAUSE: every ComfyUI control-plane fetch (/object_info, /prompt,
 * /history, /free, /system_stats, /object_info/<Node>) went through localFetch
 * WITHOUT a `timeoutMs`, so each inherited the Rust proxy's 300 s default. One
 * wedged control call (e.g. /object_info right after a ComfyUI restart, or a
 * /prompt that never returns) froze the whole VRAM hand-off for minutes with
 * the text model left unloaded — the agent looked permanently stuck.
 *
 * These tests pin the contract: each control-plane call MUST pass a bounded,
 * finite `timeoutMs`. They DON'T prove the real network behaviour (mocked
 * localFetch) — they prove the timeout is actually plumbed through, so a future
 * refactor can't silently drop it and reintroduce the infinite hang.
 *
 * Run: npx vitest run src/api/__tests__/comfyui-timeouts.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const localFetch = vi.fn()

vi.mock('../backend', () => ({
  localFetch: (...a: unknown[]) => localFetch(...a),
  comfyuiUrl: (p: string) => `http://localhost:8188${p}`,
  isMacOS: () => false,
}))

import {
  submitWorkflow,
  getHistory,
  getCheckpoints,
  getDiffusionModels,
  getVAEModels,
  freeMemory,
  cancelGeneration,
  getSystemVRAM,
} from '../comfyui'
import { getAllNodeInfo, clearNodeCache } from '../comfyui-nodes'

/** Build a 200 Response with a JSON body shaped for whichever endpoint is hit. */
function respondFor(url: string): Response {
  if (url.endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'p1' }), { status: 200 })
  if (url.includes('/history/')) return new Response(JSON.stringify({ p1: { status: { completed: true } } }), { status: 200 })
  if (url.endsWith('/object_info/CheckpointLoaderSimple')) {
    return new Response(JSON.stringify({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors']] } } } }), { status: 200 })
  }
  if (url.endsWith('/object_info/UNETLoader')) {
    return new Response(JSON.stringify({ UNETLoader: { input: { required: { unet_name: [['u.safetensors']] } } } }), { status: 200 })
  }
  if (url.endsWith('/object_info/VAELoader')) {
    return new Response(JSON.stringify({ VAELoader: { input: { required: { vae_name: [['v.safetensors']] } } } }), { status: 200 })
  }
  if (url.endsWith('/object_info')) return new Response(JSON.stringify({ KSampler: { input: { required: {} }, output: [] } }), { status: 200 })
  if (url.endsWith('/system_stats')) return new Response(JSON.stringify({ devices: [{ vram_total: 12 * 1024 * 1024 * 1024 }] }), { status: 200 })
  // /free, /interrupt, fallback
  return new Response('{}', { status: 200 })
}

beforeEach(() => {
  localFetch.mockReset()
  localFetch.mockImplementation(async (url: string) => respondFor(url))
  clearNodeCache()
})

/** Pull the options object from the localFetch call whose URL matches `frag`. */
function optsForUrl(frag: string): Record<string, unknown> | undefined {
  const call = localFetch.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string).includes(frag))
  return call?.[1] as Record<string, unknown> | undefined
}

function expectBoundedTimeout(frag: string, max = 60_000) {
  const opts = optsForUrl(frag)
  expect(opts, `localFetch for "${frag}" must receive an options object`).toBeTruthy()
  const t = opts!.timeoutMs
  expect(typeof t, `"${frag}" must pass a numeric timeoutMs`).toBe('number')
  expect(Number.isFinite(t as number)).toBe(true)
  expect(t as number).toBeGreaterThan(0)
  // A control-plane call must never get a multi-minute budget — that is exactly
  // the proxy default that caused the hang.
  expect(t as number).toBeLessThanOrEqual(max)
}

describe('ComfyUI control-plane fetches are timeout-bounded (chat-agent hang regression)', () => {
  it('submitWorkflow (POST /prompt) passes a bounded timeoutMs', async () => {
    await submitWorkflow({ '1': { class_type: 'SaveImage', inputs: {} } })
    expectBoundedTimeout('/prompt')
  })

  it('getHistory (GET /history/<id>) passes a bounded timeoutMs', async () => {
    await getHistory('p1')
    expectBoundedTimeout('/history/')
  })

  it('getCheckpoints (/object_info/CheckpointLoaderSimple) passes a bounded timeoutMs', async () => {
    await getCheckpoints()
    expectBoundedTimeout('/object_info/CheckpointLoaderSimple')
  })

  it('getDiffusionModels (/object_info/UNETLoader) passes a bounded timeoutMs', async () => {
    await getDiffusionModels()
    expectBoundedTimeout('/object_info/UNETLoader')
  })

  it('getVAEModels (/object_info/VAELoader) passes a bounded timeoutMs', async () => {
    await getVAEModels()
    expectBoundedTimeout('/object_info/VAELoader')
  })

  it('freeMemory (POST /free) passes a bounded timeoutMs (runs in the finally → must not stall the reload)', async () => {
    await freeMemory()
    expectBoundedTimeout('/free')
  })

  it('cancelGeneration (POST /interrupt) passes a bounded timeoutMs', async () => {
    await cancelGeneration()
    expectBoundedTimeout('/interrupt')
  })

  it('getSystemVRAM (/system_stats) passes a bounded timeoutMs', async () => {
    await getSystemVRAM()
    expectBoundedTimeout('/system_stats')
  })

  it('getAllNodeInfo (full /object_info — the heaviest call, hit first by buildDynamicWorkflow) passes a bounded timeoutMs', async () => {
    await getAllNodeInfo(true)
    expectBoundedTimeout('/object_info')
  })
})
