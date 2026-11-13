import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import { normalizeStagedPath } from '../lib/staged-overlay'
import type { StagedChange, ReviewNote } from '../types/staged-changes'
import { idbStorage } from '../lib/idbStorage'
import { coalescedJSONStorage } from '../lib/coalescedStorage'

// Die Datenform lebt in types/staged-changes.ts, damit lib/staged-overlay.ts
// sie lesen kann, ohne diesen Store zu importieren (der seinerseits
// normalizeStagedPath aus dem Overlay zieht). Re-Export, damit bestehende
// Importpfade unverändert bleiben.
export type { StagedChange, ReviewNote }

interface StagedChangesState {
  /** Per-conversation queue. Cleared on apply-all / reject-all / chat reset. */
  byChat: Record<string, StagedChange[]>
  /** Adds a change, returns the assigned id. The same file overwrites its prior entry, the model usually means the latest write to win. */
  stage: (
    chatId: string,
    change: Omit<StagedChange, 'id' | 'stagedAt'>,
  ) => string
  /** Removes a single change from the queue. */
  remove: (chatId: string, id: string) => void
  /** Clears all staged changes for a chat. */
  clear: (chatId: string) => void
  /** Returns the queue for a chat (empty array if none). */
  list: (chatId: string) => StagedChange[]
  /** Looks up a single change by id. */
  get: (chatId: string, id: string) => StagedChange | undefined
  /** Records the user's decision on one hunk; null opens it again. */
  decideHunk: (chatId: string, id: string, hunk: number, decision: 'accepted' | 'rejected' | null) => void
  /**
   * Review outcomes the model has not heard yet, per chat. The desktop review
   * happens beside the run, so the model only learns about a rejected file or
   * hunk when somebody tells it: hooks/codex/staged-writes.ts hands these to
   * the next tool result and empties the list.
   */
  notes: Record<string, ReviewNote[]>
  addNote: (chatId: string, note: ReviewNote) => void
  /** Removes and returns the notes of a chat, or only those for one change. */
  takeNotes: (chatId: string, changeId?: string) => ReviewNote[]
}

/**
 * One file, one entry. The queue used to dedupe on the raw `path` string while
 * every reader (findStagedForPath, the overlay) matches normalized and also on
 * `resolvedPath`. A model that writes `main.py` once and `C:\proj\main.py` the
 * next time therefore left TWO entries for one file, both anchored on the same
 * disk baseline. Applying them wrote the older version first, and the newer one
 * then hit the drift guard and refused: the customer lost the edit he approved
 * and kept the one he did not (Morgan, 2026-08-11).
 */
function sameFile(a: Pick<StagedChange, 'path' | 'resolvedPath'>, b: Pick<StagedChange, 'path' | 'resolvedPath'>): boolean {
  return (
    normalizeStagedPath(a.path) === normalizeStagedPath(b.path) ||
    normalizeStagedPath(a.resolvedPath || a.path) === normalizeStagedPath(b.resolvedPath || b.path)
  )
}

/**
 * The queue holds approved work that is not on disk yet, so it must survive a
 * restart. It did not: the store lived in memory only, and an update (which is
 * a restart) silently emptied it. Morgan lost a full run that way on
 * 2026-08-11, on top of the applies that were refused.
 *
 * IndexedDB, not localStorage: an entry carries the file twice, before and
 * after, and a handful of source files blows past the ~5 MB cap. The write is
 * coalesced for the same reason the chat history is (2026-08-03: a per-set
 * write serialised multi-megabyte state on every frame and took the renderer's
 * memory with it).
 */
const stagedStorage = coalescedJSONStorage<StagedChangesState>(idbStorage)

/** Force the queue out now instead of waiting for the coalescing window. The
 *  end of a run is the honest durability point, an IndexedDB write cannot
 *  finish during unload. */
export function flushStagedPersist(): Promise<void> {
  return stagedStorage.flush()
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('pagehide', () => { void stagedStorage.flush() })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void stagedStorage.flush()
  })
}

/** Two weeks. A pending change older than that is measured against a project
 *  that has moved on, and keeping it forever only grows the database. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * What comes back from disk is data, not state we control: an older build, a
 * half written record, a hand edited database. Keep every entry that still
 * looks like one and is not ancient, drop the rest. An entry whose age cannot
 * be read is KEPT, because throwing away work we merely cannot date would be
 * the very failure this persistence exists to prevent.
 */
