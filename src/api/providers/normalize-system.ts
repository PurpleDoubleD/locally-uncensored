/**
 * One system message, and it sits first. Enforced on the last piece of code
 * every request passes through, right before the body is serialized.
 *
 * Why this exists (bug B3, 2.6.7). Discord #bug-reports 2026-08-21:
 * helpslowlydying diagnosed it as "the system instructions or tools are being
 * injected in the wrong order, causing the Jinja template engine to crash with
 * System message must be at the beginning", and platorius, who was hitting it,
 * added "the problem is only in LU" with the same model and the same prompts
 * working in other frontends.
 *
 * That is exactly what a strict Jinja chat template does. llama.cpp
 * (llama-server, the built-in engine) and LM Studio render the model's own
 * template, and the Qwen, Mistral and ChatML style templates shipped with many
 * GGUFs contain a literal
 *
 *   {{ raise_exception('System message must be at the beginning') }}
 *
 * guard that fires on ANY message with role "system" at an index other than 0,
 * and several of them fire on a SECOND system message even when both sit at the
 * front. The request never reaches the model, so nothing partial streams: the
 * turn just dies.
 *
 * 2.6.6 fixed one producer (the compaction trim notice, see
 * lib/__tests__/compaction-system-position.test.ts). This is the other half of
 * the job: instead of auditing every one of the dozen places that assemble a
 * message array, the invariant is checked once on the way out. A payload that
 * already satisfies it is returned BY REFERENCE, untouched, so the upstream
 * prefix cache still matches byte for byte and the normal path pays nothing.
 *
 * Merging rather than dropping is deliberate. Every system message in the array
 * is an instruction someone meant the model to follow (a persona, a tool
 * catalog, a memory block, an injected context header). Dropping the late ones
 * would silently disarm a feature; merging them into the leading system message
 * in their original order keeps every instruction and keeps the order the
 * builders intended.
 */

import { buildHermesToolResult, buildHermesToolCall } from '../hermes-tool-calling'

/** The shape this works on. Deliberately looser than ChatMessage so the same
 *  function serves the wire types of all providers. */
export interface RoledMessage {
  role: string
  content?: unknown
}

/**
 * Pull every system part to the front and merge it into one system message.
 *
 * Returns the SAME array reference when the payload is already correct, which
 * is the overwhelmingly common case: zero system messages, or exactly one at
 * index 0. Only a payload that would have crashed a strict template is rebuilt.
 *
 * Notes on the merge:
 *   - Content order follows the array order, so the leading system prompt stays
 *     the leading text and a later injection is appended behind it.
 *   - Empty and whitespace-only system parts are dropped. If that leaves
 *     nothing, the system message disappears entirely instead of going out as
 *     an empty one, which some templates also refuse.
 *   - Fields other than `content` are taken from the FIRST system message
 *     (that is the one carrying the real prompt), so nothing a provider adds
 *     to its own wire shape is lost.
 *   - Non-system messages keep their order and their identity untouched.
 */
export function normalizeSystemMessages<T extends RoledMessage>(messages: T[]): T[] {
  let firstSystem = -1
  let systemCount = 0
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'system') {
      if (firstSystem < 0) firstSystem = i
      systemCount++
    }
  }

  // Already legal. Hand back the very same array: a new array here would be a
  // new JSON body on every single request, and on the cloud side a moved
  // prefix is a cold cache and a full re-bill.
  if (systemCount === 0) return messages
  if (systemCount === 1 && firstSystem === 0) return messages

  const parts: string[] = []
  const rest: T[] = []
  for (const m of messages) {
    if (m?.role === 'system') {
      const text = typeof m.content === 'string' ? m.content.trim() : ''
      if (text) parts.push(text)
    } else {
      rest.push(m)
    }
  }

  if (parts.length === 0) return rest
  return [{ ...messages[firstSystem], content: parts.join('\n\n') } as T, ...rest]
}

// ══ The template contract (bug B3, round 2) ════════════════════
//
// The counter-check ran the round-1 fix against a real strict template
// (Gemma 3, whose Jinja raises on every rule it can check) on the installed
// 2.6.7 build, and the crash was still reachable three ways. One system
// message at the front was necessary and nowhere near sufficient:
//
//   1. Agent turn with tools. After the first tool result the wire carried
//      [system, user, assistant, tool] and NO `tools` field, because the run
//      was on the prompt transport. The template has no branch for a `tool`
//      role, so it raised and the next round died.
//   2. Plain chat. The chat tools (web_search and friends) are on by default,
//      so an ordinary question produced the very same four roles and the very
//      same death, with no agent mode anywhere in sight.
//   3. Group chat. From round two on, the history holds two assistant
//      messages in a row (one per speaker), and the template demands strict
//      user/assistant alternation. Both speakers died.
//
// The same payloads run on Hermes 3, whose ChatML template loops over the
// messages and renders whatever it is handed. So the request shape is not
// wrong in the abstract: it is wrong for the template that has to render it.
//
// Hence a CONTRACT rather than one more rule. Where the model's own template
// does the rendering, the wire gets a sequence every template can render:
// no `tool` role, no two turns of the same role in a row, and a user turn
// first. Where the SERVER implements the protocol (a cloud endpoint) or has
// declared its template understands tools (the run then carries a native
// `tools` payload), nothing is rewritten and the tool calls stay native.
//
// Why the tolerant sequence rather than a per-template capability probe: the
// engine does publish its template on /props, but reading a Jinja source and
// deciding what it will accept is guesswork, the answer is cached and can be
// a model swap out of date, and being wrong means a dead turn. The tolerant
// sequence also renders correctly on a tolerant template, so the cost of
// choosing it when it was not needed is a slightly wordier prompt, and the
// cost of the other mistake is a chat that cannot be used at all.

