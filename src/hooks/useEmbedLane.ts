/**
 * The measured embedding lane, shared by every surface that asks.
 *
 * One measurement per app, not one per mounted component: the composer's Docs
 * button and the RAG panel's privacy line both want the same answer, and each
 * probe is a round trip to the Rust side plus, on the Ollama lane, a network
 * call. The module holds the result and the subscribers; a mount joins, it does
 * not re-ask.
 *
 * It also re-asks when it should (review S1). The first cut measured once on
 * mount, and on a cold start in Cloud mode the answer arrives before
 * `resumeEmbedServer` has the sidecar up, so the button was stuck in
 * needs-setup until the next app start. Two things fix that:
 *
 *  - `lu-models-refresh`, which is what a finished embed install already fires
 *    (api/embed-install.ts) and what useModels listens to for the same reason.
 *  - one delayed retry after a negative answer, because the boot race resolves
 *    in seconds and nobody should have to restart the app to see it.
 */
import { useEffect, useState } from 'react'
import { useRAGStore } from '../stores/ragStore'
import { embeddingLane, type EmbedLaneInfo } from '../api/embed-availability'

/** How long after a "nothing can embed" answer to ask once more. The sidecar
 *  resume is a spawn plus a health check, well inside this. */
export const EMBED_LANE_RETRY_MS = 3000

let current: EmbedLaneInfo | null = null
let inflight: Promise<void> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let listenerArmed = false
const subscribers = new Set<(v: EmbedLaneInfo | null) => void>()

function publish() {
  for (const fn of subscribers) fn(current)
}

/** Measure once. Concurrent callers share the one round trip. */
function measure(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      current = await embeddingLane(useRAGStore.getState().embeddingModel)
    } catch {
      // A probe that cannot run is not proof the lane is dead, but it is not
      // proof it lives either, and the report the user can act on is the one
      // that offers the install.
      current = { lane: 'none', endpoint: null }
    } finally {
      inflight = null
    }
    publish()
    if (current?.lane === 'none' && retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null
        void measure()
      }, EMBED_LANE_RETRY_MS)
    }
  })()
  return inflight
}

function onRefresh() {
  current = null
  publish()
  void measure()
}

/** Test seam: the cache is module state on purpose (one per app), so a test
 *  needs a way back to a clean slate. */
export function __resetEmbedLaneForTests(): void {
  current = null
  inflight = null
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  subscribers.clear()
  if (listenerArmed) {
    window.removeEventListener('lu-models-refresh', onRefresh)
    listenerArmed = false
  }
}

/**
 * @param active measure at all. False in local mode, which does not read the
 *   answer, so it must not pay a round trip per composer mount either.
 * @returns the lane, or null while it is still unknown.
 */
export function useEmbedLane(active: boolean): EmbedLaneInfo | null {
  const [value, setValue] = useState<EmbedLaneInfo | null>(active ? current : null)

  useEffect(() => {
    if (!active) {
      setValue(null)
      return
    }
    subscribers.add(setValue)
    if (!listenerArmed) {
      listenerArmed = true
      window.addEventListener('lu-models-refresh', onRefresh)
    }
    setValue(current)
    if (current === null) void measure()
    return () => {
      subscribers.delete(setValue)
    }
  }, [active])

  return active ? value : null
}
