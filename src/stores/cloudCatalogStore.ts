// Persisted cache of GET /api/jobs/catalog — the hosted render/voice catalog.
// Refreshed on every successful account probe (useCloudAuth); offline or
// never-fetched falls back to the static CLOUD_MODEL_SEED so the Create UI
// always has a model list. Persist key is in AppShell's STORE_KEYS so the
// cache survives the NSIS-update WebView2 wipe like every other store.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import { CLOUD_MODEL_SEED, DEFAULT_MODEL_IDS, type CloudLengthPrice, type CloudModel } from '../lib/render/cloud-models'
import { STUDIO_MODELS, unmeasuredHidden } from '../lib/render/studio-contract'
import {
  STUDIO_EDIT_MODELS, studioImageToVideo, studioReferenceVideo, studioTextToImage,
  studioTextToVideo,
} from '../lib/render/studio-roles'
import type { RenderKind, RenderOp } from '../lib/render/cloud-jobs'
import { getCatalog, type CatalogOps, type CloudCatalog } from '../api/cloud/catalog'

interface CloudCatalogState {
  fetchedAt: number | null
  models: CloudModel[]
  ops: CatalogOps | null
  voice: { stt: number; tts_per_1k_chars: number } | null
  /** null = unknown (never fetched) — treat as live so we don't false-block. */
  mediaLive: boolean | null
  /** Upload limits as the server sent them (bytes per kind), null when it
   *  sent none. Read through lib/upload-limits.ts, which checks the numbers. */
  uploadLimits: { image?: number; audio?: number; video?: number } | null

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
      uploadLimits: null,

      setCatalog: (c) =>
        set({
          fetchedAt: Date.now(),
          models: c.models,
          ops: c.ops,
          voice: c.voice,
          mediaLive: c.media_live,
          uploadLimits: c.upload_limits ?? null,
        }),
    }),
    {
      name: 'lu-cloud-catalog',
      storage: safeJSONStorage(),
      // A copy saved from an older server may still hold a model that is not
      // measured yet (studio-contract.ts, unmeasuredHidden): it stays out.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<CloudCatalogState>
        const models = Array.isArray(saved.models) ? saved.models.filter((m) => !unmeasuredHidden(m)) : current.models
        return { ...current, ...saved, models }
      },
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

// Which generation models accept which trained-LoRA family. Ported from
// the web app (the web app,
// CHARACTER_MODEL_FAMILY): the picker (ModelChip), the meter (CreditsMeter)
// and the submit path (useCloudCreate) all resolve through the SAME table, so
// the UI cannot show Flux while quietly running Z-Image. `qwen-image-lora` is
// in the desktop seed (cloud-models.ts); flux/z-image keep their two endpoints
// each (a fast + a slower/quality one).
export const CHARACTER_MODEL_FAMILY: Readonly<Record<string, string>> = {
  'flux-schnell-lora': 'flux',
  'flux-dev-lora-ultra-fast': 'flux',
  'z-image-turbo-lora': 'z-image',
  'z-image-base-lora': 'z-image',
  'qwen-image-lora': 'qwen-image',
  'ltx-2': 'ltx-2',
  'ltx-2.3': 'ltx-2',
}

/** Generation models that accept this trained-LoRA family's weights. */
export function characterGenerationModels(family: string): CloudModel[] {
  return loraGenModels().filter((m) => CHARACTER_MODEL_FAMILY[m.id] === family)
}

/** The model a character run will really use: the stored pick if it still
 *  fits the trained family, else the family's first compatible model, else
 *  null (no compatible generation endpoint exists yet for this family). */
export function resolveCharacterModel(family: string, pickedId: string): string | null {
  const list = characterGenerationModels(family)
  return list.some((m) => m.id === pickedId) ? pickedId : (list[0]?.id ?? null)
}

/** Das klassische Standardmodell (ohne Studio-Eintraege) fuer Wege, die nur den
 *  klassischen Katalog fahren. First classic model of the kind; kinds whose
 *  models are ALL op-specialized (audio, every entry carries `ops`, in the live
 *  catalog and the seed alike) fall back to the kind's first entry so callers
 *  never explode on `.id`. */
