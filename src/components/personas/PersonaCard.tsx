import { motion } from 'framer-motion'
import { Bot, Code, Feather, BarChart3, Zap, User } from 'lucide-react'

const iconMap: Record<string, typeof Bot> = { Bot, Code, Feather, BarChart3, Zap, User }

interface Props {
  name: string
  icon: string
  isActive: boolean
  onClick: () => void
}

export function PersonaCard({ name, icon, isActive, onClick }: Props) {
  const Icon = iconMap[icon] || Bot

  return (
    <motion.button
      onClick={onClick}
      className={`flex flex-col items-center justify-center gap-1.5 rounded-xl border transition-all cursor-pointer w-full aspect-square ${
        isActive
          ? 'bg-gray-200 dark:bg-white/10 border-gray-400 dark:border-white/20'
          : 'bg-gray-50 dark:bg-white/[0.03] border-gray-200 dark:border-white/[0.06] hover:bg-gray-100 dark:hover:bg-white/[0.06]'
      }`}
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.97 }}
    >
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isActive ? 'bg-gray-300 dark:bg-white/10' : 'bg-gray-100 dark:bg-white/5'}`}>
        <Icon size={16} className={isActive ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400'} />
      </div>
      <span className={`text-[10px] font-medium leading-tight text-center line-clamp-2 px-1 ${isActive ? 'text-gray-800 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>
        {name}
      </span>
    </motion.button>
  )
}
