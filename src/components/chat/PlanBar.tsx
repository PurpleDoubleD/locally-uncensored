// The model's own plan for the current task, pinned under the newest message.
//
// On a long run the transcript scrolls away and the user is left guessing which
// step the agent is on and whether it still remembers the goal. The agent writes
// this list through `todo_write` and keeps it current, so progress is one glance
// instead of a scroll back through twenty tool calls.
//
// Where it lives (CA, 13.11.2026, David: "wie in der Claude-Code-Desktop-App"):
// at the END of the transcript, right under the newest message, in both the
// LU tab (Chat and Agent, MessageList) and the Code tab (CodexView). It is
// `sticky bottom-0` inside the transcript's own scroll box, so while the run
// writes it moves down with the conversation, and a reader who scrolls up still
// has it at the bottom edge of the transcript. Before this it sat in two other
// homes: a band above the transcript (LU tab) and the bottom of the Explorer
// column (Code tab). The right column no longer shows it; the plan APPROVAL
// card stays there (PlanApprovalBar), because that is a question with its own
// button, not progress.
//
// It is still never inside the prompt window. The owner asked for that five
// times (last 2026-08-22), and `the-prompt-window-is-the-prompt-window.test.ts`
// keeps it: the plan is part of the transcript, not of the composer.
//
// One row per step: open (empty circle), running (spinner, bold), done (tick,
// muted and struck through). Exactly one row runs: a model that marks two
// steps `in_progress` gets the first one shown as running and the other as
// open, never as done (a typo must not tick off work). The model replaces the
// whole list on every `todo_write`, so a changed plan replaces this list whole.
//
// Collapsible to one line ("3 of 5 done" and the step that runs). When the run
// is over, a short closing box sits under the list: the plan is done (and
// whether changes still wait for approval), or the run ended with steps open,
// with "Continue" and "Clear plan".

import { useState, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Circle, ChevronDown, ChevronRight, Loader2, ListTodo, X } from 'lucide-react'
import { useTodoStore, type TodoItem } from '../../stores/todoStore'
import { useCodexStore } from '../../stores/codexStore'
import { useGenerationStore } from '../../stores/generationStore'
import { useStagedChangesStore } from '../../stores/stagedChangesStore'
import { runStatusFrom } from '../../lib/run-idle'
import { isRunQueued } from '../../lib/run-lanes'
import { isRunStopped } from '../../lib/run-stop'
import { isActiveCodexStatus } from '../../types/codex'
import { HINWEIS_TEXT } from '../../lib/hinweis'

/** What the closing box says once the model ticked off every step. Ticking
 *  off a step is not the same as the change being on disk. */
export function planDoneLabel(pendingChanges: number): string {
  if (pendingChanges <= 0) return 'every step done'
  return `every step done, ${pendingChanges} change${pendingChanges === 1 ? '' : 's'} still waiting for your approval`
}

/**
 * Was die Liste sagt, wenn der Lauf vorbei ist und der Plan offen blieb.
 *
 * Gemessen am 03.09.2026 im laufenden Build: ein Lauf endete mit vier
 * Schritten, von denen drei abgehakt waren, und die Leiste stand danach
 * unveraendert auf "PLAN 3/4", mit einem Kreisel, der weiterdrehte. Kein Wort
 * davon, dass nichts mehr laeuft. Die Schlusszeile aus `turn-summary.ts` sagt
 * es nur, wenn das Modell selbst nichts geschrieben hat; die Liste sagt es
 * immer.
 */
export function planStoppedLabel(done: number, total: number): string {
  const open = total - done
  return `the run ended here, ${done} of ${total} steps done, ${open} still open`
}

export type PlanRowState = 'done' | 'running' | 'open'

/**
 * The state each row shows. Exactly one row runs, and only while the run does:
 * the first `in_progress` one. A second `in_progress` reads as open, never as
 * done. After the run nothing spins: the step that was running reads as
 * stopped (`open`, with the quiet tone the caller adds).
 */
export function planRowStates(todos: TodoItem[], runActive: boolean): PlanRowState[] {
  let running = false
  return todos.map((t) => {
    if (t.status === 'completed') return 'done'
    if (t.status === 'in_progress' && runActive && !running) {
      running = true
      return 'running'
    }
    return 'open'
  })
}

/** "3 of 5 done", the collapsed line's count. */
export function planCountLabel(todos: TodoItem[]): string {
  const done = todos.filter((t) => t.status === 'completed').length
  return `${done} of ${todos.length} done`
}

interface Props {
  conversationId: string | null | undefined
  /** Sends a message in this chat; the "Continue" button uses it. */
  onContinue?: (text: string) => void
}

