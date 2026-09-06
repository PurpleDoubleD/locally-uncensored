// The standing goal (/goal), shown above the composer in Code and in Agent.
//
// A persisted instruction that silently steers every turn is a trap: three days
// later nobody remembers why the agent keeps circling back to the same thing.
// So it is always on screen while it is in force, and always one click from
// gone.

import { X, Target } from 'lucide-react'
import { useAgentGoalStore } from '../../stores/agentGoalStore'
import { useChatStore } from '../../stores/chatStore'
import { COMPOSER_MAX_W } from './composer-width'

export function GoalBar() {
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const goal = useAgentGoalStore((s) => (activeConversationId ? s.goals[activeConversationId] : undefined))
  const clearGoal = useAgentGoalStore((s) => s.clearGoal)

  if (!activeConversationId || !goal?.text) return null

  return (
    <div className={`w-full ${COMPOSER_MAX_W} mx-auto px-3 pb-1 flex justify-center`}>
      <div className="w-full flex items-center gap-1.5 px-2 py-1 rounded-md border border-purple-500/20 bg-purple-500/[0.04]">
        <Target size={9} className="text-purple-400 shrink-0" />
        <span className="text-[0.55rem] uppercase tracking-wider text-gray-500 shrink-0">goal</span>
        <span
          className="flex-1 min-w-0 truncate t-micro text-gray-700 dark:text-gray-300"
          title={goal.text}
        >
          {goal.text}
        </span>
        <button
          onClick={() => clearGoal(activeConversationId)}
          title="Clear the goal for this session"
          className="flex items-center justify-center w-4 h-4 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors shrink-0"
        >
          <X size={10} />
        </button>
      </div>
    </div>
  )
}
