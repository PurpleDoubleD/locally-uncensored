/**
 * Schritt „Engine": was auf dieser Maschine schon laeuft, und was LU
 * stattdessen selbst installieren kann.
 *
 * Warum es dieses Modul gibt: alles, was dieser Bildschirm an EIGENEM Zustand
 * hat, liest niemand sonst — die zwei Installationsablaeufe (Ollama, LM Studio)
 * mit ihren Pollschleifen, die Liste der zwoelf bekannten Backends samt ihren
 * Standardports, und die zwei Zweige „gefunden" / „nichts gefunden". Das sind
 * rund vierhundert Zeilen, die in der Wurzel des Assistenten nur lagen, weil
 * sie dort entstanden sind.
 *
 * Was NICHT hier liegt, obwohl es hier gezeichnet wird:
 *   • Das Scan-Ergebnis (`useBackendScan`) — fuenf Bildschirme lesen es.
 *   • Die Installer-Maschinen (`useInstallerFleet`) — ComfyUI und Python
 *     laufen auf derselben, und alle vier teilen sich EINEN Takt.
 *   • `selectBackendAndContinue` — das ist die Weiche des Assistenten, nicht
 *     die dieses Bildschirms: sie schreibt den Provider-Store und entscheidet,
 *     welcher Schritt als naechster kommt.
 * Der Schnitt liegt also genau dort, wo der Zustand aufhoert, geteilt zu sein.
 */
import { Loader2, Check, Download, RefreshCw, ArrowRight, ChevronRight, ExternalLink, Cpu } from 'lucide-react'
import { withInstallerOutput, withDetail } from '../../lib/error-text'
import { useProviderStore } from '../../stores/providerStore'
import { BUILTIN_BACKEND_ID } from '../../lib/onboarding-backend'
import { ProgressBar } from '../ui/ProgressBar'
import { backendCall, openExternal } from '../../api/backend'
import { formatBytes } from '../../lib/formatters'
import { isRunning, isReady, formatElapsed, lastLog, type InstallerStatusResponse } from './installer-state'
import type { Step } from './wizard-steps'
import type { OnboardingSkin } from './onboarding-skin'
import type { BackendScan } from './use-backend-scan'
import type { InstallerFleet } from './use-installer-fleet'

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

interface BackendsStepProps {
  skin: OnboardingSkin
  scan: BackendScan
  fleet: InstallerFleet
  setStep: (step: Step) => void
  nextStepAfterBackends: () => Step
  selectBackendAndContinue: () => void
}

export function BackendsStep({ skin, scan, fleet, setStep, nextStepAfterBackends, selectBackendAndContinue }: BackendsStepProps) {
  const { isDark, cardClass, primaryBtn, secondaryBtn } = skin
  const {
    detectedBackends, detecting, selectedBackend, setSelectedBackend,
    lmstudioOfflineDetected, lmstudioModelCount, runDetection,
  } = scan
  const { ollama, ollamaDo, lmstudio, lmstudioDo, secondsOf } = fleet
  const { setProviderConfig } = useProviderStore()

  return (
    <>
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
            {/* Punkt 2: dieser Knopf hiess ebenfalls „Continue" — genau wie der
                eine Bildschirm weiter oben, der mit der eingebauten Maschine
                weitermacht. Beide rufen `selectBackendAndContinue`; der
                Unterschied ist, WOMIT weitergemacht wird, und der stand in
                keinem der beiden Namen.

                Zwei Folgen, eine sichtbar, eine nicht: ein Screenreader hoerte
                auf dem aufgeklappten Schritt zweimal dasselbe Wort ohne
                Unterschied, und `getByRole('button', { name: /Continue/i })`
                loeste bei offener Klappe auf ZWEI Elemente auf. Playwright
                WIEDERHOLT eine strict-mode-Verletzung im Klick bis zum Timeout,
                statt sofort zu scheitern — der Fehler sah deshalb aus wie 60 s
                Warten an einem Knopf, der weder deaktiviert noch animiert ist.
                Bei zugeklappter Klappe filtert Playwright den verborgenen weg,
                deshalb war die Suite gruen und der Fall trotzdem scharf.

                Der Name sagt jetzt, was er tut: WEITER MIT DIESER Maschine,
                der oben ausgewaehlten aus der Liste darueber. Der Wortlaut
                greift die Klappe auf, die darueber steht („Use another
                engine…"): erst „eine andere Maschine", dann „diese hier". */}
            <button
              onClick={selectBackendAndContinue}
              className={primaryBtn}
            >
              Use this engine <ArrowRight size={14} />
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
                      const s = await backendCall<InstallerStatusResponse>('install_ollama_status')
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
                      const s = await backendCall<InstallerStatusResponse>('install_lmstudio_status')
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
    </>
  )
}
