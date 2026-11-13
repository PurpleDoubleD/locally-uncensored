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
  /**
   * Der Mensch hat Stop gedrueckt, und `shell_execute_cancel` hat den
   * Prozessbaum gefaellt. Eigenes Feld neben `timedOut`, weil eine Zeitgrenze
   * etwas ist, das dem Befehl passiert ist, und ein Abbruch etwas, das der
   * Nutzer getan hat: das Modell soll den Unterschied lesen koennen.
   * Fehlt bei jedem Lauf, der ohne Abbruchkennung gestartet wurde.
   */
  cancelled?: boolean
  /**
   * T1: the command was still running at its timeout and moved into the
   * background-task registry under this id (`shell_task_*`). Only set when
   * the call asked for it with `backgroundOnTimeout: true`.
   */
  taskId?: string
  /** The timeout that was hit, in ms, next to `taskId`. */
  timeoutMs?: number
  /**
   * T1: a finished run with a long output; the whole output stays readable
   * under this id (`shell_task_status`). Same switch as `taskId`.
   */
  outputId?: string
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
  /** 3.0.8: every tier failed (none could be asked). `error` holds the
   *  sentence for the model (`search_tiers::UNAVAILABLE`). */
  unavailable?: boolean
  /** 3.0.8: tiers answered, none found anything for this query. */
  noResults?: boolean
  /** 3.0.8: what each tier answered, in the order they were asked. */
  tried?: WebSearchTry[]
  /** The free searches that were asked and did not deliver, each with its reason. */
  tiers?: Array<{ tier?: string; error?: string }>
}

/** One tier of `web_search` and what it answered (`search_tiers.rs`). */
export interface WebSearchTry {
  tier: string
  outcome: 'results' | 'empty' | 'failed' | 'skipped'
  detail?: string
  count?: number
}

/** `web_fetch` — the aggressively stripped page body. */
export interface WebFetchResult {
  url: string
  status: number
  contentType: string
  title: string
  text: string
  truncated: boolean
  /** One sentence in place of the text: the body was a file (a PDF, an image,
   *  an archive) or its packing could not be undone. `text` is empty then. */
  notText?: string
  /** 3.0.8: `exa` when the local read was refused or found no text and Exa's
   *  reader read the page instead. */
  via?: string
  /** Why the local read was not enough (only with `via`). */
  localProblem?: string
  /** Exa was asked and could not read it either; the local answer stands. */
  readerError?: string
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
