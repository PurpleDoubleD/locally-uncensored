import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Minus, Square, Copy, X as XIcon, ArrowRight, Download, Check, ChevronRight, Loader2, RefreshCw, ExternalLink, FolderOpen } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { ONBOARDING_MODELS, type OnboardingModel } from '../../lib/constants'
import { PROVIDER_PRESETS } from '../../api/providers/types'
import { detectLocalBackends, type DetectedBackend } from '../../lib/backend-detector'
import { detectProviderModelPath, startModelDownloadToPath } from '../../api/discover'
import { useDownloadStore } from '../../stores/downloadStore'
import { ProgressBar } from '../ui/ProgressBar'
import { openExternal } from '../../api/backend'
import { formatBytes } from '../../lib/formatters'
import { backendCall } from '../../api/backend'
import { getSystemVRAM } from '../../api/comfyui'
import { pullModelTauri, checkConnection as checkOllama } from '../../api/ollama'
import { hfUrlToOllamaRef, hfUrlToLmStudioSubdir } from '../../lib/hf-to-provider'

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
  const downloads = useDownloadStore(s => s.downloads)
  const dlStore = useDownloadStore
  const [pullingModel, setPullingModel] = useState<string | null>(null)
  const [pulledModels, setPulledModels] = useState<string[]>([])
  const [hfModelPath, setHfModelPath] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [detectedBackends, setDetectedBackends] = useState<DetectedBackend[]>([])
  const [detecting, setDetecting] = useState(false)
  const [selectedBackend, setSelectedBackend] = useState<string>('')
  const { setProviderConfig } = useProviderStore()

  // ComfyUI step state. `comfyFound.complete` distinguishes a working
  // install from a half-cloned carcass — see is_comfyui_install_complete in
  // process.rs. UI uses `complete:false` to surface a Re-install option
  // instead of "ComfyUI detected, Continue".
  const [comfyDetecting, setComfyDetecting] = useState(false)
  const [comfyFound, setComfyFound] = useState<{ found: boolean; path?: string; complete?: boolean } | null>(null)
  const [comfyInstalling, setComfyInstalling] = useState(false)
  const [comfyInstallLogs, setComfyInstallLogs] = useState<string[]>([])
  const [comfyInstallError, setComfyInstallError] = useState('')
  const [comfyPathInput, setComfyPathInput] = useState('')
  const [comfyReady, setComfyReady] = useState(false)
  const [comfyDownloadProgress, setComfyDownloadProgress] = useState(0)
  const [comfyDownloadTotal, setComfyDownloadTotal] = useState(0)
  const [comfyDownloadSpeed, setComfyDownloadSpeed] = useState(0)

  // P14: Python install state. On a fresh Windows box `python` is the
  // Microsoft Store stub which exit-1's `pip install`. The ComfyUI install
  // pre-flight runs `python_check`; if Python is missing we kick off
  // `install_python` (winget Python.Python.3.12) and poll its status here
  // before re-firing `install_comfyui`.
  const [pythonInstalling, setPythonInstalling] = useState(false)
  const [pythonInstallLogs, setPythonInstallLogs] = useState<string[]>([])
  const [pythonInstallError, setPythonInstallError] = useState('')
  const [pythonReady, setPythonReady] = useState(false)
  const [pythonStartTime, setPythonStartTime] = useState<number | null>(null)
  const [pythonElapsed, setPythonElapsed] = useState(0)
  const [systemVRAM, setSystemVRAM] = useState<number | null>(null)
  const [modelSubTab, setModelSubTab] = useState<'uncensored' | 'mainstream'>('uncensored')
  const [installStartTime, setInstallStartTime] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)

  // Ollama install state
  const [ollamaInstalling, setOllamaInstalling] = useState(false)
  const [ollamaStatus, setOllamaStatus] = useState('')
  const [ollamaProgress, setOllamaProgress] = useState(0)
  const [ollamaTotal, setOllamaTotal] = useState(0)
  const [ollamaSpeed, setOllamaSpeed] = useState(0)
  const [ollamaLogs, setOllamaLogs] = useState<string[]>([])
  const [ollamaError, setOllamaError] = useState('')
  const [ollamaReady, setOllamaReady] = useState(false)
  const [ollamaStartTime, setOllamaStartTime] = useState<number | null>(null)
  const [ollamaElapsed, setOllamaElapsed] = useState(0)

  // LM Studio install state — same shape as Ollama; both can show their
  // own progress card if the user picks both. In practice they pick one.
  const [lmstudioInstalling, setLmstudioInstalling] = useState(false)
  const [lmstudioStatus, setLmstudioStatus] = useState('')
  const [lmstudioProgress, setLmstudioProgress] = useState(0)
  const [lmstudioTotal, setLmstudioTotal] = useState(0)
  const [lmstudioSpeed, setLmstudioSpeed] = useState(0)
  const [lmstudioLogs, setLmstudioLogs] = useState<string[]>([])
  const [lmstudioError, setLmstudioError] = useState('')
  const [lmstudioReady, setLmstudioReady] = useState(false)
  const [lmstudioStartTime, setLmstudioStartTime] = useState<number | null>(null)
  const [lmstudioElapsed, setLmstudioElapsed] = useState(0)

  const isDark = settings.theme === 'dark'
  const bgClass = isDark ? 'bg-[#0a0a0a] text-white' : 'bg-white text-gray-900'
  const cardClass = isDark ? 'bg-[#141414] border-white/[0.08]' : 'bg-gray-50 border-gray-200'

  const toggleModel = (name: string) => {
    setSelectedModels((prev) =>
      prev.includes(name) ? prev.filter((m) => m !== name) : [...prev, name]
    )
  }

  const handleDownloadSelected = async () => {
    setDownloadError(null)
    const providers = useProviderStore.getState().providers

    // Decide which backend the download has to feed. selectedBackend (set in
    // the backends step) is the strongest signal; ollamaReady covers the
    // "we just installed Ollama in-app" path; final fallback is the first
    // detected backend, defaulting to ollama. The earlier code wrote a raw
    // .gguf into `~/.ollama/models` regardless — Ollama ignores files placed
    // there directly, which is the root cause of the "downloaded model
    // never appears" bug reported on Discord and GH discussion #35.
    const targetBackend = selectedBackend || (ollamaReady ? 'ollama' : detectedBackends[0]?.id) || 'ollama'
    const useOllamaPath = targetBackend === 'ollama'

    // Sanity-check / auto-start Ollama before pulling. The pull command will
    // otherwise spin in "connecting" with no actionable error if the daemon
    // isn't reachable.
    if (useOllamaPath && isTauri) {
      let ok = await checkOllama()
      if (!ok) {
        try { await backendCall('start_ollama') } catch { /* fall through to retry loop */ }
        for (let i = 0; i < 20 && !ok; i++) {
          await new Promise(r => setTimeout(r, 250))
          ok = await checkOllama()
        }
      }
      if (!ok) {
        setDownloadError('Cannot reach Ollama (localhost:11434). Open the Ollama app or run `ollama serve`, then retry.')
        return
      }
    }

    // Direct-write providers (LM Studio etc.) still need a base dir.
    let destDir: string | null = null
    if (!useOllamaPath) {
      const settingsOverride = useSettingsStore.getState().settings.hfDownloadPathOverride?.trim() || ''
      destDir = settingsOverride || hfModelPath || (await detectProviderModelPath(providers.openai?.name || 'LM Studio'))
      if (!destDir) {
        setDownloadError('Could not determine model directory. Please check app permissions, or set a custom path in Settings → Models.')
        return
      }
      setHfModelPath(destDir)
    }

    for (const name of selectedModels) {
      if (pulledModels.includes(name)) continue
      const model = ONBOARDING_MODELS.find(m => m.name === name)
      if (!model?.downloadUrl || !model?.filename) continue

      setPullingModel(name)
      try {
        if (useOllamaPath) {
          // Ollama: HF URL → `hf.co/<user>/<repo>:<quant>` → /api/pull. Ollama
          // materialises the GGUF into its own blob+manifest store; the file
          // appears in `ollama list` (and therefore in our model manager) the
          // moment the pull finishes — no separate scanner involved.
          const ollamaRef = hfUrlToOllamaRef(model.downloadUrl, model.filename)
          if (!ollamaRef) {
            setDownloadError(`Cannot derive an Ollama reference for ${model.label}. Try LM Studio instead.`)
            continue
          }

          // Seed an entry in the download store so the existing onboarding
          // progress UI keeps working. Translation from PullProgress (Ollama)
          // → DownloadProgress (LU) below.
          dlStore.getState().setMeta(model.filename, model.downloadUrl, 'ollama')
          useDownloadStore.setState(s => ({
            downloads: {
              ...s.downloads,
              [model.filename!]: {
                progress: 0, total: 0, speed: 0,
                filename: model.filename!,
                status: 'connecting',
              },
            },
          }))

          const { promise } = pullModelTauri(ollamaRef, (p) => {
            const total = p.total || 0
            const completed = p.completed || 0
            const status = (p.status || '').toLowerCase()
            const isComplete = status.includes('success') || status === 'complete'
            useDownloadStore.setState(s => ({
              downloads: {
                ...s.downloads,
                [model.filename!]: {
                  progress: completed, total,
                  speed: 0,
                  filename: model.filename!,
                  status: isComplete ? 'complete' : 'downloading',
                },
              },
            }))
          })
          await promise
          // Mark complete in case the final progress event didn't include
          // a "success" status string (Ollama varies between versions).
          useDownloadStore.getState().markComplete(model.filename)
        } else {
          // LM Studio etc.: nest under <user>/<repo>/ so the scanner finds
          // it. A bare .gguf in the model root is silently ignored by LM
          // Studio's library — the second half of the same Discord bug.
          const subdir = hfUrlToLmStudioSubdir(model.downloadUrl)
          const targetDir = subdir ? `${destDir}/${subdir}` : destDir!
          dlStore.getState().setMeta(model.filename, model.downloadUrl, 'gguf', targetDir)
          const expectedBytes = model.sizeGB ? Math.round(model.sizeGB * 1_073_741_824) : undefined
          await startModelDownloadToPath(model.downloadUrl, targetDir, model.filename, expectedBytes)
          dlStore.getState().startPolling()
        }
        setPulledModels(prev => [...prev, name])
      } catch (e) {
        setDownloadError(`Download failed for ${model.label}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setPullingModel(null)
    // Tell the rest of the app the model list changed — Model Manager,
    // Chat picker, etc. listen for this and re-fetch.
    window.dispatchEvent(new CustomEvent('lu-models-refresh'))
    setStep('done')
  }

  const finish = () => {
    updateSettings({ onboardingDone: true })
    // Persist to filesystem so NSIS updates don't reset onboarding
    if (isTauri) backendCall('set_onboarding_done').catch(() => {})
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

  // Count models the user already has installed across all backends. Used to
  // skip the model-picker step entirely when they're not a fresh install —
  // a reinstaller / upgrader doesn't need a starter recommendation, and
  // showing one is just nagging.
  const [existingModelCount, setExistingModelCount] = useState<number | null>(null)
  useEffect(() => {
    if (step !== 'models') return
    let cancelled = false
    import('../../api/ollama').then(({ listModels }) =>
      listModels()
        .then(models => { if (!cancelled) setExistingModelCount(models.length) })
        .catch(() => { if (!cancelled) setExistingModelCount(0) })
    )
    return () => { cancelled = true }
  }, [step])

  // Auto-skip the model step when the user already has installed models
  // (P4 LU-Aufgaben: "Nur wenn der User noch gar kein Modell installiert hat.
  // Sonst nirgendwo mehr 'Recommended'-Empfehlungen"). null = still loading,
  // 0 = fresh, >0 = experienced — only the first two should see the picker.
  useEffect(() => {
    if (step === 'models' && existingModelCount !== null && existingModelCount > 0) {
      setStep('done')
    }
  }, [step, existingModelCount])

  const showRecommendedBadge = existingModelCount === 0

  // Elapsed timer for ComfyUI installation
  useEffect(() => {
    if (!installStartTime) return
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - installStartTime) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [installStartTime])

  // Elapsed timer for Ollama installation
  useEffect(() => {
    if (!ollamaStartTime) return
    const timer = setInterval(() => setOllamaElapsed(Math.floor((Date.now() - ollamaStartTime) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [ollamaStartTime])

  // Elapsed timer for LM Studio installation
  useEffect(() => {
    if (!lmstudioStartTime) return
    const timer = setInterval(() => setLmstudioElapsed(Math.floor((Date.now() - lmstudioStartTime) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [lmstudioStartTime])

  // Elapsed timer for Python installation (P14). winget pulls the Python
  // 3.12 installer (~30 MB) and runs it silently; on a typical home
  // connection this is ~30–60 s, but slow links can take a few minutes.
  useEffect(() => {
    if (!pythonStartTime) return
    const timer = setInterval(() => setPythonElapsed(Math.floor((Date.now() - pythonStartTime) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [pythonStartTime])

  // Auto-detect ComfyUI when entering the comfyui step. We mark the install
  // as "ready" (=> Continue button) only when both `found` AND `complete`
  // are true. A `found && !complete` carcass (P14) keeps the install option
  // visible so the user can re-trigger and let LU rebuild torch/deps.
  useEffect(() => {
    if (step === 'comfyui' && !comfyFound && !comfyDetecting) {
      setComfyDetecting(true)
      backendCall<{ found: boolean; path?: string; complete?: boolean }>('find_comfyui')
        .then(result => {
          setComfyFound(result)
          if (result.found && result.complete !== false) setComfyReady(true)
        })
        .catch(() => setComfyFound({ found: false, complete: false }))
        .finally(() => setComfyDetecting(false))
    }
  }, [step])

  // P14 pre-flight: ensure Python is on the box before triggering ComfyUI's
  // pip install. On fresh Windows, `python` is the Microsoft Store stub
  // and pip silently exit-1's, leaving a carcass on disk and a
  // "not responding" message in the UI. Returns true once Python is ready.
  // If Python is already installed, this is a no-op single round trip.
  const ensurePythonInstalled = async (): Promise<boolean> => {
    try {
      const probe = await backendCall<{ available: boolean; path?: string | null }>('python_check')
      if (probe?.available) return true
    } catch {
      // Treat as "not available" and continue to install.
    }

    setPythonInstalling(true)
    setPythonInstallError('')
    setPythonInstallLogs(['Installing Python 3.12 via winget…'])
    setPythonStartTime(Date.now())
    setPythonElapsed(0)

    try {
      await backendCall('install_python')
    } catch (err) {
      setPythonInstalling(false)
      setPythonStartTime(null)
      setPythonInstallError(err instanceof Error ? err.message : 'Python install failed to start')
      return false
    }

    return await new Promise<boolean>((resolve) => {
      const poll = setInterval(async () => {
        try {
          const status: any = await backendCall('install_python_status')
          setPythonInstallLogs(status.logs || [])
          if (status.status === 'complete' || status.status === 'already_installed') {
            clearInterval(poll)
            setPythonInstalling(false)
            setPythonReady(true)
            setPythonStartTime(null)
            resolve(true)
          } else if (status.status === 'error') {
            clearInterval(poll)
            setPythonInstalling(false)
            setPythonStartTime(null)
            const lastLog = status.logs?.[status.logs.length - 1] || 'Python install failed'
            setPythonInstallError(lastLog)
            resolve(false)
          }
        } catch { /* keep polling */ }
      }, 2000)
    })
  }

  // GGUF download progress from downloadStore
  const currentModel = pullingModel ? ONBOARDING_MODELS.find(m => m.name === pullingModel) : null
  const currentDownload = currentModel?.filename ? downloads[currentModel.filename] : null
  const isDownloading = !!pullingModel
  const progress =
    currentDownload?.total && currentDownload?.progress
      ? (currentDownload.progress / currentDownload.total) * 100
      : 0

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
              /* ── No backends found — install Ollama in-app ─────── */
              <>
                <h2 className="text-base font-semibold">No local backend detected</h2>
                <p className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  You need a local AI backend to chat. We'll install Ollama for you — it's the easiest to set up.
                </p>

                {/* Ollama ready state */}
                {ollamaReady && (
                  <div className={`p-3 rounded-lg border ${isDark ? 'bg-green-500/10 border-green-500/20' : 'bg-green-50 border-green-200'}`}>
                    <div className="flex items-center gap-2 justify-center">
                      <Check size={14} className="text-green-400" />
                      <span className="text-[0.7rem] font-medium">Ollama is ready!</span>
                    </div>
                  </div>
                )}

                {/* Install button — only show when not installing and not ready */}
                {!ollamaInstalling && !ollamaReady && (
                  <button
                    onClick={async () => {
                      setOllamaInstalling(true)
                      setOllamaError('')
                      setOllamaStartTime(Date.now())
                      setOllamaElapsed(0)
                      try {
                        await backendCall('install_ollama')
                        const poll = setInterval(async () => {
                          try {
                            const s: any = await backendCall('install_ollama_status')
                            setOllamaStatus(s.status || '')
                            setOllamaLogs(s.logs || [])
                            setOllamaProgress(s.download_progress || 0)
                            setOllamaTotal(s.download_total || 0)
                            setOllamaSpeed(s.download_speed || 0)
                            if (s.status === 'complete') {
                              clearInterval(poll)
                              setOllamaInstalling(false)
                              setOllamaReady(true)
                              setOllamaStartTime(null)
                              // Lock the model-download flow onto Ollama so
                              // GGUFs go through `ollama pull` (which produces
                              // a usable model) instead of a raw .gguf write
                              // (which Ollama then can't see).
                              setSelectedBackend('ollama')
                            } else if (s.status === 'error') {
                              clearInterval(poll)
                              setOllamaInstalling(false)
                              setOllamaStartTime(null)
                              const lastLog = s.logs?.[s.logs.length - 1] || 'Installation failed'
                              setOllamaError(lastLog)
                            }
                          } catch { /* keep polling */ }
                        }, 1000)
                      } catch (err) {
                        setOllamaInstalling(false)
                        setOllamaStartTime(null)
                        setOllamaError(err instanceof Error ? err.message : 'Installation failed')
                      }
                    }}
                    className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-[0.7rem] font-medium transition-all ${
                      isDark ? 'bg-white text-black hover:bg-gray-200' : 'bg-gray-900 text-white hover:bg-gray-800'
                    }`}
                  >
                    <Download size={14} /> Install Ollama
                  </button>
                )}

                {/* Install progress */}
                {ollamaInstalling && (
                  <div className={`p-3 rounded-lg border ${cardClass} text-left`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Loader2 size={14} className="animate-spin text-blue-400" />
                        <span className="text-[0.7rem] font-medium">
                          {ollamaStatus === 'downloading' ? 'Downloading Ollama...' :
                           ollamaStatus === 'installing' ? 'Installing Ollama...' :
                           ollamaStatus === 'starting' ? 'Starting Ollama...' :
                           'Setting up Ollama...'}
                        </span>
                      </div>
                      <span className={`text-[0.55rem] font-mono ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                        {Math.floor(ollamaElapsed / 60)}:{String(ollamaElapsed % 60).padStart(2, '0')}
                      </span>
                    </div>
                    {/* Download progress bar */}
                    {ollamaStatus === 'downloading' && ollamaTotal > 0 && (
                      <div className="space-y-1">
                        <ProgressBar progress={(ollamaProgress / ollamaTotal) * 100} />
                        <div className="flex justify-between">
                          <span className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            {formatBytes(ollamaProgress)} / {formatBytes(ollamaTotal)}
                          </span>
                          <span className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            {ollamaSpeed > 0 ? `${formatBytes(ollamaSpeed)}/s` : ''}
                          </span>
                        </div>
                      </div>
                    )}
                    {/* Log lines */}
                    <div className={`text-[0.55rem] font-mono mt-1 max-h-16 overflow-y-auto space-y-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                      {ollamaLogs.slice(-4).map((log, i) => (
                        <p key={i}>{log}</p>
                      ))}
                    </div>
                  </div>
                )}

                {/* Error */}
                {ollamaError && (
                  <p className="text-[0.65rem] text-red-400">{ollamaError}</p>
                )}

                {/* LM Studio ready */}
                {lmstudioReady && (
                  <div className={`p-3 rounded-lg border ${isDark ? 'bg-green-500/10 border-green-500/20' : 'bg-green-50 border-green-200'}`}>
                    <div className="flex items-center gap-2 justify-center">
                      <Check size={14} className="text-green-400" />
                      <span className="text-[0.7rem] font-medium">LM Studio is ready (server on :1234)</span>
                    </div>
                  </div>
                )}

                {/* LM Studio install — alt path. Hidden once any installer is
                    running so two heavy downloads don't kick off at once. */}
                {!lmstudioInstalling && !lmstudioReady && !ollamaInstalling && !ollamaReady && (
                  <button
                    onClick={async () => {
                      setLmstudioInstalling(true)
                      setLmstudioError('')
                      setLmstudioStartTime(Date.now())
                      setLmstudioElapsed(0)
                      try {
                        await backendCall('install_lmstudio')
                        const poll = setInterval(async () => {
                          try {
                            const s: any = await backendCall('install_lmstudio_status')
                            setLmstudioStatus(s.status || '')
                            setLmstudioLogs(s.logs || [])
                            setLmstudioProgress(s.download_progress || 0)
                            setLmstudioTotal(s.download_total || 0)
                            setLmstudioSpeed(s.download_speed || 0)
                            if (s.status === 'complete') {
                              clearInterval(poll)
                              setLmstudioInstalling(false)
                              setLmstudioReady(true)
                              setLmstudioStartTime(null)
                              // Wire the OpenAI-compat provider to LM Studio so
                              // /v1/chat/completions calls hit the right port,
                              // and route GGUF downloads through the LM-Studio
                              // <user>/<repo>/<file>.gguf nesting.
                              setSelectedBackend('lmstudio')
                              setProviderConfig('openai', {
                                enabled: true,
                                name: 'LM Studio',
                                baseUrl: 'http://localhost:1234/v1',
                                isLocal: true,
                              })
                            } else if (s.status === 'error') {
                              clearInterval(poll)
                              setLmstudioInstalling(false)
                              setLmstudioStartTime(null)
                              const lastLog = s.logs?.[s.logs.length - 1] || 'Installation failed'
                              setLmstudioError(lastLog)
                            }
                          } catch { /* keep polling */ }
                        }, 1000)
                      } catch (err) {
                        setLmstudioInstalling(false)
                        setLmstudioStartTime(null)
                        setLmstudioError(err instanceof Error ? err.message : 'Installation failed')
                      }
                    }}
                    className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[0.7rem] font-medium transition-all ${
                      isDark ? 'bg-white/10 text-white hover:bg-white/15' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    <Download size={14} /> Or install LM Studio (GUI app, ~570 MB)
                  </button>
                )}

                {/* LM Studio install progress */}
                {lmstudioInstalling && (
                  <div className={`p-3 rounded-lg border ${cardClass} text-left`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Loader2 size={14} className="animate-spin text-purple-400" />
                        <span className="text-[0.7rem] font-medium">
                          {lmstudioStatus === 'downloading' ? 'Downloading LM Studio...' :
                           lmstudioStatus === 'installing' ? 'Installing LM Studio...' :
                           lmstudioStatus === 'starting' ? 'Starting LM Studio server...' :
                           'Setting up LM Studio...'}
                        </span>
                      </div>
                      <span className={`text-[0.55rem] font-mono ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                        {Math.floor(lmstudioElapsed / 60)}:{String(lmstudioElapsed % 60).padStart(2, '0')}
                      </span>
                    </div>
                    {lmstudioStatus === 'downloading' && lmstudioTotal > 0 && (
                      <div className="space-y-1">
                        <ProgressBar progress={(lmstudioProgress / lmstudioTotal) * 100} />
                        <div className="flex justify-between">
                          <span className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            {formatBytes(lmstudioProgress)} / {formatBytes(lmstudioTotal)}
                          </span>
                          <span className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            {lmstudioSpeed > 0 ? `${formatBytes(lmstudioSpeed)}/s` : ''}
                          </span>
                        </div>
                      </div>
                    )}
                    <div className={`text-[0.55rem] font-mono mt-1 max-h-16 overflow-y-auto space-y-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                      {lmstudioLogs.slice(-4).map((log, i) => (
                        <p key={i}>{log}</p>
                      ))}
                    </div>
                  </div>
                )}

                {lmstudioError && (
                  <p className="text-[0.65rem] text-red-400">
                    {lmstudioError}
                    {lmstudioError.toLowerCase().includes('didn\'t come up') && (
                      <button
                        onClick={() => { backendCall('start_lmstudio_server').catch(() => {}); setLmstudioError('') }}
                        className={`block mt-1 ${secondaryBtn}`}
                      >
                        Start LM Studio server
                      </button>
                    )}
                  </p>
                )}

                {/* Other alternatives collapsed */}
                {!ollamaInstalling && !ollamaReady && (
                  <details className={`text-left ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    <summary className={`text-[0.6rem] cursor-pointer hover:underline ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                      Other backends
                    </summary>
                    <div className="space-y-1 mt-2 max-h-[30vh] overflow-y-auto scrollbar-thin pr-1">
                      {LOCAL_BACKENDS.filter(b => b.id !== 'ollama' && b.id !== 'lmstudio').map(b => (
                        <button
                          key={b.id}
                          onClick={() => openExternal(b.url)}
                          className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg border transition-all group text-left ${
                            isDark
                              ? 'border-white/[0.06] hover:border-white/15 hover:bg-white/[0.03]'
                              : 'border-gray-200 hover:border-gray-400 hover:bg-gray-50'
                          }`}
                        >
                          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isDark ? 'bg-gray-600' : 'bg-gray-300'}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="text-[0.65rem] font-medium">{b.name}</p>
                              <ExternalLink size={10} className={`opacity-0 group-hover:opacity-100 transition-opacity ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
                            </div>
                            <p className={`text-[0.5rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{b.description}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </details>
                )}

                <div className="flex items-center justify-center gap-2 pt-1">
                  {!ollamaInstalling && !lmstudioInstalling && !ollamaReady && !lmstudioReady && (
                    <button onClick={runDetection} className={secondaryBtn}>
                      <RefreshCw size={12} /> Re-Scan
                    </button>
                  )}
                  {(ollamaReady || lmstudioReady || (!ollamaInstalling && !lmstudioInstalling)) && (
                    <button
                      onClick={() => setStep('comfyui')}
                      className={(ollamaReady || lmstudioReady) ? primaryBtn : `${secondaryBtn} opacity-60`}
                    >
                      {(ollamaReady || lmstudioReady) ? <>Continue <ArrowRight size={14} /></> : <>Skip for now <ChevronRight size={12} /></>}
                    </button>
                  )}
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

            {/* Found AND complete (a working install). The carcass case
                is handled in the install-options block below. */}
            {comfyFound?.found && comfyFound.complete !== false && !comfyInstalling && (
              <div className={`p-3 rounded-lg border ${isDark ? 'bg-green-500/10 border-green-500/20' : 'bg-green-50 border-green-200'}`}>
                <div className="flex items-center gap-2 justify-center">
                  <Check size={14} className="text-green-400" />
                  <span className="text-[0.7rem] font-medium">ComfyUI detected</span>
                </div>
                <p className={`text-[0.55rem] font-mono mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{comfyFound.path}</p>
              </div>
            )}

            {/* Not found OR found-but-incomplete — install options.
                P14: a found-but-incomplete dir is the ComfyUI carcass case;
                the same install button restarts the flow (Python pre-flight
                + git pull + pip install). */}
            {comfyFound && (!comfyFound.found || comfyFound.complete === false) && !comfyInstalling && !pythonInstalling && !comfyReady && (
              <div className="space-y-2">
                {comfyFound.found && comfyFound.complete === false && (
                  <div className={`p-2.5 rounded-lg border ${isDark ? 'bg-amber-500/10 border-amber-500/20' : 'bg-amber-50 border-amber-200'} text-left`}>
                    <p className={`text-[0.6rem] ${isDark ? 'text-amber-300' : 'text-amber-800'}`}>
                      Found a previous ComfyUI install at <code className="font-mono">{comfyFound.path}</code> but it's missing PyTorch — looks like a previous install was interrupted. Click below to finish it.
                    </p>
                  </div>
                )}
                <button
                  onClick={async () => {
                    // P14 pre-flight — install Python first if missing,
                    // then proceed with the original ComfyUI flow. Both
                    // progress cards animate from this single click; the
                    // user never has to interact mid-flight.
                    const pythonOk = await ensurePythonInstalled()
                    if (!pythonOk) return

                    setComfyInstalling(true)
                    setComfyInstallError('')
                    setComfyInstallLogs(['Starting ComfyUI installation...'])
                    setInstallStartTime(Date.now())
                    setElapsed(0)
                    try {
                      await backendCall('install_comfyui')
                      // Poll installation status
                      const poll = setInterval(async () => {
                        try {
                          const status: any = await backendCall('install_comfyui_status')
                          setComfyInstallLogs(status.logs || [])
                          setComfyDownloadProgress(status.download_progress || 0)
                          setComfyDownloadTotal(status.download_total || 0)
                          setComfyDownloadSpeed(status.download_speed || 0)
                          if (status.status === 'complete' || status.status === 'done') {
                            clearInterval(poll)
                            setComfyInstalling(false)
                            setComfyReady(true)
                            setInstallStartTime(null)
                            // Auto-start ComfyUI
                            try { await backendCall('start_comfyui') } catch {}
                          } else if (status.status === 'error') {
                            clearInterval(poll)
                            setComfyInstalling(false)
                            setInstallStartTime(null)
                            const lastLog = status.logs?.[status.logs.length - 1] || 'Installation failed'
                            setComfyInstallError(lastLog)
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

            {/* P14: Python install progress card. Animates while winget
                pulls Python.Python.3.12 (~30 MB) and runs the silent
                installer. Sits ABOVE the ComfyUI install card so the user
                can see the dependency chain (Python → ComfyUI) when both
                run back-to-back from a single click. */}
            {pythonInstalling && (
              <div className={`p-3 rounded-lg border ${cardClass} text-left`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin text-purple-400" />
                    <span className="text-[0.7rem] font-medium">Installing Python 3.12...</span>
                  </div>
                  <span className={`text-[0.55rem] font-mono ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                    {Math.floor(pythonElapsed / 60)}:{String(pythonElapsed % 60).padStart(2, '0')}
                  </span>
                </div>
                <p className={`text-[0.55rem] mb-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  ComfyUI needs Python to run pip. We're installing it via winget — about 30 MB and 30–60 s on a typical connection.
                </p>
                <div className={`text-[0.55rem] font-mono max-h-24 overflow-y-auto space-y-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  {pythonInstallLogs.slice(-6).map((log, i) => (
                    <p key={i}>{log}</p>
                  ))}
                </div>
              </div>
            )}
            {pythonInstallError && !pythonInstalling && (
              <p className="text-[0.65rem] text-red-400 whitespace-pre-line">{pythonInstallError}</p>
            )}

            {/* Installing progress */}
            {comfyInstalling && (
              <div className={`p-3 rounded-lg border ${cardClass} text-left`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin text-purple-400" />
                    <span className="text-[0.7rem] font-medium">Installing ComfyUI...</span>
                  </div>
                  <span className={`text-[0.55rem] font-mono ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                    {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
                  </span>
                </div>
                {/* Download progress bar (shown during download phase) */}
                {comfyInstallLogs.some(l => l.includes('Downloading')) && comfyDownloadTotal > 0 && (
                  <div className="space-y-1 mb-2">
                    <ProgressBar progress={comfyDownloadTotal > 0 ? (comfyDownloadProgress / comfyDownloadTotal) * 100 : 0} />
                    <div className="flex justify-between">
                      <span className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                        {formatBytes(comfyDownloadProgress)} / {formatBytes(comfyDownloadTotal)}
                      </span>
                      <span className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                        {comfyDownloadSpeed > 0 ? `${formatBytes(comfyDownloadSpeed)}/s` : ''}
                      </span>
                    </div>
                  </div>
                )}
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
              {/* Continue only when ComfyUI is actually usable. A
                  found-but-incomplete carcass shouldn't qualify — that
                  install will fail at first generation. */}
              {((comfyFound?.found && comfyFound.complete !== false) || comfyReady) && (
                <button
                  onClick={() => setStep('models')}
                  className={primaryBtn}
                >
                  Continue <ArrowRight size={14} />
                </button>
              )}
              {!comfyInstalling && !pythonInstalling && (!comfyFound?.found || comfyFound.complete === false) && !comfyReady && (
                <>
                  <button
                    onClick={() => {
                      setComfyDetecting(true)
                      setComfyFound(null)
                      backendCall<{ found: boolean; path?: string; complete?: boolean }>('find_comfyui')
                        .then(result => { setComfyFound(result); if (result.found && result.complete !== false) setComfyReady(true) })
                        .catch(() => setComfyFound({ found: false, complete: false }))
                        .finally(() => setComfyDetecting(false))
                    }}
                    className={secondaryBtn}
                  >
                    <RefreshCw size={12} /> Re-Scan
                  </button>
                  <button
                    onClick={() => setStep('models')}
                    className={`${secondaryBtn} opacity-60`}
                  >
                    Skip for now <ChevronRight size={12} />
                  </button>
                </>
              )}
            </div>
          </motion.div>
        )}

        {/* Step 5: Models (HuggingFace GGUF downloads) */}
        {step === 'models' && (
          <motion.div
            key="models"
            className="max-w-xl w-full space-y-3"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <div className="text-center mb-3">
              <h2 className="text-base font-semibold mb-1">Pick a starter model</h2>
              <p className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                One small model to get you running. You can browse and install more from the Discover tab in Model Manager once you're in.
              </p>
            </div>

            {/* Uncensored / Mainstream tabs — only meaningful when both
                categories have entries. With the curated single-starter list
                (P4) the tabs are hidden; reintroduce only if the list grows. */}
            {ONBOARDING_MODELS.some(m => m.uncensored) && ONBOARDING_MODELS.some(m => !m.uncensored) && (
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
            )}

            {isDownloading && pullingModel && (
              <div className={`p-2.5 rounded-lg border ${cardClass}`}>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[0.7rem]">
                    Downloading <span className="font-mono font-medium">{currentModel?.label || pullingModel}</span>...
                  </p>
                </div>
                <p className={`text-[0.6rem] mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{currentDownload?.status || 'Starting...'}</p>
                {currentDownload?.total ? (
                  <>
                    <ProgressBar progress={progress} />
                    <p className={`text-[0.55rem] mt-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                      {formatBytes(currentDownload.progress)} / {formatBytes(currentDownload.total)}
                      {progress > 0 && <span className="ml-1.5 text-blue-400">{Math.round(progress)}%</span>}
                    </p>
                  </>
                ) : null}
              </div>
            )}
            {downloadError && (
              <p className={`text-[0.65rem] text-red-400 text-center`}>{downloadError}</p>
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
                const pulled = pulledModels.includes(model.name) || (model.filename ? downloads[model.filename]?.status === 'complete' : false)
                return (
                  <button
                    key={model.name}
                    onClick={() => !pulled && !isDownloading && toggleModel(model.name)}
                    disabled={pulled || isDownloading}
                    className={`text-left p-2.5 rounded-lg border transition-all ${
                      pulled
                        ? isDark ? 'bg-green-500/10 border-green-500/30' : 'bg-green-50 border-green-300'
                        : selected
                        ? isDark ? 'bg-white/10 border-white/30' : 'bg-gray-100 border-gray-900'
                        : isDark ? 'border-white/10 hover:border-white/20' : 'border-gray-200 hover:border-gray-400'
                    } ${isDownloading ? 'opacity-60' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-[0.7rem]">{model.label}</span>
                          {model.recommended && showRecommendedBadge && (
                            <span className={`text-[0.5rem] px-1 py-0.5 rounded ${isDark ? 'bg-white/10 text-gray-300' : 'bg-gray-200 text-gray-600'}`}>
                              Recommended
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
              {selectedModels.length > 0 && !isDownloading ? (
                <button
                  onClick={handleDownloadSelected}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.7rem] font-medium transition-all ${
                    isDark ? 'bg-white text-black hover:bg-gray-200' : 'bg-gray-900 text-white hover:bg-gray-800'
                  }`}
                >
                  <Download size={14} /> Install {selectedModels.length} model{selectedModels.length > 1 ? 's' : ''}
                </button>
              ) : !isDownloading ? (
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
