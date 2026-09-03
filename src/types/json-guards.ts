/**
 * Boundary guards for data this app did NOT produce.
 *
 * Three foreign sources meet the frontend and all three arrive shapeless:
 *   - the Tauri bridge (`backendCall` / `invoke` hand back whatever Rust
 *     serialised — the generic parameter is a claim, not a check),
 *   - ComfyUI over HTTP (`/prompt`, `/history`, `/object_info`, and the
 *     user-authored workflow JSON that gets dropped into the app),
 *   - MCP servers (a third-party process answering `tools/list`).
 *
 * The rule these helpers exist to enforce: check before you claim. `isRecord`
 * before a property read, `Array.isArray` before an iteration, `typeof` before
 * a value is handed on as a string or a number. Past the guard everything is
 * typed; nothing here casts.
 *
 * Deliberately dependency-free — no imports at all, so it stays a leaf module
 * and can never take part in an import cycle.
 *
 * (`src/api/providers/wire.ts` does the same job for the three chat-completion
 * HTTP APIs. It is kept separate on purpose: that file also carries the wire
 * *shapes* of Ollama/OpenAI/Anthropic, which have nothing to do with the
 * bridge, and importing it here would tie the MCP layer to the providers.)
 */

/** True for a plain object we may index. Arrays and null are rejected. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Read a property without asserting anything about the container. */
export function prop(v: unknown, key: string): unknown {
  return isRecord(v) ? v[key] : undefined
}

/** Follow a property path, giving up (undefined) at the first non-record. */
export function propPath(v: unknown, ...keys: string[]): unknown {
  let cur: unknown = v
  for (const k of keys) {
    if (!isRecord(cur)) return undefined
    cur = cur[k]
  }
  return cur
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

/** Array of records, or [] — the shape every "list" endpoint claims to send. */
export function asRecordArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : []
}

/** Array of strings, or [] — non-strings are dropped, not stringified. */
export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * A string OR a number that a JSON producer wrote as one when the other was
 * meant — ComfyUI node ids are the standing example (`"3"` in a saved graph,
 * `3` in a fresh one). Numbers are normalised to their decimal text.
 */
export function asIdString(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

/**
 * Best-effort human text for a value of unknown shape — used where a foreign
 * error field could be a string, an `{ message }`, or an arbitrary object.
 * Returns '' for null/undefined so callers can test truthiness.
 */
export function errorText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.message
  const msg = prop(v, 'message')
  if (typeof msg === 'string') return msg
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}
