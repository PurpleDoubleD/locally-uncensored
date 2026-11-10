// @vitest-environment jsdom
/**
 * C38 (3.1.0): the Memory quick menu cut every memory after
 * about 90 characters, and there was no way to read or change the rest. A row
 * now opens to the whole text, and Edit changes it in place.
 *
 * Run: npx vitest run src/components/chat/__tests__/memory-panel-edit.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useMemoryStore, __setMemoryEmbedFn } from '../../../stores/memoryStore'
import { MemoryDebugToggle } from '../MemoryDebugPanel'

const LONG = 'The user runs a small bakery in Lodz and prefers answers in Polish. ' +
  'They bake rye bread on Fridays and want recipes in grams, never cups. The oven tops out at 250 C.'

function open() {
  render(<MemoryDebugToggle />)
  fireEvent.click(screen.getByTitle('Memory: view, add or delete the context injected into prompts'))
}

beforeEach(() => {
  __setMemoryEmbedFn(async (texts: string[]) => texts.map(() => []))
  useMemoryStore.setState({ entries: [], forgotten: [], activeMemoryOwner: null })
  useMemoryStore.getState().addMemory({ type: 'user', title: 'Bakery', description: LONG.slice(0, 120), content: LONG, tags: [], source: 'manual' })
})
afterEach(() => cleanup())

describe('Memory quick menu: read and edit the whole memory', () => {
  it('a click on the row shows the whole text, not a cut line', () => {
    open()
    expect(screen.queryByTestId('memory-full')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Bakery/, expanded: false }))
    expect(screen.getByTestId('memory-full').textContent).toBe(LONG)
  })

  it('Edit changes title, kind and text, and the short line follows', () => {
    open()
    fireEvent.click(screen.getByLabelText('Edit Bakery'))
    fireEvent.change(screen.getByLabelText('Memory title'), { target: { value: 'Bakery in Lodz' } })
    fireEvent.change(screen.getByLabelText('Kind of memory'), { target: { value: 'project' } })
    const field = screen.getByRole('textbox', { name: 'Memory' })
    fireEvent.change(field, { target: { value: LONG + ' New: gluten free on Mondays.' } })
    fireEvent.click(screen.getByTestId('memory-save'))
    const e = useMemoryStore.getState().entries[0]
    expect(e.title).toBe('Bakery in Lodz')
    expect(e.type).toBe('project')
    expect(e.content.endsWith('gluten free on Mondays.')).toBe(true)
    expect(e.description).toBe(e.content.slice(0, 120))
    expect(screen.getByTestId('memory-full').textContent).toContain('gluten free on Mondays.')
  })

  it('Cancel leaves the memory as it was', () => {
    open()
    fireEvent.click(screen.getByLabelText('Edit Bakery'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory' }), { target: { value: 'gone' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useMemoryStore.getState().entries[0].content).toBe(LONG)
  })

  it('an empty text cannot be saved', () => {
    open()
    fireEvent.click(screen.getByLabelText('Edit Bakery'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory' }), { target: { value: '   ' } })
    expect((screen.getByTestId('memory-save') as HTMLButtonElement).disabled).toBe(true)
  })
})
