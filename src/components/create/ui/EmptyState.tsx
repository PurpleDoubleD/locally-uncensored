
import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import { Button } from './Button'
import { ICON_STROKE_MARK } from '../../ui/icon-size'

interface Action {
  label: string
  onClick: () => void
  icon?: LucideIcon
  variant?: 'primary' | 'secondary' | 'ghost'
}

interface Props {
  icon: LucideIcon
  /** When set, renders this image (e.g. the LU monogram) instead of the icon. */
  logoSrc?: string
  title: string
  description?: string
  action?: Action
  secondaryAction?: Action
  children?: React.ReactNode
  tone?: 'neutral' | 'accent'
}

export function EmptyState({ icon: Icon, logoSrc, title, description, action, secondaryAction, children, tone = 'neutral' }: Props) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="max-w-sm space-y-4"
      >
        {logoSrc ? (
          <img src={logoSrc} alt="" className="mx-auto h-14 w-14 object-contain opacity-90 select-none" draggable={false} />
        ) : (
          // David 2026-07-13: no gray bubble behind the icon — the SVG stands on
          // its own, lifted only by a soft purple accent glow (a gentle, slow
          // breathe so it reads as intentional, not a hard animation).
          <div className="relative mx-auto w-16 h-16 flex items-center justify-center">
            <motion.span
              aria-hidden
              className="absolute rounded-full bg-lu-accent blur-2xl"
              style={{ width: '3.5rem', height: '3.5rem' }}
              initial={{ opacity: 0.28, scale: 0.9 }}
              animate={{ opacity: [0.28, tone === 'accent' ? 0.6 : 0.42, 0.28], scale: [0.9, 1.06, 0.9] }}
              transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
            />
            <Icon size={36} strokeWidth={ICON_STROKE_MARK} className="relative text-lu-accent drop-shadow-[0_0_8px_var(--color-lu-accent-ring)]" />
          </div>
        )}
        <div className="space-y-1.5">
          <div className="t-title text-gray-200">{title}</div>
          {description && <div className="t-body text-gray-500">{description}</div>}
        </div>
        {children}
        {(action || secondaryAction) && (
          <div className="flex items-center justify-center gap-2 pt-1">
            {action && <Button variant={action.variant ?? 'primary'} icon={action.icon} onClick={action.onClick}>{action.label}</Button>}
            {secondaryAction && <Button variant={secondaryAction.variant ?? 'ghost'} icon={secondaryAction.icon} onClick={secondaryAction.onClick}>{secondaryAction.label}</Button>}
          </div>
        )}
      </motion.div>
    </div>
  )
}