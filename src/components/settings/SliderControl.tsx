interface Props {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}

export function SliderControl({ label, value, min, max, step, onChange }: Props) {
  const pct = ((value - min) / (max - min)) * 100

  return (
    <div className="space-y-1">
      {/* Label + value on one line */}
      <div className="flex items-center justify-between">
        <span className="text-[0.7rem] text-gray-500 dark:text-gray-400">{label}</span>
        <span className="text-[0.65rem] font-mono text-gray-400 dark:text-gray-500">{value}</span>
      </div>
      {/* Slider full width below */}
      <div className="relative h-5 flex items-center">
        {/* Track background */}
        <div className="absolute inset-x-0 h-1 rounded-full bg-white/10" />
        {/* Track fill */}
        <div className="absolute left-0 h-1 rounded-full bg-gray-400" style={{ width: `${pct}%` }} />
        {/* Native input (invisible but captures all mouse/touch events) */}
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
        {/* Custom thumb */}
        <div
          className="absolute w-3 h-3 rounded-full bg-gray-300 border border-gray-500 pointer-events-none"
          style={{ left: `calc(${pct}% - 6px)`, zIndex: 1 }}
        />
      </div>
    </div>
  )
}
