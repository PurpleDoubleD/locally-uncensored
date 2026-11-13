/**
 * The Qwen-Image 2.1 prompt enhancer (GH #148): the graph ComfyUI gets, the
 * version it needs, the run, and the two Model Manager bundles.
 *
 * Read off the real sources on 2026-10-03, not guessed:
 *   - Comfy-Org/workflow_templates, image_qwen_image_2_1_t2i.json and
 *     image_qwen_image_2_1_image_edit.json (commit 9fae1041be): the enhancer
 *     chain CLIPLoader -> TextGenerate -> PreviewAny, the system prompt through
 *     PrimitiveStringMultiline, BatchImagesNode in front of the image input,
 *     and every widget value of TextGenerate
 *   - ComfyUI comfy_extras/nodes_textgen.py at the tags 0.37.1 and 0.37.2: the
 *     `system_prompt` input arrived in 0.37.2
 *   - the Hugging Face API for both repos: file names, byte counts, SHA-256
 *
 * Run: npx vitest run src/api/__tests__/qwen-enhancer-workflow.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, localFetch: vi.fn(), comfyuiUrl: (p: string) => `http://test${p}` }
})

const comfy = vi.hoisted(() => ({
  submitted: [] as unknown[],
  history: [] as unknown[],
  submitError: null as Error | null,
  log: [] as string[],
}))
vi.mock('../comfyui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui')>()
  return {
    ...actual,
    submitWorkflow: vi.fn(async (workflow: unknown) => {
      comfy.log.push('submit')
      if (comfy.submitError) throw comfy.submitError
      comfy.submitted.push(workflow)
      return 'pe-1'
    }),
    getHistory: vi.fn(async () => (comfy.history.length > 1 ? comfy.history.shift() : comfy.history[0]) ?? null),
    freeMemory: vi.fn(async () => { comfy.log.push('free') }),
    abandonPrompt: vi.fn(async (id: string) => { comfy.log.push(`abandon:${id}`) }),
  }
})

import {
  QWEN_ENHANCER_MAX_LENGTH, QWEN_ENHANCER_NEEDS_UPDATE, QWEN_ENHANCER_OUTPUT_NODE,
  qwenEnhancerGraph, runQwenEnhancer,
} from '../qwen-enhancer'
import { QWEN_PE_I2I_SYSTEM_PROMPT, QWEN_PE_T2I_SYSTEM_PROMPT } from '../qwen-enhancer-prompts'
import { findMatchingCLIP } from '../comfyui'
import { getImageBundles } from '../discover'
import { localFetch } from '../backend'
import { qwenEnhancerFile } from '../../lib/render/qwen-enhancer'
import { nodeOf, nodesOf } from './graph-test-support'
import type { ComfyApiGraph } from '../../types/comfy-graph'

/** The inputs and the id of the one node of this class. */
const inputsOf = (graph: ComfyApiGraph, klass: string) => nodeOf(graph, klass)![1].inputs
const idOf = (graph: ComfyApiGraph, klass: string) => nodeOf(graph, klass)![0]

const T2I = 'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors'
const I2I_FREE = 'qwen3.5_9b_qwen_image_2.1_pe_i2i_heretic.int8_convrot.safetensors'

/** The four core nodes of a ComfyUI that can run the enhancer (0.37.2 and up). */
const NODES = {
  TextGenerate: { input: { required: { clip: ['CLIP'], prompt: ['STRING'], max_length: ['INT'] }, optional: { image: ['IMAGE'], thinking: ['BOOLEAN'], mtp: ['COMBO'], system_prompt: ['STRING'] } } },
  PrimitiveStringMultiline: { input: { required: { value: ['STRING'] } } },
  PreviewAny: { input: { required: { source: ['*'] } } },
  BatchImagesNode: { input: { required: {} } },
}
/** ComfyUI 0.37.0 and 0.37.1: Qwen-Image 2.1 runs, TextGenerate has no system prompt yet. */
const NODES_0371 = {
  ...NODES,
  TextGenerate: { input: { required: { clip: ['CLIP'], prompt: ['STRING'], max_length: ['INT'] }, optional: { image: ['IMAGE'], thinking: ['BOOLEAN'], mtp: ['COMBO'] } } },
}

beforeEach(() => {
  comfy.submitted.length = 0
  comfy.history.length = 0
  comfy.log.length = 0
  comfy.submitError = null
})

