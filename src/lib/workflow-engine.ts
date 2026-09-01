/**
 * Workflow Engine — Executes agent workflow steps sequentially.
 *
 * Reuses the same tool execution and provider infrastructure as useAgentChat.
 * Supports: prompt, tool, condition, loop, user_input, memory_save steps.
 */

import { useModelStore } from '../stores/modelStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useMemoryStore } from '../stores/memoryStore'
// Audit W-T2: hier stand `from '../api/tool-registry'` — der als @deprecated
// markierte Kompatibilitäts-Shim. Der zieht das ganze MCP-Barrel herein
// (api/mcp/index.ts, das registerBuiltinTools ausführt), und weil
// builtin-tools.ts umgekehrt diese Engine für sein run_workflow-Tool braucht,
// schloss sich der Kreis: mcp/index → builtin-tools → workflow-engine →
// tool-registry → mcp/index.
//
// Die Engine ist kein Altlast-Aufrufer. Sie braucht die Registry selbst, nicht
// den Kompositions-Einstiegspunkt, der die Builtins einhängt — also importiert
// sie jetzt genau die: das Registry-Modul und die Berechtigungs-Voreinstellung.
// Beides sind generische Module ohne Rückkante. Der Shim bleibt für seine
// verbliebenen Aufrufer bestehen.
import { toolRegistry } from '../api/mcp/tool-registry'
import { DEFAULT_PERMISSIONS } from '../api/mcp/types'
import { streamProviderTurn } from './provider-stream'
import { settleThinking } from './thinking-stripper'
import { buildHermesToolPrompt, parseHermesToolCalls, stripToolCallTags, hasToolCallTags } from '../api/hermes-tool-calling'
import { resolveToolCallingStrategy } from './agent-strategy'
import type { AgentWorkflow, WorkflowStep, StepResult, WorkflowEngineCallbacks } from '../types/agent-workflows'
import type { ChatMessage, ToolDefinition } from '../api/providers/types'

// ── Safety Limits ─────────────────────────────────────────────

export const MAX_LOOP_ITERATIONS = 100
export const MAX_WORKFLOW_DEPTH = 5
/**
 * Total steps one run may execute. A condition can branch backwards, which is
 * how a workflow expresses "not done yet, try again" — without a budget that
 * is an unbounded loop, and run_workflow gives the agent no way to cancel it.
 */
export const MAX_STEPS_EXECUTED = 500

// ── Variable Interpolation ────────────────────────────────────

function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || '')
}

// ── Condition Evaluation ──────────────────────────────────────

function evaluateCondition(
  source: string,
  operator: string,
  value: string,
  variables: Record<string, string>
): boolean {
  const sourceValue = source === 'last_output'
    ? (variables['last_output'] || '')
    : (variables[source] || '')

  switch (operator) {
    case 'contains': return sourceValue.includes(value)
    case 'not_contains': return !sourceValue.includes(value)
    case 'equals': return sourceValue === value
    case 'not_equals': return sourceValue !== value
    case 'truthy': return Boolean(sourceValue && sourceValue !== 'false' && sourceValue !== '0')
    case 'falsy': return !sourceValue || sourceValue === 'false' || sourceValue === '0'
    default: return false
  }
}

// ── Engine ────────────────────────────────────────────────────

export class WorkflowEngine {
  private workflow: AgentWorkflow
  private conversationId: string
  private callbacks: WorkflowEngineCallbacks
  private variables: Record<string, string>
  private abortController: AbortController
  private inputResolver: ((input: string) => void) | null = null
  private depth: number

  constructor(
    workflow: AgentWorkflow,
    conversationId: string,
    callbacks: WorkflowEngineCallbacks,
    initialVariables?: Record<string, string>,
    depth: number = 0
  ) {
    this.workflow = workflow
    this.conversationId = conversationId
    this.callbacks = callbacks
    this.variables = { ...workflow.variables, ...(initialVariables || {}) }
    this.abortController = new AbortController()
    this.depth = depth
  }

