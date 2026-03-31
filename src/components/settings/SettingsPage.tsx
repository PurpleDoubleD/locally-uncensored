import { useState, useEffect } from 'react'
import { ArrowLeft, RotateCcw, Sun, Moon, Mic, Volume2, Check, X } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { GlassCard } from '../ui/GlassCard'
import { GlowButton } from '../ui/GlowButton'
import { SliderControl } from './SliderControl'
import { ApiConfig } from './ApiConfig'
import { PersonaPanel } from '../personas/PersonaPanel'
import { useVoiceStore } from '../../stores/voiceStore'

export function SettingsPage() {
  const { settings, updateSettings, resetSettings } = useSettingsStore()
  const { setView } = useUIStore()
  const voiceSettings = useVoiceStore()
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])

  const sttSupported = typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
  const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window

  useEffect(() => {
    if (!ttsSupported) return
    const loadVoices = () => {
      const v = speechSynthesis.getVoices()
      if (v.length > 0) setVoices(v)
    }
    loadVoices()
    speechSynthesis.addEventListener('voiceschanged', loadVoices)
    return () => speechSynthesis.removeEventListener('voiceschanged', loadVoices)
  }, [ttsSupported])

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
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4 uppercase tracking-wider">Voice</h2>
          <div className="space-y-4">
            {/* Support indicators */}
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5">
                {sttSupported ? (
                  <Check size={14} className="text-green-500" />
                ) : (
                  <X size={14} className="text-red-500" />
                )}
                <span className="text-xs text-gray-600 dark:text-gray-300">Speech-to-Text</span>
              </div>
              <div className="flex items-center gap-1.5">
                {ttsSupported ? (
                  <Check size={14} className="text-green-500" />
                ) : (
                  <X size={14} className="text-red-500" />
                )}
                <span className="text-xs text-gray-600 dark:text-gray-300">Text-to-Speech</span>
              </div>
            </div>

            {/* TTS Enabled toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Volume2 size={16} className="text-gray-500 dark:text-gray-400" />
                <label className="text-sm text-gray-600 dark:text-gray-300">TTS Enabled</label>
              </div>
              <button
                onClick={() => voiceSettings.updateVoiceSettings({ ttsEnabled: !voiceSettings.ttsEnabled })}
                className={`relative w-10 h-5 rounded-full transition-colors ${voiceSettings.ttsEnabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${voiceSettings.ttsEnabled ? 'translate-x-5' : ''}`} />
              </button>
            </div>

            {/* TTS Voice dropdown */}
            <div className="space-y-1.5">
              <label className="text-sm text-gray-600 dark:text-gray-300">TTS Voice</label>
              <select
                value={voiceSettings.ttsVoice}
                onChange={(e) => voiceSettings.updateVoiceSettings({ ttsVoice: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-300 dark:border-white/10 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-gray-400 dark:focus:border-white/20"
              >
                <option value="">System Default</option>
                {voices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
            </div>

            {/* TTS Rate slider */}
            <SliderControl
              label="TTS Rate"
              value={voiceSettings.ttsRate}
              min={0.5}
              max={2}
              step={0.1}
              onChange={(v) => voiceSettings.updateVoiceSettings({ ttsRate: v })}
            />

            {/* TTS Pitch slider */}
            <SliderControl
              label="TTS Pitch"
              value={voiceSettings.ttsPitch}
              min={0.5}
              max={2}
              step={0.1}
              onChange={(v) => voiceSettings.updateVoiceSettings({ ttsPitch: v })}
            />

            {/* Auto-send on transcribe toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Mic size={16} className="text-gray-500 dark:text-gray-400" />
                <label className="text-sm text-gray-600 dark:text-gray-300">Auto-send on Transcribe</label>
              </div>
              <button
                onClick={() => voiceSettings.updateVoiceSettings({ autoSendOnTranscribe: !voiceSettings.autoSendOnTranscribe })}
                className={`relative w-10 h-5 rounded-full transition-colors ${voiceSettings.autoSendOnTranscribe ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${voiceSettings.autoSendOnTranscribe ? 'translate-x-5' : ''}`} />
              </button>
            </div>
          </div>
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
