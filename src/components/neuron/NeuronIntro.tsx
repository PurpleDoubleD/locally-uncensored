// The Neurons introduction (N2, 3.0.9). David, 31.10.2026: once, on the
// first click on Neurons, explain how it works and what it can do, "with
// nice graphics, nicely animated". Five short cards, skippable, and back
// any time from the "How it works" button on the page or the command
// palette. The drawings are plain SVG and CSS; with reduced motion they
// stand still and the cards switch without sliding.

import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowLeft, ArrowRight, FlaskConical, Hash, Sliders, Sparkles } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { MOTION_S } from '../ui/motion'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { ICON_SM } from '../ui/icon-size'
import { useNeuronStore } from '../../stores/neuronStore'
import { useNeuronIntroRequest } from '../../stores/neuronIntroStore'


interface Card {
  title: string
  text: string
  art: () => React.ReactElement
}

/** Layers with words flowing up, and a push added in the middle. */
function ArtLayers() {
  const layers = [0, 1, 2, 3, 4, 5]
  return (
    <svg viewBox="0 0 320 168" className="w-full h-full" aria-hidden>
      {layers.map((i) => (
        <rect key={i} x="70" y={142 - i * 24} width="130" height="14" rx="5" className={i === 2 || i === 3 ? 'nintro-layer nintro-layer--hit' : 'nintro-layer'} style={{ animationDelay: `${i * 0.25}s` }} />
      ))}
      {[0, 1, 2].map((i) => (
        <circle key={i} cx={105 + i * 30} cy="160" r="4" className="nintro-token" style={{ animationDelay: `${i * 0.7}s` }} />
      ))}
      <g className="nintro-push">
        <path d="M290 88 C 255 88, 240 98, 210 100" fill="none" strokeWidth="2.5" strokeLinecap="round" className="nintro-accent-stroke" />
        <path d="M216 94 L206 100 L216 106" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="nintro-accent-stroke" />
        <rect x="248" y="58" width="58" height="20" rx="10" className="nintro-accent-fill-soft" />
        <text x="277" y="72" textAnchor="middle" className="nintro-label nintro-accent-text">push</text>
      </g>
      <text x="135" y="18" textAnchor="middle" className="nintro-label nintro-muted-text">answer</text>
      <text x="40" y="153" textAnchor="middle" className="nintro-label nintro-muted-text">words</text>
      <text x="40" y="105" textAnchor="middle" className="nintro-label nintro-muted-text">layers</text>
    </svg>
  )
}

/** Equalizer: five sliders that settle at different heights. */
function ArtEqualizer() {
  const bars = ['Creative', 'Detailed', 'Casual', 'Cheerful', 'Yours']
  return (
    <svg viewBox="0 0 320 168" className="w-full h-full" aria-hidden>
      {bars.map((b, i) => {
        const x = 48 + i * 56
        return (
          <g key={b}>
            <line x1={x} y1="24" x2={x} y2="128" strokeWidth="4" strokeLinecap="round" className="nintro-track" />
            <line x1={x - 9} y1="76" x2={x + 9} y2="76" strokeWidth="1.5" className="nintro-track" />
            <g className="nintro-knob" style={{ animationDelay: `${i * 0.35}s`, ['--nintro-to' as string]: `${[-30, 18, -12, -38, 26][i]}px` }}>
              <rect x={x - 13} y="68" width="26" height="16" rx="5" className={i === 4 ? 'nintro-accent-fill' : 'nintro-knob-fill'} />
            </g>
            <text x={x} y="150" textAnchor="middle" className="nintro-label nintro-muted-text">{b}</text>
          </g>
        )
      })}
      <text x="12" y="30" className="nintro-label nintro-muted-text">more</text>
      <text x="12" y="128" className="nintro-label nintro-muted-text">less</text>
    </svg>
  )
}

