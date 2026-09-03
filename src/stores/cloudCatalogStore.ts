// Persisted cache of GET /api/jobs/catalog — the hosted render/voice catalog.
// Refreshed on every successful account probe (useCloudAuth); offline or
// never-fetched falls back to the static CLOUD_MODEL_SEED so the Create UI
// always has a model list. Persist key is in AppShell's STORE_KEYS so the
// cache survives the NSIS-update WebView2 wipe like every other store.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import { CLOUD_MODEL_SEED, type CloudModel } from '../lib/render/cloud-models'
import type { RenderKind, RenderOp } from '../lib/render/cloud-jobs'
import { getCatalog, type CatalogOps, type CloudCatalog } from '../api/cloud/catalog'

interface CloudCatalogState {
  fetchedAt: number | null
  models: CloudModel[]
  ops: CatalogOps | null
  voice: { stt: number; tts_per_1k_chars: number } | null
  /** null = unknown (never fetched) — treat as live so we don't false-block. */
  mediaLive: boolean | null

  setCatalog: (c: CloudCatalog) => void
}

export const useCloudCatalogStore = create<CloudCatalogState>()(
  persist(
    (set) => ({
      fetchedAt: null,
      models: CLOUD_MODEL_SEED,
      ops: null,
      voice: null,
      mediaLive: null,

      setCatalog: (c) =>
        set({
          fetchedAt: Date.now(),
          models: c.models,
          ops: c.ops,
          voice: c.voice,
          mediaLive: c.media_live,
        }),
    }),
    {
      name: 'lu-cloud-catalog',
      storage: safeJSONStorage(),
    },
  ),
)

/** Fetch the live catalog into the store. Fire-and-forget on account probes —
 *  a failure just keeps the last persisted (or seed) catalog. */
export async function refreshCatalog(): Promise<void> {
  try {
    useCloudCatalogStore.getState().setCatalog(await getCatalog())
  } catch {
    // offline / gated — the persisted or seed catalog stays in effect
  }
}

// Classic per-kind list (the Image / Video pickers): op-specialized 2.5.8
// models (`ops` set) are excluded — they live behind their own intents via
// modelsForOp below.
export function cloudModelsFor(kind: RenderKind): CloudModel[] {
  return useCloudCatalogStore.getState().models.filter((m) => m.kind === kind && !m.ops)
}

// Does this catalog entry serve this op? Classic models (no `ops`) keep their
// flag contract: generate always, edit per flag, animate = video i2v.
export function cloudModelSupportsOp(m: CloudModel, op: RenderOp): boolean {
  if (m.ops) return m.ops.includes(op)
  if (op === 'generate') return m.kind !== 'video' || m.t2v !== false
  if (op === 'edit') return m.edit === true
  if (op === 'animate') return m.kind === 'video' && m.i2v !== false
  return false
}

/** The pickers behind the 2.5.8 intents; 'generate' + kind image restricted to
 *  LoRA-capable models yields the Character-Studio generation list. */
export function modelsForOp(kind: RenderKind, op: RenderOp): CloudModel[] {
  return useCloudCatalogStore.getState().models.filter(
    (m) => m.kind === kind && cloudModelSupportsOp(m, op),
  )
}

/** Exactly the rows the specialized-op picker offers. Character training is
 *  image trainers only for now: the LTX video trainer needs a video training
 *  set (and a video use-lane) that no surface can provide yet. */
export function opPickerModels(op: RenderOp): CloudModel[] {
  return useCloudCatalogStore
    .getState()
    .models.filter((m) => m.ops?.includes(op) && (op !== 'lora-train' || m.kind === 'image'))
}

/** Chip, meter and submit all resolve the stored op pick through this one
 *  rule — a pick left over from another intent (p-video-avatar surviving from
 *  lipsync into character training) falls to the op's first model instead of
 *  silently steering the submit to a different family than the chip shows. */
export function resolveOpPick(op: RenderOp, pickedId: string): string {
  const list = opPickerModels(op)
  return list.some((m) => m.id === pickedId) ? pickedId : (list[0]?.id ?? '')
}

/** Character-Studio generation endpoints (accept `params.loras`). */
export function loraGenModels(): CloudModel[] {
  return useCloudCatalogStore.getState().models.filter((m) => m.lora === true)
}

/** First classic model of the kind; kinds whose models are ALL op-specialized
 *  (audio — every entry carries `ops`, in the live catalog and the seed alike)
 *  fall back to the kind's first entry so callers never explode on `.id`. */
export function defaultCloudModel(kind: RenderKind): CloudModel | undefined {
  return cloudModelsFor(kind)[0] ?? useCloudCatalogStore.getState().models.find((m) => m.kind === kind)
}

export function cloudModelById(id: string): CloudModel | undefined {
  return useCloudCatalogStore.getState().models.find((m) => m.id === id)
}

export function isEditCapable(id: string): boolean {
  return cloudModelById(id)?.edit === true
}

/** First edit-capable image model in the catalog (flux-dev today) — the
 *  submit-time fallback when the picker holds a t2i-only model for an edit. */
