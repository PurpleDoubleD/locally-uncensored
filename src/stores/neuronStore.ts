import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import { clampStrength, modelProfileKey, personaProfileKey, type Profiles, type Strengths } from '../lib/neuron'

/**
 * The Neuron tweaker's slider values (3.0.9, P11), saved per model and,
 * when someone chooses so, per model and persona.
 *
 * The vectors themselves live on disk in Rust's neuron folder; what the
 * engine runs with right now is Rust's too (active.json). This store only
 * remembers where each slider was, so a persona switch can bring its own
 * settings back.
 */
interface NeuronState {
  profiles: Profiles
  /** Which profile the panel edits for a model: the model's own, or the
   *  active persona's. Keyed by model key. */
  scopeByModel: Record<string, 'model' | 'persona'>
  setStrength: (key: string, id: string, value: number) => void
  setProfile: (key: string, strengths: Strengths) => void
  removeProfile: (key: string) => void
  removeSlider: (modelKey: string, id: string) => void
  setScope: (modelKey: string, scope: 'model' | 'persona') => void
}

export const useNeuronStore = create<NeuronState>()(
  persist(
    (set) => ({
      profiles: {},
      scopeByModel: {},
      setStrength: (key, id, value) =>
        set((s) => ({ profiles: { ...s.profiles, [key]: { ...(s.profiles[key] ?? {}), [id]: clampStrength(value) } } })),
      setProfile: (key, strengths) => set((s) => ({ profiles: { ...s.profiles, [key]: strengths } })),
      removeProfile: (key) =>
        set((s) => {
          const next = { ...s.profiles }
          delete next[key]
          return { profiles: next }
        }),
      removeSlider: (modelKey, id) =>
        set((s) => {
          const next: Profiles = {}
          for (const [k, v] of Object.entries(s.profiles)) {
            if (k === modelKey || k.startsWith(`${modelKey}::persona:`)) {
              const { [id]: _gone, ...rest } = v
              next[k] = rest
            } else next[k] = v
          }
          return { profiles: next }
        }),
      setScope: (modelKey, scope) => set((s) => ({ scopeByModel: { ...s.scopeByModel, [modelKey]: scope } })),
    }),
    { name: 'lu-neuron-tweaker', storage: safeJSONStorage() },
  ),
)

/** The profile key the panel edits for this model and persona. */
export function editingKey(modelKey: string, personaId: string, scope: 'model' | 'persona'): string {
  return scope === 'persona' ? personaProfileKey(modelKey, personaId) : modelProfileKey(modelKey)
}
