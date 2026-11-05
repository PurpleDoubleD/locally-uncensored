import { useState, useEffect, useRef } from 'react'
import { usePopoverPlatz } from '../../hooks/usePopoverPlatz'
import { Wifi, WifiOff, Loader2, Eye, EyeOff, ChevronDown, Plus, Power, Play, Trash2, X, AlertTriangle } from 'lucide-react'
import { useProviderStore, deobfuscate } from '../../stores/providerStore'
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
  takeoverClearsApiKey,
} from '../../lib/openai-slot-handover'
import { getProvider, getOpenAIEntryProvider } from '../../api/providers'
import { placeBackend, sameEndpoint } from '../../lib/openai-entries'
import { useSettingsStore } from '../../stores/settingsStore'
import { MAX_EXTRA_MODEL_IDS, endpointKey, parseExtraModelIds } from '../../lib/extra-model-ids'
import { PROVIDER_PRESETS } from '../../api/providers/types'
import { Modal } from '../ui/Modal'
import { ModalActions, ModalButton } from '../ui/ModalActions'
import { backendCall } from '../../api/backend'
import { diagnoseBuiltinEngine, readBuiltinSlotStatus } from '../../api/builtin-ensure'
import { useBuiltinEngineStatus } from '../../hooks/useBuiltinEngineStatus'
import { reachVerdict, liveSlotStatus, type SlotStatus } from '../../lib/builtin-slot-status'
import type { ProviderId, ProviderConfig } from '../../api/providers/types'
import { disabledSlotNote } from '../../lib/disabled-slot-note'
import { HINWEIS_TEXT, HINWEIS_ZEILE, PUNKT_FARBE } from '../../lib/hinweis'
import { parkApiKeyForBackend, restoreParkedApiKeyForBackend } from '../../lib/parked-key'
import { isBuiltinEngineMissing } from '../../lib/builtin-engine-presence'
import { providerBadgeClass } from '../../lib/provider-badge'
import { engineNoticeDismissed as engineNoticeDismissedThisSession, dismissEngineNoticeForSession, resetEngineNoticeDismissal } from '../../lib/engine-notice-session'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

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
    // A13, Windows counter-check 2026-09-02: "nothing to configure" was true
    // and useless. The engine starts its walk at 8127 and moves to the next
    // free port when that one is held, and this row is where the address of a
    // backend belongs. It is the live slot URL, which api/engine keeps on the
    // port the engine really holds.
    return {
      label: preset.name || config.name,
      presetId: preset.id,
      endpointEditable: false,
      needsKey: false,
      note: config.baseUrl
        ? `LU Engine, runs locally on ${config.baseUrl}, nothing to configure.`
        : 'LU Engine, runs locally, nothing to configure.',
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
// existing `start_lmstudio_server` Tauri command, same surface the
// onboarding's Fix-(d) card uses. This keeps the user inside LU instead
// of forcing them through Re-run-onboarding to recover from a
// transient server outage.
type LmStudioServerInfo = { lms_present: boolean; running: boolean }

export function ProviderSettings() {
  const {
    providers, setProviderConfig, setProviderApiKey, getProviderApiKey, engineOptedOut,
    openaiEntries, addOpenAIEntry, updateOpenAIEntry, setOpenAIEntryApiKey,
  } = useProviderStore()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const dropdown = usePopoverPlatz(dropdownRef, dropdownOpen, { deckel: 224 })
  const [testing, setTesting] = useState<ProviderId | null>(null)
  const [statuses, setStatuses] = useState<Record<string, SlotStatus>>({})
  // Der laufende Zustand unserer eigenen Engine, dieselbe Schleife, die der
  // Abschnitt LU Engine (expert) weiter unten liest. Gegenprobe G2: ohne sie
  // blieb der Punkt in dieser Liste 150 Sekunden gruen, waehrend derselbe
  // Bildschirm "Engine not running" meldete.
  const engineAnswer = useBuiltinEngineStatus()
  // Per-slot English explanation for a failed Test (GH #118).
  const [testDetail, setTestDetail] = useState<Record<string, string>>({})
  const [showKey, setShowKey] = useState<Record<string, boolean>>({})
  const [showCloudWarning, setShowCloudWarning] = useState(false)
  const [pendingPreset, setPendingPreset] = useState<typeof PROVIDER_PRESETS[0] | null>(null)
  // Review-Runde 2, Punkt 5: a takeover the OS keychain cannot durably park.
  // See wouldLoseApiKeyOnRestart below for why this exists.
  const [showKeyLossWarning, setShowKeyLossWarning] = useState(false)
  // A slot id, or `entry:<id>` for an additional OpenAI-compatible entry
  // (GitHub #173), so one row at a time is open across both lists.
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  // R13D Nebenfund 1: LU Engine can fall out of the `openai` slot entirely
  // (see lib/builtin-engine-presence.ts for the read and the root cause).
  // Dismissal is session-only, not persisted: a restart re-checks the slot
  // and shows the notice again while the engine is still missing, so a
  // dismissed notice never hides a standing problem across restarts. It also
  // resets the moment the engine is back, so dismissing today's notice does
  // not silently swallow tomorrow's.
  // Sitzungsweit und an EINER Stelle gemerkt, damit das X hier und das X im
  // Modellmenue des Chats dasselbe X sind (lib/engine-notice-session.ts).
  const [engineNoticeDismissed, setEngineNoticeDismissed] = useState(engineNoticeDismissedThisSession)
  // Opus review: `managed: false` with no `displaced` record is also the
  // shape a customer who picked Ollama or LM Studio on purpose leaves
  // behind (onboarding, the startup backend selector, Start LM Studio
  // Server). `engineOptedOut` is how those are told apart from the R13D
  // eviction bug; see lib/builtin-engine-presence.ts.
  const engineMissing = isBuiltinEngineMissing(providers.openai, engineOptedOut)
  // Reset the dismissal the moment the condition itself changes, adjusted
  // during render rather than in an effect (react-hooks/set-state-in-effect):
  // this is the "state that resets when a prop changes" case the React docs
  // call out, not a cascading-render trap. It keeps a dismissed notice from
  // hiding a DIFFERENT missing-engine episode than the one the user dismissed.
  const [engineWasMissing, setEngineWasMissing] = useState(engineMissing)
  if (engineMissing !== engineWasMissing) {
    setEngineWasMissing(engineMissing)
    if (!engineMissing) {
      resetEngineNoticeDismissal()
      setEngineNoticeDismissed(false)
    }
  }


  // Bug (g) state, LM-Studio-on-disk-but-server-off detection.
  const [lmStudioInfo, setLmStudioInfo] = useState<LmStudioServerInfo | null>(null)
  const [startingLmStudioServer, setStartingLmStudioServer] = useState(false)

  const refreshLmStudioInfo = async () => {
    if (!isTauri) return
    try {
      const status = await backendCall<LmStudioServerInfo>('lmstudio_server_status')
      setLmStudioInfo(status)
    } catch { /* command unavailable on older builds, leave null */ }
  }

  // One status for one slot, and never a verdict nobody earned.
  //
  // GH #118 leftover, counter-check 2026-08-29: right after app start, with no
  // chat model loaded, this row read "Failed" for the app's OWN engine, and
  // the click that disproved it printed ERR_CONNECTION_REFUSED on 127.0.0.1:8127
  // in the console first. The app starts that process itself, so it can simply
  // ask whether it runs. An engine that was never started is "Not running",
  // which is a true sentence and also a different one from "Failed".
  /**
   * Wie viele Modelle dieser Anbieter gerade wirklich anbietet.
   *
   * `null` heisst "nicht beantwortbar" und nicht "keine": ein Anbieter ohne
   * Liste oder ein Fehler beim Holen darf ein bereits gemessenes Connected
   * nicht kaputtreden. Kostet eine zweite Anfrage an denselben lokalen Port,
   * die `checkConnection` schon kennt, und das ist der Preis dafuer, dass die
   * Anbieterschnittstelle bleibt, wie sie ist: Anthropic prueft mit einem
   * echten POST, dessen Modellliste steht fest im Code.
   */
  const countModels = async (id: ProviderId): Promise<number | null> => {
    try {
      const list = await getProvider(id).listModels()
      return Array.isArray(list) ? list.length : null
    } catch {
      return null
    }
  }

  const probeSlot = async (id: ProviderId): Promise<SlotStatus> => {
    if (id === 'openai') {
      const known = await readBuiltinSlotStatus()
      // 'connected' or 'stopped' answers it without touching a socket. Only an
      // engine that is up but not yet answering falls through to a real probe.
      // Ein 'connected' von hier geht trotzdem durch dieselbe Verfeinerung wie
      // der Test-Knopf, sonst sagen Aufschlag und Klick zwei verschiedene
      // Dinge ueber dieselbe Zeile. Die Anfrage kommt nur bei einer gesunden
      // Maschine dazu, der stumme Fall aus GH #118 bleibt stumm.
      if (known) return known === 'connected' ? reachVerdict(true, await countModels(id)) : known
    }
    let reachable = false
    try {
      reachable = await getProvider(id).checkConnection()
    } catch {
      reachable = false
    }
    return reachVerdict(reachable, reachable ? await countModels(id) : null)
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

  // Opus-Review Nachbesserung 6 (3.0.1, F3) + R9: every path below that hands
  // the shared `openai` slot to a REMEMBERED backend (Remove on the
  // occupant, Enable on the standby card, Disable swapping it back in) must
  // restore that backend's own key too, not just its name/URL. R9's OS
  // keychain (secret_park_get, via restoreParkedApiKeyForBackend) is tried
  // FIRST, since a key parked there survives an app restart; `displaced.
  // apiKey` (F3, session-only) is the fallback for a device with no
  // keychain, or a `displaced` record written before R9 existed. Through
  // setProviderApiKey, not a plain field merge: that is the call that keeps
  // the OS keychain in step with the store, and it has to run AFTER
  // setProviderConfig so it is the last word on `openai`'s key field. No
  // parked key anywhere (a backend that never had one) clears it instead of
  // leaving the key of whichever backend just left sitting there under a
  // new name.
  async function restoreParkedApiKey(backendName: string | undefined, parkedObfuscated: string | undefined) {
    const fromKeychain = backendName ? await restoreParkedApiKeyForBackend(backendName) : null
    setProviderApiKey('openai', fromKeychain !== null ? fromKeychain : (parkedObfuscated !== undefined ? deobfuscate(parkedObfuscated) : ''))
  }

  // Remove on the backend that holds the shared local slot: the slot goes back
  // to what it held before the takeover, and the removed backend is forgotten
  // instead of parked on standby. Offered only where `displaced` knows a state
  // to return to, so the app's own engine and the three other slots have no
  // Remove at all.
  async function removeOccupant() {
    const update = slotRemoveOccupantUpdate(providers.openai)
    if (!update) return
    const displaced = providers.openai.displaced
    setProviderConfig('openai', update)
    await restoreParkedApiKey(displaced?.name, displaced?.apiKey)
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
  async function handBackSlot() {
    const update = slotHandbackUpdate(providers.openai)
    if (!update) return
    const displaced = providers.openai.displaced
    setProviderConfig('openai', update)
    await restoreParkedApiKey(displaced?.name, displaced?.apiKey)
    setStatuses(prev => ({ ...prev, openai: 'idle' }))
    setExpandedProvider('openai')
  }

  // GitHub #173: "Run side by side" on the standby card. Instead of choosing
  // which of the two backends holds the slot, both run: the one that is not
  // the LU Engine gets its own entry, with its own key, and the LU Engine (or
  // whoever held the slot) keeps or gets the slot. Nothing is forgotten.
  async function runSideBySide() {
    const slot = providers.openai
    const waiting = standbyOccupant(slot)
    if (!waiting) return
    const already = (url: string) => openaiEntries.find((e) => sameEndpoint(e.baseUrl, url))
    if (waiting.managed) {
      // The LU Engine waits: the backend in the slot moves to an entry and
      // the engine gets its slot back.
      const update = slotRemoveOccupantUpdate(slot)
      if (!update) return
      const key = getProviderApiKey('openai')
      const known = already(slot.baseUrl)
      const entryId = known?.entryId ?? addOpenAIEntry({ name: slot.name, baseUrl: slot.baseUrl, isLocal: slot.isLocal })
      if (key && !known) setOpenAIEntryApiKey(entryId, key)
      if (!slot.enabled) updateOpenAIEntry(entryId, { enabled: false, disabledByUser: true })
      else if (known) updateOpenAIEntry(entryId, { enabled: true, disabledByUser: false })
      setProviderConfig('openai', update)
      await restoreParkedApiKey(waiting.name, waiting.apiKey)
      setStatuses(prev => ({ ...prev, openai: 'idle' }))
      setExpandedProvider(entryRowKey(entryId))
      return
    }
    // Another backend waits: it gets the entry, the slot forgets it.
    const update = slotForgetStandbyUpdate(slot)
    if (!update) return
    const parked = await restoreParkedApiKeyForBackend(waiting.name)
    const key = parked !== null ? parked : (waiting.apiKey ? deobfuscate(waiting.apiKey) : '')
    const known = already(waiting.baseUrl)
    const entryId = known?.entryId ?? addOpenAIEntry({ name: waiting.name, baseUrl: waiting.baseUrl, isLocal: waiting.isLocal })
    if (key && !known) setOpenAIEntryApiKey(entryId, key)
    if (known) updateOpenAIEntry(entryId, { enabled: true, disabledByUser: false })
    setProviderConfig('openai', update)
    setExpandedProvider(entryRowKey(entryId))
  }

  // Review-Runde 2, Punkt 5 (F3) + R9: whether accepting `preset` into the
  // shared `openai` slot would destroy a currently-set, non-empty API key
  // with no way to bring it back. R9 tries to prevent that outright: the
  // outgoing key is parked in the OS keychain (parkApiKeyForBackend,
  // survives an app restart) before this function answers, and only a
  // FAILED park still counts as a loss, e.g. no keychain on this device
  // (Linux, or the LU_NO_KEYCHAIN test switch), in which case F3's warning
  // card is shown so the loss is a choice made with eyes open instead of a
  // 401 the next time the backend returns.
  async function wouldLoseApiKeyOnRestart(preset: typeof PROVIDER_PRESETS[0]): Promise<boolean> {
    if (preset.providerId === 'ollama' || preset.providerId === 'anthropic') return false
    // GitHub #173: a backend that gets its own entry takes nothing from the slot.
    if (placeBackend(providers.openai, openaiEntries, preset).kind !== 'slot') return false
    const incoming = { name: preset.name, baseUrl: preset.baseUrl, isLocal: preset.isLocal, managed: preset.managed }
    if (!(takeoverClearsApiKey(providers.openai, incoming) && getProviderApiKey('openai') !== '')) return false
    const parked = await parkApiKeyForBackend(providers.openai.name, getProviderApiKey('openai'))
    return !parked
  }

  // Add a preset (enable a provider without disabling others)
  async function selectPreset(preset: typeof PROVIDER_PRESETS[0]) {
    if (!preset.isLocal) {
      setPendingPreset(preset)
      setShowCloudWarning(true)
      return
    }
    if (await wouldLoseApiKeyOnRestart(preset)) {
      setPendingPreset(preset)
      setShowKeyLossWarning(true)
      return
    }
    applyPreset(preset)
  }

  /** The address a preset row stands for: Ollama's is the configured one. */
  function presetAddress(preset: typeof PROVIDER_PRESETS[0]): string {
    if (preset.providerId === 'ollama') return providers.ollama?.baseUrl?.trim() || preset.baseUrl
    return preset.baseUrl
  }

  function applyPreset(preset: typeof PROVIDER_PRESETS[0]) {
    // GitHub #173: an OpenAI-compatible backend no longer has to push the one
    // in the slot out. While the slot is on and serves something else, the
    // new backend gets its own entry next to it (lib/openai-entries.ts).
    const place = placeBackend(providers.openai, openaiEntries, preset)
    if (place.kind === 'entry-existing') {
      updateOpenAIEntry(place.entryId, { enabled: true, disabledByUser: false })
      setDropdownOpen(false)
      setExpandedProvider(entryRowKey(place.entryId))
      return
    }
    if (place.kind === 'entry-new') {
      const entryId = addOpenAIEntry({ name: preset.name, baseUrl: preset.baseUrl, isLocal: preset.isLocal })
      setDropdownOpen(false)
      setExpandedProvider(entryRowKey(entryId))
      return
    }
    // Enable the selected provider WITHOUT disabling others
    if (preset.providerId === 'ollama') {
      // Jaeger B, B7: the slot already carries the address Rust resolved
      // (config.json > OLLAMA_HOST) or the one typed in by hand. Picking
      // Ollama turns it on there; the preset's localhost:11434 is only for
      // a slot that has no address at all.
      setProviderConfig('ollama', { enabled: true, baseUrl: presetAddress(preset) })
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
      // F3 (3.0.1, T4 Nebenfund): a real takeover must not leave the
      // displaced backend's API key sitting in the shared slot's field,
      // see takeoverClearsApiKey in lib/openai-slot-handover.ts. Checked
      // against the same shape slotTakeoverUpdate itself reads below.
      if (takeoverClearsApiKey(providers.openai, {
        name: preset.name, baseUrl: preset.baseUrl, isLocal: preset.isLocal, managed: preset.managed,
      })) {
        setProviderApiKey('openai', '')
      }
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
        const displaced = providers.openai.displaced
        setProviderConfig('openai', handback)
        void restoreParkedApiKey(displaced?.name, displaced?.apiKey)
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
    // Erreichbar ist nicht chatbereit. Derselbe Spruch wie beim Aufschlag oben,
    // damit der Knopf und die Zeile daneben nie zwei Dinge behaupten.
    const verdict = reachVerdict(ok, ok ? await countModels(providerId) : null)
    setStatuses(prev => ({ ...prev, [providerId]: verdict }))
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

  const noBackend = enabledProviderIds.length === 0 && !openaiEntries.some((e) => e.enabled)

  return (
    <div className="space-y-2">
      {/* Windows-Bau t14, Bild 38-lmstudio-added.png: diese Zeile war knallrot,
          Dreieck rot, X rot, und der Restore-Knopf ein eigenes Kaestchen. Der
          Eigner will "unauffaellig, aber so, dass man es sieht", also derselbe
          ruhige Ton wie die Zeile oben im Modellmenue: Text in gedecktem Grau,
          Akzent nur fuer den Textknopf, eine Zeile, kein Kasten. Verhalten,
          Texte und selectPreset unveraendert, `role="alert"` bleibt, die Farbe
          war nie das, was die Zeile ankuendigt.
          Das Warnsymbol bleibt im selben Grau statt in Amber: Gelb und Amber
          sind in dieser Oberflaeche verboten (lib/hinweis.ts, Waechter
          lib/__tests__/kein-gelb-in-der-oberflaeche.test.ts), und es gibt
          keinen dritten Ton. */}
      {engineMissing && !engineNoticeDismissed && (
        <div
          role="alert"
          data-testid="engine-missing-notice"
          className={`${HINWEIS_ZEILE} ${HINWEIS_TEXT.ruhig} px-1`}
        >
          <AlertTriangle size={11} className="shrink-0 mt-0.5" />
          <span className="flex-1 min-w-0">
            LU Engine is missing from your providers. Restore it below.
          </span>
          <button
            onClick={() => selectPreset(PROVIDER_PRESETS.find(p => p.id === 'builtin')!)}
            className="self-center shrink-0 text-lu-accent underline underline-offset-2"
          >
            Restore LU Engine
          </button>
          <button
            onClick={() => { dismissEngineNoticeForSession(); setEngineNoticeDismissed(true) }}
            className="self-center shrink-0 rounded p-[1px] opacity-70 hover:opacity-100 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            aria-label="Dismiss"
            title="Dismiss"
          >
            <X size={11} />
          </button>
        </div>
      )}
      {/* Providers List: enabled rows, plus the ones the user switched off */}
      {rowIds.map(id => {
        const config = providers[id]
        const view = providerSlotView(id, config)

        // Switched off by the user: the row stays and carries the way back.
        // Nothing to test and nothing to configure while it is off, so the row
        // is one line: the Power toggle where every other row carries it, the
        // Enable button, and the note underneath.
        if (isReturnableRow(config)) {
          return (
            <div key={id} className="rounded-lg border border-white/8 bg-white/[0.01] overflow-hidden">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <button
                  onClick={() => toggleProvider(id)}
                  className="group flex items-center"
                  title="Enable provider"
                >
                  <Power size={10} className="text-gray-500 group-hover:text-green-600 dark:group-hover:text-green-400 transition-colors" />
                </button>
                <div className="flex-1 flex items-center gap-2 min-w-0">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-gray-600" />
                  <span className="text-[0.65rem] text-gray-500 font-medium truncate">{view.label}</span>
                  <span className="t-micro px-1 py-0.5 rounded bg-white/5 text-gray-500 shrink-0">DISABLED</span>
                </div>
                <button
                  onClick={() => toggleProvider(id)}
                  className="shrink-0 px-2 py-0.5 rounded bg-green-500/10 border border-green-500/20 text-[0.6rem] text-green-300 hover:text-green-200 hover:bg-green-500/15 transition-colors"
                >
                  Enable
                </button>
              </div>
              <p className="px-2 pb-1.5 text-[0.55rem] text-gray-600 leading-snug">
                {disabledSlotNote(config?.managed === true)}
              </p>
            </div>
          )
        }
        const needsKey = view.needsKey
        const currentKey = getProviderApiKey(id)
        // Unsere eigene Engine kennt ihren Zustand besser als eine Sonde, die
        // einmal beim Aufbauen lief: fuer sie entscheidet die laufende
        // Schleife, sonst der Sondenwert.
        const status = liveSlotStatus(id, config, engineAnswer) ?? statuses[id] ?? 'idle'
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
                <Power size={10} className="text-green-600 dark:text-green-400 group-hover:text-red-600 dark:group-hover:text-red-400 transition-colors" />
              </button>
              <button
                onClick={() => setExpandedProvider(isExpanded ? null : id)}
                className="flex-1 flex items-center justify-between min-w-0"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {/* Gegenprobe G2, 04.09.2026: dieser Punkt blieb 150 Sekunden
                      lang gruen, waehrend derselbe Bildschirm zwei Zentimeter
                      tiefer "Engine not running" meldete. Der Grund war die
                      Uhr: der Zustand wurde EINMAL beim Aufbauen geholt und nie
                      wieder. Fuer unsere eigene Engine liest der Punkt jetzt
                      dieselbe laufende Schleife wie der Abschnitt darunter, und
                      die beiden koennen nicht mehr zwei Dinge behaupten. */}
                  <Zustandspunkt status={status} />
                  <span className="text-[0.65rem] text-gray-300 font-medium truncate">{view.label}</span>
                  {config.managed && <span className={providerBadgeClass('default')}>DEFAULT</span>}
                  {config.isLocal && <span className={providerBadgeClass('local')}>LOCAL</span>}
                  {!config.isLocal && <span className={providerBadgeClass('cloud')}>CLOUD</span>}
                  <Zustandssymbol status={status} />
                </div>
                <ChevronDown size={10} className={`text-gray-500 transition-transform shrink-0 ${isExpanded ? 'rotate-180' : ''}`} />
              </button>
            </div>

            {/* Expanded config */}
            {isExpanded && (
              <div className="px-2 pb-2 space-y-1.5 border-t border-white/[0.04]">
                {/* Endpoint, an edit box only where editing it does something.
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
                    <label className="text-[0.6rem] text-gray-500 mb-0.5 block" htmlFor={`provider-url-${id}`}>Endpoint</label>
                    <input
                      id={`provider-url-${id}`}
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
                    <label className="text-[0.6rem] text-gray-500 mb-0.5 block" htmlFor={`provider-key-${id}`}>API Key</label>
                    <div className="relative">
                      <input
                        id={`provider-key-${id}`}
                        type={isKeyVisible ? 'text' : 'password'}
                        value={currentKey}
                        onChange={(e) => setProviderApiKey(id, e.target.value)}
                        placeholder={view.placeholder || 'sk-...'}
                        className="w-full px-2 py-1 pr-7 rounded bg-white/5 border border-white/8 text-[0.65rem] text-gray-300 font-mono focus:outline-none focus:border-white/20"
                      />
                      <button
                        onClick={() => setShowKey(prev => ({ ...prev, [id]: !isKeyVisible }))}
                        aria-label={isKeyVisible ? 'Hide API key' : 'Show API key'}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                      >
                        {isKeyVisible ? <EyeOff size={10} /> : <Eye size={10} />}
                      </button>
                    </div>
                  </div>
                )}

                {/* GitHub #112: a model the server serves but does not list. */}
                {id === 'openai' && view.endpointEditable && (
                  <ExtraModelIdsField baseUrl={config.baseUrl} />
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
                  <Statusfeld status={status} />
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

                {/* Die Kostenzeile der Erinnerungs-Extraktion stand hier, hinter
                    `needsKey`. `lu-cloud` braucht keinen Schluessel, also las
                    genau der Kunde sie nie, dem der stille Aufruf wirklich
                    berechnet wird (R5-41). Sie steht jetzt an einer Stelle,
                    neben dem Schalter in Settings > Memory. */}
              </div>
            )}
          </div>
        )
      })}

      {/* GitHub #173: the additional OpenAI-compatible backends, each with its
          own address, key and model list, next to the slot instead of in it. */}
      {openaiEntries.map((entry) => (
        <OpenAIEntryRow
          key={entry.entryId}
          entry={entry}
          expanded={expandedProvider === entryRowKey(entry.entryId as string)}
          onToggleExpanded={() => {
            const k = entryRowKey(entry.entryId as string)
            setExpandedProvider(expandedProvider === k ? null : k)
          }}
        />
      ))}

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
              <Power size={10} className="text-gray-500 group-hover:text-green-600 dark:group-hover:text-green-400 transition-colors" />
            </button>
            <div className="flex-1 flex items-center gap-2 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-gray-600" />
              <span className="text-[0.65rem] text-gray-500 font-medium truncate">{standby.name}</span>
              {standbyOff
                ? <span className="t-micro px-1 py-0.5 rounded bg-white/5 text-gray-500 shrink-0">DISABLED</span>
                : <span className="t-micro px-1 py-0.5 rounded bg-white/5 text-gray-500 shrink-0">STANDBY</span>}
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
            {(!standby.managed || occupantIsRemovable(providers.openai)) && (
              <button
                data-testid="standby-side-by-side"
                onClick={() => { void runSideBySide() }}
                title={standby.managed
                  ? `Give the slot back to ${standby.name} and keep ${providers.openai.name} as its own backend`
                  : `Keep ${providers.openai.name} in the slot and add ${standby.name} as its own backend`}
                className="shrink-0 px-2 py-0.5 rounded bg-white/5 border border-white/8 text-[0.6rem] text-gray-300 hover:text-gray-100 hover:bg-white/8 transition-colors"
              >
                Run side by side
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
              {providers.openai.name} took over the local OpenAI compatible slot from {standby.name}.
              Press Run side by side to keep both, each with its own models. Press Enable to hand the slot back to {standby.name}.
            </p>
          ) : (
            <p className="px-2 pb-1.5 text-[0.55rem] text-gray-600 leading-snug">
              {providers.openai.name} holds the local OpenAI compatible slot and is switched off,
              so no local backend is running in it. Press Enable to give the slot back to {standby.name},
              or Run side by side to keep both.
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
        {/* Hellmodus-Luecke aus Welle 2, in f336b91e gemeldet statt
            geaendert. Die Flaeche war fest auf #363636 gesetzt, OHNE `dark:`, blieb im
            Hellmodus also dunkel, waehrend der Rescue-Layer in index.css
            die Schrift darin nach unten dreht (`.light .text-gray-500 →
            #374151`). Ergebnis: #374151 auf #363636 = 1,17:1, praktisch
            unsichtbar; jetzt 10,31:1. Kein zweites Literal, sondern
            derselbe Tokenwechsel wie in ChatView (f336b91e). Das gruene
            „Active" stand auf Weiss bei 1,74:1 und traegt jetzt green-700
            mit 5,02:1. */}
        {dropdownOpen && (
          <div ref={dropdownRef} style={dropdown.style} className={`absolute z-50 w-full lu-elevated rounded-lg overflow-y-auto scrollbar-thin ${dropdown.nachOben ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
            {/* Local group */}
            <div className="px-2.5 py-1 text-[0.5rem] uppercase tracking-wider text-gray-600 font-semibold">Local</div>
            {localPresets.map(preset => {
              const isActive = (enabledProviderIds.includes(preset.providerId) &&
                (preset.providerId !== 'openai' || providers.openai.name === preset.name)) ||
                (preset.providerId === 'openai' && openaiEntries.some((e) => e.enabled && sameEndpoint(e.baseUrl, preset.baseUrl)))
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
                    {isActive && <span className="text-[0.5rem] text-green-700 dark:text-green-400">Active</span>}
                  </div>
                  {presetAddress(preset) && <span className="block text-[0.55rem] text-gray-500 font-mono">{presetAddress(preset)}</span>}
                </button>
              )
            })}

            {/* Cloud group */}
            <div className="px-2.5 py-1 mt-1 border-t border-white/[0.06] text-[0.5rem] uppercase tracking-wider text-gray-600 font-semibold">Cloud</div>
            {cloudPresets.map(preset => {
              const isActive = (enabledProviderIds.includes(preset.providerId) &&
                (preset.providerId !== 'openai' || providers.openai.name === preset.name)) ||
                (preset.providerId === 'openai' && openaiEntries.some((e) => e.enabled && sameEndpoint(e.baseUrl, preset.baseUrl)))
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
                    {isActive && <span className="text-[0.5rem] text-green-700 dark:text-green-400">Active</span>}
                  </div>
                  {presetAddress(preset) && <span className="block text-[0.55rem] text-gray-500 font-mono">{presetAddress(preset)}</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Cloud privacy warning popup */}
      <Modal open={showCloudWarning} onClose={() => { setShowCloudWarning(false); setPendingPreset(null) }} title="Enable Cloud Provider">
        <div className="space-y-3">
          <p className="text-[12px] text-gray-400 leading-relaxed">
            Cloud providers send your data to external servers. Your conversations will no longer be fully private or offline.
          </p>
          <p className="text-[12px] text-gray-400 leading-relaxed">
            For maximum privacy, use Ollama or a local backend instead.
          </p>
          <ModalActions>
            <ModalButton variant="quiet" onClick={() => { setShowCloudWarning(false); setPendingPreset(null) }}>
              Cancel
            </ModalButton>
            <ModalButton
              variant="primary"
              onClick={() => {
                setShowCloudWarning(false)
                void (async () => {
                  if (pendingPreset && await wouldLoseApiKeyOnRestart(pendingPreset)) {
                    setShowKeyLossWarning(true)
                    return
                  }
                  if (pendingPreset) applyPreset(pendingPreset)
                  setPendingPreset(null)
                })()
              }}
            >
              Continue
            </ModalButton>
          </ModalActions>
        </div>
      </Modal>

      {/* Review-Runde 2, Punkt 5: standby key not surviving a restart. Only
          reached now (R9) when parkApiKeyForBackend already tried and
          failed to place the key in the OS keychain, so it stays accurate:
          this device really has nowhere durable to keep it. */}
      <Modal open={showKeyLossWarning} onClose={() => { setShowKeyLossWarning(false); setPendingPreset(null) }} title="API Key Will Be Lost">
        <div className="space-y-3" data-testid="key-loss-warning-modal">
          <p className="t-control text-gray-400 leading-relaxed">
            The current OpenAI-compatible backend has an API key set, and this device has no OS keychain LU could safely park it in. Switching backends clears it from this slot, and it will NOT survive an app restart while parked.
          </p>
          <p className="t-control text-gray-400 leading-relaxed">
            If you switch back to this backend later, you will need to enter the key again.
          </p>
          <ModalActions>
            <ModalButton variant="quiet" onClick={() => { setShowKeyLossWarning(false); setPendingPreset(null) }}>
              Cancel
            </ModalButton>
            <ModalButton
              variant="primary"
              onClick={() => {
                if (pendingPreset) applyPreset(pendingPreset)
                setShowKeyLossWarning(false)
                setPendingPreset(null)
              }}
            >
              Switch Anyway
            </ModalButton>
          </ModalActions>
        </div>
      </Modal>
    </div>
  )
}

/**
 * Was neben Test und Disable steht, in einer Zeile statt in vier Abschriften.
 *
 * Vier waren es, als "Reachable, no models" dazukam, und die vierte entstand
 * durch Abschreiben der dritten, genau der Zug, den die Typo-Sperrklinke in
 * `die-typo-leiter-und-ihre-umgehung.test.ts` verhindern soll. Eine
 * Groessenangabe, ein Abstand, vier Saetze.
 *
 * Die Toene sind eine Aussage, kein Geschmack: Gruen heisst auf dieser Zeile
 * "du kannst jetzt chatten", Rot heisst "gemessen und kaputt". Ein laufender
 * Server ohne Modell und eine nie gestartete Engine sind weder das eine noch
 * das andere, also sind sie ruhig. Beide trugen frueher einen eigenen
 * Bernstein, und der hat sie zu halben Fehlern gemacht; die Begruendung, warum
 * es diesen dritten Ton nicht mehr gibt, steht in lib/hinweis.ts.
 */
const SLOT_TEXTE: Partial<Record<SlotStatus, { text: string; ton: string; testid?: string; title?: string }>> = {
  connected: { text: 'Connected', ton: 'text-green-600 dark:text-green-400' },
  failed: { text: 'Failed', ton: 'text-red-600 dark:text-red-400' },
  stopped: {
    text: 'Not running',
    ton: HINWEIS_TEXT.ruhig,
    title: 'The engine is installed but not started yet. It starts when you pick a chat model, or when you press Test.',
  },
  'no-models': {
    text: 'Reachable, no models',
    ton: HINWEIS_TEXT.ruhig,
    testid: 'provider-no-models',
    title: 'The server answered, but it offers no models, so no chat can run on it yet. Load or download a model in that backend, then press Test again.',
  },
}

/**
 * Der farbige Punkt am Anfang der zugeklappten Anbieterzeile.
 *
 * Drei Farben, keine vierte (lib/hinweis.ts): Gruen heisst hier "du kannst
 * chatten", Rot heisst "gemessen und kaputt", und alles dazwischen ist Grau.
 * "Not running" und "Reachable, no models" hatten frueher einen eigenen
 * Bernstein, der sie zu halben Fehlern machte; sie fallen jetzt mit 'idle' in
 * denselben ruhigen Punkt.
 *
 * Was die Farbe HEISST, stand nirgends. Der Punkt trug weder `title` noch
 * `aria-label`, also sah, wer die Zeile nicht aufklappt, einen Farbfleck ohne
 * Erklaerung, und fuer einen Screenreader gab es ihn gar nicht: die Zustaende
 * standen nur im Statusfeld im aufgeklappten Koerper. Das Wort kommt deshalb
 * aus SLOT_TEXTE, derselben Quelle wie dieses Statusfeld. Zwei Woerter fuer
 * denselben Zustand waeren nur die naechste Luecke.
 *
 * Kein Wort heisst kein Anspruch: solange noch niemand gemessen hat ('idle'),
 * schweigt auch das Statusfeld, und dann bleibt der Punkt eine Farbe ohne
 * Aussage statt eine Behauptung, die keiner geprueft hat.
 */
function Zustandspunkt({ status }: { status: SlotStatus }) {
  const wort = SLOT_TEXTE[status]?.text
  return (
    <span
      data-testid="provider-dot"
      role={wort ? 'img' : undefined}
      aria-label={wort}
      title={wort}
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
        status === 'connected' ? PUNKT_FARBE.an :
        status === 'failed' ? PUNKT_FARBE.kaputt :
        PUNKT_FARBE.aus
      }`}
    />
  )
}

/**
 * Das Wifi-Zeichen hinter den Abzeichen derselben Zeile.
 *
 * Es sagt dasselbe wie der Punkt am Zeilenanfang, also sagt es der Punkt und
 * dieses hier bleibt stumm. Es bekommt bewusst KEINEN Namen: lucide setzt
 * `aria-hidden` von sich aus, solange kein a11y-Merkmal daran haengt, und ein
 * Name hier wuerde das abschalten und denselben Zustand ein zweites Mal
 * vorlesen lassen.
 *
 * Auswahl und Farbe kommen aus SLOT_TEXTE, damit die zugeklappte Zeile und das
 * Statusfeld nicht zwei Farbtabellen fuehren, die auseinanderlaufen koennen.
 */
function Zustandssymbol({ status }: { status: SlotStatus }) {
  const wort = SLOT_TEXTE[status]
  if (!wort) return null
  const Zeichen = status === 'connected' ? Wifi : WifiOff
  return <Zeichen size={8} className={`${wort.ton} shrink-0`} />
}

function Statusfeld({ status }: { status: SlotStatus | undefined }) {
  const wort = status ? SLOT_TEXTE[status] : undefined
  if (!wort) return null
  return (
    <span
      data-testid={wort.testid}
      title={wort.title}
      className={`flex items-center gap-1 text-[0.6rem] ${wort.ton}`}
    >
      {status === 'connected' ? <Wifi size={10} /> : <WifiOff size={10} />} {wort.text}
    </span>
  )
}

/** Model ids for an OpenAI-compatible server that serves more than its
 *  /models list says (GitHub #112). Stored per endpoint, saved when the field
 *  is left, and the model list is read again so the ids show in the picker. */
function ExtraModelIdsField({ baseUrl, fieldId = 'extra-model-ids' }: { baseUrl: string; fieldId?: string }) {
  const key = endpointKey(baseUrl)
  const stored = useSettingsStore((s) => s.settings.extraModelIds?.[key])
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (stored ?? []).join('\n')
  const save = () => {
    if (draft === null) return
    const ids = parseExtraModelIds(draft)
    const all = { ...(useSettingsStore.getState().settings.extraModelIds ?? {}) }
    if (ids.length) all[key] = ids
    else delete all[key]
    useSettingsStore.getState().updateSettings({ extraModelIds: all })
    setDraft(null)
    window.dispatchEvent(new Event('lu-models-refresh'))
  }
  return (
    <div>
      <label className="text-[0.6rem] text-gray-500 mb-0.5 block" htmlFor={fieldId}>
        Model IDs the server does not list
      </label>
      <textarea
        id={fieldId}
        data-testid="extra-model-ids"
        value={shown}
        rows={2}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        placeholder="One per line, for example deepseek-chat"
        className="w-full px-2 py-1 rounded bg-white/5 border border-white/8 text-[0.65rem] text-gray-300 font-mono focus:outline-none focus:border-white/20 resize-y"
      />
      <p className="text-[0.55rem] text-gray-500 leading-tight">
        They appear in the model list next to the ones the server names. Up to {MAX_EXTRA_MODEL_IDS}.
      </p>
    </div>
  )
}

/** For the test of GitHub #112, which renders the field on its own. */
export const ExtraModelIdsFieldForTest = ExtraModelIdsField

/** The expanded-row key of an additional OpenAI-compatible entry. */
function entryRowKey(entryId: string): string {
  return `entry:${entryId}`
}

/**
 * One additional OpenAI-compatible backend (GitHub #173): its own name,
 * address, optional key, extra model ids, Test, Disable or Enable, and
 * Remove. Same parts and the same words as a slot row, so the two lists read
 * as one; the slot-only machinery (standby, handover, the engine) has no
 * business here, because an entry pushes nobody out.
 */
function OpenAIEntryRow({ entry, expanded, onToggleExpanded }: {
  entry: ProviderConfig
  expanded: boolean
  onToggleExpanded: () => void
}) {
  const entryId = entry.entryId as string
  // The backend's own name, what the slot rows call `view.label`.
  const label = entry.name
  const updateOpenAIEntry = useProviderStore((s) => s.updateOpenAIEntry)
  const removeOpenAIEntry = useProviderStore((s) => s.removeOpenAIEntry)
  const setOpenAIEntryApiKey = useProviderStore((s) => s.setOpenAIEntryApiKey)
  const currentKey = useProviderStore((s) => s.getOpenAIEntryApiKey(entryId))
  const [status, setStatus] = useState<SlotStatus>('idle')
  const [testing, setTesting] = useState(false)
  const [keyVisible, setKeyVisible] = useState(false)
  const [armed, setArmed] = useState(false)
  const armTimer = useRef<number | null>(null)
  useEffect(() => () => { if (armTimer.current) window.clearTimeout(armTimer.current) }, [])

  const probe = async (): Promise<SlotStatus> => {
    let ok = false
    try {
      ok = await getOpenAIEntryProvider(entryId).checkConnection()
    } catch {
      ok = false
    }
    let count: number | null = null
    if (ok) {
      try {
        const list = await getOpenAIEntryProvider(entryId).listModels()
        count = Array.isArray(list) ? list.length : null
      } catch {
        count = null
      }
    }
    return reachVerdict(ok, count)
  }

  // One probe when the row appears switched on, like the slot rows get.
  useEffect(() => {
    if (!entry.enabled) return
    let cancelled = false
    void probe().then((v) => { if (!cancelled) setStatus(v) })
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const test = async () => {
    setTesting(true)
    setStatus('idle')
    const v = await probe()
    setStatus(v)
    setTesting(false)
  }

  const toggle = () => {
    const next = !entry.enabled
    updateOpenAIEntry(entryId, { enabled: next, disabledByUser: !next })
    setStatus('idle')
    if (next) window.dispatchEvent(new Event('lu-models-refresh'))
  }

  const remove = () => {
    if (!armed) {
      setArmed(true)
      if (armTimer.current) window.clearTimeout(armTimer.current)
      armTimer.current = window.setTimeout(() => setArmed(false), 4000)
      return
    }
    if (armTimer.current) window.clearTimeout(armTimer.current)
    setArmed(false)
    removeOpenAIEntry(entryId)
    window.dispatchEvent(new Event('lu-models-refresh'))
  }

  if (!entry.enabled) {
    return (
      <div data-testid="openai-entry-row" data-entry={entryId} className="rounded-lg border border-white/8 bg-white/[0.01] overflow-hidden">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <button onClick={toggle} className="group flex items-center" title="Enable provider">
            <Power size={10} className="text-gray-500 group-hover:text-green-600 dark:group-hover:text-green-400 transition-colors" />
          </button>
          <div className="flex-1 flex items-center gap-2 min-w-0">
            <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-gray-600" />
            <span className="t-micro text-gray-500 font-medium truncate">{label}</span>
            <span className="t-micro px-1 py-0.5 rounded bg-white/5 text-gray-500 shrink-0">DISABLED</span>
          </div>
          <button
            data-testid="openai-entry-remove"
            onClick={remove}
            title={`Forget ${entry.name} and stop offering it here`}
            className={`shrink-0 flex items-center gap-1 px-2 py-0.5 rounded border t-micro transition-colors ${
              armed
                ? 'bg-red-500/15 border-red-500/30 text-red-300 font-medium'
                : 'bg-white/5 border-white/8 text-gray-500 hover:text-red-300 hover:border-red-500/20'
            }`}
          >
            <Trash2 size={10} />
            {armed ? 'Click again to remove' : 'Remove'}
          </button>
          <button
            onClick={toggle}
            className="shrink-0 px-2 py-0.5 rounded bg-green-500/10 border border-green-500/20 t-micro text-green-300 hover:text-green-200 hover:bg-green-500/15 transition-colors"
          >
            Enable
          </button>
        </div>
      </div>
    )
  }

  return (
    <div data-testid="openai-entry-row" data-entry={entryId} className="rounded-lg border border-white/8 bg-white/[0.02] overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button onClick={toggle} className="group flex items-center" title="Disable provider">
          <Power size={10} className="text-green-600 dark:text-green-400 group-hover:text-red-600 dark:group-hover:text-red-400 transition-colors" />
        </button>
        <button onClick={onToggleExpanded} className="flex-1 flex items-center justify-between min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Zustandspunkt status={status} />
            <span className="t-micro text-gray-300 font-medium truncate">{label}</span>
            {entry.isLocal
              ? <span className={providerBadgeClass('local')}>LOCAL</span>
              : <span className={providerBadgeClass('cloud')}>CLOUD</span>}
            <Zustandssymbol status={status} />
          </div>
          <ChevronDown size={10} className={`text-gray-500 transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {expanded && (
        <div className="px-2 pb-2 space-y-1.5 border-t border-white/[0.04]">
          <div className="pt-1.5">
            <label className="t-micro text-gray-500 mb-0.5 block" htmlFor={`entry-name-${entryId}`}>Name</label>
            <input
              id={`entry-name-${entryId}`}
              data-testid="openai-entry-name"
              value={entry.name}
              onChange={(e) => updateOpenAIEntry(entryId, { name: e.target.value })}
              className="w-full px-2 py-1 rounded bg-white/5 border border-white/8 t-micro text-gray-300 focus:outline-none focus:border-white/20"
            />
          </div>
          <div>
            <label className="t-micro text-gray-500 mb-0.5 block" htmlFor={`entry-url-${entryId}`}>Endpoint</label>
            <input
              id={`entry-url-${entryId}`}
              data-testid="openai-entry-endpoint"
              value={entry.baseUrl}
              onChange={(e) => updateOpenAIEntry(entryId, { baseUrl: e.target.value })}
              placeholder="http://localhost:..."
              className="w-full px-2 py-1 rounded bg-white/5 border border-white/8 t-micro text-gray-300 font-mono focus:outline-none focus:border-white/20"
            />
          </div>
          <div>
            <label className="t-micro text-gray-500 mb-0.5 block" htmlFor={`entry-key-${entryId}`}>
              {entry.isLocal ? 'API Key (optional)' : 'API Key'}
            </label>
            <div className="relative">
              <input
                id={`entry-key-${entryId}`}
                type={keyVisible ? 'text' : 'password'}
                value={currentKey}
                onChange={(e) => setOpenAIEntryApiKey(entryId, e.target.value)}
                placeholder="sk-..."
                className="w-full px-2 py-1 pr-7 rounded bg-white/5 border border-white/8 t-micro text-gray-300 font-mono focus:outline-none focus:border-white/20"
              />
              <button
                onClick={() => setKeyVisible(!keyVisible)}
                aria-label={keyVisible ? 'Hide API key' : 'Show API key'}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              >
                {keyVisible ? <EyeOff size={10} /> : <Eye size={10} />}
              </button>
            </div>
          </div>
          <ExtraModelIdsField baseUrl={entry.baseUrl} fieldId={`extra-model-ids-${entryId}`} />
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => { void test() }}
              disabled={testing}
              className="px-2 py-0.5 rounded bg-white/5 border border-white/8 t-micro text-gray-400 hover:text-gray-200 hover:bg-white/8 transition-colors disabled:opacity-50"
            >
              {testing ? <Loader2 size={10} className="animate-spin" /> : 'Test'}
            </button>
            <button
              onClick={toggle}
              className="px-2 py-0.5 rounded bg-red-500/5 border border-red-500/10 t-micro text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
            >
              Disable
            </button>
            <button
              data-testid="openai-entry-remove"
              onClick={remove}
              title={`Forget ${entry.name} and stop offering it here`}
              className={`flex items-center gap-1 px-2 py-0.5 rounded border t-micro transition-colors ${
                armed
                  ? 'bg-red-500/15 border-red-500/30 text-red-300 font-medium'
                  : 'bg-white/5 border-white/8 text-gray-400 hover:text-red-300 hover:border-red-500/20'
              }`}
            >
              <Trash2 size={10} />
              {armed ? 'Click again to remove' : 'Remove'}
            </button>
            <Statusfeld status={status} />
          </div>
          {currentKey && (
            <p className="text-[0.5rem] text-gray-600 mt-0.5 leading-tight">
              Keys are stored locally with basic obfuscation, not encryption. Avoid shared computers.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
