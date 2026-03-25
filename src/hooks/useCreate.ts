import { useState, useCallback, useRef, useEffect } from 'react'
import { v4 as uuid } from 'uuid'
import {
  checkComfyConnection,
  getImageModels,
  getVideoModels,
  getSamplers,
  getSchedulers,
  detectVideoBackend,
  cancelGeneration,
  submitWorkflow,
  getHistory,
  buildTxt2ImgWorkflow,
  buildTxt2VidWorkflow,
  type ClassifiedModel,
  type ComfyUIOutput,
  type VideoBackend,
} from '../api/comfyui'
import { useCreateStore, type GalleryItem } from '../stores/createStore'

export function useCreate() {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [imageModels, setImageModels] = useState<ClassifiedModel[]>([])
  const [videoModelsList, setVideoModelsList] = useState<ClassifiedModel[]>([])
  const [samplerList, setSamplerList] = useState<string[]>([])
  const [schedulerList, setSchedulerList] = useState<string[]>([])
  const [videoBackend, setVideoBackend] = useState<VideoBackend>('none')
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const checkConnection = useCallback(async () => {
    const ok = await checkComfyConnection()
    setConnected(ok)
    return ok
  }, [])

  const fetchModels = useCallback(async () => {
    try {
      const [imgModels, vidModels, samplers, schedulers, vBackend] = await Promise.all([
        getImageModels(),
        getVideoModels(),
        getSamplers(),
        getSchedulers(),
        detectVideoBackend(),
      ])
      setImageModels(imgModels)
      setVideoModelsList(vidModels)
      setSamplerList(samplers)
      setSchedulerList(schedulers)
      setVideoBackend(vBackend)
      setModelsLoaded(true)

      // Auto-select first models if none set
      const state = useCreateStore.getState()
      if (imgModels.length > 0 && !state.imageModel) {
        state.setImageModel(imgModels[0].name, imgModels[0].type)
      }
      if (vidModels.length > 0 && !state.videoModel) {
        state.setVideoModel(vidModels[0].name)
      }
    } catch (err) {
      console.error('[useCreate] Failed to fetch models:', err)
    }
  }, [])

  const generate = useCallback(async () => {
    const state = useCreateStore.getState()
    const {
      mode, prompt, negativePrompt, imageModel, imageModelType, videoModel,
      sampler, scheduler, steps, cfgScale, width, height, seed, batchSize, frames, fps,
      setIsGenerating, setProgress, setCurrentPromptId, setError, addToGallery, addToPromptHistory,
    } = state

    setError(null)
    const activeModel = mode === 'image' ? imageModel : videoModel

    if (!prompt.trim()) {
      setError('Please enter a prompt.')
      return
    }
    if (!activeModel) {
      setError(mode === 'image'
        ? 'No image model selected. Add checkpoints or FLUX models to ComfyUI.'
        : 'No video model selected. Install Wan 2.1 or AnimateDiff models.')
      return
    }

    const isRunning = await checkComfyConnection()
    if (!isRunning) {
      setError('ComfyUI is not running. Wait for it to start.')
      return
    }

    setIsGenerating(true)
    setProgress(0, 'Preparing workflow...')
    abortRef.current = new AbortController()

    try {
      const baseParams = { prompt, negativePrompt, model: activeModel, sampler, scheduler, steps, cfgScale, width, height, seed, batchSize }

      let workflow: Record<string, any>
      if (mode === 'video') {
        setProgress(5, 'Building video workflow...')
        workflow = await buildTxt2VidWorkflow({ ...baseParams, frames, fps }, videoBackend)
      } else {
        setProgress(5, 'Building image workflow...')
        workflow = await buildTxt2ImgWorkflow(baseParams, imageModelType)
      }

      setProgress(10, 'Submitting to ComfyUI...')
      let promptId: string
      try {
        promptId = await submitWorkflow(workflow)
      } catch (err) {
        setError(`Failed to submit: ${err instanceof Error ? err.message : String(err)}`)
        setIsGenerating(false)
        return
      }
      setCurrentPromptId(promptId)
      addToPromptHistory(prompt)

      // Poll for completion
      await new Promise<void>((resolve, reject) => {
        let attempts = 0
        const maxAttempts = 1200
        const startTime = Date.now()

        pollRef.current = setInterval(async () => {
          if (abortRef.current?.signal.aborted) {
            if (pollRef.current) clearInterval(pollRef.current)
            reject(new Error('Cancelled'))
            return
          }

          attempts++
          if (attempts > maxAttempts) {
            if (pollRef.current) clearInterval(pollRef.current)
            reject(new Error('Generation timed out after 20 minutes'))
            return
          }

          const elapsed = Math.round((Date.now() - startTime) / 1000)
          const pct = Math.min(10 + (attempts / (steps * 2) * 85), 95)

          try {
            const history = await getHistory(promptId)
            if (!history) {
              setProgress(pct, `Generating... ${elapsed}s elapsed`)
              return
            }

            if (history.status?.completed) {
              if (pollRef.current) clearInterval(pollRef.current)
              setProgress(100, 'Complete!')

              const outputs = history.outputs ?? {}
              let found = false
              for (const nodeId of Object.keys(outputs)) {
                const nodeOutput = outputs[nodeId]
                const files: ComfyUIOutput[] = [
                  ...(nodeOutput.images ?? []),
                  ...(nodeOutput.gifs ?? []),
                  ...(nodeOutput.videos ?? []),
                ]
                for (const file of files) {
                  found = true
                  const galleryItem: GalleryItem = {
                    id: uuid(),
                    type: mode,
                    filename: file.filename,
                    subfolder: file.subfolder ?? '',
                    prompt, negativePrompt,
                    model: activeModel,
                    modelType: mode === 'image' ? imageModelType : 'wan',
                    seed: seed === -1 ? 0 : seed,
                    steps, cfgScale, sampler, scheduler, width, height,
                    batchSize,
                    createdAt: Date.now(),
                  }
                  addToGallery(galleryItem)
                }
              }
              if (!found) setError('Generation completed but no output was produced. Check ComfyUI logs.')
              resolve()
            } else if (history.status?.status_str === 'error') {
              if (pollRef.current) clearInterval(pollRef.current)
              const errMsg = history.status?.messages?.[0]?.[1]?.message ?? 'Unknown ComfyUI error'
              reject(new Error(errMsg))
            }
          } catch (err) {
            console.warn('[useCreate] Poll error:', err)
          }
        }, 1000)
      })
    } catch (err) {
      if (err instanceof Error && err.message === 'Cancelled') {
        // User cancelled, not an error
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        useCreateStore.getState().setError(`Generation failed: ${msg}`)
        console.error('[useCreate] Generation error:', err)
      }
    } finally {
      useCreateStore.getState().setIsGenerating(false)
      useCreateStore.getState().setProgress(0)
      useCreateStore.getState().setCurrentPromptId(null)
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      abortRef.current = null
    }
  }, [videoBackend])

  const cancel = useCallback(async () => {
    abortRef.current?.abort()
    await cancelGeneration()
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    useCreateStore.getState().setIsGenerating(false)
    useCreateStore.getState().setProgress(0)
    useCreateStore.getState().setCurrentPromptId(null)
    useCreateStore.getState().setError(null)
  }, [])

  return {
    connected,
    imageModels,
    videoModels: videoModelsList,
    samplerList,
    schedulerList,
    videoBackend,
    modelsLoaded,
    checkConnection,
    fetchModels,
    generate,
    cancel,
  }
}
