import { Menu, Settings, Sun, Moon, MessageSquare, Film, Layers, GitCompareArrows, Trophy } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { useCompareStore } from '../../stores/compareStore'
import { ModelSelector } from '../models/ModelSelector'

export function Header() {
  const { currentView, toggleSidebar, setView } = useUIStore()
  const { settings, updateSettings } = useSettingsStore()
  const isComparing = useCompareStore((s) => s.isComparing)

  const toggleTheme = () => {
    updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
  }

  const navBtn = (view: string, icon: React.ReactNode, title: string) => (
    <button
      onClick={() => {
        // Always reset compare mode when navigating away
        if (view !== 'chat' || view === 'chat') useCompareStore.getState().setComparing(false)
        setView(view as any)
      }}
      className={`p-1.5 rounded-md transition-colors ${
        currentView === view && !isComparing
          ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white'
          : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5'
      }`}
      title={title}
    >
      {icon}
    </button>
  )

  return (
    <header className="h-10 flex items-center justify-between px-3 border-b border-gray-200 dark:border-white/[0.04] bg-gray-50 dark:bg-[#0e0e0e] z-20">
      {/* Left: Sidebar + Logo */}
      <div className="flex items-center gap-2">
        <button
          onClick={toggleSidebar}
          className="p-1 rounded-md hover:bg-gray-200 dark:hover:bg-white/5 text-gray-500 hover:text-gray-800 dark:hover:text-white transition-colors"
          aria-label="Toggle sidebar"
        >
          <Menu size={15} />
        </button>
        <button
          onClick={() => {
            useChatStore.getState().setActiveConversation(null)
            useCompareStore.getState().setComparing(false)
            setView('chat')
          }}
          className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition"
        >
          <img src="/LU-monogram-bw.png" alt="" width={16} height={16} className="dark:invert-0 invert opacity-70" />
          <span className="font-semibold text-[0.7rem] tracking-wide">LUncensored</span>
        </button>
      </div>

      {/* Center: Model Selector */}
      <ModelSelector />

      {/* Right: Nav icons — Order: Chat, Create, A/B Compare, Benchmark, Models, Settings */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={toggleTheme}
          className="p-1.5 rounded-md text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
          title={settings.theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        >
          {settings.theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        {navBtn('chat', <MessageSquare size={14} />, 'Chat')}
        {navBtn('create', <Film size={14} />, 'Create')}
        <button
          onClick={() => { useCompareStore.getState().setComparing(true); setView('chat') }}
          className={`p-1.5 rounded-md transition-colors ${
            isComparing
              ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white'
              : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5'
          }`}
          title="A/B Compare"
        >
          <GitCompareArrows size={14} />
        </button>
        <button
          onClick={() => {
            useCompareStore.getState().setComparing(false)
            setView('models')
          }}
          className="p-1.5 rounded-md transition-colors text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5"
          title="Benchmark"
        >
          <Trophy size={14} />
        </button>
        {navBtn('models', <Layers size={14} />, 'Models')}
        {navBtn('settings', <Settings size={14} />, 'Settings')}
      </div>
    </header>
  )
}
