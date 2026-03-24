import { useEffect } from 'react'
import { Header } from './Header'
import { Sidebar } from './Sidebar'
import { ChatView } from '../chat/ChatView'
import { ModelManager } from '../models/ModelManager'
import { SettingsPage } from '../settings/SettingsPage'
import { CreateView } from '../create/CreateView'
import { Onboarding } from '../onboarding/Onboarding'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'

export function AppShell() {
  const { currentView } = useUIStore()
  const { settings } = useSettingsStore()
  const onboardingDone = useSettingsStore((s) => s.settings.onboardingDone)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings.theme === 'dark')
    document.documentElement.classList.toggle('light', settings.theme === 'light')
  }, [settings.theme])

  if (!onboardingDone) {
    return <Onboarding />
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-white dark:bg-[#212121] text-gray-900 dark:text-white">
      <div className="h-full flex flex-col">
        <Header />
        <div className="flex-1 flex overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-hidden">
            {currentView === 'chat' && <ChatView />}
            {currentView === 'models' && <ModelManager />}
            {currentView === 'settings' && <SettingsPage />}
            {currentView === 'create' && <CreateView />}
          </main>
        </div>
      </div>
    </div>
  )
}
