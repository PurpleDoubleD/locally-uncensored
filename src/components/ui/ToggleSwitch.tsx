import { motion } from 'framer-motion'
import { SPRING_CONTROL } from './motion'

interface Props {
  enabled: boolean
  onChange: (enabled: boolean) => void
  label?: string
  disabled?: boolean
  size?: 'sm' | 'md'
}

export function ToggleSwitch({ enabled, onChange, label, disabled = false, size = 'sm' }: Props) {
  const trackSize = size === 'sm' ? 'w-8 h-4' : 'w-10 h-5'
  const dotSize = size === 'sm' ? 'w-3 h-3' : 'w-4 h-4'
  const dotTravel = size === 'sm' ? 16 : 20

  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!enabled)}
      disabled={disabled}
      className={`flex items-center gap-2 ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
      aria-label={label || 'Toggle'}
    >
      {label && (
        <span className="text-[0.7rem] text-gray-500 dark:text-gray-400 select-none">{label}</span>
      )}
      <div
        className={`${trackSize} rounded-full relative transition-colors duration-[var(--motion-base)] ${
          enabled
            ? 'bg-green-500/30 border border-green-500/50'
            : 'bg-gray-300 dark:bg-white/10 border border-gray-400 dark:border-white/15'
        }`}
      >
        <motion.div
          className={`${dotSize} rounded-full absolute top-1/2 -translate-y-1/2 ${
            enabled ? 'bg-green-400' : 'bg-gray-400 dark:bg-gray-500'
          }`}
          animate={{ left: enabled ? dotTravel : 2 }}
          transition={SPRING_CONTROL}
        />
      </div>
    </button>
  )
}
