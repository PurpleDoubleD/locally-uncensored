/**
 * Bug A1 (2.6.7), the two halves the 2.6.5 fix left standing.
 *
 * aldrich_ironhart on 2.6.5, Discord #general 18.08.: "has anyone lost their
 * chats after a restart??", then "My code chats are vaporised", a coding chat
 * around 230k tokens. sockenmonster on the same build lost nothing.
 *
 * The update path already flushes the coalesced stores before it hands the
 * process to the installer. Two things were still wrong with that.
 *
 * ONE. It awaited the flush with no deadline. flush() resolves when the
 * IndexedDB put has landed, and on a database that is blocked, broken or out
 * of room the put never lands and the promise never settles. That is not an
 * exotic case here, it is the population this whole fix is aimed at: the
 * machines whose IndexedDB is already in trouble. The button became a spinner
 * that never came back, and the way out of that is the user killing the app,
 * which is the exact hard kill the flush exists to avoid.
 *
 * TWO. Nothing wrote a fresh file backup before handing over. The backup triad
 * writes %APPDATA%/store_backup.json every 5 s and 1 s after a chat mutation,
 * so what survived an update was whatever the interval happened to catch. The
 * instant before a self update is the most valuable moment there is to have a
 * current copy outside the WebView2 profile, and it was the one moment nobody
 * asked for one.
 *
 * Run: npx vitest run src/stores/__tests__/update-waits-but-not-forever.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const calls: string[] = []

vi.mock('../../api/backend', () => ({
  isTauri: () => true,
  openExternal: vi.fn(),
  backendCall: vi.fn(async (cmd: string) => {
    calls.push(`backend:${cmd}`)
    return null
  }),
}))

vi.mock('../../api/engine', () => ({
  stopBundledEngine: vi.fn(async () => { calls.push('stop:engine') }),
  stopBundledEmbed: vi.fn(async () => { calls.push('stop:embed') }),
}))

vi.mock('../../lib/logger', () => ({
  log: { warn: vi.fn((m: string) => { calls.push(`warn:${m}`) }), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

let chatFlush: () => Promise<void> = async () => { calls.push('flush:chat') }
vi.mock('../chatStore', () => ({ flushChatPersist: () => chatFlush() }))
vi.mock('../stagedChangesStore', () => ({ flushStagedPersist: async () => { calls.push('flush:staged') } }))

let backupNow: () => Promise<boolean> = async () => { calls.push('backup'); return true }
vi.mock('../../lib/store-backup', () => ({ backupStoresNow: () => backupNow() }))

vi.mock('../../../package.json', () => ({ version: '2.6.6' }))

const install = vi.fn(async () => { calls.push('install') })

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => ({ version: '2.6.7', body: 'notes', install, download: vi.fn() })),
}))

import { useUpdateStore, settledOrTimedOut } from '../updateStore'

/** A promise that is never going to settle, which is what a put into a broken
 *  IndexedDB looks like from here. */
function neverSettles(): Promise<void> {
  return new Promise<void>(() => {})
}

async function armPendingUpdate() {
  await useUpdateStore.getState().checkForUpdate(true)
}

function reset() {
  calls.length = 0
  install.mockClear()
  chatFlush = async () => { calls.push('flush:chat') }
  backupNow = async () => { calls.push('backup'); return true }
  useUpdateStore.setState({
    downloadStatus: 'downloaded',
    autoDownload: false,
    lastChecked: null,
    latestVersion: null,
    updateAvailable: false,
    errorMessage: null,
  })
}

describe('the update waits for the chats to be written, but not forever', () => {
  beforeEach(reset)
  afterEach(() => { vi.useRealTimers() })

  it('a flush that never settles does not stop the update', async () => {
    await armPendingUpdate()
    reset()
    chatFlush = neverSettles

    vi.useFakeTimers()
    const running = useUpdateStore.getState().installAndRestart()
    // Everything the deadline plus the settle pause can possibly need.
    await vi.advanceTimersByTimeAsync(30_000)
    await running

    expect(install).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().downloadStatus).not.toBe('error')
    // And it said so, rather than pretending the write had landed.
    expect(calls.some((c) => c.startsWith('warn:'))).toBe(true)
  })

  it('NEGATIVE CONTROL: the old rule was a bare await, and it never reached install', async () => {
    // Exactly what the code did before: allSettled over the flushes with no
    // deadline. allSettled needs every input to settle, so one that does not
    // hangs the whole handover. Nothing else about the path changed.
    vi.useFakeTimers()
    let reached = false
    const oldRule = (async () => {
      await Promise.allSettled([neverSettles(), Promise.resolve()])
      reached = true
    })()
    void oldRule
    await vi.advanceTimersByTimeAsync(30_000)
    expect(reached).toBe(false)

    // The new rule, over the same never-settling flush, comes back.
    const verdict = settledOrTimedOut(Promise.allSettled([neverSettles(), Promise.resolve()]), 10_000)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await verdict).toBe('timeout')
  })

  it('writes a fresh backup to disk before it hands the process over', async () => {
    await armPendingUpdate()
    reset()

    await useUpdateStore.getState().installAndRestart()

    expect(calls).toContain('backup')
    expect(calls.indexOf('backup')).toBeLessThan(calls.indexOf('install'))
    // And after the flush, not before it: backing up a store whose newest
    // messages are still sitting in the coalescing window would snapshot the
    // history the user is trying to keep, minus the last thing they said.
    expect(calls.indexOf('flush:chat')).toBeLessThan(calls.indexOf('backup'))
  })

  it('NEGATIVE CONTROL: without the pre-update backup nothing writes a file on this path', async () => {
    // What 2.6.6 did: stop the sidecars, flush the two stores, pause, install.
    // Not one of those puts anything in %APPDATA%, so the copy that had to
    // survive the update was whatever the 5 s triad interval last caught.
    await armPendingUpdate()
    reset()
    // Stand the old path back up by making the backup a no-op.
    backupNow = async () => true

    await useUpdateStore.getState().installAndRestart()

    const before = calls.slice(0, calls.indexOf('install'))
    expect(before).not.toContain('backup')
    expect(before.filter((c) => c.startsWith('backend:'))).toHaveLength(0)
  })

  it('a backup that never answers does not stop the update either', async () => {
    await armPendingUpdate()
    reset()
    backupNow = () => neverSettles() as unknown as Promise<boolean>

    vi.useFakeTimers()
    const running = useUpdateStore.getState().installAndRestart()
    await vi.advanceTimersByTimeAsync(30_000)
    await running

    expect(install).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().downloadStatus).not.toBe('error')
  })

  it('settledOrTimedOut answers on a rejection instead of passing it on', async () => {
    // The caller wants to know it may proceed, not what went wrong. A throw
    // out of here would land in installAndRestart's catch and turn a failed
    // write into "The update could not be installed."
    await expect(settledOrTimedOut(Promise.reject(new Error('idb gone')), 1_000)).resolves.toBe('settled')
    await expect(settledOrTimedOut(Promise.resolve(1), 1_000)).resolves.toBe('settled')
  })
})
