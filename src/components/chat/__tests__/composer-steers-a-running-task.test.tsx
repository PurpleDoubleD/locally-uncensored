/**
 * @vitest-environment jsdom
 *
 * CA U2: Enter during an agent run queues the message for the next step.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { ChatInput } from '../ChatInput'
import { useSteerQueue } from '../../../hooks/useSteerQueue'
import { useSteerStore } from '../../../stores/steerStore'

afterEach(() => { cleanup(); useSteerStore.setState({ queue: {} }) })

describe('typing while the agent works (CA U2)', () => {
  it('Enter queues the message instead of doing nothing', () => {
    const onSend = vi.fn()
    const onSteer = vi.fn()
    const view = render(<ChatInput onSend={onSend} onStop={() => {}} isGenerating modelReady={() => true} onSteer={onSteer} />)
    const box = view.container.querySelector('textarea')!
    expect(box.getAttribute('placeholder')).toMatch(/reads it after this step/)
    fireEvent.change(box, { target: { value: 'use vitest' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSteer).toHaveBeenCalledWith('use vitest')
    expect(onSend).not.toHaveBeenCalled()
    expect(box.value).toBe('')
  })

  it('shows what waits, and a message can be taken back', () => {
    const onUnsteer = vi.fn()
    const view = render(
      <ChatInput onSend={() => {}} onStop={() => {}} isGenerating modelReady={() => true} onSteer={() => {}} steerQueue={[{ id: 's1', text: 'keep the old name' }]} onUnsteer={onUnsteer} />,
    )
    expect(view.getByTestId('steer-queue').textContent).toContain('keep the old name')
    fireEvent.click(view.getByRole('button', { name: 'Take this message back' }))
    expect(onUnsteer).toHaveBeenCalledWith('s1')
  })

  it('without steering (plain chat) Enter during a run still sends nothing', () => {
    const onSend = vi.fn()
    const view = render(<ChatInput onSend={onSend} onStop={() => {}} isGenerating modelReady={() => true} />)
    const box = view.container.querySelector('textarea')!
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(box.value).toBe('hello')
  })

  it('what the run did not read goes out as the next message when it ends', () => {
    const send = vi.fn()
    const { rerender } = renderHook(({ running }) => useSteerQueue('c1', running, true, send), { initialProps: { running: true } })
    act(() => { useSteerStore.getState().add('c1', 'one more thing'); useSteerStore.getState().add('c1', 'and this') })
    rerender({ running: false })
    expect(send).toHaveBeenCalledWith('one more thing\n\nand this')
    expect(useSteerStore.getState().queue.c1).toEqual([])
  })
})
