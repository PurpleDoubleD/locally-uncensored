// MIRRORED from the web app (lib/create/engine.ts), without its comments. Do not edit here.
// scripts/create-chat-mirror.mjs writes this file, and web-parity.test.ts
// holds it to its source. Only the import paths differ, the places listed
// under PATCHES in that script, and the classes under CLASSES.
import { lengthPrice, lengthCredits } from './bridge/credits'
import type { CreateIntent } from './bridge/create-store'
import type { RenderKind, RenderOp } from '../render/cloud-jobs'
import {
  CloudJobError, intentToJob, jobFileUrl,
  type AdoptRole, type CloudJob, type CloudJobParams, type CloudJobSubmit, type UploadRole,
} from './bridge/cloud-jobs'
import {
  cloudModelById, defaultCloudModel, editNeedsMask, modelForOp, resolveCharacterModel, resolveOpPick, utilityOpModel,
} from './bridge/cloud-models'
import {
  intentRequiredInputs, intentRoles, isStudioModel, resolveIntentPick, studioExtraPhotoSlots,
} from '../render/create-studio'
import {
  STUDIO_MODELS, studioFields, studioOptions, studioPreviewCredits, studioSchema, supportsProviderField,
  type Schema, type StudioModel,
} from '../render/studio-contract'
import {
  classicCredits, presetModel, presetModels, requiredRoleInputs, roleInputs, rolePrompts, type PresetModel,
} from './bridge/preset-models'
import type { CreatePreset, PresetStep } from '../render/create-presets'
import { selectedVideoSeconds } from '../render/video-duration'
import { blockMessageFor, type SafetyVerdict } from '../render/safety'
import { dataUrlToBlob } from '../render/data-url'
import type { ExhaustedReason } from '../credits-exhausted'

export type MediaRef =
  | { type: 'dataUrl'; url: string; width?: number; height?: number }
  | { type: 'blob'; blob: Blob }
  | { type: 'job'; jobId: string }

export type MediaOf<T extends MediaRef['type']> = Extract<MediaRef, { type: T }>

export interface CreateInputs {
  source?: MediaOf<'dataUrl'> | MediaOf<'job'> | null
  references?: (MediaOf<'dataUrl'> | MediaOf<'job'>)[]
  mask?: MediaOf<'dataUrl'> | null
  video?: MediaOf<'blob'> | MediaOf<'job'> | null
  audio?: MediaOf<'blob'> | MediaOf<'job'> | null
  extend?: MediaOf<'job'> | MediaOf<'blob'> | null
  clip?: MediaOf<'job'> | MediaOf<'blob'> | null
  train?: (MediaOf<'blob'> | MediaOf<'dataUrl'> | MediaOf<'job'>)[]
}

export interface CreateRequest {
  intent: CreateIntent
  characterTab: 'train' | 'use'
  cloudImageModel: string
  cloudVideoModel: string
  cloudOpModel: string
  prompt: string
  negativePrompt: string
  width: number
  height: number
  steps: number
  cfg: number
  seed: number
  denoise: number
  growMaskBy: number
  frames: number
  fps: number
  musicDuration: number
  musicLyrics: string
  triggerWord: string
  character: { id: string; family: string } | null
  studioOptions: Record<string, unknown>
  studioCredits: number | null
  inputs: CreateInputs
}

export interface ResolvedCreateJob {
  intent: CreateIntent
  kind: RenderKind
  op: RenderOp
  model: string
  galleryModel: string
  studioModel?: string
  characterUse: boolean
}

/** `negative` is the negative prompt, checked apart (safety.ts, B30). */
export type PromptSafetyCheck = (text: string, negative?: string) => SafetyVerdict

export interface CreateDeps {
  uploadInput: (file: Blob, role: UploadRole) => Promise<string>
  adoptInput: (jobId: string, role: AdoptRole) => Promise<string>
  getJob: (id: string) => Promise<CloudJob>
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  signal?: AbortSignal
}

export type CreateProgress = (progress: number, text: string) => void

export class CreateInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CreateInputError'
  }
}

