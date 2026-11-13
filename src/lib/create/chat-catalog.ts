// MIRRORED from the web app (lib/create/chat-catalog.ts), without its comments. Do not edit here.
// scripts/create-chat-mirror.mjs writes this file, and web-parity.test.ts
// holds it to its source. Only the import paths differ, the places listed
// under PATCHES in that script, and the classes under CLASSES.
import type { CreateIntent } from './bridge/create-store'
import type { RenderKind } from '../render/cloud-jobs'
import {
  cloudModelById, cloudModelsFor, editCapableModels, i2vModels, opPickerModels, t2vModels,
} from './bridge/cloud-models'
import { intentPickerModels } from '../render/create-studio'
import { presetModels, studioOnlyImageModels, type StepRole } from './bridge/preset-models'
import { STUDIO_MODELS, supportsProviderField } from '../render/studio-contract'
import { videoDurations } from '../render/video-duration'
import { MUSIC_SECONDS } from './bridge/credits'
import { CREATE_PRESETS, type CreatePreset } from '../render/create-presets'

export const CHAT_INTENTS: readonly CreateIntent[] = [
  'image', 'edit', 'removebg', 'upscale', 'eraser', 'character',
  'video', 'animate', 'extend', 'video_upscale', 'lipsync', 'motion', 'music',
]

export const ERASE_REFUSAL =
  'Erase needs a painted mask, which a chat cannot draw. Use intent "edit" and describe what to remove, '
  + 'or erase it by hand in the Create tab.'

export type ChatEngine = 'create' | 'step'

export interface ChatModel {
  id: string
  label: string
  kind: RenderKind
  adult: boolean
  engine: ChatEngine
  role?: StepRole
}

export const INTENT_LABEL: Record<CreateIntent, string> = {
  image: 'Image', edit: 'Edit image', removebg: 'Remove background', upscale: 'Enhance image', eraser: 'Erase',
  character: 'Character Studio', video: 'Video', animate: 'Animate image', extend: 'Extend clip',
  video_upscale: 'Enhance video', lipsync: 'Talking character', motion: 'Motion transfer', music: 'Music',
  '3d': '3D model',
}

export const INTENT_KIND: Record<CreateIntent, RenderKind> = {
  image: 'image', edit: 'image', removebg: 'image', upscale: 'image', eraser: 'image', character: 'image',
  video: 'video', animate: 'video', extend: 'video', video_upscale: 'video', lipsync: 'video', motion: 'video',
  music: 'audio', '3d': '3d',
}

function create(m: { id: string; label: string; kind: RenderKind; adult?: boolean }): ChatModel {
  return { id: m.id, label: m.label, kind: m.kind, adult: m.adult === true, engine: 'create' }
}

function studioSteps(role: StepRole, skip: Set<string>): ChatModel[] {
  return presetModels(role)
    .filter((m) => m.op === 'studio' && !skip.has(m.id) && !skip.has(STUDIO_MODELS[m.id]?.sourceModel ?? ''))
    .map((m) => ({ id: m.id, label: m.label, kind: m.kind, adult: m.adult, engine: 'step' as const, role }))
}

export function intentModels(intent: CreateIntent): ChatModel[] {
  switch (intent) {
    case 'image':
      return [...cloudModelsFor('image').map(create), ...studioOnlyImageModels().map(create)]
    case 'edit': {
      const classic = editCapableModels().filter((m) => m.maskless).map(create)
      return [...classic, ...studioSteps('edit', new Set(classic.map((m) => m.id)))]
    }
    case 'video':
      return t2vModels().map(create)
    case 'animate': {
      const classic = i2vModels().map(create)
      return [...classic, ...studioSteps('animate', new Set(classic.map((m) => m.id)))]
    }
    case 'character':
      return opPickerModels('lora-train').map(create)
    case 'extend': case 'video_upscale': case 'lipsync': case 'motion': case 'music':
      return intentPickerModels(intent).map(create)
    default:
      return []
  }
}

export function speechModels(): ChatModel[] {
  return presetModels('speech').map((m) => ({ id: m.id, label: m.label, kind: m.kind, adult: m.adult, engine: 'step' as const, role: 'speech' }))
}

interface Marked {
  adult: boolean
}

export function visible<T extends Marked>(list: T[], all: boolean): T[] {
  return all ? list : list.filter((m) => !m.adult)
}

const presetKey = (text: string) => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function presetById(id: string): CreatePreset | undefined {
  const exact = CREATE_PRESETS.find((p) => p.id === id)
  if (exact) return exact
  const key = presetKey(id)
  return key ? CREATE_PRESETS.find((p) => p.id === key || presetKey(p.title) === key) : undefined
}

export function visiblePresets(all: boolean): CreatePreset[] {
  return CREATE_PRESETS.filter((p) => all || !p.adult)
}

