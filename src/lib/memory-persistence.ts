import type { StateStorage } from 'zustand/middleware'
import { compareAndSetIdbItem, idbStorage } from './idbStorage'

const KEY = 'locally-uncensored-memory'
let tail: Promise<unknown> = Promise.resolve()
let pending = 0
let latestValue: string | null | undefined
let writeVersion = 0

function enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
  pending++
  const result = tail.catch(() => {}).then(operation)
  tail = result
  // Ordinary Zustand writes are fire-and-forget. A rejected task must not
  // become an unhandled rejection; explicit confirmation below reports it.
  void result.then(() => { pending-- }, () => { pending-- })
  return result
}

/** One queue for ALL ordinary memory writes and synchronization confirmations. */
export const memoryPersistence: StateStorage = {
  getItem: name => {
    const version = writeVersion
    const track = (value: string | null) => {
      if (name === KEY && version === writeVersion) latestValue = value
      return value
    }
    const read = pending ? enqueue(() => Promise.resolve(idbStorage.getItem(name))) : idbStorage.getItem(name)
    return read === null || typeof read === 'string' ? track(read) : Promise.resolve(read).then(track)
  },
  setItem: (name, value) => {
    writeVersion++
    if (name === KEY) latestValue = value
    void enqueue(() => idbStorage.setItem(name, value))
  },
  removeItem: name => {
    writeVersion++
    if (name === KEY) latestValue = null
    void enqueue(() => idbStorage.removeItem(name))
  },
}

/** Confirm the snapshot offered before this call, never a later queued write.
 * A successful result proves an IndexedDB commit, not merely fallback success.
 * Sync callers must keep entries and their baselines in the same store value.
 *
 * `isCurrent` may throw instead of returning false (every caller in this repo
 * does: it is a guard that either passes silently or throws a specific
 * cancellation/account-changed error). R2-38: that error used to be lost, a
 * caller-side `catch { return false }` turned it into a plain boolean, and
 * this function then always threw its own generic "Memories changed" message
 * regardless of the real reason. The catch now lives here, and the original
 * error is what comes out. */
export function flushMemoryPersist(isCurrent: () => boolean | void = () => true): Promise<string> {
  const expected = latestValue
  return enqueue(async () => {
    const raw = await idbStorage.getItem(KEY)
    if (typeof raw !== 'string' || (expected !== undefined && raw !== expected)) {
      throw new Error('Could not confirm saved memories')
    }
    let abortReason: unknown
    const guarded = (): boolean => {
      try {
        const result = isCurrent()
        return result === false ? false : true
      } catch (e) {
        abortReason = e
        return false
      }
    }
    if (!await compareAndSetIdbItem(KEY, raw, raw, guarded)) {
      throw abortReason ?? new Error('Memories changed while saving. Try again.')
    }
    return raw
  })
}
