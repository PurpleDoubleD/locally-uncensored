// LU Cloud account panel (Settings → General). Signed out: inline
// email+password sign-in/sign-up. Signed in: email, tier, credits/token
// meters, manage-subscription (system browser), sign out. Enabling the cloud
// axis everywhere else (Create backend toggle, lu-cloud chat provider) hangs
// off the cloudAuthStore this panel drives via useCloudAuth.

import { useRef, useState } from 'react'
import { Loader2, LogOut, ExternalLink } from 'lucide-react'
import { useCloudAuth } from '../../hooks/useCloudAuth'
import { useCloudAuthStore } from '../../stores/cloudAuthStore'
import { loginWithProvider } from '../../api/cloud/supabase'
import { CLOUD_BASE } from '../../api/cloud/config'
import { MONOGRAM } from '../layout/brand'
import { openExternal } from '../../api/backend'

/**
 * Run a sign-out and report what happened, in that order.
 *
 * `signOutAccount` throws when the saved session survived the delete — and it
 * deliberately leaves the store SIGNED IN, because the account really is still
 * usable on this machine. That is the safe half. The visible half was missing:
 * the throw was dropped by `void logout()`, so the panel simply kept showing
 * the account and the click looked like it had done nothing. The user walks
 * away from a shared machine believing they are signed out.
 *
 * Exported so the contract can be asserted without a DOM — the panel itself is
 * a React tree and the suite runs in the `node` environment.
 */
export async function runSignOut(
  logout: () => Promise<void>,
  report: (message: string | null) => void,
): Promise<void> {
  report(null)
  try {
    await logout()
  } catch (err) {
    report(err instanceof Error ? err.message : String(err))
  }
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[0.65rem]">
        <span className="text-gray-600 dark:text-gray-400">{label}</span>
        <span className="text-gray-500 dark:text-gray-500 tabular-nums">
          {used.toLocaleString()} / {limit.toLocaleString()}
        </span>
      </div>
      <div className="h-1 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
        <div className="h-full rounded-full bg-gray-700 dark:bg-white/60" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// Same identities as lu-labs.ai/login — email+password inline, Google/GitHub
// via the system browser (PKCE loopback in loginWithProvider). The browser
// round-trip can hang on a closed tab, so a Cancel affordance aborts the wait
// and recovers the buttons instead of spinning out the full timeout.
function OAuthButtons({ onError }: { onError: (msg: string | null) => void }) {
  const { refresh } = useCloudAuth()
  const [waiting, setWaiting] = useState<'google' | 'github' | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const start = async (provider: 'google' | 'github') => {
    if (waiting) return
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setWaiting(provider)
    onError(null)
    try {
      await loginWithProvider(provider, ctrl.signal)
      await refresh()
    } catch (err) {
      if (!ctrl.signal.aborted) onError(err instanceof Error ? err.message : String(err))
    } finally {
      abortRef.current = null
      setWaiting(null)
    }
  }

  const btn =
    'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[0.7rem] font-medium border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 text-gray-800 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors disabled:opacity-40'

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button type="button" disabled={waiting !== null} onClick={() => void start('google')} className={btn}>
          {waiting === 'google' ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden>
              <path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l3.7 2.9c2.3-2.1 3.7-5.2 3.7-8.6z" />
              <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.2 1.2-3.2 0-6-2.1-6.9-5.1H1.2v3C3.2 21.3 7.3 24 12 24z" />
              <path fill="#FBBC05" d="M5.1 14.3c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3v-3H1.2C.4 8.3 0 10.1 0 12s.4 3.7 1.2 5.3l3.9-3z" />
              <path fill="#EA4335" d="M12 4.7c1.8 0 3 .8 3.7 1.4L19 3C17 1.1 14.7 0 12 0 7.3 0 3.2 2.7 1.2 6.7l3.9 3C6 6.8 8.8 4.7 12 4.7z" />
            </svg>
          )}
          Google
        </button>
        <button type="button" disabled={waiting !== null} onClick={() => void start('github')} className={btn}>
          {waiting === 'github' ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
          )}
          GitHub
        </button>
      </div>
      {waiting !== null && (
        <button
          type="button"
          onClick={() => abortRef.current?.abort()}
          className="text-[0.65rem] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
        >
          Waiting for the browser… Cancel
        </button>
      )}
    </div>
  )
}

