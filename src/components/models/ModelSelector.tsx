import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'
import { motion, AnimatePresence } from 'framer-motion'
import { Ban, ChevronDown, Loader2, Power, PlayCircle, Settings as SettingsIcon, Wrench, X, Cloud } from 'lucide-react'
import { useModels } from '../../hooks/useModels'
import { useModelStore } from '../../stores/modelStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { unloadAllModels, loadModel, unloadModel, listRunningModels } from '../../api/ollama'
import { displayModelName, getProviderIdFromModel } from '../../api/providers'
import { activateBuiltinModel, isManagedBuiltinActive } from '../../api/engine'
import { diagnoseBuiltinEngine } from '../../api/builtin-ensure'
import { canUseTools, resolveToolSupport, type ToolSupport } from '../../lib/tool-support'
import { backendCall } from '../../api/backend'
import { listLoadedLmStudioModels, loadLmStudioModel, unloadLmStudioModel } from '../../api/lmstudio'
import { isLmStudioProvider } from '../../lib/hf-to-provider'
import { detailOf } from '../../lib/error-text'
import { lmStudioSlotUpdate, adoptionReplacesBuiltinEngine } from '../../lib/lmstudio-backend-adopt'
import { nextProbeDelayMs } from '../../lib/probe-backoff'
import { noChatBackendEnabled } from '../../lib/provider-visibility'
import { cloudTeaserModels } from '../../lib/cloud-teaser-models'
import { splitBackendSwitchRows, needsBackendSwitchHeading } from '../../lib/lu-engine-rows'
import { isBuiltinEngineEntry, type InstalledModelLike } from '../../lib/lmstudio-match'
import type { HandoverSlot } from '../../lib/openai-slot-handover'
import {
  ensureLuEngineIsChatProvider, LU_ENGINE_SWITCH_NOTE, LU_ENGINE_SWAP_BUSY_NOTE,
  announceLuEngineSwapBusy, announceLuEngineStartFailure,
  LM_STUDIO_LOAD_BUSY_NOTE, announceLmStudioLoadBusy,
  handBackChatProviderForRow, chatProviderSwitchNote, standbyBackendOf,
} from '../../api/lu-engine-switch'
import { tryAcquireLuEngineSwap, releaseLuEngineSwap, luEngineSwapInFlight } from '../../api/lu-engine-swap-lock'
import { useLuEngineSwitchStore } from '../../stores/luEngineSwitchStore'
import { ModelPickerSkeleton } from '../layout/ViewSkeletons'
import type { AIModel } from '../../types/models'
import { MOTION_S } from '../ui/motion'

// ── Local-mode cloud discovery (2.5.8): an "LU Cloud" section at the list's
// tail. Signed-in accounts show their real hosted chat models (the appMode
// filter hides them from the selectable list); logged-out shows one generic
// row. Tapping any row opens the Cloud gate (login → plan → beta) — chat rows
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
            Frontier chat models, no GPU needed
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
// dropdown every tick — the common case once the user has stopped loading models
// (vedaiorobotics GH #70: "interface laggy, even when loading models").
function sameStringSet(prev: Set<string>, next: string[]): boolean {
  if (prev.size !== next.length) return false
  for (const n of next) if (!prev.has(n)) return false
  return true
}

// ── Bug Q (v2.4.7 — wakeywakeynow GH #41) ─────────────────────
//
// Symptom: user has LM Studio installed with models on disk, opens LU's
// chat model picker, sees only Ollama models, no hint about LM Studio.
// Root cause: LM Studio's HTTP server doesn't auto-start with the app —
// the user has to click Developer → Start Server in LM Studio, OR run
// `lms server start`. When the server is off, LU's OpenAI-compat probe
// returns nothing and LM Studio is silently dropped from the dropdown.
// v2.4.4 added a "Start LM Studio server" hint to onboarding, but the
// chat picker (where users actually look for their models) never got
// the same treatment. This banner closes that gap. Polls
// `lmstudio_server_status` on dropdown open; renders inline when LM
// Studio is detected on disk (lms.exe present OR models in
// ~/.lmstudio/models/) AND its server isn't running. Clicking "Start
// Server" hits the same Tauri command the Settings panel uses, then
// re-fetches the model list so the LM Studio models appear without a
// restart.

/**
 * Antwort von `lmstudio_server_status`. Deckungsgleich mit der Rust-Seite
 * (`src-tauri/src/commands/install.rs:3379` baut genau diese fuenf Schluessel,
 * alle immer gesetzt). Exportiert, weil das Onboarding denselben Befehl ruft
 * und dort ein `any` stand — eine Antwort, ein Typ.
 */
export interface LmStudioServerStatus {
  running: boolean
  port: number
  lms_present: boolean
  models_detected: boolean
  model_count: number
}

// Session-scope dismiss flag. Lives at module-level on purpose: the
// LmStudioServerHint component unmounts when the dropdown closes, so a
// useState reset would resurface the hint on every reopen. Module
// state survives unmount/remount within the same LU run, and resets to
// false when the user relaunches LU (the module reloads from scratch).
// Not persisted to localStorage so a forgotten-to-start server gets
// flagged again next launch.
let LM_HINT_DISMISSED_THIS_SESSION = false

