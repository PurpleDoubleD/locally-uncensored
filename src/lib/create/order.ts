// MIRRORED from the web app (lib/create/order.ts), without its comments. Do not edit here.
// scripts/create-chat-mirror.mjs writes this file, and web-parity.test.ts
// holds it to its source. Only the import paths differ, the places listed
// under PATCHES in that script, and the classes under CLASSES.
import type { CreateIntent } from './bridge/create-store'
import type { CloudJob, CloudJobParams, CloudJobSubmit, UploadRole } from './bridge/cloud-jobs'
import { cloudModelById, resolveCharacterModel } from './bridge/cloud-models'
import { pricesByInput } from '../render/create-studio'
import {
  STUDIO_MODELS, studioCredits, studioFields, studioOptions, studioSchema, type StudioModel,
} from '../render/studio-contract'
import { mediaCredits, lengthPrice, lengthCredits } from './bridge/credits'
import { modelLabel, type StepRole } from './bridge/preset-models'
import type { CreatePreset } from '../render/create-presets'
import { dataUrlToBlob } from '../render/data-url'
import { errorText } from '../../types/json-guards'
import type { OrderItemStatus, OrderItemView, OrderStepView, OrderView } from '../../components/chat/create/types'
import { blockMessageFor } from '../render/safety'
import {
  EXTEND_NEEDS_RESULT, adoptResult, buildCreateParams, buildPresetStepParams, createJobSubmit, describeSubmitError, failedJobText,
  presetAdoptRole, presetEstimate, presetSlotFor, presetStepSubmit, presetUploadRole, requestStudioQuote,
  resolveCreateJob, resolvePresetStep, runCloudJob, validateCreateJob, CreateInputError, PROMPT_MISSING,
  type CreateDeps, type CreateInputs, type CreateRequest, type MediaRef, type PromptSafetyCheck,
  type ResolvedPresetStep, type RunDeps,
} from './engine'
import {
  HandleError, resolveHandle, validHandlesText, type HandleContext, type HandleItem, type MediaKind,
} from './handles'
import {
  ERASE_REFUSAL, IMAGE_ASPECTS, INTENT_KIND, INTENT_LABEL, VIDEO_ASPECTS, checkOptions, classicOptions,
  intentModels, presetById, speechModels, stepClassicOptions, visible, visiblePresets,
  type ChatModel,
} from './chat-catalog'

export type InputSpec = Record<string, string | string[]>

export interface IntentItemSpec {
  intent: string
  prompt?: string
  model?: string
  inputs?: InputSpec
  options?: Record<string, unknown>
}

export interface StepSpec {
  prompt?: string
  model?: string
  inputs?: InputSpec
  options?: Record<string, unknown>
}

export interface PresetItemSpec {
  preset: string
  steps?: StepSpec[]
}

export interface SpeechItemSpec {
  speech: string
  model?: string
  reference?: string
  options?: Record<string, unknown>
}

export type ItemSpec = IntentItemSpec | PresetItemSpec | SpeechItemSpec

export class OrderSpecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrderSpecError'
  }
}

export type OrderState = 'awaiting' | 'running' | 'done' | 'stopped' | 'declined' | 'repricing'
export type RunStatus = 'waiting' | 'queued' | 'running' | 'done' | 'failed'

export type PriceSource = 'table' | 'quote' | 'formula' | 'estimate'

export interface RunPrice {
  credits: number
  estimated: boolean
  source: PriceSource
  assumedSeconds?: number
}

export interface RunInput {
  handle: string
  kind: MediaKind
}

export interface OrderRun {
  engine: 'create' | 'step'
  title: string
  model: string
  kind: MediaKind
  prompt: string
  options: Record<string, unknown>
  inputs: Record<string, RunInput | RunInput[]>
  intent?: CreateIntent
  characterTab?: 'train' | 'use'
  character?: { id: string; family: string } | null
  role?: StepRole
  presetId?: string
  stepIndex?: number
  carry?: string
  price: RunPrice
  approvedCredits?: number
  requoted?: number
  outputSeconds?: number
  requestId?: string
  status: RunStatus
  jobId?: string
  resultUrl?: string
  spent?: number
  interrupted?: boolean
  stoppedLate?: boolean
  lostTrack?: boolean
  refunded?: boolean
  error?: string
}

export interface OrderItem {
  n: number
  type: 'intent' | 'preset' | 'speech'
  title: string
  detail: string
  kind: MediaKind
  runs: OrderRun[]
}

export interface Order {
  id: string
  conversationId: string
  createdAt: number
  state: OrderState
  items: OrderItem[]
  spentBefore: number
  approvedAt?: number
  note?: string
}

export interface PlanContext {
  conversationId: string
  handles: Omit<HandleContext, 'items'>
  openAllowed: boolean
  characters: { id: string; name: string; family: string }[]
  checkSafety: PromptSafetyCheck
  spentBefore: number
  now: number
  newId: () => string
}

export type PriceDeps = Pick<CreateDeps, 'fetch' | 'signal'>

export const ASSUMED_INPUT_SECONDS = 10

const CHARS_PER_SECOND = 15

const MAX_ITEMS = 8

const SLOT_KIND: Record<string, MediaKind> = {
  source: 'image', video: 'video', audio: 'audio', extend: 'video', clip: 'video', train: 'image',
}

const CREATE_SLOT_NAME: Record<string, string> = {
  image: 'source', video: 'video', audio: 'audio', photos: 'train',
}

function spec(error: string): never {
  throw new OrderSpecError(error)
}

function isIntent(s: ItemSpec): s is IntentItemSpec {
  return typeof (s as IntentItemSpec).intent === 'string'
}
function isPreset(s: ItemSpec): s is PresetItemSpec {
  return typeof (s as PresetItemSpec).preset === 'string'
}
function isSpeech(s: ItemSpec): s is SpeechItemSpec {
  return typeof (s as SpeechItemSpec).speech === 'string'
}

export function routeCredits(submit: CloudJobSubmit): number {
  const { kind, model, params } = submit
  const seconds = kind === 'video'
    ? (typeof params.frames === 'number' && params.frames > 0
      ? params.frames / (typeof params.fps === 'number' && params.fps > 0 ? params.fps : 16)
      : undefined)
    : kind === 'audio' ? params.duration : undefined
  const withLora = Array.isArray(params.loras) && params.loras.length > 0
  return mediaCredits(kind, model, seconds, params.op, params.target_resolution, withLora)
}

function studioRequiredFields(model: string): string[] {
  const required = studioSchema(model).required ?? []
  return Object.keys(STUDIO_MODELS[model].inputs).filter((f) => required.includes(f))
}

