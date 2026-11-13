// MIRRORED from the web app (lib/create/chat-tools.ts), without its comments. Do not edit here.
// scripts/create-chat-mirror.mjs writes this file, and web-parity.test.ts
// holds it to its source. Only the import paths differ, the places listed
// under PATCHES in that script, and the classes under CLASSES.
import type { CreateIntent } from './bridge/create-store'
import { cloudModelById } from './bridge/cloud-models'
import { STUDIO_MODELS, studioBaseCredits, studioFields, studioSchema, type Schema } from '../render/studio-contract'
import { mediaCredits, lengthPrice, lengthCredits } from './bridge/credits'
import { modelHint, type StepRole } from './bridge/preset-models'
import type { CreatePreset } from '../render/create-presets'
import { videoDurations } from '../render/video-duration'
import type { RenderOp } from '../render/cloud-jobs'
import { presetSlotFor, resolvePresetStep } from './engine'
import {
  CHAT_INTENTS, ERASE_REFUSAL, INTENT_KIND, INTENT_LABEL, QWEN_VOICES, classicOptions, intentModels, presetById,
  speechModels, stepClassicOptions, visible, visiblePresets, type ChatModel, type OptionSpec,
} from './chat-catalog'
import {
  ORDER_RESULT_PREFIX, OrderSpecError, createSlots, orderSum, planOrder, roleStep, runCredits, stepFields,
  type ItemSpec, type Order, type PlanContext, type PriceDeps,
} from './order'
import {
  attachmentHandle, attachmentKind, attachmentUsable, galleryHandle, resultHandle, usableGallery, usableResults, type HandleContext,
} from './handles'
import type { PromptSafetyCheck } from './engine'

