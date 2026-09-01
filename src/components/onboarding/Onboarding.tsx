import { useState, useEffect, useRef, useReducer } from 'react'
import { withInstallerOutput, withDetail } from '../../lib/error-text'
import { motion, AnimatePresence } from 'framer-motion'
import { Minus, Square, X as XIcon, ArrowRight, Download, Check, ChevronRight, Loader2, RefreshCw, ExternalLink, FolderOpen, Cpu, Image as ImageIcon } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { ONBOARDING_MODELS, ONBOARDING_EMBED_MODEL } from '../../lib/constants'
import { PROVIDER_PRESETS } from '../../api/providers/types'
import { ICON_SM, ICON_LG } from '../ui/icon-size'
import { detectLocalBackends, type DetectedBackend } from '../../lib/backend-detector'
import { detectProviderModelPath, startModelDownloadToPath } from '../../api/discover'
import { useDownloadStore } from '../../stores/downloadStore'
import { ProgressBar } from '../ui/ProgressBar'
import { openExternal, isMacOS } from '../../api/backend'
import { formatBytes } from '../../lib/formatters'
import { backendCall } from '../../api/backend'
import { getSystemVRAM } from '../../api/comfyui'
import { pullModelTauri, checkConnection as checkOllama } from '../../api/ollama'
import { hfUrlToOllamaRef, hfUrlToLmStudioSubdir } from '../../lib/hf-to-provider'
import { startBundledEngine, startBundledEmbed } from '../../api/engine'
import { BUILTIN_BACKEND_ID, classifyOnboardingBackend, resolveOnboardingBackend } from '../../lib/onboarding-backend'
import { version as currentVersion } from '../../../package.json'
import { useReleaseNotesStore } from '../../stores/releaseNotesStore'
import { wizardProgress, workStepsFor, type Step } from './wizard-steps'
import {
  installerReducer, IDLE_INSTALLER, isRunning, isReady, elapsedSeconds, formatElapsed, lastLog,
} from './installer-state'

