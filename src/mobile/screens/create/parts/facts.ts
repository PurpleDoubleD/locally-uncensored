/**
 * Everything a screen of Create needs to know about the next run, derived
 * from the create store, the catalog and the account in one place.
 *
 * useCreateFacts() is cheap and may be used by any page or sheet. The price
 * of a model whose price the server confirms is fetched by exactly one
 * component (PriceOwner in CreatePage) and published through usePriceStore,
 * so two open screens never ask the server twice.
 */
import { create } from 'zustand'
import { useCreateStore, imageQualityLadder, type CharacterRef, type ImageRef, type MediaRef, type ThreeDWay } from '../../../../stores/createStore'
import { useCloudAuthStore, deriveCloudAvailable } from '../../../../stores/cloudAuthStore'
import { useCloudCatalogStore, lengthPrice, runCredits } from '../../../../stores/cloudCatalogStore'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { intentToJob, quotaCostKind, type CloudQuota, type RenderKind, type RenderOp } from '../../../../lib/render/cloud-jobs'
import { createStudioCost, intentRequiredInputs, startImageCount, studioExtraPhotoSlots, studioIntentOf } from '../../../../lib/render/create-studio'
import { STUDIO_MODELS, studioFields } from '../../../../lib/render/studio-contract'
import { runImageCount } from '../../../../lib/render/image-count'
import { meterState, type MeterState } from '../../../../lib/render/credits-meter'
import { improveKindForRun, musicLength, musicText } from '../../../../lib/render/music-ui'
import { snapToVideoDuration } from '../../../../lib/render/video-duration'
import { MIN_TRAIN_IMAGES } from '../../../../lib/train-image-cap'
import { useCloudOnline } from '../../../resilience/useOnline'
import { runModel, type RunModel } from './catalog'
import { lengthUnit } from './length-price'
import { aspectKey, qualityKey, runParams, summaryParts, type AspectKey, type QualityKey, type RunParams } from './params'
import { blockReason, walletVerdict, type BlockReason, type WalletVerdict } from './run-state'
import { toolFacts, toolNeedsMask, type ToolFacts, type ToolId } from './tools'
import { threeDModelFacts, type ThreeDModelFacts } from './three-d'

// ---------- the confirmed price, shared ----------

export interface SharedPrice {
  /** Which model and values the price belongs to. */
  model: string | null
  credits: number | null
  /** The server confirmed this number. */
  live: boolean
  /** The server could not confirm a price. */
  error: string | null
  /** Seconds of the attached clip or voice, measured on the phone. */
  inputSeconds: number | undefined
  /** An input is attached and its length is still being measured. */
  measuring: boolean
}

export const usePriceStore = create<SharedPrice & { set: (p: Partial<SharedPrice>) => void }>()((set) => ({
  model: null,
  credits: null,
  live: false,
  error: null,
  inputSeconds: undefined,
  measuring: false,
  set: (p) => set(p),
}))

// ---------- the gate ----------

export type GateState =
  /** The account is still being asked. */
  | 'checking'
  /** Create can run. */
  | 'open'
  | 'signed-out'
  /** Signed in, but without a plan that includes the cloud. */
  | 'no-plan'
  /** Signed in with a plan, the app runs on device. */
  | 'cloud-off'

export function gateState(a: { status: string; cloudAvailable: boolean; appMode: string; offline: boolean }): GateState {
  if (a.status === 'probing') return 'checking'
  if (a.status !== 'signed-in') return 'signed-out'
  // A kept session without network: the plan is not known right now, the page says so itself.
  if (a.offline) return a.appMode === 'cloud' ? 'open' : 'cloud-off'
  if (!a.cloudAvailable) return 'no-plan'
  return a.appMode === 'cloud' ? 'open' : 'cloud-off'
}

export function useGate(): { gate: GateState; teasers: boolean } {
  const status = useCloudAuthStore((s) => s.status)
  const user = useCloudAuthStore((s) => s.user)
  const licenseActive = useCloudAuthStore((s) => s.licenseActive)
  const access = useCloudAuthStore((s) => s.access)
  const quota = useCloudAuthStore((s) => s.quota)
  const offline = useCloudAuthStore((s) => s.offline)
  const appMode = useSettingsStore((s) => s.settings.appMode)
  const teasers = useSettingsStore((s) => s.settings.cloudTeasersEnabled !== false)
  const cloudAvailable = deriveCloudAvailable({ user, licenseActive, access, quota })
  return { gate: gateState({ status, cloudAvailable, appMode, offline }), teasers }
}

// ---------- the facts of the next run ----------

