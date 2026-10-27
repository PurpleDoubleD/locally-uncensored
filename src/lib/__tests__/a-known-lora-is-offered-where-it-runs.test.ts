/**
 * A LoRA whose family the app knows is offered and sent only where it runs.
 *
 * Found on 2026-10-03: after the download of the MiniMax H3 Turbo LoRA
 * (minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors in models/loras)
 * the LoRA stack in Create offered it on the image model Z-Image too, and the
 * long file name was cut off in the list.
 *
 * Since 3.0.4 a character from Character Studio goes to Z-Image only. The
 * catalogue's own LoRA add-ons now hang on the same rule: the app shipped
 * them, so it knows their family. A LoRA of unknown origin stays selectable
 * everywhere, because the app must not guess a family from a file name.
 *
 * Run: npx vitest run src/lib/__tests__/a-known-lora-is-offered-where-it-runs.test.ts
 */
import { describe, it, expect } from 'vitest'
import { knownLora, loraFitsModel, loraRows, lorasForRun, skippedLorasLine } from '../lora-stack'
import { getLoraAddonBundles } from '../../api/model-bundles'
import { classifyModel } from '../../api/comfyui'

const H3_TURBO = 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'
const PIXEL = 'pixel-art-xl.safetensors'
const CHAR = 'char_mira_zimage.safetensors'
const STYLE = 'film_grain_xl.safetensors'
const pick = (name: string, strength = 0.8) => ({ name, strength })

const Z_IMAGE = classifyModel('z_image_turbo_bf16.safetensors')
const H3 = classifyModel('minimax_h3_fl2va_bf16.safetensors')
const FAST_H3 = classifyModel('fastvideo_fasth3_8step_v2_bf16.safetensors')
const SDXL = classifyModel('juggernautXL_v9.safetensors')

describe('what the app knows about a LoRA', () => {
  it('the model types of the test are the real ones', () => {
    expect([Z_IMAGE, H3, FAST_H3, SDXL]).toEqual(['zimage', 'minimaxh3', 'minimaxh3', 'sdxl'])
  })

  it('every LoRA add-on of the catalogue is known, with its family and its catalogue name', () => {
    const addons = getLoraAddonBundles()
    expect(addons.map((b) => b.name)).toEqual(['Pixel Art XL · SDXL LoRA', 'Wan 2.1 14B Speed LoRAs · 4 Steps', 'MiniMax H3 Turbo LoRA · 8 Steps'])
    for (const b of addons) {
      for (const f of b.files) {
        expect(knownLora(f.filename!), f.filename).toEqual({ family: b.workflow, familyLabel: b.tags[0], catalogName: b.name })
      }
    }
    expect(knownLora(H3_TURBO)).toEqual({ family: 'minimaxh3', familyLabel: 'MiniMax H3', catalogName: 'MiniMax H3 Turbo LoRA · 8 Steps' })
    expect(knownLora(PIXEL)).toEqual({ family: 'sdxl', familyLabel: 'SDXL', catalogName: 'Pixel Art XL · SDXL LoRA' })
  })

  it('is found in a subfolder and whatever the case of the file name', () => {
    expect(knownLora(`video\\${H3_TURBO}`)?.family).toBe('minimaxh3')
    expect(knownLora(`video/${H3_TURBO.toUpperCase()}`)?.family).toBe('minimaxh3')
  })

  it('a character from Character Studio is a Z-Image LoRA', () => {
    expect(knownLora(CHAR)).toEqual({ family: 'zimage', familyLabel: 'Z-Image' })
  })

  it('COUNTER-CHECK: a LoRA of unknown origin is not given a family, whatever its name suggests', () => {
    for (const name of [STYLE, 'wan22_lightning_4step.safetensors', 'my_minimax_h3_style.safetensors', 'zimage_detail.safetensors', 'pixel-art-xl-v2.safetensors']) {
      expect(knownLora(name), name).toBeNull()
      for (const type of [Z_IMAGE, H3, SDXL, 'wan22', 'unknown'] as const) expect(loraFitsModel(name, type), `${name} on ${type}`).toBe(true)
    }
  })
})

