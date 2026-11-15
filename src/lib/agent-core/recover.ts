/**
 * One recovery chain for the calls of a model turn (CA K2).
 *
 * The Agent tab, the Code tab and the sub-agent each grew their own copy of
 * "where else could the calls be": the Agent tab lifted prose calls
 * (`file_read(path="a.ts")`) but not fenced JSON, the Code tab lifted fenced
 * JSON but not prose calls, and the sub-agent lifted nothing. A small local
 * model that writes its call the "other" way worked in one tab and stopped on
 * prose in the next. Every loop now runs this one function after its
 * transport produced (calls, content, thinking).
 *
 * The order is the safety property, and each step only runs while the turn
 * still has no call:
 *   1. native calls, names repaired (`video_generation` → `video_generate`,
 *      a generic `function` resolved from its arguments; GH #147)
 *   2. fenced / bare JSON in the answer (qwen2.5-coder), known tools only
 *   3. prose calls `name(k="v")`, Hermes tags, `functions.x` (gemma, qwen 14B)
 *   4. calls stuck in the reasoning channel while the answer is empty
 *      (llama.cpp #20809; C59 A3), structured forms only
 * Then the visible answer is cleaned of call text that is still in it. Every
 * lifted call must name a tool of this run: example JSON in an explanation is
 * never executed.
 */
import type { ToolCall } from '../../api/providers/types'
import { recoverKnownToolCallsFromContent } from '../../hooks/codex/tool-call-recovery'
import {
  parseLooseToolCalls,
  repairToolCall,
  stripMatchedCalls,
  stripToolCallText,
  toolCallsFromReasoning,
} from '../loose-tool-parse'

interface ToolShape {
  name: string
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] }
}

export type RecoverySource = 'native' | 'content' | 'reasoning' | 'none'

export interface RecoverInput {
  toolCalls: ToolCall[]
  content: string
  thinking?: string
  /** The tools this run may call (names and schemas, for the name repair). */
  tools: readonly ToolShape[]
  /** Extra names a lifted call may carry that are not in `tools`
   *  (e.g. `tool_search` in a compact run). */
  extraNames?: readonly string[]
}

export interface RecoverOutput {
  toolCalls: ToolCall[]
  content: string
  source: RecoverySource
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function recoverTurnCalls(input: RecoverInput): RecoverOutput {
  const tools = input.tools as ToolShape[]
  const known = [...tools.map((t) => t.name), ...(input.extraNames ?? [])]
  const isKnown = (name: string, args: Record<string, unknown>) =>
    known.includes(repairToolCall(name, args, tools).name) || known.includes(name)

  let toolCalls = input.toolCalls
  let content = input.content ?? ''
  let source: RecoverySource = toolCalls.length > 0 ? 'native' : 'none'

  // 1. Repair the names of native calls.
  if (toolCalls.length > 0) {
    toolCalls = toolCalls.map((tc) => {
      const raw = tc.function?.name ?? ''
      const args = isRecord(tc.function?.arguments) ? tc.function.arguments : {}
      const fixed = repairToolCall(raw, args, tools)
      return fixed.name === raw ? tc : { ...tc, function: { ...tc.function, name: fixed.name, arguments: fixed.arguments } }
    })
  }

  // 2. JSON in the answer (also strips a JSON echo next to native calls).
  if (content) {
    const recovered = recoverKnownToolCallsFromContent(toolCalls, content, isKnown)
    if (toolCalls.length === 0 && recovered.toolCalls.length > 0) source = 'content'
    toolCalls = recovered.toolCalls.map((tc) => {
      const args = isRecord(tc.function.arguments) ? tc.function.arguments : {}
      const fixed = repairToolCall(tc.function.name, args, tools)
      return fixed.name === tc.function.name ? tc : { ...tc, function: { ...tc.function, name: fixed.name, arguments: fixed.arguments } }
    })
    content = recovered.content
  }

  // 3. Prose calls.
  if (toolCalls.length === 0 && content.trim()) {
    const loose = parseLooseToolCalls(content, known)
    if (loose.calls.length > 0) {
      toolCalls = loose.calls.map((c) => ({ function: { name: c.name, arguments: c.arguments } }))
      content = stripMatchedCalls(content, loose.matched)
      source = 'content'
    }
  }

  // 4. Calls in the reasoning channel.
  if (toolCalls.length === 0) {
    const lifted = toolCallsFromReasoning(input.thinking ?? '', content, 0, known)
    if (lifted.length > 0) {
      toolCalls = lifted.map((c) => ({ function: { name: c.name, arguments: c.arguments } }))
      source = 'reasoning'
    }
  }

  // Clean call text the model echoed into its prose.
  if (content) content = stripToolCallText(content, known)

  return { toolCalls, content, source }
}
