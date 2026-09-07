/**
 * The in-app updater must not touch a copy it did not install.
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
 * What is pinned here is the refusal: on those installs nothing is downloaded
 * and nothing is installed, and the reason is on screen instead. The two lanes
 * where the updater does work keep working, deb included, because "be careful"
 * that stops a working update is the more expensive bug.
 *
 * Run: npx vitest run src/stores/__tests__/update-laesst-fremde-installationen-in-ruhe.test.ts
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

const {
  useUpdateStore,
  updateBlockedBecause,
  installPasswordNotice,
  parseInstallMethod,
  resetInstallMethodProbe,
} = await import('../updateStore')

/** The answer the Rust command gives, in the shape it gives it. */
function method(over: Record<string, unknown> = {}) {
  return { kind: 'unknown', exe_path: '/usr/bin/locally-uncensored', writable: false, hint: '', ...over }
}

function reset(kind: unknown) {
  resetInstallMethodProbe()
  handle.download.mockReset()
  handle.install.mockReset()
  handle.download.mockImplementation(async (cb: (e: unknown) => void) => {
    cb({ event: 'Started', data: { contentLength: 100 } })
    cb({ event: 'Progress', data: { chunkLength: 100 } })
    cb({ event: 'Finished' })
  })
  backendCall.mockReset()
  backendCall.mockImplementation(async (cmd: string) => {
    if (cmd === 'install_method') {
      if (kind instanceof Error) throw kind
      return kind
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
    installMethod: null,
  })
}

/** checkForUpdate fires the download without awaiting it. */
const settle = () => new Promise((r) => setTimeout(r, 0))

// ── The rule, on its own ──────────────────────────────────────

describe('who may be updated in place', () => {
  it('refuses a pacman install and names the AUR package', () => {
    const reason = updateBlockedBecause({ kind: 'pacman', exePath: '/usr/bin/locally-uncensored', writable: false, hint: '' })
    expect(reason).toContain('locally-uncensored-bin')
    expect(reason).toContain('yay -Syu')
    // The AUR package is somebody else's to publish, and it lagged 2.6.7
    // behind 2.6.8 for days. Saying so is the difference between "LU is
    // broken" and "the package has not caught up yet".
    expect(reason).toContain('community member')
  })

  it('lets a deb and an rpm through, and announces the password prompt', () => {
    for (const kind of ['deb', 'rpm'] as const) {
      const m = { kind, exePath: '/usr/bin/locally-uncensored', writable: false, hint: '' }
      expect(updateBlockedBecause(m)).toBeNull()
      expect(installPasswordNotice(m)).toContain('not an LU login')
    }
  })

  it('says nothing about a password where there is none', () => {
    for (const kind of ['appimage', 'pacman', 'msi', 'unknown'] as const) {
      expect(installPasswordNotice({ kind, exePath: '', writable: true, hint: '' })).toBeNull()
    }
  })

  it('refuses an AppImage in a folder the user cannot write to, and names it', () => {
    const reason = updateBlockedBecause({ kind: 'appimage', exePath: '/opt/LU.AppImage', writable: false, hint: '' })
    expect(reason).toContain('/opt/LU.AppImage')
    // The plugin's first move is a rename INSIDE that folder, so this fails
    // with EACCES and no prompt at all (updater.rs:1003).
    expect(reason).toContain('release page')
  })

  it('lets an AppImage the user owns update itself', () => {
    expect(updateBlockedBecause({ kind: 'appimage', exePath: '/home/zen/LU.AppImage', writable: true, hint: '' })).toBeNull()
  })

  it('refuses an unclaimed binary on Linux and allows one everywhere else', () => {
    const m = { kind: 'unknown' as const, exePath: '/usr/bin/locally-uncensored', writable: false, hint: '' }
    linux.yes = true
    expect(updateBlockedBecause(m)).toContain('does not recognise')
    // On macOS an app in /Applications is 'unknown' too, and there the
    // updater works. Blocking it would break every Mac.
    linux.yes = false
    expect(updateBlockedBecause(m)).toBeNull()
  })

  it('treats a missing answer as no answer at all', () => {
    expect(updateBlockedBecause(null)).toBeNull()
    expect(parseInstallMethod(null)).toBeNull()
    expect(parseInstallMethod({ kind: 'something-new' })).toBeNull()
    expect(parseInstallMethod({ kind: 'pacman' })).toEqual({
      kind: 'pacman', exePath: '', writable: false, hint: '',
    })
  })
})

// ── The store, end to end ─────────────────────────────────────

describe('the store on an AUR install', () => {
  it('downloads nothing at all', async () => {
    reset(method({ kind: 'pacman' }))

    await useUpdateStore.getState().checkForUpdate(true)
    await settle()
    // The auto-download would otherwise have started right here.
    expect(handle.download).not.toHaveBeenCalled()

    await useUpdateStore.getState().downloadUpdate()
    expect(handle.download).not.toHaveBeenCalled()

    const s = useUpdateStore.getState()
    expect(s.updateAvailable).toBe(true)
    expect(s.latestVersion).toBe('2.6.8')
    expect(s.downloadStatus).toBe('unavailable')
    expect(s.errorMessage).toContain('yay -Syu locally-uncensored-bin')
  })

  it('installs nothing either, even when a download somehow finished', async () => {
    reset(method({ kind: 'pacman' }))
    await useUpdateStore.getState().checkForUpdate(true)
    await settle()
    useUpdateStore.setState({ downloadStatus: 'downloaded' })

    await useUpdateStore.getState().installAndRestart()
    expect(handle.install).not.toHaveBeenCalled()
    expect(useUpdateStore.getState().downloadStatus).toBe('unavailable')
  })

  it('asks the backend once, not once per click', async () => {
    reset(method({ kind: 'pacman' }))
    await useUpdateStore.getState().checkForUpdate(true)
    await settle()
    await useUpdateStore.getState().downloadUpdate()
    await useUpdateStore.getState().downloadUpdate()

    const probes = backendCall.mock.calls.filter(([cmd]) => cmd === 'install_method')
    expect(probes).toHaveLength(1)
  })
})

describe('the store on the installs that do work', () => {
  it('downloads and installs a deb exactly as before', async () => {
    reset(method({ kind: 'deb' }))

    await useUpdateStore.getState().checkForUpdate(true)
    await settle()
    expect(handle.download).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().downloadStatus).toBe('downloaded')
    expect(installPasswordNotice(useUpdateStore.getState().installMethod)).toContain('password')

    await useUpdateStore.getState().installAndRestart()
    expect(handle.install).toHaveBeenCalledTimes(1)
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

  it('stops the AppImage in /opt before install(), not after', async () => {
    reset(method({ kind: 'appimage', exe_path: '/opt/LU.AppImage', writable: false }))

    await useUpdateStore.getState().checkForUpdate(true)
    await settle()
    expect(handle.download).not.toHaveBeenCalled()

    useUpdateStore.setState({ downloadStatus: 'downloaded' })
    await useUpdateStore.getState().installAndRestart()
    expect(handle.install).not.toHaveBeenCalled()
    expect(useUpdateStore.getState().errorMessage).toContain('/opt/LU.AppImage')
  })
})
