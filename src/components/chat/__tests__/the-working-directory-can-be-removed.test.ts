/**
 * @vitest-environment jsdom
 *
 * A8 (2.6.8), the surface half: there has to be a visible way out of a folder.
 *
 * Two Windows 11 users in Cloud mode looked for one on 01. and 02.09. and found
 * nothing, a moderator confirmed "There isn't one", and one of them was ready
 * to reinstall the app to get rid of a tree he had opened by mistake. The store
 * half is pinned in src/stores/__tests__/codexStore-working-directory.test.ts;
 * this file mounts the explorer column for real and checks the four things the
 * reports were actually about:
 *
 *   - the control EXISTS and is visible whenever a folder is set,
 *   - it does not depend on Cloud versus Local, because that is where both
 *     reporters were standing,
 *   - clicking it empties the store, so the picker and the run agree,
 *   - what is left behind says how to pick a new folder instead of going quiet.
 *
 * Plus the one thing neither folder button may do: fire in the middle of a run.
 * The folder is global, so it would send the next turn somewhere the user is
 * not looking. The lock covers a send from its first synchronous moment, a
 * running thread, and the pause between two /loop passes, and it covers the
 * PICKER as well as Remove: a picker that stays free while Remove is held is
 * the same hole (review S1, S2, S8). What it must NOT do is care about a Chat
 * tab streaming in another conversation (review S3).
 *
 * Run: npx vitest run src/components/chat/__tests__/the-working-directory-can-be-removed.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

// The tree calls the Tauri bridge on mount. There is no bridge here and the
// listing is not what this file is about: one empty directory, always.
vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async () => ({ entries: [], truncated: false })),
  isTauri: () => false,
  isMacOS: () => false,
}))
// The plan pieces at the bottom of the column pull in half the agent stack and
// have their own tests.
vi.mock('../PlanBar', () => ({ PlanBar: () => null }))
vi.mock('../PlanApprovalBar', () => ({ PlanApprovalBar: () => null }))
vi.mock('../FilePreview', () => ({ FilePreview: () => null }))

const { ExplorerPanel } = await import('../ExplorerPanel')
const { useCodexStore } = await import('../../../stores/codexStore')
const { useGenerationStore } = await import('../../../stores/generationStore')
const { useAgentLoopStore } = await import('../../../stores/agentLoopStore')
const { useAgentModeStore } = await import('../../../stores/agentModeStore')
const { useSettingsStore } = await import('../../../stores/settingsStore')
const { useUIStore } = await import('../../../stores/uiStore')
const { useModelStore } = await import('../../../stores/modelStore')
const { DEFAULT_SETTINGS } = await import('../../../lib/constants')

const WINDOWS_PATH = 'C:\\Users\\helpslowlydying\\Documents\\My Projects'

const show = () => render(createElement(ExplorerPanel, { onApprovePlan: () => {} }))
const removeButton = () => screen.queryByTestId('explorer-remove-folder')
const pickButton = () => screen.queryByTestId('explorer-pick-folder') as HTMLButtonElement

const A_STANDING_LOOP = {
  conversationId: 'conv-1', pass: 2, cap: 0, task: 'keep going', intervalMs: 30000, nextAt: 0,
}

beforeEach(() => {
  useCodexStore.setState({ workingDirectory: '', threads: {}, sendsInFlight: 0 })
  useGenerationStore.setState({ generating: {} })
  useAgentLoopStore.setState({ loop: null })
  useAgentModeStore.setState({ workspaces: {} })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useUIStore.setState({ explorerCollapsed: false })
  useModelStore.setState({ activeModel: null })
})
afterEach(() => cleanup())

describe('the way out of a folder is on screen', () => {
  it('shows a Remove control once a folder is set', () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    show()
    expect(removeButton()).not.toBeNull()
  })

  it('shows nothing to remove while there is no folder', () => {
    show()
    // Negative control: the control is bound to the folder, not always painted.
    expect(removeButton()).toBeNull()
  })

  it('is there in Cloud mode', () => {
    useModelStore.setState({ activeModel: 'lu-cloud::zai-org/GLM-5.3-Flash' })
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    show()
    expect(removeButton()).not.toBeNull()
  })

  it('and in Local mode, the column never asked which one it was', () => {
    useModelStore.setState({ activeModel: 'ollama::qwen3:14b' })
    act(() => useCodexStore.getState().setWorkingDirectory('/home/dave/repo'))
    show()
    expect(removeButton()).not.toBeNull()
  })
})

describe('clicking it actually lets go', () => {
  it('empties the store, Windows path and all', () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    show()
    fireEvent.click(removeButton()!)
    expect(useCodexStore.getState().workingDirectory).toBe('')
  })

  it('unpins the open thread at its next send, so the run stops walking the old tree', () => {
    act(() => {
      useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
      useCodexStore.getState().initThread('conv-1', WINDOWS_PATH)
    })
    show()
    fireEvent.click(removeButton()!)
    // The click owns the store; the thread follows at that chat's next send,
    // which is the only moment it may move without stepping on another chat.
    expect(useCodexStore.getState().syncThreadWorkingDirectory('conv-1')).toBe('')
    expect(useCodexStore.getState().getThread('conv-1')!.workingDirectory).toBe('')
  })

  it('leaves an empty state that says how to pick a new folder', () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    show()
    // Negative control: the hint is not sitting there the whole time.
    expect(screen.queryByTestId('explorer-no-folder')).toBeNull()

    fireEvent.click(removeButton()!)
    const empty = screen.getByTestId('explorer-no-folder')
    expect(empty.textContent).toContain('Select folder...')
    expect(empty.textContent).toContain('~/agent-workspace')
  })

  it('and names the workspace that really wins, not a sandbox it will never use', () => {
    // review S4: settings.defaultWorkspace beats an empty picker in the run
    // resolver, so promising ~/agent-workspace here was simply untrue.
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, defaultWorkspace: { kind: 'folder', path: '/home/dave/default' } },
    })
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    show()
    fireEvent.click(removeButton()!)
    const empty = screen.getByTestId('explorer-no-folder')
    expect(empty.textContent).toContain('/home/dave/default')
    expect(empty.textContent).not.toContain('~/agent-workspace')
  })

  it('the path itself is gone from the column, not just from the store', () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    const { container } = show()
    expect(container.textContent).toContain(WINDOWS_PATH)

    fireEvent.click(removeButton()!)
    expect(container.textContent).not.toContain(WINDOWS_PATH)
  })
})

describe('a run in flight holds it', () => {
  it('locks the control and says why, instead of hiding it', () => {
    act(() => {
      useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
      useCodexStore.getState().beginSend()
    })
    show()
    const button = removeButton()!
    expect(button).not.toBeNull()
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('title')).toContain('Wait for the current run to finish')
  })

  it('holds it from the first synchronous moment of the send, before any await', () => {
    // review S1: the thread only turns 'running' five awaits into the send.
    // The counter is taken before the first one, and this is that window.
    act(() => {
      useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
      useCodexStore.getState().beginSend()
    })
    show()
    expect(useCodexStore.getState().threads).toEqual({})
    expect((removeButton() as HTMLButtonElement).disabled).toBe(true)
  })

  it('a locked click changes nothing', () => {
    act(() => {
      useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
      useCodexStore.getState().beginSend()
    })
    show()
    fireEvent.click(removeButton()!)
    expect(useCodexStore.getState().workingDirectory).toBe(WINDOWS_PATH)
  })

  it('a thread the store still calls running counts as a run too', () => {
    act(() => {
      useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
      useCodexStore.getState().initThread('conv-1', WINDOWS_PATH)
      useCodexStore.getState().setThreadStatus('conv-1', 'running')
    })
    show()
    expect((removeButton() as HTMLButtonElement).disabled).toBe(true)
  })

  it('and an idle thread does not, the lock is about runs and nothing else', () => {
    act(() => {
      useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
      useCodexStore.getState().initThread('conv-1', WINDOWS_PATH)
    })
    show()
    expect((removeButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('the pause between two loop passes holds it too, and says so', () => {
    // review S2: the thread is idle here and the next pass is on a timer, so
    // the old lock was wide open and the pass would have walked into a folder
    // nobody chose.
    act(() => {
      useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
      useCodexStore.getState().initThread('conv-1', WINDOWS_PATH)
    })
    useAgentLoopStore.setState({ loop: A_STANDING_LOOP })
    show()
    const button = removeButton() as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toContain('loop')
  })

  it('a Chat tab streaming in another conversation does NOT hold it', () => {
    // review S3: the first cut read every conversation's generating flag, so
    // any chat anywhere locked this column for no reason.
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    useGenerationStore.setState({ generating: { 'some-other-chat': true } })
    show()
    expect((removeButton() as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(removeButton()!)
    expect(useCodexStore.getState().workingDirectory).toBe('')
  })
})

describe('the picker is held by exactly the same lock', () => {
  it('is free while nothing runs', () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    show()
    expect(pickButton().disabled).toBe(false)
  })

  it('is locked during a send, with the same sentence as Remove', () => {
    // review S8: leaving the picker open while Remove was held meant the
    // folder could still be moved under a run, which is the same hole.
    act(() => {
      useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
      useCodexStore.getState().beginSend()
    })
    show()
    expect(pickButton().disabled).toBe(true)
    expect(pickButton().getAttribute('title')).toBe(removeButton()!.getAttribute('title'))
  })
})

describe('a collapsed column is not a dead end', () => {
  it('hides its own Remove, because the whole column is gone', () => {
    // review S7. The way out then lives in the header, which is always shown
    // and is tested in the-header-can-let-the-folder-go.test.ts.
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    useUIStore.setState({ explorerCollapsed: true })
    show()
    expect(removeButton()).toBeNull()
    // Negative control: expanded, the same state shows it.
    cleanup()
    useUIStore.setState({ explorerCollapsed: false })
    show()
    expect(removeButton()).not.toBeNull()
  })
})
