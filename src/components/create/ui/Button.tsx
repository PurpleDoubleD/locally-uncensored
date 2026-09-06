
import { Loader2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from './cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

interface Props {
  children?: React.ReactNode
  onClick?: () => void
  variant?: Variant
  size?: Size
  icon?: LucideIcon
  iconOnly?: boolean
  loading?: boolean
  disabled?: boolean
  fullWidth?: boolean
  title?: string
  ariaLabel?: string
  type?: 'button' | 'submit'
  active?: boolean
}

const SIZE_H: Record<Size, string> = {
  sm: 'h-[var(--control-h-sm)]',
  md: 'h-[var(--control-h-md)]',
  lg: 'h-[var(--control-h-lg)]',
}
const SIZE_PX: Record<Size, string> = {
  sm: 'px-2 gap-1.5',
  md: 'px-3 gap-2',
  lg: 'px-4 gap-2',
}
const ICON_SIZE: Record<Size, number> = { sm: 13, md: 14, lg: 16 }

// Die Primaeraktion traegt das gemeinsame Rezept `.lu-primary` (index.css) —
// Flaeche, Textfarbe, Hover, Fokusring und disabled liegen dort, an genau
// einer Stelle, geteilt mit AccountPanel (Sign in) und ChatInput (Send).
// Vorher stand hier ein eigenes Graustufen-Rezept, das die wichtigste Aktion
// des Bildschirms wie eine Nebenaktion aussehen liess.
const VARIANT: Record<Variant, string> = {
  primary: 'lu-primary',
  secondary: 'bg-white/10 text-gray-100 hover:bg-white/15',
  ghost: 'bg-transparent text-gray-400 hover:text-white hover:bg-white/8',
  danger: 'bg-red-500/15 text-red-500 dark:text-red-400 hover:bg-red-500/25',
}

export function Button({
  children, onClick, variant = 'secondary', size = 'md', icon: Icon,
  iconOnly = false, loading = false, disabled = false, fullWidth = false,
  title, ariaLabel, type = 'button', active = false,
}: Props) {
  const isDisabled = disabled || loading
  // Der Druck kommt aus der Hausregel in index.css (`:active { scale: .97 }`),
  // nicht aus einem `whileTap` an diesem Knopf. Beides zugleich waere
  // 0,96 x 0,97 = 0,93, also ein doppelter Druck — und framer-motion
  // schriebe dafuer bei jedem Klick ein inline-Transform, das der
  // Compositor ohnehin allein kann.
  return (
    <button
      type={type}
      title={title}
      aria-label={ariaLabel ?? title}
      aria-busy={loading || undefined}
      onClick={onClick}
      disabled={isDisabled}
      className={cn(
        't-control inline-flex items-center justify-center select-none transition-colors rounded-[var(--radius-control)]',
        SIZE_H[size],
        iconOnly ? 'aspect-square' : SIZE_PX[size],
        VARIANT[variant],
        active && variant === 'ghost' && 'bg-white/10 text-white',
        fullWidth && 'w-full',
        isDisabled && 'opacity-40 pointer-events-none',
      )}
    >
      {loading ? <Loader2 size={ICON_SIZE[size]} className="animate-spin" />
        : Icon ? <Icon size={ICON_SIZE[size]} /> : null}
      {!iconOnly && children}
    </button>
  )
}