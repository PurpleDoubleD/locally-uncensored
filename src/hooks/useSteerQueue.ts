/**
 * The composer's side of steering a run (CA U2).
 *
 * While a run goes, Enter queues the message (stores/steerStore); the loop
 * reads it after the current tool step. A run that ends before it read them
 * (the model answered without another tool) sends what is left as the next
 * message, so nothing the user wrote is lost.
 */
import { useEffect, useRef } from 'react'
import { useSteerStore, type QueuedSteer } from '../stores/steerStore'

const EMPTY: QueuedSteer[] = []

export function useSteerQueue(
  convId: string | null,
  running: boolean,
  enabled: boolean,
  sendNext: (text: string) => void,
): { queue: QueuedSteer[]; steer?: (text: string) => void; unsteer: (id: string) => void } {
  const queue = useSteerStore((s) => (convId ? s.queue[convId] ?? EMPTY : EMPTY))
  const send = useRef(sendNext)
  useEffect(() => { send.current = sendNext })

  // Whatever is left in this chat's queue while nothing runs here goes out as
  // the next message. Not only at the moment a run ends while this view
  // watches it: a user who queued a line, switched chats or tabs and came back
  // found it gone for good, because the old rule fired on the running-to-idle
  // edge alone, and that edge happened while another view was mounted (CA,
  // support case "answers once, then never again"). Now any idle moment with a
  // non-empty queue sends it, on mount and on a chat switch back too.
  useEffect(() => {
    if (running || !convId || queue.length === 0) return
    const left = useSteerStore.getState().take(convId)
    if (left.length) send.current(left.map((m) => m.text).join('\n\n'))
  }, [running, convId, queue.length])

  return {
    queue,
    steer: enabled && convId ? (text: string) => useSteerStore.getState().add(convId, text) : undefined,
    unsteer: (id: string) => { if (convId) useSteerStore.getState().remove(convId, id) },
  }
}
