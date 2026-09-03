// Cloud discovery sheet (2.5.8): Local mode surfaces the hosted-only Create
// tools + hosted models as tappable teasers, and THIS is what a tap opens — a
// small sheet with an animated "show me" demo of the tool, one line of copy,
// and the path into LU Cloud. Never blocks a local flow (it only opens from
// explicitly cloud-tagged surfaces), never shows in cloud mode, and the
// footer link turns the whole discovery layer off (Settings can re-enable).

import { AnimatePresence, motion } from 'framer-motion'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'
import { X, Cloud, Sparkles, MonitorDown } from 'lucide-react'
import { useUIStore, type CloudTeaserTarget } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { cloudModelById } from '../../stores/cloudCatalogStore'
import { useCreateStore, type CreateIntent } from '../../stores/createStore'
import { isIntentAvailable } from '../create/experimental/intents'
import { isMlxImageHost } from '../../api/mlx-image'

interface TeaserCopy {
  title: string
  line: string
}

const INTENT_COPY: Record<Extract<CloudTeaserTarget, { surface: 'intent' }>['intent'], TeaserCopy> = {
  upscale: {
    title: 'Upscale',
    line: 'Blow any image up to crisp 2K, 4K or 8K. No VRAM needed.',
  },
  eraser: {
    title: 'Erase Object',
    line: 'Paint over anything and it’s gone. Clean fill, no trace.',
  },
  character: {
    title: 'Character Studio',
    line: 'Train a character from a few photos, then put them in any scene.',
  },
  lipsync: {
    title: 'Talking Character',
    line: 'A portrait plus any voice becomes a talking video.',
  },
  music: {
    title: 'Music',
    line: 'Describe a track, get a full song. Up to four minutes.',
  },
  extend: {
    title: 'Extend Video',
    line: 'Keep a clip going. The cloud continues it seamlessly.',
  },
  motion: {
    title: 'Motion Control',
    line: 'Your character copies the moves from any dance or pose video.',
  },
}

