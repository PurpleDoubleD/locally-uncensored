// What a Create run does with the character on the chip (3.0.7, characters
// everywhere). Image and Edit put the character's LoRA and trigger word into
// the run itself. Every video lane makes a start image of the character first
// (lib/characters.ts, characterStartImage) and then runs the video from it.
// The decisions live here, away from the hook, so each lane is tested alone.
import { canRunVideoIntent, runnableVideoLaneModels, type ClassifiedModel, type ModelType } from '../api/comfyui'
import { parseLocalCharacterLora } from '../api/trainer'
import { characterRunBlock } from './character-base'
import { characterLoraFile, withTriggerWord, type CharacterRef } from './characters'
import type { LoraPick } from './lora-stack'

/** The tabs that render the character into the picture itself. */
export const CHARACTER_IMAGE_LANES: ReadonlySet<string> = new Set(['image', 'edit'])
/** The tabs that start from an image of the character. */
export const CHARACTER_VIDEO_LANES: ReadonlySet<string> = new Set(['video', 'animate', 'extend', 'lipsync', 'motion'])

export const EDIT_MASK_NO_CHARACTER =
  'A character in Edit works without a mask. Z Image cannot paint into a masked area. Clear the mask to use the character.'

/** Box run d307-d: without a model for the tab, step 1 rendered the
 *  character's image for minutes and only then step 2 said that no video
 *  model was selected. The run is now refused before step 1. */
export const CHARACTER_NO_VIDEO_MODEL =
  'This tab has no video model installed, so no video can start from your character. Install one with Download & install above, or remove the character.'

export type CharacterRunPlan =
  /** Nothing to do: no character, or a tab without characters. */
  | { kind: 'none' }
  /** The run cannot start; the reason is for the user. */
  | { kind: 'error'; message: string }
  /** Image or Edit: LoRA and trigger word ride in this run. */
  | { kind: 'image'; file: string }
  /** A video lane: step 1 makes the start image, step 2 runs the video. */
  | { kind: 'chain'; file: string }
  /** A video lane with a start image of the user's own: that image wins. */
  | { kind: 'source-wins' }

export interface CharacterRunInput {
  intent: string
  character: CharacterRef | null
  hasSource: boolean
  hasMask: boolean
  /** Image and Edit: the type of the model the run takes. */
  imageModelType: ModelType
  /** Image and Edit: whether a model of the character's family is installed. */
  baseInstalled: boolean
  /** Video: the video model the run takes ('' for the lanes with their own model). */
  videoModel: string
  /** Video: true when no installed model can run step 2 of this tab
   *  (characterVideoLaneEmpty). Left out on the Mac, which knows its own. */
  videoLaneEmpty?: boolean
}

/** The model lists step 2 of a chain reads on ComfyUI. */
export interface CharacterVideoLists {
  video: ClassifiedModel[]
  lipsync: ClassifiedModel[]
  motion: ClassifiedModel[]
}

/** True when no installed ComfyUI model can run step 2 of the video tab
 *  `intent`: Talking Character and Motion Control read their own lists, the
 *  other tabs the video models that tab can run. */
export function characterVideoLaneEmpty(intent: string, lists: CharacterVideoLists): boolean {
  if (!CHARACTER_VIDEO_LANES.has(intent)) return false
  if (intent === 'lipsync') return lists.lipsync.length === 0
  if (intent === 'motion') return lists.motion.length === 0
  return runnableVideoLaneModels(lists.video, intent).length === 0
}

/** What this run does with the character. */
export function characterRunPlan(input: CharacterRunInput): CharacterRunPlan {
  const file = characterLoraFile(input.character)
  if (!file || !input.character) return { kind: 'none' }
  if (CHARACTER_IMAGE_LANES.has(input.intent)) {
    if (input.intent === 'edit' && input.hasMask) return { kind: 'error', message: EDIT_MASK_NO_CHARACTER }
    const block = characterRunBlock(file, input.imageModelType, input.baseInstalled)
    return block ? { kind: 'error', message: block } : { kind: 'image', file }
  }
  if (!CHARACTER_VIDEO_LANES.has(input.intent)) return { kind: 'none' }
  if (input.hasSource) return { kind: 'source-wins' }
  if (input.videoLaneEmpty) return { kind: 'error', message: CHARACTER_NO_VIDEO_MODEL }
  // Text to video turns into a run from the character's image, which only a
  // model that takes a start image can do.
  if (input.intent === 'video' && input.videoModel && !canRunVideoIntent(input.videoModel, 'animate')) {
    return {
      kind: 'error',
      message: `${input.videoModel} makes video from text only and cannot start from your character. Pick a model that takes a start image (Wan 2.2, LTX) or remove the character.`,
    }
  }
  return { kind: 'chain', file }
}

/**
 * The prompt of the character's start image. Talking Character and Motion
 * Control have no prompt field, so the picture is a plain one the video can
 * work from; the other lanes describe their scene in the prompt.
 */
export function characterImagePrompt(intent: string, prompt: string, trigger: string): string {
  if (intent === 'lipsync') return withTriggerWord('portrait photo, head and shoulders, facing the camera, mouth closed, soft light, plain background', trigger)
  if (intent === 'motion') return withTriggerWord('full body photo, standing, facing the camera, arms relaxed, plain background', trigger)
  return withTriggerWord(prompt, trigger)
}

/** The size of the start image: the video's shape, its long side at 1024,
 *  both sides on the 16 grid Z Image renders on. */
export function characterImageSize(width: number, height: number): { width: number; height: number } {
  const w = width > 0 ? width : 1024
  const h = height > 0 ? height : 1024
  const scale = 1024 / Math.max(w, h)
  const snap = (v: number) => Math.max(256, Math.round((v * scale) / 16) * 16)
  return { width: snap(w), height: snap(h) }
}

const isCharacterLora = (name: string) => parseLocalCharacterLora(name) !== null

/** The stack with this character's LoRA in it and no other character. */
export function withCharacterLora(picks: LoraPick[], file: string, strength: number): LoraPick[] {
  const rest = picks.filter((p) => !isCharacterLora(p.name))
  const own = picks.find((p) => p.name === file)
  return [...rest, own ?? { name: file, strength }]
}

/** The stack without any character LoRA, for the video step. */
export function withoutCharacterLoras(picks: LoraPick[]): LoraPick[] {
  return picks.filter((p) => !isCharacterLora(p.name))
}
