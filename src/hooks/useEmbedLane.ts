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
 *  - ONE delayed retry after a negative answer, because the boot race resolves
 *    in seconds and nobody should have to restart the app to see it.
 *
 * "One" is the load-bearing word, and the first cut got it wrong: the retry
 * called measure(), which scheduled another retry on another negative answer, so
 * one measurement became eleven over ten windows. Every cloud user without an
 * embedding lane would have polled bundled_embed_status, list_bundled_models,
 * checkConnection and listModels every three seconds, forever, for an answer
 * that was not going to change on its own. The arm below fires once per mount
 * and once per refresh event, and the whole thing is torn down when the last
 * subscriber leaves, so switching from Cloud to Local does not carry a poll
 * along with it (review points 1 and 2).
 */
import { useCallback, useSyncExternalStore } from 'react'
import { useRAGStore } from '../stores/ragStore'
import { embeddingLane, type EmbedLaneInfo } from '../api/embed-availability'

/** How long after a "nothing can embed" answer to ask once more. The sidecar
 *  resume is a spawn plus a health check, well inside this. */
export const EMBED_LANE_RETRY_MS = 3000

let current: EmbedLaneInfo | null = null
let inflight: Promise<void> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
/** Spent for this mount / this refresh. Reset only where a new reason to look
 *  again exists, never by the retry itself. */
let retryUsed = false
let listenerArmed = false
const subscribers = new Set<() => void>()

function publish() {
  for (const fn of subscribers) fn()
}

/**
 * Ein Leser meldet sich an und bekommt seine Abmeldung zurueck.
 *
 * Das stand bis 04.09.2026 im Effekt des Hooks und war deshalb an React
 * gebunden, obwohl nichts daran mit Rendern zu tun hat. Hier ist es das, was
 * es ist: der Anmeldeteil eines Speichers, der ausserhalb von React lebt.
 */
function anmelden(melden: () => void): () => void {
  // A fresh mount is a fresh reason to look, so it gets its own retry.
  const fresh = subscribers.size === 0
  if (fresh) retryUsed = false
  subscribers.add(melden)
  if (!listenerArmed) {
    listenerArmed = true
    window.addEventListener('lu-models-refresh', onRefresh)
  }
  // Never measured yet, or the cache holds a NO and this is a new mount: a
  // user who left Cloud mode, installed an engine and came back must not read
  // a stale refusal. A cached YES is kept; nothing about it goes stale in a
  // way that hurts, and a real change fires lu-models-refresh anyway.
  if (current === null || (fresh && current.lane === 'none')) void measure()
  return () => {
    subscribers.delete(melden)
    if (subscribers.size === 0) teardown()
  }
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
    if (current?.lane === 'none' && !retryUsed && retryTimer === null && subscribers.size > 0) {
      retryUsed = true
      retryTimer = setTimeout(() => {
        retryTimer = null
        // Nobody is looking any more: do not spend the round trip.
        if (subscribers.size === 0) return
        void measure()
      }, EMBED_LANE_RETRY_MS)
    }
  })()
  return inflight
}

function onRefresh() {
  // A real event happened, so one more look is earned.
  retryUsed = false
  current = null
  publish()
  void measure()
}

/** Stop everything this module started. Called when the last subscriber goes,
 *  which is also what a switch from Cloud to Local looks like from here. */
function teardown() {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  retryUsed = false
  if (listenerArmed) {
    window.removeEventListener('lu-models-refresh', onRefresh)
    listenerArmed = false
  }
}

/** Test seam: the cache is module state on purpose (one per app), so a test
 *  needs a way back to a clean slate. */
export function __resetEmbedLaneForTests(): void {
  current = null
  inflight = null
  subscribers.clear()
  teardown()
}

/**
 * @param active measure at all. False in local mode, which does not read the
 *   answer, so it must not pay a round trip per composer mount either.
 * @returns the lane, or null while it is still unknown.
 */
export function useEmbedLane(active: boolean): EmbedLaneInfo | null {
  // `useSyncExternalStore` und nicht `useState` plus Effekt. Der gemessene Wert
  // liegt in einem Modul, nicht in React, und genau dafuer ist dieser Haken
  // gebaut: React fragt den Stand selbst ab, nachdem es sich angemeldet hat,
  // und es kann waehrend eines unterbrochenen Durchlaufs nicht passieren, dass
  // zwei Stellen der Oberflaeche verschiedene Antworten zeigen.
  //
  // Vorher lag der Wert doppelt: einmal im Modul und einmal in einem
  // `useState`, das ein Effekt nachzog. Daraus kam die eslint-Meldung
  // `react-hooks/set-state-in-effect`, und sie hatte recht: jedes Anmelden
  // zeichnete zweimal, einmal mit dem alten und einmal mit dem neuen Wert.
  //
  // `active` false heisst: gar nicht erst anmelden, also auch keine Messung
  // und keine Rundreise. Der Stand ist dann null, und zwar ohne dass ihn
  // jemand loeschen muesste.
  const abonnieren = useCallback(
    (melden: () => void) => (active ? anmelden(melden) : () => {}),
    [active],
  )
  return useSyncExternalStore(abonnieren, () => (active ? current : null))
}
