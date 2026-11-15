import { describe, it, expect, beforeEach } from 'vitest'
import {
  useCloudCatalogStore,
  modelCostHint,
  cloudModelsFor,
  defaultCloudModel,
  defaultEditModel,
  isEditCapable,
  cloudMediaLive,
  runCredits,
  t2vModels,
  i2vModels,
  modelForOp,
  opPickerModels,
  resolveOpPick,
} from '../cloudCatalogStore'
import { CLOUD_MODEL_SEED } from '../../lib/render/cloud-models'
import type { CloudCatalog } from '../../api/cloud/catalog'

const serverCatalog: CloudCatalog = {
  models: [
    { id: 'flux-9', label: 'Flux 9', kind: 'image', edit: true, cfg: true, credits: { base: 300 } },
    { id: 'wan-9', label: 'Wan 9', kind: 'video', clip: { short: 5, long: 8 }, credits: { base: 8000, long: 13000 } },
  ],
  ops: {
    removebg: 1000,
    eraser: 2500,
    upscale_image: 1000,
    upscale_image_res: { '2k': 1000, '4k': 1000, '8k': 4000 },
    upscale_video_per_s: 500,
    upscale_video_min: 2500,
  },
  voice: { stt: 600, tts_per_1k_chars: 8000 },
  media_live: false,
  tier: 'hosted-max',
  monthly_credits: 2_550_000,
}

beforeEach(() => {
  useCloudCatalogStore.setState({
    fetchedAt: null,
    models: CLOUD_MODEL_SEED,
    ops: null,
    voice: null,
    mediaLive: null,
  })
})

