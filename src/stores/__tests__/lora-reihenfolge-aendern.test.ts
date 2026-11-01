/**
 * D4 (3.0.9, Discord, a follow-up to B24): the picked LoRAs ran in the order
 * they were clicked, and the only way to change it was to turn them off and
 * on again. A pick now moves up or down in the stack, the order is kept with
 * the picks (on the lane B24 files them under, and across a restart), and the
 * run chains the LoRAs in that order.
 *
 * Run: npx vitest run src/stores/__tests__/lora-reihenfolge-aendern.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../api/comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})

import { useCreateStore } from '../createStore'
import { buildDynamicWorkflow } from '../../api/dynamic-workflow'
import { getAllNodeInfo } from '../../api/comfyui-nodes'
import { moveLoraPick } from '../../lib/render/lora-lanes'
import type { ComfyApiGraph } from '../../types/comfy-graph'

const A = 'pixel-art-xl.safetensors'
const B = 'detail-tweaker.safetensors'
const C = 'film-grain-xl.safetensors'
const names = () => useCreateStore.getState().selectedLoras.map((l) => l.name)

beforeEach(() => {
  useCreateStore.setState({
    mode: 'image', imageSubMode: 'text2img', videoSubMode: 't2v', removebg: false, utilityOp: null, cloudOp: null,
    imageModel: 'Juggernaut-XL_v9.safetensors', imageModelType: 'sdxl', videoModel: 'wan2.2_t2v_14B.safetensors',
    selectedLoras: [], loraStrengths: {}, loraLanes: {}, selectedCharacter: null,
  } as never)
})

describe('D4: moving a pick', () => {
  it('up and down swap it with its neighbour, the strength goes along', () => {
    const picks = [{ name: A, strength: 0.8 }, { name: B, strength: 0.4 }, { name: C, strength: 1 }]
    expect(moveLoraPick(picks, B, -1).map((p) => p.name)).toEqual([B, A, C])
    expect(moveLoraPick(picks, B, 1)).toEqual([{ name: A, strength: 0.8 }, { name: C, strength: 1 }, { name: B, strength: 0.4 }])
  })

  it('the first one up, the last one down, or an unknown name change nothing', () => {
    const picks = [{ name: A, strength: 0.8 }, { name: B, strength: 0.4 }]
    expect(moveLoraPick(picks, A, -1)).toBe(picks)
    expect(moveLoraPick(picks, B, 1)).toBe(picks)
    expect(moveLoraPick(picks, C, 1)).toBe(picks)
  })

  it('the store moves the pick', () => {
    const s = useCreateStore.getState()
    s.toggleLora(A)
    s.toggleLora(B)
    s.toggleLora(C)
    s.moveLora(C, -1)
    expect(names()).toEqual([A, C, B])
    s.moveLora(A, 1)
    expect(names()).toEqual([C, A, B])
  })
})

describe('D4: the order is kept with the picks', () => {
  it('leaving the lane and coming back brings the order back (B24)', () => {
    const s = useCreateStore.getState()
    s.toggleLora(A)
    s.toggleLora(B)
    s.moveLora(B, -1)
    s.setIntent('edit')
    expect(names()).toEqual([])
    s.setIntent('image')
    expect(names()).toEqual([B, A])
  })

  it('the saved state carries the order (a restart keeps it)', () => {
    const s = useCreateStore.getState()
    s.toggleLora(A)
    s.toggleLora(B)
    s.moveLora(B, -1)
    const saved = useCreateStore.persist.getOptions().partialize!(useCreateStore.getState()) as { selectedLoras: { name: string }[] }
    expect(saved.selectedLoras.map((l) => l.name)).toEqual([B, A])
  })
})

describe('D4: the run chains the LoRAs in the order of the stack', () => {
  const NODES = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['Juggernaut-XL_v9.safetensors']] } } },
    LoraLoader: { input: { required: { lora_name: [[A, B, C]] } } },
    KSampler: { input: { required: {} } },
    EmptyLatentImage: { input: { required: {} } },
    CLIPTextEncode: { input: { required: {} } },
    VAEDecode: { input: { required: {} } },
    SaveImage: { input: { required: {} } },
  }

  /** The LoRAs from the checkpoint to the sampler, in chain order. */
  function chain(wf: ComfyApiGraph): string[] {
    const [samplerId] = Object.entries(wf).find(([, n]) => n.class_type === 'KSampler')!
    const out: string[] = []
    let at = (wf[samplerId].inputs?.model as [string, number])[0]
    while (wf[at]?.class_type === 'LoraLoader') {
      out.unshift(String(wf[at].inputs!.lora_name))
      at = (wf[at].inputs!.model as [string, number])[0]
    }
    return out
  }

  it('the moved pick runs first', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(NODES as never)
    const s = useCreateStore.getState()
    s.toggleLora(A)
    s.toggleLora(B)
    s.toggleLora(C)
    s.moveLora(C, -1)
    s.moveLora(C, -1)
    const picks = useCreateStore.getState().selectedLoras
    const wf = await buildDynamicWorkflow({
      model: 'Juggernaut-XL_v9.safetensors', prompt: 'a knight', negativePrompt: '',
      sampler: 'euler', scheduler: 'normal', steps: 20, cfgScale: 7, width: 1024, height: 1024, seed: 42, batchSize: 1,
      lora: picks.map((l) => l.name), loraStrength: picks.map((l) => l.strength),
    })
    expect(chain(wf)).toEqual([C, A, B])
  })
})
