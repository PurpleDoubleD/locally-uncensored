import { useState, type KeyboardEvent } from 'react'
import { clampCount } from '../../lib/number-limits'
import { HINWEIS_TEXT } from '../../lib/hinweis'

interface Props {
  ariaLabel: string
  value: number
  max: number
  onCommit: (value: number) => void
  placeholder?: string
}

/**
 * A whole-number Settings field with an upper bound (Jaeger B, B9 and B13).
 * Same pattern as CompactThresholdInput and the chat reply timeout: what is
 * typed stays as typed until the field loses focus or Enter is pressed, then
 * it is clamped to 0..max and saved. A value above the bound is shown as the
 * bound right away, with a short line under the field that says so, so a
 * slip of one extra zero does not travel silently into a request.
 */
export function BoundedNumberInput({ ariaLabel, value, max, onCommit, placeholder = '0' }: Props) {
  const [draft, setDraft] = useState<string | null>(null)
  const [clampedFrom, setClampedFrom] = useState<string | null>(null)

  const commit = () => {
    if (draft === null) return
    const raw = parseInt(draft, 10)
    const next = clampCount(raw, max)
    setClampedFrom(Number.isFinite(raw) && raw > max ? draft : null)
    onCommit(next)
    setDraft(null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit()
  }

  return (
    <span className="flex flex-col items-end">
      <input
        aria-label={ariaLabel}
        type="number"
        value={draft ?? String(clampCount(value, max))}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        min={0}
        max={max}
        placeholder={placeholder}
        className="w-20 px-1.5 py-0.5 rounded bg-transparent border border-white/8 t-mono text-right text-gray-300 focus:outline-none focus:border-white/20"
      />
      {clampedFrom !== null && (
        <span role="status" className={`t-micro pt-0.5 ${HINWEIS_TEXT.ruhig}`}>
          {`${clampedFrom} is above the limit, set to ${max.toLocaleString('en-US')}`}
        </span>
      )}
    </span>
  )
}
