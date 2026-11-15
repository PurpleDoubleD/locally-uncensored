// Watchers: the shapes Rust hands over (src-tauri/src/watchers.rs). Times are
// milliseconds since 1970; a daily time is the computer's local time.

export type WatcherSchedule =
  | { kind: 'once'; at: number }
  /** days: 0 = Monday … 6 = Sunday; empty = every day. */
  | { kind: 'daily'; hour: number; minute: number; days: number[] }
  | { kind: 'interval'; minutes: number }

export interface WatcherRights {
  web: boolean
  /** Read and write files in the working folder. */
  files: boolean
  /** Run commands in the working folder. */
  terminal: boolean
  /** Make pictures and videos. */
  create: boolean
  /** Folders outside the working folder, allowed by name. */
  extra_folders: string[]
}

export interface WatcherRun {
  at: number
  ms: number
  status: 'done' | 'failed' | 'stopped'
  summary: string
}

export interface Watcher {
  id: string
  name: string
  task: string
  schedule: WatcherSchedule
  rights: WatcherRights
  folder: string | null
  model: string | null
  paused: boolean
  created_at: number
  next_at: number | null
  running_since: number | null
  conversation_id: string | null
  origin_conversation_id: string | null
  runs: WatcherRun[]
}

/** A watcher the last quit of LU ended, shown once after the start. */
export interface WatcherHint {
  id: string
  name: string
  was_next: number | null
}

export interface WatcherListing {
  watchers: Watcher[]
  hints: WatcherHint[]
}

export interface WatcherSpec {
  name: string
  task: string
  schedule: WatcherSchedule
  rights: WatcherRights
  folder?: string | null
  model?: string | null
  originConversationId?: string | null
}

export type WatcherPatch = Partial<{
  name: string
  task: string
  schedule: WatcherSchedule
  rights: WatcherRights
  /** '' clears it. */
  folder: string
  /** '' clears it. */
  model: string
  paused: boolean
  conversationId: string
}>

export const NO_RIGHTS: WatcherRights = { web: false, files: false, terminal: false, create: false, extra_folders: [] }