export interface CreateFacts {
  tool: ToolId
  facts: ToolFacts
  characterUse: boolean
  character: CharacterRef | null
  model: RunModel
  kind: RenderKind
  op: RenderOp
  params: RunParams
  aspect: AspectKey
  quality: QualityKey
  /** Chosen clip length in seconds, null when the model has none. */
  seconds: number | null
  summary: string[]
  imageCount: number
  /** Price of the whole run in credits, null while it is not known. */
  cost: number | null
  /** 'measuring': the model bills by length and the length of the input is not back yet. */
  priceState: 'known' | 'pending' | 'measuring' | 'unavailable'
  quota: CloudQuota | null
  meter: MeterState | null
  wallet: WalletVerdict
  block: BlockReason | null
  needsMask: boolean
  promptNeeded: boolean
  promptShown: boolean
  source: ImageRef | null
  mask: ImageRef | null
  references: ImageRef[]
  /** How many reference photos the model takes besides the source. */
  referenceSlots: number
  /** Talking. */
  needsPortrait: boolean
  needsClip: boolean
  videoInput: MediaRef | null
  audioInput: MediaRef | null
  online: boolean
  /** 3D: the way of the tool, and what its model takes. Null for every other tool. */
  threeDWay: ThreeDWay
  threeD: ThreeDModelFacts | null
  /** 3D: the further sides after the Front (or the further still frames). */
  threeDViews: ImageRef[]
}

