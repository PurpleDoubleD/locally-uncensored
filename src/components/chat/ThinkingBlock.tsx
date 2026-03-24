import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Brain } from 'lucide-react'
import { MarkdownRenderer } from './MarkdownRenderer'

interface Props {
    thinking: string
}

export function ThinkingBlock({ thinking }: Props) {
    const [open, setOpen] = useState(false)

    if (!thinking) return null

    return (
        <motion.div
            className="mb-2"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
        >
            <div className="rounded-xl bg-blue-50 dark:bg-blue-500/8 border border-blue-200/50 dark:border-blue-400/15 overflow-hidden">
                {/* Toggle header */}
                <button
                    onClick={() => setOpen(!open)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-blue-100/50 dark:hover:bg-blue-500/10 transition-colors"
                >
                    <Brain size={13} className="text-blue-400 dark:text-blue-300/70 shrink-0" />
                    <span className="text-[0.7rem] font-medium text-blue-500 dark:text-blue-300/80 tracking-wide">
                        Thinking
                    </span>
                    <ChevronDown
                        size={12}
                        className={`text-blue-400 dark:text-blue-300/60 ml-auto transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
                    />
                </button>

                {/* Collapsible content */}
                <AnimatePresence>
                    {open && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                        >
                            <div className="px-3 pb-3 pt-1">
                                <div className="text-[0.72rem] leading-relaxed italic text-blue-600/70 dark:text-blue-200/50 font-light">
                                    <MarkdownRenderer content={thinking} />
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </motion.div>
    )
}
