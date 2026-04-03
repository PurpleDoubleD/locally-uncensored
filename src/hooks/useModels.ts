import { useCallback } from 'react'
import { listModels, pullModel as pullModelApi, deleteModel as deleteModelApi } from '../api/ollama'
import { getCheckpoints as getComfyCheckpoints, getDiffusionModels as getComfyDiffusionModels, checkComfyConnection } from '../api/comfyui'
import { parseNDJSONStream } from '../api/stream'
import { useModelStore } from '../stores/modelStore'
import { useProviderStore } from '../stores/providerStore'
// useProviderStore also used inline in fetchModels for Ollama-enabled check
import { getEnabledProviders, prefixModelName } from '../api/providers'
import type { PullProgress, AIModel, ModelCategory, ImageModel, VideoModel, CloudModel } from '../types/models'

// Known video model patterns
const VIDEO_PATTERNS = [/wan/, /svd/, /animatediff/, /animate/, /video/, /cogvideo/, /ltx/i]

function isVideoModel(name: string): boolean {
  const lower = name.toLowerCase()
  return VIDEO_PATTERNS.some((p) => p.test(lower))
}

export function useModels() {
  const { models, activeModel, pullProgress, isPulling, categoryFilter, setModels, setActiveModel, setPullProgress, setIsPulling, setCategoryFilter } =
    useModelStore()

  const fetchModels = useCallback(async () => {
    try {
      const allModels: AIModel[] = []

      // ── Fetch from all enabled providers ──────────────────
      const providers = getEnabledProviders()

      const providerResults = await Promise.allSettled(
        providers.map(async (provider) => {
          const providerModels = await provider.listModels()
          return providerModels.map((pm): AIModel => {
            if (pm.provider === 'ollama') {
              // Ollama models keep their original name format (backward compat)
              return {
                name: pm.id,
                model: pm.id,
                size: 0,
                digest: '',
                modified_at: '',
                details: {
                  parent_model: '',
                  format: '',
                  family: '',
                  families: [],
                  parameter_size: '',
                  quantization_level: '',
                },
                type: 'text' as const,
                provider: 'ollama',
                providerName: 'Ollama',
              }
            }

            // Cloud models get prefixed names for disambiguation
            const prefixedName = prefixModelName(pm.provider, pm.id)
            return {
              name: prefixedName,
              model: pm.id,
              size: 0,
              type: 'text' as const,
              provider: pm.provider,
              providerName: pm.providerName,
              contextLength: pm.contextLength,
              supportsTools: pm.supportsTools,
              supportsVision: pm.supportsVision,
            } satisfies CloudModel
          })
        })
      )

      for (const result of providerResults) {
        if (result.status === 'fulfilled') {
          allModels.push(...result.value)
        }
      }

      // Fallback: if Ollama is enabled but provider didn't return models, try direct API
      const ollamaEnabled = useProviderStore.getState().providers.ollama.enabled
      const hasOllamaModels = allModels.some(m => m.provider === 'ollama')
      if (ollamaEnabled && !hasOllamaModels) {
        try {
          const ollamaModels = await listModels()
          allModels.push(...ollamaModels.map(m => ({ ...m, provider: 'ollama' as const, providerName: 'Ollama' })))
        } catch { /* Ollama might not be running */ }
      }

      // ── ComfyUI image/video models (unchanged) ────────────
      let comfyModels: AIModel[] = []
      const comfyOk = await checkComfyConnection()
      if (comfyOk) {
        try {
          const [checkpoints, diffusionModels] = await Promise.all([
            getComfyCheckpoints(),
            getComfyDiffusionModels(),
          ])
          const classifyComfyModel = (name: string): AIModel => {
            if (isVideoModel(name)) {
              return { name, model: name, size: 0, format: 'safetensors', architecture: 'unknown', type: 'video', provider: 'ollama', providerName: 'ComfyUI' } as VideoModel
            }
            return { name, model: name, size: 0, format: 'safetensors', architecture: 'unknown', type: 'image', provider: 'ollama', providerName: 'ComfyUI' } as ImageModel
          }
          comfyModels = [
            ...checkpoints.map((name) => classifyComfyModel(name)),
            ...diffusionModels.map((name) => classifyComfyModel(name)),
          ]
        } catch {
          // ComfyUI model fetch failed, continue without
        }
      }

      setModels([...allModels, ...comfyModels])
    } catch {
      // ignore
    }
  }, [setModels])

  const pullModel = useCallback(
    async (name: string) => {
      setIsPulling(true)
      setPullProgress({ status: 'Starting download...' })
      try {
        const response = await pullModelApi(name)
        for await (const chunk of parseNDJSONStream<PullProgress>(response)) {
          setPullProgress(chunk)
        }
        await fetchModels()
      } catch (err) {
        setPullProgress({ status: `Error: ${(err as Error).message}` })
      } finally {
        setIsPulling(false)
        setTimeout(() => setPullProgress(null), 3000)
      }
    },
    [fetchModels, setIsPulling, setPullProgress]
  )

  const removeModel = useCallback(
    async (name: string) => {
      await deleteModelApi(name)
      await fetchModels()
    },
    [fetchModels]
  )

  // Filter-Helper für UI
  const getFilteredModels = (filter: ModelCategory = categoryFilter) => {
    if (filter === 'all') return models
    return models.filter((m: AIModel) => m.type === filter)
  }

  return { models, activeModel, pullProgress, isPulling, categoryFilter, fetchModels, pullModel, removeModel, setActiveModel, setCategoryFilter, getFilteredModels }
}
