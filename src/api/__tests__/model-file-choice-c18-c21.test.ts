// C18: the full CivitAI description reaches the Details dialog.
// C21: the user can pick the version and the file (bf16, fp8, a quant)
// instead of LU always taking the newest and first.
import { describe, it, expect } from 'vitest'
import {
  civitaiDescriptionToParagraphs, civitaiVersionChoices, civitaiHitWithFile, civitaiSubfolder,
  listGgufChoices, discoverModelForChoice, selectGgufFromTree, ggufRequestFor,
  type CivitAIModelResult, type HfTreeEntry, type DiscoverModel,
} from '../discover'

const LONG = `<p>${'Trigger word: pxl. '.repeat(20)}</p><ul><li>Strength 0.8</li><li>CFG 4</li></ul><p>Do not use with &amp; other LoRAs.<br>Thanks!</p><script>alert(1)</script>`

describe('C18: the whole description', () => {
  it('keeps every word, far past 120 characters', () => {
    const text = civitaiDescriptionToParagraphs(LONG)
    expect(text.length).toBeGreaterThan(300)
    expect(text).toContain('Do not use with & other LoRAs.')
  })

  it('keeps paragraphs and list items as lines, and no markup', () => {
    const text = civitaiDescriptionToParagraphs(LONG)
    expect(text).toContain('\n• Strength 0.8')
    expect(text).toContain('\nThanks!')
    expect(text).not.toMatch(/<[a-z/]/i)
  })
})

const ITEM = {
  id: 7,
  name: 'Pixel LoRA',
  modelVersions: [
    {
      id: 102, name: 'v2', baseModel: 'SDXL 1.0', publishedAt: '2026-10-01T00:00:00Z',
      files: [
        { name: 'pixel_v2_fp16.safetensors', sizeKB: 1024, primary: true, downloadUrl: 'https://civitai.com/api/download/models/102?fp=fp16', metadata: { fp: 'fp16', size: 'pruned', format: 'SafeTensor' }, hashes: { SHA256: 'A'.repeat(64) } },
        { name: 'pixel_v2_fp32.safetensors', sizeKB: 2048, downloadUrl: 'https://civitai.com/api/download/models/102?fp=fp32', metadata: { fp: 'fp32', size: 'full', format: 'SafeTensor' } },
        { name: 'pixel_v2.ckpt', sizeKB: 2048, downloadUrl: 'https://civitai.com/api/download/models/102?format=PickleTensor', metadata: { format: 'PickleTensor' } },
        { name: 'training_data.zip', sizeKB: 9999, downloadUrl: 'https://civitai.com/api/download/models/102?type=Training', type: 'Training Data' },
      ],
    },
    { id: 101, name: 'v1', baseModel: 'SD 1.5', files: [{ name: 'pixel_v1.safetensors', sizeKB: 512, downloadUrl: 'https://civitai.com/api/download/models/101' }] },
    { id: 100, name: 'v0', files: [{ name: 'pixel_v0.ckpt', sizeKB: 512, downloadUrl: 'https://civitai.com/api/download/models/100' }] },
  ],
}

