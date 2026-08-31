// Supabase auth client for the LU Cloud tier. Desktop authenticates directly
// against Supabase — email+password in-app, Google/GitHub via the system
// browser (PKCE + 127.0.0.1 loopback, see loginWithProvider) — and the
// resulting access token is sent as `Authorization: Bearer` to lu-labs.ai.
//
// Session storage: OS keychain via the existing Rust `secret_*` commands
// (Windows Credential Manager / macOS Keychain) — survives the NSIS-update
// WebView2 wipe and keeps refresh tokens out of localStorage. Linux and the
// browser dev build have no vault to use (secret.rs is a stub there) and fall
// back to localStorage under the same obfuscation providerStore gives API
// keys — see FALLBACK_MARKER for what that is and is not worth.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { secretGet, secretSet, secretDelete, oauthStart, oauthWait, openExternal } from '../backend'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config'

const SESSION_ACCOUNT = 'lu-cloud-session'
const LOCAL_KEY = 'lu-cloud-session'

// Keychain-first async storage adapter. Only a *permanent* keychain absence
// (web build, Linux stub) latches the adapter to localStorage — a transient
// failure (keychain locked at wake, dismissed unlock prompt, Credential
// Manager hiccup) falls back for that call only and retries the keychain on
// the next operation. Latching on a transient error would strand rotated
// refresh tokens in localStorage while the keychain keeps the rotated-out
// session, which kills the sign-in on the next launch.
let keychainBroken = false

function keychainMissing(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('keychain unavailable') || msg.includes('keychain unsupported')
}

// The PKCE flow stores TWO keys through this adapter: the session under the
// storageKey and the code verifier under `${storageKey}-code-verifier`. Map
// each supabase key to its own keychain account (suffix-preserving, so the
// pre-2.5.7 session account stays exactly SESSION_ACCOUNT) — a single fixed
// account would let the verifier write clobber the session.
function keychainAccount(key: string): string {
  return key.startsWith(LOCAL_KEY) ? SESSION_ACCOUNT + key.slice(LOCAL_KEY.length) : key
}

// Written over a keychain entry whose delete failed: the entry survives
// physically, but must never sign anyone back in. getItem reports it as absent.
const TOMBSTONE = '__lu_signed_out__'

// ── localStorage fallback encoding ──────────────────────────────────────
// Everything the keychain path does not take ends up here: Linux and the
// browser dev build have no OS vault at all (commands/secret.rs compiles to an
// "unsupported" stub there), and any keychain write that fails falls back for
// that one call. What lands is the Supabase session — a refresh token that is
// a full account bearer until it is revoked — and it used to be written
// verbatim, so on Linux it sat greppable in WebKitGTK's profile directory
// while providerStore's API keys on the very same platforms never do (those
// are stored reversed + base64). This closes that gap: same platforms, same
// treatment.
//
// It is obfuscation, NOT encryption. There is no key this app could hold that
// a reader of the profile directory could not take as well, so it only stops
// the token from being legible at a glance — a backup, a synced profile
// folder, a support screenshot, another process grepping for `eyJ`. The real
// store remains the OS vault, and a secret store for Linux is a Rust-side
// change, not one this adapter can make.
const FALLBACK_MARKER = 'lu.obf.1:'

function packFallback(value: string): string {
  try {
    return FALLBACK_MARKER + btoa(encodeURIComponent(value))
  } catch {
    // Dropping the session here would sign the user out on the next launch for
    // no reason at all, which is the worse failure of the two.
    return value
  }
}

function unpackFallback(stored: string): string {
  // No marker = written by a build before this encoding existed. Those must
  // keep working, or an update signs every Linux user out.
  if (!stored.startsWith(FALLBACK_MARKER)) return stored
  try {
    return decodeURIComponent(atob(stored.slice(FALLBACK_MARKER.length)))
  } catch {
    return stored
  }
}

function fallbackGet(key: string): string | null {
  const raw = localStorage.getItem(key)
  return raw === null ? null : unpackFallback(raw)
}

/** Exported for its unit tests — this adapter holds the refresh token, and the
 *  invariants in the comments above are worth asserting rather than trusting. */
