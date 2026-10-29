/**
 * @vitest-environment jsdom
 *
 * Hugging Face "Use this model" (B17) on screen: the dialog shows repository,
 * file, quant and size, starts nothing on its own, waits a second before
 * Download can be pressed, and refuses a file the repository does not have.
 * The inbox routes a link to Models and shows a refused one.
 *
 * Run: npx vitest run src/components/models/__tests__/hf-link-dialog.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const MB = 1_048_576
const backend = vi.hoisted(() => ({
  fetchExternal: vi.fn(async (_url: string) => ''),
  backendCall: vi.fn(async (_cmd: string): Promise<unknown> => null),
}))
vi.mock('../../../api/backend', () => ({
  ...backend,
  isTauri: () => false,
  isMacOS: () => false,
  isWindows: () => false,
  openExternal: vi.fn(),
}))

import { HfLinkDialog } from '../HfLinkDialog'
import { HfLinkInbox, takeHfLink } from '../HfLinkInbox'
import { useHfLinkStore } from '../../../stores/hfLinkStore'
import { useUIStore } from '../../../stores/uiStore'
import { useSettingsStore } from '../../../stores/settingsStore'

const TREE = JSON.stringify([
  { type: 'file', path: 'tiny-Q4_K_M.gguf', size: 400 * MB, lfs: { oid: 'a'.repeat(64) } },
  { type: 'file', path: 'tiny-Q8_0.gguf', size: 700 * MB },
])

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  backend.fetchExternal.mockResolvedValue(TREE)
  useHfLinkStore.getState().clear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('HfLinkDialog', () => {
  it('shows the file, its quant and size, and downloads only after the click', async () => {
    const onConfirm = vi.fn()
    render(<HfLinkDialog link={{ repo: 'a/b', file: 'tiny-Q8_0.gguf' }} onCancel={vi.fn()} onConfirm={onConfirm} />)
    await settle()
    expect(backend.fetchExternal).toHaveBeenCalledWith('https://huggingface.co/api/models/a/b/tree/main?recursive=true')
    expect(screen.getByTestId('hf-link-file').textContent).toBe('tiny-Q8_0.gguf')
    expect(screen.getByTestId('hf-link-quant').textContent).toBe('Q8_0')
    expect(screen.getByTestId('hf-link-size').textContent).toBe('700 MB')
    const button = screen.getByRole('button', { name: 'Download (700 MB)' }) as HTMLButtonElement
    // Armed only after the question stood still for a second.
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onConfirm).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1100) })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0]).toMatchObject({
      downloadUrl: 'https://huggingface.co/a/b/resolve/main/tiny-Q8_0.gguf',
      filename: 'tiny-Q8_0.gguf',
    })
  })

  it('offers the repository files when the link names none, Q4_K_M first', async () => {
    render(<HfLinkDialog link={{ repo: 'a/b', file: null }} onCancel={vi.fn()} onConfirm={vi.fn()} />)
    await settle()
    const select = screen.getByTestId('hf-link-file-select') as HTMLSelectElement
    expect(select.value).toBe('tiny-Q4_K_M.gguf')
    fireEvent.change(select, { target: { value: 'tiny-Q8_0.gguf' } })
    expect(screen.getByTestId('hf-link-quant').textContent).toBe('Q8_0')
  })

  it('refuses a file the repository does not have, and Cancel starts nothing', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<HfLinkDialog link={{ repo: 'a/b', file: 'tiny-Q5_K_M.gguf' }} onCancel={onCancel} onConfirm={onConfirm} />)
    await settle()
    expect(screen.getByTestId('hf-link-failed').textContent).toMatch(/no model file under the name/)
    await act(async () => { vi.advanceTimersByTime(1100) })
    expect((screen.getByRole('button', { name: 'Download' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('says so when Hugging Face answers with no repository', async () => {
    backend.fetchExternal.mockResolvedValue(JSON.stringify({ error: 'Repository not found' }))
    render(<HfLinkDialog link={{ repo: 'a/b', file: null }} onCancel={vi.fn()} onConfirm={vi.fn()} />)
    await settle()
    expect(screen.getByTestId('hf-link-failed').textContent).toMatch(/no public model repository/)
  })
})

describe('HfLinkInbox', () => {
  it('routes a checked link to Models, Chat lane', async () => {
    useSettingsStore.getState().updateSettings({ appMode: 'local' })
    useUIStore.getState().setView('chat')
    backend.backendCall.mockResolvedValueOnce({ kind: 'model', repo: 'a/b', file: 'tiny-Q8_0.gguf' })
    await takeHfLink()
    expect(backend.backendCall).toHaveBeenCalledWith('hf_link_take')
    expect(useHfLinkStore.getState().pending).toEqual({ repo: 'a/b', file: 'tiny-Q8_0.gguf' })
    expect(useUIStore.getState().currentView).toBe('models')
  })

  it('asks to switch to Local first in cloud mode', async () => {
    useSettingsStore.getState().updateSettings({ appMode: 'cloud' })
    useUIStore.getState().setView('chat')
    backend.backendCall.mockResolvedValueOnce({ kind: 'model', repo: 'a/b', file: null })
    await takeHfLink()
    expect(useUIStore.getState().currentView).toBe('chat')
    render(<HfLinkInbox />)
    expect(screen.getByTestId('hf-link-needs-local')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Local' }))
    expect(useSettingsStore.getState().settings.appMode).toBe('local')
    expect(useUIStore.getState().currentView).toBe('models')
  })

  it('shows a refused link and a forged inbox answer as refused, never as a download', async () => {
    backend.backendCall.mockResolvedValueOnce({ kind: 'rejected', reason: 'The link does not name a GGUF file.' })
    await takeHfLink()
    render(<HfLinkInbox />)
    expect(screen.getByTestId('hf-link-rejected').textContent).toMatch(/does not name a GGUF file/)
    cleanup()
    backend.backendCall.mockResolvedValueOnce({ kind: 'model', repo: '../etc', file: 'x.gguf' })
    await takeHfLink()
    expect(useHfLinkStore.getState().pending).toBeNull()
    expect(useHfLinkStore.getState().rejected).toBe('The link could not be read.')
  })

  it('does nothing when the inbox is empty', async () => {
    backend.backendCall.mockResolvedValueOnce(null)
    await takeHfLink()
    expect(useHfLinkStore.getState()).toMatchObject({ pending: null, rejected: null })
  })
})
