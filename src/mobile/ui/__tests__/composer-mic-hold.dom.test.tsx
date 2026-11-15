// @vitest-environment jsdom
/**
 * Voice over remote (GitHub #212): the microphone of the composer knows a
 * press and its end. Hold to talk, let go to send; a tap is hands free. A
 * press with the keyboard is a tap.
 *
 * Run: npx vitest run src/mobile/ui/__tests__/composer-mic-hold.dom.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Composer } from '../Composer'

afterEach(cleanup)

function setup() {
  const onDown = vi.fn()
  const onUp = vi.fn()
  render(<Composer value="" onChange={() => {}} onSend={() => {}} micHold={{ onDown, onUp, label: 'Talk to your computer' }} idPrefix="m-remote-chat" />)
  return { onDown, onUp, mic: screen.getByTestId('m-remote-chat-mic') }
}

describe('a microphone that knows press and release', () => {
  it('shows in the slot of an empty field with its own name', () => {
    const { mic } = setup()
    expect(mic.getAttribute('aria-label')).toBe('Talk to your computer')
  })

  it('down starts, up ends, a click after a pointer does nothing more', () => {
    const { onDown, onUp, mic } = setup()
    fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
    expect(onDown).toHaveBeenCalledTimes(1)
    expect(onUp).not.toHaveBeenCalled()
    fireEvent.pointerUp(mic, { button: 0, pointerId: 1 })
    expect(onUp).toHaveBeenCalledTimes(1)
    fireEvent.click(mic, { detail: 1 })
    expect(onDown).toHaveBeenCalledTimes(1)
    expect(onUp).toHaveBeenCalledTimes(1)
  })

  it('the composer painting again while the finger is down does not lose the release', () => {
    const onDown = vi.fn()
    const onUp = vi.fn()
    const view = (dictation?: 'recording') => <Composer value="" onChange={() => {}} onSend={() => {}} micHold={{ onDown, onUp }} dictation={dictation} replaceField={dictation ? <div /> : undefined} />
    const { rerender } = render(view())
    fireEvent.pointerDown(screen.getByTestId('m-chat-mic'), { button: 0, pointerId: 7 })
    rerender(view('recording'))
    rerender(view('recording'))
    fireEvent.pointerUp(screen.getByTestId('m-chat-mic'), { pointerId: 7 })
    expect(onUp).toHaveBeenCalledTimes(1)
  })

  it('a cancelled pointer ends the take too', () => {
    const { onUp, mic } = setup()
    fireEvent.pointerDown(mic, { button: 0, pointerId: 2 })
    fireEvent.pointerCancel(mic, { pointerId: 2 })
    expect(onUp).toHaveBeenCalledTimes(1)
  })

  it('Enter or Space (a click without a pointer) is a tap', () => {
    const { onDown, onUp, mic } = setup()
    fireEvent.click(mic, { detail: 0 })
    expect(onDown).toHaveBeenCalledTimes(1)
    expect(onUp).toHaveBeenCalledTimes(1)
  })

  it('an up without a down does nothing, and a right click starts nothing', () => {
    const { onDown, onUp, mic } = setup()
    fireEvent.pointerUp(mic, { pointerId: 3 })
    fireEvent.pointerDown(mic, { button: 2, pointerId: 3 })
    expect(onDown).not.toHaveBeenCalled()
    expect(onUp).not.toHaveBeenCalled()
  })
})
