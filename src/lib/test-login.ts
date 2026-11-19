/**
 * TEST-LOGIN (3.1.3): the page half of the test build's sign in with the
 * fixed test account (src-tauri/src/test_login.rs has the rest and the why).
 *
 * This module is only in a web bundle built with VITE_LU_TEST_LOGIN=1: the
 * one import of it (App.tsx) sits behind that compile time constant, which
 * Vite replaces, so every other bundle has neither the import nor this file.
 * scripts/check-no-test-login.sh fails a release that carries
 * TEST_LOGIN_MARKER.
 *
 * The one-time token is checked with a client that stores nothing. Only when
 * the account behind it is on the build's allow list does the app's own
 * client get the session; any other account is signed out on the server
 * again at once and the app stays signed out.
 */
import { backendCall } from '../api/backend'
import { log } from './logger'

export const TEST_LOGIN_MARKER = 'LU-TEST-LOGIN-ENTRANCE'

export interface TakenToken {
  tokenHash: string
  allow: string[]
}

export interface VerifiedSession {
  email: string | null
  accessToken: string
  refreshToken: string
}

export interface TestLoginDeps {
  take: () => Promise<TakenToken | null>
  /** Check the token with a client that keeps no session. */
  verify: (tokenHash: string) => Promise<VerifiedSession>
  /** Give the session to the app's own client. */
  adopt: (s: VerifiedSession) => Promise<void>
  /** End a session that is not let in, on the server. */
  revoke: (s: VerifiedSession) => Promise<void>
}

export type TestLoginOutcome = 'none' | 'signed-in' | 'refused' | 'failed'

export function isAllowed(email: string | null, allow: readonly string[]): boolean {
  const e = (email ?? '').trim().toLowerCase()
  return !!e && allow.map((a) => a.trim().toLowerCase()).includes(e)
}

export async function runTestLogin(deps?: TestLoginDeps): Promise<TestLoginOutcome> {
  const d = deps ?? (await realDeps())
  let taken: TakenToken | null
  try {
    taken = await d.take()
  } catch {
    return 'none'
  }
  if (!taken?.tokenHash) return 'none'
  let session: VerifiedSession
  try {
    session = await d.verify(taken.tokenHash)
  } catch (err) {
    log.warn('test_login.verify_failed', { err: err instanceof Error ? err.message : String(err) })
    return 'failed'
  }
  if (!isAllowed(session.email, taken.allow)) {
    log.warn('test_login.refused', { reason: 'account not on the allow list' })
    await d.revoke(session).catch(() => {})
    return 'refused'
  }
  await d.adopt(session)
  log.info('test_login.signed_in', {})
  return 'signed-in'
}

async function realDeps(): Promise<TestLoginDeps> {
  const { createClient } = await import('@supabase/supabase-js')
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import('../api/cloud/config')
  const { supabaseCloud } = await import('../api/cloud/supabase')
  const probe = () => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return {
    take: () => backendCall<TakenToken | null>('test_login_take'),
    verify: async (tokenHash) => {
      const { data, error } = await probe().auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })
      if (error || !data.session) throw new Error(error?.message ?? 'no session came back')
      return {
        email: data.session.user?.email ?? null,
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
      }
    },
    adopt: async (s) => {
      const { error } = await supabaseCloud().auth.setSession({ access_token: s.accessToken, refresh_token: s.refreshToken })
      if (error) throw error
    },
    revoke: async (s) => {
      const c = probe()
      await c.auth.setSession({ access_token: s.accessToken, refresh_token: s.refreshToken })
      await c.auth.signOut({ scope: 'global' })
    },
  }
}