function LmStudioServerHint({ onStarted }: { onStarted: () => void }) {
  const [status, setStatus] = useState<LmStudioServerStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')
  const [dismissed, setDismissed] = useState(LM_HINT_DISMISSED_THIS_SESSION)
  // Starting the server also hands LM Studio the local backend slot (see
  // lib/lmstudio-backend-adopt). When the built-in engine holds that slot the
  // user learns it here, before the click, together with the way back.
  const replacesBuiltinEngine = useProviderStore((s) => adoptionReplacesBuiltinEngine(s.providers.openai))

  useEffect(() => {
    let cancelled = false
    backendCall<LmStudioServerStatus>('lmstudio_server_status')
      .then(s => { if (!cancelled) setStatus(s) })
      .catch(() => { /* not Tauri / endpoint missing → just don't render */ })
    return () => { cancelled = true }
  }, [])

  // Render only when LM Studio is on disk but its server is off. If
  // running, models are already in the list; if neither lms.exe nor any
  // models are present, the user just doesn't have LM Studio.
  const detected = !!status && (status.lms_present || status.models_detected)
  if (!status || status.running || !detected || dismissed) return null

  const handleStart = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (starting) return
    setStarting(true)
    setStartError('')
    try {
      await backendCall('start_lmstudio_server')
      // The CLI takes a second or two to bind 1234 — poll status
      // briefly so the banner replaces itself with the models list
      // instead of leaving the spinner spinning forever.
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 750))
        const fresh = await backendCall<LmStudioServerStatus>('lmstudio_server_status').catch(() => null)
        if (fresh) {
          setStatus(fresh)
          if (fresh.running) {
            // A running server is only half of what the sentence above
            // promises. The picker lists ENABLED provider slots, so without
            // this the models stay invisible and the button leads into a dead
            // end (Nebenbefund 4, R8 re-measure). Same call the
            // BackendSelector makes, no LM-Studio-only path.
            const update = lmStudioSlotUpdate(useProviderStore.getState().providers.openai)
            if (update) useProviderStore.getState().setProviderConfig('openai', update)
            onStarted()
            break
          }
        }
      }
    } catch (e) {
      // Hier stand `catch (e: any)` mit `e?.message`. Das las genau EINE Sorte
      // Fehler: ein `Error`-Objekt. Tauris `invoke` lehnt aber mit einem STRING
      // ab (die Rust-Seite gibt `Result<_, String>` zurueck) — im ausgelieferten
      // Programm hatte `e.message` deshalb nie einen Wert, und der Grund des
      // Fehlschlags wurde jedes Mal durch das pauschale „Start failed" ersetzt.
      // `detailOf` ist die Stelle, an der dieses Projekt genau diese Frage schon
      // beantwortet (lib/error-text.ts): String, Error oder sonst etwas.
      const detail = detailOf(e)
      setStartError(detail ? detail.slice(0, 80) : 'Start failed')
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="relative px-2.5 py-2 border-b border-black/[0.06] dark:border-white/[0.04] bg-black/[0.03] dark:bg-white/[0.03]">
      <button
        onClick={(e) => { e.stopPropagation(); LM_HINT_DISMISSED_THIS_SESSION = true; setDismissed(true) }}
        aria-label="Dismiss (returns on next launch)"
        title="Dismiss (returns on next launch)"
        className="absolute top-1 right-1 p-1 rounded text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors"
      >
        <X size={10} />
      </button>
      <p className="t-micro text-gray-600 dark:text-gray-300 leading-snug mb-1.5 pr-5">
        LM Studio is installed ({status.model_count} model{status.model_count === 1 ? '' : 's'} on disk) but its server isn't running. Start it to pick LM Studio models here.
      </p>
      <button
        onClick={handleStart}
        disabled={starting}
        className="w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded t-micro bg-black/[0.06] dark:bg-white/[0.06] hover:bg-black/[0.1] dark:hover:bg-white/[0.12] text-gray-700 dark:text-gray-200 transition-colors disabled:opacity-50"
      >
        {starting ? <Loader2 size={10} className="animate-spin" /> : <PlayCircle size={10} />}
        <span>{starting ? 'Starting LM Studio server…' : 'Start LM Studio Server'}</span>
      </button>
      {replacesBuiltinEngine && (
        <p className="text-[0.55rem] text-gray-500 dark:text-gray-400 mt-1 leading-snug">
          This also makes LM Studio your local chat backend in place of the LU Engine. You can switch back under Settings, AI Backends, Providers.
        </p>
      )}
      {startError && (
        <p className="text-[0.55rem] text-red-600/80 dark:text-red-300/70 mt-1 leading-snug">{startError}</p>
      )}
    </div>
  )
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
// it came from Ollama or LM Studio — the per-row provider badge
// (rendered below) keeps that detail visible.
//
// Pure visual grouping — model name + provider still resolve chat
// routing exactly as before.

// Normalize a model name into a comparable base form:
//   openai::qwen3.6-27b        → qwen3.6-27b
//   richardyoung/qwen3-14b:…   → qwen3-14b
//   Qwen3.6-27B-Q4_K_M.gguf    → qwen3.6-27b-q4_k_m.gguf
function normalizeModelName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/^[^:]+::/, '')    // strip openai:: / anthropic::
    .replace(/^[^/]+\//, '')    // strip repo-author/ prefix
    .replace(/:.+$/, '')        // strip :tag suffix
}

