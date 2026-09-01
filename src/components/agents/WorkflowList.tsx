import { useState } from 'react'
import { Play, Pencil, Trash2, Copy, Plus, Search, FileText, Code, Zap } from 'lucide-react'
import { useAgentWorkflowStore } from '../../stores/agentWorkflowStore'
import type { AgentWorkflow } from '../../types/agent-workflows'

// Map workflow icon names to Lucide components
const ICON_MAP: Record<string, typeof Search> = {
  Search, FileText, Code, Zap,
}

interface WorkflowListProps {
  onRun: (workflowId: string) => void
  onEdit: (workflowId: string) => void
  onCreate: () => void
}

export function WorkflowList({ onRun, onEdit, onCreate }: WorkflowListProps) {
  const { workflows, removeWorkflow, duplicateWorkflow } = useAgentWorkflowStore()
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const handleDelete = (id: string) => {
    if (confirmDelete === id) {
      removeWorkflow(id)
      setConfirmDelete(null)
    } else {
      setConfirmDelete(id)
      setTimeout(() => setConfirmDelete(null), 3000)
    }
  }

  const builtIn = workflows.filter(w => w.isBuiltIn)
  const custom = workflows.filter(w => !w.isBuiltIn)

  const renderWorkflow = (workflow: AgentWorkflow) => {
    const Icon = ICON_MAP[workflow.icon] || Zap
    return (
      <div
        key={workflow.id}
        className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-white/[0.03] group border border-transparent hover:border-white/5 transition-colors"
      >
        <div className="w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
          <Icon size={13} className="text-gray-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[0.7rem] font-medium text-gray-200 truncate">{workflow.name}</p>
          <p className="text-[0.6rem] text-gray-500 truncate">{workflow.description}</p>
          <p className="text-[0.55rem] text-gray-600">{workflow.steps.length} steps</p>
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            onClick={() => onRun(workflow.id)}
            className="p-1 rounded hover:bg-green-500/20 text-gray-500 hover:text-green-400"
            title="Run"
          >
            <Play size={11} />
          </button>
          {!workflow.isBuiltIn && (
            <button
              onClick={() => onEdit(workflow.id)}
              className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-gray-300"
              title="Edit"
            >
              <Pencil size={11} />
            </button>
          )}
          <button
            onClick={() => duplicateWorkflow(workflow.id)}
            className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-gray-300"
            title="Duplicate"
          >
            <Copy size={11} />
          </button>
          {!workflow.isBuiltIn && (
            <button
              onClick={() => handleDelete(workflow.id)}
              className={`p-1 rounded text-gray-500 ${confirmDelete === workflow.id ? 'bg-red-500/20 text-red-400' : 'hover:bg-red-500/20 hover:text-red-400'}`}
              title={confirmDelete === workflow.id ? 'Confirm delete' : 'Delete'}
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Built-in workflows */}
      {builtIn.length > 0 && (
        <div className="space-y-1">
          <p className="text-[0.6rem] text-gray-500 uppercase tracking-wider px-1">Built-in</p>
          {builtIn.map(renderWorkflow)}
        </div>
      )}

      {/* Custom workflows */}
      {custom.length > 0 && (
        <div className="space-y-1">
          <p className="text-[0.6rem] text-gray-500 uppercase tracking-wider px-1">Custom</p>
          {custom.map(renderWorkflow)}
        </div>
      )}

      {workflows.length === 0 && (
        <p className="text-[0.7rem] text-gray-500 text-center py-4">No workflows yet.</p>
      )}

      {/* Create button */}
      <button
        onClick={onCreate}
        className="w-full flex items-center justify-center gap-1 py-1.5 rounded-lg bg-white/[0.03] border border-white/10 text-[0.65rem] text-gray-500 hover:text-gray-300 hover:border-white/20 transition-colors"
      >
        <Plus size={10} /> Create Workflow
      </button>
    </div>
  )
}
