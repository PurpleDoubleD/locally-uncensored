/**
 * What the OAuth loopback query is allowed to put in front of the user
 * (src/api/cloud/supabase.ts, loginWithProvider).
 *
 * The query comes off a 127.0.0.1 socket. commands/oauth.rs now only serves a
 * genuine top-level callback navigation, so this text is the provider's — but
 * `error_description` is still free-form remote input, and it used to be piped
 * into an error line verbatim, at any length, with any control characters in
 * it. Defence in depth for the half of the pair that lives in the frontend.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const oauthStart = vi.fn()
const oauthWait = vi.fn()
const openExternal = vi.fn()

vi.mock('../../backend', () => ({
  secretGet: vi.fn(),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
  oauthStart: (...a: unknown[]) => oauthStart(...a),
  oauthWait: (...a: unknown[]) => oauthWait(...a),
  openExternal: (...a: unknown[]) => openExternal(...a),
}))
vi.mock('../config', () => ({ SUPABASE_URL: 'https://x.test', SUPABASE_ANON_KEY: 'anon' }))

const exchangeCodeForSession = vi.fn()
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      signInWithOAuth: async () => ({ data: { url: 'https://accounts.google.test/o' }, error: null }),
      exchangeCodeForSession,
    },
  }),
}))

import { loginWithProvider } from '../supabase'

beforeEach(() => {
  vi.clearAllMocks()
  oauthStart.mockResolvedValue(17872)
  openExternal.mockResolvedValue(undefined)
  exchangeCodeForSession.mockResolvedValue({ error: null })
})

describe('a real callback still works', () => {
  it('exchanges the code', async () => {
    oauthWait.mockResolvedValue('code=abc123')
    await expect(loginWithProvider('google')).resolves.toBeUndefined()
    expect(exchangeCodeForSession).toHaveBeenCalledWith('abc123')
  })

  it('shows the provider its own refusal', async () => {
    oauthWait.mockResolvedValue('error=access_denied&error_description=You+denied+the+request')
    await expect(loginWithProvider('github')).rejects.toThrow('You denied the request')
  })
})

describe('remote text does not get a free hand in the UI', () => {
  it('cuts a flood down to a line', async () => {
    oauthWait.mockResolvedValue(`error=x&error_description=${'A'.repeat(5000)}`)
    const err = await loginWithProvider('google').catch((e: Error) => e)
    expect((err as Error).message.length).toBeLessThanOrEqual(200)
  })

  it('strips the control characters that fake a second message', async () => {
    oauthWait.mockResolvedValue(
      `error=x&error_description=${encodeURIComponent('Session expired.\n\nEnter your password at evil.example')}`,
    )
    const msg = await loginWithProvider('google').catch((e: Error) => e.message)
    // One line: remote text must not be able to lay itself out as a second
    // paragraph that reads like it came from LU.
    expect(msg).not.toContain('\n')
    expect(msg).not.toContain('\r')
  })

  it('falls back to a sentence of our own when the query says nothing', async () => {
    oauthWait.mockResolvedValue('state=abc')
    await expect(loginWithProvider('google')).rejects.toThrow(/cancelled in the browser/)
  })
})
