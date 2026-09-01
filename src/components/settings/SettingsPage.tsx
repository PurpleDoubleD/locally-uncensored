import { useState, useEffect, useCallback, useRef, type ReactNode, type ChangeEvent } from 'react'
import { withInstallerOutput, withDetail } from '../../lib/error-text'
import { ArrowLeft, RotateCcw, Sun, Moon, Volume2, Check, X, Loader2, Shield, ChevronRight, GraduationCap, Lock, Sliders, Plug, Bot, Phone, User, Download, Mic } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { SETTINGS_TAB_RESET_KEYS, type SettingsTab } from '../../lib/settings-reset'
import { armedScopeFor, type ResetArm, type ResetArmScope } from '../../lib/reset-arming'
import { useSettingsStore } from '../../stores/settingsStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useUIStore } from '../../stores/uiStore'
import { SliderControl } from './SliderControl'
import { LogFileSettings } from './LogFileSettings'
import { PersonaPanel } from '../personas/PersonaPanel'
import { AccountPanel } from '../auth/AccountPanel'
import { useVoiceStore } from '../../stores/voiceStore'
import { checkWhisperAvailable, checkTtsAvailable, downloadPiperVoice, listInstalledPiperVoices } from '../../api/voice'
import { downloadSuffix } from '../../lib/formatters'

// Curated local neural (Piper) voices the user can pick. Selecting one not yet
// on disk downloads it (~63 MB). Ids match rhasspy/piper-voices.
const PIPER_VOICES: { id: string; label: string }[] = [
  { id: 'en_US-lessac-medium', label: 'Lessac, US, neutral' },
  { id: 'en_US-amy-medium', label: 'Amy, US, female' },
  { id: 'en_US-ryan-high', label: 'Ryan, US, male (high)' },
  { id: 'en_US-hfc_female-medium', label: 'HFC, US, female' },
  { id: 'en_GB-alba-medium', label: 'Alba, UK, female' },
  { id: 'en_GB-northern_english_male-medium', label: 'Northern, UK, male' },
]

// MiniMax Speech-02 system voices for the hosted cloud TTS. The server route
// (/api/voice/tts) forwards the id verbatim as voice_id and only validates the
// character set; default is Wise_Woman.
const CLOUD_TTS_VOICES: { id: string; label: string }[] = [
  { id: 'Wise_Woman', label: 'Wise Woman, default' },
  { id: 'Calm_Woman', label: 'Calm Woman' },
  { id: 'Lively_Girl', label: 'Lively Girl' },
  { id: 'Lovely_Girl', label: 'Lovely Girl' },
  { id: 'Sweet_Girl_2', label: 'Sweet Girl' },
  { id: 'Friendly_Person', label: 'Friendly Person' },
  { id: 'Deep_Voice_Man', label: 'Deep Voice Man' },
  { id: 'Casual_Guy', label: 'Casual Guy' },
  { id: 'Patient_Man', label: 'Patient Man' },
  { id: 'Determined_Man', label: 'Determined Man' },
  { id: 'Elegant_Man', label: 'Elegant Man' },
  { id: 'Young_Knight', label: 'Young Knight' },
]
import { useAgentModeStore } from '../../stores/agentModeStore'
import { FEATURE_FLAGS } from '../../lib/constants'
import { MemorySettings } from './MemorySettings'
import { ChatBackupSettings } from './ChatBackupSettings'
import { RemoteAccessSettings } from './RemoteAccessSettings'
import { RemoteAccessDocs } from './RemoteAccessDocs'
import { HardwareSettings } from './HardwareSettings'
import { ChatbotImporter } from '../import/ChatbotImporter'
import { ProviderSettings } from './ProviderConfig'
import { BuiltinEngineSettings } from './BuiltinEngineSettings'
import { MlxMediaSettings } from './MlxMediaSettings'
import { useProviderStore } from '../../stores/providerStore'
import { PermissionSettings } from './PermissionSettings'
import { MCPServerSettings } from './MCPServerSettings'
import { WorkflowList } from '../agents/WorkflowList'
import { WorkflowBuilder } from '../agents/WorkflowBuilder'
import { useUpdateStore, isNewerVersion } from '../../stores/updateStore'
import { backendCall, isTauri, openExternal } from '../../api/backend'
import { isMlxImageHost } from '../../api/mlx-image'
import { ArrowUpCircle, KeyRound, RefreshCw } from 'lucide-react'
import { CLOUD_BASE } from '../../api/cloud/config'
import { formatBytes } from '../../lib/formatters'

