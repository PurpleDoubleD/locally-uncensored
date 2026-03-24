import { motion } from 'framer-motion'
import type { ReactNode, ButtonHTMLAttributes } from 'react'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'danger'
}

const variants = {
  primary: 'bg-white/10 border-white/15 text-white hover:bg-white/15',
  secondary: 'bg-white/5 border-white/10 text-gray-300 hover:bg-white/10',
  danger: 'bg-red-500/15 border-red-500/30 text-red-300 hover:bg-red-500/25',
}

export function GlowButton({ children, variant = 'primary', className = '', ...props }: Props) {
  return (
    <motion.button
      className={`px-4 py-2 rounded-lg border font-medium transition-all duration-300 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${variants[variant]} ${className}`}
      whileTap={{ scale: 0.95 }}
      {...(props as any)}
    >
      {children}
    </motion.button>
  )
}