export interface CreateToolEnv {
  conversationId: string | null
  handles: () => Omit<HandleContext, 'items'>
  openAllowed: () => Promise<boolean>
  checkSafety: () => Promise<PromptSafetyCheck>
  characters: () => Promise<{ id: string; name: string; family: string }[]>
  credits: () => Promise<number | null>
  spentBefore: (conversationId: string) => number
  priceDeps: PriceDeps
  addOrder: (order: Order) => void
  newId: () => string
  now: () => number
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

const SOUND_FIELDS = ['enable_audio', 'generate_audio', 'generate_audio_switch', 'save_audio']

function range(s: Schema, divisor = 1): string | null {
  if (s.enum?.length) return s.enum.map((v) => (typeof v === 'number' ? v / divisor : v)).join('/')
  if (s.minimum !== undefined && s.maximum !== undefined) return `${s.minimum / divisor}-${s.maximum / divisor}`
  return null
}

function studioCapabilities(id: string, role?: StepRole): string[] {
  const m = STUDIO_MODELS[id]
  const schema = studioSchema(id)
  const props = schema.properties ?? {}
  const required = schema.required ?? []
  const inputs = Object.keys(m.inputs)
  const out: string[] = []
  if (m.kind === 'video') {
    if (inputs.includes('video')) out.push(role === 'upscale' ? 'sharpens a clip' : role === 'soundtrack' ? 'adds sound to a clip' : 'clip in')
    else if (inputs.includes('image') && required.includes('image') && !inputs.some((f) => f.includes('audio'))) out.push('image start')
    else if (!inputs.length) out.push('text start')
    if (inputs.includes('last_image')) out.push('optional end image')
    if (inputs.includes('left_audio')) out.push('two voice tracks on one image')
    else if (inputs.includes('audio')) out.push(inputs.includes('image') ? (required.includes('audio') ? 'photo + voice track' : 'optional voice track') : 'voice track, no photo needed')
    if (SOUND_FIELDS.some((f) => props[f])) out.push('sound included')
  }
  if (m.kind === 'image') {
    if (props.images) out.push(`edits ${props.images.maxItems && props.images.maxItems > 1 ? `1-${props.images.maxItems} images` : 'an image'}`)
    else out.push('text start')
  }
  if (m.kind === 'audio') {
    if (inputs.includes('reference_audio')) out.push('clones a reference voice')
    if (m.promptField === 'lyrics' || props.lyrics) out.push('lyrics')
    if (props.is_instrumental || props.force_instrumental) out.push('instrumental possible')
  }
  const dur = props.duration ? range(props.duration) : props.music_length_ms ? range(props.music_length_ms, 1000) : null
  if (dur) out.push(`${dur} s`)
  for (const key of ['resolution', 'target_resolution']) if (props[key]?.enum) out.push(props[key].enum!.join('/'))
  if (props.target_megapixels) out.push(`${range(props.target_megapixels)} megapixels`)
  if (props.aspect_ratio?.enum) out.push(`aspect ${props.aspect_ratio.enum.join('/')}`)
  for (const key of ['voice', 'voice_id']) if (props[key]?.enum) out.push(`${props[key].enum!.length} voices`)
  if (props.avatar?.enum) out.push(`${props.avatar.enum.length} presenters`)
  if (props.language?.enum) out.push(`${props.language.enum.length} languages`)
  if (props.negative_prompt) out.push('negative prompt')
  if (m.price.mode === 'input' || m.price.mode === 'both') out.push('priced by input length')
  if (m.price.mode === 'characters') out.push('priced by text length')
  return out
}

function classicCapabilities(id: string, intent?: CreateIntent, role?: StepRole): string[] {
  const c = cloudModelById(id)
  const out: string[] = []
  if (!c) return out
  const where = intent ?? role
  if (c.kind === 'video' && !c.ops) {
    out.push(where === 'animate' ? 'image start' : 'text start')
    const lengths = videoDurations(id)
    if (lengths.length) out.push(`${lengths.join('/')} s`)
    if (/with audio/i.test(c.label)) out.push('sound included')
  }
  if (c.maskless) out.push('no mask needed')
  if (c.lipsyncSource === 'image') out.push('photo + voice track')
  if (c.lipsyncSource === 'video') out.push('re-syncs an existing clip to a voice track')
  if (c.ops?.includes('lora-train')) out.push('trains a character from 4-30 photos')
  if (c.ops?.includes('extend')) out.push('continues a clip')
  if (c.ops?.includes('motion')) out.push('image + driving clip')
  if (c.ops?.includes('music')) out.push(c.supportsLyrics ? 'lyrics' : 'writes its own lyrics')
  if (id === 'qwen3-tts') out.push(`${QWEN_VOICES.length} voices`)
  if (id === 'qwen3-tts-clone') out.push('clones a reference voice')
  if (id === 'qwen3-tts-design') out.push('voice from a description')
  return out
}

export function modelCapabilities(m: ChatModel, intent?: CreateIntent): string[] {
  const out = STUDIO_MODELS[m.id] ? studioCapabilities(m.id, m.role) : classicCapabilities(m.id, intent, m.role)
  if (m.adult) out.push('no refusals')
  return out
}

const INTENT_OP: Partial<Record<CreateIntent, RenderOp>> = {
  image: 'generate', video: 'generate', animate: 'animate', edit: 'edit', music: 'music', lipsync: 'lipsync',
  extend: 'extend', motion: 'motion', character: 'lora-train',
}

export function priceHint(m: ChatModel, intent?: CreateIntent): string {
  const studio = STUDIO_MODELS[m.id]
  if (studio) {
    const base = studioBaseCredits(m.id)
    return studio.price.mode === 'input' || studio.price.mode === 'both'
      ? `about ${fmt(base)} credits per 5 s of input` : `about ${fmt(base)} credits at defaults`
  }
  const kind = m.kind
  const op: RenderOp = m.role === 'speech' ? 'tts' : m.role === 'talking' ? 'lipsync' : (intent ? INTENT_OP[intent] : undefined) ?? 'generate'
  const seconds = kind === 'video' && (op === 'generate' || op === 'animate') ? videoDurations(m.id)[0] ?? 5 : op === 'music' ? 60 : undefined
  const rate = lengthPrice(m.id, op)
  if (rate && rate.basis !== 'extension') {
    return `about ${fmt(lengthCredits(m.id))} credits per ${rate.quote} ${rate.basis === 'chars' ? 'characters' : 's of input'}`
  }
  try {
    return `about ${fmt(mediaCredits(kind, m.id, seconds, op))} credits${op === 'music' ? ' per minute' : ''}`
  } catch {
    return 'price on order'
  }
}

const INTENT_WHAT: Record<CreateIntent, string> = {
  image: 'text to image', edit: 'change an image by instruction, no mask', removebg: 'cut out the subject',
  upscale: 'sharpen and enlarge an image', eraser: 'needs a mask, not available in chat',
  character: 'train a character from photos, or create images with a trained one', video: 'text to clip',
  animate: 'image to clip', extend: 'continue a clip', video_upscale: 'sharpen a clip', lipsync: 'a portrait speaks a voice track',
  motion: 'movement of a clip onto a character image', music: 'a track from a description',
  '3d': 'a 3D model, not available in chat',
}

function inputsOf(intent: CreateIntent, model?: ChatModel): string[] {
  if (model?.engine === 'step' && model.role) {
    const r = resolvePresetStep(roleStep(model.role, model.id, INTENT_LABEL[intent]), 0, model.id)
    const fields = stepFields(r)
    return Object.entries(fields).map(([name, key]) => (r.required.includes(key) ? name : `${name} (optional)`))
  }
  return createSlots(intent, model?.id ?? '').map((s) => (s === 'photos' ? 'photos (4-30)' : s))
}

function presetStepsLine(p: CreatePreset): string {
  return p.steps.map((st, i) => {
    const r = resolvePresetStep(p, i)
    const carried = i > 0 ? presetSlotFor(r, resolvePresetStep(p, i - 1).step.kind) : undefined
    const fields = stepFields(r)
    const needs = Object.entries(fields).filter(([, key]) => r.required.includes(key) && key !== carried).map(([name]) => name)
    return `${i + 1}. ${st.title} (${st.role}${needs.length ? `, needs ${needs.join(', ')}` : ''})`
  }).join(' > ')
}

function handleLines(h: Omit<HandleContext, 'items'>): string[] {
  const ctx: HandleContext = { ...h }
  const out: string[] = []
  const results = usableResults(ctx).slice(-8).reverse()
  if (results.length) out.push(`Results of this chat: ${results.map((r) => `${resultHandle(r.jobId)} ${r.kind} "${r.title}"`).join('; ')}`)
  const gallery = usableGallery(ctx).slice(0, 8)
  if (gallery.length) out.push(`Gallery: ${gallery.map((g) => `${galleryHandle(g)} ${g.kind} "${short(g.title)}"`).join('; ')}`)
  const attachments = h.attachments.filter(attachmentUsable).slice(-8)
  if (attachments.length) out.push(`Attachments: ${attachments.map((a) => `${attachmentHandle(a.messageId, a.index)} ${attachmentKind(a)} "${short(a.name)}"`).join('; ')}`)
  if (!out.length) out.push('No results, gallery entries or attachments yet.')
  return out
}

function short(text: string, max = 40): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 3)}...` : t
}

export function overviewText(opts: { openAllowed: boolean; credits: number | null; handles: Omit<HandleContext, 'items'> }): string {
  const lines: string[] = []
  lines.push('Create options. Reading this is free. To make something, call create_order; the customer must approve before anything runs.')
  if (opts.credits !== null) lines.push(`Credits left: ${fmt(opts.credits)}.`)
  lines.push('Subcategories (intent: what it does; inputs; models):')
  for (const intent of CHAT_INTENTS) {
    if (intent === 'eraser') continue
    const models = visible(intentModels(intent), opts.openAllowed)
    const inputs = inputsOf(intent, models[0])
    lines.push(`- ${intent}: ${INTENT_WHAT[intent]}; inputs ${inputs.length ? inputs.join(', ') : 'none'}; ${models.length ? `${models.length} models` : 'fixed model'}`)
  }
  lines.push(`- speech: text to voice; optional reference voice; ${visible(speechModels(), opts.openAllowed).length} models`)
  lines.push('Presets (fixed chains, one item each):')
  for (const p of visiblePresets(opts.openAllowed)) lines.push(`- ${p.id}: ${presetStepsLine(p)}`)
  lines.push(...handleLines(opts.handles))
  lines.push('Chain items freely: item:<n> uses the result of item n of the same order. Details: create_options with intent, preset or model.')
  return lines.join('\n')
}

function optionLine(name: string, s: OptionSpec | Schema, full: boolean): string {
  const parts: string[] = []
  if (s.enum?.length) {
    const list = full || s.enum.length <= 12 ? s.enum : [...s.enum.slice(0, 8), `... ${s.enum.length} total, ask with model for all`]
    parts.push(`one of ${list.join(', ')}`)
  } else if (s.minimum !== undefined && s.maximum !== undefined) parts.push(`${s.type} ${s.minimum}-${s.maximum}`)
  else parts.push(String(s.type ?? 'text'))
  if (s.default !== undefined) parts.push(`default ${String(s.default)}`)
  const d = (s as OptionSpec).description
  if (d && !(s as Schema).enum) parts.push(d)
  return `  ${name}: ${parts.join('; ')}`
}

function modelBlock(m: ChatModel, intent: CreateIntent | undefined, full: boolean): string[] {
  const caps = modelCapabilities(m, intent)
  const out = [`- ${m.id} (${m.label}): ${caps.length ? caps.join(', ') : 'standard'}; ${priceHint(m, intent)}`]
  const hint = modelHint(m.id)
  if (full && hint) out.push(`  note: ${hint}`)
  if (full) {
    const opts: Record<string, OptionSpec | Schema> = STUDIO_MODELS[m.id]
      ? studioFields(m.id)
      : m.engine === 'step' && m.role ? stepClassicOptions(m.role, m.id) : intent ? classicOptions(intent, m.id) : {}
    const names = Object.keys(opts)
    out.push(names.length ? '  options:' : '  options: none')
    for (const name of names) out.push(optionLine(name, opts[name], full))
    if (intent) {
      const inputs = inputsOf(intent, m)
      out.push(`  inputs: ${inputs.length ? inputs.join(', ') : 'none'}`)
    }
  }
  return out
}

export function detailText(args: { intent?: string; preset?: string; model?: string }, openAllowed: boolean): string {
  if (args.preset !== undefined) {
    const p = presetById(args.preset)
    if (!p || (p.adult && !openAllowed)) {
      throw new OrderSpecError(`Unknown preset "${args.preset}". Presets: ${visiblePresets(openAllowed).map((x) => x.id).join(', ')}.`)
    }
    const lines = [`Preset ${p.id} (${p.title}): ${p.summary}`]
    if (p.note) lines.push(`Note: ${p.note}`)
    p.steps.forEach((st, i) => {
      const r = resolvePresetStep(p, i)
      lines.push(`Step ${i + 1}: ${st.title} (${st.role}). Default model ${r.step.model}.${i > 0 ? ' Takes the result of the previous step.' : ''}`)
      const alts = visible(r.alternatives.map((a) => ({ ...a, engine: 'step' as const, role: st.role })), openAllowed)
      for (const a of alts) lines.push(...modelBlock(a, undefined, args.model === a.id || alts.length <= 3).map((l) => `  ${l}`))
      const fields = stepFields(r)
      lines.push(`  inputs of ${r.step.model}: ${Object.keys(fields).length ? Object.keys(fields).join(', ') : 'none'}`)
    })
    lines.push('Order it as {"preset":"' + p.id + '","steps":[{"prompt":"...","model":"...","inputs":{...},"options":{...}}]}, one entry per step.')
    return lines.join('\n')
  }
  if (args.intent !== undefined) {
    const intent = args.intent as CreateIntent
    if (intent === 'eraser') return ERASE_REFUSAL
    if (args.intent === 'speech') {
      const models = visible(speechModels(), openAllowed)
      const pick = args.model !== undefined ? models.filter((m) => m.id === args.model) : models
      if (!pick.length) throw new OrderSpecError(`Unknown model "${args.model}" for speech. Allowed: ${models.map((m) => m.id).join(', ')}.`)
      return ['speech: text to voice. Order as {"speech":"the words","model":"...","reference":"<audio handle>","options":{...}}.',
        ...pick.flatMap((m) => modelBlock(m, undefined, true))].join('\n')
    }
    if (!INTENT_KIND[intent]) {
      throw new OrderSpecError(`Unknown intent "${args.intent}". Intents: ${[...CHAT_INTENTS.filter((i) => i !== 'eraser'), 'speech'].join(', ')}.`)
    }
    const models = visible(intentModels(intent), openAllowed)
    const lines = [`${intent}: ${INTENT_WHAT[intent]}.`]
    if (!models.length) {
      lines.push(`Fixed model; inputs ${inputsOf(intent).join(', ') || 'none'}; no options.`)
      return lines.join('\n')
    }
    const pick = args.model !== undefined ? models.filter((m) => m.id === args.model) : models
    if (!pick.length) throw new OrderSpecError(`Unknown model "${args.model}" for ${intent}. Allowed: ${models.map((m) => m.id).join(', ')}.`)
    for (const m of pick) lines.push(...modelBlock(m, intent, args.model !== undefined || pick.length <= 6))
    if (args.model === undefined && pick.length > 6) lines.push('Options and inputs per model: create_options with intent and model.')
    return lines.join('\n')
  }
  throw new OrderSpecError('Pass intent, preset or nothing.')
}

const ITEM_SHAPES = 'An item is one of {"intent":"image","prompt":"..."}, {"speech":"the words to say"} or {"preset":"<id>","steps":[{"prompt":"..."}]}. create_options lists the intents and presets.'

const ITEM_KEYS = ['intent', 'preset', 'speech', 'prompt', 'model', 'inputs', 'options', 'steps', 'reference']
const STEP_KEYS = ['prompt', 'model', 'inputs', 'options']

function parseJsonText(value: unknown, what: string): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return value
  try {
    return JSON.parse(text)
  } catch {
    throw new OrderSpecError(`${what} is not valid JSON.`)
  }
}

function asObject(value: unknown, what: string): Record<string, unknown> | undefined {
  const v = parseJsonText(value, what)
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) throw new OrderSpecError(`${what} must be an object.`)
  return v as Record<string, unknown>
}

function onlyKeys(obj: Record<string, unknown>, allowed: string[], what: string): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k))
  if (extra.length) throw new OrderSpecError(`${what}: unknown field${extra.length > 1 ? 's' : ''} ${extra.join(', ')}. Allowed: ${allowed.join(', ')}.`)
}

function text(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') throw new OrderSpecError(`${what} must be text.`)
  return value
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return typeof value === 'object' && Object.keys(value as object).length === 0
}

const sameValue = (a: unknown, b: unknown) =>
  (typeof a === 'string' && typeof b === 'string' ? a.trim() === b.trim() : JSON.stringify(a) === JSON.stringify(b))

function foldSteps(item: Record<string, unknown>): boolean {
  const steps = parseJsonText(item.steps, 'steps')
  if (!Array.isArray(steps)) return false
  const own = (st: unknown): Record<string, unknown> | null => {
    if (isBlank(st) || typeof st === 'number' || typeof st === 'boolean') return {}
    if (typeof st === 'string') return { prompt: st }
    const obj = typeof st === 'object' && !Array.isArray(st) ? st as Record<string, unknown> : null
    if (!obj) return null
    const out: Record<string, unknown> = {}
    const loose: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (isBlank(v)) continue
      if (STEP_KEYS.includes(k)) out[k] = k === 'options' || k === 'inputs' ? parseJsonText(v, k) : v
      else if (k === 'intent') { if (!sameValue(item.intent, v)) return null }
      else if (k === 'reference' && typeof v === 'string') out.reference = v
      else if (typeof v !== 'object') loose[k] = v
      else return null
    }
    if (Object.keys(loose).length) {
      if (out.options !== undefined && (typeof out.options !== 'object' || Array.isArray(out.options))) return null
      out.options = { ...loose, ...(out.options as Record<string, unknown> | undefined) }
    }
    return out
  }
  const read = steps.map(own)
  if (read.some((st) => st === null)) return false
  const main = item.speech !== undefined ? 'speech' : 'prompt'
  const adds = (read as Record<string, unknown>[]).filter((st) => Object.entries(st).some(([k, v]) => !sameValue(item[k === 'prompt' ? main : k], v)))
  if (adds.length > 1) return false
  const merged: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(adds[0] ?? {})) {
    const key = k === 'prompt' ? main : k
    if (isBlank(item[key])) { merged[key] = v; continue }
    if (sameValue(item[key], v)) continue
    const mine = key === 'options' ? parseJsonText(item[key], key) : null
    if (!mine || typeof mine !== 'object' || Array.isArray(mine) || !v || typeof v !== 'object') return false
    const theirs = v as Record<string, unknown>
    if (Object.keys(theirs).some((o) => o in mine && !sameValue((mine as Record<string, unknown>)[o], theirs[o]))) return false
    merged[key] = { ...theirs, ...(mine as Record<string, unknown>) }
  }
  Object.assign(item, merged)
  delete item.steps
  return true
}

function referenceAsModel(item: Record<string, unknown>): void {
  if (item.speech !== undefined || typeof item.reference !== 'string' || typeof item.intent !== 'string') return
  const id = item.reference.trim()
  const intent = item.intent.trim() as CreateIntent
  if (!INTENT_KIND[intent] || !intentModels(intent).some((m) => m.id === id)) return
  if (isBlank(item.model)) item.model = id
  else if (String(item.model).trim() !== id) return
  delete item.reference
}

function referenceAsInput(item: Record<string, unknown>): void {
  if (item.speech !== undefined || typeof item.reference !== 'string' || typeof item.intent !== 'string') return
  const handle = item.reference.trim()
  const intent = item.intent.trim() as CreateIntent
  if (!INTENT_KIND[intent] || !/^(job|gal|att|item):\S+$/.test(handle) || !isBlank(item.inputs)) return
  const slots = createSlots(intent, typeof item.model === 'string' ? item.model.trim() : '')
  if (slots.length !== 1 || slots[0] === 'photos') return
  item.inputs = { [slots[0]]: handle }
  delete item.reference
}

export function coerceOrderArgs(raw: Record<string, unknown>): ItemSpec[] {
  onlyKeys(raw, ['items'], 'create_order')
  let items = parseJsonText(raw.items, 'items')
  if (items && typeof items === 'object' && !Array.isArray(items)) items = [items]
  if (!Array.isArray(items) || !items.length) throw new OrderSpecError('items must be a list of one or more items.')
  return items.map((rawItem, i) => {
    const what = `Item ${i + 1}`
    const given = asObject(rawItem, what)
    const said = ([k, v]: [string, unknown]): boolean => {
      const steps = k === 'steps' ? parseJsonText(v, `${what} steps`) : null
      return !isBlank(v) && !(Array.isArray(steps) && steps.every(isBlank))
    }
    const item = Object.fromEntries(Object.entries(given ?? {}).filter(said))
    if (!Object.keys(item).length) throw new OrderSpecError(`${what} is empty${isBlank(given?.steps) ? '' : ' (its steps hold nothing)'}. ${ITEM_SHAPES}`)
    if (item.preset === undefined && item.steps !== undefined) foldSteps(item)
    referenceAsModel(item)
    referenceAsInput(item)
    onlyKeys(item, ITEM_KEYS, what)
    const kinds = ['intent', 'preset', 'speech'].filter((k) => item[k] !== undefined)
    if (kinds.length === 0) throw new OrderSpecError(`${what} does not say what to create: it has ${Object.keys(item).join(', ')} but no intent, preset or speech. ${ITEM_SHAPES}`)
    if (kinds.length > 1) throw new OrderSpecError(`${what} has ${kinds.join(' and ')}. An item takes exactly one of intent, preset or speech; make one item for each.`)
    const inputs = asObject(item.inputs, `${what} inputs`) as Record<string, string | string[]> | undefined
    const options = asObject(item.options, `${what} options`)
    if (item.preset !== undefined) {
      const stepsRaw = parseJsonText(item.steps, `${what} steps`)
      if (stepsRaw !== undefined && !Array.isArray(stepsRaw)) throw new OrderSpecError(`${what} steps must be a list.`)
      for (const k of ['prompt', 'model', 'inputs', 'options', 'reference']) {
        if (item[k] !== undefined) throw new OrderSpecError(`${what}: a preset takes its ${k} per step, inside steps.`)
      }
      const steps = (stepsRaw as unknown[] | undefined)?.map((s, j) => {
        if (typeof s === 'string' && !s.trim().startsWith('{')) return { prompt: s }
        const st = asObject(s, `${what} step ${j + 1}`) ?? {}
        onlyKeys(st, STEP_KEYS, `${what} step ${j + 1}`)
        return {
          prompt: text(st.prompt, `${what} step ${j + 1} prompt`),
          model: text(st.model, `${what} step ${j + 1} model`),
          inputs: asObject(st.inputs, `${what} step ${j + 1} inputs`) as Record<string, string | string[]> | undefined,
          options: asObject(st.options, `${what} step ${j + 1} options`),
        }
      })
      return { preset: text(item.preset, `${what} preset`)!, steps }
    }
    if (item.steps !== undefined) throw new OrderSpecError(`${what}: "steps" is only for a preset item. Remove "steps" and put prompt, model, inputs and options on the item itself.`)
    if (item.speech !== undefined) {
      if (item.prompt !== undefined || item.inputs !== undefined) {
        throw new OrderSpecError(`${what}: speech takes its words in "speech" and a reference voice in "reference".`)
      }
      return { speech: text(item.speech, `${what} speech`)!, model: text(item.model, `${what} model`), reference: text(item.reference, `${what} reference`), options }
    }
    if (item.reference !== undefined) throw new OrderSpecError(`${what}: "reference" is only for a speech item. Remove "reference"; an input goes into "inputs" as a handle.`)
    return { intent: text(item.intent, `${what} intent`)!, prompt: text(item.prompt, `${what} prompt`), model: text(item.model, `${what} model`), inputs, options }
  })
}

export function orderText(order: Order): string {
  const lines = [`${ORDER_RESULT_PREFIX}${order.id} is waiting for the customer's approval. Nothing has been created yet and no credits were used.`]
  for (const item of order.items) {
    const credits = item.runs.reduce((s, r) => s + runCredits(r), 0)
    const estimated = item.runs.some((r) => r.price.estimated)
    const assumed = item.runs.find((r) => r.price.assumedSeconds !== undefined)?.price.assumedSeconds
    lines.push(`${item.n}. ${item.detail}: ${estimated ? 'about ' : ''}${fmt(credits)} credits${assumed !== undefined ? ` (priced for ${assumed} s of input)` : ''}`)
  }
  const sum = orderSum(order)
  const total = `${sum.estimated ? 'about ' : ''}${fmt(sum.order)}`
  lines.push(sum.spentBefore > 0
    ? `This order: ${total} credits. Already used in this chat: ${fmt(sum.spentBefore)}. Together: ${sum.estimated ? 'about ' : ''}${fmt(sum.together)}.`
    : `Total: ${total} credits.`)
  if (sum.estimated) lines.push('Prices marked "about" depend on a length measured when the item runs. If it costs more, the customer is asked for the difference.')
  lines.push('The customer approves it on the order card or by replying with a short yes. Tell them what the order contains and what it costs; do not claim anything is being created.')
  return lines.join('\n')
}

