import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Minus, Square, Copy, X as XIcon, ArrowRight, Download, Check, ChevronRight, Loader2, Pause, RefreshCw, ExternalLink, FolderOpen } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { useModels } from '../../hooks/useModels'
import { ONBOARDING_MODELS, type OnboardingModel } from '../../lib/constants'
import { PROVIDER_PRESETS } from '../../api/providers/types'
import { detectLocalBackends, type DetectedBackend } from '../../lib/backend-detector'
import { ProgressBar } from '../ui/ProgressBar'
import { openExternal } from '../../api/backend'
import { formatBytes } from '../../lib/formatters'
import { backendCall } from '../../api/backend'
import { getSystemVRAM } from '../../api/comfyui'

type Step = 'welcome' | 'theme' | 'backends' | 'comfyui' | 'models' | 'done'
const STEP_ORDER: Step[] = ['welcome', 'theme', 'backends', 'comfyui', 'models', 'done']
const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__

/* ── Local backend info for the "nothing found" state ──────── */
interface LocalBackendInfo {
  id: string
  name: string
  description: string
  url: string        // Download / homepage URL
  port: number
}

const LOCAL_BACKENDS: LocalBackendInfo[] = [
  { id: 'ollama',    name: 'Ollama',              description: 'Easiest setup. CLI + API. Huge model library.',                          url: 'https://ollama.com/',                               port: 11434 },
  { id: 'lmstudio',  name: 'LM Studio',           description: 'GUI app with built-in chat. One-click model download.',                  url: 'https://lmstudio.ai/',                              port: 1234  },
  { id: 'jan',       name: 'Jan',                  description: 'Open-source desktop app. Simple UI, offline-first.',                     url: 'https://jan.ai/',                                   port: 1337  },
  { id: 'gpt4all',   name: 'GPT4All',             description: 'Desktop app by Nomic. CPU-friendly, no GPU needed.',                     url: 'https://www.nomic.ai/gpt4all',                      port: 4891  },
  { id: 'koboldcpp', name: 'KoboldCpp',           description: 'Single executable. GGUF models, GPU + CPU hybrid.',                      url: 'https://github.com/LostRuins/koboldcpp',            port: 5001  },
  { id: 'llamacpp',  name: 'llama.cpp',           description: 'Minimal C++ inference. Low-level, maximum control.',                      url: 'https://github.com/ggerganov/llama.cpp',            port: 8080  },
  { id: 'vllm',      name: 'vLLM',                description: 'High-throughput serving. Best for multi-GPU setups.',                     url: 'https://github.com/vllm-project/vllm',              port: 8000  },
  { id: 'localai',   name: 'LocalAI',             description: 'Drop-in OpenAI replacement. Supports text, image, audio.',               url: 'https://localai.io/',                               port: 8080  },
  { id: 'oobabooga', name: 'text-generation-webui', description: 'Feature-rich web UI. Extensive model format support.',                  url: 'https://github.com/oobabooga/text-generation-webui', port: 5000  },
  { id: 'tabbyapi',  name: 'TabbyAPI',            description: 'ExLlamaV2-based. Fast inference with EXL2 quants.',                       url: 'https://github.com/theroyallab/tabbyAPI',           port: 5000  },
  { id: 'aphrodite', name: 'Aphrodite',           description: 'vLLM fork with extras. SillyTavern compatible.',                          url: 'https://github.com/PygmalionAI/aphrodite-engine',   port: 2242  },
  { id: 'sglang',    name: 'SGLang',              description: 'Structured generation. Optimized for complex prompts.',                   url: 'https://github.com/sgl-project/sglang',             port: 30000 },
]

