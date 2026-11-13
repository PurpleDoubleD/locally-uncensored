/**
 * @vitest-environment jsdom
 *
 * The review panel (Code tab, Ask mode): every hunk has its own Accept and
 * Reject, a decided hunk folds and can be undone, the last decision resolves
 * the file, and the panel closes to one line.
 *
 * Run: npx vitest run src/components/chat/__tests__/review-per-hunk.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'

const lib = vi.hoisted(() => ({
  applyStagedChange: vi.fn(async () => true),
  rejectStagedChange: vi.fn(),
  rejectAllStagedChanges: vi.fn(),
}))
vi.mock('../../../lib/staged-apply', () => lib)

const { StagedChangesPanel } = await import('../StagedChangesPanel')
const { useStagedChangesStore } = await import('../../../stores/stagedChangesStore')

const CHAT = 'chat-review'
const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
const edited = [...base]
edited[1] = 'TOP EDIT'
edited[25] = 'BOTTOM EDIT'

function stageTwoHunks(): string {
  return useStagedChangesStore.getState().stage(CHAT, {
    path: './src/a.ts',
    oldContent: base.join('\n') + '\n',
    newContent: edited.join('\n') + '\n',
    diff: '',
  })
}

function setNarrow(narrow: boolean) {
  window.matchMedia = ((q: string) => ({ matches: narrow && q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  useStagedChangesStore.setState({ byChat: {}, notes: {} })
  Object.values(lib).forEach((f) => f.mockClear())
  setNarrow(false)
})
afterEach(cleanup)

describe('per hunk review', () => {
  it('shows each hunk with its own Accept and Reject', () => {
    stageTwoHunks()
    render(createElement(StagedChangesPanel, { chatId: CHAT }))
    const hunks = screen.getAllByTestId('staged-hunk')
    expect(hunks).toHaveLength(2)
    for (const h of hunks) {
      expect(within(h).getByTestId('hunk-accept')).toBeTruthy()
      expect(within(h).getByTestId('hunk-reject')).toBeTruthy()
    }
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByText('1 change waiting')).toBeTruthy()
  })

  it('a rejected hunk folds, says so, and Undo opens it again', () => {
    const id = stageTwoHunks()
    render(createElement(StagedChangesPanel, { chatId: CHAT }))
    fireEvent.click(within(screen.getAllByTestId('staged-hunk')[0]).getByTestId('hunk-reject'))
    const first = screen.getAllByTestId('staged-hunk')[0]
    expect(first.getAttribute('data-decision')).toBe('rejected')
    expect(within(first).getByText('Rejected')).toBeTruthy()
    expect(first.querySelector('[data-kind]')).toBeNull()
    expect(screen.getByTestId('staged-change-rejected-count').textContent).toBe('1 of 2 rejected')
    expect(useStagedChangesStore.getState().get(CHAT, id)?.hunkDecisions).toEqual({ 0: 'rejected' })
    // Not every hunk is decided yet: nothing is written.
    expect(lib.applyStagedChange).not.toHaveBeenCalled()

    fireEvent.click(within(first).getByTestId('hunk-undo'))
    expect(screen.getAllByTestId('staged-hunk')[0].getAttribute('data-decision')).toBe('open')
  })

  it('the last decision applies the file with the rejected hunk left out', async () => {
    const id = stageTwoHunks()
    render(createElement(StagedChangesPanel, { chatId: CHAT }))
    fireEvent.click(within(screen.getAllByTestId('staged-hunk')[0]).getByTestId('hunk-reject'))
    fireEvent.click(within(screen.getAllByTestId('staged-hunk')[1]).getByTestId('hunk-accept'))
    await waitFor(() => expect(lib.applyStagedChange).toHaveBeenCalledOnce())
    const [, change] = lib.applyStagedChange.mock.calls[0] as unknown as [string, { id: string; hunkDecisions: unknown }]
    expect(change.id).toBe(id)
    expect(change.hunkDecisions).toEqual({ 0: 'rejected', 1: 'accepted' })
  })

  it('rejecting every hunk rejects the file', () => {
    stageTwoHunks()
    render(createElement(StagedChangesPanel, { chatId: CHAT }))
    fireEvent.click(within(screen.getAllByTestId('staged-hunk')[0]).getByTestId('hunk-reject'))
    fireEvent.click(within(screen.getAllByTestId('staged-hunk')[1]).getByTestId('hunk-reject'))
    expect(lib.rejectStagedChange).toHaveBeenCalledOnce()
    expect(lib.applyStagedChange).not.toHaveBeenCalled()
  })

  it('file and all buttons still work', async () => {
    stageTwoHunks()
    render(createElement(StagedChangesPanel, { chatId: CHAT }))
    fireEvent.click(screen.getByTestId('staged-change-reject'))
    expect(lib.rejectStagedChange).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByTestId('reject-all'))
    expect(lib.rejectAllStagedChanges).toHaveBeenCalledWith(CHAT)
    fireEvent.click(screen.getByTestId('apply-all'))
    await waitFor(() => expect(lib.applyStagedChange).toHaveBeenCalled())
  })
})

describe('the one line bar', () => {
  it('starts closed on a phone width, with Review and Apply all on the line', () => {
    setNarrow(true)
    stageTwoHunks()
    useStagedChangesStore.getState().stage(CHAT, { path: 'b.ts', oldContent: '', newContent: 'x\n', diff: '' })
    render(createElement(StagedChangesPanel, { chatId: CHAT }))
    expect(screen.queryByTestId('staged-changes-list')).toBeNull()
    const bar = screen.getByTestId('staged-changes-header')
    expect(within(bar).getByText('2 changes waiting')).toBeTruthy()
    expect(within(bar).getByText('Review')).toBeTruthy()
    expect(within(bar).getByText('Apply all')).toBeTruthy()

    fireEvent.click(within(bar).getByText('Review'))
    expect(screen.getByTestId('staged-changes-list')).toBeTruthy()
    expect(within(bar).getByText('Hide')).toBeTruthy()
  })

  it('starts open on a desktop width and can be closed', () => {
    stageTwoHunks()
    render(createElement(StagedChangesPanel, { chatId: CHAT }))
    expect(screen.getByTestId('staged-changes-list')).toBeTruthy()
    fireEvent.click(screen.getByTestId('staged-changes-review'))
    expect(screen.queryByTestId('staged-changes-list')).toBeNull()
  })
})