function measuredSeconds(inputs: Record<string, RunInput | RunInput[]>, known: (handle: string) => number | undefined, order?: unknown): number {
  const one = (key: string) => {
    const v = inputs[key]
    return v && !Array.isArray(v) ? known(v.handle) ?? ASSUMED_INPUT_SECONDS : undefined
  }
  const video = one('video_path') ?? one('video') ?? one('clip') ?? one('extend')
  if (video !== undefined) return video
  const left = one('audio_path') ?? one('audio')
  const right = one('audio2_path')
  if (left !== undefined && right !== undefined) return order === 'meanwhile' || order === undefined ? Math.max(left, right) : left + right
  return left ?? ASSUMED_INPUT_SECONDS
}

function classicPrice(
  model: string,
  op: string | undefined,
  table: number,
  prompt: string,
  inputs: Record<string, RunInput | RunInput[]>,
  known: (handle: string) => number | undefined,
): RunPrice {
  const rate = lengthPrice(model, op)
  if (!rate || rate.basis === 'extension') return { credits: table, estimated: false, source: 'table' }
  if (rate.basis === 'chars') return { credits: lengthCredits(model, Array.from(prompt).length), estimated: false, source: 'table' }
  const keys = rate.basis === 'audio' ? ['audio_path', 'audio'] : ['video_path', 'video', 'clip']
  const input = keys.map((k) => inputs[k]).find((v): v is RunInput => !!v && !Array.isArray(v))
  const seconds = (input && known(input.handle)) ?? ASSUMED_INPUT_SECONDS
  return { credits: lengthCredits(model, seconds), estimated: true, source: 'estimate', assumedSeconds: seconds }
}

async function studioPrice(
  model: string,
  prompt: string,
  options: Record<string, unknown>,
  quoteParams: CloudJobParams,
  seconds: number,
  imageCount: number,
  deps: PriceDeps,
): Promise<RunPrice> {
  const filled = studioOptions(model, prompt, options, false)
  const formula = (s?: number) => studioCredits(model, filled, s, imageCount, Array.from(prompt).length)
  if (pricesByInput(model)) {
    return { credits: formula(seconds), estimated: true, source: 'estimate', assumedSeconds: seconds }
  }
  if (!studioRequiredFields(model).length) {
    try {
      const quote = await requestStudioQuote(model, prompt, quoteParams, deps)
      return { credits: quote.credits, estimated: false, source: 'quote' }
    } catch {
      return { credits: formula(), estimated: true, source: 'formula' }
    }
  }
  return { credits: formula(), estimated: false, source: 'formula' }
}

function studioOutputSeconds(m: StudioModel, options: Record<string, unknown>, fallback?: number): number | undefined {
  if (m.price.mode === 'output' && m.kind !== 'image') {
    const raw = Number(options[m.price.durationField ?? 'duration'])
    if (Number.isFinite(raw) && raw > 0) return raw / (m.price.unitDivisor ?? 1)
  }
  return fallback
}

interface Planner {
  ctx: PlanContext
  deps: PriceDeps
  items: OrderItem[]
  carrySeconds?: number
}

function inputFor(p: Planner, slot: string, handle: unknown, kind: MediaKind): RunInput {
  const hctx: HandleContext = { ...p.ctx.handles, items: p.items.map(asHandleItem) }
  try {
    const hit = resolveHandle(handle, hctx)
    if (hit.kind !== kind) {
      spec(`Input "${slot}" needs ${kind === 'image' ? 'an image' : `a ${kind === 'video' ? 'clip' : 'sound track'}`}, `
        + `but ${hit.handle} is ${hit.kind === 'image' ? 'an image' : hit.kind === 'video' ? 'a clip' : 'a sound track'}. `
        + validHandlesText(hctx, kind))
    }
    return { handle: hit.handle, kind }
  } catch (err) {
    if (err instanceof HandleError) spec(`Input "${slot}": ${err.message}`)
    throw err
  }
}

function asHandleItem(item: OrderItem): HandleItem {
  return { n: item.n, kind: item.kind, title: item.title }
}

function knownSeconds(p: Planner) {
  return (handle: string): number | undefined => {
    const m = /^item:(\d+)$/.exec(handle)
    if (!m) return undefined
    const item = p.items.find((i) => i.n === Number(m[1]))
    return item?.runs[item.runs.length - 1]?.outputSeconds
  }
}

export function coerceOptionValues(
  options: Record<string, unknown>,
  typeOf: (key: string) => { type?: string; enum?: readonly unknown[] } | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    const t = typeOf(key)
    let v = value
    if (typeof value === 'string' && t) {
      const text = value.trim()
      const numeric = text !== '' && Number.isFinite(Number(text))
      if ((t.type === 'integer' || t.type === 'number') && numeric) v = Number(text)
      else if (t.type === 'boolean' && (text === 'true' || text === 'false')) v = text === 'true'
      else if (t.enum?.some((e) => typeof e === 'number') && numeric && !t.enum.includes(value)) v = Number(text)
    }
    out[key] = v
  }
  return out
}

function pickModel(list: ChatModel[], wanted: string | undefined, openAllowed: boolean, what: string): ChatModel {
  const allowed = visible(list, openAllowed)
  if (!wanted) {
    if (!allowed.length) spec(`${what} has no model available for this account.`)
    return allowed[0]
  }
  const hit = list.find((m) => m.id === wanted)
  if (!hit) spec(`Unknown model "${wanted}" for ${what}. Allowed: ${allowed.map((m) => m.id).join(', ')}.`)
  if (hit.adult && !openAllowed) {
    spec(`"${wanted}" is not available for this account. Allowed: ${allowed.map((m) => m.id).join(', ')}.`)
  }
  return hit
}

function checkPrompt(p: Planner, text: string, negative?: string): void {
  const verdict = p.ctx.checkSafety(text, negative)
  if (verdict.blocked) spec(blockMessageFor(verdict.reason))
}

function inputNames(list: string[]): string {
  return list.length ? list.join(', ') : 'none'
}

export function imageSlotFor(name: string, slots: string[], imageSlots: string[]): string {
  if (slots.includes(name) || (name !== 'image' && name !== 'images')) return name
  const other = name === 'image' ? 'images' : 'image'
  return imageSlots.length === 1 && imageSlots[0] === other ? other : name
}

function aliasedValue(value: string | string[], aliased: boolean): string | string[] {
  return aliased && Array.isArray(value) && value.length === 1 ? value[0] : value
}

