/**
 * Reply shapes of the Rust bridge commands the tool layer calls.
 *
 * These describe code we own: each interface below was read off the
 * `serde_json::json!` literal that produces it in `src-tauri/src/commands/`,
 * and a field is optional here exactly when Rust can omit it (a binary
 * `fs_read` carries `bytes` and no `content`, for instance).
 *
 * That is why these are declarations rather than runtime guards: unlike an MCP
 * server or a ComfyUI graph, the producer is in this repository and changes to
 * it are changes to this file. Foreign JSON still goes through
 * `src/types/json-guards.ts`.
 *
 * Type-only module — no imports, no runtime code, cannot join an import cycle.
 */

/** `shell_execute`, `execute_code` — commands/shell.rs, commands/agent.rs. */
export interface ShellExecResult {
  stdout: string
  stderr: string
  /** `status.code()`, or -1 when the child was killed or timed out. */
  exitCode: number
  timedOut: boolean
}

/** `fs_read` — commands/filesystem.rs. Binary files carry `bytes`, no `content`. */
export interface FsReadResult {
  content?: string
  encoding: 'utf8' | 'binary' | 'base64'
  bytes?: number
}

/** `fs_write` — commands/filesystem.rs. */
export interface FsWriteResult {
  status: 'saved' | 'unchanged'
  path: string
  bytes: number
}

/** One `fs_list` entry — commands/filesystem.rs. */
export interface FsEntry {
  name: string
  path: string
  size: number
  isDir: boolean
  /** Unix seconds; 0 when the metadata read failed. */
  modified: number
}

export interface FsListResult {
  entries: FsEntry[]
  count?: number
}

/** `fs_search` — one matching line inside one file. */
export interface FsSearchMatch {
  line: number
  text: string
}

export interface FsSearchHit {
  file: string
  matches?: FsSearchMatch[]
}

export interface FsSearchResult {
  results: FsSearchHit[]
}

/** `web_search` — commands/web.rs. `results` is absent on a hard failure. */
export interface WebSearchHit {
  title: string
  url: string
  snippet: string
}

export interface WebSearchResult {
  results?: WebSearchHit[]
  provider?: string
  /** Set when the CONFIGURED provider failed and a free fallback answered. */
  providerError?: string
  error?: string
}

/** `web_fetch` — the aggressively stripped page body. */
export interface WebFetchResult {
  url: string
  status: number
  contentType: string
  title: string
  text: string
  truncated: boolean
}

/** `process_list` — one running process. */
export interface ProcessInfo {
  name: string
  pid: number
  memory: number
  cpu: number
}

export interface ProcessListResult {
  processes: ProcessInfo[]
  count?: number
}

/** `screenshot` — base64 PNG payload. */
export interface ScreenshotResult {
  image?: string
  format?: string
  encoding?: string
}

/** `get_current_time`. */
export interface CurrentTimeResult {
  unix: number
  iso_local: string
  iso_utc: string
  timezone: string
  timezone_offset: number
}
