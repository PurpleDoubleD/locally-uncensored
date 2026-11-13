/**
 * D1: the source page of a downloaded model file. Only an https page of
 * Hugging Face or CivitAI is kept and opened; a file LU did not download, or
 * one from before 3.0.9, has none.
 *
 * Run: npx vitest run src/lib/__tests__/model-source-d1.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { comfyKindLabel, isModelSourcePage, modelSourceKey, sourcePageFromDownloadUrl } from '../model-source'
import { useModelSourceStore } from '../../stores/modelSourceStore'

const backendCall = vi.fn(async (_cmd: string, _args?: unknown) => ({ status: 'started', id: 'x' }))
vi.mock('../../api/backend', async (orig) => ({
  ...(await orig<typeof import('../../api/backend')>()),
  backendCall: (cmd: string, args?: unknown) => backendCall(cmd, args),
}))

beforeEach(() => {
  useModelSourceStore.setState({ pages: {} })
  backendCall.mockClear()
})

describe('sourcePageFromDownloadUrl', () => {
  it('a Hugging Face file is its repository page', () => {
    expect(sourcePageFromDownloadUrl('https://huggingface.co/Comfy-Org/flux2/resolve/main/split_files/vae/flux2-vae.safetensors?download=true'))
      .toBe('https://huggingface.co/Comfy-Org/flux2')
  })
  it('a CivitAI address names a version, not a page: none', () => {
    expect(sourcePageFromDownloadUrl('https://civitai.com/api/download/models/135867')).toBeNull()
  })
  it('anything else, or plain http, is none', () => {
    expect(sourcePageFromDownloadUrl('http://huggingface.co/a/b/resolve/main/x.gguf')).toBeNull()
    expect(sourcePageFromDownloadUrl('https://evil.test/a/b/resolve/main/x.gguf')).toBeNull()
    expect(sourcePageFromDownloadUrl('https://huggingface.co/a/resolve/main/x.gguf')).toBeNull()
    expect(sourcePageFromDownloadUrl('not a url')).toBeNull()
  })
})

describe('isModelSourcePage', () => {
  it('https Hugging Face and CivitAI only', () => {
    expect(isModelSourcePage('https://civitai.com/models/120096')).toBe(true)
    expect(isModelSourcePage('https://civitai.red/models/120096')).toBe(true)
    expect(isModelSourcePage('https://huggingface.co/org/repo')).toBe(true)
    expect(isModelSourcePage('http://civitai.com/models/1')).toBe(false)
    expect(isModelSourcePage('https://civitai.com.evil.test/models/1')).toBe(false)
    expect(isModelSourcePage('https://user:pw@civitai.com/models/1')).toBe(false)
    expect(isModelSourcePage('javascript:alert(1)')).toBe(false)
    expect(isModelSourcePage('file:///etc/passwd')).toBe(false)
  })
})

describe('the store', () => {
  it('keys by file name, whatever folder the list puts in front', () => {
    expect(modelSourceKey('loras/styles/Pixel.safetensors')).toBe('pixel.safetensors')
    expect(modelSourceKey('chars\\x.safetensors')).toBe('x.safetensors')
    useModelSourceStore.getState().record('Pixel.safetensors', 'https://civitai.com/models/1')
    expect(useModelSourceStore.getState().pageFor('styles/pixel.safetensors')).toBe('https://civitai.com/models/1')
  })
  it('a foreign or empty page is dropped and never overwrites a known one', () => {
    const s = useModelSourceStore.getState()
    s.record('a.safetensors', 'https://civitai.com/models/7')
    s.record('a.safetensors', null)
    s.record('a.safetensors', 'https://evil.test/x')
    expect(useModelSourceStore.getState().pageFor('a.safetensors')).toBe('https://civitai.com/models/7')
    expect(useModelSourceStore.getState().pageFor('unknown.safetensors')).toBeNull()
  })
  it('THE FIX: both download starts write the page the address shows', async () => {
    const { startModelDownload, startModelDownloadToPath } = await import('../../api/discover')
    await startModelDownload('https://huggingface.co/org/vae/resolve/main/v.safetensors', 'vae', 'v.safetensors')
    await startModelDownloadToPath('https://huggingface.co/org/lora/resolve/main/l.safetensors', '/m/loras', 'l.safetensors')
    expect(useModelSourceStore.getState().pageFor('v.safetensors')).toBe('https://huggingface.co/org/vae')
    expect(useModelSourceStore.getState().pageFor('l.safetensors')).toBe('https://huggingface.co/org/lora')
  })
})

describe('comfyKindLabel', () => {
  it('names the folder kinds and says nothing for an unknown one', () => {
    expect(comfyKindLabel('lora')).toBe('LoRA')
    expect(comfyKindLabel('checkpoint')).toBe('Checkpoint')
    expect(comfyKindLabel(undefined)).toBeNull()
  })
})
