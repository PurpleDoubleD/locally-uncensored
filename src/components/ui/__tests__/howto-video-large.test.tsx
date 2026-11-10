/**
 * @vitest-environment jsdom
 *
 * C26 (3.1.0): the How-it-works films were only ever 340 px wide, "so small
 * they are unwatchable" (Discord, 1 Nov). The card now opens them over the
 * whole window: by its enlarge button or a double click on the film, back by
 * Escape, the shrink button or a click beside it, and Escape a second time
 * closes the card as before.
 *
 * Run: npx vitest run src/components/ui/__tests__/howto-video-large.test.tsx
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('../../../api/backend', () => ({ openExternal: vi.fn() }))

import { HowItWorks } from '../HowItWorks'
import { HOWTO } from '../../../lib/howto'

// jsdom has no ResizeObserver; the card only uses it to place itself.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

afterEach(cleanup)

const TOPIC = Object.keys(HOWTO)[0]

function openCard() {
  render(createElement(HowItWorks, { topic: TOPIC, variant: 'line' }))
  fireEvent.click(screen.getByText(HOWTO[TOPIC].title))
  return screen.getByTestId(`howto-card-${TOPIC}`)
}

describe('How it works, enlarged', () => {
  it('the card has an enlarge button and starts small', () => {
    openCard()
    expect(screen.getByTestId('howto-enlarge')).toBeTruthy()
    expect(screen.getByTestId('howto-video')).toBeTruthy()
    expect(screen.queryByTestId(`howto-large-${TOPIC}`)).toBeNull()
  })

  it('the button opens the film over the window, one film at a time', () => {
    openCard()
    fireEvent.click(screen.getByTestId('howto-enlarge'))
    const large = screen.getByTestId(`howto-large-${TOPIC}`)
    expect(large.className).toContain('fixed')
    expect(large.className).toContain('inset-0')
    expect(screen.getByTestId('howto-video-large')).toBeTruthy()
    expect(screen.queryByTestId('howto-video')).toBeNull()
    expect(screen.getByRole('dialog', { name: `${HOWTO[TOPIC].title}, enlarged` })).toBeTruthy()
  })

  it('a double click on the film enlarges it too', () => {
    openCard()
    fireEvent.doubleClick(screen.getByTestId('howto-video'))
    expect(screen.getByTestId('howto-video-large')).toBeTruthy()
  })

  it('Escape shrinks first, then closes the card', () => {
    openCard()
    fireEvent.click(screen.getByTestId('howto-enlarge'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId(`howto-large-${TOPIC}`)).toBeNull()
    expect(screen.getByTestId(`howto-card-${TOPIC}`)).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId(`howto-card-${TOPIC}`)).toBeNull()
  })

  it('a click beside the film shrinks it and keeps the card', () => {
    openCard()
    fireEvent.click(screen.getByTestId('howto-enlarge'))
    const backdrop = screen.getByTestId(`howto-large-${TOPIC}`)
    fireEvent.mouseDown(backdrop)
    fireEvent.click(backdrop)
    expect(screen.queryByTestId(`howto-large-${TOPIC}`)).toBeNull()
    expect(screen.getByTestId(`howto-card-${TOPIC}`)).toBeTruthy()
  })

  it('the shrink button goes back to the card', () => {
    openCard()
    fireEvent.click(screen.getByTestId('howto-enlarge'))
    fireEvent.click(screen.getByLabelText('Shrink video'))
    expect(screen.getByTestId('howto-video')).toBeTruthy()
  })

  it('without a connection there is nothing to enlarge', () => {
    openCard()
    fireEvent.error(screen.getByTestId('howto-video'))
    expect(screen.getByTestId('howto-lines')).toBeTruthy()
    expect(screen.queryByTestId('howto-enlarge')).toBeNull()
  })
})