async function planCreate(p: Planner, s: IntentItemSpec, intent: CreateIntent, model: ChatModel | null): Promise<OrderRun> {
  const prompt = (s.prompt ?? '').trim()
  const modelId = model?.id ?? ''
  const studio = model ? STUDIO_MODELS[model.id] : undefined
  const classic = classicOptions(intent, modelId)
  const options = coerceOptionValues({ ...(s.options ?? {}) }, (key) => (studio ? studioFields(modelId)[key] : classic[key]))
  const mode = intent === 'character' ? (options.mode ?? 'train') : undefined
  if (studio) {
    try { studioOptions(modelId, prompt, options, false) } catch (err) { spec(errorText(err)) }
  } else {
    try { checkOptions(options, classic) } catch (err) { spec(errorText(err)) }
  }
  let character: { id: string; family: string } | null = null
  let useModel = modelId
  if (intent === 'character' && mode === 'use') {
    const shelf = p.ctx.characters.find((c) => c.id === options.character)
    if (!shelf) {
      spec(p.ctx.characters.length
        ? `Option "character" must be one of: ${p.ctx.characters.map((c) => `${c.id} (${c.name})`).join(', ')}.`
        : 'There is no trained character yet. Train one first (intent "character", mode "train").')
    }
    character = { id: shelf.id, family: shelf.family }
    useModel = resolveCharacterModel(shelf.family, '') ?? ''
    if (!useModel) spec('This character has no compatible generation model yet.')
  }
  const given = s.inputs ?? {}
  const inputs: Record<string, RunInput | RunInput[]> = {}
  const allowedSlots = createSlots(intent, modelId)
  const imageSlots = allowedSlots.filter((n) => SLOT_KIND[CREATE_SLOT_NAME[n]] === 'image')
  for (const [name, raw] of Object.entries(given)) {
    const known = imageSlotFor(name, allowedSlots, imageSlots)
    if (known !== name && given[known] !== undefined) spec(`Input "${name}" is the same place as "${known}". Give one of them.`)
    const value = aliasedValue(raw, known !== name)
    const slot = CREATE_SLOT_NAME[known]
    const place = intent === 'extend' && slot === 'video' ? 'extend' : intent === 'video_upscale' && slot === 'video' ? 'clip' : slot
    if (!slot || !allowedSlots.includes(known)) {
      spec(`Input "${name}" is not used by ${INTENT_LABEL[intent]}${modelId ? ` on ${modelId}` : ''}. Inputs: ${inputNames(allowedSlots)}.`)
    }
    if (place === 'train') {
      const list = Array.isArray(value) ? value : [value]
      inputs.train = list.map((h) => inputFor(p, name, h, 'image'))
    } else {
      if (Array.isArray(value)) spec(`Input "${name}" takes one handle, not a list.`)
      inputs[place] = inputFor(p, name, value, SLOT_KIND[place])
    }
  }
  const extendInput = inputs.extend
  if (intent === 'extend' && !studio && extendInput && !Array.isArray(extendInput) && extendInput.handle.startsWith('att:')) {
    spec(`Input "video": ${EXTEND_NEEDS_RESULT}`)
  }
  const width = intent === 'video' ? VIDEO_ASPECTS[String(options.aspect ?? '16:9')].width
    : intent === 'animate' ? 1280 : IMAGE_ASPECTS[String(options.aspect ?? '1:1')]?.width ?? 1024
  const height = intent === 'video' ? VIDEO_ASPECTS[String(options.aspect ?? '16:9')].height
    : intent === 'animate' ? 720 : IMAGE_ASPECTS[String(options.aspect ?? '1:1')]?.height ?? 1024
  const seconds = typeof options.duration === 'number' ? options.duration : 5
  const req: CreateRequest = {
    ...emptyRequest(intent),
    characterTab: mode === 'use' ? 'use' : 'train',
    cloudImageModel: ['image', 'edit', 'removebg', 'upscale'].includes(intent) ? modelId : '',
    cloudVideoModel: intent === 'video' || intent === 'animate' ? modelId : '',
    cloudOpModel: ['image', 'edit', 'removebg', 'upscale', 'video', 'animate'].includes(intent) ? '' : (mode === 'use' ? useModel : modelId),
    prompt,
    negativePrompt: typeof options.negative_prompt === 'string' ? options.negative_prompt : '',
    width, height,
    seed: typeof options.seed === 'number' ? options.seed : -1,
    frames: seconds * 16, fps: 16,
    musicDuration: typeof options.duration === 'number' ? options.duration : 60,
    musicLyrics: typeof options.lyrics === 'string' ? options.lyrics : '',
    triggerWord: typeof options.trigger_word === 'string' ? options.trigger_word : '',
    character,
    studioOptions: studio ? options : {},
    studioCredits: null,
    inputs: placeholderInputs(inputs),
  }
  const resolved = resolveCreateJob(req)
  if (model && resolved.model !== (mode === 'use' ? useModel : modelId)) spec(`"${modelId}" cannot run ${INTENT_LABEL[intent]}.`)
  const invalid = validateCreateJob(resolved, req, p.ctx.checkSafety)
  if (invalid) spec(inputHint(invalid, intent, allowedSlots))
  const params = await buildCreateParams(resolved, req, dryDeps)
  const submit = createJobSubmit(resolved, req, params)
  let price: RunPrice
  let outputSeconds: number | undefined
  if (resolved.studioModel) {
    const m = STUDIO_MODELS[resolved.studioModel]
    const measured = measuredSeconds(inputs, knownSeconds(p))
    price = await studioPrice(resolved.studioModel, prompt, options, { op: 'studio', studio_options: params.studio_options ?? {} }, measured, 1, p.deps)
    outputSeconds = studioOutputSeconds(m, studioOptions(resolved.studioModel, prompt, options, false), pricesByInput(resolved.studioModel) ? measured : undefined)
  } else {
    price = classicPrice(submit.model, params.op, routeCredits(submit), prompt, inputs, knownSeconds(p))
    outputSeconds = resolved.kind === 'video' && typeof params.frames === 'number' ? params.frames / (params.fps ?? 16)
      : resolved.kind === 'audio' ? params.duration : undefined
  }
  return {
    engine: 'create',
    title: INTENT_LABEL[intent],
    model: resolved.model,
    kind: resolved.op === 'lora-train' ? 'image' : resolved.kind,
    prompt,
    options,
    inputs,
    intent,
    characterTab: req.characterTab,
    character,
    price,
    outputSeconds,
    status: 'waiting',
  }
}

export function createSlots(intent: CreateIntent, model: string): string[] {
  switch (intent) {
    case 'edit': case 'removebg': case 'upscale': case 'animate': return ['image']
    case 'extend': case 'video_upscale': return ['video']
    case 'motion': return ['image', 'video']
    case 'character': return ['photos']
    case 'lipsync': {
      const clip = cloudModelById(model)?.lipsyncSource === 'video'
      if (clip) return ['video', 'audio']
      if (STUDIO_MODELS[model] && !STUDIO_MODELS[model].inputs.image) return ['audio']
      return ['image', 'audio']
    }
    default: return []
  }
}

