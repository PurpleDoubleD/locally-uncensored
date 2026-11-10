/**
 * B1-2 (lu-301/bau/review-offload2.md, Auflage 2.1): the reviewer's actual
 * explanation for the box's "run workflow Research Topic: the history of
 * tea" finishing in seconds with idle GPU and only a memory_save receipt to
 * show. `executeWebSearch`/`executeWebFetch` (builtin-tools.ts) used to
 * return failure text that did not start with "Error:", so `executeToolStep`
 * (workflow-engine.ts) never marked the step `status: 'failed'` and the
 * chain ran on to `memory_save` on a failure-shaped string as if it were a
 * real search result. Commit c3e4bf0c fixed the completion MESSAGE without
 * fixing this, which the reviewer called "a LOUDER false statement than
 * before" ("Workflow complete (6/6 steps)." over a run that never really
 * worked).
 *
 * This drives the REAL `WorkflowEngine` over a workflow shaped exactly like
 * the built-in "Research Topic" (tool -> prompt -> tool -> prompt ->
 * memory_save), with `backendCall('web_search', ...)` mocked to answer the
 * way a bad search provider key does: `{ error: '...' }`. Only the provider
 * boundary (`resolveToolCallingStrategy`) and the Tauri bridge
 * (`backendCall`) are mocked; `executeWebSearch` and `executeToolStep` run
 * for real.
 *
 * Run: npx vitest run src/lib/__tests__/workflow-stops-honestly-on-tool-failure.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
// P-L (3.1.0): the address gate has its own tests (web-research-und-quellen.test.ts); here the
// mocked model picks no real address.
vi.mock('../web-url-provenance', () => ({ guardWebUrl: async () => null, rememberUrls: () => {} }))

const backendCall = vi.fn(async (..._args: unknown[]) => ({}))

vi.mock('../agent-strategy', () => ({
  resolveToolCallingStrategy: vi.fn(),
}))
vi.mock('../../api/backend', async () => {
  const actual = await vi.importActual<typeof import('../../api/backend')>('../../api/backend')
  return { ...actual, backendCall: (...a: unknown[]) => backendCall(...a) }
})

import { WorkflowEngine, describeWorkflowStepFailure, describeWorkflowCompletion } from '../workflow-engine'
import { APPROVE_ALL } from '../../api/agents/tool-executor'
import { toolRegistry, registerBuiltinTools } from '../../api/mcp'
import { useModelStore } from '../../stores/modelStore'
import { useGenerationStore } from '../../stores/generationStore'
import { __resetRunLanesForTests } from '../run-lanes'
import { resolveToolCallingStrategy } from '../agent-strategy'
import type { AgentWorkflow, WorkflowStep, WorkflowEngineCallbacks, StepResult } from '../../types/agent-workflows'

const CLOUD_MODEL = 'anthropic::claude'

function researchTopicShaped(): AgentWorkflow {
  const steps: WorkflowStep[] = [
    { id: 'search', type: 'tool', label: 'Search the web', toolName: 'web_search', toolArgTemplates: { query: '{{user_input}}' } },
    { id: 'pick', type: 'prompt', label: 'Pick best URL', prompt: 'pick a url', allowedTools: [] },
    { id: 'fetch', type: 'tool', label: 'Fetch page content', toolName: 'web_fetch', toolArgTemplates: { url: '{{last_output}}' } },
    { id: 'summarize', type: 'prompt', label: 'Summarize findings', prompt: 'summarize', allowedTools: [] },
    { id: 'save', type: 'memory_save', label: 'Save to memory', memorySave: { type: 'reference', titleTemplate: 'Research: {{user_input}}', contentTemplate: '{{last_output}}', tags: [] } },
  ]
  return { id: 'wf', name: 'Research Topic', description: '', icon: 'Search', steps, variables: {}, isBuiltIn: true, createdAt: 0, updatedAt: 0 }
}

/** Production's own callback shape (useAgentChat.ts / builtin-tools.ts):
 *  onStepError posts the honest per-step message and sets `hadStepError`;
 *  onComplete bails out when it fires, so at most ONE final message ever
 *  reaches the user. */
