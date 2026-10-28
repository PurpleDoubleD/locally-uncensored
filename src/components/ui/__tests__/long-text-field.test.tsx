// @vitest-environment jsdom
/**
 * GH #197: the persona prompt, the reminder and a memory drag taller and open
 * in a large editor with search (Ctrl+F) and a character and token count.
 *
 * Run: npx vitest run src/components/ui/__tests__/long-text-field.test.tsx
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LongTextField } from '../LongTextField'
import { SystemPromptEditor } from '../../personas/SystemPromptEditor'
import { useSettingsStore } from '../../../stores/settingsStore'

beforeEach(() => localStorage.clear())
afterEach(cleanup)

function Harness({ initial }: { initial: string }) {
  const [v, setV] = useState(initial)
  return <LongTextField value={v} onChange={setV} storageKey="t" label="System prompt" testId="f" />
}

describe('the long text field', () => {
  it('drags taller (resize-y) and opens with its kept height', () => {
    localStorage.setItem('lu-long-text-height:t', '420')
    render(<Harness initial="x" />)
    const field = screen.getByTestId('f') as HTMLTextAreaElement
    expect(field.className).toMatch(/resize-y/)
    expect(field.className).not.toMatch(/resize-none/)
    expect(field.style.height).toBe('420px')
  })

  it('Expand opens the same text large, with a count, and edits go through', async () => {
    render(<Harness initial={'The baron. '.repeat(10)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand System prompt' }))
    const area = await screen.findByTestId('long-text-area') as HTMLTextAreaElement
    expect(area.value).toBe('The baron. '.repeat(10))
    await waitFor(() => expect(screen.getByTestId('long-text-count').textContent).toMatch(/^110 characters · ~\d+ tokens$/))
    fireEvent.change(area, { target: { value: 'short' } })
    expect((screen.getByTestId('f') as HTMLTextAreaElement).value).toBe('short')
  })

  it('Ctrl+F in the field opens the editor at the search, which counts and steps', async () => {
    render(<Harness initial="Baron one, baron two, BARON three" />)
    fireEvent.keyDown(screen.getByTestId('f'), { key: 'f', ctrlKey: true })
    const find = await screen.findByTestId('long-text-find') as HTMLInputElement
    await waitFor(() => expect(document.activeElement).toBe(find))
    fireEvent.change(find, { target: { value: 'baron' } })
    await waitFor(() => expect(screen.getByTestId('long-text-find-count').textContent).toBe('1 / 3'))
    fireEvent.keyDown(find, { key: 'Enter' })
    expect(screen.getByTestId('long-text-find-count').textContent).toBe('2 / 3')
    const area = screen.getByTestId('long-text-area') as HTMLTextAreaElement
    expect([area.selectionStart, area.selectionEnd]).toEqual([11, 16])
    fireEvent.keyDown(find, { key: 'Enter', shiftKey: true })
    expect(screen.getByTestId('long-text-find-count').textContent).toBe('1 / 3')
  })

  it('a 40,000 token prompt types without the count or search in the way', () => {
    const big = 'The baron walks slowly through the hall. '.repeat(4000)
    render(<Harness initial={big} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand System prompt' }))
    const area = screen.getByTestId('long-text-area') as HTMLTextAreaElement
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) act(() => { fireEvent.change(area, { target: { value: big + 'x'.repeat(i) } }) })
    const perKey = (performance.now() - t0) / 20
    // jsdom is far slower than a WebView; this only keeps an O(n²) slip out.
    expect(perKey).toBeLessThan(100)
  })
})

describe('Escape', () => {
  it('closes the editor and nothing under it', async () => {
    let outer = 0
    const onDoc = (e: KeyboardEvent) => { if (e.key === 'Escape') outer++ }
    document.addEventListener('keydown', onDoc)
    render(<Harness initial="abc" />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand System prompt' }))
    const area = await screen.findByTestId('long-text-area')
    fireEvent.keyDown(area, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('long-text-area')).toBeNull())
    document.removeEventListener('keydown', onDoc)
    expect(outer).toBe(0)
  })
})

describe('where it is used', () => {
  it('the persona editor has it for the prompt and the reminder, and saves custom rows', () => {
    const before = useSettingsStore.getState().personas.length
    render(<SystemPromptEditor />)
    expect(screen.getByRole('button', { name: 'Expand System prompt' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Expand Reminder' })).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('Persona name...'), { target: { value: 'Baron' } })
    fireEvent.change(screen.getByPlaceholderText('System prompt...'), { target: { value: 'You are Baron.' } })
    fireEvent.click(screen.getByTestId('custom-param-add'))
    fireEvent.change(screen.getByLabelText('Parameter name'), { target: { value: 'dry_base' } })
    fireEvent.change(screen.getByLabelText('Parameter value'), { target: { value: '1.75' } })
    fireEvent.click(screen.getByTestId('custom-param-add'))
    fireEvent.change(screen.getAllByLabelText('Parameter name')[1], { target: { value: 'temperature' } })
    expect(screen.getByTestId('custom-param-problem').textContent).toMatch(/own field/)
    fireEvent.click(screen.getByRole('button', { name: 'Save Persona' }))
    const saved = useSettingsStore.getState().personas
    expect(saved).toHaveLength(before + 1)
    expect(saved[saved.length - 1].customParams).toEqual([
      { key: 'dry_base', type: 'number', value: '1.75' },
      { key: 'temperature', type: 'number', value: '' },
    ])
  })
})
