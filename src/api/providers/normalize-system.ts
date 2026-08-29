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
