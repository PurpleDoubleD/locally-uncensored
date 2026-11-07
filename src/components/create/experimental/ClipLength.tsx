import { AlertTriangle } from 'lucide-react'
import { modelLabel } from '../../../lib/render/preset-models'
import { swapClipCredits, swapClipLimits, swapClipSeconds, swapCreditsPerSecond, swapPricedSeconds } from '../../../lib/render/swap'

// The length of a Swap Character run (port of the web's ClipLength, C52).
// The slider always shows the whole span (2 s up to the longest model, 120 s);
// what the customer's own video does not have is drawn faint. Where the model
// reads less than the video is long, one sentence says so instead of cutting
// silently. Credits for the chosen length and per second stand beside it, the
// same seconds the Create button and the server count (swapPricedSeconds).

export function ClipLength({
  model, options, videoSeconds, chosen, onChange, photos = 0, span, disabled = false,
}: {
  model: string
  options: Record<string, unknown>
  /** Length of the customer's video, measured in the app. */
  videoSeconds?: number
  chosen: number | null
  onChange: (seconds: number) => void
  /** Photos billed one by one (the main model). */
  photos?: number
  /** The span of the slider when more than one model stands behind it (up to
   *  15 s the main model, longer Wan 2.2 Animate up to 120 s). Without it the
   *  span of the one model. */
  span?: { min: number; max: number }
  disabled?: boolean
}) {
  const own = swapClipLimits(model)
  const { min, max } = span ?? own
  const value = span
    // Without a choice the run takes the whole video up to the limit of the
    // model on duty (15 s on the main model), not the end of the slider: the
    // slider spans both models, the price is the one model's.
    ? Math.max(min, Math.min(chosen ?? own.max, max, videoSeconds ? Math.max(min, Math.floor(videoSeconds)) : max))
    : swapClipSeconds(model, chosen, videoSeconds)
  const video = videoSeconds ? Math.floor(videoSeconds) : undefined
  const perSecond = swapCreditsPerSecond(model, options)
  const total = swapClipCredits(model, options, videoSeconds ? swapPricedSeconds(model, chosen, videoSeconds) : Math.min(value, own.max), photos)
  const name = modelLabel(model)
  const at = (v: number) => (max > min ? Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100)) : 0)
  const pos = at(value)
  // Faint from the end of the customer's video on.
  const end = video !== undefined && video < max ? at(Math.max(min, video)) : 100

  return (
    <div className="w-full" data-clip-length>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor="swap-length" className="t-control text-gray-400">
          Length <span className="t-mono text-gray-200">{value} s</span>
          {video !== undefined && <span className="text-gray-500"> of {video} s</span>}
        </label>
        {total != null && perSecond != null && (
          <span className="text-right" data-clip-price>
            <span className="t-mono text-gray-200">{total.toLocaleString('en-US')}</span>
            <span className="t-control text-gray-500"> credits · {perSecond.toLocaleString('en-US')}/s</span>
          </span>
        )}
      </div>
      <div className="relative mt-1 h-5 flex items-center">
        <div className="absolute inset-x-0 h-1 rounded-full bg-white/[0.04]" />
        <div className="absolute h-1 rounded-full bg-white/10" style={{ left: 0, width: `${end}%` }} />
        <div className="absolute h-1 rounded-full bg-lu-accent" style={{ left: 0, width: `${pos}%` }} />
        <input
          id="swap-length"
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          disabled={disabled}
          aria-valuetext={`${value} seconds`}
          onChange={(e) => {
            const v = Number(e.target.value)
            // Past the end of the video there is nothing to take.
            onChange(video !== undefined ? Math.min(v, Math.max(min, video)) : v)
          }}
          className="absolute inset-x-0 w-full cursor-pointer disabled:cursor-not-allowed"
          style={{ zIndex: 2, opacity: 0, top: '-4px', height: '28px' }}
        />
        <div
          className="absolute w-3.5 h-3.5 rounded-full pointer-events-none bg-gray-200 border border-lu-accent"
          style={{ left: `calc(${pos}% - 7px)`, zIndex: 1, boxShadow: '0 1px 4px rgba(0,0,0,0.4)' }}
        />
      </div>
      <div className="mt-0.5 flex justify-between t-control text-gray-500 tabular-nums">
        <span>{min} s</span>
        <span>{name}: {own.min} to {own.max} s</span>
        <span>{max} s</span>
      </div>
      {video !== undefined && video > own.max && value >= own.max && (
        <p className="mt-1.5 flex items-start gap-1.5 t-body text-gray-500 dark:text-gray-400" data-clip-note="too-long">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          Your video is {video} s. {name} reads at most {own.max} s, so only the first {Math.min(value, own.max)} s are used.
        </p>
      )}
      {video !== undefined && video < own.min && (
        <p className="mt-1.5 flex items-start gap-1.5 t-body text-gray-500 dark:text-gray-400" data-clip-note="too-short">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          Your video is {video} s. {name} needs at least {own.min} s.
        </p>
      )}
      {value < own.billedMin && (
        <p className="mt-1 t-body text-gray-500" data-clip-note="billed-min">Billed as {own.billedMin} s, the provider&apos;s minimum.</p>
      )}
    </div>
  )
}