// Ordered — first match wins. Prefixes/infixes on the normalized name.
const FAMILY_MATCHERS: Array<{ family: string; test: RegExp }> = [
  { family: 'Qwen',       test: /^qwen|^qwq/ },
  { family: 'Gemma',      test: /^gemma/ },
  { family: 'Llama',      test: /^llama|^meta[-_]?llama/ },
  { family: 'Mistral',    test: /^mistral|^mixtral|^mistral-nemo|^mistral-small|^mistral-large/ },
  { family: 'DeepSeek',   test: /^deepseek/ },
  { family: 'Phi',        test: /^phi-?\d|^phi_?\d/ },
  { family: 'Hermes',     test: /^hermes|^nous-/ },
  { family: 'Dolphin',    test: /^dolphin/ },
  { family: 'Claude',     test: /^claude/ },
  { family: 'GPT-OSS',    test: /^gpt-oss/ },
  { family: 'GPT / o-series', test: /^gpt-|^o1-|^o3-/ },
  { family: 'Command',    test: /^command/ },
  { family: 'GLM',        test: /^glm|^chatglm|^zai/ },
  { family: 'Yi',         test: /^yi-/ },
  { family: 'Gemini',     test: /^gemini/ },
  { family: 'Grok',       test: /^grok/ },
]

function getModelFamily(modelName: string): string {
  const n = normalizeModelName(modelName)
  for (const { family, test } of FAMILY_MATCHERS) {
    if (test.test(n)) return family
  }
  return 'Other'
}

// Family display order — Qwen/Gemma/Llama surface first since they're
// the most common local-chat picks; cloud-only families (Claude/GPT)
// come after the local ones; 'Other' always last.
const FAMILY_ORDER: string[] = [
  'Qwen', 'Gemma', 'Llama', 'Mistral', 'DeepSeek', 'Phi', 'Hermes',
  'Dolphin', 'GLM', 'GPT-OSS', 'Yi', 'Command',
  'Claude', 'GPT / o-series', 'Gemini', 'Grok',
]

function groupByFamily(models: AIModel[]): { family: string; models: AIModel[] }[] {
  const groups: Record<string, AIModel[]> = {}
  for (const m of models) {
    const fam = getModelFamily(m.name)
    if (!groups[fam]) groups[fam] = []
    groups[fam].push(m)
  }

  return Object.entries(groups)
    .sort(([a], [b]) => {
      if (a === 'Other') return 1
      if (b === 'Other') return -1
      const ai = FAMILY_ORDER.indexOf(a)
      const bi = FAMILY_ORDER.indexOf(b)
      if (ai >= 0 && bi >= 0) return ai - bi
      if (ai >= 0) return -1
      if (bi >= 0) return 1
      return a.localeCompare(b)
    })
    .map(([family, models]) => ({ family, models }))
}

// ── LM Studio selection helpers (§18) ─────────────────────────
//
// Extracted as pure module-level functions so the select-time auto-load
// decision is unit-testable without rendering the whole hook-heavy
// component (no test harness exists for ModelSelector — it depends on
// several zustand stores + the Tauri bridge).

/**
 * The identifier LM Studio's CLI/bridge uses for `model` — its `lmsKey`
 * when present (the exact key the loaded-list reports), else the model name.
 * Centralised so the row toggle, the loaded check, and the select-time
 * auto-load all agree on one id.
 *
 * CRITICAL: strip LU's routing prefix. An LM Studio model's `name` carries the
 * provider-scoped form "openai::qwen2.5-0.5b-instruct@q4_k_m" (getProviderForModel
 * routes on that `openai::`), but the `lms` CLI and LM Studio's /api/v0/models use
 * the BARE key "qwen2.5-0.5b-instruct@q4_k_m". Passing the prefixed name to
 * `lms load` matches nothing — pre-`-y` it dropped into the interactive picker and
 * the command hung forever (stuck "loading…" spinner, no error); post-`-y` it
 * exits 1. The loaded-check `loaded.has(lmsIdOf(...))` also silently failed
 * (bare keys from the API vs. a prefixed id), so rows showed perpetually unloaded
 * and selecting re-triggered a load every time. Same `/^[^:]+::/` strip as
 * displayModelName. (Found via live E2E 2026-06-01.)
 */
export function lmsIdOf(model: AIModel): string {
  // `lmsKey` steht auf keinem der vier Glieder von `AIModel`. Seit TS 4.9
  // verengt `'lmsKey' in model` trotzdem — auf `AIModel & Record<'lmsKey',
  // unknown>` —, und die `typeof`-Pruefung dahinter macht daraus `string`.
  // Beide Zusicherungen waren also nur die Handarbeit, die der Compiler seither
  // selbst macht; die aeussere `as string` hat obendrein verdeckt, dass die
  // innere Pruefung ueberhaupt etwas garantiert.
  const raw = 'lmsKey' in model && typeof model.lmsKey === 'string'
    ? model.lmsKey
    : model.name
  return raw.replace(/^[^:]+::/, '')
}

