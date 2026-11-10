/** Attachments live outside the frequently serialized chat state. `data` keeps
 * its wire-compatible string shape; local references are resolved ONLY at the
 * provider boundary, after context trimming. Originals are never downsampled
 * in storage. Native files survive a WebView cache reset alongside store backup.
 *
 * Nothing in this module may cost the user a chat. Every path that can fail
 * (disk full, a locked file, a missing attachment, an image the decoder
 * refuses) degrades to "this image stays inline" or "this image is left out
 * with a note", never to "the save is skipped" or "the send is refused".
 */
import { backendCall, isTauri } from '../api/backend'
import { log } from './logger'
import type { ImageAttachment } from '../types/chat'
import { prepareChatImage } from './chat-image-input'

const PREFIX = 'lu-attachment:v1:'
export function isAttachmentReference(data: string): boolean { return data.startsWith(PREFIX) }
function attachmentId(data: string): string {
  const id = data.slice(PREFIX.length)
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid chat attachment reference.')
  return id
}
/** The content id behind a reference, or null for inline data. */
export function referenceId(data: string): string | null {
  if (!isAttachmentReference(data)) return null
  try { return attachmentId(data) } catch { return null }
}
let database: Promise<IDBDatabase> | undefined
function db(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('lu-chat-attachments', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('images')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => { database = undefined; reject(req.error) }
  })
}
async function browserWrite(id: string, data: string): Promise<void> {
  const database = await db()
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('images', 'readwrite')
    tx.objectStore('images').put(data, id)
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Could not save chat attachment.'))
  })
}
async function read(data: string): Promise<string> {
  if (!isAttachmentReference(data)) return data
  const id = attachmentId(data)
  if (isTauri()) return backendCall<string>('read_chat_attachment', { id })
  const database = await db()
  return new Promise((resolve, reject) => {
    const req = database.transaction('images').objectStore('images').get(id)
    req.onsuccess = () => typeof req.result === 'string' ? resolve(req.result) : reject(new Error('Chat attachment is missing. Please attach the original image again.'))
    req.onerror = () => reject(req.error)
  })
}

/** The data URL behind a stored reference (chat backgrounds, 3.1.0). */
export function readAttachment(ref: string): Promise<string> {
  return read(ref)
}

/** The reference an inline image object already got. Keyed by the object, so
 *  a state snapshot taken before the swap does not hash and write the same
 *  megabytes a second time. */
const storedRefs = new WeakMap<object, string>()

export async function storeAttachment<T extends { data: string }>(image: T): Promise<T> {
  if (!image.data || isAttachmentReference(image.data)) return image
  const known = storedRefs.get(image)
  if (known) return { ...image, data: known }
  const bytes = new TextEncoder().encode(image.data)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  const id = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
  if (isTauri()) await backendCall('write_chat_attachment', { id, data: image.data })
  else await browserWrite(id, image.data)
  // References are published only after the durable write succeeded.
  storedRefs.set(image, PREFIX + id)
  return { ...image, data: PREFIX + id }
}

export function attachmentBlob(data: string, mimeType: string): Blob {
  // Chunk conversion avoids a second giant numeric JS array for old images.
  const chunks: Uint8Array<ArrayBuffer>[] = []
  for (let at = 0; at < data.length; at += 65536) {
    const binary = atob(data.slice(at, at + 65536))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    chunks.push(bytes)
  }
  return new Blob(chunks, { type: mimeType })
}
export async function originalAttachment<T extends { data: string }>(image: T): Promise<T> {
  return { ...image, data: await read(image.data) }
}

/**
 * Sequential, bounded decoding, one queue per purpose. Sending and previews
 * used to share a single queue, so scrolling through an old chat delayed the
 * next send behind every thumbnail on screen, and one decoder that never
 * settled stalled both. Two queues bound the worst case at two decodes at a
 * time, and a preview can never stand in front of a send.
 */
const queues = { send: Promise.resolve(), preview: Promise.resolve() }
/** A decode that has not settled after this long releases its queue. The
 *  work itself cannot be cancelled, but the next image no longer waits. */
const DECODE_TIMEOUT_MS = 30_000
export const PREVIEW_EDGE = 512

function enqueue<T>(queue: keyof typeof queues, job: () => Promise<T>): Promise<T> {
  const result = queues[queue].then(() => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Image preparation timed out.')), DECODE_TIMEOUT_MS)
    job().then(resolve, reject).finally(() => clearTimeout(timer))
  }))
  queues[queue] = result.then(() => {}, () => {})
  return result
}

async function prepareStored<T extends { data: string; mimeType: string }>(image: T, maxEdge: number | undefined, cancelled: () => boolean): Promise<T> {
  if (cancelled()) throw new Error('Image no longer visible.')
  const original = await originalAttachment(image)
  if (cancelled()) throw new Error('Image no longer visible.')
  const file = new File([attachmentBlob(original.data, image.mimeType)], 'chat-image', { type: image.mimeType })
  const prepared = await prepareChatImage(file, { maxEdge, legacy: true })
  return { ...image, data: prepared.data, mimeType: prepared.mimeType }
}