describe('the enhancer graph for a new picture (T2I)', () => {
  const graph = qwenEnhancerGraph({ file: T2I, mode: 't2i', prompt: 'a fox in snow', seed: 42 }, NODES)

  it('loads the enhancer file and nothing of the image model', () => {
    expect(inputsOf(graph, 'CLIPLoader')).toEqual({ clip_name: T2I, type: 'qwen_image', device: 'default' })
    expect(Object.values(graph).map((n) => n.class_type).sort()).toEqual(['CLIPLoader', 'PreviewAny', 'PrimitiveStringMultiline', 'TextGenerate'])
  })

  it('TextGenerate carries the template values, the prompt and the T2I system prompt', () => {
    const id = idOf(graph, 'CLIPLoader')
    const systemId = idOf(graph, 'PrimitiveStringMultiline')
    expect(inputsOf(graph, 'TextGenerate')).toEqual({
      clip: [id, 0],
      prompt: 'a fox in snow',
      max_length: 4096,
      sampling_mode: 'on',
      'sampling_mode.temperature': 1,
      'sampling_mode.top_k': 20,
      'sampling_mode.top_p': 0.95,
      'sampling_mode.min_p': 0,
      'sampling_mode.repetition_penalty': 1,
      'sampling_mode.seed': 42,
      'sampling_mode.presence_penalty': 1.5,
      thinking: true,
      use_default_template: true,
      mtp: 'auto',
      system_prompt: [systemId, 0],
    })
    expect(QWEN_ENHANCER_MAX_LENGTH).toBe(4096)
    expect(inputsOf(graph, 'PrimitiveStringMultiline').value).toBe(QWEN_PE_T2I_SYSTEM_PROMPT)
  })

  it('the answer leaves through PreviewAny, the node the run reads', () => {
    expect(graph[QWEN_ENHANCER_OUTPUT_NODE]).toEqual({ class_type: 'PreviewAny', inputs: { source: [idOf(graph, 'TextGenerate'), 0] } })
  })

  it('takes no picture, even when one is handed in', () => {
    const g = qwenEnhancerGraph({ file: T2I, mode: 't2i', prompt: 'a fox', seed: 1, images: ['source.png'] }, NODES)
    expect(nodesOf(g, 'LoadImage')).toHaveLength(0)
    expect(inputsOf(g, 'TextGenerate').image).toBeUndefined()
  })
})

describe('the enhancer graph for an edit (I2I)', () => {
  it('one picture goes straight into the enhancer', () => {
    const graph = qwenEnhancerGraph({ file: I2I_FREE, mode: 'i2i', prompt: 'make it night', seed: 7, images: ['source.png'] }, NODES)
    expect(inputsOf(graph, 'LoadImage')).toEqual({ image: 'source.png' })
    const gen = inputsOf(graph, 'TextGenerate')
    expect(gen.image).toEqual([idOf(graph, 'LoadImage'), 0])
    expect(nodesOf(graph, 'BatchImagesNode')).toHaveLength(0)
    expect(inputsOf(graph, 'CLIPLoader').clip_name).toBe(I2I_FREE)
  })

  it('the edit system prompt and the edit sampling: no presence penalty', () => {
    const graph = qwenEnhancerGraph({ file: I2I_FREE, mode: 'i2i', prompt: 'make it night', seed: 7, images: ['source.png'] }, NODES)
    expect(inputsOf(graph, 'PrimitiveStringMultiline').value).toBe(QWEN_PE_I2I_SYSTEM_PROMPT)
    const gen = inputsOf(graph, 'TextGenerate')
    expect(gen['sampling_mode.presence_penalty']).toBe(0)
    expect(gen['sampling_mode.seed']).toBe(7)
    expect(gen.prompt).toBe('make it night')
    expect(gen.thinking).toBe(true)
  })

  it('source and references reach it as one batch, in the order the picture numbers them', () => {
    const graph = qwenEnhancerGraph({
      file: I2I_FREE, mode: 'i2i', prompt: 'put the woman from <image2> into <image1>', seed: 7,
      images: ['street.png', 'woman.png', 'hat.png'],
    }, NODES)
    const loads = nodesOf(graph, 'LoadImage')
    expect(loads.map(([, n]) => n.inputs.image)).toEqual(['street.png', 'woman.png', 'hat.png'])
    expect(inputsOf(graph, 'BatchImagesNode')).toEqual({
      'images.image0': [loads[0][0], 0],
      'images.image1': [loads[1][0], 0],
      'images.image2': [loads[2][0], 0],
    })
    expect(inputsOf(graph, 'TextGenerate').image).toEqual([idOf(graph, 'BatchImagesNode'), 0])
  })
})