/**
 * True when selecting `model` must auto-load it into LM Studio first: it's
 * an LM Studio model AND it isn't already in the loaded set. Non-LM-Studio
 * models (Ollama, cloud) always return false — they activate immediately.
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
 * system prompt + the 5 curated tool schemas — let alone the full agent
 * catalog — overflow 4K, and LM Studio answers /v1/chat/completions with a
 * context-overflow error that surfaces as the opaque "LM Studio: Request
 * failed", with NO retry (it's a 4xx). Proven live 2026-06-12: gemma-3-4b
 * @4096 failed every chat-tools / agent turn; the identical turn @16384
 * worked first try. So we always request a usable window — capped by the
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
    return `${how}, but its ${Math.round(ctx / 1024)}k context window is too small for a full Agent or Code tool set`
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

export function lmsAutoLoadContext(model: AIModel): number {
  const max =
    'contextLength' in model && typeof model.contextLength === 'number' && model.contextLength > 0
      ? model.contextLength
      : LMS_AUTOLOAD_CONTEXT
  return Math.min(max, LMS_AUTOLOAD_CONTEXT)
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
// (active) competing with a separate loaded indicator. (David 2026-06-06:
// "keine haken mehr, nur on/off load sichtbar im dropdown".)
function LoadToggle({ loaded, busy, disabled, onClick }: {
  loaded: boolean; busy: boolean; disabled: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      disabled={disabled}
      title={loaded
        ? 'Loaded in VRAM. Click to unload (Off)'
        : 'Not loaded. Click to load into VRAM (On)'}
      className={`flex items-center gap-0.5 pl-1 pr-1.5 py-0.5 rounded text-[0.5rem] font-semibold uppercase tracking-wide transition-colors disabled:opacity-40 ${
        loaded
          ? 'text-emerald-400 bg-emerald-500/[0.12] hover:bg-emerald-500/20'
          : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.06]'
      }`}
    >
      {busy ? <Loader2 size={9} className="animate-spin" /> : <Power size={9} />}
      <span>{busy ? '…' : loaded ? 'On' : 'Off'}</span>
    </button>
  )
}

// ── Component ─────────────────────────────────────────────────

export interface ModelSelectorProps {
  openUpward?: boolean
  /**
   * Which surface is asking. 'code' is the coding agent, which cannot do
   * anything at all without tool calls, so hosted models that have told us
   * they do not support tools are left out of the list entirely rather than
   * offered with a warning icon (David 2026-07-25: "Modelle ohne Tool-Support
   * z.B. nicht im Code-Bereich anzeigen"). Local models stay listed on every
   * surface — there the fallback XML path often still works, and when it does
   * not the run says so.
   */
  surface?: 'chat' | 'code'
  /**
   * The model that wrote the answers of the open chat, when that is not the
   * model picked here (Meldung 4 of the R5 re-measure). It used to be a chip
   * of its own beside the picker; David wanted it out of the row on
   * 2026-09-02, so the picker carries it: a 4 px dot on the corner and the
   * full sentence in the tooltip. `null`/undefined is the normal case and
   * changes nothing about the trigger, not even its width.
   */
  answeredBy?: string | null
}

