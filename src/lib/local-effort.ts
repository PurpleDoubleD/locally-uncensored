import { asRecordArray, asString, asStringArray, prop } from '../types/json-guards'
import { normalizeThinkBudget } from './think-budget'

/**
 * Reasoning effort for local backends (issue 176).
 *
 * The composer's effort control used to exist only for hosted models whose
 * catalogue declares rungs. A local server never declared any, so every local
 * request with Think on carried `reasoning_effort: 'high'` and nothing else,
 * whatever the user wanted. Each local server takes effort in its own way,
 * and each way below is read from that server's source or documentation
 * (checked 15.10.2026). A server we cannot place gets no rungs and the
 * control says so, in the same way the Think budget field does.
 *
 *  - LU Engine (llama-server b9949, commit 049326a0): the server itself has
 *    no `reasoning_effort` field (no match anywhere under tools/server).
 *    b11960 (the pin since 3.0.9, E1) reads a top-level one and writes it
 *    over the template variable; LU keeps it off the engine's wire
 *    (openai-provider.ts keepEffortOffEngineTopLevel), so what follows holds.
 *    It passes `chat_template_kwargs` into the model's Jinja template
 *    (tools/server/server-common.cpp), and the templates that know effort
 *    read a `reasoning_effort` variable there (models/templates/
 *    openai-gpt-oss-120b.jinja: "Reasoning: low|medium|high"; docs/preset.md
 *    shows `chat-template-kwargs = {"reasoning_effort": "high"}`). For every
 *    other thinking model the server's real control is the token budget
 *    `thinking_budget_tokens`, so Low and Medium also set a budget there,
 *    unless the user set a Think budget of their own, which always wins.
 *    High sets none, which is what every request did before.
 *  - Self-hosted llama.cpp: same template variable, but its version is ours
 *    to guess, so the budget is not claimed (see think-budget.ts). Rungs
 *    only when the template /props reports actually reads
 *    `reasoning_effort`, the same check llama.cpp's own web UI makes
 *    (tools/ui/src/lib/utils/chat-template-thinking-detector.ts).
 *  - LM Studio 0.4.8 and later: top-level `reasoning_effort` on
 *    /v1/chat/completions (LM Studio 0.4.8 release notes, 26.03.2026). The
 *    rungs per model come from GET /api/v1/models,
 *    `capabilities.reasoning.allowed_options` ("off" | "on" | "low" |
 *    "medium" | "high", LM Studio REST docs, List your models).
 *  - KoboldCpp (koboldcpp.py 1.123, commit e1c41e17): top-level
 *    `reasoning_effort`; "low", "medium" and "high" cap the thought at 25, 50
 *    and 75 percent of the reply length, any other value leaves it
 *    unrestricted, and the same field is handed to the Jinja template. Max
 *    therefore sends no `reasoning_effort` at all, which is KoboldCpp's
 *    unrestricted case, rather than a word the template does not know.
 *    Recognised by GET /api/extra/version answering `"result": "KoboldCpp"`.
 */

export type LocalEffortServer = 'engine' | 'llamacpp' | 'lmstudio' | 'kobold' | 'unknown'

export const ENGINE_EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high']
export const LLAMACPP_EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high']
export const KOBOLD_EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'max']

/** The Think budget the LU Engine gets for a rung when the user set none.
 *  High and Max are absent on purpose: no limit, as before this existed. */
export const ENGINE_EFFORT_BUDGET: Readonly<Record<string, number>> = { low: 1024, medium: 4096 }

/** KoboldCpp's /api/extra/version body. */
export function isKoboldVersion(body: unknown): boolean {
  return asString(prop(body, 'result')) === 'KoboldCpp'
}

/** LM Studio's /api/v1/models body: is it one at all. */
export function isLmStudioV1Models(body: unknown): boolean {
  return Array.isArray(prop(body, 'models'))
}

/**
 * The rungs LM Studio declares for one model, in our words, or undefined
 * when it declares none ("on" and "off" are the Think button, not rungs).
 * Matched on the model key, which is the id /v1/models lists, and on the
 * ids of loaded instances.
 */
export function lmStudioEffortLevels(body: unknown, modelId: string): string[] | undefined {
  for (const m of asRecordArray(prop(body, 'models'))) {
    const ids = [asString(m.key), ...asRecordArray(m.loaded_instances).map((i) => asString(i.id))]
    if (!ids.includes(modelId)) continue
    const reasoning = prop(prop(m, 'capabilities'), 'reasoning')
    const levels = asStringArray(prop(reasoning, 'allowed_options'))
      .filter((o) => o === 'low' || o === 'medium' || o === 'high')
    return levels.length > 0 ? levels : undefined
  }
  return undefined
}

/** Does the chat template llama.cpp reports in /props read `reasoning_effort`? */
export function templateReadsEffort(props: unknown): boolean {
  const tmpl = asString(prop(props, 'chat_template'))
  return !!tmpl && /\breasoning_effort\b/.test(tmpl)
}

/** Why a local model shows the effort control greyed out. */
export function localEffortNote(server: LocalEffortServer): string {
  switch (server) {
    case 'lmstudio': return 'LM Studio lists no effort levels for this model.'
    case 'llamacpp': return 'The chat template of this model has no effort setting.'
    default: return 'This backend does not take effort levels.'
  }
}

/** The fields of a chat body this module touches. */
export interface EffortBody {
  reasoning_effort?: string
  chat_template_kwargs?: Record<string, unknown>
  thinking_budget_tokens?: number
}

/**
 * Put the rung on the wire in the form this server reads. `body` already
 * carries the clamped rung as `reasoning_effort` (thinkingEffort in the
 * provider); this adds or reshapes what the server needs on top.
 * `ownBudget` is the user's Think budget, 0 for Auto.
 */
export function applyLocalEffort(body: EffortBody, server: LocalEffortServer, ownBudget: unknown): void {
  const rung = body.reasoning_effort
  if (!rung || rung === 'none' || rung === 'minimal') return
  const templateRung = rung === 'max' ? 'high' : rung
  switch (server) {
    case 'engine': {
      body.chat_template_kwargs = { ...(body.chat_template_kwargs ?? {}), reasoning_effort: templateRung }
      const budget = ENGINE_EFFORT_BUDGET[rung]
      if (normalizeThinkBudget(ownBudget) === 0 && body.thinking_budget_tokens === undefined && budget) {
        body.thinking_budget_tokens = budget
      }
      return
    }
    case 'llamacpp':
      body.chat_template_kwargs = { ...(body.chat_template_kwargs ?? {}), reasoning_effort: templateRung }
      return
    case 'kobold':
      if (rung === 'max') delete body.reasoning_effort
      return
    default:
      return
  }
}
