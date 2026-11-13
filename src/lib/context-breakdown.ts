/**
 * What fills the context window, split by kind (U5, like Claude Code's
 * /context).
 *
 * The meter on the context button says how full the window is. It does not
 * say WHY. A coding run on a 16K model is often half full before the first
 * message: the tool catalogue and the system prompt alone. Without the split
 * the user cannot tell "my chat is long" apart from "the agent setup is big",
 * and those want different fixes (compact the chat, or a bigger window).
 *
 * Everything here is pure. The agent loops publish the split of the request
 * they actually built (stores/contextBreakdownStore.ts); without a run the
 * dropdown asks `estimateNextStep` for what the next step would roughly send.
 *
 * The sections are found by the fences their own renderers write:
 *   - project files: lib/project-instructions.ts (AGENTS.md, CLAUDE.md) and
 *     lib/lurules.ts (.lurules)
 *   - memory: lib/turn-context.ts MEMORY_PREAMBLE plus the
 *     <remembered_context> block from stores/memoryStore.ts
 * Reading the fences instead of asking the loops for each piece keeps the
 * hook side to one call per step.
 */
import { estimateTokens } from './token-estimate'
import { MEMORY_PREAMBLE } from './turn-context'
import { computeContextFill, type FillMessage } from './token-usage'

export type BreakdownKey = 'system' | 'tools' | 'projectFiles' | 'memory' | 'conversation' | 'toolResults'

/** In the order the dropdown lists them. */
export const BREAKDOWN_ORDER: readonly BreakdownKey[] = [
  'system', 'tools', 'projectFiles', 'memory', 'conversation', 'toolResults',
]

export const BREAKDOWN_LABEL: Record<BreakdownKey, string> = {
  system: 'System prompt',
  tools: 'Tools',
  projectFiles: 'Project files',
  memory: 'Memory',
  conversation: 'Conversation',
  toolResults: 'Tool results',
}

export interface BreakdownRow {
  key: BreakdownKey
  label: string
  tokens: number
  /** Not known before the first step (an estimate cannot see it). */
  unknown?: boolean
}

export interface ContextBreakdown {
  rows: BreakdownRow[]
  /** Sum of the rows. */
  total: number
  /**
   * `step`: the request the last agent step built and sent.
   * `estimate`: what the next step would roughly send, before any run.
   * The dropdown says "about" for the second.
   */
  kind: 'step' | 'estimate'
  /** Messages in the conversation when it was measured (step only). */
  atMessageCount?: number
}

/** The smallest message shape both the wire format and the store share. */
export interface BreakdownMessage {
  role: string
  content: string
  tool_calls?: ReadonlyArray<{ function?: { name?: string; arguments?: unknown } }>
  hidden?: boolean
}

// ── Sections inside one text ───────────────────────────────────────────

const PROJECT_FILE_FENCE = /\n?─── Project instructions from ([^\n]+?) ───[\s\S]*?─── end \1 ───\n?/g
const LURULES_FENCE = /\n?─── Project rules from \.lurules[\s\S]*?─── end \.lurules ─*\n?/g
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const MEMORY_FENCE = new RegExp(
  `(?:\\n\\n)?${escapeRe(MEMORY_PREAMBLE)}\\s*(?:<remembered_context>[\\s\\S]*?</remembered_context>|[^\\n]*(?:\\n(?!\\n)[^\\n]*)*)`,
  'g',
)

export interface SplitText {
  projectFiles: string
  memory: string
  rest: string
}

/** Cut the project file and memory sections out of one text. */
export function splitSections(text: string): SplitText {
  let projectFiles = ''
  let memory = ''
  let rest = text
  rest = rest.replace(PROJECT_FILE_FENCE, (m) => { projectFiles += m; return '' })
  rest = rest.replace(LURULES_FENCE, (m) => { projectFiles += m; return '' })
  rest = rest.replace(MEMORY_FENCE, (m) => { memory += m; return '' })
  return { projectFiles, memory, rest }
}

const tok = (s: string) => (s ? estimateTokens(s) : 0)

