import { motion } from 'framer-motion'
import { MOTION_S } from './motion'

interface Props {
  progress: number // 0-100
  label?: string
}

export function ProgressBar({ progress, label }: Props) {
  return (
    <div className="w-full">
      {label && <p className="text-sm text-gray-400 mb-1">{label}</p>}
      <div className="w-full h-2 rounded-full bg-white/5 overflow-hidden">
        <motion.div
          className="h-full rounded-full bg-white/60"
          style={{}}
          initial={{ width: 0 }}
          animate={{ width: `${Math.min(progress, 100)}%` }}
          transition={{ duration: MOTION_S.slow }}
        />
      </div>
      <p className="text-xs text-gray-500 mt-1 text-right">{Math.round(progress)}%</p>
    </div>
  )
}
