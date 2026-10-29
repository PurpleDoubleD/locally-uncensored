import { useEffect } from 'react'
import { bundledEngineStatus } from '../api/engine'
import { neuronApply, neuronInfo } from '../api/neuron'
import { entriesFor, effectiveStrengths, hasPersonaProfile, steeringPersona } from '../lib/neuron'
import { useChatStore } from '../stores/chatStore'
import { useNeuronStore } from '../stores/neuronStore'
import { useSettingsStore } from '../stores/settingsStore'

/**
 * A persona can carry its own Neuron tweaker sliders for a model (3.0.9,
 * P11). When the persona that steers (lib/neuron `steeringPersona`: the open
 * chat's own, or the app wide pick) changes and either the old or the new
 * one has its own, the engine is restarted with the new persona's sliders.
 * When neither has, the model's sliders stay and nothing restarts.
 */
export async function followPersona(prevId: string | null, nextId: string | null): Promise<boolean> {
  const status = await bundledEngineStatus().catch(() => null)
  const modelPath = status?.running ? status.model_path : null
  if (!modelPath) return false
  const info = await neuronInfo(modelPath).catch(() => null)
  if (!info) return false
  const { profiles } = useNeuronStore.getState()
  const own = (id: string | null) => !!id && hasPersonaProfile(profiles, info.modelKey, id)
  if (!own(prevId) && !own(nextId)) return false
  const available = new Set(info.vectors.map((v) => v.id))
  const entries = entriesFor(effectiveStrengths(profiles, info.modelKey, nextId), available)
  await neuronApply(modelPath, entries, useSettingsStore.getState().settings.builtinEngine)
  return true
}

/** The steering persona right now, from the chat and settings stores. */
export function currentSteeringPersona(): { id: string | null; group: boolean } {
  const s = useSettingsStore.getState()
  return steeringPersona(useChatStore.getState().getActiveConversation(), s.personas, s.activePersonaId, s.settings.personasEnabled !== false)
}

export function useNeuronFollowsPersona(): void {
  useEffect(() => {
    let prev = currentSteeringPersona().id
    const check = () => {
      const next = currentSteeringPersona().id
      if (next === prev) return
      const was = prev
      prev = next
      void followPersona(was, next).catch(() => undefined)
    }
    const offSettings = useSettingsStore.subscribe(check)
    const offChat = useChatStore.subscribe(check)
    return () => { offSettings(); offChat() }
  }, [])
}
