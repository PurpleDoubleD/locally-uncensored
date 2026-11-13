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
  const wasRunning = useRef(running)
  const send = useRef(sendNext)
  useEffect(() => { send.current = sendNext })

  useEffect(() => {
    const ended = wasRunning.current && !running
    wasRunning.current = running
    if (!ended || !convId) return
    const left = useSteerStore.getState().take(convId)
    if (left.length) send.current(left.map((m) => m.text).join('\n\n'))
  }, [running, convId])

  return {
    queue,
    steer: enabled && convId ? (text: string) => useSteerStore.getState().add(convId, text) : undefined,
    unsteer: (id: string) => { if (convId) useSteerStore.getState().remove(convId, id) },
  }
}
