import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { yieldSilentLocalRuns } from '../../lib/silent-runs'
import { usePopoverPlatz } from '../../hooks/usePopoverPlatz'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, Ban, ChevronDown, Loader2, Power, Settings as SettingsIcon, Wrench, X, Cloud } from 'lucide-react'
import { useModels } from '../../hooks/useModels'
import { useModelStore } from '../../stores/modelStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import {
  loadModel, unloadModelAndLook, readLoadedModels, readRunningModels, modelsAheadOfLoad,
} from '../../api/ollama'
import {
  ollamaSwitchState, waitingForSentence, stillBusySentence, switchFailedSentence,
  type OllamaSwitchRun,
} from '../../lib/ollama-switch'
import type { LoadSwitchState } from '../../lib/load-switch'
import {
  lmStudioSwitchState, lmStudioSwitchFailedSentence, LM_STUDIO_STILL_LISTED,
  type LmStudioSwitchRun,
} from '../../lib/lmstudio-switch'
import { CallTimeoutError } from '../../lib/call-limit'
import { loadedOnCpuLabel, loadedOnCpuTitle } from '../../lib/ollama-window-fit'
import { ModelLoadError } from '../../lib/ollama-errors'
import { displayModelName, isOpenAISlotModel } from '../../api/providers'
import { splitForMiddleEllipsis, modelDisplayLabel } from '../../lib/model-label'
import { formatContextWindow } from '../../lib/formatters'
import { lmStudioLoadContext, savedLmStudioContext } from '../../lib/lmstudio-context-pick'
import { activateBuiltinModel, isManagedBuiltinActive } from '../../api/engine'
import { diagnoseBuiltinEngine } from '../../api/builtin-ensure'
import { canUseTools, resolveToolSupport, type ToolSupport } from '../../lib/tool-support'
import { backendCall } from '../../api/backend'
import {
  listLoadedLmStudioModels, readLoadedLmStudioModels, loadLmStudioModel, unloadLmStudioModelAndLook,
  LmStudioSwitchError,
} from '../../api/lmstudio'
import {
  useEndedLmStudioLoads, dismissUnconfirmedLmStudioLoads, lmStudioUnconfirmedSentence,
  lmStudioGoneMark, lmStudioWentAfter,
} from '../../lib/lmstudio-ended-loads'
import { isLmStudioProvider } from '../../lib/hf-to-provider'
import { unloadEverything, unloadProblems, unloadedNames } from '../../lib/unload-everything'
import { detailOf } from '../../lib/error-text'
import { lmStudioSlotUpdate, adoptionReplacesBuiltinEngine } from '../../lib/lmstudio-backend-adopt'
import { nextProbeDelayMs } from '../../lib/probe-backoff'
import { noChatBackendEnabled } from '../../lib/provider-visibility'
import { cloudTeaserModels } from '../../lib/cloud-teaser-models'
import { splitBackendSwitchRows, needsBackendSwitchHeading, foldedRowsSentence } from '../../lib/lu-engine-rows'
import { isBuiltinEngineEntry, type InstalledModelLike } from '../../lib/lmstudio-match'
import type { HandoverSlot } from '../../lib/openai-slot-handover'
import { modelListIsStale, openaiEntriesAreStale } from '../../lib/model-list-staleness'
import {
  ensureLuEngineIsChatProvider, announceLuEngineSwitch, LU_ENGINE_SWAP_BUSY_NOTE,
  clearEngineErrorAfterSuccess,
  announceLuEngineSwapBusy, announceLuEngineStartFailure,
  LM_STUDIO_LOAD_BUSY_NOTE, announceLmStudioLoadBusy,
  handBackChatProviderForRow, announceChatProviderSwitch, standbyBackendOf,
} from '../../api/lu-engine-switch'
import { tryAcquireLuEngineSwap, releaseLuEngineSwap, luEngineSwapInFlight, useLuEngineSwapRunning } from '../../api/lu-engine-swap-lock'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { useLuEngineSwitchStore } from '../../stores/luEngineSwitchStore'
import { FitActionButtons } from '../ui/FitActionButtons'
import { isBuiltinEngineMissing } from '../../lib/builtin-engine-presence'
import { engineNoticeDismissed, dismissEngineNoticeForSession, resetEngineNoticeDismissal } from '../../lib/engine-notice-session'
import { log } from '../../lib/logger'
import { ModelPickerSkeleton } from '../layout/ViewSkeletons'
import type { AIModel } from '../../types/models'
import { MOTION_S } from '../ui/motion'
import { ModelRowMarks } from './ModelRowMarks'
import { CloudModelPicker, CLOUD_PICKER_MAX_HEIGHT, CLOUD_PICKER_WIDTH, type PickerNote } from './CloudModelPicker'
import { modelFamily, OTHER_FAMILY } from '../../lib/model-family'
import type { CloudModel as CloudModelMarks } from '../../types/models'
import { cloudPickerLine, hostIsMac } from '../../lib/mac-pc-words'

// ── Local-mode cloud discovery (2.5.8): an "LU Cloud" section at the list's
// tail. Signed-in accounts show their real hosted chat models (the appMode
// filter hides them from the selectable list); logged-out shows one generic
// row. Tapping any row opens the Cloud gate (login → plan → beta), chat rows
// skip the teaser sheet, the gate IS the pitch here. Hidden in cloud mode
// (models are the real list there) and when the discovery layer is off. ──
function CloudTeaserSection({ onOpen }: { onOpen: () => void }) {
  const appMode = useSettingsStore((s) => s.settings.appMode)
  const teasersEnabled = useSettingsStore((s) => s.settings.cloudTeasersEnabled)
  const setCloudGateOpen = useUIStore((s) => s.setCloudGateOpen)
  const setPendingCloudModel = useUIStore((s) => s.setPendingCloudModel)
  const allModels = useModelStore((s) => s.models)
  if (appMode === 'cloud' || !teasersEnabled) return null
  // The five used to be the head of the list as `/v1/models` happened to send
  // it, and that order is not stable, so the strip showed a different five on
  // every look (Nebenbefund 3, R9 re-measure). Same five every time now, and
  // the ones that did not fit are counted instead of silently dropped.
  const { shown: cloudChat, more: cloudMore } = cloudTeaserModels(
    allModels.filter((m) => m.provider === 'lu-cloud' && m.type === 'text'),
    (m) => (('displayName' in m && m.displayName) || displayModelName(m.name)) as string,
  )
  // Every row used to call this with nothing, so the row you pressed and the
  // model you got afterwards were unrelated: the gate flipped the mode and the
  // mode rule then handed out the head of the catalogue, in whatever order the
  // last `/v1/models` answer had arrived in (Nebenbefund 1, R10 re-measure
  // 2026-08-30, DeepSeek V3.2 landed on Kimi K3). A model row now names its
  // model, by name and never by its position in any list, and the mode rule
  // honours that name when the flip lands. The rows that stand for the
  // catalogue as a whole, the rest-counter and the logged-out line, still ask
  // for nothing in particular.
  const open = (model?: string) => {
    setPendingCloudModel(model ?? null)
    onOpen()
    setCloudGateOpen(true)
  }
  return (
    <div className="mt-1 border-t border-white/[0.05]">
      <div className="px-2.5 pt-2 pb-0.5 flex items-center gap-1">
        <Cloud size={10} className="text-violet-500 dark:text-violet-200" />
        <span className="text-[0.55rem] font-medium uppercase tracking-widest text-gray-600">
          LU Cloud
        </span>
      </div>
      {cloudChat.map((m) => (
          <button
            key={m.name}
            onClick={() => open(m.name)}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-white/[0.04] transition-colors"
            title="Runs on LU Cloud, tap to see plans"
          >
            <Cloud size={10} className="text-violet-500 dark:text-violet-200 shrink-0" />
            <span className="t-micro text-gray-400 truncate">
              {('displayName' in m && m.displayName) || displayModelName(m.name)}
            </span>
            <span className="ml-auto text-[0.5rem] text-violet-500 dark:text-violet-200">Cloud</span>
          </button>
      ))}
      {cloudChat.length > 0 && cloudMore > 0 && (
        <button
          onClick={() => open()}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-white/[0.04] transition-colors"
          title="See the whole hosted catalogue"
        >
          <span className="t-micro text-gray-500">
            {cloudMore} more cloud {cloudMore === 1 ? 'model' : 'models'}, see them all
          </span>
        </button>
      )}
      {cloudChat.length === 0 && (
        <button
          onClick={() => open()}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-white/[0.04] transition-colors"
          title="Runs on LU Cloud, tap to see plans"
        >
          <Cloud size={10} className="text-violet-500 dark:text-violet-200 shrink-0" />
          <span className="t-micro text-gray-400">
            {cloudPickerLine(hostIsMac())}
          </span>
          <span className="ml-auto text-[0.5rem] text-violet-500 dark:text-violet-200">Cloud</span>
        </button>
      )}
    </div>
  )
}

// True when `prev` already holds exactly the names in `next`. Lets the 1.5 s
// loaded-state poll bail out of a state update (return the SAME Set ref) when
// nothing changed, so React skips the re-render instead of reconciling the whole
// dropdown every tick, the common case once the user has stopped loading models
// (GH #70: "interface laggy, even when loading models").
function sameStringSet(prev: Set<string>, next: string[]): boolean {
  if (prev.size !== next.length) return false
  for (const n of next) if (!prev.has(n)) return false
  return true
}

// ── Bug Q (v2.4.7, GH #41) ─────────────────────
//
// Symptom: user has LM Studio installed with models on disk, opens LU's
// chat model picker, sees only Ollama models, no hint about LM Studio.
// Root cause: LM Studio's HTTP server doesn't auto-start with the app, // the user has to click Developer → Start Server in LM Studio, OR run
// `lms server start`. When the server is off, LU's OpenAI-compat probe
// returns nothing and LM Studio is silently dropped from the dropdown.
// v2.4.4 added a "Start LM Studio server" hint to onboarding, but the
// chat picker (where users actually look for their models) never got
// the same treatment. This banner closes that gap. Asks
// `lmstudio_server_status` while the dropdown is open; renders inline when LM
// Studio is detected on disk (lms.exe present OR models in
// ~/.lmstudio/models/) AND its server isn't running. Clicking "Start
// Server" hits the same Tauri command the Settings panel uses, then
// re-fetches the model list so the LM Studio models appear without a
// restart.

/**
 * Antwort von `lmstudio_server_status`. Deckungsgleich mit der Rust-Seite
 * (`src-tauri/src/commands/install.rs:3379` baut genau diese fuenf Schluessel,
 * alle immer gesetzt). Exportiert, weil das Onboarding denselben Befehl ruft
 * und dort ein `any` stand, eine Antwort, ein Typ.
 */
export interface LmStudioServerStatus {
  running: boolean
  port: number
  lms_present: boolean
  /** Any GGUF in LM Studio's models folder. */
  models_detected: boolean
  /** The models the chat picker lists once the server runs: no embedding
   *  models, no vision projectors, a split model once. */
  model_count: number
}

/** How often the line asks the server while the menu is open. */
const LMSTUDIO_STATUS_POLL_MS = 1500
/** How long "starting" stands before the Start button comes back. */
const LMSTUDIO_START_WAIT_MS = 30_000

