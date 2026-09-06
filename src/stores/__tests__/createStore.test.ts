import { describe, it, expect, vi, beforeEach } from 'vitest'

// The vitest env is 'node' (no DOM). zustand persist reads window.localStorage
// (createJSONStorage default) at store-module load; without it the persist API
// is never attached and the partialize test below cannot reach getOptions().
// Install a Map-backed store BEFORE the hoisted import (same pattern as
// providerStore.keychain.test.ts, hoisted because static imports run first).
vi.hoisted(() => {
  const map = new Map<string, string>()
  const ls = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => { map.clear() },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size },
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = ls
  const g = globalThis as unknown as { window?: Record<string, unknown> }
  g.window = Object.assign(g.window ?? {}, { localStorage: ls })
})

// Der Wirt wird festgenagelt, nicht geraten. `isMacOS()` liest den
// User-Agent, und im Testlauf meldet dieser Rechner einen Mac: gemessen am
// 04.09.2026, `isMacOS()` ist hier true, auf einem Linux-Laeufer waere es
// false. Damit haetten die Faelle weiter unten je nach Maschine ein anderes
// Ergebnis. Dieser Block beschreibt den ComfyUI-Wirt (Windows und Linux); der
// Mac hat seine eigene Datei, der-mac-strandet-nicht-auf-einem-werkzeug.
vi.mock('../../api/mlx-image', () => ({ isMlxImageHost: () => false, MLX_MODEL_PREFIX: 'MLX ' }))

// Mock comfyui before importing the store
vi.mock('../../api/comfyui', () => ({
  classifyModel: vi.fn((name: string) => {
    if (name.includes('wan')) return 'wan'
    if (name.includes('hunyuan')) return 'hunyuan'
    if (name.includes('ltx')) return 'ltx'
    if (name.includes('flux2')) return 'flux2'
    if (name.includes('flux')) return 'flux'
    if (name.includes('zimage')) return 'zimage'
    if (name.includes('sdxl')) return 'sdxl'
    if (name.includes('sd15')) return 'sd15'
    return 'unknown'
  }),
}))

import { useCreateStore, MODEL_TYPE_DEFAULTS } from '../createStore'
import type { GalleryItem } from '../createStore'
import { prop } from '../../types/json-guards'

// ── Helpers ─────────────────────────────────────────────────────

const makeGalleryItem = (id: string, prompt = 'test'): GalleryItem => ({
  id,
  type: 'image',
  filename: `${id}.png`,
  subfolder: '',
  prompt,
  negativePrompt: '',
  model: 'test-model',
  modelType: 'sdxl',
  seed: 42,
  steps: 20,
  cfgScale: 7,
  sampler: 'euler',
  scheduler: 'normal',
  width: 1024,
  height: 1024,
  batchSize: 1,
  createdAt: Date.now(),
})

const INITIAL_STATE = {
  mode: 'image' as const,
  imageSubMode: 'text2img' as const,
  prompt: '',
  negativePrompt: '',
  imageModel: '',
  imageModelType: 'unknown' as const,
  videoModel: '',
  sampler: 'euler',
  scheduler: 'normal',
  steps: 20,
  cfgScale: 7,
  width: 1024,
  height: 1024,
  seed: -1,
  batchSize: 1,
  frames: 24,
  fps: 8,
  denoise: 0.7,
  i2iImage: null,
  i2vImage: null,
  isGenerating: false,
  progress: 0,
  progressText: '',
  progressPhase: 'idle' as const,
  currentPromptId: null,
  error: null,
  lastGenTime: null,
  gallery: [],
  promptHistory: [],
}

// ═══════════════════════════════════════════════════════════════
//  createStore
// ═══════════════════════════════════════════════════════════════