export function AccountPanel() {
  const { status, login, signup, logout } = useCloudAuth()
  const user = useCloudAuthStore((s) => s.user)
  const licenseActive = useCloudAuthStore((s) => s.licenseActive)
  const quota = useCloudAuthStore((s) => s.quota)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)

  const onSignOut = async () => {
    if (signingOut) return
    setSigningOut(true)
    try {
      await runSignOut(logout, setSignOutError)
    } finally {
      setSigningOut(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || !email || !password) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'signin') await login(email, password)
      else await signup(email, password)
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (status === 'probing') {
    return (
      <div className="flex items-center gap-2 py-1 text-[0.7rem] text-gray-500">
        <Loader2 size={11} className="animate-spin" /> Checking account…
      </div>
    )
  }

  if (status === 'signed-out' || !user) {
    return (
      <form onSubmit={submit} className="space-y-2">
        <p className="text-[0.7rem] text-gray-600 dark:text-gray-400">
          Sign in to render images, video and chat on LU's cloud GPUs. Local features never need an account.
        </p>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          autoComplete="email"
          className="w-full px-2 py-1.5 rounded text-[0.7rem] bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-gray-900 dark:text-gray-100 placeholder-gray-400 outline-none focus:border-gray-400 dark:focus:border-white/30"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          className="w-full px-2 py-1.5 rounded text-[0.7rem] bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-gray-900 dark:text-gray-100 placeholder-gray-400 outline-none focus:border-gray-400 dark:focus:border-white/30"
        />
        {error && <p className="text-[0.65rem] text-red-500 dark:text-red-400">{error}</p>}
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={busy || !email || !password}
            className="lu-primary flex items-center gap-1.5 px-3 py-1.5 rounded text-[0.7rem] disabled:opacity-40 transition-colors"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : (
              /* Monogram, not the stock cloud glyph. Der Knopf traegt jetzt in
                 BEIDEN Modi die Akzentflaeche mit dunklem Text (.lu-primary),
                 also muss das Monogramm auch in beiden Modi dunkel sein —
                 vorher kippte es mit dem Modus, weil der Knopf das tat. */
              <img
                src={MONOGRAM}
                alt=""
                width={12}
                height={12}
                draggable={false}
                className="shrink-0 select-none invert"
              />
            )}
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
          <button
            type="button"
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null) }}
            className="text-[0.65rem] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            {mode === 'signin' ? 'No account yet? Sign up' : 'Have an account? Sign in'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-px bg-gray-200 dark:bg-white/10" />
          <span className="text-[0.6rem] text-gray-400 dark:text-gray-600">or continue with</span>
          <div className="flex-1 h-px bg-gray-200 dark:bg-white/10" />
        </div>
        <OAuthButtons onError={setError} />
      </form>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[0.7rem] text-gray-900 dark:text-gray-100">{user.email ?? user.id}</div>
          <div className="text-[0.65rem] text-gray-500">
            {licenseActive ? `Plan: ${quota?.tier ?? 'active'}` : 'No active plan'}
          </div>
        </div>
        <button
          onClick={() => void onSignOut()}
          disabled={signingOut}
          className="flex items-center gap-1 px-2 py-1 rounded text-[0.65rem] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors disabled:opacity-40"
        >
          {signingOut ? <Loader2 size={10} className="animate-spin" /> : <LogOut size={10} />} Sign out
        </button>
      </div>

      {/* A sign-out that did not happen has to say so HERE. The account is
          still shown above (the store stays signed-in on purpose), so without
          this line the failure is invisible and the panel reads like a
          sign-out that simply took no effect. */}
      {signOutError && (
        <p role="alert" className="text-[0.65rem] text-red-500 dark:text-red-400">
          {signOutError}
        </p>
      )}

      {licenseActive && quota ? (
        <div className="space-y-2">
          {/* One shared compute-credit wallet, chat, images, video and voice
              all draw from the same budget. It refills on the subscription's
              renewal date, not on the 1st (server migration 0027). */}
          <Meter
            label="Cloud credits (this billing period)"
            used={Number(quota.used.credits_used)}
            limit={quota.limits.credits}
          />
        </div>
      ) : (
        <p className="text-[0.7rem] text-gray-600 dark:text-gray-400">
          Pick a plan to unlock cloud rendering and chat.
        </p>
      )}

      <button
        onClick={() => void openExternal(`${CLOUD_BASE}/${licenseActive ? 'account' : 'pricing'}`)}
        className="flex items-center gap-1 text-[0.65rem] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
      >
        <ExternalLink size={10} /> {licenseActive ? 'Manage subscription' : 'View plans'} on lu-labs.ai
      </button>
    </div>
  )
}
