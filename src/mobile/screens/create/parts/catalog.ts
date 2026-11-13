/**
 * What the cloud catalog offers, read for the screens of Create.
 *
 * This file is the only one in the strand that knows the catalog helpers of
 * the logic layer. The screens ask it three things: which tools can run,
 * which models a tool has, and what the picked model is.
 */
import { useCreateStore, MODEL_TYPE_DEFAULTS, type CharacterRef, type ThreeDWay } from '../../../../stores/createStore'
import {
  useCloudCatalogStore,
  animatePickerModels,
  characterGenerationModels,
  cloudModelById,
  defaultCloudModel,
  editCapableModels,
  editNeedsMask,
  loraGenModels,
  opPickerModels,
  studioOnlyImageModels,
  videoPickerModels,
} from '../../../../stores/cloudCatalogStore'
import type { CloudModel } from '../../../../lib/render/cloud-models'
import { createRunModel, createStudioCost, intentPickerModels, intentRoles, isStudioModel, studioIntentOf } from '../../../../lib/render/create-studio'
import { groupForPicker, tierMarks } from '../../../../lib/render/model-tier'
import { modelLabel } from '../../../../lib/render/preset-models'
import { effectiveVideoDurations } from '../../../../lib/render/video-duration'
import { STUDIO_MODELS } from '../../../../lib/render/studio-contract'
import { shownCreateLabel, shownCreateModel } from './policy'
import { toolFacts, type ToolId, type ToolProbe } from './tools'

/** Re-render when the catalog changes. Returns a number that only serves as a dependency. */
export function useCatalogVersion(): number {
  return useCloudCatalogStore((s) => s.fetchedAt ?? 0)
}

/** Whether the catalog was ever fetched in this install. Before that the list is the built in one. */
export function useCatalogState(): { loaded: boolean; live: boolean } {
  const fetchedAt = useCloudCatalogStore((s) => s.fetchedAt)
  const mediaLive = useCloudCatalogStore((s) => s.mediaLive)
  return { loaded: fetchedAt !== null, live: mediaLive !== false }
}

function imageModels(): CloudModel[] {
  const { models } = useCloudCatalogStore.getState()
  return [...models.filter((m) => m.kind === 'image' && !m.ops), ...studioOnlyImageModels()]
}

/** Which tools the catalog can run. */
export function toolProbe(): ToolProbe {
  const { ops } = useCloudCatalogStore.getState()
  // Before the first catalog answer the prices of the three utilities are unknown, not absent.
  const utility = (rate: number | undefined) => ops === null || (typeof rate === 'number' && rate >= 0)
  return {
    image: imageModels().length > 0,
    edit: editCapableModels().length > 0,
    removebg: utility(ops?.removebg),
    upscale: utility(ops?.upscale_image),
    eraser: utility(ops?.eraser),
    video: videoPickerModels().length > 0,
    animate: animatePickerModels().length > 0,
    character: opPickerModels('lora-train').length > 0 || loraGenModels().length > 0,
    lipsync: intentPickerModels('lipsync').length > 0,
    music: intentPickerModels('music').length > 0,
    extend: intentPickerModels('extend').length > 0,
    motion: intentPickerModels('motion').length > 0,
    // The tab is there as soon as the catalog lists one 3D model, whatever its way.
    '3d': intentPickerModels('3d').length > 0,
  }
}

export interface ModelRow {
  id: string
  label: string
  /** Family head above the row, when the list has more than one group. */
  group?: string
  /** Credits of one run with the standard values, null when unknown. */
  credits: number | null
  /** The price depends on seconds: credits per second. */
  perSecond?: number
  /** The server confirms the price before the run. */
  quoted: boolean
  tags: { label: string; accent: boolean }[]
  adult: boolean
  /** This build shows the mark "Direct" at the model (parts/policy.ts shownCreateModel). */
  direct: boolean
}

interface Listable { id: string; label: string; adult?: boolean; tier?: CloudModel['tier']; weights?: CloudModel['weights'] }

function rowCredits(id: string, tool: ToolId, musicSeconds: number, fallback: number | null): { credits: number | null; perSecond?: number; quoted: boolean } {
  if (isStudioModel(id)) {
    let credits: number | null = null
    try {
      credits = createStudioCost(id, {}, 100)
    } catch {
      credits = null
    }
    return { credits, quoted: true }
  }
  const m = cloudModelById(id)
  const c = m?.credits
  if (!c) return { credits: fallback, quoted: false }
  if (tool === 'music' && c.per_s !== undefined) {
    return { credits: Math.ceil(c.per_s * (musicSeconds > 0 ? musicSeconds : 60)), perSecond: c.per_s, quoted: false }
  }
  return { credits: c.base, quoted: m?.quote_required === true }
}

