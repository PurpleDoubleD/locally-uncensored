import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  preflightReady: null,
  preflightErrors: [],
  preflightWarnings: [],
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
})