  /**
   * Run the workflow from start to finish.
   */
  async run(): Promise<StepResult[]> {
    if (this.depth >= MAX_WORKFLOW_DEPTH) {
      throw new Error(`Maximum workflow nesting depth (${MAX_WORKFLOW_DEPTH}) exceeded`)
    }

    const results: StepResult[] = []
    let stepIndex = 0
    let executed = 0

    try {
      while (stepIndex < this.workflow.steps.length) {
        if (this.abortController.signal.aborted) break
        if (++executed > MAX_STEPS_EXECUTED) {
          this.callbacks.onError(`Workflow exceeded ${MAX_STEPS_EXECUTED} steps — check for a condition that branches back on itself`)
          break
        }

        const step = this.workflow.steps[stepIndex]
        this.callbacks.onStepStart(stepIndex, step)

        const result = await this.executeStep(step, stepIndex)
        results.push(result)

        if (result.status === 'failed') {
          this.callbacks.onStepError(stepIndex, result.error || 'Unknown error')
          break
        }

        this.callbacks.onStepComplete(stepIndex, result)

        // Set last_output for next step. A condition's "true"/"false" is a
        // branch marker, not data: letting it through replaced the previous
        // step's real output, so the next step's {{last_output}} interpolated
        // to the literal "true".
        if (result.output && step.type !== 'condition') {
          this.variables['last_output'] = result.output
        }

        // Handle branching — on the decision the step already made. Evaluating
        // the condition a second time here used to happen AFTER last_output had
        // been overwritten with that marker, so a condition reading last_output
        // (the default, and the only source the builder writes) compared
        // "true"/"false" against the user's value and always fell to the else
        // branch.
        if (step.type === 'condition' && step.condition) {
          const targetId = result.output === 'true' ? step.condition.thenStepId : step.condition.elseStepId
          const targetIndex = this.workflow.steps.findIndex(s => s.id === targetId)
          stepIndex = targetIndex >= 0 ? targetIndex : stepIndex + 1
        } else {
          stepIndex++
        }
      }

      if (!this.abortController.signal.aborted) {
        this.callbacks.onComplete(results)
      }
    } catch (err) {
      const errorMsg = (err as Error).message || 'Workflow execution failed'
      this.callbacks.onError(errorMsg)
    }

    return results
  }

  /**
   * Cancel the running workflow.
   */
  cancel() {
    this.abortController.abort()
  }

  /**
   * Provide user input for a waiting user_input step.
   */
  provideUserInput(input: string) {
    if (this.inputResolver) {
      this.inputResolver(input)
      this.inputResolver = null
    }
  }

  // ── Step Execution ────────────────────────────────────────

  private async executeStep(step: WorkflowStep, stepIndex: number): Promise<StepResult> {
    const startedAt = Date.now()

    try {
      switch (step.type) {
        case 'prompt':
          return await this.executePromptStep(step, startedAt)

        case 'tool':
          return await this.executeToolStep(step, startedAt)

        case 'condition':
          return this.executeConditionStep(step, startedAt)

        case 'loop':
          return await this.executeLoopStep(step, startedAt)

        case 'user_input':
          return await this.executeUserInputStep(step, stepIndex, startedAt)

        case 'memory_save':
          return this.executeMemorySaveStep(step, startedAt)

        default:
          return { stepId: step.id, status: 'failed', output: '', startedAt, error: `Unknown step type: ${step.type}` }
      }
    } catch (err) {
      return {
        stepId: step.id,
        status: 'failed',
        output: '',
        startedAt,
        completedAt: Date.now(),
        error: (err as Error).message || 'Step execution failed',
      }
    }
  }

  // ── Prompt Step ───────────────────────────────────────────

