/**
 * C69 (3.1.0): DeepSeek R1 and its distills get no system message.
 *
 * Discord, deepseek-r1:14b on Ollama: a plain "hi" got pages of thinking
 * ABOUT LU's system prompt ("so I want to figure out how to solve this
 * problem where a model is supposed to be running solely for the user…")
 * and no answer. R1 was trained without system prompts, and DeepSeek's own
 * model card says to leave the system prompt out and put every instruction
 * into the user prompt. The distills (R1-Distill-Qwen, R1-Distill-Llama, the
 * Ollama `deepseek-r1:*` tags) inherit that.
 *
 * So, for these models only, on the wire only:
 *   * LU's own lines (the chat base role and the house rules from
 *     lib/system-prompt.ts) are left out. They are what the model chewed on,
 *     and they are not the user's words.
 *   * Whatever else the system message carried (a persona, an agent role, a
 *     tool catalog, memory, a character card) is folded into the FIRST user
 *     message, fenced off so the model reads it as setup and not as the
 *     question. The first and not the latest user turn: that is where
 *     DeepSeek puts it, and it keeps the prefix of a long chat stable.
 *   * The store keeps the transcript as written; nothing on screen changes.
 *
 * Every other model gets the very same array back (by reference), so their
 * requests stay byte for byte what they were.
 */

import { CHAT_BASE_ROLE, CHAT_BASE_SYSTEM_PROMPT, HOUSE_CONDUCT, HOUSE_RULES, HOUSE_SCOPE } from './system-prompt'

/**
 * R1 itself and the models built from it, under the names Ollama, Hugging
 * Face, a GGUF file in the LU Engine and the cloud catalogues give them:
 *
 *   deepseek-r1:14b · huihui_ai/deepseek-r1-abliterated:8b
 *   hf.co/bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF:Q4_K_M
 *   DeepSeek-R1-Distill-Llama-8B-Q4_K_M(.gguf) · deepseek/deepseek-r1-0528
 *   deepseek-r1-distill-llama-70b · R1-Distill-Qwen-7B · r1-1776
 *
 * Not DeepSeek V3, Coder, V2.5 or the `deepseek-chat` API, and not a name
 * that only happens to hold the letters "r1" (command-r, r10, …).
 */
export function isR1StyleModel(model: string | null | undefined): boolean {
  if (!model) return false
  const n = model.toLowerCase().replace(/[\s_.]+/g, '-')
  return /deepseek-?r1(?![0-9a-z])/.test(n)
    || /(^|[^a-z0-9])r1-distill(?![a-z])/.test(n)
    || /(^|[^a-z0-9])r1-1776(?![0-9])/.test(n)
}

/** LU's own lines, longest first so a whole block goes before its parts. */
const LU_LINES = [CHAT_BASE_SYSTEM_PROMPT, HOUSE_RULES, HOUSE_CONDUCT, HOUSE_SCOPE, CHAT_BASE_ROLE]

/** The system text without LU's own lines. Empty when that was all of it. */
export function withoutLuLines(system: string): string {
  let out = system
  for (const line of LU_LINES) out = out.split(line).join('')
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

const OPEN = '<instructions>'
const CLOSE = '</instructions>'

interface Roled {
  role: string
  content?: unknown
}

/**
 * Move the leading system message of `messages` into the first user turn,
 * for an R1 style `model`. Expects the contract's shape: at most one system
 * message, at index 0 (normalize-system.ts runs first).
 */
export function foldSystemForR1<T extends Roled>(model: string | null | undefined, messages: T[]): T[] {
  if (!isR1StyleModel(model) || messages[0]?.role !== 'system') return messages
  const system = typeof messages[0].content === 'string' ? messages[0].content : ''
  const rest = messages.slice(1)
  const kept = withoutLuLines(system)
  if (!kept) return rest

  const block = `${OPEN}\n${kept}\n${CLOSE}`
  const first = rest.findIndex((m) => m?.role === 'user')
  if (first < 0) return [{ role: 'user', content: block } as unknown as T, ...rest]
  const target = rest[first]
  const text = typeof target.content === 'string' ? target.content : null
  if (text === null) {
    // Not plain text (never the case on today's wire): the setup goes in a
    // turn of its own in front, which merging cannot reach.
    return [...rest.slice(0, first), { role: 'user', content: block } as unknown as T, ...rest.slice(first)]
  }
  const out = rest.slice()
  out[first] = { ...target, content: text ? `${block}\n\n${text}` : block }
  return out
}