/**
 * Counted the way the request builder counts (estimateMessageTokens in
 * lib/context-compaction.ts): the content, the tool calls as JSON, and a few
 * tokens for the role tag. Same arithmetic, so the split adds up to the
 * number on the meter instead of a second, slightly different one.
 */
const ROLE_OVERHEAD = 4
function toolCallTokens(m: BreakdownMessage): number {
  return m.tool_calls?.length ? estimateTokens(JSON.stringify(m.tool_calls)) : 0
}

/** A Hermes-style result rides as a user message on the prompt transport. */
function isToolResult(m: BreakdownMessage): boolean {
  return m.role === 'tool' || (m.role === 'user' && m.content.trimStart().startsWith('<tool_response>'))
}

export interface BreakdownOptions {
  kind?: ContextBreakdown['kind']
  atMessageCount?: number
  /** Rows an estimate cannot know; shown as "after the first step". */
  unknown?: readonly BreakdownKey[]
}

/**
 * The split of one request.
 *
 * @param messages the messages as they go on the wire (or the stored ones,
 *                 for an estimate)
 * @param tools    the tool catalogue sent beside them, or its token count
 *                 when the caller already estimated it
 */
export function breakdownOf(
  messages: readonly BreakdownMessage[],
  tools: readonly unknown[] | number,
  opts: BreakdownOptions = {},
): ContextBreakdown {
  const sums: Record<BreakdownKey, number> = {
    system: 0, tools: 0, projectFiles: 0, memory: 0, conversation: 0, toolResults: 0,
  }
  sums.tools = typeof tools === 'number'
    ? Math.max(0, Math.round(tools))
    : tools.length ? estimateTokens(JSON.stringify(tools)) : 0

  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : ''
    const whole = estimateTokens(content) + toolCallTokens(m) + ROLE_OVERHEAD
    if (isToolResult(m)) {
      sums.toolResults += whole
      continue
    }
    // The fenced parts are estimated on their own; what remains of the
    // message's own estimate is the rest, so the parts never add up to more
    // than the message.
    const parts = splitSections(content)
    const project = Math.min(whole, tok(parts.projectFiles))
    const memory = Math.min(whole - project, tok(parts.memory))
    sums.projectFiles += project
    sums.memory += memory
    if (m.role === 'system') sums.system += whole - project - memory
    else sums.conversation += whole - project - memory
  }

  const unknown = new Set(opts.unknown ?? [])
  const rows = BREAKDOWN_ORDER.map((key): BreakdownRow => (
    unknown.has(key) && sums[key] === 0
      ? { key, label: BREAKDOWN_LABEL[key], tokens: 0, unknown: true }
      : { key, label: BREAKDOWN_LABEL[key], tokens: sums[key] }
  ))
  return {
    rows,
    total: rows.reduce((a, r) => a + r.tokens, 0),
    kind: opts.kind ?? 'step',
    ...(opts.atMessageCount !== undefined ? { atMessageCount: opts.atMessageCount } : {}),
  }
}

/**
 * What the next step would roughly send, from the conversation as stored.
 *
 * On an agent surface (Code tab, Agent mode) the system prompt, the tool
 * catalogue, the project files and the memory are assembled at run time, so
 * before the first step they are marked unknown rather than made up. A plain
 * chat sends its stored system prompt and never project files.
 */
export function estimateNextStep(
  messages: readonly BreakdownMessage[],
  o: { systemPrompt?: string; agent: boolean },
): ContextBreakdown {
  const wire: BreakdownMessage[] = []
  if (!o.agent && o.systemPrompt?.trim()) wire.push({ role: 'system', content: o.systemPrompt })
  for (const m of messages) {
    if (m.role === 'system') continue
    if (!m.content?.trim() && !m.tool_calls?.length) continue
    wire.push(m)
  }
  const unknown: BreakdownKey[] = o.agent
    ? ['system', 'tools', 'projectFiles', 'memory']
    : ['tools', 'memory']
  return breakdownOf(wire, 0, { kind: 'estimate', unknown })
}

