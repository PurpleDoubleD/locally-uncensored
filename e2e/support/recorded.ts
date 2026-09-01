import type { Page } from '@playwright/test'

/**
 * Typed read-back for everything the in-page Tauri mock records.
 *
 * `support/tauri-mock.ts` runs inside the BROWSER and pushes plain objects onto
 * `window.__E2E_*__`. What comes back through `page.evaluate` therefore crosses
 * a serialization boundary: Node did not build those values and cannot know
 * their shape. That is the same situation as a foreign HTTP body, so this file
 * follows the same rule as `src/api/providers/wire.ts` — check before you
 * claim. `isRecord` before a property read, `Array.isArray` before iterating,
 * `typeof` before a string or number is handed on.
 *
 * The one rule this file adds on top: a recorded entry WITHOUT a string `cmd`
 * is an error, not a value to drop. Every spec here filters on `cmd`, so a
 * silently discarded record turns `expect(calls.filter(…))` into an assertion
 * about the empty set — a green test that proves nothing. The mock has already
 * produced exactly that bug once (`video_install_model` recorded `id:
 * undefined` because the payload is nested under `args`; see the comment in
 * tauri-mock.ts), which is why the parse is loud instead of forgiving.
 *
 * Parsed calls keep a reference to their untouched source record in `raw`.
 * Assertions about what must NOT be in a call ("the token value is never
 * echoed") have to run against what the page actually recorded — running them
 * against the parsed projection would only test this parser.
 */

// ── Boundary primitives ────────────────────────────────────────

/** True for a plain object we may index. Arrays and null are rejected. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

/** Array of strings, or [] — the shape of the plain URL buckets. */
export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

// ── The recorded envelope ──────────────────────────────────────

/** Anything `record()` in the mock pushed: a plain object naming a command. */
type CommandRecord = Record<string, unknown> & { cmd: string }

function isCommandRecord(v: unknown): v is CommandRecord {
  return isRecord(v) && typeof v.cmd === 'string'
}

/**
 * Validate one recorded bucket. An absent bucket is legitimately empty (the
 * mock only creates it on first write); anything else that is not an array of
 * `{ cmd: string, … }` means the mock and this parser have drifted apart, and
 * the spec must hear about that rather than silently measure nothing.
 */
function commandRecords(raw: unknown, bucket: string): CommandRecord[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new Error(`${bucket}: expected an array of recorded calls, got ${JSON.stringify(raw)}`)
  }
  return raw.map((entry, i) => {
    if (!isCommandRecord(entry)) {
      throw new Error(`${bucket}[${i}]: recorded entry has no string \`cmd\`: ${JSON.stringify(entry)}`)
    }
    return entry
  })
}

// ── MLX media surface (commands/mlx.rs + video.rs) ─────────────

/**
 * One entry of `__E2E_MLX_CALLS__`. Only `cmd` is guaranteed — which fields
 * ride along depends on the command, and a field the mock did not record must
 * read as `undefined` here rather than as a wrong value.
 */
export interface RecordedMlxCall {
  /** The record exactly as the page pushed it. */
  readonly raw: Readonly<Record<string, unknown>>
  cmd: string
  /** Model id — `mlx_image_install_model`, `video_install_model`, … */
  id?: string
  /** `mlx_generate` / `video_generate`. */
  prompt?: string
  model?: string
  steps?: number
  seed?: number
  width?: number
  height?: number
  seconds?: number
  /** `set_hf_token` reports only PRESENCE, never the token value. */
  present?: boolean
}

function parseMlxCall(e: CommandRecord): RecordedMlxCall {
  return {
    raw: e,
    cmd: e.cmd,
    id: asString(e.id),
    prompt: asString(e.prompt),
    model: asString(e.model),
    steps: asNumber(e.steps),
    seed: asNumber(e.seed),
    width: asNumber(e.width),
    height: asNumber(e.height),
    seconds: asNumber(e.seconds),
    present: asBoolean(e.present),
  }
}

