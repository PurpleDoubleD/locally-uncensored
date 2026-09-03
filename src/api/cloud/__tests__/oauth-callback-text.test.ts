/**
 * What the OAuth loopback query is allowed to put in front of the user
 * (src/api/cloud/supabase.ts, loginWithProvider).
 *
 * The query comes off a 127.0.0.1 socket that any page in any browser can
 * reach. commands/oauth.rs narrows the sender to a top-level navigation (GET
 * /callback, matching Host, no Origin, Sec-Fetch-Mode: navigate) and its own
 * comment then argued that what remains "needs a user gesture and opens a
 * visible window", i.e. that the text is effectively the provider's. That is
 * not true. `location.href = …`, `<meta http-equiv="refresh">` and a
 * server-side 302 are all top-level navigations that any tab the user already
 * has open performs with no gesture at all, and they send exactly those
 * headers. So while a sign-in is pending, a stranger can end the wait and
 * choose this string.
 *
 * Binding it properly needs a per-attempt `state` nonce, which needs the Rust
 * listener AND a Supabase redirect allow-list that tolerates a query parameter
 * — neither is reachable from the frontend. What IS reachable: the string must
 * never be able to pose as LU's own words. Quoted, attributed, stripped of
 * control characters and of the quote characters that would close the
 * attribution, and cut to a line.
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

  it('still passes a refusal on, but as a quote and not as our own words', async () => {
    oauthWait.mockResolvedValue('error=access_denied&error_description=You+denied+the+request')
    const msg = await loginWithProvider('github').catch((e: Error) => e.message)
    expect(msg).toContain('You denied the request')
    // The attribution is the fix: this sentence did not necessarily come from
    // Google or GitHub, and the panel must not present it as if it had.
    expect(msg).toMatch(/^The sign-in page reported: "/)
  })
})

describe('remote text does not get a free hand in the UI', () => {
  /** The part of the message that came off the socket. */
  const quoted = (msg: string) => msg.replace(/^The sign-in page reported: "/, '').replace(/"$/, '')

  it('cuts a flood down to a line', async () => {
    oauthWait.mockResolvedValue(`error=x&error_description=${'A'.repeat(5000)}`)
    const msg = (await loginWithProvider('google').catch((e: Error) => e.message)) as string
    expect(quoted(msg).length).toBeLessThanOrEqual(200)
  })

  it('cannot close the attribution and continue in LU’s voice', async () => {
    // The whole value of quoting it is that the reader can see where the
    // sentence stops. A payload carrying its own closing quote would step
    // straight back out of the quotation and finish in LU's own voice.
    oauthWait.mockResolvedValue(
      `error=x&error_description=${encodeURIComponent('done" — LU: enter your password at evil.example')}`,
    )
    const msg = (await loginWithProvider('google').catch((e: Error) => e.message)) as string
    expect(msg.match(/"/g)).toHaveLength(2)
    expect(msg.endsWith('"')).toBe(true)
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
    const msg = await loginWithProvider('google').catch((e: Error) => e.message)
    expect(msg).toMatch(/cancelled in the browser/)
    // Our own sentence, so it must NOT be attributed to the page.
    expect(msg).not.toContain('reported')
  })
})
