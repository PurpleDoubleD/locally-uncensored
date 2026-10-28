/**
 * GH #198: sampling parameters LU has no field for, as a free list of rows
 * (key, type, value), on a persona and on a chat.
 *
 * Every new sampler of KoboldCpp or llama.cpp (dry_base, xtc_threshold,
 * banned strings, logit_bias ...) would otherwise need its own field in LU.
 * A row goes to the backend as typed:
 *
 *  - OpenAI compatible servers: a top level field of the request body.
 *  - Ollama: a key of `options`.
 *  - Anthropic and the hosted endpoint (LU Cloud): nothing, both refuse
 *    fields they do not know.
 *
 * Order, highest first, by key: the chat's row, the speaker's persona row.
 * Nothing else: without a row the backend keeps its own default. In a group
 * chat each member brings its own persona's rows; the chat's rows hold for
 * every member, as the chat's sliders do (lib/chat-persona.ts).
 *
 * A key LU already sends from one of its own fields (temperature, top_p,
 * max_tokens, the persona's samplers ...) or that carries the request itself
 * (model, messages, stream ...) is never taken from a row: the field stays
 * the one place for it, and nothing goes out twice. The editor says so on the
 * row.
 */

export type CustomParamType = 'string' | 'number' | 'boolean' | 'json'

export const CUSTOM_PARAM_TYPES: readonly CustomParamType[] = ['string', 'number', 'boolean', 'json']

export interface CustomParam {
  key: string
  type: CustomParamType
  /** As typed. Parsed by type when the request is built. */
  value: string
}

/** Most rows one persona or one chat keeps. */
export const MAX_CUSTOM_PARAMS = 32
/** Longest value kept, enough for a long banned-strings list. */
export const MAX_CUSTOM_VALUE = 20_000

/** Top level fields of an OpenAI compatible body that LU writes itself. */
export const OPENAI_FIXED_FIELDS: ReadonlySet<string> = new Set([
  'model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice',
  'temperature', 'top_p', 'top_k', 'max_tokens', 'max_completion_tokens',
  'min_p', 'repeat_penalty', 'repetition_penalty', 'presence_penalty', 'frequency_penalty', 'dry_multiplier',
  'reasoning_effort', 'chat_template_kwargs', 'thinking_budget_tokens', 'continue_final_message',
  'response_format', 'n',
])

/** Keys of Ollama's `options` that LU writes itself. `num_ctx` is the window,
 *  which LU picks so the model is not loaded again by every request. */
export const OLLAMA_FIXED_OPTIONS: ReadonlySet<string> = new Set([
  'temperature', 'top_p', 'top_k', 'num_predict', 'num_ctx',
  'min_p', 'repeat_penalty', 'presence_penalty', 'frequency_penalty',
])

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/

export type ParsedParam = { ok: true; value: unknown } | { ok: false; error: string }

/** A row's value as the backend gets it, or why it cannot go. */
export function parseCustomParam(row: Pick<CustomParam, 'type' | 'value'>): ParsedParam {
  const text = row.value.trim()
  switch (row.type) {
    case 'string':
      return { ok: true, value: row.value }
    case 'number': {
      if (text === '') return { ok: false, error: 'Enter a number.' }
      const n = Number(text)
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: 'Not a number.' }
    }
    case 'boolean':
      if (text === 'true') return { ok: true, value: true }
      if (text === 'false') return { ok: true, value: false }
      return { ok: false, error: 'true or false.' }
    case 'json':
      if (text === '') return { ok: false, error: 'Enter JSON, e.g. ["\\n", ":"] or {"128": -100}.' }
      try {
        return { ok: true, value: JSON.parse(text) }
      } catch {
        return { ok: false, error: 'Not valid JSON.' }
      }
  }
}

/** Why this row is not sent, for the editor. Undefined when it is sent
 *  (where the backend takes custom rows at all). */
export function customParamProblem(row: CustomParam): string | undefined {
  const key = row.key.trim()
  if (!key) return 'Give it a name.'
  if (!KEY_PATTERN.test(key)) return 'Letters, digits, _ . - only.'
  if (OPENAI_FIXED_FIELDS.has(key) || OLLAMA_FIXED_OPTIONS.has(key)) return 'LU sets this one with its own field.'
  const parsed = parseCustomParam(row)
  return parsed.ok ? undefined : parsed.error
}

/** Rows as kept: well formed, at most MAX_CUSTOM_PARAMS, values capped. A
 *  half-typed row (no key yet) is kept, the editor shows it; only sending
 *  skips it. */
export function cleanCustomParams(rows: unknown): CustomParam[] {
  if (!Array.isArray(rows)) return []
  const out: CustomParam[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const { key, type, value } = r as Record<string, unknown>
    if (typeof key !== 'string' || typeof value !== 'string') continue
    if (!CUSTOM_PARAM_TYPES.includes(type as CustomParamType)) continue
    out.push({ key: key.slice(0, 64), type: type as CustomParamType, value: value.slice(0, MAX_CUSTOM_VALUE) })
    if (out.length >= MAX_CUSTOM_PARAMS) break
  }
  return out
}

/** The rows in force for one speaker: the chat's over the persona's, by key. */
export function mergeCustomParams(chat?: readonly CustomParam[], persona?: readonly CustomParam[]): CustomParam[] {
  const byKey = new Map<string, CustomParam>()
  for (const row of persona ?? []) byKey.set(row.key.trim(), row)
  for (const row of chat ?? []) byKey.set(row.key.trim(), row)
  return [...byKey.values()]
}

/** The rows that can go out, parsed: key → value. */
export function resolveCustomParams(rows: readonly CustomParam[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const row of rows) {
    if (customParamProblem(row)) continue
    const parsed = parseCustomParam(row)
    if (parsed.ok) out[row.key.trim()] = parsed.value
  }
  return out
}

/** The values as top level fields of an OpenAI compatible body. */
export function openAiCustomFields(values: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values ?? {})) {
    if (!OPENAI_FIXED_FIELDS.has(key)) out[key] = value
  }
  return out
}

/** The values as keys of Ollama's `options`. */
export function ollamaCustomOptions(values: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values ?? {})) {
    if (!OLLAMA_FIXED_OPTIONS.has(key)) out[key] = value
  }
  return out
}

/** A row's value in one short line, for the popup's speaker lines. */
export function customParamText(row: CustomParam): string {
  const v = row.value.trim()
  return v.length > 24 ? `${v.slice(0, 23)}…` : v
}
