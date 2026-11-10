/**
 * Bring stores back after the WebView lost its storage.
 *
 * Taken from the desktop (components/layout/AppShell.tsx, the restore effect)
 * with the same helpers and the same Rust commands (restore_stores,
 * restore_rag_chunks, is_onboarding_done). What is different on the phone:
 *
 *  - It runs in bootMobile, before the first frame, not in an effect. While
 *    it runs the splash says "Restoring your chats".
 *  - No polling for the Tauri global. On a phone the bridge is injected
 *    before the page loads; without it this is a browser and there is nothing
 *    to restore.
 *  - Stores that are present are never overwritten from the backup. The
 *    desktop runs the full restore once for an install that has stores but
 *    no "restore complete" marker; on a phone, where the system kills the app
 *    at any time, that could put an older backup over newer data. This holds
 *    for the full restore too (gap L6, mobile-docs/r39/restore.md): when only
 *    localStorage was dropped, an IndexedDB store that is still there is
 *    merged with the backup record by record, never replaced.
 */
import { backendCall, isTauri } from '../../api/backend'
import { recoverChatsFromBackup } from '../../lib/chat-backup-recovery'
import { idbKeysToRestore, mayReloadForIdbRestore, mergeIdbStoreValue } from '../../lib/idb-restore'
import { hasFailedRead, hasReadableItem, idbStorage } from '../../lib/idbStorage'
import { log } from '../../lib/logger'
import { IDB_STORE_KEYS, STORE_KEYS } from '../../lib/store-backup'
import { useChatStore } from '../../stores/chatStore'
import { mergeDocumentJournal, pruneDocumentJournal } from '../lib/document-journal'
import { installDocumentRemovals, recoverDocumentsFromBackup } from '../lib/document-list-recovery'
import { checkDocumentsHaveChunks } from '../lib/rag-missing-chunks'
import { mergeStoreJournal } from '../lib/store-journal'
import type { TextChunk } from '../../types/rag'

const STORE_KEYS_SET = new Set<string>(STORE_KEYS)
const RESTORE_COMPLETE_KEY = 'lu-restore-complete'
/** Reserved key under which memory embeddings ride inside the RAG chunk backup. */
const MEMORY_VECTORS_BACKUP_KEY = '__memory_vectors__'

let resolveRestoreDecided: () => void = () => {}
/**
 * Resolves once the restore has looked at the backup file. The backup loop
 * (boot/backup.ts) waits for it: a first backup written earlier would put the
 * empty state over the only good copy.
 */
export const restoreDecided = new Promise<void>((resolve) => {
  resolveRestoreDecided = resolve
})

export type RestoreOutcome =
  /** Nothing to do, or the quiet repair runs in the background. */
  | { kind: 'ready'; onboardingMarker: boolean }
  /** Stores were written back; the page reloads to hydrate from them. */
  | { kind: 'reloading' }
  /** The backup could not be read. The app starts, the user is told. */
  | { kind: 'failed'; error: unknown; onboardingMarker: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** The store that holds the app settings (stores/settingsStore.ts). */
const SETTINGS_STORE_KEY = 'chat-settings'

/**
 * Pure: one store of a backup as the phone takes it.
 *
 * A backup can come from a desktop, where the user switched Create in chat
 * on (`settings.createEnabled`). The phone has no order card and no switch to
 * turn it off again (lib/create-order-surface.ts), so the phone does not take
 * that one field over. Everything else comes back as it was written. A value
 * that cannot be read is returned unchanged: the store's own migration deals
 * with it, as it always did.
 */
export function storeValueForPhone(key: string, value: string): string {
  if (key !== SETTINGS_STORE_KEY) return value
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed) || !isRecord(parsed.state) || !isRecord(parsed.state.settings)) return value
    if (!('createEnabled' in parsed.state.settings)) return value
    const { createEnabled: _left, ...settings } = parsed.state.settings
    return JSON.stringify({ ...parsed, state: { ...parsed.state, settings } })
  } catch {
    return value
  }
}

/**
 * Puts back the memory vectors of the backup that IndexedDB does not have and
 * returns the document part. A vector that is there stays: it may belong to a
 * memory edited after the backup was written (gap L6).
 */
async function restoreMemoryVectorsFrom(parsed: Record<string, unknown>): Promise<Record<string, unknown>> {
  const mem = parsed[MEMORY_VECTORS_BACKUP_KEY]
  if (isRecord(mem)) {
    try {
      const { exportAll, importAll } = await import('../../lib/memoryEmbedDB')
      const live = await exportAll()
      const missing: Record<string, unknown> = {}
      for (const [id, rec] of Object.entries(mem)) if (!(id in live)) missing[id] = rec
      if (Object.keys(missing).length > 0) await importAll(missing as Record<string, never>)
    } catch {
      /* best effort; IndexedDB that cannot be read is not written over */
    }
  }
  const { [MEMORY_VECTORS_BACKUP_KEY]: _omit, ...ragOnly } = parsed
  return ragOnly
}