describe('the version lock', () => {
  it('names the version and the way out, in the words Create keys the update on', () => {
    expect(QWEN_ENHANCER_NEEDS_UPDATE).toBe('The Qwen prompt enhancer needs ComfyUI 0.37.2 or newer. Update ComfyUI in Settings.')
  })

  it('a ComfyUI whose TextGenerate takes no system prompt gets the update sentence, for T2I and I2I', () => {
    for (const req of [
      { file: T2I, mode: 't2i' as const, prompt: 'a fox', seed: 1 },
      { file: I2I_FREE, mode: 'i2i' as const, prompt: 'make it night', seed: 1, images: ['a.png'] },
    ]) {
      let thrown: unknown
      try { qwenEnhancerGraph(req, NODES_0371) } catch (err) { thrown = err }
      expect(thrown).toBeInstanceOf(Error)
      const err = thrown as Error & { needsComfyUpdate?: boolean }
      expect(err.name).toBe('WorkflowUnavailableError')
      expect(err.message).toBe(QWEN_ENHANCER_NEEDS_UPDATE)
      expect(err.needsComfyUpdate).toBe(true)
    }
  })

  it('a ComfyUI without TextGenerate at all gets it too', () => {
    expect(() => qwenEnhancerGraph({ file: T2I, mode: 't2i', prompt: 'a fox', seed: 1 }, {})).toThrow(QWEN_ENHANCER_NEEDS_UPDATE)
  })

  it('a current ComfyUI builds without a word', () => {
    expect(() => qwenEnhancerGraph({ file: T2I, mode: 't2i', prompt: 'a fox', seed: 1 }, NODES)).not.toThrow()
  })
})

describe('the run', () => {
  const graph = qwenEnhancerGraph({ file: T2I, mode: 't2i', prompt: 'a fox', seed: 1 }, NODES)
  const done = (text: unknown) => ({ status: { status_str: 'success' }, outputs: { [QWEN_ENHANCER_OUTPUT_NODE]: { text: [text] } } })

  it('reads the rewritten prompt and unloads the enhancer afterwards', async () => {
    comfy.history.push(null, done('A red fox in deep snow.'))
    const out = await runQwenEnhancer(graph, 'a fox', { clientId: 'lu-test' })
    expect(out).toEqual({ status: 'improved', prompt: 'A red fox in deep snow.' })
    expect(comfy.submitted).toEqual([graph])
    // The enhancer is out of the card before the caller builds the picture.
    expect(comfy.log).toEqual(['free', 'submit', 'free'])
  })

  it('a ComfyUI error is a failed rewrite, never a thrown one, and the card is freed', async () => {
    comfy.history.push({ status: { status_str: 'error', messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] } })
    await expect(runQwenEnhancer(graph, 'a fox')).resolves.toEqual({ status: 'failed' })
    expect(comfy.log).toEqual(['free', 'submit', 'free'])
  })

  it('a rejected graph (file gone since the list was read) is a failed rewrite', async () => {
    comfy.submitError = new Error('ComfyUI rejected workflow: Value not in list')
    await expect(runQwenEnhancer(graph, 'a fox')).resolves.toEqual({ status: 'failed' })
    expect(comfy.log).toEqual(['free', 'submit', 'free'])
  })

  it('a refusal or an empty answer is a failed rewrite', async () => {
    comfy.history.push(done("I'm sorry, but I can't help with that."))
    await expect(runQwenEnhancer(graph, 'a fox')).resolves.toEqual({ status: 'failed' })
    comfy.history.length = 0
    comfy.history.push({ status: { status_str: 'success' }, outputs: {} })
    await expect(runQwenEnhancer(graph, 'a fox')).resolves.toEqual({ status: 'failed' })
  })

  it('out of time: the job is taken out of the queue, then the card is freed', async () => {
    comfy.history.push(null)
    await expect(runQwenEnhancer(graph, 'a fox', { timeoutMs: -1 })).resolves.toEqual({ status: 'failed' })
    expect(comfy.log).toEqual(['free', 'submit', 'abandon:pe-1', 'free'])
  })

  it('Cancel: the job is taken out of the queue at once', async () => {
    comfy.history.push(null)
    const stop = new AbortController()
    const run = runQwenEnhancer(graph, 'a fox', { signal: stop.signal })
    await new Promise((r) => setTimeout(r, 10))
    stop.abort()
    await expect(run).resolves.toEqual({ status: 'failed' })
    expect(comfy.log).toEqual(['free', 'submit', 'abandon:pe-1', 'free'])
  })

  it('cancelled before it starts: nothing is sent', async () => {
    const stop = new AbortController()
    stop.abort()
    await expect(runQwenEnhancer(graph, 'a fox', { signal: stop.signal })).resolves.toEqual({ status: 'failed' })
    expect(comfy.log).toEqual([])
  })
})