/** The copy a model receives: at most 2048 px and 512 KiB, from the stored original. */
export function boundedAttachment<T extends { data: string; mimeType: string }>(image: T, cancelled: () => boolean = () => false): Promise<T> {
  return enqueue('send', () => prepareStored(image, undefined, cancelled))
}

/** The thumbnail in the transcript. Its own queue and a small edge. */
export function previewAttachment<T extends { data: string; mimeType: string }>(image: T, cancelled: () => boolean = () => false): Promise<T> {
  return enqueue('preview', () => prepareStored(image, PREVIEW_EDGE, cancelled))
}

/** The prepared images a single request may carry, base64 characters. About
 *  twenty-three optimized images; more than any vision model takes. */
export const CONTEXT_IMAGE_BUDGET = 16 * 1024 * 1024

/** Base64 length up to which an inline image is taken as the composer made
 *  it (512 KiB of bytes is about 700k characters). */
const INLINE_READY_LIMIT = 1_000_000

export const OMITTED_IMAGE_NOTE = '[An image attached here was left out of this request.]'

/**
 * Resolve references to model-ready images. Never refuses a send: an image
 * that cannot be read, cannot be decoded, or no longer fits the per-request
 * budget is left out and the message says so in one line. The newest images
 * are resolved first, so the budget always goes to the turn the user is on.
 */
export async function resolveMessageAttachments<T extends { content?: string; images?: { data: string; mimeType: string }[] }>(messages: T[]): Promise<T[]> {
  const result = messages.slice()
  let bytes = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message.images?.length) continue
    const images: { data: string; mimeType: string }[] = []
    let omitted = 0
    for (const image of message.images) {
      if (bytes >= CONTEXT_IMAGE_BUDGET) { omitted++; continue }
      try {
        // The composer already hands over optimized images. Anything else
        // (a reference, or an original that stayed inline because its
        // write failed) goes through the same bounded preparation.
        const resolved = isAttachmentReference(image.data) || image.data.length > INLINE_READY_LIMIT
          ? await boundedAttachment(image)
          : image
        if (bytes + resolved.data.length > CONTEXT_IMAGE_BUDGET) { omitted++; continue }
        bytes += resolved.data.length
        images.push(resolved)
      } catch (err) {
        log.warn('[chat-attachments] image left out of the request', { err: String(err) })
        omitted++
      }
    }
    if (omitted === 0 && images.every((image, i) => image === message.images![i])) continue
    const note = Array(omitted).fill(OMITTED_IMAGE_NOTE).join('\n')
    const next = { ...message, images: images as T['images'] }
    if (note && typeof message.content === 'string') next.content = message.content ? `${message.content}\n\n${note}` : note
    if (images.length === 0) delete next.images
    result[index] = next
  }
  return result
}

export function hasInlineImages(conversations: readonly { messages: readonly { images?: readonly ImageAttachment[] }[] }[]): boolean {
  return conversations.some(c => c.messages.some(m => m.images?.some(i => i.data && !isAttachmentReference(i.data))))
}

/** After a failed attachment write the next attempt waits this long, so a
 *  full disk costs one failed IPC per window instead of one per keystroke. */
const RETRY_AFTER_FAILURE_MS = 30_000
let retryAt = 0

/**
 * Immutable migration, best effort per image. An image whose write fails
 * stays inline, exactly as it was, and the rest still move out. Never throws:
 * the caller writes whatever comes back, so a failing disk can delay the
 * move of the images but never the save of the chat around them.
 */
export async function externalizeConversations<T extends { messages: { images?: ImageAttachment[] }[] }>(conversations: T[]): Promise<T[]> {
  let changed = false
  const result: T[] = []
  let blocked = Date.now() < retryAt
  for (const conversation of conversations) {
    let convChanged = false
    const messages = []
    for (const message of conversation.messages) {
      if (blocked || !message.images?.some(image => image.data && !isAttachmentReference(image.data))) { messages.push(message); continue }
      const images = []
      let messageChanged = false
      for (const image of message.images) {
        if (blocked) { images.push(image); continue }
        try {
          const stored = await storeAttachment(image)
          if (stored !== image) messageChanged = true
          images.push(stored)
        } catch (err) {
          blocked = true
          retryAt = Date.now() + RETRY_AFTER_FAILURE_MS
          log.error('[chat-attachments] attachment write failed, the image stays inline for now', { err: String(err) })
          images.push(image)
        }
      }
      if (messageChanged) {
        messages.push({ ...message, images })
        convChanged = changed = true
      } else messages.push(message)
    }
    result.push(convChanged ? { ...conversation, messages } : conversation)
  }
  return changed ? result : conversations
}

/** Test seam: forget the failure backoff. */
export function __resetAttachmentBackoff(): void { retryAt = 0 }
