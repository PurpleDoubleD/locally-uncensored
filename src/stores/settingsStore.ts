import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Settings, Persona } from '../types/settings'
import { DEFAULT_SETTINGS, BUILT_IN_PERSONAS } from '../lib/constants'

const STORE_VERSION = 2

interface SettingsState {
  settings: Settings
  personas: Persona[]
  activePersonaId: string
  _version: number
  updateSettings: (partial: Partial<Settings>) => void
  resetSettings: () => void
  addPersona: (persona: Persona) => void
  removePersona: (id: string) => void
  updatePersona: (id: string, partial: Partial<Persona>) => void
  setActivePersona: (id: string) => void
  getActivePersona: () => Persona | undefined
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      personas: BUILT_IN_PERSONAS,
      activePersonaId: 'unrestricted',
      _version: STORE_VERSION,

      updateSettings: (partial) =>
        set((state) => ({ settings: { ...state.settings, ...partial } })),

      resetSettings: () => set({ settings: DEFAULT_SETTINGS }),

      addPersona: (persona) =>
        set((state) => ({ personas: [...state.personas, persona] })),

      removePersona: (id) =>
        set((state) => ({
          personas: state.personas.filter((p) => p.id !== id),
          activePersonaId: state.activePersonaId === id ? 'unrestricted' : state.activePersonaId,
        })),

      updatePersona: (id, partial) =>
        set((state) => ({
          personas: state.personas.map((p) => (p.id === id ? { ...p, ...partial } : p)),
        })),

      setActivePersona: (id) => set({ activePersonaId: id }),

      getActivePersona: () => {
        const { personas, activePersonaId } = get()
        return personas.find((p) => p.id === activePersonaId)
      },
    }),
    {
      name: 'chat-settings',
      version: STORE_VERSION,
      migrate: (persisted: any, version: number) => {
        if (version < STORE_VERSION) {
          // Keep user's custom personas, replace built-in ones
          const customPersonas = (persisted.personas || []).filter((p: Persona) => !p.isBuiltIn)
          return {
            ...persisted,
            personas: [...BUILT_IN_PERSONAS, ...customPersonas],
            activePersonaId: persisted.activePersonaId || 'unrestricted',
            _version: STORE_VERSION,
          }
        }
        return persisted
      },
    }
  )
)