// One line with a state dot, a short sentence and a text button (the owner,
// 05.10.2026). It used to be a box of three text blocks and a full-width
// button, about as tall as five model rows. What the click does is unchanged.
//
// `onServerOff` tells the list below what the line knows: with the server off
// its rows cannot be picked, so they leave the list for as long as the line
// stands and come back with the server.
function LmStudioStatusLine({ onStarted, onServerOff }: { onStarted: () => void; onServerOff: (off: boolean) => void }) {
  const [status, setStatus] = useState<LmStudioServerStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')
  // Starting the server also hands LM Studio the local backend slot (see
  // lib/lmstudio-backend-adopt). When the built-in engine holds that slot the
  // user learns it before the click, together with the way back: in the
  // tooltip of the button, the line itself stays one line.
  const replacesBuiltinEngine = useProviderStore((s) => adoptionReplacesBuiltinEngine(s.providers.openai))

  // The line follows the server for as long as the menu is open. It used to
  // ask once on open and for six seconds after "Start": a server that needed
  // longer came up, its models reached the list, and the line above them went
  // on saying "server off" (Windows box, 05.10.2026).
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  const startAsked = useRef(false)
  const onStartedRef = useRef(onStarted)
  const onServerOffRef = useRef(onServerOff)
  useEffect(() => { onStartedRef.current = onStarted; onServerOffRef.current = onServerOff }, [onStarted, onServerOff])
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let wasRunning: boolean | null = null
    let following = false
    let asked = 0
    const refresh = async () => {
      clearTimeout(timer)
      const mine = ++asked
      const fresh = await backendCall<LmStudioServerStatus>('lmstudio_server_status').catch(() => null)
      // A newer question is on its way (the click on "Start" asks at once):
      // that one answers and keeps the rhythm.
      if (cancelled || mine !== asked) return
      // Not Tauri, endpoint missing, or no LM Studio on this machine: there
      // is nothing to follow, so the line stays away and nothing keeps asking.
      // One answer that fails later on is not that: the line keeps what it
      // last knew and asks again.
      const detected = !!fresh && (fresh.lms_present || fresh.models_detected)
      if (!fresh && following) timer = setTimeout(() => void refresh(), LMSTUDIO_STATUS_POLL_MS)
      // Only an answer moves the list. A reopened menu keeps what the last
      // answer said until the next one is in.
      if (fresh) onServerOffRef.current(detected && !fresh.running)
      if (!fresh || !detected) return
      following = true
      const cameUp = fresh.running && wasRunning === false
      wasRunning = fresh.running
      if (cameUp) {
        // After a click on "Start" this is the moment the line promised: the
        // models have to appear. A running server is only half of that. The
        // picker lists ENABLED provider slots, so without the slot the models
        // stay invisible and the button leads into a dead end (Nebenbefund 4,
        // R8 re-measure). Same call the BackendSelector makes, no
        // LM-Studio-only path. A server someone started elsewhere takes no
        // slot: nobody asked for that here.
        if (startAsked.current) {
          startAsked.current = false
          const update = lmStudioSlotUpdate(useProviderStore.getState().providers.openai)
          if (update) {
            useProviderStore.getState().setProviderConfig('openai', update)
            // Opus review, R13D follow-up: this click is the deliberate
            // pick `adoptionReplacesBuiltinEngine` already warns about
            // above, not an eviction bug, so the missing-engine notice
            // must not fire because of it. See lib/builtin-engine-presence.ts.
            if (update.managed === false) useProviderStore.getState().setEngineOptedOut(true)
          }
        }
        setStarting(false)
        onStartedRef.current()
      }
      setStatus(fresh)
      timer = setTimeout(() => void refresh(), LMSTUDIO_STATUS_POLL_MS)
    }
    refreshRef.current = refresh
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [])

  // "Starting" is a promise with an end: a server that has not answered by
  // then gets its Start button back. The line keeps following it either way.
  useEffect(() => {
    if (!starting) return
    const timer = setTimeout(() => setStarting(false), LMSTUDIO_START_WAIT_MS)
    return () => clearTimeout(timer)
  }, [starting])

  // Render only when LM Studio is on disk but its server is off. If
  // running, models are already in the list; if neither lms.exe nor any
  // models are present, the user just doesn't have LM Studio.
  if (!status || status.running) return null

  const handleStart = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (starting) return
    setStarting(true)
    setStartError('')
    startAsked.current = true
    try {
      await backendCall('start_lmstudio_server')
      // The CLI takes a moment to bind 1234. Ask right away, the line then
      // keeps asking on its own until the server answers.
      await refreshRef.current()
    } catch (e) {
      // Tauris `invoke` lehnt mit einem STRING ab (die Rust-Seite gibt
      // `Result<_, String>` zurueck), ein `e.message` haette im ausgelieferten
      // Programm nie einen Wert. `detailOf` ist die Stelle, an der dieses
      // Projekt genau diese Frage beantwortet (lib/error-text.ts): String,
      // Error oder sonst etwas.
      const detail = detailOf(e)
      startAsked.current = false
      setStartError(detail ? detail.slice(0, 80) : 'Start failed')
      setStarting(false)
    }
  }

  const sentence = lmStudioLineText(status.model_count, starting, startError !== '')
  return (
    <div
      data-testid="lmstudio-status-line"
      data-state={starting ? 'starting' : startError ? 'failed' : 'off'}
      className={`lu-picker-service${startError ? ' is-err' : ''}`}
    >
      {starting
        ? <Loader2 size={8} className="shrink-0 animate-spin" />
        : <span className={`lu-picker-dot${startError ? ' is-err' : ''}`} />}
      {/* Why the start failed, in the server's own words, behind the line. */}
      <span className="st" title={startError || sentence}>{sentence}</span>
      {!starting && (
        <button
          type="button"
          className="lu-picker-text-btn"
          onClick={handleStart}
          title={lmStudioStartTitle(replacesBuiltinEngine)}
        >
          {startError ? 'Retry' : 'Start'}
        </button>
      )}
    </div>
  )
}

/** What the LM Studio line reads in each of its three states. */
export function lmStudioLineText(modelCount: number, starting: boolean, failed: boolean): string {
  if (starting) return 'LM Studio server starting'
  if (failed) return 'LM Studio server did not start'
  return `LM Studio server off, ${modelCount} ${modelCount === 1 ? 'model' : 'models'} on disk`
}

/** The tooltip of "Start". The consequence of the click stands here and
 *  nowhere in the line: with the LU Engine in the local slot, starting LM
 *  Studio takes that slot over. */
export function lmStudioStartTitle(replacesBuiltinEngine: boolean): string {
  return replacesBuiltinEngine
    ? 'Start the LM Studio server to pick its models here. This also makes LM Studio your local chat backend in place of the LU Engine. You can switch back under Settings, AI Backends, Providers.'
    : 'Start the LM Studio server to pick its models here.'
}

// ── Badge configs ─────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  text: 'text-blue-400',
  image: 'text-purple-400',
  video: 'text-emerald-400',
}

const TYPE_LABEL: Record<string, string> = {
  text: 'TXT',
  image: 'IMG',
  video: 'VID',
}

const PROVIDER_BADGE: Record<string, { label: string; color: string }> = {
  ollama: { label: 'Ollama', color: 'text-emerald-400/70' },
  openai: { label: 'Cloud', color: 'text-sky-400/70' },
  anthropic: { label: 'Claude', color: 'text-violet-400/70' },
}

function getProviderBadge(model: AIModel) {
  const provider = ('provider' in model && model.provider) || 'ollama'
  const providerName = ('providerName' in model && model.providerName) || 'Ollama'

  if (providerName && providerName !== 'Ollama' && providerName !== 'OpenAI-Compatible' && providerName !== 'Anthropic') {
    return { label: providerName, color: PROVIDER_BADGE[provider]?.color || PROVIDER_BADGE.ollama.color }
  }
  return PROVIDER_BADGE[provider] || PROVIDER_BADGE.ollama
}

// ── Group models by family (Qwen / Gemma / Llama / …) ────────
//
// Users care more about model lineage than about which local backend
// they're pointing at. "Qwen 3.6 27B" appears once under Qwen whether
// it came from Ollama or LM Studio, the per-row provider badge
// (rendered below) keeps that detail visible.
//
// Pure visual grouping, model name + provider still resolve chat
// routing exactly as before.
//
// This is the LOCAL list. It keeps its own order and its own head per family,
// also over a single row (05.10.2026: the local list stays as it is).
// Which family a name belongs to is asked in lib/model-family, the same table
// the Cloud picker groups by.

// Family display order, Qwen/Gemma/Llama surface first since they're
// the most common local-chat picks; cloud-only families (Claude/GPT)
// come after the local ones; 'Other' always last.
const FAMILY_ORDER: string[] = [
  'Qwen', 'Gemma', 'Llama', 'Mistral', 'DeepSeek', 'Phi', 'Hermes',
  'Dolphin', 'GLM', 'gpt-oss', 'Yi', 'Command',
  'Claude', 'GPT / o-series', 'Gemini', 'Grok',
]

function groupByFamily(models: AIModel[]): { family: string; models: AIModel[] }[] {
  const groups: Record<string, AIModel[]> = {}
  for (const m of models) {
    const fam = modelFamily(m.name)
    if (!groups[fam]) groups[fam] = []
    groups[fam].push(m)
  }

  return Object.entries(groups)
    .sort(([a], [b]) => {
      if (a === OTHER_FAMILY) return 1
      if (b === OTHER_FAMILY) return -1
      const ai = FAMILY_ORDER.indexOf(a)
      const bi = FAMILY_ORDER.indexOf(b)
      if (ai >= 0 && bi >= 0) return ai - bi
      if (ai >= 0) return -1
      if (bi >= 0) return 1
      return a.localeCompare(b)
    })
    .map(([family, models]) => ({ family, models }))
}

/**
 * GitHub #173: the rows of each additional OpenAI-compatible entry, grouped
 * under that entry's name in the order the entries arrive, and every other row
 * untouched. Two entries with the same name get the address added, so no two
 * headings read the same.
 */
export function splitEntryRows(textModels: AIModel[]): {
  entryGroups: { family: string; models: AIModel[] }[]
  slotRows: AIModel[]
} {
  const byEntry = new Map<string, { name: string; models: AIModel[] }>()
  const slotRows: AIModel[] = []
  for (const m of textModels) {
    const entry = 'providerEntry' in m ? m.providerEntry : undefined
    if (!entry) { slotRows.push(m); continue }
    const name = (('providerName' in m && m.providerName) || '').trim() || 'OpenAI compatible'
    const g = byEntry.get(entry)
    if (g) g.models.push(m)
    else byEntry.set(entry, { name, models: [m] })
  }
  const all = [...byEntry.entries()]
  const entryGroups = all.map(([id, g]) => {
    const twin = all.some(([other, o]) => other !== id && o.name === g.name)
    return { family: twin ? `${g.name} (${id})` : g.name, models: g.models }
  })
  return { entryGroups, slotRows }
}

/**
 * K6 (3.0.1): GitHub #132, AppImage/Ubuntu 24.04, "it adds models and then
 * breaks the selection field... it's fixed by restarting". Not reproduced in
 * this pass (no Linux box available, see proof doc), but a restart-only fix
 * for a component with no error boundary of its own is the exact signature
 * of an uncaught render throw: ChatView wraps the WHOLE chat area in one
 * ErrorBoundary (AppShell.tsx), so a single bad row breaking here during
 * grouping would take the entire chat view down with it, not just this
 * picker, and only a full remount (restart) clears a tripped React
 * error-boundary. Grouping freshly downloaded, not-yet-fully-normalized model
 * data is exactly the computation most likely to meet a field a fresh entry
 * does not carry yet.
 *
 * Extracted as its own pure function for the same reason as the LM Studio
 * helpers below: no test harness exists for the whole ModelSelector
 * component, and this is exactly the kind of decision that needs a
 * regression test more than it needs to stay physically inline.
 *
 * On success: real grouping, unchanged behaviour. On a throw: falls back to
 * one flat, ungrouped list (still fully usable, every model is still there
 * and still clickable) instead of letting the exception reach React and take
 * the whole chat view with it, and logs which models were in play so the
 * NEXT report carries a stack trace pointing at the real field instead of
 * nothing at all.
 */
export function computeModelGroups(
  textModels: AIModel[],
  luEngineHoldsChat: boolean,
  standbyName: string | null,
  holderName: string | null,
): { groups: { family: string; models: AIModel[] }[]; showHeadings: boolean; groupingFailed: boolean } {
  try {
    // GitHub #173: the rows of an additional OpenAI-compatible entry stay
    // together under that entry's name, apart from the slot's rows, so two
    // backends serving a model of the same name are two visible rows, each
    // under its own backend. They never enter the slot's switch logic below:
    // an entry is not the slot and picking from it moves nothing.
    const { entryGroups, slotRows } = splitEntryRows(textModels)
    const wechsel = splitBackendSwitchRows(slotRows, luEngineHoldsChat, standbyName, holderName)
    const groups: { family: string; models: AIModel[] }[] = [
      ...(wechsel.switching.length > 0 && wechsel.label
        ? [{ family: wechsel.label, models: wechsel.switching }]
        : []),
      // Das fremde Backend, das den Platz haelt, unter seinem eigenen Namen
      // statt verstreut ueber die Familien.
      ...(wechsel.holding.length > 0 && wechsel.holderLabel
        ? [{ family: wechsel.holderLabel, models: wechsel.holding }]
        : []),
      ...entryGroups,
      ...groupByFamily(wechsel.rest),
    ]
    // The one rule, asked rather than copied (second review): one group
    // normally draws no heading, except the switch group, where the heading
    // is the warning that picking from it moves the backend. An entry group
    // always carries its name: it is the only thing that says which server a
    // row is on.
    const showHeadings = entryGroups.length > 0
      || needsBackendSwitchHeading(groups.map((g) => g.family), wechsel.label)
    return { groups, showHeadings, groupingFailed: false }
  } catch (e) {
    log.error('[ModelSelector] grouping the model list threw, falling back to a flat ungrouped list', {
      err: e, modelCount: textModels.length,
      modelNames: textModels.slice(0, 20).map((m) => m.name),
    })
    return {
      groups: textModels.length > 0 ? [{ family: '', models: textModels }] : [],
      showHeadings: false,
      groupingFailed: true,
    }
  }
}

// ── LM Studio selection helpers (§18) ─────────────────────────
//
// Extracted as pure module-level functions so the select-time auto-load
// decision is unit-testable without rendering the whole hook-heavy
// component (no test harness exists for ModelSelector, it depends on
// several zustand stores + the Tauri bridge).

/**
 * The identifier LM Studio's CLI/bridge uses for `model`, its `lmsKey`
 * when present (the exact key the loaded-list reports), else the model name.
 * Centralised so the row toggle, the loaded check, and the select-time
 * auto-load all agree on one id.
 *
 * CRITICAL: strip LU's routing prefix. An LM Studio model's `name` carries the
 * provider-scoped form "openai::qwen2.5-0.5b-instruct@q4_k_m" (getProviderForModel
 * routes on that `openai::`), but the `lms` CLI and LM Studio's /api/v0/models use
 * the BARE key "qwen2.5-0.5b-instruct@q4_k_m". Passing the prefixed name to
 * `lms load` matches nothing, pre-`-y` it dropped into the interactive picker and
 * the command hung forever (stuck "loading…" spinner, no error); post-`-y` it
 * exits 1. The loaded-check `loaded.has(lmsIdOf(...))` also silently failed
 * (bare keys from the API vs. a prefixed id), so rows showed perpetually unloaded
 * and selecting re-triggered a load every time. Same `/^[^:]+::/` strip as
 * displayModelName. (Found via live E2E 2026-06-01.)
 */
export function lmsIdOf(model: AIModel): string {
  // `lmsKey` steht auf keinem der vier Glieder von `AIModel`. Seit TS 4.9
  // verengt `'lmsKey' in model` trotzdem, auf `AIModel & Record<'lmsKey',
  // unknown>`, , und die `typeof`-Pruefung dahinter macht daraus `string`.
  // Beide Zusicherungen waren also nur die Handarbeit, die der Compiler seither
  // selbst macht; die aeussere `as string` hat obendrein verdeckt, dass die
  // innere Pruefung ueberhaupt etwas garantiert.
  const raw = 'lmsKey' in model && typeof model.lmsKey === 'string'
    ? model.lmsKey
    : model.name
  // GitHub #173: an additional entry's prefix `openai:<entry>::` too.
  return raw.replace(/^[^:]+(?::[a-z0-9-]+)?::/, '')
}

