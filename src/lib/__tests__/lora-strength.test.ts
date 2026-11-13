/**
 * The strength of a LoRA in the stack (Discord 2026-10-02).
 * The stack stopped at 0 to 2; slider LoRAs, the Krea 2 ones above all, are
 * made for about -10 to 10, some for -10 to 15 (Discord 2026-10-23), so the
 * field takes -20 to 20. ComfyUI itself takes -100 to 100 on LoraLoader
 * and LoraLoaderModelOnly (nodes.py, strength_model and strength_clip).
 *
 * Run: npx vitest run src/lib/__tests__/lora-strength.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  LORA_STRENGTH_MAX, LORA_STRENGTH_MIN, LORA_STRENGTH_STEP, LORA_SLIDER_MAX, LORA_SLIDER_MIN,
  clampLoraStrength, defaultLoraStrength, parseLoraStrength, stepLoraStrength,
} from '../lora-strength'

describe('the range', () => {
  it('is -20 to 20 in steps of 0.05, inside what ComfyUI accepts, and the slider covers -2 to 2', () => {
    expect([LORA_STRENGTH_MIN, LORA_STRENGTH_MAX, LORA_STRENGTH_STEP]).toEqual([-20, 20, 0.05])
    expect(LORA_STRENGTH_MIN).toBeGreaterThanOrEqual(-100)
    expect(LORA_STRENGTH_MAX).toBeLessThanOrEqual(100)
    expect([LORA_SLIDER_MIN, LORA_SLIDER_MAX]).toEqual([-2, 2])
  })

  it('clamps at both ends and keeps two decimals', () => {
    expect(clampLoraStrength(20)).toBe(20)
    expect(clampLoraStrength(20.01)).toBe(20)
    expect(clampLoraStrength(250)).toBe(20)
    expect(clampLoraStrength(-20)).toBe(-20)
    expect(clampLoraStrength(-20.01)).toBe(-20)
    expect(clampLoraStrength(-999)).toBe(-20)
    expect(clampLoraStrength(15)).toBe(15)
    expect(clampLoraStrength(-10)).toBe(-10)
    expect(clampLoraStrength(0.8)).toBe(0.8)
    expect(clampLoraStrength(-3.456)).toBe(-3.46)
    expect(clampLoraStrength(1.2345)).toBe(1.23)
  })

  it('never hands out a negative zero', () => {
    expect(Object.is(clampLoraStrength(-0.001), 0)).toBe(true)
    expect(Object.is(clampLoraStrength(-0), 0)).toBe(true)
  })
})

describe('what a typed strength means', () => {
  it('plain numbers, negative ones included', () => {
    expect(parseLoraStrength('1')).toBe(1)
    expect(parseLoraStrength('0.85')).toBe(0.85)
    expect(parseLoraStrength('-4')).toBe(-4)
    expect(parseLoraStrength('-0.35')).toBe(-0.35)
    expect(parseLoraStrength('+2.5')).toBe(2.5)
    expect(parseLoraStrength('.5')).toBe(0.5)
    expect(parseLoraStrength('-.5')).toBe(-0.5)
    expect(parseLoraStrength('3.')).toBe(3)
    expect(parseLoraStrength('  7  ')).toBe(7)
    expect(parseLoraStrength('0')).toBe(0)
  })

  it('a decimal comma is a point', () => {
    expect(parseLoraStrength('1,5')).toBe(1.5)
    expect(parseLoraStrength('-2,25')).toBe(-2.25)
  })

  it('out of range is pulled to the nearest end', () => {
    expect(parseLoraStrength('15')).toBe(15)
    expect(parseLoraStrength('-15')).toBe(-15)
    expect(parseLoraStrength('25')).toBe(20)
    expect(parseLoraStrength('-25')).toBe(-20)
    expect(parseLoraStrength('99999999999999999999')).toBe(20)
  })

  it('half typed values and typos are not a number', () => {
    for (const typo of ['', ' ', '-', '+', '.', '-.', ',', 'abc', '1.2.3', '1,2,3', '1e3', '--1', '1-', '0x10', 'NaN', 'Infinity', '1 2', '1.5x']) {
      expect(parseLoraStrength(typo), JSON.stringify(typo)).toBeNull()
    }
  })
})

describe('the arrow keys', () => {
  it('move by one step without float dust, and stop at the ends', () => {
    expect(stepLoraStrength(0.8, 1)).toBe(0.85)
    expect(stepLoraStrength(0.8, -1)).toBe(0.75)
    expect(stepLoraStrength(0, -1)).toBe(-0.05)
    expect(stepLoraStrength(-0.05, 1)).toBe(0)
    expect(stepLoraStrength(0.1, 1)).toBe(0.15)
    expect(stepLoraStrength(20, 1)).toBe(20)
    expect(stepLoraStrength(-20, -1)).toBe(-20)
  })
})

describe('the strength a LoRA starts with', () => {
  it('a step distillation starts at 1, the way the official H3 templates load it', () => {
    expect(defaultLoraStrength('minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors')).toBe(1)
    expect(defaultLoraStrength('minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors')).toBe(1)
  })

  it('everything else starts at 0.8, a model that merely says turbo too', () => {
    expect(defaultLoraStrength('film_grain_xl.safetensors')).toBe(0.8)
    expect(defaultLoraStrength('char_mira_zimage.safetensors')).toBe(0.8)
    expect(defaultLoraStrength('z_image_turbo_style.safetensors')).toBe(0.8)
  })
})
