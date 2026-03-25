import { useEffect, useState, useCallback, useRef } from 'react'
import { Image, Video, WifiOff, Loader2, CheckCircle, AlertTriangle, RefreshCw, Settings } from 'lucide-react'
import { useCreate } from '../../hooks/useCreate'
import { useCreateStore } from '../../stores/createStore'
import { PromptInput } from './PromptInput'
import { ParamPanel } from './ParamPanel'
import { OutputDisplay } from './OutputDisplay'
import { Gallery } from './Gallery'

interface ComfyStatus {
  running: boolean
  starting: boolean
  found: boolean
  path: string | null
  logs: string[]
  processAlive?: boolean
}

export function CreateView() {
  const {
    connected, imageModels, videoModels, samplerList, schedulerList,
    videoBackend, modelsLoaded, checkConnection, fetchModels, generate, cancel,
  } = useCreate()
  const { mode, setMode, error } = useCreateStore()

  const [status, setStatus] = useState<ComfyStatus | null>(null)
  const [startupLogs, setStartupLogs] = useState<string[]>([])
  const [retrying, setRetrying] = useState(false)
  const [showParams, setShowParams] = useState(false) // mobile params toggle
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollIdRef = useRef(0) // prevent duplicate polling

  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch('/local-api/comfyui-status', { signal: AbortSignal.timeout(3000) })
      const data: ComfyStatus = await res.json()
      setStatus(data)
      if (data.logs?.length > 0) setStartupLogs(data.logs)

      if (data.running) {
        const wasConnected = await checkConnection()
        if (wasConnected) fetchModels()
        return true
      }
    } catch (err) {
      console.warn('[CreateView] Status poll failed:', err)
    }
    return false
  }, [checkConnection, fetchModels])

  // Initial check + auto-poll (with duplicate prevention)
  useEffect(() => {
    const id = ++pollIdRef.current
    let stopped = false

    const init = async () => {
      const ready = await pollStatus()
      if (ready || stopped || id !== pollIdRef.current) return

      pollRef.current = setInterval(async () => {
        if (stopped || id !== pollIdRef.current) {
          if (pollRef.current) clearInterval(pollRef.current)
          return
        }
        const ready = await pollStatus()
        if (ready && pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      }, 3000)
    }
    init()

    return () => {
      stopped = true
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
  }, [pollStatus])

  const retryConnect = async () => {
    setRetrying(true)
    try { await fetch('/local-api/start-comfyui') } catch { /* ignore */ }
    // Single poll attempt
    setTimeout(async () => {
      await pollStatus()
      setRetrying(false)
    }, 3000)
  }

  const isStarting = status?.starting || status?.processAlive
  const notFound = status && !status.found && !status.running

  return (
    <div className="h-full flex flex-col">
      {/* Status: ComfyUI not found */}
      {notFound && (
        <div className="flex items-center justify-between px-4 py-3 bg-red-50 dark:bg-red-500/10 border-b border-red-200 dark:border-red-500/20" role="alert">
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400 text-sm">
            <WifiOff size={16} />
            <span>ComfyUI not found. Install it or set COMFYUI_PATH in .env</span>
          </div>
        </div>
      )}

      {/* Status: ComfyUI is starting */}
      {isStarting && !connected && (
        <div className="border-b border-yellow-200 dark:border-yellow-500/20" role="status">
          <div className="flex items-center gap-3 px-4 py-3 bg-yellow-50 dark:bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 text-sm">
            <Loader2 size={16} className="animate-spin shrink-0" />
            <span>ComfyUI is loading... This can take a minute on first start.</span>
          </div>
          {startupLogs.length > 0 && (
            <div className="px-4 py-2 bg-gray-100 dark:bg-gray-900 text-gray-600 dark:text-gray-400 text-xs font-mono max-h-24 overflow-y-auto">
              {startupLogs.slice(-8).map((log, i) => (
                <div key={i} className="truncate">{log.trim()}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Status: Not running — offer retry */}
      {status && !status.running && status.found && !isStarting && !connected && (
        <div className="flex items-center justify-between px-4 py-3 bg-orange-50 dark:bg-orange-500/10 border-b border-orange-200 dark:border-orange-500/20" role="alert">
          <div className="flex items-center gap-2 text-orange-600 dark:text-orange-400 text-sm">
            <AlertTriangle size={16} />
            <span>ComfyUI found but not responding.</span>
          </div>
          <button
            onClick={retryConnect}
            disabled={retrying}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white text-xs font-medium transition-colors"
          >
            <RefreshCw size={12} className={retrying ? 'animate-spin' : ''} /> {retrying ? 'Retrying...' : 'Retry'}
          </button>
        </div>
      )}

      {/* Status: Connected */}
      {connected === true && (
        <div className="flex items-center gap-2 px-4 py-2 bg-green-50 dark:bg-green-500/10 border-b border-green-200 dark:border-green-500/20 text-green-600 dark:text-green-400 text-sm" role="status">
          <CheckCircle size={16} />
          <span>
            ComfyUI connected — {imageModels.length} image model{imageModels.length !== 1 ? 's' : ''}, {videoModels.length} video model{videoModels.length !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Main content */}
        <div className="flex-1 flex flex-col overflow-hidden p-4 gap-3">
          {/* Mode switcher */}
          <div className="flex items-center justify-between">
            <div className="flex gap-1 p-1 bg-gray-100 dark:bg-white/5 rounded-lg">
              <button
                onClick={() => setMode('image')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                  mode === 'image' ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <Image size={14} /> Image
              </button>
              <button
                onClick={() => setMode('video')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                  mode === 'video' ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <Video size={14} /> Video
              </button>
            </div>

            {/* Mobile params toggle */}
            <button
              onClick={() => setShowParams(!showParams)}
              className="lg:hidden p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400"
              title="Parameters"
            >
              <Settings size={18} />
            </button>
          </div>

          {/* Video status */}
          {mode === 'video' && (videoBackend === 'none' || videoModels.length === 0) && connected === true && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-50 dark:bg-yellow-500/10 border border-yellow-200 dark:border-yellow-500/20 text-yellow-700 dark:text-yellow-400 text-xs" role="alert">
              <AlertTriangle size={14} />
              <span>No video models installed. Add Wan 2.1/2.2 or Hunyuan models to ComfyUI's models/diffusion_models/ folder.</span>
            </div>
          )}

          {mode === 'video' && videoBackend !== 'none' && videoModels.length > 0 && connected === true && (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Video backend: <span className="text-gray-700 dark:text-gray-300 font-medium">{videoBackend === 'wan' ? 'Wan 2.1/2.2' : 'AnimateDiff'}</span>
              {' · '}{videoModels.length} model{videoModels.length !== 1 ? 's' : ''}
            </div>
          )}

          {/* Prompt */}
          <PromptInput onGenerate={generate} onCancel={cancel} disabled={!connected || !modelsLoaded} />

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-600 dark:text-red-400 text-xs" role="alert">
              <AlertTriangle size={14} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Output area */}
          <div className="flex-1 min-h-0 rounded-xl border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-[#1a1a1a] overflow-hidden flex flex-col">
            <OutputDisplay />
            <Gallery />
          </div>
        </div>

        {/* Parameter sidebar — desktop */}
        <div className="w-64 border-l border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-[#1a1a1a] p-4 overflow-y-auto scrollbar-thin hidden lg:block">
          <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">Parameters</h3>
          <ParamPanel
            imageModels={imageModels}
            videoModels={videoModels}
            samplerList={samplerList}
            schedulerList={schedulerList}
            modelsLoaded={modelsLoaded}
          />
        </div>

        {/* Parameter sidebar — mobile overlay */}
        {showParams && (
          <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setShowParams(false)}>
            <div className="absolute inset-0 bg-black/50" />
            <div
              className="absolute right-0 top-0 h-full w-72 bg-white dark:bg-[#1a1a1a] border-l border-gray-200 dark:border-white/5 p-4 overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Parameters</h3>
                <button onClick={() => setShowParams(false)} className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                  <Settings size={16} />
                </button>
              </div>
              <ParamPanel
                imageModels={imageModels}
                videoModels={videoModels}
                samplerList={samplerList}
                schedulerList={schedulerList}
                modelsLoaded={modelsLoaded}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