/**
 * True when selecting `model` must auto-load it into LM Studio first: it's
 * an LM Studio model AND it isn't already in the loaded set. Non-LM-Studio
 * models (Ollama, cloud) always return false, they activate immediately.
 */
export function shouldAutoLoadForSelect(
  model: AIModel,
  loaded: Set<string>,
): boolean {
  const isLms = isLmStudioProvider(
    ('providerName' in model && model.providerName) as string | undefined,
  )
  return isLms && !loaded.has(lmsIdOf(model))
}

/**
 * Context window (tokens) to request when LU auto-loads an LM Studio model.
 *
 * `lms load` WITHOUT `-c` pins the instance at LM Studio's small default
 * (4096 on current builds). That silently breaks tool use: the chat-tools
 * system prompt + the 5 curated tool schemas, let alone the full agent
 * catalog, overflow 4K, and LM Studio answers /v1/chat/completions with a
 * context-overflow error that surfaces as the opaque "LM Studio: Request
 * failed", with NO retry (it's a 4xx). Proven live 2026-06-12: gemma-3-4b
 * @4096 failed every chat-tools / agent turn; the identical turn @16384
 * worked first try. So we always request a usable window, capped by the
 * model's real max so we never ask for more than it supports (an 8K model
 * stays 8K). 16K is enough for the tool schemas + a real conversation while
 * keeping the KV-cache VRAM modest for the small local models LU targets.
 */
export const LMS_AUTOLOAD_CONTEXT = 16384

// A full agent tool set is about 5k tokens of definitions before the
// conversation starts, so a 4k model calls tools in Chat but cannot carry
// Agent or Code (MythoMax holds 4k and the upstream refuses the request
// outright, reproduced against production 2026-07-29). Saying that on the row
// beats letting the user find out from an error after the first message.
const TIGHT_CONTEXT = 8192

export function toolBadgeTitle(model: AIModel, support: ToolSupport = 'native'): string {
  const ctx =
    'contextLength' in model && typeof model.contextLength === 'number' ? model.contextLength : 0
  // A model with no native function-calling channel is NOT a model without
  // tools. The prompt transport drives it instead: the tool contract goes into
  // the system prompt and the answer comes back as <tool_call> XML. That is how
  // small Ollama models have run Agent and Code since 2.5.3, and it is the same
  // trick LU Cloud does server-side for the unrestricted fine-tunes.
  const how = support === 'hermes'
    ? 'Drives tools through the prompt, because this model has no native function-calling channel. Agent and Code work'
    : 'Supports tool calling (Agent, Code, and tools in Chat)'
  if (ctx > 0 && ctx < TIGHT_CONTEXT) {
    // Eine Schreibweise fuer jedes Kontextfenster, aus lib/formatters. Hier
    // stand `Math.round(ctx / 1024)}k`: klein geschrieben und gerundet, also
    // bei 6000 Token "6k" neben dem "5.9K", das jede andere Stelle der
    // Oberflaeche fuer denselben Wert zeigt.
    return `${how}, but its ${formatContextWindow(ctx)} context window is too small for a full Agent or Code tool set`
  }
  return how
}

/**
 * Which wait a click on a switched-off picker row ran into, or null.
 *
 * A17 (Windows counter-check 03.09.): while a pick is in flight every row in
 * the list carries `aria-disabled`, and the row's onClick read
 * `if (!rowDisabled) void handleSelectModel(model)`. Both busy sentences live
 * inside `handleSelectModel`, so the door that would have said them was the
 * door that never opened: two clicks 150 ms apart, fourteen and eighteen
 * seconds of watching, and not a word on screen. The card path (Models >
 * Installed) says its line because its buttons are not switched off.
 *
 * So the disabled row answers too, and it answers with the SAME split
 * `handleSelectModel` makes: the bolt is the only thing that knows whether the
 * engine is swapping, and the picker's own in-flight state without the bolt is
 * LM Studio warming a model of its own.
 *
 * `pickInFlight` is exactly the reason this picker switches rows off. A row
 * that is dead for any other reason (nothing running, some future rule) is not
 * a wait, and gets silence rather than a sentence about a wait nobody is in.
 */
export function blockedPickWait(
  pickInFlight: boolean,
  luEngineSwapRunning: boolean,
): 'lu-engine' | 'lm-studio' | null {
  if (!pickInFlight) return null
  return luEngineSwapRunning ? 'lu-engine' : 'lm-studio'
}

/**
 * The window LU asks for when it loads an LM Studio model by itself (a pick in
 * this list, or its On switch).
 *
 * `saved` is the person's own pick for this model (lib/lmstudio-context-pick,
 * 0 = Auto). GH #168: this ignored it and loaded every model at 16384, so a
 * model picked at "256K · max" came back at 16K after a switch away and back.
 */
export function lmsAutoLoadContext(model: AIModel, saved = 0): number {
  const max =
    'contextLength' in model && typeof model.contextLength === 'number' && model.contextLength > 0
      ? model.contextLength
      : 0
  return lmStudioLoadContext(saved, max, LMS_AUTOLOAD_CONTEXT)
}

/** The same, with the pick read from the settings. */
function lmsLoadContextNow(model: AIModel): number {
  return lmsAutoLoadContext(model, savedLmStudioContext(useSettingsStore.getState().settings, model.name))
}

// ── Load toggle (On / Off) ────────────────────────────────────
//
// Per-row VRAM load indicator + control for LOCAL models (Ollama AND
// LM Studio). Green "On" = the model is loaded in VRAM (click to unload
// and free VRAM); gray "Off" = not loaded (click to load it). Cloud
// models have no local VRAM state, so they get no toggle.
//
// This REPLACED the old active-row blue checkmark. The active/selected
// model is still shown by the row highlight; the dropdown now shows a
// single, unambiguous on/off LOAD state per model instead of a checkmark
// (active) competing with a separate loaded indicator. (2026-06-06:
// "keine haken mehr, nur on/off load sichtbar im dropdown".)
//
// The switch follows the rule in lib/load-switch.ts: while it loads it is its
// own Cancel, while it unloads there is nothing to click, and while another
// row's switch runs it is off. A cancelled load the backend has not let go of
// is "Cancelling": not off yet, and never on.
function LoadToggle({ loaded: listed, state, onClick }: { loaded: boolean; state: LoadSwitchState; onClick: () => void }) {
  const cancels = state === 'cancel'
  const cancelling = state === 'cancelling'
  const busy = cancels || cancelling || state === 'busy'
  const loaded = listed && !cancelling
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      disabled={state === 'busy' || state === 'off' || cancelling}
      // A row that is switched off for a running load (`pickInFlight`) hands
      // its `aria-disabled` down to everything in it. The Cancel of that load
      // is the one thing in the row that works, and says so.
      aria-disabled={cancels ? false : undefined}
      data-testid="load-toggle"
      data-state={cancels ? 'cancel' : cancelling ? 'cancelling' : busy ? 'busy' : loaded ? 'on' : 'off'}
      title={cancels
        ? 'Loading. Click to cancel'
        : cancelling
          ? 'Cancelling. Waiting until the model has left memory'
          : loaded
            ? 'Loaded in VRAM. Click to unload (Off)'
            : 'Not loaded. Click to load into VRAM (On)'}
      className={`flex items-center gap-0.5 pl-1 pr-1.5 py-0.5 rounded text-[0.5rem] font-semibold uppercase tracking-wide transition-colors disabled:opacity-40 ${
        loaded
          ? 'text-emerald-400 bg-emerald-500/[0.12] hover:bg-emerald-500/20'
          : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.06]'
      }`}
    >
      {busy ? <Loader2 size={9} className="animate-spin" /> : <Power size={9} />}
      <span>{cancels ? 'Cancel' : cancelling ? 'Cancelling' : busy ? '…' : loaded ? 'On' : 'Off'}</span>
    </button>
  )
}

/** What a load switch has to say after it ran, with its own way to close it. */
type SwitchNote = { text: string; tone: 'info' | 'error' }

function SwitchNoteLine({ testId, note, onDismiss }: { testId: string; note: SwitchNote; onDismiss: () => void }) {
  return (
    <div
      data-testid={testId}
      data-tone={note.tone}
      className={`flex items-start gap-1.5 px-2.5 py-1.5 border-b border-black/5 dark:border-white/[0.06] t-micro ${
        note.tone === 'error' ? HINWEIS_TEXT.fehler : HINWEIS_TEXT.ruhig
      }`}
    >
      <span className="flex-1 min-w-0 leading-snug">{note.text}</span>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        title="Dismiss"
        className="shrink-0 rounded p-[1px] opacity-70 hover:opacity-100 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
      >
        <X size={10} />
      </button>
    </div>
  )
}

/** How soon a pending Ollama load is first asked what it waits for, and how often after. */
const OLLAMA_WAIT_FIRST_LOOK_MS = 1500
const OLLAMA_WAIT_LOOK_EVERY_MS = 2000

// ── Component ─────────────────────────────────────────────────

export interface ModelSelectorProps {
  openUpward?: boolean
  /**
   * Which surface is asking. 'code' is the coding agent, which cannot do
   * anything at all without tool calls, so hosted models that have told us
   * they do not support tools are left out of the list entirely rather than
   * offered with a warning icon (2026-07-25: "Modelle ohne Tool-Support
   * z.B. nicht im Code-Bereich anzeigen"). Local models stay listed on every
   * surface, there the fallback XML path often still works, and when it does
   * not the run says so.
   */
  surface?: 'chat' | 'code'
  /**
   * The model that wrote the answers of the open chat, when that is not the
   * model picked here (Meldung 4 of the R5 re-measure). It used to be a chip
   * of its own beside the picker; the owner wanted it out of the row on
   * 2026-09-02, so the picker carries it: a 4 px dot on the corner and the
   * full sentence in the tooltip. `null`/undefined is the normal case and
   * changes nothing about the trigger, not even its width.
   */
  answeredBy?: string | null
}

/** What the picker button reads while no chat model is picked. In Cloud mode
 *  that is the normal state of a new account: the app never picks a hosted
 *  model by itself (lib/active-model-mode). */
const NO_MODEL_LABEL = 'Choose a model'
/** The first line of the menu while nothing is picked, in the words of the
 *  web app. One wording for both reasons the line can stand there. */
export const CHOOSE_TO_SEND = 'Choose a model to send your message.'
/** Added to it, in the same line, after a send was tried without a model. */
export const MESSAGE_IS_KEPT = 'Your text and attachments are kept.'
/** The line when a send is waiting and the list holds no model at all. */
export const NO_MODEL_LISTED = `Your message needs a chat model, and none is listed yet. ${MESSAGE_IS_KEPT}`