describe('createStore', () => {
  beforeEach(() => {
    useCreateStore.setState(INITIAL_STATE)
  })

  // ── Initial state ──────────────────────────────────────────

  describe('initial state', () => {
    it('has correct default values', () => {
      const state = useCreateStore.getState()
      expect(state.mode).toBe('image')
      expect(state.imageSubMode).toBe('text2img')
      expect(state.prompt).toBe('')
      expect(state.negativePrompt).toBe('')
      expect(state.imageModel).toBe('')
      expect(state.imageModelType).toBe('unknown')
      expect(state.videoModel).toBe('')
      expect(state.sampler).toBe('euler')
      expect(state.scheduler).toBe('normal')
      expect(state.steps).toBe(20)
      expect(state.cfgScale).toBe(7)
      expect(state.width).toBe(1024)
      expect(state.height).toBe(1024)
      expect(state.seed).toBe(-1)
      expect(state.batchSize).toBe(1)
      expect(state.frames).toBe(24)
      expect(state.fps).toBe(8)
      expect(state.denoise).toBe(0.7)
      expect(state.i2iImage).toBeNull()
      expect(state.i2vImage).toBeNull()
      expect(state.isGenerating).toBe(false)
      expect(state.gallery).toEqual([])
      expect(state.promptHistory).toEqual([])
    })

    // Regression: CreateTopControls (header dropdown) reads these fields
    // directly. If they're undefined, `activeList.length` / `.map()` crash
    // the whole app. Reported on Discord by @diimmortalis (v2.3.9) and
    // @phantomderp (v2.4.0). Defensive `?? []` lives in CreateTopControls,
    // but the store itself must also hand out safe defaults.
    it('initializes imageModelList, videoModelList, comfyRunning', () => {
      // Force a clean construction so we bypass the INITIAL_STATE merge that
      // beforeEach does (INITIAL_STATE intentionally omits these to prove the
      // setter/getter contract without leaning on the initial-state defaults).
      useCreateStore.setState({
        imageModelList: [],
        videoModelList: [],
        comfyRunning: false,
      })
      const state = useCreateStore.getState()
      expect(Array.isArray(state.imageModelList)).toBe(true)
      expect(Array.isArray(state.videoModelList)).toBe(true)
      expect(state.imageModelList).toEqual([])
      expect(state.videoModelList).toEqual([])
      expect(state.comfyRunning).toBe(false)
    })

    it('setImageModelList / setVideoModelList replace the lists', () => {
      const imgs = [
        { name: 'flux-schnell.safetensors', type: 'flux' as const, source: 'checkpoint' as const },
        { name: 'sdxl-base.safetensors', type: 'sdxl' as const, source: 'checkpoint' as const },
      ]
      const vids = [{ name: 'wan-2.1.safetensors', type: 'wan' as const, source: 'checkpoint' as const }]
      useCreateStore.getState().setImageModelList(imgs)
      useCreateStore.getState().setVideoModelList(vids)
      expect(useCreateStore.getState().imageModelList).toEqual(imgs)
      expect(useCreateStore.getState().videoModelList).toEqual(vids)
    })

    it('setComfyRunning toggles the flag', () => {
      useCreateStore.getState().setComfyRunning(true)
      expect(useCreateStore.getState().comfyRunning).toBe(true)
      useCreateStore.getState().setComfyRunning(false)
      expect(useCreateStore.getState().comfyRunning).toBe(false)
    })

    // Pathological-state regression: reproduce @phantomderp's crash from
    // multiple angles. The defensive `Array.isArray` guard in
    // CreateTopControls is the real fix, but the store APIs must keep
    // returning *something* when setState is called with garbage. These
    // tests document the contract: the store does not throw, and its
    // CONSUMERS (which this mirrors) can always fall back to [].
    describe('activeList fallback contract (mirrors CreateTopControls)', () => {
      const computeActiveList = (mode: string, iml: unknown, vml: unknown): unknown[] => {
        const raw = mode === 'image' ? iml : vml
        return Array.isArray(raw) ? raw : []
      }

      /**
       * Write a value the store's own type forbids. That is the point of this
       * block: `imageModelList` is declared as an array, and these tests exist
       * because a rehydrated blob from an older build has arrived as
       * undefined / null / an object / a string. The store type says what the
       * app WRITES; the cast is confined to this one helper so no individual
       * test claims a corrupt value is a model list.
       */
      const forceState = (patch: Record<string, unknown>) =>
        useCreateStore.setState(patch as Partial<ReturnType<typeof useCreateStore.getState>>)

      it('falls back to [] when imageModelList is undefined', () => {
        forceState({ imageModelList: undefined, mode: 'image' })
        const s = useCreateStore.getState()
        expect(computeActiveList(s.mode, s.imageModelList, s.videoModelList)).toEqual([])
      })

      it('falls back to [] when videoModelList is undefined in video mode', () => {
        forceState({ videoModelList: undefined, mode: 'video' })
        const s = useCreateStore.getState()
        expect(computeActiveList(s.mode, s.imageModelList, s.videoModelList)).toEqual([])
      })

      it('falls back to [] when the list is null', () => {
        forceState({ imageModelList: null, mode: 'image' })
        const s = useCreateStore.getState()
        expect(computeActiveList(s.mode, s.imageModelList, s.videoModelList)).toEqual([])
      })

      it('falls back to [] when the list is an object', () => {
        forceState({ imageModelList: { foo: 'bar' }, mode: 'image' })
        const s = useCreateStore.getState()
        expect(computeActiveList(s.mode, s.imageModelList, s.videoModelList)).toEqual([])
      })

      it('falls back to [] when the list is a string', () => {
        forceState({ imageModelList: 'corrupted', mode: 'image' })
        const s = useCreateStore.getState()
        expect(computeActiveList(s.mode, s.imageModelList, s.videoModelList)).toEqual([])
      })

      it('passes through a real populated list unchanged', () => {
        const list = [{ name: 'flux.safetensors', type: 'flux' as const, source: 'checkpoint' as const }]
        useCreateStore.setState({ imageModelList: list, mode: 'image' })
        const s = useCreateStore.getState()
        expect(computeActiveList(s.mode, s.imageModelList, s.videoModelList)).toBe(list)
      })

      it('.length and .map never throw on the fallback', () => {
        forceState({ imageModelList: undefined, videoModelList: null })
        const s = useCreateStore.getState()
        const imgList = computeActiveList('image', s.imageModelList, s.videoModelList)
        const vidList = computeActiveList('video', s.imageModelList, s.videoModelList)
        // These are the exact two operations CreateTopControls performs
        // (line 175 `.length === 0` and line 180 `.map(...)`).
        expect(() => imgList.length === 0).not.toThrow()
        expect(() => imgList.map((m) => prop(m, 'name'))).not.toThrow()
        expect(() => vidList.length === 0).not.toThrow()
        expect(() => vidList.map((m) => prop(m, 'name'))).not.toThrow()
      })
    })
  })

  // ── setSteps ───────────────────────────────────────────────

  describe('setSteps', () => {
    it('sets steps to a valid value', () => {
      useCreateStore.getState().setSteps(30)
      expect(useCreateStore.getState().steps).toBe(30)
    })

    it('clamps steps to minimum of 1', () => {
      useCreateStore.getState().setSteps(0)
      expect(useCreateStore.getState().steps).toBe(1)
    })

    it('clamps negative steps to 1', () => {
      useCreateStore.getState().setSteps(-10)
      expect(useCreateStore.getState().steps).toBe(1)
    })

    it('clamps steps to maximum of 200', () => {
      useCreateStore.getState().setSteps(999)
      expect(useCreateStore.getState().steps).toBe(200)
    })

    it('floors fractional values', () => {
      useCreateStore.getState().setSteps(15.7)
      expect(useCreateStore.getState().steps).toBe(15)
    })
  })

  // ── setCfgScale ────────────────────────────────────────────

  describe('setCfgScale', () => {
    it('sets cfgScale to a valid value', () => {
      useCreateStore.getState().setCfgScale(5.5)
      expect(useCreateStore.getState().cfgScale).toBe(5.5)
    })

    it('clamps cfgScale to minimum of 0', () => {
      useCreateStore.getState().setCfgScale(-3)
      expect(useCreateStore.getState().cfgScale).toBe(0)
    })

    it('clamps cfgScale to maximum of 30', () => {
      useCreateStore.getState().setCfgScale(50)
      expect(useCreateStore.getState().cfgScale).toBe(30)
    })

    it('allows zero', () => {
      useCreateStore.getState().setCfgScale(0)
      expect(useCreateStore.getState().cfgScale).toBe(0)
    })

    it('preserves decimal precision', () => {
      useCreateStore.getState().setCfgScale(3.14)
      expect(useCreateStore.getState().cfgScale).toBe(3.14)
    })
  })

  // ── setSize ────────────────────────────────────────────────

  describe('setSize', () => {
    it('sets width and height to valid values', () => {
      useCreateStore.getState().setSize(512, 768)
      expect(useCreateStore.getState().width).toBe(512)
      expect(useCreateStore.getState().height).toBe(768)
    })

    it('clamps width to minimum of 64', () => {
      useCreateStore.getState().setSize(10, 512)
      expect(useCreateStore.getState().width).toBe(64)
    })

    it('clamps height to minimum of 64', () => {
      useCreateStore.getState().setSize(512, 10)
      expect(useCreateStore.getState().height).toBe(64)
    })

    it('clamps width to maximum of 4096', () => {
      useCreateStore.getState().setSize(8000, 512)
      expect(useCreateStore.getState().width).toBe(4096)
    })

    it('clamps height to maximum of 4096', () => {
      useCreateStore.getState().setSize(512, 8000)
      expect(useCreateStore.getState().height).toBe(4096)
    })

    it('floors fractional values', () => {
      useCreateStore.getState().setSize(512.9, 768.1)
      expect(useCreateStore.getState().width).toBe(512)
      expect(useCreateStore.getState().height).toBe(768)
    })
  })

  // ── setBatchSize ───────────────────────────────────────────

  describe('setBatchSize', () => {
    it('sets batch size to a valid value', () => {
      useCreateStore.getState().setBatchSize(4)
      expect(useCreateStore.getState().batchSize).toBe(4)
    })

    it('clamps to minimum of 1', () => {
      useCreateStore.getState().setBatchSize(0)
      expect(useCreateStore.getState().batchSize).toBe(1)
    })

    it('clamps to maximum of 8', () => {
      useCreateStore.getState().setBatchSize(20)
      expect(useCreateStore.getState().batchSize).toBe(8)
    })

    it('floors fractional values', () => {
      useCreateStore.getState().setBatchSize(3.7)
      expect(useCreateStore.getState().batchSize).toBe(3)
    })
  })

  // ── setFrames ──────────────────────────────────────────────

  describe('setFrames', () => {
    it('sets frames to a valid value', () => {
      useCreateStore.getState().setFrames(49)
      expect(useCreateStore.getState().frames).toBe(49)
    })

    it('clamps to minimum of 1', () => {
      useCreateStore.getState().setFrames(0)
      expect(useCreateStore.getState().frames).toBe(1)
    })

    it('clamps to maximum of 120', () => {
      useCreateStore.getState().setFrames(200)
      expect(useCreateStore.getState().frames).toBe(120)
    })

    it('floors fractional values', () => {
      useCreateStore.getState().setFrames(24.9)
      expect(useCreateStore.getState().frames).toBe(24)
    })
  })

  // ── setFps ─────────────────────────────────────────────────

  describe('setFps', () => {
    it('sets fps to a valid value', () => {
      useCreateStore.getState().setFps(30)
      expect(useCreateStore.getState().fps).toBe(30)
    })

    it('clamps to minimum of 1', () => {
      useCreateStore.getState().setFps(0)
      expect(useCreateStore.getState().fps).toBe(1)
    })

    it('clamps to maximum of 60', () => {
      useCreateStore.getState().setFps(120)
      expect(useCreateStore.getState().fps).toBe(60)
    })

    it('floors fractional values', () => {
      useCreateStore.getState().setFps(24.5)
      expect(useCreateStore.getState().fps).toBe(24)
    })
  })

  // ── setDenoise ─────────────────────────────────────────────

  describe('setDenoise', () => {
    it('sets denoise to a valid value', () => {
      useCreateStore.getState().setDenoise(0.5)
      expect(useCreateStore.getState().denoise).toBe(0.5)
    })

    it('clamps to minimum of 0', () => {
      useCreateStore.getState().setDenoise(-0.5)
      expect(useCreateStore.getState().denoise).toBe(0)
    })

    it('clamps to maximum of 1', () => {
      useCreateStore.getState().setDenoise(1.5)
      expect(useCreateStore.getState().denoise).toBe(1)
    })

    it('allows exact boundaries 0 and 1', () => {
      useCreateStore.getState().setDenoise(0)
      expect(useCreateStore.getState().denoise).toBe(0)
      useCreateStore.getState().setDenoise(1)
      expect(useCreateStore.getState().denoise).toBe(1)
    })
  })

  // ── addToGallery ───────────────────────────────────────────

  describe('addToGallery', () => {
    it('prepends a new gallery item', () => {
      useCreateStore.getState().addToGallery(makeGalleryItem('a'))
      useCreateStore.getState().addToGallery(makeGalleryItem('b'))
      const gallery = useCreateStore.getState().gallery
      expect(gallery).toHaveLength(2)
      expect(gallery[0].id).toBe('b')
      expect(gallery[1].id).toBe('a')
    })

    it('caps at 200 items', () => {
      for (let i = 0; i < 205; i++) {
        useCreateStore.getState().addToGallery(makeGalleryItem(`item-${i}`))
      }
      expect(useCreateStore.getState().gallery).toHaveLength(200)
      // Most recent is first
      expect(useCreateStore.getState().gallery[0].id).toBe('item-204')
    })

    it('removes oldest items when exceeding 200', () => {
      for (let i = 0; i < 201; i++) {
        useCreateStore.getState().addToGallery(makeGalleryItem(`item-${i}`))
      }
      const gallery = useCreateStore.getState().gallery
      expect(gallery).toHaveLength(200)
      // item-0 (oldest) should be gone
      expect(gallery.find(g => g.id === 'item-0')).toBeUndefined()
      // item-200 (newest) should be first
      expect(gallery[0].id).toBe('item-200')
    })
  })

  // ── updateGalleryItem ──────────────────────────────────────

  describe('updateGalleryItem', () => {
    it('patches the matching item in place', () => {
      useCreateStore.getState().addToGallery(makeGalleryItem('a'))
      useCreateStore.getState().addToGallery(makeGalleryItem('b'))
      useCreateStore.getState().updateGalleryItem('a', { remoteUrl: 'https://signed/new' })
      const gallery = useCreateStore.getState().gallery
      expect(gallery.find(g => g.id === 'a')?.remoteUrl).toBe('https://signed/new')
      expect(gallery.find(g => g.id === 'b')?.remoteUrl).toBeUndefined()
      expect(gallery).toHaveLength(2)
    })

    it('does nothing when id does not exist', () => {
      useCreateStore.getState().addToGallery(makeGalleryItem('a'))
      useCreateStore.getState().updateGalleryItem('nope', { remoteUrl: 'x' })
      expect(useCreateStore.getState().gallery[0].remoteUrl).toBeUndefined()
    })
  })

  // ── persistence: media bytes never hit localStorage ────────

  describe('partialize', () => {
    it('strips dataUrl from persisted gallery items, keeps remoteUrl + jobId', () => {
      useCreateStore.getState().addToGallery({
        ...makeGalleryItem('a'),
        dataUrl: 'data:image/png;base64,AAAA',
        remoteUrl: 'https://signed/a',
        jobId: 'job-a',
      })
      const { partialize } = useCreateStore.persist.getOptions()
      const persisted = partialize!(useCreateStore.getState()) as {
        gallery: Array<Record<string, unknown>>
      }
      expect(persisted.gallery[0].dataUrl).toBeUndefined()
      expect(persisted.gallery[0].remoteUrl).toBe('https://signed/a')
      expect(persisted.gallery[0].jobId).toBe('job-a')
      // in-memory item keeps its dataUrl for the current session
      expect(useCreateStore.getState().gallery[0].dataUrl).toBe('data:image/png;base64,AAAA')
    })
  })

  // ── removeFromGallery / clearGallery ───────────────────────

  describe('removeFromGallery', () => {
    it('removes a specific item by id', () => {
      useCreateStore.getState().addToGallery(makeGalleryItem('a'))
      useCreateStore.getState().addToGallery(makeGalleryItem('b'))
      useCreateStore.getState().removeFromGallery('a')
      const gallery = useCreateStore.getState().gallery
      expect(gallery).toHaveLength(1)
      expect(gallery[0].id).toBe('b')
    })

    it('does nothing when id does not exist', () => {
      useCreateStore.getState().addToGallery(makeGalleryItem('a'))
      useCreateStore.getState().removeFromGallery('nonexistent')
      expect(useCreateStore.getState().gallery).toHaveLength(1)
    })
  })

  describe('clearGallery', () => {
    it('removes all gallery items', () => {
      useCreateStore.getState().addToGallery(makeGalleryItem('a'))
      useCreateStore.getState().addToGallery(makeGalleryItem('b'))
      useCreateStore.getState().clearGallery()
      expect(useCreateStore.getState().gallery).toEqual([])
    })
  })

  // ── addToPromptHistory ─────────────────────────────────────

  describe('addToPromptHistory', () => {
    it('adds a prompt to history', () => {
      useCreateStore.getState().addToPromptHistory('a beautiful sunset')
      expect(useCreateStore.getState().promptHistory).toEqual(['a beautiful sunset'])
    })

    it('deduplicates — moves duplicate to front', () => {
      useCreateStore.getState().addToPromptHistory('first')
      useCreateStore.getState().addToPromptHistory('second')
      useCreateStore.getState().addToPromptHistory('first')
      const history = useCreateStore.getState().promptHistory
      expect(history).toEqual(['first', 'second'])
    })

    it('caps at 50 entries', () => {
      for (let i = 0; i < 55; i++) {
        useCreateStore.getState().addToPromptHistory(`prompt-${i}`)
      }
      expect(useCreateStore.getState().promptHistory).toHaveLength(50)
      expect(useCreateStore.getState().promptHistory[0]).toBe('prompt-54')
    })

    it('keeps newest entries when exceeding cap', () => {
      for (let i = 0; i < 55; i++) {
        useCreateStore.getState().addToPromptHistory(`prompt-${i}`)
      }
      // oldest 5 (0-4) dropped
      expect(useCreateStore.getState().promptHistory).not.toContain('prompt-0')
      expect(useCreateStore.getState().promptHistory).toContain('prompt-54')
    })
  })

  // ── removeFromPromptHistory / clearPromptHistory (A10) ─────
  //
  // Bug A10 (pardy22, Discord #general + #help-18): the prompt history could
  // not be deleted. The store had no action for it at all, so no button could
  // have worked. These four claims pin the two new actions plus the persisted
  // copy, which is what made the entries come back after a restart.

  describe('removeFromPromptHistory', () => {
    it('drops exactly the one entry', () => {
      useCreateStore.getState().addToPromptHistory('keep me')
      useCreateStore.getState().addToPromptHistory('delete me')
      useCreateStore.getState().removeFromPromptHistory('delete me')
      expect(useCreateStore.getState().promptHistory).toEqual(['keep me'])
    })

    // Negative control: an unknown prompt must not eat the list.
    it('leaves the list alone when the prompt is not in it', () => {
      useCreateStore.getState().addToPromptHistory('a')
      useCreateStore.getState().addToPromptHistory('b')
      useCreateStore.getState().removeFromPromptHistory('never added')
      expect(useCreateStore.getState().promptHistory).toEqual(['b', 'a'])
    })
  })

  describe('clearPromptHistory', () => {
    it('empties the history', () => {
      useCreateStore.getState().addToPromptHistory('a')
      useCreateStore.getState().addToPromptHistory('b')
      useCreateStore.getState().clearPromptHistory()
      expect(useCreateStore.getState().promptHistory).toEqual([])
    })

    // Negative control: clearing the prompts must not touch the gallery.
    it('does not touch the gallery', () => {
      useCreateStore.getState().addToGallery(makeGalleryItem('a'))
      useCreateStore.getState().addToPromptHistory('a')
      useCreateStore.getState().clearPromptHistory()
      expect(useCreateStore.getState().gallery).toHaveLength(1)
    })
  })

  describe('prompt history persistence', () => {
    const persisted = () => {
      const raw = localStorage.getItem('create-store')
      return raw ? (JSON.parse(raw).state as { promptHistory?: string[] }) : null
    }

    it('writes the surviving entries to localStorage, so nothing returns after a restart', () => {
      useCreateStore.getState().addToPromptHistory('keep me')
      useCreateStore.getState().addToPromptHistory('delete me')
      // Guard: without this the assertions below could pass on an empty store.
      expect(persisted()?.promptHistory).toEqual(['delete me', 'keep me'])

      useCreateStore.getState().removeFromPromptHistory('delete me')
      expect(persisted()?.promptHistory).toEqual(['keep me'])

      useCreateStore.getState().clearPromptHistory()
      expect(persisted()?.promptHistory).toEqual([])
    })
  })

  // ── setIsGenerating ────────────────────────────────────────

  describe('setIsGenerating', () => {
    it('sets generating to true without resetting progressPhase', () => {
      useCreateStore.setState({ progressPhase: 'sampling' })
      useCreateStore.getState().setIsGenerating(true)
      expect(useCreateStore.getState().isGenerating).toBe(true)
      expect(useCreateStore.getState().progressPhase).toBe('sampling')
    })

    it('resets progressPhase to idle when set to false', () => {
      useCreateStore.setState({ progressPhase: 'sampling', isGenerating: true })
      useCreateStore.getState().setIsGenerating(false)
      expect(useCreateStore.getState().isGenerating).toBe(false)
      expect(useCreateStore.getState().progressPhase).toBe('idle')
    })
  })

  // ── setMode ────────────────────────────────────────────────

  describe('setMode', () => {
    it('switches to video mode and applies video model defaults', () => {
      useCreateStore.setState({ videoModel: 'wan-model' })
      useCreateStore.getState().setMode('video')
      const state = useCreateStore.getState()
      expect(state.mode).toBe('video')
      expect(state.steps).toBe(MODEL_TYPE_DEFAULTS.wan.steps)
      expect(state.cfgScale).toBe(MODEL_TYPE_DEFAULTS.wan.cfgScale)
      expect(state.width).toBe(MODEL_TYPE_DEFAULTS.wan.width)
      expect(state.height).toBe(MODEL_TYPE_DEFAULTS.wan.height)
      expect(state.frames).toBe(MODEL_TYPE_DEFAULTS.wan.frames)
    })

    it('switches to image mode and applies image model defaults', () => {
      useCreateStore.setState({ imageModel: 'sdxl-model', imageModelType: 'sdxl' })
      useCreateStore.getState().setMode('image')
      const state = useCreateStore.getState()
      expect(state.mode).toBe('image')
      expect(state.steps).toBe(MODEL_TYPE_DEFAULTS.sdxl.steps)
      expect(state.cfgScale).toBe(MODEL_TYPE_DEFAULTS.sdxl.cfgScale)
      expect(state.width).toBe(MODEL_TYPE_DEFAULTS.sdxl.width)
    })

    it('only sets mode when no model is set', () => {
      useCreateStore.setState({ videoModel: '', steps: 99 })
      useCreateStore.getState().setMode('video')
      expect(useCreateStore.getState().mode).toBe('video')
      // steps should remain since no videoModel to classify
      expect(useCreateStore.getState().steps).toBe(99)
    })
  })

  // ── setImageModel ──────────────────────────────────────────

  describe('setImageModel', () => {
    it('sets model, type, and applies MODEL_TYPE_DEFAULTS for flux', () => {
      useCreateStore.getState().setImageModel('flux-model.safetensors', 'flux')
      const state = useCreateStore.getState()
      expect(state.imageModel).toBe('flux-model.safetensors')
      expect(state.imageModelType).toBe('flux')
      expect(state.steps).toBe(MODEL_TYPE_DEFAULTS.flux.steps)
      expect(state.cfgScale).toBe(MODEL_TYPE_DEFAULTS.flux.cfgScale)
      expect(state.sampler).toBe(MODEL_TYPE_DEFAULTS.flux.sampler)
      expect(state.scheduler).toBe(MODEL_TYPE_DEFAULTS.flux.scheduler)
      expect(state.width).toBe(MODEL_TYPE_DEFAULTS.flux.width)
      expect(state.height).toBe(MODEL_TYPE_DEFAULTS.flux.height)
    })

    it('applies sd15 defaults correctly', () => {
      useCreateStore.getState().setImageModel('v1-5-pruned.safetensors', 'sd15')
      const state = useCreateStore.getState()
      expect(state.steps).toBe(25)
      expect(state.cfgScale).toBe(7.0)
      expect(state.width).toBe(512)
      expect(state.height).toBe(512)
    })

    it('applies zimage defaults correctly', () => {
      useCreateStore.getState().setImageModel('zimage-turbo.safetensors', 'zimage')
      const state = useCreateStore.getState()
      expect(state.steps).toBe(12)
      expect(state.cfgScale).toBe(3.5)
    })
  })

  // ── Simple setters ─────────────────────────────────────────

  describe('simple setters', () => {
    it('setPrompt updates prompt', () => {
      useCreateStore.getState().setPrompt('a cat')
      expect(useCreateStore.getState().prompt).toBe('a cat')
    })

    it('setNegativePrompt updates negativePrompt', () => {
      useCreateStore.getState().setNegativePrompt('blurry')
      expect(useCreateStore.getState().negativePrompt).toBe('blurry')
    })

    it('setSampler updates sampler', () => {
      useCreateStore.getState().setSampler('dpmpp_2m')
      expect(useCreateStore.getState().sampler).toBe('dpmpp_2m')
    })

    it('setScheduler updates scheduler', () => {
      useCreateStore.getState().setScheduler('karras')
      expect(useCreateStore.getState().scheduler).toBe('karras')
    })

    it('setSeed floors the value', () => {
      useCreateStore.getState().setSeed(42.9)
      expect(useCreateStore.getState().seed).toBe(42)
    })

    it('setI2iImage sets and clears image', () => {
      useCreateStore.getState().setI2iImage('upload.png')
      expect(useCreateStore.getState().i2iImage).toBe('upload.png')
      useCreateStore.getState().setI2iImage(null)
      expect(useCreateStore.getState().i2iImage).toBeNull()
    })

    it('setI2vImage sets and clears image', () => {
      useCreateStore.getState().setI2vImage('video-input.png')
      expect(useCreateStore.getState().i2vImage).toBe('video-input.png')
      useCreateStore.getState().setI2vImage(null)
      expect(useCreateStore.getState().i2vImage).toBeNull()
    })

    it('setImageSubMode switches sub-mode', () => {
      useCreateStore.getState().setImageSubMode('img2img')
      expect(useCreateStore.getState().imageSubMode).toBe('img2img')
    })

    it('setError sets and clears error', () => {
      useCreateStore.getState().setError('something broke')
      expect(useCreateStore.getState().error).toBe('something broke')
      useCreateStore.getState().setError(null)
      expect(useCreateStore.getState().error).toBeNull()
    })

    it('setProgress sets progress and text', () => {
      useCreateStore.getState().setProgress(50, 'Sampling...')
      expect(useCreateStore.getState().progress).toBe(50)
      expect(useCreateStore.getState().progressText).toBe('Sampling...')
    })

    it('setProgress defaults text to empty string', () => {
      useCreateStore.getState().setProgress(25)
      expect(useCreateStore.getState().progressText).toBe('')
    })
  })

  // David 2026-07-10: edit/animate/upscale/eraser are cloud-only — flipping
  // the backend to local must clear every cloud-only intent (the IntentBar no
  // longer shows them) so the surface never strands on a hidden op.
  describe('setBackend local-flip clears cloud-only intents', () => {
    const ref = { filename: 'src.png', url: 'data:image/png;base64,x', width: 8, height: 8 }

    it('clears a utility op (upscale) with its mask', () => {
      const s = useCreateStore.getState()
      s.setBackend('cloud')
      s.setIntent('upscale')
      s.setSource(ref)
      useCreateStore.getState().setBackend('local')
      const after = useCreateStore.getState()
      expect(after.utilityOp).toBeNull()
      expect(after.intent()).not.toBe('upscale')
    })

    it('keeps edit — it has a local lane via checkpoint inpaint (2.5.7)', () => {
      const s = useCreateStore.getState()
      s.setBackend('cloud')
      s.setIntent('edit')
      s.setSource(ref)
      useCreateStore.getState().setBackend('local')
      const after = useCreateStore.getState()
      expect(after.intent()).toBe('edit')
      expect(after.source).not.toBeNull()
    })

    it('keeps animate — its local I2V lane is back (2026-07-17)', () => {
      // The lu-labs port cleared i2v on every local flip ("no local lane");
      // with the lane restored, a cloud → local switch must keep the user's
      // animate setup (sub-mode AND source) exactly like edit/removebg do.
      const s = useCreateStore.getState()
      s.setBackend('cloud')
      s.setIntent('animate')
      s.setSource(ref)
      useCreateStore.getState().setBackend('local')
      const after = useCreateStore.getState()
      expect(after.videoSubMode).toBe('i2v')
      expect(after.source).not.toBeNull()
      expect(after.intent()).toBe('animate')
    })

    it('keeps removebg — it has a local lane via the RMBG node', () => {
      const s = useCreateStore.getState()
      s.setBackend('cloud')
      s.setIntent('removebg')
      s.setSource(ref)
      useCreateStore.getState().setBackend('local')
      const after = useCreateStore.getState()
      expect(after.intent()).toBe('removebg')
      expect(after.source).not.toBeNull()
    })

    it('keeps character since 2.6.0 ships the local musubi trainer lane', () => {
      const s = useCreateStore.getState()
      s.setBackend('cloud')
      s.setIntent('character')
      useCreateStore.getState().setBackend('local')
      const after = useCreateStore.getState()
      expect(after.cloudOp).toBe('character')
      expect(after.intent()).toBe('character')
    })

    it('keeps motion — its DWPose + VACE local lane shipped in 2.5.8', () => {
      const s = useCreateStore.getState()
      s.setBackend('cloud')
      s.setIntent('motion')
      useCreateStore.getState().setBackend('local')
      const after = useCreateStore.getState()
      expect(after.cloudOp).toBe('motion')
      expect(after.intent()).toBe('motion')
    })

    it('flipping to cloud never resets anything', () => {
      const s = useCreateStore.getState()
      s.setBackend('local')
      s.setIntent('removebg')
      s.setSource(ref)
      useCreateStore.getState().setBackend('cloud')
      expect(useCreateStore.getState().intent()).toBe('removebg')
      expect(useCreateStore.getState().source).not.toBeNull()
    })
  })
})
