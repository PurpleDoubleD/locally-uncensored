/**
 * The chat catalog and its image parts.
 *
 * A GGUF chat model sees pictures only when its image part (mmproj) lies next
 * to it. On the owner's test machine in October 2026 a Qwen 3.5 9B ran without
 * one: the catalog entry named none, so the download fetched none, the app
 * rightly treated the model as one without image input, and computer control
 * worked blind from the list of buttons and fields.
 *
 * These tests hold the two directions together: nothing is offered as "can
 * see" without a part to download, and no part hides behind an entry that does
 * not say so.
 */
import { describe, expect, it } from 'vitest'
import { getMainstreamTextModels, getUncensoredTextModels, imagePartOf, planModelDownload, mmprojFileName, isImagePartFile } from '../discover'
import { IMAGE_PART } from '../image-parts'
import { isVisionCompatible } from '../../lib/model-compatibility'
import type { DiscoverModel } from '../model-bundles'

const all = [...getUncensoredTextModels(), ...getMainstreamTextModels()]
const isGguf = (m: DiscoverModel) => !!m.downloadUrl && /\.gguf$/i.test(m.filename ?? '')
const gguf = all.filter(isGguf)

describe('the image parts of the chat catalog', () => {
  it('lists a model as able to see exactly when it names its image part', () => {
    expect(gguf.length).toBeGreaterThan(100)
    for (const m of gguf) {
      const seesByTag = m.tags.includes('Vision')
      // N1: LFM3 Audio's part is a sound part (an audio encoder through the
      // same --mmproj). It carries the tag "Audio" and no "Vision".
      const hearsOnly = m.tags.includes('Audio') && !seesByTag
      expect(seesByTag || hearsOnly, `${m.name}: the Vision tag and the image part must agree`).toBe(!!m.mmprojUrl)
    }
  })

  it('names every part with its source, its exact size and its digest', () => {
    for (const m of gguf) {
      if (!m.mmprojUrl) continue
      expect(m.mmprojUrl, m.name).toMatch(/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/main\/.+\.gguf$/)
      expect(m.mmprojUrl.toLowerCase(), `${m.name}: the file is an image part`).toContain('mmproj')
      expect(m.mmprojBytes, m.name).toBeGreaterThan(100_000_000)
      expect(m.mmprojSha256, m.name).toMatch(/^[0-9a-f]{64}$/)
      expect(m.mmprojSizeGB, m.name).toBeCloseTo(m.mmprojBytes! / 1_073_741_824, 2)
      expect(m.noImagePart, `${m.name}: a part and a reason for none`).toBeUndefined()
    }
  })

  it('never takes the double size F32 file', () => {
    for (const row of Object.values(IMAGE_PART)) expect(row.mmprojUrl).not.toMatch(/f32/i)
  })

  it('gives a model of a family with image input its part or the sentence that says why not', () => {
    for (const m of gguf) {
      if (!isVisionCompatible(m.filename!) && !isVisionCompatible(m.name)) continue
      expect(!!m.mmprojUrl || !!m.noImagePart, `${m.name}: family with image input, no part and no reason`).toBe(true)
    }
  })

  it('does not promise image input in the text of an entry without a part', () => {
    for (const m of gguf) {
      if (m.mmprojUrl) continue
      const text = m.description.replace(/text only[^.]*\./gi, '')
      expect(text, `${m.name}: promises image input without a part`).not.toMatch(/\bvision\b|image input|multimodal|sees? (images|screenshots)/i)
    }
  })

  it('leaves the entries of the other runtime alone, their tag brings its own', () => {
    for (const m of all) {
      if (!m.ollamaModel) continue
      expect(m.mmprojUrl, m.name).toBeUndefined()
    }
  })

  // Three pairings were proven (image-parts.ts). The third, Qwen 3.5 35B MoE
  // Abliterated, left the catalog with the refresh of 2026-10-08; its row
  // stays in the table for the day the entry comes back.
  it('takes the part of another repository only for the proven pairings', () => {
    const foreign = gguf.filter((m) => {
      if (!m.mmprojUrl) return false
      const repoOf = (u: string) => u.split('/').slice(3, 5).join('/')
      return repoOf(m.mmprojUrl) !== repoOf(m.downloadUrl!)
    })
    expect(foreign.map((m) => m.name).sort()).toEqual([
      'Gemma 4 31B Unfiltered',
      'Qwen 3.5 9B Abliterated',
    ])
    const nine = foreign.find((m) => m.name === 'Qwen 3.5 9B Abliterated')!
    expect(nine.mmprojUrl).toBe('https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/mmproj-F16.gguf')
    expect(nine.mmprojBytes).toBe(918166080)
  })

  // Ornith 1.0 and Cydonia 24B, the other entries of this kind, left the
  // catalog with the refresh of 2026-10-08.
  it('keeps the distill without a part honest', () => {
    for (const name of ['Qwen 3.8 9B Distill', 'Qwen 3.8 9B Distill Q8_0']) {
      const m = all.find((x) => x.name === name)!
      expect(m.mmprojUrl, name).toBeUndefined()
      expect(m.noImagePart, name).toBeTruthy()
      expect(m.tags, name).not.toContain('Vision')
    }
  })
})

describe('the download plan of a model with an image part', () => {
  const nine = all.find((m) => m.name === 'Qwen 3.5 9B Abliterated')!

  it('fetches the part with the model, under the name the engine looks for, with size and digest', () => {
    const plan = planModelDownload(nine, nine.downloadUrl!, nine.filename!, 5627045216)
    expect(plan).toHaveLength(2)
    expect(plan[1]).toEqual({
      url: nine.mmprojUrl,
      filename: 'Qwen3.5-9B-abliterated.Q4_K_M.mmproj.gguf',
      expectedBytes: 918166080,
      sha256: nine.mmprojSha256,
    })
    expect(plan[1].filename).toBe(mmprojFileName(nine.filename!))
    expect(isImagePartFile(plan[1].filename)).toBe(true)
    expect(isImagePartFile(plan[0].filename)).toBe(false)
  })

  it('leaves the part out when the user unticked it', () => {
    const plan = planModelDownload(nine, nine.downloadUrl!, nine.filename!, 1, undefined, { withImagePart: false })
    expect(plan.map((f) => f.filename)).toEqual([nine.filename])
  })

  it('takes a part found in the repository for a model the catalog does not know', () => {
    const own: DiscoverModel = { name: 'own', description: '', pulls: '', tags: [], updated: '', downloadUrl: 'https://huggingface.co/a/b/resolve/main/m.Q4_K_M.gguf', filename: 'm.Q4_K_M.gguf' }
    const plan = planModelDownload(own, own.downloadUrl!, own.filename!, 10, undefined, {
      part: { url: 'https://huggingface.co/a/b/resolve/main/mmproj-F16.gguf', sizeBytes: 7, sha256: 'b'.repeat(64) },
    })
    expect(plan[1]).toEqual({ url: 'https://huggingface.co/a/b/resolve/main/mmproj-F16.gguf', filename: 'm.Q4_K_M.mmproj.gguf', expectedBytes: 7, sha256: 'b'.repeat(64) })
    expect(imagePartOf(own)).toBeNull()
  })
})
