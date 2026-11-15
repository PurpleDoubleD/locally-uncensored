// Watchers: the names of the four tools and when a message is about one.
// Apart from the executors (api/mcp/watcher-tools.ts) so the catalog filters
// can know them without loading the stores behind the tools.
//
// They belong to the self-control family (lib/settings-tool-names.ts): what a
// sub-agent, a voice session, a workflow or the local API never gets, and what
// changes LU only after the user's yes on the card. They ride along on their
// own gate, a message that names a time or a repeat, so a settings question
// does not carry them and a reminder does not carry the settings tools.

export const WATCHER_CREATE = 'watcher_create'
export const WATCHER_LIST = 'watcher_list'
export const WATCHER_UPDATE = 'watcher_update'
export const WATCHER_DELETE = 'watcher_delete'

export const WATCHER_TOOL_NAMES = [WATCHER_CREATE, WATCHER_LIST, WATCHER_UPDATE, WATCHER_DELETE] as const

export function isWatcherToolName(name: string): boolean {
  return (WATCHER_TOOL_NAMES as readonly string[]).includes(name)
}

/** The line the system prompt gets on a turn that carries the tools. */
export const WATCHER_PROMPT_LINE = 'Watchers: when the user wants something done later or again and again '
  + '("at 18:00 check …", "every morning at 8 …", "in 20 minutes remind me …"), make a watcher with watcher_create '
  + 'instead of waiting. A watcher runs that task as a new agent turn at that time, also with the window closed, '
  + 'as long as LU runs; it ends when LU quits. Write the task so it stands alone. Ask for only the rights the task '
  + 'needs (web, files, terminal, create) and a folder only if it works on files. The user confirms on a card. '
  + 'watcher_list shows them; watcher_update and watcher_delete change or remove one.'

/** Words that name a later time or a repeat, in English and German. Also
 *  the gate of the four tools in the coding catalog (lib/tool-selection.ts). */
export const WATCHER_GATE_WORDS: readonly string[] = [
  'watcher', 'wächter', 'waechter',
  'remind me', 'reminder', 'erinnere mich', 'erinner mich', 'erinnerung',
  'every day', 'everyday', 'every morning', 'every evening', 'every night', 'every hour', 'every week',
  'each day', 'each morning', 'daily', 'hourly', 'weekly',
  'jeden tag', 'jeden morgen', 'jeden abend', 'jede nacht', 'jede stunde', 'jede woche',
  'täglich', 'taeglich', 'stündlich', 'stuendlich', 'wöchentlich', 'woechentlich',
  'o\'clock', ' uhr', 'tonight', 'heute abend', 'morgen früh', 'morgen frueh', 'tomorrow morning',
  'keep an eye', 'behalte im auge', 'behalt im auge', 'pass auf', 'pass mal auf', 'schau um', 'check at', 'schedule', 'zeitplan',
  'later today', 'heute später', 'heute spaeter',
]

/** "18:00", "8 am", "um 8", "at 7", "in 20 minutes", "in 2 Stunden". */
const TIME_PATTERNS = [
  /\b([01]?\d|2[0-3])[:.][0-5]\d\b/,
  /\b(1[0-2]|0?[1-9])\s?(am|pm)\b/,
  /\b(um|at|gegen)\s+([01]?\d|2[0-3])\b/,
  /\bin\s+\d+\s*(min|minute|minuten|minutes|h|hour|hours|stunde|stunden)\b/,
]

/** True when a message is about doing something later or again. */
export function asksAboutWatchers(userMessage: string): boolean {
  const msg = ` ${(userMessage || '').toLowerCase()} `
  return WATCHER_GATE_WORDS.some((w) => msg.includes(w)) || TIME_PATTERNS.some((re) => re.test(msg))
}
