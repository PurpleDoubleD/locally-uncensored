import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronRight, ChevronLeft } from 'lucide-react'
import { Modal } from '../ui/Modal'

interface Props {
  open: boolean
  onClose: () => void
  onComplete: () => void
}

const STEPS = [
  {
    title: 'Welcome to Agent Mode',
    description: 'Your AI can now use tools to take action — search the web, read and write files, execute code, and generate images. All locally, all uncensored.',
    tagline: 'Generate anything — text, images, video. Locally. Uncensored.',
    accent: 'bg-green-500',
  },
  {
    title: 'Available Tools',
    description: 'Agent Mode gives your model access to powerful tools. Safe actions run automatically — risky ones always ask for approval first.',
    tools: [
      { name: 'Web Search', desc: 'Search the internet for current information', accent: 'bg-blue-400' },
      { name: 'File Read/Write', desc: 'Read and create files on your system', accent: 'bg-amber-400' },
      { name: 'Code Execute', desc: 'Run Python or shell commands', accent: 'bg-purple-400' },
    ],
    accent: 'bg-blue-500',
  },
]

export function AgentTutorial({ open, onClose, onComplete }: Props) {
  const [step, setStep] = useState(0)
  const current = STEPS[step]
  const isLast = step === STEPS.length - 1

  return (
    <Modal open={open} onClose={onClose} title="">
      <div className="space-y-4">
        {/* Step indicator */}
        <div className="flex items-center justify-center gap-1.5">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`w-1.5 h-1.5 rounded-full transition-colors ${
                i === step ? 'bg-green-400' : 'bg-white/10'
              }`}
            />
          ))}
        </div>

        {/* Content */}
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2 }}
            className="text-center space-y-3"
          >
            {/* Accent dot instead of icon */}
            <div className="flex justify-center">
              <div className={`w-3 h-3 rounded-full ${current.accent} shadow-lg`}
                style={{ boxShadow: `0 0 20px 4px currentColor` }}
              />
            </div>

            <h3 className="text-base font-semibold text-white">{current.title}</h3>
            <p className="text-[0.75rem] text-gray-400 leading-relaxed">{current.description}</p>

            {current.tagline && (
              <p className="text-[0.7rem] text-green-400/80 font-medium italic">{current.tagline}</p>
            )}

            {current.tools && (
              <div className="space-y-2 pt-1">
                {current.tools.map((tool) => (
                  <div key={tool.name} className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                    <div className={`w-1.5 h-1.5 rounded-full ${tool.accent} shrink-0`} />
                    <div className="text-left">
                      <p className="text-[0.7rem] text-white font-medium">{tool.name}</p>
                      <p className="text-[0.6rem] text-gray-500">{tool.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

          </motion.div>
        </AnimatePresence>

        {/* Don't show again — visible on last step */}
        {isLast && (
          <label className="flex items-center justify-center gap-2 cursor-pointer group">
            <input
              type="checkbox"
              checked={true}
              disabled
              className="w-3.5 h-3.5 rounded border-white/20 bg-white/5 text-green-500 focus:ring-green-500/30 focus:ring-offset-0 opacity-50"
            />
            <span className="text-[0.65rem] text-gray-500 select-none">
              Don't show this again
            </span>
          </label>
        )}

        {/* Navigation */}
        <div className="flex items-center justify-between pt-2">
          <button
            onClick={() => setStep(Math.max(0, step - 1))}
            disabled={step === 0}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[0.7rem] text-gray-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft size={14} />
            Back
          </button>

          {isLast ? (
            <button
              onClick={onComplete}
              className="flex items-center gap-1 px-4 py-1.5 rounded-lg text-[0.7rem] font-medium bg-green-500/15 border border-green-500/30 text-green-300 hover:bg-green-500/25 transition-colors"
            >
              Enable Agent Mode
              <ChevronRight size={14} />
            </button>
          ) : (
            <button
              onClick={() => setStep(step + 1)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[0.7rem] text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
            >
              Next
              <ChevronRight size={14} />
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}