const SPECIAL_OPS = new Set<RenderOp>(['lipsync', 'extend', 'motion', 'music', 'tts', 'lora-train'])

const OP_GALLERY_LABEL: Partial<Record<RenderOp, string>> = {
  lipsync: 'Talking character',
  motion: 'Motion transfer',
  removebg: 'Background removed',
  upscale: 'Upscaled',
  eraser: 'Object erased',
  extend: 'Extended clip',
  music: 'Track',
  tts: 'Voice',
}

export function createGalleryLabel(op: RenderOp): string | undefined {
  return OP_GALLERY_LABEL[op]
}

function isVideoUpscale(job: ResolvedCreateJob): boolean {
  return job.op === 'upscale' && job.kind === 'video'
}

export function resolveCreateJob(req: CreateRequest): ResolvedCreateJob {
  const intent = req.intent
  let { kind, op } = intentToJob(intent)
  const characterUse = intent === 'character' && req.characterTab === 'use'
  if (characterUse) {
    kind = 'image'
    op = 'generate'
  }
  const specialOp = SPECIAL_OPS.has(op)
  const roleIntent = !characterUse && intentRoles(intent).length > 0
  let picked: string
  if (characterUse) {
    picked = resolveCharacterModel(req.character?.family ?? '', req.cloudOpModel) ?? ''
  } else if (roleIntent) {
    picked = resolveIntentPick(intent, req.cloudOpModel)
  } else if (specialOp) {
    picked = resolveOpPick(op, req.cloudOpModel)
  } else {
    picked = (kind === 'video' ? req.cloudVideoModel : req.cloudImageModel) || defaultCloudModel(kind).id
  }
  const model = roleIntent || characterUse ? picked : modelForOp(kind, op, picked)
  const galleryModel = !roleIntent && model !== picked && model === utilityOpModel(kind, op, picked) ? picked : model
  const studioModel = isStudioModel(model) ? model : undefined
  if (studioModel) kind = STUDIO_MODELS[studioModel].kind
  if (specialOp || characterUse) kind = cloudModelById(model)?.kind ?? kind
  return { intent, kind, op, model, galleryModel, studioModel, characterUse }
}

export const PROMPT_MISSING = 'Please enter a prompt.'

export function validateCreateJob(
  job: ResolvedCreateJob,
  req: CreateRequest,
  checkSafety: PromptSafetyCheck,
): string | null {
  const { intent, op, model, studioModel, characterUse } = job
  const inputs = req.inputs
  if ((op === 'generate' || op === 'music') && req.prompt.trim().length === 0) {
    return PROMPT_MISSING
  }
  const safety = checkSafety(`${req.prompt} ${req.musicLyrics} ${req.triggerWord}`, req.negativePrompt)
  if (safety.blocked) return blockMessageFor(safety.reason)
  if (characterUse && !req.character) return 'Pick a character from your shelf first, or train one.'
  if (characterUse && !model) return 'This character has no compatible generation model yet.'
  if (op === 'lora-train' && (inputs.train?.length ?? 0) < 4) {
    return 'Add at least 4 photos of your character (more is better, up to 30).'
  }
  if (op === 'lipsync') {
    if (!inputs.audio) return 'Add a voice first: upload an audio file or generate one.'
    const needsClip = cloudModelById(model)?.lipsyncSource === 'video'
    const needsPhoto = studioModel ? intentRequiredInputs(intent, studioModel).includes('source_path') : !needsClip
    if (needsClip ? !inputs.video : needsPhoto && !inputs.source) {
      return needsClip ? 'Add the video clip to re-sync.' : 'Add a portrait image for your character.'
    }
  }
  if (op === 'extend' && !inputs.extend) return 'Pick one of your cloud videos to extend.'
  if (op === 'motion' && (!inputs.source || !inputs.video)) {
    return 'Motion control needs a character image and a driving video.'
  }
  if (isVideoUpscale(job)) {
    if (!inputs.clip) return 'Generate a video first. Enhance Video sharpens your most recent clip.'
  } else if (!SPECIAL_OPS.has(op) && op !== 'generate' && !inputs.source) {
    return 'Add a source image first.'
  }
  return null
}

