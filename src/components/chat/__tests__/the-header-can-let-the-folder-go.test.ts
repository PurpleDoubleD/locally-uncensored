/**
 * @vitest-environment jsdom
 *
 * A8 (2.6.8), the second surface: the Coding Agent header.
 *
 * The Remove control in the explorer column is the main one, but that column
 * collapses and remembers that it was collapsed (uiStore). A user sitting in
 * front of a collapsed column sees a folder in the header and no way to let it
 * go, which is exactly the report we got: two people searched, a moderator said
 * "There isn't one". So the header, which always shows the folder, also carries
 * the way to give it back.
 *
 * CodexView is mounted for real here. Everything that talks to a model, a
 * bridge or a microphone is mocked away, because none of it is what this file
 * is about.
 *
 * Run: npx vitest run src/components/chat/__tests__/the-header-can-let-the-folder-go.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('../../../hooks/useCodex', () => ({
  useCodex: () => ({ sendInstruction: () => {}, stopCodex: () => {}, isRunning: false }),
}))
vi.mock('../../../api/backend', () => ({
  checkGitInstalled: async () => ({ installed: true, download_url: '' }),
  openExternal: () => {},
  backendCall: async () => ({ entries: [], truncated: false }),
  isTauri: () => false,
  isMacOS: () => false,
}))
vi.mock('../ChatInput', () => ({ ChatInput: () => null }))
vi.mock('../ExplorerPanel', () => ({ ExplorerPanel: () => null }))
vi.mock('../../models/ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('../TokenCounter', () => ({ TokenCounter: () => null }))
vi.mock('../ContextDropdown', () => ({ ContextDropdown: () => null }))
vi.mock('../PluginsDropdown', () => ({ PluginsDropdown: () => null }))
vi.mock('../SmallModelModeToggle', () => ({ SmallModelModeToggle: () => null }))
vi.mock('../StagedChangesPanel', () => ({ StagedChangesPanel: () => null }))
vi.mock('../CodexConfirmDialog', () => ({ CodexConfirmDialog: () => null }))

const { CodexView } = await import('../CodexView')
const { useCodexStore } = await import('../../../stores/codexStore')
const { useGenerationStore } = await import('../../../stores/generationStore')
const { useChatStore } = await import('../../../stores/chatStore')

const WINDOWS_PATH = 'C:\\Users\\dielitakira\\Documents\\huge-tree'

const show = () => render(createElement(CodexView))
const removeButton = () => screen.queryByTestId('codex-remove-folder')

beforeEach(() => {
  useCodexStore.setState({ workingDirectory: '', threads: {} })
  useGenerationStore.setState({ generating: {} })
  useChatStore.setState({ conversations: [], activeConversationId: null })
})
afterEach(() => cleanup())

describe('the header shows the folder, so it also gives it back', () => {
  it('carries a Remove control while a folder is set', () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    show()
    expect(removeButton()).not.toBeNull()
  })

  it('carries none while the agent is in its sandbox', () => {
    show()
    // Negative control: bound to the folder, not always painted.
    expect(removeButton()).toBeNull()
  })

  it('a click empties the store and the header falls back to the sandbox label', () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    const { container } = show()
    expect(container.textContent).toContain(WINDOWS_PATH)

    fireEvent.click(removeButton()!)
    expect(useCodexStore.getState().workingDirectory).toBe('')
    expect(container.textContent).not.toContain(WINDOWS_PATH)
    expect(container.textContent).toContain('sandbox')
  })

  it('the empty transcript then says how to pick a new folder', () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    show()
    expect(screen.queryByTestId('codex-no-folder-hint')).toBeNull()

    fireEvent.click(removeButton()!)
    const hint = screen.getByTestId('codex-no-folder-hint')
    expect(hint.textContent).toContain('Select folder...')
    expect(hint.textContent).toContain('agent-workspace')
  })

  it('is locked with a reason while a coding turn is in flight', () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    useGenerationStore.setState({ generating: { 'conv-1': true } })
    show()
    const button = removeButton() as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toContain('Wait for the current run to finish')

    fireEvent.click(button)
    expect(useCodexStore.getState().workingDirectory).toBe(WINDOWS_PATH)
  })

  it('and unlocked again once nothing is running', () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    show()
    expect((removeButton() as HTMLButtonElement).disabled).toBe(false)
  })
})