export function Onboarding() {
  const [step, setStep] = useState<Step>('welcome')
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const { settings, updateSettings } = useSettingsStore()
  const { pullModel, pausePull, isPulling, activePulls, models: installedModels } = useModels()
  const [pullingModel, setPullingModel] = useState<string | null>(null)
  const [pulledModels, setPulledModels] = useState<string[]>([])
  const [detectedBackends, setDetectedBackends] = useState<DetectedBackend[]>([])
  const [detecting, setDetecting] = useState(false)
  const [selectedBackend, setSelectedBackend] = useState<string>('')
  const { setProviderConfig } = useProviderStore()

  // ComfyUI step state
  const [comfyDetecting, setComfyDetecting] = useState(false)
  const [comfyFound, setComfyFound] = useState<{ found: boolean; path?: string } | null>(null)
  const [comfyInstalling, setComfyInstalling] = useState(false)
  const [comfyInstallLogs, setComfyInstallLogs] = useState<string[]>([])
  const [comfyInstallError, setComfyInstallError] = useState('')
  const [comfyPathInput, setComfyPathInput] = useState('')
  const [comfyReady, setComfyReady] = useState(false)
  const [systemVRAM, setSystemVRAM] = useState<number | null>(null)
  const [modelSubTab, setModelSubTab] = useState<'uncensored' | 'mainstream'>('uncensored')

  const isDark = settings.theme === 'dark'
  const bgClass = isDark ? 'bg-[#0a0a0a] text-white' : 'bg-white text-gray-900'
  const cardClass = isDark ? 'bg-[#141414] border-white/[0.08]' : 'bg-gray-50 border-gray-200'

  const toggleModel = (name: string) => {
    setSelectedModels((prev) =>
      prev.includes(name) ? prev.filter((m) => m !== name) : [...prev, name]
    )
  }

  const handlePullSelected = async () => {
    for (const name of selectedModels) {
      if (pulledModels.includes(name)) continue
      setPullingModel(name)
      await pullModel(name)
      setPulledModels((prev) => [...prev, name])
    }
    setPullingModel(null)
    setStep('done')
  }

  const finish = () => {
    updateSettings({ onboardingDone: true })
  }

  /* ── Scan for backends ──────────────────────────────────── */
  const runDetection = () => {
    setDetecting(true)
    detectLocalBackends().then((backends) => {
      setDetectedBackends(backends)
      if (backends.length > 0 && !selectedBackend) {
        setSelectedBackend(backends[0].id)
      }
      setDetecting(false)
    })
  }

  // Detect system VRAM for model filtering
  useEffect(() => { getSystemVRAM().then(v => setSystemVRAM(v)).catch(() => {}) }, [])

  // Auto-detect ComfyUI when entering the comfyui step
  useEffect(() => {
    if (step === 'comfyui' && !comfyFound && !comfyDetecting) {
      setComfyDetecting(true)
      backendCall<{ found: boolean; path?: string }>('find_comfyui')
        .then(result => {
          setComfyFound(result)
          if (result.found) setComfyReady(true)
        })
        .catch(() => setComfyFound({ found: false }))
        .finally(() => setComfyDetecting(false))
    }
  }, [step])

  const currentPull = pullingModel ? activePulls[pullingModel] : null
  const pullProgress = currentPull?.progress ?? null
  const progress =
    pullProgress?.total && pullProgress?.completed
      ? (pullProgress.completed / pullProgress.total) * 100
      : 0

  const hasOllama = detectedBackends.some(b => b.id === 'ollama')

  // Shared button styles
  const primaryBtn = `mx-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.7rem] font-medium transition-all ${
    isDark ? 'bg-white text-black hover:bg-gray-200' : 'bg-gray-900 text-white hover:bg-gray-800'
  }`
  const secondaryBtn = `mx-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.7rem] font-medium transition-all ${
    isDark ? 'bg-white/10 text-white hover:bg-white/15' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
  }`

  const handleMinimize = async () => { const { getCurrentWindow } = await import('@tauri-apps/api/window'); getCurrentWindow().minimize() }
  const handleMaximize = async () => { const { getCurrentWindow } = await import('@tauri-apps/api/window'); getCurrentWindow().toggleMaximize() }
  const handleClose = async () => { const { getCurrentWindow } = await import('@tauri-apps/api/window'); getCurrentWindow().close() }
  const winBtn = 'inline-flex items-center justify-center w-[46px] h-8 transition-colors text-gray-400 hover:text-gray-200'

  const stepIndex = STEP_ORDER.indexOf(step)

  return (
    <div className={`h-screen w-screen flex items-center justify-center p-4 ${bgClass}`}>
      {/* Drag region + window controls */}
      {isTauri && (
        <div data-tauri-drag-region className="fixed top-0 left-0 right-0 h-8 z-50 flex items-center justify-end select-none">
          <button onClick={handleMinimize} className={winBtn} aria-label="Minimize"><Minus size={14} strokeWidth={1.5} /></button>
          <button onClick={handleMaximize} className={winBtn} aria-label="Maximize"><Square size={11} strokeWidth={1.5} /></button>
          <button onClick={handleClose} className={`${winBtn} hover:bg-red-500 hover:text-white`} aria-label="Close"><XIcon size={14} strokeWidth={1.5} /></button>
        </div>
      )}

      {/* Step indicator dots */}
      <div className="fixed top-10 left-1/2 -translate-x-1/2 z-40 flex gap-1.5">
        {STEP_ORDER.map((s, i) => (
          <div key={s} className={`w-1.5 h-1.5 rounded-full transition-colors ${i <= stepIndex ? (isDark ? 'bg-white' : 'bg-gray-900') : (isDark ? 'bg-white/15' : 'bg-gray-300')}`} />
        ))}
      </div>

      <AnimatePresence mode="wait">
        {/* Step 1: Welcome */}
        {step === 'welcome' && (
          <motion.div
            key="welcome"
            className="max-w-sm w-full text-center space-y-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <h1 className="text-base font-semibold">Locally Uncensored</h1>
            <p className={`text-[0.75rem] leading-relaxed ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              Private, local AI chat. No servers, no tracking, everything stays on your machine.
            </p>
            <button onClick={() => setStep('theme')} className={primaryBtn}>
              Get Started <ArrowRight size={14} />
            </button>
          </motion.div>
        )}

        {/* Step 2: Theme */}
        {step === 'theme' && (
          <motion.div
            key="theme"
            className="max-w-sm w-full text-center space-y-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <h2 className="text-base font-semibold">Choose your theme</h2>
            <p className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>You can change this later in settings.</p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => updateSettings({ theme: 'light' })}
                className={`flex flex-col items-center gap-2 p-4 rounded-lg border transition-all w-28 ${
                  !isDark ? 'border-gray-900 bg-gray-50' : 'border-white/10 hover:border-white/20'
                }`}
              >
                <div className="w-4 h-4 rounded-full bg-white border border-gray-300" />
                <span className="text-[0.7rem] font-medium">Light</span>
              </button>
              <button
                onClick={() => updateSettings({ theme: 'dark' })}
                className={`flex flex-col items-center gap-2 p-4 rounded-lg border transition-all w-28 ${
                  isDark ? 'border-white bg-white/10' : 'border-gray-200 hover:border-gray-400'
                }`}
              >
                <div className="w-4 h-4 rounded-full bg-[#050505]" />
                <span className="text-[0.7rem] font-medium">Dark</span>
              </button>
            </div>
            <button
              onClick={() => {
                setStep('backends')
                runDetection()
              }}
              className={primaryBtn}
            >
              Next <ArrowRight size={14} />
            </button>
          </motion.div>
        )}

        {/* Step 3: Backend Detection */}
        {step === 'backends' && (
          <motion.div
            key="backends"
            className="max-w-md w-full text-center space-y-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            {detecting ? (
              <>
                <Loader2 size={18} className="mx-auto animate-spin text-gray-400" />
                <h2 className="text-base font-semibold">Scanning for local backends...</h2>
                <p className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  Checking {LOCAL_BACKENDS.length} backends on their default ports.
                </p>
              </>
            ) : detectedBackends.length > 0 ? (
              /* ── Backends found ──────────────────────────────── */
              <>
                <h2 className="text-base font-semibold">
                  {detectedBackends.length} backend{detectedBackends.length > 1 ? 's' : ''} detected
                </h2>
                <p className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {detectedBackends.length === 1
                    ? `${detectedBackends[0].name} is running. Select it to connect.`
                    : 'Select which backend to use as your primary. You can add more in Settings.'}
                </p>

                <div className="space-y-1.5 text-left">
                  {detectedBackends.map(b => (
                    <button
                      key={b.id}
                      onClick={() => setSelectedBackend(b.id)}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border text-left transition-all ${
                        selectedBackend === b.id
                          ? isDark ? 'bg-white/10 border-white/20' : 'bg-gray-100 border-gray-900'
                          : isDark ? 'border-white/10 hover:border-white/20' : 'border-gray-200 hover:border-gray-400'
                      }`}
                    >
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        selectedBackend === b.id ? 'bg-green-500' : 'bg-gray-500'
                      }`} />
                      <div>
                        <p className="text-[0.7rem] font-medium">{b.name}</p>
                        <p className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'} font-mono`}>localhost:{b.port}</p>
                      </div>
                    </button>
                  ))}
                </div>

                <div className="flex items-center justify-center gap-2 pt-1">
                  <button onClick={runDetection} className={secondaryBtn} title="Scan again">
                    <RefreshCw size={12} /> Re-Scan
                  </button>
                  <button
                    onClick={() => {
                      const backend = detectedBackends.find(b => b.id === selectedBackend)
                      if (backend) {
                        const preset = PROVIDER_PRESETS.find(p => p.id === backend.id)
                        if (preset && preset.providerId !== 'ollama') {
                          setProviderConfig('openai', {
                            enabled: true,
                            name: backend.name,
                            baseUrl: backend.baseUrl,
                            isLocal: true,
                          })
                        }
                      }
                      // Go to ComfyUI step next
                      setStep('comfyui')
                    }}
                    className={primaryBtn}
                  >
                    Continue <ArrowRight size={14} />
                  </button>
                </div>
              </>
            ) : (
              /* ── No backends found — show all options ─────── */
              <>
                <h2 className="text-base font-semibold">No local backend detected</h2>
                <p className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  Install any of these local AI backends, then hit Re-Scan. Pick whichever you prefer — they all work.
                </p>

                <div className="space-y-1 text-left max-h-[45vh] overflow-y-auto scrollbar-thin pr-1">
                  {LOCAL_BACKENDS.map(b => (
                    <button
                      key={b.id}
                      onClick={() => openExternal(b.url)}
                      className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg border transition-all group text-left ${
                        isDark
                          ? 'border-white/[0.06] hover:border-white/15 hover:bg-white/[0.03]'
                          : 'border-gray-200 hover:border-gray-400 hover:bg-gray-50'
                      }`}
                    >
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isDark ? 'bg-gray-600' : 'bg-gray-300'}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-[0.7rem] font-medium">{b.name}</p>
                          <ExternalLink size={10} className={`opacity-0 group-hover:opacity-100 transition-opacity ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
                        </div>
                        <p className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{b.description}</p>
                      </div>
                      <span className={`text-[0.5rem] font-mono shrink-0 ${isDark ? 'text-gray-600' : 'text-gray-300'}`}>:{b.port}</span>
                    </button>
                  ))}
                </div>

                <div className="flex items-center justify-center gap-2 pt-1">
                  <button onClick={runDetection} className={secondaryBtn}>
                    <RefreshCw size={12} /> Re-Scan
                  </button>
                  <button onClick={() => setStep('comfyui')} className={`${secondaryBtn} opacity-60`}>
                    Skip for now <ChevronRight size={12} />
                  </button>
                </div>
              </>
            )}
          </motion.div>
        )}

        {/* Step 4: ComfyUI Setup */}
        {step === 'comfyui' && (
          <motion.div
            key="comfyui"
            className="max-w-md w-full text-center space-y-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <div className="w-3 h-3 rounded-full bg-purple-400 mx-auto" />
            <h2 className="text-base font-semibold">Image & Video Generation</h2>
            <p className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              Generate images and videos right from the app. We'll set everything up for you.
            </p>

            {/* Auto-detecting */}
            {comfyDetecting && (
              <div className="flex items-center justify-center gap-2">
                <Loader2 size={14} className="animate-spin text-gray-400" />
                <span className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Looking for ComfyUI...</span>
              </div>
            )}

            {/* Found */}
            {comfyFound?.found && !comfyInstalling && (
              <div className={`p-3 rounded-lg border ${isDark ? 'bg-green-500/10 border-green-500/20' : 'bg-green-50 border-green-200'}`}>
                <div className="flex items-center gap-2 justify-center">
                  <Check size={14} className="text-green-400" />
                  <span className="text-[0.7rem] font-medium">ComfyUI detected</span>
                </div>
                <p className={`text-[0.55rem] font-mono mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{comfyFound.path}</p>
              </div>
            )}

            {/* Not found — install options */}
            {comfyFound && !comfyFound.found && !comfyInstalling && !comfyReady && (
              <div className="space-y-2">
                <button
                  onClick={async () => {
                    setComfyInstalling(true)
                    setComfyInstallError('')
                    setComfyInstallLogs(['Starting ComfyUI installation...'])
                    try {
                      await backendCall('install_comfyui')
                      // Poll installation status
                      const poll = setInterval(async () => {
                        try {
                          const status: any = await backendCall('install_comfyui_status')
                          setComfyInstallLogs(status.logs || [])
                          if (status.status === 'complete' || status.status === 'done') {
                            clearInterval(poll)
                            setComfyInstalling(false)
                            setComfyReady(true)
                            // Auto-start ComfyUI
                            try { await backendCall('start_comfyui') } catch {}
                          } else if (status.status === 'error') {
                            clearInterval(poll)
                            setComfyInstalling(false)
                            setComfyInstallError('Installation failed. Check logs below.')
                          }
                        } catch { /* keep polling */ }
                      }, 2000)
                    } catch (err) {
                      setComfyInstalling(false)
                      setComfyInstallError(err instanceof Error ? err.message : 'Installation failed')
                    }
                  }}
                  className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[0.7rem] font-medium transition-all ${
                    isDark ? 'bg-white text-black hover:bg-gray-200' : 'bg-gray-900 text-white hover:bg-gray-800'
                  }`}
                >
                  <Download size={14} /> Install ComfyUI (Recommended)
                </button>
                <button
                  onClick={() => {
                    const input = document.createElement('input')
                    input.type = 'text'
                    // Show path input inline
                    setComfyPathInput('')
                    setComfyFound({ found: false })
                  }}
                  className={secondaryBtn}
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  <FolderOpen size={14} /> I already have ComfyUI
                </button>

                {/* Manual path input */}
                {comfyPathInput !== undefined && (
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={comfyPathInput}
                      onChange={e => setComfyPathInput(e.target.value)}
                      placeholder="C:\ComfyUI"
                      className={`flex-1 px-2 py-1.5 rounded-lg border text-[0.65rem] font-mono ${
                        isDark ? 'bg-black border-white/10 text-white' : 'bg-white border-gray-300 text-gray-900'
                      }`}
                    />
                    <button
                      onClick={async () => {
                        if (!comfyPathInput.trim()) return
                        try {
                          await backendCall('set_comfyui_path', { path: comfyPathInput.trim() })
                          setComfyReady(true)
                          try { await backendCall('start_comfyui') } catch {}
                        } catch (err) {
                          setComfyInstallError(err instanceof Error ? err.message : 'Invalid path')
                        }
                      }}
                      className={primaryBtn}
                    >
                      Connect
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Installing progress */}
            {comfyInstalling && (
              <div className={`p-3 rounded-lg border ${cardClass} text-left`}>
                <div className="flex items-center gap-2 mb-2">
                  <Loader2 size={14} className="animate-spin text-purple-400" />
                  <span className="text-[0.7rem] font-medium">Installing ComfyUI...</span>
                </div>
                <div className={`text-[0.55rem] font-mono max-h-24 overflow-y-auto space-y-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  {comfyInstallLogs.slice(-8).map((log, i) => (
                    <p key={i}>{log}</p>
                  ))}
                </div>
              </div>
            )}

            {/* Error */}
            {comfyInstallError && (
              <p className="text-[0.65rem] text-red-400">{comfyInstallError}</p>
            )}

            {/* Ready state */}
            {comfyReady && (
              <div className={`p-3 rounded-lg border ${isDark ? 'bg-green-500/10 border-green-500/20' : 'bg-green-50 border-green-200'}`}>
                <div className="flex items-center gap-2 justify-center">
                  <Check size={14} className="text-green-400" />
                  <span className="text-[0.7rem] font-medium">ComfyUI is ready</span>
                </div>
              </div>
            )}

            <div className="flex items-center justify-center gap-2 pt-1">
              {(comfyFound?.found || comfyReady) && (
                <button
                  onClick={() => hasOllama ? setStep('models') : setStep('done')}
                  className={primaryBtn}
                >
                  Continue <ArrowRight size={14} />
                </button>
              )}
              {!comfyInstalling && !comfyFound?.found && !comfyReady && (
                <>
                  <button
                    onClick={() => {
                      setComfyDetecting(true)
                      setComfyFound(null)
                      backendCall<{ found: boolean; path?: string }>('find_comfyui')
                        .then(result => { setComfyFound(result); if (result.found) setComfyReady(true) })
                        .catch(() => setComfyFound({ found: false }))
                        .finally(() => setComfyDetecting(false))
                    }}
                    className={secondaryBtn}
                  >
                    <RefreshCw size={12} /> Re-Scan
                  </button>
                  <button
                    onClick={() => hasOllama ? setStep('models') : setStep('done')}
                    className={`${secondaryBtn} opacity-60`}
                  >
                    Skip for now <ChevronRight size={12} />
                  </button>
                </>
              )}
            </div>
          </motion.div>
        )}

        {/* Step 5: Models (Ollama only — pull models) */}
        {step === 'models' && (
          <motion.div
            key="models"
            className="max-w-xl w-full space-y-3"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <div className="text-center mb-3">
              <h2 className="text-base font-semibold mb-1">Choose your models</h2>
              <p className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {systemVRAM ? `Showing models for your ${systemVRAM} GB GPU.` : 'Select models to install.'} You can add more later.
              </p>
            </div>

            {/* Uncensored / Mainstream tabs */}
            <div className="flex gap-4 justify-center">
              <button onClick={() => setModelSubTab('uncensored')} className={`flex items-center gap-2 transition-all ${modelSubTab === 'uncensored' ? 'opacity-100' : 'opacity-40 hover:opacity-70'}`}>
                <div className={`w-1 h-4 rounded-full ${modelSubTab === 'uncensored' ? 'bg-red-500' : 'bg-red-500/50'}`} />
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider">Uncensored</span>
              </button>
              <button onClick={() => setModelSubTab('mainstream')} className={`flex items-center gap-2 transition-all ${modelSubTab === 'mainstream' ? 'opacity-100' : 'opacity-40 hover:opacity-70'}`}>
                <div className={`w-1 h-4 rounded-full ${modelSubTab === 'mainstream' ? 'bg-blue-500' : 'bg-blue-500/50'}`} />
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider">Mainstream</span>
              </button>
            </div>

            {isPulling && pullingModel && (
              <div className={`p-2.5 rounded-lg border ${cardClass}`}>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[0.7rem]">
                    Installing <span className="font-mono font-medium">{pullingModel}</span>...
                  </p>
                  <button
                    onClick={() => pullingModel && pausePull(pullingModel)}
                    className="p-0.5 rounded hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors"
                    title="Pause download"
                  >
                    <Pause size={12} />
                  </button>
                </div>
                <p className={`text-[0.6rem] mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{pullProgress?.status}</p>
                {pullProgress?.total && pullProgress?.completed !== undefined && (
                  <ProgressBar progress={progress} />
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[50vh] overflow-y-auto scrollbar-thin pr-1">
              {ONBOARDING_MODELS.filter(m => {
                // Filter by tab
                if (modelSubTab === 'uncensored' && !m.uncensored) return false
                if (modelSubTab === 'mainstream' && m.uncensored) return false
                // Filter by VRAM if known
                if (systemVRAM && m.vramGB > systemVRAM) return false
                return true
              }).map((model) => {
                const selected = selectedModels.includes(model.name)
                const pulled = pulledModels.includes(model.name) || installedModels.some((m) => m.name === model.name)
                return (
                  <button
                    key={model.name}
                    onClick={() => !pulled && !isPulling && toggleModel(model.name)}
                    disabled={pulled || isPulling}
                    className={`text-left p-2.5 rounded-lg border transition-all ${
                      pulled
                        ? isDark ? 'bg-green-500/10 border-green-500/30' : 'bg-green-50 border-green-300'
                        : selected
                        ? isDark ? 'bg-white/10 border-white/30' : 'bg-gray-100 border-gray-900'
                        : isDark ? 'border-white/10 hover:border-white/20' : 'border-gray-200 hover:border-gray-400'
                    } ${isPulling ? 'opacity-60' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-[0.7rem]">{model.label}</span>
                          {model.recommended && (
                            <span className={`text-[0.5rem] px-1 py-0.5 rounded ${isDark ? 'bg-white/10 text-gray-300' : 'bg-gray-200 text-gray-600'}`}>
                              Recommended
                            </span>
                          )}
                          {model.agent && (
                            <span className={`text-[0.5rem] px-1 py-0.5 rounded ${isDark ? 'bg-green-500/15 text-green-400 border border-green-500/30' : 'bg-green-50 text-green-700 border border-green-200'}`}>
                              Tool Calling
                            </span>
                          )}
                        </div>
                        <p className={`text-[0.6rem] mt-0.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{model.description}</p>
                        <p className={`text-[0.55rem] mt-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                          {model.size} · VRAM: {model.vram}
                        </p>
                      </div>
                      {pulled ? (
                        <Check size={14} className="text-green-400 shrink-0 mt-0.5" />
                      ) : selected ? (
                        <div className={`w-4 h-4 rounded flex items-center justify-center shrink-0 mt-0.5 ${isDark ? 'bg-white' : 'bg-gray-900'}`}>
                          <Check size={10} className={isDark ? 'text-black' : 'text-white'} />
                        </div>
                      ) : (
                        <div className={`w-4 h-4 rounded border shrink-0 mt-0.5 ${isDark ? 'border-white/20' : 'border-gray-300'}`} />
                      )}
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="flex items-center gap-2 pt-1">
              {selectedModels.length > 0 && !isPulling ? (
                <button
                  onClick={handlePullSelected}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.7rem] font-medium transition-all ${
                    isDark ? 'bg-white text-black hover:bg-gray-200' : 'bg-gray-900 text-white hover:bg-gray-800'
                  }`}
                >
                  <Download size={14} /> Install {selectedModels.length} model{selectedModels.length > 1 ? 's' : ''}
                </button>
              ) : !isPulling ? (
                <button
                  onClick={() => setStep('done')}
                  className={`flex-1 flex items-center justify-center gap-1.5 ${secondaryBtn}`}
                >
                  Skip for now <ChevronRight size={14} />
                </button>
              ) : null}
            </div>
          </motion.div>
        )}

        {/* Step 5: Done */}
        {step === 'done' && (
          <motion.div
            key="done"
            className="max-w-sm w-full text-center space-y-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <div className="w-3 h-3 rounded-full bg-green-400 mx-auto" />
            <h2 className="text-base font-semibold">You're all set!</h2>
            <p className={`text-[0.75rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {pulledModels.length > 0
                ? `${pulledModels.length} model${pulledModels.length > 1 ? 's' : ''} installed. You're ready to go.`
                : detectedBackends.length > 0
                ? `Connected to ${detectedBackends.find(b => b.id === selectedBackend)?.name || detectedBackends[0].name}. You're ready to go.`
                : 'You can configure backends and install models anytime from Settings and Model Manager.'}
            </p>
            <button onClick={finish} className={primaryBtn}>
              Get Started <ArrowRight size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
