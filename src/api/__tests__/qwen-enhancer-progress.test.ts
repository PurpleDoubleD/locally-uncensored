/**
 * B41 (3.0.9): Discord mneme1761, 29.10.2026. "Improve my prompt" with the
 * local Qwen enhancer on Qwen-Image 2.1 Edit stood on "Improving your
 * prompt…" for more than 530 s, without it the edit took 40 s.
 *
 * Three things the run did not do:
 *   - free the card BEFORE the enhancer: the edit model of the previous run
 *     stayed warm in ComfyUI (vram-handoff keeps it on purpose), and the 9 GB
 *     enhancer loaded next to it;
 *   - say anything but the seconds, although ComfyUI reports every token;
 *   - end a job that went silent before the 15 minute limit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComfyWSEvent } from '../comfyui-ws'

const comfy = vi.hoisted(() => ({
  log: [] as string[],
  history: [] as unknown[],
  listeners: new Set<(ev: ComfyWSEvent) => void>(),
  connected: true,
}))
vi.mock('../comfyui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../comfyui')>()),
  submitWorkflow: vi.fn(async () => { comfy.log.push('submit'); return 'pe-7' }),
  getHistory: vi.fn(async () => (comfy.history.length > 1 ? comfy.history.shift() : comfy.history[0]) ?? null),
  freeMemory: vi.fn(async () => { comfy.log.push('free') }),
  abandonPrompt: vi.fn(async (id: string) => { comfy.log.push(`abandon:${id}`) }),
}))
vi.mock('../comfyui-ws', () => ({
  comfyWS: {
    get connected() { return comfy.connected },
    connect: vi.fn(async () => {}),
    mark: () => 0,
    on: (l: (ev: ComfyWSEvent) => void) => { comfy.listeners.add(l); return () => comfy.listeners.delete(l) },
  },
}))

import { runQwenEnhancer, QWEN_ENHANCER_TIMEOUT_MS, type EnhancerProgress } from '../qwen-enhancer'
import { enhancerLine } from '../../lib/render/qwen-enhancer'

const send = (ev: ComfyWSEvent) => { for (const l of comfy.listeners) l(ev) }
const graph = { '1': { class_type: 'CLIPLoader', inputs: {} } }
const done = { status: { status_str: 'success' }, outputs: { '9': { text: ['A red fox in deep snow, soft morning light.'] } } }

beforeEach(() => {
  vi.useFakeTimers()
  comfy.log.length = 0
  comfy.history.length = 0
  comfy.listeners.clear()
  comfy.connected = true
})
afterEach(() => { vi.useRealTimers() })

describe('the card is handed over before the enhancer', () => {
  it('frees ComfyUI first, then submits, then frees again', async () => {
    comfy.history.push(done)
    const out = await runQwenEnhancer(graph, 'a fox')
    expect(out.status).toBe('improved')
    expect(comfy.log).toEqual(['free', 'submit', 'free'])
  })
})

describe('the line says where the enhancer is', () => {
  it('loading, reading, then tokens and their rate, from the job\'s own events only', async () => {
    comfy.history.push(null)
    const seen: EnhancerProgress[] = []
    const run = runQwenEnhancer(graph, 'a fox', { onProgress: (p) => seen.push(p) })
    await vi.advanceTimersByTimeAsync(0)
    send({ type: 'executing', data: { node: '1', prompt_id: 'pe-7' } })
    send({ type: 'executing', data: { node: '4', prompt_id: 'pe-7' } })
    send({ type: 'progress', data: { value: 1, max: 4096, prompt_id: 'pe-7' } })
    // Someone else's job says nothing here.
    send({ type: 'progress', data: { value: 999, max: 4096, prompt_id: 'other' } })
    await vi.advanceTimersByTimeAsync(10_000)
    send({ type: 'progress', data: { value: 11, max: 4096, prompt_id: 'pe-7' } })
    comfy.history.length = 0
    comfy.history.push(done)
    await vi.advanceTimersByTimeAsync(2_000)
    await run
    expect(seen.map((p) => p.phase)).toEqual(['queued', 'loading', 'reading', 'writing', 'writing'])
    expect(seen[3]).toEqual({ phase: 'writing', tokens: 1, max: 4096, tokensPerSecond: null })
    expect(seen[4]).toEqual({ phase: 'writing', tokens: 11, max: 4096, tokensPerSecond: 1 })
  })

  it('the words: phase, tokens, rate, and the limit when it crawls', () => {
    expect(enhancerLine({ phase: 'loading' }, 'i2i', 8)).toBe('Improving your prompt: loading the prompt enhancer…')
    expect(enhancerLine({ phase: 'reading' }, 'i2i', 8)).toContain('reads your prompt and pictures')
    expect(enhancerLine({ phase: 'writing', tokens: 320, max: 4096, tokensPerSecond: 14.2 }, 't2i', 8))
      .toBe('Improving your prompt: 320 of up to 4096 tokens, 14 tokens/s…')
    const slow = enhancerLine({ phase: 'writing', tokens: 40, max: 4096, tokensPerSecond: 0.84 }, 'i2i', 8)
    expect(slow).toContain('0.8 tokens/s')
    expect(slow).toContain('gives up after 8 min and uses your own prompt')
  })
})

describe('a job that hangs ends', () => {
  it('silence after the job has spoken ends it at the stall limit, long before the time limit', async () => {
    comfy.history.push(null)
    const run = runQwenEnhancer(graph, 'a fox', { stallMs: 60_000 })
    await vi.advanceTimersByTimeAsync(0)
    send({ type: 'executing', data: { node: '4', prompt_id: 'pe-7' } })
    await vi.advanceTimersByTimeAsync(65_000)
    await expect(run).resolves.toEqual({ status: 'failed' })
    expect(comfy.log).toEqual(['free', 'submit', 'abandon:pe-7', 'free'])
  })

  it('without the progress stream only the time limit counts', async () => {
    comfy.connected = false
    comfy.history.push(null)
    let settled = false
    const run = runQwenEnhancer(graph, 'a fox', { stallMs: 60_000 }).then((r) => { settled = true; return r })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(QWEN_ENHANCER_TIMEOUT_MS)
    await expect(run).resolves.toEqual({ status: 'failed' })
  })

  it('the time limit is eight minutes, not fifteen', () => {
    expect(QWEN_ENHANCER_TIMEOUT_MS).toBe(8 * 60_000)
  })
})