export const EXTEND_NEEDS_RESULT =
  'This model can only continue one of your own results. Pick a result or a gallery clip, or choose another extend model for an uploaded clip.'

const EXPIRED: Record<AdoptRole, string> = {
  video: 'That clip has expired. Re-render it first.',
  audio: 'That audio has expired. Create it again first.',
  image: 'That image has expired. Create it again first.',
}

export async function adoptResult(adoptInput: CreateDeps['adoptInput'], jobId: string, role: AdoptRole): Promise<string> {
  try {
    return await adoptInput(jobId, role)
  } catch (err) {
    if (err instanceof CloudJobError && (err.status === 404 || err.status === 409)) throw new Error(EXPIRED[role])
    throw err
  }
}

export async function buildCreateParams(
  job: ResolvedCreateJob,
  req: CreateRequest,
  deps: Pick<CreateDeps, 'uploadInput' | 'adoptInput' | 'getJob' | 'signal'>,
  onStep?: CreateProgress,
): Promise<CloudJobParams> {
  const { kind, op, model, studioModel, characterUse } = job
  const { uploadInput, adoptInput, getJob, signal } = deps
  const inputs = req.inputs
  const specialOp = SPECIAL_OPS.has(op)
  const stageImage = async (ref: MediaOf<'dataUrl'> | MediaOf<'job'>, role: 'source' | 'train'): Promise<string> =>
    ref.type === 'job' ? adoptResult(adoptInput, ref.jobId, 'image') : uploadInput(await dataUrlToBlob(ref.url), role)
  const params: CloudJobParams = { op: studioModel ? 'studio' : op }
  if (studioModel) {
    const allowed = studioFields(studioModel)
    params.studio_options = Object.fromEntries(
      Object.entries(req.studioOptions).filter(([key]) => allowed[key] !== undefined),
    )
    if (req.studioCredits != null) params.max_credits = req.studioCredits
  } else if (lengthPrice(model, op)) {
    params.max_credits = req.studioCredits ?? lengthCredits(model)
  }
  const editIsMaskless = op === 'edit' && !editNeedsMask(model)
  if (op === 'generate' || op === 'animate' || op === 'edit') {
    params.negative_prompt = supportsProviderField(model, 'negative_prompt', op) ? (req.negativePrompt || undefined) : undefined
    params.width = req.width
    params.height = req.height
    params.steps = req.steps
    params.cfg = req.cfg
    params.seed = req.seed === -1 ? undefined : req.seed
  }
  const sourceSize = inputs.source?.type === 'dataUrl' ? inputs.source : undefined
  if (op === 'edit' && sourceSize?.width && sourceSize?.height) {
    params.width = sourceSize.width
    params.height = sourceSize.height
  }
  if (kind === 'video' && (op === 'generate' || op === 'animate')) {
    const seconds = selectedVideoSeconds(model, req.frames, req.fps)
    params.frames = seconds * 16
    params.fps = 16
  }
  if (op === 'edit' && !editIsMaskless) {
    params.denoise = req.denoise
  }
  if ((op === 'edit' && !editIsMaskless) || op === 'eraser') {
    params.grow_mask_by = req.growMaskBy
  }
  if (op === 'upscale' && !studioModel) {
    params.target_resolution = kind === 'video' ? '1080p' : '4k'
  }
  if (op === 'music' && !studioModel) {
    params.duration = req.musicDuration
    if (req.musicLyrics.trim()) params.lyrics = req.musicLyrics.trim()
  }
  if (op === 'lora-train') {
    params.trigger_word = req.triggerWord || 'oxlu'
    if (req.triggerWord) params.name = req.triggerWord
  }
  if (characterUse && req.character) {
    params.loras = [{ id: req.character.id }]
  }
  if (isVideoUpscale(job) && inputs.clip) {
    onStep?.(6, 'Uploading video…')
    params.video_path = inputs.clip.type === 'blob'
      ? await uploadInput(inputs.clip.blob, 'video')
      : await adoptResult(adoptInput, inputs.clip.jobId, 'video')
  } else if (op !== 'generate' && !specialOp && inputs.source) {
    params.source_path = await stageImage(inputs.source, 'source')
    if (studioModel) {
      const reads = Object.values(STUDIO_MODELS[studioModel].inputs)
      if (reads.includes('image_paths')) {
        const extras = job.intent === 'edit' || job.intent === 'animate'
          ? (inputs.references ?? []).slice(0, studioExtraPhotoSlots(studioModel)) : []
        const more: string[] = []
        for (const [i, ref] of extras.entries()) {
          if (signal?.aborted) return params
          onStep?.(6, `Uploading photos… ${i + 2}/${extras.length + 1}`)
          more.push(await stageImage(ref, 'source'))
        }
        params.image_paths = [params.source_path, ...more]
      }
      if (!reads.includes('source_path')) delete params.source_path
    }
  }
  if ((op === 'edit' && !editIsMaskless) || op === 'eraser') {
    if (!inputs.mask) {
      throw new CreateInputError(
        op === 'eraser'
          ? 'Paint over the object you want to erase first.'
          : 'Paint a mask first. The edit only changes the painted area.',
      )
    }
    params.mask_path = await uploadInput(await dataUrlToBlob(inputs.mask.url), 'mask')
  }
  if (op === 'lipsync' && inputs.source && cloudModelById(model)?.lipsyncSource !== 'video') {
    params.source_path = await stageImage(inputs.source, 'source')
  }
  if (op === 'motion' && inputs.source) {
    params.source_path = await stageImage(inputs.source, 'source')
  }
  if ((op === 'lipsync' || op === 'motion') && inputs.video) {
    onStep?.(6, 'Uploading video…')
    params.video_path = inputs.video.type === 'job'
      ? await adoptResult(adoptInput, inputs.video.jobId, 'video')
      : await uploadInput(inputs.video.blob, 'video')
  }
  if (op === 'lipsync' && inputs.audio) {
    if (inputs.audio.type === 'blob') {
      onStep?.(8, 'Uploading audio…')
      params.audio_path = await uploadInput(inputs.audio.blob, 'audio')
    } else if (studioModel) {
      onStep?.(8, 'Uploading audio…')
      params.audio_path = await adoptResult(adoptInput, inputs.audio.jobId, 'audio')
    } else {
      const vj = await getJob(inputs.audio.jobId)
      if (!vj.result_url) throw new Error('That voice has expired. Generate it again first.')
      params.audio_url = vj.result_url
    }
  }
  if (op === 'lora-train') {
    const photos = inputs.train ?? []
    const paths: string[] = []
    for (const [i, photo] of photos.entries()) {
      if (signal?.aborted) return params
      onStep?.(5, `Uploading training photos… ${i + 1}/${photos.length}`)
      paths.push(photo.type === 'blob' ? await uploadInput(photo.blob, 'train') : await stageImage(photo, 'train'))
    }
    params.image_paths = paths
  }
  if (op === 'extend' && inputs.extend) {
    if (studioModel) {
      onStep?.(6, 'Uploading video…')
      params.video_path = inputs.extend.type === 'blob'
        ? await uploadInput(inputs.extend.blob, 'video')
        : await adoptResult(adoptInput, inputs.extend.jobId, 'video')
    } else if (inputs.extend.type === 'blob') {
      throw new Error(EXTEND_NEEDS_RESULT)
    } else {
      const src = await getJob(inputs.extend.jobId)
      if (!src.result_url) throw new Error('The source clip has expired. Re-render it first.')
      params.source_url = src.result_url
    }
  }
  const label = createGalleryLabel(op)
  if (label) params.label = label
  return params
}

