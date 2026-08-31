/**
 * A sign-out that did not happen has to be VISIBLE (AccountPanel).
 *
 * The dangerous half was closed first: `signOutAccount` throws when the saved
 * session survived the delete, and deliberately leaves the store signed IN,
 * because the account really is still usable on this machine.
 *
 * The visible half was still open. The panel called `void logout()`, so the
 * throw went nowhere: the account row stayed on screen, no message appeared,
 * and the click read as a sign-out that had simply taken no effect. Whoever
 * hands over a shared or company machine on the strength of that hands over
 * the account with it — which is the exact scenario the throw was added for.
 *
 * The suite runs in the `node` environment with no DOM, so the behaviour lives
 * in an exported function the panel calls, and the wiring is read off the
 * source.
 *
 * Run: npx vitest run src/components/auth/__tests__/sign-out-failure-reaches-the-user.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

vi.mock('../../../hooks/useCloudAuth', () => ({ useCloudAuth: vi.fn() }))
vi.mock('../../../api/cloud/supabase', () => ({ loginWithProvider: vi.fn() }))
vi.mock('../../../api/backend', () => ({ openExternal: vi.fn() }))

import { runSignOut } from '../AccountPanel'

const PANEL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../AccountPanel.tsx'),
  'utf8',
)

/** What useCloudAuth.signOutAccount throws when the session is still here. */
const STILL_HERE = new Error(
  'Sign-out failed — the saved session is still on this computer, so the account stays signed in here. keychain locked',
)

describe('a sign-out that failed says so', () => {
  it('reports the message it was refused with', async () => {
    const reported: (string | null)[] = []
    await runSignOut(async () => { throw STILL_HERE }, (m) => reported.push(m))

    expect(reported.at(-1)).toContain('still on this computer')
  })

  it('clears the previous failure before trying again', async () => {
    // Otherwise a retry that worked would leave yesterday's red line standing
    // under an account that is now genuinely signed out.
    const reported: (string | null)[] = []
    await runSignOut(async () => {}, (m) => reported.push(m))

    expect(reported).toEqual([null])
  })

  it('does not rethrow — the click must not take the panel down with it', async () => {
    await expect(runSignOut(async () => { throw STILL_HERE }, () => {})).resolves.toBeUndefined()
  })

  it('survives something thrown that is not an Error', async () => {
    const reported: (string | null)[] = []
    await runSignOut(async () => { throw 'the stub received bad data' }, (m) => reported.push(m))

    expect(reported.at(-1)).toContain('bad data')
  })
})

describe('the panel is actually wired to it', () => {
  it('routes the Sign out button through runSignOut', () => {
    expect(PANEL).toContain('runSignOut(logout, setSignOutError)')
    // The bare `void logout()` is what swallowed the throw.
    expect(PANEL).not.toMatch(/onClick=\{\(\)\s*=>\s*void logout\(\)\}/)
  })

  it('renders the failure in the SIGNED-IN branch, where the user is standing', () => {
    // `error` already existed and is only drawn in the signed-out form. A
    // sign-out failure happens on the other screen, so reporting it into that
    // state would have changed nothing on screen.
    const signedIn = PANEL.slice(PANEL.indexOf('{licenseActive && quota ?'))
    expect(PANEL).toMatch(/\{signOutError && \(/)
    expect(PANEL).toContain('{signOutError}')
    expect(PANEL.indexOf('{signOutError && (')).toBeLessThan(PANEL.indexOf('{licenseActive && quota ?'))
    // ...and it is inside the signed-in return, not the form above it.
    expect(PANEL.indexOf('{signOutError && (')).toBeGreaterThan(PANEL.indexOf('<OAuthButtons'))
    expect(signedIn).toBeTruthy()
  })
})