function inputHint(message: string, intent: CreateIntent, slots: string[]): string {
  if (message === PROMPT_MISSING) return `${INTENT_LABEL[intent]} has no prompt. Put what to create into "prompt" of this item.`
  return slots.length ? `${message} ${INTENT_LABEL[intent]} inputs: ${slots.join(', ')} (handles).` : message
}

function emptyRequest(intent: CreateIntent): CreateRequest {
  return {
    intent, characterTab: 'train', cloudImageModel: '', cloudVideoModel: '', cloudOpModel: '', prompt: '',
    negativePrompt: '', width: 1024, height: 1024, steps: 20, cfg: 7, seed: -1, denoise: 0.7, growMaskBy: 6,
    frames: 80, fps: 16, musicDuration: 60, musicLyrics: '', triggerWord: '', character: null, studioOptions: {},
    studioCredits: null, inputs: {},
  }
}

function placeholderInputs(inputs: Record<string, RunInput | RunInput[]>): CreateInputs {
  const out: CreateInputs = {}
  const job = (i: number) => ({ type: 'job' as const, jobId: `placeholder-${i}` })
  for (const [slot, value] of Object.entries(inputs)) {
    if (slot === 'train') out.train = (value as RunInput[]).map((_, i) => job(i))
    else (out as Record<string, unknown>)[slot] = job(0)
  }
  return out
}

const dryDeps: Pick<CreateDeps, 'uploadInput' | 'adoptInput' | 'getJob'> = {
  uploadInput: async (_file, role) => `placeholder/${role}`,
  adoptInput: async (jobId, role) => `placeholder/${jobId}-${role}`,
  getJob: async (id) => ({ id, result_url: 'https://placeholder.invalid/result' }) as CloudJob,
}

async function planStep(
  p: Planner,
  preset: CreatePreset,
  index: number,
  s: StepSpec,
  carryFrom: MediaKind | null,
  title: string,
): Promise<OrderRun> {
  const raw = preset.steps[index]
  const alternatives = visible(presetModelsFor(preset, index), p.ctx.openAllowed)
  if (s.model !== undefined && !alternatives.some((m) => m.id === s.model)) {
    spec(`Unknown model "${s.model}" for ${title}. Allowed: ${alternatives.map((m) => m.id).join(', ')}.`)
  }
  const picked = s.model ?? (alternatives.some((m) => m.id === raw.model) ? raw.model : alternatives[0]?.id)
  if (!picked) spec(`${title} has no model available for this account.`)
  const r = resolvePresetStep(preset, index, picked)
  const prompt = (s.prompt ?? '').trim()
  const classic = stepClassicOptions(raw.role, r.step.model)
  const options = coerceOptionValues({ ...(s.options ?? {}) }, (key) => (r.studio ? r.fields[key] : classic[key]))
  if (r.studio) {
    try { studioOptions(r.step.model, prompt, options, false) } catch (err) { spec(errorText(err)) }
  } else {
    try { checkOptions(options, classic) } catch (err) { spec(errorText(err)) }
  }
  const carry = carryFrom ? presetSlotFor(r, carryFrom) : undefined
  const fields = stepFields(r)
  const inputs: Record<string, RunInput | RunInput[]> = {}
  const imageFields = Object.keys(fields).filter((n) => keyKind(fields[n]) === 'image')
  for (const [name, raw] of Object.entries(s.inputs ?? {})) {
    const known = imageSlotFor(name, Object.keys(fields), imageFields)
    if (known !== name && s.inputs?.[known] !== undefined) spec(`Input "${name}" is the same place as "${known}". Give one of them.`)
    const value = aliasedValue(raw, known !== name)
    const key = fields[known]
    if (!key) spec(`Input "${name}" is not used by ${title} on ${r.step.model}. Inputs: ${inputNames(Object.keys(fields))}.`)
    if (key === carry) spec(`Input "${name}" of ${title} comes from the previous step.`)
    const kind = keyKind(key)
    if (key === 'image_paths') {
      inputs[key] = (Array.isArray(value) ? value : [value]).map((h) => inputFor(p, name, h, kind))
    } else {
      if (Array.isArray(value)) spec(`Input "${name}" takes one handle, not a list.`)
      inputs[key] = inputFor(p, name, value, kind)
    }
  }
  const missing = r.required.filter((key) => key !== carry && !inputs[key])
  if (!r.studio && raw.role === 'extend' && carry !== 'source_url' && !inputs.source_url) missing.push('source_url')
  if (missing.length) {
    const names = Object.entries(fields).filter(([, key]) => missing.includes(key)).map(([name]) => name)
    spec(`${title} on ${r.step.model} needs: ${names.join(', ')} (handles).`)
  }
  const promptNeeded = r.studio
    ? (studioSchema(r.step.model).required ?? []).includes(r.studio.promptField ?? 'prompt')
    : ['image', 'animate', 'speech', 'music', 'extend', 'edit', 'restyle'].includes(raw.role)
  if (promptNeeded && !prompt) spec(`${title} has no ${raw.role === 'speech' ? 'text to speak' : 'prompt'}. Put it into "prompt" of that step.`)
  if (!r.studio && raw.role === 'speech' && r.step.model === 'qwen3-tts-design' && !options.voice_description) {
    spec(`${title} on qwen3-tts-design needs option "voice_description".`)
  }
  // The negative prompt the model wrote goes apart: it is where a model puts
  // "child, underage" to keep them OUT (B30, safety.ts).
  const { negative_prompt: negative, ...rest } = options
  checkPrompt(
    p,
    `${prompt} ${Object.values(rest).filter((v) => typeof v === 'string').join(' ')}`,
    typeof negative === 'string' ? negative : undefined,
  )
  const placeholder: Record<string, string | string[]> = {}
  for (const key of [...Object.keys(inputs), ...(carry ? [carry] : [])]) {
    placeholder[key] = key === 'image_paths' ? ['placeholder'] : key === 'source_url' ? 'https://placeholder.invalid/clip.mp4' : 'placeholder'
  }
  const images = Array.isArray(inputs.image_paths) ? inputs.image_paths.length : 1
  let price: RunPrice
  let outputSeconds: number | undefined
  const measureOf = { ...inputs, ...(carry && carryFrom ? { [carry]: { handle: 'carry', kind: carryFrom } } : {}) }
  const known = (h: string) => (h === 'carry' ? p.carrySeconds : knownSeconds(p)(h))
  const measured = measuredSeconds(measureOf, known, options.order)
  if (r.studio) {
    price = await studioPrice(r.step.model, prompt, options, buildPresetStepParams(r, {}, options), measured, images, p.deps)
    const filled = studioOptions(r.step.model, prompt, options, false)
    outputSeconds = r.step.kind === 'audio' && r.studio.price.mode === 'characters'
      ? Math.max(1, Math.ceil(Array.from(prompt).length / CHARS_PER_SECOND))
      : studioOutputSeconds(r.studio, filled, pricesByInput(r.step.model) ? measured : undefined)
  } else {
    const credits = presetEstimate(r, prompt, options, placeholder) ?? 0
    price = classicPrice(r.step.model, r.step.op, credits, prompt, measureOf, known)
    const p2 = buildPresetStepParams(r, placeholder, options)
    outputSeconds = r.step.kind === 'video' && typeof p2.frames === 'number' ? p2.frames / (p2.fps ?? 16)
      : raw.role === 'speech' ? Math.max(1, Math.ceil(Array.from(prompt).length / CHARS_PER_SECOND)) : undefined
  }
  return {
    engine: 'step',
    title,
    model: r.step.model,
    kind: r.step.kind,
    prompt,
    options,
    inputs,
    role: raw.role,
    presetId: preset.id,
    stepIndex: index,
    carry,
    price,
    outputSeconds,
    status: 'waiting',
  }
}