// ── User profile picture (Appearance) ───────────────────────────
// Self-contained like HfDownloadPathSetting. Stores the picture as a
// downscaled base64 data URL (≤256px PNG) in settings so persisted state
// stays small. Shows next to the user's messages in chat / code / agent.
// The AI avatar is always the LU monogram and is NOT user-settable.
function AvatarSetting() {
  const userAvatarDataUrl = useSettingsStore((s) => s.settings.userAvatarDataUrl)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const inputRef = useRef<HTMLInputElement>(null)

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        // Downscale to ≤256px (longest edge) so the persisted data URL is small.
        const MAX = 256
        const scale = Math.min(1, MAX / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(img, 0, 0, w, h)
        updateSettings({ userAvatarDataUrl: canvas.toDataURL('image/png') })
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className="flex items-center justify-between pt-2">
      <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Profile picture</span>
      <div className="flex items-center gap-2">
        {userAvatarDataUrl ? (
          <img src={userAvatarDataUrl} alt="" className="w-7 h-7 rounded-md object-cover border border-gray-200 dark:border-white/10" />
        ) : (
          <div className="w-7 h-7 rounded-md bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 flex items-center justify-center">
            <User size={12} className="text-gray-400" />
          </div>
        )}
        <button
          onClick={() => inputRef.current?.click()}
          className="px-2 py-1 rounded text-[0.65rem] bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white hover:bg-gray-300 dark:hover:bg-white/15 transition-colors"
        >
          {userAvatarDataUrl ? 'Change' : 'Upload'}
        </button>
        {userAvatarDataUrl && (
          <button
            onClick={() => updateSettings({ userAvatarDataUrl: '' })}
            className="px-2 py-1 rounded text-[0.65rem] text-gray-500 hover:text-red-400 transition-colors"
          >
            Remove
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={onPick}
        className="hidden"
      />
    </div>
  )
}

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

// ── Disclosure ──────────────────────────────────────────────────
// Lightweight nested collapsible for use *inside* a Section (e.g. the
// Remote Access "How it works" docs). Unlike Section it uses sentence-case
// and a smaller chevron so it reads as a sub-item, not a top-level heading.

function Disclosure({ label, children, defaultOpen = false }: { label: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="mt-2 pt-2 border-t border-gray-100 dark:border-white/[0.04]">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 group"
      >
        <ChevronRight size={11} className={`text-gray-400 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
        <span className="text-[0.65rem] font-medium text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">
          {label}
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="pt-2">{children}</div>
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
  const [pickError, setPickError] = useState<string | null>(null)
  useEffect(() => { setDraft(override) }, [override])

  async function pickFolder() {
    setPickError(null)
    try {
      const chosen = await backendCall<string | null>('pick_folder')
      if (chosen) { setDraft(chosen); updateSettings({ hfDownloadPathOverride: chosen }) }
    } catch (e) {
      // Level (c): the click was meant to CHANGE the download path and did
      // not. Cancelling the dialog returns null and is not an error, so
      // anything landing here really failed to open the picker.
      setPickError(withDetail('The folder picker did not open. Type or paste the path into the field instead.', e))
    }
  }

  return (
    <div className="space-y-2 py-1">
      <div className="text-[0.6rem] text-gray-500 leading-relaxed">
        Custom location for downloaded GGUFs. Leave empty to auto-detect from your active provider's models folder (e.g. <code className="font-mono">~/.lmstudio/models</code> for LM Studio). Ollama is unaffected, it manages its own blob store; LU pulls Ollama models via <code className="font-mono">ollama pull</code> regardless of this setting.
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
      {pickError && (
        <p role="alert" className="text-[0.55rem] text-red-500 dark:text-red-400 leading-snug whitespace-pre-line">
          {pickError}
        </p>
      )}
    </div>
  )
}

// ── Import models from Ollama / LM Studio ──────────────────────
// Discord feedback 2026-08-16: users with existing local models should not
// download them a second time. The backend hard links the GGUF into the app
// models dir, zero copy; Ollama and LM Studio keep working untouched.

function ImportLocalModels() {
  const [candidates, setCandidates] = useState<import('../../api/engine').ImportCandidate[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function scan() {
    setScanning(true)
    setErrors({})
    try {
      const { listImportableModels } = await import('../../api/engine')
      setCandidates(await listImportableModels())
    } catch (e) {
      setCandidates([])
      setErrors({ scan: String(e) })
    } finally {
      setScanning(false)
    }
  }

  async function doImport(c: import('../../api/engine').ImportCandidate) {
    setBusyPath(c.path)
    setErrors((prev) => { const next = { ...prev }; delete next[c.path]; return next })
    try {
      const { importLocalModel, listBundledModels } = await import('../../api/engine')
      await importLocalModel(c.path, c.name)
      await listBundledModels()
      setCandidates((prev) => prev?.map((x) => x.path === c.path ? { ...x, already_imported: true } : x) ?? prev)
    } catch (e) {
      setErrors((prev) => ({ ...prev, [c.path]: String(e) }))
    } finally {
      setBusyPath(null)
    }
  }

  return (
    <div className="space-y-2 py-1 border-t border-white/5 mt-2 pt-2">
      <div className="text-[0.6rem] text-gray-500 leading-relaxed">
        Already have models in Ollama or LM Studio? Link them into LU without downloading or copying anything. The file stays where it is; both apps keep working.
      </div>
      <button
        onClick={scan}
        disabled={scanning}
        className="px-2.5 py-1 rounded-md text-[0.6rem] font-medium bg-white dark:bg-white/10 text-gray-800 dark:text-white hover:bg-gray-100 dark:hover:bg-white/15 border border-gray-200 dark:border-white/15 transition-colors disabled:opacity-50"
      >
        {scanning ? 'Scanning…' : 'Scan for local models'}
      </button>
      {errors.scan && <div className="text-[0.6rem] text-red-400">{errors.scan}</div>}
      {candidates !== null && !errors.scan && (
        candidates.length === 0 ? (
          <div className="text-[0.6rem] text-gray-500">No importable models found. Looked in the Ollama store and the LM Studio models folder.</div>
        ) : (
          <div className="space-y-1">
            {candidates.map((c) => (
              <div key={c.path}>
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[0.65rem] text-gray-700 dark:text-gray-300 font-mono truncate" title={c.path}>{c.name}</span>
                  <span className="text-[0.55rem] text-gray-500 uppercase">{c.source}</span>
                  <span className="text-[0.55rem] text-gray-500">{formatBytes(c.size)}</span>
                  {c.already_imported ? (
                    <span className="text-[0.6rem] text-green-500">Imported</span>
                  ) : (
                    <button
                      onClick={() => doImport(c)}
                      disabled={busyPath === c.path}
                      className="px-2 py-0.5 rounded-md text-[0.6rem] font-medium bg-white dark:bg-white/10 text-gray-800 dark:text-white hover:bg-gray-100 dark:hover:bg-white/15 border border-gray-200 dark:border-white/15 transition-colors disabled:opacity-50"
                    >
                      {busyPath === c.path ? 'Linking…' : 'Import'}
                    </button>
                  )}
                </div>
                {errors[c.path] && <div className="text-[0.6rem] text-red-400 leading-snug">{errors[c.path]}</div>}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}

// ── ComfyUI Settings ────────────────────────────────────────────

function ComfyUISettings() {
  const [status, setStatus] = useState<{ running: boolean; found: boolean; complete?: boolean; path?: string; port?: number; host?: string; isLocal?: boolean; starting?: boolean; stalled?: boolean } | null>(null)
  // Why the last start attempt did not stick. The button used to swallow this
  // whole (E16): on a box with no ComfyUI python environment, Start answered
  // "started", the panel went back to `Stopped`, and six minutes later there
  // was still no reason anywhere on screen while the traceback sat in our own
  // ring buffer. An error is not allowed to be silence.
  const [startError, setStartError] = useState('')
  const [loading, setLoading] = useState(true)
  const [customPath, setCustomPath] = useState('')
  const [pathError, setPathError] = useState('')
  const [pathSuccess, setPathSuccess] = useState(false)
  const [customPort, setCustomPort] = useState('')
  const [portSuccess, setPortSuccess] = useState(false)
  const [portError, setPortError] = useState('')
  const [customHost, setCustomHost] = useState('')
  const [hostError, setHostError] = useState('')
  const [hostSuccess, setHostSuccess] = useState(false)
  // P14 Python install state for the Settings Install-ComfyUI flow.
  const [installPhase, setInstallPhase] = useState<'idle' | 'python' | 'comfyui' | 'repair' | 'error'>('idle')
  const [installLogs, setInstallLogs] = useState<string[]>([])
  const [installErr, setInstallErr] = useState('')
  // #162: size, rate and remaining time in the bracket next to the spinner.
  const [installDl, setInstallDl] = useState({ progress: 0, total: 0, speed: 0 })

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const { backendCall, setComfyPort, setComfyHost } = await import('../../api/backend')
        const s: any = await backendCall('comfyui_status')
        if (!cancelled) {
          setStatus(s)
          // Mirror backend truth into the frontend URL builder so subsequent
          // fetch() calls hit the right machine immediately, no restart needed.
          if (typeof s?.port === 'number' && s.port > 0) setComfyPort(s.port)
          if (typeof s?.host === 'string' && s.host.trim()) setComfyHost(s.host)
        }
      } catch {
        // Level (a): silent on purpose. This is the 5 s status poll below, and
        // a failed probe simply means the panel keeps showing the last known
        // state until the next tick. Every USER action in this panel (start,
        // stop, install, set port) reports its own failure; a poll that missed
        // one beat is not something to interrupt anyone about.
      }
      if (!cancelled) setLoading(false)
    }
    check()
    const interval = setInterval(check, 5000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  const handleStart = async () => {
    setStartError('')
    try {
      const { backendCall } = await import('../../api/backend')
      await backendCall('start_comfyui')
      setStatus(prev => prev ? { ...prev, starting: true } : null)
      // GH #98 (joelnewswanger): a crash AFTER the 2s spawn watch used to flip
      // the panel silently back to Stopped, which read as "the start button
      // does nothing". Look once, a few seconds in, and say what happened.
      setTimeout(async () => {
        try {
          const out: any = await backendCall('comfyui_last_output')
          if (out?.exited && Array.isArray(out?.lines) && out.lines.length > 1) {
            const { comfyStartupError } = await import('../create/experimental/comfyError')
            setStartError(
              comfyStartupError(out.lines) +
              (out.envBroken ? '\n\nThe Python environment looks broken. Repair environment below rebuilds it in place; models, outputs and custom nodes are left alone.' : ''),
            )
          }
        } catch { /* status polling keeps the panel honest */ }
      }, 6000)
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err))
    }
  }

  // GH #98: rebuild the ComfyUI venv (fresh isolated env, ~2 GB) through the
  // same status contract the installer uses, so the progress card just works.
  const handleRepair = async () => {
    setStartError('')
    setInstallPhase('repair')
    setInstallLogs(['Repairing the ComfyUI environment…'])
    setInstallDl({ progress: 0, total: 0, speed: 0 })
    try {
      const { backendCall } = await import('../../api/backend')
      await backendCall('repair_comfyui_env')
      const poll = setInterval(async () => {
        try {
          const data: any = await backendCall('install_comfyui_status')
          setInstallLogs(data.logs || [])
          setInstallDl({ progress: data.download_progress || 0, total: data.download_total || 0, speed: data.download_speed || 0 })
          if (data.status === 'complete') {
            clearInterval(poll)
            setInstallPhase('idle')
          } else if (data.status === 'error' || data.status === 'cancelled') {
            clearInterval(poll)
            const lastLog = (data.logs?.length ? data.logs[data.logs.length - 1] : '') as string
            setInstallErr(withInstallerOutput('Repairing the environment did not finish.', lastLog))
            setInstallPhase('error')
          }
        } catch { /* keep polling */ }
      }, 2000)
    } catch (err) {
      setInstallPhase('error')
      setInstallErr(err instanceof Error ? err.message : 'Failed to start the repair')
    }
  }

  const handleStop = async () => {
    setStartError('')
    try {
      const { backendCall } = await import('../../api/backend')
      await backendCall('stop_comfyui')
      setStatus(prev => prev ? { ...prev, running: false } : null)
    } catch (e) {
      // Level (c): a stop that failed leaves the panel showing "running", which
      // is the truth — but without this line the button reads as a dud. Same
      // channel as the start failure, right under the same pair of buttons.
      setStartError(withDetail('ComfyUI did not stop. It may still be running — try again, or close it in its own window.', e))
    }
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
      setPathError(err instanceof Error ? err.message : 'Invalid path, main.py not found')
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
            {status?.running ? 'Running'
              : status?.stalled ? 'Not responding'
              : status?.starting ? 'Starting'
              : status?.found ? 'Stopped' : 'Not Installed'}
          </span>
        </div>
      </div>

      {startError && (
        <pre role="alert" className="whitespace-pre-wrap break-words text-[0.55rem] leading-relaxed text-red-400 bg-red-500/[0.06] border border-red-500/20 rounded p-2 max-h-40 overflow-y-auto">
          {startError}
        </pre>
      )}
      {status?.stalled && !startError && (
        <p className="text-[0.55rem] text-amber-400">
          ComfyUI has been starting for a while without answering on its port. Use Show output below to see what it printed.
        </p>
      )}

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
          <p className="text-[0.55rem] text-amber-400">Remote ComfyUI, start/stop/install not available from LU. Manage the process on the server.</p>
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
              setPortError('')
              try {
                const { backendCall, setComfyPort } = await import('../../api/backend')
                await backendCall('set_comfyui_port', { port })
                setComfyPort(port)
                setPortSuccess(true)
                setTimeout(() => setPortSuccess(false), 3000)
              } catch (e) {
                // Level (c): the port was NOT saved. Without this the button
                // just fails to produce the green "Port saved" line, which is
                // indistinguishable from a slow save.
                setPortError(withDetail('The port was not saved. Pick a free port and try again.', e))
              }
            }}
            disabled={!customPort || parseInt(customPort) === (status?.port || 8188)}
            className="px-2 py-1 rounded text-[0.6rem] bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors disabled:opacity-30"
          >
            Set
          </button>
        </div>
        {portSuccess && <p className="text-[0.55rem] text-green-400">Port saved. Restart ComfyUI to apply.</p>}
        {portError && (
          <p role="alert" className="text-[0.55rem] text-red-500 dark:text-red-400 leading-snug whitespace-pre-line">
            {portError}
          </p>
        )}
      </div>

      {/* Controls, local host only (can't manage a remote process) */}
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
        {/* GH #98: a from-source install whose Python env broke (shared system
            Python, dead torch) needs a rebuild, not a re-install — pip reports
            broken packages as already satisfied. Rebuilds ComfyUI/venv. */}
        {status?.found && !status?.running && installPhase === 'idle' && (
          <button onClick={handleRepair} title="Rebuild the Python environment in an isolated venv (~2 GB). Models, outputs and custom nodes are left alone." className="px-2 py-1 rounded text-[0.6rem] bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors">
            Repair environment
          </button>
        )}
        {(!status?.found || status?.complete === false) && installPhase === 'idle' && (
          <button
            onClick={async () => {
              const { backendCall } = await import('../../api/backend')
              setInstallErr('')
              setInstallLogs([])

              // P14 pre-flight: ensure Python is on the box before
              // pip-installing ComfyUI. The carcass case (status.complete
              // === false) lands here too — Python may still be missing
              // and the previous run died on the Microsoft Store stub.
              let pythonOk = false
              try {
                const probe: any = await backendCall('python_check')
                pythonOk = !!probe?.available
              } catch { pythonOk = false }

              if (!pythonOk) {
                setInstallPhase('python')
                setInstallLogs(['Installing Python 3.12 via winget…'])
                try {
                  await backendCall('install_python')
                } catch (err) {
                  setInstallPhase('error')
                  setInstallErr(err instanceof Error ? err.message : 'Could not start Python install')
                  return
                }
                pythonOk = await new Promise<boolean>((resolve) => {
                  const poll = setInterval(async () => {
                    try {
                      const data: any = await backendCall('install_python_status')
                      setInstallLogs(data.logs || [])
                      if (data.status === 'complete' || data.status === 'already_installed') {
                        clearInterval(poll); resolve(true)
                      } else if (data.status === 'error') {
                        clearInterval(poll)
                        const lastLog = (data.logs?.length ? data.logs[data.logs.length - 1] : '') as string
                        setInstallErr(withInstallerOutput('Installing Python did not finish.', lastLog))
                        resolve(false)
                      }
                    } catch { /* keep polling */ }
                  }, 2000)
                })
                if (!pythonOk) { setInstallPhase('error'); return }
              }

              setInstallPhase('comfyui')
              setInstallLogs(['Installing ComfyUI…'])
              try {
                // andy_38747 (Discord): let the Path field double as the install
                // target so the multi-GB install can land on another drive.
                // Empty field → backend default (~/ComfyUI). On a carcass
                // re-install with no override, reuse the detected path so the
                // repair happens where the broken install lives.
                const installTarget = customPath.trim() || status?.path || ''
                await backendCall('install_comfyui', installTarget ? { installPath: installTarget } : {})
                const poll = setInterval(async () => {
                  try {
                    const data: any = await backendCall('install_comfyui_status')
                    setInstallLogs(data.logs || [])
                    setInstallDl({ progress: data.download_progress || 0, total: data.download_total || 0, speed: data.download_speed || 0 })
                    if (data.status === 'complete') {
                      clearInterval(poll)
                      setInstallPhase('idle')
                    } else if (data.status === 'error') {
                      clearInterval(poll)
                      const lastLog = (data.logs?.length ? data.logs[data.logs.length - 1] : '') as string
                      setInstallErr(withInstallerOutput('Installing ComfyUI did not finish.', lastLog))
                      setInstallPhase('error')
                    }
                  } catch { /* keep polling */ }
                }, 2000)
              } catch (err) {
                setInstallPhase('error')
                setInstallErr(err instanceof Error ? err.message : 'Failed to start')
              }
            }}
            className="px-2 py-1 rounded text-[0.6rem] bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors"
          >
            {status?.complete === false ? 'Re-install ComfyUI' : 'Install ComfyUI'}
          </button>
        )}
        {status?.found && status?.complete !== false && installPhase === 'idle' && (
          // 2.5.8: the specialized local lanes (music / talking character /
          // motion) need node families that ship with current cores — this is
          // the one-click git pull + dependency refresh the lane errors point
          // to. Reuses the installer's status channel and log panel.
          <button
            onClick={async () => {
              setInstallPhase('comfyui')
              setInstallErr('')
              setInstallLogs(['Updating ComfyUI…'])
              try {
                await backendCall('update_comfyui')
                const poll = setInterval(async () => {
                  try {
                    const data: any = await backendCall('install_comfyui_status')
                    setInstallLogs(data.logs || [])
                    setInstallDl({ progress: data.download_progress || 0, total: data.download_total || 0, speed: data.download_speed || 0 })
                    if (data.status === 'complete') {
                      clearInterval(poll)
                      setInstallPhase('idle')
                    } else if (data.status === 'error') {
                      clearInterval(poll)
                      const lastLog = (data.logs?.length ? data.logs[data.logs.length - 1] : '') as string
                      setInstallErr(withInstallerOutput('Updating ComfyUI did not finish.', lastLog))
                      setInstallPhase('error')
                    }
                  } catch { /* keep polling */ }
                }, 2000)
              } catch (err) {
                setInstallPhase('error')
                setInstallErr(err instanceof Error ? err.message : 'Failed to start the update')
              }
            }}
            className="px-2 py-1 rounded text-[0.6rem] bg-white/5 text-gray-400 hover:text-gray-200 hover:bg-white/10 transition-colors"
          >
            Update ComfyUI
          </button>
        )}
        {(!status?.found || status?.complete === false) && installPhase === 'idle' && (
          <p className="w-full text-[0.55rem] text-gray-600">
            Installs to your home folder by default. Set Path above (e.g. D:\ComfyUI) to install on another drive.
          </p>
        )}
        {installPhase !== 'idle' && (
          <div className="w-full mt-2 space-y-1">
            <div className="flex items-center gap-1.5 text-[0.6rem] text-gray-400">
              {installPhase !== 'error' && <Loader2 size={10} className="animate-spin" />}
              <span>
                {installPhase === 'python' && 'Installing Python 3.12 (~30 MB)…'}
                {installPhase === 'comfyui' && `Installing ComfyUI…${downloadSuffix(installDl)}`}
                {installPhase === 'repair' && `Rebuilding the ComfyUI environment…${downloadSuffix(installDl)}`}
                {installPhase === 'error' && 'Install failed'}
              </span>
            </div>
            {installLogs.length > 0 && (
              <div className="bg-black/50 rounded p-1.5 max-h-24 overflow-y-auto font-mono text-[0.5rem] text-gray-500 space-y-0.5">
                {installLogs.slice(-6).map((log, i) => <div key={i} className="truncate">{log}</div>)}
              </div>
            )}
            {installErr && <p className="text-[0.55rem] text-red-400 whitespace-pre-line">{installErr}</p>}
          </div>
        )}
      </div>
      )}
    </div>
  )
}

// ── Coding Agent (v2.5.0) Settings ──────────────────────────────

function CodexAgentSettings() {
  const { settings, updateSettings } = useSettingsStore()
  return (
    <div className="space-y-3">
      <div className="text-[0.6rem] text-gray-500 leading-relaxed pb-1">
        v2.5.0 coding-agent capabilities ported from the companion repo. All
        local-first by default. Cloud usage requires the explicit toggle below.
      </div>

      {/* Architect / Editor split */}
      <InlineToggle
        label="Architect / Editor split"
        enabled={settings.codexArchitectMode}
        onChange={() => updateSettings({ codexArchitectMode: !settings.codexArchitectMode })}
      />
      <div className="space-y-1 pl-1">
        <label className="text-[0.6rem] text-gray-500 block">Architect model</label>
        <input
          type="text"
          value={settings.codexArchitectModel}
          onChange={(e) => updateSettings({ codexArchitectModel: e.target.value })}
          disabled={!settings.codexArchitectMode}
          placeholder="ollama::qwen-coder:32b"
          className="w-full px-2 py-1 rounded bg-transparent border border-white/8 text-[0.65rem] text-gray-700 dark:text-gray-300 font-mono focus:outline-none focus:border-white/20 disabled:opacity-40"
        />
        <p className="text-[0.55rem] text-gray-500">Empty = use the active coding agent model.</p>
      </div>
      <InlineToggle
        label="Allow cloud architect models"
        enabled={settings.codexArchitectAllowCloud}
        onChange={() => updateSettings({ codexArchitectAllowCloud: !settings.codexArchitectAllowCloud })}
        icon={<Shield size={10} className={settings.codexArchitectAllowCloud ? 'text-amber-400' : 'text-emerald-500'} />}
      />
      <p className="text-[0.55rem] text-gray-500 leading-relaxed pl-1">
        Off keeps the architect step fully local. On allows third-party
        endpoints (Anthropic, OpenAI, OpenRouter).
      </p>

      {/* Repo-Map */}
      <div className="pt-1.5 border-t border-white/[0.04]" />
      <InlineToggle
        label="Repo-Map injection"
        enabled={settings.codexRepoMapEnabled}
        onChange={() => updateSettings({ codexRepoMapEnabled: !settings.codexRepoMapEnabled })}
      />
      <div className={settings.codexRepoMapEnabled ? '' : 'opacity-40 pointer-events-none'}>
        <SliderControl
          label="Repo-Map top-N files"
          value={settings.codexRepoMapLimit}
          min={1}
          max={200}
          step={1}
          onChange={(v) => updateSettings({ codexRepoMapLimit: v })}
        />
      </div>

      {/* /loop — unlimited by default. The stop button and the loop bar above
          the composer are the brake; a number here is only for people who want
          a hard stop after N passes. */}
      <div className="pt-1.5 border-t border-white/[0.04]" />
      <div className="flex items-center justify-between gap-3 py-1">
        <div className="min-w-0">
          <div className="text-[0.7rem] text-gray-700 dark:text-gray-300">Maximum /loop passes</div>
          <div className="text-[0.6rem] text-gray-500">
            0 means unlimited: the loop keeps checking until it reports done or you stop it.
          </div>
        </div>
        <input
          type="number"
          min={0}
          value={settings.loopMaxPasses}
          onChange={(e) => updateSettings({ loopMaxPasses: Math.max(0, parseInt(e.target.value, 10) || 0) })}
          className="w-16 shrink-0 px-1.5 py-0.5 rounded border border-gray-200 dark:border-white/10 bg-transparent text-[0.7rem] text-right text-gray-800 dark:text-gray-200"
        />
      </div>

      {/* Stage + Review */}
      <div className="pt-1.5 border-t border-white/[0.04]" />
      <InlineToggle
        label="Stage file_write changes (review before apply)"
        enabled={settings.codexStageMode}
        onChange={() => updateSettings({ codexStageMode: !settings.codexStageMode })}
      />
      {settings.codexStageMode && (
        <InlineToggle
          label="Auto-apply staged changes when the run finishes (no per-file clicking)"
          enabled={settings.codexAutoApply}
          onChange={() => updateSettings({ codexAutoApply: !settings.codexAutoApply })}
        />
      )}
      <InlineToggle
        label="Code-Review mode (read-only)"
        enabled={settings.codexReviewMode}
        onChange={() => updateSettings({ codexReviewMode: !settings.codexReviewMode })}
      />
      <InlineToggle
        label="Confirm shell & code commands (prevents prompt-injection from auto-running commands)"
        enabled={settings.codexConfirmShell}
        onChange={() => updateSettings({ codexConfirmShell: !settings.codexConfirmShell })}
      />
      {/* Cloud arm of the same gate, an opt-in since David's decision of
          2026-08-22: off by default, a cloud model runs like a local one, and
          Bypass really bypasses. Always shown, because it governs Agent mode
          too, which ignores the Codex-only toggle above. */}
      <InlineToggle
        label="Also confirm shell & code when Agent or Coding runs on an LU Cloud model (off by default, and it asks in Bypass too)"
        enabled={settings.codexCloudConfirmOptIn}
        onChange={() => updateSettings({ codexCloudConfirmOptIn: !settings.codexCloudConfirmOptIn })}
      />
    </div>
  )
}

// ── Main Component ──────────────────────────────────────────────

// P5 settings refactor: Top-level tabs replace the previous flat scroll of
// 17 collapsibles. Each tab groups conceptually related Sections so users
// don't have to scan the whole list to find one toggle. Mapping (kept in
// sync with LU-Aufgaben.md / IMPLEMENTATION_NOTES.md):
//
//   General      → Appearance · Generation · Privacy · Onboarding · Updates
//   AI Backends  → Providers · Model Storage · ComfyUI
//   Agent        → Personas · Memory · Agent Permissions ·
//                  Agent Workflows · MCP Servers · Search Provider
//   Voice & Remote → Speech · Remote Access
//
// Tab choice is persisted in localStorage so the user's last-used view
// survives reloads.
const SETTINGS_TAB_KEY = 'lu-settings-tab'
const SETTINGS_TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: 'general',      label: 'General',      icon: <Sliders size={11} /> },
  { id: 'backends',     label: 'AI Backends',  icon: <Plug size={11} /> },
  { id: 'agent',        label: 'Agent',        icon: <Bot size={11} /> },
  { id: 'voice-remote', label: 'Voice & Remote', icon: <Phone size={11} /> },
]

// GitHub #59 — the old single "Reset to Defaults" button fired silently with
// no confirm and no feedback, so users reported it as "does nothing". Now:
// arm-then-confirm (second click within 4s), per-tab scope, and an explicit
// success line after the reset.
//
// Nebenbefund 2 of the R9 re-measure (2026-08-30) read the first click as a
// dud. Checked and kept as it is: the armed button relabels to "Click again to
// reset <tab>", turns red and goes medium weight, and the first click writes
// nothing at all. That is the same arm-then-confirm the Cloud switch got in
// round 6, and the same reasoning holds here: two clicks on one control is the
// cheapest confirmation there is, no dialog and no mouse travel. The three
// visible signals are pinned by
// src/lib/__tests__/reset-arming-is-visible.test.ts.
function ResetSection({ tab }: { tab: SettingsTab }) {
  const resetSettingsKeys = useSettingsStore((s) => s.resetSettingsKeys)
  const resetSettings = useSettingsStore((s) => s.resetSettings)
  const resetVoiceDefaults = useVoiceStore((s) => s.resetVoiceDefaults)
  const resetPermissions = usePermissionStore((s) => s.resetToDefaults)
  // The arm records the tab it was made on, so "still armed?" is a question
  // that can be answered while rendering. Switching tabs while armed must
  // disarm — otherwise a click armed on General would confirm-fire on Agent —
  // and armedScopeFor() is that rule (src/lib/reset-arming.ts). It replaces a
  // `useEffect(..., [tab])` that disarmed one render too late.
  const [arm, setArm] = useState<ResetArm<SettingsTab>>(null)
  const armed = armedScopeFor(arm, tab)
  const setArmed = (which: ResetArmScope | null) =>
    setArm(which === null ? null : { scope: which, tab })
  const [done, setDone] = useState<string | null>(null)
  const armTimer = useRef<number | null>(null)
  const doneTimer = useRef<number | null>(null)

  const tabLabel = SETTINGS_TABS.find((t) => t.id === tab)?.label ?? 'section'

  useEffect(() => () => {
    if (armTimer.current) window.clearTimeout(armTimer.current)
    if (doneTimer.current) window.clearTimeout(doneTimer.current)
  }, [])

  const handleClick = (which: 'section' | 'all') => {
    if (armed !== which) {
      setArmed(which)
      if (armTimer.current) window.clearTimeout(armTimer.current)
      armTimer.current = window.setTimeout(() => setArmed(null), 4000)
      return
    }
    if (armTimer.current) window.clearTimeout(armTimer.current)
    setArmed(null)
    if (which === 'all') {
      resetSettings()
      resetVoiceDefaults()
      resetPermissions()
      setDone('All settings restored to defaults')
    } else {
      resetSettingsKeys(SETTINGS_TAB_RESET_KEYS[tab])
      if (tab === 'agent') resetPermissions()
      if (tab === 'voice-remote') resetVoiceDefaults()
      // G20: "Reset AI Backends" only reset settings KEYS and never touched
      // the provider store, so it could not hand the openai slot back to the
      // Built-in Engine once LM Studio had adopted it. Now it restores the
      // shipped slots too (API keys and the cloud account flag are kept).
      if (tab === 'backends') useProviderStore.getState().resetProvidersToDefaults()
      setDone(`${tabLabel} settings restored to defaults`)
    }
    if (doneTimer.current) window.clearTimeout(doneTimer.current)
    doneTimer.current = window.setTimeout(() => setDone(null), 3000)
  }

  return (
    <div className="pt-3 pb-6 space-y-1.5">
      <div className="flex items-center gap-3">
        <button
          onClick={() => handleClick('section')}
          className={`flex items-center gap-1.5 text-[0.65rem] transition-colors ${
            armed === 'section' ? 'text-red-400 font-medium' : 'text-gray-500 hover:text-red-400'
          }`}
        >
          <RotateCcw size={11} />
          {armed === 'section' ? `Click again to reset ${tabLabel}` : `Reset ${tabLabel} to defaults`}
        </button>
        <button
          onClick={() => handleClick('all')}
          className={`flex items-center gap-1.5 text-[0.6rem] transition-colors ${
            armed === 'all' ? 'text-red-400 font-medium' : 'text-gray-600 dark:text-gray-600 hover:text-red-400'
          }`}
        >
          {armed === 'all' ? 'Click again to reset everything' : 'Reset all settings'}
        </button>
      </div>
      {done && (
        <div className="flex items-center gap-1.5 text-[0.6rem] text-emerald-500">
          <Check size={11} /> {done}
        </div>
      )}
      <div className="text-[0.55rem] text-gray-500 dark:text-gray-600 leading-snug">
        Personas, memories, conversations, workflows and MCP servers are kept.
      </div>
    </div>
  )
}

export function SettingsPage() {
  const { settings, updateSettings } = useSettingsStore()
  // ENG-2 — the expert panel only exists when the openai slot IS the
  // app-managed built-in engine (same gate as the send-path self-heal).
  const builtinManaged = useProviderStore((s) => !!s.providers.openai?.enabled && s.providers.openai?.managed === true)
  const { setView } = useUIStore()
  const voiceSettings = useVoiceStore()
  const [whisperStatus, setWhisperStatus] = useState<{ available: boolean; backend: string | null; error?: string } | null>(null)
  const [whisperLoading, setWhisperLoading] = useState(true)
  // §24.9 — in-app faster-whisper install. `installing` drives the spinner;
  // `whisperInstallError` shows the last failure under the badge.
  const [whisperInstalling, setWhisperInstalling] = useState(false)
  const [whisperInstallError, setWhisperInstallError] = useState<string | null>(null)
  // Neural TTS (Piper) install state — mirrors the whisper installer.
  const [ttsStatus, setTtsStatus] = useState<{ available: boolean } | null>(null)
  const [ttsLoading, setTtsLoading] = useState(true)
  const [ttsInstalling, setTtsInstalling] = useState(false)
  const [ttsInstallError, setTtsInstallError] = useState<string | null>(null)
  // Piper voice picker state.
  const [installedVoices, setInstalledVoices] = useState<string[]>([])
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  // Where the navigation that opened this page wanted to land. Read ONCE, at
  // mount, and held for this mount's whole life: `defaultOpen` below is an
  // initial value, so a focus that vanished from the store on the next render
  // would fold the section straight back up (Nebenbefund 3, R8 re-measure).
  const [entryFocus] = useState(() => useUIStore.getState().settingsFocus)
  useEffect(() => { useUIStore.getState().clearSettingsFocus() }, [])
  const [tab, setTab] = useState<SettingsTab>(() => {
    if (entryFocus) return entryFocus.tab
    if (typeof window === 'undefined') return 'general'
    const stored = window.localStorage.getItem(SETTINGS_TAB_KEY)
    return (stored === 'general' || stored === 'backends' || stored === 'agent' || stored === 'voice-remote')
      ? stored
      : 'general'
  })
  useEffect(() => {
    if (typeof window !== 'undefined') {
      // Level (a): silent on purpose. This only remembers which tab was open
      // for the next visit. If storage is full or blocked (private window),
      // Settings opens on General next time — a convenience lost, not an
      // action failed, and nothing the user could act on.
      try { window.localStorage.setItem(SETTINGS_TAB_KEY, tab) } catch { /* see above */ }
    }
  }, [tab])


  // The three probes are stabilised with useCallback ON PURPOSE, not for
  // speed: the mount effect below has to list them as dependencies, and a
  // function rebuilt on every render would re-run the effect on every render.
  // `voiceSettings` is `useVoiceStore()` — the WHOLE store, so it changes on
  // every store write, including the writes these probes make themselves.
  // Reaching for the actions through selectors instead keeps the closures
  // pinned to values that never change: zustand defines its actions once in
  // create(), so setSttAvailable/setTtsAvailable are the same references for
  // the life of the store.
  const setSttAvailable = useVoiceStore((s) => s.setSttAvailable)
  const setTtsAvailable = useVoiceStore((s) => s.setTtsAvailable)

  const refreshWhisper = useCallback(() => {
    setWhisperLoading(true)
    return checkWhisperAvailable()
      .then((s) => {
        setWhisperStatus(s)
        // Drive the mic button's availability from the same probe so it lights
        // up immediately after the in-app install — no restart needed.
        setSttAvailable(!!s.available)
      })
      .finally(() => setWhisperLoading(false))
  }, [setSttAvailable])

  const refreshTts = useCallback(() => {
    setTtsLoading(true)
    // Read the voice at call time rather than closing over it. It is what
    // every caller already means — handlePickVoice sets the new voice and
    // then asks "is TTS available now?", which is a question about the NEW
    // voice — and it keeps this callback free of a dependency that changes.
    return checkTtsAvailable(useVoiceStore.getState().piperVoice)
      .then((s) => {
        setTtsStatus(s)
        // Same as STT: drive the read-aloud button availability from this probe
        // so it lights up right after the in-app install.
        setTtsAvailable(!!s.available)
      })
      .finally(() => setTtsLoading(false))
  }, [setTtsAvailable])

  const refreshVoices = useCallback(
    () =>
      listInstalledPiperVoices()
        .then(setInstalledVoices)
        // Level (a): silent on purpose. This only fills the voice DROPDOWN. If
        // the list cannot be read the dropdown stays on its last contents and
        // every real action here — picking a voice, downloading one — reports
        // its own failure through setVoiceError below. A second message for
        // "the list did not refresh" would be noise on a screen that already
        // says what went wrong.
        .catch(() => {}),
    [],
  )

  useEffect(() => {
    void refreshWhisper()
    void refreshTts()
    void refreshVoices()
  }, [refreshWhisper, refreshTts, refreshVoices])

  // §24.9 — kick off the faster-whisper install, poll its status, then
  // re-check availability so the badge flips ✗ → ✓ without a restart.
  const handleInstallWhisper = async () => {
    if (whisperInstalling) return
    setWhisperInstallError(null)
    setWhisperInstalling(true)
    try {
      await backendCall('install_whisper')
      // Poll install status until it leaves "installing" (cap ~10 min — a
      // model download on a slow link can be lengthy; pip itself is quick).
      const start = Date.now()
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise((r) => setTimeout(r, 2000))
        let s: { status?: string; error?: string } = {}
        try {
          s = await backendCall<{ status?: string; error?: string }>('install_whisper_status')
        } catch { /* transient — keep polling */ }
        if (s.status === 'complete') break
        if (s.status === 'error') {
          setWhisperInstallError(withInstallerOutput('Installing speech to text did not finish.', s.error))
          break
        }
        if (Date.now() - start > 600_000) {
          setWhisperInstallError('Install is taking unusually long, check the logs / try again.')
          break
        }
      }
    } catch (e) {
      setWhisperInstallError(e instanceof Error ? e.message : String(e))
    } finally {
      setWhisperInstalling(false)
      await refreshWhisper()
    }
  }

  // Install Piper neural TTS (pip + voice download) the same end-user way as
  // whisper, polling install_tts_status until done, then re-checking the badge.
  const handleInstallTts = async () => {
    if (ttsInstalling) return
    setTtsInstallError(null)
    setTtsInstalling(true)
    try {
      await backendCall('install_tts')
      const start = Date.now()
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise((r) => setTimeout(r, 2000))
        let s: { status?: string; error?: string } = {}
        try {
          s = await backendCall<{ status?: string; error?: string }>('install_tts_status')
        } catch { /* transient — keep polling */ }
        if (s.status === 'complete') break
        if (s.status === 'error') {
          setTtsInstallError(withInstallerOutput('Installing read aloud did not finish.', s.error))
          break
        }
        if (Date.now() - start > 600_000) {
          setTtsInstallError('Install is taking unusually long, check the logs / try again.')
          break
        }
      }
    } catch (e) {
      setTtsInstallError(e instanceof Error ? e.message : String(e))
    } finally {
      setTtsInstalling(false)
      await refreshTts()
    }
  }

  // Pick a Piper voice. If it isn't on disk yet, download it (~63 MB), then
  // re-check the installed list + TTS availability. The selection is applied
  // optimistically (so the dropdown reflects the pick) but REVERTED if the
  // download fails — otherwise piperVoice pointed at a missing model and every
  // read fell back to the Windows SAPI voice (#77, ElBiggus).
  const handlePickVoice = async (id: string) => {
    setVoiceError(null)
    const prev = voiceSettings.piperVoice
    voiceSettings.setPiperVoice(id)
    if (installedVoices.includes(id)) return
    setVoiceBusy(true)
    try {
      await downloadPiperVoice(id)
      await refreshVoices()
      await refreshTts()
    } catch (e) {
      voiceSettings.setPiperVoice(prev)
      setVoiceError(e instanceof Error ? e.message : String(e))
    } finally {
      setVoiceBusy(false)
    }
  }

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

        {/* P5: top-level tabs. Sticky so the user can switch tabs from
            anywhere in a long Section without scrolling back up. */}
        <div className="sticky top-0 z-10 -mx-4 px-4 pb-2 mb-2 bg-white/80 dark:bg-[#202020]/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 dark:supports-[backdrop-filter]:bg-[#202020]/60 border-b border-gray-100 dark:border-white/[0.06]">
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-thin">
            {SETTINGS_TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[0.65rem] font-medium transition-colors ${
                  tab === t.id
                    ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.04]'
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── General tab ──────────────────────────────── */}
        {tab === 'general' && (<>
          <Section title="LU Cloud Account" defaultOpen>
            <AccountPanel />
            {/* Local-mode discovery layer (2.5.8): the locked Create tabs +
                hosted-model rows. The teaser sheet's "Hide Cloud features"
                link flips this off; this is the way back on. */}
            <div className="flex items-center justify-between pt-1">
              <div className="min-w-0 pr-3">
                <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Show Cloud features in Local mode</span>
                <p className="text-[0.6rem] text-gray-500 dark:text-gray-600 leading-snug">
                  Cloud previews on Create tools and model lists, plus Try cloud tags on the tools that run both ways. Never blocks a local flow.
                </p>
              </div>
              <button
                onClick={() => updateSettings({ cloudTeasersEnabled: !settings.cloudTeasersEnabled })}
                className={`relative w-8 h-[18px] rounded-full transition-colors shrink-0 ${
                  settings.cloudTeasersEnabled ? 'bg-violet-500/70' : 'bg-gray-300 dark:bg-white/10'
                }`}
                role="switch"
                aria-checked={settings.cloudTeasersEnabled}
                aria-label="Show Cloud features in Local mode"
              >
                <span
                  className={`absolute top-[2px] w-3.5 h-3.5 rounded-full bg-white shadow transition-all ${
                    settings.cloudTeasersEnabled ? 'left-[16px]' : 'left-[2px]'
                  }`}
                />
              </button>
            </div>
          </Section>
          {/* Keys are minted and revoked on lu-labs.ai only; the desktop app
              never sees the plaintext, so this section just points there. */}
          <Section title="Cloud API Keys">
            <p className="text-[0.6rem] text-gray-500 leading-relaxed">
              Use the chat models of your plan from Aider, LibreChat or any OpenAI-compatible tool.
              Base URL <code className="font-mono select-text text-gray-700 dark:text-gray-300">{CLOUD_BASE}/api/inference/v1</code>, your key as the API key.
              A key spends plan tokens only; it can never read or change the account.
            </p>
            <button
              onClick={() => void openExternal(`${CLOUD_BASE}/account`)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[0.65rem] font-medium bg-violet-500/15 text-violet-500 dark:text-violet-300 hover:bg-violet-500/25 transition-colors"
            >
              <KeyRound size={11} /> Generate API key on lu-labs.ai
            </button>
          </Section>
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
            <AvatarSetting />
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
                onChange={(e) => updateSettings({ maxTokens: Math.max(0, parseInt(e.target.value) || 0) })}
                min={0}
                placeholder="0"
                className="w-20 px-1.5 py-0.5 rounded bg-transparent border border-white/8 text-[0.65rem] text-right text-gray-300 font-mono focus:outline-none focus:border-white/20"
              />
            </div>
            {/* Bug AA v2.5.0 — Ollama num_ctx override. 0 = use the provider
                default (Ollama default = 2048 on most builds, which silently
                clips RAG / long chats). Bump up to use the model's full
                context window. Ignored by Anthropic / OpenAI providers. */}
            <div className="flex items-center justify-between">
              <span className="text-[0.7rem] text-gray-700 dark:text-gray-400" title="Forwarded as Ollama num_ctx. 0 = provider default (Ollama defaults to 2048, which clips RAG and long chats). Bump up to use the model's full context. Ignored by cloud providers.">Context window (Ollama)</span>
              <input
                type="number"
                value={settings.contextWindowOverride ?? 0}
                onChange={(e) => updateSettings({ contextWindowOverride: Math.max(0, parseInt(e.target.value) || 0) })}
                min={0}
                placeholder="0"
                className="w-20 px-1.5 py-0.5 rounded bg-transparent border border-white/8 text-[0.65rem] text-right text-gray-300 font-mono focus:outline-none focus:border-white/20"
              />
            </div>
            <div className="text-[0.6rem] text-gray-500 dark:text-gray-500 leading-relaxed pt-0.5">
              0 = let Ollama decide (defaults to 2048). Set to e.g. 8192 or 16384 if RAG / long chats get clipped. Cloud providers ignore this.
            </div>
          </Section>

          {/* Bug BB v2.5.0 — BobbyT GPU picker. Lazy-loads the GPU list when
              the section opens via detect_gpus probe (nvidia-smi + rocm-smi +
              lspci/wmic). */}
          {/* Not on macOS: every knob in there is a no-op on Apple Silicon.
              The vendor picker forwards CUDA_VISIBLE_DEVICES / HIP_* /
              ONEAPI_* to Ollama and ComfyUI — none of which exist here (Metal,
              unified memory, and ComfyUI never launches). Showing a dead
              NVIDIA/AMD/Intel selector is worse than showing nothing. */}
          {!isMlxImageHost() && (
            <Section title="Hardware (GPU picker)">
              <HardwareSettings />
            </Section>
          )}

          {/* Feature CC v2.5.0 — MikeS++ chatbot export importer. Parses
              ChatGPT / Claude / Gemini export JSON (or .zip), pre-selects
              every conversation, feeds the chosen ones into the active
              chat's RAG store. */}
          <Section title="Import from other chatbots">
            <ChatbotImporter />
          </Section>

          <Section title="Chat Backup">
            <ChatBackupSettings />
          </Section>

          {/* ComfyUI-only knobs — cloud renders use server-side limits, and the
              Mac's MLX pipeline has its own fixed timeout, so hide there too. */}
          {settings.appMode !== 'cloud' && !isMlxImageHost() && (
          <Section title="Image / Video Generation Timeouts">
            <div className="text-[0.6rem] text-gray-500 dark:text-gray-500 leading-relaxed pb-1.5">
              Maximum minutes a ComfyUI generation can run before LU aborts it. Bump these up if you run on iGPU or CPU only, because a 1024px image on integrated graphics can take 30+ min.
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Image timeout (min)</span>
              <input
                type="number"
                value={settings.imageGenTimeoutMinutes ?? 20}
                onChange={(e) => updateSettings({ imageGenTimeoutMinutes: Math.min(480, Math.max(1, parseInt(e.target.value) || 20)) })}
                min={1}
                max={480}
                placeholder="20"
                className="w-20 px-1.5 py-0.5 rounded bg-transparent border border-white/8 text-[0.65rem] text-right text-gray-300 font-mono focus:outline-none focus:border-white/20"
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Video timeout (min)</span>
              <input
                type="number"
                value={settings.videoGenTimeoutMinutes ?? 60}
                onChange={(e) => updateSettings({ videoGenTimeoutMinutes: Math.min(480, Math.max(1, parseInt(e.target.value) || 60)) })}
                min={1}
                max={480}
                placeholder="60"
                className="w-20 px-1.5 py-0.5 rounded bg-transparent border border-white/8 text-[0.65rem] text-right text-gray-300 font-mono focus:outline-none focus:border-white/20"
              />
            </div>
          </Section>
          )}

          <Section title="Privacy">
            {settings.appMode === 'cloud' ? (
              /* Cloud mode: the 100%-local pledge doesn't hold — say so
                 honestly, mirroring the Speech section's cloud copy. */
              <div className="space-y-2 py-1 text-[0.65rem] text-gray-500 dark:text-gray-400 leading-relaxed">
                <div className="flex items-start gap-2">
                  <Lock size={12} className="mt-0.5 shrink-0 text-sky-500" />
                  <div>
                    <p className="text-gray-700 dark:text-gray-300 font-medium mb-0.5">Cloud mode is active.</p>
                    <p>Chat, Create renders and voice run on lu-labs.ai against your LU account and are metered against your credits; generated media and job records are stored with your account. Switch to Local in the header to run everything on your machine, and the 100% local pledge below then applies.</p>
                  </div>
                </div>
                <div className="flex items-start gap-2 pt-1.5">
                  <Shield size={12} className="mt-0.5 shrink-0 text-emerald-500" />
                  <div>
                    <p className="text-gray-700 dark:text-gray-300 font-medium mb-0.5">Local mode: 100% local.</p>
                    <p>In local mode chat, agent runs, and image &amp; video generation all execute on your machine. No telemetry, no analytics, no model pings home. Your local data lives in <code className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/5 font-mono text-[0.6rem]">%APPDATA%/Locally Uncensored</code> on Windows (or the equivalent on Linux/macOS).</p>
                  </div>
                </div>
              </div>
            ) : (
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
                    <p>Conversations, memories, and generated media live in <code className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/5 font-mono text-[0.6rem]">%APPDATA%/Locally Uncensored</code> on Windows (or the equivalent on Linux/macOS). Back up the folder, move it between machines, or delete it. LU writes nothing else.</p>
                  </div>
                </div>
              </div>
            )}
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
                  // The line above is what actually re-runs the wizard: AppShell
                  // gates it on settings.onboardingDone, and that store is
                  // persisted, so it survives the reload below. The backend call
                  // only clears the marker FILE, which is read in one place —
                  // the NSIS-update recovery in AppShell, and only when the
                  // store itself was lost.
                  //
                  // Level (a): silent on purpose. The visible action succeeds
                  // either way, and the reload on the next line would wipe any
                  // message before it could be read. A stale marker costs
                  // nothing until a store-loss recovery, which re-writes it.
                  useSettingsStore.getState().updateSettings({ onboardingDone: false })
                  try { await backendCall('set_onboarding_done', { done: false }) } catch { /* see above */ }
                  window.location.reload()
                }}
                className="ml-3 shrink-0 px-2.5 py-1 rounded-md text-[0.6rem] font-medium bg-white dark:bg-white/10 text-gray-800 dark:text-white hover:bg-gray-100 dark:hover:bg-white/15 border border-gray-200 dark:border-white/15 transition-colors"
              >
                Re-run onboarding
              </button>
            </div>
          </Section>

          <UpdateSection />

          <Section title="Troubleshoot">
            <TroubleshootSection />
          </Section>
        </>)}

        {/* ── AI Backends tab ──────────────────────────── */}
        {tab === 'backends' && (<>
          <Section title="Providers" defaultOpen>
            <ProviderSettings />
          </Section>

          <Section title="Model Storage">
            <HfDownloadPathSetting />
            <ImportLocalModels />
          </Section>

          {builtinManaged && (
            <Section title="Built-in Engine (expert)">
              <BuiltinEngineSettings />
            </Section>
          )}

          {/* ComfyUI never runs on the Mac (MLX-only local media) — hide the whole
              panel there so it isn't a dead Install/Start surface. The Mac gets
              the MLX installer in its place; without it a fresh Mac has no way
              to set up local image/video at all (MAC-3). */}
          {!isMlxImageHost() ? (
            // Arriving from the Models page's "Start ComfyUI to see your image
            // models" hint: the Start button it names lives in here, so the
            // section arrives open instead of costing one more click the hint
            // never mentioned.
            <Section title="ComfyUI (Image & Video)" defaultOpen={entryFocus?.section === 'comfyui'}>
              {settings.appMode === 'cloud' && (
                <p className="text-[0.55rem] text-gray-500 leading-snug pb-1">
                  Local mode only. Cloud renders run on lu-labs.ai and never use ComfyUI.
                </p>
              )}
              <ComfyUISettings />
            </Section>
          ) : (
            <Section title="Local Media (Apple MLX)">
              {settings.appMode === 'cloud' && (
                <p className="text-[0.55rem] text-gray-500 leading-snug pb-1">
                  Local mode only. Cloud renders run on lu-labs.ai and never touch these models.
                </p>
              )}
              <MlxMediaSettings />
            </Section>
          )}
        </>)}

        {/* ── Agent tab ─────────────────────────────────── */}
        {tab === 'agent' && (<>
          <Section title="Personas">
            <PersonaPanel />
          </Section>

          <Section title="Memory">
            <MemorySettings />
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
            <Section title="Coding Agent">
              <CodexAgentSettings />
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
        </>)}

        {/* ── Voice & Remote tab ────────────────────────── */}
        {tab === 'voice-remote' && (<>
          <Section title="Speech" defaultOpen>
            {settings.appMode === 'cloud' ? (<>
              {/* Cloud mode: dictation + read-aloud are hosted on lu-labs.ai —
                  honest copy (audio leaves the machine, metered), no local
                  install buttons, and a picker for the hosted MiniMax voice. */}
              <p className="text-[0.55rem] text-gray-500 leading-snug">
                Cloud mode: dictation and read-aloud run on lu-labs.ai (hosted Whisper speech-to-text + MiniMax text-to-speech) and are metered against your credits. No local installs needed.
              </p>
              <InlineToggle label="Enable read-aloud" enabled={voiceSettings.ttsEnabled} onChange={() => voiceSettings.updateVoiceSettings({ ttsEnabled: !voiceSettings.ttsEnabled })} icon={<Volume2 size={11} className="text-gray-500" />} />
              {voiceSettings.ttsEnabled && (
                <InlineToggle label="Auto-read new responses" enabled={voiceSettings.autoReadAloud} onChange={() => voiceSettings.updateVoiceSettings({ autoReadAloud: !voiceSettings.autoReadAloud })} icon={<Volume2 size={11} className="text-gray-500" />} />
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[0.7rem] text-gray-500">Voice</span>
                <select
                  value={voiceSettings.cloudTtsVoice}
                  onChange={(e) => voiceSettings.updateVoiceSettings({ cloudTtsVoice: e.target.value })}
                  className="max-w-[210px] px-1.5 py-0.5 rounded bg-transparent border border-white/8 text-[0.65rem] text-gray-300 focus:outline-none"
                >
                  {CLOUD_TTS_VOICES.map((v) => (
                    <option key={v.id} value={v.id}>{v.label}</option>
                  ))}
                </select>
              </div>
            </>) : (<>
            <p className="text-[0.55rem] text-gray-500 leading-snug">
              Voice runs 100% locally, no cloud. Each engine is a one-time local install.
            </p>

            {/* Speech-to-Text — faster-whisper (powers the microphone / dictation) */}
            <div className="flex items-center gap-2 text-[0.65rem]">
              <span className="flex items-center gap-1.5">
                {whisperLoading
                  ? <Loader2 size={11} className="animate-spin text-gray-500" />
                  : whisperStatus?.available ? <Check size={11} className="text-green-500" /> : <X size={11} className="text-red-500" />}
                <Mic size={11} className="text-gray-400" />
                <span className="text-gray-700 dark:text-gray-200 font-medium">Speech-to-Text</span>
                <span className="text-gray-500">faster-whisper</span>
              </span>
              {!whisperLoading && whisperStatus && !whisperStatus.available && (
                <button
                  onClick={() => void handleInstallWhisper()}
                  disabled={whisperInstalling}
                  className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded text-[0.6rem] font-medium bg-blue-500/15 text-blue-400 border border-blue-500/30 hover:bg-blue-500/25 transition-colors disabled:opacity-50"
                  title="Download + install faster-whisper so the microphone works"
                >
                  {whisperInstalling ? <Loader2 size={9} className="animate-spin" /> : <Download size={9} />}
                  {whisperInstalling ? 'Installing…' : 'Download & Install'}
                </button>
              )}
            </div>
            {whisperInstallError && (
              <p className="text-[0.55rem] text-red-400/90 leading-snug">{whisperInstallError}</p>
            )}
            {!whisperLoading && whisperStatus && !whisperStatus.available && !whisperInstalling && !whisperInstallError && (
              <p className="text-[0.55rem] text-gray-500 leading-snug">
                Required for the microphone. Installs faster-whisper into LU's Python; first run also downloads a small model.
              </p>
            )}

            {/* Text-to-Speech, Piper neural (read responses aloud) */}
            <div className="flex items-center gap-2 text-[0.65rem] pt-1">
              <span className="flex items-center gap-1.5">
                {ttsLoading
                  ? <Loader2 size={11} className="animate-spin text-gray-500" />
                  : ttsStatus?.available ? <Check size={11} className="text-green-500" /> : <X size={11} className="text-red-500" />}
                <Volume2 size={11} className="text-gray-400" />
                <span className="text-gray-700 dark:text-gray-200 font-medium">Text-to-Speech</span>
                <span className="text-gray-500">Piper neural</span>
              </span>
              {!ttsLoading && ttsStatus && !ttsStatus.available && (
                <button
                  onClick={() => void handleInstallTts()}
                  disabled={ttsInstalling}
                  className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded text-[0.6rem] font-medium bg-blue-500/15 text-blue-400 border border-blue-500/30 hover:bg-blue-500/25 transition-colors disabled:opacity-50"
                  title="Download + install Piper neural TTS + a voice (~63 MB)"
                >
                  {ttsInstalling ? <Loader2 size={9} className="animate-spin" /> : <Download size={9} />}
                  {ttsInstalling ? 'Installing…' : 'Download & Install'}
                </button>
              )}
            </div>
            {ttsInstallError && (
              <p className="text-[0.55rem] text-red-400/90 leading-snug">{ttsInstallError}</p>
            )}
            {/* #77: read-aloud silently fell back to the system voice while this
                row showed a healthy green check — surface the recorded reason. */}
            {voiceSettings.ttsMode === 'piper' && voiceSettings.ttsFallbackReason && (
              <p className="text-[0.55rem] text-amber-400/90 leading-snug">
                {voiceSettings.ttsFallbackReason} If an antivirus quarantined Piper, whitelist it or reinstall the voice below.
              </p>
            )}
            {!ttsLoading && ttsStatus && !ttsStatus.available && !ttsInstalling && !ttsInstallError && (
              <p className="text-[0.55rem] text-gray-500 leading-snug">
                Required for read-aloud. Installs Piper + a neural voice locally (~63 MB).
              </p>
            )}

            <InlineToggle label="Enable read-aloud" enabled={voiceSettings.ttsEnabled} onChange={() => voiceSettings.updateVoiceSettings({ ttsEnabled: !voiceSettings.ttsEnabled })} icon={<Volume2 size={11} className="text-gray-500" />} />
            {/* Auto-read is a SEPARATE opt-in (default OFF). The toggle above only
                surfaces the per-message Speaker button; this one also reads each
                finished response aloud (#77, ElBiggus, the old single toggle was
                labelled "Read responses aloud" but never auto-read). */}
            {voiceSettings.ttsEnabled && (
              <InlineToggle label="Auto-read new responses" enabled={voiceSettings.autoReadAloud} onChange={() => voiceSettings.updateVoiceSettings({ autoReadAloud: !voiceSettings.autoReadAloud })} icon={<Volume2 size={11} className="text-gray-500" />} />
            )}
            {/* Neural voice picker (Piper), replaces the old Microsoft/browser
                voices (David 2026-06-06). Picking one not yet on disk downloads
                it (~63 MB). Browser-only rate/pitch knobs dropped, they didn't
                apply to Piper. */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.7rem] text-gray-500 flex items-center gap-1">
                Voice {voiceBusy && <Loader2 size={10} className="animate-spin text-gray-500" />}
              </span>
              <select
                value={voiceSettings.piperVoice}
                onChange={(e) => void handlePickVoice(e.target.value)}
                disabled={voiceBusy}
                className="max-w-[210px] px-1.5 py-0.5 rounded bg-transparent border border-white/8 text-[0.65rem] text-gray-300 focus:outline-none disabled:opacity-50"
              >
                {PIPER_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}{installedVoices.includes(v.id) ? '' : ', download'}
                  </option>
                ))}
              </select>
            </div>
            {voiceBusy && <p className="text-[0.55rem] text-gray-500 leading-snug">Downloading voice (~63 MB)…</p>}
            {voiceError && <p className="text-[0.55rem] text-red-400/90 leading-snug">{voiceError}</p>}

            {/* TTS engine — bundled Piper, or an external OpenAI-compatible HTTP
                endpoint like Kokoro-FastAPI (GitHub #58). */}
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-[0.7rem] text-gray-500">Engine</span>
              <div className="flex items-center gap-1 text-[0.6rem]">
                {(['piper', 'external'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => voiceSettings.updateVoiceSettings({ ttsMode: m })}
                    className={
                      'px-2 py-0.5 rounded border transition-colors ' +
                      (voiceSettings.ttsMode === m
                        ? 'bg-gray-200 dark:bg-white/15 text-gray-900 dark:text-white border-gray-300 dark:border-white/20'
                        : 'text-gray-500 border-white/8 hover:text-gray-300')
                    }
                  >
                    {m === 'piper' ? 'Piper neural' : 'External HTTP'}
                  </button>
                ))}
              </div>
            </div>
            {voiceSettings.ttsMode === 'external' && (
              <div className="space-y-1.5">
                <input
                  value={voiceSettings.externalTtsUrl}
                  onChange={(e) => voiceSettings.updateVoiceSettings({ externalTtsUrl: e.target.value })}
                  placeholder="http://localhost:8880/v1/audio/speech"
                  spellCheck={false}
                  className="w-full px-2 py-1 rounded bg-transparent border border-white/8 text-[0.65rem] text-gray-300 placeholder-gray-600 focus:outline-none focus:border-white/20"
                />
                <input
                  value={voiceSettings.externalTtsVoice}
                  onChange={(e) => voiceSettings.updateVoiceSettings({ externalTtsVoice: e.target.value })}
                  placeholder="voice name (e.g. af_bella, alloy)"
                  spellCheck={false}
                  className="w-full px-2 py-1 rounded bg-transparent border border-white/8 text-[0.65rem] text-gray-300 placeholder-gray-600 focus:outline-none focus:border-white/20"
                />
                <p className="text-[0.55rem] text-gray-500 leading-snug">
                  Any OpenAI-compatible TTS endpoint (e.g. Kokoro-FastAPI). Used for read-aloud instead of Piper. Stays on your machine when the endpoint is local.
                </p>
              </div>
            )}
            </>)}
          </Section>

          <Section title="Remote Access">
            <RemoteAccessSettings />
            {/* §16 — real step-by-step docs (F5/X2 shipped only a 1-line
                blurb). Collapsed by default so the settings stay compact. */}
            <Disclosure label="How it works">
              <RemoteAccessDocs />
            </Disclosure>
          </Section>
        </>)}

        {/* ── Reset (GitHub #59: per-tab scope + confirm + feedback) ── */}
        <ResetSection tab={tab} />
      </div>
    </div>
  )
}

// ── Update Section ──────────────────────────────────────────────

function UpdateSection() {
  const { currentVersion, latestVersion, updateAvailable, releaseNotes, dismissed, isChecking, autoDownload, downloadStatus, downloadProgress, downloadedBytes, totalBytes, errorMessage, checkForUpdate, downloadUpdate, installAndRestart, clearDismiss, setAutoDownload, openReleasePage } = useUpdateStore()
  // Defensive: only treat the persisted `latestVersion` as actually newer if a
  // semver compare confirms it. Otherwise the binary was updated out-of-band
  // and the persisted value is stale (e.g. localStorage still says 2.3.8 while
  // the binary is now 2.4.1). In that case both `updateAvailable` and the
  // "Latest Version" row should hide so we don't display a confusing inversion.
  const latestIsActuallyNewer = !!(latestVersion && isNewerVersion(latestVersion, currentVersion))
  const displayLatestVersion = latestIsActuallyNewer ? latestVersion : null
  const showUpdate = updateAvailable && latestIsActuallyNewer

  return (
    <Section title="Updates">
      <div className="space-y-3 py-2">
        {/* Current version */}
        <div className="flex items-center justify-between">
          <span className="text-[0.65rem] text-gray-500">Current Version</span>
          <span className="text-[0.65rem] text-gray-300 font-mono">v{currentVersion}</span>
        </div>

        {/* Latest version — only show if it's actually newer than current */}
        {displayLatestVersion && (
          <div className="flex items-center justify-between">
            <span className="text-[0.65rem] text-gray-500">Latest Version</span>
            <span className={`text-[0.65rem] font-mono ${showUpdate ? 'text-emerald-400' : 'text-gray-300'}`}>
              v{displayLatestVersion}
            </span>
          </div>
        )}

        {/* Status. Same pipeline as the header badge: in-app download, then a
            click to restart. openReleasePage survives only as the dev-mode
            fallback, there is no updater outside Tauri. */}
        {showUpdate ? (
          <div className="rounded-lg bg-emerald-500/[0.08] border border-emerald-500/20 p-3">
            <div className="flex items-center gap-2 mb-2">
              <ArrowUpCircle size={14} className="text-emerald-400" />
              <span className="text-[0.65rem] font-medium text-emerald-400">Update available!</span>
            </div>
            {releaseNotes && downloadStatus !== 'downloading' && downloadStatus !== 'downloaded' && (
              <p className="text-[0.55rem] text-gray-500 leading-relaxed mb-2.5 line-clamp-4 whitespace-pre-line">{releaseNotes}</p>
            )}

            {(downloadStatus === 'downloading' || downloadStatus === 'downloaded') && (
              <div className="mb-2.5">
                <div className="w-full h-1 rounded-full bg-white/[0.06] overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${downloadStatus === 'downloaded' ? 'bg-emerald-500' : 'bg-blue-500'}`}
                    style={{ width: `${downloadProgress}%` }}
                  />
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[0.55rem] text-gray-500">
                    {downloadStatus === 'downloaded' ? 'Download complete' : `${downloadProgress}%`}
                  </span>
                  {totalBytes > 0 && (
                    <span className="text-[0.55rem] text-gray-600">
                      {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)}
                    </span>
                  )}
                </div>
              </div>
            )}

            {downloadStatus === 'error' && errorMessage && (
              <p className="text-[0.6rem] text-red-400/80 leading-relaxed mb-2.5">{errorMessage}</p>
            )}

            <div className="flex gap-2">
              {!isTauri() ? (
                <button
                  onClick={openReleasePage}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[0.6rem] font-medium bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
                >
                  <Download size={11} /> View Release
                </button>
              ) : downloadStatus === 'idle' ? (
                <button
                  onClick={() => { void downloadUpdate() }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[0.6rem] font-medium bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
                >
                  <Download size={11} /> Download Update
                </button>
              ) : downloadStatus === 'downloading' ? (
                <span className="flex items-center gap-1.5 px-3 py-1.5 text-[0.6rem] text-blue-400/80">
                  <Loader2 size={11} className="animate-spin" /> Downloading...
                </span>
              ) : downloadStatus === 'downloaded' ? (
                <button
                  onClick={() => { void installAndRestart() }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[0.6rem] font-medium bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
                >
                  <RefreshCw size={11} /> Restart Now
                </button>
              ) : downloadStatus === 'installing' ? (
                <span className="flex items-center gap-1.5 px-3 py-1.5 text-[0.6rem] text-emerald-400/80">
                  <Loader2 size={11} className="animate-spin" /> Installing...
                </span>
              ) : (
                <button
                  onClick={() => { void downloadUpdate() }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[0.6rem] font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
                >
                  <RotateCcw size={11} /> Retry
                </button>
              )}
              {dismissed === displayLatestVersion && (
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

        {/* Auto-download. Downloads only — installing always stays a click, so
            the app never restarts under the user's hands. */}
        <label className="flex items-start justify-between gap-3 cursor-pointer">
          <span>
            <span className="block text-[0.65rem] text-gray-300">Download updates automatically</span>
            <span className="block text-[0.55rem] text-gray-600 leading-relaxed">
              Fetches the update in the background so installing is one click. Never restarts on its own.
            </span>
          </span>
          <input
            type="checkbox"
            checked={autoDownload}
            onChange={(e) => setAutoDownload(e.target.checked)}
            className="mt-0.5 accent-emerald-500"
          />
        </label>

        {/* Manual check */}
        <button
          onClick={() => { void checkForUpdate(true) }}
          disabled={isChecking}
          className="text-[0.6rem] text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-40"
        >
          {isChecking ? 'Checking...' : 'Check for updates'}
        </button>
      </div>
    </Section>
  )
}

// ── B7 Troubleshoot section — one-shot diagnostic probe ───────

interface BackendProbe {
  status: 'ok' | 'unreachable' | 'not_installed' | 'error'
  detail: string
  endpoint: string
}

interface SystemHealthReport {
  version: string
  host: {
    os: string
    os_version: string
    arch: string
    cpu_count: number
    ram_gb: number
    disk_free_gb: number
    // §17: VRAM of the biggest NVIDIA GPU. null on non-NVIDIA boxes / when
    // the nvidia-smi probe fails — rendered as "—".
    vram_total_gb: number | null
    vram_free_gb: number | null
  }
  ollama: BackendProbe
  comfyui: BackendProbe
  lm_studio: BackendProbe
}

function ProbeBadge({ probe }: { probe: BackendProbe }) {
  const colors: Record<BackendProbe['status'], string> = {
    ok: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30',
    unreachable: 'bg-amber-500/15 text-amber-500 border-amber-500/30',
    not_installed: 'bg-gray-500/15 text-gray-500 border-gray-500/30',
    error: 'bg-red-500/15 text-red-500 border-red-500/30',
  }
  const labels: Record<BackendProbe['status'], string> = {
    ok: 'Reachable',
    unreachable: 'Not running',
    not_installed: 'Not installed',
    error: 'Error',
  }
  return (
    <span
      className={`text-[0.55rem] px-1.5 py-0.5 rounded border font-medium ${colors[probe.status]}`}
      title={probe.detail || probe.endpoint}
    >
      {labels[probe.status]}
    </span>
  )
}

function TroubleshootSection() {
  const [report, setReport] = useState<SystemHealthReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await backendCall<SystemHealthReport>('system_health', {})
      setReport(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  // Auto-run on first open so the panel never starts empty.
  useEffect(() => {
    void run()
  }, [])

  return (
    <div className="space-y-3 py-2">
      <p className="text-[0.6rem] text-gray-500 leading-relaxed">
        One-shot probe of the local backends and host facts. Use this when
        the app behaves oddly. Most "model not found" / {isMlxImageHost() ? '"backend doesn\'t respond"' : '"ComfyUI doesn\'t respond"'} issues become obvious here.
      </p>

      {error && (
        <div className="rounded-lg bg-red-500/[0.08] border border-red-500/20 p-2.5 text-[0.65rem] text-red-400">
          system_health failed: {error}
        </div>
      )}

      {/* Audit #01 — where the log file is. Above the probe result because
          "send us the log" is the most common outcome of opening this panel. */}
      <LogFileSettings />

      {report && (
        <div className="space-y-2">
          {/* Backends */}
          <div className="rounded-lg border border-white/[0.06] p-2.5 space-y-2">
            <div className="text-[0.55rem] uppercase tracking-widest text-gray-500">Backends</div>
            <div className="flex items-center justify-between">
              <span className="text-[0.65rem] text-gray-300">Ollama</span>
              <ProbeBadge probe={report.ollama} />
            </div>
            {!isMlxImageHost() && (
              <div className="flex items-center justify-between">
                <span className="text-[0.65rem] text-gray-300">ComfyUI</span>
                <ProbeBadge probe={report.comfyui} />
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[0.65rem] text-gray-300">LM Studio</span>
              <ProbeBadge probe={report.lm_studio} />
            </div>
          </div>

          {/* Host facts */}
          <div className="rounded-lg border border-white/[0.06] p-2.5 space-y-1.5">
            <div className="text-[0.55rem] uppercase tracking-widest text-gray-500">Host</div>
            <div className="flex items-center justify-between text-[0.65rem]">
              <span className="text-gray-500">LU version</span>
              <span className="text-gray-300 font-mono">v{report.version}</span>
            </div>
            <div className="flex items-center justify-between text-[0.65rem]">
              <span className="text-gray-500">OS</span>
              <span className="text-gray-300 font-mono">{report.host.os} {report.host.os_version}</span>
            </div>
            <div className="flex items-center justify-between text-[0.65rem]">
              <span className="text-gray-500">Arch / CPUs</span>
              <span className="text-gray-300 font-mono">{report.host.arch} / {report.host.cpu_count}</span>
            </div>
            <div className="flex items-center justify-between text-[0.65rem]">
              <span className="text-gray-500">RAM</span>
              <span className="text-gray-300 font-mono">{report.host.ram_gb} GB</span>
            </div>
            <div className="flex items-center justify-between text-[0.65rem]">
              <span className="text-gray-500">Disk free (home)</span>
              <span className={`font-mono ${report.host.disk_free_gb < 10 ? 'text-amber-400' : 'text-gray-300'}`}>
                {report.host.disk_free_gb} GB
              </span>
            </div>
            <div className="flex items-center justify-between text-[0.65rem]">
              <span className="text-gray-500">VRAM (GPU)</span>
              <span className="text-gray-300 font-mono">
                {report.host.vram_total_gb != null
                  ? (report.host.vram_free_gb != null
                      ? `${report.host.vram_free_gb} / ${report.host.vram_total_gb} GB free`
                      : `${report.host.vram_total_gb} GB`)
                  : 'not detected'}
              </span>
            </div>
          </div>
        </div>
      )}

      <button
        onClick={run}
        disabled={loading}
        className="w-full px-3 py-1.5 rounded-md text-[0.65rem] font-medium bg-gray-100 dark:bg-white/[0.06] hover:bg-gray-200 dark:hover:bg-white/10 text-gray-800 dark:text-gray-200 transition-colors disabled:opacity-50"
      >
        {loading ? 'Probing…' : 'Re-probe'}
      </button>
    </div>
  )
}
