/**
 * @vitest-environment jsdom
 *
 * A15 review, 03.09., two findings on the closing line a finished run leaves.
 *
 * 1. It was painted amber whatever it said, so "Repair finished. ComfyUI is
 *    ready." arrived in the colour of a warning after an eight minute rebuild.
 * 2. Nothing ever put it away. The section unfolds itself while a line is
 *    standing, so one finished run kept the section open on every visit for the
 *    rest of the session.
 *
 * Run: npx vitest run src/components/settings/__tests__/comfy-notice-reads-as-what-it-is.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const backendCall = vi.fn()
vi.mock('../../../api/backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  isTauri: () => true,
  isMacOS: () => false,
  openExternal: vi.fn(),
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
  setComfyPort: vi.fn(),
  setComfyHost: vi.fn(),
}))

const { ComfyUISettings } = await import('../SettingsPage')
const { useComfyInstallStore, comfySectionShouldOpen } = await import('../../../stores/comfyInstallStore')

beforeEach(() => {
  useComfyInstallStore.getState().reset()
  backendCall.mockReset()
  backendCall.mockImplementation(async (cmd: string) => {
    if (cmd === 'comfyui_status') {
      return { running: false, found: true, complete: true, path: 'C:\\ComfyUI', isLocal: true }
    }
    if (cmd === 'install_comfyui_status') return { status: 'idle', logs: [] }
    return {}
  })
})
afterEach(() => { cleanup(); useComfyInstallStore.getState().reset() })

async function panelShowing(notice: string, noticeKind: 'ok' | 'warn') {
  useComfyInstallStore.setState({ phase: 'idle', notice, noticeKind })
  render(createElement(ComfyUISettings))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  return screen.getByTestId('comfy-install-notice')
}

describe('the closing line reads as what it is', () => {
  it('a run that worked is not painted as a warning', async () => {
    const line = await panelShowing('Repair finished. ComfyUI is ready.', 'ok')
    expect(line.textContent).toBe('Repair finished. ComfyUI is ready.')
    expect(line.getAttribute('data-kind')).toBe('ok')
    expect(line.className).not.toContain('amber')
  })

  it('a run with something to report still is', async () => {
    // Negative control for the test above: the colour is not a constant, it
    // follows the kind the backend sent.
    const line = await panelShowing(
      'Repair finished. ComfyUI is ready. The requirements.txt in C:\\ComfyUI could not be used.',
      'warn',
    )
    expect(line.getAttribute('data-kind')).toBe('warn')
    expect(line.className).toContain('amber')
  })
})

describe('the closing line can be dismissed', () => {
  it('the x clears it, and the section stops unfolding itself', async () => {
    await panelShowing('Repair finished. ComfyUI is ready.', 'ok')
    expect(comfySectionShouldOpen(useComfyInstallStore.getState())).toBe(true)

    await act(async () => { fireEvent.click(screen.getByLabelText('Dismiss this message')) })

    expect(screen.queryByTestId('comfy-install-notice')).toBeNull()
    expect(useComfyInstallStore.getState().notice).toBe('')
    expect(comfySectionShouldOpen(useComfyInstallStore.getState())).toBe(false)
  })

  it('shows no dismiss control when there is nothing to dismiss', async () => {
    // Negative control: an idle panel with no line carries no stray button.
    render(createElement(ComfyUISettings))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.queryByTestId('comfy-install-notice')).toBeNull()
    expect(screen.queryByLabelText('Dismiss this message')).toBeNull()
  })
})
