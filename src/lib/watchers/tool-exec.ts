// Watchers: what the four tools do. Loaded on the first call
// (api/mcp/watcher-tools.ts registers them).
//
// Every change goes through the same gate as LU's other self-control actions
// (confirmAction: the policy, then the card): the user's own message has to
// be about a later time or a watcher, a run that read foreign content may not
// hand out the shell or a folder outside, and nothing is made before the yes.
import type { ToolArgs } from '../../api/mcp/types'
import type { AgentRunContext } from '../../api/agent-context'
import { confirmAction } from '../../api/mcp/self-control-tools'
import { backendCall, isTauri } from '../../api/backend'
import { getProviderIdFromModel } from '../../api/providers/model-name'
import { useModelStore } from '../../stores/modelStore'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { useWatcherStore, useWatcherSettingsStore } from '../../stores/watcherStore'
import { isPaidProvider } from '../send-window'
import { sendsToALanBackend } from '../lan-openai-slot'
import { asksAboutWatchers } from '../watcher-tool-names'
import { scheduleFromArgs, repeatText, rightsText, whenText } from './schedule'
import type { Watcher, WatcherListing, WatcherPatch, WatcherRights, WatcherSchedule, WatcherSpec } from './types'

const NOT_HERE = 'Error: watchers exist in the desktop app only. Nothing was made.'
const TASK_SHOWN = 280

const namesWatchers = (t: string) => asksAboutWatchers(t) || /\bwatcher|wächter|waechter\b/i.test(t)

function rightsFrom(raw: unknown, extra: unknown): WatcherRights {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const folders = Array.isArray(extra) ? extra.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []
  return { web: r.web === true, files: r.files === true, terminal: r.terminal === true, create: r.create === true, extra_folders: folders }
}

/** The shell or a folder outside: the red card, and never after foreign content. */
const isStrong = (r: WatcherRights) => r.terminal || r.extra_folders.length > 0

function modelLine(model: string | null): string {
  if (!model) return 'Model: the one active when it runs'
  const provider = getProviderIdFromModel(model)
  const paid = isPaidProvider(provider, sendsToALanBackend(provider, model))
  return `Model: ${model}${paid ? ' · every run is billed like a chat turn with this model' : ' · on this computer, free'}`
}

function scheduleLine(s: WatcherSchedule, now: number, next: number | null): string {
  if (s.kind === 'once') return `When: once, ${next ? whenText(next, now) : 'now'}`
  return `When: ${repeatText(s)}${next ? ` · next ${whenText(next, now)}` : ''}`
}

/** The next run as the card can know it before Rust has the watcher. */
function firstRun(s: WatcherSchedule, now: number): number | null {
  if (s.kind === 'once') return s.at
  if (s.kind === 'interval') return now + s.minutes * 60_000
  for (let i = 0; i < 8; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() + i)
    d.setHours(s.hour, s.minute, 0, 0)
    const wd = (d.getDay() + 6) % 7
    if (d.getTime() > now && (s.days.length === 0 || s.days.includes(wd))) return d.getTime()
  }
  return null
}

function clipTask(t: string): string {
  const s = t.trim().replace(/\s+/g, ' ')
  return s.length > TASK_SHOWN ? `${s.slice(0, TASK_SHOWN - 1)}…` : s
}

/** Once per install, while the user is at the computer: a short "set"
 *  notification, so the system asks for permission now and not with the
 *  first result. Only with notifications on. */
export async function greetOnce(w: Watcher): Promise<void> {
  const s = useWatcherSettingsStore.getState()
  if (s.greeted || !s.notify) return
  s.update({ greeted: true })
  const next = w.next_at ? `next ${whenText(w.next_at, Date.now())}` : repeatText(w.schedule)
  await backendCall('watchers_notify', { title: 'Watcher set', body: `${w.name} · ${next}. Results come here.`, sound: false }).catch(() => null)
}

async function listing(): Promise<WatcherListing> {
  const l = await backendCall<WatcherListing>('watchers_list')
  useWatcherStore.getState().set(l)
  return l
}

