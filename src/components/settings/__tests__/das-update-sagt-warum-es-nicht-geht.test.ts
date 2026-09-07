/**
 * @vitest-environment jsdom
 *
 * Zen, Arch Linux, 06.09.2026: the update downloaded, asked for his password
 * and then failed. He had installed LU from the AUR package
 * locally-uncensored-bin, and the updater plugin cannot tell that apart from a
 * Debian install (UPDATER-LINUX-BEFUND.md).
 *
 * The store refuses the update on those installs. This is about what he SEES
 * while it refuses: a sentence naming his own package manager instead of a
 * dead Download button, and, on the installs where the update does run a
 * package install, a warning that the password prompt is his system's and not
 * a login LU is asking for.
 *
 * Run: npx vitest run src/components/settings/__tests__/das-update-sagt-warum-es-nicht-geht.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const openExternal = vi.fn()

vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async () => ({})),
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

const AUR_REFUSAL = 'This copy was installed with your package manager (AUR package '
  + 'locally-uncensored-bin). Update it with your AUR helper, for example '
  + 'yay -Syu locally-uncensored-bin. The AUR package is maintained by a '
  + 'community member and can lag a few days behind the GitHub release.'

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
    installMethod: null,
    ...over,
  })
  render(createElement(UpdateSection))
  // The section starts folded, like every other one on the page.
  fireEvent.click(screen.getByText('Updates'))
  await act(async () => { await Promise.resolve() })
}

afterEach(cleanup)
beforeEach(() => { openExternal.mockReset() })

describe('an install LU may not replace', () => {
  it('says which package manager owns it instead of offering a download', async () => {
    await section({
      downloadStatus: 'unavailable',
      errorMessage: AUR_REFUSAL,
      installMethod: { kind: 'pacman', exePath: '/usr/bin/locally-uncensored', writable: false, hint: '' },
    })

    expect(screen.getByTestId('update-unavailable').textContent).toContain('yay -Syu locally-uncensored-bin')
    // No dead button: the one thing left to click leads to the release page.
    expect(screen.queryByText('Download Update')).toBeNull()
    expect(screen.queryByText('Retry')).toBeNull()
    fireEvent.click(screen.getByText('View Release'))
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('names the folder when the AppImage cannot be replaced', async () => {
    await section({
      downloadStatus: 'unavailable',
      errorMessage: 'The AppImage sits in a folder you cannot write to (/opt/LU.AppImage). '
        + 'Move it to your home folder or download the new AppImage from the release page.',
      installMethod: { kind: 'appimage', exePath: '/opt/LU.AppImage', writable: false, hint: '' },
    })

    expect(screen.getByTestId('update-unavailable').textContent).toContain('/opt/LU.AppImage')
  })
})

describe('an install LU may replace', () => {
  it('warns that the system, not LU, is about to ask for a password', async () => {
    await section({
      downloadStatus: 'downloaded',
      installMethod: { kind: 'deb', exePath: '/usr/bin/locally-uncensored', writable: false, hint: '' },
    })

    expect(screen.getByTestId('update-password-notice').textContent).toContain('not an LU login')
    // And the install itself is still on offer.
    expect(screen.getByText('Restart Now')).toBeTruthy()
  })

  it('keeps quiet before there is anything to install', async () => {
    await section({
      downloadStatus: 'idle',
      installMethod: { kind: 'deb', exePath: '/usr/bin/locally-uncensored', writable: false, hint: '' },
    })

    expect(screen.queryByTestId('update-password-notice')).toBeNull()
    expect(screen.queryByTestId('update-unavailable')).toBeNull()
    expect(screen.getByText('Download Update')).toBeTruthy()
  })

  it('says nothing extra on a Windows or AppImage install', async () => {
    await section({
      downloadStatus: 'downloaded',
      installMethod: { kind: 'msi', exePath: 'C:/Program Files/LU/LU.exe', writable: true, hint: '' },
    })

    expect(screen.queryByTestId('update-password-notice')).toBeNull()
    expect(screen.getByText('Restart Now')).toBeTruthy()
  })
})
