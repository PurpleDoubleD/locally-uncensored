/**
 * On an install the updater plugin cannot serve, LU installs itself.
 *
 * Zen, Arch Linux, 06.09.2026: "auto update downloads the update, then asks me
 * for a password, I type my user password, then it fails." He installed LU
 * from the AUR package locally-uncensored-bin, which unpacks our .deb into
 * /usr. The updater plugin decides between AppImage, deb and rpm by reading a
 * string the bundler patched into the binary rather than by looking at the
 * machine, so on Arch it picks linux-x86_64-deb out of latest.json, downloads
 * a Debian package and runs `pkexec dpkg -i` on a box with no dpkg. polkit
 * asks for the password first and the command fails afterwards, which is
 * exactly the order he described. Full trace with line numbers in
 * UPDATER-LINUX-BEFUND.md.
 *
 * What is pinned here is that he never has to know any of that: the same
 * Download button fetches the AppImage, the same Restart button puts it in his
 * home folder and starts it, and the plugin's own lane keeps working untouched
 * wherever it does work.
 *
 * Run: npx vitest run src/stores/__tests__/update-installiert-sich-auf-arch-selbst.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

const backendCall = vi.fn()
const linux = { yes: true }

vi.mock('../../api/backend', () => ({
  isTauri: () => true,
  isLinux: () => linux.yes,
  openExternal: vi.fn(),
  backendCall: (cmd: string, args?: Record<string, unknown>) => backendCall(cmd, args),
}))

vi.mock('../../api/engine', () => ({
  stopBundledEngine: vi.fn(async () => {}),
  stopBundledEmbed: vi.fn(async () => {}),
}))

vi.mock('../../../package.json', () => ({ version: '2.6.7' }))

const handle = vi.hoisted(() => ({
  download: vi.fn(),
  install: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => ({
    version: '2.6.8',
    body: 'notes',
    download: handle.download,
    install: handle.install,
  })),
}))

/** The progress events the Rust side emits while it installs LU itself. */
const events = vi.hoisted(() => ({
  listener: null as null | ((e: { payload: Record<string, unknown> }) => void),
  unlisten: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: Record<string, unknown> }) => void) => {
    events.listener = cb
    return events.unlisten
  }),
}))

const {
  useUpdateStore,
  installsItself,
  parseInstallMethod,
  resetUpdateSession,
} = await import('../updateStore')

/** The answer the Rust command gives, in the shape it gives it. */
function method(over: Record<string, unknown> = {}) {
  return { kind: 'unknown', exe_path: '/usr/bin/locally-uncensored', writable: false, ...over }
}

function reset(kind: unknown) {
  resetUpdateSession()
  handle.download.mockReset()
  handle.install.mockReset()
  handle.download.mockImplementation(async (cb: (e: unknown) => void) => {
    cb({ event: 'Started', data: { contentLength: 100 } })
    cb({ event: 'Progress', data: { chunkLength: 100 } })
    cb({ event: 'Finished' })
  })
  events.listener = null
  events.unlisten.mockReset()
  backendCall.mockReset()
  backendCall.mockImplementation(async (cmd: string) => {
    if (cmd === 'install_method') {
      if (kind instanceof Error) throw kind
      return kind
    }
    if (cmd === 'self_migrate_stage') {
      // The real command reports its download through events on the way.
      events.listener?.({ payload: { phase: 'download', downloaded: 50, total: 100 } })
      events.listener?.({ payload: { phase: 'verify', downloaded: 100, total: 100 } })
      return { version: '2.6.8', bytes: 100, staged: '/home/zen/.local/share/locally-uncensored/x.part' }
    }
    return null
  })
  linux.yes = true
  useUpdateStore.setState({
    currentVersion: '2.6.7',
    latestVersion: null,
    updateAvailable: false,
    releaseNotes: null,
    isChecking: false,
    lastChecked: null,
    dismissed: null,
    autoDownload: true,
    downloadStatus: 'idle',
    downloadProgress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    errorMessage: null,
    progressNote: null,
    installMethod: null,
  })
}

/** checkForUpdate fires the download without awaiting it. */
const settle = () => new Promise((r) => setTimeout(r, 0))

