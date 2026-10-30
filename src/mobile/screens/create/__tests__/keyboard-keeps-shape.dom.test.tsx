// @vitest-environment jsdom
/**
 * Customer mail of 30.10. (package M1, 3.0.9): on Android the keyboard kept
 * closing on Create. Android shrinks the window by the keyboard
 * (adjustResize, MainActivity pads the content by the IME inset). On a usual
 * phone that is less than 30 text units of height, so Create went from the
 * fixed composer (tall) to one scrolling column (low). The composer stands in
 * another place there, React built the prompt field anew, the new field had
 * no focus and Android took the keyboard away. The window grew back, tall
 * returned, and the next tap started it all again.
 *
 * Run: npx vitest run src/mobile/screens/create/__tests__/keyboard-keeps-shape.dom.test.tsx
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useScreenShape } from '../parts/ui'

/** Create in small: the prompt sits in the footer when tall and at the top of the column otherwise (CreatePage Surface). */
function Harness() {
  const shape = useScreenShape()
  const field = <textarea data-testid="prompt" defaultValue="" />
  return (
    <div data-shape={shape} data-testid="page">
      {shape === 'tall' ? (
        <>
          <div>stage</div>
          <footer>{field}</footer>
        </>
      ) : (
        <div className="m-k-low">
          <div>{field}</div>
          <div>stage</div>
        </div>
      )}
    </div>
  )
}

function windowSize(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
  window.dispatchEvent(new Event('resize'))
}

afterEach(() => {
  cleanup()
})

describe('M1: the keyboard does not move the composer of Create', () => {
  it('Android 360x730, the keyboard takes 300 px: the prompt keeps its place and its focus', async () => {
    windowSize(360, 730)
    render(<Harness />)
    expect(screen.getByTestId('page').dataset.shape).toBe('tall')
    const field = screen.getByTestId('prompt')
    field.focus()
    expect(document.activeElement).toBe(field)

    await act(async () => windowSize(360, 430))

    expect(screen.getByTestId('page').dataset.shape).toBe('tall')
    expect(screen.getByTestId('prompt')).toBe(field)
    expect(document.activeElement).toBe(field)
  })

  it('without a field in focus a low window still gets the scrolling column', async () => {
    windowSize(360, 730)
    render(<Harness />)
    await act(async () => windowSize(360, 430))
    expect(screen.getByTestId('page').dataset.shape).toBe('low')
  })

  it('the keyboard gone and the focus with it: the measured shape counts again', async () => {
    windowSize(360, 730)
    render(<Harness />)
    const field = screen.getByTestId('prompt')
    field.focus()
    await act(async () => windowSize(360, 430))
    field.blur()
    await act(async () => windowSize(360, 730))
    expect(screen.getByTestId('page').dataset.shape).toBe('tall')
    await act(async () => windowSize(360, 430))
    expect(screen.getByTestId('page').dataset.shape).toBe('low')
  })

  it('turned on its side while typing: the width changed, the shape follows', async () => {
    windowSize(360, 730)
    render(<Harness />)
    screen.getByTestId('prompt').focus()
    await act(async () => windowSize(730, 360))
    expect(screen.getByTestId('page').dataset.shape).not.toBe('tall')
  })
})
