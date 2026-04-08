import { useCallback } from 'react'
import { listModels, pullModel as pullModelApi, pullModelTauri, deleteModel as deleteModelApi } from '../api/ollama'
import { isTauri } from '../api/backend'
import { getCheckpoints as getComfyCheckpoints, getDiffusionModels as getComfyDiffusionModels, checkComfyConnection } from '../api/comfyui'
import { parseNDJSONStream } from '../api/stream'
import { useModelStore } from '../stores/modelStore'
import { useProviderStore } from '../stores/providerStore'
import { getEnabledProviders, prefixModelName } from '../api/providers'
import type { PullProgress, AIModel, ModelCategory, ImageModel, VideoModel, CloudModel } from '../types/models'

const VIDEO_PATTERNS = [/wan/, /svd/, /animatediff/, /animate/, /video/, /cogvideo/, /ltx/i]

function isVideoModel(name: string): boolean {
  const lower = name.toLowerCase()
  return VIDEO_PATTERNS.some((p) => p.test(lower))
}

export function useModels() {
  const {
    models, activeModel, activePulls, categoryFilter,
    setModels, setActiveModel, startPull, updatePullProgress,
    pausePull, completePull, dismissPull, setCategoryFilter,
  } = useModelStore()

  const isPulling = Object.keys(activePulls).length > 0

  const fetchModels = useCallback(async () => {
    try {
      const allModels: AIModel[] = []
      const providers = getEnabledProviders()
      const providerResults = await Promise.allSettled(
        providers.map(async (provider) => {
          const providerModels = await provider.listModels()
          return providerModels.map((pm): AIModel => {
            if (pm.provider === 'ollama') {
              return {
                name: pm.id, model: pm.id, size: 0, digest: '', modified_at: '',
                details: { parent_model: '', format: '', family: '', families: [], parameter_size: '', quantization_level: '' },
                type: 'text' as const, provider: 'ollama', providerName: 'Ollama',
              }
            }
            const prefixedName = prefixModelName(pm.provider, pm.id)
            return {
              name: prefixedName, model: pm.id, size: 0, type: 'text' as const,
              provider: pm.provider, providerName: pm.providerName,
              contextLength: pm.contextLength, supportsTools: pm.supportsTools, supportsVision: pm.supportsVision,
            } satisfies CloudModel
          })
        })
      )
      for (const result of providerResults) {
        if (result.status === 'fulfilled') allModels.push(...result.value)
      }
      const ollamaEnabled = useProviderStore.getState().providers.ollama.enabled
      const hasOllamaModels = allModels.some(m => m.provider === 'ollama')
      if (ollamaEnabled && !hasOllamaModels) {
        try {
          const ollamaModels = await listModels()
          allModels.push(...ollamaModels.map(m => ({ ...m, provider: 'ollama' as const, providerName: 'Ollama' })))
        } catch { /* Ollama might not be running */ }
      }
      let comfyModels: AIModel[] = []
      const comfyOk = await checkComfyConnection()
      if (comfyOk) {
        try {
          const [checkpoints, diffusionModels] = await Promise.all([getComfyCheckpoints(), getComfyDiffusionModels()])
          const classifyComfyModel = (name: string): AIModel => {
            if (isVideoModel(name)) return { name, model: name, size: 0, format: 'safetensors', architecture: 'unknown', type: 'video', providerName: 'ComfyUI' } as VideoModel
            return { name, model: name, size: 0, format: 'safetensors', architecture: 'unknown', type: 'image', providerName: 'ComfyUI' } as ImageModel
          }
          comfyModels = [...checkpoints.map(classifyComfyModel), ...diffusionModels.map(classifyComfyModel)]
        } catch { /* continue */ }
      }
      setModels([...allModels, ...comfyModels])
    } catch { /* ignore */ }
  }, [setModels])

  const pullModel = useCallback(
    async (name: string) => {
      const existing = activePulls[name]
      // If already active and not paused, don't restart
      if (existing && !existing.paused && !existing.complete) return

      const controller = new AbortController()
      startPull(name, controller)

      if (isTauri()) {
        const { promise, cancel } = pullModelTauri(name, (progress) => {
          updatePullProgress(name, progress)
        })
        controller.signal.addEventListener('abort', cancel)
        try {
          await promise
          completePull(name)
          try { await fetchModels() } catch { /* model list refresh failed — non-critical */ }
          // Auto-dismiss after 5s
          setTimeout(() => dismissPull(name), 5000)
        } catch {
          // Stream disconnected (pause or error) — card stays visible
        }
        return
      }

      // Dev mode: streaming fetch
      try {
        const response = await pullModelApi(name, controller.signal)
        for await (const chunk of parseNDJSONStream<PullProgress>(response)) {
          updatePullProgress(name, chunk)
        }
        completePull(name)
        try { await fetchModels() } catch { /* non-critical */ }
        setTimeout(() => dismissPull(name), 5000)
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          updatePullProgress(name, { status: `Error: ${(err as Error).message}` })
        }
        // On abort (pause): card stays with "Paused" status
      }
    },
    [activePulls, fetchModels, startPull, updatePullProgress, completePull, dismissPull]
  )

  const isPullingModel = useCallback(
    (name: string) => {
      const pull = activePulls[name]
      return !!pull && !pull.paused && !pull.complete
    },
    [activePulls]
  )

  const removeModel = useCallback(
    async (name: string) => {
      await deleteModelApi(name)
      await fetchModels()
    },
    [fetchModels]
  )

  const getFilteredModels = (filter: ModelCategory = categoryFilter) => {
    if (filter === 'all') return models
    return models.filter((m: AIModel) => m.type === filter)
  }

  return {
    models, activeModel, activePulls, isPulling, categoryFilter,
    fetchModels, pullModel, pausePull, dismissPull,
    removeModel, setActiveModel, setCategoryFilter, getFilteredModels, isPullingModel,
  }
}
