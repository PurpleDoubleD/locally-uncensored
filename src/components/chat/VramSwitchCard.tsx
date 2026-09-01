/**
 * Feature EE (v2.5.0) — VRAM hand-off status card.
 *
 * Rendered inside the active assistant message while the image/video generation
 * orchestrator swaps the chat model out of VRAM and the ComfyUI model in. It
 * subscribes (via useVramHandoff) to the orchestrator's phase events and shows
 * HONEST per-phase copy — the point of the swap is OOM-avoidance + keeping the
 * conversation intact, NOT speed, so the copy says "~30-90s" plainly and never
 * implies a seamless zero-latency experience.
 *
 * Visibility: shown for the whole generation (model loading → generating →
 * restoring), for image AND video. When an actual VRAM eviction happens
 * (`evicted`) the copy talks about freeing VRAM / the swap; when the models
 * co-exist and nothing is evicted (the common image case) it shows plain
 * "loading the image model / generating" with no false "freeing VRAM" claim
 * (David 2026-06-16). Cloud/remote/'never' generations emit no phases at all,
 * so the card stays hidden there and the ToolCallBlock spinner conveys progress.
 */

import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, Cpu, Check } from 'lucide-react'
import { useVramHandoff } from '../../hooks/useVramHandoff'
import type { HandoffPhase } from '../../api/vram-handoff'
import { MOTION_S } from '../ui/motion'

function copyFor(phase: HandoffPhase | null, kind: 'image' | 'video' | null, detail: string | null, evicted: boolean): { text: string; sub?: string; done?: boolean } {
  const what = kind === 'video' ? 'video' : 'image'
  switch (phase) {
    case 'deciding':
      return { text: 'Checking VRAM…' }
    case 'freeing_vram':
      return {
        text: 'Freeing VRAM for the ' + what + ' model',
        sub: detail ? `unloading ${detail} (chat is preserved)` : 'unloading the chat model (chat is preserved)',
      }
    case 'loading_image_model':
      return { text: `Loading the ${what} model…`, sub: 'starting ComfyUI if needed. This can take a moment' }
    case 'generating':
      return {
        text: `Generating the ${what}…`,
        // Only call it a "VRAM swap" when we actually evicted the chat model.
        // No eviction (models co-exist) → just an honest timing hint.
        sub: evicted ? 'VRAM swap in progress, usually 30-90s (longer on a cold start)' : 'usually 30-90s (longer on a cold start)',
      }
    case 'restoring_text':
      // Nothing was evicted → the chat model stayed resident, so don't claim a
      // restore; just show a brief "finishing" beat before done.
      return evicted
        ? { text: 'Restoring the chat model', sub: detail ? `reloading ${detail}` : 'reloading into VRAM' }
        : { text: `Finishing the ${what}…` }
    case 'done':
      return { text: evicted ? 'Chat model restored' : 'Done', done: true }
    case 'error':
      return evicted
        ? { text: 'VRAM swap interrupted', sub: 'the chat model is being restored', done: true }
        : { text: 'Generation interrupted', done: true }
    default:
      return { text: 'Working…' }
  }
}

export function VramSwitchCard() {
  const { active, evicted, phase, kind, detail } = useVramHandoff()

  // Render for the whole generation. The `done`/`error` terminal frames flip
  // `active` false immediately, but we still want to flash a brief terminal
  // confirmation, so we also render while the phase is a terminal one.
  const terminal = phase === 'done' || phase === 'error'
  const visible = active || terminal

  const { text, sub, done } = copyFor(phase, kind, detail, evicted)

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: MOTION_S.base }}
          className="flex items-start gap-2 px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.05] t-micro text-gray-700 dark:text-gray-200"
        >
          <span className="mt-0.5 shrink-0">
            {done ? <Check size={12} className="text-emerald-500" /> : <Loader2 size={12} className="animate-spin" />}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1 font-medium">
              <Cpu size={10} className="opacity-70 shrink-0" />
              <span className="truncate">{text}</span>
            </div>
            {sub && <p className="opacity-75 mt-0.5 leading-snug">{sub}</p>}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