/** Messages as the contract sees them. Deliberately looser than ChatMessage. */
export interface ContractMessage extends RoledMessage {
  tool_calls?: { id?: string; function: { name: string; arguments: unknown } }[]
  tool_call_id?: string
  images?: { data: string; mimeType: string }[]
}

export interface TemplateContract {
  /**
   * 'native' leaves `tool` messages and `assistant.tool_calls` alone; the
   * server or the template handles them.
   * 'text' carries both as prompt text instead, in the Hermes dialect LU has
   * used for tool-less models since 2.5.3.
   */
  toolRole: 'native' | 'text'
  /** Enforce strict user/assistant alternation behind the system message. */
  alternate: boolean
}

/** The minimal turn used when two same-role turns cannot be merged. */
const BRIDGE_USER = 'Continue.'
const BRIDGE_ASSISTANT = 'Understood.'

function textOf(content: unknown): string | null {
  return typeof content === 'string' ? content : null
}

/**
 * Rewrite the tool channel as prompt text.
 *
 * A `tool` message becomes a user turn holding <tool_response>, and the
 * assistant turn that asked for it keeps its call as <tool_call> text. Doing
 * only the first half is what produced the orphaned results the counter-check
 * found on the wire: the model saw an answer to a question it never asked.
 */
function toolRoleAsText<T extends ContractMessage>(messages: T[]): T[] {
  const nameById = new Map<string, string>()
  for (const m of messages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
    for (const tc of m.tool_calls) {
      if (tc?.id && tc.function?.name) nameById.set(String(tc.id), String(tc.function.name))
    }
  }

  // Names of the calls the last assistant turn made, for a result that carries
  // no id (the Ollama shape, and every call the prompt transport parsed).
  let pending: string[] = []
  const out: T[] = []
  let changed = false

  for (const m of messages) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      pending = m.tool_calls.map((tc) => String(tc?.function?.name ?? ''))
      const calls = m.tool_calls
        .map((tc) => buildHermesToolCall(tc?.function?.name ?? '', tc?.function?.arguments))
        .join('\n')
      const body = textOf(m.content) ?? ''
      const next = { ...m, content: body ? `${body}\n${calls}` : calls } as T
      delete (next as ContractMessage).tool_calls
      out.push(next)
      changed = true
      continue
    }
    if (m?.role === 'tool') {
      const byId = m.tool_call_id ? nameById.get(String(m.tool_call_id)) : undefined
      const name = byId || pending.shift() || 'tool'
      const next = {
        ...m,
        role: 'user',
        content: buildHermesToolResult(name, textOf(m.content) ?? ''),
      } as unknown as T
      delete (next as ContractMessage).tool_call_id
      delete (next as ContractMessage).tool_calls
      out.push(next)
      changed = true
      continue
    }
    if (m?.role === 'assistant') pending = []
    out.push(m)
  }

  return changed ? out : messages
}

/**
 * Strict user/assistant alternation behind the optional system message.
 *
 * Merging is preferred over dropping and over padding: two consecutive user
 * turns are two things the user (or the tool transport) said, and the model
 * has to see both. A bridging turn is only used where a merge is impossible,
 * which is a non-string content (an image payload) and a history that opens
 * on an assistant turn.
 */
function alternateRoles<T extends ContractMessage>(messages: T[]): T[] {
  const lead = messages[0]?.role === 'system' ? 1 : 0
  const head = messages.slice(0, lead)
  const body = messages.slice(lead)
  if (body.length === 0) return messages

  const out: T[] = []
  let changed = false

  // A template that alternates from user expects the first turn to be one.
  if (body[0]?.role === 'assistant') {
    out.push({ role: 'user', content: BRIDGE_USER } as unknown as T)
    changed = true
  }

  for (const m of body) {
    const prev = out[out.length - 1]
    if (!prev || prev.role !== m.role) {
      out.push(m)
      continue
    }
    const a = textOf(prev.content)
    const b = textOf(m.content)
    if (a !== null && b !== null) {
      const merged = { ...prev, content: a && b ? `${a}\n\n${b}` : a || b } as T
      const images = [
        ...(Array.isArray(prev.images) ? prev.images : []),
        ...(Array.isArray(m.images) ? m.images : []),
      ]
      if (images.length) (merged as ContractMessage).images = images
      out[out.length - 1] = merged
    } else {
      out.push({
        role: m.role === 'user' ? 'assistant' : 'user',
        content: m.role === 'user' ? BRIDGE_ASSISTANT : BRIDGE_USER,
      } as unknown as T)
      out.push(m)
    }
    changed = true
  }

  return changed ? [...head, ...out] : messages
}

/**
 * The whole contract, in the order the rules depend on each other: system
 * first (round 1), then the tool channel, then alternation, because turning
 * a tool result into a user turn is what creates most of the consecutive
 * user turns alternation then has to merge.
 *
 * Returns the SAME array reference when nothing had to change, which is the
 * common case and keeps the upstream prefix cache warm. See
 * normalizeSystemMessages for why that matters.
 */
export function applyTemplateContract<T extends ContractMessage>(
  messages: T[],
  contract: TemplateContract,
): T[] {
  let out = normalizeSystemMessages(messages)
  if (contract.toolRole === 'text') out = toolRoleAsText(out)
  if (contract.alternate) out = alternateRoles(out)
  return out
}