export function createJobSubmit(
  job: ResolvedCreateJob,
  req: CreateRequest,
  params: CloudJobParams,
  runPrompt: string = req.prompt,
): CloudJobSubmit {
  return { kind: job.kind, model: job.model, prompt: runPrompt, params }
}

export async function requestStudioQuote(
  model: string,
  prompt: string,
  params: CloudJobParams,
  deps: Pick<CreateDeps, 'fetch' | 'signal'>,
  quoteImages?: number,
): Promise<PresetQuote> {
  const { fetch: load, signal } = deps
  const res = await load('/api/jobs/studio-quote', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, params, ...(quoteImages ? { quote_images: quoteImages } : {}) }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Could not calculate price')
  if (!Number.isSafeInteger(data.credits) || data.credits < 1) throw new Error('Invalid price response')
  return Number.isFinite(data.seconds) ? { credits: data.credits, seconds: data.seconds } : { credits: data.credits }
}

export interface RunDeps {
  submitCloudJob: (submit: CloudJobSubmit) => Promise<{ id: string }>
  pollJob: (
    id: string,
    opts: { signal?: AbortSignal; timeoutMs?: number; onTick?: (job: CloudJob) => void },
  ) => Promise<CloudJob>
  cancelJob: (id: string) => Promise<unknown>
}

