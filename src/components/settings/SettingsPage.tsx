import { useState, useEffect, type ReactNode } from 'react'
import { ArrowLeft, RotateCcw, Sun, Moon, Mic, Volume2, Check, X, Loader2, Shield, ChevronRight, GraduationCap, Lock } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { SliderControl } from './SliderControl'
import { PersonaPanel } from '../personas/PersonaPanel'
import { useVoiceStore } from '../../stores/voiceStore'
import { checkWhisperAvailable } from '../../api/voice'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { FEATURE_FLAGS } from '../../lib/constants'
import { getRecommendedAgentModels } from '../../lib/model-compatibility'
import { MemorySettings } from './MemorySettings'
import { RemoteAccessSettings } from './RemoteAccessSettings'
import { ProviderSettings } from './ProviderConfig'
import { PermissionSettings } from './PermissionSettings'
import { MCPServerSettings } from './MCPServerSettings'
import { WorkflowList } from '../agents/WorkflowList'
import { WorkflowBuilder } from '../agents/WorkflowBuilder'
import { useUpdateStore } from '../../stores/updateStore'
import { useClaudeCodeStore, CLAUDE_CODE_RECOMMENDED_MODELS } from '../../stores/claudeCodeStore'
import { backendCall } from '../../api/backend'
import { ArrowUpCircle } from 'lucide-react'

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

// ── Model Storage (HF GGUF download path override) ─────────────