/** By id, a unique id prefix, or the name (case does not matter). */
function find(list: Watcher[], key: unknown): Watcher | string {
  const k = String(key ?? '').trim().toLowerCase()
  if (!k) return 'Error: name the watcher (id or name from watcher_list).'
  const hits = list.filter((w) => w.id.toLowerCase() === k || w.id.toLowerCase().startsWith(k) || w.name.toLowerCase() === k)
  const loose = hits.length ? hits : list.filter((w) => w.name.toLowerCase().includes(k))
  if (loose.length === 1) return loose[0]
  return loose.length === 0
    ? `Error: no watcher matches "${key}". Call watcher_list.`
    : `Error: "${key}" matches ${loose.length} watchers: ${loose.map((w) => w.name).join(', ')}. Say which.`
}

export async function executeWatcherCreate(args: ToolArgs, run?: AgentRunContext, signal?: AbortSignal): Promise<string> {
  const now = Date.now()
  const name = typeof args?.name === 'string' ? args.name.trim() : ''
  const task = typeof args?.task === 'string' ? args.task.trim() : ''
  if (!name) return 'Error: watcher_create needs name, a short name. Nothing was made.'
  if (!task) return 'Error: watcher_create needs task, the full order for the run. Nothing was made.'
  if (typeof args?.repeat !== 'string' || !args.repeat.trim()) return 'Error: watcher_create needs repeat: once, daily, weekdays or interval. Nothing was made.'
  if (!isTauri()) return NOT_HERE
  const when = scheduleFromArgs(args ?? {}, now)
  if (!when.ok) return `Error: ${when.error} Nothing was made.`
  const rights = rightsFrom(args?.rights, args?.extra_folders)
  // The working folder: the one named, else the folder the chat it is made in
  // works in, else its own sandbox folder.
  let folder = typeof args?.folder === 'string' && args.folder.trim() ? args.folder.trim() : null
  if (!folder && (rights.files || rights.terminal) && run?.conversationId) {
    const ws = useAgentModeStore.getState().workspaces[run.conversationId]
    if (ws?.kind === 'folder' && ws.path) folder = ws.path
  }
  const model = useModelStore.getState().activeModel || null
  const details = [
    scheduleLine(when.schedule, now, firstRun(when.schedule, now)),
    `Task: ${clipTask(task)}`,
    `May use: ${rightsText(rights, folder)}`,
    modelLine(model),
    'Runs while LU is open or in the tray, also with the window closed. Ends when you quit LU.',
  ]
  const refused = await confirmAction(run, signal, {
    key: 'watcher_create', title: `Make the watcher "${name}"`, details, strong: isStrong(rights), what: 'a watcher',
    names: namesWatchers,
    riskNote: isStrong(rights) ? 'It may run commands or reach folders outside its own, with nobody watching.' : undefined,
  })
  if (refused) return refused
  const spec: WatcherSpec = { name, task, schedule: when.schedule, rights, folder, model, originConversationId: run?.conversationId ?? null }
  try {
    const w = await backendCall<Watcher>('watchers_create', { spec })
    void listing().catch(() => {})
    void greetOnce(w)
    const next = w.next_at ? whenText(w.next_at, Date.now()) : 'now'
    return `Watcher "${w.name}" is set (id ${w.id.slice(0, 8)}): ${repeatText(w.schedule)}, next run ${next}. `
      + 'It runs as long as LU runs, also with the window closed, and ends when LU quits. The user sees it above the message box.'
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)} Nothing was made.`
  }
}

export async function executeWatcherList(): Promise<string> {
  if (!isTauri()) return NOT_HERE
  const { watchers } = await listing()
  if (watchers.length === 0) return 'No watchers.'
  const now = Date.now()
  return watchers.map((w) => {
    const next = w.paused ? 'paused' : w.running_since ? 'running now' : w.next_at ? `next ${whenText(w.next_at, now)}` : 'done'
    const last = w.runs[0] ? ` · last ${w.runs[0].status}${w.runs[0].summary ? `: ${w.runs[0].summary.slice(0, 80)}` : ''}` : ''
    return `${w.id.slice(0, 8)} · ${w.name} · ${repeatText(w.schedule)} · ${next} · may use ${rightsText(w.rights, w.folder)}${last}`
  }).join('\n')
}

export async function executeWatcherUpdate(args: ToolArgs, run?: AgentRunContext, signal?: AbortSignal): Promise<string> {
  if (typeof args?.watcher !== 'string' || !args.watcher.trim()) return 'Error: watcher_update needs watcher, the id or name from watcher_list. Nothing changed.'
  if (!isTauri()) return NOT_HERE
  const now = Date.now()
  const found = find((await listing()).watchers, args?.watcher)
  if (typeof found === 'string') return found
  const patch: WatcherPatch = {}
  const lines: string[] = []
  if (typeof args?.name === 'string' && args.name.trim()) { patch.name = args.name.trim(); lines.push(`Name: ${patch.name}`) }
  if (typeof args?.task === 'string' && args.task.trim()) { patch.task = args.task.trim(); lines.push(`Task: ${clipTask(patch.task)}`) }
  if (args?.repeat !== undefined || args?.time !== undefined || args?.in_minutes !== undefined) {
    const when = scheduleFromArgs(args ?? {}, now)
    if (!when.ok) return `Error: ${when.error} Nothing changed.`
    patch.schedule = when.schedule
    lines.push(scheduleLine(when.schedule, now, firstRun(when.schedule, now)))
  }
  let rights: WatcherRights = found.rights
  if (args?.rights !== undefined) {
    rights = { ...rightsFrom(args.rights, found.rights.extra_folders) }
    patch.rights = rights
    lines.push(`May use: ${rightsText(rights, found.folder)}`)
  }
  if (typeof args?.folder === 'string') { patch.folder = args.folder.trim(); lines.push(`Folder: ${patch.folder || 'its own'}`) }
  if (typeof args?.paused === 'boolean') { patch.paused = args.paused; lines.push(args.paused ? 'Pause it' : 'Resume it') }
  if (lines.length === 0) return 'Error: nothing to change was given. Nothing changed.'
  // Granting the shell or a folder outside is the red card; taking a right
  // away, a new time or a pause is the plain one.
  const grows = (rights.terminal && !found.rights.terminal) || patch.folder !== undefined
  const refused = await confirmAction(run, signal, {
    key: 'watcher_update', title: `Change the watcher "${found.name}"`, details: lines, strong: grows && isStrong(rights), what: 'a watcher',
    names: (t, strict) => namesWatchers(t) || t.toLowerCase().includes(found.name.toLowerCase()) || (!strict && /paus|resume|weiter|stopp/i.test(t)),
  })
  if (refused) return refused
  try {
    const w = await backendCall<Watcher>('watchers_update', { id: found.id, patch })
    void listing().catch(() => {})
    const state = w.paused ? 'paused' : w.next_at ? `next run ${whenText(w.next_at, Date.now())}` : 'no further run'
    return `Watcher "${w.name}" changed: ${repeatText(w.schedule)}, ${state}.`
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)} Nothing changed.`
  }
}

export async function executeWatcherDelete(args: ToolArgs, run?: AgentRunContext, signal?: AbortSignal): Promise<string> {
  if (typeof args?.watcher !== 'string' || !args.watcher.trim()) return 'Error: watcher_delete needs watcher, the id or name from watcher_list. Nothing changed.'
  if (!isTauri()) return NOT_HERE
  const found = find((await listing()).watchers, args?.watcher)
  if (typeof found === 'string') return found
  const refused = await confirmAction(run, signal, {
    key: 'watcher_delete', title: `Delete the watcher "${found.name}"`, strong: false, what: 'a watcher',
    details: [`${repeatText(found.schedule)} · ${clipTask(found.task)}`, 'Its chat stays.'],
    names: (t) => namesWatchers(t) || t.toLowerCase().includes(found.name.toLowerCase()) || /delet|lösch|loesch|remove|entfern/i.test(t),
  })
  if (refused) return refused
  try {
    await backendCall('watchers_delete', { id: found.id })
    void listing().catch(() => {})
    return `Watcher "${found.name}" deleted.`
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)} Nothing changed.`
  }
}