describe('cloudCatalogStore', () => {
  it('falls back to the static seed before any fetch', () => {
    expect(cloudModelsFor('image').length).toBeGreaterThan(0)
    // 02.10.2026: der neue Standard fuer Bild steht im Notvorrat (klassisch), der
    // fuer Video (minimax-h3-t2v, ein Studio-Modell) nicht: ohne Server bleibt
    // es beim ersten klassischen Videomodell.
    expect(defaultCloudModel('image')?.id).toBe('z-image-turbo')
    expect(defaultCloudModel('video')?.id).toBe('wan-2.2-720p')
    expect(isEditCapable('flux-dev')).toBe(true)
    expect(isEditCapable('flux-schnell')).toBe(false)
    // never fetched → unknown → treat as live (don't false-block)
    expect(cloudMediaLive()).toBe(true)
  })

  it('setCatalog replaces the seed with the server truth', () => {
    useCloudCatalogStore.getState().setCatalog(serverCatalog)
    expect(defaultCloudModel('image')?.id).toBe('flux-9')
    expect(defaultCloudModel('video')?.id).toBe('wan-9')
    expect(isEditCapable('flux-9')).toBe(true)
    expect(useCloudCatalogStore.getState().ops?.eraser).toBe(2500)
    expect(useCloudCatalogStore.getState().fetchedAt).not.toBeNull()
    // server said media is off → honest coming-soon
    expect(cloudMediaLive()).toBe(false)
  })

  it('seed ids match the wired flags (edit only on flux-dev, neg-prompt on wan/hunyuan)', () => {
    const editCapable = CLOUD_MODEL_SEED.filter((m) => m.edit).map((m) => m.id)
    expect(editCapable).toEqual(['flux-dev'])
    const negPrompt = CLOUD_MODEL_SEED.filter((m) => m.negative_prompt).map((m) => m.id)
    // hunyuan-video stand hier bis zum 24.10.2026 (retired-models.ts).
    expect(negPrompt).toEqual(['wan-2.2-720p', 'wan-2.2-fast'])
  })

  it('defaultCloudModel never explodes on an all-specialized kind (audio)', () => {
    // Audio has no classic (ops-less) entries — in the seed AND the live v2
    // catalog. Before the guard this was `cloudModelsFor('audio')[0].id` →
    // TypeError, taking down the whole Create page for anyone opening Music
    // without a previously picked image model (live-found on 2026-07-18).
    expect(cloudModelsFor('audio')).toEqual([])
    expect(defaultCloudModel('audio')?.kind).toBe('audio')
    expect(defaultCloudModel('audio')?.ops?.length).toBeGreaterThan(0)
    // a kind with no models at all resolves to undefined instead of throwing
    useCloudCatalogStore.setState({ models: [] })
    expect(defaultCloudModel('audio')).toBeUndefined()
    expect(defaultCloudModel('image')).toBeUndefined()
  })

  it('defaultEditModel resolves the first edit-capable image model (seed and server)', () => {
    expect(defaultEditModel()?.id).toBe('flux-dev')
    useCloudCatalogStore.getState().setCatalog(serverCatalog)
    expect(defaultEditModel()?.id).toBe('flux-9')
  })

  // R5-58: qwen-image-edit serves 'edit' through `ops: ['edit']`, not
  // `edit: true`. isEditCapable and defaultEditModel used to check only the
  // classic flag, so this model existed in the seed and was still
  // unreachable from the edit picker and the submit-time fallback.
  it('R5-58: isEditCapable recognises an ops-based edit model too', () => {
    expect(isEditCapable('qwen-image-edit')).toBe(true)
    expect(isEditCapable('qwen-image')).toBe(false) // plain generate-only model
  })

  it('R5-58: qwen-image-edit is in the seed with the maskless flag Web sets', () => {
    const m = CLOUD_MODEL_SEED.find((x) => x.id === 'qwen-image-edit')
    expect(m).toBeDefined()
    expect(m?.ops).toContain('edit')
    expect(m?.maskless).toBe(true)
  })

  describe('runCredits', () => {
    it('falls back to the quota figure before any catalog fetch (seed has no prices)', () => {
      expect(runCredits('image', 'generate', 'flux-schnell', undefined, 300)).toBe(300)
      expect(runCredits('image', 'eraser', 'flux-schnell', undefined, 300)).toBe(300)
    })

    it('prices utility ops from the catalog ops table', () => {
      useCloudCatalogStore.getState().setCatalog(serverCatalog)
      expect(runCredits('image', 'removebg', 'flux-9', undefined, 300)).toBe(1000)
      expect(runCredits('image', 'eraser', 'flux-9', undefined, 300)).toBe(2500)
      expect(runCredits('image', 'upscale', 'flux-9', undefined, 300)).toBe(1000)
    })

    it('prices video upscale per second with the min floor and the server 8s default', () => {
      useCloudCatalogStore.getState().setCatalog(serverCatalog)
      // unknown clip length → server default 8 s → 500 × 8 = 4000 (what the submit claims)
      expect(runCredits('video', 'upscale', 'wan-9', undefined, 300)).toBe(4000)
      expect(runCredits('video', 'upscale', 'wan-9', 10, 300)).toBe(5000)
      // short clip books the floor
      expect(runCredits('video', 'upscale', 'wan-9', 3, 300)).toBe(2500)
      // no catalog → quota fallback
      useCloudCatalogStore.setState({ ops: null })
      expect(runCredits('video', 'upscale', 'wan-9', undefined, 300)).toBe(300)
    })

    it('prices image upscale per target resolution, flat 4k when the res table is absent', () => {
      useCloudCatalogStore.getState().setCatalog(serverCatalog)
      expect(runCredits('image', 'upscale', 'flux-9', undefined, 300, '8k')).toBe(4000)
      expect(runCredits('image', 'upscale', 'flux-9', undefined, 300, '2k')).toBe(1000)
      // Older persisted catalog without the res table → flat 4k figure.
      useCloudCatalogStore.getState().setCatalog({
        ...serverCatalog,
        ops: { ...serverCatalog.ops, upscale_image_res: undefined },
      })
      expect(runCredits('image', 'upscale', 'flux-9', undefined, 300, '8k')).toBe(1000)
    })

    it('prices generates per model, booking the long clip rate from 6.5 s', () => {
      useCloudCatalogStore.getState().setCatalog(serverCatalog)
      expect(runCredits('image', 'generate', 'flux-9', undefined, 300)).toBe(300)
      expect(runCredits('video', 'generate', 'wan-9', 5, 40000)).toBe(8000)
      expect(runCredits('video', 'generate', 'wan-9', 8, 40000)).toBe(13000)
    })

    it('edit coerces onto the edit-capable model like the submit does', () => {
      useCloudCatalogStore.getState().setCatalog(serverCatalog)
      expect(runCredits('image', 'edit', 'some-t2i-only', undefined, 999)).toBe(300)
    })

    it('an unknown pick is priced as the model the run really uses, the default', () => {
      // Seit 02.10.2026 faengt modelForOp eine Wahl ab, die der Katalog nicht
      // (mehr) kennt, und Zaehler und Start rechnen beide mit dem Standard.
      useCloudCatalogStore.getState().setCatalog(serverCatalog)
      expect(runCredits('image', 'generate', 'not-in-catalog', undefined, 321)).toBe(300)
    })

    it('falls back to the quota figure when the entry carries no price', () => {
      useCloudCatalogStore.getState().setCatalog({
        ...serverCatalog,
        models: [{ id: 'flux-9', label: 'Flux 9', kind: 'image' }],
      })
      expect(runCredits('image', 'generate', 'flux-9', undefined, 321)).toBe(321)
      expect(runCredits('image', 'generate', 'not-in-catalog', undefined, 321)).toBe(321)
    })
  })

  describe('video capability flags (t2v / i2v)', () => {
    const mixed: CloudCatalog = {
      ...serverCatalog,
      models: [
        { id: 'flux-9', label: 'Flux 9', kind: 'image', edit: true },
        { id: 'dual', label: 'Dual', kind: 'video', t2v: true, i2v: true },
        { id: 't2v-only', label: 'T2V only', kind: 'video', t2v: true, i2v: false },
        { id: 'legacy', label: 'Legacy (no flags)', kind: 'video' },
      ],
    }

    it('every classic seed clip model animates an image; the open ones do only that', () => {
      // Op-specialized 2.5.8 entries (lipsync/extend/motion/trainer) are not
      // clip-generation models and are hard-false on both flags.
      const vids = CLOUD_MODEL_SEED.filter((m) => m.kind === 'video' && !m.ops)
      expect(vids.length).toBeGreaterThan(0)
      expect(vids.every((m) => m.i2v !== false)).toBe(true)
      // Text-to-video is what splits the list since 2026-09-13: the provider
      // ships no text-to-video twin for the open endpoints, so exactly those
      // carry t2v: false and every other clip model still does both.
      expect(vids.filter((m) => m.t2v === false).map((m) => m.id))
        .toEqual(vids.filter((m) => m.id.includes('spicy')).map((m) => m.id))
      expect(vids.filter((m) => m.t2v !== false).length).toBeGreaterThan(0)
      const specialized = CLOUD_MODEL_SEED.filter((m) => m.kind === 'video' && m.ops)
      expect(specialized.length).toBeGreaterThan(0)
      expect(specialized.every((m) => m.t2v === false && m.i2v === false)).toBe(true)
    })

    it('op-specialized seed models never reach the classic pickers', () => {
      useCloudCatalogStore.setState({ models: CLOUD_MODEL_SEED })
      for (const m of t2vModels()) expect(m.ops).toBeUndefined()
      for (const m of i2vModels()) expect(m.ops).toBeUndefined()
    })

    it('i2vModels excludes an i2v:false model; an absent flag stays capable', () => {
      useCloudCatalogStore.getState().setCatalog(mixed)
      expect(i2vModels().map((m) => m.id)).toEqual(['dual', 'legacy'])
      expect(t2vModels().map((m) => m.id)).toEqual(['dual', 't2v-only', 'legacy'])
    })

    it('op picker offers image trainers only and resolves stale picks (take-01 regression)', () => {
      // No surface can provide a video training set (or use a video LoRA), so
      // the LTX video trainer stays out of the Character-Studio picker.
      const trainers = opPickerModels('lora-train')
      expect(trainers.map((m) => m.id)).toContain('flux-lora-trainer')
      expect(trainers.map((m) => m.id)).not.toContain('ltx-2-video-lora-trainer')
      expect(trainers.every((m) => m.kind === 'image')).toBe(true)
      // cloudOpModel still held the lipsync model when Character Studio opened:
      // the chip displayed Flux but submit flipped kind to video and trained on
      // the LTX video trainer ("No videos found in the zip file"). Chip, meter
      // and submit now resolve through this one rule.
      expect(resolveOpPick('lora-train', 'p-video-avatar')).toBe('flux-lora-trainer')
      expect(resolveOpPick('lipsync', 'p-video-avatar')).toBe('p-video-avatar')
      useCloudCatalogStore.setState({ models: [] })
      expect(resolveOpPick('lora-train', 'p-video-avatar')).toBe('')
    })

    it('modelForOp coerces an incapable pick onto the op’s first valid model', () => {
      useCloudCatalogStore.getState().setCatalog(mixed)
      // animate with a t2v-only pick → first i2v-capable clip model
      expect(modelForOp('video', 'animate', 't2v-only')).toBe('dual')
      // a capable pick is kept untouched
      expect(modelForOp('video', 'animate', 'legacy')).toBe('legacy')
      expect(modelForOp('video', 'generate', 't2v-only')).toBe('t2v-only')
      // edit still coerces onto the edit-capable image model
      expect(modelForOp('image', 'edit', 'dual')).toBe('flux-9')
      // a non-video, non-edit op keeps the pick
      expect(modelForOp('image', 'generate', 'flux-9')).toBe('flux-9')
    })
  })

  describe('modelCostHint (A3: the shown price is the billed price)', () => {
    const ace = {
      id: 'ace-step-1.5', label: 'ACE-Step 1.5', kind: 'audio' as const,
      ops: ['music' as const], credits: { base: 1800, per_s: 30 },
    }

    it('music follows the length slider, not a static 60 s quote', () => {
      // a user's exact run: 3:10 = 190 s at 30 cr/s.
      expect(modelCostHint(ace, 'music', 190)).toBe('5,700 cr')
      expect(modelCostHint(ace, 'music', 60)).toBe('1,800 cr')
    })

    it('NEGATIVE CONTROL: without a duration the 60 s default still prices', () => {
      expect(modelCostHint(ace, 'music')).toBe('1,800 cr')
      expect(modelCostHint(ace, 'music', 0)).toBe('1,800 cr')
    })

    it('non-music ops ignore the duration and quote base', () => {
      const flux = { id: 'flux-9', label: 'Flux 9', kind: 'image' as const, credits: { base: 300 } }
      expect(modelCostHint(flux, 'generate', 190)).toBe('300 cr')
    })
  })
})