describe('the system prompts', () => {
  const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

  it('are the template texts, to the character', () => {
    expect(QWEN_PE_T2I_SYSTEM_PROMPT).toHaveLength(10308)
    expect(sha(QWEN_PE_T2I_SYSTEM_PROMPT)).toBe('0b8b261455e2a8c48757bdad7c3cb71173c67ab7b5ab7042a2635fd76a6fb2bf')
    expect(QWEN_PE_I2I_SYSTEM_PROMPT).toHaveLength(10494)
    expect(sha(QWEN_PE_I2I_SYSTEM_PROMPT)).toBe('eaff356cd2bdbcfd1aaf20502b5ccd8cbad16fa6e9afe41e3166eeee299c8e59')
  })

  it('each asks for a plain paragraph, not for JSON', () => {
    expect(QWEN_PE_T2I_SYSTEM_PROMPT).toContain('Your whole reply is used as the image prompt')
    expect(QWEN_PE_I2I_SYSTEM_PROMPT).toContain('Output ONLY the rewritten editing instruction itself')
  })

  it('the source file is plain ASCII', () => {
    const source = readFileSync(resolve(__dirname, '../qwen-enhancer-prompts.ts'), 'utf8')
    expect([...source].every((c) => c.charCodeAt(0) < 128)).toBe(true)
  })
})

describe('the encoder search never picks an enhancer', () => {
  const serve = (clips: string[]) => {
    vi.mocked(localFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ CLIPLoader: { input: { required: { clip_name: [clips] } } } }),
    } as never)
  }
  const ALL_FOUR = [
    'qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors',
    'qwen3.5_9b_qwen_image_2.1_pe_i2i_heretic.int8_convrot.safetensors',
    T2I,
    'qwen3.5_9b_qwen_image_2.1_pe_t2i_heretic.int8_convrot.safetensors',
  ]

  it('HunyuanVideo keeps its own Qwen encoder although the enhancers sort first', async () => {
    serve([...ALL_FOUR, 'qwen_2.5_vl_7b_fp8_scaled.safetensors'])
    await expect(findMatchingCLIP('hunyuan')).resolves.toBe('qwen_2.5_vl_7b_fp8_scaled.safetensors')
  })

  it('with only enhancers in the folder, every family says which encoder to download', async () => {
    serve(ALL_FOUR)
    await expect(findMatchingCLIP('flux2', 'flux-2-klein-4b.safetensors')).rejects.toThrow(/qwen_3_4b/)
    await expect(findMatchingCLIP('zimage')).rejects.toThrow(/qwen_3_4b\.safetensors/)
    await expect(findMatchingCLIP('framepack')).rejects.toThrow(/llava_llama3_fp8_scaled/)
    await expect(findMatchingCLIP('hunyuan')).rejects.toThrow(/qwen_2\.5_vl_7b_fp8_scaled/)
    await expect(findMatchingCLIP('qwenimage')).rejects.toThrow(/qwen3vl_8b_int8_convrot/)
  })

  it('next to an unrelated encoder, FLUX 2, Z-Image and FramePack still do not take an enhancer', async () => {
    serve([...ALL_FOUR, 't5xxl_fp16.safetensors'])
    await expect(findMatchingCLIP('flux2', 'flux-2-klein-4b.safetensors')).rejects.toThrow(/FLUX 2 text encoder/)
    await expect(findMatchingCLIP('zimage')).rejects.toThrow(/Z-Image text encoder/)
    await expect(findMatchingCLIP('framepack')).rejects.toThrow(/FramePack text encoder/)
  })

  it('Qwen-Image 2.1 keeps Qwen3-VL 8B next to them', async () => {
    serve([...ALL_FOUR, 'qwen3vl_8b_int8_convrot.safetensors'])
    await expect(findMatchingCLIP('qwenimage')).resolves.toBe('qwen3vl_8b_int8_convrot.safetensors')
  })
})

