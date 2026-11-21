// The training page of the Character area (3.1.3, David 21.11.2026): at a
// glance what is done, what comes next and the one button for it. The steps
// are the grammar of the swap's progress line; nothing here holds logic of
// the trainer (SpecialIntentControls does).

import type { ReactNode } from 'react'
import { ArrowRight, Check, ChevronDown, Sparkles, X } from 'lucide-react'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { useHubRun } from './hubRun'

export type TrainStep = 'trainer' | 'bases' | 'train'

const STEPS: { id: TrainStep | 'photos'; label: string }[] = [
  { id: 'photos', label: 'Photos' },
  { id: 'trainer', label: 'Trainer' },
  { id: 'bases', label: 'Base model' },
  { id: 'train', label: 'Train' },
]

export function TrainSteps({ now }: { now: TrainStep }) {
  const at = STEPS.findIndex((s) => s.id === now)
  return (
    <ol className="hub-train-steps hub-fs-125" aria-label="Training steps" data-hub-train-steps={now}>
      {STEPS.map((s, i) => (
        <li key={s.id} className={cn('inline-flex items-center gap-1.5', i < at ? 'hub-muted' : i === at ? 'hub-text font-medium' : 'hub-dim')} data-state={i < at ? 'done' : i === at ? 'now' : 'next'} aria-current={i === at ? 'step' : undefined}>
          {i > 0 && <ArrowRight size={12} className="hub-dim mr-1" aria-hidden />}
          {i < at && <Check size={13} className="hub-acc" aria-hidden />}
          {s.label}
        </li>
      ))}
    </ol>
  )
}

/** The head of the page: the steps, what to do now, one line why. */
export function TrainHead({ now, title, line }: { now: TrainStep; title: string; line?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center">
      <TrainSteps now={now} />
      <h2 className="hub-text hub-fs-20 mt-5 font-semibold" data-hub-train-title>{title}</h2>
      {line && <p className="hub-muted mt-1.5 max-w-[520px] text-balance hub-fs-13" data-hub-train-line>{line}</p>}
    </div>
  )
}

/** The word of the character, as a field that plainly asks to be typed in. */
export function TrainWord({ value, onChange, label, placeholder, help, after }: {
  value: string; onChange: (v: string) => void; label: string; placeholder: string; help: string; after?: ReactNode
}) {
  return (
    <div className="w-full max-w-[340px] text-left" data-hub-train-word>
      <label htmlFor="hub-train-word" className="hub-text mb-1.5 block hub-fs-13 font-medium">{label}</label>
      <input
        id="hub-train-word"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        className="hub-train-input hub-text w-full"
      />
      <p className="hub-dim mt-1.5 hub-fs-125">{help}</p>
      {after}
    </div>
  )
}

/** A label and its choice, on one line of the page. */
export function TrainRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex w-full max-w-[340px] items-center justify-between gap-3" data-hub-train-row={label}>
      <span className="hub-muted hub-fs-13">{label}</span>
      {children}
    </div>
  )
}

/** The one main button of the page, right under the settings: the same place
 *  as "Set up trainer". The run itself is the Composer's. */
export function TrainStart({ hint }: { hint?: string }) {
  const start = useHubRun((s) => s.trainStart)
  if (!start) return null
  if (start.running) return <Button variant="danger" size="lg" icon={X} onClick={start.cancel}>Cancel</Button>
  return (
    <span className="inline-flex" title={start.ready ? undefined : hint}>
      <Button variant="primary" size="lg" icon={Sparkles} disabled={!start.ready} onClick={start.run}>
        {start.price ? `Start training · ${start.price}` : 'Start training'}
      </Button>
    </span>
  )
}

/** What most people never need, folded away. */
export function TrainMore({ label = 'More options', open, children }: { label?: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="hub-train-more w-full max-w-[460px]" open={open} data-hub-train-more>
      <summary className="hub-dim inline-flex cursor-pointer select-none items-center gap-1 hub-fs-125">
        {label}<ChevronDown size={12} className="hub-train-chev" aria-hidden />
      </summary>
      <div className="flex flex-col items-center gap-2 pt-3">{children}</div>
    </details>
  )
}
