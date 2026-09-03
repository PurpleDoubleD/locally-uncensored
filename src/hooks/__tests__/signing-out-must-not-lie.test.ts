/**
 * Sign-out (src/hooks/useCloudAuth.ts).
 *
 * The keychain adapter throws on purpose when a delete fails and the stored
 * session survives (api/cloud/supabase.ts, "Signed out, but the saved session
 * could not be removed"). That throw was swallowed and the store was flipped
 * to signed-out regardless, so the app said "signed out" while a valid refresh
 * token stayed in the OS vault — and the 5-minute probe signed the account
 * back in. On a shared or handed-over machine that is the whole account.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const signOut = vi.fn()
const getSession = vi.fn()

vi.mock('../../api/cloud/supabase', () => ({
  supabaseCloud: () => ({ auth: { signOut, getSession } }),
}))
vi.mock('../../api/cloud/jobs', () => ({ getMe: vi.fn(), getQuota: vi.fn() }))
vi.mock('../../stores/cloudCatalogStore', () => ({ refreshCatalog: vi.fn() }))
vi.mock('../../stores/providerStore', () => ({
  useProviderStore: { getState: () => ({ providers: {}, setProviderConfig: vi.fn() }) },
}))
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: { appMode: 'local' }, updateSettings: vi.fn() }) },
}))

import { signOutAccount } from '../useCloudAuth'
import { useCloudAuthStore } from '../../stores/cloudAuthStore'

const SESSION = { access_token: 'still-valid', refresh_token: 'r' }

function signedIn() {
  useCloudAuthStore
    .getState()
    .setSignedIn({ id: 'u1', email: 'a@b.c' }, { licenseActive: true, tier: 'hosted', access: true, quota: null })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), CustomEvent })
  signedIn()
})

describe('a sign-out that worked', () => {
  it('clears the account state', async () => {
    signOut.mockResolvedValue({ error: null })

    await expect(signOutAccount()).resolves.toBeUndefined()

    expect(useCloudAuthStore.getState().status).toBe('signed-out')
    expect(useCloudAuthStore.getState().user).toBeNull()
    // No reason to interrogate the storage when nothing went wrong.
    expect(getSession).not.toHaveBeenCalled()
  })
})

describe('a sign-out that did not happen', () => {
  it('reports the keychain failure instead of swallowing it', async () => {
    // Exactly what keychainStorage.removeItem throws when the OS vault is
    // there and the delete failed anyway (locked at wake, dismissed prompt).
    signOut.mockRejectedValue(new Error('Signed out, but the saved session could not be removed from the keychain.'))
    getSession.mockResolvedValue({ data: { session: SESSION }, error: null })

    await expect(signOutAccount()).rejects.toThrow(/still on this computer/)
  })

  it('does not claim the account is signed out while the token is still there', async () => {
    signOut.mockRejectedValue(new Error('The stub received bad data.'))
    getSession.mockResolvedValue({ data: { session: SESSION }, error: null })

    await signOutAccount().catch(() => {})

    // The panel must keep showing the account, because the account IS still
    // usable here. Saying "signed out" over a live session is what let the
    // next person at this machine spend the credits.
    expect(useCloudAuthStore.getState().status).toBe('signed-in')
    expect(useCloudAuthStore.getState().user?.id).toBe('u1')
  })

  it('treats an unreadable session as still there', async () => {
    signOut.mockRejectedValue(new Error('boom'))
    getSession.mockRejectedValue(new Error('keychain locked'))

    await expect(signOutAccount()).rejects.toThrow(/still on this computer/)
    expect(useCloudAuthStore.getState().status).toBe('signed-in')
  })
})

describe('a failure that still emptied this machine', () => {
  it('completes the sign-out when the tombstone landed', async () => {
    // removeItem could not delete the entry but did overwrite it, so getItem
    // reports the session as absent — this machine is clean.
    signOut.mockRejectedValue(new Error('Signed out, but the saved session could not be removed from the keychain.'))
    getSession.mockResolvedValue({ data: { session: null }, error: null })

    await expect(signOutAccount()).resolves.toBeUndefined()
    expect(useCloudAuthStore.getState().status).toBe('signed-out')
  })

  it('completes when only the server-side revoke failed', async () => {
    // supabase-js clears the local session before returning that error, so
    // there is nothing left here to sign anyone back in.
    signOut.mockResolvedValue({ error: { message: 'Failed to fetch' } })
    getSession.mockResolvedValue({ data: { session: null }, error: null })

    await expect(signOutAccount()).resolves.toBeUndefined()
    expect(useCloudAuthStore.getState().status).toBe('signed-out')
  })
})
