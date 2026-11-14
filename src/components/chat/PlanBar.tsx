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
// How it looks (David, 14.11.2026: "Claude Code is not a glass surface, it is
// integrated into the chat much more cleanly"): no card, no shadow, no frame.
// It is a plain list in the flow of the chat, on the left edge of the answer
// text and in its size, under one hairline. Because it sticks to the
// bottom of the transcript and text scrolls under it, it carries the
// transcript's own colour (`lu-chat-scrim`, index.css: the pane, light and
// dark), so it reads as the page and not as a sheet on top of it.
//
// One row per step: open (empty circle), running (spinner, full text colour),
// done (tick, muted; no strike-through, a finished step steps back instead of
// being crossed out). Exactly one row runs: a model that marks two steps
// `in_progress` gets the first one shown as running and the other as open,
// never as done (a typo must not tick off work). The model replaces the whole
// list on every `todo_write`, so a changed plan replaces this list whole.
//
// No count anywhere (David, 14.11.2026): the head says "Plan", the ticks say
// how far it is. Collapsible to one line ("Plan · the step that runs"); the
// line is the list's own first line, so folding moves nothing sideways. When
// the run is over a closing line sits under the list only when something is
// left: changes still waiting for approval, or a run that ended with steps
// open, with "Continue" and "Clear plan". A plan that is through stays as it
// is, every step ticked, until the user writes again; then it leaves the chat
// and keeps a folded "Plan" row at its answer (PlanHistoryRow, lib/plan-pin.ts).

