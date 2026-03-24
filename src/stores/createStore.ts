import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface GalleryItem {
  id: string
  type: 'image' | 'video'
  filename: string
  subfolder: string
  prompt: string
  negativePrompt: string
  model: string
  seed: number
  steps: number
  cfgScale: number
  width: number
  height: number
  createdAt: number
}

interface CreateState {
  mode: 'image' | 'video'
  prompt: string
  negativePrompt: string
  model: string
  sampler: string
  steps: number
  cfgScale: number
  width: number
  height: number
  seed: number
  frames: number
  fps: number
  isGenerating: boolean
  progress: number
  currentPromptId: string | null
  gallery: GalleryItem[]

  setMode: (mode: 'image' | 'video') => void
  setPrompt: (prompt: string) => void
  setNegativePrompt: (negativePrompt: string) => void
  setModel: (model: string) => void
  setSampler: (sampler: string) => void
  setSteps: (steps: number) => void
  setCfgScale: (cfgScale: number) => void
  setWidth: (width: number) => void
  setHeight: (height: number) => void
  setSeed: (seed: number) => void
  setFrames: (frames: number) => void
  setFps: (fps: number) => void
  setIsGenerating: (generating: boolean) => void
  setProgress: (progress: number) => void
  setCurrentPromptId: (id: string | null) => void
  addToGallery: (item: GalleryItem) => void
  removeFromGallery: (id: string) => void
  clearGallery: () => void
}

export const useCreateStore = create<CreateState>()(
  persist(
    (set) => ({
      mode: 'image',
      prompt: '',
      negativePrompt: '',
      model: '',
      sampler: 'euler',
      steps: 20,
      cfgScale: 7,
      width: 1024,
      height: 1024,
      seed: -1,
      frames: 24,
      fps: 8,
      isGenerating: false,
      progress: 0,
      currentPromptId: null,
      gallery: [],

      setMode: (mode) => set({ mode }),
      setPrompt: (prompt) => set({ prompt }),
      setNegativePrompt: (negativePrompt) => set({ negativePrompt }),
      setModel: (model) => set({ model }),
      setSampler: (sampler) => set({ sampler }),
      setSteps: (steps) => set({ steps }),
      setCfgScale: (cfgScale) => set({ cfgScale }),
      setWidth: (width) => set({ width }),
      setHeight: (height) => set({ height }),
      setSeed: (seed) => set({ seed }),
      setFrames: (frames) => set({ frames }),
      setFps: (fps) => set({ fps }),
      setIsGenerating: (generating) => set({ isGenerating: generating }),
      setProgress: (progress) => set({ progress }),
      setCurrentPromptId: (id) => set({ currentPromptId: id }),
      addToGallery: (item) => set((s) => ({ gallery: [item, ...s.gallery] })),
      removeFromGallery: (id) => set((s) => ({ gallery: s.gallery.filter((g) => g.id !== id) })),
      clearGallery: () => set({ gallery: [] }),
    }),
    {
      name: 'create-store',
      partialize: (state) => ({
        mode: state.mode,
        model: state.model,
        sampler: state.sampler,
        steps: state.steps,
        cfgScale: state.cfgScale,
        width: state.width,
        height: state.height,
        frames: state.frames,
        fps: state.fps,
        gallery: state.gallery,
      }),
    }
  )
)