const calls = (cmd: string) => backendCall.mock.calls.filter(([c]) => c === cmd)

// ── The rule, on its own ──────────────────────────────────────

describe('who installs the update', () => {
  it('takes over on an AUR install, where the plugin would run dpkg', () => {
    expect(installsItself({ kind: 'pacman', exePath: '/usr/bin/locally-uncensored', writable: false })).toBe(true)
  })

  it('takes over on a binary no package manager claims, but only on Linux', () => {
    const m = { kind: 'unknown' as const, exePath: '/usr/bin/locally-uncensored', writable: false }
    linux.yes = true
    expect(installsItself(m)).toBe(true)
    // On macOS an app in /Applications is 'unknown' too, and there the plugin
    // works. Migrating it would be a Linux fix breaking every Mac.
    linux.yes = false
    expect(installsItself(m)).toBe(false)
    linux.yes = true
  })

  it('takes over for an AppImage in a folder the user cannot write to', () => {
    // The plugin's first move there is a rename INSIDE that folder, which
    // fails with EACCES and no prompt at all (updater.rs:1003).
    expect(installsItself({ kind: 'appimage', exePath: '/opt/LU.AppImage', writable: false })).toBe(true)
    expect(installsItself({ kind: 'appimage', exePath: '/home/zen/LU.AppImage', writable: true })).toBe(false)
  })

  it('leaves the lanes that work to the plugin', () => {
    for (const kind of ['deb', 'rpm', 'msi'] as const) {
      expect(installsItself({ kind, exePath: '/usr/bin/locally-uncensored', writable: false })).toBe(false)
    }
  })

  it('treats a missing answer as no answer at all', () => {
    expect(installsItself(null)).toBe(false)
    expect(parseInstallMethod(null)).toBeNull()
    expect(parseInstallMethod({ kind: 'something-new' })).toBeNull()
    expect(parseInstallMethod({ kind: 'pacman' })).toEqual({
      kind: 'pacman', exePath: '', writable: false,
    })
  })
})

// ── The store, end to end ─────────────────────────────────────

describe('the store on an AUR install', () => {
  it('fetches LU s own AppImage instead of the Debian package', async () => {
    reset(method({ kind: 'pacman' }))

    await useUpdateStore.getState().checkForUpdate(true)
    await settle()

    // Not one byte through the plugin: that is the download that ends in
    // pkexec dpkg -i on a box with no dpkg.
    expect(handle.download).not.toHaveBeenCalled()
    expect(calls('self_migrate_stage')).toHaveLength(1)

    const s = useUpdateStore.getState()
    expect(s.updateAvailable).toBe(true)
    expect(s.downloadStatus).toBe('downloaded')
    expect(s.errorMessage).toBeNull()
  })

  it('shows the bytes while they land and names the step after them', async () => {
    reset(method({ kind: 'pacman' }))
    // Hold the command open after its events so the state can be read
    // mid-flight, the way the progress bar sees it.
    let release = () => {}
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'install_method') return method({ kind: 'pacman' })
      if (cmd === 'self_migrate_stage') {
        events.listener?.({ payload: { phase: 'download', downloaded: 25, total: 100 } })
        events.listener?.({ payload: { phase: 'verify', downloaded: 100, total: 100 } })
        await new Promise<void>((r) => { release = r })
        return { version: '2.6.8', bytes: 100 }
      }
      return null
    })

    const running = useUpdateStore.getState().downloadUpdate()
    await settle()

    const mid = useUpdateStore.getState()
    expect(mid.downloadedBytes).toBe(25)
    expect(mid.totalBytes).toBe(100)
    expect(mid.downloadProgress).toBe(25)
    // The signature check has no length to show, so it says what it is doing.
    expect(mid.progressNote).toBe('Checking the signature')

    release()
    await running
    const done = useUpdateStore.getState()
    expect(done.downloadStatus).toBe('downloaded')
    expect(done.progressNote).toBeNull()
    // The listener is dropped again, or every retry would stack another one.
    expect(events.unlisten).toHaveBeenCalled()
  })

  it('installs and restarts through the backend, not through the plugin', async () => {
    reset(method({ kind: 'pacman' }))
    await useUpdateStore.getState().checkForUpdate(true)
    await settle()

    await useUpdateStore.getState().installAndRestart()

    expect(handle.install).not.toHaveBeenCalled()
    expect(calls('self_migrate_finish')).toHaveLength(1)
    // And the app goes down afterwards, so the new AppImage can take over.
    expect(calls('exit_app')).toHaveLength(1)
  })

  it('never restarts on its own, however far the auto-download got', async () => {
    reset(method({ kind: 'pacman' }))
    await useUpdateStore.getState().checkForUpdate(true)
    await settle()

    // Auto-download ran the whole staging step and stopped there.
    expect(calls('self_migrate_stage')).toHaveLength(1)
    expect(calls('self_migrate_finish')).toHaveLength(0)
    expect(calls('exit_app')).toHaveLength(0)
  })

  it('says so in English when the download fails, and keeps the button alive', async () => {
    reset(method({ kind: 'pacman' }))
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'install_method') return method({ kind: 'pacman' })
      if (cmd === 'self_migrate_stage') throw new Error('the signature does not match the downloaded file')
      return null
    })

    await useUpdateStore.getState().downloadUpdate()

    const s = useUpdateStore.getState()
    expect(s.downloadStatus).toBe('error')
    expect(s.errorMessage).toContain('The update could not be downloaded.')
    expect(s.errorMessage).toContain('signature')
    expect(s.progressNote).toBeNull()

    // A failed staging leaves nothing to install: Restart must not pretend.
    await useUpdateStore.getState().installAndRestart()
    expect(calls('self_migrate_finish')).toHaveLength(0)
    expect(useUpdateStore.getState().errorMessage).toContain('Download it again.')
  })

  it('asks the backend once, not once per click', async () => {
    reset(method({ kind: 'pacman' }))
    await useUpdateStore.getState().checkForUpdate(true)
    await settle()
    await useUpdateStore.getState().downloadUpdate()

    expect(calls('install_method')).toHaveLength(1)
  })
})

