/**
 * IndexedDB for the recall vectors of long chats (B33, 3.0.9). Modeled on
 * memoryEmbedDB.ts: the vectors are far too big for localStorage, and they
 * never leave this machine.
 *
 *   DB "locally-uncensored-chat-recall" (v1), store "vectors"
 *   key `<conversation id>\u0000<message id>`, value RecallVectorRecord
 *
 * The conversation id leads the key so a deleted chat takes its vectors with
 * it in one key range (dropConversationSideState). Every function is a no-op
 * without IndexedDB (node vitest), so the chat path never throws from here.
 */

export interface RecallVectorRecord {
  model: string
  dim: number
  vector: number[]
  /** recallHash of the embedded text: re-embed only when it changed. */
  contentHash: string
}

const DB_NAME = 'locally-uncensored-chat-recall'
const DB_VERSION = 1
const STORE = 'vectors'
const SEP = '\u0000'

let dbPromise: Promise<IDBDatabase> | null = null

function hasIDB(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      dbPromise = null
      reject(request.error)
    }
  })
  return dbPromise
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

export function recallKey(conversationId: string, messageId: string): string {
  return `${conversationId}${SEP}${messageId}`
}

/** The stored vectors of these messages of one chat, by message id. */
export async function loadRecallVectors(conversationId: string, messageIds: string[]): Promise<Map<string, RecallVectorRecord>> {
  const out = new Map<string, RecallVectorRecord>()
  if (!hasIDB() || messageIds.length === 0) return out
  const store = (await openDB()).transaction(STORE, 'readonly').objectStore(STORE)
  for (const id of messageIds) {
    const rec = (await req(store.get(recallKey(conversationId, id)))) as RecallVectorRecord | undefined
    if (rec && Array.isArray(rec.vector)) out.set(id, rec)
  }
  return out
}

export async function saveRecallVectors(conversationId: string, records: Array<[string, RecallVectorRecord]>): Promise<void> {
  if (!hasIDB() || records.length === 0) return
  const store = (await openDB()).transaction(STORE, 'readwrite').objectStore(STORE)
  for (const [id, rec] of records) await req(store.put(rec, recallKey(conversationId, id)))
}

/** Forget every vector of a chat. Called when the chat is deleted. */
export async function deleteRecallConversation(conversationId: string): Promise<void> {
  if (!hasIDB()) return
  const store = (await openDB()).transaction(STORE, 'readwrite').objectStore(STORE)
  // Every key of this chat sorts between `<id>\u0000` and `<id>\u0001`.
  await req(store.delete(IDBKeyRange.bound(`${conversationId}${SEP}`, `${conversationId}\u0001`, false, true)))
}
