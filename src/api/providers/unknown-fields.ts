/**
 * A43 (Discord, 19.11.2026, glitter_fart): Gemini's OpenAI compatible
 * endpoint answered every model with a fixed 400. Measured against
 * generativelanguage.googleapis.com/v1beta/openai/chat/completions on
 * 19.11.2026: Google checks the body BEFORE the key and refuses any field it
 * does not know, "Invalid JSON payload received. Unknown name "top_k": Cannot
 * find field.". LU sends top_k on every request (F3), plus, depending on the
 * settings, frequency_penalty, seed, chat_template_kwargs,
 * thinking_budget_tokens, ttl or continue_final_message, all of which Google
 * refuses the same way. OpenAI itself says "Unrecognized request argument
 * supplied: x", a pydantic server (vLLM and others) "Extra inputs are not
 * permitted" with the field in `loc`.
 *
 * This reads the field names out of such an answer, so the request can go
 * again without exactly those fields. Fields every request needs are never
 * named as droppable.
 */

const NEVER_DROP = new Set(['model', 'messages', 'stream'])

export function unknownFieldsIn(errorText: string): string[] {
  const out = new Set<string>()
  const add = (name: string | undefined) => {
    const n = (name ?? '').trim()
    if (/^[a-z_][a-z0-9_]*$/i.test(n) && !NEVER_DROP.has(n)) out.add(n)
  }
  // Google: Unknown name "top_k": Cannot find field.   (also escaped \"top_k\")
  for (const m of errorText.matchAll(/Unknown name \\?"([A-Za-z0-9_]+)\\?"/g)) add(m[1])
  // OpenAI: Unrecognized request argument supplied: top_k
  for (const m of errorText.matchAll(/Unrecognized request arguments? supplied:\s*([A-Za-z0-9_, ]+)/g)) {
    for (const part of m[1].split(',')) add(part)
  }
  // pydantic (vLLM, FastAPI servers): {"loc":["body","top_k"],"msg":"Extra inputs are not permitted"}
  if (/extra inputs are not permitted|extra fields not permitted/i.test(errorText)) {
    for (const m of errorText.matchAll(/"loc"\s*:\s*\[\s*"body"\s*,\s*"([A-Za-z0-9_]+)"\s*\]/g)) add(m[1])
  }
  return [...out]
}
