import { useEffect, useState } from 'react'
import { Loader2, Check, X, Circle, Send, Square } from 'lucide-react'
import { useAgentWorkflowStore } from '../../stores/agentWorkflowStore'
import { Hinweis } from '../ui/Hinweis'
import type { StepStatus } from '../../types/agent-workflows'

const STATUS_ICONS: Record<StepStatus | 'waiting', typeof Check> = {
  pending: Circle,
  running: Loader2,
  completed: Check,
  failed: X,
  skipped: Circle,
  waiting: Loader2,
}

// `waiting` war gelb und stand damit zwischen „laeuft" und „kaputt", als gaebe
// es einen halben Fehler. Es gibt keinen: der Lauf laeuft, er haengt nur an
// einer Eingabe. Also dieselbe Farbe wie `running`. Was die beiden trennt, ist
// die Bewegung (Puls statt Drehung) und die Frage, die darunter steht.
const STATUS_COLORS: Record<StepStatus | 'waiting', string> = {
  pending: 'text-gray-600',
  running: 'text-blue-400 animate-spin',
  completed: 'text-green-400',
  failed: 'text-red-400',
  skipped: 'text-gray-600',
  waiting: 'text-blue-400 animate-pulse',
}

interface WorkflowRunnerProps {
  executionId: string
  workflowSteps: Array<{ id: string; label: string; type: string }>
  waitingForInput: string | null
  onProvideInput: (input: string) => void
  onCancel: () => void
}

export function WorkflowRunner({
  executionId,
  workflowSteps,
  waitingForInput,
  onProvideInput,
  onCancel,
}: WorkflowRunnerProps) {
  const execution = useAgentWorkflowStore((s) => s.executions.find(e => e.id === executionId))
  const [inputValue, setInputValue] = useState('')

  // The clock the "Running… Ns" line divides by. It used to be `Date.now()`
  // read straight from the render body — impure (React 19 `purity`), and it
  // only advanced when the store happened to push a step update, so a slow
  // step froze the counter. A one-second tick while the run is live says the
  // same thing honestly; a finished run needs no clock at all.
  const live = execution?.status === 'running' || execution?.status === 'waiting_input'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live, executionId])

  if (!execution) return null

  const handleSubmitInput = () => {
    if (!inputValue.trim()) return
    onProvideInput(inputValue.trim())
    setInputValue('')
  }

  const elapsed = execution.completedAt
    ? Math.round((execution.completedAt - execution.startedAt) / 1000)
    : Math.max(0, Math.round((now - execution.startedAt) / 1000))

  return (
    <div className="space-y-3 p-3 rounded-lg border border-white/10 bg-white/[0.02]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[0.7rem] font-medium text-gray-200">{execution.workflowName}</p>
          <p className="t-micro text-gray-500">
            {execution.status === 'running' || execution.status === 'waiting_input'
              ? `Running... ${elapsed}s`
              : execution.status === 'completed'
                ? `Completed in ${elapsed}s`
                : execution.status === 'failed'
                  ? `Failed after ${elapsed}s`
                  : execution.status === 'cancelled'
                    ? 'Cancelled'
                    : execution.status}
          </p>
        </div>
        {(execution.status === 'running' || execution.status === 'waiting_input') && (
          <button
            onClick={onCancel}
            className="p-1 rounded hover:bg-red-500/20 text-gray-500 hover:text-red-400"
            title="Cancel"
          >
            <Square size={12} />
          </button>
        )}
      </div>

      {/* Step progress */}
      <div className="space-y-1">
        {workflowSteps.map((step, index) => {
          const result = execution.stepResults.find(r => r.stepId === step.id)
          let status: StepStatus | 'waiting' = 'pending'
          if (result) {
            status = result.status
          } else if (index === execution.currentStepIndex && execution.status === 'waiting_input') {
            status = 'waiting'
          } else if (index === execution.currentStepIndex && execution.status === 'running') {
            status = 'running'
          }

          const Icon = STATUS_ICONS[status]

          return (
            <div key={step.id} className="flex items-start gap-2">
              <Icon size={11} className={`mt-0.5 shrink-0 ${STATUS_COLORS[status]}`} />
              <div className="flex-1 min-w-0">
                <p className={`t-micro ${status === 'completed' || status === 'running' || status === 'waiting' ? 'text-gray-300' : 'text-gray-500'}`}>
                  {step.label}
                </p>
                {result?.output && status === 'completed' && (
                  <p className="t-micro text-gray-500 truncate mt-0.5">
                    {result.output.substring(0, 100)}
                  </p>
                )}
                {result?.error && (
                  <p className="t-micro text-red-400/70 mt-0.5">{result.error}</p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* User input prompt */}
      {waitingForInput && (
        <div className="space-y-1.5 pt-1 border-t border-white/5">
          {/* Das ist die Frage an den Nutzer, keine Warnung. Sie gehoert zum
              Feld darunter und traegt deshalb dessen Textfarbe. */}
          <p className="t-micro text-gray-200">{waitingForInput}</p>
          <div className="flex gap-1.5">
            <input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmitInput()}
              placeholder="Type your input..."
              className="flex-1 px-2 py-1 rounded bg-white/5 border border-white/10 text-[0.7rem] text-gray-300 placeholder-gray-600 focus:outline-none focus:border-white/20"
              autoFocus
            />
            <button
              onClick={handleSubmitInput}
              className="px-2 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors"
            >
              <Send size={11} />
            </button>
          </div>
        </div>
      )}

      {/* Error. Der Kasten um die Zeile ist weg: die rote Schrift sagt schon
          alles, was Rahmen und Fuellflaeche dazutun sollten. */}
      {execution.error && (
        <Hinweis ton="fehler">{execution.error}</Hinweis>
      )}
    </div>
  )
}
