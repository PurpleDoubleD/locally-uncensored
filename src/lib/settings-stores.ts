// Read and write of every store the settings catalog reaches (C60, 3.1.0).
//
// lib/settings-catalog.ts names what the chat may change and stays free of
// stores, so the filters that only need names can import it cheaply. This
// file is the other half: for each `store` of an entry, how its value is read
// and written. A store missing here cannot be written from the chat, and an
// entry of an unknown store throws instead of writing somewhere by guess.

import { useSettingsStore } from '../stores/settingsStore'
import { useVoiceStore } from '../stores/voiceStore'
import { useCreateStore } from '../stores/createStore'
import { useMemoryStore } from '../stores/memoryStore'
import { usePermissionStore } from '../stores/permissionStore'
import { useModelStore } from '../stores/modelStore'
import { useSettingsAuditStore } from '../stores/settingsAuditStore'
import { backendCall, isTauri } from '../api/backend'
import { normalizeGpuRoles } from './gpu-roles'
import type { GpuRef } from '../types/settings'
import type { ToolCategory, PermissionLevel } from '../api/mcp/types'
import {
  findEntry, patchFor, readValue, sameValue, setKnownGpuCards, storeOf, type CatalogEntry, type KnownGpuCard,
} from './settings-catalog'

const field = (entry: CatalogEntry) => entry.key.slice(entry.key.indexOf('.') + 1)

/** Load what a parse needs that is not in a store yet (the GPU list). */
export async function prepareEntry(entry: CatalogEntry): Promise<void> {
  if (storeOf(entry) !== 'gpu') return
  if (!isTauri()) { setKnownGpuCards([]); return }
  try {
    const raw = await backendCall<{ index: number; vendor: string; name: string }[]>('detect_gpus')
    const cards: KnownGpuCard[] = (Array.isArray(raw) ? raw : [])
      .filter((g) => g.vendor === 'nvidia' || g.vendor === 'amd' || g.vendor === 'intel')
      .map((g) => ({ vendor: g.vendor as KnownGpuCard['vendor'], index: g.index, name: g.name }))
    setKnownGpuCards(cards)
  } catch {
    setKnownGpuCards([])
  }
}

export function readEntry(entry: CatalogEntry): unknown {
  switch (storeOf(entry)) {
    case 'settings':
      return readValue(useSettingsStore.getState().settings, entry.key)
    case 'voice':
      return (useVoiceStore.getState() as unknown as Record<string, unknown>)[field(entry)]
    case 'create': {
      const s = useCreateStore.getState()
      if (entry.key === 'create.size') return [s.width, s.height]
      return (s as unknown as Record<string, unknown>)[field(entry)]
    }
    case 'memory': {
      const v = (useMemoryStore.getState().settings as unknown as Record<string, unknown>)[field(entry)]
      if (entry.key === 'memory.injectEnabled') return v !== false
      return entry.key === 'memory.maxMemoriesOverride' || entry.key === 'memory.memoryTokenBudget' ? (v ?? 0) : v
    }
    case 'permission':
      return usePermissionStore.getState().globalPermissions[field(entry) as ToolCategory]
    case 'gpu': {
      const roles = normalizeGpuRoles(useSettingsStore.getState().settings.gpuRoles)
      return roles[field(entry) as 'chat' | 'comfy']
    }
    default:
      throw new Error(`no reader for ${entry.key}`)
  }
}

/** A value the chat may not write because it does not exist here (an image
 *  model that is not installed). Null when the value is fine. */
export function refuseValue(entry: CatalogEntry, value: unknown): string | null {
  if (entry.key === 'create.imageModel' || entry.key === 'create.videoModel') {
    const s = useCreateStore.getState()
    const list = entry.key === 'create.imageModel' ? s.imageModelList : s.videoModelList
    const want = String(value).toLowerCase()
    const hits = list.filter((m) => m.name.toLowerCase() === want || m.name.toLowerCase().includes(want))
    if (hits.length === 1) return null
    const names = list.slice(0, 8).map((m) => m.name).join(', ')
    if (list.length === 0) return 'no model of this kind is installed, or Create has not listed them: open Create once'
    return hits.length === 0 ? `not installed. Installed: ${names}` : `ambiguous, matches ${hits.length}: ${hits.slice(0, 5).map((m) => m.name).join(', ')}`
  }
  return null
}

/** The stored form of a Create model name: the full name of the one match. */
function createModelFor(entry: CatalogEntry, value: unknown) {
  const s = useCreateStore.getState()
  const list = entry.key === 'create.imageModel' ? s.imageModelList : s.videoModelList
  const want = String(value).toLowerCase()
  return list.find((m) => m.name.toLowerCase() === want) ?? list.find((m) => m.name.toLowerCase().includes(want))
}

/** The value as it will be stored, e.g. the full model name for a part of it. */
export function normalizeForStore(entry: CatalogEntry, value: unknown): unknown {
  if (entry.key === 'create.imageModel' || entry.key === 'create.videoModel') return createModelFor(entry, value)?.name ?? value
  return value
}