describe('the store on the installs the plugin serves', () => {
  it('downloads and installs a deb exactly as before', async () => {
    reset(method({ kind: 'deb' }))

    await useUpdateStore.getState().checkForUpdate(true)
    await settle()
    expect(handle.download).toHaveBeenCalledTimes(1)
    expect(calls('self_migrate_stage')).toHaveLength(0)
    expect(useUpdateStore.getState().downloadStatus).toBe('downloaded')

    await useUpdateStore.getState().installAndRestart()
    expect(handle.install).toHaveBeenCalledTimes(1)
    expect(calls('self_migrate_finish')).toHaveLength(0)
  })

  it('carries on when the backend does not know the command', async () => {
    // An older backend, or a probe that threw. Not being able to ask is not a
    // reason to withhold an update from someone whose updater works.
    reset(new Error('unknown command install_method'))

    await useUpdateStore.getState().checkForUpdate(true)
    await settle()
    expect(handle.download).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().downloadStatus).toBe('downloaded')

    await useUpdateStore.getState().installAndRestart()
    expect(handle.install).toHaveBeenCalledTimes(1)
  })

  it('takes the AppImage in /opt off the plugin and onto our own install', async () => {
    reset(method({ kind: 'appimage', exe_path: '/opt/LU.AppImage', writable: false }))

    await useUpdateStore.getState().checkForUpdate(true)
    await settle()
    expect(handle.download).not.toHaveBeenCalled()
    expect(calls('self_migrate_stage')).toHaveLength(1)

    await useUpdateStore.getState().installAndRestart()
    expect(handle.install).not.toHaveBeenCalled()
    expect(calls('self_migrate_finish')).toHaveLength(1)
  })

  it('leaves an AppImage the user owns on the plugin s in place swap', async () => {
    reset(method({ kind: 'appimage', exe_path: '/home/zen/LU.AppImage', writable: true }))

    await useUpdateStore.getState().checkForUpdate(true)
    await settle()
    expect(handle.download).toHaveBeenCalledTimes(1)
    expect(calls('self_migrate_stage')).toHaveLength(0)
  })
})
