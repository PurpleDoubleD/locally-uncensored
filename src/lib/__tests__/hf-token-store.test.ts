/**
 * @vitest-environment jsdom
 *
 * On Linux, secret.rs answers "keychain unsupported on this platform".
 * Before this fix the Hugging Face token field showed that text as an error
 * and the token was never saved.
 *
 * Run: npx vitest run src/lib/__tests__/hf-token-store.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const secretSet = vi.fn()
const secretGet = vi.fn()
vi.mock('../../api/backend', () => ({
  secretGet: (...a: unknown[]) => secretGet(...a),
  secretSet: (...a: unknown[]) => secretSet(...a),
  secretDelete: vi.fn(),
  secretParkGet: vi.fn(),
  secretParkSet: vi.fn(),
  secretParkDelete: vi.fn(),
  setOllamaBase: vi.fn(),
}))
vi.mock('../../api/mlx-image', () => ({ HF_TOKEN_ACCOUNT: 'huggingface-token' }))

import { saveHfToken, loadHfToken } from '../hf-token-store'

const LINUX = new Error('keychain unsupported on this platform')

beforeEach(() => {
  secretSet.mockReset()
  secretGet.mockReset()
  localStorage.clear()
})

describe('Hugging Face token storage', () => {
  it('Linux: saves and loads without a keychain', async () => {
    secretSet.mockRejectedValue(LINUX)
    secretGet.mockRejectedValue(LINUX)
    await saveHfToken('hf_abc')
    expect(await loadHfToken()).toBe('hf_abc')
    expect(localStorage.getItem('lu-hf-token')).not.toContain('hf_abc')
  })

  it('Linux: an empty token clears it', async () => {
    secretSet.mockRejectedValue(LINUX)
    secretGet.mockRejectedValue(LINUX)
    await saveHfToken('hf_abc')
    await saveHfToken('')
    expect(await loadHfToken()).toBeNull()
  })

  it('Windows/macOS: uses the keychain, nothing in localStorage', async () => {
    secretSet.mockResolvedValue(undefined)
    secretGet.mockResolvedValue('hf_abc')
    await saveHfToken('hf_abc')
    expect(secretSet).toHaveBeenCalledWith('huggingface-token', 'hf_abc')
    expect(localStorage.getItem('lu-hf-token')).toBeNull()
    expect(await loadHfToken()).toBe('hf_abc')
  })

  it('other keychain errors still reach the user', async () => {
    secretSet.mockRejectedValue(new Error('refused: bad account'))
    await expect(saveHfToken('hf_abc')).rejects.toThrow('refused')
    expect(localStorage.getItem('lu-hf-token')).toBeNull()
  })
})
