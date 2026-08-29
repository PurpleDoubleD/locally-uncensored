import { settleThinking } from '../../lib/thinking-stripper'
import type { ChatMessage } from '../providers/types'
import { getProviderForModel } from '../providers'

export const ARCHITECT_SYSTEM_PROMPT = `You are the Architect — the planning half of a two-model coding system.

Your job: read the user's request and the working directory, then output a CONCRETE, ORDERED PLAN that the Editor model will execute step by step. You have NO tools. You do NOT read or write files. You only plan.

Output format (markdown, nothing else):

## Plan

1. <step> — file(s), change, why
2. ...

## Files to read first

- path/to/file.ts — why
- ...

## Done when

- <observable criterion>
- ...

Rules:
- Be specific. "Update the API route" is bad. "Edit apps/web/app/api/foo/route.ts to handle POST" is good.
- Reference exact file paths when the user mentioned them or you can infer them.
- Maximum 12 numbered steps. Group if needed.
- Don't write code unless it's essential to convey the change shape.
- Don't invent files. If you don't know the file, say "find the X file that does Y".
- Output the plan in the exact format above. Nothing else.`

export interface ArchitectInput {
  /** Prefixed model name, e.g. `anthropic::claude-sonnet-4-5`. */
  model: string
  /** The user's latest instruction. */
  userInstruction: string
  /** Resolved cwd; threaded into the system prompt so the planner knows where work happens. */
  workingDirectory: string
  /** Optional prior conversation turns for follow-up context (keep small — planner doesn't need full history). */
  recentMessages?: ChatMessage[]
  /** Abort signal — wired to the same controller as the editor loop so a cancelled run kills both halves. */
  signal?: AbortSignal
  /** Override sampling temperature. Default 0.3 — plans want determinism, not creativity. */
  temperature?: number
}

export interface ArchitectResult {
  /** Raw markdown plan from the architect. */
  plan: string
  /** Echo of the model used — for the chat-side reasoning block. */
  modelUsed: string
  /** Wall time spent planning, for the same block. */
  tookMs: number
}

/**
 * Run the Architect pass. Returns the markdown plan; no tools are passed
 * to the provider so the model cannot accidentally start editing files in
 * this phase. Caller is responsible for showing the plan to the user and
 * forwarding it into the Editor's system prompt.
 */
export async function planWithArchitect(
  input: ArchitectInput,
): Promise<ArchitectResult> {
  const t0 = Date.now()
  const { provider, modelId } = getProviderForModel(input.model)
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${ARCHITECT_SYSTEM_PROMPT}\n\nWorking directory: ${input.workingDirectory}`,
    },
    ...(input.recentMessages ?? []),
    { role: 'user', content: input.userInstruction },
  ]
  const { content } = await provider.chatWithTools(modelId, messages, [], {
    temperature: input.temperature ?? 0.3,
    signal: input.signal,
  })
  return {
    // The plan is pasted into the EDITOR's system prompt verbatim, so a
    // thinking model's reasoning would ride into every coding turn after it
    // (2.6.7 Denk-Audit, Loch 11). Same settlement as every visible surface.
    plan: settleThinking(content ?? '', '', false).content,
    modelUsed: input.model,
    tookMs: Date.now() - t0,
  }
}

/**
 * Render the architect plan as a system-prompt suffix the editor sees.
 * The marker `ARCHITECT PLAN:` is intentional — it gives the editor a
 * stable anchor it can refer to ("follow the architect plan above").
 */
export function renderArchitectPlanSection(plan: string): string {
  const trimmed = plan.trim()
  if (!trimmed) return ''
  return `\n\nARCHITECT PLAN — follow this plan step by step. The architect produced it before any tool was called. Treat it as authoritative for ordering and scope; deviate only when a step turns out to be impossible or unsafe.\n\n${trimmed}`
}
