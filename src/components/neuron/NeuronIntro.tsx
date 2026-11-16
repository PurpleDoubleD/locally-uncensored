// The Neurons introduction (N2, 3.0.9). David, 31.10.2026: once, on the
// first click on Neurons, explain how it works and what it can do, "with
// nice graphics, nicely animated". Five short cards, skippable, and back
// any time from the "How it works" button on the page or the command
// palette. The drawings are plain SVG and CSS; with reduced motion they
// stand still and the cards switch without sliding.

import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { MOTION_S } from '../ui/motion'
import { ICON_SM } from '../ui/icon-size'
import { useNeuronStore } from '../../stores/neuronStore'
import { useNeuronIntroRequest } from '../../stores/neuronIntroStore'


interface Card {
  title: string
  text: string
  art: () => React.ReactElement
}

// Step 1 (3.1.0): the words run as fine lines through the layers. One layer
// carries a thumb, like a slider. When it moves, the lines behind it take a
// new course and the old course stays as a ghost. All of it is CSS on plain
// SVG (index.css, "new drawings"), so reduced motion holds the pushed state.
const PUSH_X = 240
const WIRE_X0 = 92
const WIRE_X1 = 388
const WIRES = [0, 1, 2, 3, 4, 5, 6, 7, 8]
const wireY = (j: number) => 56 + j * 7
const bentY = (j: number) => 44 + j * 4.5
const straightWire = (j: number) => `M${WIRE_X0} ${wireY(j)} H${WIRE_X1}`
const bentTail = (j: number) => `C${PUSH_X + 30} ${wireY(j)} ${PUSH_X + 38} ${bentY(j)} ${PUSH_X + 70} ${bentY(j)} H${WIRE_X1}`
const pulseDelay = (j: number) => `${-((j * 1.37) % 3.2).toFixed(2)}s`

/** Words as lines through the layers; a push on one layer bends them. */
function ArtLayers() {
  return (
    <svg viewBox="0 0 480 168" className="w-full h-full" aria-hidden>
      <defs>
        <clipPath id="nintro-up"><rect x="0" y="0" width={PUSH_X} height="168" /></clipPath>
        <clipPath id="nintro-down"><rect x={PUSH_X} y="0" width={480 - PUSH_X} height="168" /></clipPath>
      </defs>
      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
        <line key={i} x1={110 + i * 26} y1="30" x2={110 + i * 26} y2="138" className={i === 5 ? 'nintro-plane nintro-plane--hit' : 'nintro-plane'} />
      ))}
      {WIRES.map((j) => <path key={j} d={`M${WIRE_X0} ${wireY(j)} H${PUSH_X}`} className="nintro-wire" />)}
      <g clipPath="url(#nintro-up)">
        {WIRES.map((j) => <path key={j} d={straightWire(j)} pathLength={100} className="nintro-pulse" style={{ animationDelay: pulseDelay(j) }} />)}
      </g>
      <g className="nintro-ghost">
        {WIRES.map((j) => <path key={j} d={`M${PUSH_X} ${wireY(j)} H${WIRE_X1}`} className="nintro-wire" />)}
        <g clipPath="url(#nintro-down)">
          {WIRES.map((j) => <path key={j} d={straightWire(j)} pathLength={100} className="nintro-pulse" style={{ animationDelay: pulseDelay(j) }} />)}
        </g>
      </g>
      <g className="nintro-bentgroup">
        {WIRES.map((j) => (
          <path key={j} d={`M${PUSH_X} ${wireY(j)} ${bentTail(j)}`} pathLength={100} className="nintro-wire nintro-wire--bent" style={{ animationDelay: `${(Math.abs(j - 4) * 0.04).toFixed(2)}s` }} />
        ))}
        <g clipPath="url(#nintro-down)">
          {WIRES.map((j) => <path key={j} d={`M${WIRE_X0} ${wireY(j)} H${PUSH_X} ${bentTail(j)}`} pathLength={100} className="nintro-pulse" style={{ animationDelay: pulseDelay(j) }} />)}
        </g>
      </g>
      <g className="nintro-thumb"><rect x={PUSH_X - 8} y="78" width="16" height="12" rx="4" className="nintro-accent-fill" /></g>
      <text x={WIRE_X0 - 10} y="87.5" textAnchor="end" className="nintro-label nintro-muted-text">your words</text>
      <text x={WIRE_X1 + 10} y="87.5" className="nintro-label nintro-muted-text nintro-ghost">answer</text>
      <text x={WIRE_X1 + 10} y="65.5" className="nintro-label nintro-accent-text nintro-when">new tone</text>
      <text x={PUSH_X} y="21" textAnchor="middle" className="nintro-label nintro-accent-text nintro-when">push</text>
      <text x={PUSH_X} y="156" textAnchor="middle" className="nintro-label nintro-muted-text">layers</text>
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

