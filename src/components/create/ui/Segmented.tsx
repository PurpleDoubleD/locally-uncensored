
import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import { cn } from './cn'

export interface SegOption<T extends string> {
  value: T
  label?: string
  icon?: LucideIcon
  title?: string
}

interface Props<T extends string> {
  options: SegOption<T>[]
  value: T
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  layoutId?: string
  className?: string
  ariaLabel?: string
}

export function Segmented<T extends string>({ options, value, onChange, size = 'md', layoutId = 'seg', className, ariaLabel }: Props<T>) {
  const h = size === 'sm' ? 'h-[var(--control-h-sm)]' : 'h-[var(--control-h-md)]'
  const iconSize = size === 'sm' ? 13 : 15

  const move = (dir: -1 | 1) => {
    const i = options.findIndex((o) => o.value === value)
    const next = options[i + dir]
    if (next) onChange(next.value)
  }

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn('inline-flex items-center gap-0.5 p-0.5 rounded-[var(--radius-control)] bg-white/[0.04] border border-white/[0.06]', className)}>
      {options.map((o) => {
        const selected = o.value === value
        const Icon = o.icon
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={selected}
            aria-label={o.label || o.title}
            title={o.title || o.label}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1) }
            }}
            className={cn(
              'relative t-control inline-flex items-center justify-center gap-1.5 px-2.5 rounded-[6px] transition-colors',
              h,
              selected ? 'text-white' : 'text-gray-500 hover:text-gray-300',
            )}
          >
            {selected && (
              <motion.div
                layoutId={layoutId}
                className="absolute inset-0 rounded-[6px] bg-white/[0.12] border border-white/20"
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
              />
            )}
            {Icon && <Icon size={iconSize} className="relative z-10" />}
            {o.label && <span className="relative z-10 whitespace-nowrap">{o.label}</span>}
          </button>
        )
      })}
    </div>
  )
}