  private async executePromptStep(step: WorkflowStep, startedAt: number): Promise<StepResult> {
    const { activeModel } = useModelStore.getState()
    if (!activeModel) throw new Error('No active model')

    const { strategy, modelToUse, provider } = await resolveToolCallingStrategy(activeModel)
    const prompt = interpolate(step.prompt || '', this.variables)

    const messages: ChatMessage[] = [
      { role: 'user', content: prompt },
    ]

    const { settings } = useSettingsStore.getState()
    let output = ''

    if (step.allowedTools && step.allowedTools.length === 0) {
      // No tools — pure prompt. One transport for every strategy: without a
      // tool contract the hermes and native paths send the same plain chat,
      // and the provider abstraction routes it to the right server. The old
      // hermes branch here posted to Ollama unconditionally (G32b), which
      // 404s the moment the model lives on LM Studio.
      const stream = provider.chatStream(modelToUse, messages, {
        temperature: settings.temperature,
        // Bug AA v2.5.0 — keep num_ctx override for workflow steps too.
        contextWindow: settings.contextWindowOverride || undefined,
        signal: this.abortController.signal,
      })
      for await (const chunk of stream) {
        if (chunk.content) output += chunk.content
        if (chunk.done) break
      }
    } else {
      // With tools
      const tools: ToolDefinition[] = toolRegistry.toOllamaTools(DEFAULT_PERMISSIONS)
      const allowedTools = step.allowedTools
        ? tools.filter(t => step.allowedTools!.includes(t.function.name))
        : tools

      if (strategy === 'native') {
        const turn = await provider.chatWithTools(modelToUse, messages, allowedTools, {
          temperature: settings.temperature,
          // Bug AA v2.5.0 — same num_ctx override on tool calls.
          contextWindow: settings.contextWindowOverride || undefined,
          signal: this.abortController.signal,
        })
        output = turn.content || ''

        // Execute any tool calls
        for (const tc of turn.toolCalls) {
          const result = await toolRegistry.execute(tc.function.name, tc.function.arguments)
          output += `\n[Tool: ${tc.function.name}] ${result}`
        }
      } else {
        // Hermes XML
        const hermesSystem = buildHermesToolPrompt(
          allowedTools.map(t => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters as any, permission: 'auto' as const }))
        )
        const hermesMessages = [{ role: 'system' as const, content: hermesSystem }, ...messages]
        // G32b: through the provider, not Ollama's /api/chat. hermes_xml is
        // reachable for LM Studio and friends now (a server-declared
        // tool-less model lands here), and those models are not installed in
        // Ollama, so the old chatNonStreaming call answered 404.
        const hermesTurn = await streamProviderTurn(
          provider,
          modelToUse,
          hermesMessages.map(m => ({ role: m.role, content: m.content })),
          {
            temperature: settings.temperature,
            contextWindow: settings.contextWindowOverride || undefined,
            signal: this.abortController.signal,
          },
        )
        const rawContent = hermesTurn.content

        if (hasToolCallTags(rawContent)) {
          const toolCalls = parseHermesToolCalls(rawContent)
          output = stripToolCallTags(rawContent)
          for (const tc of toolCalls) {
            const result = await toolRegistry.execute(tc.name, tc.arguments)
            output += `\n[Tool: ${tc.name}] ${result}`
          }
        } else {
          output = rawContent
        }
      }
    }

    // Strip reasoning through the SHARED settlement (2.6.7 Denk-Audit,
    // Loch 5). This used to be a hand-written copy of the balanced-block
    // regex, so a pre-opened Qwen3 thought (closer without opener), a turn cut
    // off mid-thought and every non-canonical marker went straight into the
    // step output, which is not only shown: it becomes a workflow VARIABLE
    // and rides into every later step's prompt.
    output = settleThinking(output, '', false).content

    return {
      stepId: step.id,
      status: 'completed',
      output,
      startedAt,
      completedAt: Date.now(),
    }
  }

  // ── Tool Step ─────────────────────────────────────────────

  private async executeToolStep(step: WorkflowStep, startedAt: number): Promise<StepResult> {
    if (!step.toolName) throw new Error('Tool step missing toolName')

    // Build args from static + templates
    const args: Record<string, any> = { ...(step.toolArgs || {}) }
    if (step.toolArgTemplates) {
      for (const [key, template] of Object.entries(step.toolArgTemplates)) {
        args[key] = interpolate(template, this.variables)
      }
    }

    const result = await toolRegistry.execute(step.toolName, args)
    const isError = result.startsWith('Error:')

    return {
      stepId: step.id,
      status: isError ? 'failed' : 'completed',
      output: result,
      startedAt,
      completedAt: Date.now(),
      error: isError ? result : undefined,
      toolCalls: [{ name: step.toolName, args, result }],
    }
  }

  // ── Condition Step ────────────────────────────────────────

  private executeConditionStep(step: WorkflowStep, startedAt: number): StepResult {
    if (!step.condition) throw new Error('Condition step missing condition')

    const matches = evaluateCondition(
      step.condition.source,
      step.condition.operator,
      interpolate(step.condition.value, this.variables),
      this.variables
    )

    return {
      stepId: step.id,
      status: 'completed',
      output: matches ? 'true' : 'false',
      startedAt,
      completedAt: Date.now(),
    }
  }

  // ── Loop Step ─────────────────────────────────────────────

  private async executeLoopStep(step: WorkflowStep, startedAt: number): Promise<StepResult> {
    if (!step.loop) throw new Error('Loop step missing loop config')

    let iterations = 0
    const outputs: string[] = []

    while (iterations < Math.min(step.loop.maxIterations, MAX_LOOP_ITERATIONS)) {
      if (this.abortController.signal.aborted) break

      // Execute body steps
      for (const bodyStepId of step.loop.bodyStepIds) {
        const bodyStep = this.workflow.steps.find(s => s.id === bodyStepId)
        if (!bodyStep) continue

        const bodyResult = await this.executeStep(bodyStep, -1)
        if (bodyResult.output) {
          this.variables['last_output'] = bodyResult.output
          outputs.push(bodyResult.output)
        }
        if (bodyResult.status === 'failed') {
          return { stepId: step.id, status: 'failed', output: outputs.join('\n'), startedAt, completedAt: Date.now(), error: bodyResult.error }
        }
      }

      // Check exit condition
      const shouldContinue = evaluateCondition(
        step.loop.condition.source,
        step.loop.condition.operator,
        interpolate(step.loop.condition.value, this.variables),
        this.variables
      )
      if (!shouldContinue) break

      iterations++
    }

    return {
      stepId: step.id,
      status: 'completed',
      output: outputs.join('\n'),
      startedAt,
      completedAt: Date.now(),
    }
  }

  // ── User Input Step ───────────────────────────────────────

  private async executeUserInputStep(step: WorkflowStep, stepIndex: number, startedAt: number): Promise<StepResult> {
    const prompt = interpolate(step.userInputPrompt || 'Enter input:', this.variables)
    this.callbacks.onWaitingForInput(stepIndex, prompt)

    const input = await new Promise<string>((resolve) => {
      this.inputResolver = resolve

      // Also resolve on abort
      const onAbort = () => {
        resolve('')
        this.abortController.signal.removeEventListener('abort', onAbort)
      }
      this.abortController.signal.addEventListener('abort', onAbort)
    })

    if (this.abortController.signal.aborted) {
      return { stepId: step.id, status: 'failed', output: '', startedAt, error: 'Cancelled' }
    }

    this.variables['user_input'] = input
    this.variables['last_output'] = input

    return {
      stepId: step.id,
      status: 'completed',
      output: input,
      startedAt,
      completedAt: Date.now(),
    }
  }

  // ── Memory Save Step ──────────────────────────────────────

  private executeMemorySaveStep(step: WorkflowStep, startedAt: number): StepResult {
    if (!step.memorySave) throw new Error('Memory save step missing config')

    const title = interpolate(step.memorySave.titleTemplate, this.variables)
    const content = interpolate(step.memorySave.contentTemplate, this.variables)

    useMemoryStore.getState().addMemory({
      type: step.memorySave.type,
      title: title.substring(0, 60),
      description: content.substring(0, 120),
      content,
      tags: step.memorySave.tags || ['workflow'],
      source: this.conversationId,
    })

    return {
      stepId: step.id,
      status: 'completed',
      output: `Saved to memory: ${title}`,
      startedAt,
      completedAt: Date.now(),
    }
  }
}