/** The models of a tool, grouped and marked the way the desktop picker does it. */
export function toolModels(tool: ToolId, opts: { character: CharacterRef | null; characterUse: boolean; musicSeconds: number; fallbackCredits: Record<'image' | 'video' | 'audio', number | null>; threeDWay?: ThreeDWay }): ModelRow[] {
  const facts = toolFacts(tool, opts.threeDWay)
  if (!facts.hasModels) return []
  // 3D lists the models of its way: words, one photo, or the frames of a video.
  const pickIntent = studioIntentOf(tool, opts.threeDWay)
  let list: Listable[]
  if (tool === 'character') {
    list = opts.characterUse ? characterGenerationModels(opts.character?.family ?? '') : opPickerModels('lora-train')
  } else if (intentRoles(pickIntent).length > 0) list = intentPickerModels(pickIntent)
  else if (tool === 'edit') list = editCapableModels()
  else if (tool === 'animate') list = animatePickerModels()
  else if (tool === 'video') list = videoPickerModels()
  else list = imageModels()
  const fallback = facts.kind === '3d' ? null : opts.fallbackCredits[facts.kind]
  return groupForPicker(list).map(({ model, group }) => ({
    id: model.id,
    // The name and the head of the group as this build may show them: a store build writes no word it may not show.
    label: shownCreateModel(model).name,
    direct: shownCreateModel(model).direct,
    group: group ? shownCreateLabel(group) : group,
    ...rowCredits(model.id, tool, opts.musicSeconds, fallback),
    tags: tierMarks(model).map((t) => ({ label: t.label, accent: t.tone === 'accent' })),
    adult: model.adult === true,
  }))
}

/** The row with the lowest known price, or null. */
export function cheapestModel(rows: readonly ModelRow[]): string | null {
  let best: ModelRow | null = null
  for (const row of rows) {
    if (row.credits === null) continue
    if (!best || row.credits < (best.credits ?? Infinity)) best = row
  }
  return best?.id ?? null
}

/** Rows whose name or family contains the search text. */
export function searchModels(rows: readonly ModelRow[], query: string): ModelRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...rows]
  return rows.filter((r) => r.label.toLowerCase().includes(q) || (r.group ?? '').toLowerCase().includes(q) || r.tags.some((t) => t.label.toLowerCase().includes(q)))
}

export interface RunModel {
  /** The model the run uses. */
  id: string
  label: string
  studio: boolean
  /** An edit model that changes the whole image without a painted area. */
  maskless: boolean
  negativePrompt: boolean
  durations: number[]
  /** Talking: the model re-syncs a clip instead of animating a portrait. */
  lipsyncFromClip: boolean
}

type Picks = { cloudImageModel: string; cloudVideoModel: string; cloudOpModel: string }

/** The model a run of `tool` uses with the current picks. 3D runs the model of its way. */
export function runModel(tool: ToolId, picks: Picks, character: CharacterRef | null, characterUse: boolean, threeDWay?: ThreeDWay): RunModel {
  const id = createRunModel(
    studioIntentOf(tool, threeDWay),
    { image: picks.cloudImageModel, video: picks.cloudVideoModel, op: picks.cloudOpModel },
    characterUse ? character?.family ?? '' : undefined,
  )
  const entry = cloudModelById(id)
  const studio = !characterUse && isStudioModel(id)
  const label = shownCreateLabel(entry?.label ?? (studio ? STUDIO_MODELS[id].label : modelLabel(id)), id)
  return {
    id,
    label,
    studio,
    maskless: tool === 'edit' ? !editNeedsMask(id) : false,
    negativePrompt: !studio && entry?.negative_prompt === true,
    durations: (tool === 'video' || tool === 'animate') && !studio ? effectiveVideoDurations(id) : [],
    lipsyncFromClip: tool === 'lipsync' && !studio && entry?.lipsync_source === 'video',
  }
}

/** Remember a model choice in the slot the cloud hook reads for this tool. */
export function pickModel(tool: ToolId, id: string): void {
  const st = useCreateStore.getState()
  if (tool === 'character' || intentRoles(tool).length > 0) st.setCloudOpModel(id)
  else if (toolFacts(tool).kind === 'video') st.setCloudVideoModel(id)
  else st.setCloudImageModel(id)
}

/** Long side of the image family the cloud renders with, for the aspect sizes. */
export function imageBaseLong(): number {
  const d = MODEL_TYPE_DEFAULTS[useCreateStore.getState().imageModelType] ?? MODEL_TYPE_DEFAULTS.unknown
  return Math.max(d.width, d.height) || 1024
}

/** The standard model of a kind, for a first label before anything was picked. */
export function standardModelLabel(kind: 'image' | 'video'): string | null {
  const standard = defaultCloudModel(kind)
  return standard ? shownCreateLabel(standard.label, standard.id) : null
}