function keyKind(key: string): MediaKind {
  return key.includes('audio') ? 'audio' : key === 'video_path' || key === 'source_url' ? 'video' : 'image'
}

export function stepFields(r: ResolvedPresetStep): Record<string, string> {
  const fields = { ...r.inputs }
  if (!r.studio && r.raw.role === 'extend') fields.video = 'source_url'
  return fields
}

function presetModelsFor(preset: CreatePreset, index: number): ChatModel[] {
  return resolvePresetStep(preset, index).alternatives.map((m) => ({
    id: m.id, label: m.label, kind: m.kind, adult: m.adult, engine: 'step' as const, role: preset.steps[index].role,
  }))
}

export function roleStep(role: StepRole, model: string, title: string): CreatePreset {
  const kind = STUDIO_MODELS[model]?.kind ?? cloudModelById(model)?.kind ?? 'image'
  return {
    id: `chat-${role}`, title, summary: '', category: 'Video', adult: false, accent: '',
    steps: [{ model, kind, op: STUDIO_MODELS[model] ? 'studio' : 'generate', title, role }],
  }
}

async function planItem(p: Planner, s: ItemSpec, n: number): Promise<OrderItem> {
  if (isSpeech(s)) {
    const model = pickModel(speechModels(), s.model, p.ctx.openAllowed, 'Speech')
    const inputs: InputSpec = {}
    if (s.reference !== undefined) {
      const field = Object.entries(resolvePresetStep(roleStep('speech', model.id, 'Speech'), 0, model.id).inputs)[0]?.[0]
      if (!field) {
        const cloning = speechModels().filter((m) => Object.keys(resolvePresetStep(roleStep('speech', m.id, 'Speech'), 0, m.id).inputs).length)
        spec(`"${model.id}" does not take a reference voice. Models that do: ${cloning.map((m) => m.id).join(', ')}.`)
      }
      inputs[field] = s.reference
    }
    const run = await planStep(p, roleStep('speech', model.id, 'Speech'), 0, { prompt: s.speech, model: model.id, inputs, options: s.options }, null, 'Speech')
    return { n, type: 'speech', title: 'Speech', detail: `Voice · ${modelLabel(run.model)}`, kind: 'audio', runs: [run] }
  }
  if (isPreset(s)) {
    const preset = presetById(s.preset)
    if (!preset || (preset.adult && !p.ctx.openAllowed)) {
      spec(`Unknown preset "${s.preset}". Presets: ${visiblePresets(p.ctx.openAllowed).map((x) => x.id).join(', ')}.`)
    }
    const steps = s.steps ?? []
    if (steps.length > preset.steps.length) spec(`Preset "${preset.id}" has ${preset.steps.length} step(s), not ${steps.length}.`)
    const runs: OrderRun[] = []
    p.carrySeconds = undefined
    for (let i = 0; i < preset.steps.length; i++) {
      const title = preset.steps[i].title
      const run = await planStep(p, preset, i, steps[i] ?? {}, i > 0 ? runs[i - 1].kind : null, title)
      p.carrySeconds = run.outputSeconds
      runs.push(run)
    }
    const last = runs[runs.length - 1]
    return {
      n, type: 'preset', title: preset.title,
      detail: runs.length > 1 ? `Preset · ${runs.length} steps` : `Preset · ${modelLabel(last.model)}`,
      kind: last.kind, runs,
    }
  }
  if (!isIntent(s)) spec('Each item needs "intent", "preset" or "speech".')
  const intent = s.intent as CreateIntent
  if (intent === 'eraser') spec(ERASE_REFUSAL)
  if (!INTENT_KIND[intent]) {
    spec(`Unknown intent "${s.intent}". Intents: ${Object.keys(INTENT_LABEL).filter((i) => i !== 'eraser').join(', ')}.`)
  }
  const list = intentModels(intent)
  if (!list.length) {
    if (s.model !== undefined) spec(`${INTENT_LABEL[intent]} has no model choice. Leave "model" out.`)
    const run = await planCreate(p, s, intent, null)
    return { n, type: 'intent', title: INTENT_LABEL[intent], detail: INTENT_LABEL[intent], kind: run.kind, runs: [run] }
  }
  const model = pickModel(list, s.model, p.ctx.openAllowed, INTENT_LABEL[intent])
  if (model.engine === 'step' && model.role) {
    const run = await planStep(p, roleStep(model.role, model.id, INTENT_LABEL[intent]), 0,
      { prompt: s.prompt, model: model.id, inputs: s.inputs, options: s.options }, null, INTENT_LABEL[intent])
    return { n, type: 'intent', title: INTENT_LABEL[intent], detail: `${INTENT_LABEL[intent]} · ${model.label}`, kind: run.kind, runs: [run] }
  }
  checkPrompt(p, `${s.prompt ?? ''}`)
  const run = await planCreate(p, s, intent, model)
  return { n, type: 'intent', title: INTENT_LABEL[intent], detail: `${detailFor(run)} · ${modelLabel(run.model)}`, kind: run.kind, runs: [run] }
}

function detailFor(run: OrderRun): string {
  if (run.kind === 'video' && run.outputSeconds) return `Clip ${run.outputSeconds} s`
  if (run.kind === 'audio' && run.outputSeconds) return `Track ${run.outputSeconds} s`
  return run.title
}

export async function planOrder(specs: ItemSpec[], ctx: PlanContext, deps: PriceDeps): Promise<Order> {
  if (!Array.isArray(specs) || specs.length === 0) spec('An order needs at least one item.')
  if (specs.length > MAX_ITEMS) spec(`An order takes at most ${MAX_ITEMS} items.`)
  const p: Planner = { ctx, deps, items: [] }
  for (const [i, s] of specs.entries()) {
    try {
      p.items.push(await planItem(p, s, i + 1))
    } catch (err) {
      if (err instanceof OrderSpecError) throw new OrderSpecError(`Item ${i + 1}: ${err.message}`)
      if (err instanceof CreateInputError) throw new OrderSpecError(`Item ${i + 1}: ${err.message}`)
      throw err
    }
  }
  return {
    id: ctx.newId(),
    conversationId: ctx.conversationId,
    createdAt: ctx.now,
    state: 'awaiting',
    items: p.items,
    spentBefore: ctx.spentBefore,
  }
}

