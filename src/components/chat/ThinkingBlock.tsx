import { useState, useRef, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Brain } from 'lucide-react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { stripModelNoise } from '../../lib/strip-model-noise'
import { MOTION_S } from '../ui/motion'

interface Props {
    thinking: string
    /** True while the model is actively producing this turn. While it is,
     *  the COLLAPSED block shows a bounded, self-scrolling live peek of the
     *  reasoning (G14-7, David 2026-08-07: thinking stays folded everywhere
     *  and streams inside a 3-4 line window; supersedes the 2026-06-04
     *  auto-expand). The user can still expand for the full text. */
    streaming?: boolean
}

// Four lines of the 0.65rem / leading-relaxed reasoning text.
const PREVIEW_MAX_H = 'max-h-[68px]'

export function ThinkingBlock({ thinking, streaming }: Props) {
    const [open, setOpen] = useState(false)
    const previewRef = useRef<HTMLDivElement>(null)

    // Keep the live peek pinned to the newest reasoning. No dep array on
    // purpose: the text grows every streaming frame, so this runs each render
    // and the window tracks the bottom, same pattern as SlashStepsBlock.
    useEffect(() => {
        if (streaming && !open && previewRef.current) {
            previewRef.current.scrollTop = previewRef.current.scrollHeight
        }
    })

    // Strip orchestration out of the reasoning too (2.5.9): Qwen3-32B writes
    // its planned call as a raw <tool_call> tag inside the thought, and that
    // call is already rendered properly as its own block right below. Guard on
    // the CLEANED text so a thought that was nothing but a tag does not leave
    // an empty "Thinking" header behind.
    const cleaned = useMemo(() => stripModelNoise(thinking || ''), [thinking])
    if (!cleaned) return null

    return (
        <div className="mb-0.5">
            <button
                onClick={() => setOpen((o) => !o)}
                className="flex items-center gap-1.5 py-0.5 text-left hover:opacity-80 transition-opacity"
                aria-label="Toggle thinking details"
            >
                <Brain size={10} className="text-blue-400/70 shrink-0" />
                <span className={`t-micro text-blue-400 ${streaming ? 'lu-tool-shimmer' : ''}`}>Thinking</span>
                <ChevronDown
                    size={9}
                    className={`text-blue-400/50 transition-transform duration-[var(--motion-base)] ${open ? 'rotate-180' : ''}`}
                />
            </button>

            {!open && streaming && (
                // Collapsed + streaming: bounded live peek. The top fades so
                // older reasoning scrolls up out of view; clicks fall through
                // to the header toggle.
                <div
                    ref={previewRef}
                    className={`pl-4 pb-1 pt-0.5 ${PREVIEW_MAX_H} overflow-hidden pointer-events-none [mask-image:linear-gradient(to_bottom,transparent,#000_20px)]`}
                >
                    <div className="t-micro leading-relaxed italic text-blue-200/60">
                        <MarkdownRenderer content={cleaned} />
                    </div>
                </div>
            )}

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: MOTION_S.base }}
                        className="overflow-hidden"
                    >
                        <div className="pl-4 pb-1 pt-0.5">
                            <div className="t-micro leading-relaxed italic text-blue-200/60">
                                <MarkdownRenderer content={cleaned} />
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
