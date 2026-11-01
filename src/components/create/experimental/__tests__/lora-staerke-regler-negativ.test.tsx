/**
 * @vitest-environment jsdom
 *
 * D4b (3.0.9, Discord 2026-11-01): the LoRA strength slider stopped at 0 to 2,
 * slider LoRAs need values below zero and some -10 to 20. The slider now
 * covers -2 to 2 with 0 marked in the middle, the field still takes any value
 * from -20 to 20, and a typed value beyond 2 widens the slider to it.
 * Stored strengths read as before.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/lora-staerke-regler-negativ.test.tsx
 */
import { describe, it, expect, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { LoraStrength } from '../LoraStrength'
import { loraSliderReach } from '../../../../lib/lora-strength'

const NAME = 'krea2_slider_age.safetensors'
const seen: number[] = []

function Harness({ start = 0.8 }: { start?: number }) {
  const [value, setValue] = useState(start)
  return <LoraStrength name={NAME} value={value} onChange={(v) => { seen.push(v); setValue(v) }} />
}

const field = () => screen.getByRole('textbox', { name: 'Strength of krea2_slider_age' }) as HTMLInputElement
const slider = () => screen.getByRole('slider') as HTMLInputElement
const range = () => [slider().min, slider().max]
const type = (text: string) => {
  fireEvent.focus(field())
  fireEvent.change(field(), { target: { value: text } })
  fireEvent.blur(field())
}

afterEach(() => { cleanup(); seen.length = 0 })

describe('D4b: the strength slider goes below zero', () => {
  it('covers -2 to 2 by default, with 0 marked in the middle', () => {
    render(<Harness />)
    expect(range()).toEqual(['-2', '2'])
    expect(slider().value).toBe('0.8')
    expect(screen.getByTestId('slider-origin').style.left).toBe('50%')
  })

  it('drags to a negative strength, and the field shows it', () => {
    render(<Harness />)
    fireEvent.change(slider(), { target: { value: '-1.5' } })
    expect(seen.at(-1)).toBe(-1.5)
    expect(field().value).toBe('-1.50')
  })

  it('a typed value beyond 2 widens the slider to it, on both sides', () => {
    render(<Harness />)
    type('-15')
    expect(seen.at(-1)).toBe(-15)
    expect(range()).toEqual(['-15', '15'])
    expect(slider().value).toBe('-15')
    type('20')
    expect(range()).toEqual(['-20', '20'])
    expect(slider().value).toBe('20')
  })

  it('stays wide while it is open, so dragging back to 0 does not move the track', () => {
    render(<Harness />)
    type('12.5')
    fireEvent.change(slider(), { target: { value: '0.5' } })
    expect(seen.at(-1)).toBe(0.5)
    expect(range()).toEqual(['-13', '13'])
  })

  it('a stored strength opens where it is: 0.8 on the usual slider, -6 on a wider one', () => {
    render(<Harness start={0.8} />)
    expect(range()).toEqual(['-2', '2'])
    cleanup()
    render(<Harness start={-6} />)
    expect(range()).toEqual(['-6', '6'])
    expect(slider().value).toBe('-6')
    expect(field().value).toBe('-6.00')
    expect(seen).toEqual([])
  })

  it('the reach is 2, or the next whole number past the value, never past 20', () => {
    expect([0, 0.8, 2, -2, 2.01, -15, 15.5, 20].map(loraSliderReach)).toEqual([2, 2, 2, 2, 3, 15, 16, 20])
  })
})
