import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import { Plus, Trash2, ChevronUp, ChevronDown, Save, X, ArrowLeft } from 'lucide-react'
import { useAgentWorkflowStore } from '../../stores/agentWorkflowStore'
import { AGENT_TOOL_DEFS } from '../../api/tool-registry'
import { GlowButton } from '../ui/GlowButton'
import type { WorkflowStep, WorkflowStepType } from '../../types/agent-workflows'
import type { MemoryType } from '../../types/agent-mode'

const STEP_TYPE_LABELS: Record<WorkflowStepType, string> = {
  prompt: 'Prompt',
  tool: 'Tool',
  condition: 'Condition',
  loop: 'Loop',
  user_input: 'User Input',
  memory_save: 'Save to Memory',
}

const STEP_TYPE_COLORS: Record<WorkflowStepType, string> = {
  prompt: 'border-blue-500/30 bg-blue-500/5',
  tool: 'border-green-500/30 bg-green-500/5',
  condition: 'border-amber-500/30 bg-amber-500/5',
  loop: 'border-purple-500/30 bg-purple-500/5',
  user_input: 'border-cyan-500/30 bg-cyan-500/5',
  memory_save: 'border-pink-500/30 bg-pink-500/5',
}

function createEmptyStep(type: WorkflowStepType): WorkflowStep {
  const base: WorkflowStep = { id: uuid(), type, label: STEP_TYPE_LABELS[type] }
  switch (type) {
    case 'prompt': return { ...base, prompt: '', allowedTools: [] }
    case 'tool': return { ...base, toolName: '', toolArgTemplates: {} }
    case 'condition': return { ...base, condition: { source: 'last_output', operator: 'contains', value: '', thenStepId: '', elseStepId: '' } }
    case 'loop': return { ...base, loop: { maxIterations: 5, condition: { source: 'last_output', operator: 'truthy', value: '' }, bodyStepIds: [] } }
    case 'user_input': return { ...base, userInputPrompt: '' }
    case 'memory_save': return { ...base, memorySave: { type: 'reference', titleTemplate: '', contentTemplate: '{{last_output}}', tags: [] } }
    default: return base
  }
}

interface WorkflowBuilderProps {
  workflowId?: string  // undefined = create new
  onSave: () => void
  onCancel: () => void
}

