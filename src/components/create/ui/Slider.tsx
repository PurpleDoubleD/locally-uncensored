interface Props {
  label?: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  unit?: string
  format?: (v: number) => string
  /** Where the bar starts and a small mark sits, for a range around zero
   *  (the LoRA strength). Without it the bar starts at min, as before. */
  origin?: number
}

// Upgrade of src/components/settings/SliderControl.tsx — same neutral-grey fill
// and thumb as the live app, plus a unit + tabular-mono value readout.
export function Slider({ label, value, min, max, step, onChange, unit, format, origin }: Props) {
  // Held inside the track: a value outside min..max (a stored setting from a
  // wider range) drew the bar and the thumb past the end of the slider.
  const at = (v: number) => max > min ? Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100)) : 0
  const pct = at(value)
  const from = origin === undefined ? 0 : at(origin)
  const display = format ? format(value) : `${value}${unit ? ' ' + unit : ''}`
  return (
    <div className="space-y-1.5">
      {label !== undefined && (
        <div className="flex items-center justify-between">
          <span className="t-control text-gray-400">{label}</span>
          <span className="t-mono text-gray-300">{display}</span>
        </div>
      )}
      <div className="relative h-5 flex items-center">
        <div className="absolute inset-x-0 h-1 rounded-full bg-white/10" />
        <div className="absolute h-1 rounded-full bg-gray-400" style={{ left: `${Math.min(from, pct)}%`, width: `${Math.abs(pct - from)}%` }} />
        {origin !== undefined && (
          <div data-testid="slider-origin" className="absolute w-px h-2.5 bg-gray-500" style={{ left: `${from}%` }} />
        )}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="absolute inset-x-0 w-full cursor-pointer"
          style={{ zIndex: 2, opacity: 0, top: '-4px', height: '28px' }}
        />
        <div
          className="absolute w-3.5 h-3.5 rounded-full pointer-events-none bg-gray-300 border border-gray-500"
          style={{ left: `calc(${pct}% - 7px)`, zIndex: 1, boxShadow: '0 1px 4px rgba(0,0,0,0.4)' }}
        />
      </div>
    </div>
  )
}