/** localStorage is intact. IndexedDB may still have been dropped: repair it quietly. Returns true when it reloads. */
async function quietRepair(): Promise<boolean> {
  const startedAt = Date.now()
  /** The text of the native backup of the stores, once it was read. */
  let stores: string | null | undefined
  try {
    const live: Record<string, string | null> = {}
    for (const key of IDB_STORE_KEYS) {
      // Present means a value hydration can read, not a row count() sees: a row that is no string, or a
      // leftover "[object Object]" in localStorage, hydrated the chat store empty while the old check
      // (hasStoredItem) took it for chats and put nothing back (perrt on the desktop, 05.11.2026; C46).
      const present = await hasReadableItem(key)
      live[key] = present === true ? 'present' : present === false ? null : await Promise.resolve(idbStorage.getItem(key)).catch(() => null)
      // Not readable is not empty. With a full phone IndexedDB cannot be opened at all, every key
      // looked empty here, and the backup was "restored" over stores that were all still there
      // (the write was refused further down, the reload came anyway). Such a key is left alone (F11).
      if (!live[key] && hasFailedRead(key)) live[key] = 'unreadable'
    }
    if (Object.values(live).some((v) => !v)) {
      const raw = await backendCall<string | null>('restore_stores')
      stores = raw
      const parsed: unknown = raw ? JSON.parse(raw) : null
      const wanted = isRecord(parsed) ? idbKeysToRestore(live, parsed) : []
      let back = 0
      for (const key of wanted) {
        try {
          await Promise.resolve(idbStorage.setItem(key, storeValueForPhone(key, (parsed as Record<string, string>)[key])))
          back++
        } catch {
          /* one key failing must not stop the rest */
        }
      }
      if (back > 0) {
        log.warn('[mobile boot] IndexedDB stores were empty, restored from the backup', { keys: wanted })
        if (mayReloadForIdbRestore(typeof sessionStorage !== 'undefined' ? sessionStorage : null)) {
          resolveRestoreDecided()
          window.location.reload()
          return true
        }
      }
    }
  } catch {
    /* best effort, the steps below still run */
  }
  try {
    await new Promise<void>((resolve) => {
      if (useChatStore.persist.hasHydrated()) resolve()
      else useChatStore.persist.onFinishHydration(() => resolve())
    })
    // A chat the last session wrote after a full phone, kept in the journal: IndexedDB may have lost it in a kill (N6b).
    try {
      await mergeStoreJournal(
        () => useChatStore.getState().conversations,
        (chats) => {
          useChatStore.getState().importConversations(chats, 'merge')
        },
      )
    } catch (err) {
      log.warn('[mobile boot] the journal could not be merged, will retry next launch', { err: String(err) })
    }
    await recoverChatsFromBackup(
      () => useChatStore.getState().conversations,
      (chats) => {
        useChatStore.getState().importConversations(chats, 'merge')
      },
    )
  } catch (err) {
    log.warn('[mobile boot] chat recovery from the backup failed, will retry next launch', { err: String(err) })
  }
  // From here on every document that leaves the list is noted, so the step below never puts back one that was
  // removed on purpose or marked as not saved.
  installDocumentRemovals()
  // A document the list lost between two sessions, while the native backup still lists it (IMP-A, check of
  // package 18): localStorage can lose a record of an earlier session and keep the ones after it. It comes back
  // here, before the check below, so it is either searchable again or shown as not saved, never gone without a word.
  try {
    if (stores === undefined) stores = await backendCall<string | null>('restore_stores')
    recoverDocumentsFromBackup(stores)
  } catch {
    /* best effort, the next start holds the lists against each other again */
  }
  // A document read while IndexedDB refused every write, kept in the native backup (D-VW, check of package 17):
  // its entry in the list may have been torn off with the last write of localStorage. It comes back here,
  // before the check below, so it is either searchable again or shown as not saved, never gone without a word.
  try {
    await mergeDocumentJournal()
  } catch {
    /* best effort, the note stays for the next start */
  }
  // Documents whose passages the backup has. A write back that failed (a full phone) is no loss: the next start tries again.
  const inBackup = new Set<string>()
  let backupRead = false
  try {
    const data = await backendCall<string | null>('restore_rag_chunks')
    const rawParsed: unknown = data ? JSON.parse(data) : null
    backupRead = true
    if (isRecord(rawParsed)) {
      const parsed = await restoreMemoryVectorsFrom(rawParsed)
      for (const [docId, chunks] of Object.entries(parsed)) if (Array.isArray(chunks) && chunks.length > 0) inBackup.add(docId)
      const { exportAllChunks, importAllChunks } = await import('../../lib/ragDB')
      const live = await exportAllChunks()
      const toImport: Record<string, TextChunk[]> = {}
      for (const [docId, chunks] of Object.entries(parsed)) {
        if (!live[docId] && Array.isArray(chunks) && chunks.length > 0) toImport[docId] = chunks as TextChunk[]
      }
      if (Object.keys(toImport).length > 0) await importAllChunks(toImport)
    }
  } catch {
    /* best effort */
  }
  // A document in the list whose passages are in neither place is marked to be added again (gap L2).
  try {
    const { exportAllChunks } = await import('../../lib/ragDB')
    const live = backupRead ? await exportAllChunks().catch(() => null) : null
    const withChunks = live ? new Set([...inBackup, ...Object.keys(live).filter((id) => Array.isArray(live[id]) && live[id].length > 0)]) : null
    checkDocumentsHaveChunks(withChunks, startedAt)
  } catch {
    /* best effort */
  }
  // What the check just marked has left the list; its entry leaves the note too.
  await pruneDocumentJournal().catch(() => {})
  resolveRestoreDecided()
  return false
}

