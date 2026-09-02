/**
 * @vitest-environment jsdom
 *
 * The CivitAI API key field, rendered for real.
 *
 * goonerforporn's report (Discord #bug-reports, 2026-08-28) is precisely the
 * kind a source-text test cannot answer: the store had the value and the setter,
 * the changelog named the key, and the field was not in the interface. So this
 * one mounts the component, types a key, and reads the store back.
 *
 * Run: npx vitest run src/components/settings/__tests__/civitai-key-field-renders.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

const openExternal = vi.fn()
vi.mock('../../../api/backend', () => ({
  openExternal: (...args: unknown[]) => openExternal(...args),
  backendCall: vi.fn(),
  isTauri: () => true,
  isMacOS: () => false,
  // The store reaches for the OS vault; no vault in a test process, and the
  // vault path itself is proven in stores/__tests__/civitai-key-keychain.
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

import { CivitaiApiKeySetting, CIVITAI_KEY_PAGE } from '../CivitaiApiKeySetting'
import { useWorkflowStore } from '../../../stores/workflowStore'

beforeEach(() => {
  openExternal.mockReset()
  useWorkflowStore.setState({ civitaiApiKey: '' })
})
afterEach(cleanup)

function show() {
  render(createElement(CivitaiApiKeySetting))
  return screen.getByLabelText('CivitAI API key') as HTMLInputElement
}

describe('the field exists and writes to the store', () => {
  it('is there, and is masked', () => {
    const input = show()
    // A settings page is a screen people paste into support threads.
    expect(input.type).toBe('password')
  })

  it('writes what the user typed into the store', () => {
    const input = show()
    fireEvent.change(input, { target: { value: '  my-civitai-key  ' } })
    // Nothing is stored until the field is committed.
    expect(useWorkflowStore.getState().civitaiApiKey).toBe('')
    fireEvent.click(screen.getByText('Save'))
    expect(useWorkflowStore.getState().civitaiApiKey).toBe('my-civitai-key')
    expect(screen.getByText('Saved')).toBeTruthy()
  })

  it('commits on blur as well, because that is how the other fields behave', () => {
    const input = show()
    fireEvent.change(input, { target: { value: 'typed-then-clicked-away' } })
    fireEvent.blur(input)
    expect(useWorkflowStore.getState().civitaiApiKey).toBe('typed-then-clicked-away')
  })

  it('shows an existing key back and can remove it', () => {
    useWorkflowStore.setState({ civitaiApiKey: 'already-set' })
    const input = show()
    expect(input.value).toBe('already-set')
    fireEvent.click(screen.getByText('Remove'))
    expect(useWorkflowStore.getState().civitaiApiKey).toBe('')
  })

  it('points at the page that issues the key', () => {
    show()
    fireEvent.click(screen.getByText('Get a CivitAI API key'))
    expect(openExternal).toHaveBeenCalledWith(CIVITAI_KEY_PAGE)
    expect(CIVITAI_KEY_PAGE).toMatch(/^https:\/\/civitai\.com\//)
  })

  // Negative control: with no key stored there is nothing to remove, so the
  // button that would clear it is not offered.
  it('offers no Remove button when there is no key', () => {
    show()
    expect(screen.queryByText('Remove')).toBeNull()
  })

  it('explains in English why the key matters, and where it is kept', () => {
    show()
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/Most CivitAI downloads are refused without a key/)
    expect(text).toMatch(/HTTP 400 or 401/)
    // Where it goes is part of the answer: it is a credential, and it is not
    // sitting in plain text any more.
    expect(text).toMatch(/system credential store/)
  })
})

// ── A14 review 8: a key field that cannot be mistaken for a folder field ────
//
// From the Windows follow-up: the Model Storage folder field and this one sat
// directly under each other, two bare text boxes in a row, and a tester saved
// a filesystem path as his API key. Nothing said no, the path went into the OS
// credential store, every CivitAI download kept failing with a bare 400, and
// the field showed a row of dots that looked exactly like a key that was there.

describe('the field says what belongs in it', () => {
  it('the empty field shows the shape of a key, not the word none', () => {
    show()
    const field = screen.getByLabelText('CivitAI API key') as HTMLInputElement
    expect(field.placeholder).toMatch(/^[0-9a-f]{32}$/)
    expect(field.placeholder).not.toBe('(none)')
  })

  it('a pasted Windows path is called out instead of silently stored', () => {
    show()
    const field = screen.getByLabelText('CivitAI API key')
    fireEvent.change(field, { target: { value: 'G:\\AI\\Models' } })
    expect(screen.getByTestId('civitai-key-looks-wrong').textContent)
      .toContain('That looks like a folder, not a key')
    // And it names where that value actually belongs.
    expect(screen.getByTestId('civitai-key-looks-wrong').textContent).toContain('Model Storage')
  })

  it('a pasted Unix path too', () => {
    show()
    fireEvent.change(screen.getByLabelText('CivitAI API key'), { target: { value: '/Users/dev/lu-e2e-models' } })
    expect(screen.getByTestId('civitai-key-looks-wrong')).toBeTruthy()
  })

  // NEGATIVE CONTROL, and the important one: a real key must never trip this.
  // A key the user cannot save without a warning beside it is a feature he
  // stops trusting.
  it('stays quiet for a real key', () => {
    show()
    fireEvent.change(screen.getByLabelText('CivitAI API key'), { target: { value: '3f9a1c7d5e2b48f06a1d9c3e7b52f8a4' } })
    expect(screen.queryByTestId('civitai-key-looks-wrong')).toBeNull()
  })

  // NEGATIVE CONTROL: an empty field is not a mistake, it is the default.
  it('stays quiet on an empty field', () => {
    show()
    expect(screen.queryByTestId('civitai-key-looks-wrong')).toBeNull()
  })
})
