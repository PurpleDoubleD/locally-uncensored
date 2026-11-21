import { create } from 'zustand'

/**
 * Which answers a run can still write into, by message id. Not persisted: after
 * a restart no run is left, so every answer is free again.
 *
 * `generating[id]` (generationStore) cannot answer this. Stop clears it at
 * once, while the stopped run can still put its last text, its stop note or an
 * error into the bubble. An edit saved in that gap would be overwritten.
 */
interface ReplyWriteState {
  open: Record<string, number>
}

export const useReplyWriteStore = create<ReplyWriteState>(() => ({ open: {} }))

/** The run starts writing this answer. Returns its end, safe to call twice. */
export function beginReplyWrite(messageId: string): () => void {
  useReplyWriteStore.setState((s) => ({ open: { ...s.open, [messageId]: (s.open[messageId] ?? 0) + 1 } }))
  let ended = false
  return () => {
    if (ended) return
    ended = true
    useReplyWriteStore.setState((s) => {
      const open = { ...s.open }
      const left = (open[messageId] ?? 1) - 1
      if (left > 0) open[messageId] = left
      else delete open[messageId]
      return { open }
    })
  }
}