/**
 * What fullRestore does with one IndexedDB store (gap L6). Only localStorage
 * may have been dropped: then IndexedDB still holds the store, newer than the
 * backup. Empty: the backup goes back. Present: merged, never replaced.
 * Not readable: left alone, like the quiet repair does (F11).
 */
async function restoreIdbStore(key: string, saved: string): Promise<boolean> {
  const present = await hasReadableItem(key)
  if (present === null || hasFailedRead(key)) return false
  if (!present) {
    await Promise.resolve(idbStorage.setItem(key, saved))
    return true
  }
  const live = await Promise.resolve(idbStorage.getItem(key))
  if (hasFailedRead(key)) return false
  if (typeof live !== 'string' || !live.trim()) {
    await Promise.resolve(idbStorage.setItem(key, saved))
    return true
  }
  const merged = mergeIdbStoreValue(key, live, saved)
  if (merged === live) return false
  await Promise.resolve(idbStorage.setItem(key, merged))
  log.warn('[mobile boot] records from the backup were added to a store IndexedDB still had', { key })
  return true
}

async function fullRestore(onboardingMarker: boolean): Promise<RestoreOutcome> {
  try {
    const data = await backendCall<string | null>('restore_stores')
    const parsed: unknown = data ? JSON.parse(data) : null
    if (isRecord(parsed)) {
      let restored = 0
      for (const [key, value] of Object.entries(parsed)) {
        if (!STORE_KEYS_SET.has(key) || typeof value !== 'string' || !value) continue
        try {
          const taken = storeValueForPhone(key, value)
          if (IDB_STORE_KEYS.has(key)) await restoreIdbStore(key, taken)
          else localStorage.setItem(key, taken)
          restored++
        } catch {
          /* skip this key, keep restoring the rest */
        }
      }
      if (restored > 0) {
        try {
          const ragData = await backendCall<string | null>('restore_rag_chunks')
          const parsedRag: unknown = ragData ? JSON.parse(ragData) : null
          if (isRecord(parsedRag)) {
            const ragOnly = await restoreMemoryVectorsFrom(parsedRag)
            const { exportAllChunks, importAllChunks } = await import('../../lib/ragDB')
            // Passages IndexedDB still has stay as they are (a document read again after the backup), gap L6.
            const live = await exportAllChunks()
            const toImport: Record<string, TextChunk[]> = {}
            for (const [docId, chunks] of Object.entries(ragOnly)) {
              if (!live[docId] && Array.isArray(chunks) && chunks.length > 0) toImport[docId] = chunks as TextChunk[]
            }
            if (Object.keys(toImport).length > 0) await importAllChunks(toImport)
          }
        } catch {
          /* best effort: documents can be indexed again */
        }
        localStorage.setItem(RESTORE_COMPLETE_KEY, '1')
        resolveRestoreDecided()
        window.location.reload()
        return { kind: 'reloading' }
      }
    }
  } catch (error) {
    resolveRestoreDecided()
    return { kind: 'failed', error, onboardingMarker }
  }
  resolveRestoreDecided()
  return { kind: 'ready', onboardingMarker }
}

/**
 * Decide and run the restore. `onRestoring` is called when the long path
 * starts, so the caller can say so on screen.
 */
export async function runStoreRestore(onRestoring: () => void = () => {}): Promise<RestoreOutcome> {
  if (!isTauri()) {
    resolveRestoreDecided()
    return { kind: 'ready', onboardingMarker: false }
  }
  let hasStores = false
  try {
    hasStores = STORE_KEYS.some((k) => localStorage.getItem(k))
  } catch {
    hasStores = false
  }
  if (hasStores) {
    try {
      localStorage.setItem(RESTORE_COMPLETE_KEY, '1')
    } catch {
      /* the marker is a convenience */
    }
    // Not awaited: the app starts, the repair reads the backup in the background.
    void quietRepair()
    return { kind: 'ready', onboardingMarker: false }
  }
  onRestoring()
  const onboardingMarker = await backendCall<boolean>('is_onboarding_done').catch(() => false)
  return fullRestore(onboardingMarker === true)
}