/**
 * The last step plus what the conversation gained since, so the split adds
 * up to the meter on the button. The meter counts the messages behind the
 * step's anchor on top of it (computeContextFill, built branch); asking that
 * same function keeps one rule for what counts. They join the conversation
 * row. `since` says how much was added.
 */
export function withNewerMessages(
  b: ContextBreakdown,
  messages: readonly FillMessage[],
): ContextBreakdown & { since: number } {
  const at = b.atMessageCount
  if (b.kind !== 'step' || at === undefined || at > messages.length) return { ...b, since: 0 }
  const since = computeContextFill(messages as FillMessage[], { tokens: 1, atMessageCount: at }).used - 1
  if (since <= 0) return { ...b, since: 0 }
  return {
    ...b,
    rows: b.rows.map((r) => (r.key === 'conversation' ? { ...r, tokens: r.tokens + since } : r)),
    total: b.total + since,
    since,
  }
}

// ── Layout for the dropdown ────────────────────────────────────────────

export interface BreakdownLayout {
  window: number
  used: number
  free: number
  /** Share of the window, 0..1, per row key. */
  share: Record<BreakdownKey, number>
  usedShare: number
  /** Where auto-compaction fires, 0..1 of the window, or null when off. */
  thresholdShare: number | null
  thresholdTokens: number | null
}

/** Shares of the window and the free space; the window is the meter's. */
export function layoutBreakdown(
  b: ContextBreakdown,
  window: number,
  threshold: number | null,
): BreakdownLayout {
  const w = Math.max(0, window)
  const share = {} as Record<BreakdownKey, number>
  for (const r of b.rows) share[r.key] = w > 0 ? Math.min(1, r.tokens / w) : 0
  const used = Math.min(b.total, w > 0 ? w : b.total)
  const ok = threshold !== null && threshold > 0 && threshold < 1 && w > 0
  return {
    window: w,
    used,
    free: Math.max(0, w - b.total),
    share,
    usedShare: w > 0 ? Math.min(1, b.total / w) : 0,
    thresholdShare: ok ? threshold : null,
    thresholdTokens: ok ? Math.round(threshold * w) : null,
  }
}

// ── Small window warning ───────────────────────────────────────────────

/** Below this an agent run keeps too little of what it read. */
export const SMALL_WINDOW_TOKENS = 16384
/** What the one-click fix sets. */
export const SMALL_WINDOW_FIX_TOKENS = 32768

export interface SmallWindowInput {
  /** useActiveContextWindow().provider */
  provider: 'ollama' | 'lmstudio' | 'builtin' | 'cloud' | 'custom' | 'unknown'
  /** The window the agent runs with (0 = not known yet). */
  window: number
  /** The model's ceiling, 0 = unknown. */
  modelMax: number
  /** The surface: only agent work is warned about. */
  use: 'chat' | 'agent'
}

export interface SmallWindowNote {
  window: number
  /** The window the action sets, or null when LU cannot set one. */
  fix: number | null
  text: string
  /** Second line when there is no action. */
  hint?: string
}

/**
 * The calm note for a local model whose agent window is small.
 *
 * Cloud models are never warned: their window is the model's and fixed, and
 * the send window there is a cost choice, not a memory problem LU can solve.
 * A server LU does not start (custom) gets the note without an action,
 * because LU cannot change that server's window. A model whose own maximum
 * is below 32K gets the note without the action too.
 */
export function smallWindowNote(i: SmallWindowInput): SmallWindowNote | null {
  if (i.use !== 'agent') return null
  if (i.provider === 'cloud' || i.provider === 'unknown') return null
  if (!(i.window > 0) || i.window >= SMALL_WINDOW_TOKENS) return null
  const text = 'Small window: agent runs may forget files.'
  if (i.provider === 'custom') {
    return { window: i.window, fix: null, text, hint: 'Start the server with 32K to fix it.' }
  }
  if (i.modelMax > 0 && i.modelMax < SMALL_WINDOW_FIX_TOKENS) {
    return { window: i.window, fix: null, text, hint: 'This model cannot go to 32K. A larger model helps.' }
  }
  return { window: i.window, fix: SMALL_WINDOW_FIX_TOKENS, text }
}