export function defaultEditModel(): CloudModel | undefined {
  return useCloudCatalogStore.getState().models.find((m) => m.kind === 'image' && m.edit)
}

// Video models that render text-to-video (the "Video" intent) / image-to-video
// (the "Animate Image" intent). Absent flag = capable, so a persisted catalog
// cached before this field existed still lists every clip model; only an
// explicit false hides a capability-restricted model from that picker.
export function t2vModels(): CloudModel[] {
  return useCloudCatalogStore.getState().models.filter((m) => m.kind === 'video' && !m.ops && m.t2v !== false)
}

export function i2vModels(): CloudModel[] {
  return useCloudCatalogStore.getState().models.filter((m) => m.kind === 'video' && !m.ops && m.i2v !== false)
}

/** The model a run will really use for this op — coerces a leftover/incapable
 *  pick onto a capable one (edit→i2i, animate→i2v, video→t2v) so submit + the
 *  credits gate agree. Mirrors each picker's per-op filter. */
export function modelForOp(kind: RenderKind, op: RenderOp, pickedId: string): string {
  if (op === 'edit') return isEditCapable(pickedId) ? pickedId : (defaultEditModel()?.id ?? pickedId)
  if (kind === 'video' && (op === 'generate' || op === 'animate')) {
    const list = op === 'animate' ? i2vModels() : t2vModels()
    return list.some((m) => m.id === pickedId) ? pickedId : (list[0]?.id ?? pickedId)
  }
  // 2.5.8 op-specialized intents: coerce a stale pick onto a model that
  // actually serves the op (same rule the pickers apply).
  if (op === 'lipsync' || op === 'extend' || op === 'motion' || op === 'music' || op === 'tts' || op === 'lora-train') {
    const list = modelsForOp(kind, op)
    return list.some((m) => m.id === pickedId) ? pickedId : (list[0]?.id ?? pickedId)
  }
  return pickedId
}

/** Credits the upcoming run draws, priced from the server catalog: per-op
 *  utility rates, per-model base/long clip rates (the long rate books from
 *  ~6.5 s, mirroring the server's mediaCredits split). Edit coerces onto the
 *  edit-capable model exactly like useCloudCreate's submit, so gate + meter
 *  price the model the run actually uses. Falls back to the quota's
 *  representative per-kind figure when the catalog carries no price
 *  (seed/offline). */
export function runCredits(
  kind: RenderKind,
  op: RenderOp,
  pickedModel: string,
  seconds: number | undefined,
  fallback: number,
  resolution?: string,
): number {
  const { ops } = useCloudCatalogStore.getState()
  // Music bills per second: catalog per_s × the requested duration (60 s
  // default, mirroring the server's MUSIC_SECONDS fallback).
  if (op === 'music') {
    const m = cloudModelById(modelForOp(kind, op, pickedModel))
    const perS = m?.credits?.per_s
    if (perS === undefined) return m?.credits?.base ?? fallback
    return Math.ceil(perS * (seconds && seconds > 0 ? seconds : 60))
  }
  if (op === 'removebg' || op === 'eraser' || op === 'upscale') {
    // Video upscale is per-second with a floor; the server defaults to 8 s
    // when the submit carries no clip length (mirrors mediaCredits).
    const upscale = !ops
      ? undefined
      : kind === 'video'
        ? Math.ceil(Math.max(ops.upscale_video_min, ops.upscale_video_per_s * (seconds && seconds > 0 ? seconds : 8)))
        : ((resolution && ops.upscale_image_res?.[resolution]) || ops.upscale_image)
    const rate = ops ? { removebg: ops.removebg, eraser: ops.eraser, upscale }[op] : undefined
    return rate ?? fallback
  }
  const model = modelForOp(kind, op, pickedModel)
  const credits = cloudModelById(model)?.credits
  if (!credits) return fallback
  return kind === 'video' && seconds !== undefined && seconds >= 6.5
    ? (credits.long ?? credits.base)
    : credits.base
}

export function shortCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  return n.toLocaleString('en-US')
}

/** One run's wallet draw as a picker sublabel. The single biggest cost lever
 *  (wan-2.2-720p costs 5x wan-2.2-fast) was invisible before picking. Music
 *  prices the CURRENT length-slider value, not a static 60 s quote: the old
 *  hint said 1,800 cr while a 3:10 run really billed 5,700, which read as a
 *  hidden price hike (sockenmonster, bug-reports 2026-08-08). Video quotes the
 *  short clip; the meter refines it to the exact run. Undefined when the entry
 *  carries no price (seed/offline). */
export function modelCostHint(m: CloudModel, op: RenderOp, seconds?: number): string | undefined {
  const c = m.credits
  if (!c) return undefined
  const cr =
    op === 'music' && c.per_s !== undefined
      ? Math.ceil(c.per_s * (seconds && seconds > 0 ? seconds : 60))
      : c.base
  return `${shortCount(cr)} cr`
}

/** Media-live switch from the server (MEDIA_LIVE env). Unknown = live so the
 *  first-ever session doesn't false-block before the catalog arrives. */
export function cloudMediaLive(): boolean {
  return useCloudCatalogStore.getState().mediaLive !== false
}