export interface OptionSpec {
  type: 'string' | 'integer' | 'number' | 'boolean'
  enum?: readonly (string | number)[]
  minimum?: number
  maximum?: number
  default?: unknown
  description?: string
}

export const IMAGE_ASPECTS: Record<string, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '3:4': { width: 768, height: 1024 },
  '4:3': { width: 1024, height: 768 },
  '16:9': { width: 1024, height: 576 },
}
export const VIDEO_ASPECTS: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
}

export const QWEN_VOICES = ['Serena', 'Vivian', 'Ryan', 'Aiden', 'Dylan', 'Eric', 'Sohee', 'Ono_Anna', 'Uncle_Fu'] as const

const SEED: OptionSpec = { type: 'integer', minimum: 0, maximum: 2147483647, description: 'fixed seed; omit for random' }
const NEGATIVE: OptionSpec = { type: 'string', description: 'what must not appear' }

export function classicOptions(intent: CreateIntent, model: string): Record<string, OptionSpec> {
  const out: Record<string, OptionSpec> = {}
  const op = intent === 'animate' ? 'animate' : intent === 'edit' ? 'edit' : 'generate'
  if (intent === 'image' || intent === 'video' || intent === 'animate' || intent === 'edit') {
    if (supportsProviderField(model, 'negative_prompt', op)) out.negative_prompt = NEGATIVE
    out.seed = SEED
  }
  if (intent === 'image') out.aspect = { type: 'string', enum: Object.keys(IMAGE_ASPECTS), default: '1:1' }
  if (intent === 'video') out.aspect = { type: 'string', enum: Object.keys(VIDEO_ASPECTS), default: '16:9' }
  if (intent === 'video' || intent === 'animate') {
    const lengths = videoDurations(model)
    out.duration = { type: 'integer', enum: lengths, default: lengths[0] ?? 5, description: 'seconds' }
  }
  if (intent === 'music') {
    out.duration = { type: 'integer', minimum: MUSIC_SECONDS.min, maximum: MUSIC_SECONDS.max, default: 60, description: 'seconds' }
    if (cloudModelById(model)?.supportsLyrics) out.lyrics = { type: 'string', description: 'song lyrics' }
  }
  if (intent === 'character') {
    out.mode = { type: 'string', enum: ['train', 'use'], default: 'train', description: 'train a new character or create an image with a trained one' }
    out.trigger_word = { type: 'string', description: 'train: the word that summons the character' }
    out.character = { type: 'string', description: 'use: the id of a trained character from the shelf' }
    out.aspect = { type: 'string', enum: Object.keys(IMAGE_ASPECTS), default: '1:1' }
    out.seed = SEED
  }
  return out
}

export function stepClassicOptions(role: StepRole, model: string): Record<string, OptionSpec> {
  const out: Record<string, OptionSpec> = {}
  if (role === 'animate') {
    const lengths = videoDurations(model)
    out.duration = { type: 'integer', enum: lengths, default: 5, description: 'seconds' }
    if (supportsProviderField(model, 'shot_type', 'animate')) out.shot_type = { type: 'string', enum: ['single', 'multi'], default: 'single' }
    if (supportsProviderField(model, 'negative_prompt', 'animate')) out.negative_prompt = NEGATIVE
  }
  if (role === 'image' && supportsProviderField(model, 'negative_prompt', 'generate')) out.negative_prompt = NEGATIVE
  if (role === 'speech' && model === 'qwen3-tts') out.voice = { type: 'string', enum: QWEN_VOICES, default: 'Serena' }
  if (role === 'speech' && model === 'qwen3-tts-design') out.voice_description = { type: 'string', description: 'describe the voice' }
  return out
}

export function checkOptions(options: Record<string, unknown>, spec: Record<string, OptionSpec>): void {
  for (const [key, value] of Object.entries(options)) {
    const s = spec[key]
    if (!s) {
      const names = Object.keys(spec)
      throw new Error(`Unsupported option "${key}". ${names.length ? `Allowed: ${names.join(', ')}.` : 'This model takes no options.'}`)
    }
    if (s.enum && !s.enum.includes(value as string | number)) {
      throw new Error(`Option "${key}" must be one of: ${s.enum.join(', ')}.`)
    }
    const typeOk = s.type === 'string' ? typeof value === 'string' && value.length <= 4000
      : s.type === 'boolean' ? typeof value === 'boolean'
      : typeof value === 'number' && Number.isFinite(value) && (s.type === 'number' || Number.isInteger(value))
    if (!typeOk) throw new Error(`Option "${key}" must be ${s.type === 'integer' ? 'a whole number' : `a ${s.type}`}.`)
    if (typeof value === 'number' && ((s.minimum !== undefined && value < s.minimum) || (s.maximum !== undefined && value > s.maximum))) {
      throw new Error(`Option "${key}" must be between ${s.minimum} and ${s.maximum}.`)
    }
  }
}