// Step 4 (3.1.0): one real answer, and a line that wipes across it. Left of
// the line the sliders are on, right of it they are off. Both answers lie on
// the same spot, so the eye compares the words and not two boxes.
function ArtCompare() {
  return (
    <div className="nintro-wipe" aria-hidden data-testid="neuron-intro-wipe">
      <span className="nintro-wipe-tag nintro-wipe-tag--on">SLIDERS ON</span>
      <span className="nintro-wipe-tag nintro-wipe-tag--off">SLIDERS OFF</span>
      <p className="nintro-wipe-a nintro-wipe-a--before">It was fine. I answered a few questions, sorted some notes, and that is about all there is to say.</p>
      <p className="nintro-wipe-a nintro-wipe-a--after">Wonderful! I got to help with so many curious questions, and every single one taught me something new.</p>
      <i className="nintro-wipe-bar" />
    </div>
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

// Step 3 (3.1.0): four ways lead into one slider. One way at a time lights
// up, its line runs to the slider, the thumb settles and the slider gets its
// name. The small marks are drawn for this card, no icon set.
const WAYS = [
  { name: 'Ready-made', slider: 'Cheerful' },
  { name: 'From examples', slider: 'Like a pirate' },
  { name: 'Features', slider: 'Feature 8949' },
  { name: 'Coordinates', slider: 'L14N8949 +1.0' },
]
const WAY_Y = [30, 66, 102, 138]
const MARK_X = 56
const wayPath = (y: number) => `M184 ${y} C250 ${y} 232 84 296 84`

function WayMark({ i, y }: { i: number; y: number }) {
  if (i === 0) {
    return (
      <>
        {[0, 8, 16].map((dx, k) => (
          <g key={dx}>
            <line x1={MARK_X + 2 + dx} y1={y - 8} x2={MARK_X + 2 + dx} y2={y + 8} strokeWidth="1" />
            <circle cx={MARK_X + 2 + dx} cy={y + [-3, 4, -6][k]} r="2.2" stroke="none" />
          </g>
        ))}
      </>
    )
  }
  if (i === 1) {
    return (
      <>
        <rect x={MARK_X} y={y - 6} width="20" height="2.4" rx="1.2" stroke="none" />
        <rect x={MARK_X} y={y - 1.2} width="14" height="2.4" rx="1.2" stroke="none" />
        <rect x={MARK_X} y={y + 3.6} width="18" height="2.4" rx="1.2" stroke="none" />
      </>
    )
  }
  if (i === 2) {
    return (
      <>
        {[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => (
          <circle key={`${r}${c}`} cx={MARK_X + 3 + c * 7} cy={y - 7 + r * 7} r={r === 1 && c === 2 ? 2.8 : 1.3} stroke="none" />
        )))}
      </>
    )
  }
  return <text x={MARK_X - 1} y={y + 3.5} className="nintro-code" style={{ fontSize: 9 }} stroke="none">L14</text>
}

/** The four ways, as lines that run into one slider, one after the other. */
function ArtWays() {
  return (
    <svg viewBox="0 0 480 168" className="w-full h-full" aria-hidden>
      {WAYS.map((w, i) => {
        const y = WAY_Y[i]
        const delay = { animationDelay: `${i * 2}s` }
        return (
          <g key={w.name}>
            <path d={wayPath(y)} className="nintro-way-wire" />
            <path d={wayPath(y)} pathLength={100} className="nintro-way-run" style={delay} />
            <g className="nintro-way" style={delay}>
              <g className="nintro-way-mark"><WayMark i={i} y={y} /></g>
              <text x={MARK_X + 30} y={y + 4} className="nintro-name nintro-text">{w.name}</text>
            </g>
          </g>
        )
      })}
      <line x1="298" y1="84" x2="424" y2="84" strokeWidth="4" strokeLinecap="round" className="nintro-track" />
      <line x1="361" y1="74" x2="361" y2="94" strokeWidth="1.5" className="nintro-track" />
      <g className="nintro-way-knob"><rect x="353" y="71" width="16" height="26" rx="5" className="nintro-accent-fill" /></g>
      {WAYS.map((w, i) => (
        <text key={w.name} x="361" y="52" textAnchor="middle" className={`nintro-name nintro-text nintro-way-name${i === 0 ? ' nintro-way-name--first' : ''}`} style={{ animationDelay: `${i * 2}s` }}>{w.slider}</text>
      ))}
      <text x="298" y="118" className="nintro-label nintro-muted-text">less</text>
      <text x="424" y="118" textAnchor="end" className="nintro-label nintro-muted-text">more</text>
    </svg>
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
