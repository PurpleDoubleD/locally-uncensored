import { useEffect, useState, useCallback, useRef } from 'react'
import { Image, Video, WifiOff, Loader2, AlertTriangle, RefreshCw, Settings, FolderOpen, HardDriveDownload, CheckCircle2, XCircle, Download, Pause, Play, X as XIcon, Upload, ImagePlus } from 'lucide-react'
import { backendCall } from '../../api/backend'
import { freeMemory, uploadImage, classifyModel } from '../../api/comfyui'
import { startModelDownload, getDownloadProgress, pauseDownload, cancelDownload, resumeDownload } from '../../api/discover'
import { useCreate } from '../../hooks/useCreate'
import { useCreateStore } from '../../stores/createStore'
import { PromptInput } from './PromptInput'
import { ParamPanel } from './ParamPanel'
import { OutputDisplay } from './OutputDisplay'
import { Gallery } from './Gallery'

/** Inline download button — stays on Create view, shows progress with pause/cancel */
function DownloadButton({ url, subfolder, filename, onDone }: { url: string; subfolder: string; filename: string; onDone: () => void }) {
  const [state, setState] = useState<'idle' | 'downloading' | 'paused' | 'done' | 'error'>('idle')
  const [pct, setPct] = useState(0)
  const [speed, setSpeed] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const prog = await getDownloadProgress()
        const d = prog[filename]
        if (!d) return
        if (d.total > 0) setPct(Math.round(d.progress / d.total * 100))
        if (d.speed > 0) setSpeed((d.speed / 1024 / 1024).toFixed(1) + ' MB/s')
        if (d.status === 'complete') {
          if (pollRef.current) clearInterval(pollRef.current)
          setState('done')
          window.dispatchEvent(new CustomEvent('comfyui-model-downloaded'))
          onDone()
        } else if (d.status === 'error') {
          if (pollRef.current) clearInterval(pollRef.current)
          setState('error')
        } else if (d.status === 'paused') {
          setState('paused')
        } else {
          setState('downloading')
        }
      } catch { /* keep polling */ }
    }, 1500)
  }

  const handleStart = async () => {
    setState('downloading')
    try {
      await startModelDownload(url, subfolder, filename)
      startPolling()
    } catch { setState('error') }
  }

  const handlePause = async () => {
    await pauseDownload(filename)
    setState('paused')
  }

  const handleResume = async () => {
    await resumeDownload(filename, url, subfolder)
    setState('downloading')
    startPolling()
  }

  const handleCancel = async () => {
    if (pollRef.current) clearInterval(pollRef.current)
    await cancelDownload(filename)
    setState('idle')
    setPct(0)
  }

  useEffect(() => { return () => { if (pollRef.current) clearInterval(pollRef.current) } }, [])

  if (state === 'done') return <span className="text-[9px] text-emerald-400 font-medium px-2 py-0.5">Installed</span>
  if (state === 'error') return (
    <button onClick={handleStart} className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30 text-red-300 text-[9px] font-medium transition-colors">
      <Download size={9} /> Retry
    </button>
  )
  if (state === 'downloading') return (
    <span className="shrink-0 flex items-center gap-1 text-[9px] font-medium">
      <span className="text-blue-300 min-w-[32px]">{pct}%</span>
      {speed && <span className="text-gray-500">{speed}</span>}
      <button onClick={handlePause} className="p-0.5 rounded hover:bg-white/10 text-yellow-400" title="Pause"><Pause size={9} /></button>
      <button onClick={handleCancel} className="p-0.5 rounded hover:bg-white/10 text-red-400" title="Cancel"><XIcon size={9} /></button>
    </span>
  )
  if (state === 'paused') return (
    <span className="shrink-0 flex items-center gap-1 text-[9px] font-medium">
      <span className="text-yellow-400">{pct}% paused</span>
      <button onClick={handleResume} className="p-0.5 rounded hover:bg-white/10 text-emerald-400" title="Resume"><Play size={9} /></button>
      <button onClick={handleCancel} className="p-0.5 rounded hover:bg-white/10 text-red-400" title="Cancel"><XIcon size={9} /></button>
    </span>
  )
  return (
    <button onClick={handleStart} className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30 text-red-300 text-[9px] font-medium transition-colors">
      <Download size={9} /> Download
    </button>
  )
}

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
    videoBackend, modelsLoaded, checkConnection, fetchModels, runPreflight, generate, cancel,
  } = useCreate()
  const { mode, setMode, imageSubMode, error, preflightReady, preflightErrors, preflightWarnings, videoModel, i2vImage, setI2vImage, i2iImage, setI2iImage, denoise, setDenoise } = useCreateStore()

  const [status, setStatus] = useState<ComfyStatus | null>(null)
  const [startupLogs, setStartupLogs] = useState<string[]>([])
  const [retrying, setRetrying] = useState(false)
  const [showParams, setShowParams] = useState(false)
  const [comfyPathInput, setComfyPathInput] = useState('')
  const [pathSaving, setPathSaving] = useState(false)
  const [pathError, setPathError] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installLogs, setInstallLogs] = useState<string[]>([])
  const [installError, setInstallError] = useState('')
  const [showConnected, setShowConnected] = useState(true)
  const [i2vUploading, setI2vUploading] = useState(false)
  const [i2vDragOver, setI2vDragOver] = useState(false)
  const [i2iUploading, setI2iUploading] = useState(false)
  const [i2iDragOver, setI2iDragOver] = useState(false)
  const installPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollIdRef = useRef(0)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pollStatus = useCallback(async () => {
    try {
      const data: ComfyStatus = await backendCall('comfyui_status')
      setStatus(data)
      if (data.logs?.length > 0) setStartupLogs(data.logs)

      if (data.running) {
        const wasConnected = await checkConnection()
        if (wasConnected) fetchModels()
        return true
      }
    } catch {
      // Status poll failed silently
    }
    return false
  }, [checkConnection, fetchModels])

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

  // Auto-hide connected bar after 10s
  useEffect(() => {
    if (connected === true) {
      setShowConnected(true)
      hideTimerRef.current = setTimeout(() => setShowConnected(false), 10000)
      return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current) }
    }
  }, [connected])

  const retryConnect = async () => {
    setRetrying(true)
    try { await backendCall('start_comfyui') } catch { /* ignore */ }
    setTimeout(async () => {
      await pollStatus()
      setRetrying(false)
    }, 3000)
  }

  // Re-run preflight when mode or video model changes
  useEffect(() => {
    if (connected === true && modelsLoaded) {
      runPreflight()
    }
  }, [mode, videoModel, connected, modelsLoaded, runPreflight])

  // Detect I2V model (SVD, FramePack need an input image)
  const videoModelType = videoModel ? classifyModel(videoModel) : null
  const isI2V = mode === 'video' && (videoModelType === 'svd' || videoModelType === 'framepack')

  const handleI2vUpload = async (file: File) => {
    if (!file.type.startsWith('image/')) return
    setI2vUploading(true)
    try {
      const filename = await uploadImage(file)
      setI2vImage(filename)
    } catch (err) {
      console.error('[CreateView] I2V image upload failed:', err)
    }
    setI2vUploading(false)
  }

  const handleI2vDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setI2vDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleI2vUpload(file)
  }

  const handleI2iUpload = async (file: File) => {
    if (!file.type.startsWith('image/')) return
    setI2iUploading(true)
    try {
      const filename = await uploadImage(file)
      setI2iImage(filename)
    } catch (err) {
      console.error('[CreateView] I2I image upload failed:', err)
    }
    setI2iUploading(false)
  }

  const handleI2iDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setI2iDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleI2iUpload(file)
  }

  const isStarting = status?.starting || status?.processAlive
  const notFound = status && !status.found && !status.running

  return (
    <div className="h-full flex flex-col">
      {/* Setup wizard */}
      {notFound && !installing && (
        <div className="border-b border-red-500/20">
          <div className="p-4 bg-red-500/5 space-y-3">
            <div className="flex items-center gap-2 text-red-400 text-sm font-medium">
              <WifiOff size={14} />
              ComfyUI not found
            </div>
            <div className="bg-neutral-900 rounded-lg p-4 space-y-4 border border-white/5">
              <div>
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Auto-install</p>
                <button
                  onClick={async () => {
                    setInstalling(true)
                    setInstallError('')
                    setInstallLogs([])
                    try {
                      await backendCall('install_comfyui')
                      installPollRef.current = setInterval(async () => {
                        try {
                          const data = await backendCall('install_comfyui_status')
                          setInstallLogs(data.logs || [])
                          if (data.status === 'complete') {
                            if (installPollRef.current) clearInterval(installPollRef.current)
                            setInstalling(false)
                            setTimeout(() => pollStatus(), 2000)
                          } else if (data.status === 'error') {
                            if (installPollRef.current) clearInterval(installPollRef.current)
                            setInstallError(data.error || 'Failed')
                            setInstalling(false)
                          }
                        } catch { /* keep polling */ }
                      }, 2000)
                    } catch {
                      setInstallError('Failed to start')
                      setInstalling(false)
                    }
                  }}
                  className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-white text-xs font-medium transition-colors"
                >
                  Install ComfyUI
                </button>
              </div>
              <div className="border-t border-white/5 pt-3">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Manual path</p>
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <FolderOpen size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                    <input
                      value={comfyPathInput}
                      onChange={(e) => { setComfyPathInput(e.target.value); setPathError('') }}
                      placeholder="C:\ComfyUI"
                      className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-white/20"
                    />
                  </div>
                  <button
                    onClick={async () => {
                      if (!comfyPathInput.trim()) { setPathError('Enter a path'); return }
                      setPathSaving(true)
                      setPathError('')
                      try {
                        const data = await backendCall('set_comfyui_path', { path: comfyPathInput.trim() })
                        if (data.status === 'ok') setTimeout(() => pollStatus(), 2000)
                        else setPathError(data.error || 'Invalid')
                      } catch { setPathError('Failed') }
                      setPathSaving(false)
                    }}
                    disabled={pathSaving}
                    className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 disabled:opacity-50 text-white text-xs transition-colors"
                  >
                    {pathSaving ? <Loader2 size={12} className="animate-spin" /> : 'Connect'}
                  </button>
                </div>
                {pathError && <p className="text-[10px] text-red-400 mt-1">{pathError}</p>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Installing */}
      {installing && (
        <div className="border-b border-white/5">
          <div className="p-3 bg-white/5 space-y-2">
            <div className="flex items-center gap-2 text-gray-300 text-xs">
              <Loader2 size={12} className="animate-spin" />
              Installing ComfyUI...
            </div>
            {installLogs.length > 0 && (
              <div className="bg-black rounded-lg p-2 max-h-32 overflow-y-auto font-mono text-[10px] text-gray-500">
                {installLogs.slice(-10).map((log, i) => <div key={i} className="truncate">{log}</div>)}
              </div>
            )}
            {installError && <p className="text-[10px] text-red-400">{installError}</p>}
          </div>
        </div>
      )}

      {/* Starting */}
      {isStarting && !connected && (
        <div className="flex items-center gap-2 px-4 py-2 bg-white/5 border-b border-white/5 text-gray-400 text-xs">
          <Loader2 size={12} className="animate-spin" />
          <span>ComfyUI loading...</span>
        </div>
      )}

      {/* Not responding */}
      {status && !status.running && status.found && !isStarting && !connected && (
        <div className="flex items-center justify-between px-4 py-2 bg-orange-500/5 border-b border-orange-500/10 text-xs">
          <div className="flex items-center gap-2 text-orange-400">
            <AlertTriangle size={12} />
            <span>ComfyUI not responding</span>
          </div>
          <button onClick={retryConnect} disabled={retrying}
            className="flex items-center gap-1 px-2 py-1 rounded bg-white/10 hover:bg-white/15 text-white text-[10px] transition-colors">
            <RefreshCw size={10} className={retrying ? 'animate-spin' : ''} /> Retry
          </button>
        </div>
      )}

      {/* Connected — auto-hides after 10s */}
      {connected === true && showConnected && (
        <div className="flex items-center justify-between px-4 py-1.5 bg-emerald-500/5 border-b border-emerald-500/10 text-emerald-400 text-[11px] transition-opacity">
          <span>{imageModels.length} model{imageModels.length !== 1 ? 's' : ''} loaded</span>
          <button onClick={fetchModels} className="flex items-center gap-1 text-emerald-500/60 hover:text-emerald-400 transition-colors">
            <RefreshCw size={10} /> Refresh
          </button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Main content */}
        <div className="flex-1 flex flex-col overflow-hidden p-4 gap-3">
          {/* Mode switcher */}
          <div className="flex items-center justify-between">
            <div className="flex gap-0.5 p-0.5 bg-gray-100 dark:bg-white/5 rounded-lg">
              <button
                onClick={() => setMode('image')}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all ${
                  mode === 'image' ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <Image size={12} /> Image
              </button>
              <button
                onClick={() => setMode('video')}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all ${
                  mode === 'video' ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <Video size={12} /> Video
              </button>
            </div>

            <div className="flex items-center gap-1">
              {connected && (
                <button
                  onClick={async () => {
                    await freeMemory()
                    setShowConnected(true)
                    // Brief flash to confirm
                    const el = document.getElementById('unload-btn')
                    if (el) { el.textContent = 'Freed!'; setTimeout(() => { el.textContent = '' }, 1500) }
                  }}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 text-[10px] transition-colors"
                  title="Unload models and free memory"
                  aria-label="Unload models and free memory"
                >
                  <HardDriveDownload size={12} />
                  <span id="unload-btn"></span>
                </button>
              )}
              <button
                onClick={() => setShowParams(!showParams)}
                className="lg:hidden p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500"
                aria-label="Toggle settings panel"
              >
                <Settings size={14} />
              </button>
            </div>
          </div>

          {/* Pre-flight status */}
          {connected === true && modelsLoaded && preflightReady !== null && (
            <>
              {preflightReady && preflightWarnings.length === 0 && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/5 border border-emerald-500/10 text-emerald-400 text-[10px]">
                  <CheckCircle2 size={11} />
                  Ready to generate
                </div>
              )}
              {preflightReady && preflightWarnings.length > 0 && (
                <div className="space-y-1">
                  {preflightWarnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-2 px-3 py-1.5 rounded-lg bg-yellow-500/5 border border-yellow-500/10 text-yellow-400 text-[10px]">
                      <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}
              {!preflightReady && preflightErrors.length > 0 && (
                <div className="space-y-1">
                  {preflightErrors.map((e, i) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-500/5 border border-red-500/10 text-red-400 text-[10px]">
                      <XCircle size={11} className="shrink-0" />
                      <span className="flex-1">{e.message}</span>
                      {e.downloadUrl && e.downloadFilename && e.downloadSubfolder && (
                        <DownloadButton url={e.downloadUrl!} subfolder={e.downloadSubfolder!} filename={e.downloadFilename!} onDone={() => runPreflight()} />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Video info */}
          {mode === 'video' && (videoBackend === 'none' || videoModels.length === 0) && connected === true && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-500/5 border border-yellow-500/10 text-yellow-400 text-[11px]">
              <AlertTriangle size={12} />
              No video models found
            </div>
          )}

          {/* I2V Image Upload — shown when SVD or FramePack model is selected */}
          {isI2V && connected === true && (
            <div
              onDragOver={(e) => { e.preventDefault(); setI2vDragOver(true) }}
              onDragLeave={() => setI2vDragOver(false)}
              onDrop={handleI2vDrop}
              className={`relative rounded-lg border-2 border-dashed transition-colors ${
                i2vDragOver
                  ? 'border-blue-400 bg-blue-500/10'
                  : i2vImage
                    ? 'border-emerald-500/30 bg-emerald-500/5'
                    : 'border-white/10 bg-white/[0.02] hover:border-white/20'
              }`}
            >
              {i2vImage ? (
                <div className="flex items-center justify-between px-3 py-2">
                  <div className="flex items-center gap-2 text-emerald-400 text-[11px]">
                    <CheckCircle2 size={12} />
                    <span className="truncate max-w-[200px]">{i2vImage}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <label className="cursor-pointer px-2 py-0.5 rounded text-[10px] text-gray-400 hover:text-white hover:bg-white/10 transition-colors">
                      Replace
                      <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleI2vUpload(f) }} />
                    </label>
                    <button
                      onClick={() => setI2vImage(null)}
                      className="p-0.5 rounded text-gray-500 hover:text-red-400 hover:bg-white/10 transition-colors"
                      title="Remove image"
                    >
                      <XIcon size={10} />
                    </button>
                  </div>
                </div>
              ) : (
                <label className="flex flex-col items-center gap-1 px-3 py-3 cursor-pointer">
                  {i2vUploading ? (
                    <Loader2 size={16} className="animate-spin text-gray-400" />
                  ) : (
                    <ImagePlus size={16} className="text-gray-500" />
                  )}
                  <span className="text-[11px] text-gray-400">
                    {i2vUploading ? 'Uploading...' : 'Drop or click to upload input image'}
                  </span>
                  <span className="text-[9px] text-gray-600">
                    {videoModelType === 'svd' ? 'SVD' : 'FramePack'} generates video from an image
                  </span>
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleI2vUpload(f) }} />
                </label>
              )}
            </div>
          )}

          {/* I2I Image Upload + Denoise Slider — shown when Image sub-tab is "Image to Image" */}
          {mode === 'image' && imageSubMode === 'img2img' && connected === true && (
            <div className="space-y-2">
              <div
                onDragOver={(e) => { e.preventDefault(); setI2iDragOver(true) }}
                onDragLeave={() => setI2iDragOver(false)}
                onDrop={handleI2iDrop}
                className={`relative rounded-lg border-2 border-dashed transition-colors ${
                  i2iDragOver
                    ? 'border-blue-400 bg-blue-500/10'
                    : i2iImage
                      ? 'border-emerald-500/30 bg-emerald-500/5'
                      : 'border-white/10 bg-white/[0.02] hover:border-white/20'
                }`}
              >
                {i2iImage ? (
                  <div className="flex items-center justify-between px-3 py-2">
                    <div className="flex items-center gap-2 text-emerald-400 text-[11px]">
                      <CheckCircle2 size={12} />
                      <span className="truncate max-w-[200px]">{i2iImage}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <label className="cursor-pointer px-2 py-0.5 rounded text-[10px] text-gray-400 hover:text-white hover:bg-white/10 transition-colors">
                        Replace
                        <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleI2iUpload(f) }} />
                      </label>
                      <button
                        onClick={() => setI2iImage(null)}
                        className="p-0.5 rounded text-gray-500 hover:text-red-400 hover:bg-white/10 transition-colors"
                        title="Remove image"
                      >
                        <XIcon size={10} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <label className="flex flex-col items-center gap-1 px-3 py-3 cursor-pointer">
                    {i2iUploading ? (
                      <Loader2 size={16} className="animate-spin text-gray-400" />
                    ) : (
                      <Upload size={16} className="text-gray-500" />
                    )}
                    <span className="text-[11px] text-gray-400">
                      {i2iUploading ? 'Uploading...' : 'Drop or click to upload source image'}
                    </span>
                    <span className="text-[9px] text-gray-600">
                      Image-to-Image: transforms your image guided by the prompt
                    </span>
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleI2iUpload(f) }} />
                  </label>
                )}
              </div>

              {/* Denoise Strength Slider */}
              <div className="flex items-center gap-3 px-1">
                <span className="text-[10px] text-gray-500 whitespace-nowrap">Denoise</span>
                <input
                  type="range"
                  min={0} max={1} step={0.05}
                  value={denoise}
                  onChange={(e) => setDenoise(parseFloat(e.target.value))}
                  className="flex-1 h-1 accent-blue-500"
                />
                <span className="text-[10px] text-gray-400 font-mono w-8 text-right">{denoise.toFixed(2)}</span>
              </div>
            </div>
          )}

          {/* Output area */}
          <div className="flex-1 min-h-0 rounded-xl border border-gray-200 dark:border-white/5 bg-gray-100 dark:bg-white/[0.03] overflow-hidden flex flex-col">
            <OutputDisplay />
            <Gallery />
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/5 border border-red-500/10 text-red-400 text-[11px]">
              <AlertTriangle size={12} className="shrink-0" />
              <span className="truncate">{error}</span>
            </div>
          )}

          {/* Prompt */}
          <PromptInput onGenerate={generate} onCancel={cancel} disabled={!connected || !modelsLoaded} />
        </div>

        {/* Parameter sidebar — desktop */}
        <div className="w-56 border-l border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-white/[0.03] p-3 overflow-y-auto scrollbar-thin hidden lg:block">
          <p className="text-[10px] font-medium text-gray-600 uppercase tracking-widest mb-3">Parameters</p>
          <ParamPanel
            imageModels={imageModels}
            videoModels={videoModels}
            samplerList={samplerList}
            schedulerList={schedulerList}
            modelsLoaded={modelsLoaded}
          />
        </div>

        {/* Parameter sidebar — mobile */}
        {showParams && (
          <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setShowParams(false)}>
            <div className="absolute inset-0 bg-black/60" />
            <div className="absolute right-0 top-0 h-full w-64 bg-white dark:bg-[#212121] border-l border-gray-200 dark:border-white/5 p-3 overflow-y-auto"
              onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <p className="text-[10px] font-medium text-gray-600 uppercase tracking-widest">Parameters</p>
                <button onClick={() => setShowParams(false)} className="p-1 text-gray-500 hover:text-gray-300" aria-label="Close settings panel">
                  <Settings size={12} />
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