export function runCredits(run: OrderRun): number {
  return run.requoted ?? run.approvedCredits ?? run.price.credits
}

export interface OrderSum {
  order: number
  estimated: boolean
  spentBefore: number
  together: number
}

export function orderSum(order: Order): OrderSum {
  let sum = 0
  let estimated = false
  for (const item of order.items) for (const run of item.runs) {
    if (run.status === 'done') { sum += run.spent ?? runCredits(run); continue }
    if (run.status === 'failed') continue
    sum += runCredits(run)
    if (run.price.estimated) estimated = true
  }
  return { order: sum, estimated, spentBefore: order.spentBefore, together: order.spentBefore + sum }
}

export function conversationSpent(orders: Order[]): number {
  let sum = 0
  for (const o of orders) for (const item of o.items) for (const run of item.runs) {
    if (run.status === 'done') sum += run.spent ?? 0
  }
  return sum
}

export function orderDifference(order: Order): { item: number; credits: number; approved: number; difference: number } | null {
  if (order.state !== 'repricing') return null
  for (const item of order.items) for (const run of item.runs) {
    if (run.requoted !== undefined) {
      const approved = run.approvedCredits ?? run.price.credits
      return { item: item.n, credits: run.requoted, approved, difference: run.requoted - approved }
    }
  }
  return null
}

export function approveOrder(order: Order, now: number): Order {
  if (order.state !== 'awaiting') return order
  return {
    ...order,
    state: 'running',
    approvedAt: now,
    items: order.items.map((item) => ({
      ...item,
      runs: item.runs.map((run) => ({ ...run, approvedCredits: run.price.credits })),
    })),
  }
}

export function declineOrder(order: Order): Order {
  return order.state === 'awaiting' ? { ...order, state: 'declined' } : order
}

export function approveDifference(order: Order): Order {
  if (order.state !== 'repricing') return order
  return {
    ...order,
    state: 'running',
    note: undefined,
    items: order.items.map((item) => ({
      ...item,
      runs: item.runs.map((run) => (run.requoted !== undefined
        ? { ...run, approvedCredits: run.requoted, requoted: undefined, error: undefined }
        : run)),
    })),
  }
}

export class OrderNotApprovedError extends Error {
  constructor() {
    super('This order has not been approved. Nothing was started and nothing was charged.')
    this.name = 'OrderNotApprovedError'
  }
}

export interface ExecuteDeps extends RunDeps, Pick<CreateDeps, 'uploadInput' | 'adoptInput' | 'getJob'> {
  handles: () => Omit<HandleContext, 'items'>
  signal?: AbortSignal
  onUpdate: (order: Order) => void
  newRequestId: () => string
}

export function timeoutFor(run: OrderRun): number {
  if (run.engine === 'step') return 125 * 60_000
  return run.kind === 'video' || run.intent === 'character' ? 45 * 60_000 : 15 * 60_000
}

function itemResult(order: Order, n: number): { jobId: string; kind: MediaKind } | undefined {
  const item = order.items.find((i) => i.n === n)
  const last = item?.runs[item.runs.length - 1]
  return last?.status === 'done' && last.jobId ? { jobId: last.jobId, kind: last.kind } : undefined
}

function mediaOf(order: Order, input: RunInput, deps: ExecuteDeps, before: number): MediaRef {
  const items = order.items.filter((i) => i.n < before).map(asHandleItem)
  const hit = resolveHandle(input.handle, { ...deps.handles(), items })
  if (hit.ref.type === 'item') {
    const result = itemResult(order, hit.ref.n)
    if (!result) throw new Error(`Item ${hit.ref.n} has no result to use.`)
    return { type: 'job', jobId: result.jobId }
  }
  if (hit.ref.type === 'job') return { type: 'job', jobId: hit.ref.jobId }
  if (hit.ref.type === 'blob') return { type: 'blob', blob: hit.ref.blob }
  return { type: 'dataUrl', url: hit.ref.url }
}

async function stepPaths(order: Order, item: OrderItem, run: OrderRun, index: number, deps: ExecuteDeps): Promise<Record<string, string | string[]>> {
  const paths: Record<string, string | string[]> = {}
  const stage = async (key: string, ref: MediaRef): Promise<string> => {
    if (key === 'source_url') {
      if (ref.type !== 'job') throw new Error('The source clip must be one of your results.')
      const src = await deps.getJob(ref.jobId)
      if (!src.result_url) throw new Error('The source clip has expired. Re-render it first.')
      return src.result_url
    }
    if (ref.type === 'job') return adoptResult(deps.adoptInput, ref.jobId, presetAdoptRole(key))
    if (ref.type === 'dataUrl') return deps.uploadInput(await dataUrlToBlob(ref.url), presetUploadRole(key) as UploadRole)
    return deps.uploadInput(ref.blob, presetUploadRole(key) as UploadRole)
  }
  for (const [key, value] of Object.entries(run.inputs)) {
    if (Array.isArray(value)) {
      const list: string[] = []
      for (const v of value) list.push(await stage(key, mediaOf(order, v, deps, item.n)))
      paths[key] = list
    } else {
      paths[key] = await stage(key, mediaOf(order, value, deps, item.n))
    }
  }
  if (run.carry) {
    const prev = item.runs[index - 1]
    if (!prev?.jobId) throw new Error('The previous step has no result to use.')
    const path = await stage(run.carry, { type: 'job', jobId: prev.jobId })
    paths[run.carry] = run.carry === 'image_paths' ? [path] : path
  }
  return paths
}