export interface RunHooks {
  signal?: AbortSignal
  timeoutMs: number
  onSubmitted?: (id: string) => void
  onPolling?: (id: string) => void
  onTick?: (job: CloudJob) => void
}

export async function runCloudJob(submit: CloudJobSubmit, deps: RunDeps, hooks: RunHooks): Promise<CloudJob> {
  const { signal } = hooks
  const { id } = await deps.submitCloudJob(submit)
  hooks.onSubmitted?.(id)
  if (signal?.aborted) {
    void deps.cancelJob(id).catch(() => {})
    throw new CloudJobError('polling aborted', 0)
  }
  hooks.onPolling?.(id)
  return deps.pollJob(id, { timeoutMs: hooks.timeoutMs, signal, onTick: hooks.onTick })
}

export interface SubmitFailure {
  kind: 'exhausted' | 'quote_changed' | 'rate_limited' | 'timeout' | 'aborted' | 'other'
  text: string | null
  reason?: ExhaustedReason
  credits?: number
}

export function describeSubmitError(
  err: unknown,
  signalExhausted?: (reason?: ExhaustedReason) => void,
  perImage = false,
): SubmitFailure {
  if (err instanceof CloudJobError && err.code === 'credits_exhausted') {
    signalExhausted?.()
    return { kind: 'exhausted', reason: 'credits', text: "You're out of credits. Load up your credits or upgrade your plan." }
  }
  if (err instanceof CloudJobError && err.code === 'video_budget_exhausted') {
    signalExhausted?.('video_budget')
    return {
      kind: 'exhausted',
      reason: 'video_budget',
      text: "This month's video budget is used up. Top-up credits keep video going, or upgrade your plan.",
    }
  }
  if (err instanceof CloudJobError && err.code === 'trainings_exhausted') {
    signalExhausted?.('trainings')
    return {
      kind: 'exhausted',
      reason: 'trainings',
      text: 'Your included character trainings are used up. Top-up credits keep training going, or upgrade your plan.',
    }
  }
  if (err instanceof CloudJobError && err.code === 'quote_changed') {
    return err.credits != null
      ? {
          kind: 'quote_changed',
          credits: err.credits,
          text: `The price has changed: ${perImage ? 'each image' : 'this run'} now costs ${err.credits.toLocaleString('en-US')} credits. Nothing was charged. Press Start again to confirm.`,
        }
      : { kind: 'quote_changed', text: err.message }
  }
  if (err instanceof CloudJobError && err.status === 429) {
    return { kind: 'rate_limited', text: 'Too many requests at once. Wait a moment and try again.' }
  }
  if (err instanceof CloudJobError && err.message === 'render timed out') {
    return {
      kind: 'timeout',
      text: 'Still rendering. This is taking longer than expected. It will appear in your history when it completes.',
    }
  }
  if (err instanceof CloudJobError && err.message === 'polling aborted') return { kind: 'aborted', text: null }
  return { kind: 'other', text: err instanceof Error ? err.message : String(err) }
}

export function failedJobText(job: Pick<CloudJob, 'error'>): string {
  return job.error ?? 'Cloud render failed.'
}

export type PresetPaths = Record<string, string | string[]>

export interface ResolvedPresetStep {
  preset: CreatePreset
  index: number
  raw: PresetStep
  alternatives: PresetModel[]
  choice: PresetModel
  step: PresetStep
  studio: StudioModel | undefined
  fields: Record<string, Schema>
  inputs: Record<string, string>
  required: string[]
}

