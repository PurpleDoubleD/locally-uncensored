/**
 * @vitest-environment jsdom
 *
 * The number field beside the LoRA strength slider (Discord 2026-10-02,
 * A user): exact values, negative ones, and the wide range the slider
 * does not reach. Measured on the rendered control.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/lora-strength-feld.test.tsx
 */
import { describe, it, expect, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LoraStrength } from '../LoraStrength'

const NAME = 'styles/krea2_slider_age.safetensors'
const seen: number[] = []

function Harness({ start = 0.8 }: { start?: number }) {
  const [value, setValue] = useState(start)
  return <LoraStrength name={NAME} value={value} onChange={(v) => { seen.push(v); setValue(v) }} />
}

const field = () => screen.getByRole('textbox', { name: 'Strength of krea2_slider_age' }) as HTMLInputElement
const slider = () => screen.getByRole('slider') as HTMLInputElement
const type = (text: string) => fireEvent.change(field(), { target: { value: text } })

afterEach(() => { cleanup(); seen.length = 0 })

describe('the number field', () => {
  it('shows the value with two decimals and is named after its LoRA', () => {
    render(<Harness />)
    expect(field().value).toBe('0.80')
    expect(screen.getByText('Strength')).toBeTruthy()
  })

  it('a typed value is applied, a negative one too', () => {
    render(<Harness />)
    fireEvent.focus(field())
    type('-4')
    expect(seen.at(-1)).toBe(-4)
    fireEvent.blur(field())
    expect(field().value).toBe('-4.00')
  })

  it('typing a negative number digit by digit never loses the minus', () => {
    render(<Harness />)
    fireEvent.focus(field())
    type('-')
    expect(field().value).toBe('-')
    expect(seen).toEqual([])
    type('-7')
    type('-7.')
    expect(field().value).toBe('-7.')
    type('-7.5')
    expect(seen.at(-1)).toBe(-7.5)
  })

  it('the ends are -20 and 20: more is pulled back, and the field says so on leaving', () => {
    render(<Harness />)
    fireEvent.focus(field())
    type('25')
    expect(seen.at(-1)).toBe(20)
    expect(field().value).toBe('25')
    fireEvent.blur(field())
    expect(field().value).toBe('20.00')
    fireEvent.focus(field())
    type('-250')
    fireEvent.blur(field())
    expect(seen.at(-1)).toBe(-20)
    expect(field().value).toBe('-20.00')
  })

  it('takes what slider LoRAs are made for, -10 and 15 included', () => {
    render(<Harness />)
    fireEvent.focus(field())
    type('15')
    fireEvent.blur(field())
    expect(seen.at(-1)).toBe(15)
    expect(field().value).toBe('15.00')
    fireEvent.focus(field())
    type('-10')
    fireEvent.blur(field())
    expect(seen.at(-1)).toBe(-10)
    expect(field().value).toBe('-10.00')
  })

  it('a typo changes nothing and is gone when the field is left', () => {
    render(<Harness start={1.25} />)
    fireEvent.focus(field())
    for (const typo of ['abc', '1.2.3', '', '1e3', '--2']) {
      type(typo)
      expect(field().value).toBe(typo)
    }
    expect(seen).toEqual([])
    fireEvent.blur(field())
    expect(field().value).toBe('1.25')
  })

  it('a decimal comma counts', () => {
    render(<Harness />)
    fireEvent.focus(field())
    type('1,5')
    expect(seen.at(-1)).toBe(1.5)
  })

  it('arrow keys step by 0.05, below zero as well, and stop at the ends', () => {
    render(<Harness start={0} />)
    fireEvent.focus(field())
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(seen.at(-1)).toBe(-0.05)
    expect(field().value).toBe('-0.05')
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(seen.at(-1)).toBe(0.05)
    cleanup()
    render(<Harness start={20} />)
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(seen.at(-1)).toBe(20)
    cleanup()
    render(<Harness start={-20} />)
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(seen.at(-1)).toBe(-20)
  })
})

describe('the slider next to it', () => {
  it('covers -2 to 2 in steps of 0.05 and writes into the same value', () => {
    render(<Harness />)
    expect([slider().min, slider().max, slider().step]).toEqual(['-2', '2', '0.05'])
    fireEvent.change(slider(), { target: { value: '1.35' } })
    expect(seen.at(-1)).toBe(1.35)
    expect(field().value).toBe('1.35')
  })

  it('widens to a value beyond it (D4b), the field keeps the truth', () => {
    render(<Harness start={-6} />)
    expect([slider().min, slider().max, slider().value]).toEqual(['-6', '6', '-6'])
    expect(field().value).toBe('-6.00')
    cleanup()
    render(<Harness start={8} />)
    expect([slider().min, slider().max, slider().value]).toEqual(['-8', '8', '8'])
    expect(field().value).toBe('8.00')
  })
})

describe('the LoRA stack', () => {
  it('draws this control for every active LoRA and writes into the store per name', () => {
    const src = readFileSync(resolve(__dirname, '..', 'ParamGroups.tsx'), 'utf8')
    // The field is named after what the row reads (a catalogue LoRA shows its
    // catalogue name), the store is written under the file name.
    expect(src).toMatch(/<LoraStrength name=\{label\} value=\{active\.strength\} onChange=\{\(v\) => s\.setLoraStrengthFor\(name, v\)\} \/>/)
    // The old slider that stopped at 2 is gone, not kept beside it.
    expect(src).not.toMatch(/label="Strength"/)
  })
})
