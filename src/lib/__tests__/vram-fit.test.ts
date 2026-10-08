import { describe, it, expect } from 'vitest'
import {
  deriveVramNeed, vramFit, fileVramFit, vramFitLabel, vramFitLine, vramNeedTitle, slowLoadHint, cardGb,
  withVramNeed, largestWeightGb, needForInstalledFile, VRAM_WORKING_GB, SLOW_LOAD_HINT_AFTER_MS,
} from '../vram-fit'
import {
  getImageBundles, getVideoBundles, getAudioBundles, getLipsyncBundles, getMotionBundles, getLoraAddonBundles,
} from '../../api/model-bundles'

// The owner's test box, October 2026: RTX 3060 with 12 GB, Z-Image
// (z_image_bf16 at 11.5 GB beside a 7.5 GB text encoder) sat more than 300 s in
// "Loading the model into memory" while the catalogue said "10-16 GB" and
// nothing else. These cases pin the one rule that now reads that text for
// every bundle, and the words it turns into.

const allBundles = () => [
  ...getImageBundles(), ...getVideoBundles(), ...getAudioBundles(), ...getLipsyncBundles(), ...getMotionBundles(),
]

describe('deriveVramNeed: what the catalogue text and the file sizes say', () => {
  it('a span is minimum and comfortable value', () => {
    expect(deriveVramNeed({ vramRequired: '6-8 GB', files: [{ sizeGB: 6.5 }] })).toEqual({ vramMinGB: 6, vramComfortGB: 8 })
    expect(deriveVramNeed({ vramRequired: '10-16 GB', files: [{ sizeGB: 11.5 }, { sizeGB: 7.5 }] })).toEqual({ vramMinGB: 10, vramComfortGB: 16 })
  })

  it('a single number or a plus is both ends, nothing is added to it', () => {
    expect(deriveVramNeed({ vramRequired: '16 GB', files: [{ sizeGB: 8.82 }] })).toEqual({ vramMinGB: 16, vramComfortGB: 16 })
    expect(deriveVramNeed({ vramRequired: '24+ GB', files: [{ sizeGB: 21 }] })).toEqual({ vramMinGB: 24, vramComfortGB: 24 })
  })

  it('the largest single weight plus working memory lifts the comfortable value', () => {
    expect(VRAM_WORKING_GB).toBe(1.5)
    // FLUX.1 FP8: "8-10 GB" beside a 16.1 GB diffusion model.
    expect(deriveVramNeed({ vramRequired: '8-10 GB', files: [{ sizeGB: 16.1 }, { sizeGB: 4.6 }] })).toEqual({ vramMinGB: 8, vramComfortGB: 17.6 })
    expect(deriveVramNeed({ vramRequired: '12+ GB', files: [{ sizeGB: 14 }, { sizeGB: 6.3 }] })).toEqual({ vramMinGB: 12, vramComfortGB: 15.5 })
    // The weights load one after the other, so they are not added up.
    expect(deriveVramNeed({ vramRequired: '10-16 GB', files: [{ sizeGB: 7 }, { sizeGB: 7 }, { sizeGB: 7 }] })!.vramComfortGB).toBe(16)
    expect(largestWeightGb([{ sizeGB: 2 }, {}, { sizeGB: 9.3 }])).toBe(9.3)
    expect(largestWeightGb()).toBe(0)
  })

  it('"best" names the comfortable value and no floor', () => {
    expect(deriveVramNeed({ vramRequired: '16 GB best, offloads on less', files: [{ sizeGB: 15.27 }] })).toEqual({ vramMinGB: 0, vramComfortGB: 16.8 })
  })

  it('"any" has no floor and is as big as its file', () => {
    expect(deriveVramNeed({ vramRequired: 'any', files: [{ sizeGB: 0.17 }] })).toEqual({ vramMinGB: 0, vramComfortGB: 1.7 })
  })

  it('a text without a number gets no verdict instead of a guessed one', () => {
    expect(deriveVramNeed({ vramRequired: 'depends on the checkpoint', files: [{ sizeGB: 4.9 }] })).toBeNull()
    expect(deriveVramNeed({})).toBeNull()
    expect(withVramNeed([{ vramRequired: '' }])[0]).toMatchObject({ vramMinGB: null, vramComfortGB: null })
  })
})

