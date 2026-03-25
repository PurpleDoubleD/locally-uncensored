import { Menu, Settings, Cpu, Sun, Moon, MessageSquare, Film, Layers } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { ModelSelector } from '../models/ModelSelector'

export function Header() {
  const { currentView, toggleSidebar, setView } = useUIStore()
  const { settings, updateSettings } = useSettingsStore()

  const toggleTheme = () => {
    updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
  }

  return (
    <header className="h-14 flex items-center justify-between px-4 border-b border-gray-200 dark:border-white/5 bg-white dark:bg-[#2f2f2f] z-20">
      {/* Left: Sidebar + Logo */}
      <div className="flex items-center gap-3">
        <button
          onClick={toggleSidebar}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
        >
          <Menu size={20} />
        </button>
        <button
          onClick={() => {
            useChatStore.getState().setActiveConversation(null)
            setView('chat')
          }}
          className="flex items-center gap-2 text-gray-800 dark:text-gray-200 hover:opacity-80 transition"
        >
          <Cpu size={20} />
          <span className="font-bold text-sm tracking-wider hidden sm:inline">LOCALLY UNCENSORED</span>
        </button>
      </div>

      {/* Center: Model Selector */}
      <ModelSelector />

      {/* Right: Actions */}
      <div className="flex items-center gap-1">
        <button
          onClick={toggleTheme}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
          title={settings.theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        >
          {settings.theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <button
          onClick={() => setView('chat')}
          className={`p-2 rounded-lg transition-colors ${currentView === 'chat' ? 'bg-blue-100 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300' : 'hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'}`}
          title="Text Chat"
        >
          <MessageSquare size={18} />
        </button>
        <button
          onClick={() => setView('create')}
          className={`p-2 rounded-lg transition-colors ${currentView === 'create' ? 'bg-purple-100 dark:bg-purple-500/15 text-purple-600 dark:text-purple-300' : 'hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'}`}
          title="Create Images & Videos"
        >
          <Film size={18} />
        </button>
        <button
          onClick={() => setView('models')}
          className={`p-2 rounded-lg transition-colors ${currentView === 'models' ? 'bg-blue-100 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300' : 'hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'}`}
          title="Model Manager"
        >
          <Layers size={18} />
        </button>
        <button
          onClick={() => setView('settings')}
          className={`p-2 rounded-lg transition-colors ${currentView === 'settings' ? 'bg-gray-200 dark:bg-white/15 text-gray-900 dark:text-white' : 'hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'}`}
          title="Settings"
        >
          <Settings size={18} />
        </button>
      </div>
    </header>
  )
}
