import { useEffect, useRef } from 'react'
import { bundledEngineStatus, type BundledModel } from '../api/engine'
import { isTauri } from '../api/backend'
import { neuronPluginSet, neuronPluginStatus } from '../api/neuron'
import { preservedSwapCtx } from '../lib/builtin-ctx'
import { useSettingsStore } from '../stores/settingsStore'
import { useNeuronWindow } from '../stores/neuronWindowStore'
import type { BuiltinEngineTuning } from '../types/settings'

/** The tuning a restart uses: the user's, with the context the engine holds
 *  kept the way the chat's own restarts keep it (lib/builtin-ctx). */
export async function restartTuning(model?: BundledModel): Promise<BuiltinEngineTuning | undefined> {
  const tuning = useSettingsStore.getState().settings.builtinEngine
  try {
    const status = await bundledEngineStatus()
    const keep = preservedSwapCtx({
      tuningCtx: tuning?.ctx,
      tuningChosen: tuning?.ctxChosen,
      currentCtx: status?.ctxRequested ?? status?.ctx,
      ctxTrain: model?.ctx_train,
    })
    return keep ? { ...(tuning ?? {}), ctx: keep } as BuiltinEngineTuning : tuning
  } catch {
    return tuning
  }
}

/** Whether the Neurons plugin is on in the settings (3.1.0). */
export function neuronsPluginOn(): boolean {
  return useSettingsStore.getState().settings.neuronsPluginEnabled === true
}

/**
 * Keeps Rust's Neurons switch (commands/neuron `plugin-on`) in step with the
 * Plugins row. Rust decides whether a saved mix reaches the engine; the app
 * only tells it. At start it asks first and speaks only on a difference, so
 * opening LU never restarts a running engine for nothing. Off also closes
 * the window.
 */
export function useNeuronPluginSync(): void {
  const enabled = useSettingsStore((s) => s.settings.neuronsPluginEnabled === true)
  const first = useRef(true)
  useEffect(() => {
    if (!enabled) useNeuronWindow.getState().hide()
    if (!isTauri()) return
    const initial = first.current
    first.current = false
    void (async () => {
      if (initial) {
        const now = await neuronPluginStatus().catch(() => null)
        if (now && now.enabled === enabled) return
      }
      await neuronPluginSet(enabled, await restartTuning())
    })().catch(() => undefined)
  }, [enabled])
}
