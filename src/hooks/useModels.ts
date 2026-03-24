import { useCallback } from 'react'
import { listModels, pullModel as pullModelApi, deleteModel as deleteModelApi } from '../api/ollama'
import { getCheckpoints as getComfyCheckpoints, checkComfyConnection } from '../api/comfyui'
import { parseNDJSONStream } from '../api/stream'
import { useModelStore } from '../stores/modelStore'
import type { PullProgress, AIModel, ModelCategory, ImageModel, VideoModel } from '../types/models'

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
      // Fetch text models from Ollama
      const ollamaModels = await listModels()

      // Try to fetch image/video models from ComfyUI
      let comfyModels: AIModel[] = []
      const comfyOk = await checkComfyConnection()
      if (comfyOk) {
        try {
          const checkpoints = await getComfyCheckpoints()
          comfyModels = checkpoints.map((name): AIModel => {
            if (isVideoModel(name)) {
              return {
                name,
                model: name,
                size: 0,
                format: 'safetensors',
                architecture: 'unknown',
                type: 'video',
              } as VideoModel
            }
            return {
              name,
              model: name,
              size: 0,
              format: 'safetensors',
              architecture: 'unknown',
              type: 'image',
            } as ImageModel
          })
        } catch {
          // ComfyUI model fetch failed, continue with Ollama only
        }
      }

      setModels([...ollamaModels, ...comfyModels])
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