describe('the two Model Manager bundles', () => {
  const bundles = getImageBundles().filter((b) => b.tags.includes('Prompt Enhancer'))
  const official = bundles.find((b) => b.name === 'Qwen-Image 2.1 Prompt Enhancer (Official)')
  const free = bundles.find((b) => b.name === 'Qwen-Image 2.1 Prompt Enhancer (No Filter)')

  /** file name -> [repo path, SHA-256], as the Hugging Face API states them. */
  const FILES: Record<string, [string, string]> = {
    'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors': [
      'Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/', '9182abae56fe05459840a86d22abd21f972061c92fce032630af680c8c5178d3'],
    'qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors': [
      'Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/', '32707d01b427e488af252b95c551989aad59f9fec611a694f5db6bde7f0f1f6c'],
    'qwen3.5_9b_qwen_image_2.1_pe_t2i_heretic.int8_convrot.safetensors': [
      'Adahm/PE-Heretic-INT8-ConvRot-for-Qwen-Image-2.1/resolve/main/', '91b9ba42539fb662775181eabce845befe2c1441658a736fadf0033dd799d8f3'],
    'qwen3.5_9b_qwen_image_2.1_pe_i2i_heretic.int8_convrot.safetensors': [
      'Adahm/PE-Heretic-INT8-ConvRot-for-Qwen-Image-2.1/resolve/main/', '979b9063dd16645f0191c9ff55aa5059105bfe84096d96a817a85deed22231f0'],
  }
  const BYTES = 9_471_072_252

  it('there are exactly two: the official one and the one without refusals', () => {
    expect(bundles.map((b) => b.name)).toEqual([
      'Qwen-Image 2.1 Prompt Enhancer (Official)',
      'Qwen-Image 2.1 Prompt Enhancer (No Filter)',
    ])
    expect(official!.uncensored).toBe(false)
    expect(free!.uncensored).toBe(true)
  })

  it('each is one click for both tasks: a file for new pictures and one for edits', () => {
    for (const b of bundles) {
      expect(b.files.map((f) => qwenEnhancerFile(f.filename!)?.mode).sort(), b.name).toEqual(['i2i', 't2i'])
    }
    expect(official!.files.every((f) => qwenEnhancerFile(f.filename!)?.variant === 'official')).toBe(true)
    expect(free!.files.every((f) => qwenEnhancerFile(f.filename!)?.variant === 'unfiltered')).toBe(true)
  })

  it('every file is complete: address, folder, exact size and SHA-256', () => {
    const seen: string[] = []
    for (const b of bundles) {
      for (const f of b.files) {
        const [path, sha256] = FILES[f.filename!]
        expect(f.downloadUrl, f.filename).toBe(`https://huggingface.co/${path}${f.filename}`)
        expect(f.subfolder, f.filename).toBe('text_encoders')
        expect(f.sizeBytes, f.filename).toBe(BYTES)
        expect(f.sha256, f.filename).toBe(sha256)
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
        // sizeGB is gibibytes: the install check multiplies it by 1_073_741_824.
        expect(Math.abs(f.sizeGB! - BYTES / 1_073_741_824), f.filename).toBeLessThan(0.01)
        seen.push(f.filename!)
      }
      expect(Math.abs(b.totalSizeGB - b.files.reduce((sum, f) => sum + f.sizeGB!, 0)), b.name).toBeLessThan(0.05)
    }
    expect(seen.sort()).toEqual(Object.keys(FILES).sort())
  })

  it('each carries a tier, a VRAM figure and the family it belongs to', () => {
    for (const b of bundles) {
      expect(b.tier, b.name).toBe('best')
      expect(b.workflow, b.name).toBe('qwenimage')
      expect(b.vramRequired, b.name).toBe('12 GB best, offloads on less')
      expect(b.tags, b.name).toContain('Addon')
      expect(b.customNodes, b.name).toBeUndefined()
    }
  })

  it('says what it does, where to switch it on, and the licence', () => {
    for (const b of bundles) {
      expect(b.description, b.name).toMatch(/Add-on for Qwen-Image 2\.1/)
      expect(b.description, b.name).toMatch(/short prompt/)
      expect(b.description, b.name).toMatch(/looks at your pictures when you edit/)
      expect(b.description, b.name).toMatch(/runs before the image model and makes room for it/)
      expect(b.description, b.name).toMatch(/Improve my prompt in the advanced settings/)
      expect(b.description, b.name).toContain('Qwen Research License, non-commercial use: https://huggingface.co/')
    }
  })

  it('the official one says it can soften an instruction, the other that it does not', () => {
    expect(official!.description).toMatch(/can soften or refuse an instruction/)
    expect(free!.description).toMatch(/refusals taken out/)
    expect(free!.description).toMatch(/stay what you wrote/)
  })

  it('they stand after the model itself, so the family still finds its model first', () => {
    const all = getImageBundles()
    const first = all.find((b) => b.workflow === 'qwenimage')!
    expect(first.name).toBe('Qwen-Image 2.1 (Generate and Edit)')
    const at = (name: string) => all.findIndex((b) => b.name === name)
    expect(at(official!.name)).toBeGreaterThan(at(first.name))
    expect(at(free!.name)).toBeGreaterThan(at(first.name))
    expect(all[0].tags).not.toContain('Prompt Enhancer')
  })
})
