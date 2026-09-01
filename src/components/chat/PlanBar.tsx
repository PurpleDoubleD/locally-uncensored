// The model's own plan for the current task.
//
// On a long run the transcript scrolls away and the user is left guessing which
// step the agent is on and whether it still remembers the goal. The agent writes
// this list through `todo_write` and keeps it current, so progress is one glance
// instead of a scroll back through twenty tool calls.
//
// Two homes, and neither one touches the prompt window. David has asked for
// that five times now, last on 2026-08-22: the prompt window is the prompt
// window, nothing about plans may be visible there, on any surface, in any
// state. So there is no composer variant to reach for:
//   - 'header' (LU tab, plain chat and Agent alike): a status band under the
//     header row and above the transcript, next to the other standing status
//     controls. Collapsed to the current step by default, because a ten-item
//     list would push the conversation down.
//   - 'panel' (Code tab): the BOTTOM section of the Explorer column, full
//     column width and expanded by default. Bottom because David read the
//     column top down on 2026-08-22 and the files are what he wants first;
//     the plan is the footer of that column, not its headline.
// Expanded state is per session, not persisted, because a plan is short-lived.

import { useState } from 'react'
import { CheckCircle2, Circle, ChevronDown, ChevronRight, Loader2, ListTodo, X } from 'lucide-react'
import { useTodoStore } from '../../stores/todoStore'
import { useChatStore } from '../../stores/chatStore'
import { useStagedChangesStore } from '../../stores/stagedChangesStore'

/** What the collapsed bar says once the model ticked off every step. Ticking
 *  off a step is not the same as the change being on disk. */
export function planDoneLabel(pendingChanges: number): string {
  if (pendingChanges <= 0) return 'every step done'
  return `every step done, ${pendingChanges} change${pendingChanges === 1 ? '' : 's'} still waiting for your approval`
}

export type PlanBarVariant = 'header' | 'panel'

interface Props {
  variant?: PlanBarVariant
}

export function PlanBar({ variant = 'header' }: Props) {
  const panel = variant === 'panel'
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const todos = useTodoStore((s) =>
    activeConversationId ? s.byConversation[activeConversationId] : undefined,
  )
  // Ticking off every step is not the same as the work being on disk. In
  // Stage-and-Approve the writes wait in the queue, and Morgan read "every step
  // done" on a run whose six file changes had all been refused (2026-08-11).
  const pending = useStagedChangesStore((s) =>
    activeConversationId ? (s.byChat[activeConversationId]?.length ?? 0) : 0,
  )
  const clearTodos = useTodoStore((s) => s.clearTodos)
  const [expanded, setExpanded] = useState(panel)

  if (!activeConversationId || !todos || todos.length === 0) return null

  const done = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')
  const allDone = done === todos.length
  // Collapsed, the one line that matters is what is happening NOW. With nothing
  // in progress (plan written but not started, or everything finished) fall back
  // to the first item that is still open, and only then to the last one.
  const headline = current ?? todos.find((t) => t.status === 'pending') ?? todos[todos.length - 1]

  return (
    <div
      // 'header' sits directly above the transcript, so it rides the SAME
      // measure column and the same px-3 gutter the bubbles use — a band that
      // ran the full window width while the answers below it stopped at 760px
      // read as a second, wider layout stacked on the first. 'panel' is the
      // Code Explorer column and owns its own width, so it keeps out of this.
      className={panel ? 'w-full p-1.5' : 'mx-auto w-full max-w-[var(--lu-measure)] px-3 pt-1'}
      data-testid={panel ? 'plan-panel' : 'plan-header'}
    >
      <div className="w-full rounded-md border border-blue-500/20 bg-blue-500/[0.04]">
        <div className="flex items-center gap-1.5 px-2 py-1">
          <button
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'Collapse the plan' : 'Show every step'}
            className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
          >
            {expanded ? (
              <ChevronDown size={9} className="text-blue-400 shrink-0" />
            ) : (
              <ChevronRight size={9} className="text-blue-400 shrink-0" />
            )}
            <ListTodo size={9} className="text-blue-400 shrink-0" />
            <span className="text-[0.55rem] uppercase tracking-wider text-gray-500 shrink-0">
              plan {done}/{todos.length}
            </span>
            {!expanded && (
              <span
                className="flex-1 min-w-0 truncate t-micro text-gray-700 dark:text-gray-300"
                title={headline.content}
              >
                {headline.content}
              </span>
            )}
          </button>
          <button
            onClick={() => clearTodos(activeConversationId)}
            title="Clear the plan"
            className="flex items-center justify-center w-4 h-4 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors shrink-0"
          >
            <X size={10} />
          </button>
        </div>

        {expanded && (
          // Capped so a fifteen-step plan cannot push the transcript off
          // screen, and in the panel so it cannot push the file tree out of
          // view.
          <ul className={`px-2 pb-1.5 space-y-0.5 overflow-y-auto ${panel ? 'max-h-48 scrollbar-thin' : 'max-h-40'}`}>
            {todos.map((t, i) => (
              <li key={`${i}-${t.content}`} className="flex items-start gap-1.5">
                {t.status === 'completed' ? (
                  <CheckCircle2 size={10} className="text-emerald-400 shrink-0 mt-[1px]" />
                ) : t.status === 'in_progress' ? (
                  <Loader2 size={10} className="text-blue-400 shrink-0 mt-[1px] animate-spin" />
                ) : (
                  <Circle size={10} className="text-gray-600 shrink-0 mt-[1px]" />
                )}
                <span
                  className={`t-micro leading-snug ${
                    t.status === 'completed'
                      ? 'text-gray-500 line-through'
                      : t.status === 'in_progress'
                        ? 'text-gray-800 dark:text-gray-100 font-medium'
                        : 'text-gray-600 dark:text-gray-400'
                  }`}
                >
                  {t.content}
                </span>
              </li>
            ))}
          </ul>
        )}

        {(panel || !expanded) && allDone && (
          // In the header band this is the collapsed summary line. In the panel
          // the list is open by default, so the line has to stay: "every step done"
          // while six writes sit refused in the queue is exactly the sentence
          // Morgan believed.
          <div className="px-2 pb-1 flex items-center gap-1.5" data-testid="plan-all-done">
            <CheckCircle2
              size={9}
              className={`${pending > 0 ? 'text-amber-400' : 'text-emerald-400'} shrink-0`}
            />
            <span
              className={`text-[0.55rem] leading-snug ${pending > 0 ? 'text-amber-400/90' : 'text-emerald-400/80'}`}
            >
              {planDoneLabel(pending)}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
