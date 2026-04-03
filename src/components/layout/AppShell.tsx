import { useEffect, useState } from 'react'
import { Header } from './Header'
import { Sidebar } from './Sidebar'
import { ChatView } from '../chat/ChatView'
import { ModelManager } from '../models/ModelManager'
import { SettingsPage } from '../settings/SettingsPage'
import { CreateView } from '../create/CreateView'
import { Onboarding } from '../onboarding/Onboarding'
import { BackendSelector } from '../onboarding/BackendSelector'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { detectLocalBackends, type DetectedBackend } from '../../lib/backend-detector'

export function AppShell() {
  const { currentView } = useUIStore()
  const { settings } = useSettingsStore()
  const onboardingDone = useSettingsStore((s) => s.settings.onboardingDone)

  const [detectedBackends, setDetectedBackends] = useState<DetectedBackend[]>([])
  const [showSelector, setShowSelector] = useState(false)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings.theme === 'dark')
    document.documentElement.classList.toggle('light', settings.theme === 'light')
  }, [settings.theme])

  // Auto-detect local backends on startup (once per session)
  useEffect(() => {
    if (!onboardingDone) return
    if (sessionStorage.getItem('lu-backend-detection-done')) return

    sessionStorage.setItem('lu-backend-detection-done', '1')

    detectLocalBackends().then((backends) => {
      if (backends.length === 0) return

      // If only Ollama detected, nothing to do (already default)
      const nonOllama = backends.filter(b => b.id !== 'ollama')
      if (nonOllama.length === 0) return

      // If exactly 1 non-Ollama backend, auto-enable it
      if (nonOllama.length === 1) {
        const backend = nonOllama[0]
        useProviderStore.getState().setProviderConfig('openai', {
          enabled: true,
          name: backend.name,
          baseUrl: backend.baseUrl,
          isLocal: true,
        })
        return
      }

      // Multiple backends detected → show selection dialog
      setDetectedBackends(backends)
      setShowSelector(true)
    })
  }, [onboardingDone])

  if (!onboardingDone) {
    return <Onboarding />
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-white dark:bg-[#0a0a0a] text-gray-900 dark:text-gray-100">
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

      {/* Backend selection dialog (shown when multiple local backends detected) */}
      <BackendSelector
        open={showSelector}
        backends={detectedBackends}
        onClose={() => setShowSelector(false)}
      />
    </div>
  )
}