describe('vramFit: where a bundle stands on a card', () => {
  const zimage = { vramMinGB: 10, vramComfortGB: 16 }

  it('below the minimum needs more, from the comfortable value fits, between is tight', () => {
    expect(vramFit(zimage, 8)).toBe('big')
    expect(vramFit(zimage, 10)).toBe('tight')
    expect(vramFit(zimage, 12)).toBe('tight')
    expect(vramFit(zimage, 16)).toBe('fits')
    expect(vramFit(zimage, 24)).toBe('fits')
  })

  it('a card that reports a hair under its size counts as that size', () => {
    expect(cardGb(11.99)).toBe(12)
    expect(vramFit({ vramMinGB: 12, vramComfortGB: 12 }, 11.99)).toBe('fits')
  })

  it('no card or no stated need is unknown, never a verdict', () => {
    expect(vramFit(zimage, null)).toBe('unknown')
    expect(vramFit(zimage, 0)).toBe('unknown')
    expect(vramFit({ vramMinGB: null, vramComfortGB: null }, 12)).toBe('unknown')
    expect(vramFit({}, 12)).toBe('unknown')
  })

  it('a file no bundle names is judged by its size, and never "needs more"', () => {
    expect(fileVramFit(6.5, 12)).toBe('fits')
    expect(fileVramFit(10.5, 12)).toBe('fits')
    expect(fileVramFit(11.5, 12)).toBe('tight')
    expect(fileVramFit(40, 12)).toBe('tight')
    expect(fileVramFit(undefined, 12)).toBe('unknown')
    expect(fileVramFit(6.5, null)).toBe('unknown')
  })
})

describe('needForInstalledFile: what the catalogue knows about a file on the disk', () => {
  it('finds the bundle that lists the file, whatever folder or case it comes in', () => {
    const all = allBundles()
    expect(needForInstalledFile('z_image_turbo_bf16.safetensors', all)).toEqual({ vramMinGB: 10, vramComfortGB: 16 })
    expect(needForInstalledFile('zimage\\Z_Image_Turbo_BF16.safetensors', all)).toEqual({ vramMinGB: 10, vramComfortGB: 16 })
    expect(needForInstalledFile('Juggernaut-XL_v9.safetensors', all)).toEqual({ vramMinGB: 6, vramComfortGB: 8 })
  })

  it('answers null for a file no bundle names, so its size decides', () => {
    expect(needForInstalledFile('some_civitai_merge.safetensors', allBundles())).toBeNull()
    expect(needForInstalledFile('', allBundles())).toBeNull()
  })

  it('answers null when two bundles list the file and disagree, or the bundle names no number', () => {
    const a = { vramMinGB: 6, vramComfortGB: 8, files: [{ filename: 'shared.safetensors' }] }
    const b = { vramMinGB: 10, vramComfortGB: 12, files: [{ filename: 'shared.safetensors' }] }
    expect(needForInstalledFile('shared.safetensors', [a, { ...a }])).toEqual({ vramMinGB: 6, vramComfortGB: 8 })
    expect(needForInstalledFile('shared.safetensors', [a, b])).toBeNull()
    expect(needForInstalledFile('x.safetensors', [{ vramMinGB: null, vramComfortGB: null, files: [{ filename: 'x.safetensors' }] }])).toBeNull()
  })
})

