import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import { v4 as uuid } from 'uuid'
import type { AgentWorkflow, WorkflowExecution, StepResult } from '../types/agent-workflows'
import { BUILT_IN_WORKFLOWS } from '../lib/built-in-workflows'

// ── Max execution history ─────────────────────────────────────

const MAX_EXECUTION_HISTORY = 50

// ── Store Interface ───────────────────────────────────────────

interface AgentWorkflowState {
  workflows: AgentWorkflow[]
  executions: WorkflowExecution[]
  activeExecutionId: string | null

  // Workflow CRUD
  addWorkflow: (workflow: Omit<AgentWorkflow, 'id' | 'createdAt' | 'updatedAt'>) => string
  updateWorkflow: (id: string, updates: Partial<Pick<AgentWorkflow, 'name' | 'description' | 'icon' | 'steps' | 'variables'>>) => void
  removeWorkflow: (id: string) => void
  duplicateWorkflow: (id: string) => string | null
  getWorkflow: (id: string) => AgentWorkflow | undefined

  // Execution management
  startExecution: (workflowId: string, conversationId?: string) => string | null
  updateExecution: (id: string, updates: Partial<WorkflowExecution>) => void
  addStepResult: (executionId: string, result: StepResult) => void
  cancelExecution: (id: string) => void
  clearExecutionHistory: () => void
}

// ── Store ─────────────────────────────────────────────────────

export const useAgentWorkflowStore = create<AgentWorkflowState>()(
  persist(
    (set, get) => ({
      workflows: [...BUILT_IN_WORKFLOWS],
      executions: [],
      activeExecutionId: null,

      // ── Workflow CRUD ─────────────────────────────────────

      addWorkflow: (workflow) => {
        const id = uuid()
        set((state) => ({
          workflows: [
            ...state.workflows,
            { ...workflow, id, createdAt: Date.now(), updatedAt: Date.now() },
          ],
        }))
        return id
      },

      updateWorkflow: (id, updates) =>
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === id ? { ...w, ...updates, updatedAt: Date.now() } : w
          ),
        })),

      removeWorkflow: (id) =>
        set((state) => ({
          workflows: state.workflows.filter((w) => w.id !== id || w.isBuiltIn),
        })),

      duplicateWorkflow: (id) => {
        const original = get().workflows.find(w => w.id === id)
        if (!original) return null
        const newId = uuid()
        set((state) => ({
          workflows: [
            ...state.workflows,
            {
              ...original,
              id: newId,
              name: `${original.name} (copy)`,
              isBuiltIn: false,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
        }))
        return newId
      },

      getWorkflow: (id) => get().workflows.find(w => w.id === id),

      // ── Execution ─────────────────────────────────────────

      startExecution: (workflowId, conversationId) => {
        const workflow = get().workflows.find(w => w.id === workflowId)
        if (!workflow) return null

        const id = uuid()
        const execution: WorkflowExecution = {
          id,
          workflowId,
          workflowName: workflow.name,
          status: 'running',
          currentStepIndex: 0,
          stepResults: [],
          variables: { ...workflow.variables },
          conversationId,
          startedAt: Date.now(),
        }

        set((state) => {
          // Trim history if needed
          const executions = [execution, ...state.executions].slice(0, MAX_EXECUTION_HISTORY)
          return { executions, activeExecutionId: id }
        })

        return id
      },

      updateExecution: (id, updates) =>
        set((state) => ({
          executions: state.executions.map((e) =>
            e.id === id ? { ...e, ...updates } : e
          ),
        })),

      addStepResult: (executionId, result) =>
        set((state) => ({
          executions: state.executions.map((e) =>
            e.id === executionId
              ? { ...e, stepResults: [...e.stepResults, result], currentStepIndex: e.currentStepIndex + 1 }
              : e
          ),
        })),

      cancelExecution: (id) =>
        set((state) => ({
          executions: state.executions.map((e) =>
            e.id === id ? { ...e, status: 'cancelled', completedAt: Date.now() } : e
          ),
          activeExecutionId: state.activeExecutionId === id ? null : state.activeExecutionId,
        })),

      clearExecutionHistory: () =>
        set({ executions: [], activeExecutionId: null }),
    }),
    {
      name: 'locally-uncensored-agent-workflows',
      storage: safeJSONStorage(),
      version: 1,
      migrate: (persistedState, version) => {
        const state = persistedState as any
        if (version < 1 || !state.workflows || state.workflows.length === 0) {
          return { ...state, workflows: BUILT_IN_WORKFLOWS, executions: [], activeExecutionId: null }
        }
        // Ensure built-ins are present (may have been added in updates)
        const existingIds = new Set(state.workflows.map((w: any) => w.id))
        const missingBuiltIns = BUILT_IN_WORKFLOWS.filter(w => !existingIds.has(w.id))
        return {
          ...state,
          workflows: [...missingBuiltIns, ...state.workflows],
        }
      },
      partialize: (state) => ({
        workflows: state.workflows,
        executions: state.executions.slice(0, MAX_EXECUTION_HISTORY),
        // Don't persist activeExecutionId
      }),
    }
  )
)
