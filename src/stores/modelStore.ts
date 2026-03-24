import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AIModel, PullProgress, ModelCategory } from '../types/models'

interface ModelState {
  models: AIModel[]
  activeModel: string | null
  pullProgress: PullProgress | null
  isPulling: boolean
  categoryFilter: ModelCategory
  setModels: (models: AIModel[]) => void
  setActiveModel: (name: string) => void
  setPullProgress: (progress: PullProgress | null) => void
  setIsPulling: (pulling: boolean) => void
  setCategoryFilter: (category: ModelCategory) => void
}

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      models: [],
      activeModel: null,
      pullProgress: null,
      isPulling: false,
      categoryFilter: 'all',

      setModels: (models) =>
        set((state) => ({
          models,
          activeModel: state.activeModel || (models.length > 0 ? models[0].name : null),
        })),

      setActiveModel: (name) => set({ activeModel: name }),

      setPullProgress: (progress) => set({ pullProgress: progress }),

      setIsPulling: (pulling) => set({ isPulling: pulling }),

      setCategoryFilter: (category) => set({ categoryFilter: category }),
    }),
    {
      name: 'chat-models',
      partialize: (state) => ({ activeModel: state.activeModel, categoryFilter: state.categoryFilter }),
    }
  )
)
