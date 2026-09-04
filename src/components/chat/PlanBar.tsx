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
import { AlertCircle, CheckCircle2, Circle, ChevronDown, ChevronRight, Loader2, ListTodo, X } from 'lucide-react'
import { useTodoStore } from '../../stores/todoStore'
import { useChatStore } from '../../stores/chatStore'
import { useCodexStore } from '../../stores/codexStore'
import { useGenerationStore } from '../../stores/generationStore'
import { useStagedChangesStore } from '../../stores/stagedChangesStore'
import { runStatusFrom } from '../../lib/run-idle'
import { isRunQueued } from '../../lib/run-lanes'
import { isRunStopped } from '../../lib/run-stop'
import { isActiveCodexStatus } from '../../types/codex'
import { HINWEIS_TEXT } from '../../lib/hinweis'

/** What the collapsed bar says once the model ticked off every step. Ticking
 *  off a step is not the same as the change being on disk. */
export function planDoneLabel(pendingChanges: number): string {
  if (pendingChanges <= 0) return 'every step done'
  return `every step done, ${pendingChanges} change${pendingChanges === 1 ? '' : 's'} still waiting for your approval`
}

/**
 * Was die Leiste sagt, wenn der Lauf vorbei ist und der Plan offen blieb.
 *
 * Gemessen am 03.09.2026 im laufenden Build: ein Lauf endete mit vier
 * Schritten, von denen drei abgehakt waren, und die Leiste stand danach
 * unveraendert auf "PLAN 3/4", mit dem vierten Punkt als Ueberschrift und,
 * aufgeklappt, einem Kreisel, der weiterdrehte. Kein Wort davon, dass nichts
 * mehr laeuft. Genau so hat eine Persona es gemeldet ("blieb stehen").
 *
 * Die Zahl war dabei richtig: der Aufraeum-Steer in `plan-reconcile.ts` hat
 * ein Budget von zwei, und danach endet der Lauf mit offenem Plan. Die
 * Schlusszeile aus `turn-summary.ts` sagt das auch, aber NUR wenn das Modell
 * selbst nichts geschrieben hat. Schreibt es "fertig, alles erledigt", faellt
 * der Hinweis weg, und genau dann ist er am noetigsten. Die Leiste ist die
 * zweite Stelle, an der es stehen kann, und sie steht immer da.
 */
export function planStoppedLabel(done: number, total: number): string {
  const open = total - done
  return `the run ended here, ${done} of ${total} steps done, ${open} still open`
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
  // Laeuft ueberhaupt noch etwas auf dieser Konversation. Beide Quellen einzeln
  // abonniert, damit die Leiste neu zeichnet, wenn der Lauf endet; das Urteil
  // selbst kommt aus `run-idle.ts`, der einen Stelle, die die zwei Quellen
  // versoehnt (AS-08). `generating` allein ist die Haelfte, die der Stop des
  // Coding-Agenten zuerst loescht.
  const generating = useGenerationStore((s) =>
    activeConversationId ? s.generating[activeConversationId] === true : false,
  )
  const threadStatus = useCodexStore((s) =>
    activeConversationId ? s.threads[activeConversationId]?.status : undefined,
  )
  const runActive = isActiveCodexStatus(
    runStatusFrom(generating, threadStatus, isRunStopped(activeConversationId), isRunQueued(activeConversationId)),
  )
  const [expanded, setExpanded] = useState(panel)

  if (!activeConversationId || !todos || todos.length === 0) return null

  const done = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')
  const allDone = done === todos.length
  // Der Lauf ist vorbei und der Plan ist es nicht. Das ist die Aussage, die
  // vorher nirgends stand.
  const stoppedShort = !allDone && !runActive
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
                  // Ein Kreisel, der sich dreht, behauptet Arbeit. Nach dem Ende
                  // des Laufs ist das eine Behauptung ueber nichts: gemessen
                  // drehte er nach dem letzten Wort des Modells unbegrenzt
                  // weiter. Ohne Lauf steht er still und wird ruhig grau, wie
                  // die Zeile unten, die dasselbe in Worten sagt. (Hier stand
                  // Bernstein. Ein angehaltener Schritt ist kein halber Fehler,
                  // siehe `lib/hinweis.ts`.)
                  <Loader2
                    size={10}
                    className={`shrink-0 mt-[1px] ${runActive ? 'text-blue-400 animate-spin' : HINWEIS_TEXT.ruhig}`}
                  />
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
          <Schlusszeile
            testid="plan-all-done"
            Symbol={CheckCircle2}
            ton={pending > 0 ? 'ruhig' : 'gut'}
            text={planDoneLabel(pending)}
          />
        )}

        {stoppedShort && (
          // Das Gegenstueck zur Zeile darueber, und aus demselben Grund an
          // derselben Stelle: sie steht IMMER, aufgeklappt wie zugeklappt.
          // Zugeklappt las die Leiste sonst "PLAN 3/4" mit dem vierten Punkt
          // daneben und sah aus wie ein Lauf, der gleich weitermacht.
          <Schlusszeile
            testid="plan-run-stopped"
            Symbol={AlertCircle}
            ton="ruhig"
            text={planStoppedLabel(done, todos.length)}
          />
        )}
      </div>
    </div>
  )
}

/**
 * Die eine Zeile unter der Liste, in zwei Toenen.
 *
 * Zusammengelegt, weil es jetzt ZWEI davon gibt (fertiger Plan, abgebrochener
 * Lauf) und zwei Abschriften derselben Zeile genau so auseinanderlaufen, wie
 * es die Typo-Sperrklinke beschreibt: die zweite entsteht durch Abschreiben
 * der ersten und bringt frische Umgehungen mit. Eine Groessenangabe, ein
 * Abstand, zwei Toene.
 *
 * Die zwei Toene sind `gut` (der Plan ist durch) und `ruhig`. Vorher hiess der
 * zweite `warnung` und war bernsteinfarben, an beiden Stellen zu Unrecht:
 * weder ein Lauf, der endet, noch eine Aenderung, die auf Freigabe wartet, ist
 * ein Fehler. Ruhig ist derselbe Ton wie sekundaerer Text, `lib/hinweis.ts`.
 */
function Schlusszeile({
  testid,
  Symbol,
  ton,
  text,
}: {
  testid: string
  Symbol: typeof CheckCircle2
  ton: 'gut' | 'ruhig'
  text: string
}) {
  const farbe = ton === 'gut' ? 'text-emerald-400' : HINWEIS_TEXT.ruhig
  return (
    <div className={`px-2 pb-1 flex items-center gap-1.5 ${farbe}`} data-testid={testid}>
      <Symbol size={9} className="shrink-0" />
      <span className="text-[0.55rem] leading-snug">{text}</span>
    </div>
  )
}
