import { useEffect, useState, useCallback, useRef } from 'react'
import { Image, Video, WifiOff, Play, Loader2, CheckCircle } from 'lucide-react'
import { useCreate } from '../../hooks/useCreate'
import { useCreateStore } from '../../stores/createStore'
import { PromptInput } from './PromptInput'
import { ParamPanel } from './ParamPanel'
import { OutputDisplay } from './OutputDisplay'
import { Gallery } from './Gallery'

export function CreateView() {
  const { connected, checkpoints, samplerList, checkConnection, fetchModels, generate, cancel } = useCreate()
  const { mode, setMode } = useCreateStore()

  const [starting, setStarting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const tryConnect = useCallback(async () => {
    const ok = await checkConnection()
    if (ok) fetchModels()
    return ok
  }, [checkConnection, fetchModels])

  useEffect(() => {
    tryConnect()
  }, [tryConnect])

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const startComfyUI = async () => {
    setStarting(true)
    try {
      await fetch('/local-api/start-comfyui')
    } catch { /* ignore */ }

    let attempts = 0
    pollRef.current = setInterval(async () => {
      attempts++
      const ok = await checkConnection()
      if (ok) {
        if (pollRef.current) clearInterval(pollRef.current)
        setStarting(false)
        fetchModels()
      }
      if (attempts > 30) {
        if (pollRef.current) clearInterval(pollRef.current)
        setStarting(false)
      }
    }, 3000)
  }

  return (
    <div className="h-full flex flex-col">
      {/* Connection status */}
      {connected === false && !starting && (
        <div className="flex items-center justify-between px-4 py-3 bg-red-50 dark:bg-red-500/10 border-b border-red-200 dark:border-red-500/20">
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400 text-sm">
            <WifiOff size={16} />
            <span>ComfyUI is not running on port 8188.</span>
          </div>
          <button
            onClick={startComfyUI}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium transition-colors"
          >
            <Play size={14} /> Start ComfyUI
          </button>
        </div>
      )}

      {starting && (
        <div className="flex items-center gap-3 px-4 py-3 bg-yellow-50 dark:bg-yellow-500/10 border-b border-yellow-200 dark:border-yellow-500/20 text-yellow-700 dark:text-yellow-400 text-sm">
          <Loader2 size={16} className="animate-spin" />
          <span>Starting ComfyUI... This may take up to 30 seconds.</span>
        </div>
      )}

      {connected === true && (
        <div className="flex items-center gap-2 px-4 py-2 bg-green-50 dark:bg-green-500/10 border-b border-green-200 dark:border-green-500/20 text-green-600 dark:text-green-400 text-sm">
          <CheckCircle size={16} />
          <span>ComfyUI connected — {checkpoints.length} model{checkpoints.length !== 1 ? 's' : ''} found</span>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Main content */}
        <div className="flex-1 flex flex-col overflow-hidden p-4 gap-4">
          {/* Top section: Mode switcher + Prompt (~25%) */}
          <div className="space-y-3">
            <div className="flex gap-1 p-1 bg-gray-100 dark:bg-white/5 rounded-lg w-fit">
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

            <PromptInput onGenerate={generate} onCancel={cancel} />
          </div>

          {/* Output area (~75%) — centered in a distinct card */}
          <div className="flex-1 min-h-0 rounded-xl border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-[#1a1a1a] overflow-hidden flex flex-col">
            <OutputDisplay />
            <Gallery />
          </div>
        </div>

        {/* Parameter sidebar */}
        <div className="w-64 border-l border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-[#1a1a1a] p-4 overflow-y-auto scrollbar-thin hidden lg:block">
          <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">Parameters</h3>
          <ParamPanel checkpoints={checkpoints} samplerList={samplerList} />
        </div>
      </div>
    </div>
  )
}
