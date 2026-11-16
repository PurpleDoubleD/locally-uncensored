// The Character area with no character yet (3.1.0, David 16.11.2026): the
// three steps and one button on the left, on the right what a character can
// do, as four small drawings with the LU mark as the figure. These four are
// the only moving pictures of the area (index.css, .hub-ex-*); with reduced
// motion they stand still.

import type { ReactNode } from 'react'
import { Image as ImageIcon, Mic, PersonStanding, Plus, Replace } from 'lucide-react'
import { ACTION_LABEL, type HubAction } from '../../../../lib/create/character-hub'
import { MONOGRAM } from '../../../layout/brand'
import { Button } from '../../ui/Button'

const STEPS = [
  { title: 'Add photos of one face', line: '4 to 30 photos, or frames from a video in your gallery.' },
  { title: 'Give it a name', line: 'Saved right away. Train it later for the best likeness.' },
  { title: 'Use it', line: 'Image, Swap, Motion and Talk. In Chat too.' },
]

/** The LU mark as a figure: the monogram is the head, the shoulders are
 *  drawn in the same line. */
function LuFigure({ x, y, k = 1, className }: { x: number; y: number; k?: number; className?: string }) {
  return (
    <g className={className} transform={`translate(${x} ${y}) scale(${k})`}>
      <image href={MONOGRAM} x="-15" y="-34" width="30" height="30" className="hub-ex-mark" />
      <path d="M-20 22v-8a12 12 0 0 1 12-12h16a12 12 0 0 1 12 12v8" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" className="hub-text" />
    </g>
  )
}

/** Anybody: the same build in grey, with an empty head. */
function GreyFigure({ x, y, k = 1, className }: { x: number; y: number; k?: number; className?: string }) {
  return (
    <g className={className} transform={`translate(${x} ${y}) scale(${k})`}>
      <g fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" className="hub-dim">
        <rect x="-11" y="-31" width="22" height="24" rx="8" />
        <path d="M-20 22v-8a12 12 0 0 1 12-12h16a12 12 0 0 1 12 12v8" />
      </g>
    </g>
  )
}

/** Image: the figure stays, the picture around it becomes another one
 *  (mountains by day, a town by night). */
function ArtImage() {
  return (
    <>
      <defs><clipPath id="hub-ex-picture"><rect x="14" y="8" width="92" height="64" rx="5" /></clipPath></defs>
      <g clipPath="url(#hub-ex-picture)">
        <g className="hub-ex-a hub-dim" fill="currentColor">
          <circle cx="88" cy="22" r="7" opacity=".7" />
          <path d="M14 72 44 30l18 24 12-14 32 32z" opacity=".45" />
        </g>
        <g className="hub-ex-b hub-dim" fill="currentColor">
          <path d="M82 14a8 8 0 1 0 8 10 6.4 6.4 0 0 1-8-10z" opacity=".7" />
          {[[18, 44, 13], [34, 30, 11], [48, 50, 15], [70, 38, 12], [86, 48, 16]].map(([x, y, w]) => (
            <rect key={x} x={x} y={y} width={w} height={72 - y} opacity=".4" />
          ))}
        </g>
        <LuFigure x={60} y={56} k={0.82} />
      </g>
      <rect x="14" y="8" width="92" height="64" rx="5" fill="none" stroke="currentColor" strokeWidth="1.2" className="hub-dim" />
    </>
  )
}

/** Swap: one of two people becomes the character. */
function ArtSwap() {
  return (
    <>
      <GreyFigure x={38} y={48} k={0.95} className="hub-ex-a" />
      <LuFigure x={38} y={48} k={0.95} className="hub-ex-b" />
      <GreyFigure x={84} y={48} k={0.95} />
    </>
  )
}

/** Motion: somebody moves, the character moves the same way. */
function ArtMotion() {
  return (
    <>
      <g className="hub-ex-tilt" style={{ transformOrigin: '30px 68px' }}><GreyFigure x={30} y={48} k={0.85} /></g>
      <path d="M55 42h10m-4-4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="hub-dim" />
      <g className="hub-ex-tilt" style={{ transformOrigin: '90px 68px' }}><LuFigure x={90} y={48} k={0.95} /></g>
    </>
  )
}

/** Talk: the character and its voice. */
function ArtTalk() {
  return (
    <>
      <LuFigure x={36} y={48} />
      {[12, 24, 16, 30, 20, 10].map((h, i) => (
        <rect key={i} className="hub-ex-bar hub-acc" fill="currentColor" x={70 + i * 7} y={40 - h / 2} width="3.4" height={h} rx="1.7"
          style={{ animationDelay: `${-i * 0.23}s`, transformOrigin: '0 40px' }} />
      ))}
    </>
  )
}

const EXAMPLES: { action: HubAction; icon: ReactNode; line: string; art: () => ReactNode }[] = [
  { action: 'image', icon: <ImageIcon size={14} />, line: 'Your character in any place you describe.', art: ArtImage },
  { action: 'swap', icon: <Replace size={14} />, line: 'Your character takes the place of a person in a clip.', art: ArtSwap },
  { action: 'motion', icon: <PersonStanding size={14} />, line: 'Your character copies a dance or a move.', art: ArtMotion },
  { action: 'talk', icon: <Mic size={14} />, line: 'Your character says your text.', art: ArtTalk },
]

export function HubEmpty({ onCreate, onTry }: { onCreate: () => void; onTry: (action: HubAction) => void }) {
  return (
    <div className="hub-empty" data-hub-step="who" data-hub-empty>
      <div className="min-w-0 flex-1">
        <ol className="hub-line border-t">
          {STEPS.map((s, i) => (
            <li key={s.title} className="hub-line flex gap-4 border-b py-3">
              <span className="hub-dim w-3 shrink-0 pt-px hub-fs-13 tabular-nums">{i + 1}</span>
              <span className="min-w-0">
                <span className="hub-text block hub-fs-14 font-medium">{s.title}</span>
                <span className="hub-dim mt-0.5 block hub-fs-13">{s.line}</span>
              </span>
            </li>
          ))}
        </ol>
        <div className="pt-6">
          <span data-hub-create><Button variant="primary" size="lg" icon={Plus} onClick={onCreate}>Create a character</Button></span>
        </div>
      </div>
      <ul className="hub-line min-w-0 flex-1 border-t" aria-label="What a character can do">
        {EXAMPLES.map((e) => {
          const Art = e.art
          return (
            <li key={e.action} className="hub-line border-b">
              <button
                type="button"
                onClick={() => onTry(e.action)}
                title={`Try ${ACTION_LABEL[e.action]} with one photo`}
                className="hub-hover -mx-2 flex w-[calc(100%+16px)] items-center gap-4 rounded-sm px-2 py-3 text-left"
                data-hub-example={e.action}
              >
                <svg viewBox="0 0 120 80" className="hub-ex shrink-0" aria-hidden><Art /></svg>
                <span className="min-w-0">
                  <span className="hub-text flex items-center gap-1.5 hub-fs-14 font-medium"><span className="hub-muted">{e.icon}</span>{ACTION_LABEL[e.action]}</span>
                  <span className="hub-dim mt-0.5 block hub-fs-13">{e.line}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
