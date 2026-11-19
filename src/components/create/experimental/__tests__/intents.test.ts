import { describe, it, expect } from 'vitest'
import { INTENTS, INTENT_MAP, intentNeedsSource, intentTakesPrompt, isIntentAvailable, isIntentLocked, visibleIntents } from '../intents'
import { LOCAL_LANE_OPS, LOCAL_UTILITY_OPS } from '../../../../stores/createStore'

// 2026-07-10 made the advanced ops cloud-only; 2026-07-12 brought
// Edit BACK to local as the 4th local tab (checkpoint mask inpaint —
// VAEEncodeForInpaint / InpaintModelConditioning); 2026-07-17 brought
// Animate (local I2V) back as the 5th. 2.5.8 gives FOUR specialized categories
// REAL local lanes (hasLocalLane): music / lipsync / extend / motion on core
// ComfyUI node families (motion additionally needs the DWPose pack, which
// loads fine on Windows via the OpenCV CPU fallback). Eraser stays hosted
// only; upscale got a local lane in 3.0.7 (core upscale nodes). Character
// was cloud-first through 2.5.x; 2.6.0 ships the
// musubi trainer runtime (trainer.rs), so its train lane is local now too.
/** The pills the bar shows, in order. */
const shown = (backend: 'local' | 'cloud', mlxHost: boolean) =>
  visibleIntents(backend, mlxHost, true).map((m) => m.id)
/** The pills a user can actually select (no cloud-teaser lock). */
const unlocked = (backend: 'local' | 'cloud', mlxHost: boolean) =>
  visibleIntents(backend, mlxHost, true).filter((m) => !isIntentLocked(m, backend, mlxHost)).map((m) => m.id)
/** The pills shown as locked, cloud-tagged teasers. */
const teasers = (backend: 'local' | 'cloud', mlxHost: boolean) =>
  visibleIntents(backend, mlxHost, true).filter((m) => isIntentLocked(m, backend, mlxHost)).map((m) => m.id)