/** Before and after: the same question, two answers being written. */
function ArtCompare() {
  return (
    <svg viewBox="0 0 320 168" className="w-full h-full" aria-hidden>
      <rect x="16" y="20" width="136" height="128" rx="12" className="nintro-card" />
      <rect x="168" y="20" width="136" height="128" rx="12" className="nintro-card nintro-card--accent" />
      <text x="32" y="42" className="nintro-label nintro-muted-text">BEFORE</text>
      <text x="184" y="42" className="nintro-label nintro-accent-text">AFTER</text>
      {[0, 1, 2, 3].map((i) => (
        <rect key={`b${i}`} x="32" y={58 + i * 18} width={[104, 92, 100, 60][i]} height="7" rx="3.5" className="nintro-line" style={{ animationDelay: `${i * 0.3}s` }} />
      ))}
      {[0, 1, 2, 3].map((i) => (
        <rect key={`a${i}`} x="184" y={58 + i * 18} width={[96, 104, 84, 70][i]} height="7" rx="3.5" className="nintro-line nintro-line--accent" style={{ animationDelay: `${1.3 + i * 0.3}s` }} />
      ))}
    </svg>
  )
}

/** Coordinates: a code being typed, copied, and pasted elsewhere. */
function ArtShare() {
  return (
    <svg viewBox="0 0 320 168" className="w-full h-full" aria-hidden>
      <text x="16" y="22" className="nintro-label nintro-muted-text">layer · neuron · strength</text>
      <rect x="16" y="32" width="250" height="34" rx="10" className="nintro-card" />
      <g className="nintro-type">
        <text x="30" y="54" className="nintro-code">L14N8949+1.0 @cheerful+0.5</text>
      </g>
      <rect x="16" y="32" width="250" height="34" rx="10" fill="none" strokeWidth="1.5" className="nintro-accent-stroke nintro-glow" />
      <path d="M150 72 C 160 100, 190 112, 214 118" fill="none" strokeWidth="2" strokeDasharray="4 5" className="nintro-accent-stroke nintro-dash" />
      <rect x="216" y="98" width="88" height="48" rx="10" className="nintro-card nintro-card--accent nintro-arrive" />
      <text x="260" y="119" textAnchor="middle" className="nintro-label nintro-accent-text nintro-arrive">pasted</text>
      <text x="260" y="134" textAnchor="middle" className="nintro-label nintro-muted-text nintro-arrive">same mix</text>
    </svg>
  )
}

/** The four ways, as tiles that come in one after the other. */
function ArtWays() {
  const ways = [
    { icon: <Sliders size={18} />, name: 'Ready-made', line: 'Five sliders, any model' },
    { icon: <Sparkles size={18} />, name: 'From examples', line: 'Write lines, get a slider' },
    { icon: <FlaskConical size={18} />, name: 'Features', line: 'Search what a model knows' },
    { icon: <Hash size={18} />, name: 'Coordinates', line: 'Paste what others share' },
  ]
  return (
    <div className="grid grid-cols-2 gap-2.5 w-full px-2" aria-hidden>
      {ways.map((w, i) => (
        <div key={w.name} className="nintro-tile rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] px-3 py-2.5" style={{ animationDelay: `${i * 0.18}s` }}>
          <div className="flex items-center gap-2 text-lu-accent">{w.icon}<span className="t-body font-medium text-gray-900 dark:text-white">{w.name}</span></div>
          <p className={`t-micro ${HINWEIS_TEXT.ruhig} mt-1`}>{w.line}</p>
        </div>
      ))}
    </div>
  )
}

export const INTRO_CARDS: Card[] = [
  {
    title: 'Change how your model answers, from the inside',
    text: 'A model passes your words through many layers. Neurons adds a small push to some of them. That changes the tone and style of every answer, without touching your prompt.',
    art: ArtLayers,
  },
  {
    title: 'Sliders, like an equalizer',
    text: 'Each slider is one trait. Right for more, left for less. At 0 the model is exactly as before, so you can always go back.',
    art: ArtEqualizer,
  },
  {
    title: 'Four ways to get a slider',
    text: 'Start with a ready-made one. Make your own from a few example lines. Search the features of a model that has them. Or paste coordinates someone shared.',
    art: ArtWays,
  },
  {
    title: 'See the difference',
    text: 'Compare asks the same question twice, with the sliders off and on, and shows both answers side by side.',
    art: ArtCompare,
  },
  {
    title: 'Share your mix as coordinates',
    text: 'Copy your sliders as one short line or a link. Paste lines from others under Coordinates. LU reads only numbers and example sentences from them, never files or commands.',
    art: ArtShare,
  },
]

