import { Dices } from 'lucide-react'
import { cn } from './cn'

interface Props {
  label?: string
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
  onRandomize?: () => void
  mono?: boolean
  suffix?: string
  className?: string
}

/**
 * Bring a typed value inside the declared bounds and onto the step grid.
 *
 * `min` / `max` / `step` on an <input type="number"> are advisory: React takes
 * whatever was typed or pasted, so a Width declared 64..4096 step 64 reached
 * the generator as 9999 or 3 and the job failed in the backend — in cloud mode
 * after the request was already on its way. Applied on BLUR, never per
 * keystroke: clamping while typing turns "1024" into 64 at the first digit.
 */
export function commitNumber(v: number, min?: number, max?: number, step?: number): number {
  let out = v
  if (typeof step === 'number' && step > 0 && typeof min === 'number') {
    out = min + Math.round((out - min) / step) * step
  }
  if (typeof min === 'number') out = Math.max(min, out)
  if (typeof max === 'number') out = Math.min(max, out)
  return out
}

export function NumberField({ label, value, min, max, step = 1, onChange, onRandomize, mono = true, suffix, className }: Props) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label !== undefined && <div className="t-control text-gray-400">{label}</div>}
      <div className="flex items-center gap-1.5">
        <div className="flex items-center flex-1 h-[var(--control-h-md)] px-2.5 rounded-[var(--radius-control)] bg-white/[0.04] border border-white/[0.08] focus-within:border-white/20">
          <input
            type="number"
            value={value}
            min={min}
            max={max}
            step={step}
            onChange={(e) => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onChange(v) }}
            onBlur={(e) => {
              const v = parseFloat(e.target.value)
              if (Number.isNaN(v)) return
              const fixed = commitNumber(v, min, max, step)
              if (fixed !== v) onChange(fixed)
            }}
            className={cn('bg-transparent outline-none w-full t-control text-gray-200', mono && 'lu-hud-num')}
          />
          {suffix && <span className="t-mono text-gray-600 shrink-0 pl-1">{suffix}</span>}
        </div>
        {onRandomize && (
          <button
            onClick={onRandomize}
            title="Randomize"
            className="h-[var(--control-h-md)] aspect-square inline-flex items-center justify-center rounded-[var(--radius-control)] bg-white/[0.06] text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <Dices size={14} />
          </button>
        )}
      </div>
    </div>
  )
}
