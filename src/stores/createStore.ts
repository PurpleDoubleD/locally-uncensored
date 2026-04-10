import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ModelType } from '../api/comfyui'
import { classifyModel } from '../api/comfyui'
import type { PreflightError } from '../api/preflight'
// ModelType includes: flux, flux2, zimage, sdxl, sd15, wan, hunyuan, unknown

export type ProgressPhase = 'idle' | 'queued' | 'loading-model' | 'loading-clip' | 'loading-vae' | 'sampling' | 'decoding' | 'complete'

// ─── Optimal defaults per model type (research-backed: Draw Things, Fooocus, ComfyUI) ───

export const MODEL_TYPE_DEFAULTS: Record<ModelType, {
  steps: number; cfgScale: number; sampler: string; scheduler: string
  width: number; height: number; frames?: number; fps?: number
}> = {
  sd15:    { steps: 25, cfgScale: 7.0, sampler: 'euler_ancestral', scheduler: 'normal', width: 512,  height: 512 },
  sdxl:    { steps: 25, cfgScale: 7.0, sampler: 'dpmpp_2m',       scheduler: 'karras', width: 1024, height: 1024 },
  flux:    { steps: 20, cfgScale: 1.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  flux2:   { steps: 20, cfgScale: 1.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  zimage:  { steps: 12, cfgScale: 3.5, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  wan:     { steps: 25, cfgScale: 5.0, sampler: 'euler',           scheduler: 'normal', width: 848,  height: 480, frames: 49, fps: 16 },
  hunyuan: { steps: 30, cfgScale: 6.0, sampler: 'euler',           scheduler: 'normal', width: 848,  height: 480, frames: 45, fps: 15 },
  ltx:     { steps: 20, cfgScale: 1.0, sampler: 'euler',           scheduler: 'simple', width: 768,  height: 512, frames: 97, fps: 24 },
  unknown: { steps: 20, cfgScale: 7.0, sampler: 'euler',           scheduler: 'normal', width: 1024, height: 1024 },
}

export interface GalleryItem {
  id: string
  type: 'image' | 'video'
  filename: string
  subfolder: string
  prompt: string
  negativePrompt: string
  model: string
  modelType: ModelType
  seed: number
  steps: number
  cfgScale: number
  sampler: string
  scheduler: string
  width: number
  height: number
  batchSize: number
  createdAt: number
  builderUsed?: 'dynamic' | 'legacy' | 'custom'
  resolvedVAE?: string
  resolvedCLIP?: string
}

interface CreateState {
  mode: 'image' | 'video'
  imageSubMode: 'text2img' | 'img2img'
  prompt: string
  negativePrompt: string
  imageModel: string
  imageModelType: ModelType
  videoModel: string
  sampler: string
  scheduler: string
  steps: number
  cfgScale: number
  width: number
  height: number
  seed: number
  batchSize: number
  frames: number
  fps: number
  denoise: number  // Denoise strength for I2I (0.0–1.0)
  i2iImage: string | null  // Uploaded image filename for I2I
  i2vImage: string | null  // Uploaded image filename for I2V models (SVD, FramePack)
  isGenerating: boolean
  progress: number
  progressText: string
  progressPhase: ProgressPhase
  currentPromptId: string | null
  error: string | null
  lastGenTime: string | null
  preflightReady: boolean | null
  preflightErrors: PreflightError[]
  preflightWarnings: string[]
  gallery: GalleryItem[]
  promptHistory: string[]

  setPreflightStatus: (ready: boolean | null, errors: PreflightError[], warnings: string[]) => void
  setMode: (mode: 'image' | 'video') => void
  setImageSubMode: (subMode: 'text2img' | 'img2img') => void
  setPrompt: (prompt: string) => void
  setNegativePrompt: (negativePrompt: string) => void
  setImageModel: (model: string, type: ModelType) => void
  setVideoModel: (model: string) => void
  setSampler: (sampler: string) => void
  setScheduler: (scheduler: string) => void
  setSteps: (steps: number) => void
  setCfgScale: (cfgScale: number) => void
  setSize: (width: number, height: number) => void
  setSeed: (seed: number) => void
  setBatchSize: (batchSize: number) => void
  setFrames: (frames: number) => void
  setFps: (fps: number) => void
  setDenoise: (denoise: number) => void
  setI2iImage: (image: string | null) => void
  setI2vImage: (image: string | null) => void
  setIsGenerating: (generating: boolean) => void
  setProgress: (progress: number, text?: string) => void
  setProgressPhase: (phase: ProgressPhase) => void
  setCurrentPromptId: (id: string | null) => void
  setError: (error: string | null) => void
  setLastGenTime: (time: string | null) => void
  addToGallery: (item: GalleryItem) => void
  removeFromGallery: (id: string) => void
  clearGallery: () => void
  addToPromptHistory: (prompt: string) => void
}

export const useCreateStore = create<CreateState>()(
  persist(
    (set) => ({
      mode: 'image',
      imageSubMode: 'text2img' as 'text2img' | 'img2img',
      prompt: '',
      negativePrompt: '',
      imageModel: '',
      imageModelType: 'unknown' as ModelType,
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
      progressPhase: 'idle' as ProgressPhase,
      currentPromptId: null,
      error: null,
      lastGenTime: null,
      preflightReady: null,
      preflightErrors: [],
      preflightWarnings: [],
      gallery: [],
      promptHistory: [],

      setPreflightStatus: (ready, errors, warnings) => set({ preflightReady: ready, preflightErrors: errors, preflightWarnings: warnings }),
      setMode: (mode) => set((state) => {
        // Reset parameters to the correct defaults when switching modes
        // This prevents image resolution (1024x1024) leaking into video mode (causes HTTP 500)
        if (mode === 'video' && state.videoModel) {
          const type = classifyModel(state.videoModel)
          const defaults = MODEL_TYPE_DEFAULTS[type] || MODEL_TYPE_DEFAULTS.unknown
          return {
            mode,
            steps: defaults.steps, cfgScale: defaults.cfgScale,
            sampler: defaults.sampler, scheduler: defaults.scheduler,
            width: defaults.width, height: defaults.height,
            ...(defaults.frames ? { frames: defaults.frames } : {}),
            ...(defaults.fps ? { fps: defaults.fps } : {}),
          }
        }
        if (mode === 'image' && state.imageModel) {
          const defaults = MODEL_TYPE_DEFAULTS[state.imageModelType] || MODEL_TYPE_DEFAULTS.unknown
          return {
            mode,
            steps: defaults.steps, cfgScale: defaults.cfgScale,
            sampler: defaults.sampler, scheduler: defaults.scheduler,
            width: defaults.width, height: defaults.height,
          }
        }
        return { mode }
      }),
      setImageSubMode: (subMode) => set({ imageSubMode: subMode }),
      setPrompt: (prompt) => set({ prompt }),
      setNegativePrompt: (negativePrompt) => set({ negativePrompt }),
      setImageModel: (model, type) => {
        const defaults = MODEL_TYPE_DEFAULTS[type]
        set({
          imageModel: model, imageModelType: type,
          steps: defaults.steps, cfgScale: defaults.cfgScale,
          sampler: defaults.sampler, scheduler: defaults.scheduler,
          width: defaults.width, height: defaults.height,
        })
      },
      setVideoModel: (model) => {
        const type = classifyModel(model)
        const defaults = MODEL_TYPE_DEFAULTS[type] || MODEL_TYPE_DEFAULTS.unknown
        set({
          videoModel: model,
          steps: defaults.steps, cfgScale: defaults.cfgScale,
          sampler: defaults.sampler, scheduler: defaults.scheduler,
          width: defaults.width, height: defaults.height,
          ...(defaults.frames ? { frames: defaults.frames } : {}),
          ...(defaults.fps ? { fps: defaults.fps } : {}),
        })
      },
      setSampler: (sampler) => set({ sampler }),
      setScheduler: (scheduler) => set({ scheduler }),
      setSteps: (steps) => set({ steps: Math.max(1, Math.min(200, Math.floor(steps))) }),
      setCfgScale: (cfgScale) => set({ cfgScale: Math.max(0, Math.min(30, cfgScale)) }),
      setSize: (width, height) => set({
        width: Math.max(64, Math.min(4096, Math.floor(width))),
        height: Math.max(64, Math.min(4096, Math.floor(height))),
      }),
      setSeed: (seed) => set({ seed: Math.floor(seed) }),
      setBatchSize: (batchSize) => set({ batchSize: Math.max(1, Math.min(8, Math.floor(batchSize))) }),
      setFrames: (frames) => set({ frames: Math.max(1, Math.min(120, Math.floor(frames))) }),
      setFps: (fps) => set({ fps: Math.max(1, Math.min(60, Math.floor(fps))) }),
      setDenoise: (denoise) => set({ denoise: Math.max(0, Math.min(1, denoise)) }),
      setI2iImage: (image) => set({ i2iImage: image }),
      setI2vImage: (image) => set({ i2vImage: image }),
      setIsGenerating: (generating) => set({ isGenerating: generating, ...(generating ? {} : { progressPhase: 'idle' as ProgressPhase }) }),
      setProgress: (progress, text) => set({ progress, progressText: text ?? '' }),
      setProgressPhase: (phase) => set({ progressPhase: phase }),
      setCurrentPromptId: (id) => set({ currentPromptId: id }),
      setError: (error) => set({ error }),
      setLastGenTime: (time) => set({ lastGenTime: time }),
      addToGallery: (item) => set((s) => ({ gallery: [item, ...s.gallery].slice(0, 200) })),
      removeFromGallery: (id) => set((s) => ({ gallery: s.gallery.filter((g) => g.id !== id) })),
      clearGallery: () => set({ gallery: [] }),
      addToPromptHistory: (prompt) => set((s) => {
        const filtered = s.promptHistory.filter(p => p !== prompt)
        return { promptHistory: [prompt, ...filtered].slice(0, 50) }
      }),
    }),
    {
      name: 'create-store',
      partialize: (state) => ({
        mode: state.mode,
        imageModel: state.imageModel,
        imageModelType: state.imageModelType,
        videoModel: state.videoModel,
        sampler: state.sampler,
        scheduler: state.scheduler,
        steps: state.steps,
        cfgScale: state.cfgScale,
        width: state.width,
        height: state.height,
        batchSize: state.batchSize,
        frames: state.frames,
        fps: state.fps,
        denoise: state.denoise,
        gallery: state.gallery,
        promptHistory: state.promptHistory,
      }),
      // Migrate old 'i2i' mode to imageSubMode (v2.3.0 refactor)
      merge: (persisted: any, current: any) => {
        const merged = { ...current, ...persisted }
        if (merged.mode === 'i2i') {
          merged.mode = 'image'
          merged.imageSubMode = 'img2img'
        }
        return merged
      },
    }
  )
)