export function NeuronIntro({ open, onClose }: { open: boolean; onClose: () => void }) {
  // The Modal mounts its content only while open, so every showing starts
  // on the first card.
  return (
    <Modal open={open} onClose={onClose} title="" ariaLabel="Introduction to Neurons" hideHeader maxWidth="max-w-xl" panelPad="p-0">
      <IntroCards onClose={onClose} />
    </Modal>
  )
}

function IntroCards({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0)
  const [dir, setDir] = useState(1)
  const reduce = useReducedMotion()
  const last = i === INTRO_CARDS.length - 1
  const go = (to: number) => {
    setDir(to > i ? 1 : -1)
    setI(Math.max(0, Math.min(INTRO_CARDS.length - 1, to)))
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') go(i + 1)
      else if (e.key === 'ArrowLeft') go(i - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const card = INTRO_CARDS[i]
  const Art = card.art
  const slide = reduce ? 0 : 24
  return (
      <div className="neuron-intro" data-testid="neuron-intro">
        <div className="relative h-52 rounded-t-2xl overflow-hidden bg-gradient-to-b from-lu-accent/[0.10] to-transparent flex items-center justify-center px-6 pt-6">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={i}
              className="w-full h-full flex items-center justify-center"
              initial={{ opacity: 0, x: slide * dir }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -slide * dir }}
              transition={{ duration: reduce ? 0 : MOTION_S.slow }}
            >
              <Art />
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="px-6 pt-4 pb-5">
          <p className="t-label text-lu-accent mb-1.5" data-testid="neuron-intro-step">Step {i + 1} of {INTRO_CARDS.length}</p>
          <h2 className="t-display text-gray-900 dark:text-white" data-testid="neuron-intro-title">{card.title}</h2>
          <p className="t-body text-gray-300 mt-2 min-h-[4.5em]">{card.text}</p>
          <div className="flex items-center justify-between mt-4">
            <div className="flex items-center gap-1.5" role="tablist" aria-label="Introduction cards">
              {INTRO_CARDS.map((c, k) => (
                <button
                  key={c.title}
                  type="button"
                  role="tab"
                  aria-selected={k === i}
                  aria-label={`Card ${k + 1}: ${c.title}`}
                  onClick={() => go(k)}
                  className={`h-1.5 rounded-full transition-[width,background-color] ${k === i ? 'w-5 bg-lu-accent' : 'w-1.5 bg-gray-300 dark:bg-white/20'}`}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              {!last && <button type="button" className="lu-control" onClick={onClose} data-testid="neuron-intro-skip">Skip</button>}
              {i > 0 && (
                <button type="button" className="lu-control lu-control--outline" onClick={() => go(i - 1)} aria-label="Back" data-testid="neuron-intro-back">
                  <ArrowLeft size={ICON_SM} />
                </button>
              )}
              {last ? (
                <button type="button" className="lu-control lu-primary" onClick={onClose} data-testid="neuron-intro-done">Start tweaking</button>
              ) : (
                <button type="button" className="lu-control lu-primary" onClick={() => go(i + 1)} data-testid="neuron-intro-next" data-autofocus>
                  Next <ArrowRight size={ICON_SM} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
  )
}

/** The introduction on the page: once by itself, then on request. */
export function NeuronIntroHost() {
  const seen = useNeuronStore((s) => s.introSeen)
  const setSeen = useNeuronStore((s) => s.setIntroSeen)
  const requested = useNeuronIntroRequest((s) => s.open)
  const hide = useNeuronIntroRequest((s) => s.hide)
  return (
    <NeuronIntro
      open={!seen || requested}
      onClose={() => { setSeen(true); hide() }}
    />
  )
}