describe('intent cloud gating', () => {
  it('eraser stays hosted-only (no local lane)', () => {
    expect(INTENT_MAP.eraser.cloudOnly).toBe(true)
    expect(INTENT_MAP.eraser.hasLocalLane).toBeUndefined()
  })

  it('upscale keeps its hosted endpoint and runs locally too since 3.0.7', () => {
    expect(INTENT_MAP.upscale.cloudOnly).toBe(true)
    expect(INTENT_MAP.upscale.hasLocalLane).toBe(true)
    expect(INTENT_MAP.upscale.requiresModels).toBe('upscale')
  })

  it('image, edit, video, removebg and animate stay available locally', () => {
    for (const id of ['image', 'edit', 'video', 'removebg', 'animate'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBeUndefined()
    }
  })

  it('the dual lanes carry a hosted clip AND a local lane (character joined in 2.6.0)', () => {
    for (const id of ['music', 'lipsync', 'extend', 'motion', 'character'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBe(true)
      expect(INTENT_MAP[id].hasLocalLane, id).toBe(true)
    }
  })

  it('intent metadata mirrors the store LOCAL_LANE_OPS plus LOCAL_UTILITY_OPS exactly', () => {
    const fromMeta = INTENTS.filter((m) => m.hasLocalLane).map((m) => m.id).sort()
    expect(fromMeta).toEqual([...LOCAL_LANE_OPS, ...LOCAL_UTILITY_OPS].sort())
  })

  it('the local IntentBar filter keeps the 5 classic tabs, Enhance, Scene, the 5 lanes and 3D selectable', () => {
    const selectable = INTENTS.filter((m) => !m.cloudOnly || m.hasLocalLane).map((m) => m.id)
    // Scene to Video (3.1.3) runs Wan 2.1 VACE in ComfyUI, after Animate as on the web.
    expect(selectable).toEqual(['image', 'edit', 'removebg', 'upscale', 'video', 'animate', 'scene', 'character', 'lipsync', 'music', 'extend', 'motion', '3d'])
    // …and that IS what the pure filter reports for a ComfyUI local host.
    expect(unlocked('local', false)).toEqual(selectable)
  })

  it('local edit gates on the inpaint capability + image models', () => {
    expect(INTENT_MAP.edit.capability).toBe('inpaint-nodes')
    expect(INTENT_MAP.edit.requiresModels).toBe('image')
    expect(INTENT_MAP.edit.allowsMask).toBe(true)
    // The fresh-PC Download & install card also covers plain generation.
    expect(INTENT_MAP.image.requiresModels).toBe('image')
    expect(INTENT_MAP.video.requiresModels).toBe('video')
  })

  it('local animate needs a source image and gates on video models', () => {
    expect(INTENT_MAP.animate.needsSource).toBe(true)
    expect(INTENT_MAP.animate.isVideo).toBe(true)
    expect(INTENT_MAP.animate.requiresModels).toBe('video')
  })

  it('the lanes gate on their own model kinds', () => {
    expect(INTENT_MAP.music.requiresModels).toBe('audio')
    expect(INTENT_MAP.lipsync.requiresModels).toBe('lipsync')
    // Extend rides the regular i2v-capable video list (last-frame continue).
    expect(INTENT_MAP.extend.requiresModels).toBe('video')
    // Motion gates on the VACE/Animate model list AND the DWPose pack.
    expect(INTENT_MAP.motion.requiresModels).toBe('motion')
    expect(INTENT_MAP.motion.capability).toBe('dwpose')
    // Scene to Video gates on the VACE files of the same list and on the
    // depth extractor of the same pack (laneModelCount counts VACE only).
    expect(INTENT_MAP.scene.requiresModels).toBe('motion')
    expect(INTENT_MAP.scene.capability).toBe('depth')
    // Character has no requiresModels gate: LocalTrainControls runs its own
    // three gates (trainer env, Z-Image bases, staged photos) instead.
    expect(INTENT_MAP.character.requiresModels).toBeUndefined()
  })
})

// The Mac has NO ComfyUI (hard product rule): its local media is the
// in-process MLX path, which runs plain text-to-image and text-to-video and
// nothing else. Every other lane's "local" implementation is a ComfyUI graph
// (RMBG cutout, inpaint nodes, ACE music, Wan S2V, VACE/DWPose) and every
// source-needing lane additionally stages its input through ComfyUI's
// /upload/image, which does not exist there either. So on a local MLX Mac an
// intent must never render as an active local tab unless MLX really runs it.
describe('intent gating on a local MLX Mac (no ComfyUI)', () => {
  it('only image, video, the cutout, Character Studio and 3D stay real local tabs', () => {
    // Remove Background runs on Vision in macOS (commands/mlx_cutout.rs).
    // Character Studio runs "Use character" through mflux with the LoRA from
    // the Mac's LoRA folder; its Train tab says where to train. 3D (3.1.0) is
    // TripoSR's own engine; without it the Stage offers the setup.
    expect(unlocked('local', true)).toEqual(['image', 'removebg', 'video', 'character', '3d'])
  })

  it('the hosted-only tools AND the 2.5.8 lanes become cloud teasers', () => {
    // Same locked pill + ", runs on LU Cloud" label the 2.6.0 bar already
    // uses — visible, honest, and it opens the teaser sheet on tap.
    // Swap Character (07.11.2026) is hosted-only like Erase, so it is a teaser
    // here too.
    // Scene to Video (3.1.3) too: its local lane is a ComfyUI graph.
    expect(teasers('local', true)).toEqual(['upscale', 'eraser', 'scene', 'lipsync', 'music', 'extend', 'motion', 'swap_character'])
  })

  it('every Mac teaser has a cloud endpoint to teased about', () => {
    for (const id of teasers('local', true)) {
      expect(INTENT_MAP[id].cloudOnly, id).toBe(true)
    }
  })

  it('edit and animate are hidden rather than shown as dead tabs', () => {
    // No hosted-only flag means no teaser sheet exists for them, and MLX
    // silently DROPS a source + mask (it only takes prompt/steps/seed/size/
    // negative) — which produced an unrelated fresh image instead of an edit.
    // Hiding is the only honest state left.
    const hidden = INTENTS.map((m) => m.id).filter((id) => !shown('local', true).includes(id))
    expect(hidden).toEqual(['edit', 'animate'])
  })

  it('nothing is hidden on cloud or on a ComfyUI local host', () => {
    expect(shown('cloud', true)).toEqual(INTENTS.map((m) => m.id))
    expect(shown('cloud', false)).toEqual(INTENTS.map((m) => m.id))
    expect(shown('local', false)).toEqual(INTENTS.map((m) => m.id))
  })

  it('cloud unlocks every intent regardless of host', () => {
    expect(unlocked('cloud', true)).toEqual(INTENTS.map((m) => m.id))
    expect(teasers('cloud', true)).toEqual([])
  })

  it('a Mac on the cloud backend is unaffected by the MLX rule', () => {
    expect(unlocked('cloud', true)).toEqual(unlocked('cloud', false))
  })

  it("isIntentAvailable gates the result's 'Edit with mask' action the same way", () => {
    // The action force-sets 'edit'; it must vanish exactly where the tab does.
    expect(isIntentAvailable('edit', 'local', true)).toBe(false)
    expect(isIntentAvailable('edit', 'local', false)).toBe(true)
    expect(isIntentAvailable('edit', 'cloud', true)).toBe(true)
    // And it agrees with the bar for every intent, on every backend/host.
    for (const backend of ['local', 'cloud'] as const) {
      for (const mlxHost of [true, false]) {
        for (const m of INTENTS) {
          expect(isIntentAvailable(m.id, backend, mlxHost), `${m.id}/${backend}/${mlxHost}`)
            .toBe(unlocked(backend, mlxHost).includes(m.id))
        }
      }
    }
  })

  // M1 (14.10.2026): Extend Video continues from the last frame of a clip
  // through image to video, so on a Mac it runs on the models that Animate
  // runs on, and only while one is installed. Until then it was a cloud
  // teaser on every Mac.
  it('on a Mac, Extend Video is a local tab exactly while Animate is one', () => {
    for (const mlxAnimate of [false, true]) {
      const extend = INTENTS.find((m) => m.id === 'extend')!
      expect(isIntentLocked(extend, 'local', true, mlxAnimate), `animate ${mlxAnimate}`).toBe(!mlxAnimate)
      expect(isIntentAvailable('extend', 'local', true, mlxAnimate)).toBe(isIntentAvailable('animate', 'local', true, mlxAnimate))
    }
    // The other ComfyUI lanes stay teasers whatever is installed.
    for (const id of ['lipsync', 'music', 'motion'] as const) {
      expect(isIntentLocked(INTENTS.find((m) => m.id === id)!, 'local', true, true, true), id).toBe(true)
    }
  })

  // 3.0.8: Talking Character runs on LTX-2.3 4-bit (the engine's a2v) while
  // that model is installed, and is the cloud teaser it was without it.
  it('on a Mac, Talking Character is a local tab exactly while a model that talks is installed', () => {
    const lipsync = INTENT_MAP.lipsync
    for (const mlxTalk of [false, true]) {
      expect(isIntentLocked(lipsync, 'local', true, false, false, false, false, false, mlxTalk), `talk ${mlxTalk}`).toBe(!mlxTalk)
      expect(isIntentAvailable('lipsync', 'local', true, false, false, false, false, false, mlxTalk)).toBe(mlxTalk)
      expect(visibleIntents('local', true, false, false, false, false, false, false, mlxTalk).includes(lipsync)).toBe(mlxTalk)
    }
    // It frees no other lane, and a ComfyUI host is not touched by it.
    const others = (talk: boolean) => INTENTS.filter((m) => m.id !== 'lipsync' && !isIntentLocked(m, 'local', true, false, false, false, false, false, talk)).map((m) => m.id)
    expect(others(true)).toEqual(others(false))
    for (const talk of [false, true]) {
      expect(isIntentLocked(lipsync, 'local', false, false, false, false, false, false, talk)).toBe(false)
      expect(isIntentLocked(lipsync, 'cloud', true, false, false, false, false, false, talk)).toBe(false)
    }
  })
})

describe('3D (3.1.0)', () => {
  it('is the last pill, so no tool moves', () => {
    expect(INTENTS[INTENTS.length - 1].id).toBe('3d')
    expect(INTENT_MAP['3d'].short).toBe('3D')
  })
  it('takes a prompt from text only, and a source from a picture or a video', () => {
    expect(intentTakesPrompt('3d', false, 'text')).toBe(true)
    expect(intentTakesPrompt('3d', false, 'image')).toBe(false)
    expect(intentTakesPrompt('3d', false, 'video')).toBe(false)
    expect(intentNeedsSource('3d', 'text')).toBe(false)
    expect(intentNeedsSource('3d', 'image')).toBe(true)
    expect(intentNeedsSource('3d', 'video')).toBe(true)
    // Every other tab keeps its own flags.
    expect(intentNeedsSource('animate')).toBe(true)
    expect(intentTakesPrompt('image')).toBe(true)
  })
  it('is a working tab in the cloud, on ComfyUI and on a Mac', () => {
    expect(unlocked('cloud', false)).toContain('3d')
    expect(unlocked('local', false)).toContain('3d')
    expect(unlocked('local', true)).toContain('3d')
  })
})
