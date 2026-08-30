import { useState, useEffect, useRef } from 'react'
import { Wifi, WifiOff, Loader2, Eye, EyeOff, ChevronDown, Plus, Power, Play, Trash2 } from 'lucide-react'
import { useProviderStore } from '../../stores/providerStore'
import { providerRowIds, isReturnableRow } from '../../lib/provider-visibility'
import {
  slotTakeoverUpdate,
  slotHandbackUpdate,
  slotDisableOccupantUpdate,
  standbyOccupant,
  occupantIsRemovable,
  standbyIsRemovable,
  slotRemoveOccupantUpdate,
  slotForgetStandbyUpdate,
} from '../../lib/openai-slot-handover'
import { useMemoryStore } from '../../stores/memoryStore'
import { getProvider } from '../../api/providers'
import { PROVIDER_PRESETS } from '../../api/providers/types'
import { Modal } from '../ui/Modal'
import { backendCall } from '../../api/backend'
import { diagnoseBuiltinEngine, readBuiltinSlotStatus } from '../../api/builtin-ensure'
import type { SlotStatus } from '../../lib/builtin-slot-status'
import type { ProviderId, ProviderConfig } from '../../api/providers/types'

const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__

/** What a slot in the provider list may show and let the user change. */
export interface SlotView {
  label: string
  /** Preset the row resolved to, or null when the app owns the slot itself. */
  presetId: string | null
  /** False when the app pins the address, so an edit box would be a lie. */
  endpointEditable: boolean
  /** False when the credential is not something the user types here. */
  needsKey: boolean
  placeholder?: string
  /** Shown in place of the fields the app owns. */
  note?: string
}

/**
 * Decide what a provider row is allowed to promise.
 *
 * `LuCloudProvider` pins the address to CLOUD_BASE and uses the account's
 * session token as the bearer, on purpose: a tampered provider store must not
 * be able to redirect that traffic (security review 2.5.7). The pane used to
 * offer an editable Endpoint box and an API Key box anyway, so both ignored
 * what was typed and said nothing about it, and the row called itself
 * "Custom (OpenAI-compat)" because no preset matched, which made the one
 * first-party backend look hand-rolled. The built-in engine already handles
 * its own fixed address this way; this is the same answer for the other slot
 * the app owns.
 */
export function providerSlotView(id: ProviderId, config: ProviderConfig): SlotView {
  if (id === 'lu-cloud') {
    return {
      label: config.name || 'LU Cloud',
      presetId: null,
      endpointEditable: false,
      needsKey: false,
      note: 'Signed in with your LU account. The address is fixed and needs no key.',
    }
  }
  const preset =
    id === 'ollama'
      ? PROVIDER_PRESETS.find(p => p.id === 'ollama')!
      : id === 'anthropic'
        ? PROVIDER_PRESETS.find(p => p.id === 'anthropic')!
        : PROVIDER_PRESETS.find(p => p.providerId === 'openai' && (p.name === config.name || p.baseUrl === config.baseUrl)) ||
          PROVIDER_PRESETS.find(p => p.id === 'custom-openai')!
  if (config.managed) {
    return {
      label: preset.name || config.name,
      presetId: preset.id,
      endpointEditable: false,
      needsKey: false,
      note: 'Built-in engine, runs locally, nothing to configure.',
    }
  }
  return {
    label: preset.name || config.name,
    presetId: preset.id,
    endpointEditable: true,
    needsKey: !config.isLocal,
    placeholder: preset.placeholder,
  }
}

// Sweep #4 Bug (g): when LM Studio is installed locally but its embedded
// server is not currently listening on :1234 (user closed the GUI, the
// server toggle is off, etc.), the previous Settings UI offered only
// `Test` and `Disable`. The clean Plug-and-Play path is to call the
// existing `start_lmstudio_server` Tauri command — same surface the
// onboarding's Fix-(d) card uses. This keeps the user inside LU instead
// of forcing them through Re-run-onboarding to recover from a
// transient server outage.
type LmStudioServerInfo = { lms_present: boolean; running: boolean }

