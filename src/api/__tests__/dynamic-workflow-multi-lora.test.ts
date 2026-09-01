/**
 * Multi-LoRA chaining (konata 2026-06-09: "agent cannot load multiple loras").
 *
 * Before: buildDynamicWorkflow created exactly ONE LoraLoader from a single
 * string param — an LLM passing "a.safetensors, b.safetensors" sent the
 * joined string to ComfyUI verbatim and died with "Value not in list".
 * Now: the lora param accepts string | string[] (plus comma-joined strings),
 * names are resolved against the real LoraLoader enum with actionable
 * errors, and N LoRAs chain through N LoraLoader nodes exactly like
 * stacking them in the ComfyUI graph editor.
 *
 * Run: npx vitest run src/api/__tests__/dynamic-workflow-multi-lora.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})

import {
  buildDynamicWorkflow,
  normalizeLoraList,
  normalizeLoraStrengths,
  resolveLoraNames,
} from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { nodeOf, nodesOf, type BuiltNode } from './graph-test-support'
import type { ComfyApiGraph } from '../../types/comfy-graph'

const INSTALLED = ['pixel-art-xl.safetensors', 'detail-tweaker.safetensors', 'styles/ghibli_v2.safetensors']

// Minimal /object_info for the plain checkpoint (SDXL) strategy, with a
// LoraLoader whose enum carries the installed LoRAs.
const CHECKPOINT_NODES = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['Juggernaut-XL_v9.safetensors']] } } },
  LoraLoader: { input: { required: { lora_name: [INSTALLED] } } },
  KSampler: { input: { required: {} } },
  EmptyLatentImage: { input: { required: {} } },
  CLIPTextEncode: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  SaveImage: { input: { required: {} } },
}

const baseParams = {
  model: 'Juggernaut-XL_v9.safetensors',
  prompt: 'a knight', negativePrompt: '',
  sampler: 'euler', scheduler: 'normal',
  steps: 20, cfgScale: 7, width: 1024, height: 1024, seed: 42, batchSize: 1,
}

const loraNodesOf = (wf: ComfyApiGraph): [string, BuiltNode][] => nodesOf(wf, 'LoraLoader')

describe('normalizeLoraList', () => {
  it('passes arrays through (trimmed, empties dropped)', () => {
    expect(normalizeLoraList([' a.safetensors ', '', 'b.safetensors'])).toEqual(['a.safetensors', 'b.safetensors'])
  })
  it('splits comma/semicolon-joined strings (the LLM shape that used to break)', () => {
    expect(normalizeLoraList('a.safetensors, b.safetensors')).toEqual(['a.safetensors', 'b.safetensors'])
    expect(normalizeLoraList('a;b')).toEqual(['a', 'b'])
  })
  it('single name stays a one-element list; undefined → []', () => {
    expect(normalizeLoraList('a.safetensors')).toEqual(['a.safetensors'])
    expect(normalizeLoraList(undefined)).toEqual([])
  })
})

describe('normalizeLoraStrengths', () => {
  it('single number applies to every LoRA', () => {
    expect(normalizeLoraStrengths(1.2, 3)).toEqual([1.2, 1.2, 1.2])
  })
  it('array maps per index, missing tail falls back to 0.8', () => {
    expect(normalizeLoraStrengths([1.0, 0.5], 3)).toEqual([1.0, 0.5, 0.8])
  })
  it('undefined → 0.8 for all; non-finite garbage → 0.8', () => {
    expect(normalizeLoraStrengths(undefined, 2)).toEqual([0.8, 0.8])
    expect(normalizeLoraStrengths([Number.NaN, Infinity] as number[], 2)).toEqual([0.8, 0.8])
  })
})

describe('resolveLoraNames', () => {
  it('exact names pass through', () => {
    expect(resolveLoraNames(['pixel-art-xl.safetensors'], INSTALLED)).toEqual(['pixel-art-xl.safetensors'])
  })
  it('extension and case are optional', () => {
    expect(resolveLoraNames(['Pixel-Art-XL'], INSTALLED)).toEqual(['pixel-art-xl.safetensors'])
  })
  it('subfolder enum entries match by basename', () => {
    expect(resolveLoraNames(['ghibli_v2'], INSTALLED)).toEqual(['styles/ghibli_v2.safetensors'])
  })
  it('unique substring resolves', () => {
    expect(resolveLoraNames(['detail'], INSTALLED)).toEqual(['detail-tweaker.safetensors'])
  })
  it('separator-insensitive: "pixel art" (spaces) finds pixel-art-xl (dashes)', () => {
    // Live E2E 2026-06-10 found this gap: a natural-language "use the pixel
    // art lora" arrives as 'pixel art' and the dash-only substring missed it.
    expect(resolveLoraNames(['pixel art'], INSTALLED)).toEqual(['pixel-art-xl.safetensors'])
    expect(resolveLoraNames(['pixel_art_xl'], INSTALLED)).toEqual(['pixel-art-xl.safetensors'])
  })
  it('a miss throws an actionable error listing installed LoRAs', () => {
    expect(() => resolveLoraNames(['does-not-exist'], INSTALLED)).toThrow(/not installed/i)
    expect(() => resolveLoraNames(['does-not-exist'], INSTALLED)).toThrow(/pixel-art-xl\.safetensors/)
  })
})

describe('buildDynamicWorkflow — LoRA chaining', () => {
  beforeEach(() => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(CHECKPOINT_NODES as never)
  })

  it('single LoRA keeps the original single-node behaviour', async () => {
    const wf = await buildDynamicWorkflow({ ...baseParams, lora: 'pixel-art-xl.safetensors', loraStrength: 0.7 } as never)
    const loras = loraNodesOf(wf)
    expect(loras).toHaveLength(1)
    expect(loras[0][1].inputs.lora_name).toBe('pixel-art-xl.safetensors')
    expect(loras[0][1].inputs.strength_model).toBe(0.7)
  })

  it('two LoRAs chain: second consumes the first, sampler + CLIP see the last', async () => {
    const wf = await buildDynamicWorkflow({
      ...baseParams,
      lora: ['pixel-art-xl.safetensors', 'detail-tweaker.safetensors'],
      loraStrength: [1.0, 0.5],
    } as never)
    const loras = loraNodesOf(wf)
    expect(loras).toHaveLength(2)
    const [firstId, first] = loras.find(([, n]) => n.inputs.lora_name === 'pixel-art-xl.safetensors')!
    const [secondId, second] = loras.find(([, n]) => n.inputs.lora_name === 'detail-tweaker.safetensors')!
    // Chain wiring: second's model AND clip come from the first LoraLoader.
    expect(second.inputs.model).toEqual([firstId, 0])
    expect(second.inputs.clip).toEqual([firstId, 1])
    // Per-LoRA strengths land on the right node.
    expect(first.inputs.strength_model).toBe(1.0)
    expect(second.inputs.strength_model).toBe(0.5)
    // Sampler consumes the LAST LoRA's model output.
    const [, sampler] = nodeOf(wf, 'KSampler')!
    expect(sampler.inputs.model).toEqual([secondId, 0])
    // Text encoding consumes the LAST LoRA's clip output (slot 1).
    const encoders = nodesOf(wf, 'CLIPTextEncode').map(([, n]) => n)
    for (const enc of encoders) expect(enc.inputs.clip).toEqual([secondId, 1])
  })

  it('a comma-joined string from the LLM chains too (konata repro)', async () => {
    const wf = await buildDynamicWorkflow({
      ...baseParams,
      lora: 'pixel-art-xl, detail-tweaker',
    } as never)
    expect(loraNodesOf(wf)).toHaveLength(2)
  })

  it('the same LoRA may stack twice (different strengths)', async () => {
    const wf = await buildDynamicWorkflow({
      ...baseParams,
      lora: ['pixel-art-xl.safetensors', 'pixel-art-xl.safetensors'],
      loraStrength: [0.8, 0.3],
    } as never)
    const loras = loraNodesOf(wf)
    expect(loras).toHaveLength(2)
    expect(loras.map(([, n]) => n.inputs.strength_model).sort()).toEqual([0.3, 0.8])
  })

  it('an unknown LoRA fails the build with the installed list (never reaches ComfyUI)', async () => {
    await expect(
      buildDynamicWorkflow({ ...baseParams, lora: ['pixel-art-xl.safetensors', 'nope-v9'] } as never),
    ).rejects.toThrow(/not installed.*pixel-art-xl/is)
  })

  it('no lora param → no LoraLoader nodes (byte-identical baseline)', async () => {
    const wf = await buildDynamicWorkflow({ ...baseParams } as never)
    expect(loraNodesOf(wf)).toHaveLength(0)
  })
})