export function pruneStagedQueues(
  persisted: unknown,
  now: number,
): Record<string, StagedChange[]> {
  const source = (persisted as Record<string, unknown> | null | undefined) ?? {}
  if (typeof source !== 'object') return {}
  const out: Record<string, StagedChange[]> = {}
  for (const [chatId, raw] of Object.entries(source)) {
    if (!Array.isArray(raw)) continue
    const kept = raw.filter((c): c is StagedChange => {
      if (!c || typeof c !== 'object') return false
      const entry = c as Partial<StagedChange>
      if (typeof entry.id !== 'string' || typeof entry.path !== 'string') return false
      if (typeof entry.newContent !== 'string') return false
      if (typeof entry.stagedAt !== 'number' || !Number.isFinite(entry.stagedAt)) return true
      return now - entry.stagedAt < MAX_AGE_MS
    })
    if (kept.length > 0) out[chatId] = kept
  }
  return out
}

export const useStagedChangesStore = create<StagedChangesState>()(persist((set, get) => ({
  byChat: {},

  stage: (chatId, change) => {
    const id = uuid()
    set((state) => {
      const prev = state.byChat[chatId] ?? []
      // Same file, replace, don't dupe. The diff carries the latest intent.
      const without = prev.filter((c) => !sameFile(c, change))
      return {
        byChat: {
          ...state.byChat,
          [chatId]: [
            ...without,
            { ...change, id, stagedAt: Date.now() },
          ],
        },
      }
    })
    return id
  },

  remove: (chatId, id) =>
    set((state) => {
      const prev = state.byChat[chatId]
      if (!prev) return state
      const next = prev.filter((c) => c.id !== id)
      const byChat = { ...state.byChat }
      if (next.length === 0) {
        delete byChat[chatId]
      } else {
        byChat[chatId] = next
      }
      return { byChat }
    }),

  clear: (chatId) =>
    set((state) => {
      if (!state.byChat[chatId]) return state
      const byChat = { ...state.byChat }
      delete byChat[chatId]
      return { byChat }
    }),

  list: (chatId) => get().byChat[chatId] ?? [],

  get: (chatId, id) => (get().byChat[chatId] ?? []).find((c) => c.id === id),

  decideHunk: (chatId, id, hunk, decision) =>
    set((state) => {
      const prev = state.byChat[chatId]
      if (!prev || !prev.some((c) => c.id === id)) return state
      return {
        byChat: {
          ...state.byChat,
          [chatId]: prev.map((c) => {
            if (c.id !== id) return c
            const next = { ...(c.hunkDecisions ?? {}) }
            if (decision) next[hunk] = decision
            else delete next[hunk]
            return { ...c, hunkDecisions: next }
          }),
        },
      }
    }),

  notes: {},

  addNote: (chatId, note) =>
    set((state) => ({
      notes: {
        ...state.notes,
        // One note per change: a later review of the same change says it all.
        [chatId]: [...(state.notes[chatId] ?? []).filter((n) => n.changeId !== note.changeId), note],
      },
    })),

  takeNotes: (chatId, changeId) => {
    const all = get().notes[chatId] ?? []
    const taken = changeId ? all.filter((n) => n.changeId === changeId) : all
    if (taken.length === 0) return []
    const rest = changeId ? all.filter((n) => n.changeId !== changeId) : []
    set((state) => {
      const notes = { ...state.notes }
      if (rest.length > 0) notes[chatId] = rest
      else delete notes[chatId]
      return { notes }
    })
    return taken
  },
}), {
  name: 'staged-changes',
  storage: stagedStorage,
  partialize: (state) => ({ byChat: state.byChat, notes: state.notes }) as StagedChangesState,
  merge: (persisted, current) => ({
    ...current,
    byChat: pruneStagedQueues((persisted as { byChat?: unknown } | null)?.byChat, Date.now()),
    notes: pruneNotes((persisted as { notes?: unknown } | null)?.notes),
  }),
}))

/** Notes from disk, kept only when they still look like notes. */
function pruneNotes(persisted: unknown): Record<string, ReviewNote[]> {
  if (!persisted || typeof persisted !== 'object') return {}
  const out: Record<string, ReviewNote[]> = {}
  for (const [chatId, raw] of Object.entries(persisted as Record<string, unknown>)) {
    if (!Array.isArray(raw)) continue
    const kept = raw.filter((n): n is ReviewNote =>
      !!n && typeof n === 'object'
      && typeof (n as ReviewNote).changeId === 'string'
      && typeof (n as ReviewNote).path === 'string'
      && typeof (n as ReviewNote).text === 'string')
    if (kept.length > 0) out[chatId] = kept
  }
  return out
}
