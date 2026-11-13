/**
 * @vitest-environment jsdom
 *
 * CA U4: "Rewind" under a user message says what goes back, puts the files
 * back, and with "Files and chat" also takes the chat back to before the
 * message and returns its text to the composer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const disk = vi.hoisted(() => new Map<string, string>())
vi.mock('../../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  backendCall: vi.fn(async (cmd: string, a: { path: string; content?: string }) => {
    if (cmd === 'fs_write') { disk.set(a.path, a.content ?? ''); return { status: 'saved', path: a.path } }
    if (cmd === 'fs_delete') { disk.delete(a.path); return { deleted: true } }
    throw new Error(cmd)
  }),
}))

import { RewindHere } from '../RewindHere'
import { ChatInput } from '../ChatInput'
import { useChatStore } from '../../../stores/chatStore'
import { useCheckpointStore } from '../../../lib/agent-core/checkpoints'
import { useGenerationStore } from '../../../stores/generationStore'

const MSG = { id: 'u1', role: 'user', content: 'fix median', timestamp: 100 }

beforeEach(() => {
  disk.clear()
  disk.set('/ws/math.ts', 'edited by the agent')
  disk.set('/ws/new.ts', 'made by the agent')
  useChatStore.setState({ conversations: [{ id: 'c', title: 't', messages: [MSG, { id: 'a1', role: 'assistant', content: 'done', timestamp: 120 }] }] } as never)
  useCheckpointStore.setState({
    byConv: { c: [{ messageId: 'u1', at: 110, files: {
      '/ws/math.ts': { target: { path: '/ws/math.ts', chatId: 'c' }, before: { kind: 'text', content: 'original' } },
      '/ws/new.ts': { target: { path: '/ws/new.ts', chatId: 'c' }, before: { kind: 'missing' } },
    } }] },
    trimmedBefore: {},
  })
  useGenerationStore.setState({ generating: {} } as never)
})
afterEach(() => cleanup())

describe('Rewind under a user message (CA U4)', () => {
  it('lists what goes back and says commands stay', () => {
    render(<RewindHere conversationId="c" message={MSG as never} />)
    fireEvent.click(screen.getByRole('button', { name: /Rewind/ }))
    const dlg = screen.getByRole('dialog')
    expect(dlg.textContent).toMatch(/math\.ts goes back/)
    expect(dlg.textContent).toMatch(/new\.ts is removed again/)
    expect(dlg.textContent).toMatch(/Changes made by commands stay/)
  })

  it('Files and chat: files back, chat back, text in the composer', async () => {
    render(<><RewindHere conversationId="c" message={MSG as never} /><ChatInput onSend={() => {}} onStop={() => {}} isGenerating={false} modelReady={() => true} /></>)
    fireEvent.click(screen.getByRole('button', { name: /Rewind/ }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Files and chat' })) })
    expect(disk.get('/ws/math.ts')).toBe('original')
    expect(disk.has('/ws/new.ts')).toBe(false)
    expect(useChatStore.getState().conversations[0].messages).toHaveLength(0)
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('fix median')
  })

  it('Only the files leaves the chat as it is', async () => {
    render(<RewindHere conversationId="c" message={MSG as never} />)
    fireEvent.click(screen.getByRole('button', { name: /Rewind/ }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Only the files' })) })
    expect(disk.get('/ws/math.ts')).toBe('original')
    expect(useChatStore.getState().conversations[0].messages).toHaveLength(2)
  })

  it('is not offered while a run is going, and not where nothing was written', () => {
    useGenerationStore.setState({ generating: { c: true } } as never)
    const v = render(<RewindHere conversationId="c" message={MSG as never} />)
    expect((screen.getByRole('button', { name: /Rewind/ }) as HTMLButtonElement).disabled).toBe(true)
    v.unmount()
    useCheckpointStore.setState({ byConv: {}, trimmedBefore: {} })
    const w = render(<RewindHere conversationId="c" message={MSG as never} />)
    expect(w.container.innerHTML).toBe('')
  })
})