function productionShapedCallbacks(workflow: AgentWorkflow) {
  let hadStepError = false
  const messages: string[] = []
  const callbacks: WorkflowEngineCallbacks = {
    onStepStart: () => {},
    onStepComplete: () => {},
    onStepError: (i, error) => {
      hadStepError = true
      messages.push(describeWorkflowStepFailure(workflow, i, error))
    },
    onWaitingForInput: () => {},
    onComplete: (allResults: StepResult[]) => {
      if (hadStepError) return
      messages.push(describeWorkflowCompletion(workflow, allResults))
    },
    onError: (err) => { messages.push(`Workflow error: ${err}`) },
  }
  return { callbacks, messages }
}

beforeEach(() => {
  __resetRunLanesForTests()
  useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })
  useModelStore.setState({ activeModel: CLOUD_MODEL })
  backendCall.mockClear()
  registerBuiltinTools(toolRegistry)
  vi.mocked(resolveToolCallingStrategy).mockResolvedValue({
    strategy: 'native',
    modelToUse: 'claude',
    modelId: 'claude',
    providerId: 'anthropic',
    // A prompt step should never be reached once the search step fails and
    // the run breaks; this stub only exists so the test fails loudly (a
    // thrown error, not a false pass) if that assumption is ever wrong.
    provider: {
      chatStream: async function* () { yield { content: 'unexpected: a prompt step ran', done: true } },
      chatWithTools: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  })
})

describe('a broken web search stops the run honestly instead of a false "complete"', () => {
  it('the search step is marked failed, the run stops at step 1, and later steps never run', async () => {
    backendCall.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string
      if (cmd === 'web_search') return { error: 'All search tiers failed' }
      throw new Error(`unexpected backendCall: ${cmd}`)
    })
    const workflow = researchTopicShaped()
    const { callbacks, messages } = productionShapedCallbacks(workflow)
    const engine = new WorkflowEngine(workflow, 'conv-a', callbacks, APPROVE_ALL, { user_input: 'the history of tea' })
    const results = await engine.run()

    // Only the search step ran; runSteps breaks on its failure.
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('failed')

    // Exactly one message reached the user, and it is the honest one.
    expect(messages).toHaveLength(1)
    expect(messages[0]).toBe('Workflow stopped at step 1 of 5: Error: Web search failed: All search tiers failed')

    // The false positive this fixes: it must NOT claim completion.
    expect(messages[0]).not.toContain('Workflow complete')
    expect(messages[0]).not.toContain('Saved to memory')
  })

  it('Gegenprobe: a working search lets the run reach memory_save and report completion', async () => {
    backendCall.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string
      if (cmd === 'web_search') return { results: [{ title: 'Tea', url: 'https://tea.example', snippet: 'history of tea' }] }
      if (cmd === 'web_fetch') return { url: 'https://tea.example', status: 200, contentType: 'text/html', title: 'Tea', text: 'Tea has a long history.', truncated: false }
      throw new Error(`unexpected backendCall: ${cmd}`)
    })
    vi.mocked(resolveToolCallingStrategy).mockResolvedValue({
      strategy: 'native',
      modelToUse: 'claude',
      modelId: 'claude',
      providerId: 'anthropic',
      provider: {
        chatStream: async function* () { yield { content: 'Tea has a long and storied history.', done: true } },
        chatWithTools: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })
    const workflow = researchTopicShaped()
    const { callbacks, messages } = productionShapedCallbacks(workflow)
    const engine = new WorkflowEngine(workflow, 'conv-b', callbacks, APPROVE_ALL, { user_input: 'the history of tea' })
    const results = await engine.run()

    expect(results).toHaveLength(5)
    expect(results.every((r) => r.status === 'completed')).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('Workflow complete (5/5 steps).')
    expect(messages[0]).toContain('Tea has a long and storied history.')
  })
})