describe('C21: CivitAI versions and files', () => {
  it('lists every version with its model files, newest first', () => {
    const v = civitaiVersionChoices(ITEM)
    expect(v.map((x) => x.name)).toEqual(['v2', 'v1'])
    expect(v[0].files.map((f) => f.name)).toEqual(['pixel_v2_fp16.safetensors', 'pixel_v2_fp32.safetensors'])
    expect(v[0].files[0]).toMatchObject({ fp: 'fp16', size: 'pruned', format: 'SafeTensor', primary: true, sizeBytes: 1024 * 1024, sha256: 'a'.repeat(64) })
    expect(v[0].baseModel).toBe('SDXL 1.0')
    expect(v[0].published).toBe('2026-10-01')
  })

  it('THE RULE: no pickle file and no training data is offered', () => {
    const names = civitaiVersionChoices(ITEM).flatMap((v) => v.files.map((f) => f.name))
    expect(names).not.toContain('pixel_v2.ckpt')
    expect(names).not.toContain('training_data.zip')
  })

  it('the mirror host goes into every file address', () => {
    const v = civitaiVersionChoices(ITEM, 'civitai.red')
    expect(v[0].files[0].downloadUrl).toMatch(/^https:\/\/civitai\.red\//)
  })

  it('a picked file downloads as itself, into the folder of its type', () => {
    const hit: CivitAIModelResult = { id: 7, name: 'Pixel LoRA', description: '', type: 'LORA', sourceUrl: 'https://civitai.com/models/7', filename: 'pixel_v2_fp16.safetensors', subfolder: 'loras' }
    const v = civitaiVersionChoices(ITEM)
    const picked = civitaiHitWithFile(hit, v[1], v[1].files[0])
    expect(picked).toMatchObject({ filename: 'pixel_v1.safetensors', subfolder: 'loras', downloadUrl: 'https://civitai.com/api/download/models/101', versionId: 101 })
  })

  it('a GGUF checkpoint goes to diffusion_models, a LoRA named Flux to loras', () => {
    expect(civitaiSubfolder('Checkpoint', 'Some Model', 'q.gguf')).toBe('diffusion_models')
    expect(civitaiSubfolder('Checkpoint', 'Some Model', 'q.safetensors')).toBe('checkpoints')
    expect(civitaiSubfolder('LORA', 'Flux Realism', 'r.safetensors')).toBe('loras')
  })
})

const TREE: HfTreeEntry[] = [
  { type: 'file', path: 'model-Q8_0.gguf', size: 8_000 },
  { type: 'file', path: 'model-Q4_K_M.gguf', size: 4_000 },
  { type: 'file', path: 'BF16/model-BF16-00001-of-00002.gguf', size: 9_000 },
  { type: 'file', path: 'BF16/model-BF16-00002-of-00002.gguf', size: 9_000 },
  { type: 'file', path: 'Q2/model-Q2_K-00001-of-00003.gguf', size: 1_000 },
  { type: 'file', path: 'mmproj-F16.gguf', size: 600 },
  { type: 'file', path: 'README.md', size: 10 },
]

describe('C21: the GGUF files of a Hugging Face repository', () => {
  it('lists each file and each split set once, smallest first, without the image part', () => {
    const list = listGgufChoices(TREE)
    expect(list.map((c) => c.quant)).toEqual(['Q2_K', 'Q4_K_M', 'Q8_0', 'BF16'])
    const bf16 = list.find((c) => c.quant === 'BF16')!
    expect(bf16).toMatchObject({ parts: 2, totalBytes: 18_000, filename: 'model-BF16-00001-of-00002.gguf', incomplete: false })
  })

  it('a split set with missing parts is marked, not offered as loadable', () => {
    expect(listGgufChoices(TREE).find((c) => c.quant === 'Q2_K')?.incomplete).toBe(true)
  })

  it('THE FIX: the picked file is what the download resolves, never a swapped quant', () => {
    const base: DiscoverModel = {
      name: 'Test 8B', description: '', pulls: '', tags: [], updated: '',
      downloadUrl: 'https://huggingface.co/u/r/resolve/main/model-Q4_K_M.gguf', filename: 'model-Q4_K_M.gguf', sizeGB: 4, quantGuessed: true,
    }
    const pick = listGgufChoices(TREE).find((c) => c.quant === 'Q8_0')!
    const model = discoverModelForChoice(base, 'u/r', pick)
    expect(model.quantGuessed).toBe(false)
    const req = ggufRequestFor(model)!
    // A tight memory budget would swap a guessed quant; a picked one stays.
    const res = selectGgufFromTree(TREE, req.repoId, req.preferredQuant, req.exactPath, 2_000)
    expect(res?.files.map((f) => f.filename)).toEqual(['model-Q8_0.gguf'])
    expect(res?.fitSwap).toBeUndefined()
  })

  it('a picked split set brings every part', () => {
    const base: DiscoverModel = { name: 'T', description: '', pulls: '', tags: [], updated: '', downloadUrl: 'https://huggingface.co/u/r/resolve/main/model-Q4_K_M.gguf', filename: 'model-Q4_K_M.gguf' }
    const pick = listGgufChoices(TREE).find((c) => c.quant === 'BF16')!
    const req = ggufRequestFor(discoverModelForChoice(base, 'u/r', pick))!
    const res = selectGgufFromTree(TREE, req.repoId, req.preferredQuant, req.exactPath)
    expect(res?.sharded).toBe(true)
    expect(res?.files).toHaveLength(2)
  })
})
