// @vitest-environment jsdom
/**
 * A setting changed right before a hard end of the app is back after the
 * restart (acceptance Android, re-run, N5: lost when changed 0.3 s before,
 * kept from 2 s on, because the WebView writes localStorage to disk late).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetStorageHealthForTests, storageWriteFailures } from '../../../lib/storage-health'
import { IDB_STORE_KEYS, MOBILE_STORE_KEYS, STORE_KEYS } from '../../../lib/store-backup'
import {
  DURABLE_SETTINGS_KEYS, SETTINGS_COPY_KEY, SETTINGS_COPY_RETRY_MS, SETTINGS_STAMP_KEY, installSettingsDurability, parseMirror, recoverSettings, settingsToRecover,
  type MirrorDoor, type SettingsMirror,
} from '../settings-durable'
import { AGE_KEY } from '../../policy/age'
import { AI_CONSENT_KEY } from '../../policy/consent'
import { REPORT_QUEUE_KEY } from '../../policy/report'
import { THINKING_DEFAULT_KEY } from '../../screens/chat/parts/thinking-default'
import { CLOUD_SUBMIT_INTENTS_KEY, PENDING_CLOUD_JOBS_KEY } from '../../../lib/pending-cloud-jobs'

/** A copy that is kept in memory, like IndexedDB keeps it across a kill. */
function memoryDoor(): MirrorDoor & { held: SettingsMirror | null; writes: number } {
  const door = {
    held: null as SettingsMirror | null,
    writes: 0,
    read: async () => (door.held ? parseMirror(JSON.parse(JSON.stringify(door.held))) : null),
    write: async (mirror: SettingsMirror) => {
      door.held = JSON.parse(JSON.stringify(mirror)) as SettingsMirror
      door.writes += 1
    },
    drop: async () => {
      door.held = null
    },
  }
  return door
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const settings = (theme: string) => JSON.stringify({ state: { settings: { theme } }, version: 9 })

let stop: () => void = () => {}
let clock = 1_000

beforeEach(() => {
  localStorage.clear()
  clock = 1_000
})
afterEach(() => {
  stop()
  stop = () => {}
})

describe('which keys are kept', () => {
  it('the settings store and every phone key that holds a setting', () => {
    expect(DURABLE_SETTINGS_KEYS).toContain('chat-settings')
    for (const key of MOBILE_STORE_KEYS) expect(DURABLE_SETTINGS_KEYS).toContain(key)
    expect(DURABLE_SETTINGS_KEYS).not.toContain(SETTINGS_STAMP_KEY)
    expect(DURABLE_SETTINGS_KEYS).not.toContain('chat-conversations')
  })

  // Round 9, A-14 on Android: "Read every answer aloud" was lost in three
  // kills of three. The switch lives in the voice store, and the list above
  // did not know that store.
  it('the stores behind the switches of the phone: voice, permissions, providers, the agent, documents, paid jobs', () => {
    for (const key of [
      'locally-uncensored-voice', 'locally-uncensored-permissions', 'lu-providers', 'locally-uncensored-agent-mode',
      'locally-uncensored-agent-goal', 'locally-uncensored-agent-workflows', 'rag-store',
      PENDING_CLOUD_JOBS_KEY, CLOUD_SUBMIT_INTENTS_KEY,
    ]) expect(DURABLE_SETTINGS_KEYS, key).toContain(key)
  })

  it('the decisions a phone keeps under keys of its own: age, consent, a report that waits, saved Create settings', () => {
    for (const key of [AGE_KEY, AI_CONSENT_KEY, REPORT_QUEUE_KEY, THINKING_DEFAULT_KEY, 'lu-mobile-create-presets', 'lu-mobile-character-names']) {
      expect(DURABLE_SETTINGS_KEYS, key).toContain(key)
    }
  })

  it('no key twice', () => {
    expect(new Set(DURABLE_SETTINGS_KEYS).size).toBe(DURABLE_SETTINGS_KEYS.length)
  })

  /**
   * The guard. Every persisted store (lib/store-backup.ts, which a test of
   * its own holds against src/stores) is either copied or stands here with
   * the reason why not. A store that is added later fails this test until
   * somebody decides.
   */
  it('every persisted store is copied, or named here with the reason why not', () => {
    const notCopied: Record<string, string> = {
      // Already in IndexedDB, which has no delay.
      ...Object.fromEntries([...IDB_STORE_KEYS].map((key) => [key, 'lives in IndexedDB'])),
      'chat-models': 'the list of models, read from the device again at every start',
      'create-store': 'large (the gallery), rewritten while a job runs; a running paid job is kept through lu-pending-cloud-jobs',
      'locally-uncensored-downloads': 'downloads of the desktop; the phone keeps its own list on the native side',
      'lu-cloud-catalog': 'a cache of the cloud catalog',
      'lu-cloud-gate': 'the gate pop-up of the desktop (3.0.8): a cache of the public catalogue and the model clicked there',
      'lu-cloud-outage': 'which outage notice was closed (3.0.8, A28): shown once more at worst',
      'locally-uncensored-model-health': 'a cache',
      'lu-benchmark-store': 'results of a measurement, not a setting',
      'locally-uncensored-todos': 'the plan of a run, which ends with the app',
      'lu_cloud_notice': 'which notice was seen: shown once more at worst',
      'lu_comfy_notice': 'desktop only',
      'lu_release_notes': 'which notes were read: shown once more at worst',
      'locally-uncensored-ui': 'window geometry of the desktop',
      'locally-uncensored-codex': 'desktop only',
      'locally-uncensored-mcp-servers': 'desktop only',
      'locally-uncensored-agent': 'a key of an older build',
      'lu-update-checker-v2': 'desktop only',
      'workflow-store': 'desktop only',
      'lu-local-api': 'desktop only',
      'locally-uncensored-computer': 'desktop only: the settings of computer use, which the phone does not have',
      'lu-neuron-tweaker': 'desktop only (3.0.9, P11): the Neuron tweaker steers LU Engine, which the phone does not have',
      'LU-create-orders': 'the orders of Create in chat, which is locked on the phone until it has the order card',
      'lu-mobile-switched-under-answer': 'a note per answer; lost, the chat says "interrupted" instead of "you switched models"',
      'lu-mobile-settings-stamp': 'the stamp of this copy itself; in the native backup it dates the settings there (L5)',
    }
    for (const key of STORE_KEYS) {
      const copied = DURABLE_SETTINGS_KEYS.includes(key)
      expect(copied || key in notCopied, `${key} is neither copied at once nor named as not copied`).toBe(true)
      expect(copied && key in notCopied, `${key} is named as not copied but is copied`).toBe(false)
    }
  })
})

describe('every write is copied at once', () => {
  it('copies a change of a setting with its stamp, and nothing for other keys', async () => {
    const door = memoryDoor()
    stop = installSettingsDurability(door, () => clock)
    localStorage.setItem('chat-conversations', 'big')
    await settle()
    expect(door.writes).toBe(0)

    localStorage.setItem('chat-settings', settings('dark'))
    await settle()
    expect(door.held?.values['chat-settings']).toBe(settings('dark'))
    expect(door.held?.stamp).toBe(Number(localStorage.getItem(SETTINGS_STAMP_KEY)))
    expect(door.held?.stamp).toBeGreaterThanOrEqual(1_000)
  })

  it('does not wait: the copy is on its way in the same turn as the write', async () => {
    const door = memoryDoor()
    let started = 0
    const write = door.write
    door.write = async (mirror) => {
      started += 1
      await write(mirror)
    }
    stop = installSettingsDurability(door, () => clock)
    localStorage.setItem('lu-mobile-theme', 'dark')
    expect(started).toBe(1)
  })

  it('a write of the same value is not a change', async () => {
    const door = memoryDoor()
    localStorage.setItem('chat-settings', settings('dark'))
    stop = installSettingsDurability(door, () => clock)
    localStorage.setItem('chat-settings', settings('dark'))
    await settle()
    expect(door.writes).toBe(0)
    // Still the stamp of the start (round 9), not a new one.
    expect(localStorage.getItem(SETTINGS_STAMP_KEY)).toBe('1000')
  })

  it('several changes in a row end with the last one in the copy, each with a later stamp', async () => {
    const door = memoryDoor()
    stop = installSettingsDurability(door, () => clock)
    const stamps: number[] = []
    for (const theme of ['a', 'b', 'c', 'd']) {
      localStorage.setItem('chat-settings', settings(theme))
      stamps.push(Number(localStorage.getItem(SETTINGS_STAMP_KEY)))
    }
    await settle()
    await settle()
    expect(door.held?.values['chat-settings']).toBe(settings('d'))
    expect(door.held?.stamp).toBe(stamps[3])
    expect([...stamps].sort((x, y) => x - y)).toEqual(stamps)
    expect(new Set(stamps).size).toBe(4)
  })

  it('a removed key is copied as removed', async () => {
    const door = memoryDoor()
    localStorage.setItem('lu-mobile-theme', 'dark')
    stop = installSettingsDurability(door, () => clock)
    localStorage.removeItem('lu-mobile-theme')
    await settle()
    expect(door.held?.values['lu-mobile-theme']).toBeNull()
  })

  it('a copy that cannot be written never breaks the write to localStorage', async () => {
    const door = memoryDoor()
    door.write = async () => {
      throw new Error('IndexedDB is gone')
    }
    stop = installSettingsDurability(door, () => clock)
    expect(() => localStorage.setItem('chat-settings', settings('dark'))).not.toThrow()
    await settle()
    expect(localStorage.getItem('chat-settings')).toBe(settings('dark'))
  })
})

describe('the hard end of the app', () => {
  it('what the copy holds newer than localStorage is put back, removed keys included', async () => {
    const door = memoryDoor()
    // localStorage as the disk had it: the old values and the old stamp.
    localStorage.setItem('chat-settings', settings('light'))
    localStorage.setItem('lu-mobile-download-wifi-only', '1')
    localStorage.setItem(SETTINGS_STAMP_KEY, '1000')
    // The copy, written with the change the disk never saw.
    door.held = { stamp: 5_000, values: { ...Object.fromEntries(DURABLE_SETTINGS_KEYS.map((k) => [k, null])), 'chat-settings': settings('dark') } }

    await expect(recoverSettings(door)).resolves.toBe('recovered')
    expect(localStorage.getItem('chat-settings')).toBe(settings('dark'))
    expect(localStorage.getItem('lu-mobile-download-wifi-only')).toBeNull()
    expect(localStorage.getItem(SETTINGS_STAMP_KEY)).toBe('5000')
    // The second start finds nothing left to do.
    await expect(recoverSettings(door)).resolves.toBe('nothing')
  })

  it('end to end with the watch: change, kill before the disk write, start again', async () => {
    const door = memoryDoor()
    stop = installSettingsDurability(door, () => clock)
    localStorage.setItem('chat-settings', settings('light'))
    await settle()
    const disk = { ...localStorage } as Record<string, string>

    clock = 9_000
    localStorage.setItem('chat-settings', settings('dark'))
    await settle()
    const held = door.held
    stop()
    stop = () => {}
    // The kill: localStorage is what was on disk, the copy is what IndexedDB had.
    for (const key of Object.keys({ ...localStorage })) localStorage.removeItem(key)
    for (const [key, value] of Object.entries(disk)) localStorage.setItem(key, value)
    door.held = held

    expect(localStorage.getItem('chat-settings')).toBe(settings('light'))
    await expect(recoverSettings(door)).resolves.toBe('recovered')
    expect(localStorage.getItem('chat-settings')).toBe(settings('dark'))
  })

  it('nothing is touched when localStorage kept everything', async () => {
    const door = memoryDoor()
    stop = installSettingsDurability(door, () => clock)
    localStorage.setItem('chat-settings', settings('dark'))
    await settle()
    await expect(recoverSettings(door)).resolves.toBe('nothing')
    expect(localStorage.getItem('chat-settings')).toBe(settings('dark'))
  })
})

describe('round 9, A-14: the switch of the report', () => {
  const voice = (autoReadAloud: boolean) => JSON.stringify({ state: { ttsEnabled: true, autoReadAloud }, version: 0 })

  it('"Read every answer aloud" changed, the app killed before the disk write: the switch is as it was set', async () => {
    const door = memoryDoor()
    localStorage.setItem('locally-uncensored-voice', voice(false))
    stop = installSettingsDurability(door, () => clock)
    await settle()
    // What the disk has: the old value, and the stamp of the first start.
    const disk = { ...localStorage } as Record<string, string>
    expect(Number(disk[SETTINGS_STAMP_KEY])).toBeGreaterThan(0)

    clock = 9_000
    localStorage.setItem('locally-uncensored-voice', voice(true))
    await settle()
    const held = door.held
    stop()
    stop = () => {}
    for (const key of Object.keys({ ...localStorage })) localStorage.removeItem(key)
    for (const [key, value] of Object.entries(disk)) localStorage.setItem(key, value)
    door.held = held

    expect(localStorage.getItem('locally-uncensored-voice')).toBe(voice(false))
    await expect(recoverSettings(door)).resolves.toBe('recovered')
    expect(localStorage.getItem('locally-uncensored-voice')).toBe(voice(true))
  })

  it('the very first change after an install is covered too: the stamp is there from the first start', async () => {
    const door = memoryDoor()
    stop = installSettingsDurability(door, () => clock)
    expect(localStorage.getItem(SETTINGS_STAMP_KEY)).toBe('1000')
    // Nothing was changed, so nothing was copied.
    await settle()
    expect(door.writes).toBe(0)
  })

  it('a start with a stamp does not write a new one', async () => {
    localStorage.setItem(SETTINGS_STAMP_KEY, '400')
    stop = installSettingsDurability(memoryDoor(), () => clock)
    expect(localStorage.getItem(SETTINGS_STAMP_KEY)).toBe('400')
  })

  // Finding F11 of check 4 on Android: with a full phone a change was lost without a word.
  it('a copy that fails on a full phone is said out loud, tried again by itself, and the notice goes when it lands', async () => {
    __resetStorageHealthForTests()
    vi.useFakeTimers()
    try {
      const door = memoryDoor()
      const write = door.write
      let full = true
      door.write = async (mirror) => {
        if (full) throw new DOMException('Failed to write blobs (IOError)', 'DataError')
        await write(mirror)
      }
      stop = installSettingsDurability(door, () => clock)
      localStorage.setItem('locally-uncensored-voice', voice(true))
      await vi.advanceTimersByTimeAsync(0)
      expect(storageWriteFailures()).toMatchObject([{ key: SETTINGS_COPY_KEY, savedTo: 'nowhere', reason: 'no-space' }])
      // The setting itself holds: localStorage took it.
      expect(localStorage.getItem('locally-uncensored-voice')).toBe(voice(true))

      await vi.advanceTimersByTimeAsync(SETTINGS_COPY_RETRY_MS)
      expect(storageWriteFailures()).toHaveLength(1)
      full = false
      await vi.advanceTimersByTimeAsync(SETTINGS_COPY_RETRY_MS)
      expect(door.held?.values['locally-uncensored-voice']).toBe(voice(true))
      expect(storageWriteFailures()).toEqual([])
    } finally {
      vi.useRealTimers()
      __resetStorageHealthForTests()
    }
  })

  it('a copy that failed is tried again when the app goes to the background, and not when nothing is owed', async () => {
    const door = memoryDoor()
    const write = door.write
    let broken = true
    let tries = 0
    door.write = async (mirror) => {
      tries += 1
      if (broken) throw new Error('IndexedDB is busy')
      await write(mirror)
    }
    stop = installSettingsDurability(door, () => clock)
    localStorage.setItem('locally-uncensored-voice', voice(true))
    await settle()
    expect(tries).toBe(1)
    expect(door.held).toBeNull()

    broken = false
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(tries).toBe(2)
    expect(door.held?.values['locally-uncensored-voice']).toBe(voice(true))

    // Nothing is owed now: leaving again writes nothing.
    window.dispatchEvent(new Event('pagehide'))
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(tries).toBe(2)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })
})

describe('what must never come back', () => {
  const live = (value: string | null) => ({ 'chat-settings': value })
  const mirror = (stamp: number, value: string | null): SettingsMirror => ({ stamp, values: { 'chat-settings': value } })

  it('an older or equally old copy', () => {
    expect(settingsToRecover(500, live(settings('new')), mirror(400, settings('old')))).toEqual({})
    expect(settingsToRecover(500, live(settings('new')), mirror(500, settings('old')))).toEqual({})
  })

  it('anything into a storage that knows no stamp: fresh, or emptied on purpose', () => {
    expect(settingsToRecover(0, live(null), mirror(900, settings('old')))).toEqual({})
  })

  it('a copy that is not a copy', () => {
    expect(parseMirror(null)).toBeNull()
    expect(parseMirror({ stamp: 'x', values: {} })).toBeNull()
    expect(parseMirror({ stamp: 5 })).toBeNull()
    expect(parseMirror({ stamp: 5, values: { 'chat-settings': 7, other: 'x' } })).toEqual({ stamp: 5, values: {} })
  })

  it('only keys that differ are written', () => {
    expect(settingsToRecover(1, { a: 'x', 'chat-settings': 's' }, { stamp: 2, values: { 'chat-settings': 's', 'lu-mobile-theme': 'dark' } })).toEqual({ 'lu-mobile-theme': 'dark' })
  })

  it('clearing the storage drops the copy', async () => {
    const door = memoryDoor()
    stop = installSettingsDurability(door, () => clock)
    localStorage.setItem('chat-settings', settings('dark'))
    await settle()
    expect(door.held).not.toBeNull()
    localStorage.clear()
    await settle()
    expect(door.held).toBeNull()
  })

  it('a copy that cannot be read leaves everything as it is', async () => {
    const door = memoryDoor()
    door.read = async () => {
      throw new Error('IndexedDB is gone')
    }
    localStorage.setItem(SETTINGS_STAMP_KEY, '5')
    localStorage.setItem('chat-settings', settings('light'))
    await expect(recoverSettings(door)).resolves.toBe('nothing')
    expect(localStorage.getItem('chat-settings')).toBe(settings('light'))
  })
})