export function PlanBar({ conversationId, onContinue }: Props) {
  const todos = useTodoStore((s) => (conversationId ? s.byConversation[conversationId] : undefined))
  // Ticking off every step is not the same as the work being on disk. In
  // Stage-and-Approve the writes wait in the queue, and Morgan read "every step
  // done" on a run whose six file changes had all been refused (2026-08-11).
  const pending = useStagedChangesStore((s) => (conversationId ? (s.byChat[conversationId]?.length ?? 0) : 0))
  const clearTodos = useTodoStore((s) => s.clearTodos)
  // Is anything still running in this conversation. Both sources subscribed
  // on their own so the list redraws when the run ends; the verdict comes from
  // `run-idle.ts` (AS-08). `generating` alone is the half that the coding
  // agent's stop clears first.
  const generating = useGenerationStore((s) => (conversationId ? s.generating[conversationId] === true : false))
  const threadStatus = useCodexStore((s) => (conversationId ? s.threads[conversationId]?.status : undefined))
  const runActive = isActiveCodexStatus(
    runStatusFrom(generating, threadStatus, isRunStopped(conversationId), isRunQueued(conversationId)),
  )
  const [collapsed, setCollapsed] = useState(false)

  if (!conversationId || !todos || todos.length === 0) return null

  const states = planRowStates(todos, runActive)
  const done = todos.filter((t) => t.status === 'completed').length
  const allDone = done === todos.length
  const stoppedShort = !allDone && !runActive
  const runningIdx = states.indexOf('running')
  // Collapsed, the one line that matters is what is happening NOW, else the
  // first step still open, else the last one.
  const headline = todos[runningIdx] ?? todos.find((t) => t.status !== 'completed') ?? todos[todos.length - 1]
  const nextOpen = todos.find((t) => t.status !== 'completed')

  return (
    <div className="sticky bottom-0 z-10 px-3 pt-2 pb-1" data-testid="plan-pinned">
      <div className="rounded-lg lu-elevated overflow-hidden">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            title={collapsed ? 'Show every step' : 'Collapse the plan'}
            className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
          >
            {collapsed ? (
              <ChevronRight size={12} className="text-gray-400 dark:text-gray-500 shrink-0" />
            ) : (
              <ChevronDown size={12} className="text-gray-400 dark:text-gray-500 shrink-0" />
            )}
            <ListTodo size={12} className="text-gray-500 dark:text-gray-400 shrink-0" />
            <span className="t-micro font-medium text-gray-700 dark:text-gray-200 shrink-0" data-testid="plan-count">
              {planCountLabel(todos)}
            </span>
            {collapsed && (
              <span className="flex-1 min-w-0 truncate t-micro text-gray-600 dark:text-gray-300" title={headline.content}>
                · {headline.content}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => clearTodos(conversationId)}
            title="Clear the plan"
            aria-label="Clear the plan"
            className="flex items-center justify-center w-5 h-5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors shrink-0"
          >
            <X size={11} />
          </button>
        </div>

        {!collapsed && (
          // Capped so a fifteen-step plan cannot cover the transcript it pins to.
          <ul className="px-2.5 pb-2 space-y-1 max-h-56 overflow-y-auto scrollbar-thin" data-testid="plan-steps">
            {todos.map((t, i) => {
              const state = states[i]
              const halted = !runActive && t.status === 'in_progress'
              return (
                <li key={`${i}-${t.content}`} className="flex items-start gap-2" data-state={state}>
                  {state === 'done' ? (
                    <CheckCircle2 size={13} className="text-gray-400 dark:text-gray-500 shrink-0 mt-[1px]" />
                  ) : state === 'running' ? (
                    <Loader2 size={13} className="text-gray-700 dark:text-gray-200 animate-spin shrink-0 mt-[1px]" />
                  ) : (
                    <Circle size={13} className={`shrink-0 mt-[1px] ${halted ? HINWEIS_TEXT.ruhig : 'text-gray-300 dark:text-gray-600'}`} />
                  )}
                  <span
                    className={`t-control leading-snug ${
                      state === 'done'
                        ? 'text-gray-400 dark:text-gray-500 line-through'
                        : state === 'running'
                          ? 'text-gray-900 dark:text-gray-50 font-medium'
                          : 'text-gray-600 dark:text-gray-300'
                    }`}
                  >
                    {t.content}
                  </span>
                </li>
              )
            })}
          </ul>
        )}

        {!runActive && allDone && (
          <Abschluss testid="plan-all-done" Symbol={CheckCircle2} ton={pending > 0 ? 'ruhig' : 'gut'}>
            <span className="first-letter:uppercase inline-block">{planDoneLabel(pending)}.</span>
          </Abschluss>
        )}

        {stoppedShort && (
          <Abschluss testid="plan-run-stopped" Symbol={AlertCircle} ton="ruhig">
            <span className="first-letter:uppercase inline-block">{planStoppedLabel(done, todos.length)}.</span>
            {nextOpen && <span> Next: {nextOpen.content}</span>}
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {onContinue && (
                <button
                  type="button"
                  onClick={() => onContinue('continue')}
                  data-testid="plan-continue"
                  className="lu-control lu-primary px-3 t-control font-medium"
                >
                  Continue
                </button>
              )}
              <button
                type="button"
                onClick={() => clearTodos(conversationId)}
                className="lu-control px-3 t-control text-gray-800 dark:text-gray-100 border border-gray-300 dark:border-white/15 hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors"
              >
                Clear plan
              </button>
            </div>
          </Abschluss>
        )}
      </div>
    </div>
  )
}

/**
 * The closing box under the list once the run is over, in two tones: `gut`
 * (the plan is through) and `ruhig`. Neither a run that ends nor a change that
 * waits for approval is an error, so no amber (`lib/hinweis.ts`).
 */
function Abschluss({
  testid,
  Symbol,
  ton,
  children,
}: {
  testid: string
  Symbol: typeof CheckCircle2
  ton: 'gut' | 'ruhig'
  children: ReactNode
}) {
  const farbe = ton === 'gut' ? 'text-emerald-600 dark:text-emerald-400' : HINWEIS_TEXT.ruhig
  return (
    <div className="border-t border-gray-200 dark:border-white/[0.06] px-2.5 py-2 flex items-start gap-2" data-testid={testid}>
      <Symbol size={13} className={`shrink-0 mt-[1px] ${farbe}`} />
      <div className="t-control leading-snug text-gray-700 dark:text-gray-200 min-w-0">{children}</div>
    </div>
  )
}
