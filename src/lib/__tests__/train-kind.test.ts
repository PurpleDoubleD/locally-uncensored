/**
 * 3.0.9 P8: the Style / concept mode of the local trainer (lib/train-kind.ts).
 * Run: npx vitest run src/lib/__tests__/train-kind.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildStyleCaption, trainedLoraFile, trainPresetsFor, trainStepsDefaultFor, STYLE_TRAIN_PRESETS,
  STYLE_TRAIN_STEPS_DEFAULT, DESCRIBE_STYLE_SYSTEM, isTrainKind,
} from '../train-kind'
import { TRAIN_PRESETS, TRAIN_STEPS_DEFAULT, trainStepsNote } from '../trainer-presets'
import { knownLora, loraRows } from '../lora-stack'
import { parseLocalCharacterLora, parseLocalStyleLora } from '../../api/trainer'
import { useCreateStore } from '../../stores/createStore'

describe('style captions', () => {
  it('lead with the trigger word and never say "a photo of"', () => {
    expect(buildStyleCaption('inkwash', 'a fox in a forest')).toBe('inkwash, a fox in a forest')
    expect(buildStyleCaption('inkwash', '')).toBe('inkwash')
    expect(buildStyleCaption('inkwash', null)).toBe('inkwash')
    expect(buildStyleCaption('inkwash', 'a fox')).not.toContain('photo')
  })

  it('without a trigger word are the description alone, cleaned like a character\'s', () => {
    expect(buildStyleCaption('', '  a fox,\n in a forest. ')).toBe('a fox, in a forest')
    expect(buildStyleCaption('', '')).toBe('')
  })
})

describe('the style file', () => {
  it('is named like the Rust trainer names it (sanitize_component, TrainKind::output_name)', () => {
    expect(trainedLoraFile('style', 'inkwash')).toBe('style_inkwash_zimage.safetensors')
    expect(trainedLoraFile('character', 'anna')).toBe('char_anna_zimage.safetensors')
    expect(trainedLoraFile('style', 'ink wash!')).toBe('style_ink_wash_zimage.safetensors')
    expect(trainedLoraFile('style', '__x__')).toBe('style_x_zimage.safetensors')
    const rust = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src-tauri', 'src', 'commands', 'trainer.rs'), 'utf8')
    expect(rust).toContain('TrainKind::Style => format!("style_{name}_zimage")')
    expect(rust).toContain(".take(48)")
  })

  it('is no character, but a Z-Image LoRA the stack offers with its strength', () => {
    const f = 'style_inkwash_zimage.safetensors'
    expect(parseLocalCharacterLora(f)).toBeNull()
    expect(parseLocalStyleLora(f)).toEqual({ file: f, name: 'inkwash' })
    expect(parseLocalStyleLora('sub/style_a_b_zimage.safetensors')?.name).toBe('a_b')
    expect(parseLocalStyleLora('char_anna_zimage.safetensors')).toBeNull()
    expect(knownLora(f)).toEqual({ family: 'zimage', familyLabel: 'Z-Image' })
    expect(loraRows([f], [], 'zimage')[0]).toMatchObject({ name: f, fits: true })
    expect(loraRows([f], [], 'flux')[0]).toMatchObject({ fits: false, familyLabel: 'Z-Image' })
  })
})

describe('the style presets', () => {
  it('are three, longer than the character ones, with Standard as default', () => {
    expect(STYLE_TRAIN_PRESETS.map((p) => p.label)).toEqual(TRAIN_PRESETS.map((p) => p.label))
    expect(STYLE_TRAIN_PRESETS.map((p) => p.steps)).toEqual([600, 1600, 3000])
    expect(STYLE_TRAIN_PRESETS.find((p) => p.label === 'Standard')?.steps).toBe(STYLE_TRAIN_STEPS_DEFAULT)
    expect(trainPresetsFor('character')).toBe(TRAIN_PRESETS)
    expect(trainStepsDefaultFor('character')).toBe(TRAIN_STEPS_DEFAULT)
    // Inside the clamp of both trainers (100..4000).
    for (const p of STYLE_TRAIN_PRESETS) expect(p.steps).toBeGreaterThanOrEqual(100)
    for (const p of STYLE_TRAIN_PRESETS) expect(p.steps).toBeLessThanOrEqual(4000)
  })

  it('name their level in the note', () => {
    expect(trainStepsNote(1600, STYLE_TRAIN_PRESETS)).toBe('Standard, 1600 steps')
    expect(trainStepsNote(1600)).toBe('1600 steps')
  })
})

describe('the mode in the store', () => {
  beforeEach(() => useCreateStore.setState({ trainKind: 'character', trainSteps: 1200 } as never))

  it('takes the steps of the other mode along when they match none of its presets', () => {
    const s = useCreateStore.getState()
    s.setTrainKind('style')
    expect(useCreateStore.getState().trainSteps).toBe(1600)
    s.setTrainKind('character')
    expect(useCreateStore.getState().trainSteps).toBe(1200)
    useCreateStore.setState({ trainSteps: 400 } as never)
    s.setTrainKind('style')
    expect(useCreateStore.getState().trainSteps).toBe(1600)
  })

  it('turns an unknown mode into a character', () => {
    useCreateStore.getState().setTrainKind('pose' as never)
    expect(useCreateStore.getState().trainKind).toBe('character')
    expect(isTrainKind('style')).toBe(true)
    expect(isTrainKind('pose')).toBe(false)
  })
})

describe('Describe photos in style mode', () => {
  it('names the content and leaves the style out', () => {
    expect(DESCRIBE_STYLE_SYSTEM).toMatch(/style LoRA/)
    expect(DESCRIBE_STYLE_SYSTEM).toMatch(/Never describe the art style/)
    expect(DESCRIBE_STYLE_SYSTEM).toMatch(/never name an artist/)
  })
})
