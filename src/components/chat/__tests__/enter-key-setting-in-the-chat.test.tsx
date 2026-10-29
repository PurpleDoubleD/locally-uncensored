// @vitest-environment jsdom
/**
 * GH #202: the Enter key setting reaches the composer and the edit field of
 * an earlier message.
 *
 * Run: npx vitest run src/components/chat/__tests__/enter-key-setting-in-the-chat.test.tsx
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatInput } from '../ChatInput'
import { MessageBubble } from '../MessageBubble'
import { useSettingsStore } from '../../../stores/settingsStore'

afterEach(() => {
  cleanup()
  useSettingsStore.getState().updateSettings({ enterKey: 'send' })
})

function composer(onSend: (text: string) => void) {
  const view = render(<ChatInput onSend={(text) => onSend(text)} onStop={() => {}} isGenerating={false} modelReady={() => true} />)
  const field = view.container.querySelector('textarea[data-lu-composer]') as HTMLTextAreaElement
  fireEvent.change(field, { target: { value: 'line one' } })
  return field
}

describe('the composer', () => {
  it('"Sends": Enter sends, as before', () => {
    const onSend = vi.fn()
    const field = composer(onSend)
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('line one')
  })

  it('"New line": Enter does not send, Ctrl+Enter does, and the placeholder says so', () => {
    useSettingsStore.getState().updateSettings({ enterKey: 'newline' })
    const onSend = vi.fn()
    const field = composer(onSend)
    expect(field.placeholder).toMatch(/\+Enter to send/)
    const plain = fireEvent.keyDown(field, { key: 'Enter' })
    expect(plain).toBe(true) // not prevented: the browser adds the line
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })
    expect(onSend).toHaveBeenCalledWith('line one')
  })
})

describe('the edit field of an earlier message', () => {
  const msg = { id: 'u1', role: 'user' as const, content: 'hello', timestamp: 1 }

  function openEdit(onEdit: (id: string, text: string) => boolean) {
    render(<MessageBubble message={msg} onEdit={onEdit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    return screen.getByLabelText('Edit message text') as HTMLTextAreaElement
  }

  it('"Sends": Enter saves and closes, Ctrl+Enter resends', () => {
    const onEdit = vi.fn(() => true)
    let field = openEdit(onEdit)
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.queryByLabelText('Edit message text')).toBeNull()
    expect(onEdit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    field = screen.getByLabelText('Edit message text') as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'hello again' } })
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })
    expect(onEdit).toHaveBeenCalledWith('u1', 'hello again')
  })

  it('"New line": Enter stays in the field, Ctrl+Enter saves, Ctrl+Shift+Enter resends', () => {
    useSettingsStore.getState().updateSettings({ enterKey: 'newline' })
    const onEdit = vi.fn(() => true)
    let field = openEdit(onEdit)
    expect(screen.getByTestId('edit-key-hint').textContent).toMatch(/\+Enter saves, Enter adds a line/)
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.getByLabelText('Edit message text')).toBeTruthy()
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })
    expect(screen.queryByLabelText('Edit message text')).toBeNull()
    expect(onEdit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    field = screen.getByLabelText('Edit message text') as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'again' } })
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true, shiftKey: true })
    expect(onEdit).toHaveBeenCalledWith('u1', 'again')
  })
})

describe('a phone-wide window (375 px)', () => {
  it('Sampling, the model and Send have their own line below 26rem, not pushed out of the row', () => {
    render(<ChatInput onSend={() => {}} onStop={() => {}} isGenerating={false} modelReady={() => true} />)
    const cluster = screen.getByTestId('composer-right-cluster')
    expect(cluster.className).toMatch(/@max-\[26rem\]:basis-full/)
    expect(cluster.contains(screen.getByTestId('composer-send-slot'))).toBe(true)
    const row = cluster.parentElement as HTMLElement
    expect(row.className).toMatch(/@max-\[26rem\]:flex-wrap/)
    // The query container is the parent: a container cannot query itself.
    expect((row.parentElement as HTMLElement).className).toMatch(/@container/)
    expect(row.className).not.toMatch(/@container/)
  })
})