export function WorkflowBuilder({ workflowId, onSave, onCancel }: WorkflowBuilderProps) {
  const store = useAgentWorkflowStore()
  const existing = workflowId ? store.getWorkflow(workflowId) : undefined

  const [name, setName] = useState(existing?.name || '')
  const [description, setDescription] = useState(existing?.description || '')
  const [steps, setSteps] = useState<WorkflowStep[]>(existing?.steps || [])
  const [expandedStep, setExpandedStep] = useState<string | null>(null)

  const addStep = (type: WorkflowStepType) => {
    const newStep = createEmptyStep(type)
    setSteps([...steps, newStep])
    setExpandedStep(newStep.id)
  }

  const removeStep = (id: string) => {
    setSteps(steps.filter(s => s.id !== id))
    if (expandedStep === id) setExpandedStep(null)
  }

  const moveStep = (index: number, direction: -1 | 1) => {
    const newIndex = index + direction
    if (newIndex < 0 || newIndex >= steps.length) return
    const arr = [...steps]
    ;[arr[index], arr[newIndex]] = [arr[newIndex], arr[index]]
    setSteps(arr)
  }

  const updateStep = (id: string, updates: Partial<WorkflowStep>) => {
    setSteps(steps.map(s => s.id === id ? { ...s, ...updates } : s))
  }

  const handleSave = () => {
    if (!name.trim()) return

    if (workflowId && existing) {
      store.updateWorkflow(workflowId, { name, description, steps })
    } else {
      store.addWorkflow({
        name,
        description,
        icon: 'Zap',
        steps,
        variables: {},
        isBuiltIn: false,
      })
    }
    onSave()
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <button onClick={onCancel} className="p-1 rounded hover:bg-white/10 text-gray-400">
          <ArrowLeft size={14} />
        </button>
        <h3 className="text-[12px] font-semibold text-white">
          {workflowId ? 'Edit Workflow' : 'New Workflow'}
        </h3>
      </div>

      {/* Name & Description */}
      <div className="space-y-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Workflow name"
          className="w-full px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[0.7rem] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/20"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
          className="w-full px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[0.7rem] text-gray-400 placeholder-gray-600 focus:outline-none focus:border-white/20"
        />
      </div>

      {/* Steps */}
      <div className="space-y-1.5">
        <p className="text-[0.6rem] text-gray-500 uppercase tracking-wider">Steps</p>

        {steps.map((step, index) => (
          <div key={step.id} className={`rounded-lg border ${STEP_TYPE_COLORS[step.type]} transition-all`}>
            {/* Step header */}
            <div
              className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer"
              onClick={() => setExpandedStep(expandedStep === step.id ? null : step.id)}
            >
              <span className="text-[0.6rem] text-gray-500 w-4 text-center">{index + 1}</span>
              <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-white/5 text-gray-400">
                {STEP_TYPE_LABELS[step.type]}
              </span>
              <span className="text-[0.65rem] text-gray-300 flex-1 truncate">{step.label}</span>
              <div className="flex items-center gap-0.5">
                <button onClick={(e) => { e.stopPropagation(); moveStep(index, -1) }} className="p-0.5 rounded hover:bg-white/10 text-gray-600" disabled={index === 0}>
                  <ChevronUp size={10} />
                </button>
                <button onClick={(e) => { e.stopPropagation(); moveStep(index, 1) }} className="p-0.5 rounded hover:bg-white/10 text-gray-600" disabled={index === steps.length - 1}>
                  <ChevronDown size={10} />
                </button>
                <button onClick={(e) => { e.stopPropagation(); removeStep(step.id) }} className="p-0.5 rounded hover:bg-red-500/20 text-gray-600 hover:text-red-400">
                  <Trash2 size={10} />
                </button>
              </div>
            </div>

            {/* Expanded step editor */}
            {expandedStep === step.id && (
              <div className="px-2.5 pb-2.5 space-y-2 border-t border-white/5">
                <input
                  value={step.label}
                  onChange={(e) => updateStep(step.id, { label: e.target.value })}
                  placeholder="Step label"
                  className="w-full px-2 py-1 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 placeholder-gray-600 focus:outline-none mt-2"
                />

                {/* Type-specific fields */}
                {step.type === 'prompt' && (
                  <textarea
                    value={step.prompt || ''}
                    onChange={(e) => updateStep(step.id, { prompt: e.target.value })}
                    placeholder="Prompt text (use {{variable}} for interpolation)"
                    rows={3}
                    className="w-full px-2 py-1 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 placeholder-gray-600 focus:outline-none resize-none"
                  />
                )}

                {step.type === 'tool' && (
                  <>
                    <select
                      value={step.toolName || ''}
                      onChange={(e) => updateStep(step.id, { toolName: e.target.value })}
                      className="w-full px-2 py-1 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 focus:outline-none"
                    >
                      <option value="">Select tool...</option>
                      {AGENT_TOOL_DEFS.map(t => (
                        <option key={t.name} value={t.name}>{t.name}</option>
                      ))}
                    </select>
                    <input
                      value={step.toolArgTemplates ? JSON.stringify(step.toolArgTemplates) : ''}
                      onChange={(e) => {
                        // Halb getippter JSON ist der Normalfall, nicht der
                        // Fehlerfall: das Feld wird bei JEDEM Tastendruck
                        // geparst, und `{"q"` ist auf dem Weg zu `{"q": 1}`
                        // unvermeidlich ungueltig. Der letzte gueltige Stand
                        // bleibt stehen, bis wieder einer da ist — deshalb
                        // wird hier nichts gemeldet und nichts gesetzt.
                        try { updateStep(step.id, { toolArgTemplates: JSON.parse(e.target.value) }) } catch { /* siehe oben */ }
                      }}
                      placeholder='Args JSON: {"query": "{{user_input}}"}'
                      className="w-full px-2 py-1 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 placeholder-gray-600 focus:outline-none"
                    />
                  </>
                )}

                {step.type === 'user_input' && (
                  <input
                    value={step.userInputPrompt || ''}
                    onChange={(e) => updateStep(step.id, { userInputPrompt: e.target.value })}
                    placeholder="Prompt shown to user"
                    className="w-full px-2 py-1 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 placeholder-gray-600 focus:outline-none"
                  />
                )}

                {step.type === 'memory_save' && (
                  <>
                    <select
                      value={step.memorySave?.type || 'reference'}
                      onChange={(e) => updateStep(step.id, { memorySave: { ...step.memorySave!, type: e.target.value as MemoryType } })}
                      className="w-full px-2 py-1 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 focus:outline-none"
                    >
                      <option value="user">User</option>
                      <option value="feedback">Feedback</option>
                      <option value="project">Project</option>
                      <option value="reference">Reference</option>
                    </select>
                    <input
                      value={step.memorySave?.titleTemplate || ''}
                      onChange={(e) => updateStep(step.id, { memorySave: { ...step.memorySave!, titleTemplate: e.target.value } })}
                      placeholder="Title template: Research: {{user_input}}"
                      className="w-full px-2 py-1 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 placeholder-gray-600 focus:outline-none"
                    />
                  </>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Add step buttons */}
        <div className="flex flex-wrap gap-1 pt-1">
          {(['prompt', 'tool', 'user_input', 'memory_save', 'condition', 'loop'] as WorkflowStepType[]).map(type => (
            <button
              key={type}
              onClick={() => addStep(type)}
              className="text-[0.6rem] px-2 py-0.5 rounded border border-white/10 text-gray-500 hover:text-gray-300 hover:border-white/20 transition-colors"
            >
              <Plus size={8} className="inline mr-0.5" />
              {STEP_TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      </div>

      {/* Save / Cancel */}
      <div className="flex gap-2 pt-2">
        <GlowButton onClick={handleSave} className="flex-1 text-xs flex items-center justify-center gap-1.5" disabled={!name.trim()}>
          <Save size={12} /> Save
        </GlowButton>
        <GlowButton variant="secondary" onClick={onCancel} className="flex-1 text-xs flex items-center justify-center gap-1.5">
          <X size={12} /> Cancel
        </GlowButton>
      </div>
    </div>
  )
}