export function classicDefaultModel(kind: RenderKind): CloudModel | undefined {
  return cloudModelsFor(kind)[0] ?? useCloudCatalogStore.getState().models.find((m) => m.kind === kind)
}

/** Das Standardmodell fuer eine NEUE Auswahl (DEFAULT_MODEL_IDS, seit
 *  02.10.2026), sofern der Server es kennt. Kennt er es nicht (ein aelterer
 *  Server, oder der Notvorrat), gilt wie vor diesem Stand das erste klassische
 *  Modell. Eine gespeicherte Wahl bleibt, wie sie ist: diese Funktion wird nur
 *  befragt, wo nichts gewaehlt ist. */
export function defaultCloudModel(kind: RenderKind): CloudModel | undefined {
  const id = kind === 'image' ? DEFAULT_MODEL_IDS.image : kind === 'video' ? DEFAULT_MODEL_IDS.video : undefined
  return (id ? cloudModelById(id) : undefined) ?? classicDefaultModel(kind)
}

export function cloudModelById(id: string): CloudModel | undefined {
  return useCloudCatalogStore.getState().models.find((m) => m.id === id)
}

// R5-58: a model serves 'edit' either the classic way (`edit: true`, e.g.
// flux-dev) or the 2.5.8 op-specialized way (`ops: ['edit']`, e.g.
// qwen-image-edit). `cloudModelSupportsOp` already branches on `m.ops` first
// so it got this right; `isEditCapable` and `defaultEditModel` below checked
// only `m.edit` and silently could not see an ops-based edit model at all.
export function isEditModel(m: CloudModel): boolean {
  return m.edit === true || m.ops?.includes('edit') === true
}

/** Die Studio-Eintraege dieser Ids, die der Server wirklich fuehrt. Die Ids
 *  kommen aus der mitgelieferten Registrierung (studio-roles.ts), die Eintraege
 *  aus dem Katalog: was ein Server nicht kennt, wird nicht angeboten, weil der
 *  Start es dort ablehnen wuerde. Ein Eintrag zaehlt als Studio-Eintrag, wenn
 *  der Server `quote_required` setzt: ABWESENHEIT dieses Felds, nie eine
 *  Versionsnummer, ist, wie ein aelterer Katalog aussieht (Portplan Abschnitt 4,
 *  "nie eine Serverversion fest verdrahten"). Review B1 (Runde 2, 20.09.2026):
 *  ohne diese Probe wich ein Create-Lauf auf einem Server ohne Studio auf einen
 *  Endpunkt aus, den dieser Server nie gehoert hatte. */
export function studioEntries(ids: readonly string[]): CloudModel[] {
  const { models } = useCloudCatalogStore.getState()
  return ids
    .map((id) => models.find((m) => m.id === id))
    .filter((m): m is CloudModel => m !== undefined && m.quote_required === true && STUDIO_MODELS[m.id] !== undefined && !unmeasuredHidden(m))
}

/** Models that can run the 'edit' op: the masked img2img editors (`edit` flag,
 *  flux-dev) plus the instruction-based edit-only endpoints (`ops` includes
 *  'edit', qwen-image-edit), then the studio editors (instruction, no mask, see
 *  studio-roles.ts). The classic ones stay first. */
export function editCapableModels(): CloudModel[] {
  const classic = useCloudCatalogStore.getState().models.filter((m) => m.kind === 'image' && isEditModel(m))
  return [...classic, ...studioEntries(STUDIO_EDIT_MODELS)]
}

export function isEditCapable(id: string): boolean {
  return editCapableModels().some((m) => m.id === id)
}

/** Does an edit on this model need a painted mask? Masked editors (flux-dev) do.
 *  Instruction editors (qwen-image-edit and every studio editor) read the
 *  prompt and the picture alone, so the button must not wait for a mask. */
export function editNeedsMask(id: string): boolean {
  if (STUDIO_MODELS[id]) return false
  // A server older than c341f5ac leaves the flag out of the catalog; the
  // bundled registration knows that qwen-image-edit takes no mask.
  const maskless = cloudModelById(id)?.maskless ?? CLOUD_MODEL_SEED.find((m) => m.id === id)?.maskless
  return maskless !== true
}

/** The edit model a leftover pick falls back to: the open instruction editor
 *  when the server has it, else the first edit-capable model, as before. */
