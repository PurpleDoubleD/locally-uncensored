// Watchers: the four tools as the registry sees them. Nothing heavy is
// imported here (the registry loads this with the app); the executors load
// on the first call (lib/watchers/tool-exec.ts).
//
// They are offered only on a turn that names a later time or a repeat
// (lib/watcher-tool-names.ts), and only on a surface that draws the card
// (run.settingsCard): the chat with tools, Agent and Code. A new or changed
// watcher waits for the user's yes, as every change LU makes to itself.

import type { JSONSchemaProp, MCPToolDefinition } from './types'
import type { ToolRegistry } from './tool-registry'
import { WATCHER_CREATE, WATCHER_LIST, WATCHER_UPDATE, WATCHER_DELETE } from '../../lib/watcher-tool-names'

const RIGHTS_SCHEMA: JSONSchemaProp = {
  type: 'object',
  description: 'Only what the task needs; all off by default.',
  properties: {
    web: { type: 'boolean', description: 'Web.' },
    files: { type: 'boolean', description: 'Files in the working folder.' },
    terminal: { type: 'boolean', description: 'Commands in the working folder.' },
    create: { type: 'boolean', description: 'Pictures, videos.' },
  },
}

const WHEN_PROPS: Record<string, JSONSchemaProp> = {
  repeat: { type: 'string', enum: ['once', 'daily', 'weekdays', 'interval'], description: 'How often.' },
  time: { type: 'string', description: 'Local HH:MM, 24 h.' },
  date: { type: 'string', description: 'YYYY-MM-DD, once on a later day.' },
  in_minutes: { type: 'number', description: 'Once, in N minutes.' },
  days: { type: 'array', items: { type: 'string' }, description: 'weekdays: ["mon","fri"].' },
  every_minutes: { type: 'number', description: 'interval: minutes, 10 or more.' },
}

export const WATCHER_TOOLS: MCPToolDefinition[] = [
  {
    name: WATCHER_CREATE,
    description: 'Schedule a task LU runs by itself as an agent turn, once or repeatedly, also with the window closed, until LU quits. User confirms on a card.',
    brief: 'Schedule a task the AI runs later or repeatedly.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name.' },
        task: { type: 'string', description: 'Full standalone order: what to do and report.' },
        ...WHEN_PROPS,
        rights: RIGHTS_SCHEMA,
        folder: { type: 'string', description: 'Working folder, full path, only for file work.' },
        extra_folders: { type: 'array', items: { type: 'string' }, description: 'More full paths, only ones the user named.' },
      },
      required: ['name', 'task', 'repeat'],
    },
    category: 'system',
    source: 'builtin',
  },
  {
    name: WATCHER_LIST,
    description: 'List watchers: id, name, schedule, next run, last result.',
    brief: 'List the scheduled watchers.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'system',
    source: 'builtin',
  },
  {
    name: WATCHER_UPDATE,
    description: 'Change a watcher; only given fields change. paused pauses or resumes. User confirms on a card.',
    brief: 'Change, pause or resume a watcher.',
    inputSchema: {
      type: 'object',
      properties: {
        watcher: { type: 'string', description: 'Id or name.' },
        name: { type: 'string', description: 'New name.' },
        task: { type: 'string', description: 'New order.' },
        ...WHEN_PROPS,
        rights: RIGHTS_SCHEMA,
        folder: { type: 'string', description: 'New working folder; empty for its own.' },
        paused: { type: 'boolean', description: 'Pause or resume.' },
      },
      required: ['watcher'],
    },
    category: 'system',
    source: 'builtin',
  },
  {
    name: WATCHER_DELETE,
    description: 'Delete a watcher. User confirms on a card.',
    brief: 'Delete a watcher.',
    inputSchema: {
      type: 'object',
      properties: { watcher: { type: 'string', description: 'Id or name.' } },
      required: ['watcher'],
    },
    category: 'system',
    source: 'builtin',
  },
]

const exec = () => import('../../lib/watchers/tool-exec')

export function registerWatcherTools(registry: ToolRegistry): void {
  const [create, list, update, del] = WATCHER_TOOLS
  registry.registerBuiltin(create, async (a, run, signal) => (await exec()).executeWatcherCreate(a, run, signal))
  registry.registerBuiltin(list, async () => (await exec()).executeWatcherList())
  registry.registerBuiltin(update, async (a, run, signal) => (await exec()).executeWatcherUpdate(a, run, signal))
  registry.registerBuiltin(del, async (a, run, signal) => (await exec()).executeWatcherDelete(a, run, signal))
}