async function createSubmit(order: Order, item: OrderItem, run: OrderRun, deps: ExecuteDeps, approved: number, requestId: string): Promise<CloudJobSubmit> {
  const inputs: CreateInputs = {}
  for (const [slot, value] of Object.entries(run.inputs)) {
    if (Array.isArray(value)) {
      inputs.train = value.map((v) => mediaOf(order, v, deps, item.n)) as CreateInputs['train']
    } else {
      (inputs as Record<string, unknown>)[slot] = mediaOf(order, value, deps, item.n)
    }
  }
  const o = run.options
  const intent = run.intent!
  const req: CreateRequest = {
    ...emptyRequest(intent),
    characterTab: run.characterTab ?? 'train',
    cloudImageModel: ['image', 'edit', 'removebg', 'upscale'].includes(intent) ? run.model : '',
    cloudVideoModel: intent === 'video' || intent === 'animate' ? run.model : '',
    cloudOpModel: ['image', 'edit', 'removebg', 'upscale', 'video', 'animate'].includes(intent) ? '' : run.model,
    prompt: run.prompt,
    negativePrompt: typeof o.negative_prompt === 'string' ? o.negative_prompt : '',
    width: intent === 'video' ? VIDEO_ASPECTS[String(o.aspect ?? '16:9')].width : intent === 'animate' ? 1280 : IMAGE_ASPECTS[String(o.aspect ?? '1:1')]?.width ?? 1024,
    height: intent === 'video' ? VIDEO_ASPECTS[String(o.aspect ?? '16:9')].height : intent === 'animate' ? 720 : IMAGE_ASPECTS[String(o.aspect ?? '1:1')]?.height ?? 1024,
    seed: typeof o.seed === 'number' ? o.seed : -1,
    frames: (typeof o.duration === 'number' ? o.duration : 5) * 16,
    fps: 16,
    musicDuration: typeof o.duration === 'number' ? o.duration : 60,
    musicLyrics: typeof o.lyrics === 'string' ? o.lyrics : '',
    triggerWord: typeof o.trigger_word === 'string' ? o.trigger_word : '',
    character: run.character ?? null,
    studioOptions: STUDIO_MODELS[run.model] ? o : {},
    studioCredits: approved,
    inputs,
  }
  const resolved = resolveCreateJob(req)
  const params = await buildCreateParams(resolved, req, { ...deps, signal: deps.signal })
  params.max_credits = approved
  params.client_request_id = requestId
  return createJobSubmit(resolved, req, params)
}

async function stepSubmit(order: Order, item: OrderItem, run: OrderRun, index: number, deps: ExecuteDeps, approved: number, requestId: string): Promise<CloudJobSubmit> {
  const preset = run.presetId && presetById(run.presetId) ? presetById(run.presetId)! : roleStep(run.role!, run.model, run.title)
  const r = resolvePresetStep(preset, run.stepIndex ?? 0, run.model)
  const paths = await stepPaths(order, item, run, index, deps)
  return presetStepSubmit(r, run.prompt, paths, run.options, { credits: approved, requestId })
}

function replaceRun(order: Order, n: number, index: number, patch: Partial<OrderRun>): Order {
  return {
    ...order,
    items: order.items.map((item) => (item.n !== n ? item : {
      ...item,
      runs: item.runs.map((run, i) => (i === index ? { ...run, ...patch } : run)),
    })),
  }
}

export const INTERRUPTED_ERROR = 'Interrupted by a reload.'
export const STOPPED_LATE_ERROR = 'Stopped too late: it was already rendering.'
export const LOST_TRACK_ERROR = 'Still with LU Cloud: its answer did not arrive yet.'
export const INTERRUPTED_NOTE =
  'Interrupted by a reload. Finished items stay; an item that was rendering may still finish in your gallery.'

export function markInterrupted(order: Order): Order {
  if (order.state !== 'running') return order
  return {
    ...order,
    state: 'stopped',
    note: INTERRUPTED_NOTE,
    items: order.items.map((item) => ({
      ...item,
      runs: item.runs.map((run) => (run.status === 'queued' || run.status === 'running'
        ? { ...run, status: 'failed' as const, refunded: false, error: INTERRUPTED_ERROR, interrupted: true }
        : run)),
    })),
  }
}

function serverJobId(run: OrderRun): string | undefined {
  return run.jobId ?? run.requestId
}

export function interruptedRuns(order: Order): { n: number; index: number; jobId: string }[] {
  const out: { n: number; index: number; jobId: string }[] = []
  for (const item of order.items) {
    item.runs.forEach((run, index) => {
      const jobId = serverJobId(run)
      if (run.interrupted && jobId) out.push({ n: item.n, index, jobId })
    })
  }
  return out
}

export function resumeInterrupted(order: Order, n: number, index: number): Order {
  const run = order.items.find((i) => i.n === n)?.runs[index]
  return {
    ...replaceRun(order, n, index, { status: 'running', error: undefined, refunded: undefined, jobId: run && serverJobId(run) }),
    state: 'running', note: undefined,
  }
}

export function settleInterrupted(order: Order, n: number, index: number, job: CloudJob): Order {
  const run = order.items.find((i) => i.n === n)?.runs[index]
  if (!run?.interrupted) return order
  const jobId = serverJobId(run)
  let next: Order
  if (job.status === 'succeeded' && (job.result_url || run.intent === 'character')) {
    next = replaceRun(order, n, index, {
      status: 'done', jobId, resultUrl: job.result_url ?? undefined, spent: job.cost_units,
      error: undefined, refunded: undefined, interrupted: undefined, stoppedLate: undefined, lostTrack: undefined,
    })
  } else if (job.status === 'canceled') {
    next = replaceRun(order, n, index, { status: 'failed', jobId, refunded: true, spent: 0, error: 'Stopped.', interrupted: undefined, stoppedLate: undefined, lostTrack: undefined })
  } else if (job.status === 'failed' || job.status === 'succeeded') {
    next = replaceRun(order, n, index, { status: 'failed', jobId, refunded: true, spent: 0, error: failedJobText(job), interrupted: undefined, stoppedLate: undefined, lostTrack: undefined })
  } else {
    return order
  }
  const runs = next.items.flatMap((i) => i.runs)
  if (runs.every((r) => r.status === 'done')) {
    return { ...next, state: 'done', note: run.stoppedLate ? `Your stop came after item ${n} had started rendering. It finished and was charged.` : undefined }
  }
  const finished = next.items.find((i) => i.n === n)?.runs[index].status === 'done'
  if (run.stoppedLate) {
    return {
      ...next,
      state: 'stopped',
      note: finished
        ? `You stopped this order after item ${n} had started rendering. It finished and was charged; items that had not started were not run and not charged.`
        : `You stopped this order. Item ${n} did not finish and was refunded; items that had not started were not run and not charged.`,
    }
  }
  if (run.lostTrack) {
    return {
      ...next,
      state: 'stopped',
      note: finished
        ? `Item ${n} has finished on LU Cloud after all and was charged.`
        : `Item ${n} did not finish on LU Cloud and was refunded.`,
    }
  }
  return {
    ...next,
    state: 'stopped',
    note: finished
      ? 'The page was reloaded while this order ran. The item that was rendering has finished; items that had not started were not run and not charged.'
      : `The page was reloaded while this order ran. Item ${n} did not finish and was refunded; items that had not started were not run and not charged.`,
  }
}

