/**
 * @vitest-environment jsdom
 *
 * "Install Git" (3.1.3, Davids Wunsch 21.11.): on a new, empty Windows PC the
 * ComfyUI install stopped with "Installing ComfyUI did not finish" because git
 * was missing. Where LU says so, it now offers a button, and once git is
 * there the same install starts again by itself.
 *
 * The flow runs through the real Settings panel and the real install store;
 * only the backend answers are stand-ins: git missing -> button -> install
 * again, with the same target. Plus the button on its own for the Mac
 * (waiting for the Command Line Tools) and Linux (command to copy).
 *
 * Run: npx vitest run src/components/settings/__tests__/git-install-button.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'

const backendCall = vi.fn()
vi.mock('../../../api/backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  isTauri: () => true,
  isMacOS: () => false,
  isWindows: () => true,
  openExternal: vi.fn(),
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
  setComfyPort: vi.fn(),
  setComfyHost: vi.fn(),
}))

const { ComfyUISettings } = await import('../SettingsPage')
const { useComfyInstallStore } = await import('../../../stores/comfyInstallStore')
const { GitInstallButton } = await import('../../ui/GitInstallButton')
const { isGitMissing, gitInstallLine } = await import('../../../lib/git-missing')

const GIT_MISSING = 'Git is not installed. Press Install Git and LU sets up its own Git (about 40 MB, no admin rights needed). Or install Git for Windows from https://git-scm.com/download/win and restart LU.'

beforeEach(() => {
  useComfyInstallStore.getState().reset()
  backendCall.mockReset()
})
afterEach(() => { cleanup(); useComfyInstallStore.getState().reset() })

describe('the sentence and the status line', () => {
  it('finds the git sentence in an install error, nothing else', () => {
    expect(isGitMissing(`Installing ComfyUI did not finish.\n\nLast output from the installer:\n${GIT_MISSING}`)).toBe(true)
    expect(isGitMissing('Installing ComfyUI did not finish.\n\nLast output from the installer:\npip failed')).toBe(false)
    expect(isGitMissing('')).toBe(false)
    expect(isGitMissing(undefined)).toBe(false)
  })

  it('says the download in MB, then ready', () => {
    expect(gitInstallLine({ status: 'downloading', download_progress: 12_400_000, download_total: 39_849_768 })).toBe('Downloading Git... 12 of 40 MB')
    expect(gitInstallLine({ status: 'downloading' })).toBe('Downloading Git...')
    expect(gitInstallLine({ status: 'installing', phase: 'Unpacking Git...' })).toBe('Unpacking Git...')
    expect(gitInstallLine({ status: 'complete' })).toBe('Git is ready.')
    expect(gitInstallLine({ status: 'error', logs: ['The downloaded Git did not match the expected file.'] })).toBe('The downloaded Git did not match the expected file.')
  })
})

describe('git missing -> Install Git -> the install goes on (Settings)', () => {
  it('installs git and then starts the same ComfyUI install again', async () => {
    let gitThere = false
    const installs: unknown[] = []
    backendCall.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'comfyui_status') return { running: false, found: false, path: '', isLocal: true }
      if (cmd === 'python_check') return { available: true }
      if (cmd === 'install_comfyui') { installs.push(args); return { status: 'started' } }
      if (cmd === 'install_comfyui_status') {
        return gitThere
          ? { status: 'complete', logs: ['ComfyUI installed.'] }
          : { status: 'error', logs: ['Step 1/4: Checking git...', GIT_MISSING] }
      }
      if (cmd === 'install_git') return { status: 'downloading' }
      if (cmd === 'install_git_status') {
        gitThere = true
        return { status: 'complete', installed: true, logs: ['git version 2.56.1.windows.1 is ready.'] }
      }
      return {}
    })
    render(createElement(ComfyUISettings))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const path = screen.getByPlaceholderText(/ComfyUI/i) as HTMLInputElement
    fireEvent.change(path, { target: { value: 'D:\\AI\\ComfyUI' } })
    fireEvent.click(await screen.findByRole('button', { name: /Install ComfyUI/i }))

    const gitButton = await screen.findByRole('button', { name: /Install Git/i }, { timeout: 6000 })
    expect(screen.getAllByText(/Git is not installed/).length).toBeGreaterThan(0)
    expect(installs).toHaveLength(1)

    fireEvent.click(gitButton)
    await waitFor(() => expect(installs).toHaveLength(2), { timeout: 6000 })
    expect(installs[1]).toEqual(installs[0])
    expect((installs[0] as { installPath?: string }).installPath).toBe('D:\\AI\\ComfyUI')
    expect(backendCall.mock.calls.map((c) => c[0])).toContain('install_git')
    await waitFor(() => expect(useComfyInstallStore.getState().phase).toBe('idle'), { timeout: 6000 })
    expect(useComfyInstallStore.getState().error).toBe('')
  }, 20_000)
})

describe('the button on its own', () => {
  it('Mac: waits for the Command Line Tools, then says ready once', async () => {
    let asks = 0
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'install_git') return { status: 'installing' }
      if (cmd === 'install_git_status') {
        asks += 1
        return asks < 2
          ? { status: 'installing', installed: false, phase: 'macOS asks to install its Command Line Tools, which include Git.' }
          : { status: 'complete', installed: true }
      }
      return {}
    })
    const ready = vi.fn()
    render(createElement(GitInstallButton, { onReady: ready }))
    fireEvent.click(screen.getByRole('button', { name: /Install Git/i }))
    await screen.findByText(/Command Line Tools/, undefined, { timeout: 5000 })
    await screen.findByText('Git is ready.', undefined, { timeout: 8000 })
    expect(ready).toHaveBeenCalledTimes(1)
  }, 15_000)

  it('Linux: shows the command to copy and goes on after Check again', async () => {
    let installed = false
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'install_git') return { status: 'manual', command: 'sudo apt install git' }
      if (cmd === 'install_git_status') return installed ? { status: 'complete', installed: true } : { status: 'manual', installed: false, command: 'sudo apt install git' }
      return {}
    })
    const ready = vi.fn()
    render(createElement(GitInstallButton, { onReady: ready }))
    fireEvent.click(screen.getByRole('button', { name: /Install Git/i }))
    expect(await screen.findByText('sudo apt install git')).toBeTruthy()
    expect(ready).not.toHaveBeenCalled()
    installed = true
    fireEvent.click(screen.getByRole('button', { name: /Check again/i }))
    await screen.findByText('Git is ready.')
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('a failed download says why and the button stays', async () => {
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'install_git') return { status: 'downloading' }
      if (cmd === 'install_git_status') return { status: 'error', installed: false, logs: ['Downloading Git did not work (HTTP 404). Check the internet connection and press Install Git again.'] }
      return {}
    })
    render(createElement(GitInstallButton))
    fireEvent.click(screen.getByRole('button', { name: /Install Git/i }))
    expect(await screen.findByText(/HTTP 404/, undefined, { timeout: 4000 })).toBeTruthy()
    expect((screen.getByRole('button', { name: /Install Git/i }) as HTMLButtonElement).disabled).toBe(false)
  })
})