export interface PresetQuote {
  credits: number
  seconds?: number
}

export function resolvePresetStep(preset: CreatePreset, index: number, picked?: string): ResolvedPresetStep {
  const raw = preset.steps[index]
  const alternatives = presetModels(raw.role, preset.adult).filter((m) => !raw.models || raw.models.includes(m.id))
  const choice = presetModel(raw.role, picked ?? raw.model)
    ?? { id: raw.model, label: raw.model, kind: raw.kind, op: raw.op, adult: preset.adult, tier: 'standard' as const, weights: 'closed' as const }
  const step = { ...raw, model: choice.id, kind: choice.kind, op: choice.op }
  const studio: StudioModel | undefined = STUDIO_MODELS[step.model]
  const fields = studio ? studioFields(step.model) : {}
  const inputs = {
    ...roleInputs(raw.role, step.model),
    ...(!studio && raw.role === 'animate' && supportsProviderField(step.model, 'audio', 'animate') ? { audio: 'audio_path' } : {}),
  }
  const required = requiredRoleInputs(raw.role, step.model)
  return { preset, index, raw, alternatives, choice, step, studio, fields, inputs, required }
}

export function buildPresetStepParams(
  r: ResolvedPresetStep,
  paths: PresetPaths,
  options: Record<string, unknown>,
): CloudJobParams {
  const { raw, step, studio } = r
  if (studio) return { op: 'studio', ...paths, studio_options: options } as CloudJobParams
  const p: CloudJobParams = { op: step.op, ...paths } as CloudJobParams
  if (raw.role === 'animate') {
    const seconds = selectedVideoSeconds(step.model, Number(options.duration ?? 5) * 16, 16)
    p.frames = seconds * 16
    p.fps = 16
    if (supportsProviderField(step.model, 'shot_type', 'animate') && (options.shot_type === 'single' || options.shot_type === 'multi')) {
      p.shot_type = options.shot_type
    }
  }
  if (raw.role === 'image') {
    p.width = 1024
    p.height = 1024
  }
  if ((raw.role === 'image' || raw.role === 'animate') && supportsProviderField(step.model, 'negative_prompt', step.op) && options.negative_prompt) {
    p.negative_prompt = String(options.negative_prompt)
  }
  if (raw.role === 'speech') {
    if (step.model === 'qwen3-tts-design') p.voice_description = String(options.voice_description ?? '')
    else if (step.model !== 'qwen3-tts-clone') p.voice = String(options.voice ?? 'Serena')
  }
  if (raw.role === 'extend') p.source_url = String(paths.source_url ?? '')
  return p
}

function classicPresetCredits(r: ResolvedPresetStep, p: CloudJobParams, prompt: string, measuredSeconds?: number): number {
  const rate = lengthPrice(r.step.model, r.step.op)
  if (rate) return lengthCredits(r.step.model, rate.basis === 'chars' ? Array.from(prompt).length : measuredSeconds)
  return classicCredits(r.step.kind, r.step.model, r.step.op, p)
}
function measuredByServer(r: ResolvedPresetStep): boolean {
  const basis = r.studio ? undefined : lengthPrice(r.step.model, r.step.op)?.basis
  return basis === 'audio' || basis === 'video'
}

export function presetMeasurementKey(paths: PresetPaths, options: Record<string, unknown>): string {
  return JSON.stringify([paths, options.order ?? 'meanwhile'])
}

export function presetPriceKey(
  r: ResolvedPresetStep,
  prompt: string,
  options: Record<string, unknown>,
  paths: PresetPaths,
): string {
  return JSON.stringify([r.step.model, prompt, options, paths, r.index])
}

export function presetEstimate(
  r: ResolvedPresetStep,
  prompt: string,
  options: Record<string, unknown>,
  paths: PresetPaths,
  measuredSeconds?: number,
): number | null {
  if (!r.studio) return classicPresetCredits(r, buildPresetStepParams(r, paths, options), prompt, measuredSeconds)
  const images = Array.isArray(paths.image_paths) ? paths.image_paths.length : 1
  return studioPreviewCredits(r.step.model, options, measuredSeconds, images, Array.from(prompt).length)
}