export async function executeOrder(start: Order, deps: ExecuteDeps): Promise<Order> {
  if (start.state !== 'running' || !start.approvedAt) throw new OrderNotApprovedError()
  let order = start
  const emit = (next: Order) => { order = next; deps.onUpdate(order) }
  for (const item of start.items) {
    for (let index = 0; index < item.runs.length; index++) {
      const run = order.items.find((i) => i.n === item.n)!.runs[index]
      if (run.status === 'done') continue
      const approved = run.approvedCredits
      if (approved === undefined) throw new OrderNotApprovedError()
      if (deps.signal?.aborted) { emit({ ...order, state: 'stopped' }); return order }
      const requestId = run.requestId ?? deps.newRequestId()
      emit(replaceRun(order, item.n, index, { status: 'queued', requestId, error: undefined }))
      let polling = false
      try {
        const current = order.items.find((i) => i.n === item.n)!
        const submit = run.engine === 'create'
          ? await createSubmit(order, current, run, deps, approved, requestId)
          : await stepSubmit(order, current, run, index, deps, approved, requestId)
        if (deps.signal?.aborted) { emit({ ...replaceRun(order, item.n, index, { status: 'waiting' }), state: 'stopped' }); return order }
        const job = await runCloudJob(submit, deps, {
          signal: deps.signal,
          timeoutMs: timeoutFor(run),
          onSubmitted: (id) => emit(replaceRun(order, item.n, index, { jobId: id })),
          onPolling: () => { polling = true },
          onTick: (j) => { if (j.status === 'running') emit(replaceRun(order, item.n, index, { status: 'running' })) },
        })
        if (job.status === 'succeeded' && (job.result_url || run.intent === 'character')) {
          emit(replaceRun(order, item.n, index, {
            status: 'done', jobId: job.id, resultUrl: job.result_url ?? undefined, spent: job.cost_units,
          }))
          continue
        }
        if (job.status === 'canceled') {
          emit({ ...replaceRun(order, item.n, index, { status: 'failed', refunded: true, spent: 0, error: 'Stopped.' }), state: 'stopped' })
          return order
        }
        emit({
          ...replaceRun(order, item.n, index, { status: 'failed', refunded: true, spent: 0, error: failedJobText(job) }),
          state: 'stopped', note: `Item ${item.n} failed. Finished items stay, the failed one was refunded.`,
        })
        return order
      } catch (err) {
        const failure = describeSubmitError(err)
        if (deps.signal?.aborted && failure.kind !== 'aborted' && !order.items.find((i) => i.n === item.n)!.runs[index].jobId) {
          emit({
            ...replaceRun(order, item.n, index, { status: 'waiting' }),
            state: 'stopped',
            note: 'Stopped. Items that had not started were not charged.',
          })
          return order
        }
        if (failure.kind === 'quote_changed' && failure.credits != null) {
          emit({
            ...replaceRun(order, item.n, index, { status: 'waiting', requoted: failure.credits, jobId: undefined }),
            state: 'repricing',
            note: `Item ${item.n} now costs ${(failure.credits - approved).toLocaleString('en-US')} credits more than approved. Nothing was charged for it.`,
          })
          return order
        }
        if (failure.kind === 'aborted') {
          const jobId = order.items.find((i) => i.n === item.n)!.runs[index].jobId
          let refunded = !polling && !!jobId
          if (jobId) {
            try {
              const res = await deps.cancelJob(jobId) as { refunded?: boolean } | undefined
              refunded = res?.refunded !== false
            } catch {
              refunded = false
            }
          }
          emit({
            ...replaceRun(order, item.n, index, !jobId
              ? { status: 'waiting' }
              : refunded
                ? { status: 'failed', refunded: true, spent: 0, error: 'Stopped.' }
                : { status: 'failed', refunded: false, error: STOPPED_LATE_ERROR, interrupted: true, stoppedLate: true }),
            state: 'stopped',
            note: jobId && !refunded
              ? `Item ${item.n} was already rendering and cannot be recalled. It is charged if it finishes. Items that had not started were not charged.`
              : 'Stopped. Items that had not started were not charged.',
          })
          return order
        }
        const sentId = order.items.find((i) => i.n === item.n)!.runs[index].jobId
        if (polling && sentId) {
          emit({
            ...replaceRun(order, item.n, index, { status: 'failed', refunded: false, error: LOST_TRACK_ERROR, interrupted: true, lostTrack: true }),
            state: 'stopped',
            note: `Item ${item.n} is with LU Cloud, but its answer did not arrive (${failure.text ?? 'no reply'}). LU keeps checking; it is charged only if it finishes.`,
          })
          return order
        }
        const text = err instanceof HandleError ? err.message : failure.text ?? 'Could not start this item.'
        emit({
          ...replaceRun(order, item.n, index, { status: 'failed', refunded: false, spent: 0, error: text }),
          state: 'stopped', note: `Item ${item.n} could not start. Finished items stay.`,
        })
        return order
      }
    }
  }
  emit({ ...order, state: 'done', note: undefined })
  return order
}

export const ORDER_RESULT_PREFIX = 'Order '
const ORDER_ID = /^Order ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) /

export function orderIdFromToolResult(toolName: string, result: unknown): string | null {
  if (toolName !== 'create_order' || typeof result !== 'string') return null
  return ORDER_ID.exec(result)?.[1] ?? null
}

export function toOrderView(order: Order): OrderView {
  const items: OrderItemView[] = order.items.map((item) => {
    const statuses = item.runs.map((r) => r.status)
    const status: OrderItemStatus = statuses.includes('running') ? 'running'
      : statuses.includes('queued') ? 'queued'
      : statuses.every((s) => s === 'done') ? 'done'
      : statuses.includes('failed') ? 'failed'
      : 'waiting'
    const open = item.runs.filter((r) => r.status !== 'failed')
    const view: OrderItemView = {
      id: `${order.id}:${item.n}`,
      title: item.title,
      detail: item.detail,
      kind: item.kind,
      credits: open.reduce((sum, r) => sum + runCredits(r), 0),
      status,
    }
    if (open.some((r) => r.price.estimated && r.status !== 'done')) view.estimated = true
    if (status === 'done') view.spent = item.runs.reduce((sum, r) => sum + (r.spent ?? 0), 0)
    const failed = item.runs.find((r) => r.status === 'failed')
    if (failed) { view.error = failed.error; view.refunded = failed.refunded === true }
    const repriced = item.runs.find((r) => r.requoted !== undefined)
    if (repriced && !view.error) {
      view.error = `Now ${(repriced.requoted! - (repriced.approvedCredits ?? repriced.price.credits)).toLocaleString('en-US')} credits more than approved.`
    }
    if (item.runs.length > 1) {
      view.steps = item.runs.map((r): OrderStepView => ({
        title: r.title, model: modelLabel(r.model), credits: runCredits(r),
        status: r.status,
      }))
    }
    return view
  })
  return {
    id: order.id,
    state: order.state === 'repricing' ? 'awaiting' : order.state,
    items,
    ...(order.spentBefore > 0 ? { spentBefore: order.spentBefore } : {}),
  }
}
