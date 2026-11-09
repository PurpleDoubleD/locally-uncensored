// The tools that read and change LU's own settings on request (A11, 3.0.8,
// grown in C60 / 3.1.0): "stell Auto Compact auf 80". get_settings only
// reads. set_setting and set_settings change nothing until the user accepts
// the card in the tool call, also in Bypass.
//
// Like the Create tools they stand apart from BUILTIN_TOOLS: that list is
// mirrored to the phone and offered in every Code turn. These ride along only
// when a message is about LU itself (lib/settings-tool-names.ts), and only on
// surfaces that draw the card: the chat, Agent and Code. A sub-agent, a voice
// session, a workflow or the local API never get them (run.settingsCard).
//
// What may be changed, and how, is lib/settings-catalog.ts; where each value
// lives is lib/settings-stores.ts; when a card may come at all is
// lib/self-control-policy.ts (the user's own words, no foreign content for
// strong changes, at most three cards a run).
import { v4 as uuid } from 'uuid'
import type { MCPToolDefinition, ToolArgs } from './types'
import type { ToolRegistry } from './tool-registry'
import type { AgentRunContext } from '../agent-context'
import {
  GET_SETTINGS, SET_SETTING, SET_SETTINGS, SET_SETTINGS_MAX, SETTINGS_TOOL_NAMES, isSettingsToolName, SETTINGS_PROMPT_LINE,
} from '../../lib/settings-tool-names'
import { useSettingsConfirmStore, type SettingChangeItem } from '../../stores/settingsConfirmStore'
import { useSettingsAuditStore } from '../../stores/settingsAuditStore'
import { useModelStore } from '../../stores/modelStore'
import {
  CATALOG, LOCK_RULES, SETTINGS_AREAS, areaOf, findEntry, isArea, isHiddenKey, lockedRule, normKey,
  sameValue, similarKeys, tabName, textNames, type CatalogEntry, type SettingsArea,
} from '../../lib/settings-catalog'
import {
  describeEntryNow, entryState, normalizeForStore, prepareEntry, readEntry, refuseValue, writeEntry,
} from '../../lib/settings-stores'
import { checkSelfControl, noteCard } from '../../lib/self-control-policy'
import { taintLabel } from '../../lib/run-taint'

export { GET_SETTINGS, SET_SETTING, SET_SETTINGS, SET_SETTINGS_MAX, SETTINGS_TOOL_NAMES, isSettingsToolName, SETTINGS_PROMPT_LINE }

/** Most entries one get_settings answer lists: a 9B model with 8k context
 *  reads twelve lines, not seventy. */
export const GET_SETTINGS_MAX = 12

const AREA_NAMES = Object.keys(SETTINGS_AREAS).join(', ')

export const SETTINGS_TOOLS: MCPToolDefinition[] = [
  {
    name: GET_SETTINGS,
    description: 'Read LU app settings, one line each. No argument: the areas. '
      + 'area or query (a key or a word like compact): the keys. Read only. Call before set_setting.',
    brief: 'Read LU app settings by area or search word.',
    inputSchema: {
      type: 'object',
      properties: {
        area: { type: 'string', description: 'e.g. context, voice, create, gpu.' },
        query: { type: 'string', description: 'A key or a word.' },
      },
      required: [],
    },
    category: 'system',
    source: 'builtin',
  },
  {
    name: SET_SETTING,
    description: 'Change one LU app setting. Nothing changes until the user accepts the card. '
      + 'Locked keys are refused. Use a key and a value get_settings lists.',
    brief: 'Change one LU app setting; the user confirms on a card.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Setting key from get_settings.' },
        value: { type: ['string', 'number', 'boolean'], description: 'New value, e.g. 80, on, dark.' },
      },
      required: ['key', 'value'],
    },
    category: 'system',
    source: 'builtin',
  },
]

const LOCKED_LINE = 'Locked, only the user changes these in Settings: '
  + LOCK_RULES.map((r) => r.what.toLowerCase()).join(', ') + '.'

function lockedReply(key: string): string | null {
  const rule = lockedRule(key)
  if (!rule) return null
  return `Refused: ${rule.what} is locked. Nothing changed. Only the user can change it, in ${rule.where}. Tell the user so.`
}

function listed(entries: readonly CatalogEntry[], head: string): string {
  const shown = entries.slice(0, GET_SETTINGS_MAX).map(describeEntryNow)
  const more = entries.length - shown.length
  return [head, ...shown, ...(more > 0 ? [`(+${more} more: narrow with query)`] : [])].join('\n')
}