// `openUpward` flips the dropdown to open above the trigger, right-aligned, // used when the picker lives in the composer action bar (bottom of the screen)
// instead of the header. Header usage keeps the default downward/centered menu.
export function ModelSelector({ openUpward = false, surface = 'chat', answeredBy = null }: ModelSelectorProps = {}) {
  const { models, activeModel, setActiveModel, fetchModels } = useModels()
  const isModelLoading = useModelStore((s) => s.isModelLoading)
  // Welle 3, Listen-Ladezustand 3 von 4, und der einzige, den es vorher gar
  // nicht gab. `inventoryLoaded` ist die Frage „ist ueberhaupt schon einmal
  // eine Modellliste hier gelandet"; sie steht seit dem Zaehler-Nachschlag
  // (2026-08-29) im Store, aus genau demselben Grund: bis dahin darf man
  // keine Zahl und keine Leermeldung zeigen, sondern nur eine Ladeanzeige.
  // Ohne sie ging der Waehler direkt von leer auf Liste, und „leer" rendert
  // hier als „No models available", also als Aussage ueber die Maschine
  // statt ueber den Ladezustand.
  const inventoryLoaded = useModelStore((s) => s.inventoryLoaded)
  // G20: useModels hides every local model while the app is in Cloud mode.
  // Deliberate, but the picker never SAID so, and the silence reads as "my
  // local models are gone" (it cost a whole repro round on 2026-08-07).
  const appMode = useSettingsStore((s) => s.settings.appMode)
  // Whether the empty list is empty because nothing is switched on at all.
  // That has a different answer from "the engine did not start", and it has a
  // button (Nebenbefund 1, R9 re-measure 2026-08-30).
  const noBackendEnabled = useProviderStore((s) => noChatBackendEnabled(s.providers, appMode))
  const openSettingsAt = useUIStore((s) => s.openSettingsAt)
  /**
   * R13D Nebenfund 1, zweite Runde (Eigner, 21.09.2026): "NICHTS im prompt
   * fenster". Der Hinweis, dass LU Engine aus der Anbieterliste gefallen ist,
   * stand vorher als eigene Leiste ueber der Chat-Eingabe (EngineMissingBar,
   * geloescht). Er steht jetzt ganz oben in diesem Menue, wo der Kunde ohnehin
   * nach einem Modell sucht, plus ein winziger Punkt am Ausloeser, damit er
   * ueberhaupt bemerkt, dass hier etwas steht.
   *
   * Nur im Modus Local: in Cloud laeuft die Antwort nicht ueber den lokalen
   * Steckplatz, der Satz waere dort wahr und ohne Folgen. `engineOptedOut`
   * trennt die echte Verdraengung von einem Kunden, der ein anderes lokales
   * Backend mit Absicht gewaehlt hat (siehe lib/builtin-engine-presence.ts).
   */
  const openaiSlot = useProviderStore((s) => s.providers.openai)
  const engineOptedOut = useProviderStore((s) => s.engineOptedOut)
  const engineMissing = appMode === 'local' && isBuiltinEngineMissing(openaiSlot, engineOptedOut)
  const [engineNoticeHidden, setEngineNoticeHidden] = useState(engineNoticeDismissed)
  // Die Wegdrueckung faellt, sobald die Lage selbst sich aendert, waehrend des
  // Renderns statt in einem Effekt (react-hooks/set-state-in-effect): der Fall
  // "Zustand, der mit einer Eigenschaft zurueckfaellt" aus der React-Doku. So
  // verdeckt ein weggedrueckter Hinweis niemals einen SPAETEREN Vorfall.
  const [engineWasMissing, setEngineWasMissing] = useState(engineMissing)
  if (engineMissing !== engineWasMissing) {
    setEngineWasMissing(engineMissing)
    if (!engineMissing) {
      resetEngineNoticeDismissal()
      setEngineNoticeHidden(false)
    }
  }
  const showEngineNotice = engineMissing && !engineNoticeHidden

  /**
   * Die stehende Zeile ueber das Modell, jetzt HIER statt ueber der Eingabe.
   *
   * 21.09.2026, am echten Windows-Bau: „NICHTS im prompt fenster!"
   * Gemessen an Bild B3 stand ihr Satz („…is gone from the model list, so the
   * chat switched to…") mitsamt x IM Kasten des Composers, direkt ueber der
   * Zeile, in die er tippen wollte.
   *
   * Der Satz handelt vom Modell, also gehoert er dorthin, wo man das Modell
   * waehlt, und zwar in derselben Bauform wie die Engine-Zeile darunter: eine
   * ruhige Zeile ganz oben im Aufklapper, mit x. Dass die Wahl diesen
   * Aufklapper schliesst, war frueher der Grund, den Satz ueber den Composer
   * zu haengen; dagegen steht jetzt der Punkt am Knopf, derselbe, den die
   * Engine-Zeile schon benutzt. Der Punkt bleibt stehen, wenn das Menue
   * zufaellt, und fuehrt zurueck zum Text. Der Punkt ist erlaubt, Text nicht.
   */
  const engineSwitchNote = useLuEngineSwitchStore((s) => s.note)
  const engineSwitchTone = useLuEngineSwitchStore((s) => s.tone)
  const engineSwitchActions = useLuEngineSwitchStore((s) => s.actions)
  const engineSwitchActionModel = useLuEngineSwitchStore((s) => s.actionModel)

  const [open, setOpen] = useState(false)
  useDismissOnEscape(open, () => setOpen(false))

  /**
   * A send was tried without a chat model (ChatInput.handleSend). The message
   * stays in the composer, and this picker is where the user learns why: it
   * opens, and its first line says what is missing. Nothing is written in or
   * above the prompt field. When the menu is closed without a pick, the dot
   * on the button stays as the way back to the sentence, until a model is
   * there.
   *
   * The counter is compared during render instead of in an effect: opening is
   * a reaction to one click somewhere else, and an effect would open the menu
   * one paint late.
   */
  const modelAskSeq = useUIStore((s) => s.modelAskSeq)
  const [seenModelAsk, setSeenModelAsk] = useState(modelAskSeq)
  const [modelAsked, setModelAsked] = useState(false)
  if (seenModelAsk !== modelAskSeq) {
    setSeenModelAsk(modelAskSeq)
    setModelAsked(true)
    setOpen(true)
  }
  if (modelAsked && activeModel) setModelAsked(false)
  const sendNeedsModel = modelAsked && !activeModel

  /**
   * Die Lesezeit beginnt, wenn der Satz wirklich zu lesen ist.
   *
   * Eine Info-Zeile steht zwoelf Sekunden. Solange sie im Chat nur als Punkt
   * am Knopf existiert, waeren das zwoelf Sekunden ohne ein einziges Wort auf
   * dem Schirm, und danach waere auch der Punkt weg. Deshalb meldet der
   * Waehler hier, dass die Zeile aufgeklappt DA ist; der Halt im Speicher
   * laeuft daraufhin aus und die Uhr beginnt (luEngineSwitchStore, `gesehen`).
   *
   * Im Effekt, nicht im Renderkoerper: es ist ein Schreibzugriff auf einen
   * fremden Speicher. Idempotent, also stoert ein zweites Aufklappen nicht.
   */
  useEffect(() => {
    if (open && engineSwitchNote) useLuEngineSwitchStore.getState().alsGesehenMarkieren()
  }, [open, engineSwitchNote])
  // Read by the empty-state probe below, which runs before the render that
  // computes textModels. A ref keeps it out of the effect's dependency list.
  const textModelsEmptyRef = useRef(true)
  const [unloading, setUnloading] = useState(false)
  const [unloadDone, setUnloadDone] = useState(false)
  // B3, per-model LM Studio load/unload state. `lmsLoaded` is the set
  // of LM Studio model identifiers currently loaded in the server.
  // LM Studio's HTTP server doesn't have load / unload endpoints, so we
  // route through the `lms` CLI via the bridge's `lmstudio_load_model` /
  // `lmstudio_unload_model` commands.
  //
  // The list is kept with the mark that was taken before LM Studio was asked
  // for it (lib/lmstudio-ended-loads.ts). A model that was seen to be gone
  // after that is left out: the list may be from the second the model sat in
  // memory before the unload of a cancelled load took it, and the row read
  // "On" for a second after "Cancelling" (hand test, 11.10.2026).
  const [lmsListed, setLmsListed] = useState<{ ids: Set<string>; asked: number }>({ ids: new Set(), asked: 0 })
  const setLmsLoaded = useCallback((list: Iterable<string>, asked: number) => {
    const ids = [...list]
    setLmsListed((prev) => {
      const same = sameStringSet(prev.ids, ids)
      return same && prev.asked === asked ? prev : { ids: same ? prev.ids : new Set(ids), asked }
    })
  }, [])
  // The one LM Studio load or unload that is running, the handle that ends
  // its load, and what the last switch has to say. The rule is written down
  // in lib/lmstudio-switch.ts. `togglingLms` is the row whose On/Off switch
  // started it (a pick that loads is `selectingLms` below).
  const [lmsRun, setLmsRun] = useState<LmStudioSwitchRun | null>(null)
  const lmsRunAbort = useRef<AbortController | null>(null)
  const [lmsNote, setLmsNote] = useState<SwitchNote | null>(null)
  const togglingLms = lmsRun?.via === 'switch' ? lmsRun.name : null
  // The loads that were ended and that LM Studio has not let go of yet, and
  // the ones the watch could not confirm (lib/lmstudio-ended-loads.ts).
  const { ending: lmsEnding, unconfirmed: lmsUnconfirmed, goneMark: lmsGoneMark } = useEndedLmStudioLoads()
  const lmsLoaded = useMemo(
    () => new Set([...lmsListed.ids].filter((id) => !lmStudioWentAfter(id, lmsListed.asked))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lmsGoneMark is what lmStudioWentAfter reads
    [lmsListed, lmsGoneMark],
  )
  // B3/§18, the LM Studio model we're auto-loading as part of *selecting* it
  // (distinct from `togglingLms`, the explicit power-button flow). Drives the
  // inline "loading…" state on the row and blocks a second click.
  const [selectingLms, setSelectingLms] = useState<string | null>(null)
  /**
   * Das Modell, auf das gerade gewechselt wird, solange der Wechsel laeuft.
   *
   * Gegenprobe G1, 04.09.2026, zwei Messreihen ueber je 60 s: der Knopf im
   * Eingabefeld fuehrt zwei gegenlaeufige Gepflogenheiten. Innerhalb der LU
   * Engine nennt er bis zu 20,5 s lang das angeklickte Modell, obwohl noch
   * das alte bedient, also springt er VOR. Ueber eine Providergrenze hinweg
   * nennt er 12,44 s lang das alte, obwohl der Steckplatz schon uebergeben
   * ist, also haengt er NACH. "Zwei gegenlaeufige Konventionen im selben
   * Knopf."
   *
   * Eine Gepflogenheit: der Knopf nennt immer das angeklickte Modell, und
   * solange es noch nicht bedient, dreht sich der Ring daneben. Der Weg ueber
   * die LU Engine schrieb die Wahl dafuer schon sofort in den Speicher; der
   * Weg zu einem fremden Backend darf das nicht, weil eine nicht geladene
   * Kennung dort mit 404 antwortet, und deshalb steht der Name hier.
   */
  const [imWechselZu, setImWechselZu] = useState<string | null>(null)
  const [selectError, setSelectError] = useState<string | null>(null)
  // VRAM load state for Ollama rows, parity with `lmsLoaded` above, so
  // every LOCAL model shows a clear on/off load toggle (not just LM Studio).
  // Sourced from /api/ps on dropdown open.
  const [ollamaLoaded, setOllamaLoaded] = useState<Set<string>>(new Set())
  // What Ollama reports about each loaded model: how much of it sits in
  // graphics memory. A row says so when part of its model runs on the CPU
  // (lib/ollama-window-fit.ts). Measured after the load, never predicted.
  const [ollamaOnCpu, setOllamaOnCpu] = useState<Record<string, { label: string; title: string }>>({})
  // The one Ollama switch that is running, the handle that ends its load, the
  // models that load is waiting behind, and what the last switch has to say.
  // The rule is written down in lib/ollama-switch.ts.
  const [ollamaRun, setOllamaRun] = useState<OllamaSwitchRun | null>(null)
  const ollamaRunAbort = useRef<AbortController | null>(null)
  const [ollamaWaitingFor, setOllamaWaitingFor] = useState<string[]>([])
  const [ollamaNote, setOllamaNote] = useState<SwitchNote | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  /**
   * Wie hoch das Aufklappmenue hoechstens werden darf, in Pixeln.
   *
   * Persona P5 hat am 03.09.2026 am echten Build gemessen: nach einem
   * Fehlstart war das Menue 902 px hoch in einem 808 px hohen Fenster, der
   * Kasten mit der Fehlermeldung begann bei -149 px, also oberhalb des
   * Fensterrands, und weil das Menue `overflow-hidden` traegt, kam man da
   * weder mit dem Mausrad noch mit `scrollTop` hin. Sichtbar blieb nur das
   * rohe Maschinenprotokoll, der Satz mit dem Namen des Modells und dem
   * Handlungsvorschlag war unerreichbar.
   *
   * Ein festes `max-h` in vh reicht dafuer nicht: wie viel Platz ueber oder
   * unter dem Ausloeser ist, weiss nur der Ausloeser selbst. Also gemessen,
   * seit GitHub #149 mit `usePopoverPlatz` wie jedes Aufklappmenue der App:
   * die Seite, die reicht, die Hoehe, die bleibt, keine Mindesthoehe mehr.
   */
  const menueRef = useRef<HTMLDivElement>(null)
  // In Cloud mode the menu is the new picker: a fixed head and foot around a
  // list that scrolls by itself, capped in height, and never wider than the
  // area that would cut it.
  const cloudListRef = useRef<HTMLDivElement>(null)
  const cloudPicker = appMode === 'cloud'
  const menue = usePopoverPlatz(menueRef, open, cloudPicker
    ? { bevorzugt: openUpward ? 'oben' : 'unten', abstand: 6, luft: 12, deckel: CLOUD_PICKER_MAX_HEIGHT, rolle: cloudListRef, breiteDeckeln: true }
    : { bevorzugt: openUpward ? 'oben' : 'unten', abstand: 6, luft: 12 })

  // The Cloud picker's search field takes the keyboard when the menu opens.
  // When the menu closes while the keyboard is still in it (a pick, Escape),
  // the keyboard goes back to where it came from: the composer, so Enter
  // sends the kept message, or the trigger.
  const triggerRef = useRef<HTMLButtonElement>(null)
  const focusCameFrom = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open || !cloudPicker) return
    const menu = menueRef.current
    if (!menu || !menu.contains(document.activeElement)) return
    const back = focusCameFrom.current
    focusCameFrom.current = null
    ;(back && back.isConnected && back !== document.body ? back : triggerRef.current)?.focus({ preventScroll: true })
  }, [open, cloudPicker])

  // Keep the per-row On/Off LOAD state LIVE while the dropdown is open
  // (2026-06-12: "on und offload button sehr delayed und nicht immer
  // akkurat, gemma4b ist geladen laut ollama aber in LU steht off"). The old
  // code fetched the loaded set ONCE on open, so a model that loaded after the
  // open, or a slow/transiently-failed first fetch, showed the wrong state
  // until the user reopened. Now: fetch immediately, then poll /api/ps + LM
  // Studio every 1.5 s so the toggle self-corrects within a beat. Both calls are
  // cheap loopback requests; we only poll while the panel is actually open.
  useEffect(() => {
    if (!open) return
    setSelectError(null) // fresh open, drop any stale auto-load error
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // Consecutive failed probes. A backend that answers keeps the brisk 1.5 s
    // beat; one that is not installed is asked about less and less often, up
    // to a minute. Counter-check round 2 (2026-08-29) found the app knocking
    // on localhost:11434 every 1.5 s forever on a box with no Ollama at all,
    // over forty console lines inside a single chat round, drowning out the
    // errors somebody was actually looking for.
    let misses = 0

    const refresh = async () => {
      // Skip the tick entirely while the window is hidden/minimized, there's
      // nothing to repaint and we re-sync the moment it's visible again. Stops a
      // backgrounded app from hitting Ollama / LM Studio every 1.5 s (#70).
      if (typeof document !== 'undefined' && document.hidden) return
      // Only probe LM Studio's loaded-state when LM Studio models are actually
      // listed. When its server is down there are NO LM Studio rows, so this
      // skips the probe entirely, removing the last frontend reason the
      // dropdown ever stalled on a down LM Studio (the Rust side is now async +
      // port-pre-checked too). Ollama's /api/ps is a cheap loopback call and
      // always runs.
      // `providerName` steht auf ALLEN vier Gliedern von `AIModel` (auf dreien
      // optional, auf `CloudModel` verpflichtend), der `in`-Test und die
      // Zusicherung waren beide ueberfluessig. `m.providerName` ist von sich aus
      // `string | undefined`, also genau das, was `isLmStudioProvider` nimmt.
      const hasLmsRows = useModelStore.getState().models.some((m) =>
        isLmStudioProvider(m.providerName),
      )
      if (hasLmsRows) {
        const asked = lmStudioGoneMark()
        void listLoadedLmStudioModels().then((list) => { if (!cancelled) setLmsLoaded(list, asked) }).catch(() => {})
      } else if (!cancelled) {
        setLmsLoaded([], lmStudioGoneMark())
      }
      try {
        const loaded = await readLoadedModels()
        misses = 0
        if (cancelled) return
        const list = loaded.map((m) => m.name)
        setOllamaLoaded((prev) => sameStringSet(prev, list) ? prev : new Set(list))
        const onCpu: Record<string, { label: string; title: string }> = {}
        for (const m of loaded) {
          const label = loadedOnCpuLabel(m)
          if (label) onCpu[m.name] = { label, title: loadedOnCpuTitle(m) ?? '' }
        }
        setOllamaOnCpu((prev) => (JSON.stringify(prev) === JSON.stringify(onCpu) ? prev : onCpu))
      } catch {
        // Ollama did not answer: nothing is known, so nothing is called loaded.
        misses += 1
        if (!cancelled) setOllamaLoaded((prev) => (prev.size ? new Set() : prev))
      }
    }

    // setTimeout chain rather than setInterval: the gap has to grow, and a
    // fixed interval cannot.
    const tick = () => {
      void refresh().finally(() => {
        if (cancelled) return
        timer = setTimeout(tick, nextProbeDelayMs(misses))
      })
    }
    tick()

    // Re-sync immediately when the user comes back to the window (the hidden
    // ticks above were skipped, so the loaded-state could be stale). Coming
    // back is also a good moment to give a backend that was down another quick
    // chance, so the ladder resets here.
    const onVisible = () => {
      if (typeof document === 'undefined' || document.hidden || cancelled) return
      misses = 0
      if (timer) clearTimeout(timer)
      tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [open, setLmsLoaded])

  // While an Ollama load is pending: ask what it is waiting behind, so the
  // picker can say it. Starts a moment after the load, because a load that
  // simply goes through needs no sentence.
  const loadingOllama = ollamaRun?.kind === 'load' ? ollamaRun.name : null
  useEffect(() => {
    if (!loadingOllama) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const look = async () => {
      let ahead: string[] = []
      try {
        ahead = await modelsAheadOfLoad(loadingOllama)
      } catch {
        // /api/ps did not answer. Then nothing is known, and nothing is said.
      }
      if (cancelled) return
      setOllamaWaitingFor((prev) => (prev.length === ahead.length && prev.every((n, i) => n === ahead[i]) ? prev : ahead))
      timer = setTimeout(() => void look(), OLLAMA_WAIT_LOOK_EVERY_MS)
    }
    timer = setTimeout(() => void look(), OLLAMA_WAIT_FIRST_LOOK_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [loadingOllama])

  /** What LM Studio says is loaded right now. An unreadable list keeps the last one. */
  const rereadLmsLoaded = async (): Promise<Set<string> | null> => {
    try {
      const asked = lmStudioGoneMark()
      const loaded = new Set(await readLoadedLmStudioModels())
      setLmsLoaded(loaded, asked)
      return loaded
    } catch (e) {
      log.warn('[picker] could not read the loaded LM Studio models after a switch', { err: e })
      return null
    }
  }

  /** The sentence for an LM Studio load or unload that did not do what was asked. */
  const lmsFailure = (kind: LmStudioSwitchRun['kind'], label: string, e: unknown): string =>
    lmStudioSwitchFailedSentence(kind, label, {
      timedOut: e instanceof CallTimeoutError,
      reason: e instanceof LmStudioSwitchError ? e.reason : undefined,
    })

  /**
   * Flip a LM Studio model between loaded / unloaded via the bridge. A click
   * on the switch of the model that is loading ends that load, whether the
   * switch or a pick of the row started it. Afterwards the switch shows what
   * LM Studio's loaded list says, never what was asked for, and a switch that
   * did not do what was asked says why.
   */
  const toggleLmStudioLoad = async (model: AIModel) => {
    // lmsIdOf, never the row's name: `lms` and the loaded list know the bare
    // key, without LU's `openai::` routing prefix.
    const id = lmsIdOf(model)
    if (!id) return
    if (lmsRun) {
      if (lmStudioSwitchState(id, lmsRun, false, lmsEnding) === 'cancel') lmsRunAbort.current?.abort()
      return
    }
    if (selectingLms || lmsEnding.has(id)) return
    const kind: LmStudioSwitchRun['kind'] = lmsLoaded.has(id) ? 'unload' : 'load'
    const label = modelDisplayLabel(models, model.name)
    const cancel = new AbortController()
    lmsRunAbort.current = cancel
    setLmsRun({ name: id, kind, via: 'switch' })
    setLmsNote(null)
    // A backend cannot swap a model that is still computing (lib/silent-runs.ts).
    yieldSilentLocalRuns()
    let note: SwitchNote | null = null
    try {
      if (kind === 'load') {
        await loadLmStudioModel(id, lmsLoadContextNow(model), { signal: cancel.signal })
      } else if (await unloadLmStudioModelAndLook(id) === 'still-loaded') {
        note = { text: lmStudioSwitchFailedSentence('unload', label, { timedOut: false, reason: LM_STUDIO_STILL_LISTED }), tone: 'error' }
      }
    } catch (e) {
      // The person's own Cancel needs no sentence. Everything else does.
      if (!cancel.signal.aborted) {
        log.warn(`[picker] the LM Studio switch could not ${kind} the model`, { model: id, err: e })
        note = { text: lmsFailure(kind, label, e), tone: 'error' }
      }
    } finally {
      await rereadLmsLoaded()
      if (lmsRunAbort.current === cancel) lmsRunAbort.current = null
      if (note) setLmsNote(note)
      setLmsRun(null)
    }
  }

  /** The name a row shows for an Ollama model, for the sentences about it. */
  const ollamaLabel = (name: string) => modelDisplayLabel(models, name)

  /** What Ollama says is loaded right now. An unreadable list keeps the last one. */
  const rereadOllamaLoaded = async () => {
    try {
      setOllamaLoaded(new Set(await readRunningModels()))
    } catch (e) {
      log.warn('[picker] could not read the loaded Ollama models after a switch', { err: e })
    }
  }

  /**
   * Flip an Ollama model between loaded / unloaded in VRAM (parity with
   * toggleLmStudioLoad). Load = warm it into VRAM; unload = free VRAM
   * (keep_alive:0). A click on the switch of the model that is loading ends
   * that load. Afterwards the switch shows what /api/ps says, never what was
   * asked for, and a switch that did not do what was asked says why.
   */
  const toggleOllamaLoad = async (model: AIModel) => {
    const name = model.name
    if (!name) return
    if (ollamaRun) {
      if (ollamaSwitchState(name, ollamaRun) === 'cancel') ollamaRunAbort.current?.abort()
      return
    }
    const kind: OllamaSwitchRun['kind'] = ollamaLoaded.has(name) ? 'unload' : 'load'
    const cancel = new AbortController()
    ollamaRunAbort.current = cancel
    setOllamaRun({ name, kind })
    setOllamaNote(null)
    // A backend cannot swap a model that is still computing (lib/silent-runs.ts).
    yieldSilentLocalRuns()
    let note: SwitchNote | null = null
    try {
      if (kind === 'load') {
        await loadModel(name, { signal: cancel.signal })
      } else if (await unloadModelAndLook(name) === 'busy') {
        note = { text: stillBusySentence([ollamaLabel(name)]), tone: 'info' }
      }
    } catch (e) {
      // The person's own Cancel needs no sentence. Everything else does.
      if (!cancel.signal.aborted) {
        log.warn(`[picker] the Ollama switch could not ${kind} the model`, { model: name, err: e })
        note = {
          text: switchFailedSentence(kind, ollamaLabel(name), {
            timedOut: e instanceof CallTimeoutError,
            reason: e instanceof ModelLoadError ? e.message : undefined,
          }),
          tone: 'error',
        }
      }
    } finally {
      await rereadOllamaLoaded()
      if (ollamaRunAbort.current === cancel) ollamaRunAbort.current = null
      setOllamaWaitingFor([])
      // Only its own sentence: "Unload all models" may have ended this load
      // and be about to say something itself.
      if (note) setOllamaNote(note)
      setOllamaRun(null)
    }
  }

  /**
   * "Unload all models". It stays available while a load is pending and ends
   * that load first: the load would bring its model in right after the unload.
   * GH #235 follow-up: it frees every engine, not only Ollama (Ollama, the LU
   * Engine, LM Studio, ComfyUI's memory; lib/unload-everything.ts), and says
   * per engine what did not go. "Unloaded" only when nothing was left.
   */
  const unloadAllOllama = async () => {
    if (unloading) return
    setUnloading(true)
    setUnloadDone(false)
    setOllamaNote(null)
    ollamaRunAbort.current?.abort()
    yieldSilentLocalRuns()
    try {
      const { outcomes, ollama } = await unloadEverything({ ollama: hasOllamaModels, lmstudio: hasLmStudioRows })
      if (ollama) {
        setOllamaLoaded(new Set([...ollama.stillBusy, ...ollama.failed]))
        if (ollama.failed.length > 0) {
          setOllamaNote({ text: switchFailedSentence('unload', ollama.failed.map(ollamaLabel).join(', '), { timedOut: false }), tone: 'error' })
        } else if (ollama.stillBusy.length > 0) {
          setOllamaNote({ text: stillBusySentence(ollama.stillBusy.map(ollamaLabel)), tone: 'info' })
        }
      }
      if (outcomes.some((o) => o.engine === 'lmstudio' && o.freed)) setLmsLoaded([], lmStudioGoneMark())
      const others = unloadProblems(outcomes.filter((o) => o.engine !== 'ollama' || !ollama))
      log.info('[picker] "Unload all models"', { freed: unloadedNames(outcomes) })
      if (others) {
        setOllamaNote({ text: others, tone: 'error' })
      } else if (!outcomes.some((o) => o.problem)) {
        setUnloadDone(true)
        setTimeout(() => setUnloadDone(false), 2000)
      }
    } finally {
      setUnloading(false)
    }
  }

  /**
   * §18, Select a model, auto-loading it into LM Studio first when needed.
   *
   * Routing (getProviderForModel) keys only on the `openai::` prefix, so an
   * LM Studio model's HTTP requests go out regardless of whether the model
   * is actually loaded in the server, picking an UNloaded one used to fail
   * silently at the HTTP layer (404 from LM Studio). So: if the picked row is
   * an LM Studio model that isn't loaded, load it (await) BEFORE activating,
   * showing an inline "loading…" state; only then setActiveModel + close. On
   * load failure we keep the dropdown open and surface the error instead of
   * activating a model that can't answer. Non-LM-Studio rows are unaffected,    * they activate immediately exactly as before.
   */
  const handleSelectModel = async (model: AIModel) => {
    const id = lmsIdOf(model)
    setImWechselZu(model.name)
    // The pick outranks what the app runs on its own (lib/silent-runs.ts).
    yieldSilentLocalRuns()
    try {
      await selectModelInner(model, id)
    } finally {
      setImWechselZu(null)
    }
  }

  const selectModelInner = async (model: AIModel, id: string) => {

    // A16 (A14-3a): a row belonging to the backend our engine displaced hands
    // the slot back to it. First thing in the function, because everything
    // below asks who holds the slot: the auto-load branch would warm a model
    // in LM Studio and then route the chat at 8127, and the LU Engine branch
    // would try to load an LM Studio id as a GGUF.
    const handedBackTo = handBackChatProviderForRow(model as unknown as InstalledModelLike)
    if (handedBackTo) announceChatProviderSwitch(handedBackTo, model.name)

    // A model whose cancelled load LM Studio is still finishing may be listed
    // as loaded for a moment before it is unloaded. Picking it is asking for
    // it again, which goes through the load and keeps it.
    const stillEnding = lmsEnding.has(id) && isLmStudioProvider(model.providerName)
    if (stillEnding || shouldAutoLoadForSelect(model, lmsLoaded)) {
      if (selectingLms || togglingLms) return // a load is already in flight
      const label = modelDisplayLabel(models, model.name)
      // The load this pick starts is ended on the switch of its row, like
      // every load (lib/lmstudio-switch.ts).
      const cancel = new AbortController()
      lmsRunAbort.current = cancel
      setSelectError(null)
      setLmsNote(null)
      setSelectingLms(id)
      setLmsRun({ name: id, kind: 'load', via: 'pick' })
      try {
        await loadLmStudioModel(id, lmsLoadContextNow(model), { signal: cancel.signal })
        // Confirm it actually loaded before we route chat at it.
        const loaded = await rereadLmsLoaded()
        if (!loaded?.has(id)) {
          setSelectError(`Couldn't load "${displayModelName(model.name)}" into LM Studio. Try the On/Off button on the model's row, or load it in LM Studio directly.`)
          return // keep dropdown open; don't activate an unloaded model
        }
        setActiveModel(model.name)
        clearEngineErrorAfterSuccess()
        setOpen(false)
      } catch (e) {
        // The person's own Cancel needs no sentence: the pick is simply not made.
        if (!cancel.signal.aborted) {
          log.warn('[picker] picking the LM Studio model could not load it', { model: id, err: e })
          setSelectError(lmsFailure('load', label, e))
        }
        await rereadLmsLoaded()
      } finally {
        if (lmsRunAbort.current === cancel) lmsRunAbort.current = null
        setLmsRun(null)
        setSelectingLms(null)
      }
      return
    }

    // LU Engine rows (ENG-4): swap the GGUF (await) BEFORE activating, the
    // same contract as the LM Studio path above. A failed llama-server start
    // keeps the dropdown open and shows the real reason (Rust appends the
    // stderr tail) instead of activating a model that can't answer. Idempotent
    // when the model is already loaded (the Rust side compares argv + health).
    //
    // A14: the second half of the condition is the case where the LU Engine is
    // listed but not in front. The rows are visible now on a machine where
    // Ollama or LM Studio holds the chat, and a row you can see and cannot use
    // would be worse than the old invisibility, so the pick takes the slot
    // first and says so.
    if ((isManagedBuiltinActive() && isOpenAISlotModel(model.name))
        || isBuiltinEngineEntry(model as unknown as InstalledModelLike)) {
      // A14 fourth review: `selectingLms` is this component's own state and it
      // only ever knew about this dropdown, while the Installed card had a
      // bolt of its own that only ever knew about the card. Two doors into one
      // llama-server, and a pick here while a card swap is running sent the
      // second swap_bundled_model at a process the first was still restarting.
      // Both doors share one bolt now (api/lu-engine-swap-lock), and a blocked
      // pick says so instead of doing nothing.
      //
      // A16 (A14-6): it did not, on this door. `if (selectingLms ||
      // togglingLms) return` stood one line ABOVE the bolt and returned in
      // total silence, so the second quick pick never reached the sentence
      // written for it. The three conditions are one condition, "something is
      // already going on", and they get one answer. The order matters: the
      // bolt is only asked for, and therefore only taken, when the first two
      // are clear.
      if (selectingLms || togglingLms || !tryAcquireLuEngineSwap()) {
        // A16 counter-check follow-up: one condition, but not one wait. The
        // first two flags are this component's own state and are also set
        // while LM STUDIO loads a model, which has nothing to do with our
        // engine. The bolt is what says a swap of ours is running, so it
        // decides which of the two sentences is true.
        //
        // Both places in either case, because they outlive different things:
        // the dropdown line dies when the dropdown closes, the standing row
        // above the composer survives that and is where the card writes too.
        if ((selectingLms || togglingLms) && !luEngineSwapInFlight()) {
          announceLmStudioLoadBusy()
          setSelectError(LM_STUDIO_LOAD_BUSY_NOTE)
          return
        }
        announceLuEngineSwapBusy()
        setSelectError(LU_ENGINE_SWAP_BUSY_NOTE)
        return
      }
      setSelectError(null)
      setSelectingLms(id)
      // Der Fangzweig unten muss wissen, ob der Platz schon uebergeben war,
      // also steht die Antwort ausserhalb des try. Die Uebergabe selbst bleibt
      // drin, damit sie weiter mitgefangen wird.
      let switched = false
      // Was vorher gewaehlt war, fuer den Rueckweg. Genau wie auf der Kachel.
      const vorherAktiv = useModelStore.getState().activeModel
      try {
        // Announced BEFORE the start is attempted and NOT into this dropdown,
        // which the pick closes a few lines further down. It goes to the
        // standing status row above the composer, so it survives both the
        // close on success and the error banner on failure (A14 review 2).
        switched = ensureLuEngineIsChatProvider()
        if (switched) {
          announceLuEngineSwitch()
        }
        // Die Wahl steht SOFORT, nicht erst wenn die Engine bedient. Die
        // Kachel macht das laengst so, der Waehler schrieb sie erst hinter
        // dem `await`, und ein Ladevorgang dauert Sekunden bis Minuten.
        //
        // Persona P5, 03./04.09.2026, am echten Build: nach einem Klick auf
        // Phi-4-mini nannte das Eingabefeld 11 s lang
        // "Hermes-3-Llama-3.2-3B", ein Modell, das an dem Wechsel gar nicht
        // beteiligt war. Waehrend des Wartens wechselt naemlich der
        // Steckplatz, die Modelliste wird neu gebaut, und die Regel in
        // lib/active-model-mode findet die ALTE Wahl darin nicht mehr wieder
        // und faellt auf den Kopf der Liste zurueck. Steht die neue Wahl
        // schon da, findet sie sich und nichts faellt zurueck.
        //
        // Rohes set: der Wrapper aus useModels wuerde ein zweites, sinnloses
        // activate ausloesen.
        useModelStore.getState().setActiveModel(model.name)
        const swapped = await activateBuiltinModel(model.name)
        // Keine unserer GGUFs: die gewoehnliche Aktivierung ueber den Wrapper
        // holt nach, was dieser Weg nicht kann.
        if (!swapped) setActiveModel(model.name)
        clearEngineErrorAfterSuccess()
        setOpen(false)
      } catch (e) {
        // Und zurueck, wenn nichts daraus wurde. Ohne das stuende die Wahl
        // auf einem Modell, das nirgends laeuft (derselbe Befund, den die
        // Kachel am 03.09.2026 hatte).
        if (useModelStore.getState().activeModel === model.name) {
          useModelStore.getState().setActiveModel(vorherAktiv)
        }
        // Shared with the Installed card, which used to swallow this failure
        // whole. One sentence, one place it is written (A14 third review).
        //
        // Und in BEIDE Zeilen, nicht nur in diese hier. Persona P5 hat am
        // 03.09.2026 am echten Build den Waehler zwei Sekunden nach dem Klick
        // geschlossen, so wie ein Mensch es tut: die Antwort kommt erst 12 bis
        // 21 s spaeter, sie stand nur in diesem Kasten, und der Kasten war
        // weg. 7,4 s ohne Engine, zwei Prozessstarts, und 75 s lang keine
        // einzige neue Textzeile auf der Seite.
        // NICHT in den Kasten im Menue: das Menue geht in derselben
        // Bewegung zu, und der Kasten waere ein rotes Aufblitzen fuer die
        // Dauer der Ausblendung. Die Zeile ueber dem Eingabefeld traegt den
        // ganzen Text und bleibt stehen.
        announceLuEngineStartFailure(model.name, e, switched)
        // Und das Menue geht zu, damit die Zeile ueber dem Eingabefeld frei
        // liegt. Gegenprobe G1, 04.09.2026, nachgemessen: das offene Menue
        // verdeckte 331 von 763 Pixeln seines eigenen Banners, also 43
        // Prozent, und der Text im Menue war zu 69 Prozent abgeschnitten
        // (scrollHeight 576 gegen clientHeight 176). Zwei Schriftstuecke,
        // beide halb, keines ganz. Die Zeile ueber dem Eingabefeld ist die
        // dauerhafte: sie hat keine Uhr, sie hat ein X, und der Waehler kann
        // sie nicht mehr verdecken, wenn er zu ist.
        setOpen(false)
      } finally {
        setSelectingLms(null)
        releaseLuEngineSwap()
      }
      return
    }

    // Non-LM-Studio, or an already-loaded LM Studio model: activate now.
    setActiveModel(model.name)
    // Und die stehende Fehlerzeile ist damit auch erledigt. Sie hat absichtlich
    // keine Uhr, also war der gewoehnliche Ausgang bisher der einzige Weg aus
    // dem Waehler, der sie stehen liess: kaputte GGUF anklicken, Banner, dann
    // im selben Menue ein Ollama-Modell waehlen, und das Banner stand ueber
    // einem Chat, der laengst wieder antwortete. Der Weg ueber die LU Engine
    // raeumt sie seit G3, dieser hier nicht.
    clearEngineErrorAfterSuccess()
    setOpen(false)
  }

  /**
   * The answer a click on a switched-off row gets (A17).
   *
   * Not a queued pick: the click is still refused, it just stops being silent.
   * `blockedPickWait` decides whether there is anything to say at all, so a row
   * switched off for some other reason keeps its silence.
   */
  const announceBlockedPick = (pickInFlight: boolean) => {
    const wait = blockedPickWait(pickInFlight, luEngineSwapInFlight())
    if (wait === null) return
    if (wait === 'lm-studio') {
      announceLmStudioLoadBusy()
      setSelectError(LM_STUDIO_LOAD_BUSY_NOTE)
      return
    }
    announceLuEngineSwapBusy()
    setSelectError(LU_ENGINE_SWAP_BUSY_NOTE)
  }

  useEffect(() => { fetchModels() }, [fetchModels])

  // Und bei jedem Aufklappen noch einmal. Der Modellordner ist eine Sache der
  // Platte, nicht der Anwendung: eine Datei kann dazugekommen oder
  // verschwunden sein, seit die Liste zuletzt gelesen wurde, und es gibt
  // keinen Waechter darauf.
  //
  // Persona P5, 03./04.09.2026, am echten Build: eine gerade angelegte GGUF
  // fehlte im Waehler, und eine laengst geloeschte stand noch darin. Erst der
  // Refresh-Knopf auf Models, Installed hat die Liste in Ordnung gebracht.
  // Der Moment des Aufklappens ist genau der, in dem die Liste zaehlt, und
  // ein Ordnerlauf je Klick ist billiger als eine falsche Liste. Beim
  // Zuklappen nicht, das waere Arbeit fuer niemanden.
  useEffect(() => { if (open) void fetchModels() }, [open, fetchModels])

  // GH #118: an empty picker used to say "No models available" no matter what
  // was wrong, so a built-in engine that never started read like a machine
  // with nothing installed. Asked only while the dropdown is open and the list
  // is empty, and never repairs, because opening a dropdown must not boot a server.
  const [emptyReason, setEmptyReason] = useState('')
  // What the LM Studio line last heard from the server, see `allTextModels`.
  const [lmStudioServerOff, setLmStudioServerOff] = useState(false)
  useEffect(() => {
    if (!open || textModelsEmptyRef.current === false) return
    let cancelled = false
    diagnoseBuiltinEngine({ repair: false })
      .then((d) => { if (!cancelled && !d.ok && d.reason) setEmptyReason(d.reason) })
      .catch(() => { /* nothing to add, the generic line stands */ })
    return () => { cancelled = true }
  }, [open])

  // Refetch when a provider change makes the list stale (the user enables LM
  // Studio in Settings, the backend picker activates an OpenAI-compatible
  // provider, a click hands the shared slot on). Without this the dropdown
  // stays stuck on whatever providers were enabled at mount time. Die Regel
  // steht in lib/model-list-staleness, dieselbe, die auch die Kopfleiste
  // fragt.
  useEffect(() => {
    const unsub = useProviderStore.subscribe((state, prev) => {
      if (modelListIsStale(state.providers, prev.providers)
        || openaiEntriesAreStale(state.openaiEntries, prev.openaiEntries)) fetchModels()
    })
    return () => unsub()
  }, [fetchModels])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      // The rate popover of the Cloud picker is lifted out to the body. It
      // belongs to the menu, so a press on it is not a press outside.
      if (e.target instanceof Element && e.target.closest('[data-model-rate]')) return
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Read reactively, not through isManagedBuiltinActive(): the grouping below
  // has to redraw the moment a pick hands the slot to the engine.
  const luEngineHoldsChat = useProviderStore((s) => s.providers.openai.enabled && s.providers.openai.managed === true)
  // Ebenfalls reaktiv, und aus demselben Grund: gibt ein Klick den Steckplatz
  // zurueck, verschwindet die Ueberschrift im selben Zug.
  const standbyName = useProviderStore((s) => standbyBackendOf(s.providers.openai as HandoverSlot)?.name ?? null)
  // Der Name des fremden Backends, das den Steckplatz gerade haelt. Auch
  // reaktiv, aus demselben Grund wie standbyName: ein Klick kann den Platz
  // weiterreichen, und die Gruppierung muss das mitbekommen.
  const holderName = useProviderStore((s) =>
    s.providers.openai.enabled && s.providers.openai.managed !== true
      ? (s.providers.openai.name ?? null)
      : null,
  )
  const foldedRows = useModelStore((s) => s.foldedRows)
  // Ein Wechsel laeuft, solange der Waehler einen fuehrt oder das Backend
  // eines meldet. Beides faerbt den Punkt und dreht den Ring, damit der Name
  // im Knopf nie ohne Vorbehalt dasteht, wenn er noch nicht bedient.
  // Der Riegel kommt dazu, weil `imWechselZu` nur Kliks in DIESEM Menue kennt
  // und mit dem Bauteil stirbt. Nachpruefung G3, 04.09.2026: der Knopf nennt
  // das angeklickte Modell nach 15 bis 29 ms, die Engine haelt es erst nach
  // 16,7 bis 19,3 s. Das ist Absicht, der Knopf nennt die Wahl. Nur muss dann
  // auch dranstehen, dass sie noch nicht bedient, und zwar auch dann, wenn der
  // Klick von der Models-Kachel kam oder der Nutzer zwischendurch den Reiter
  // gewechselt hat.
  const gezeigtesModell = imWechselZu ?? activeModel
  const swapLaeuft = useLuEngineSwapRunning()
  const wechselLaeuft = isModelLoading || imWechselZu !== null
    || (swapLaeuft && isOpenAISlotModel(gezeigtesModell ?? ''))
  const gezeigtesObj = models.find((m) => m.name === gezeigtesModell)
  const activeDisplayName = gezeigtesModell ? modelDisplayLabel(models, gezeigtesModell) : NO_MODEL_LABEL
  // Der Punkt folgt demselben Modell wie der Name daneben, sonst haette der
  // Knopf waehrend eines Wechsels zwei Aussagen in sich.
  const activeType = gezeigtesObj?.type || 'text'
  // Chat dropdown shows TEXT models only, image/video live in the
  // Create view's own picker. Everything here is grouped by the model
  // FAMILY (Qwen/Gemma/Llama/…), not by provider, because users pick
  // models by lineage first and the backend that serves them is a
  // per-row badge.
  // Minus the rows of an LM Studio whose server is off (Windows box,
  // 05.10.2026: "server off" stood above seven of its models for 160 s, and a
  // click on one could only fail). The pick itself is not touched.
  const allTextModels = models
    .filter((m) => m.type === 'text')
    .filter((m) => !(lmStudioServerOff && isLmStudioProvider(m.providerName)))
  // Code needs tools to do literally anything. A hosted model that has told us
  // it cannot call them is not a degraded choice there, it is a dead one, so it
  // does not get listed. Keep the ACTIVE model visible even if it fails the
  // check, or switching away from it becomes impossible.
  const textModels = surface === 'code'
    ? allTextModels.filter((m) => m.name === activeModel || canUseTools({ name: m.name, supportsTools: m.supportsTools }))
    : allTextModels
  const hiddenForCode = allTextModels.length - textModels.length
  // A14: die Zeilen, deren Wahl das lokale Backend wechselt, stehen unter
  // ihrer eigenen Ueberschrift statt zwischen den Modellfamilien, denn ein
  // Klick darauf hat eine Folge und die Ueberschrift ist die billigste Stelle,
  // sie VOR dem Klick zu nennen. Welche Zeilen das sind, haengt daran, wer den
  // Steckplatz haelt: unsere GGUFs unter einem fremden Backend, die Zeilen des
  // wartenden Backends unter unserer eigenen Engine. Gibt es nichts zu
  // wechseln, gruppiert der Waehler nach Familie wie eh und je, denn dann gibt
  // es keine Folge zu melden und Abstammung ist, wonach Menschen waehlen.
  //
  // K6 (3.0.1): siehe computeModelGroups oben fuer die volle Begruendung, warum
  // dieser Schritt jetzt gegen einen Absturz gepanzert ist statt roh JSX zu
  // fuettern.
  const { groups, showHeadings, groupingFailed } =
    computeModelGroups(textModels, luEngineHoldsChat, standbyName, holderName)
  const hasOllamaModels = textModels.some(m => ('provider' in m && m.provider === 'ollama') || !('provider' in m))
  // GH #235 follow-up: the unload button is there for every local engine, also
  // when only the LU Engine runs (a managed engine exists on the desktop only).
  const hasLmStudioRows = textModels.some((m) => isLmStudioProvider(m.providerName))
  const showUnloadAll = hasOllamaModels || hasLmStudioRows || luEngineHoldsChat
  textModelsEmptyRef.current = textModels.length === 0

  // The one reason this picker switches rows off: a pick is already running.
  // Kept as its own name because a refused click hands exactly this to
  // `blockedPickWait`, which is what keeps any future second reason silent
  // (A17).
  const pickInFlight = selectingLms !== null || togglingLms !== null
  // An Ollama switch is deliberately not part of it (lib/ollama-switch.ts).
  const ollamaWaitLine = loadingOllama ? waitingForSentence(ollamaWaitingFor.map(ollamaLabel)) : null

  // What an empty list says, in both modes. An empty picker after the user
  // switched the last backend off in Settings used to say only "No models
  // available", which reads like a machine with nothing installed
  // (Nebenbefund 1, R9 re-measure). The reason and the way back belong here.
  // Ruhiger Ton aus `lib/hinweis.ts`: der Nutzer hat das Backend selbst
  // ausgeschaltet, das ist kein Zwischenfall, sondern die Antwort auf „warum
  // ist die Liste leer". Der Knopf darunter traegt den Weg zurueck.
  const emptyList = (
    <div className="px-2.5 py-3 text-center">
      <p className="t-micro text-gray-600">No models available</p>
      {noBackendEnabled ? (
        <>
          <p className={`mt-1 t-micro leading-snug text-left ${HINWEIS_TEXT.ruhig}`}>
            No AI backend is enabled, so there is nothing to list. Open Settings, go to AI Backends, and press Enable on the backend you switched off, or Add Provider.
          </p>
          <button
            onClick={() => { setOpen(false); openSettingsAt({ tab: 'backends' }) }}
            className="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded bg-white/5 border border-white/10 t-micro text-gray-300 hover:bg-white/10 transition-colors"
          >
            <SettingsIcon size={10} /> Open Settings
          </button>
        </>
      ) : emptyReason && (
        <p className={`mt-1 t-micro leading-snug text-left ${HINWEIS_TEXT.ruhig}`}>{emptyReason}</p>
      )}
    </div>
  )

  // The lines under the search of the Cloud picker: what needs attention now.
  // Same sentences and the same test ids as the lines of the local menu.
  const cloudNotes: PickerNote[] = [
    ...(selectError ? [{ testId: 'model-picker-error', text: selectError, tone: 'error' as const }] : []),
    ...(engineSwitchNote ? [{
      testId: 'picker-engine-note',
      text: engineSwitchNote,
      tone: engineSwitchTone === 'error' ? 'error' as const : 'info' as const,
      onDismiss: () => useLuEngineSwitchStore.getState().dismiss(),
    }] : []),
    // In Cloud the app picks no model by itself, so a menu without a pick is
    // the normal state of a new account there. The line says what the pick is
    // for; after a send was tried it adds, in the same line, that the message
    // is still in the composer.
    ...(sendNeedsModel
      ? [{
          testId: 'picker-send-needs-model',
          text: textModels.length > 0 ? `${CHOOSE_TO_SEND} ${MESSAGE_IS_KEPT}` : NO_MODEL_LISTED,
          tone: 'info' as const,
        }]
      : !activeModel && textModels.length > 0
        ? [{ testId: 'picker-choose-a-model', text: CHOOSE_TO_SEND, tone: 'info' as const }]
        : []),
  ]

  return (
    <div ref={ref} className="relative">
      {/* ── Trigger Button ── */}
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        title={
          answeredBy
            ? `The answers in this chat were written by ${answeredBy}. The next answer runs on the model picked here.`
            : activeModel ? `Model: ${activeDisplayName}, click to switch`
              : sendNeedsModel ? 'Your message needs a chat model. Pick one here to send it.' : 'Select a chat model'
        }
        aria-label="Select chat model"
        aria-expanded={open}
        // Laedt gerade ein Modell: `aria-busy` statt eines eigenen blauen
        // Rezepts mit Leuchtschatten. Das Rezept faerbt die Kante mit dem
        // Akzent, die Aussage steht damit im selben Vokabular wie der Rest
        // der Leiste, und im Accessibility-Baum, wo sie hingehoert.
        aria-busy={wechselLaeuft}
        // max-w-full + min-w-0 below: in a tight composer row the name
        // ellipsizes inside the slot ChatInput lets shrink.
        className="lu-control max-w-full"
      >
        {/* Type indicator dot */}
        <span className={`w-1.5 h-1.5 rounded-full ${
          activeType === 'text' ? 'bg-blue-400' : activeType === 'image' ? 'bg-purple-400' : 'bg-emerald-400'
        } ${wechselLaeuft ? 'animate-pulse' : ''}`} />

        {/* Model name. Keine eigene Textfarbe mehr, sie wird vom Control
            geerbt, sonst haette der Knopf zwei Graustufen in sich. */}
        <span className="min-w-0 max-w-[140px] truncate leading-none">
          {activeDisplayName}
        </span>

        {/* Chevron / Spinner */}
        {wechselLaeuft ? (
          <Loader2 size={10} className="animate-spin" />
        ) : (
          <ChevronDown size={10} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        )}
      </button>

      {/* The open chat ran on another model than the one picked here. Absolute
          so the row keeps its width to the pixel, and quiet enough that it is
          a mark rather than a message: the sentence lives in the tooltip. */}
      {answeredBy && (
        <span
          data-testid="conversation-model-dot"
          aria-hidden="true"
          className="pointer-events-none absolute -top-0.5 -right-0.5 w-1 h-1 rounded-full bg-gray-500 opacity-60"
        />
      )}

      {/* Derselbe winzige Punkt, den das Haus schon fuer "hier ist etwas Neues"
          benutzt (Workflow-Knopf in create/experimental/Composer.tsx, How-to in
          SpecialIntentControls.tsx): kein Text, keine Leiste, nur die Marke,
          dass im Menue eine Zeile wartet. Verschwindet mit dem X. */}
      {showEngineNotice && (
        <span
          data-testid="picker-engine-missing-dot"
          aria-hidden
          className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-lu-accent pointer-events-none"
        />
      )}

      {/* Derselbe Punkt fuer die stehende Modellzeile, damit ihr Umzug in den
          Aufklapper sie nicht unsichtbar macht: sie steht hinter einem Klick,
          und dieser Punkt ist der Hinweis darauf, dass es etwas zu lesen gibt.
          Rot, wenn ein Start gescheitert ist, sonst der gewoehnliche Akzent. */}
      {engineSwitchNote && !showEngineNotice && (
        <span
          data-testid="picker-engine-note-dot"
          aria-hidden
          className={`absolute top-0 right-0 w-1.5 h-1.5 rounded-full pointer-events-none ${
            engineSwitchTone === 'error' ? 'bg-red-500' : 'bg-lu-accent'
          }`}
        />
      )}

      {/* A send is waiting for a model and the menu is closed: the same dot,
          as the way back to the sentence in the menu. */}
      {sendNeedsModel && !open && (
        <span
          data-testid="picker-send-needs-model-dot"
          aria-hidden
          className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-lu-accent pointer-events-none"
        />
      )}

      {/* ── Dropdown ── */}
      <AnimatePresence>
        {open && (
          <motion.div
            data-testid="model-picker-menu"
            data-picker={cloudPicker ? 'cloud' : 'local'}
            ref={menueRef}
            style={cloudPicker ? { width: CLOUD_PICKER_WIDTH, ...menue.style } : menue.style}
            className={`absolute z-50 lu-elevated ${
              // Cloud: the new picker, a column whose list scrolls by itself.
              // Local: the list as it always was, the menu scrolls as a whole.
              cloudPicker
                ? 'lu-picker flex flex-col overflow-hidden'
                : 'w-72 rounded-lg overflow-x-hidden overflow-y-auto scrollbar-thin'
            } ${
              menue.nachOben ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
            } ${openUpward ? 'right-0' : 'left-1/2 -translate-x-1/2'}`}
            initial={{ opacity: 0, y: menue.nachOben ? 6 : -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: menue.nachOben ? 6 : -6, scale: 0.98 }}
            transition={{ duration: MOTION_S.fast, ease: 'easeOut' }}
          >
            {cloudPicker ? (
              <CloudModelPicker
                models={textModels}
                activeModel={activeModel}
                loading={!inventoryLoaded}
                notes={cloudNotes}
                hiddenForCode={hiddenForCode}
                empty={emptyList}
                listRef={cloudListRef}
                onPick={(model) => {
                  // A17: a pick while another one is running is refused, and
                  // says which wait it ran into.
                  if (pickInFlight) { announceBlockedPick(pickInFlight); return }
                  void handleSelectModel(model)
                }}
                onTookFocus={(from) => { focusCameFrom.current = from }}
              />
            ) : (<>
            {/* First of all: why the menu opened by itself. The message the
                user tried to send is still in the composer. */}
            {sendNeedsModel && (
              <div
                data-testid="picker-send-needs-model"
                className={`px-2.5 py-1.5 border-b border-black/5 dark:border-white/[0.06] t-micro leading-snug ${HINWEIS_TEXT.ruhig}`}
              >
                {textModels.length > 0 ? `${CHOOSE_TO_SEND} ${MESSAGE_IS_KEPT}` : NO_MODEL_LISTED}
              </div>
            )}
            {/* Noch vor der Engine-Zeile: was sich am Modell selbst geaendert
                hat, waehrend der Nutzer woanders hinsah. Begruendung des
                Platzes oben an `engineSwitchNote`. */}
            {engineSwitchNote && (
              <div
                data-testid="picker-engine-note"
                data-tone={engineSwitchTone}
                className={`flex items-start gap-1.5 px-2.5 py-1.5 border-b border-black/5 dark:border-white/[0.06] text-[0.55rem] ${
                  engineSwitchTone === 'error' ? HINWEIS_TEXT.fehler : HINWEIS_TEXT.ruhig
                }`}
              >
                <span className="flex-1 min-w-0 leading-snug">
                  {engineSwitchNote}
                  {/* 3.0.8 (A25): "Context 16K" / "KV q8_0" under a fit sentence. */}
                  <FitActionButtons
                    actions={engineSwitchActions}
                    modelPath={engineSwitchActionModel}
                    onApplied={() => useLuEngineSwitchStore.getState().dismiss()}
                    className="mt-1"
                  />
                </span>
                <button
                  onClick={() => useLuEngineSwitchStore.getState().dismiss()}
                  aria-label="Dismiss"
                  title="Dismiss"
                  className="shrink-0 rounded p-[1px] opacity-70 hover:opacity-100 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                >
                  <X size={10} />
                </button>
              </div>
            )}

            {/* Ganz oben, vor allem anderen: LU Engine ist aus der
                Anbieterliste gefallen. Ruhiger Ton statt Rot-Alarm und kein
                eigener Kasten im Kasten (lib/hinweis.ts), der Akzent traegt
                nur den Textknopf. Der Knopf nimmt denselben Weg nach Settings,
                den dieses Menue weiter unten schon nimmt. */}
            {showEngineNotice && (
              <div
                data-testid="picker-engine-missing"
                className={`flex items-start gap-1.5 px-2.5 py-1.5 border-b border-black/5 dark:border-white/[0.06] text-[0.55rem] ${HINWEIS_TEXT.ruhig}`}
              >
                <AlertTriangle size={10} className="shrink-0 mt-[1px]" />
                <span className="flex-1 min-w-0">
                  LU Engine is missing from your providers.{' '}
                  <button
                    data-testid="picker-engine-missing-open"
                    onClick={() => { setOpen(false); openSettingsAt({ tab: 'backends' }) }}
                    className="text-lu-accent underline underline-offset-2"
                  >
                    Open AI Backends
                  </button>
                </span>
                <button
                  onClick={() => { dismissEngineNoticeForSession(); setEngineNoticeHidden(true) }}
                  aria-label="Dismiss"
                  title="Dismiss"
                  className="shrink-0 rounded p-[1px] opacity-70 hover:opacity-100 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                >
                  <X size={10} />
                </button>
              </div>
            )}

            {/* Bug Q v2.4.7: LM Studio is on disk but its server is off.
                a user's "can't choose any models i have installed"
                symptom. One line with a "Start" button. Local mode only: in
                Cloud the list shows hosted models, and what the line promises
                (pick LM Studio models here) would not come true there. */}
            <LmStudioStatusLine onStarted={fetchModels} onServerOff={setLmStudioServerOff} />

            {/* K6: grouping threw and was caught above instead of crashing the
                whole chat view. Says so, in the dropdown itself, with a way
                to try again, the fallback list below still works, this is
                just honesty about why it looks flat. */}
            {groupingFailed && (
              <div className={`px-2.5 py-1.5 border-b border-black/5 dark:border-white/[0.06] text-[0.55rem] ${HINWEIS_TEXT.ruhig} flex items-center justify-between gap-2`}>
                <span>Couldn't group the model list, showing it flat.</span>
                <button
                  onClick={() => void fetchModels()}
                  data-testid="model-grouping-retry"
                  className="underline shrink-0"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Say WHY the list is shorter here than in Chat, otherwise a
                missing favourite reads as a bug. */}
            {hiddenForCode > 0 && (
              <div className="px-2.5 py-1.5 border-b border-black/5 dark:border-white/[0.06] text-[0.55rem] text-gray-500">
                {hiddenForCode} cloud {hiddenForCode === 1 ? 'model is' : 'models are'} hidden here because they cannot call tools. They are still in Chat.
              </div>
            )}

            {/* Dieselbe Ehrlichkeit eine Zeile weiter, und in BEIDE
                Richtungen: was zwei Backends aus derselben Datei anbieten,
                steht nur einmal da. Ohne diesen Satz sehen Modelle
                verschwunden aus (Persona P5: LM Studio meldet 7, der Waehler
                zeigt 4. Gegenprobe G1, andere Richtung: eine installierte
                Datei des Kunden von 2,3 GB faellt kommentarlos weg). */}
            {foldedRows && (
              <div
                data-testid="picker-folded-rows"
                className="px-2.5 py-1.5 border-b border-black/5 dark:border-white/[0.06] text-[0.55rem] text-gray-500"
              >
                {foldedRowsSentence(foldedRows)}
              </div>
            )}

            {/* §18, surfaced when an LM Studio auto-load (on select) failed,
                so the user isn't left wondering why the model didn't switch. */}
            {selectError && (
              <div
                data-testid="model-picker-error"
                className="mx-2 mt-2 px-2 py-1.5 rounded bg-red-500/10 border border-red-500/20 t-micro text-red-600/90 dark:text-red-300/90 leading-snug max-h-[22vh] overflow-y-auto overflow-x-hidden scrollbar-thin whitespace-pre-wrap break-words"
              >
                {selectError}
              </div>
            )}

            {/* The Ollama switches: why a load is not moving, and what the
                last switch has to say (lib/ollama-switch.ts). */}
            {ollamaWaitLine && (
              <div
                data-testid="picker-ollama-waiting"
                className={`px-2.5 py-1.5 border-b border-black/5 dark:border-white/[0.06] t-micro leading-snug ${HINWEIS_TEXT.ruhig}`}
              >
                {ollamaWaitLine}
              </div>
            )}
            {ollamaNote && <SwitchNoteLine testId="picker-ollama-note" note={ollamaNote} onDismiss={() => setOllamaNote(null)} />}
            {/* The LM Studio switches: what the last one has to say
                (lib/lmstudio-switch.ts). */}
            {lmsNote && <SwitchNoteLine testId="picker-lmstudio-note" note={lmsNote} onDismiss={() => setLmsNote(null)} />}
            {lmsUnconfirmed.length > 0 && (
              <SwitchNoteLine
                testId="picker-lmstudio-unconfirmed-note"
                note={{ text: lmStudioUnconfirmedSentence(lmsUnconfirmed.map((id) => displayModelName(id))), tone: 'error' }}
                onDismiss={dismissUnconfirmedLmStudioLoads}
              />
            )}

            {/* Scrollable model list */}
            <div className="py-1 max-h-[280px] overflow-y-auto scrollbar-thin">
              {!inventoryLoaded && textModels.length === 0 && <ModelPickerSkeleton />}
              {inventoryLoaded && textModels.length === 0 && emptyList}

              {groups.map(({ family, models: groupModels }, gi) => (
                <div key={`${gi}-${family}`}>
                  {/* Section header. One group normally draws none; an LU
                      Engine group under a foreign chat backend draws one
                      anyway, because that heading is the warning that picking
                      from it moves the backend (A14 review 7). */}
                  {showHeadings && (
                    <div className="px-2.5 pt-2 pb-0.5">
                      <span className="text-[0.55rem] font-medium uppercase tracking-widest text-gray-600">
                        {family}
                      </span>
                    </div>
                  )}

                  {groupModels.map((model: AIModel) => {
                    const modelDisplayName =
                      ('displayName' in model && model.displayName) || displayModelName(model.name)
                    // Fremde Kennungen tragen Pfadteile und Dateiendungen mit
                    // sich, die kein Kunde gewaehlt hat. Der Name selbst bleibt
                    // unangetastet (lib/model-label).
                    const { head: nameKopf, tail: nameEnde } = splitForMiddleEllipsis(modelDisplayName)
                    const modelProvider = ('provider' in model && model.provider) || 'ollama'
                    const providerBadge = getProviderBadge(model)
                    const isActive = model.name === activeModel

                    const isLmsRow = isLmStudioProvider(('providerName' in model && model.providerName) as string | undefined)
                    // Local Ollama row (provider 'ollama' or legacy no-provider) →
                    // gets the on/off load toggle too. Excludes LM Studio + cloud.
                    const isOllamaRow = !isLmsRow && modelProvider === 'ollama'
                    const rowId = lmsIdOf(model)
                    const isSelectingThis = selectingLms === rowId
                    // The row carries the per-LM-Studio-model power toggle, itself
                    // a <button>. A <button> can't nest a <button> (invalid HTML →
                    // React hydration error + flaky clicks), so the row is a
                    // role="button" <div> with explicit keyboard activation.
                    const rowDisabled = pickInFlight

                    return (
                      <div
                        key={model.name}
                        role="button"
                        tabIndex={rowDisabled ? -1 : 0}
                        aria-disabled={rowDisabled}
                        onClick={() => {
                          // A17: the switched-off row used to swallow the
                          // click whole, and both busy sentences sit behind
                          // this door in `handleSelectModel`, so nothing was
                          // ever said. It says the wait now and still does not
                          // pick.
                          if (rowDisabled) { announceBlockedPick(pickInFlight); return }
                          void handleSelectModel(model)
                        }}
                        onKeyDown={(e) => {
                          if (rowDisabled) {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              announceBlockedPick(pickInFlight)
                            }
                            return
                          }
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            void handleSelectModel(model)
                          }
                        }}
                        className={`
                          w-full flex items-center gap-2 px-2.5 py-[5px] mx-1 rounded text-left transition-colors
                          ${isActive
                            ? 'bg-black/[0.06] dark:bg-white/[0.06] text-gray-900 dark:text-white'
                            : 'text-gray-500 dark:text-gray-400 hover:bg-black/[0.04] dark:hover:bg-white/[0.03] hover:text-gray-900 dark:hover:text-gray-200'
                          }
                          ${rowDisabled ? 'cursor-default' : 'cursor-pointer'}
                        `}
                        style={{ width: 'calc(100% - 8px)' }}
                      >
                        {/* Type dot */}
                        <span className={`w-1 h-1 rounded-full shrink-0 ${
                          model.type === 'text' ? 'bg-blue-400/70' : model.type === 'image' ? 'bg-purple-400/70' : 'bg-emerald-400/70'
                        }`} />

                        {/* Model info */}
                        <div className="flex-1 min-w-0 flex items-center gap-1.5">
                          {/* Gekuerzt wird in der MITTE, nicht am Ende.
                              Gegenprobe G1, 04.09.2026: am Ende gekuerzt
                              standen `qwen2.5-0.5b-instruct@...` und
                              `qwen2.5-0.5b-instruct...` untereinander und
                              sahen gleich aus, obwohl das eine q4_k_m und das
                              andere q8_0 ist. Genau das Zeichen, das die
                              beiden unterscheidet, war das erste, das
                              weggeschnitten wurde. */}
                          <span
                            className={`text-[0.7rem] flex min-w-0 ${isActive ? 'text-gray-900 dark:text-white' : ''}`}
                            title={modelDisplayName}
                          >
                            <span className="truncate">{nameKopf}</span>
                            {nameEnde && <span className="shrink-0">{nameEnde}</span>}
                          </span>

                          {/* Marken aus dem Katalog: unzensiert gemessen, ohne
                              Credits. Dasselbe Bauteil wie in der
                              Webanwendung, damit beide Oberflaechen dasselbe
                              sagen. */}
                          <ModelRowMarks model={model as { flash?: CloudModelMarks['flash']; unfiltered?: CloudModelMarks['unfiltered']; unrestricted?: boolean }} />
                          {/* Subtle meta */}
                          {model.type !== 'text' && (
                            <span className={`text-[0.5rem] uppercase font-medium tracking-wide ${TYPE_COLOR[model.type] || 'text-gray-500'} opacity-60`}>
                              {TYPE_LABEL[model.type] || model.type}
                            </span>
                          )}
                          {modelProvider !== 'ollama' && (
                            <span className={`text-[0.5rem] ${providerBadge.color}`}>
                              {providerBadge.label}
                            </span>
                          )}
                          {/* 2.5.8, tool-calling capability at a glance. Text
                              models only.

                              2026-08-06: "wieso ist es nicht toolfähig?
                              Wir haben doch Toolschema für Hermes Modelle."
                              Exactly. The badge used to draw a ban on
                              `supportsTools === false` and say "Agent and Code
                              mode cannot use it", which is wrong for a LOCAL
                              model: resolveToolSupport returns 'hermes' there,
                              not 'none', so the prompt transport drives it and
                              both modes work. The badge was disagreeing with
                              the code that actually runs the turn.

                              So ask resolveToolSupport, which is the one place
                              that layers the proven-rejection cache, the
                              server's own answer and the family heuristic.
                              Three states, not two: native and hermes both get
                              a wrench (they differ only in HOW, which the
                              tooltip says), and only 'none' is a ban. 'none'
                              is reachable for a cloud model alone, because
                              there the translation already happens server-side
                              and a declared no really means no. */}
                          {model.type === 'text' && (() => {
                            const support = resolveToolSupport({
                              name: model.name,
                              supportsTools: 'supportsTools' in model ? model.supportsTools : undefined,
                            })
                            if (support === 'none') {
                              // Das Verbotszeichen stand in Gelb, direkt neben
                              // dem gruenen Schraubenschluessel: zwei Farben
                              // fuer „kann Werkzeuge" und „kann keine". Es
                              // fehlt eine Faehigkeit, es ist nichts kaputt,
                              // also der ruhige Ton aus `lib/hinweis.ts`. Die
                              // Aussage traegt die Glyphe, nicht die Farbe.
                              return (
                                <span
                                  className={`inline-flex items-center shrink-0 ${HINWEIS_TEXT.ruhig}`}
                                  title="This model does not support tool calling, so Agent and Code mode cannot use it"
                                >
                                  <Ban size={9} />
                                </span>
                              )
                            }
                            return (
                              <span
                                className={`inline-flex items-center shrink-0 ${support === 'hermes' ? 'text-emerald-500/60' : 'text-emerald-500/90'}`}
                                title={toolBadgeTitle(model, support)}
                              >
                                <Wrench size={9} />
                              </span>
                            )
                          })()}
                          {/* §18, inline load state while we auto-load this
                              LM Studio model on the way to selecting it. */}
                          {isSelectingThis && (
                            <span className="inline-flex items-center gap-0.5 text-[0.5rem] text-blue-400">
                              <Loader2 size={8} className="animate-spin" />
                              loading…
                            </span>
                          )}
                        </div>

                        {/* Details on right */}
                        <div className="flex items-center gap-1 shrink-0">
                          {/* `type === 'text'` verengt auf OllamaModel | CloudModel,
                              `'details' in model` von dort auf OllamaModel, und
                              nur das hat `details`. Der Zugriff braucht deshalb
                              keine Zusicherung; `parameter_size` ist dort als
                              `string` deklariert (types/models.ts:15). */}
                          {model.type === 'text' && 'details' in model && model.details && (
                            <span className="text-[0.5rem] text-gray-600">
                              {model.details.parameter_size}
                            </span>
                          )}
                          {/* On/Off VRAM load toggle for LOCAL models, LM Studio
                              AND Ollama both get it now (was LM-Studio-only). The
                              old active-row checkmark is gone; the active model is
                              shown by the row highlight, and the dropdown shows a
                              single, clear on/off LOAD state per model. Cloud
                              models have no local VRAM → no toggle. Click stops
                              propagation so the row's select handler doesn't fire. */}
                          {isLmsRow ? (
                            <LoadToggle
                              loaded={lmsLoaded.has(rowId)}
                              state={lmStudioSwitchState(rowId, lmsRun, selectingLms !== null, lmsEnding)}
                              onClick={() => void toggleLmStudioLoad(model)}
                            />
                          ) : isOllamaRow ? (
                            <>
                            {ollamaLoaded.has(model.name) && ollamaOnCpu[model.name] && (
                              <span
                                data-testid="ollama-on-cpu"
                                title={ollamaOnCpu[model.name].title}
                                className="text-[0.5rem] text-gray-500 whitespace-nowrap"
                              >
                                {ollamaOnCpu[model.name].label}
                              </span>
                            )}
                            <LoadToggle
                              loaded={ollamaLoaded.has(model.name)}
                              state={ollamaSwitchState(model.name, ollamaRun)}
                              onClick={() => void toggleOllamaLoad(model)}
                            />
                            </>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))}

              <CloudTeaserSection onOpen={() => setOpen(false)} />
            </div>

            {/* Sticky footer: Unload */}
            {showUnloadAll && (
              <div className="border-t border-black/[0.06] dark:border-white/[0.04] px-1 py-1">
                <button
                  data-testid="ollama-unload-all"
                  onClick={(e) => { e.stopPropagation(); void unloadAllOllama() }}
                  disabled={unloading}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-[5px] rounded t-micro text-red-600/70 dark:text-red-500/60 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-500/[0.06] transition-colors disabled:opacity-40"
                >
                  {unloading ? <Loader2 size={10} className="animate-spin" /> : <Power size={10} />}
                  <span>{unloadDone ? 'Unloaded' : unloading ? 'Unloading...' : 'Unload all models'}</span>
                </button>
              </div>
            )}
            </>)}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
