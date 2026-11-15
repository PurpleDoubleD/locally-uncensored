/**
 * Where a message written during a run enters the run (CA U2).
 *
 * The same place and the same channel as a finished background agent's report
 * (lib/agent-task-report.ts): user material, at the top of an iteration, never
 * between an assistant message with tool_calls and their results. A round that
 * still waits for results keeps the messages for the next one.
 */
import { awaitingToolResults } from '../agent-task-report'
import type { QueuedSteer } from '../../stores/steerStore'

interface Turn {
  role: string
  content?: unknown
  tool_calls?: unknown
}

/** What the model reads. Short, and clear that the task is still the same run. */
export function steerMessage(text: string): string {
  return `The user adds this while you work. Take it into account from now on, then go on:\n${text}`
}

/**
 * Appends the waiting messages to the history and returns them, so the loop
 * can show them in the transcript. Nothing is taken while results are missing.
 */
export function appendSteers<T extends Turn>(
  messages: T[],
  take: () => QueuedSteer[],
  make: (content: string) => T,
): QueuedSteer[] {
  if (awaitingToolResults(messages)) return []
  const items = take()
  for (const item of items) messages.push(make(steerMessage(item.text)))
  return items
}