/** Everything the page recorded through the mocked MLX / video commands. */
export async function mlxCalls(page: Page): Promise<RecordedMlxCall[]> {
  const raw = await page.evaluate(
    () => (window as unknown as { __E2E_MLX_CALLS__?: unknown }).__E2E_MLX_CALLS__,
  )
  return commandRecords(raw, '__E2E_MLX_CALLS__').map(parseMlxCall)
}

// ── Agent file/shell bridge ────────────────────────────────────

/** One entry of `__E2E_TOOL_CALLS__` (fs_read/fs_write/fs_list/shell_execute). */
export interface RecordedToolCall {
  readonly raw: Readonly<Record<string, unknown>>
  cmd: string
  path?: string
  /** `shell_execute` — the command line the agent asked Rust to run. */
  command?: string
  /** `shell_execute` — the timeout the caller injected, in milliseconds. */
  timeout?: number
}

function parseToolCall(e: CommandRecord): RecordedToolCall {
  return {
    raw: e,
    cmd: e.cmd,
    path: asString(e.path),
    command: asString(e.command),
    timeout: asNumber(e.timeout),
  }
}

/** Every file/shell tool call the agent loop pushed through the Tauri bridge. */
export async function toolCalls(page: Page): Promise<RecordedToolCall[]> {
  const raw = await page.evaluate(
    () => (window as unknown as { __E2E_TOOL_CALLS__?: unknown }).__E2E_TOOL_CALLS__,
  )
  return commandRecords(raw, '__E2E_TOOL_CALLS__').map(parseToolCall)
}

// ── ComfyUI probe ──────────────────────────────────────────────

/** One entry of `__E2E_COMFY_CALLS__`. The mock records the bare command. */
export interface RecordedComfyCall {
  readonly raw: Readonly<Record<string, unknown>>
  cmd: string
}

/**
 * Every ComfyUI probe the page attempted. The Mac specs assert this stays
 * empty, so the parse must be strict: a malformed entry that got dropped would
 * make "no ComfyUI call happened" true for the wrong reason.
 */
export async function comfyCalls(page: Page): Promise<RecordedComfyCall[]> {
  const raw = await page.evaluate(
    () => (window as unknown as { __E2E_COMFY_CALLS__?: unknown }).__E2E_COMFY_CALLS__,
  )
  return commandRecords(raw, '__E2E_COMFY_CALLS__').map((e) => ({ raw: e, cmd: e.cmd }))
}

// ── Plain buckets ──────────────────────────────────────────────

/** Every URL that went through `proxy_localhost`, in call order. */
export async function proxyUrls(page: Page): Promise<string[]> {
  const raw = await page.evaluate(
    () => (window as unknown as { __E2E_PROXY_URLS__?: unknown }).__E2E_PROXY_URLS__,
  )
  return asStringArray(raw)
}

/** The HuggingFace token Rust currently holds — `undefined` when it holds none. */
export async function hfToken(page: Page): Promise<string | undefined> {
  const raw = await page.evaluate(
    () => (window as unknown as { __E2E_HF_TOKEN__?: unknown }).__E2E_HF_TOKEN__,
  )
  return asString(raw)
}

// ── Lookup ─────────────────────────────────────────────────────

/**
 * The first recorded call for `cmd`, or a failure that names what was actually
 * recorded. `calls.find(…)!.field` reads the same until it does not, and then
 * reports "cannot read properties of undefined" — which says nothing about
 * which command never arrived.
 */
export function requireCall<T extends { cmd: string }>(calls: readonly T[], cmd: string): T {
  const hit = calls.find((c) => c.cmd === cmd)
  if (!hit) {
    const seen = calls.map((c) => c.cmd).join(', ')
    throw new Error(`no \`${cmd}\` call was recorded — recorded instead: ${seen || '(nothing)'}`)
  }
  return hit
}