export function presetQuoteReady(r: ResolvedPresetStep, prompt: string, paths: PresetPaths): boolean {
  const { raw, step, studio, required } = r
  const schemaRequired = studio ? studioSchema(step.model).required ?? [] : []
  if (required.some((key) => !paths[key])) return false
  if (!studio && raw.role === 'extend' && !paths.source_url) return false
  if ((studio ? schemaRequired.includes(studio.promptField ?? 'prompt') : rolePrompts(raw.role)) && !prompt.trim()) return false
  return true
}

export async function quotePresetStep(
  r: ResolvedPresetStep,
  prompt: string,
  options: Record<string, unknown>,
  paths: PresetPaths,
  deps: Pick<CreateDeps, 'fetch' | 'signal'>,
  _quoteImages?: number,
): Promise<PresetQuote> {
  if (measuredByServer(r)) return requestStudioQuote(r.step.model, prompt, buildPresetStepParams(r, paths, options), deps)
  if (!r.studio) return { credits: classicPresetCredits(r, buildPresetStepParams(r, paths, options), prompt) }
  studioOptions(r.step.model, prompt, options)
  return requestStudioQuote(r.step.model, prompt, buildPresetStepParams(r, paths, options), deps)
}

export function presetUploadRole(key: string): UploadRole {
  return key === 'image_paths' ? 'source'
    : key === 'mask_path' ? 'mask'
    : key.includes('audio') ? 'audio'
    : key === 'video_path' ? 'video'
    : 'source'
}

export async function stagePresetFiles(
  key: string,
  files: Blob[],
  deps: Pick<CreateDeps, 'uploadInput'>,
): Promise<string | string[]> {
  const { uploadInput } = deps
  const role = presetUploadRole(key)
  const list: string[] = []
  for (const file of files) list.push(await uploadInput(file, role))
  return key === 'image_paths' ? list : list[0]
}

export function presetAdoptRole(key: string): AdoptRole {
  const role = presetUploadRole(key)
  return role === 'audio' || role === 'video' ? role : 'image'
}

export interface PresetPreview {
  url: string
  type: 'image' | 'video'
}

export async function adoptPresetResult(
  jobId: string,
  key: string,
  deps: Pick<CreateDeps, 'adoptInput'>,
): Promise<{ value: string | string[]; preview: PresetPreview | null }> {
  const { adoptInput } = deps
  const role = presetAdoptRole(key)
  let path: string
  try {
    path = await adoptInput(jobId, role)
  } catch (err) {
    if (err instanceof CloudJobError && (err.status === 404 || err.status === 409)) throw new Error('Result is not available')
    if (err instanceof CloudJobError && err.status >= 500) throw new Error('Could not load the previous result')
    throw err
  }
  return {
    value: key === 'image_paths' ? [path] : path,
    preview: role === 'audio' ? null : { url: jobFileUrl(jobId), type: role },
  }
}

export function presetSlotFor(r: ResolvedPresetStep, kind: string): string | undefined {
  return Object.entries(r.inputs).find(([, key]) =>
    (kind === 'image' && (key === 'source_path' || key === 'image_paths'))
    || (kind === 'audio' && key === 'audio_path')
    || (kind === 'video' && key === 'video_path'))?.[1]
}

export function presetStepLabel(r: ResolvedPresetStep): string {
  return r.index === r.preset.steps.length - 1 ? r.preset.title : `${r.preset.title} · ${r.step.title}`
}

export function presetStepSubmit(
  r: ResolvedPresetStep,
  prompt: string,
  paths: PresetPaths,
  options: Record<string, unknown>,
  quote: { credits: number; requestId?: string | null },
): CloudJobSubmit {
  return {
    kind: r.step.kind,
    model: r.step.model,
    prompt,
    params: {
      ...buildPresetStepParams(r, paths, options),
      label: presetStepLabel(r),
      max_credits: quote.credits,
      client_request_id: quote.requestId ?? undefined,
    },
  }
}