export async function executeGetSettings(args: ToolArgs): Promise<string> {
  const query = typeof args?.query === 'string' ? args.query.trim() : ''
  const areaArg = typeof args?.area === 'string' ? args.area.trim().toLowerCase() : ''
  const qArea = query.toLowerCase()
  const area: SettingsArea | null = isArea(areaArg) ? areaArg : isArea(qArea) ? qArea : null
  if (area) {
    const inArea = CATALOG.filter((c) => areaOf(c) === area)
    return listed(inArea, `LU settings, ${SETTINGS_AREAS[area].label} (key = value | allowed | what):`)
  }
  if (!query) {
    // The map, not the territory: seventy lines would fill a small model's
    // whole window. One line per area, then the model asks for one.
    const counts = (Object.keys(SETTINGS_AREAS) as (keyof typeof SETTINGS_AREAS)[])
      .map((a) => `${a} (${CATALOG.filter((c) => areaOf(c) === a).length}): ${SETTINGS_AREAS[a].label}`)
    return ['LU settings by area. Call get_settings with area or query for the keys:', ...counts, LOCKED_LINE].join('\n')
  }
  const exact = findEntry(query)
  if (exact) return describeEntryNow(exact)
  const q = normKey(query)
  const words = query.toLowerCase().split(/[^a-z0-9äöüß]+/).filter((w) => w.length >= 3)
  const hits = CATALOG.filter((c) => {
    const hay = `${c.key} ${c.label} ${c.help} ${(c.synonyms ?? []).join(' ')}`.toLowerCase()
    return (q.length >= 3 && normKey(hay).includes(q)) || words.some((w) => hay.includes(w))
  })
  if (hits.length) return listed(hits, `LU settings matching "${query}":`)
  const locked = lockedReply(query)
  if (locked) return locked
  return `No setting matches "${query}". Call get_settings with an area: ${AREA_NAMES}.`
}

/** The line set_setting puts under its answer, one per change, so the card can
 *  undo the change later, also after a restart. */
const MARK = /<!-- lu-setting (\{.*?\}) -->/g

export interface SettingChange { key: string; from: unknown; to: unknown }

export function parseSettingChanges(result: string | null | undefined): SettingChange[] {
  if (typeof result !== 'string') return []
  const out: SettingChange[] = []
  for (const m of result.matchAll(MARK)) {
    try {
      const v = JSON.parse(m[1]) as Partial<SettingChange>
      if (typeof v.key === 'string' && 'from' in v && 'to' in v) out.push({ key: v.key, from: v.from, to: v.to })
    } catch { /* a broken mark is no change */ }
  }
  return out
}

export function parseSettingChange(result: string | null | undefined): SettingChange | null {
  return parseSettingChanges(result)[0] ?? null
}

const markOf = (c: SettingChange) => `<!-- lu-setting ${JSON.stringify(c)} -->`

const APPLIES_NOTE: Record<string, string> = {
  'engine-restart': 'Applies on the next start of the engine.',
  'comfy-restart': 'Applies on the next start of ComfyUI.',
  'next-render': 'Applies from the next render.',
  'next-message': 'Applies from the next message.',
}

function noteFor(entry: CatalogEntry): string | undefined {
  return (entry.applies && APPLIES_NOTE[entry.applies]) ?? /Applies[^.]*\./.exec(entry.help)?.[0]
}

type Checked =
  | { ok: true; entry: CatalogEntry; before: unknown; value: unknown; item: SettingChangeItem }
  | { ok: false; reply: string; same?: boolean }

/** Everything short of the card: known, not locked, a valid value, the safe
 *  direction, a real change. */