describe('a prompt step with no output is a failed step, not a completed one with nothing to say', () => {
  it('an empty model answer stops the run and is named honestly', async () => {
    vi.mocked(resolveToolCallingStrategy).mockResolvedValue({
      strategy: 'native',
      modelToUse: 'claude',
      modelId: 'claude',
      providerId: 'anthropic',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: { chatStream: async function* () { yield { content: '', done: true } }, chatWithTools: vi.fn() } as any,
    })
    const workflow: AgentWorkflow = {
      id: 'wf2', name: 'test', description: '', icon: 'Zap',
      steps: [{ id: 'p', type: 'prompt', label: 'p', prompt: 'say something', allowedTools: [] }],
      variables: {}, isBuiltIn: false, createdAt: 0, updatedAt: 0,
    }
    const { callbacks, messages } = productionShapedCallbacks(workflow)
    const engine = new WorkflowEngine(workflow, 'conv-c', callbacks, APPROVE_ALL)
    const results = await engine.run()

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('failed')
    expect(messages).toEqual(['Workflow stopped at step 1 of 1: The model returned no content for this prompt step.'])
  })

  it('Gegenprobe: a non-empty model answer completes normally', async () => {
    vi.mocked(resolveToolCallingStrategy).mockResolvedValue({
      strategy: 'native',
      modelToUse: 'claude',
      modelId: 'claude',
      providerId: 'anthropic',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: { chatStream: async function* () { yield { content: 'a real answer', done: true } }, chatWithTools: vi.fn() } as any,
    })
    const workflow: AgentWorkflow = {
      id: 'wf3', name: 'test', description: '', icon: 'Zap',
      steps: [{ id: 'p', type: 'prompt', label: 'p', prompt: 'say something', allowedTools: [] }],
      variables: {}, isBuiltIn: false, createdAt: 0, updatedAt: 0,
    }
    const { callbacks, messages } = productionShapedCallbacks(workflow)
    const engine = new WorkflowEngine(workflow, 'conv-d', callbacks, APPROVE_ALL)
    const results = await engine.run()

    expect(results[0].status).toBe('completed')
    expect(messages[0]).toContain('a real answer')
  })

  // R2-1 (lu-301/bau/review-offload2.md, Runde 2): executePromptStep checks
  // only for empty output, never a prefix, so a real model answer that
  // happens to start with "Error:" or "Web search failed" must NOT be
  // treated as a failed step. Guards against a future "unifier" that widens
  // the tool-step error detector to also cover prompt steps.
  it('a non-empty model answer that merely starts with "Error:" still completes', async () => {
    vi.mocked(resolveToolCallingStrategy).mockResolvedValue({
      strategy: 'native',
      modelToUse: 'claude',
      modelId: 'claude',
      providerId: 'anthropic',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: { chatStream: async function* () { yield { content: 'Error: the user asked me to write this exact sentence', done: true } }, chatWithTools: vi.fn() } as any,
    })
    const workflow: AgentWorkflow = {
      id: 'wf4', name: 'test', description: '', icon: 'Zap',
      steps: [{ id: 'p', type: 'prompt', label: 'p', prompt: 'say something', allowedTools: [] }],
      variables: {}, isBuiltIn: false, createdAt: 0, updatedAt: 0,
    }
    const { callbacks, messages } = productionShapedCallbacks(workflow)
    const engine = new WorkflowEngine(workflow, 'conv-e', callbacks, APPROVE_ALL)
    const results = await engine.run()

    expect(results[0].status).toBe('completed')
    expect(messages[0]).toContain('Workflow complete')
    expect(messages[0]).toContain('Error: the user asked me to write this exact sentence')
  })

  it('a non-empty model answer that starts with "Web search failed" still completes', async () => {
    vi.mocked(resolveToolCallingStrategy).mockResolvedValue({
      strategy: 'native',
      modelToUse: 'claude',
      modelId: 'claude',
      providerId: 'anthropic',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: { chatStream: async function* () { yield { content: 'Web search failed to turn up anything, the model said, so let me answer from memory instead.', done: true } }, chatWithTools: vi.fn() } as any,
    })
    const workflow: AgentWorkflow = {
      id: 'wf5', name: 'test', description: '', icon: 'Zap',
      steps: [{ id: 'p', type: 'prompt', label: 'p', prompt: 'say something', allowedTools: [] }],
      variables: {}, isBuiltIn: false, createdAt: 0, updatedAt: 0,
    }
    const { callbacks, messages } = productionShapedCallbacks(workflow)
    const engine = new WorkflowEngine(workflow, 'conv-f', callbacks, APPROVE_ALL)
    const results = await engine.run()

    expect(results[0].status).toBe('completed')
    expect(messages[0]).toContain('Workflow complete')
  })
})