export function writeEntry(entry: CatalogEntry, value: unknown): void {
  switch (storeOf(entry)) {
    case 'settings': {
      const store = useSettingsStore.getState()
      store.updateSettings(patchFor(store.settings, entry.key, value))
      return
    }
    case 'voice':
      useVoiceStore.getState().updateVoiceSettings({ [field(entry)]: value } as never)
      return
    case 'create': {
      const s = useCreateStore.getState()
      switch (entry.key) {
        case 'create.size': { const [w, h] = value as [number, number]; s.setSize(w, h); return }
        case 'create.imageModel': {
          const m = createModelFor(entry, value)
          if (!m) throw new Error('image model not installed')
          s.setImageModel(m.name, m.type)
          return
        }
        case 'create.videoModel': s.setVideoModel(String(value)); return
        case 'create.steps': s.setSteps(Number(value)); return
        case 'create.cfgScale': s.setCfgScale(Number(value)); return
        case 'create.sampler': s.setSampler(String(value)); return
        case 'create.scheduler': s.setScheduler(String(value)); return
        case 'create.batchSize': s.setBatchSize(Number(value)); return
        case 'create.batchPacket': s.setBatchPacket(Number(value)); return
        case 'create.frames': s.setFrames(Number(value)); return
        case 'create.fps': s.setFps(Number(value)); return
        case 'create.hiresFixEnabled': s.setHiresFixEnabled(value === true); return
        default: throw new Error(`no writer for ${entry.key}`)
      }
    }
    case 'memory': {
      const v = (entry.key === 'memory.maxMemoriesOverride' || entry.key === 'memory.memoryTokenBudget') && value === 0 ? null : value
      useMemoryStore.getState().updateMemorySettings({ [field(entry)]: v } as never)
      return
    }
    case 'permission':
      usePermissionStore.getState().setGlobalPermission(field(entry) as ToolCategory, value as PermissionLevel)
      return
    case 'gpu': {
      const store = useSettingsStore.getState()
      const roles = { ...normalizeGpuRoles(store.settings.gpuRoles), [field(entry)]: (value as GpuRef | null) ?? null }
      store.updateSettings({ gpuRoles: roles })
      // Rust holds the pick for the next process start; the picker in
      // Settings does the same on every change (GpuRolesPicker.tsx).
      if (isTauri()) backendCall('set_gpu_roles', { roles }).catch(() => {})
      return
    }
    default:
      throw new Error(`no writer for ${entry.key}`)
  }
}

/** Where the value stands against a change on a card. */
export function entryState(entry: CatalogEntry, from: unknown, to: unknown): 'applied' | 'undone' | 'moved' {
  const now = readEntry(entry)
  if (sameValue(now, to)) return 'applied'
  if (sameValue(now, from)) return 'undone'
  return 'moved'
}

export function describeEntryNow(entry: CatalogEntry): string {
  let v: unknown
  try { v = readEntry(entry) } catch { v = undefined }
  return `${entry.key} = ${entry.show(v)} | ${entry.allowed} | ${entry.label}: ${entry.help}`
}

/** A tick that moves when any store a card shows may change, for a card that
 *  re-renders its state after a change by hand. */
export function useAnyEntryStore(): number {
  const a = useSettingsStore((s) => s.settings)
  const b = useVoiceStore((s) => `${s.ttsEnabled}${s.autoReadAloud}${s.sttEnabled}${s.ttsRate}${s.ttsPitch}${s.ttsMode}${s.sttMode}${s.loopThinking}${s.loopAgent}`)
  const c = useCreateStore((s) => `${s.imageModel}${s.videoModel}${s.steps}${s.cfgScale}${s.width}${s.height}${s.sampler}${s.scheduler}${s.batchSize}${s.batchPacket}${s.frames}${s.fps}${s.hiresFixEnabled}`)
  const d = useMemoryStore((s) => s.settings)
  const e = usePermissionStore((s) => s.globalPermissions)
  return [a, b, c, d, e].length
}

/** The chat model that asks, for the log. */
export function activeModelName(): string | null {
  return useModelStore.getState().activeModel ?? null
}

/** One change as the mark under a tool result carries it (settings-tools.ts). */
export interface SettingChangeMark { key: string; from: unknown; to: unknown }

/** Undo from the card: back to the value before, through the same catalog. */
export function undoSettingChange(change: SettingChangeMark): boolean {
  const entry = findEntry(change.key)
  if (!entry) return false
  writeEntry(entry, change.from)
  useSettingsAuditStore.getState().record({
    conversationId: null, model: null, kind: 'setting', key: entry.key, label: entry.label,
    from: entry.show(change.to), to: entry.show(change.from), outcome: 'undone',
  })
  return true
}

/** Apply a change again (the card's "Apply again"). */
export function redoSettingChange(change: SettingChangeMark): boolean {
  const entry = findEntry(change.key)
  if (!entry) return false
  writeEntry(entry, change.to)
  return true
}

/** Where the value stands now against the change on the card. */
export function settingChangeState(change: SettingChangeMark): 'applied' | 'undone' | 'moved' {
  const entry = findEntry(change.key)
  if (!entry) return 'moved'
  return entryState(entry, change.from, change.to)
}