async function checkOne(keyRaw: unknown, valueRaw: unknown): Promise<Checked> {
  const key = typeof keyRaw === 'string' ? keyRaw.trim() : ''
  if (!key) return { ok: false, reply: 'Error: key is missing. Call get_settings for the keys. Nothing changed.' }
  const entry = findEntry(key)
  if (!entry) {
    const locked = lockedReply(key)
    if (locked) return { ok: false, reply: locked }
    const near = isHiddenKey(key) ? [] : similarKeys(key)
    return { ok: false, reply: `Error: there is no setting "${key}". ${near.length ? `Closest: ${near.join(', ')}. ` : ''}Call get_settings. Nothing changed.` }
  }
  await prepareEntry(entry)
  const parsed = entry.parse(valueRaw)
  if (!parsed.ok) {
    return { ok: false, reply: `Error: ${entry.label} (${entry.key}) ${parsed.error}. Allowed: ${entry.allowed}. Nothing changed.` }
  }
  const refused = refuseValue(entry, parsed.value)
  if (refused) return { ok: false, reply: `Error: ${entry.label} ${String(parsed.value)}: ${refused}. Nothing changed.` }
  const value = normalizeForStore(entry, parsed.value)
  const before = readEntry(entry)
  if (entry.safe && !entry.safe(value, before)) {
    return { ok: false, reply: `Refused: from the chat ${entry.label} can only be set to ${entry.allowed}. ${entry.safeWhy}. Nothing changed. The user can change it in ${tabName(entry.tab)}.` }
  }
  if (sameValue(before, value)) return { ok: false, same: true, reply: `${entry.label} is already ${entry.show(before)}. Nothing changed.` }
  return { ok: true, entry, before, value, item: { key: entry.key, label: entry.label, from: entry.show(before), to: entry.show(value), note: noteFor(entry) } }
}

function audit(run: AgentRunContext | undefined, row: {
  key: string; label: string; from: string; to: string; outcome: 'applied' | 'declined' | 'timeout' | 'refused' | 'failed';
  rawFrom?: unknown; rawTo?: unknown; why?: string; tainted?: string
}): void {
  useSettingsAuditStore.getState().record({
    conversationId: run?.conversationId ?? null,
    model: useModelStore.getState().activeModel ?? null,
    kind: 'setting',
    ...row,
  })
}

const namesOf = (entry: CatalogEntry) => (text: string, strict: boolean) => textNames(entry, text, strict)

export async function executeSetSetting(args: ToolArgs, run?: AgentRunContext, signal?: AbortSignal): Promise<string> {
  if (!run?.settingsCard) {
    return 'Error: settings can only be changed in a chat where the user sees the confirmation card. Nothing changed.'
  }
  const c = await checkOne(args?.key, args?.value)
  if (!c.ok) return c.reply
  const { entry, before, value, item } = c
  const verdict = checkSelfControl(run, { names: namesOf(entry), strong: entry.risk === 'strong', what: entry.label })
  if (!verdict.ok) {
    audit(run, { ...item, outcome: 'refused', why: verdict.why })
    return verdict.reply
  }
  noteCard(run)
  const answer = await useSettingsConfirmStore.getState().askFull({
    id: uuid(),
    toolCallId: run.toolCallId,
    conversationId: run.conversationId,
    key: entry.key,
    label: entry.label,
    from: item.from,
    to: item.to,
    note: item.note,
    risk: entry.risk ?? 'card',
    taintedBy: verdict.taintedBy,
  }, signal ?? run.abortSignal)
  if (!answer.allow) {
    audit(run, { ...item, outcome: answer.reason === 'timeout' ? 'timeout' : 'declined', tainted: verdict.taintedBy })
    return answer.reason === 'timeout'
      ? `No answer on the card for 10 minutes, so no. ${entry.label} stays ${item.from}. Do not ask again unless the user asks.`
      : `The user declined. ${entry.label} stays ${item.from}. Do not ask again unless the user asks.`
  }
  // The value may have moved while the card was open (by hand, another chat).
  const now = readEntry(entry)
  if (!sameValue(now, before)) {
    audit(run, { ...item, outcome: 'refused', why: 'moved' })
    return `${entry.label} changed to ${entry.show(now)} while the card was open. Nothing applied. Ask the user again if it is still wanted.`
  }
  try {
    writeEntry(entry, value)
  } catch (e) {
    audit(run, { ...item, outcome: 'failed', why: String(e) })
    return `Error: ${entry.label} could not be changed: ${String(e)}. Nothing changed.`
  }
  audit(run, { ...item, outcome: 'applied', rawFrom: before, rawTo: value, tainted: verdict.taintedBy })
  return `Changed: ${entry.label} ${item.from} → ${item.to}.${item.note ? ` ${item.note}` : ''} The user can undo it on the card.\n${markOf({ key: entry.key, from: before, to: value })}`
}