describe('where a known LoRA fits', () => {
  it('the H3 turbo LoRA fits MiniMax H3 and FastH3, and no image model', () => {
    expect(loraFitsModel(H3_TURBO, H3)).toBe(true)
    expect(loraFitsModel(H3_TURBO, FAST_H3)).toBe(true)
    expect(loraFitsModel(H3_TURBO, Z_IMAGE)).toBe(false)
    expect(loraFitsModel(H3_TURBO, SDXL)).toBe(false)
    expect(loraFitsModel(H3_TURBO, 'wan22')).toBe(false)
  })

  it('Pixel Art XL fits SDXL only', () => {
    expect(loraFitsModel(PIXEL, SDXL)).toBe(true)
    expect(loraFitsModel(PIXEL, 'sd15')).toBe(false)
    expect(loraFitsModel(PIXEL, Z_IMAGE)).toBe(false)
    expect(loraFitsModel(PIXEL, H3)).toBe(false)
  })

  it('a model the app could not classify does not rule a catalogue LoRA out', () => {
    expect(loraFitsModel(PIXEL, 'unknown')).toBe(true)
    expect(loraFitsModel(H3_TURBO, 'unknown')).toBe(true)
  })

  it('a character stays with Z-Image, as since 3.0.4', () => {
    expect(loraFitsModel(CHAR, Z_IMAGE)).toBe(true)
    expect(loraFitsModel(CHAR, SDXL)).toBe(false)
    expect(loraFitsModel(CHAR, 'unknown')).toBe(false)
  })
})

describe('the rows of the stack', () => {
  const listed = [STYLE, H3_TURBO, PIXEL, CHAR]
  const labels = (type: Parameters<typeof loraRows>[2], picks = [] as ReturnType<typeof pick>[]) =>
    loraRows(listed, picks, type).map((r) => (r.fits ? r.label : `${r.label} [${r.familyLabel} only]`))

  it('the reported case: Z-Image does not offer the H3 turbo LoRA', () => {
    expect(labels(Z_IMAGE)).toEqual(['film_grain_xl', 'char_mira_zimage'])
  })

  it('MiniMax H3 offers it, under its catalogue name with the file name as the tooltip', () => {
    const rows = loraRows(listed, [], H3)
    expect(rows.map((r) => r.label)).toEqual(['film_grain_xl', 'MiniMax H3 Turbo LoRA · 8 Steps', 'char_mira_zimage'])
    const turbo = rows[1]
    expect(turbo).toEqual({ name: H3_TURBO, label: 'MiniMax H3 Turbo LoRA · 8 Steps', file: H3_TURBO, fits: true })
    // The character keeps its row and says where it belongs.
    expect(rows[2]).toMatchObject({ fits: false, familyLabel: 'Z-Image' })
  })

  it('SDXL offers Pixel Art XL and not the turbo LoRA', () => {
    expect(labels(SDXL)).toEqual(['film_grain_xl', 'Pixel Art XL · SDXL LoRA', 'char_mira_zimage [Z-Image only]'])
  })

  it('a catalogue LoRA that is still ticked on another model keeps its row, so it can be turned off', () => {
    expect(labels(Z_IMAGE, [pick(H3_TURBO)])).toEqual(['film_grain_xl', 'MiniMax H3 Turbo LoRA · 8 Steps [MiniMax H3 only]', 'char_mira_zimage'])
  })

  it('the name a row sends is the one ComfyUI lists, subfolder included', () => {
    const inFolder = `video\\${H3_TURBO}`
    expect(loraRows([inFolder], [], H3)).toEqual([{ name: inFolder, label: 'MiniMax H3 Turbo LoRA · 8 Steps', file: H3_TURBO, fits: true }])
  })

  it('a file of unknown origin reads as its name without the ending', () => {
    expect(loraRows(['styles\\Film Grain.safetensors'], [], Z_IMAGE)).toEqual([
      { name: 'styles\\Film Grain.safetensors', label: 'styles\\Film Grain', file: 'Film Grain.safetensors', fits: true },
    ])
  })
})

describe('what a run sends', () => {
  it('Z-Image leaves a ticked H3 turbo LoRA out and says so', () => {
    const r = lorasForRun([pick(H3_TURBO), pick(STYLE)], [H3_TURBO, STYLE], Z_IMAGE)
    expect(r.use).toEqual([pick(STYLE)])
    expect(r.otherModel).toEqual([H3_TURBO])
    expect(skippedLorasLine(r.missing, r.otherModel)).toBe('Skipping LoRA MiniMax H3 only: MiniMax H3 Turbo LoRA · 8 Steps')
  })

  it('MiniMax H3 sends it', () => {
    const r = lorasForRun([pick(H3_TURBO, 1)], [H3_TURBO], H3)
    expect(r.use).toEqual([pick(H3_TURBO, 1)])
    expect(r.otherModel).toEqual([])
  })

  it('characters and catalogue LoRAs each get their own part of the line', () => {
    expect(skippedLorasLine(['gone.safetensors'], [CHAR, PIXEL]))
      .toBe('Skipping LoRA no longer in models/loras: gone; Z-Image characters only: char_mira_zimage; SDXL only: Pixel Art XL · SDXL LoRA')
  })
})