export function useCreateFacts(): CreateFacts {
  const online = useCloudOnline()
  const quota = useCloudAuthStore((s) => s.quota)
  // The catalog decides models and prices: read it so a refresh repaints.
  useCloudCatalogStore((s) => s.fetchedAt)
  useCloudCatalogStore((s) => s.models)

  const tool = useCreateStore((s) => s.intent())
  const characterTab = useCreateStore((s) => s.characterTab)
  const character = useCreateStore((s) => s.selectedCharacter)
  const cloudImageModel = useCreateStore((s) => s.cloudImageModel)
  const cloudVideoModel = useCreateStore((s) => s.cloudVideoModel)
  const cloudOpModel = useCreateStore((s) => s.cloudOpModel)
  const prompt = useCreateStore((s) => s.prompt)
  const source = useCreateStore((s) => s.source)
  const mask = useCreateStore((s) => s.mask)
  const references = useCreateStore((s) => s.references)
  const width = useCreateStore((s) => s.width)
  const height = useCreateStore((s) => s.height)
  const steps = useCreateStore((s) => s.steps)
  const imageModel = useCreateStore((s) => s.imageModel)
  const imageModelType = useCreateStore((s) => s.imageModelType)
  const cloudFrames = useCreateStore((s) => s.cloudFrames)
  const cloudFps = useCreateStore((s) => s.cloudFps)
  const musicDuration = useCreateStore((s) => s.musicDuration)
  const targetResolution = useCreateStore((s) => s.targetResolution)
  const cloudImageCount = useCreateStore((s) => s.cloudImageCount)
  const cloudStudioOptions = useCreateStore((s) => s.cloudStudioOptions)
  const cloudStudioCredits = useCreateStore((s) => s.cloudStudioCredits)
  const trainImages = useCreateStore((s) => s.trainImages)
  const audioInput = useCreateStore((s) => s.audioInput)
  const voiceFromJob = useCreateStore((s) => s.voiceFromJob)
  const videoInput = useCreateStore((s) => s.videoInput)
  const extendSource = useCreateStore((s) => s.extendSource)
  const threeDWay = useCreateStore((s) => s.threeDWay)
  const threeDViews = useCreateStore((s) => s.threeDViews)
  const price = usePriceStore()

  const facts = toolFacts(tool, threeDWay)
  const characterUse = tool === 'character' && characterTab === 'use'
  const model = runModel(tool, { cloudImageModel, cloudVideoModel, cloudOpModel }, character, characterUse, threeDWay)
  const threeD = tool === '3d' ? threeDModelFacts(model.studio ? model.id : undefined) : null
  let { kind, op } = intentToJob(tool)
  if (characterUse) {
    kind = 'image'
    op = 'generate'
  }
  if (model.studio) kind = STUDIO_MODELS[model.id].kind

  const text = tool === 'music' && model.id ? musicText(model.id) : null
  const params = runParams({
    tool,
    characterUse,
    studio: model.studio,
    studioFieldCount: model.studio ? Object.keys(studioFields(model.id)).length : 0,
    negativePrompt: model.negativePrompt,
    durations: model.durations,
    musicLength: tool === 'music' && model.id ? musicLength(model.id) : null,
    musicSecond: text?.second ? text.second.is : null,
    canImprove: !characterUse && !!model.id && improveKindForRun(tool, model.id) !== null,
  })

  const aspect = aspectKey(width, height)
  const quality = qualityKey(imageQualityLadder({ backend: 'cloud', imageModel, imageModelType }).steps, steps)
  const seconds = model.durations.length ? snapToVideoDuration(model.durations, cloudFrames, cloudFps) : null
  const imageCount = runImageCount(tool, cloudImageCount, characterUse)
  const summary = summaryParts({
    params, tool, characterUse, count: imageCount, aspect, quality, seconds, size: targetResolution, musicSeconds: musicDuration,
  })

  // The price of one run, by the same rule the cloud hook books with.
  const runSeconds = op === 'music' ? musicDuration : kind === 'video' && !model.studio && seconds !== null ? seconds : undefined
  const extraPhotos = tool === 'edit' || tool === 'animate' ? references.length : tool === '3d' && threeD ? Math.min(threeDViews.length, threeD.maxViews - 1) : 0
  let unit: number | null = null
  let priceState: CreateFacts['priceState'] = 'known'
  if (model.studio) {
    if (price.model === model.id && price.error) priceState = 'unavailable'
    else if (price.model === model.id && price.credits !== null) {
      unit = price.credits
      if (!price.live) priceState = 'pending'
    } else {
      priceState = 'pending'
      try {
        unit = createStudioCost(model.id, cloudStudioOptions, Array.from(prompt).length, price.inputSeconds, startImageCount(model.id, extraPhotos) ?? 1)
      } catch {
        unit = null
      }
    }
  } else if (model.id && lengthPrice(model.id, op)) {
    // Billed by the length of the input (credits.length). The number PriceOwner left is the price of the
    // measured length, or after a 409 the price the server measured; until it is there, the rule itself answers.
    const mine = price.model === model.id
    unit = (mine ? cloudStudioCredits : null) ?? lengthUnit(model.id, op, prompt, mine ? price.inputSeconds : undefined)
    if (mine && price.measuring) priceState = 'measuring'
  } else if (quota && model.id) {
    unit = runCredits(kind, op, model.id, runSeconds, quota.costs[quotaCostKind(kind)], targetResolution)
  } else if (quota && !facts.hasModels) {
    unit = runCredits(kind, op, '', runSeconds, quota.costs.image, targetResolution)
  }
  const noCharacterYet = characterUse && !character
  const cost = unit === null || noCharacterYet ? null : unit * imageCount

  const meter = quota && cost !== null ? meterState(quota, cost, kind, op) : null
  const wallet = meter ? walletVerdict(meter.kind) : 'ok'

  const needsMask = toolNeedsMask(tool, model.maskless)
  const promptShown = facts.prompt !== 'no' && (tool !== 'character' || characterUse)
  const promptNeeded = promptShown && facts.prompt === 'yes'
  const studioNeeds = model.studio ? intentRequiredInputs(studioIntentOf(tool, threeDWay), model.id) : []
  const needsClip = tool === 'lipsync' && (model.studio ? studioNeeds.includes('video_path') : model.lipsyncFromClip)
  const needsPortrait = tool === 'lipsync' && !needsClip && (model.studio ? studioNeeds.includes('source_path') : true)

  const block = blockReason({
    online,
    tool,
    promptNeeded,
    prompt,
    sourceNeeded: facts.needsSource,
    hasSource: !!source,
    maskNeeded: needsMask,
    hasMask: !!mask,
    characterUse,
    hasCharacter: !!character,
    trainPhotos: trainImages.length,
    minTrainPhotos: MIN_TRAIN_IMAGES,
    hasVoice: !!audioInput || !!voiceFromJob,
    needsPortrait,
    needsClip,
    hasVideo: !!videoInput,
    hasExtendClip: !!extendSource,
    threeDWay,
    hasModel: !facts.hasModels || !!model.id,
    priceState,
    quotaKnown: quota !== null,
  })

  return {
    tool, facts, characterUse, character, model, kind, op, params, aspect, quality, seconds, summary, imageCount,
    cost, priceState, quota, meter, wallet, block, needsMask, promptNeeded, promptShown,
    source, mask, references,
    referenceSlots: model.studio && (tool === 'edit' || tool === 'animate') ? studioExtraPhotoSlots(model.id) : 0,
    needsPortrait, needsClip, videoInput, audioInput, online,
    threeDWay, threeD, threeDViews,
  }
}