function HfDownloadPathSetting() {
  const override = useSettingsStore(s => s.settings.hfDownloadPathOverride)
  const updateSettings = useSettingsStore(s => s.updateSettings)
  const [draft, setDraft] = useState(override)
  useEffect(() => { setDraft(override) }, [override])

  async function pickFolder() {
    try {
      const chosen = await backendCall<string | null>('pick_folder')
      if (chosen) { setDraft(chosen); updateSettings({ hfDownloadPathOverride: chosen }) }
    } catch {}
  }

  return (
    <div className="space-y-2 py-1">
      <div className="text-[0.6rem] text-gray-500 leading-relaxed">
        HuggingFace GGUF downloads save here. Leave empty to auto-detect from your active openai-compat provider (e.g. LM Studio's models folder).
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => updateSettings({ hfDownloadPathOverride: draft.trim() })}
          placeholder="(auto-detect)"
          className="flex-1 px-2 py-1 rounded bg-transparent border border-white/8 text-[0.65rem] text-gray-700 dark:text-gray-300 font-mono focus:outline-none focus:border-white/20"
        />
        <button
          onClick={pickFolder}
          className="px-2.5 py-1 rounded-md text-[0.6rem] font-medium bg-white dark:bg-white/10 text-gray-800 dark:text-white hover:bg-gray-100 dark:hover:bg-white/15 border border-gray-200 dark:border-white/15 transition-colors"
        >
          Browse…
        </button>
        {override && (
          <button
            onClick={() => { setDraft(''); updateSettings({ hfDownloadPathOverride: '' }) }}
            className="px-2.5 py-1 rounded-md text-[0.6rem] text-gray-500 hover:text-red-400 transition-colors"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  )
}

// ── ComfyUI Settings ────────────────────────────────────────────

function ComfyUISettings() {
  const [status, setStatus] = useState<{ running: boolean; found: boolean; path?: string; port?: number; host?: string; isLocal?: boolean; starting?: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [customPath, setCustomPath] = useState('')
  const [pathError, setPathError] = useState('')
  const [pathSuccess, setPathSuccess] = useState(false)
  const [customPort, setCustomPort] = useState('')
  const [portSuccess, setPortSuccess] = useState(false)
  const [customHost, setCustomHost] = useState('')
  const [hostError, setHostError] = useState('')
  const [hostSuccess, setHostSuccess] = useState(false)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const { backendCall, setComfyPort, setComfyHost } = await import('../../api/backend')
        const s: any = await backendCall('comfyui_status')
        if (!cancelled) {
          setStatus(s)
          // Mirror backend truth into the frontend URL builder so subsequent
          // fetch() calls hit the right machine immediately — no restart needed.
          if (typeof s?.port === 'number' && s.port > 0) setComfyPort(s.port)
          if (typeof s?.host === 'string' && s.host.trim()) setComfyHost(s.host)
        }
      } catch {}
      if (!cancelled) setLoading(false)
    }
    check()
    const interval = setInterval(check, 5000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  const handleStart = async () => {
    try {
      const { backendCall } = await import('../../api/backend')
      await backendCall('start_comfyui')
      setStatus(prev => prev ? { ...prev, starting: true } : null)
    } catch {}
  }

  const handleStop = async () => {
    try {
      const { backendCall } = await import('../../api/backend')
      await backendCall('stop_comfyui')
      setStatus(prev => prev ? { ...prev, running: false } : null)
    } catch {}
  }

  const handleSetPath = async () => {
    if (!customPath.trim()) return
    setPathError('')
    setPathSuccess(false)
    try {
      const { backendCall } = await import('../../api/backend')
      await backendCall('set_comfyui_path', { path: customPath.trim() })
      setPathSuccess(true)
      setStatus(prev => prev ? { ...prev, found: true, path: customPath.trim() } : { running: false, found: true, path: customPath.trim() })
      setTimeout(() => setPathSuccess(false), 3000)
    } catch (err) {
      setPathError(err instanceof Error ? err.message : 'Invalid path — main.py not found')
    }
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-[0.65rem] text-gray-500"><Loader2 size={12} className="animate-spin" /> Checking...</div>
  }

  return (
    <div className="space-y-2">
      {/* Status */}
      <div className="flex items-center justify-between">
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Status</span>
        <div className="flex items-center gap-1.5">
          <div className={`w-1.5 h-1.5 rounded-full ${status?.running ? 'bg-green-500' : status?.found ? 'bg-orange-500' : 'bg-gray-500'}`} />
          <span className="text-[0.65rem] text-gray-500">
            {status?.running ? 'Running' : status?.found ? 'Stopped' : 'Not Installed'}
          </span>
        </div>
      </div>

      {/* Host - editable (supports remote ComfyUI: Docker, LAN, homelab) */}
      <div className="space-y-1">
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Host</span>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={customHost || status?.host || 'localhost'}
            onChange={e => { setCustomHost(e.target.value); setHostError(''); setHostSuccess(false) }}
            placeholder="localhost or server-ip"
            className="flex-1 px-2 py-1 rounded-lg border text-[0.6rem] font-mono bg-transparent border-white/10 text-gray-300 focus:outline-none focus:border-white/25"
          />
          <button
            onClick={async () => {
              const host = customHost.trim()
              if (!host) { setHostError('Host required'); return }
              setHostError('')
              setHostSuccess(false)
              try {
                const { backendCall, setComfyHost } = await import('../../api/backend')
                await backendCall('set_comfyui_host', { host })
                setComfyHost(host)
                setHostSuccess(true)
                setStatus(prev => prev ? { ...prev, host, isLocal: ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host.toLowerCase()) } : null)
                setTimeout(() => setHostSuccess(false), 3000)
              } catch (err) {
                setHostError(err instanceof Error ? err.message : 'Invalid host')
              }
            }}
            disabled={!customHost.trim() || customHost.trim() === status?.host}
            className="px-2 py-1 rounded text-[0.6rem] bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors disabled:opacity-30"
          >
            Set
          </button>
        </div>
        {hostError && <p className="text-[0.55rem] text-red-400">{hostError}</p>}
        {hostSuccess && <p className="text-[0.55rem] text-green-400">Host saved. Restart ComfyUI to apply.</p>}
        {status?.host && !status?.isLocal && (
          <p className="text-[0.55rem] text-amber-400">Remote ComfyUI — start/stop/install not available from LU. Manage the process on the server.</p>
        )}
      </div>

      {/* Path - editable (LOCAL ONLY: remote ComfyUI manages its own path) */}
      {status?.isLocal !== false && (
      <div className="space-y-1">
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Path</span>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={customPath || status?.path || ''}
            onChange={e => { setCustomPath(e.target.value); setPathError(''); setPathSuccess(false) }}
            placeholder="C:\ComfyUI"
            className="flex-1 px-2 py-1 rounded-lg border text-[0.6rem] font-mono bg-transparent border-white/10 text-gray-300 focus:outline-none focus:border-white/25"
          />
          <button
            onClick={handleSetPath}
            disabled={!customPath.trim() || customPath.trim() === status?.path}
            className="px-2 py-1 rounded text-[0.6rem] bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors disabled:opacity-30"
          >
            Connect
          </button>
        </div>
        {pathError && <p className="text-[0.55rem] text-red-400">{pathError}</p>}
        {pathSuccess && <p className="text-[0.55rem] text-green-400">Path set successfully</p>}
      </div>
      )}

      {/* Port - editable */}
      <div className="space-y-1">
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Port</span>
        <div className="flex gap-1.5">
          <input
            type="number"
            value={customPort || status?.port || 8188}
            onChange={e => { setCustomPort(e.target.value); setPortSuccess(false) }}
            placeholder="8188"
            className="w-24 px-2 py-1 rounded-lg border text-[0.6rem] font-mono bg-transparent border-white/10 text-gray-300 focus:outline-none focus:border-white/25"
          />
          <button
            onClick={async () => {
              const port = parseInt(customPort)
              if (!port || port < 1 || port > 65535) return
              try {
                const { backendCall, setComfyPort } = await import('../../api/backend')
                await backendCall('set_comfyui_port', { port })
                setComfyPort(port)
                setPortSuccess(true)
                setTimeout(() => setPortSuccess(false), 3000)
              } catch {}
            }}
            disabled={!customPort || parseInt(customPort) === (status?.port || 8188)}
            className="px-2 py-1 rounded text-[0.6rem] bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors disabled:opacity-30"
          >
            Set
          </button>
        </div>
        {portSuccess && <p className="text-[0.55rem] text-green-400">Port saved. Restart ComfyUI to apply.</p>}
      </div>

      {/* Controls — local host only (can't manage a remote process) */}
      {status?.isLocal !== false && (
      <div className="flex items-center gap-1.5">
        {status?.found && !status.running && (
          <button onClick={handleStart} className="px-2 py-1 rounded text-[0.6rem] bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-colors">
            Start
          </button>
        )}
        {status?.running && (
          <button onClick={handleStop} className="px-2 py-1 rounded text-[0.6rem] bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors">
            Stop
          </button>
        )}
        {status?.running && (
          <button
            onClick={async () => { await handleStop(); setTimeout(handleStart, 2000) }}
            className="px-2 py-1 rounded text-[0.6rem] bg-white/5 text-gray-400 hover:bg-white/10 transition-colors"
          >
            Restart
          </button>
        )}
        {!status?.found && (
          <button
            onClick={async () => {
              try {
                const { backendCall } = await import('../../api/backend')
                await backendCall('install_comfyui')
              } catch {}
            }}
            className="px-2 py-1 rounded text-[0.6rem] bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors"
          >
            Install ComfyUI
          </button>
        )}
      </div>
      )}
    </div>
  )
}

// ── Claude Code Settings ────────────────────────────────────────

function ClaudeCodeSettings() {
  const installed = useClaudeCodeStore((s) => s.installed)
  const version = useClaudeCodeStore((s) => s.version)
  const { settings, updateSettings } = useSettingsStore()
  const [detecting, setDetecting] = useState(false)

  async function handleDetect() {
    setDetecting(true)
    try {
      const result = await backendCall<{ installed: boolean; version: string; path: string }>('detect_claude_code')
      useClaudeCodeStore.getState().setInstalled(result.installed, result.version, result.path)
    } catch { /* ignore */ }
    setDetecting(false)
  }

  return (
    <div className="space-y-3">
      {/* Status */}
      <div className="flex items-center gap-2 text-[0.65rem]">
        <span className="flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${installed ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-gray-500">{installed ? `Installed (${version || 'unknown'})` : 'Not installed'}</span>
        </span>
        <button onClick={handleDetect} disabled={detecting} className="text-[0.55rem] text-gray-500 hover:text-gray-300 transition-colors">
          {detecting ? 'Detecting...' : 'Re-detect'}
        </button>
      </div>

      {/* Model selector */}
      <div className="space-y-1">
        <label className="text-[0.6rem] text-gray-500">Model</label>
        <select
          value={settings.claudeCodeModel}
          onChange={(e) => updateSettings({ claudeCodeModel: e.target.value })}
          className="w-full text-[0.65rem] px-2 py-1 rounded bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 text-gray-800 dark:text-gray-200"
        >
          <option value="">Auto (default)</option>
          {CLAUDE_CODE_RECOMMENDED_MODELS.map(m => (
            <option key={m.name} value={m.name}>{m.label} — {m.reason}</option>
          ))}
        </select>
      </div>

      {/* Auto-approve toggle */}
      <InlineToggle
        label="Auto-approve all permissions"
        enabled={settings.claudeCodeAutoApprove}
        onChange={() => updateSettings({ claudeCodeAutoApprove: !settings.claudeCodeAutoApprove })}
        icon={<Shield size={10} className="text-amber-400" />}
      />
      {settings.claudeCodeAutoApprove && (
        <p className="text-[0.5rem] text-amber-400/70 ml-4">
          Warning: This allows Claude Code to execute any tool without asking. Use with caution.
        </p>
      )}

      <p className="text-[0.5rem] text-gray-600">
        Requires Ollama 0.14+ for local Anthropic API compatibility.
      </p>
    </div>
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

        <Section title="Appearance">
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

        <Section title="Personas">
          <PersonaPanel />
        </Section>

        <Section title="Memory">
          <MemorySettings />
        </Section>

        <Section title="Providers">
          <ProviderSettings />
        </Section>

        <Section title="Model Storage">
          <HfDownloadPathSetting />
        </Section>

        <Section title="ComfyUI (Image & Video)">
          <ComfyUISettings />
        </Section>

        <Section title="Claude Code">
          <ClaudeCodeSettings />
        </Section>

        {FEATURE_FLAGS.AGENT_MODE && (
          <Section title="Agent Permissions">
            <PermissionSettings />
            <button
              onClick={() => useAgentModeStore.getState().resetTutorial()}
              className="text-[0.6rem] text-gray-500 hover:text-gray-300 transition-colors"
            >
              Reset tutorial
            </button>
          </Section>
        )}

        {FEATURE_FLAGS.AGENT_WORKFLOWS && (
          <Section title="Agent Workflows">
            <WorkflowSection />
          </Section>
        )}

        {FEATURE_FLAGS.AGENT_MODE && (
          <Section title="MCP Servers">
            <MCPServerSettings />
          </Section>
        )}

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

        <Section title="Speech">
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

        <Section title="Remote Access">
          <RemoteAccessSettings />
        </Section>

        <UpdateSection />

        <Section title="Privacy">
          <div className="space-y-2 py-1 text-[0.65rem] text-gray-500 dark:text-gray-400 leading-relaxed">
            <div className="flex items-start gap-2">
              <Lock size={12} className="mt-0.5 shrink-0 text-emerald-500" />
              <div>
                <p className="text-gray-700 dark:text-gray-300 font-medium mb-0.5">100% local by default.</p>
                <p>Chat, agent runs, image &amp; video generation all execute on your machine. No telemetry, no analytics, no model pings home. The only network calls LU makes unless you explicitly opt in are: update checks against GitHub Releases, and cloud provider APIs (OpenAI, Anthropic, etc.) that you configure yourself with your own API keys.</p>
              </div>
            </div>
            <div className="flex items-start gap-2 pt-1.5">
              <Shield size={12} className="mt-0.5 shrink-0 text-emerald-500" />
              <div>
                <p className="text-gray-700 dark:text-gray-300 font-medium mb-0.5">You own your data.</p>
                <p>Conversations, memories, and generated media live in <code className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/5 font-mono text-[0.6rem]">%APPDATA%/Locally Uncensored</code> on Windows (or the equivalent on Linux/macOS). Back up the folder, move it between machines, or delete it — LU writes nothing else.</p>
              </div>
            </div>
          </div>
        </Section>

        <Section title="Onboarding">
          <div className="flex items-center justify-between py-1">
            <div className="flex items-start gap-2">
              <GraduationCap size={12} className="mt-0.5 shrink-0 text-gray-500" />
              <div className="text-[0.65rem] text-gray-600 dark:text-gray-400 leading-relaxed">
                Run the first-launch setup wizard again (hardware scan, recommended models, tool-calling tour).
              </div>
            </div>
            <button
              onClick={async () => {
                useSettingsStore.getState().updateSettings({ onboardingDone: false })
                try { await backendCall('set_onboarding_done', { done: false }) } catch {}
                window.location.reload()
              }}
              className="ml-3 shrink-0 px-2.5 py-1 rounded-md text-[0.6rem] font-medium bg-white dark:bg-white/10 text-gray-800 dark:text-white hover:bg-gray-100 dark:hover:bg-white/15 border border-gray-200 dark:border-white/15 transition-colors"
            >
              Re-run onboarding
            </button>
          </div>
        </Section>

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

// ── Update Section ──────────────────────────────────────────────

function UpdateSection() {
  const { currentVersion, latestVersion, updateAvailable, releaseNotes, dismissed, isChecking, checkForUpdate, clearDismiss, openReleasePage } = useUpdateStore()
  const showUpdate = updateAvailable && latestVersion

  return (
    <Section title="Updates">
      <div className="space-y-3 py-2">
        {/* Current version */}
        <div className="flex items-center justify-between">
          <span className="text-[0.65rem] text-gray-500">Current Version</span>
          <span className="text-[0.65rem] text-gray-300 font-mono">v{currentVersion}</span>
        </div>

        {/* Latest version */}
        {latestVersion && (
          <div className="flex items-center justify-between">
            <span className="text-[0.65rem] text-gray-500">Latest Version</span>
            <span className={`text-[0.65rem] font-mono ${updateAvailable ? 'text-emerald-400' : 'text-gray-300'}`}>
              v{latestVersion}
            </span>
          </div>
        )}

        {/* Status */}
        {showUpdate ? (
          <div className="rounded-lg bg-emerald-500/[0.08] border border-emerald-500/20 p-3">
            <div className="flex items-center gap-2 mb-2">
              <ArrowUpCircle size={14} className="text-emerald-400" />
              <span className="text-[0.65rem] font-medium text-emerald-400">Update available!</span>
            </div>
            {releaseNotes && (
              <p className="text-[0.55rem] text-gray-500 leading-relaxed mb-2.5 line-clamp-4 whitespace-pre-line">{releaseNotes}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={openReleasePage}
                className="px-3 py-1.5 rounded-md text-[0.6rem] font-medium bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
              >
                Download Update
              </button>
              {dismissed === latestVersion && (
                <button
                  onClick={clearDismiss}
                  className="px-3 py-1.5 rounded-md text-[0.6rem] text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] transition-colors"
                >
                  Show Badge Again
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[0.6rem] text-gray-600">
            <Check size={12} className="text-emerald-500" />
            You are on the latest version.
          </div>
        )}

        {/* Manual check */}
        <button
          onClick={() => { useUpdateStore.setState({ lastChecked: null }); checkForUpdate() }}
          disabled={isChecking}
          className="text-[0.6rem] text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-40"
        >
          {isChecking ? 'Checking...' : 'Check for updates'}
        </button>
      </div>
    </Section>
  )
}