export function defaultEditModel(): CloudModel | undefined {
  return cloudModelById(DEFAULT_MODEL_IDS.edit) ?? editCapableModels()[0]
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

/** Can this model make a picture from words alone? The classic image models,
 *  the studio ones that start from a sentence, and the Character-Studio
 *  endpoints (which take their LoRA on top). An edit model or an upscaler left
 *  selected from another tab is not one of them. */
export function runsTextToImage(id: string): boolean {
  const m = cloudModelById(id)
  if (!m || m.kind !== 'image') return false
  return m.lora === true || !m.ops || studioTextToImage().includes(id)
}

/** The studio image models that sit in no classic entry (an entry with a
 *  `sourceModel` twin already stands under its classic name). They belong in
 *  the Image picker behind the classic list. */
export function studioOnlyImageModels(): CloudModel[] {
  return studioEntries(studioTextToImage()).filter((m) => !STUDIO_MODELS[m.id]?.sourceModel)
}

/** The Video picker of the Create tab: the classic text-to-video models, then
 *  the studio ones that start from words alone. */
export function videoPickerModels(): CloudModel[] {
  return [...t2vModels(), ...studioEntries(studioTextToVideo())]
}

/** The Animate picker: the classic image-to-video models, then the studio ones
 *  that start from one picture, then the reference models, which take that
 *  picture as their single reference. */
export function animatePickerModels(): CloudModel[] {
  return [...i2vModels(), ...studioEntries(studioImageToVideo()), ...studioEntries(studioReferenceVideo())]
}

/** Utility ops (bg-remove / eraser / image upscale) have no model pick: the
 *  server runs them on fixed endpoints and ignores the model. A Studio model
 *  left selected on the Image tab must not reroute them to op 'studio', which
 *  would render a new picture instead of cutting out, erasing or enhancing.
 *  The run then looks exactly like one with the default image model picked. */
export function utilityOpModel(kind: RenderKind, op: RenderOp, pickedId: string): string {
  const utility = op === 'removebg' || op === 'eraser' || op === 'upscale'
  return utility && kind === 'image' && STUDIO_MODELS[pickedId] ? (defaultCloudModel('image')?.id ?? pickedId) : pickedId
}

/** The model a run will really use for this op — coerces a leftover/incapable
 *  pick onto a capable one (edit→i2i, animate→i2v, video→t2v) so submit + the
 *  credits gate agree. Mirrors each picker's per-op filter. */
export function modelForOp(kind: RenderKind, op: RenderOp, pickedId: string): string {
  if (op === 'edit') return isEditCapable(pickedId) ? pickedId : (defaultEditModel()?.id ?? pickedId)
  if (kind === 'video' && (op === 'generate' || op === 'animate')) {
    const list = op === 'animate' ? animatePickerModels() : videoPickerModels()
    if (list.some((m) => m.id === pickedId)) return pickedId
    const standard = op === 'animate' ? DEFAULT_MODEL_IDS.animate : DEFAULT_MODEL_IDS.video
    return list.some((m) => m.id === standard) ? standard : (list[0]?.id ?? pickedId)
  }
  // Text zu Bild: ein Editor oder Upscaler aus einem anderen Tab darf nicht in
  // einen Lauf ohne Bild geraten (er bricht dort nach dem Absenden ab). Ein
  // Modell, das der Katalog nicht (mehr) kennt, faellt auf den Standard.
  if (kind === 'image' && op === 'generate' && !runsTextToImage(pickedId)) {
    return defaultCloudModel('image')?.id ?? pickedId
  }
  // 2.5.8 op-specialized intents: coerce a stale pick onto a model that
  // actually serves the op (same rule the pickers apply).
  if (op === 'lipsync' || op === 'extend' || op === 'motion' || op === 'music' || op === 'tts' || op === 'lora-train') {
    const list = modelsForOp(kind, op)
    return list.some((m) => m.id === pickedId) ? pickedId : (list[0]?.id ?? pickedId)
  }
  return utilityOpModel(kind, op, pickedId)
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
  const entry = cloudModelById(model)
  // P3, Studio-Zweig (P9 rescoped): a Studio model (`quote_required` on the
  // catalog entry) prices its OWN generation run live from POST
  // /api/jobs/studio-quote, see studio.ts and studio-contract.ts's own
  // `studioCredits()` formula, which is a PREVIEW, not this function's job.
  // Computing this generic base/long/by_duration figure for a Studio
  // generation would drift from the provider's real price the moment it
  // changes there, and a run must never book a different number than what
  // got shown (Portplan Abschnitt 7, Risiko 1); no UI path does this today
  // (Composer/CreditsMeter route a Studio pick around runCredits entirely,
  // preset-models.ts/create-presets.ts only call runCredits for non-studio
  // steps), this guard is the safety net for the day one of them slips.
  //
  // The guard sits HERE, not before the op branches above, on purpose: a
  // Studio-originated video can still reach the generic video-upscale
  // 'enhance' action from the gallery Lightbox, a wholly separate render-service
  // utility endpoint, priced from the flat per-second `ops` rate table, not
  // from this model's own Studio price. Blocking that call too (the
  // original, wider guard did) forced the enhance-credits gate onto the
  // quota's generic per-kind fallback for every Studio-originated clip,
  // silently hiding the real per-second rate. Scoping the guard to only the
  // generic-model-credits branch below fixes that and is what actually makes
  // Lightbox's `runCredits('video', 'upscale', item.model, ...)` call
  // correct for a Studio clip.
  if (entry?.quote_required) return fallback
  const credits = entry?.credits
  if (!credits) return fallback
  // P3, by_duration: dd29f359 lets a video model book any advertised length,
  // not just the short/long pair; an exact catalog price for the requested
  // length beats rounding it onto one of the two buckets below. Falls
  // through to the base/long split when the catalog carries no per-duration
  // table yet (older payload) or no entry for this exact length.
  if (kind === 'video' && seconds !== undefined && credits.by_duration) {
    const exact = credits.by_duration[String(seconds)]
    if (exact !== undefined) return exact
  }
  return kind === 'video' && seconds !== undefined && seconds >= 6.5
    ? (credits.long ?? credits.base)
    : credits.base
}

/** The ops whose models the provider can meter by length (as in the
 *  server's price table). */
const LENGTH_OPS: ReadonlySet<string> = new Set(['lipsync', 'tts', 'extend', 'motion'])

/** The length price of a run, when the server says this model is metered by
 *  the length of its input. No `op` asks about the model as such. Undefined
 *  for every other model and for a server that does not send the field: then
 *  the catalogue figure is the price, as it always was. */
export function lengthPrice(model?: string, op?: string): CloudLengthPrice | undefined {
  if (model === undefined || (op !== undefined && !LENGTH_OPS.has(op))) return undefined
  const rate = cloudModelById(model)?.credits?.length
  if (!rate || !(rate.block > 0) || !(rate.per_block >= 0)) return undefined
  return rate
}

/** Credits for `units` seconds (or characters) on a length-priced model, the
 *  server's own rule: up to whole units, never below its minimum, per started
 *  block. Without a known length it is the price of the catalogue length,
 *  which is `credits.base`. */
export function lengthCredits(model: string, units?: number): number {
  const rate = lengthPrice(model)
  if (!rate) return cloudModelById(model)?.credits?.base ?? 0
  const known = units !== undefined && Number.isFinite(units) && units > 0
  const billed = Math.min(rate.max, Math.max(rate.min, Math.ceil((known ? units : rate.quote) - 1e-6)))
  return Math.ceil(billed / rate.block) * rate.per_block
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
 *  hidden price hike (bug-reports 2026-08-08). Video quotes the
 *  short clip; the meter refines it to the exact run. Undefined when the entry
 *  carries no price (seed/offline).
 *
 *  Review B7 (Runde 2): the same `quote_required` guard `runCredits()` has
 *  twenty lines up: a Studio entry must never print a self-computed hint,
 *  its real price lives in `studio-contract.ts`/`studioQuote()`, not in this
 *  model's `credits` field. Harmless today (a Studio entry carries `pricing`,
 *  not `credits`, so `c` is already undefined below), but a future catalog
 *  payload that sends both must not silently start printing a wrong number
 *  here just because the other guard was three lines away. */
export function modelCostHint(m: CloudModel, op: RenderOp, seconds?: number): string | undefined {
  if (m.quote_required) return undefined
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
