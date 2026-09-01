/**
 * Agent Workflows / Chains — Type Definitions
 *
 * Multi-step agent sequences that can be saved, shared, and reused.
 * Steps execute sequentially with branching and looping support.
 */

import type { MemoryType } from './agent-mode'

// ── Step Types ────────────────────────────────────────────────

export type WorkflowStepType = 'prompt' | 'tool' | 'condition' | 'loop' | 'user_input' | 'memory_save'

export interface WorkflowStep {
  id: string
  type: WorkflowStepType
  label: string
  description?: string

  // prompt step: send message to LLM
  prompt?: string
  allowedTools?: string[]  // tool whitelist (empty = no tools, undefined = all tools)

  // tool step: execute specific tool
  toolName?: string
  /** Static args merged with the interpolated `toolArgTemplates` at run time.
   *  Same `unknown`-valued shape the tool executors receive (mcp/types.ToolArgs)
   *  — a saved workflow's args are JSON the user or an import wrote. */
  toolArgs?: Record<string, unknown>
  toolArgTemplates?: Record<string, string>  // supports {{variable}} interpolation

  // condition step: branch based on output
  condition?: {
    source: 'last_output' | string  // variable name or 'last_output'
    operator: 'contains' | 'not_contains' | 'equals' | 'not_equals' | 'truthy' | 'falsy'
    value: string
    thenStepId: string
    elseStepId: string
  }

  // loop step: repeat until condition
  loop?: {
    maxIterations: number
    condition: {
      source: 'last_output' | string
      operator: 'contains' | 'not_contains' | 'equals' | 'not_equals' | 'truthy' | 'falsy'
      value: string
    }
    bodyStepIds: string[]
  }

  // memory_save step: save to memory store
  memorySave?: {
    type: MemoryType
    titleTemplate: string    // supports {{variable}}
    contentTemplate: string  // supports {{variable}}
    tags?: string[]
  }

  // user_input step: pause for user input
  userInputPrompt?: string
}

// ── Workflow Definition ───────────────────────────────────────

export interface AgentWorkflow {
  id: string
  name: string
  description: string
  icon: string           // Lucide icon name
  steps: WorkflowStep[]
  variables: Record<string, string>  // default variable values
  isBuiltIn: boolean
  createdAt: number
  updatedAt: number
}

// ── Execution ─────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
export type WorkflowStatus = 'idle' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled'

export interface StepResult {
  stepId: string
  status: StepStatus
  output: string
  startedAt: number
  completedAt?: number
  error?: string
  toolCalls?: Array<{
    name: string
    args: Record<string, unknown>
    result: string
  }>
}

export interface WorkflowExecution {
  id: string
  workflowId: string
  workflowName: string
  status: WorkflowStatus
  currentStepIndex: number
  stepResults: StepResult[]
  variables: Record<string, string>  // runtime variable state
  conversationId?: string
  startedAt: number
  completedAt?: number
  error?: string
}

// ── Engine Callbacks ──────────────────────────────────────────

export interface WorkflowEngineCallbacks {
  onStepStart: (stepIndex: number, step: WorkflowStep) => void
  onStepComplete: (stepIndex: number, result: StepResult) => void
  onStepError: (stepIndex: number, error: string) => void
  onWaitingForInput: (stepIndex: number, prompt: string) => void
  onComplete: (results: StepResult[]) => void
  onError: (error: string) => void
}
