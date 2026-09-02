/**
 * @vitest-environment jsdom
 *
 * Bug A10: the prompt history in Create could not be deleted.
 *
 * pardy22 asked twice, in #general and in #help-18, and a moderator pointed at
 * a "Clear" button at the top of the clock list. That button existed on the web
 * app only; the desktop dropdown was a read-only list and the store had no
 * delete action at all, so there was nothing to find.
 *
 * This file mounts the real dropdown and proves four things a source-reading
 * test cannot: the Clear control is on screen without hovering anything, the
 * first click does NOT delete (it is not undoable, so it arms first), the
 * second one does, and every row carries its own X that removes exactly one
 * entry.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/prompt-history-clear.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { PromptHistory } from '../PromptHistory'
import { useCreateStore } from '../../../../stores/createStore'

// The store classifies model names on import; the ComfyUI client underneath
// reaches for the Tauri bridge, which does not exist in jsdom.
vi.mock('../../../../api/comfyui', () => ({
  classifyModel: vi.fn(() => 'sdxl'),
}))

const HISTORY = ['a red fox in the snow', 'a blue whale at night']

function show(history: string[] = HISTORY, onPick: (p: string) => void = () => {}) {
  useCreateStore.setState({ promptHistory: history })
  return render(createElement(PromptHistory, { onPick }))
}

/** Opens the dropdown by clicking the clock button. */
function openList() {
  fireEvent.click(screen.getByTitle('Prompt history'))
}

beforeEach(() => {
  useCreateStore.setState({ promptHistory: [] })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Create prompt history: deleting it (A10)', () => {
  it('shows the Clear all control at the top of the open list, no hover needed', () => {
    show()
    // Negative control: nothing of the list is on screen before the click.
    expect(screen.queryByText('Clear all')).toBeNull()
    openList()
    expect(screen.getByText('Clear all')).toBeTruthy()
    expect(screen.getByText('Prompt history')).toBeTruthy()
  })

  it('renders a remove button on every row, without hovering', () => {
    show()
    openList()
    for (const entry of HISTORY) {
      expect(screen.getByLabelText(`Remove prompt: ${entry}`)).toBeTruthy()
    }
  })

  it('asks before it clears: one click arms, the second wipes the history', () => {
    show()
    openList()

    fireEvent.click(screen.getByText('Clear all'))
    // Negative control: a single click must NOT delete anything.
    expect(useCreateStore.getState().promptHistory).toEqual(HISTORY)
    expect(screen.getByText('Click again to clear')).toBeTruthy()

    fireEvent.click(screen.getByText('Click again to clear'))
    expect(useCreateStore.getState().promptHistory).toEqual([])
  })

  it('the arming times out, so a stray click never becomes a delete later', () => {
    vi.useFakeTimers()
    show()
    openList()
    fireEvent.click(screen.getByText('Clear all'))
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.getByText('Clear all')).toBeTruthy()
    expect(useCreateStore.getState().promptHistory).toEqual(HISTORY)
  })

  it('the X removes exactly its own entry', () => {
    show()
    openList()
    fireEvent.click(screen.getByLabelText(`Remove prompt: ${HISTORY[0]}`))
    expect(useCreateStore.getState().promptHistory).toEqual([HISTORY[1]])
    // The other row is still pickable, the list did not collapse.
    expect(screen.getByText(HISTORY[1])).toBeTruthy()
  })

  it('picking a prompt still works and does not delete it', () => {
    const picked: string[] = []
    show(HISTORY, (p) => picked.push(p))
    openList()
    fireEvent.click(screen.getByText(HISTORY[1]))
    expect(picked).toEqual([HISTORY[1]])
    expect(useCreateStore.getState().promptHistory).toEqual(HISTORY)
  })

  it('renders nothing at all while the history is empty', () => {
    show([])
    expect(screen.queryByTitle('Prompt history')).toBeNull()
  })
})