describe('the words', () => {
  it('names the card in all three states', () => {
    expect(vramFitLabel('fits', 12)).toBe('Fits your 12 GB card')
    expect(vramFitLabel('tight', 12)).toBe('Tight on your 12 GB card')
    expect(vramFitLabel('big', 12)).toBe('Needs more than your 12 GB card')
    expect(vramFitLine('fits', 12)).toBe('Fits your 12 GB card')
    expect(vramFitLine('tight', 12)).toBe('Tight on your 12 GB card: runs, loading can be slow')
    expect(vramFitLine('big', 12)).toBe('Needs more than your 12 GB card')
  })

  it('says nothing without a card or a verdict', () => {
    expect(vramFitLabel('fits', null)).toBe('')
    expect(vramFitLabel('unknown', 12)).toBe('')
    expect(vramFitLine('tight', null)).toBe('')
  })

  it('the tooltip states the two numbers the verdict rests on', () => {
    expect(vramNeedTitle({ vramMinGB: 10, vramComfortGB: 16 })).toBe('Runs from 10 GB. Loads fully into graphics memory from 16 GB.')
    // The box, 04.10.2026: Wan 2.2 S2V FP8 and the Qwen cards ("16 GB best,
    // offloads on less") had a tooltip without the half that says they run.
    expect(vramNeedTitle({ vramMinGB: 0, vramComfortGB: 16.8 })).toBe('Runs on smaller cards too, with part of the model kept outside graphics memory. Loads fully into graphics memory from 16.8 GB.')
    for (const b of allBundles().filter((x) => typeof x.vramMinGB === 'number')) expect(vramNeedTitle(b), b.name).toMatch(/^Runs /)
    expect(vramNeedTitle({ vramMinGB: null, vramComfortGB: null })).toBe('')
  })

  it('the waiting area speaks after a minute, and only for a model that is not a fit', () => {
    expect(SLOW_LOAD_HINT_AFTER_MS).toBe(60_000)
    expect(slowLoadHint('tight', 59_000)).toBe('')
    expect(slowLoadHint('tight', 60_000)).toBe('This model is a tight fit for your graphics memory, so loading is slow.')
    expect(slowLoadHint('big', 300_000)).toBe('This model is larger than your graphics memory, so loading is slow.')
    expect(slowLoadHint('fits', 300_000)).toBe('')
    expect(slowLoadHint('unknown', 300_000)).toBe('')
    expect(slowLoadHint('big', Number.NaN)).toBe('')
  })

  it('no line carries a dash', () => {
    const lines = [
      vramFitLine('fits', 12), vramFitLine('tight', 12), vramFitLine('big', 12),
      vramNeedTitle({ vramMinGB: 10, vramComfortGB: 16 }), vramNeedTitle({ vramMinGB: 0, vramComfortGB: 16 }), slowLoadHint('tight', 60_000), slowLoadHint('big', 60_000),
    ]
    for (const line of lines) expect(line).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('every bundle in the catalogue carries the two numbers', () => {
  /** The one entry whose text names no number: its need is the checkpoint's. */
  const NO_NUMBER = ['Krea 2 Companion Files (Text Encoder + VAE)']

  it('as the rule derives them, from its own text and files', () => {
    const all = allBundles()
    expect(all.length).toBeGreaterThan(30)
    for (const b of all) {
      const need = deriveVramNeed(b)
      if (NO_NUMBER.includes(b.name)) {
        expect(need, b.name).toBeNull()
        expect([b.vramMinGB, b.vramComfortGB], b.name).toEqual([null, null])
        continue
      }
      expect(need, b.name).not.toBeNull()
      expect(b.vramMinGB, b.name).toBe(need!.vramMinGB)
      expect(b.vramComfortGB, b.name).toBe(need!.vramComfortGB)
      expect(Number.isFinite(b.vramComfortGB), b.name).toBe(true)
      expect(b.vramComfortGB!, b.name).toBeGreaterThanOrEqual(b.vramMinGB!)
      expect(b.vramComfortGB!, b.name).toBeGreaterThan(0)
      expect(b.vramComfortGB!, b.name).toBeLessThan(99)
    }
    for (const b of getLoraAddonBundles()) expect(typeof b.vramComfortGB, b.name).toBe('number')
  })

  // Minimum, comfortable value, verdict on an 8, 12, 16 and 24 GB card. Written
  // out so a changed text or file size in the catalogue shows up here as a
  // changed verdict, and not only on somebody's card.
  const TABLE: Array<[string, number, number, string]> = [
    ['Juggernaut XL V9 (Photorealistic)', 6, 8, 'fits fits fits fits'],
    ['RealVisXL V5 (Photorealistic)', 6, 8, 'fits fits fits fits'],
    ['FLUX.1 [schnell] FP8 (Fast & Modern)', 8, 17.6, 'tight tight tight fits'],
    ['FLUX.1 [dev] FP8 (High Quality)', 8, 17.6, 'tight tight tight fits'],
    ['FLUX 2 Klein 4B (Next Gen)', 8, 10, 'tight fits fits fits'],
    ['Z-Image Turbo (Unfiltered, Fast)', 10, 16, 'big tight fits fits'],
    ['Z-Image Base (Unfiltered, Quality)', 10, 16, 'big tight fits fits'],
    // Measured on the box, 03.10.2026 (RTX 3060, 12 GB): see the test below.
    ['Qwen-Image 2.1 (Generate and Edit)', 0, 12, 'tight fits fits fits'],
    ['Qwen-Image 2.1 (No Refusals)', 0, 12, 'tight fits fits fits'],
    ['Noct Q (Qwen-Image 2.1, Unfiltered)', 0, 12, 'tight fits fits fits'],
    ['Qwen-Image 2.1 Prompt Enhancer (Official)', 0, 12, 'tight fits fits fits'],
    ['Qwen-Image 2.1 Prompt Enhancer (No Refusals)', 0, 12, 'tight fits fits fits'],
    ['DreamShaper XL Turbo V2 (Anime/Stylized)', 6, 8, 'fits fits fits fits'],
    ['ERNIE-Image Turbo', 24, 24, 'big big big fits'],
    ['ERNIE-Image Base', 24, 24, 'big big big fits'],
    ['SDXL VAE (fp16-fix) · addon', 0, 1.8, 'fits fits fits fits'],
    ['Pixel Art XL · SDXL LoRA', 0, 1.7, 'fits fits fits fits'],
    ['Wan 2.1 · 1.3B (Lightweight)', 8, 10, 'tight fits fits fits'],
    ['Wan 2.1 · 14B FP8 (High Quality)', 12, 15.5, 'big tight fits fits'],
    ['Wan 2.2 · TI2V 5B (Image + Text to Video)', 12, 12, 'big fits fits fits'],
    ['HunyuanVideo 1.5 T2V FP8 (High Quality)', 12, 12, 'big fits fits fits'],
    ['LTX Video 2.3 · 22B FP8', 16, 29, 'big big tight tight'],
    ['MiniMax H3 · Video with Sound', 24, 24, 'big big big fits'],
    ['MiniMax H3 Turbo LoRA · 8 Steps', 24, 24, 'big big big fits'],
    ['FastH3 · MiniMax H3 in 8 Steps', 24, 24, 'big big big fits'],
    ['LTX 2.5 · Video with Sound', 24, 24, 'big big big fits'],
    ['LTX 2.5 · Small (GGUF Q4)', 16, 16, 'big big fits fits'],
    ['AnimateDiff Lightning', 6, 8, 'fits fits fits fits'],
    ['AnimateDiff v3', 6, 8, 'fits fits fits fits'],
    // States its own comfortable value: built to run on 6 GB (see the test below).
    ['FramePack F1 (Image to Video)', 6, 8, 'fits fits fits fits'],
    ['SVD-XT 1.1 (Image to Video)', 12, 12, 'big fits fits fits'],
    ['Mochi 1 Preview (FP8)', 16, 16, 'big big fits fits'],
    ['NVIDIA Cosmos 7B', 24, 24, 'big big big fits'],
    ['Wan 14B Uncensored (GGUF)', 10, 12, 'big fits fits fits'],
    ['Wan 2.2 Rapid AIO (Uncensored I2V, GGUF)', 10, 12, 'big fits fits fits'],
    ['ACE Step 1.5 Turbo (Music)', 6, 10.8, 'tight fits fits fits'],
    ['YuE2 (Songs from Style and Lyrics)', 6, 8, 'fits fits fits fits'],
    ['ACE Step v1 3.5B (Music, lighter)', 4, 8.7, 'tight fits fits fits'],
    ['Wan 2.2 S2V Q4 (Talking Character, GGUF)', 10, 14.4, 'big tight fits fits'],
    ['Wan 2.2 S2V FP8 (Talking Character)', 0, 16.8, 'tight tight tight fits'],
    ['Wan VACE 1.3B (Motion Control, light)', 8, 10, 'tight fits fits fits'],
    ['Wan 2.2 Animate Q4 (Motion Control, GGUF)', 10, 12.2, 'big tight fits fits'],
  ]

  // The box, 03.10.2026: the 1.82 GB turbo LoRA read "Needs more than your
  // 12 GB card", inherited from MiniMax H3's "24+ GB". The numbers stay (sort
  // and size filters), the card shows what the add-on is for (ModelTiles).
  it('the add-ons name what they belong to', () => {
    expect(allBundles().filter((b) => b.addonFor).map((b) => [b.name, b.addonFor])).toEqual([
      ['Krea 2 Companion Files (Text Encoder + VAE)', 'Krea 2 checkpoints'],
      ['SDXL VAE (fp16-fix) · addon', 'SDXL models'],
      ['Pixel Art XL · SDXL LoRA', 'SDXL models'],
      ['MiniMax H3 Turbo LoRA · 8 Steps', 'MiniMax H3'],
    ])
    // The box, 04.10.2026: the Krea 2 companion files had neither a verdict
    // nor a "For ..." line. Every entry without a number says what it is for.
    for (const b of allBundles().filter((x) => typeof x.vramMinGB !== 'number')) expect(b.addonFor, b.name).toBeTruthy()
    // Every LoRA add-on of the catalogue is one of them.
    for (const b of getLoraAddonBundles()) expect(b.addonFor, b.name).toBeTruthy()
  })

  // The same day: FramePack's description says "runs on 6 GB VRAM", its verdict
  // said "Tight" on 12 GB, because its 15.3 GB model is larger than the card.
  // The model is built to run that way, and the bundle states so.
  it('a stated comfortable value stands against the largest-weight rule', () => {
    const framepack = allBundles().find((b) => b.name === 'FramePack F1 (Image to Video)')!
    expect(framepack.description).toContain('runs on 6 GB VRAM')
    expect(framepack.vramComfortStatedGB).toBe(8)
    expect(vramFit(framepack, 12)).toBe('fits')
    expect(vramFit(framepack, 6)).toBe('tight')
    expect(vramFit(framepack, 4)).toBe('big')
    // Without the statement the rule would raise it to the 15.3 GB weight.
    expect(deriveVramNeed({ vramRequired: '6-8 GB', files: [{ sizeGB: 15.3 }] })).toEqual({ vramMinGB: 6, vramComfortGB: 16.8 })
    expect(deriveVramNeed({ vramRequired: '6-8 GB', vramComfortStatedGB: 8, files: [{ sizeGB: 15.3 }] })).toEqual({ vramMinGB: 6, vramComfortGB: 8 })
    // Nothing else in the catalogue claims it.
    expect(allBundles().filter((b) => b.vramComfortStatedGB != null).map((b) => b.name)).toEqual(['FramePack F1 (Image to Video)'])
  })

  it('and the table of all of them holds', () => {
    const all = allBundles()
    expect(all.filter((b) => !NO_NUMBER.includes(b.name)).map((b) => b.name)).toEqual(TABLE.map((row) => row[0]))
    for (const [name, min, comfort, verdicts] of TABLE) {
      const b = all.find((x) => x.name === name)!
      expect([b.vramMinGB, b.vramComfortGB], name).toEqual([min, comfort])
      expect([8, 12, 16, 24].map((card) => vramFit(b, card)).join(' '), name).toBe(verdicts)
    }
  })

  // The box, 03.10.2026, RTX 3060 12 GB, ComfyUI 0.38.0: Qwen-Image 2.1 loads
  // cold in 46 s and makes a 768 picture in 74 s in all, peak 11.5 GB; with the
  // prompt enhancer a picture takes 160 s, peak 11.4 GB. The catalogue said
  // "16-24 GB" and "16 GB", which told the owner of that card "Needs more".
  it('the box that measured it: Qwen-Image 2.1 and its enhancers fit a 12 GB card', () => {
    const image = getImageBundles()
    const measured = [
      'Qwen-Image 2.1 (Generate and Edit)', 'Qwen-Image 2.1 (No Refusals)', 'Noct Q (Qwen-Image 2.1, Unfiltered)',
      'Qwen-Image 2.1 Prompt Enhancer (Official)', 'Qwen-Image 2.1 Prompt Enhancer (No Refusals)',
    ]
    for (const name of measured) {
      const b = image.find((x) => x.name === name)!
      expect(b.vramRequired, name).toBe('12 GB best, offloads on less')
      expect(vramFitLine(vramFit(b, 12), 12), name).toBe('Fits your 12 GB card')
      expect(vramFit(b, 8), name).toBe('tight')
    }
  })

  // Z-Image on the same card: 65 to 76 s to load cold, once 19 minutes. So the
  // tight line promises neither minutes nor speed.
  it('the tight line holds for every tight case: it names no duration', () => {
    expect(vramFitLine('tight', 12)).toBe('Tight on your 12 GB card: runs, loading can be slow')
    expect(vramFitLine('tight', 12)).not.toMatch(/minute|second/)
  })

  it('the box that raised it: Z-Image is tight on 12 GB, the add-ons fit every card', () => {
    const image = getImageBundles()
    expect(vramFitLine(vramFit(image.find((b) => b.name.startsWith('Z-Image Turbo'))!, 12), 12))
      .toBe('Tight on your 12 GB card: runs, loading can be slow')
    // Counter-check 2026-08-29: the old reader answered 99 GB to "any" and
    // stamped a 0.17 GB LoRA "Too big for your GPU".
    for (const name of ['SDXL VAE (fp16-fix) · addon', 'Pixel Art XL · SDXL LoRA']) {
      const b = image.find((x) => x.name === name)!
      expect(vramFit(b, 12), name).toBe('fits')
      expect(vramFit(b, 4), name).toBe('fits')
    }
  })
})
