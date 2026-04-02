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
  classifyModel,
  type ClassifiedModel,
  type ComfyUIOutput,
  type VideoBackend,
} from '../api/comfyui'
import { buildDynamicWorkflow } from '../api/dynamic-workflow'
import { getAllNodeInfo } from '../api/comfyui-nodes'
import { useCreateStore, type GalleryItem } from '../stores/createStore'
import { useWorkflowStore } from '../stores/workflowStore'
import { injectParameters } from '../api/workflows'
import { preflightCheck } from '../api/preflight'

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

  const runPreflight = useCallback(async () => {
    const state = useCreateStore.getState()
    const activeModel = state.mode === 'image' ? state.imageModel : state.videoModel
    if (!activeModel) {
      state.setPreflightStatus(null, [], [])
      return
    }
    try {
      const result = await preflightCheck(activeModel, state.mode, state.width, state.height)
      state.setPreflightStatus(
        result.ready,
        result.errors,
        result.warnings.map(w => w.message),
      )
    } catch {
      state.setPreflightStatus(null, [], [])
    }
  }, [])

  const fetchModels = useCallback(async () => {
    try {
      const [imgModels, vidModels, samplers, schedulers, vBackend, _nodeInfo] = await Promise.all([
        getImageModels(),
        getVideoModels(),
        getSamplers(),
        getSchedulers(),
        detectVideoBackend(),
        getAllNodeInfo().catch(() => null),
      ])
      setImageModels(imgModels)
      setVideoModelsList(vidModels)
      setSamplerList(samplers)
      setSchedulerList(schedulers)
      setVideoBackend(vBackend)
      setModelsLoaded(true)

      const state = useCreateStore.getState()
      // Auto-select first models if none set
      if (imgModels.length > 0 && !state.imageModel) {
        state.setImageModel(imgModels[0].name, imgModels[0].type)
      }
      if (vidModels.length > 0 && !state.videoModel) {
        state.setVideoModel(vidModels[0].name)
      }
      // Always re-sync model type for currently selected model (fixes stale type after restart)
      if (state.imageModel && imgModels.length > 0) {
        const current = imgModels.find(m => m.name === state.imageModel)
        if (current && current.type !== state.imageModelType) {
          console.log(`[useCreate] Fixing model type: ${state.imageModelType} -> ${current.type}`)
          state.setImageModel(state.imageModel, current.type)
        }
      }
      // Run preflight check after models are loaded
      setTimeout(() => runPreflight(), 100)
    } catch (err) {
      console.error('[useCreate] Failed to fetch models:', err)
    }
  }, [runPreflight])

  // Auto-refresh models when a ComfyUI model download completes
  useEffect(() => {
    const handler = () => {
      console.log('[useCreate] Model download completed, refreshing model list...')
      fetchModels()
    }
    window.addEventListener('comfyui-model-downloaded', handler)
    return () => window.removeEventListener('comfyui-model-downloaded', handler)
  }, [fetchModels])

  const generate = useCallback(async () => {
    const state = useCreateStore.getState()
    const {
      mode, prompt, negativePrompt, imageModel, videoModel,
      sampler, scheduler, steps, cfgScale, width, height, seed, batchSize, frames, fps,
      setIsGenerating, setProgress, setCurrentPromptId, setError, addToGallery, addToPromptHistory,
    } = state

    setError(null)
    const activeModel = mode === 'image' ? imageModel : videoModel
    // Always re-classify from model name to avoid stale type
    const imageModelType = classifyModel(activeModel)

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
      let builderUsed: 'dynamic' | 'legacy' | 'custom' = 'dynamic'

      // Check for custom workflow assignment — but verify it's compatible with the model
      let customWf = useWorkflowStore.getState().getWorkflowForModel(activeModel, imageModelType)
      if (customWf) {
        const wfNodes = Object.values(customWf.workflow).map((n: any) => n.class_type)
        const needsUnet = imageModelType === 'flux' || imageModelType === 'flux2' || imageModelType === 'wan' || imageModelType === 'hunyuan'
        const hasUnet = wfNodes.includes('UNETLoader')
        const hasCheckpoint = wfNodes.includes('CheckpointLoaderSimple')
        if (needsUnet && !hasUnet && hasCheckpoint) {
          console.warn('[useCreate] Custom workflow incompatible: model needs UNETLoader but workflow has CheckpointLoaderSimple. Using auto.')
          customWf = null
        } else if (!needsUnet && hasUnet && !hasCheckpoint) {
          console.warn('[useCreate] Custom workflow incompatible: model needs CheckpointLoaderSimple but workflow has UNETLoader. Using auto.')
          customWf = null
        }
      }
      console.log('[useCreate] Custom workflow check:', { activeModel, imageModelType, found: customWf?.name ?? 'NONE (auto)' })

      if (customWf) {
        builderUsed = 'custom'
        setProgress(5, `Using workflow: ${customWf.name}...`)
        const params = mode === 'video' ? { ...baseParams, frames, fps } : baseParams
        workflow = await injectParameters(customWf.workflow, customWf.parameterMap, params, imageModelType)
      } else {
        // Dynamic workflow builder — auto-detects nodes and builds the right pipeline
        setProgress(5, 'Building workflow...')
        try {
          const genParams = mode === 'video' ? { ...baseParams, frames, fps } : baseParams
          workflow = await buildDynamicWorkflow(genParams, imageModelType)
          builderUsed = 'dynamic'
        } catch (dynErr) {
          // Fallback to legacy builders if dynamic fails
          console.warn('[useCreate] Dynamic builder failed, using legacy:', dynErr)
          builderUsed = 'legacy'
          setProgress(5, 'Using legacy builder...')
          if (mode === 'video') {
            workflow = await buildTxt2VidWorkflow({ ...baseParams, frames, fps }, videoBackend)
          } else {
            workflow = await buildTxt2ImgWorkflow(baseParams, imageModelType)
          }
        }
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

      // Poll for completion — video gets 60min timeout, image 20min
      const maxTime = mode === 'video' ? 60 * 60 * 1000 : 20 * 60 * 1000
      await new Promise<void>((resolve, reject) => {
        let attempts = 0
        let comfyCheckCounter = 0
        const startTime = Date.now()

        pollRef.current = setInterval(async () => {
          if (abortRef.current?.signal.aborted) {
            if (pollRef.current) clearInterval(pollRef.current)
            reject(new Error('Cancelled'))
            return
          }

          const elapsed = Date.now() - startTime
          if (elapsed > maxTime) {
            if (pollRef.current) clearInterval(pollRef.current)
            reject(new Error(`Generation timed out after ${Math.round(maxTime / 60000)} minutes`))
            return
          }

          attempts++
          comfyCheckCounter++

          // Heartbeat: every 30 polls, check if ComfyUI is still alive
          if (comfyCheckCounter >= 30) {
            comfyCheckCounter = 0
            const alive = await checkComfyConnection()
            if (!alive) {
              if (pollRef.current) clearInterval(pollRef.current)
              reject(new Error('ComfyUI stopped responding during generation'))
              return
            }
          }

          const elapsedSec = Math.round(elapsed / 1000)
          // Video progress: slower, more conservative estimate
          const expectedSteps = mode === 'video' ? steps * frames * 0.5 : steps * 2
          const pct = Math.min(10 + (attempts / expectedSteps * 85), 95)

          try {
            const history = await getHistory(promptId)

            // Always update elapsed time
            setProgress(pct, `Generating... ${elapsedSec}s elapsed`)

            if (!history) return

            if (history.status?.completed) {
              if (pollRef.current) clearInterval(pollRef.current)
              // Calculate real generation time from ComfyUI timestamps
              const messages: [string, any][] = history.status?.messages ?? []
              const startMsg = messages.find(([t]) => t === 'execution_start')
              const endMsg = messages.find(([t]) => t === 'execution_success')
              const comfyTime = startMsg?.[1]?.timestamp && endMsg?.[1]?.timestamp
                ? ((endMsg[1].timestamp - startMsg[1].timestamp) / 1000).toFixed(1)
                : null
              setProgress(100, 'Complete!')
              useCreateStore.getState().setLastGenTime(comfyTime ? `${comfyTime}s` : null)

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
                    modelType: mode === 'image' ? imageModelType : (videoModelsList.find(m => m.name === activeModel)?.type ?? 'wan'),
                    seed: seed === -1 ? 0 : seed,
                    steps, cfgScale, sampler, scheduler, width, height,
                    batchSize,
                    createdAt: Date.now(),
                    builderUsed,
                  }
                  addToGallery(galleryItem)
                }
              }
              if (!found) setError('Generation completed but no output was produced. Check ComfyUI logs.')
              resolve()
            } else if (history.status?.status_str === 'error') {
              if (pollRef.current) clearInterval(pollRef.current)
              // Find the execution_error message which has the actual error details
              const messages: [string, any][] = history.status?.messages ?? []
              const errorEntry = messages.find(([t]) => t === 'execution_error')
              const errMsg = errorEntry?.[1]?.exception_message
                || errorEntry?.[1]?.message
                || messages[messages.length - 1]?.[1]?.message
                || 'Unknown ComfyUI error'
              const nodeType = errorEntry?.[1]?.node_type ? ` (${errorEntry[1].node_type})` : ''
              reject(new Error(errMsg.trim() + nodeType))
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
    runPreflight,
    generate,
    cancel,
  }
}
