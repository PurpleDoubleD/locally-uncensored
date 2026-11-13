/**
 * W23 (Discord 2026-11-12): the H3 builder runs MiniMax H3 Reference (ref2va,
 * up to nine references) since B38, but the Models tab offered only the
 * fl2va file and FastH3, so nobody could get the model it needs.
 *
 * Read from the Hugging Face tree API and an anonymous HEAD on 2026-11-13:
 * Comfy-Org/MiniMax-H3, not gated, diffusion_models/minimax_h3_ref2va_pruned_
 * int8_convrot.safetensors, 20970379616 bytes, LFS sha256 9255f52b...
 *
 * Run: npx vitest run src/api/__tests__/h3-reference-is-a-download.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, backendCall: vi.fn(), localFetch: vi.fn(), comfyuiUrl: (p: string) => `http://test${p}` }
})

import { getVideoBundles } from '../model-bundles'
import { lookupFileMeta, checkBundlesInstalled } from '../discover'
import { bundleForVideoIntent, classifyModel } from '../comfyui'
import { localAnimateReferenceSlots } from '../../lib/frame-refs'
import { backendCall } from '../backend'

const FILE = 'minimax_h3_ref2va_pruned_int8_convrot.safetensors'
const SHA = '9255f52b6677845ad238f20dfaafa94727053694127ab7f255c048f0f9365779'
const BYTES = 20970379616
const GIB = 1024 ** 3

const all = () => getVideoBundles()
const ref = () => all().find((b) => b.files.some((f) => f.filename === FILE))!
const fl2va = () => all().find((b) => b.name === 'MiniMax H3 · Video with Sound')!

describe('MiniMax H3 Reference is on the Models tab', () => {
  it('its own bundle, with URL, folder, size and sha256 as Hugging Face states them', () => {
    const b = ref()
    expect(b).toBeDefined()
    expect(b.name).toMatch(/^MiniMax H3 Reference/)
    expect(b.workflow).toBe('minimaxh3')
    const f = b.files[0]
    expect(f.downloadUrl).toBe(`https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/${FILE}`)
    expect(f.sizeBytes).toBe(BYTES)
    expect(f.sha256).toBe(SHA)
    expect(f.sizeGB).toBeCloseTo(BYTES / GIB, 2)
    const sum = b.files.reduce((t, x) => t + (x.sizeGB ?? 0), 0)
    expect(b.totalSizeGB).toBeCloseTo(sum, 0)
  })

  it('the same folder as the fl2va model, and the shared parts are the very same entries', () => {
    const [main, ...shared] = ref().files
    const [h3Main, ...h3Shared] = fl2va().files
    expect(main.subfolder).toBe(h3Main.subfolder)
    expect(shared).toEqual(h3Shared)
    // No file of the shared set is defined twice in the catalog with other values.
    for (const f of shared) expect(lookupFileMeta(f.filename!)).toMatchObject({ url: f.downloadUrl, subfolder: f.subfolder })
  })

  it('a machine that has MiniMax H3 sees only the reference model missing', async () => {
    const b = ref()
    vi.mocked(backendCall).mockResolvedValueOnce(b.files.map((f) => ({
      filename: f.filename, exists: f.filename !== FILE, actualBytes: f.filename === FILE ? 0 : f.sizeBytes ?? Math.round((f.sizeGB ?? 0) * GIB), complete: f.filename !== FILE,
    })) as never)
    expect(await checkBundlesInstalled([b])).toEqual({ [b.name]: false })
  })

  it('a retry or resume finds the same URL, folder and checksum', () => {
    expect(lookupFileMeta(FILE)).toMatchObject({ url: ref().files[0].downloadUrl, subfolder: 'diffusion_models', sha256: SHA })
  })

  it('the builder reads it as H3 with nine references, and the fl2va bundle stays the starter', () => {
    expect(classifyModel(FILE)).toBe('minimaxh3')
    expect(localAnimateReferenceSlots(FILE)).toBe(8)
    expect(all().find((b) => b.workflow === 'minimaxh3')!.name).toBe('MiniMax H3 · Video with Sound')
    expect(bundleForVideoIntent(all(), 'video')?.name).not.toBe(ref().name)
  })

  it('the Turbo LoRA stays right behind the H3 bundle, the card text has no dash characters', () => {
    const names = all().map((b) => b.name)
    expect(names[names.indexOf('MiniMax H3 Turbo LoRA · 8 Steps') - 1]).toBe('MiniMax H3 · Video with Sound')
    for (const t of [ref().name, ref().description, ref().files[0].name, ref().files[0].description]) expect(t).not.toMatch(/[–—]/)
    expect(ref().description.length).toBeLessThanOrEqual(170)
  })
})