export async function executeSetSettings(args: ToolArgs, run?: AgentRunContext, signal?: AbortSignal): Promise<string> {
  if (!run?.settingsCard) {
    return 'Error: settings can only be changed in a chat where the user sees the confirmation card. Nothing changed.'
  }
  const raw = Array.isArray(args?.changes) ? (args.changes as unknown[]) : []
  if (raw.length === 0) return 'Error: changes is empty. Pass [{"key":…,"value":…}]. Nothing changed.'
  if (raw.length > SET_SETTINGS_MAX) return `Error: at most ${SET_SETTINGS_MAX} changes on one card. Nothing changed.`
  const lines: string[] = []
  const ok: Extract<Checked, { ok: true }>[] = []
  for (const r of raw) {
    const o = (r && typeof r === 'object' ? r : {}) as { key?: unknown; value?: unknown }
    const c = await checkOne(o.key, o.value)
    if (!c.ok) { lines.push(c.reply); continue }
    if (ok.some((x) => x.entry.key === c.entry.key)) { lines.push(`Error: ${c.entry.label} twice. The first one counts.`); continue }
    const v = checkSelfControl(run, { names: namesOf(c.entry), strong: c.entry.risk === 'strong', what: c.entry.label })
    if (!v.ok) { audit(run, { ...c.item, outcome: 'refused', why: v.why }); lines.push(`${c.entry.label}: ${v.reply}`); continue }
    ok.push(c)
  }
  if (ok.length === 0) return lines.join('\n')
  noteCard(run)
  const taintedBy = taintLabel(run)
  const first = ok[0].item
  const answer = await useSettingsConfirmStore.getState().askFull({
    id: uuid(),
    toolCallId: run.toolCallId,
    conversationId: run.conversationId,
    key: first.key, label: first.label, from: first.from, to: first.to,
    items: ok.map((c) => c.item),
    risk: ok.some((c) => c.entry.risk === 'strong') ? 'strong' : 'card',
    taintedBy,
  }, signal ?? run.abortSignal)
  if (!answer.allow) {
    for (const c of ok) audit(run, { ...c.item, outcome: answer.reason === 'timeout' ? 'timeout' : 'declined', tainted: taintedBy })
    lines.push(answer.reason === 'timeout'
      ? 'No answer on the card for 10 minutes, so no. Nothing changed. Do not ask again unless the user asks.'
      : 'The user declined the card. Nothing changed. Do not ask again unless the user asks.')
    return lines.join('\n')
  }
  const selected = new Set(answer.selected ?? ok.map((c) => c.entry.key))
  const marks: string[] = []
  for (const c of ok) {
    if (!selected.has(c.entry.key)) {
      audit(run, { ...c.item, outcome: 'declined', tainted: taintedBy })
      lines.push(`Unticked by the user: ${c.entry.label} stays ${c.item.from}.`)
      continue
    }
    const now = readEntry(c.entry)
    if (!sameValue(now, c.before)) {
      audit(run, { ...c.item, outcome: 'refused', why: 'moved' })
      lines.push(`${c.entry.label} changed to ${c.entry.show(now)} while the card was open. Not applied.`)
      continue
    }
    try {
      writeEntry(c.entry, c.value)
    } catch (e) {
      audit(run, { ...c.item, outcome: 'failed', why: String(e) })
      lines.push(`Error: ${c.entry.label} could not be changed: ${String(e)}.`)
      continue
    }
    audit(run, { ...c.item, outcome: 'applied', rawFrom: c.before, rawTo: c.value, tainted: taintedBy })
    lines.push(`Changed: ${c.entry.label} ${c.item.from} → ${c.item.to}.${c.item.note ? ` ${c.item.note}` : ''}`)
    marks.push(markOf({ key: c.entry.key, from: c.before, to: c.value }))
  }
  if (marks.length) lines.push('The user can undo each on the card.', ...marks)
  return lines.join('\n')
}

/** Undo from the card: back to the value before, through the same catalog. */
export function undoSettingChange(change: SettingChange): boolean {
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
export function redoSettingChange(change: SettingChange): boolean {
  const entry = findEntry(change.key)
  if (!entry) return false
  writeEntry(entry, change.to)
  return true
}

/** Where the value stands now against the change on the card. */
export function settingChangeState(change: SettingChange): 'applied' | 'undone' | 'moved' {
  const entry = findEntry(change.key)
  if (!entry) return 'moved'
  return entryState(entry, change.from, change.to)
}

export function registerSettingsTools(registry: ToolRegistry): void {
  registry.registerBuiltin(SETTINGS_TOOLS[0], (a) => executeGetSettings(a))
  registry.registerBuiltin(SETTINGS_TOOLS[1], (a, run, signal) => executeSetSetting(a, run, signal))
}
