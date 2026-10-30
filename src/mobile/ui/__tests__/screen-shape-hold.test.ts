/**
 * The arrangement of a page holds while the keyboard moves (package M1, 3.0.9).
 * The page that showed it: src/mobile/screens/create/__tests__/keyboard-keeps-shape.dom.test.tsx
 *
 * Run: npx vitest run src/mobile/ui/__tests__/screen-shape-hold.test.ts
 */
import { describe, expect, it } from 'vitest'
import { nextShapeState } from '../screen-shape'

describe('nextShapeState (pure)', () => {
  const tall = nextShapeState(null, { width: 360, height: 730, unitPx: 16, editing: false })

  it('holds the shape while a field is edited and only the height changed', () => {
    expect(tall.shape).toBe('tall')
    expect(nextShapeState(tall, { width: 360, height: 430, unitPx: 16, editing: true })).toBe(tall)
  })

  it('measures again without a field in focus, at another width or another text size', () => {
    expect(nextShapeState(tall, { width: 360, height: 430, unitPx: 16, editing: false }).shape).toBe('low')
    expect(nextShapeState(tall, { width: 730, height: 360, unitPx: 16, editing: true }).shape).toBe('wide')
    expect(nextShapeState(tall, { width: 360, height: 430, unitPx: 20, editing: true }).shape).toBe('low')
  })
})
