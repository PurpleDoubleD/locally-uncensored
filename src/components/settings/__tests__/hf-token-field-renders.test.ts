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
vi.mock('../../../api/backend', () => ({
  openExternal: vi.fn(),
  backendCall: vi.fn(),
  isTauri: () => true,
  isMacOS: () => false,
  secretGet: (...a: unknown[]) => secretGet(...a),
  secretSet: (...a: unknown[]) => secretSet(...a),
  secretDelete: vi.fn(),
}))
vi.mock('../../../api/mlx-image', () => ({
  HF_TOKEN_ACCOUNT: 'huggingface-token',
  applyHfToken: (...a: unknown[]) => applyHfToken(...a),
}))

import { HfTokenSetting } from '../HfTokenSetting'

beforeEach(() => { secretSet.mockClear(); secretGet.mockReset().mockResolvedValue(null); applyHfToken.mockClear() })
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
})