// `openUpward` flips the dropdown to open above the trigger, right-aligned —
// used when the picker lives in the composer action bar (bottom of the screen)
// instead of the header. Header usage keeps the default downward/centered menu.
export function ModelSelector({ openUpward = false, surface = 'chat', answeredBy = null }: ModelSelectorProps = {}) {
  const { models, activeModel, setActiveModel, fetchModels } = useModels()
  const isModelLoading = useModelStore((s) => s.isModelLoading)
  // Welle 3, Listen-Ladezustand 3 von 4 — und der einzige, den es vorher gar
  // nicht gab. `inventoryLoaded` ist die Frage „ist ueberhaupt schon einmal
  // eine Modellliste hier gelandet"; sie steht seit dem Zaehler-Nachschlag
  // (2026-08-29) im Store, aus genau demselben Grund: bis dahin darf man
  // keine Zahl und keine Leermeldung zeigen, sondern nur eine Ladeanzeige.
  // Ohne sie ging der Waehler direkt von leer auf Liste — und „leer" rendert
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
  const [open, setOpen] = useState(false)
  useDismissOnEscape(open, () => setOpen(false))
  // Read by the empty-state probe below, which runs before the render that
  // computes textModels. A ref keeps it out of the effect's dependency list.
  const textModelsEmptyRef = useRef(true)
  const [unloading, setUnloading] = useState(false)
  const [unloadDone, setUnloadDone] = useState(false)
  // B3 — per-model LM Studio load/unload state. `lmsLoaded` is the set
  // of LM Studio model identifiers currently loaded in the server;
  // `togglingLms` is the one we're flipping right now (drives the
  // spinner on the row). LM Studio's HTTP server doesn't have load /
  // unload endpoints, so we route through the `lms` CLI via the
  // bridge's `lmstudio_load_model` / `lmstudio_unload_model` commands.
  const [lmsLoaded, setLmsLoaded] = useState<Set<string>>(new Set())
  const [togglingLms, setTogglingLms] = useState<string | null>(null)
  // B3/§18 — the LM Studio model we're auto-loading as part of *selecting* it
  // (distinct from `togglingLms`, the explicit power-button flow). Drives the
  // inline "loading…" state on the row and blocks a second click.
  const [selectingLms, setSelectingLms] = useState<string | null>(null)
  const [selectError, setSelectError] = useState<string | null>(null)
  // VRAM load state for Ollama rows — parity with `lmsLoaded` above, so
  // every LOCAL model shows a clear on/off load toggle (not just LM Studio).
  // Sourced from /api/ps on dropdown open.
  const [ollamaLoaded, setOllamaLoaded] = useState<Set<string>>(new Set())
  const [togglingOllama, setTogglingOllama] = useState<string | null>(null)
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
   * Ein festes `max-h` in vh reicht dafuer nicht: das Menue haengt mit
   * `bottom-full` am Ausloeser, und wie viel Platz DARUEBER ist, weiss nur
   * der Ausloeser selbst. Also gemessen, bei jedem Oeffnen und bei jeder
   * Groessenaenderung des Fensters.
   */
  const [menuePlatz, setMenuePlatz] = useState<number | null>(null)

  // Keep the per-row On/Off LOAD state LIVE while the dropdown is open
  // (David 2026-06-12: "on und offload button sehr delayed und nicht immer
  // akkurat — gemma4b ist geladen laut ollama aber in LU steht off"). The old
  // code fetched the loaded set ONCE on open, so a model that loaded after the
  // open — or a slow/transiently-failed first fetch — showed the wrong state
  // until the user reopened. Now: fetch immediately, then poll /api/ps + LM
  // Studio every 1.5 s so the toggle self-corrects within a beat. Both calls are
  // cheap loopback requests; we only poll while the panel is actually open.
  useEffect(() => {
    if (!open) return
    setSelectError(null) // fresh open — drop any stale auto-load error
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
      // Skip the tick entirely while the window is hidden/minimized — there's
      // nothing to repaint and we re-sync the moment it's visible again. Stops a
      // backgrounded app from hitting Ollama / LM Studio every 1.5 s (#70).
      if (typeof document !== 'undefined' && document.hidden) return
      // Only probe LM Studio's loaded-state when LM Studio models are actually
      // listed. When its server is down there are NO LM Studio rows, so this
      // skips the probe entirely — removing the last frontend reason the
      // dropdown ever stalled on a down LM Studio (the Rust side is now async +
      // port-pre-checked too). Ollama's /api/ps is a cheap loopback call and
      // always runs.
      // `providerName` steht auf ALLEN vier Gliedern von `AIModel` (auf dreien
      // optional, auf `CloudModel` verpflichtend) — der `in`-Test und die
      // Zusicherung waren beide ueberfluessig. `m.providerName` ist von sich aus
      // `string | undefined`, also genau das, was `isLmStudioProvider` nimmt.
      const hasLmsRows = useModelStore.getState().models.some((m) =>
        isLmStudioProvider(m.providerName),
      )
      if (hasLmsRows) {
        void listLoadedLmStudioModels().then((list) => { if (!cancelled) setLmsLoaded((prev) => sameStringSet(prev, list) ? prev : new Set(list)) }).catch(() => {})
      } else if (!cancelled) {
        setLmsLoaded((prev) => (prev.size ? new Set() : prev))
      }
      try {
        const list = await listRunningModels()
        misses = 0
        if (!cancelled) setOllamaLoaded((prev) => sameStringSet(prev, list) ? prev : new Set(list))
      } catch {
        misses += 1
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
  }, [open])

  /**
   * Flip a LM Studio model between loaded / unloaded via the bridge.
   * Refreshes the loaded set on success so the toggle reflects reality
   * (the user might have multiple LM Studio models loaded already).
   */
  const toggleLmStudioLoad = async (model: AIModel) => {
    // Use lmsIdOf so LU's `openai::` routing prefix is stripped. Re-deriving the
    // id inline (as this did) passed "openai::<key>" to `lms load`, which
    // matches no model → silent failure; and the loaded-set / spinner checks
    // below compare against the BARE lmsIdOf, so they never matched the prefixed
    // id either (no spinner, green state never reflected reality). The same
    // prefix strip is already applied to handleSelectModel + rowId.
    const id = lmsIdOf(model)
    if (!id || togglingLms) return
    setTogglingLms(id)
    try {
      if (lmsLoaded.has(id)) {
        await unloadLmStudioModel(id)
      } else {
        await loadLmStudioModel(id, lmsAutoLoadContext(model))
      }
      const list = await listLoadedLmStudioModels()
      setLmsLoaded(new Set(list))
    } catch {
      // Best-effort: leave the previous snapshot in place; the user
      // can re-open the dropdown to retry.
    } finally {
      setTogglingLms(null)
    }
  }

  /**
   * Flip an Ollama model between loaded / unloaded in VRAM (parity with
   * toggleLmStudioLoad). Load = warm it into VRAM; unload = free VRAM
   * (keep_alive:0). Refreshes /api/ps after so the toggle reflects reality.
   */
  const toggleOllamaLoad = async (model: AIModel) => {
    const name = model.name
    if (!name || togglingOllama) return
    setTogglingOllama(name)
    try {
      if (ollamaLoaded.has(name)) {
        await unloadModel(name)
      } else {
        await loadModel(name)
      }
      const list = await listRunningModels()
      setOllamaLoaded(new Set(list))
    } catch {
      // best-effort; reopen the dropdown to retry
    } finally {
      setTogglingOllama(null)
    }
  }

  /**
   * §18 — Select a model, auto-loading it into LM Studio first when needed.
   *
   * Routing (getProviderForModel) keys only on the `openai::` prefix, so an
   * LM Studio model's HTTP requests go out regardless of whether the model
   * is actually loaded in the server — picking an UNloaded one used to fail
   * silently at the HTTP layer (404 from LM Studio). So: if the picked row is
   * an LM Studio model that isn't loaded, load it (await) BEFORE activating,
   * showing an inline "loading…" state; only then setActiveModel + close. On
   * load failure we keep the dropdown open and surface the error instead of
   * activating a model that can't answer. Non-LM-Studio rows are unaffected —
   * they activate immediately exactly as before.
   */
  const handleSelectModel = async (model: AIModel) => {
    const id = lmsIdOf(model)

    // A16 (A14-3a): a row belonging to the backend our engine displaced hands
    // the slot back to it. First thing in the function, because everything
    // below asks who holds the slot: the auto-load branch would warm a model
    // in LM Studio and then route the chat at 8127, and the LU Engine branch
    // would try to load an LM Studio id as a GGUF.
    const handedBackTo = handBackChatProviderForRow(model as unknown as InstalledModelLike)
    if (handedBackTo) {
      useLuEngineSwitchStore.getState().announce(chatProviderSwitchNote(handedBackTo))
    }

    if (shouldAutoLoadForSelect(model, lmsLoaded)) {
      if (selectingLms || togglingLms) return // a load is already in flight
      setSelectError(null)
      setSelectingLms(id)
      try {
        await loadLmStudioModel(id, lmsAutoLoadContext(model))
        // Confirm it actually loaded before we route chat at it.
        const list = await listLoadedLmStudioModels()
        const loaded = new Set(list)
        setLmsLoaded(loaded)
        if (!loaded.has(id)) {
          setSelectError(`Couldn't load "${displayModelName(model.name)}" into LM Studio. Try the On/Off button on the model's row, or load it in LM Studio directly.`)
          return // keep dropdown open; don't activate an unloaded model
        }
        setActiveModel(model.name)
        setOpen(false)
      } catch {
        setSelectError(`Couldn't load "${displayModelName(model.name)}" into LM Studio. Is the LM Studio server running?`)
      } finally {
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
    if ((isManagedBuiltinActive() && getProviderIdFromModel(model.name) === 'openai')
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
      try {
        // Announced BEFORE the start is attempted and NOT into this dropdown,
        // which the pick closes a few lines further down. It goes to the
        // standing status row above the composer, so it survives both the
        // close on success and the error banner on failure (A14 review 2).
        switched = ensureLuEngineIsChatProvider()
        if (switched) {
          useLuEngineSwitchStore.getState().announce(LU_ENGINE_SWITCH_NOTE)
        }
        const swapped = await activateBuiltinModel(model.name)
        if (swapped) {
          // Raw store set — the useModels wrapper would fire a second
          // (idempotent but pointless) activate.
          useModelStore.getState().setActiveModel(model.name)
        } else {
          setActiveModel(model.name) // not a bundled GGUF — plain activate
        }
        setOpen(false)
      } catch (e) {
        // Shared with the Installed card, which used to swallow this failure
        // whole. One sentence, one place it is written (A14 third review).
        //
        // Und in BEIDE Zeilen, nicht nur in diese hier. Persona P5 hat am
        // 03.09.2026 am echten Build den Waehler zwei Sekunden nach dem Klick
        // geschlossen, so wie ein Mensch es tut: die Antwort kommt erst 12 bis
        // 21 s spaeter, sie stand nur in diesem Kasten, und der Kasten war
        // weg. 7,4 s ohne Engine, zwei Prozessstarts, und 75 s lang keine
        // einzige neue Textzeile auf der Seite.
        setSelectError(announceLuEngineStartFailure(model.name, e, switched))
      } finally {
        setSelectingLms(null)
        releaseLuEngineSwap()
      }
      return
    }

    // Non-LM-Studio, or an already-loaded LM Studio model: activate now.
    setActiveModel(model.name)
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

  // GH #118: an empty picker used to say "No models available" no matter what
  // was wrong, so a built-in engine that never started read like a machine
  // with nothing installed. Asked only while the dropdown is open and the list
  // is empty, and never repairs, because opening a dropdown must not boot a server.
  const [emptyReason, setEmptyReason] = useState('')
  useEffect(() => {
    if (!open || textModelsEmptyRef.current === false) return
    let cancelled = false
    diagnoseBuiltinEngine({ repair: false })
      .then((d) => { if (!cancelled && !d.ok && d.reason) setEmptyReason(d.reason) })
      .catch(() => { /* nothing to add, the generic line stands */ })
    return () => { cancelled = true }
  }, [open])

  // Refetch when any provider's enabled state or baseUrl changes (e.g. user
  // enables LM Studio / adds Anthropic key in Settings, or the backend
  // picker activates an OpenAI-compatible provider). Without this the
  // dropdown stays stuck on whatever providers were enabled at mount time.
  useEffect(() => {
    const unsub = useProviderStore.subscribe((state, prev) => {
      const changed = (Object.keys(state.providers) as Array<keyof typeof state.providers>)
        .some(id => state.providers[id]?.enabled !== prev.providers[id]?.enabled
          || state.providers[id]?.baseUrl !== prev.providers[id]?.baseUrl)
      if (changed) fetchModels()
    })
    return () => unsub()
  }, [fetchModels])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
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
  const activeModelObj = models.find((m) => m.name === activeModel)
  const activeDisplayName = activeModel
    ? (activeModelObj && 'displayName' in activeModelObj && activeModelObj.displayName) ||
      displayModelName(activeModel).split(':')[0]
    : 'Select Model'
  const activeType = activeModelObj?.type || 'text'
  // Chat dropdown shows TEXT models only — image/video live in the
  // Create view's own picker. Everything here is grouped by the model
  // FAMILY (Qwen/Gemma/Llama/…), not by provider, because users pick
  // models by lineage first and the backend that serves them is a
  // per-row badge.
  const allTextModels = models.filter(m => m.type === 'text')
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
  const wechsel = splitBackendSwitchRows(textModels, luEngineHoldsChat, standbyName)
  const groups: { family: string; models: AIModel[] }[] = [
    ...(wechsel.switching.length > 0 && wechsel.label
      ? [{ family: wechsel.label, models: wechsel.switching }]
      : []),
    ...groupByFamily(wechsel.rest),
  ]
  // The one rule, asked rather than copied (second review): one group normally
  // draws no heading, except the switch group, where the heading is the
  // warning that picking from it moves the backend.
  const showHeadings = needsBackendSwitchHeading(groups.map((g) => g.family), wechsel.label)
  const hasOllamaModels = textModels.some(m => ('provider' in m && m.provider === 'ollama') || !('provider' in m))
  textModelsEmptyRef.current = textModels.length === 0

  // Messen, wie viel Fenster ueber (bzw. unter) dem Ausloeser noch frei ist.
  // 18 px Abzug: 6 px Abstand des Menues zum Ausloeser plus 12 px Luft zum
  // Fensterrand. Die Untergrenze von 200 px ist die Notbremse fuer ein sehr
  // flaches Fenster, in dem sonst ein Menue ohne Inhalt herauskaeme.
  useLayoutEffect(() => {
    if (!open) return
    const messen = () => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const frei = openUpward ? r.top : window.innerHeight - r.bottom
      setMenuePlatz(Math.max(200, Math.round(frei - 18)))
    }
    messen()
    window.addEventListener('resize', messen)
    return () => window.removeEventListener('resize', messen)
  }, [open, openUpward])

  return (
    <div ref={ref} className="relative">
      {/* ── Trigger Button ── */}
      <button
        onClick={() => setOpen(!open)}
        title={
          answeredBy
            ? `The answers in this chat were written by ${answeredBy}. The next answer runs on the model picked here.`
            : activeModel ? `Model: ${activeDisplayName}, click to switch` : 'Select a chat model'
        }
        aria-label="Select chat model"
        aria-expanded={open}
        // Laedt gerade ein Modell: `aria-busy` statt eines eigenen blauen
        // Rezepts mit Leuchtschatten. Das Rezept faerbt die Kante mit dem
        // Akzent, die Aussage steht damit im selben Vokabular wie der Rest
        // der Leiste — und im Accessibility-Baum, wo sie hingehoert.
        aria-busy={isModelLoading}
        className="lu-control"
      >
        {/* Type indicator dot */}
        <span className={`w-1.5 h-1.5 rounded-full ${
          activeType === 'text' ? 'bg-blue-400' : activeType === 'image' ? 'bg-purple-400' : 'bg-emerald-400'
        } ${isModelLoading ? 'animate-pulse' : ''}`} />

        {/* Model name. Keine eigene Textfarbe mehr — sie wird vom Control
            geerbt, sonst haette der Knopf zwei Graustufen in sich. */}
        <span className="max-w-[140px] truncate leading-none">
          {activeDisplayName}
        </span>

        {/* Chevron / Spinner */}
        {isModelLoading ? (
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

      {/* ── Dropdown ── */}
      <AnimatePresence>
        {open && (
          <motion.div
            data-testid="model-picker-menu"
            style={menuePlatz === null ? undefined : { maxHeight: menuePlatz }}
            className={`absolute w-72 rounded-lg overflow-x-hidden overflow-y-auto scrollbar-thin z-50 lu-elevated ${
              openUpward ? 'bottom-full mb-1.5 right-0' : 'top-full mt-1.5 left-1/2 -translate-x-1/2'
            }`}
            initial={{ opacity: 0, y: openUpward ? 6 : -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: openUpward ? 6 : -6, scale: 0.98 }}
            transition={{ duration: MOTION_S.fast, ease: 'easeOut' }}
          >
            {/* Bug Q v2.4.7 — surface "Start LM Studio Server" inline when
                LM Studio is on disk but its server is off. wakeywakeynow's
                "can't choose any models i have installed" symptom. */}
            <LmStudioServerHint onStarted={fetchModels} />

            {/* Same honesty as the hiddenForCode note below: in Cloud mode the
                local models are hidden on purpose, so say so instead of
                letting an empty local section read as a bug (G20). */}
            {appMode === 'cloud' && (
              <div className="px-2.5 py-1.5 border-b border-black/5 dark:border-white/[0.06] text-[0.55rem] text-gray-500">
                Cloud mode shows hosted models only. Switch the app to Local mode to use Ollama, LM Studio or the LU Engine.
              </div>
            )}

            {/* Say WHY the list is shorter here than in Chat, otherwise a
                missing favourite reads as a bug. */}
            {hiddenForCode > 0 && (
              <div className="px-2.5 py-1.5 border-b border-black/5 dark:border-white/[0.06] text-[0.55rem] text-gray-500">
                {hiddenForCode} cloud {hiddenForCode === 1 ? 'model is' : 'models are'} hidden here because they cannot call tools. They are still in Chat.
              </div>
            )}

            {/* §18 — surfaced when an LM Studio auto-load (on select) failed,
                so the user isn't left wondering why the model didn't switch. */}
            {selectError && (
              <div
                data-testid="model-picker-error"
                className="mx-2 mt-2 px-2 py-1.5 rounded bg-red-500/10 border border-red-500/20 t-micro text-red-600/90 dark:text-red-300/90 leading-snug max-h-[22vh] overflow-y-auto overflow-x-hidden scrollbar-thin whitespace-pre-wrap break-words"
              >
                {selectError}
              </div>
            )}


            {/* Scrollable model list */}
            <div className="py-1 max-h-[280px] overflow-y-auto scrollbar-thin">
              {!inventoryLoaded && textModels.length === 0 && <ModelPickerSkeleton />}
              {inventoryLoaded && textModels.length === 0 && (
                <div className="px-2.5 py-3 text-center">
                  <p className="t-micro text-gray-600">No models available</p>
                  {/* An empty picker after the user switched the last backend
                      off in Settings used to say only that, which reads like a
                      machine with nothing installed (Nebenbefund 1, R9
                      re-measure). The reason and the way back belong here. */}
                  {noBackendEnabled ? (
                    <>
                      <p className="mt-1 t-micro text-amber-300/90 leading-snug text-left">
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
                    <p className="mt-1 t-micro text-amber-300/90 leading-snug text-left">{emptyReason}</p>
                  )}
                </div>
              )}

              {groups.map(({ family, models: groupModels }) => (
                <div key={family}>
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
                    // The one reason this picker switches rows off: a pick is
                    // already running. Kept as its own name because the click
                    // below hands exactly this to `blockedPickWait`, which is
                    // what keeps any future second reason silent (A17).
                    const pickInFlight = selectingLms !== null || togglingLms !== null
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
                          <span className={`text-[0.7rem] truncate ${isActive ? 'text-gray-900 dark:text-white' : ''}`}>
                            {modelDisplayName}
                          </span>

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
                          {/* 2.5.8 — tool-calling capability at a glance. Text
                              models only.

                              David 2026-08-06: "wieso ist es nicht toolfähig?
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
                              return (
                                <span
                                  className="inline-flex items-center shrink-0 text-amber-500/80"
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
                          {/* §18 — inline load state while we auto-load this
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
                              `'details' in model` von dort auf OllamaModel — und
                              nur das hat `details`. Der Zugriff braucht deshalb
                              keine Zusicherung; `parameter_size` ist dort als
                              `string` deklariert (types/models.ts:15). */}
                          {model.type === 'text' && 'details' in model && model.details && (
                            <span className="text-[0.5rem] text-gray-600">
                              {model.details.parameter_size}
                            </span>
                          )}
                          {/* On/Off VRAM load toggle for LOCAL models — LM Studio
                              AND Ollama both get it now (was LM-Studio-only). The
                              old active-row checkmark is gone; the active model is
                              shown by the row highlight, and the dropdown shows a
                              single, clear on/off LOAD state per model. Cloud
                              models have no local VRAM → no toggle. Click stops
                              propagation so the row's select handler doesn't fire. */}
                          {isLmsRow ? (
                            <LoadToggle
                              loaded={lmsLoaded.has(rowId)}
                              busy={togglingLms === rowId}
                              disabled={togglingLms !== null || selectingLms !== null}
                              onClick={() => void toggleLmStudioLoad(model)}
                            />
                          ) : isOllamaRow ? (
                            <LoadToggle
                              loaded={ollamaLoaded.has(model.name)}
                              busy={togglingOllama === model.name}
                              disabled={togglingOllama !== null}
                              onClick={() => void toggleOllamaLoad(model)}
                            />
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
            {hasOllamaModels && (
              <div className="border-t border-black/[0.06] dark:border-white/[0.04] px-1 py-1">
                <button
                  onClick={async (e) => {
                    e.stopPropagation()
                    if (unloading) return
                    setUnloading(true)
                    setUnloadDone(false)
                    try {
                      await unloadAllModels()
                      setUnloadDone(true)
                      setTimeout(() => setUnloadDone(false), 2000)
                    } catch { /* ignore */ }
                    finally { setUnloading(false) }
                  }}
                  disabled={unloading}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-[5px] rounded t-micro text-red-600/70 dark:text-red-500/60 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-500/[0.06] transition-colors disabled:opacity-40"
                >
                  {unloading ? <Loader2 size={10} className="animate-spin" /> : <Power size={10} />}
                  <span>{unloadDone ? 'Unloaded' : unloading ? 'Unloading...' : 'Unload all models'}</span>
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
