import { useEffect } from 'react'
import { bundledEngineStatus } from '../api/engine'
import { neuronApply, neuronInfo } from '../api/neuron'
import { entriesFor, effectiveStrengths, hasPersonaProfile } from '../lib/neuron'
import { useNeuronStore } from '../stores/neuronStore'
import { useSettingsStore } from '../stores/settingsStore'

/**
 * A persona can carry its own Neuron tweaker sliders for a model (3.0.9,
 * P11). When the persona changes and either the old or the new one has its
 * own, the engine is restarted with the new persona's sliders. When neither
 * has, the model's sliders stay and nothing restarts.
 */
export async function followPersona(prevId: string, nextId: string): Promise<boolean> {
  const status = await bundledEngineStatus().catch(() => null)
  const modelPath = status?.running ? status.model_path : null
  if (!modelPath) return false
  const info = await neuronInfo(modelPath).catch(() => null)
  if (!info) return false
  const { profiles } = useNeuronStore.getState()
  if (!hasPersonaProfile(profiles, info.modelKey, prevId) && !hasPersonaProfile(profiles, info.modelKey, nextId)) return false
  const available = new Set(info.vectors.map((v) => v.id))
  const entries = entriesFor(effectiveStrengths(profiles, info.modelKey, nextId), available)
  await neuronApply(modelPath, entries, useSettingsStore.getState().settings.builtinEngine)
  return true
}

export function useNeuronFollowsPersona(): void {
  useEffect(() => {
    return useSettingsStore.subscribe((state, prev) => {
      if (state.activePersonaId !== prev.activePersonaId) {
        void followPersona(prev.activePersonaId, state.activePersonaId).catch(() => undefined)
      }
    })
  }, [])
}
