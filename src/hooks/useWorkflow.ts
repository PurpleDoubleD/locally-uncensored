/**
 * useWorkflow — Hook for running agent workflows.
 *
 * Manages workflow lifecycle: start, provide input, cancel.
 * Delegates execution to WorkflowEngine.
 */

import { useRef, useState, useCallback } from 'react'
import { WorkflowEngine } from '../lib/workflow-engine'
import { useAgentWorkflowStore } from '../stores/agentWorkflowStore'
import { useChatStore } from '../stores/chatStore'
import { v4 as uuid } from 'uuid'
import type { StepResult, WorkflowEngineCallbacks } from '../types/agent-workflows'

export function useWorkflow() {
  const [isRunning, setIsRunning] = useState(false)
  const [waitingForInput, setWaitingForInput] = useState<string | null>(null)
  const [currentStepLabel, setCurrentStepLabel] = useState('')
  const engineRef = useRef<WorkflowEngine | null>(null)

  const startWorkflow = useCallback(async (
    workflowId: string,
    variables?: Record<string, string>
  ) => {
    const store = useAgentWorkflowStore.getState()
    const workflow = store.getWorkflow(workflowId)
    if (!workflow) return

    const chatStore = useChatStore.getState()
    const convId = chatStore.activeConversationId || chatStore.createConversation(
      '', // model will be resolved by engine
      ''
    )

    const executionId = store.startExecution(workflowId, convId)
    if (!executionId) return

    setIsRunning(true)
    setWaitingForInput(null)

    // Add workflow start message to chat
    chatStore.addMessage(convId, {
      id: uuid(),
      role: 'assistant',
      content: `Running workflow: **${workflow.name}**...`,
      timestamp: Date.now(),
    })

    const callbacks: WorkflowEngineCallbacks = {
      onStepStart: (stepIndex, step) => {
        setCurrentStepLabel(step.label)
        store.updateExecution(executionId, { currentStepIndex: stepIndex })
      },
      onStepComplete: (_stepIndex, result) => {
        store.addStepResult(executionId, result)
      },
      onStepError: (stepIndex, error) => {
        store.addStepResult(executionId, {
          stepId: workflow.steps[stepIndex].id,
          status: 'failed',
          output: '',
          startedAt: Date.now(),
          error,
        })
      },
      onWaitingForInput: (_stepIndex, prompt) => {
        setWaitingForInput(prompt)
        store.updateExecution(executionId, { status: 'waiting_input' })
      },
      onComplete: (results: StepResult[]) => {
        store.updateExecution(executionId, {
          status: 'completed',
          completedAt: Date.now(),
        })

        // Add final result to chat
        const lastOutput = results.filter(r => r.output).pop()
        if (lastOutput) {
          chatStore.addMessage(convId, {
            id: uuid(),
            role: 'assistant',
            content: lastOutput.output,
            timestamp: Date.now(),
          })
        }
      },
      onError: (error) => {
        store.updateExecution(executionId, {
          status: 'failed',
          completedAt: Date.now(),
          error,
        })
        chatStore.addMessage(convId, {
          id: uuid(),
          role: 'assistant',
          content: `Workflow failed: ${error}`,
          timestamp: Date.now(),
        })
      },
    }

    const engine = new WorkflowEngine(workflow, convId, callbacks, variables)
    engineRef.current = engine

    try {
      await engine.run()
    } finally {
      setIsRunning(false)
      setWaitingForInput(null)
      setCurrentStepLabel('')
      engineRef.current = null
    }
  }, [])

  const provideInput = useCallback((input: string) => {
    engineRef.current?.provideUserInput(input)
    setWaitingForInput(null)
  }, [])

  const cancelWorkflow = useCallback(() => {
    engineRef.current?.cancel()
    setIsRunning(false)
    setWaitingForInput(null)
    setCurrentStepLabel('')
  }, [])

  return {
    startWorkflow,
    provideInput,
    cancelWorkflow,
    isRunning,
    waitingForInput,
    currentStepLabel,
  }
}