// Bug (h): the dedicated 'theme' onboarding step was removed because users
// kept ending up on Light by accident, and the project standard is "dark
// always". Light mode stays available in Settings → General → Appearance
// for users who explicitly want it; we just don't push them through the
// choice on first launch anymore.
// Added 'embeddings' step (GH #45, leonsk29 2026-05-23): suggests pulling
// `nomic-embed-text` (~274 MB) before completing onboarding so Document
// Chat / RAG works out of the box. The step shows a Skip button and
// auto-skips entirely when the user already has any embedding model on disk.
// D-S35: `Step` und die Schrittfolge liegen jetzt in ./wizard-steps.ts —
// zusammen mit der Unterscheidung zwischen einem Bildschirm und einem
// Arbeitsschritt, die dieser Datei bisher fehlte. Der Typ wird hier
// re-exportiert, damit die 60 Fundstellen unten unveraendert bleiben.
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
  // 2.5.7: the built-in engine is the pre-selected default — a fresh install
  // needs nothing installed. Detected Ollama/LM Studio are offered as Advanced.
  const [selectedBackend, setSelectedBackend] = useState<string>(BUILTIN_BACKEND_ID)
  const { setProviderConfig } = useProviderStore()

  // ComfyUI step state. `comfyFound.complete` distinguishes a working
  // install from a half-cloned carcass — see is_comfyui_install_complete in
  // process.rs. UI uses `complete:false` to surface a Re-install option
  // instead of "ComfyUI detected, Continue".
  const [comfyDetecting, setComfyDetecting] = useState(false)
  const [comfyFound, setComfyFound] = useState<{ found: boolean; path?: string; complete?: boolean } | null>(null)
  // AS-09: hier standen acht `useState` fuer EINE Zustandsmaschine —
  // installing, logs, error, downloadProgress, downloadTotal, downloadSpeed
  // plus installStartTime und elapsed weiter unten. Dieselbe Maschine fuehrten
  // Ollama, LM Studio und der Python-Installer je noch einmal. Sie steht jetzt
  // in ./installer-state.ts, einmal und geprueft.
  const [comfyInstall, comfyDo] = useReducer(installerReducer, IDLE_INSTALLER)
  const [comfyPathInput, setComfyPathInput] = useState('')
  const [comfyReady, setComfyReady] = useState(false)
  // Bug #3 (ninjastic2008 v2.4.3): multi-install disambiguation. When
  // `detect_all_comfyui_installs` returns more than one hit the user picks
  // explicitly instead of LU auto-picking the first scan match. Picking
  // the wrong install caused "ComfyUI loaded endlessly" because their
  // manual install's `python_embeded` was incompatible with our default
  // System-Python launcher.
  type ComfyInstallChoice = {
    path: string
    complete: boolean
    has_embedded_python: boolean
    source: string
  }
  const [comfyChoices, setComfyChoices] = useState<ComfyInstallChoice[]>([])

  // P14: Python install state. On a fresh Windows box `python` is the
  // Microsoft Store stub which exit-1's `pip install`. The ComfyUI install
  // pre-flight runs `python_check`; if Python is missing we kick off
  // `install_python` (winget Python.Python.3.12) and poll its status here
  // before re-firing `install_comfyui`.
  // Dieselbe Maschine. `setPythonReady` war dabei ein Schreibzugriff ohne
  // Leser (`const [, setPythonReady]`) — im Reducer ist „fertig" eine Phase,
  // also gibt es den toten Halbzustand nicht mehr.
  const [pythonInstall, pythonDo] = useReducer(installerReducer, IDLE_INSTALLER)
  const [systemVRAM, setSystemVRAM] = useState<number | null>(null)
  // Default the active sub-tab to whichever category actually has entries.
  // The previous fixed 'uncensored' default broke the onboarding starter card
  // entirely once P4 trimmed ONBOARDING_MODELS down to a single mainstream
  // entry (Qwen 2.5 0.5B): the tab switcher hides itself when only one
  // category is populated, but the filter at render time still rejected every
  // mainstream model — leaving the user on an empty list with only "Skip for
  // now". This computed initial value keeps the switcher useful when both
  // categories grow back, while making the single-entry case actually show
  // the entry.
  const initialSubTab: 'uncensored' | 'mainstream' = ONBOARDING_MODELS.some(m => m.uncensored)
    ? 'uncensored'
    : 'mainstream'
  const [modelSubTab, setModelSubTab] = useState<'uncensored' | 'mainstream'>(initialSubTab)
  // Ollama und LM Studio — der Kommentar hier sagte es vorher selbst:
  // „same shape as Ollama". Zwanzig `useState` fuer zweimal dieselbe Maschine.
  const [ollama, ollamaDo] = useReducer(installerReducer, IDLE_INSTALLER)
  const [lmstudio, lmstudioDo] = useReducer(installerReducer, IDLE_INSTALLER)

  // Der EINE Takt fuer alle vier Anzeigen. `elapsed` war viermal ein eigener
  // `useState` mit einem eigenen `setInterval`, obwohl es nichts anderes ist
  // als `jetzt − startedAt`. Gespeichert wird jetzt nur noch das „jetzt",
  // gerechnet wird beim Rendern (elapsedSeconds in ./installer-state.ts).
  const [now, setNow] = useState(() => Date.now())
  const secondsOf = (startedAt: number | null) => elapsedSeconds(startedAt, now)
  // Set when LM Studio is installed on the box but its embedded server is
  // not currently listening on :1234. Surfaces a "Start LM Studio server"
  // primary action instead of pushing the user through a redundant 570 MB
  // re-install. The install_lmstudio Tauri command is idempotent — it
  // detects the existing install and skips straight to bootstrap+server
  // start — so we route through the same code path either way; only the
  // UI labelling differs.
  const [lmstudioOfflineDetected, setLmstudioOfflineDetected] = useState(false)
  // Soft-detect: GGUFs in ~/.lmstudio/models/ even when we can't locate
  // lms.exe. Set when techx69-style users have LM Studio installed
  // system-wide (C:\Program Files\LM Studio) and the Rust path scan misses
  // it, but the canonical models dir is populated anyway. We surface a
  // "Start LM Studio server" CTA either way — the model count gives a
  // confidence cue in the offline-detected card.
  const [lmstudioModelCount, setLmstudioModelCount] = useState(0)

  const isDark = settings.theme === 'dark'
  const bgClass = isDark ? 'bg-[#202020] text-white' : 'bg-white text-gray-900'
  const cardClass = isDark ? 'bg-[#202020] border-white/[0.08]' : 'bg-gray-50 border-gray-200'

  const toggleModel = (name: string) => {
    setSelectedModels((prev) =>
      prev.includes(name) ? prev.filter((m) => m !== name) : [...prev, name]
    )
  }

  // Resolve once the download store reports the file finished (or errored).
  // Used by the built-in engine path, which must not boot llama-server until
  // the GGUF is fully on disk. Polls the same store the progress UI renders.
  const awaitDownloadComplete = (filename: string) =>
    new Promise<void>((resolve, reject) => {
      const poll = setInterval(() => {
        const d = useDownloadStore.getState().downloads[filename]
        if (d?.status === 'complete') { clearInterval(poll); resolve() }
        else if (d?.status === 'error') { clearInterval(poll); reject(new Error(d.error || 'Download failed')) }
      }, 500)
    })

  const handleDownloadSelected = async () => {
    setDownloadError(null)
    const providers = useProviderStore.getState().providers

    // Decide which backend the download has to feed. selectedBackend (set in
    // the backends step) is the strongest signal; isReady(ollama) covers the
    // "we just installed Ollama in-app" path; final fallback is the first
    // detected backend, defaulting to ollama. The earlier code wrote a raw
    // .gguf into `~/.ollama/models` regardless — Ollama ignores files placed
    // there directly, which is the root cause of the "downloaded model
    // never appears" bug reported on Discord and GH discussion #35.
    const targetBackend = resolveOnboardingBackend(selectedBackend, isReady(ollama), detectedBackends)
    const kind = classifyOnboardingBackend(targetBackend)
    const useBuiltinPath = kind === 'builtin'
    const useOllamaPath = kind === 'ollama'

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

    // Direct-write providers (built-in engine, LM Studio etc.) need a base dir.
    // The built-in engine has a dedicated, app-owned models dir resolved by the
    // Rust side (detect_model_path("builtin")); other OpenAI-compat providers
    // reuse the LM-Studio-style detection / user override.
    let destDir: string | null = null
    if (useBuiltinPath) {
      destDir = await detectProviderModelPath(BUILTIN_BACKEND_ID)
      if (!destDir) {
        setDownloadError('Could not create the built-in engine model folder. Check app permissions and retry.')
        return
      }
    } else if (!useOllamaPath) {
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
        } else if (useBuiltinPath) {
          // Built-in engine: write the GGUF flat into the app models dir, wait
          // for it to finish, then boot llama-server on it. Unlike LM Studio
          // there's no <user>/<repo> nesting — list_bundled_models scans the
          // dir directly. We await completion here (not fire-and-forget) so the
          // engine starts on a fully-downloaded file and the first chat works.
          dlStore.getState().setMeta(model.filename, model.downloadUrl, 'gguf', destDir!)
          const expectedBytes = model.sizeGB ? Math.round(model.sizeGB * 1_073_741_824) : undefined
          await startModelDownloadToPath(model.downloadUrl, destDir!, model.filename, expectedBytes)
          dlStore.getState().startPolling()
          await awaitDownloadComplete(model.filename)
          try {
            await startBundledEngine(`${destDir}/${model.filename}`)
          } catch (e) {
            setDownloadError(`Model downloaded, but the built-in engine failed to start: ${e instanceof Error ? e.message : String(e)}`)
          }
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
    setStep('embeddings')
  }

  const finish = () => {
    updateSettings({ onboardingDone: true })
    // B4: a brand new install must NOT be greeted by "what is new in 2.6.3"
    // right after setting the app up for the first time. Stamping the current
    // version here silently is what separates a fresh install from an upgrade:
    // an upgrade never runs this wizard, so its flag stays null and it gets the
    // notes. This is the ONLY place that stamps without showing anything.
    useReleaseNotesStore.getState().markNotesSeen(currentVersion)
    // Persist to filesystem so NSIS updates don't reset onboarding.
    //
    // Level (a): silent on purpose. updateSettings() above is what actually
    // ends the wizard, and it is persisted. This only writes the recovery
    // marker, which AppShell re-writes on any later boot where it is missing
    // (the migration next to `is_onboarding_done`). So a failure here heals
    // itself, and reporting it would put an error on the last screen of a
    // setup that succeeded.
    if (isTauri) backendCall('set_onboarding_done').catch(() => {})
  }

  // Hard rule: on macOS, local image/video generation is Apple MLX only —
  // ComfyUI never runs there (see isMlxImageHost() / the image_generate +
  // video_generate MLX routing in api/mcp/builtin-tools.ts). The ComfyUI
  // wizard step would just auto-detect/install a backend that can't start on
  // this platform, so skip straight to the model picker. MLX models are
  // managed from Models → Discover after onboarding, same as any other
  // model — no dedicated onboarding step for them.
  const nextStepAfterBackends = (): Step => (isMacOS() ? 'models' : 'comfyui')

  // Commit the chosen backend to the provider store and advance to ComfyUI
  // (or straight to the model picker on macOS — see nextStepAfterBackends).
  // Built-in (default) reasserts the managed OpenAI-slot config; a detected
  // Ollama takes over the primary slot (managed built-in disabled) so there
  // aren't two defaults; other OpenAI-compat backends fill the openai slot.
  const selectBackendAndContinue = () => {
    if (selectedBackend === BUILTIN_BACKEND_ID) {
      setProviderConfig('openai', {
        enabled: true, name: 'Built-in Engine',
        baseUrl: 'http://127.0.0.1:8127/v1', isLocal: true, managed: true,
      })
    } else if (selectedBackend === 'ollama') {
      setProviderConfig('ollama', { enabled: true })
      setProviderConfig('openai', { enabled: false, managed: false })
    } else {
      const backend = detectedBackends.find(b => b.id === selectedBackend)
      const preset = backend && PROVIDER_PRESETS.find(p => p.id === backend.id)
      if (backend && preset && preset.providerId !== 'ollama') {
        setProviderConfig('openai', {
          enabled: true, name: backend.name, baseUrl: backend.baseUrl,
          isLocal: true, managed: false,
        })
      }
    }
    setStep(nextStepAfterBackends())
  }

  /* ── Scan for backends ──────────────────────────────────── */
  const runDetection = async () => {
    setDetecting(true)
    setLmstudioOfflineDetected(false)
    setLmstudioModelCount(0)
    const backends = await detectLocalBackends()
    setDetectedBackends(backends)
    if (backends.length > 0 && !selectedBackend) {
      setSelectedBackend(backends[0].id)
    } else if (backends.length === 0 && isTauri) {
      // No live backend on any well-known port. Before we push the user
      // through a 570 MB LM-Studio re-install, ask the Rust side whether
      // LM Studio is actually present on disk — its embedded server may
      // just be turned off. lmstudio_server_status is cheap (a single
      // reqwest probe + a path check) and was added in the same sweep
      // that introduced this branch.
      //
      // v2.4.4 (Bug #2): the status payload now also includes
      // `models_detected` / `model_count` — set by scanning
      // ~/.lmstudio/models/ for GGUF files. We treat that as a strong
      // soft-detect signal: if the user has models in the canonical dir,
      // they obviously *have* LM Studio, regardless of whether our path
      // scan turned up lms.exe (techx69's system-wide install reproed this).
      try {
        const status: any = await backendCall('lmstudio_server_status')
        const offline = status?.lms_present && !status?.running
        const softDetect = status?.models_detected && !status?.running
        if (offline || softDetect) {
          setLmstudioOfflineDetected(true)
          setLmstudioModelCount(Number(status?.model_count) || 0)
        }
      } catch { /* command unavailable — ignore */ }
    }
    setDetecting(false)
  }

  // Detect system VRAM for model filtering.
  //
  // Level (a): silent on purpose. systemVRAM is only ever read as
  // `if (systemVRAM && m.vramGB > systemVRAM) return false`, so a failed
  // probe means the recommendation list is not narrowed — the user sees MORE
  // models, not fewer, and every card still states its own VRAM need. There
  // is no action to offer, and nothing was lost.
  useEffect(() => { getSystemVRAM().then(v => setSystemVRAM(v)).catch(() => {}) }, [])

  // Count CHAT-CAPABLE models the user already has installed. Used to skip
  // the model-picker step when they're not a fresh install — a reinstaller /
  // upgrader doesn't need a starter rec.
  //
  // Embedding-only models (LM Studio's default `nomic-embed-text-v1.5`,
  // `bge-*`, anything with `embed` in the name) are excluded because they
  // can't drive a chat. Without this filter, a fresh LM Studio install
  // looked like "user already has 1 model" and auto-skipped the starter
  // card — which is exactly the noob trap we're trying to remove.
  const [existingModelCount, setExistingModelCount] = useState<number | null>(null)
  useEffect(() => {
    if (step !== 'models') return
    let cancelled = false
    import('../../api/ollama').then(({ listModels }) =>
      listModels()
        .then(models => {
          const chatCapable = models.filter(m => {
            const lower = (m.name || '').toLowerCase()
            return !lower.includes('embed') && !lower.includes('bge-') && !lower.includes('nomic')
          })
          if (!cancelled) setExistingModelCount(chatCapable.length)
        })
        .catch(() => { if (!cancelled) setExistingModelCount(0) })
    )
    return () => { cancelled = true }
  }, [step])

  // Auto-skip the model step when the user already has installed models
  // (P4 LU-Aufgaben: "Nur wenn der User noch gar kein Modell installiert hat.
  // Sonst nirgendwo mehr 'Recommended'-Empfehlungen"). null = still loading,
  // 0 = fresh, >0 = experienced — only the first two should see the picker.
  // Experienced users still progress to the embedding step (separate skip).
  useEffect(() => {
    if (step === 'models' && existingModelCount !== null && existingModelCount > 0) {
      setStep('embeddings')
    }
  }, [step, existingModelCount])

  // ── nomic-embed-text install state (GH #45, leonsk29 2026-05-23) ─────
  // The Document Chat / RAG feature needs an embedding model. We default
  // to `nomic-embed-text` — small (~274 MB), broadly supported. The step
  // auto-skips when the user already has any embedding model installed
  // (covers LM Studio users who came in via that backend with their own
  // embedding model, and Ollama users who already pulled one).
  const [embeddingsPulling, setEmbeddingsPulling] = useState(false)
  const [embeddingsPulled, setEmbeddingsPulled] = useState(false)
  const [embeddingsError, setEmbeddingsError] = useState<string | null>(null)
  const [embeddingsProgress, setEmbeddingsProgress] = useState<{ completed: number; total: number }>({ completed: 0, total: 0 })
  const [embeddingsAlreadyHave, setEmbeddingsAlreadyHave] = useState<boolean | null>(null)

  // Embeddings route on the CHOSEN backend, not isManagedBuiltinActive():
  // rag.ts only ever queries the bundled embeddings server or Ollama — never
  // an LM-Studio-style /v1/embeddings — so openai-compat backends must take
  // the bundled path too. Branching on isManagedBuiltinActive() dead-ended
  // LM Studio users on a machine that has no Ollama by explicit choice.
  const embedsViaBundled =
    classifyOnboardingBackend(resolveOnboardingBackend(selectedBackend, isReady(ollama), detectedBackends)) !== 'ollama'

  // Probe whether an embedding model is already present. For the built-in
  // engine (P5) and openai-compat backends we scan the app models dir via
  // list_bundled_models; only Ollama lists its pulled models. Either way we
  // match anything with `embed`/`bge`/`nomic` in the name (same heuristic
  // used elsewhere).
  useEffect(() => {
    if (step !== 'embeddings') return
    let cancelled = false
    const isEmbed = (name: string) => {
      const lower = (name || '').toLowerCase()
      return lower.includes('embed') || lower.includes('bge-') || lower.includes('nomic')
    }
    const probe = embedsViaBundled
      ? import('../../api/engine').then(({ listBundledModels }) =>
          listBundledModels().then(models => models.some(m => isEmbed(m.name))))
      : import('../../api/ollama').then(({ listModels }) =>
          listModels().then(models => models.some(m => isEmbed(m.name))))
    probe
      .then(hasEmbedding => { if (!cancelled) setEmbeddingsAlreadyHave(hasEmbedding) })
      .catch(() => { if (!cancelled) setEmbeddingsAlreadyHave(false) })
    return () => { cancelled = true }
  }, [step, embedsViaBundled])

  const handlePullEmbeddings = async () => {
    if (!isTauri) {
      setEmbeddingsError('Embedding install requires the desktop app. Running in a browser preview.')
      return
    }
    setEmbeddingsPulling(true)
    setEmbeddingsError(null)
    setEmbeddingsProgress({ completed: 0, total: 0 })

    // P5: bundled-engine path — download the embedding GGUF flat into the app
    // models dir and boot the embeddings server on it. No Ollama involved, so
    // Document-Chat/RAG works on a fresh install with zero external provider.
    // Taken for the built-in engine AND openai-compat backends (LM Studio
    // etc.) — see embedsViaBundled above.
    if (embedsViaBundled) {
      try {
        const destDir = await detectProviderModelPath(BUILTIN_BACKEND_ID)
        if (!destDir) throw new Error('Could not resolve the built-in models directory.')
        const { downloadUrl, filename, sizeGB } = ONBOARDING_EMBED_MODEL
        dlStore.getState().setMeta(filename, downloadUrl, 'gguf', destDir)
        const expectedBytes = sizeGB ? Math.round(sizeGB * 1_073_741_824) : undefined
        await startModelDownloadToPath(downloadUrl, destDir, filename, expectedBytes)
        dlStore.getState().startPolling()
        // Mirror the store's completed/total into the step's progress UI.
        const unsub = useDownloadStore.subscribe(s => {
          const d = s.downloads[filename]
          if (d) setEmbeddingsProgress({ completed: d.progress || 0, total: d.total || 0 })
        })
        try {
          await awaitDownloadComplete(filename)
        } finally {
          unsub()
        }
        await startBundledEmbed(`${destDir}/${filename}`)
        setEmbeddingsPulled(true)
        window.dispatchEvent(new CustomEvent('lu-models-refresh'))
      } catch (e) {
        setEmbeddingsError(`Embedding setup failed: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setEmbeddingsPulling(false)
      }
      return
    }

    try {
      // Make sure ollama is reachable before kicking off the pull.
      let ok = await checkOllama()
      if (!ok) {
        try { await backendCall('start_ollama') } catch { /* fall through */ }
        for (let i = 0; i < 20 && !ok; i++) {
          await new Promise(r => setTimeout(r, 250))
          ok = await checkOllama()
        }
      }
      if (!ok) {
        setEmbeddingsError('Cannot reach Ollama (localhost:11434). Start Ollama and retry.')
        setEmbeddingsPulling(false)
        return
      }
      const { promise } = pullModelTauri('nomic-embed-text', (p) => {
        setEmbeddingsProgress({ completed: p.completed || 0, total: p.total || 0 })
      })
      await promise
      setEmbeddingsPulled(true)
      // Same refresh event chat/picker components listen on.
      window.dispatchEvent(new CustomEvent('lu-models-refresh'))
    } catch (e) {
      setEmbeddingsError(`Pull failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setEmbeddingsPulling(false)
    }
  }

  const showRecommendedBadge = existingModelCount === 0

  // EIN Takt fuer alle vier Installer statt vier Intervallen (AS-09). Er
  // laeuft nur, solange ueberhaupt einer laeuft, und er speichert die Uhr,
  // nicht die vier daraus abgeleiteten Sekundenzaehler.
  //
  // Der Python-Fall ist der, der die Laufzeit ueberhaupt sichtbar macht
  // (P14): winget zieht den Python-3.12-Installer (~30 MB) und faehrt ihn
  // still durch — an einem normalen Anschluss 30–60 s, an einem langsamen
  // ein paar Minuten.
  const anyStartedAt = comfyInstall.startedAt ?? ollama.startedAt ?? lmstudio.startedAt ?? pythonInstall.startedAt
  useEffect(() => {
    if (anyStartedAt === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [anyStartedAt])

  /** Der Auto-Scan laeuft einmal pro Mount, sobald der comfyui-Schritt erreicht
   *  ist. Ref statt State: der Wert steuert keinen Render, sondern verhindert
   *  nur den Wiedereintritt in den Effekt. */
  const comfyAutoDetectStarted = useRef(false)

  // Auto-detect ComfyUI when entering the comfyui step. We mark the install
  // as "ready" (=> Continue button) only when both `found` AND `complete`
  // are true. A `found && !complete` carcass (P14) keeps the install option
  // visible so the user can re-trigger and let LU rebuild torch/deps.
  useEffect(() => {
    // Belt-and-suspenders: nextStepAfterBackends() already routes macOS
    // straight past this step, so `step` should never actually be 'comfyui'
    // there — but never auto-detect/install ComfyUI on Mac regardless (hard
    // rule: Mac local image/video is MLX only).
    if (step === 'comfyui' && !isMacOS() && !comfyAutoDetectStarted.current) {
      // Die Wiedereintritts-Sperre steckte bisher in `!comfyFound &&
      // !comfyDetecting`. Als Dependencies notiert waeren genau diese beiden
      // eine Endlosschleife: der Mehrfach-Install-Zweig setzt `comfyFound`
      // absichtlich wieder auf null und `finally` setzt `comfyDetecting` auf
      // false — der Effekt haette sich damit selbst nachgetriggert und den
      // Backend-Scan in Dauerschleife gefahren. Die Sperre ist Lauf-Zustand,
      // kein Render-Zustand, und liegt deshalb in einer Ref.
      comfyAutoDetectStarted.current = true
      setComfyDetecting(true)
      // First: enumerate ALL installs (Bug #3). When >1 we show a picker
      // BEFORE auto-picking — preventing the ninjastic2008 trap where LU
      // detected their manual install while they wanted the empty placeholder
      // path. `find_comfyui` is the auto-pick fallback for the single-install
      // case, which keeps the existing happy-path behaviour intact.
      backendCall<ComfyInstallChoice[]>('detect_all_comfyui_installs')
        .then(async installs => {
          if (Array.isArray(installs) && installs.length > 1) {
            setComfyChoices(installs)
            setComfyFound(null)
            return
          }
          if (Array.isArray(installs) && installs.length === 1) {
            const only = installs[0]
            setComfyFound({ found: true, path: only.path, complete: only.complete })
            if (only.complete) setComfyReady(true)
            // Persist the auto-pick so process.rs uses it on start_comfyui.
            //
            // Level (b): the user finds out, the wizard carries on. Nobody
            // clicked anything here — the single install was auto-picked — but
            // if the path does not stick, the panel above says "found" while
            // start_comfyui will look somewhere else entirely, and the failure
            // then surfaces minutes later with no visible cause.
            try {
              await backendCall('set_comfyui_path', { path: only.path })
            } catch (e) {
              comfyDo({ type: 'warn', error: withDetail(
                `LU found ComfyUI at ${only.path} but could not save that location. Starting it may not work; set the path by hand below.`,
                e,
              ) })
            }
            return
          }
          // Zero matches — fall back to legacy find_comfyui (env var, config
          // file overrides that aren't on the scan list).
          const legacy = await backendCall<{ found: boolean; path?: string; complete?: boolean }>('find_comfyui')
          setComfyFound(legacy)
          if (legacy.found && legacy.complete !== false) setComfyReady(true)
        })
        .catch(async () => {
          // Older builds without detect_all_comfyui_installs — degrade
          // gracefully to the previous single-pick API.
          try {
            const legacy = await backendCall<{ found: boolean; path?: string; complete?: boolean }>('find_comfyui')
            setComfyFound(legacy)
            if (legacy.found && legacy.complete !== false) setComfyReady(true)
          } catch {
            setComfyFound({ found: false, complete: false })
          }
        })
        .finally(() => setComfyDetecting(false))
    }
  }, [step])

  // Pick one of the multiple installs from the disambiguation dialog. The
  // chosen path is persisted via set_comfyui_path so start_comfyui hits it
  // without further user intervention.
  const pickComfyInstall = async (choice: ComfyInstallChoice) => {
    // Level (c): the user picked one of several installs and this call is the
    // whole point of that click — without it the pick is not recorded anywhere
    // and start_comfyui keeps using the old one. The lines below close the
    // dialog and report "found", so a swallowed failure here leaves the wizard
    // confidently showing a choice that was never made.
    comfyDo({ type: 'warn', error: '' })
    try {
      await backendCall('set_comfyui_path', { path: choice.path })
    } catch (e) {
      comfyDo({ type: 'warn', error: withDetail(
        `Could not switch ComfyUI to ${choice.path}. LU will keep using the location it had — try the pick again, or enter the path by hand below.`,
        e,
      ) })
      return
    }
    setComfyFound({ found: true, path: choice.path, complete: choice.complete })
    if (choice.complete) setComfyReady(true)
    setComfyChoices([])
  }

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

    pythonDo({ type: 'start', at: Date.now(), log: 'Installing Python 3.12 via winget…' })

    try {
      await backendCall('install_python')
    } catch (err) {
      pythonDo({ type: 'fail', error: err instanceof Error ? err.message : 'Python install failed to start' })
      return false
    }

    return await new Promise<boolean>((resolve) => {
      const poll = setInterval(async () => {
        try {
          const status: any = await backendCall('install_python_status')
          pythonDo({ type: 'progress', status: status.status, logs: status.logs || [] })
          if (status.status === 'complete' || status.status === 'already_installed') {
            clearInterval(poll)
            pythonDo({ type: 'ready' })
            resolve(true)
          } else if (status.status === 'error') {
            clearInterval(poll)
            pythonDo({ type: 'fail', error: withInstallerOutput('Installing Python did not finish.', lastLog(status.logs)) })
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
  //
  // D-S36: `primaryBtn` war `bg-white text-black hover:bg-gray-200` (dunkel)
  // bzw. `bg-gray-900 text-white hover:bg-gray-800` (hell). Der Hover machte
  // den Knopf also DUNKLER als seinen Ruhezustand — im Screenshot des Audits
  // liest Schritt 2 deshalb als deaktiviert. Das Rezept dafuer existiert seit
  // f336b91e genau einmal, in index.css als `.lu-primary`, und rechnet seinen
  // Kontrast nach (#a094f8 auf #111827 = 6.83:1 in Ruhe, #b1a6ff auf #111827
  // = 8.25:1 im Hover — der Hover wird HELLER, nicht dunkler). Er hatte das
  // Onboarding nur nie erreicht; AUDIT-COVERAGE fuehrt das unter D-A8 als
  // ausdruecklichen Rest. Kein eigenes Rezept hier, sondern jenes.
  const primaryBtn = 'lu-primary mx-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.7rem] transition-all'
  const secondaryBtn = `mx-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.7rem] font-medium transition-colors ${
    isDark ? 'bg-white/10 text-white hover:bg-white/15' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
  }`

  const handleMinimize = async () => { const { getCurrentWindow } = await import('@tauri-apps/api/window'); getCurrentWindow().minimize() }
  const handleMaximize = async () => { const { getCurrentWindow } = await import('@tauri-apps/api/window'); getCurrentWindow().toggleMaximize() }
  const handleClose = async () => { const { getCurrentWindow } = await import('@tauri-apps/api/window'); getCurrentWindow().close() }
  const winBtn = 'inline-flex items-center justify-center w-[46px] h-8 transition-colors text-gray-400 hover:text-gray-200'

  // D-S35: Mac ueberspringt 'comfyui' (siehe nextStepAfterBackends). Der
  // Anzeiger zaehlt ausserdem nur noch die ARBEITSSCHRITTE — Willkommen ist
  // ein Titelbild, Fertig eine Bestaetigung. Die Rechnung dazu steht in
  // ./wizard-steps.ts und ist dort geprueft.
  const workSteps = workStepsFor(isMacOS())
  const progressNow = wizardProgress(step, isMacOS())

  return (
    // D-S38: vorher `items-center` auf einem h-screen-Kasten PLUS ein
    // `fixed top-10`-Anzeiger. Die Punkte klebten damit an der Titelleiste
    // (y=46), der Inhalt hing in der Fenstermitte (y=340) — 294px Niemandsland
    // dazwischen, und die Punkte lasen als Teil des Fensterrahmens statt als
    // Teil des Assistenten. Jetzt steht der Anzeiger IM Fluss, direkt ueber
    // der Karte, und der Abstand ist der `gap` einer Spalte statt der Rest
    // einer Zentrierung.
    <div className={`h-screen w-screen flex flex-col items-center justify-center gap-5 p-4 ${bgClass}`}>
      {/* Drag region + window controls */}
      {isTauri && (
        <div data-tauri-drag-region className="fixed top-0 left-0 right-0 h-8 z-50 flex items-center justify-end select-none">
          <button onClick={handleMinimize} className={winBtn} aria-label="Minimize"><Minus size={ICON_SM} /></button>
          <button onClick={handleMaximize} className={winBtn} aria-label="Maximize"><Square size={ICON_SM} /></button>
          <button onClick={handleClose} className={`${winBtn} hover:bg-red-500 hover:text-white`} aria-label="Close"><XIcon size={ICON_SM} /></button>
        </div>
      )}

      {/* Step indicator — Punkte UND Text. Sechs anonyme Punkte konnten die
          Frage „wie viele noch?" nicht beantworten; „Step 2 of 4 · Model"
          kann es. Die Hoehe ist fest, damit ein Schrittwechsel die Karte
          darunter nicht verschiebt. */}
      <div className="h-8 flex flex-col items-center justify-end gap-1.5" aria-live="polite">
        {progressNow && (<>
          <div className="flex gap-1.5">
            {workSteps.map((s, i) => (
              <div key={s.step} className={`w-1.5 h-1.5 rounded-full transition-colors ${i < progressNow.filled ? (isDark ? 'bg-white' : 'bg-gray-900') : (isDark ? 'bg-white/15' : 'bg-gray-300')}`} />
            ))}
          </div>
          <p className={`text-[0.6rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{progressNow.caption}</p>
        </>)}
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
            {/* D-S37: war `text-base` = 1rem — die Willkommens-Ueberschrift
                der App genau so gross wie ein Settings-Label. Soll laut Audit
                28px/34px/600.
                Warum `1.5rem` und keine feste px-Zahl: die 28px des Audits
                sind eine MESSUNG am gerenderten Fenster, und das Wurzelmass
                der App wird gerade umgestellt (D-A3, anderes Paket). Beide
                Regime ergeben fuer 1.5rem dasselbe, weil 18,4 = 16 × 1,15:
                  alt   1.5 × 18,4px                = 27,6 gerenderte px
                  neu   1.5 × 16px × --ui-scale 1,15 = 27,6 gerenderte px
                Zeilenhoehe 1,21 → 33,4px (Soll 34). Eine px-Angabe waere im
                neuen Regime durch `zoom` auf 32,2px gelaufen.
                Der Zusatz „by LU Labs" bleibt eine Stufe kleiner, damit die
                Groesse dem Namen gehoert und nicht der ganzen Zeile. */}
            <h1 className="text-[1.5rem] leading-[1.21] font-semibold tracking-tight">
              LU <span className="text-[12px] font-normal opacity-60 align-middle">by LU Labs</span>
            </h1>
            <p className={`text-[12px] leading-relaxed ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              Private, local AI chat that works right away. No extra software to install. No servers, no tracking, everything stays on your machine.
            </p>
            <button
              onClick={() => {
                setStep('backends')
                runDetection()
              }}
              className={primaryBtn}
            >
              Get Started <ArrowRight size={14} />
            </button>
          </motion.div>
        )}

        {/* Step 2 (theme picker) was removed in Bug (h). Light mode is
            still available in Settings → General → Appearance for users
            who want it explicitly. */}

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
            ) : (
              <>
                {/* Built-in engine — the 2.5.7 default. Runs locally, nothing to
                    install. Detected/installable external engines move under the
                    Advanced disclosure below (kept, just no longer required). */}
                <h2 className="text-base font-semibold">Ready to chat</h2>
                <p className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  LU runs its own engine on your machine. Nothing to install. Pick a starter model next.
                </p>

                <button
                  onClick={() => setSelectedBackend(BUILTIN_BACKEND_ID)}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg border text-left transition-colors ${
                    selectedBackend === BUILTIN_BACKEND_ID
                      ? isDark ? 'bg-white/10 border-white/20' : 'bg-gray-100 border-gray-900'
                      : isDark ? 'border-white/10 hover:border-white/20' : 'border-gray-200 hover:border-gray-400'
                  }`}
                >
                  <Cpu size={16} className={selectedBackend === BUILTIN_BACKEND_ID ? (isDark ? 'text-white' : 'text-gray-900') : 'text-gray-500'} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[0.72rem] font-medium">Built-in Engine</p>
                    <p className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Runs on your machine · nothing to install</p>
                  </div>
                  {selectedBackend === BUILTIN_BACKEND_ID && <Check size={14} className="text-green-400 shrink-0" />}
                </button>

                <div className="flex items-center justify-center gap-2 pt-1">
                  <button onClick={selectBackendAndContinue} className={primaryBtn}>
                    Continue <ArrowRight size={14} />
                  </button>
                </div>

                {/* Advanced: connect to a detected engine or install another one.
                    All the existing Ollama/LM-Studio detection + install UI lives
                    here now — available, but off the critical path. */}
                <details className="text-left pt-1">
                  <summary className={`text-[0.6rem] cursor-pointer hover:underline text-center list-none ${isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'}`}>
                    Use another engine (Ollama, LM Studio…)
                  </summary>
                  <div className="mt-3 space-y-4 text-center">
                {detectedBackends.length > 0 ? (
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
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border text-left transition-colors ${
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
                    onClick={selectBackendAndContinue}
                    className={primaryBtn}
                  >
                    Continue <ArrowRight size={14} />
                  </button>
                </div>
              </>
            ) : (
              /* ── No backends found — install Ollama in-app ─────── */
              <>
                <h2 className="text-base font-semibold">
                  {lmstudioOfflineDetected ? 'LM Studio detected' : 'No local backend detected'}
                </h2>
                <p className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {lmstudioOfflineDetected
                    ? (lmstudioModelCount > 0
                        ? `LM Studio is installed (${lmstudioModelCount} model${lmstudioModelCount === 1 ? '' : 's'} detected) but its server isn't currently running. Start it to use LM Studio as your backend, no re-install needed.`
                        : "LM Studio is installed but its server isn't currently running. Start it to use LM Studio as your backend, no re-install needed.")
                    : "You need a local AI backend to chat. We'll install Ollama for you, it's the easiest to set up."}
                </p>

                {/* Ollama ready state */}
                {isReady(ollama) && (
                  <div className={`p-3 rounded-lg border ${isDark ? 'bg-green-500/10 border-green-500/20' : 'bg-green-50 border-green-200'}`}>
                    <div className="flex items-center gap-2 justify-center">
                      <Check size={14} className="text-green-400" />
                      <span className="text-[0.7rem] font-medium">Ollama is ready!</span>
                    </div>
                  </div>
                )}

                {/* Ollama install button — hidden when we already know LM
                    Studio is on the box and just needs starting; pushing
                    Ollama in that situation is just noise and forces a
                    second 200 MB download. */}
                {!isRunning(ollama) && !isReady(ollama) && !lmstudioOfflineDetected && (
                  <button
                    onClick={async () => {
                      ollamaDo({ type: 'start', at: Date.now() })
                      try {
                        await backendCall('install_ollama')
                        const poll = setInterval(async () => {
                          try {
                            const s: any = await backendCall('install_ollama_status')
                            ollamaDo({
                              type: 'progress',
                              status: s.status || '',
                              logs: s.logs || [],
                              received: s.download_progress || 0,
                              total: s.download_total || 0,
                              speed: s.download_speed || 0,
                            })
                            if (s.status === 'complete') {
                              clearInterval(poll)
                              ollamaDo({ type: 'ready' })
                              // Lock the model-download flow onto Ollama so
                              // GGUFs go through `ollama pull` (which produces
                              // a usable model) instead of a raw .gguf write
                              // (which Ollama then can't see).
                              setSelectedBackend('ollama')
                            } else if (s.status === 'error') {
                              clearInterval(poll)
                              ollamaDo({ type: 'fail', error: withInstallerOutput('Installing Ollama did not finish.', lastLog(s.logs)) })
                            }
                          } catch { /* keep polling */ }
                        }, 1000)
                      } catch (err) {
                        ollamaDo({ type: 'fail', error: err instanceof Error ? err.message : 'Installation failed' })
                      }
                    }}
                    className="lu-primary w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-[0.7rem] transition-all"
                  >
                    <Download size={14} /> Install Ollama
                  </button>
                )}

                {/* Install progress */}
                {isRunning(ollama) && (
                  <div className={`p-3 rounded-lg border ${cardClass} text-left`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Loader2 size={14} className="animate-spin text-blue-400" />
                        <span className="text-[0.7rem] font-medium">
                          {ollama.status === 'downloading' ? 'Downloading Ollama...' :
                           ollama.status === 'installing' ? 'Installing Ollama...' :
                           ollama.status === 'starting' ? 'Starting Ollama...' :
                           'Setting up Ollama...'}
                        </span>
                      </div>
                      <span className={`text-[0.55rem] font-mono ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                        {formatElapsed(secondsOf(ollama.startedAt))}
                      </span>
                    </div>
                    {/* Download progress bar */}
                    {ollama.status === 'downloading' && ollama.total > 0 && (
                      <div className="space-y-1">
                        <ProgressBar progress={(ollama.received / ollama.total) * 100} />
                        <div className="flex justify-between">
                          <span className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            {formatBytes(ollama.received)} / {formatBytes(ollama.total)}
                          </span>
                          <span className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            {ollama.speed > 0 ? `${formatBytes(ollama.speed)}/s` : ''}
                          </span>
                        </div>
                      </div>
                    )}
                    {/* Log lines */}
                    <div className={`text-[0.55rem] font-mono mt-1 max-h-16 overflow-y-auto space-y-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                      {ollama.logs.slice(-4).map((log, i) => (
                        <p key={i}>{log}</p>
                      ))}
                    </div>
                  </div>
                )}

                {/* Error */}
                {ollama.error && (
                  <p className="text-[0.65rem] text-red-400 whitespace-pre-line">{ollama.error}</p>
                )}

                {/* LM Studio ready */}
                {isReady(lmstudio) && (
                  <div className={`p-3 rounded-lg border ${isDark ? 'bg-green-500/10 border-green-500/20' : 'bg-green-50 border-green-200'}`}>
                    <div className="flex items-center gap-2 justify-center">
                      <Check size={14} className="text-green-400" />
                      <span className="text-[0.7rem] font-medium">LM Studio is ready (server on :1234)</span>
                    </div>
                  </div>
                )}

                {/* LM Studio install — alt path. Hidden once any installer is
                    running so two heavy downloads don't kick off at once.
                    When `lmstudioOfflineDetected` is set we re-label this
                    button as the primary action and let the same Tauri
                    command handle it; the Rust side detects the existing
                    install and skips straight to bootstrap+server-start
                    instead of re-downloading. */}
                {!isRunning(lmstudio) && !isReady(lmstudio) && !isRunning(ollama) && !isReady(ollama) && (
                  <button
                    onClick={async () => {
                      lmstudioDo({ type: 'start', at: Date.now() })
                      try {
                        await backendCall('install_lmstudio')
                        const poll = setInterval(async () => {
                          try {
                            const s: any = await backendCall('install_lmstudio_status')
                            lmstudioDo({
                              type: 'progress',
                              status: s.status || '',
                              logs: s.logs || [],
                              received: s.download_progress || 0,
                              total: s.download_total || 0,
                              speed: s.download_speed || 0,
                            })
                            if (s.status === 'complete') {
                              clearInterval(poll)
                              lmstudioDo({ type: 'ready' })
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
                                managed: false,
                              })
                            } else if (s.status === 'error') {
                              clearInterval(poll)
                              lmstudioDo({ type: 'fail', error: withInstallerOutput('Installing LM Studio did not finish.', lastLog(s.logs)) })
                            }
                          } catch { /* keep polling */ }
                        }, 1000)
                      } catch (err) {
                        lmstudioDo({ type: 'fail', error: err instanceof Error ? err.message : 'Installation failed' })
                      }
                    }}
                    className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[0.7rem] transition-all ${
                      lmstudioOfflineDetected
                        ? 'lu-primary'
                        : `font-medium ${isDark ? 'bg-white/10 text-white hover:bg-white/15' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`
                    }`}
                  >
                    <Download size={14} />
                    {lmstudioOfflineDetected
                      ? 'Start LM Studio server'
                      : 'Or install LM Studio (GUI app, ~570 MB)'}
                  </button>
                )}

                {/* LM Studio install progress */}
                {isRunning(lmstudio) && (
                  <div className={`p-3 rounded-lg border ${cardClass} text-left`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Loader2 size={14} className="animate-spin text-purple-400" />
                        <span className="text-[0.7rem] font-medium">
                          {lmstudio.status === 'downloading' ? 'Downloading LM Studio...' :
                           lmstudio.status === 'installing' ? 'Installing LM Studio...' :
                           lmstudio.status === 'starting' ? 'Starting LM Studio server...' :
                           'Setting up LM Studio...'}
                        </span>
                      </div>
                      <span className={`text-[0.55rem] font-mono ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                        {formatElapsed(secondsOf(lmstudio.startedAt))}
                      </span>
                    </div>
                    {lmstudio.status === 'downloading' && lmstudio.total > 0 && (
                      <div className="space-y-1">
                        <ProgressBar progress={(lmstudio.received / lmstudio.total) * 100} />
                        <div className="flex justify-between">
                          <span className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            {formatBytes(lmstudio.received)} / {formatBytes(lmstudio.total)}
                          </span>
                          <span className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            {lmstudio.speed > 0 ? `${formatBytes(lmstudio.speed)}/s` : ''}
                          </span>
                        </div>
                      </div>
                    )}
                    <div className={`text-[0.55rem] font-mono mt-1 max-h-16 overflow-y-auto space-y-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                      {lmstudio.logs.slice(-4).map((log, i) => (
                        <p key={i}>{log}</p>
                      ))}
                    </div>
                  </div>
                )}

                {lmstudio.error && (
                  <p role="alert" className="text-[0.65rem] text-red-400 whitespace-pre-line">
                    {lmstudio.error}
                    {lmstudio.error.toLowerCase().includes('didn\'t come up') && (
                      <button
                        // Level (c): this button lives INSIDE the error it is
                        // meant to clear, and the click wipes that error on the
                        // spot. Swallowing the failure meant the message
                        // vanished and nothing replaced it — the one shape of
                        // dud this file can produce. Put the outcome back into
                        // the same line the button came from.
                        onClick={() => {
                          // `warn`, nicht `fail`: hier laeuft keine
                          // Installation, es wird nur ein Server angestossen.
                          lmstudioDo({ type: 'warn', error: '' })
                          backendCall('start_lmstudio_server').catch((e) => {
                            lmstudioDo({ type: 'warn', error: withDetail(
                              'The LM Studio server did not start. Open LM Studio and start its local server from the Developer tab, then continue here.',
                              e,
                            ) })
                          })
                        }}
                        className={`block mt-1 ${secondaryBtn}`}
                      >
                        Start LM Studio server
                      </button>
                    )}
                  </p>
                )}

                {/* Other alternatives collapsed */}
                {!isRunning(ollama) && !isReady(ollama) && (
                  <details className={`text-left ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    <summary className={`text-[0.6rem] cursor-pointer hover:underline ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                      Other backends
                    </summary>
                    <div className="space-y-1 mt-2 max-h-[30vh] overflow-y-auto scrollbar-thin pr-1">
                      {LOCAL_BACKENDS.filter(b => b.id !== 'ollama' && b.id !== 'lmstudio').map(b => (
                        <button
                          key={b.id}
                          onClick={() => openExternal(b.url)}
                          className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg border transition-colors group text-left ${
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
                  {!isRunning(ollama) && !isRunning(lmstudio) && !isReady(ollama) && !isReady(lmstudio) && (
                    <button onClick={runDetection} className={secondaryBtn}>
                      <RefreshCw size={12} /> Re-Scan
                    </button>
                  )}
                  {(isReady(ollama) || isReady(lmstudio) || (!isRunning(ollama) && !isRunning(lmstudio))) && (
                    <button
                      onClick={() => setStep(nextStepAfterBackends())}
                      className={(isReady(ollama) || isReady(lmstudio)) ? primaryBtn : `${secondaryBtn} opacity-60`}
                    >
                      {(isReady(ollama) || isReady(lmstudio)) ? <>Continue <ArrowRight size={14} /></> : <>Skip for now <ChevronRight size={12} /></>}
                    </button>
                  )}
                </div>
              </>
                )}
                  </div>
                </details>
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
            {/* D-S39: hier stand ein nackter 13,8px-Punkt in `bg-purple-400`
                — im Screenshot des Audits nicht von einem fehlgeschlagenen
                Icon-Load zu unterscheiden. Jetzt das Zeichen, um das es auf
                diesem Schritt geht, auf der Leiterstufe ICON_LG (20px, siehe
                ui/icon-size.ts) in einer weichen Akzentflaeche — dieselbe
                Behandlung, die `Loader2` zwei Zeilen weiter unten bekommt. */}
            <div className="mx-auto w-9 h-9 rounded-full bg-lu-accent-soft flex items-center justify-center">
              <ImageIcon size={ICON_LG} className="text-lu-accent" />
            </div>
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

            {/* Bug #3: multi-install picker. When the scan found more than
                one ComfyUI directory, LU asks the user explicitly rather
                than guessing. Each option shows whether it's complete and
                whether it ships its own python_embeded — both matter for
                start_comfyui's launcher decision. */}
            {!comfyDetecting && comfyChoices.length > 1 && !comfyFound && (
              <div className="space-y-2 text-left">
                <div className={`p-2.5 rounded-lg border ${isDark ? 'bg-amber-500/10 border-amber-500/20' : 'bg-amber-50 border-amber-200'}`}>
                  <p className={`text-[0.7rem] font-medium ${isDark ? 'text-amber-200' : 'text-amber-800'}`}>
                    Multiple ComfyUI installs detected
                  </p>
                  <p className={`text-[0.6rem] mt-0.5 ${isDark ? 'text-amber-300/80' : 'text-amber-700'}`}>
                    Pick the one you want LU to use. We'll remember your choice, and you can change it later in Settings → ComfyUI.
                  </p>
                </div>
                <div className="space-y-1.5 max-h-44 overflow-y-auto">
                  {comfyChoices.map((c) => (
                    <button
                      key={c.path}
                      onClick={() => pickComfyInstall(c)}
                      className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
                        isDark ? 'border-white/[0.08] hover:bg-white/[0.04]' : 'border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-[0.65rem] font-mono truncate ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>{c.path}</span>
                        <span className={`text-[0.5rem] px-1.5 py-[1px] rounded shrink-0 ${
                          c.complete
                            ? (isDark ? 'bg-green-500/15 text-green-400' : 'bg-green-100 text-green-700')
                            : (isDark ? 'bg-amber-500/15 text-amber-300' : 'bg-amber-100 text-amber-700')
                        }`}>
                          {c.complete ? 'ready' : 'needs setup'}
                        </span>
                      </div>
                      <div className={`flex items-center gap-2 mt-0.5 text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
                        <span>found via {c.source}</span>
                        {c.has_embedded_python && (
                          <span className={isDark ? 'text-blue-300' : 'text-blue-600'}>• bundles python_embeded</span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => { setComfyChoices([]); setComfyFound({ found: false, complete: false }) }}
                  className={`text-[0.55rem] ${isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-500 hover:text-gray-700'} underline`}
                >
                  None of these, let me install a fresh one
                </button>
              </div>
            )}

            {/* Found AND complete (a working install). The carcass case
                is handled in the install-options block below. */}
            {comfyFound?.found && comfyFound.complete !== false && !isRunning(comfyInstall) && (
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
            {comfyFound && (!comfyFound.found || comfyFound.complete === false) && !isRunning(comfyInstall) && !isRunning(pythonInstall) && !comfyReady && (
              <div className="space-y-2">
                {comfyFound.found && comfyFound.complete === false && (
                  <div className={`p-2.5 rounded-lg border ${isDark ? 'bg-amber-500/10 border-amber-500/20' : 'bg-amber-50 border-amber-200'} text-left`}>
                    <p className={`text-[0.6rem] ${isDark ? 'text-amber-300' : 'text-amber-800'}`}>
                      Found a previous ComfyUI install at <code className="font-mono">{comfyFound.path}</code> but it's missing PyTorch, looks like a previous install was interrupted. Click below to finish it.
                    </p>
                  </div>
                )}
                <button
                  onClick={async () => {
                    // P14 pre-flight, install Python first if missing,
                    // then proceed with the original ComfyUI flow. Both
                    // progress cards animate from this single click; the
                    // user never has to interact mid-flight.
                    const pythonOk = await ensurePythonInstalled()
                    if (!pythonOk) return

                    comfyDo({ type: 'start', at: Date.now(), log: 'Starting ComfyUI installation...' })
                    try {
                      await backendCall('install_comfyui')
                      // Poll installation status
                      const poll = setInterval(async () => {
                        try {
                          const status: any = await backendCall('install_comfyui_status')
                          comfyDo({
                            type: 'progress',
                            status: status.status,
                            logs: status.logs || [],
                            received: status.download_progress || 0,
                            total: status.download_total || 0,
                            speed: status.download_speed || 0,
                          })
                          if (status.status === 'complete' || status.status === 'done') {
                            clearInterval(poll)
                            comfyDo({ type: 'ready' })
                            setComfyReady(true)
                            // Auto-start ComfyUI.
                            //
                            // Level (b): the install DID finish, which is what
                            // this step was for, so the wizard moves on to its
                            // ready state either way. But "ready" would then be
                            // claiming something that is not running, so say so.
                            try {
                              await backendCall('start_comfyui')
                            } catch (e) {
                              // `warn`, nicht `fail`: die Installation IST
                              // durch — nur der Start danach nicht.
                              comfyDo({ type: 'warn', error: withDetail(
                                'ComfyUI is installed but did not start. You can start it from Settings → ComfyUI later; the rest of the setup is unaffected.',
                                e,
                              ) })
                            }
                          } else if (status.status === 'cancelled') {
                            // Bug #1: install cancelled by user, close the
                            // progress card and surface the install options
                            // again so they can retry or pick another drive.
                            clearInterval(poll)
                            comfyDo({ type: 'fail', error: 'Install cancelled.' })
                          } else if (status.status === 'error') {
                            clearInterval(poll)
                            comfyDo({ type: 'fail', error: withInstallerOutput('Installing ComfyUI did not finish.', lastLog(status.logs)) })
                          }
                        } catch { /* keep polling */ }
                      }, 2000)
                    } catch (err) {
                      comfyDo({ type: 'fail', error: err instanceof Error ? err.message : 'Installation failed' })
                    }
                  }}
                  className="lu-primary w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[0.7rem] transition-all"
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
                          // Level (b): the path — the thing the user typed —
                          // was saved, so this stays out of the outer catch and
                          // `ready` stands. Only the convenience auto-start
                          // failed, and that is worth one line rather than
                          // undoing a save that worked.
                          try {
                            await backendCall('start_comfyui')
                          } catch (e) {
                            comfyDo({ type: 'warn', error: withDetail(
                              'The path was saved, but ComfyUI did not start from it. Check that the folder holds a complete ComfyUI install, then start it from Settings → ComfyUI.',
                              e,
                            ) })
                          }
                        } catch (err) {
                          comfyDo({ type: 'warn', error: err instanceof Error ? err.message : 'Invalid path' })
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
            {isRunning(pythonInstall) && (
              <div className={`p-3 rounded-lg border ${cardClass} text-left`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin text-purple-400" />
                    <span className="text-[0.7rem] font-medium">Installing Python 3.12...</span>
                  </div>
                  <span className={`text-[0.55rem] font-mono ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                    {formatElapsed(secondsOf(pythonInstall.startedAt))}
                  </span>
                </div>
                <p className={`text-[0.55rem] mb-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  ComfyUI needs Python to run pip. We're installing it via winget, about 30 MB and 30 to 60 s on a typical connection.
                </p>
                <div className={`text-[0.55rem] font-mono max-h-24 overflow-y-auto space-y-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  {pythonInstall.logs.slice(-6).map((log, i) => (
                    <p key={i}>{log}</p>
                  ))}
                </div>
              </div>
            )}
            {pythonInstall.error && !isRunning(pythonInstall) && (
              <p className="text-[0.65rem] text-red-400 whitespace-pre-line">{pythonInstall.error}</p>
            )}

            {/* Installing progress */}
            {isRunning(comfyInstall) && (
              <div className={`p-3 rounded-lg border ${cardClass} text-left`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin text-purple-400" />
                    <span className="text-[0.7rem] font-medium">
                      {comfyInstall.logs.some(l => l.toLowerCase().includes('cancel')) ? 'Cancelling ComfyUI install…' : 'Installing ComfyUI...'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-[0.55rem] font-mono ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                      {formatElapsed(secondsOf(comfyInstall.startedAt))}
                      {/* Bug #1: rolling ETA from download bytes when known. */}
                      {comfyInstall.speed > 0 && comfyInstall.total > 0 && comfyInstall.received < comfyInstall.total && (() => {
                        const remaining = comfyInstall.total - comfyInstall.received
                        const etaSec = Math.round(remaining / Math.max(1, comfyInstall.speed))
                        const m = Math.floor(etaSec / 60)
                        const s = etaSec % 60
                        return ` • ETA ${m}:${String(s).padStart(2, '0')}`
                      })()}
                    </span>
                    {/* Cancel button (Bug #1 — techx69) */}
                    <button
                      onClick={async () => {
                        // Level (c): Cancel is the only way out of a multi-GB
                        // download. If the call fails the progress bar keeps
                        // filling and the button looks broken — and the user is
                        // still paying for the bandwidth.
                        comfyDo({ type: 'warn', error: '' })
                        try {
                          await backendCall('cancel_comfyui_install')
                        } catch (e) {
                          comfyDo({ type: 'warn', error: withDetail(
                            'The install could not be cancelled and is still running. Try Cancel once more; if it keeps going, closing LU stops the download.',
                            e,
                          ) })
                        }
                      }}
                      className={`text-[0.55rem] px-1.5 py-[1px] rounded border transition-colors ${
                        isDark
                          ? 'border-red-500/40 text-red-300 hover:bg-red-500/10'
                          : 'border-red-300 text-red-600 hover:bg-red-50'
                      }`}
                      title="Cancel ComfyUI install"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
                {/* Disk pressure warning (push from Rust side) */}
                {comfyInstall.logs.some(l => l.startsWith('⚠')) && (
                  <div className={`text-[0.55rem] mb-2 px-2 py-1 rounded ${isDark ? 'bg-amber-500/10 text-amber-300' : 'bg-amber-50 text-amber-800'}`}>
                    {comfyInstall.logs.find(l => l.startsWith('⚠'))}
                  </div>
                )}
                {/* Download progress bar (shown during download phase) */}
                {comfyInstall.logs.some(l => l.includes('Downloading')) && comfyInstall.total > 0 && (
                  <div className="space-y-1 mb-2">
                    <ProgressBar progress={comfyInstall.total > 0 ? (comfyInstall.received / comfyInstall.total) * 100 : 0} />
                    <div className="flex justify-between">
                      <span className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                        {formatBytes(comfyInstall.received)} / {formatBytes(comfyInstall.total)}
                      </span>
                      <span className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                        {comfyInstall.speed > 0 ? `${formatBytes(comfyInstall.speed)}/s` : ''}
                      </span>
                    </div>
                  </div>
                )}
                <div className={`text-[0.55rem] font-mono max-h-24 overflow-y-auto space-y-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  {comfyInstall.logs.slice(-8).map((log, i) => (
                    <p key={i}>{log}</p>
                  ))}
                </div>
              </div>
            )}

            {/* Error */}
            {comfyInstall.error && (
              <p role="alert" className="text-[0.65rem] text-red-400 whitespace-pre-line">{comfyInstall.error}</p>
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
              {!isRunning(comfyInstall) && !isRunning(pythonInstall) && (!comfyFound?.found || comfyFound.complete === false) && !comfyReady && (
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
                One small model to get you running. You can browse and install more from the Models tab once you're in.
              </p>
            </div>

            {/* Unfiltered / Mainstream tabs, only meaningful when both
                categories have entries. With the curated single-starter list
                (P4) the tabs are hidden; reintroduce only if the list grows. */}
            {ONBOARDING_MODELS.some(m => m.uncensored) && ONBOARDING_MODELS.some(m => !m.uncensored) && (
              <div className="flex gap-4 justify-center">
                <button onClick={() => setModelSubTab('uncensored')} className={`flex items-center gap-2 transition-all ${modelSubTab === 'uncensored' ? 'opacity-100' : 'opacity-40 hover:opacity-70'}`}>
                  <div className={`w-1 h-4 rounded-full ${modelSubTab === 'uncensored' ? 'bg-red-500' : 'bg-red-500/50'}`} />
                  <span className="text-[0.65rem] font-semibold uppercase tracking-wider">Unfiltered</span>
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
                    className={`text-left p-2.5 rounded-lg border transition-colors ${
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
                  className="lu-primary flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.7rem] transition-all"
                >
                  <Download size={14} /> Install {selectedModels.length} model{selectedModels.length > 1 ? 's' : ''}
                </button>
              ) : !isDownloading ? (
                <button
                  onClick={() => setStep('embeddings')}
                  className={`flex-1 flex items-center justify-center gap-1.5 ${secondaryBtn}`}
                >
                  Skip for now <ChevronRight size={14} />
                </button>
              ) : null}
            </div>
          </motion.div>
        )}

        {/* Step 5: Embeddings (GH #45, Document Chat / RAG) */}
        {step === 'embeddings' && (
          <motion.div
            key="embeddings"
            className="max-w-md w-full space-y-3"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <div className="text-center mb-2">
              <h2 className="text-base font-semibold mb-1">Document Chat (optional)</h2>
              <p className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                Drop a PDF, Word doc, or text file into chat and the model can answer questions about it. Needs a small embedding model.
              </p>
            </div>

            {embeddingsAlreadyHave === true && !embeddingsPulled && (
              <div className={`p-3 rounded-lg border ${isDark ? 'bg-green-500/10 border-green-500/20' : 'bg-green-50 border-green-200'}`}>
                <div className="flex items-center gap-2 justify-center">
                  <Check size={14} className="text-green-400" />
                  <span className="text-[0.7rem] font-medium">Embedding model already installed, Document Chat is ready.</span>
                </div>
              </div>
            )}

            {embeddingsAlreadyHave !== true && (
              <div className={`p-3 rounded-lg border ${cardClass}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-[0.7rem] font-medium">nomic-embed-text</p>
                    <p className={`text-[0.6rem] mt-0.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                      Standard embedding model from Nomic AI. Used purely on-device to chunk and retrieve your documents, never sent anywhere.
                    </p>
                    <p className={`text-[0.55rem] mt-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                      {embedsViaBundled ? '84 MB · bundled engine, runs on any CPU' : '274 MB · runs on any CPU'}
                    </p>
                  </div>
                </div>

                {embeddingsPulling && (
                  <div className="mt-2.5 space-y-1">
                    <ProgressBar progress={embeddingsProgress.total > 0 ? (embeddingsProgress.completed / embeddingsProgress.total) * 100 : 0} />
                    <p className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                      {embeddingsProgress.total > 0
                        ? `${formatBytes(embeddingsProgress.completed)} / ${formatBytes(embeddingsProgress.total)}`
                        : 'Starting…'}
                    </p>
                  </div>
                )}

                {embeddingsPulled && (
                  <div className="mt-2.5 flex items-center gap-2 text-[0.65rem] text-green-400">
                    <Check size={12} /> Installed. Document Chat is ready.
                  </div>
                )}

                {embeddingsError && (
                  <p className="text-[0.6rem] text-red-400 mt-2">{embeddingsError}</p>
                )}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              {embeddingsAlreadyHave !== true && !embeddingsPulled && !embeddingsPulling && (
                <button onClick={handlePullEmbeddings} className={primaryBtn} style={{ flex: 1 }}>
                  <Download size={14} /> Install nomic-embed-text ({embedsViaBundled ? '84 MB' : '274 MB'})
                </button>
              )}
              <button
                onClick={() => setStep('done')}
                disabled={embeddingsPulling}
                className={`${secondaryBtn} ${embeddingsPulling ? 'opacity-40 cursor-not-allowed' : ''}`}
                style={{ flex: embeddingsAlreadyHave === true || embeddingsPulled ? 1 : undefined }}
              >
                {embeddingsAlreadyHave === true || embeddingsPulled ? (
                  <>Continue <ArrowRight size={14} /></>
                ) : (
                  <>Skip for now <ChevronRight size={14} /></>
                )}
              </button>
            </div>
          </motion.div>
        )}

        {/* Step 6: Done */}
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
            <p className={`text-[12px] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {pulledModels.length > 0
                ? `${pulledModels.length} model${pulledModels.length > 1 ? 's' : ''} installed. You're ready to go.`
                : selectedBackend === BUILTIN_BACKEND_ID
                ? 'The built-in engine is ready. Install a model anytime from the Models tab.'
                : detectedBackends.length > 0
                ? `Connected to ${detectedBackends.find(b => b.id === selectedBackend)?.name || detectedBackends[0].name}. You're ready to go.`
                : 'You can configure backends and install models anytime from Settings and the Models tab.'}
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
