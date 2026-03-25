import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ModelType } from '../api/comfyui'

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
}

interface CreateState {
  mode: 'image' | 'video'
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
  isGenerating: boolean
  progress: number
  progressText: string
  currentPromptId: string | null
  error: string | null
  gallery: GalleryItem[]
  promptHistory: string[]

  setMode: (mode: 'image' | 'video') => void
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
  setIsGenerating: (generating: boolean) => void
  setProgress: (progress: number, text?: string) => void
  setCurrentPromptId: (id: string | null) => void
  setError: (error: string | null) => void
  addToGallery: (item: GalleryItem) => void
  removeFromGallery: (id: string) => void
  clearGallery: () => void
  addToPromptHistory: (prompt: string) => void
}

export const useCreateStore = create<CreateState>()(
  persist(
    (set) => ({
      mode: 'image',
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
      isGenerating: false,
      progress: 0,
      progressText: '',
      currentPromptId: null,
      error: null,
      gallery: [],
      promptHistory: [],

      setMode: (mode) => set({ mode }),
      setPrompt: (prompt) => set({ prompt }),
      setNegativePrompt: (negativePrompt) => set({ negativePrompt }),
      setImageModel: (model, type) => set({ imageModel: model, imageModelType: type }),
      setVideoModel: (model) => set({ videoModel: model }),
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
      setIsGenerating: (generating) => set({ isGenerating: generating }),
      setProgress: (progress, text) => set({ progress, progressText: text ?? '' }),
      setCurrentPromptId: (id) => set({ currentPromptId: id }),
      setError: (error) => set({ error }),
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
        gallery: state.gallery,
        promptHistory: state.promptHistory,
      }),
    }
  )
)
