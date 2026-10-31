// The building blocks of the Neurons page (N2, 3.0.9). David, 31.10.2026:
// "text left, sliders in the middle, then left again: no structure, one
// cannot see what to do". So every part of the page is one of these: a
// numbered step card whose content starts on the same left edge, and slider
// rows that read the same way everywhere (both ends on one line, the slider
// under them across the whole card).

import { Check, Loader2, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Hinweis } from '../ui/Hinweis'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { ICON_SM } from '../ui/icon-size'
import { jobProgressText, jobShare } from '../../lib/neuron'
import type { NeuronJob } from '../../api/neuron'

/** One step of the page: number, title, one line on what it is for, then
 *  its content. A done step shows a check instead of its number. */
export function StepCard({ n, title, lead, done, aside, children, testId }: {
  n: number
  title: string
  lead: ReactNode
  done?: boolean
  aside?: ReactNode
  children: ReactNode
  testId?: string
}) {
  return (
    <section className="relative pl-10 pb-6" data-testid={testId} aria-labelledby={`neuron-step-${n}`}>
      {/* The line that ties the steps together, behind the numbers. */}
      <span aria-hidden className="absolute left-[13px] top-7 bottom-0 w-px bg-gray-200 dark:bg-white/[0.08] neuron-step-line" />
      <span
        aria-hidden
        className={`absolute left-0 top-0 w-7 h-7 rounded-full flex items-center justify-center t-control tabular-nums ${done ? 'bg-lu-accent text-white' : 'border border-gray-300 dark:border-white/20 text-gray-300 bg-white dark:bg-[#1a1a1a]'}`}
        data-step-done={done ? 'true' : 'false'}
      >
        {done ? <Check size={ICON_SM} /> : n}
      </span>
      <div className="flex items-start justify-between gap-3 min-h-7">
        <div className="min-w-0 pt-0.5">
          <h2 id={`neuron-step-${n}`} className="t-title text-gray-900 dark:text-white">{title}</h2>
          <p className={`t-body ${HINWEIS_TEXT.ruhig} mt-0.5`}>{lead}</p>
        </div>
        {aside && <div className="flex-none flex items-center gap-2">{aside}</div>}
      </div>
      <div className="mt-3 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white/60 dark:bg-white/[0.02] p-4">
        {children}
      </div>
    </section>
  )
}

export interface SliderRowProps {
  id: string
  left: string
  right: string
  value: number
  computed: boolean
  disabled?: boolean
  /** A short tag above the ends: "Ready-made", "Your slider", "Feature #…". */
  tag?: string
  onChange: (v: number) => void
  onCompute?: () => void
  onDelete?: () => void
}

