/**
 * Phase 13 (v2.4.0) — Sub-agent delegation.
 *
 * Exposes a `delegate_task` builtin tool that spawns a nested ReAct loop
 * with a sub-goal, its own isolated AgentBudget, and the same tool
 * registry minus `delegate_task` itself (so a sub-agent cannot fork-bomb
 * a tree of delegations).
 *
 * Depth is capped at 2 globally — a sub-agent that attempts to call
 * delegate_task returns a refusal string. Combined with the tool-list
 * filtering, the model has no syntactically valid path to recurse.
 */

import type { MCPToolDefinition } from '../mcp/types'
import { executeParallel, type ExecutionRequest } from './tool-executor'
import { AgentBudget } from './budget'
import { explainError as explainToolError } from './error-hints'

// NOTE: the toolRegistry import is done LAZILY inside defaultSubAgentRunner
// to avoid a circular dependency with src/api/mcp/builtin-tools.ts, which
// pulls DELEGATE_TASK_TOOL_DEF + buildDelegateExecutor from this file at
// module init.

/** Max sub-agent nesting depth. Incremented on every delegate_task call. */
export const SUB_AGENT_MAX_DEPTH = 2

/** Tight caps so a sub-agent cannot runaway inside the parent's budget. */
export const SUB_AGENT_BUDGET = { maxToolCalls: 10, maxIterations: 5 } as const

export const DELEGATE_TASK_TOOL_DEF: MCPToolDefinition = {
  name: 'delegate_task',
  description:
    'Spawn a focused sub-agent to work on a sub-goal autonomously. '
    + 'USE for self-contained research or analysis tasks that would pollute the main conversation with tool-call chatter. '
    + 'The sub-agent has its own tight budget (max 10 tool calls, 5 ReAct iterations) and returns a concise final answer. '
    + 'DO NOT call from inside another delegate_task — max nesting depth is 2. '
    + 'NOT a replacement for a regular tool call when one direct tool would do.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'One-sentence statement of what the sub-agent should accomplish.',
      },
      context: {
        type: 'string',
        description: 'Optional background information the sub-agent needs but should not search for.',
      },
    },
    required: ['goal'],
  },
  category: 'workflow',
  source: 'builtin',
}

/**
 * Depth tracker — module-scoped so nested sub-agents across async
 * boundaries stay bounded. Reset only by successful return or thrown
 * error; see the try/finally in the executor.
 */
let _depth = 0

/** Exposed for tests. */
export function _getDepth(): number {
  return _depth
}
/** Exposed for tests. */
export function _setDepth(n: number): void {
  _depth = n
}

export type SubAgentRunner = (
  goal: string,
  context: string,
  options: { budget: AgentBudget }
) => Promise<string>

/**
 * Default sub-agent runner. Pulls in the active provider + model via
 * dynamic import to keep this module standalone and testable with a
 * stub runner. The real hook wiring lives in buildDelegateExecutor().
 */
export async function defaultSubAgentRunner(
  goal: string,
  context: string,
  options: { budget: AgentBudget }
): Promise<string> {
  const { useModelStore } = await import('../../stores/modelStore')
  const { getProviderForModel } = await import('../providers')
  const { toolRegistry } = await import('../mcp')
  const activeModel = useModelStore.getState().activeModel
  if (!activeModel) return 'Error: No active model configured.'
  const { provider, modelId } = getProviderForModel(activeModel)

  const tools: MCPToolDefinition[] = toolRegistry
    .getAll()
    .filter((t) => t.name !== DELEGATE_TASK_TOOL_DEF.name)

  const llmTools = tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }))

  const messages: any[] = [
    {
      role: 'system',
      content:
        'You are a focused sub-agent. Work autonomously toward the goal. '
        + 'Be concise — return a direct final answer without filler. '
        + 'Do NOT attempt to call delegate_task; it is not available to you.',
    },
    {
      role: 'user',
      content: context ? `Goal: ${goal}\n\nContext:\n${context}` : `Goal: ${goal}`,
    },
  ]

  let finalContent = ''
  for (let i = 0; i < SUB_AGENT_BUDGET.maxIterations; i++) {
    options.budget.addIteration()
    const ex = options.budget.exceeded()
    if (ex.kind !== 'none') {
      return `${options.budget.haltMessage()} ${finalContent || '(no partial answer)'}`
    }
    const turn = await provider.chatWithTools(modelId, messages, llmTools, {})
    finalContent = turn.content || finalContent
    if (!turn.toolCalls || turn.toolCalls.length === 0) break

    options.budget.addToolCalls(turn.toolCalls.length)
    const requests: ExecutionRequest[] = turn.toolCalls.map((tc, idx) => ({
      id: `sub-${Date.now()}-${idx}`,
      toolName: tc.function.name,
      args: tc.function.arguments,
      parentToolCallId: 'sub-agent',
    }))
    const registry = toolRegistry
    const results = await executeParallel(requests, {
      getTool: (name) => {
        const td = registry.getToolByName(name)
        return td ? { name: td.name, inputSchema: td.inputSchema } : undefined
      },
      execute: (name, args) => registry.execute(name, args),
      explainError: (toolName, err) => explainToolError(toolName, err),
    })

    messages.push({ role: 'assistant', content: turn.content || '', tool_calls: turn.toolCalls })
    for (const r of results) {
      const tc = turn.toolCalls.find((t) => t.function.name === r.toolName)
      messages.push({
        role: 'tool',
        content: r.result ?? r.error ?? '(no output)',
        tool_call_id: tc?.id,
      })
    }
  }

  return finalContent || '(sub-agent produced no final answer)'
}

/**
 * Build a tool executor suitable for toolRegistry.registerBuiltin. The
 * runner is injectable so tests can stub the whole LLM round-trip.
 */
export function buildDelegateExecutor(
  runner: SubAgentRunner = defaultSubAgentRunner
): (args: Record<string, any>) => Promise<string> {
  return async (args: Record<string, any>) => {
    if (_depth >= SUB_AGENT_MAX_DEPTH) {
      return 'Error: Maximum sub-agent nesting depth (2) reached. Continue the task yourself.'
    }
    const goal = typeof args.goal === 'string' ? args.goal.trim() : ''
    if (!goal) return 'Error: delegate_task requires a "goal" argument.'
    const context = typeof args.context === 'string' ? args.context.trim() : ''

    _depth++
    try {
      const budget = new AgentBudget({ ...SUB_AGENT_BUDGET })
      return await runner(goal, context, { budget })
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      _depth--
    }
  }
}
