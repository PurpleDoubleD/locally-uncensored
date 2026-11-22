/**
 * Characters everywhere (3.0.7): what a run does with the character on the
 * chip, lane by lane (lib/character-run.ts).
 *
 * Run: npx vitest run src/lib/__tests__/character-run-plan.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  CHARACTER_NO_VIDEO_MODEL, EDIT_MASK_NO_CHARACTER, characterImagePrompt, characterImageSize, characterRunPlan,
  characterVideoLaneEmpty, withCharacterLora, withoutCharacterLoras, type CharacterRunInput,
} from '../character-run'
import type { ClassifiedModel } from '../../api/comfyui'

const CHAR = 'char_mira_zimage.safetensors'
const MIRA = { id: `local:${CHAR}`, name: 'mira', triggerWord: 'mira', family: 'zimage' }
const base: CharacterRunInput = {
  intent: 'image', character: MIRA, hasSource: false, hasMask: false, imageModelType: 'zimage', baseInstalled: true, videoModel: '',
}

describe('characterRunPlan', () => {
  it('no character, a cloud character or a tab without characters: nothing', () => {
    expect(characterRunPlan({ ...base, character: null })).toEqual({ kind: 'none' })
    expect(characterRunPlan({ ...base, character: { ...MIRA, id: 'cloud-1' } })).toEqual({ kind: 'none' })
    expect(characterRunPlan({ ...base, intent: 'music' })).toEqual({ kind: 'none' })
  })

  it('Image and Edit on Z Image run with the character', () => {
    expect(characterRunPlan(base)).toEqual({ kind: 'image', file: CHAR })
    expect(characterRunPlan({ ...base, intent: 'edit', hasSource: true })).toEqual({ kind: 'image', file: CHAR })
  })

  it('Image on another model, Edit with a mask: the reason', () => {
    expect(characterRunPlan({ ...base, imageModelType: 'sdxl' })).toMatchObject({ kind: 'error', message: expect.stringMatching(/trained for Z Image/) })
    expect(characterRunPlan({ ...base, imageModelType: 'sdxl', baseInstalled: false })).toMatchObject({ message: expect.stringMatching(/no Z Image model is installed/) })
    expect(characterRunPlan({ ...base, intent: 'edit', hasMask: true })).toEqual({ kind: 'error', message: EDIT_MASK_NO_CHARACTER })
  })

  it('every video lane chains, a start image of the user wins', () => {
    for (const intent of ['video', 'animate', 'extend', 'lipsync', 'motion']) {
      expect(characterRunPlan({ ...base, intent, videoModel: intent === 'video' ? 'wan2.2_ti2v_5B.safetensors' : '' })).toEqual({ kind: 'chain', file: CHAR })
      if (intent !== 'video') expect(characterRunPlan({ ...base, intent, hasSource: true })).toEqual({ kind: 'source-wins' })
    }
  })

  // Box run d307-d: with no video model the chain rendered the character's
  // image for minutes, then step 2 said "No video model selected".
  it('a video tab without a model refuses before the character image', () => {
    for (const intent of ['video', 'animate', 'extend', 'lipsync', 'motion']) {
      expect(characterRunPlan({ ...base, intent, videoLaneEmpty: true })).toEqual({ kind: 'error', message: CHARACTER_NO_VIDEO_MODEL })
    }
    expect(characterRunPlan({ ...base, intent: 'image', videoLaneEmpty: true })).toEqual({ kind: 'image', file: CHAR })
  })

  it('Video on a text only model says why', () => {
    expect(characterRunPlan({ ...base, intent: 'video', videoModel: 'wan2.1_t2v_1.3B.safetensors' }))
      .toMatchObject({ kind: 'error', message: expect.stringMatching(/makes video from text only/) })
  })
})

describe('the start image', () => {
  it('prompts: the scene with the trigger word, a portrait to speak, a full body to move', () => {
    expect(characterImagePrompt('video', 'on a boat', 'mira')).toBe('mira, on a boat')
    expect(characterImagePrompt('lipsync', 'ignored', 'mira')).toMatch(/^mira, portrait photo/)
    expect(characterImagePrompt('motion', '', 'mira')).toMatch(/^mira, full body photo/)
  })

  it('takes the video shape with the long side at 1024 on the 16 grid', () => {
    expect(characterImageSize(832, 480)).toEqual({ width: 1024, height: 592 })
    expect(characterImageSize(480, 832)).toEqual({ width: 592, height: 1024 })
    expect(characterImageSize(0, 0)).toEqual({ width: 1024, height: 1024 })
  })
})

describe('the LoRA stack', () => {
  it('one character at a time, the user strength kept, no character on the video', () => {
    const stack = [{ name: 'grain.safetensors', strength: 0.5 }, { name: 'char_zoe_zimage.safetensors', strength: 1 }]
    expect(withCharacterLora(stack, CHAR, 0.8)).toEqual([{ name: 'grain.safetensors', strength: 0.5 }, { name: CHAR, strength: 0.8 }])
    expect(withCharacterLora([{ name: CHAR, strength: 0.6 }], CHAR, 1)).toEqual([{ name: CHAR, strength: 0.6 }])
    expect(withoutCharacterLoras([...stack, { name: CHAR, strength: 1 }])).toEqual([{ name: 'grain.safetensors', strength: 0.5 }])
  })
})

describe('characterVideoLaneEmpty', () => {
  const m = (name: string): ClassifiedModel => ({ name, type: 'unknown', source: 'diffusion_model' })
  const none = { video: [], lipsync: [], motion: [] }
  it('every video tab without its model is empty, Image and Edit never are', () => {
    for (const intent of ['video', 'animate', 'extend', 'lipsync', 'motion']) expect(characterVideoLaneEmpty(intent, none)).toBe(true)
    expect(characterVideoLaneEmpty('image', none)).toBe(false)
    expect(characterVideoLaneEmpty('edit', none)).toBe(false)
  })
  it('a tab counts the models it can run', () => {
    const lists = { video: [m('wan2.1_t2v_1.3B.safetensors')], lipsync: [m('wan2.2_s2v_14B.safetensors')], motion: [] }
    expect(characterVideoLaneEmpty('video', lists)).toBe(false)
    expect(characterVideoLaneEmpty('animate', lists)).toBe(true)
    expect(characterVideoLaneEmpty('lipsync', lists)).toBe(false)
    expect(characterVideoLaneEmpty('motion', lists)).toBe(true)
  })
})
