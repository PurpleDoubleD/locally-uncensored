import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Cpu, Sun, Moon, ArrowRight, Download, Check, ChevronRight } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useModels } from '../../hooks/useModels'
import { ONBOARDING_MODELS, type OnboardingModel } from '../../lib/constants'
import { ProgressBar } from '../ui/ProgressBar'
import { formatBytes } from '../../lib/formatters'

type Step = 'welcome' | 'theme' | 'models' | 'done'

export function Onboarding() {
  const [step, setStep] = useState<Step>('welcome')
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const { settings, updateSettings } = useSettingsStore()
  const { pullModel, isPulling, pullProgress, models: installedModels } = useModels()
  const [pullingModel, setPullingModel] = useState<string | null>(null)
  const [pulledModels, setPulledModels] = useState<string[]>([])

  const isDark = settings.theme === 'dark'
  const bgClass = isDark ? 'bg-[#212121] text-white' : 'bg-white text-gray-900'
  const cardClass = isDark ? 'bg-[#2f2f2f] border-white/10' : 'bg-gray-50 border-gray-200'

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

  return (
    <div className={`h-screen w-screen flex items-center justify-center p-4 ${bgClass}`}>
      <AnimatePresence mode="wait">
        {/* Step 1: Welcome */}
        {step === 'welcome' && (
          <motion.div
            key="welcome"
            className="max-w-md w-full text-center space-y-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <div className={`w-20 h-20 rounded-2xl flex items-center justify-center mx-auto ${isDark ? 'bg-white/10' : 'bg-gray-100'}`}>
              <Cpu size={40} className={isDark ? 'text-gray-300' : 'text-gray-600'} />
            </div>
            <h1 className="text-3xl font-bold">Locally Uncensored</h1>
            <p className={isDark ? 'text-gray-400' : 'text-gray-500'}>
              Private, local AI chat. No servers, no tracking, everything stays on your machine.
            </p>
            <button
              onClick={() => setStep('theme')}
              className={`mx-auto flex items-center gap-2 px-6 py-3 rounded-xl font-medium transition-all ${
                isDark ? 'bg-white text-black hover:bg-gray-200' : 'bg-gray-900 text-white hover:bg-gray-800'
              }`}
            >
              Get Started <ArrowRight size={18} />
            </button>
          </motion.div>
        )}

        {/* Step 2: Theme */}
        {step === 'theme' && (
          <motion.div
            key="theme"
            className="max-w-md w-full text-center space-y-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <h2 className="text-2xl font-bold">Choose your theme</h2>
            <p className={isDark ? 'text-gray-400' : 'text-gray-500'}>You can change this later in settings.</p>
            <div className="flex gap-4 justify-center">
              <button
                onClick={() => updateSettings({ theme: 'light' })}
                className={`flex flex-col items-center gap-3 p-6 rounded-xl border-2 transition-all w-40 ${
                  !isDark ? 'border-gray-900 bg-gray-50' : 'border-white/10 hover:border-white/20'
                }`}
              >
                <Sun size={32} className={isDark ? 'text-gray-400' : 'text-yellow-500'} />
                <span className="font-medium">Light</span>
              </button>
              <button
                onClick={() => updateSettings({ theme: 'dark' })}
                className={`flex flex-col items-center gap-3 p-6 rounded-xl border-2 transition-all w-40 ${
                  isDark ? 'border-white bg-white/10' : 'border-gray-200 hover:border-gray-400'
                }`}
              >
                <Moon size={32} className={isDark ? 'text-white' : 'text-gray-600'} />
                <span className="font-medium">Dark</span>
              </button>
            </div>
            <button
              onClick={() => setStep('models')}
              className={`mx-auto flex items-center gap-2 px-6 py-3 rounded-xl font-medium transition-all ${
                isDark ? 'bg-white text-black hover:bg-gray-200' : 'bg-gray-900 text-white hover:bg-gray-800'
              }`}
            >
              Next <ArrowRight size={18} />
            </button>
          </motion.div>
        )}

        {/* Step 3: Models */}
        {step === 'models' && (
          <motion.div
            key="models"
            className="max-w-2xl w-full space-y-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <div className="text-center mb-6">
              <h2 className="text-2xl font-bold mb-2">Choose your models</h2>
              <p className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                Select uncensored models to install. You can add more later.
              </p>
            </div>

            {isPulling && pullingModel && (
              <div className={`p-4 rounded-xl border ${cardClass}`}>
                <p className="text-sm mb-2">
                  Installing <span className="font-mono font-medium">{pullingModel}</span>...
                </p>
                <p className={`text-xs mb-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{pullProgress?.status}</p>
                {pullProgress?.total && pullProgress?.completed !== undefined && (
                  <ProgressBar progress={progress} />
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[50vh] overflow-y-auto scrollbar-thin pr-1">
              {ONBOARDING_MODELS.map((model) => {
                const selected = selectedModels.includes(model.name)
                const pulled = pulledModels.includes(model.name) || installedModels.some((m) => m.name === model.name)
                return (
                  <button
                    key={model.name}
                    onClick={() => !pulled && !isPulling && toggleModel(model.name)}
                    disabled={pulled || isPulling}
                    className={`text-left p-4 rounded-xl border transition-all ${
                      pulled
                        ? isDark ? 'bg-green-500/10 border-green-500/30' : 'bg-green-50 border-green-300'
                        : selected
                        ? isDark ? 'bg-white/10 border-white/30' : 'bg-gray-100 border-gray-900'
                        : isDark ? 'border-white/10 hover:border-white/20' : 'border-gray-200 hover:border-gray-400'
                    } ${isPulling ? 'opacity-60' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{model.label}</span>
                          {model.recommended && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${isDark ? 'bg-white/10 text-gray-300' : 'bg-gray-200 text-gray-600'}`}>
                              Recommended
                            </span>
                          )}
                        </div>
                        <p className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{model.description}</p>
                        <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                          {model.size} · VRAM: {model.vram}
                        </p>
                      </div>
                      {pulled ? (
                        <Check size={18} className="text-green-400 shrink-0 mt-1" />
                      ) : selected ? (
                        <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 mt-1 ${isDark ? 'bg-white' : 'bg-gray-900'}`}>
                          <Check size={14} className={isDark ? 'text-black' : 'text-white'} />
                        </div>
                      ) : (
                        <div className={`w-5 h-5 rounded border shrink-0 mt-1 ${isDark ? 'border-white/20' : 'border-gray-300'}`} />
                      )}
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="flex items-center gap-3 pt-2">
              {selectedModels.length > 0 && !isPulling ? (
                <button
                  onClick={handlePullSelected}
                  className={`flex-1 flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-medium transition-all ${
                    isDark ? 'bg-white text-black hover:bg-gray-200' : 'bg-gray-900 text-white hover:bg-gray-800'
                  }`}
                >
                  <Download size={18} /> Install {selectedModels.length} model{selectedModels.length > 1 ? 's' : ''}
                </button>
              ) : !isPulling ? (
                <button
                  onClick={() => setStep('done')}
                  className={`flex-1 flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-medium transition-all ${
                    isDark ? 'bg-white/10 text-white hover:bg-white/15' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Skip for now <ChevronRight size={18} />
                </button>
              ) : null}
            </div>
          </motion.div>
        )}

        {/* Step 4: Done */}
        {step === 'done' && (
          <motion.div
            key="done"
            className="max-w-md w-full text-center space-y-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <div className={`w-20 h-20 rounded-2xl flex items-center justify-center mx-auto ${isDark ? 'bg-green-500/10' : 'bg-green-50'}`}>
              <Check size={40} className="text-green-400" />
            </div>
            <h2 className="text-2xl font-bold">You're all set!</h2>
            <p className={isDark ? 'text-gray-400' : 'text-gray-500'}>
              {pulledModels.length > 0
                ? `${pulledModels.length} model${pulledModels.length > 1 ? 's' : ''} installed. Start chatting!`
                : 'You can install models anytime from the Model Manager.'}
            </p>
            <button
              onClick={finish}
              className={`mx-auto flex items-center gap-2 px-6 py-3 rounded-xl font-medium transition-all ${
                isDark ? 'bg-white text-black hover:bg-gray-200' : 'bg-gray-900 text-white hover:bg-gray-800'
              }`}
            >
              Start Chatting <ArrowRight size={18} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