export function ProviderSettings() {
  const { providers, setProviderConfig, setProviderApiKey, getProviderApiKey } = useProviderStore()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [testing, setTesting] = useState<ProviderId | null>(null)
  const [statuses, setStatuses] = useState<Record<string, SlotStatus>>({})
  // Per-slot English explanation for a failed Test (GH #118).
  const [testDetail, setTestDetail] = useState<Record<string, string>>({})
  const [showKey, setShowKey] = useState<Record<string, boolean>>({})
  const [showCloudWarning, setShowCloudWarning] = useState(false)
  const [pendingPreset, setPendingPreset] = useState<typeof PROVIDER_PRESETS[0] | null>(null)
  const [expandedProvider, setExpandedProvider] = useState<ProviderId | null>(null)

  const autoExtractEnabled = useMemoryStore((s) => s.settings.autoExtractEnabled)

  // Bug (g) state — LM-Studio-on-disk-but-server-off detection.
  const [lmStudioInfo, setLmStudioInfo] = useState<LmStudioServerInfo | null>(null)
  const [startingLmStudioServer, setStartingLmStudioServer] = useState(false)

  const refreshLmStudioInfo = async () => {
    if (!isTauri) return
    try {
      const status = await backendCall<LmStudioServerInfo>('lmstudio_server_status')
      setLmStudioInfo(status)
    } catch { /* command unavailable on older builds — leave null */ }
  }

  // One status for one slot, and never a verdict nobody earned.
  //
  // GH #118 leftover, counter-check 2026-08-29: right after app start, with no
  // chat model loaded, this row read "Failed" for the app's OWN engine, and
  // the click that disproved it printed ERR_CONNECTION_REFUSED on 127.0.0.1:8127
  // in the console first. The app starts that process itself, so it can simply
  // ask whether it runs. An engine that was never started is "Not running",
  // which is a true sentence and also a different one from "Failed".
  const probeSlot = async (id: ProviderId): Promise<SlotStatus> => {
    if (id === 'openai') {
      const known = await readBuiltinSlotStatus()
      // 'connected' or 'stopped' answers it without touching a socket. Only an
      // engine that is up but not yet answering falls through to a real probe.
      if (known) return known
    }
    try {
      return (await getProvider(id).checkConnection()) ? 'connected' : 'failed'
    } catch {
      return 'failed'
    }
  }

  // Auto-check connection status for all enabled providers on mount.
  // Also probe lmstudio_server_status so the inline "Start Server"
  // affordance is correct from first render, not just after a Test click.
  useEffect(() => {
    const checkAll = async () => {
      const ids = (Object.keys(providers) as ProviderId[]).filter(id => providers[id].enabled)
      for (const id of ids) {
        const status = await probeSlot(id)
        setStatuses(prev => ({ ...prev, [id]: status }))
      }
      await refreshLmStudioInfo()
    }
    checkAll()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Get all enabled providers
  const enabledProviderIds = (Object.keys(providers) as ProviderId[]).filter(id => providers[id].enabled)
  // The rows the list draws: everything enabled, PLUS everything the user
  // switched off right here. Disabling used to delete the card, and with it the
  // only control that could bring the provider back (Nebenbefund 1, R9
  // re-measure). A switched-off row stays, greyed, with Enable on it.
  const rowIds = providerRowIds(providers) as ProviderId[]
  // The backend Add Provider pushed out of the shared `openai` slot, if any.
  // It keeps a card instead of disappearing (Nebenbefund 3, R10 re-measure).
  const standby = standbyOccupant(providers.openai)
  // Was it pushed aside, or did the user switch it off. The slot looks the
  // same from here either way, so the mark rides on the card (Nebenbefund 3,
  // R12/R13 re-measure).
  const standbyOff = standby?.disabledByUser === true

  // Remove, armed by a second click on the same button (Nebenbefund (b), R11
  // re-measure). The house has one confirmation and this is it: the Reset
  // button, the Cloud switch and the message delete all arm and wait for a
  // second click, and none of them opens a dialog. Which button is armed has to
  // be part of the state, because the occupant card and the standby card each
  // have one and arming one must not arm the other.
  const [armedRemove, setArmedRemove] = useState<'occupant' | 'standby' | null>(null)
  const armTimer = useRef<number | null>(null)
  useEffect(() => () => { if (armTimer.current) window.clearTimeout(armTimer.current) }, [])

  function disarmRemove() {
    if (armTimer.current) window.clearTimeout(armTimer.current)
    armTimer.current = null
    setArmedRemove(null)
  }

  // First click arms and writes nothing, second click within 4 s does it. Same
  // window as the Reset button, so the two behave alike.
  function armOrRun(which: 'occupant' | 'standby', run: () => void) {
    if (armedRemove !== which) {
      if (armTimer.current) window.clearTimeout(armTimer.current)
      setArmedRemove(which)
      armTimer.current = window.setTimeout(() => setArmedRemove(null), 4000)
      return
    }
    disarmRemove()
    run()
  }

  // Remove on the backend that holds the shared local slot: the slot goes back
  // to what it held before the takeover, and the removed backend is forgotten
  // instead of parked on standby. Offered only where `displaced` knows a state
  // to return to, so the app's own engine and the three other slots have no
  // Remove at all.
  function removeOccupant() {
    const update = slotRemoveOccupantUpdate(providers.openai)
    if (!update) return
    setProviderConfig('openai', update)
    setStatuses(prev => ({ ...prev, openai: 'idle' }))
    setExpandedProvider('openai')
  }

  // Remove on the standby card: forget the backend waiting there. The slot
  // itself is not touched.
  function removeStandby() {
    const update = slotForgetStandbyUpdate(providers.openai)
    if (!update) return
    setProviderConfig('openai', update)
  }

  // Hand the `openai` slot back to the backend on standby. Same effect the
  // Reset button has for this one slot, without resetting anything else, and
  // it swaps rather than forgets: the backend now leaving the slot takes the
  // standby card in its turn.
  function handBackSlot() {
    const update = slotHandbackUpdate(providers.openai)
    if (!update) return
    setProviderConfig('openai', update)
    setStatuses(prev => ({ ...prev, openai: 'idle' }))
    setExpandedProvider('openai')
  }

  // Add a preset (enable a provider without disabling others)
  function selectPreset(preset: typeof PROVIDER_PRESETS[0]) {
    if (!preset.isLocal) {
      setPendingPreset(preset)
      setShowCloudWarning(true)
      return
    }
    applyPreset(preset)
  }

  function applyPreset(preset: typeof PROVIDER_PRESETS[0]) {
    // Enable the selected provider WITHOUT disabling others
    if (preset.providerId === 'ollama') {
      setProviderConfig('ollama', { enabled: true, baseUrl: preset.baseUrl })
    } else if (preset.providerId === 'anthropic') {
      setProviderConfig('anthropic', { enabled: true, name: preset.name, baseUrl: preset.baseUrl, isLocal: false })
    } else {
      // Every OpenAI-protocol backend shares the one `openai` slot, so adding
      // one pushes out whatever was in it. That used to happen in silence:
      // Add Provider, Jan, and the Built-in Engine card was gone with no word
      // about where it went (Nebenbefund 3, R10 re-measure 2026-08-30). The
      // slot remembers who it displaced now, and the list keeps a standby card
      // for it. `managed` is still set explicitly in both directions, so
      // switching to LM Studio/vLLM clears the built-in flag and re-selecting
      // Built-in restores it.
      setProviderConfig('openai', slotTakeoverUpdate(providers.openai, {
        name: preset.name,
        baseUrl: preset.baseUrl,
        isLocal: preset.isLocal,
        managed: preset.managed,
      }))
    }

    setDropdownOpen(false)
    setStatuses(prev => ({ ...prev, [preset.providerId]: 'idle' }))
    setExpandedProvider(preset.providerId)
  }

  // Toggle a provider on/off independently. The off state is marked as the
  // user's own doing so the row survives it and can offer Enable; turning it
  // back on clears the mark, and the row is a normal row again.
  function toggleProvider(id: ProviderId) {
    const nextEnabled = !providers[id].enabled
    // Nebenbefund (c), R11 re-measure: Disable on the backend that had taken
    // the shared local slot left the machine with NO local backend at all. Jan
    // went to DISABLED, the built-in engine stayed on STANDBY carrying the now
    // untrue sentence "Jan took over the local slot", and the chat fell back to
    // "Select Model". Switching a backend off is not a wish to be left without
    // one: the engine that was waiting for exactly this slot takes it back, and
    // the backend that is leaving takes the standby card in its place. That is
    // the same swap Enable does, only pressed from the other side.
    //
    // Nebenbefund 3, R12/R13 re-measure: the swap was right, the label was not.
    // The card of the backend that leaves said STANDBY, which is the word for a
    // backend that was pushed aside, and this one was switched off by hand. It
    // says DISABLED now and carries the same disabledByUser mark every other
    // switched-off row carries. Enable and Remove stay on it, unchanged.
    if (!nextEnabled && id === 'openai') {
      const handback = slotDisableOccupantUpdate(providers.openai)
      if (handback) {
        setProviderConfig('openai', handback)
        setStatuses(prev => ({ ...prev, openai: 'idle' }))
        return
      }
    }
    setProviderConfig(id, { enabled: nextEnabled, disabledByUser: !nextEnabled })
    setStatuses(prev => ({ ...prev, [id]: 'idle' }))
    if (nextEnabled) setExpandedProvider(id)
  }

  const handleTest = async (providerId: ProviderId) => {
    setTesting(providerId)
    setStatuses(prev => ({ ...prev, [providerId]: 'idle' }))
    setTestDetail(prev => ({ ...prev, [providerId]: '' }))
    let ok = false
    // A stopped engine is a thing to start, not a thing to probe. Skipping the
    // doomed request is what keeps ERR_CONNECTION_REFUSED out of the console
    // on the way to a green dot (GH #118).
    const stopped = providerId === 'openai' && (await readBuiltinSlotStatus()) === 'stopped'
    if (!stopped) {
      try {
        const client = getProvider(providerId)
        ok = await client.checkConnection()
      } catch {
        ok = false
      }
    }
    // GH #118: a red dot was the whole answer the built-in engine gave, while
    // the console carried ERR_CONNECTION_REFUSED on 127.0.0.1:8127. The app
    // owns that process, so a failed test asks the app: start it if a model is
    // there, and otherwise say in one English sentence what is missing.
    // Only the openai slot can BE the built-in engine, and testing Anthropic
    // must never boot a local server as a side effect.
    if (!ok && providerId === 'openai') {
      const diag = await diagnoseBuiltinEngine({ repair: true })
      if (diag.ok) {
        try {
          ok = await getProvider(providerId).checkConnection()
        } catch {
          ok = false
        }
      }
      if (!ok && diag.reason) {
        setTestDetail(prev => ({ ...prev, [providerId]: diag.reason }))
      }
    }
    setStatuses(prev => ({ ...prev, [providerId]: ok ? 'connected' : 'failed' }))
    setTesting(null)
    // Bug (g): refresh after a Test click so the Start-Server button
    // appears the moment a user discovers their LM Studio server is down.
    void refreshLmStudioInfo()
  }

  const handleStartLmStudioServer = async (providerId: ProviderId) => {
    setStartingLmStudioServer(true)
    setStatuses(prev => ({ ...prev, [providerId]: 'idle' }))
    try {
      await backendCall('start_lmstudio_server')
      // Poll up to 30 s for the server to come up. LM Studio's embedded
      // server typically binds in 3–8 s on a warm machine; 30 s ceiling
      // covers cold ARM64 VMs without wedging the UI.
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const status = await backendCall<LmStudioServerInfo>('lmstudio_server_status').catch(() => null)
        if (status?.running) {
          setLmStudioInfo(status)
          // Re-test the provider so the connection dot turns green.
          await handleTest(providerId)
          break
        }
      }
    } catch {
      setStatuses(prev => ({ ...prev, [providerId]: 'failed' }))
    }
    setStartingLmStudioServer(false)
  }

  // Group presets for the "Add provider" dropdown
  const localPresets = PROVIDER_PRESETS.filter(p => p.isLocal)
  const cloudPresets = PROVIDER_PRESETS.filter(p => !p.isLocal)

  const noBackend = enabledProviderIds.length === 0

  return (
    <div className="space-y-2">
      {/* Providers List: enabled rows, plus the ones the user switched off */}
      {rowIds.map(id => {
        const config = providers[id]
        const view = providerSlotView(id, config)

        // Switched off by the user: the row stays and carries the way back.
        // Nothing to test and nothing to configure while it is off, so the row
        // is one line and one button.
        if (isReturnableRow(config)) {
          return (
            <div key={id} className="rounded-lg border border-white/8 bg-white/[0.01] overflow-hidden">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <button
                  onClick={() => toggleProvider(id)}
                  className="group flex items-center"
                  title="Enable provider"
                >
                  <Power size={10} className="text-gray-500 group-hover:text-green-400 transition-colors" />
                </button>
                <div className="flex-1 flex items-center gap-2 min-w-0">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-gray-600" />
                  <span className="text-[0.65rem] text-gray-500 font-medium truncate">{view.label}</span>
                  <span className="text-[0.5rem] px-1 py-0.5 rounded bg-white/5 text-gray-500 shrink-0">DISABLED</span>
                </div>
                <button
                  onClick={() => toggleProvider(id)}
                  className="shrink-0 px-2 py-0.5 rounded bg-green-500/10 border border-green-500/20 text-[0.6rem] text-green-300 hover:text-green-200 hover:bg-green-500/15 transition-colors"
                >
                  Enable
                </button>
              </div>
              <p className="px-2 pb-1.5 text-[0.55rem] text-gray-600 leading-snug">
                Switched off, so its models are not offered in the chat model picker. Press Enable to use it again.
              </p>
            </div>
          )
        }
        const needsKey = view.needsKey
        const currentKey = getProviderApiKey(id)
        const status = statuses[id] || 'idle'
        const isExpanded = expandedProvider === id
        const isTesting = testing === id
        const isKeyVisible = showKey[id] || false

        return (
          <div key={id} className="rounded-lg border border-white/8 bg-white/[0.02] overflow-hidden">
            {/* Provider header */}
            <div className="flex items-center gap-2 px-2 py-1.5">
              <button
                onClick={() => toggleProvider(id)}
                className="group flex items-center"
                title={config.enabled ? 'Disable provider' : 'Enable provider'}
              >
                <Power size={10} className="text-green-400 group-hover:text-red-400 transition-colors" />
              </button>
              <button
                onClick={() => setExpandedProvider(isExpanded ? null : id)}
                className="flex-1 flex items-center justify-between min-w-0"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    status === 'connected' ? 'bg-green-500' :
                    status === 'failed' ? 'bg-red-500' :
                    status === 'stopped' ? 'bg-amber-500' :
                    'bg-gray-500'
                  }`} />
                  <span className="text-[0.65rem] text-gray-300 font-medium truncate">{view.label}</span>
                  {config.managed && <span className="text-[0.5rem] px-1 py-0.5 rounded bg-purple-500/15 text-purple-300 shrink-0">DEFAULT</span>}
                  {config.isLocal && <span className="text-[0.5rem] px-1 py-0.5 rounded bg-green-500/10 text-green-400 shrink-0">LOCAL</span>}
                  {!config.isLocal && <span className="text-[0.5rem] px-1 py-0.5 rounded bg-blue-500/10 text-blue-400 shrink-0">CLOUD</span>}
                  {status === 'connected' && <Wifi size={8} className="text-green-400 shrink-0" />}
                  {status === 'failed' && <WifiOff size={8} className="text-red-400 shrink-0" />}
                  {status === 'stopped' && <WifiOff size={8} className="text-amber-400 shrink-0" />}
                </div>
                <ChevronDown size={10} className={`text-gray-500 transition-transform shrink-0 ${isExpanded ? 'rotate-180' : ''}`} />
              </button>
            </div>

            {/* Expanded config */}
            {isExpanded && (
              <div className="px-2 pb-2 space-y-1.5 border-t border-white/[0.04]">
                {/* Endpoint — an edit box only where editing it does something.
                    The built-in engine and LU Cloud both run on an address the
                    app pins, so they show it instead of pretending. */}
                {!view.endpointEditable ? (
                  <div className="pt-1.5 space-y-0.5">
                    <p className="text-[0.6rem] text-gray-500 leading-tight">{view.note}</p>
                    {!config.isLocal && (
                      <code className="block text-[0.6rem] text-gray-400 font-mono break-all select-text">{config.baseUrl}</code>
                    )}
                  </div>
                ) : (
                  <div className="pt-1.5">
                    <label className="text-[0.6rem] text-gray-500 mb-0.5 block">Endpoint</label>
                    <input
                      value={config.baseUrl}
                      onChange={(e) => setProviderConfig(id, { baseUrl: e.target.value })}
                      placeholder="http://localhost:..."
                      className="w-full px-2 py-1 rounded bg-white/5 border border-white/8 text-[0.65rem] text-gray-300 font-mono focus:outline-none focus:border-white/20"
                    />
                  </div>
                )}

                {/* API Key (cloud only) */}
                {needsKey && (
                  <div>
                    <label className="text-[0.6rem] text-gray-500 mb-0.5 block">API Key</label>
                    <div className="relative">
                      <input
                        type={isKeyVisible ? 'text' : 'password'}
                        value={currentKey}
                        onChange={(e) => setProviderApiKey(id, e.target.value)}
                        placeholder={view.placeholder || 'sk-...'}
                        className="w-full px-2 py-1 pr-7 rounded bg-white/5 border border-white/8 text-[0.65rem] text-gray-300 font-mono focus:outline-none focus:border-white/20"
                      />
                      <button
                        onClick={() => setShowKey(prev => ({ ...prev, [id]: !isKeyVisible }))}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                      >
                        {isKeyVisible ? <EyeOff size={10} /> : <Eye size={10} />}
                      </button>
                    </div>
                  </div>
                )}

                {/* Test + Disable + (g) Start Server when LM-Studio is offline */}
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => handleTest(id)}
                    disabled={isTesting}
                    className="px-2 py-0.5 rounded bg-white/5 border border-white/8 text-[0.6rem] text-gray-400 hover:text-gray-200 hover:bg-white/8 transition-colors disabled:opacity-50"
                  >
                    {isTesting ? <Loader2 size={10} className="animate-spin" /> : 'Test'}
                  </button>
                  <button
                    onClick={() => toggleProvider(id)}
                    className="px-2 py-0.5 rounded bg-red-500/5 border border-red-500/10 text-[0.6rem] text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                  >
                    Disable
                  </button>
                  {/* Remove, for a backend the user put into the shared local
                      slot on top of another one. The slot goes back to what it
                      held before, which is the only thing "remove" can mean
                      here, and the reason it is not offered anywhere else. */}
                  {id === 'openai' && occupantIsRemovable(providers.openai) && (
                    <button
                      data-testid="provider-remove"
                      onClick={() => armOrRun('occupant', removeOccupant)}
                      title={`Remove ${view.label} and put ${standby?.name} back in the local slot`}
                      className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[0.6rem] transition-colors ${
                        armedRemove === 'occupant'
                          ? 'bg-red-500/15 border-red-500/30 text-red-300 font-medium'
                          : 'bg-white/5 border-white/8 text-gray-400 hover:text-red-300 hover:border-red-500/20'
                      }`}
                    >
                      <Trash2 size={10} />
                      {armedRemove === 'occupant' ? 'Click again to remove' : 'Remove'}
                    </button>
                  )}
                  {/* Bug (g): only render when this is the LM Studio provider AND
                      we have positive evidence that the binary is on disk but the
                      server isn't up. The same Tauri command is idempotent so
                      duplicate clicks are safe. */}
                  {view.presetId === 'lmstudio'
                    && lmStudioInfo?.lms_present
                    && lmStudioInfo?.running === false
                    && status !== 'connected'
                    && (
                      <button
                        onClick={() => handleStartLmStudioServer(id)}
                        disabled={startingLmStudioServer}
                        className="flex items-center gap-1 px-2 py-0.5 rounded bg-green-500/10 border border-green-500/20 text-[0.6rem] text-green-300 hover:text-green-200 hover:bg-green-500/15 transition-colors disabled:opacity-50"
                      >
                        {startingLmStudioServer
                          ? <><Loader2 size={10} className="animate-spin" /> Starting…</>
                          : <><Play size={10} /> Start Server</>}
                      </button>
                    )}
                  {status === 'connected' && (
                    <span className="flex items-center gap-1 text-[0.6rem] text-green-400">
                      <Wifi size={10} /> Connected
                    </span>
                  )}
                  {status === 'failed' && (
                    <span className="flex items-center gap-1 text-[0.6rem] text-red-400">
                      <WifiOff size={10} /> Failed
                    </span>
                  )}
                  {status === 'stopped' && (
                    <span
                      className="flex items-center gap-1 text-[0.6rem] text-amber-400"
                      title="The engine is installed but not started yet. It starts when you pick a chat model, or when you press Test."
                    >
                      <WifiOff size={10} /> Not running
                    </span>
                  )}
                </div>

                {/* Why it failed, when the app can tell (GH #118). */}
                {status === 'failed' && testDetail[id] && (
                  <p className="text-[0.6rem] text-red-300/90 leading-snug">{testDetail[id]}</p>
                )}

                {/* API key storage disclaimer */}
                {needsKey && currentKey && (
                  <p className="text-[0.5rem] text-gray-600 mt-0.5 leading-tight">
                    Keys are stored locally with basic obfuscation, not encryption. Avoid shared computers.
                  </p>
                )}

                {/* Cloud + auto-extract cost warning */}
                {needsKey && autoExtractEnabled && (
                  <p className="text-[0.55rem] text-amber-400/80 mt-1 leading-tight">
                    Memory auto-extraction runs a secondary inference every 3rd turn, increasing API costs. Disable in Settings &gt; Memory if not needed.
                  </p>
                )}
              </div>
            )}
          </div>
        )
      })}

      {/* The backend that is no longer in the shared local slot. It used to
          vanish without a word, and the way back (Add Provider, Built-in
          Engine) was there but unlabelled. Same shape as the switched-off row
          above, with the reason written out.

          Two ways to land here, and they are not the same state (Nebenbefund 3,
          R12/R13 re-measure): something else TOOK the slot, or the user pressed
          Disable on this backend and the slot went back to the engine waiting
          for it. The first is STANDBY, the second is DISABLED, because that is
          the button the user pressed. Enable and Remove sit on both. */}
      {standby && (
        <div className="rounded-lg border border-white/8 bg-white/[0.01] overflow-hidden">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <button onClick={handBackSlot} className="group flex items-center" title={standbyOff ? 'Switch this backend back on and give it the local slot' : 'Put this backend back in the local slot'}>
              <Power size={10} className="text-gray-500 group-hover:text-green-400 transition-colors" />
            </button>
            <div className="flex-1 flex items-center gap-2 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-gray-600" />
              <span className="text-[0.65rem] text-gray-500 font-medium truncate">{standby.name}</span>
              {standbyOff
                ? <span className="text-[0.5rem] px-1 py-0.5 rounded bg-white/5 text-gray-500 shrink-0">DISABLED</span>
                : <span className="text-[0.5rem] px-1 py-0.5 rounded bg-white/5 text-gray-500 shrink-0">STANDBY</span>}
            </div>
            {standbyIsRemovable(providers.openai) && (
              <button
                data-testid="standby-remove"
                onClick={() => armOrRun('standby', removeStandby)}
                title={`Forget ${standby.name} and stop offering it here`}
                className={`shrink-0 flex items-center gap-1 px-2 py-0.5 rounded border text-[0.6rem] transition-colors ${
                  armedRemove === 'standby'
                    ? 'bg-red-500/15 border-red-500/30 text-red-300 font-medium'
                    : 'bg-white/5 border-white/8 text-gray-500 hover:text-red-300 hover:border-red-500/20'
                }`}
              >
                <Trash2 size={10} />
                {armedRemove === 'standby' ? 'Click again to remove' : 'Remove'}
              </button>
            )}
            <button
              onClick={handBackSlot}
              className="shrink-0 px-2 py-0.5 rounded bg-green-500/10 border border-green-500/20 text-[0.6rem] text-green-300 hover:text-green-200 hover:bg-green-500/15 transition-colors"
            >
              Enable
            </button>
          </div>
          {/* The sentence has to describe the state that is really on screen.
              Disable on the slot holder hands the slot back now, so it cannot
              produce a switched-off holder any more, but onboarding still parks
              this slot without anyone pressing anything, and then the takeover
              wording would be a lie. */}
          {standbyOff ? (
            <p className="px-2 pb-1.5 text-[0.55rem] text-gray-600 leading-snug">
              You switched {standby.name} off, so the local OpenAI compatible slot went back to
              {' '}{providers.openai.name}, which holds it now. Press Enable to switch {standby.name}
              {' '}back on and give it the slot again.
            </p>
          ) : providers.openai.enabled ? (
            <p className="px-2 pb-1.5 text-[0.55rem] text-gray-600 leading-snug">
              {providers.openai.name} took over the local OpenAI compatible slot, which holds one
              backend at a time. Press Enable to hand the slot back to {standby.name}.
              {' '}{providers.openai.name} then waits here in its place.
            </p>
          ) : (
            <p className="px-2 pb-1.5 text-[0.55rem] text-gray-600 leading-snug">
              {providers.openai.name} holds the local OpenAI compatible slot and is switched off,
              so no local backend is running. Press Enable to give the slot back to {standby.name}.
            </p>
          )}
        </div>
      )}

      {/* No backend warning. With a switched-off row on screen the honest
          sentence names that row first, because pressing Enable on it is the
          shorter way back than adding a provider again. */}
      {noBackend && (
        <p className="text-[0.6rem] text-red-400">
          {rowIds.length > 0
            ? 'No backend is enabled. Press Enable on one above, or add one below, to start chatting.'
            : 'No backend configured. Add one below to start chatting.'}
        </p>
      )}

      {/* Add Provider Dropdown */}
      <div className="relative">
        <button
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className="w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded bg-white/5 border border-white/8 text-[0.65rem] text-gray-500 hover:text-gray-300 hover:border-white/15 transition-colors"
        >
          <Plus size={10} />
          <span>Add Provider</span>
        </button>
        {dropdownOpen && (
          <div className="absolute z-50 top-full mt-1 w-full bg-[#363636] border border-white/10 rounded-lg shadow-xl max-h-56 overflow-y-auto scrollbar-thin">
            {/* Local group */}
            <div className="px-2.5 py-1 text-[0.5rem] uppercase tracking-wider text-gray-600 font-semibold">Local</div>
            {localPresets.map(preset => {
              const isActive = enabledProviderIds.includes(preset.providerId) &&
                (preset.providerId !== 'openai' || providers.openai.name === preset.name)
              return (
                <button
                  key={preset.id}
                  onClick={() => selectPreset(preset)}
                  className={`w-full text-left px-2.5 py-1.5 text-[0.65rem] transition-colors ${
                    isActive ? 'bg-white/10 text-white' : 'text-gray-300 hover:bg-white/5'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{preset.name}</span>
                    {isActive && <span className="text-[0.5rem] text-green-400">Active</span>}
                  </div>
                  {preset.baseUrl && <span className="block text-[0.55rem] text-gray-500 font-mono">{preset.baseUrl}</span>}
                </button>
              )
            })}

            {/* Cloud group */}
            <div className="px-2.5 py-1 mt-1 border-t border-white/[0.06] text-[0.5rem] uppercase tracking-wider text-gray-600 font-semibold">Cloud</div>
            {cloudPresets.map(preset => {
              const isActive = enabledProviderIds.includes(preset.providerId) &&
                (preset.providerId !== 'openai' || providers.openai.name === preset.name)
              return (
                <button
                  key={preset.id}
                  onClick={() => selectPreset(preset)}
                  className={`w-full text-left px-2.5 py-1.5 text-[0.65rem] transition-colors ${
                    isActive ? 'bg-white/10 text-white' : 'text-gray-300 hover:bg-white/5'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{preset.name}</span>
                    {isActive && <span className="text-[0.5rem] text-green-400">Active</span>}
                  </div>
                  {preset.baseUrl && <span className="block text-[0.55rem] text-gray-500 font-mono">{preset.baseUrl}</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Cloud privacy warning popup */}
      <Modal open={showCloudWarning} onClose={() => { setShowCloudWarning(false); setPendingPreset(null) }} title="">
        <div className="space-y-4 text-center">
          <h3 className="text-base font-semibold text-white">Enable Cloud Provider</h3>
          <p className="text-[0.75rem] text-gray-400 leading-relaxed">
            Cloud providers send your data to external servers. Your conversations will no longer be fully private or offline.
          </p>
          <p className="text-[0.75rem] text-gray-400 leading-relaxed">
            For maximum privacy, use Ollama or a local backend instead.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={() => { setShowCloudWarning(false); setPendingPreset(null) }}
              className="px-4 py-1.5 rounded-lg text-[0.7rem] text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                if (pendingPreset) applyPreset(pendingPreset)
                setShowCloudWarning(false)
                setPendingPreset(null)
              }}
              className="px-4 py-1.5 rounded-lg text-[0.7rem] font-medium bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 transition-colors"
            >
              Continue
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