export const keychainStorage = {
  async getItem(key: string): Promise<string | null> {
    let value: string | null = null
    if (!keychainBroken) {
      try {
        const fromKeychain = await secretGet(keychainAccount(key))
        // A localStorage copy only exists when a later write missed the
        // keychain (transient failure, keychain-less build) — when both
        // stores hold the key, localStorage is the newer one. A clean
        // keychain miss must also consult it, or a fallback-written session
        // is invisible on the next launch and the user is signed out.
        value = fallbackGet(key) ?? fromKeychain
      } catch (err) {
        if (keychainMissing(err)) keychainBroken = true
        value = fallbackGet(key)
      }
    } else {
      value = fallbackGet(key)
    }
    return value === TOMBSTONE ? null : value
  },
  async setItem(key: string, value: string): Promise<void> {
    if (!keychainBroken) {
      try {
        await secretSet(keychainAccount(key), value)
        // Drop any stale fallback copy so the two stores can't diverge and
        // no refresh token lingers in plaintext once the keychain works.
        localStorage.removeItem(key)
        return
      } catch (err) {
        if (keychainMissing(err)) keychainBroken = true
      }
    }
    localStorage.setItem(key, packFallback(value))
  },
  async removeItem(key: string): Promise<void> {
    // Always clear the fallback copy too — sign-out must never leave a
    // resurrectable session (or plaintext refresh token) in localStorage.
    localStorage.removeItem(key)
    if (keychainBroken) return

    const account = keychainAccount(key)
    try {
      await secretDelete(account)
      return
    } catch (err) {
      if (keychainMissing(err)) {
        keychainBroken = true
        return
      }
    }
    // The keychain is THERE and the delete failed anyway (locked at wake, a
    // dismissed unlock prompt, a Credential Manager hiccup) — so the refresh
    // token is still in it and the next launch would sign the user back in
    // after they explicitly signed out. This used to resolve silently, which
    // reported a sign-out that had not happened.
    //
    // Neutralise the surviving entry (best effort: a write may succeed where
    // the delete did not), then report the failure instead of swallowing it.
    try {
      await secretSet(account, TOMBSTONE)
    } catch {
      // Nothing left to try — the throw below is the only honest outcome.
    }
    throw new Error('Signed out, but the saved session could not be removed from the keychain.')
  },
}

let client: SupabaseClient | null = null

export function supabaseCloud(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: keychainStorage,
        storageKey: LOCAL_KEY,
        persistSession: true,
        // Timers are throttled while the app is minimized/asleep, so we do
        // NOT rely on background refresh — getAccessToken() refreshes lazily
        // via getSession() on every use instead.
        autoRefreshToken: true,
        detectSessionInUrl: false,
        // OAuth via the system browser needs PKCE — the browser only ever
        // sees the code, the verifier stays in the app (keychain adapter).
        flowType: 'pkce',
      },
    })
  }
  return client
}

/** Current access token, refreshing an expired session if needed. Null when
 *  logged out. Called per request — getSession() is cached in-memory and only
 *  hits the network when the token actually expired. A failed refresh with the
 *  session still in the keychain is a connectivity problem, not a sign-out —
 *  throw so callers don't tell a signed-in user to sign in. */
export async function getAccessToken(): Promise<string | null> {
  const { data, error } = await supabaseCloud().auth.getSession()
  if (!data.session && error) {
    throw new Error('LU Cloud unreachable. Check your connection.')
  }
  return data.session?.access_token ?? null
}

export type OAuthProvider = 'google' | 'github'

/** The loopback callback is the one place in sign-in where text from outside
 *  the app reaches the UI. commands/oauth.rs now only serves a genuine
 *  top-level callback navigation, so this text comes from the provider — but
 *  `error_description` is still free-form remote input, and an error line is
 *  no place for a screenful of it. Control characters out, 200 chars max. */
function providerErrorText(params: URLSearchParams): string {
  const raw = params.get('error_description') || params.get('error') || ''
  const clean = raw.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
  return clean || 'Sign-in was cancelled in the browser.'
}

/** Google/GitHub sign-in, same identities as lu-labs.ai. Flow: bind a
 *  127.0.0.1 loopback port (Rust, fixed ladder registered in the Supabase
 *  redirect allow-list) → open the provider consent in the SYSTEM browser →
 *  Supabase redirects to the loopback with ?code= → exchange the PKCE code
 *  for a session. Rejects with a readable message on timeout/denial, and
 *  immediately when `signal` aborts (Cancel while waiting for the browser) —
 *  the abandoned Rust wait cleans itself up, and any retry's oauth_start
 *  aborts the stale listener first, so cancelling never wedges the ladder. */
export async function loginWithProvider(provider: OAuthProvider, signal?: AbortSignal): Promise<void> {
  const port = await oauthStart()
  const { data, error } = await supabaseCloud().auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `http://127.0.0.1:${port}/callback`,
      skipBrowserRedirect: true,
    },
  })
  if (error) throw new Error(error.message)
  if (!data?.url) throw new Error('OAuth start failed, no provider URL')
  await openExternal(data.url)
  const wait = oauthWait(port, 300)
  const query = signal
    ? await Promise.race([
        wait,
        new Promise<never>((_, reject) => {
          const cancel = () => reject(new Error('Sign-in cancelled.'))
          if (signal.aborted) cancel()
          else signal.addEventListener('abort', cancel, { once: true })
        }),
      ])
    : await wait
  const params = new URLSearchParams(query)
  const code = params.get('code')
  if (!code) {
    throw new Error(providerErrorText(params))
  }
  const { error: exchangeError } = await supabaseCloud().auth.exchangeCodeForSession(code)
  if (exchangeError) throw new Error(exchangeError.message)
}
