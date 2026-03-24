import { ArrowLeft, RotateCcw, Sun, Moon } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { GlassCard } from '../ui/GlassCard'
import { GlowButton } from '../ui/GlowButton'
import { SliderControl } from './SliderControl'
import { ApiConfig } from './ApiConfig'
import { PersonaPanel } from '../personas/PersonaPanel'

export function SettingsPage() {
  const { settings, updateSettings, resetSettings } = useSettingsStore()
  const { setView } = useUIStore()

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => setView('chat')}
            className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Settings</h1>
        </div>

        <GlassCard>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4 uppercase tracking-wider">Appearance</h2>
          <div className="space-y-3">
            <label className="text-sm text-gray-600 dark:text-gray-300">Theme</label>
            <div className="flex gap-2">
              <GlowButton
                variant={settings.theme === 'light' ? 'primary' : 'secondary'}
                onClick={() => updateSettings({ theme: 'light' })}
                className="flex-1 flex items-center justify-center gap-2"
              >
                <Sun size={16} /> Light
              </GlowButton>
              <GlowButton
                variant={settings.theme === 'dark' ? 'primary' : 'secondary'}
                onClick={() => updateSettings({ theme: 'dark' })}
                className="flex-1 flex items-center justify-center gap-2"
              >
                <Moon size={16} /> Dark
              </GlowButton>
            </div>
          </div>
        </GlassCard>

        <GlassCard>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4 uppercase tracking-wider">Generation Parameters</h2>
          <div className="space-y-5">
            <SliderControl
              label="Temperature"
              value={settings.temperature}
              min={0}
              max={2}
              step={0.1}
              onChange={(v) => updateSettings({ temperature: v })}
            />
            <SliderControl
              label="Top P"
              value={settings.topP}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => updateSettings({ topP: v })}
            />
            <SliderControl
              label="Top K"
              value={settings.topK}
              min={1}
              max={100}
              step={1}
              onChange={(v) => updateSettings({ topK: v })}
            />
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm text-gray-600 dark:text-gray-300">Max Tokens</label>
                <span className="text-sm font-mono text-gray-600 dark:text-gray-300">{settings.maxTokens || 'Unlimited'}</span>
              </div>
              <input
                type="number"
                value={settings.maxTokens}
                onChange={(e) => updateSettings({ maxTokens: parseInt(e.target.value) || 0 })}
                min={0}
                placeholder="0 = unlimited"
                className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-300 dark:border-white/10 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-gray-400 dark:focus:border-white/20 font-mono"
              />
            </div>
          </div>
        </GlassCard>

        <GlassCard>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4 uppercase tracking-wider">API Configuration</h2>
          <ApiConfig endpoint={settings.apiEndpoint} onChange={(v) => updateSettings({ apiEndpoint: v })} />
        </GlassCard>

        <GlassCard>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4 uppercase tracking-wider">Personas</h2>
          <PersonaPanel />
        </GlassCard>

        <GlowButton variant="secondary" onClick={resetSettings} className="w-full flex items-center justify-center gap-2">
          <RotateCcw size={16} /> Reset to Defaults
        </GlowButton>
      </div>
    </div>
  )
}
