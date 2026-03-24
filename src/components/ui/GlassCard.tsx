import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
  className?: string
  hover?: boolean
}

export function GlassCard({ children, className = '', hover = false }: Props) {
  return (
    <motion.div
      className={`glass-card rounded-xl p-4 ${className}`}
      whileHover={hover ? { scale: 1.02, borderColor: 'rgba(0, 240, 255, 0.3)' } : undefined}
      transition={{ duration: 0.2 }}
    >
      {children}
    </motion.div>
  )
}
