/**
 * @vitest-environment jsdom
 *
 * The Hugging Face token field, rendered for real, on a platform that is not
 * a Mac. Until 2.6.8 the field lived only in the Apple MLX panel, so a Windows
 * user who hit a gated repository had nowhere to put the token the error
 * message now asks for.
 *
 * Run: npx vitest run src/components/settings/__tests__/hf-token-field-renders.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const secretSet = vi.fn().mockResolvedValue(undefined)
const secretGet = vi.fn().mockResolvedValue(null)
const applyHfToken = vi.fn().mockResolvedValue({ present: true })
const secretStoreInfo = vi.fn().mockResolvedValue({ kind: 'os' })
vi.mock('../../../api/backend', () => ({
  openExternal: vi.fn(),
  backendCall: vi.fn(),
  isTauri: () => true,
  isMacOS: () => false,
  secretGet: (...a: unknown[]) => secretGet(...a),
  secretSet: (...a: unknown[]) => secretSet(...a),
  secretDelete: vi.fn(),
  secretStoreInfo: (...a: unknown[]) => secretStoreInfo(...a),
}))
vi.mock('../../../api/mlx-image', () => ({
  HF_TOKEN_ACCOUNT: 'huggingface-token',
  applyHfToken: (...a: unknown[]) => applyHfToken(...a),
}))

import { HfTokenSetting } from '../HfTokenSetting'

beforeEach(() => {
  secretSet.mockReset().mockResolvedValue(undefined)
  secretGet.mockReset().mockResolvedValue(null)
  secretStoreInfo.mockReset().mockResolvedValue({ kind: 'os' })
  applyHfToken.mockClear()
})
afterEach(cleanup)

describe('the Hugging Face token field', () => {
  it('is there, masked, and saves into the vault and into Rust', async () => {
    render(createElement(HfTokenSetting))
    const input = screen.getByLabelText('Hugging Face token') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: '  hf_abc  ' } })
    expect(secretSet).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(secretSet).toHaveBeenCalledWith('huggingface-token', 'hf_abc'))
    expect(applyHfToken).toHaveBeenCalledWith('hf_abc')
    expect(await screen.findByText('Saved')).toBeTruthy()
  })

  it('shows a stored token as present and removes it with an empty write', async () => {
    secretGet.mockResolvedValue('hf_stored')
    render(createElement(HfTokenSetting))
    const remove = await screen.findByText('Remove')
    fireEvent.click(remove)
    await waitFor(() => expect(secretSet).toHaveBeenCalledWith('huggingface-token', ''))
    expect(applyHfToken).toHaveBeenCalledWith('')
  })

  it('says nothing about a file when the OS store took the token', async () => {
    render(createElement(HfTokenSetting))
    fireEvent.change(screen.getByLabelText('Hugging Face token'), { target: { value: 'hf_abc' } })
    fireEvent.click(screen.getByText('Save'))
    expect(await screen.findByText('Saved')).toBeTruthy()
    expect(screen.queryByText(/No system keyring answered/)).toBeNull()
  })

  // GitHub #226: Linux without a Secret Service. Rust saves into a 0600 file
  // and the field has to say so and where, not pretend it is in a keyring.
  it('names the file when a Linux without a keyring stored the token there', async () => {
    secretStoreInfo.mockResolvedValue({ kind: 'file', path: '/home/u/.local/share/lu-labs/secrets.json' })
    render(createElement(HfTokenSetting))
    fireEvent.change(screen.getByLabelText('Hugging Face token'), { target: { value: 'hf_abc' } })
    fireEvent.click(screen.getByText('Save'))
    const note = await screen.findByRole('status')
    expect(note.textContent).toContain('No system keyring answered')
    expect(note.textContent).toContain('/home/u/.local/share/lu-labs/secrets.json')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the file note for a token already stored there', async () => {
    secretGet.mockResolvedValue('hf_stored')
    secretStoreInfo.mockResolvedValue({ kind: 'file', path: '/x/secrets.json' })
    render(createElement(HfTokenSetting))
    expect((await screen.findByRole('status')).textContent).toContain('/x/secrets.json')
  })

  it('drops the note again once the token is removed', async () => {
    secretGet.mockResolvedValue('hf_stored')
    secretStoreInfo.mockResolvedValue({ kind: 'file', path: '/x/secrets.json' })
    render(createElement(HfTokenSetting))
    await screen.findByRole('status')
    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(screen.queryByText(/No system keyring answered/)).toBeNull())
  })

  it('still shows a real save error', async () => {
    secretSet.mockRejectedValue(new Error('keyring locked: the unlock prompt was dismissed'))
    render(createElement(HfTokenSetting))
    fireEvent.change(screen.getByLabelText('Hugging Face token'), { target: { value: 'hf_abc' } })
    fireEvent.click(screen.getByText('Save'))
    expect((await screen.findByRole('alert')).textContent).toContain('unlock prompt was dismissed')
    expect(applyHfToken).not.toHaveBeenCalled()
  })
})
