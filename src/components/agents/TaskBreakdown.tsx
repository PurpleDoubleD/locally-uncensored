import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Circle, Loader2, CheckCircle2, XCircle, ChevronDown, ChevronRight, Wrench } from 'lucide-react'
import { ToolCallCard } from './ToolCallCard'
import type { AgentTask, TaskStatus } from '../../types/agents'

function StatusIcon({ status }: { status: TaskStatus }) {
  switch (status) {
    case 'pending':
      return <Circle size={16} className="text-gray-500 flex-shrink-0" />
    case 'running':
      return <Loader2 size={16} className="text-blue-400 animate-spin flex-shrink-0" />
    case 'completed':
      return <CheckCircle2 size={16} className="text-green-400 flex-shrink-0" />
    case 'failed':
      return <XCircle size={16} className="text-red-400 flex-shrink-0" />
    case 'skipped':
      return <Circle size={16} className="text-gray-600 flex-shrink-0" />
    default:
      return <Circle size={16} className="text-gray-500 flex-shrink-0" />
  }
}

interface Props {
  tasks: AgentTask[]
}

export function TaskBreakdown({ tasks }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (taskId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  if (tasks.length === 0) {
    return (
      <div className="text-[12px] text-gray-500 py-2">
        <div className="flex items-center gap-1.5 text-gray-400 mb-2 font-medium">
          <Wrench size={13} />
          Tasks
        </div>
        <div className="text-center py-3">No tasks yet. The agent will create them as it works</div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 text-[12px] text-gray-400 mb-2 font-medium">
        <Wrench size={13} />
        Tasks ({tasks.filter((t) => t.status === 'completed').length}/{tasks.length})
      </div>
      <div className="space-y-1.5">
        <AnimatePresence initial={false}>
          {tasks.map((task) => (
            <motion.div
              key={task.id}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
            >
              <div
                onClick={() => task.toolCalls.length > 0 && toggle(task.id)}
                className={`flex items-start gap-2 p-2 rounded-lg transition-colors text-[0.8rem] ${
                  task.toolCalls.length > 0 ? 'cursor-pointer hover:bg-white/5' : ''
                }`}
              >
                <StatusIcon status={task.status} />
                <div className="flex-1 min-w-0">
                  <div className={`leading-tight ${task.status === 'completed' ? 'text-gray-400' : 'text-white'}`}>
                    {task.description}
                  </div>
                  {task.reasoning && (
                    <div className="text-[0.7rem] text-gray-500 mt-0.5 truncate">
                      {task.reasoning}
                    </div>
                  )}
                </div>
                {task.toolCalls.length > 0 && (
                  <div className="flex items-center gap-1 text-[0.65rem] text-gray-500 flex-shrink-0">
                    <span>{task.toolCalls.length} call{task.toolCalls.length !== 1 ? 's' : ''}</span>
                    {expanded.has(task.id) ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </div>
                )}
              </div>

              <AnimatePresence>
                {expanded.has(task.id) && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.15 }}
                    className="ml-6 space-y-1.5 pb-1"
                  >
                    {task.toolCalls.map((tc) => (
                      <ToolCallCard key={tc.id} toolCall={tc} />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}
