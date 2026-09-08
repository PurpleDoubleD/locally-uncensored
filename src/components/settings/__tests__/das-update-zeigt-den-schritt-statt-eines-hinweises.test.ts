/**
 * @vitest-environment jsdom
 *
 * Zen, Arch Linux, 06.09.2026: the update downloaded, asked for his password
 * and then failed. He had installed LU from the AUR package
 * locally-uncensored-bin, and the updater plugin cannot tell that apart from a
 * Debian install (UPDATER-LINUX-BEFUND.md).
 *
 * The fix is not a sentence explaining that to him. On his install the same
 * two buttons now run LU's own install, and this is about what he SEES while
 * that happens: an ordinary Download button, an ordinary progress bar, and the
 * name of the step for the parts that have no percentage. Nothing that sends
 * him to a release page, nothing that warns him about a password.
 *
 * Run: npx vitest run src/components/settings/__tests__/das-update-zeigt-den-schritt-statt-eines-hinweises.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const openExternal = vi.fn()
const backendCall = vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => ({}))

vi.mock('../../../api/backend', () => ({
  backendCall: (cmd: string, args?: Record<string, unknown>) => backendCall(cmd, args),
  isTauri: () => true,
  isMacOS: () => false,
  isLinux: () => true,
  isWindows: () => false,
  openExternal,
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

const { UpdateSection } = await import('../SettingsPage')
const { useUpdateStore } = await import('../../../stores/updateStore')

/** The AUR install, as the Rust probe reports it. */
const AUR = { kind: 'pacman' as const, exePath: '/usr/bin/locally-uncensored', writable: false }

async function section(over: Record<string, unknown>) {
  useUpdateStore.setState({
    currentVersion: '2.6.7',
    latestVersion: '2.6.8',
    updateAvailable: true,
    releaseNotes: null,
    isChecking: false,
    dismissed: null,
    downloadStatus: 'idle',
    downloadProgress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    errorMessage: null,
    progressNote: null,
    installMethod: null,
    ...over,
  })
  render(createElement(UpdateSection))
  // The section starts folded, like every other one on the page.
  fireEvent.click(screen.getByText('Updates'))
  await act(async () => { await Promise.resolve() })
}

afterEach(cleanup)
beforeEach(() => { openExternal.mockReset(); backendCall.mockClear() })

describe('the install the plugin cannot serve', () => {
  it('offers the ordinary Download button and explains nothing', async () => {
    await section({ installMethod: AUR })

    expect(screen.getByText('Download Update')).toBeTruthy()
    // No dead end and no homework: the old build sent this user to the
    // release page with a paragraph about his AUR helper.
    expect(screen.queryByText('View Release')).toBeNull()
    expect(screen.queryByTestId('update-unavailable')).toBeNull()
    expect(screen.queryByTestId('update-password-notice')).toBeNull()
  })

  it('names the step while the percentage means nothing', async () => {
    await section({
      installMethod: AUR,
      downloadStatus: 'downloading',
      downloadProgress: 100,
      downloadedBytes: 118_000_000,
      totalBytes: 118_000_000,
      progressNote: 'Checking the signature',
    })

    expect(screen.getByText('Checking the signature')).toBeTruthy()
    // The step replaces the percentage rather than sitting next to it.
    expect(screen.queryByText('100%')).toBeNull()
  })

  it('shows bytes and percent while they are still the truth', async () => {
    await section({
      installMethod: AUR,
      downloadStatus: 'downloading',
      downloadProgress: 42,
      downloadedBytes: 50_000_000,
      totalBytes: 118_000_000,
      progressNote: null,
    })

    expect(screen.getByText('42%')).toBeTruthy()
  })

  it('ends on the same Restart button as every other install', async () => {
    await section({ installMethod: AUR, downloadStatus: 'downloaded', downloadProgress: 100 })

    expect(screen.getByText('Restart Now')).toBeTruthy()
    expect(screen.getByText('Download complete')).toBeTruthy()
    expect(screen.queryByTestId('update-password-notice')).toBeNull()
  })
})

describe('the installs that always worked', () => {
  it('says nothing extra on a Debian install either', async () => {
    await section({
      downloadStatus: 'downloaded',
      installMethod: { kind: 'deb', exePath: '/usr/bin/locally-uncensored', writable: false },
    })

    expect(screen.getByText('Restart Now')).toBeTruthy()
    expect(screen.queryByTestId('update-password-notice')).toBeNull()
  })

  it('still shows a failure as a failure, with a Retry', async () => {
    await section({
      installMethod: AUR,
      downloadStatus: 'error',
      errorMessage: 'The update could not be downloaded. the download broke off',
    })

    expect(screen.getByText(/could not be downloaded/)).toBeTruthy()
    expect(screen.getByText('Retry')).toBeTruthy()
  })
})