export function signedValue(v: number): string {
  if (v === 0) return '0'
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`
}

/** A slider as one card row: both ends and the value on one line, the
 *  slider under it across the whole row. Not computed yet: the same line,
 *  and in place of the slider the button that prepares it. */
export function SliderRow({ id, left, right, value, computed, disabled, tag, onChange, onCompute, onDelete }: SliderRowProps) {
  const on = computed && value !== 0
  return (
    <div
      className={`rounded-lg px-3 py-2.5 border ${on ? 'border-lu-accent/40 bg-lu-accent/[0.06]' : 'border-gray-200 dark:border-white/[0.06]'}`}
      data-testid={`neuron-slider-${id}`}
    >
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <span className="t-body text-gray-200 truncate" title={left}>{left}</span>
        <span className={`t-control tabular-nums px-1.5 py-0.5 rounded ${on ? 'text-lu-accent' : HINWEIS_TEXT.ruhig}`} data-testid={`neuron-value-${id}`}>
          {computed ? signedValue(value) : tag ?? ''}
        </span>
        <span className="flex items-center justify-end gap-1 min-w-0">
          <span className="t-body text-gray-200 truncate text-right" title={right}>{right}</span>
          {onDelete && (
            <button type="button" onClick={onDelete} aria-label={`Delete ${right}`} className="p-0.5 text-gray-400 hover:text-red-500 flex-none">
              <Trash2 size={ICON_SM} />
            </button>
          )}
        </span>
      </div>
      {computed ? (
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={value}
          disabled={disabled}
          aria-label={`${left} to ${right}`}
          aria-valuetext={signedValue(value)}
          onChange={(e) => onChange(Number(e.target.value))}
          onDoubleClick={() => onChange(0)}
          className="neuron-range w-full mt-1.5 accent-lu-accent"
        />
      ) : (
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={onCompute}
            data-testid={`neuron-compute-${id}`}
            className="lu-tonal"
          >
            Prepare for this model
          </button>
          <span className={`t-micro ${HINWEIS_TEXT.ruhig}`}>Once per model, seconds to a few minutes.</span>
        </div>
      )}
    </div>
  )
}

/** Before computing on a model that was changed before (P11 FEHLER 10,
 *  David 31.10.2026). Calm, blocks nothing; the words are lib/neuron's. */
export function TweakedNote({ title, text, original, onGetOriginal }: { title: string; text: string; original: string | null; onGetOriginal: () => void }) {
  return (
    <div className="mb-4 border-l-2 border-lu-accent/50 pl-3 py-0.5" role="note" data-testid="neuron-tweaked-note">
      <p className="t-body font-medium text-gray-100">{title}</p>
      <p className={`t-body ${HINWEIS_TEXT.ruhig}`}>{text}</p>
      {original && (
        <button type="button" className="lu-tonal mt-2" onClick={onGetOriginal} data-testid="neuron-get-original">
          Get the original: {original}
        </button>
      )}
    </div>
  )
}

/** The ways to make a slider, as tabs. */
export function WayTabs<T extends string>({ ways, current, onPick }: {
  ways: Array<{ id: T; label: string; count?: number }>
  current: T
  onPick: (id: T) => void
}) {
  return (
    <div role="tablist" aria-label="Ways to tweak" className="flex flex-wrap gap-1 p-1 rounded-lg bg-gray-100 dark:bg-white/[0.04] mb-4">
      {ways.map((w) => (
        <button
          key={w.id}
          type="button"
          role="tab"
          id={`neuron-way-tab-${w.id}`}
          aria-selected={current === w.id}
          aria-controls={`neuron-way-${w.id}`}
          data-testid={`neuron-way-${w.id}`}
          onClick={() => onPick(w.id)}
          className={`flex-1 min-w-[7rem] t-control px-2.5 py-1.5 rounded-md transition-colors ${current === w.id ? 'bg-white dark:bg-white/[0.10] text-gray-900 dark:text-white shadow-sm' : 'text-gray-300 hover:text-gray-900 dark:hover:text-white'}`}
        >
          {w.label}{w.count ? <span className="ml-1 tabular-nums text-lu-accent">{w.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

/** The first line inside a way: what it is, in one sentence, and for whom. */
export function WayIntro({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <span aria-hidden className="flex-none w-8 h-8 rounded-lg bg-lu-accent/10 text-lu-accent flex items-center justify-center">{icon}</span>
      <div className="min-w-0">
        <p className="t-body font-medium text-gray-900 dark:text-white">{title}</p>
        <p className={`t-body ${HINWEIS_TEXT.ruhig}`}>{children}</p>
      </div>
    </div>
  )
}

export function ScopeButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={`t-control px-2.5 py-1.5 rounded-md border ${on ? 'border-lu-accent/50 bg-lu-accent/10 text-gray-900 dark:text-white' : 'border-gray-200 dark:border-white/[0.08] text-gray-300'}`}
    >
      {children}
    </button>
  )
}

export function JobPanel({ job, onStop, onDismiss, onGetOriginal, original }: { job: NeuronJob; onStop: () => void; onDismiss: () => void; onGetOriginal?: () => void; original?: string | null }) {
  const share = jobShare(job)
  if (job.status === 'running') {
    return (
      <div className="space-y-1.5 mb-4 rounded-lg border border-lu-accent/30 bg-lu-accent/[0.05] px-3 py-2.5" data-testid="neuron-job" aria-live="polite">
        <p className="flex items-center gap-1.5 t-body text-gray-100">
          <Loader2 size={ICON_SM} className="animate-spin" /> {job.title}: {job.phaseLabel || 'starting…'}
        </p>
        <div className="h-1 rounded-full bg-gray-200 dark:bg-white/[0.08] overflow-hidden">
          <div className="h-full rounded-full bg-lu-accent transition-[width]" style={{ width: share == null ? '0%' : `${Math.round(share * 100)}%` }} />
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className={`t-micro font-mono ${HINWEIS_TEXT.ruhig}`} data-testid="neuron-job-progress">{jobProgressText(job)}</p>
          <button type="button" onClick={onStop} className="t-micro text-red-600 dark:text-red-400 hover:underline">Stop</button>
        </div>
        {job.logs.length > 0 && <p className={`t-micro ${HINWEIS_TEXT.ruhig} truncate`}>{job.logs[job.logs.length - 1]}</p>}
      </div>
    )
  }
  const strength = job.logs.find((l) => l.includes('full strength'))?.trim()
  return (
    <div className="mb-4" data-testid="neuron-job-ended">
      {job.status === 'done' && <Hinweis onDismiss={onDismiss}>{job.title}: done{job.elapsedSecs ? ` in ${job.elapsedSecs} s` : ''}.{strength ? ` ${strength}.` : ''}</Hinweis>}
      {job.status === 'failed' && (
        <>
          <Hinweis ton="fehler" onDismiss={onDismiss}>{job.title} failed: {job.error}</Hinweis>
          {onGetOriginal && original && (
            <button type="button" className="lu-tonal mt-2" onClick={onGetOriginal} data-testid="neuron-get-original-failed">
              Get the original: {original}
            </button>
          )}
        </>
      )}
      {job.status === 'cancelled' && <Hinweis onDismiss={onDismiss}>{job.title}: stopped.</Hinweis>}
    </div>
  )
}