export function CloudTeaserModal() {
  const target = useUIStore((s) => s.cloudTeaser)
  const setCloudTeaser = useUIStore((s) => s.setCloudTeaser)
  const setCloudGateOpen = useUIStore((s) => s.setCloudGateOpen)
  const setIntent = useCreateStore((s) => s.setIntent)
  const { updateSettings } = useSettingsStore()
  const teasersEnabled = useSettingsStore((s) => s.settings.cloudTeasersEnabled)

  // One-time onboarding (David 2026-07-19): the Cloud discovery layer is meant
  // to appear ONCE per user, never again — not after updates either. Any
  // dismissal of this sheet (button, backdrop, X, Try local / Try cloud) retires
  // the whole discovery layer permanently; the persisted flag survives updates,
  // and Settings can re-enable it. Cloud-only *features* (upscale / eraser) stay
  // accessible regardless — their sheet renders on tap, not on this flag.
  const close = () => {
    if (teasersEnabled) updateSettings({ cloudTeasersEnabled: false })
    setCloudTeaser(null)
  }
  // 2.5.8: the lanes that ALSO run locally get a "Try local" path — the sheet
  // stops being a pure upsell and becomes the fork between the two lanes.
  // Ask the same rule the IntentBar renders from, not a static op list: on the
  // Mac only MLX image/video run locally, so a list-based answer offered a
  // "Try local" button for lanes the bar doesn't even show (MAC-2).
  const localLane =
    target?.surface === 'intent' &&
    isIntentAvailable(target.intent as CreateIntent, 'local', isMlxImageHost())
      ? target.intent
      : null
  const copy: TeaserCopy | null =
    target?.surface === 'intent'
      ? INTENT_COPY[target.intent]
      : target?.surface === 'create-model'
        ? {
            title: cloudModelById(target.modelId)?.label ?? 'Hosted model',
            line:
              target.kind === 'video'
                ? 'Cinema grade video models on datacenter GPUs. No download, no VRAM limit.'
                : 'Frontier image models on datacenter GPUs. No download, no VRAM limit.',
          }
        : null


  useDismissOnEscape(!!target && !!copy, close)
  return (
    <AnimatePresence>
      {target && copy && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={close}
        >
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.97 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            onClick={(e) => e.stopPropagation()}
            className="w-[360px] max-w-[92vw] rounded-2xl bg-[#232323] border border-white/[0.08] shadow-2xl shadow-black/50 overflow-hidden"
          >
            {/* Demo stage */}
            <div className="relative h-[130px] bg-[#1b1b1b] border-b border-white/[0.06] overflow-hidden">
              <TeaserDemo target={target} />
              <button
                onClick={close}
                className="absolute top-2 right-2 p-1.5 rounded-md text-gray-500 hover:text-gray-200 hover:bg-white/10 transition-colors"
                title="Close"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Cloud size={14} className="text-violet-300" />
                <h3 className="text-[0.85rem] font-semibold text-white">{copy.title}</h3>
                <span className="ml-auto text-[0.55rem] font-medium uppercase tracking-widest text-violet-300/80">
                  LU Cloud
                </span>
              </div>
              <p className="text-[0.7rem] leading-relaxed text-gray-400">{copy.line}</p>
              <p className="text-[0.62rem] leading-relaxed text-gray-500">
                {localLane
                  ? 'Runs on your PC with downloaded models, or on LU Cloud where datacenter GPUs do the heavy lifting.'
                  : 'Runs on LU Cloud. Your PC stays cool while datacenter GPUs do the heavy lifting.'}
              </p>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => {
                    // 2.6.3 B5: intent teasers used to detour through an
                    // example-video popup before the gate. That stage is gone
                    // (David 2026-08-04), so both surfaces take the same path
                    // the model rows always took, one click shorter.
                    close()
                    setCloudGateOpen(true)
                  }}
                  className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg bg-white text-black text-[0.7rem] font-semibold hover:bg-gray-200 transition-colors"
                >
                  <Sparkles size={12} /> {localLane ? 'Try cloud' : 'See plans'}
                </button>
                {localLane && (
                  <button
                    onClick={() => { close(); setIntent(localLane) }}
                    className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg border border-white/15 text-gray-200 text-[0.7rem] font-semibold hover:bg-white/[0.06] transition-colors"
                  >
                    <MonitorDown size={12} /> Try local
                  </button>
                )}
                <button
                  onClick={close}
                  className="px-3 h-8 rounded-lg text-[0.7rem] text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] transition-colors"
                >
                  Not now
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ── "Show me" demos — tiny looping motion sketches, one per tool. Pure
// CSS/SVG so they ship inside the bundle (no media assets, theme-crisp). ──

function TeaserDemo({ target }: { target: CloudTeaserTarget }) {
  const kind = target.surface === 'intent' ? target.intent : target.kind === 'video' ? 'video-model' : 'image-model'
  switch (kind) {
    case 'upscale': return <UpscaleDemo />
    case 'eraser': return <EraserDemo />
    case 'character': return <CharacterDemo />
    case 'lipsync': return <LipsyncDemo />
    case 'music': return <MusicDemo />
    case 'extend': return <ExtendDemo />
    case 'motion': return <MotionDemo />
    default: return <ModelDemo video={kind === 'video-model'} />
  }
}

const LOOP = { duration: 2.6, repeat: Infinity, ease: 'easeInOut' as const }

function Stage({ children }: { children: React.ReactNode }) {
  return <div className="absolute inset-0 flex items-center justify-center">{children}</div>
}

function UpscaleDemo() {
  return (
    <Stage>
      <motion.div
        className="w-20 h-20 rounded-lg bg-gradient-to-br from-violet-500/60 to-sky-500/60"
        animate={{ filter: ['blur(6px)', 'blur(0px)', 'blur(0px)', 'blur(6px)'], scale: [0.8, 1.05, 1.05, 0.8] }}
        transition={{ ...LOOP, duration: 3.2, times: [0, 0.4, 0.7, 1] }}
      />
      <motion.span
        className="absolute text-[0.55rem] font-mono text-white/70"
        animate={{ opacity: [0, 0, 1, 0] }}
        transition={{ ...LOOP, duration: 3.2, times: [0, 0.4, 0.6, 1] }}
      >
        4K
      </motion.span>
    </Stage>
  )
}

function EraserDemo() {
  return (
    <Stage>
      <div className="relative w-24 h-16 rounded-lg bg-gradient-to-br from-emerald-800/60 to-emerald-600/40">
        <motion.div
          className="absolute left-3 bottom-3 w-6 h-8 rounded-sm bg-amber-400/80"
          animate={{ opacity: [1, 1, 0, 0, 1] }}
          transition={{ ...LOOP, duration: 3, times: [0, 0.35, 0.55, 0.85, 1] }}
        />
        <motion.div
          className="absolute w-3.5 h-3.5 rounded-full border-2 border-white/80 bg-white/20"
          animate={{ x: [8, 20, 8], y: [18, 30, 18], opacity: [0, 1, 0] }}
          transition={{ ...LOOP, duration: 3 }}
        />
      </div>
    </Stage>
  )
}

function CharacterDemo() {
  return (
    <Stage>
      <div className="flex items-center gap-3">
        <div className="grid grid-cols-2 gap-1">
          {[0, 1, 2, 3].map((i) => (
            <motion.div
              key={i}
              className="w-5 h-5 rounded-sm bg-white/25"
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ ...LOOP, delay: i * 0.18 }}
            />
          ))}
        </div>
        <motion.div animate={{ x: [0, 3, 0] }} transition={LOOP} className="text-gray-500 text-[0.7rem]">→</motion.div>
        <motion.div
          className="w-12 h-12 rounded-full bg-gradient-to-br from-violet-400/70 to-fuchsia-400/70 flex items-center justify-center"
          animate={{ scale: [0.92, 1.06, 0.92] }}
          transition={LOOP}
        >
          <Sparkles size={14} className="text-white/90" />
        </motion.div>
      </div>
    </Stage>
  )
}

