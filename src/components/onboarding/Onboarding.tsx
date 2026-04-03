import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sun, Moon, ArrowRight, Download, Check, ChevronRight, Loader2 } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { useModels } from '../../hooks/useModels'
import { ONBOARDING_MODELS, type OnboardingModel } from '../../lib/constants'
import { PROVIDER_PRESETS } from '../../api/providers/types'
import { detectLocalBackends, type DetectedBackend } from '../../lib/backend-detector'
import { ProgressBar } from '../ui/ProgressBar'
import { formatBytes } from '../../lib/formatters'

type Step = 'welcome' | 'theme' | 'backends' | 'models' | 'done'

export function Onboarding() {
  const [step, setStep] = useState<Step>('welcome')
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const { settings, updateSettings } = useSettingsStore()
  const { pullModel, isPulling, pullProgress, models: installedModels } = useModels()
  const [pullingModel, setPullingModel] = useState<string | null>(null)
  const [pulledModels, setPulledModels] = useState<string[]>([])
  const [detectedBackends, setDetectedBackends] = useState<DetectedBackend[]>([])
  const [detecting, setDetecting] = useState(false)
  const [selectedBackend, setSelectedBackend] = useState<string>('')
  const { setProviderConfig } = useProviderStore()

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

  const progress =
    pullProgress?.total && pullProgress?.completed
      ? (pullProgress.completed / pullProgress.total) * 100
      : 0

  // Shared button styles
  const primaryBtn = `mx-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.7rem] font-medium transition-all ${
    isDark ? 'bg-white text-black hover:bg-gray-200' : 'bg-gray-900 text-white hover:bg-gray-800'
  }`
  const secondaryBtn = `mx-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.7rem] font-medium transition-all ${
    isDark ? 'bg-white/10 text-white hover:bg-white/15' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
  }`

  return (
    <div className={`h-screen w-screen flex items-center justify-center p-4 ${bgClass}`}>
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
                <Sun size={18} className={isDark ? 'text-gray-400' : 'text-yellow-500'} />
                <span className="text-[0.7rem] font-medium">Light</span>
              </button>
              <button
                onClick={() => updateSettings({ theme: 'dark' })}
                className={`flex flex-col items-center gap-2 p-4 rounded-lg border transition-all w-28 ${
                  isDark ? 'border-white bg-white/10' : 'border-gray-200 hover:border-gray-400'
                }`}
              >
                <Moon size={18} className={isDark ? 'text-white' : 'text-gray-600'} />
                <span className="text-[0.7rem] font-medium">Dark</span>
              </button>
            </div>
            <button
              onClick={() => {
                setStep('backends')
                setDetecting(true)
                detectLocalBackends().then((backends) => {
                  setDetectedBackends(backends)
                  const nonOllama = backends.filter(b => b.id !== 'ollama')
                  if (nonOllama.length > 0) setSelectedBackend(nonOllama[0].id)
                  setDetecting(false)
                  if (nonOllama.length === 0) setStep('models')
                })
              }}
              className={primaryBtn}
            >
              Next <ArrowRight size={14} />
            </button>
          </motion.div>
        )}

        {/* Step 2.5: Detected Backends */}
        {step === 'backends' && (
          <motion.div
            key="backends"
            className="max-w-sm w-full text-center space-y-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            {detecting ? (
              <>
                <Loader2 size={18} className="mx-auto animate-spin text-gray-400" />
                <h2 className="text-base font-semibold">Scanning for local backends...</h2>
                <p className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  Checking LM Studio, vLLM, KoboldCpp, and other local inference servers.
                </p>
              </>
            ) : (
              <>
                <h2 className="text-base font-semibold">Local backends detected</h2>
                <p className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  We found {detectedBackends.length} backend{detectedBackends.length > 1 ? 's' : ''} running on your system.
                </p>

                <div className="space-y-1.5 text-left">
                  {detectedBackends.filter(b => b.id === 'ollama').map(b => (
                    <div key={b.id} className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg border ${isDark ? 'bg-green-500/5 border-green-500/15' : 'bg-green-50 border-green-200'}`}>
                      <div className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                      <div>
                        <p className="text-[0.7rem] font-medium">{b.name}</p>
                        <p className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'} font-mono`}>localhost:{b.port} — always active</p>
                      </div>
                    </div>
                  ))}

                  {detectedBackends.filter(b => b.id !== 'ollama').map(b => (
                    <button
                      key={b.id}
                      onClick={() => setSelectedBackend(b.id)}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border text-left transition-all ${
                        selectedBackend === b.id
                          ? isDark ? 'bg-white/10 border-white/20' : 'bg-gray-100 border-gray-900'
                          : isDark ? 'border-white/10 hover:border-white/20' : 'border-gray-200 hover:border-gray-400'
                      }`}
                    >
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${selectedBackend === b.id ? (isDark ? 'bg-white' : 'bg-gray-900') : 'bg-gray-500'}`} />
                      <div>
                        <p className="text-[0.7rem] font-medium">{b.name}</p>
                        <p className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'} font-mono`}>localhost:{b.port}</p>
                      </div>
                    </button>
                  ))}
                </div>

                <button
                  onClick={() => {
                    const backend = detectedBackends.find(b => b.id === selectedBackend)
                    if (backend && backend.id !== 'ollama') {
                      // Disable Ollama, enable selected backend
                      setProviderConfig('ollama', { enabled: false })
                      setProviderConfig('openai', {
                        enabled: true,
                        name: backend.name,
                        baseUrl: backend.baseUrl,
                        isLocal: true,
                      })
                      // Skip model pull step (not Ollama)
                      setStep('done')
                    } else {
                      setStep('models')
                    }
                  }}
                  className={primaryBtn}
                >
                  Continue <ArrowRight size={14} />
                </button>
              </>
            )}
          </motion.div>
        )}

        {/* Step 3: Models */}
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
                Select uncensored models to install. You can add more later.
              </p>
            </div>

            {isPulling && pullingModel && (
              <div className={`p-2.5 rounded-lg border ${cardClass}`}>
                <p className="text-[0.7rem] mb-1">
                  Installing <span className="font-mono font-medium">{pullingModel}</span>...
                </p>
                <p className={`text-[0.6rem] mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{pullProgress?.status}</p>
                {pullProgress?.total && pullProgress?.completed !== undefined && (
                  <ProgressBar progress={progress} />
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[50vh] overflow-y-auto scrollbar-thin pr-1">
              {ONBOARDING_MODELS.map((model) => {
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

        {/* Step 4: Done */}
        {step === 'done' && (
          <motion.div
            key="done"
            className="max-w-sm w-full text-center space-y-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center mx-auto ${isDark ? 'bg-green-500/10' : 'bg-green-50'}`}>
              <Check size={20} className="text-green-400" />
            </div>
            <h2 className="text-base font-semibold">You're all set!</h2>
            <p className={`text-[0.75rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {pulledModels.length > 0
                ? `${pulledModels.length} model${pulledModels.length > 1 ? 's' : ''} installed. Start chatting!`
                : 'You can install models anytime from the Model Manager.'}
            </p>
            <button onClick={finish} className={primaryBtn}>
              Start Chatting <ArrowRight size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