export const NO_ORDER_YET = 'No order was created and the customer sees none. Correct the call and call create_order again, or tell the customer what is missing.'

function fail(err: unknown): string {
  if (err instanceof OrderSpecError) return `Error: ${err.message}`
  return `Error: ${err instanceof Error ? err.message : String(err)}`
}

export async function runCreateOptions(args: Record<string, unknown>, env: CreateToolEnv): Promise<string> {
  try {
    onlyKeys(args, ['intent', 'preset', 'model'], 'create_options')
    const intent = text(args.intent, 'intent')?.trim() || undefined
    const preset = text(args.preset, 'preset')?.trim() || undefined
    const model = text(args.model, 'model')?.trim() || undefined
    if (intent && preset) return runCreateOptions({ preset, ...(model ? { model } : {}) }, env)
    const openAllowed = await env.openAllowed()
    if (!intent && !preset) {
      if (model) throw new OrderSpecError('Pass model together with intent or preset.')
      return overviewText({ openAllowed, credits: await env.credits(), handles: env.handles() })
    }
    const handles = env.handles()
    const known = usableResults({ ...handles }).length + usableGallery({ ...handles }).length + handles.attachments.filter(attachmentUsable).length
    const detail = detailText({ intent, preset, model }, openAllowed)
    return known && intent !== 'eraser' ? [detail, ...handleLines(handles)].join('\n') : detail
  } catch (err) {
    return fail(err)
  }
}

export async function runCreateOrder(args: Record<string, unknown>, env: CreateToolEnv): Promise<string> {
  try {
    const conversationId = env.conversationId
    if (!conversationId) throw new OrderSpecError('Create orders need an open chat.')
    const specs = coerceOrderArgs(args)
    const [openAllowed, checkSafety, characters] = await Promise.all([env.openAllowed(), env.checkSafety(), env.characters()])
    const ctx: PlanContext = {
      conversationId,
      handles: env.handles(),
      openAllowed,
      characters,
      checkSafety,
      spentBefore: env.spentBefore(conversationId),
      now: env.now(),
      newId: env.newId,
    }
    const order = await planOrder(specs, ctx, env.priceDeps)
    env.addOrder(order)
    return orderText(order)
  } catch (err) {
    return `${fail(err)} ${NO_ORDER_YET}`
  }
}
