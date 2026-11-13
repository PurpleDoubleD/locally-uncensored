// Keeps the tray menu's grey lines current (T2, 3.0.9; lines: lib/tray-menu).
//
// Sent on every change of mode, account or selected model, and again when the
// tray icon is hovered or clicked (`lu-tray-opened`) and every 15 seconds:
// then the engine, Ollama and the memory are asked fresh, and the account at
// most once a minute. The lines must be fresh BEFORE the click: an open menu
// on a Mac does not change (tray_menu.rs).
// `lu-tray-action` is the click on "Plan & Credits…" or "Models…"; the window
// is already in front by then (tray_menu.rs).

import { useEffect } from 'react'
import { isTauri } from '../api/in-tauri'
import { backendCall } from '../api/backend'
import type { EngineStatus } from '../api/engine'
import { readLoadedModels } from '../api/ollama'
import { displayModelName, getProviderIdFromModel } from '../api/providers/model-name'
import { isMobile } from '../lib/device-kind'
import { creditsLeft } from '../lib/credits-left'
import { builtinModelMatches, builtinModelNameFromPath } from '../lib/builtin-model-identity'
import { isBuiltinEngineEntry } from '../lib/lmstudio-match'
import { LU_ENGINE_NAME } from '../lib/engine-name'
import { modelDisplayLabel } from '../lib/model-label'
import {
  cloudTrayStatus,
  localTrayStatus,
  type TrayLocalInput,
  type TrayModelState,
  type TrayStatus,
} from '../lib/tray-menu'
import { useCloudAuthStore } from '../stores/cloudAuthStore'
import { useModelStore } from '../stores/modelStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { probeAccount } from './useCloudAuth'

const OPENED_EVENT = 'lu-tray-opened'
const ACTION_EVENT = 'lu-tray-action'
/** Hovering the icon on the way to somewhere else must not hammer anything. */
const LOCAL_REFRESH_MS = 3_000
const ACCOUNT_REFRESH_MS = 60_000
/** The timer that keeps the local lines fresh without a hover. Asks the
 *  engine status, Ollama's /api/ps and the memory: all local and cheap. */
const BACKGROUND_REFRESH_MS = 15_000

type Memory = TrayLocalInput['memory']
interface LocalProbe {
  model: string
  state: TrayModelState
}

/** What was last measured; the lines are rebuilt from it on every change. */
const probe: { local: LocalProbe | null; memory: Memory } = { local: null, memory: null }

export function trayEngineName(activeModel: string): string {
  const row = useModelStore.getState().models.find((m) => m.name === activeModel)
  if (row && isBuiltinEngineEntry(row)) return LU_ENGINE_NAME
  if (row?.providerName) return row.providerName
  return getProviderIdFromModel(activeModel) === 'ollama' ? 'Ollama' : 'Local'
}

export function currentTrayStatus(): TrayStatus {
  const { appMode } = useSettingsStore.getState().settings
  if (appMode === 'cloud') {
    const a = useCloudAuthStore.getState()
    const q = a.quota
    return cloudTrayStatus({
      signedIn: a.status === 'signed-in',
      probing: a.status === 'probing',
      tier: a.tier ?? q?.tier ?? null,
      licenseActive: a.licenseActive,
      pastDue: a.pastDue,
      credits: q ? creditsLeft(q).total : null,
    })
  }
  const { models, activeModel } = useModelStore.getState()
  // A cloud model kept from the Cloud mode is not a local model.
  const local = activeModel && getProviderIdFromModel(activeModel) !== 'lu-cloud' ? activeModel : null
  const measured = local && probe.local?.model === local ? probe.local.state : 'unknown'
  return localTrayStatus({
    engine: local ? trayEngineName(local) : null,
    model: local ? modelDisplayLabel(models, local) : null,
    state: measured,
    memory: probe.memory,
  })
}

/** Ask the engine that serves `model` how far it is. */
export async function probeModelState(model: string): Promise<TrayModelState> {
  const engine = trayEngineName(model)
  if (engine === LU_ENGINE_NAME) {
    const s = await backendCall<EngineStatus>('bundled_engine_status').catch(() => null)
    if (!s?.running) return 'idle'
    if (!builtinModelNameFromPath(s.model_path) || !builtinModelMatches(s.model_path, model)) return 'idle'
    return s.healthy ? 'ready' : 'loading'
  }
  if (engine === 'Ollama') {
    try {
      const loaded = await readLoadedModels()
      const want = displayModelName(model)
      return loaded.some((m) => m.name === want || m.name === `${want}:latest`) ? 'ready' : 'idle'
    } catch {
      return 'engine-off'
    }
  }
  return 'unknown'
}

let lastSent = ''
async function push(): Promise<void> {
  const status = currentTrayStatus()
  const key = JSON.stringify(status)
  if (key === lastSent) return
  lastSent = key
  await backendCall('tray_update', { status }).catch(() => {
    // No tray (Linux without AppIndicator) answers Ok; an error here is an
    // older backend. Send again next time.
    lastSent = ''
  })
}

let lastLocal = 0
let lastAccount = 0
async function refresh(): Promise<void> {
  const now = Date.now()
  const { appMode } = useSettingsStore.getState().settings
  if (appMode === 'cloud') {
    if (now - lastAccount >= ACCOUNT_REFRESH_MS && useCloudAuthStore.getState().status === 'signed-in') {
      lastAccount = now
      // probeAccount writes the store; the subscription below pushes.
      void probeAccount().catch(() => {})
    }
    return
  }
  if (now - lastLocal < LOCAL_REFRESH_MS) return
  lastLocal = now
  const model = useModelStore.getState().activeModel
  const [state, memory] = await Promise.all([
    model ? probeModelState(model) : Promise.resolve<TrayModelState>('unknown'),
    backendCall<Memory>('tray_memory').catch(() => null),
  ])
  probe.local = model ? { model, state } : null
  probe.memory = memory ?? null
  await push()
}

export function openTrayAction(action: unknown): void {
  const ui = useUIStore.getState()
  if (action === 'models') ui.setView('models')
  // The account and its plan live in Settings → General (AccountPanel).
  else if (action === 'plan') ui.openSettingsAt({ tab: 'general' })
}

export function useTraySync(): void {
  useEffect(() => {
    if (!isTauri() || isMobile()) return
    let alive = true
    const offs: Array<() => void> = []
    const sync = () => { void push() }
    offs.push(useSettingsStore.subscribe(sync))
    offs.push(useCloudAuthStore.subscribe(sync))
    offs.push(useModelStore.subscribe((s, prev) => {
      if (s.activeModel === prev.activeModel && s.models === prev.models) return
      // A new model: measure it rather than show the old one's state.
      if (s.activeModel !== prev.activeModel) lastLocal = 0
      sync()
      if (s.activeModel !== prev.activeModel) void refresh()
    }))
    void refresh().then(sync)
    const timer = setInterval(() => {
      if (useSettingsStore.getState().settings.appMode !== 'cloud') void refresh()
    }, BACKGROUND_REFRESH_MS)
    offs.push(() => clearInterval(timer))
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const offOpened = await listen(OPENED_EVENT, () => { void refresh() })
      const offAction = await listen(ACTION_EVENT, (e) => openTrayAction(e.payload))
      if (alive) offs.push(offOpened, offAction)
      else { offOpened(); offAction() }
    }).catch(() => {})
    return () => {
      alive = false
      offs.forEach((off) => off())
    }
  }, [])
}
