import { useState, useEffect, type ReactNode } from 'react'
import { ArrowLeft, RotateCcw, Sun, Moon, Mic, Volume2, Check, X, Loader2, Bot, Shield, Terminal, Search, FileText, ChevronRight } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { SliderControl } from './SliderControl'
import { PersonaPanel } from '../personas/PersonaPanel'
import { useVoiceStore } from '../../stores/voiceStore'
import { checkWhisperAvailable } from '../../api/voice'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { FEATURE_FLAGS } from '../../lib/constants'
import { AGENT_TOOL_DEFS } from '../../api/tool-registry'
import { getRecommendedAgentModels } from '../../lib/model-compatibility'
import { MemorySettings } from './MemorySettings'
import { ProviderSettings } from './ProviderConfig'
import { WorkflowList } from '../agents/WorkflowList'
import { WorkflowBuilder } from '../agents/WorkflowBuilder'

// ── Collapsible Section ─────────────────────────────────────────

function Section({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const [animating, setAnimating] = useState(false)
  return (
    <div className="border-b border-gray-100 dark:border-white/[0.04]">
      <button
        onClick={() => { setOpen(!open); setAnimating(true) }}
        className="w-full flex items-center justify-between py-2.5 group"
      >
        <span className="text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-gray-600 dark:text-gray-500 group-hover:text-gray-800 dark:group-hover:text-gray-300 transition-colors">
          {title}
        </span>
        <ChevronRight size={12} className={`text-gray-400 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            onAnimationComplete={() => setAnimating(false)}
            className={animating ? 'overflow-hidden' : 'overflow-visible'}
          >
            <div className="pb-3 space-y-2">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Inline Toggle ───────────────────────────────────────────────

function InlineToggle({ label, enabled, onChange, icon }: { label: string; enabled: boolean; onChange: () => void; icon?: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">{label}</span>
      </div>
      <button
        onClick={onChange}
        className={`relative w-7 h-3.5 rounded-full transition-colors ${enabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-700'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-3.5' : ''}`} />
      </button>
    </div>
  )
}

// ── Workflow Section (inline, manages list/builder view) ────────

function WorkflowSection() {
  const [view, setWfView] = useState<'list' | 'builder'>('list')
  const [editingId, setEditingId] = useState<string | undefined>()

  if (view === 'builder') {
    return (
      <WorkflowBuilder
        workflowId={editingId}
        onSave={() => { setWfView('list'); setEditingId(undefined) }}
        onCancel={() => { setWfView('list'); setEditingId(undefined) }}
      />
    )
  }

  return (
    <WorkflowList
      onRun={() => {}}
      onEdit={(id) => { setEditingId(id); setWfView('builder') }}
      onCreate={() => { setEditingId(undefined); setWfView('builder') }}
    />
  )
}

// ── Main Component ──────────────────────────────────────────────

export function SettingsPage() {
  const { settings, updateSettings, resetSettings } = useSettingsStore()
  const { setView } = useUIStore()
  const voiceSettings = useVoiceStore()
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [whisperStatus, setWhisperStatus] = useState<{ available: boolean; backend: string | null; error?: string } | null>(null)
  const [whisperLoading, setWhisperLoading] = useState(true)

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

  useEffect(() => {
    setWhisperLoading(true)
    checkWhisperAvailable()
      .then(setWhisperStatus)
      .finally(() => setWhisperLoading(false))
  }, [])

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-lg mx-auto px-4 py-4">
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <button onClick={() => setView('chat')} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-white/5 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors">
            <ArrowLeft size={16} />
          </button>
          <h1 className="text-[0.8rem] font-semibold text-gray-800 dark:text-gray-200">Settings</h1>
        </div>

        {/* ── Appearance ─────────────────────────────── */}
        <Section title="Appearance" defaultOpen>
          <div className="flex items-center justify-between">
            <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Theme</span>
            <div className="flex gap-1">
              <button
                onClick={() => updateSettings({ theme: 'light' })}
                className={`flex items-center gap-1 px-2 py-1 rounded text-[0.65rem] transition-colors ${
                  settings.theme === 'light' ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <Sun size={11} /> Light
              </button>
              <button
                onClick={() => updateSettings({ theme: 'dark' })}
                className={`flex items-center gap-1 px-2 py-1 rounded text-[0.65rem] transition-colors ${
                  settings.theme === 'dark' ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <Moon size={11} /> Dark
              </button>
            </div>
          </div>
        </Section>

        {/* ── Generation Parameters ──────────────────── */}
        <Section title="Generation">
          <SliderControl label="Temperature" value={settings.temperature} min={0} max={2} step={0.1} onChange={(v) => updateSettings({ temperature: v })} />
          <SliderControl label="Top P" value={settings.topP} min={0} max={1} step={0.05} onChange={(v) => updateSettings({ topP: v })} />
          <SliderControl label="Top K" value={settings.topK} min={1} max={100} step={1} onChange={(v) => updateSettings({ topK: v })} />
          <div className="flex items-center justify-between">
            <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Max Tokens</span>
            <input
              type="number"
              value={settings.maxTokens}
              onChange={(e) => updateSettings({ maxTokens: parseInt(e.target.value) || 0 })}
              min={0}
              placeholder="0"
              className="w-20 px-1.5 py-0.5 rounded bg-transparent border border-white/8 text-[0.65rem] text-right text-gray-300 font-mono focus:outline-none focus:border-white/20"
            />
          </div>
        </Section>

        {/* ── Providers ──────────────────────────────── */}
        <Section title="Providers" defaultOpen>
          <ProviderSettings />
        </Section>

        {/* ── Voice ──────────────────────────────────── */}
        <Section title="Voice">
          <div className="flex items-center gap-3 text-[0.65rem]">
            <span className="flex items-center gap-1">
              {whisperLoading ? <Loader2 size={10} className="animate-spin text-gray-500" /> : whisperStatus?.available ? <Check size={10} className="text-green-500" /> : <X size={10} className="text-red-500" />}
              <span className="text-gray-500">STT</span>
            </span>
            <span className="flex items-center gap-1">
              {ttsSupported ? <Check size={10} className="text-green-500" /> : <X size={10} className="text-red-500" />}
              <span className="text-gray-500">TTS</span>
            </span>
          </div>
          <InlineToggle label="TTS Enabled" enabled={voiceSettings.ttsEnabled} onChange={() => voiceSettings.updateVoiceSettings({ ttsEnabled: !voiceSettings.ttsEnabled })} icon={<Volume2 size={11} className="text-gray-500" />} />
          <div className="flex items-center justify-between">
            <span className="text-[0.7rem] text-gray-500">Voice</span>
            <select
              value={voiceSettings.ttsVoice}
              onChange={(e) => voiceSettings.updateVoiceSettings({ ttsVoice: e.target.value })}
              className="max-w-[180px] px-1.5 py-0.5 rounded bg-transparent border border-white/8 text-[0.65rem] text-gray-300 focus:outline-none"
            >
              <option value="">Default</option>
              {voices.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
            </select>
          </div>
          <SliderControl label="Rate" value={voiceSettings.ttsRate} min={0.5} max={2} step={0.1} onChange={(v) => voiceSettings.updateVoiceSettings({ ttsRate: v })} />
          <SliderControl label="Pitch" value={voiceSettings.ttsPitch} min={0.5} max={2} step={0.1} onChange={(v) => voiceSettings.updateVoiceSettings({ ttsPitch: v })} />
          <InlineToggle label="Auto-send on Transcribe" enabled={voiceSettings.autoSendOnTranscribe} onChange={() => voiceSettings.updateVoiceSettings({ autoSendOnTranscribe: !voiceSettings.autoSendOnTranscribe })} icon={<Mic size={11} className="text-gray-500" />} />
        </Section>

        {/* ── Memory ─────────────────────────────────── */}
        <Section title="Memory">
          <MemorySettings />
        </Section>

        {/* ── Personas ───────────────────────────────── */}
        <Section title="Personas">
          <PersonaPanel />
        </Section>

        {/* ── Agent Mode ─────────────────────────────── */}
        {FEATURE_FLAGS.AGENT_MODE && (
          <Section title="Agent Mode (Beta)">
            <div className="flex items-center justify-between">
              <span className="text-[0.7rem] text-gray-500">Sandbox</span>
              <div className="flex gap-1">
                {(['restricted', 'full'] as const).map(level => (
                  <button
                    key={level}
                    onClick={() => useAgentModeStore.getState().setSandboxLevel(level)}
                    className={`px-2 py-0.5 rounded text-[0.6rem] transition-colors ${
                      useAgentModeStore.getState().sandboxLevel === level ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {level === 'restricted' ? 'Restricted' : 'Full Access'}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-0.5">
              <span className="text-[0.6rem] text-gray-500">Tools</span>
              {AGENT_TOOL_DEFS.map((tool) => (
                <div key={tool.name} className="flex items-center justify-between py-0.5">
                  <span className="text-[0.65rem] text-gray-400 font-mono">{tool.name}</span>
                  <span className={`text-[0.55rem] ${tool.permission === 'auto' ? 'text-green-500' : 'text-amber-400'}`}>
                    {tool.permission === 'auto' ? 'auto' : 'approval'}
                  </span>
                </div>
              ))}
            </div>
            <div className="space-y-0.5">
              <span className="text-[0.6rem] text-gray-500">Recommended Models</span>
              {getRecommendedAgentModels().map((m) => (
                <div key={m.name} className="flex items-center gap-1.5 py-0.5">
                  {m.hot && <span className="text-[0.5rem] text-orange-400 font-bold">HOT</span>}
                  <span className="text-[0.65rem] text-gray-300">{m.label}</span>
                  <span className="text-[0.55rem] text-gray-600">— {m.reason}</span>
                </div>
              ))}
            </div>
            <button
              onClick={() => useAgentModeStore.getState().setTutorialCompleted()}
              className="text-[0.6rem] text-gray-500 hover:text-gray-300 transition-colors"
            >
              Reset tutorial
            </button>
          </Section>
        )}

        {/* ── Agent Workflows ────────────────────────── */}
        {FEATURE_FLAGS.AGENT_WORKFLOWS && (
          <Section title="Agent Workflows">
            <WorkflowSection />
          </Section>
        )}

        {/* ── Search Provider ────────────────────────── */}
        {FEATURE_FLAGS.AGENT_MODE && (
          <Section title="Search Provider">
            <div className="space-y-3">
              <div>
                <span className="text-[0.6rem] text-gray-500 block mb-1">Provider for Agent web_search</span>
                <div className="flex gap-1.5">
                  {(['auto', 'brave', 'tavily'] as const).map(p => (
                    <button
                      key={p}
                      onClick={() => updateSettings({ searchProvider: p })}
                      className={`px-2.5 py-1 rounded-md text-[0.6rem] font-medium transition-all ${
                        settings.searchProvider === p
                          ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm border border-gray-200 dark:border-white/15'
                          : 'text-gray-500 hover:text-gray-700 dark:hover:text-white bg-gray-100 dark:bg-white/5'
                      }`}
                    >
                      {p === 'auto' ? 'Auto (SearXNG > DDG)' : p === 'brave' ? 'Brave Search' : 'Tavily'}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[0.6rem] text-gray-500 block mb-1">Brave Search API Key</label>
                <input
                  type="password"
                  value={settings.braveApiKey}
                  onChange={(e) => updateSettings({ braveApiKey: e.target.value })}
                  placeholder="BSA-..."
                  className="w-full px-2.5 py-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-[0.65rem] text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:border-gray-400 dark:focus:border-white/25"
                />
                <span className="text-[0.5rem] text-gray-500 mt-0.5 block">Free tier: 2000 queries/month. Get key at brave.com/search/api</span>
              </div>
              <div>
                <label className="text-[0.6rem] text-gray-500 block mb-1">Tavily API Key</label>
                <input
                  type="password"
                  value={settings.tavilyApiKey}
                  onChange={(e) => updateSettings({ tavilyApiKey: e.target.value })}
                  placeholder="tvly-..."
                  className="w-full px-2.5 py-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-[0.65rem] text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:border-gray-400 dark:focus:border-white/25"
                />
                <span className="text-[0.5rem] text-gray-500 mt-0.5 block">AI-optimized search. Free tier: 1000 queries/month. Get key at tavily.com</span>
              </div>
            </div>
          </Section>
        )}

        {/* ── Reset ──────────────────────────────────── */}
        <div className="pt-3 pb-6">
          <button
            onClick={resetSettings}
            className="flex items-center gap-1.5 text-[0.65rem] text-gray-500 hover:text-red-400 transition-colors"
          >
            <RotateCcw size={11} /> Reset to Defaults
          </button>
        </div>
      </div>
    </div>
  )
}
