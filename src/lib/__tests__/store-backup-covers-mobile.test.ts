/**
 * M8 (round 3): what the phone shell keeps must be in the backup.
 *
 * store-backup-covers-every-store.test.ts walks src/stores. The phone shell
 * keeps stores of its own under src/mobile, which that walk never saw: the
 * Remote chats, the saved Create presets and the character names did not
 * survive a lost WebView storage, and neither did the list of paid cloud jobs
 * that were still running.
 *
 * This one reads the source of src/mobile and src/lib for every zustand
 * persist name, and holds the list against STORE_KEYS.
 *
 * Run: npx vitest run src/lib/__tests__/store-backup-covers-mobile.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '../..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

/** Every `name: '...'` handed to a zustand persist in this file. */
function persistNames(source: string): string[] {
  if (!/\bpersist\s*\(/.test(source)) return []
  const names: string[] = []
  for (const m of source.matchAll(/\bname:\s*['"]([a-z0-9_-]+)['"]\s*,\s*\n?\s*(?:version|storage|partialize)/gi)) names.push(m[1])
  for (const m of source.matchAll(/\{\s*name:\s*['"]([a-z0-9_-]+)['"]\s*,\s*storage:/gi)) names.push(m[1])
  return [...new Set(names)]
}

/**
 * Persisted under src/mobile and left out on purpose. Each needs a reason:
 * a key that is merely forgotten belongs in STORE_KEYS.
 */
const LEFT_OUT: Record<string, string> = {
  // A day-old answer about the newest version. A restore must not bring back an old one.
  'lu-mobile-app-update': 'cache of the update check, asked again within a day',
}

describe('the backup covers what the phone shell persists', () => {
  it('lists every persist name declared under src/mobile', async () => {
    const { STORE_KEYS } = await import('../store-backup')
    const found = new Map<string, string>()
    for (const file of sourceFiles(join(SRC, 'mobile'))) {
      for (const name of persistNames(readFileSync(file, 'utf8'))) found.set(name, file.slice(SRC.length + 1))
    }
    // The Remote store takes its name from a constant.
    const remote = readFileSync(join(SRC, 'mobile/remote/remoteClientStore.ts'), 'utf8')
    const remoteKey = /export const REMOTE_STORE_KEY = '([a-z-]+)'/.exec(remote)?.[1]
    expect(remoteKey).toBe('lu-mobile-remote')
    expect(remote).toMatch(/const name = deps\.name \?\? REMOTE_STORE_KEY/)
    found.set(remoteKey!, 'mobile/remote/remoteClientStore.ts')

    // The walk has to find the stores it is about, or it guards nothing.
    for (const known of ['lu-mobile-settings-prefs', 'lu-mobile-create-presets', 'lu-mobile-character-names']) {
      expect([...found.keys()], known).toContain(known)
    }
    const missing = [...found].filter(([name]) => !STORE_KEYS.includes(name) && !(name in LEFT_OUT)).map(([name, file]) => `${file}: ${name}`)
    expect(missing).toEqual([])
  })

  it('names the keys the review found missing, and the two lists of running cloud jobs', async () => {
    const { STORE_KEYS, IDB_STORE_KEYS } = await import('../store-backup')
    const { PENDING_CLOUD_JOBS_KEY, CLOUD_SUBMIT_INTENTS_KEY } = await import('../pending-cloud-jobs')
    for (const key of ['lu-mobile-remote', 'lu-mobile-create-presets', 'lu-mobile-character-names', PENDING_CLOUD_JOBS_KEY, CLOUD_SUBMIT_INTENTS_KEY]) {
      expect(STORE_KEYS, key).toContain(key)
    }
    // The Remote chats live on IndexedDB: read from there, restored to there.
    expect(IDB_STORE_KEYS.has('lu-mobile-remote')).toBe(true)
    for (const key of ['lu-mobile-create-presets', 'lu-mobile-character-names', PENDING_CLOUD_JOBS_KEY, CLOUD_SUBMIT_INTENTS_KEY]) {
      expect(IDB_STORE_KEYS.has(key), key).toBe(false)
    }
  })

  it('never lists the Remote token, and the Remote state does not hold it', async () => {
    const { STORE_KEYS } = await import('../store-backup')
    const { TOKEN_VAULT_KEY } = await import('../../mobile/remote/tokenVault')
    expect(STORE_KEYS).not.toContain(TOKEN_VAULT_KEY)
    // What the Remote store writes: connection, chats, active chat, drafts.
    const remote = readFileSync(join(SRC, 'mobile/remote/remoteClientStore.ts'), 'utf8')
    const partialize = /partialize: \(s\): Persisted => \(\{([\s\S]*?)\}\)/.exec(remote)?.[1] ?? ''
    // Round 22 (N10): the connection only once it ever worked. Still the same four fields, nothing else.
    const fields = partialize.replace(/\/\/[^\n]*\n/g, '').replace(/\s+/g, ' ').trim()
    expect(fields).toBe('connection: connectionEverWorked(s.connection) ? s.connection : null, chats: s.chats, activeChatId: s.activeChatId, drafts: s.drafts,')
    const connection = /export interface RemoteConnection \{([\s\S]*?)\n\}/.exec(remote)?.[1] ?? ''
    expect(connection).not.toMatch(/token|code|secret|password/i)
  })
})

describe('a finished job leaves the backup too', () => {
  it('writes an emptied list as [] instead of removing the key', async () => {
    vi.resetModules()
    const mem = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
    })
    vi.doMock('../device-kind', () => ({ isMobile: () => true, isIOS: () => false, isAndroid: () => true }))
    const jobs = await import('../pending-cloud-jobs')
    jobs.notePendingCloudJob({ id: 'job-1', kind: 'image', op: 'generate', model: 'm', prompt: 'p', startedAt: Date.now(), deadlineAt: Date.now() + 60_000, landing: 'gallery' })
    expect(mem.get(jobs.PENDING_CLOUD_JOBS_KEY)).toContain('job-1')
    jobs.forgetPendingCloudJob('job-1')
    // Present and empty: the snapshot takes it and the old list is replaced.
    expect(mem.get(jobs.PENDING_CLOUD_JOBS_KEY)).toBe('[]')
    expect(jobs.pendingCloudJobs()).toEqual([])
    vi.doUnmock('../device-kind')
    vi.unstubAllGlobals()
  })
})

describe('the snapshot carries them', () => {
  beforeEach(() => {
    vi.resetModules()
    const mem = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the Remote chats from IndexedDB and the others from localStorage', async () => {
    const idb = new Map<string, string>()
    vi.doMock('../../api/backend', () => ({ backendCall: vi.fn(async () => undefined), isTauri: () => true }))
    vi.doMock('../idbStorage', () => ({
      idbStorage: {
        getItem: async (key: string) => idb.get(key) ?? null,
        setItem: async (key: string, value: string) => void idb.set(key, value),
        removeItem: async (key: string) => void idb.delete(key),
      },
      hasFailedRead: () => false,
      onIdbWrite: () => () => {},
    }))
    const remote = JSON.stringify({ state: { connection: null, chats: [{ id: 'c1', title: 'From the desk' }], activeChatId: 'c1', drafts: {} }, version: 1 })
    idb.set('lu-mobile-remote', remote)
    // A copy in localStorage must not be what is read: the store is not there.
    localStorage.setItem('lu-mobile-remote', '{"stale":true}')
    localStorage.setItem('lu-mobile-create-presets', '{"state":{"presets":[{"id":"p1"}]},"version":0}')
    localStorage.setItem('lu-mobile-character-names', '{"state":{"names":{"a":"Mia"}},"version":0}')
    localStorage.setItem('lu-pending-cloud-jobs', '[{"id":"job-1"}]')
    localStorage.setItem('lu-cloud-submit-intents', '[{"requestId":"r-1"}]')

    const { collectStoreSnapshot } = await import('../store-backup')
    const snapshot = await collectStoreSnapshot()
    expect(snapshot['lu-mobile-remote']).toBe(remote)
    expect(snapshot['lu-mobile-create-presets']).toContain('p1')
    expect(snapshot['lu-mobile-character-names']).toContain('Mia')
    expect(snapshot['lu-pending-cloud-jobs']).toContain('job-1')
    expect(snapshot['lu-cloud-submit-intents']).toContain('r-1')
    vi.doUnmock('../../api/backend')
    vi.doUnmock('../idbStorage')
  })
})