function LipsyncDemo() {
  return (
    <Stage>
      <div className="flex items-center gap-4">
        <div className="relative w-14 h-14 rounded-full bg-white/15 flex items-end justify-center pb-3">
          <div className="absolute top-4 flex gap-2.5">
            <span className="w-1.5 h-1.5 rounded-full bg-white/70" />
            <span className="w-1.5 h-1.5 rounded-full bg-white/70" />
          </div>
          <motion.div
            className="w-4 rounded-full bg-rose-300/90"
            animate={{ height: [2, 6, 3, 7, 2] }}
            transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
          />
        </div>
        <div className="flex items-end gap-0.5 h-8">
          {[10, 18, 26, 16, 22, 12, 20].map((h, i) => (
            <motion.span
              key={i}
              className="w-1 rounded-full bg-violet-300/80"
              animate={{ height: [h * 0.4, h, h * 0.4] }}
              transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut', delay: i * 0.09 }}
            />
          ))}
        </div>
      </div>
    </Stage>
  )
}

function MusicDemo() {
  return (
    <Stage>
      <div className="flex items-end gap-1 h-12">
        {[14, 26, 38, 22, 34, 18, 30, 24, 40, 16].map((h, i) => (
          <motion.span
            key={i}
            className="w-1.5 rounded-full bg-gradient-to-t from-violet-500/80 to-sky-400/80"
            animate={{ height: [h * 0.35, h, h * 0.35] }}
            transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut', delay: i * 0.07 }}
          />
        ))}
      </div>
    </Stage>
  )
}

function ExtendDemo() {
  return (
    <Stage>
      <div className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="w-8 h-12 rounded-sm bg-white/20 border border-white/10" />
        ))}
        {[3, 4].map((i) => (
          <motion.div
            key={i}
            className="w-8 h-12 rounded-sm bg-violet-400/50 border border-violet-300/30"
            animate={{ opacity: [0, 0, 1, 1, 0], x: [-6, -6, 0, 0, -6] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeOut', times: [0, 0.2 + i * 0.12, 0.35 + i * 0.12, 0.85, 1] }}
          />
        ))}
      </div>
    </Stage>
  )
}

function MotionDemo() {
  return (
    <Stage>
      <div className="flex items-center gap-5">
        <motion.div
          className="w-8 h-14 rounded-md border-2 border-dashed border-white/40"
          animate={{ rotate: [-9, 9, -9] }}
          transition={LOOP}
        />
        <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={LOOP} className="text-gray-500 text-[0.7rem]">→</motion.div>
        <motion.div
          className="w-8 h-14 rounded-md bg-gradient-to-b from-violet-400/80 to-fuchsia-500/70"
          animate={{ rotate: [-9, 9, -9] }}
          transition={{ ...LOOP, delay: 0.12 }}
        />
      </div>
    </Stage>
  )
}

function ModelDemo({ video }: { video: boolean }) {
  return (
    <Stage>
      <motion.div
        className={
          video
            ? 'w-24 h-14 rounded-lg bg-gradient-to-br from-sky-500/50 to-violet-500/50'
            : 'w-16 h-16 rounded-lg bg-gradient-to-br from-violet-500/50 to-fuchsia-500/50'
        }
        animate={{ scale: [0.94, 1.04, 0.94], opacity: [0.7, 1, 0.7] }}
        transition={LOOP}
      >
        <div className="w-full h-full flex items-center justify-center">
          <Cloud size={18} className="text-white/80" />
        </div>
      </motion.div>
    </Stage>
  )
}