import { useMemo, useState, type ReactNode } from 'react'
import { AlertCircle, Check, Circle, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react'
import { useTodoStore, type TodoItem } from '../../stores/todoStore'
import { useCodexStore } from '../../stores/codexStore'
import { useChatStore } from '../../stores/chatStore'
import { planHistory, retiredAt } from '../../lib/plan-pin'
import type { Message } from '../../types/chat'
import { useGenerationStore } from '../../stores/generationStore'
import { useStagedChangesStore } from '../../stores/stagedChangesStore'
import { runStatusFrom } from '../../lib/run-idle'
import { isRunQueued } from '../../lib/run-lanes'
import { isRunStopped } from '../../lib/run-stop'
import { isActiveCodexStatus } from '../../types/codex'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { ICON_SM } from '../ui/icon-size'

/** The line under a finished plan, and only while changes wait for approval:
 *  ticking off a step is not the same as the change being on disk. A plan
 *  that is through with nothing waiting says nothing more than its count and
 *  the greyed list (David, 14.11.2026: no tick, no "every step done"). */
export function planDoneLabel(pendingChanges: number): string | null {
  if (pendingChanges <= 0) return null
  return `${pendingChanges} change${pendingChanges === 1 ? '' : 's'} still waiting for your approval`
}

/**
 * Was die Liste sagt, wenn der Lauf vorbei ist und der Plan offen blieb.
 *
 * Gemessen am 03.09.2026 im laufenden Build: ein Lauf endete mit vier
 * Schritten, von denen drei abgehakt waren, und die Leiste stand danach
 * unveraendert auf "PLAN 3/4", mit einem Kreisel, der weiterdrehte. Kein Wort
 * davon, dass nichts mehr laeuft. Die Schlusszeile aus `turn-summary.ts` sagt
 * es nur, wenn das Modell selbst nichts geschrieben hat; die Liste sagt es
 * immer. Seit 14.11.2026 ohne Zahlen (David: kein Zaehler, nirgends); welche
 * Schritte offen sind, zeigt die Liste selbst.
 */
export function planStoppedLabel(): string {
  return 'the run ended before every step was done'
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

/** The list's own name, the only word in its head (David, 14.11.2026: no
 *  count, not while it runs and not at the end; the ticks say it). */
export const PLAN_TITLE = 'Plan'

/**
 * The three greys of the list, written as the full text colour thinned out
 * and not as `text-gray-N`. The contrast rescue in index.css redraws the plain
 * grey utilities per theme (a `text-gray-400` is gray-700 in light mode, a
 * `text-gray-700` is gray-500 in dark mode and beats its `dark:` partner), so
 * three steps of grey would arrive as one. Worked out against the pane
 * colour, `quiet` comes to 4.7:1 in light and 4.3:1 in dark, so a finished
 * step is muted and still readable.
 */
const TONE = {
  strong: 'text-gray-900 dark:text-gray-50',
  normal: 'text-gray-900/80 dark:text-gray-50/70',
  quiet: 'text-gray-900/60 dark:text-gray-50/45',
} as const

/** A row's text colour. The running step stands out by being the darkest
 *  line, not by being bold; a finished one steps back. */
const ROW_TEXT: Record<PlanRowState, string> = {
  done: TONE.quiet,
  running: TONE.strong,
  open: TONE.normal,
}

/** Weight and leading of a line. The size is the scale's 12 px step, the size
 *  of the answers above (`t-control` on the list's box); that class also
 *  brings a control's weight and leading, which a line of text sets back. */
const LINE = 'font-normal leading-normal'

/** The glyph column: 12 px, centred on the first line of its row. */
const GLYPH = 'shrink-0 mt-[3px]'

/** Chevron, close, open circle and tick: present, never louder than the text. */
const GLYPH_QUIET = 'text-gray-900/50 dark:text-gray-50/40'

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
  // Once the user writes again the plan leaves the chat and keeps a folded
  // row at its answer (lib/plan-pin.ts). A boolean, so a streaming answer does
  // not redraw the list on every token.
  const updatedAt = useTodoStore((s) => (conversationId ? s.updatedAt[conversationId] : undefined))
  const retired = useChatStore((s) => {
    if (!conversationId) return false
    const msgs = s.conversations.find((c) => c.id === conversationId)?.messages
    return msgs ? retiredAt(msgs, updatedAt) !== null : false
  })
  // Open unless the user folded it, per chat, in the store (David,
  // 14.11.2026: open by default, a click on the head folds it, and the choice
  // stays with the chat). A running step never folds or unfolds it again, and
  // a redraw of the transcript cannot reset it.
  const open = useTodoStore((s) => (conversationId ? s.planOpen?.[conversationId] !== false : true))
  const setPlanOpen = useTodoStore((s) => s.setPlanOpen)
  const collapsed = !open

  if (!conversationId || !todos || todos.length === 0) return null
  // Gone the moment the user writes, also while the new run starts; a run that
  // writes a plan again brings a new one.
  if (retired) return null

  const states = planRowStates(todos, runActive)
  const done = todos.filter((t) => t.status === 'completed').length
  const allDone = done === todos.length
  const stoppedShort = !allDone && !runActive
  const waiting = planDoneLabel(pending)
  const runningIdx = states.indexOf('running')
  // Collapsed, the one line that matters is what is happening NOW, else the
  // first step still open, else the last one.
  const headline = todos[runningIdx] ?? todos.find((t) => t.status !== 'completed') ?? todos[todos.length - 1]
  const nextOpen = todos.find((t) => t.status !== 'completed')

  const Fold = collapsed ? ChevronRight : ChevronDown

  return (
    // `pl-12` is where the answer text starts (12 px row padding, the 24 px
    // avatar column, its 8 px gap and the text's own 4 px), so the glyphs
    // stand on the text's left edge.
    <div className="lu-chat-scrim sticky bottom-0 z-10 pl-12 pr-3 pt-1.5" data-testid="plan-pinned">
      <div className="t-control border-t border-gray-200 dark:border-white/[0.07] pt-2 pb-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPlanOpen(conversationId, collapsed)}
            aria-expanded={!collapsed}
            title={collapsed ? 'Show every step' : 'Collapse the plan'}
            className="group flex items-center gap-2 min-w-0 flex-1 text-left"
          >
            <Fold size={ICON_SM} className={`shrink-0 ${GLYPH_QUIET} group-hover:text-gray-900 dark:group-hover:text-gray-50 transition-colors`} />
            <span className={`${LINE} min-w-0 truncate`}>
              <span className={TONE.quiet} data-testid="plan-title">
                {PLAN_TITLE}
              </span>
              {/* Folded: the step that runs, with its spinner; through: a tick;
                  ended early: the next open step. No count. */}
              {collapsed && runningIdx >= 0 && (
                <span className={TONE.strong} title={headline.content} data-testid="plan-folded-step">
                  <Loader2 size={ICON_SM} className={`inline ${TONE.strong} animate-spin mx-1.5 -mt-0.5`} />
                  {headline.content}
                </span>
              )}
              {collapsed && runningIdx < 0 && allDone && (
                <Check size={ICON_SM} className={`inline ${GLYPH_QUIET} ml-1.5 -mt-0.5`} data-testid="plan-folded-done" />
              )}
              {collapsed && runningIdx < 0 && !allDone && (
                <span className={TONE.normal} title={headline.content} data-testid="plan-folded-step">
                  {' '}· {headline.content}
                </span>
              )}
            </span>
          </button>
          <button
            type="button"
            onClick={() => clearTodos(conversationId)}
            title="Clear the plan"
            aria-label="Clear the plan"
            className={`flex items-center justify-center w-5 h-5 rounded ${GLYPH_QUIET} hover:text-gray-900 dark:hover:text-gray-50 transition-colors shrink-0`}
          >
            <X size={ICON_SM} />
          </button>
        </div>

        {!collapsed && (
          // Capped so a fifteen-step plan cannot cover the transcript it pins to.
          <PlanSteps todos={todos} states={states} runActive={runActive} />
        )}

        {!runActive && allDone && waiting && (
          <Abschluss testid="plan-changes-waiting" Symbol={AlertCircle}>
            {waiting}.
          </Abschluss>
        )}

        {stoppedShort && (
          <Abschluss testid="plan-run-stopped" Symbol={AlertCircle}>
            {planStoppedLabel()}.
            {nextOpen && <span> Next: {nextOpen.content}</span>}
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {onContinue && (
                <button
                  type="button"
                  onClick={() => onContinue('continue')}
                  data-testid="plan-continue"
                  className="lu-control lu-primary"
                >
                  Continue
                </button>
              )}
              <button
                type="button"
                onClick={() => clearTodos(conversationId)}
                className="lu-control lu-control--outline"
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

/** The steps, one row each: a tick when done, the spinner on the one that
 *  runs, an open circle otherwise. Shared by the pinned plan and the folded
 *  row it leaves in the transcript. */
function PlanSteps({ todos, states, runActive }: { todos: TodoItem[]; states: PlanRowState[]; runActive: boolean }) {
  return (
    // Capped so a fifteen-step plan cannot cover the transcript it pins to.
    <ul className="mt-1 space-y-0.5 max-h-56 overflow-y-auto scrollbar-thin" data-testid="plan-steps">
      {todos.map((t, i) => {
        const state = states[i]
        const halted = !runActive && t.status === 'in_progress'
        return (
          <li key={`${i}-${t.content}`} className="flex items-start gap-2" data-state={state}>
            {state === 'done' ? (
              <Check size={ICON_SM} className={`${GLYPH} ${GLYPH_QUIET}`} />
            ) : state === 'running' ? (
              <Loader2 size={ICON_SM} className={`${GLYPH} ${TONE.strong} animate-spin`} />
            ) : (
              <Circle size={ICON_SM} className={`${GLYPH} ${halted ? HINWEIS_TEXT.ruhig : GLYPH_QUIET}`} />
            )}
            {/* The colour eases over when a step is ticked off; nothing else moves. */}
            <span className={`${LINE} min-w-0 break-words transition-colors duration-[var(--motion-slow)] ${ROW_TEXT[state]}`}>
              {t.content}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * What a plan leaves in the transcript once the user wrote again: one folded
 * line "Plan" under the answer it belonged to, opening to the steps with their
 * ticks. Quiet, the same type and greys as the pinned list; nothing spins,
 * because that run is over.
 */
export function PlanHistoryRow({ todos, className = '' }: { todos: TodoItem[]; className?: string }) {
  const [open, setOpen] = useState(false)
  const Fold = open ? ChevronDown : ChevronRight
  return (
    <div className={`t-control ${className}`} data-testid="plan-history">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Fold the plan' : 'Show the plan'}
        className="group flex items-center gap-2 text-left"
      >
        <Fold size={ICON_SM} className={`shrink-0 ${GLYPH_QUIET} group-hover:text-gray-900 dark:group-hover:text-gray-50 transition-colors`} />
        <span className={`${LINE} ${TONE.quiet} group-hover:text-gray-900 dark:group-hover:text-gray-50 transition-colors`}>{PLAN_TITLE}</span>
      </button>
      {open && <PlanSteps todos={todos} states={planRowStates(todos, false)} runActive={false} />}
    </div>
  )
}

/**
 * The closing line under the list once the run is over: a run that ended with
 * steps open, or changes that still wait for approval. Neither is an error, so
 * no amber (`lib/hinweis.ts`). It is a row like the steps above it, glyph and
 * sentence, with no frame of its own. A plan that is simply through gets none.
 */
function Abschluss({
  testid,
  Symbol,
  children,
}: {
  testid: string
  Symbol: typeof AlertCircle
  children: ReactNode
}) {
  return (
    <div className="mt-1.5 flex items-start gap-2" data-testid={testid}>
      <Symbol size={ICON_SM} className={`${GLYPH} ${HINWEIS_TEXT.ruhig}`} />
      {/* The labels are written mid-sentence (they are tested as such); the
          capital is drawn here, on the first letter of the line. */}
      <div className={`${LINE} min-w-0 break-words text-gray-800 dark:text-gray-200 first-letter:uppercase`}>{children}</div>
    </div>
  )
}

/** Answer id -> the plans that hang under it as folded rows (lib/plan-pin.ts). */
export function usePlanHistory(
  conversationId: string | null | undefined,
  messages: readonly Pick<Message, 'id' | 'role' | 'timestamp' | 'hidden'>[] | undefined,
): Map<string, TodoItem[][]> {
  const todos = useTodoStore((s) => (conversationId ? s.byConversation[conversationId] : undefined))
  const updatedAt = useTodoStore((s) => (conversationId ? s.updatedAt[conversationId] : undefined))
  const archived = useTodoStore((s) => (conversationId ? s.archived?.[conversationId] : undefined))
  return useMemo(
    () => planHistory(messages ?? [], todos, updatedAt, archived),
    [messages, todos, updatedAt, archived],
  )
}
