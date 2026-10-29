/**
 * Strand 5 (Account, cloud, settings) of the mobile shell, in a browser
 * without Tauri and against a MOCKED backend.
 *
 * Nothing in here reaches a real server: every request to the auth server,
 * to LU Cloud and to a model provider is answered by `mockBackend` below,
 * and a request to any other outside host fails the test. No real account
 * and no real password is used; the credentials are made up.
 *
 * Covered in two phone sizes (390x844 and 320x568): every page opens, every
 * switch and choice is flipped and survives a reload, sign in, sign out and
 * register with their error cases, the way back from the browser through the
 * deep link seam, empty credits, an expired session, a provider key (save,
 * test, delete, never shown), backup, restore, import and "delete all".
 *
 * Screenshots: LU_SETTINGS_SHOTS=1 npx playwright test --project=mobile settings
 * writes mobile-docs/design/strang-shots/settings/<variant>--<view>.png.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page, type Route } from '@playwright/test'
import { SIZES, declareAdult, measureLayout, openShell, screensLoaded, shellUrl, watchErrors } from './support'
import { phoneVersion } from '../../src/dev/phone-version'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.resolve(HERE, '../../mobile-docs/design/strang-shots/settings')

const AUTH = 'https://lrrhheztdytyfpizvuup.supabase.co'
const CLOUD = 'https://lu-labs.ai'
const EMAIL = 'tester@example.com'
// Made up for the mock. Not a password of any account.
const PASSWORD = 'mock-only-passphrase'
const CLEAN = { overflow: [], small: [], pageScrolls: false }

interface Backend {
  password: 'ok' | 'wrong' | 'unconfirmed'
  signup: 'confirm' | 'session' | 'exists'
  plan: 'active' | 'none' | 'past-due'
  credits: { limit: number; used: number }
  /** The server no longer knows the session: /api/me answers 401. */
  sessionDead: boolean
  policy: 'strict' | 'soft' | 'off'
  policyPutFails: boolean
  /** GET /api/account/content-policy answers 500. */
  policyGetFails: boolean
  /** LU Cloud cannot be reached at all: every request to it fails on the network. */
  cloudDown: boolean
  tts: 'ok' | 'no-credits'
  /** POST /api/account/delete answers 502. */
  deleteFails: boolean
  /** POST /api/account/delete answers 401: the server no longer takes the session. */
  deleteExpired: boolean
  /** What the auth server answers to "send me a reset link". */
  recover: 'ok' | 'too-many'
  /** What the auth server answers to a new password. */
  newPassword: 'ok' | 'same'
  /** How often a new password was accepted. The password itself is never kept. */
  passwordChanges: number
  /** /api/me, the content policy and the voice preview answer this much later, so that a loading line can be seen. */
  slowMs: number
  /** POST /auth/v1/logout fails on the network. */
  logoutDown: boolean
  /** The mock deleted the account. */
  deleted: boolean
  /** What a provider answers to its model list. */
  provider: 'ok' | 'bad-key' | 'down'
  /** 'not-set-up': the auth server does not know the provider Apple. */
  apple: 'ok' | 'not-set-up'
  /** Every identity token of Apple the auth server was handed: the nonce next to it and the nonce inside it. */
  appleSeen: Array<{ provider: string; nonce: string; tokenNonce: string }>
  /** How the session was made: a password, or Sign in with Apple (then the user carries an Apple identity). */
  via: 'email' | 'apple'
  /** What POST /api/account/apple-token answers (round 32): kept, not kept (no Apple keys on the server), or no network. */
  appleToken: 'stored' | 'not-stored' | 'down'
  /** Every authorization code handed to /api/account/apple-token. */
  appleCodes: string[]
  /** Every request that was answered, as "METHOD host/path". */
  calls: string[]
  /** Authorization headers the provider mocks saw. */
  providerAuth: string[]
}

function freshBackend(over: Partial<Backend> = {}): Backend {
  return {
    password: 'ok',
    signup: 'confirm',
    plan: 'active',
    credits: { limit: 1000, used: 250 },
    sessionDead: false,
    policy: 'soft',
    policyPutFails: false,
    policyGetFails: false,
    cloudDown: false,
    tts: 'ok',
    deleteFails: false,
    deleteExpired: false,
    recover: 'ok',
    newPassword: 'ok',
    passwordChanges: 0,
    slowMs: 0,
    logoutDown: false,
    deleted: false,
    provider: 'ok',
    apple: 'ok',
    appleSeen: [],
    via: 'email',
    appleToken: 'stored',
    appleCodes: [],
    calls: [],
    providerAuth: [],
    ...over,
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-expose-headers': '*',
}

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/** A session as the auth server would hand it out. The token is a dummy with the shape of a JWT. */
function mockSession(email: string, via: 'email' | 'apple' = 'email') {
  const now = Math.floor(Date.now() / 1000)
  const user = {
    id: '00000000-0000-4000-8000-000000000001',
    aud: 'authenticated',
    role: 'authenticated',
    email,
    app_metadata: via === 'apple' ? { provider: 'apple', providers: ['apple'] } : { provider: 'email' },
    user_metadata: {},
    ...(via === 'apple' ? { identities: [{ id: '001234.apple', provider: 'apple', identity_data: { sub: '001234.apple' } }] } : {}),
    created_at: new Date(0).toISOString(),
  }
  return {
    access_token: `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: user.id, email, exp: now + 3600, role: 'authenticated' })}.mock`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: 'mock-refresh-token',
    user,
  }
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** A tiny valid WAV, for the voice preview. */
function silentWav(): Buffer {
  const samples = 800
  const buf = Buffer.alloc(44 + samples * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(8000, 24)
  buf.writeUInt32LE(16000, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples * 2, 40)
  return buf
}

async function mockBackend(page: Page, backend: Backend): Promise<void> {
  // Links to the system browser: recorded, never opened.
  await page.addInitScript(() => {
    // Every load starts with a fresh stack, so a page opened by address is on screen once.
    try {
      localStorage.removeItem('lu-mobile-nav')
    } catch {
      /* storage blocked: nothing to clear */
    }
    const opened: string[] = []
    ;(window as unknown as { __opened: string[] }).__opened = opened
    window.open = (url?: string | URL) => {
      opened.push(String(url))
      return null
    }
    // The share sheet of a desktop browser cannot be driven: take the download path of the platform seam.
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true })
  })

  await page.route(
    (url) => url.origin === AUTH,
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
      backend.calls.push(`${request.method()} auth${url.pathname}${url.search}`)
      const body = (() => {
        try {
          return request.postDataJSON() as Record<string, unknown>
        } catch {
          return {}
        }
      })()
      if (url.pathname === '/auth/v1/token') {
        const grant = url.searchParams.get('grant_type')
        if (grant === 'password') {
          if (backend.password === 'wrong' || body.password !== PASSWORD) return json(route, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' })
          if (backend.password === 'unconfirmed') return json(route, 400, { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' })
          backend.via = 'email'
          return json(route, 200, mockSession(String(body.email)))
        }
        if (grant === 'pkce') {
          if (body.auth_code !== 'mock-oauth-code' || !body.code_verifier) return json(route, 400, { code: 400, error_code: 'bad_code_verifier', msg: 'bad code' })
          return json(route, 200, mockSession(EMAIL))
        }
        if (grant === 'id_token') {
          // What the auth server does with a token of Apple: the nonce inside it is the SHA-256 of the nonce next to it.
          const token = String(body.id_token ?? '')
          const claims = (() => {
            try {
              return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { nonce?: string }
            } catch {
              return {}
            }
          })()
          const nonce = String(body.nonce ?? '')
          backend.appleSeen.push({ provider: String(body.provider), nonce, tokenNonce: String(claims.nonce ?? '') })
          if (backend.apple === 'not-set-up') return json(route, 400, { code: 400, error_code: 'provider_disabled', msg: 'Provider (issuer "https://appleid.apple.com") is not enabled' })
          if (body.provider !== 'apple' || !nonce || claims.nonce !== createHash('sha256').update(nonce).digest('hex')) return json(route, 400, { code: 400, error_code: 'bad_jwt', msg: 'Nonces mismatch' })
          backend.via = 'apple'
          return json(route, 200, mockSession(EMAIL, 'apple'))
        }
        if (grant === 'refresh_token') {
          if (backend.sessionDead) return json(route, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' })
          return json(route, 200, mockSession(EMAIL, backend.via))
        }
      }
      if (url.pathname === '/auth/v1/signup') {
        if (backend.signup === 'exists') return json(route, 422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' })
        if (backend.signup === 'session') return json(route, 200, mockSession(String(body.email)))
        return json(route, 200, { ...mockSession(String(body.email)).user, confirmation_sent_at: new Date().toISOString() })
      }
      if (url.pathname === '/auth/v1/logout') return backend.logoutDown ? route.abort('connectionrefused') : route.fulfill({ status: 204, headers: CORS })
      if (url.pathname === '/auth/v1/recover') {
        if (backend.recover === 'too-many') return json(route, 429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'For security purposes, you can only request this after 52 seconds.' })
        // The same answer for an address with an account and for one without.
        return json(route, 200, {})
      }
      if (url.pathname === '/auth/v1/user' && request.method() === 'PUT') {
        if (backend.newPassword === 'same') return json(route, 422, { code: 422, error_code: 'same_password', msg: 'New password should be different from the old password.' })
        backend.passwordChanges += 1
        return json(route, 200, mockSession(EMAIL).user)
      }
      if (url.pathname === '/auth/v1/user') return json(route, 200, mockSession(EMAIL).user)
      return json(route, 404, { msg: 'not mocked' })
    },
  )

  await page.route(
    (url) => url.origin === CLOUD,
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
      backend.calls.push(`${request.method()} cloud${url.pathname}`)
      if (backend.cloudDown) return route.abort('internetdisconnected')
      const signedIn = (request.headers().authorization ?? '').startsWith('Bearer ')
      if (backend.slowMs > 0 && (url.pathname === '/api/me' || url.pathname === '/api/account/content-policy' || url.pathname === '/api/voice/tts')) await new Promise((done) => setTimeout(done, backend.slowMs))
      if (url.pathname === '/api/me') {
        if (!signedIn) return json(route, 200, { user: null, license: null })
        if (backend.deleted) return json(route, 401, { error: 'unauthorized' })
        if (backend.sessionDead) return json(route, 401, { error: 'unauthorized' })
        const license =
          backend.plan === 'active'
            ? { status: 'active', tier: 'hosted', access: true, paidPlan: true }
            : backend.plan === 'past-due'
              ? { status: 'past_due', tier: 'hosted', access: true, paidPlan: false, pastDue: true, pastDueTier: 'hosted' }
              : null
        return json(route, 200, { user: { id: 'user-1', email: EMAIL }, license })
      }
      if (url.pathname === '/api/jobs/quota') {
        const { limit, used } = backend.credits
        return json(route, 200, { tier: 'hosted', period: '2026-10', limits: { credits: limit }, costs: { image: 1, video: 10 }, used: { credits_used: used }, remaining: { credits: Math.max(0, limit - used) } })
      }
      if (url.pathname === '/api/account/content-policy') {
        if (request.method() === 'PUT') {
          if (backend.policyPutFails) return json(route, 500, { error: 'boom' })
          const wanted = (request.postDataJSON() as { policy: Backend['policy'] }).policy
          backend.policy = wanted
          return json(route, 200, { policy: wanted })
        }
        if (backend.policyGetFails) return json(route, 500, { error: 'boom' })
        return json(route, 200, { policy: backend.policy, ageConfirmedAt: null, ageConfirmationRequired: true })
      }
      if (url.pathname === '/api/voice/tts') {
        if (backend.tts === 'no-credits') return json(route, 429, { error: 'out of credits', code: 'credits_exhausted' })
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'audio/wav' }, body: silentWav() })
      }
      // The form of the website (feat/web-307-store): { authorization_code } with the bearer, { ok, stored } back.
      if (url.pathname === '/api/account/apple-token' && request.method() === 'POST') {
        if (!signedIn) return json(route, 401, { error: 'unauthorized' })
        const body = request.postDataJSON() as { authorization_code?: unknown }
        if (typeof body?.authorization_code !== 'string' || !body.authorization_code) return json(route, 400, { error: 'send exactly one of authorization_code or provider_refresh_token' })
        backend.appleCodes.push(body.authorization_code)
        if (backend.via !== 'apple') return json(route, 409, { error: 'this account has no Apple sign in' })
        if (backend.appleToken === 'down') return route.abort('connectionrefused')
        return json(route, 200, { ok: true, stored: backend.appleToken === 'stored' })
      }
      if (url.pathname === '/api/account/delete' && request.method() === 'POST') {
        if (!signedIn) return json(route, 401, { error: 'unauthorized' })
        if (backend.deleteExpired) return json(route, 401, { error: 'unauthorized' })
        if (backend.deleteFails) return json(route, 502, { error: 'Could not delete account.' })
        backend.deleted = true
        return json(route, 200, { ok: true })
      }
      if (url.pathname === '/api/funnel/switch') return route.fulfill({ status: 204, headers: CORS })
      if (url.pathname === '/api/jobs/catalog') return json(route, 200, { models: [] })
      if (url.pathname.startsWith('/api/inference/')) return json(route, 200, { data: [] })
      return json(route, 404, { error: 'not mocked' })
    },
  )

  // Providers the user brings a key for.
  await page.route(
    (url) => url.hostname === 'api.groq.com' || url.hostname === 'api.anthropic.com',
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
      backend.calls.push(`${request.method()} ${url.hostname}${url.pathname}`)
      backend.providerAuth.push(request.headers().authorization ?? request.headers()['x-api-key'] ?? '')
      if (backend.provider === 'down') return route.abort('connectionrefused')
      if (backend.provider === 'bad-key') return json(route, 401, { error: { message: 'Invalid API Key', type: 'invalid_request_error' } })
      if (url.hostname === 'api.anthropic.com') return json(route, 200, { id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }], model: 'x', stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 1 } })
      return json(route, 200, { object: 'list', data: [{ id: 'model-a', object: 'model' }, { id: 'model-b', object: 'model' }, { id: 'model-c', object: 'model' }] })
    },
  )

  // Anything else that leaves the dev server is a hole in the mock.
  await page.route(
    (url) => !['localhost', '127.0.0.1'].includes(url.hostname) && url.origin !== AUTH && url.origin !== CLOUD && !['api.groq.com', 'api.anthropic.com'].includes(url.hostname) && url.protocol.startsWith('http'),
    async (route) => {
      backend.calls.push(`UNMOCKED ${route.request().url()}`)
      await route.abort('blockedbyclient')
    },
  )
}

const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)

/** Measure once a tap has let go: a pressed button is drawn a little smaller for a moment. */
async function layout(page: Page) {
  await screensLoaded(page)
  await page.waitForTimeout(250)
  return measureLayout(page)
}

async function expectClean(page: Page): Promise<void> {
  expect(await layout(page)).toEqual(CLEAN)
}

/** Sign in through the form, against the mock. */
/**
 * The note after "Save key" slides in over the lower buttons of the page, and a tap on a toast
 * takes it away. A tap on "Test connection" in those first frames lands on the note instead of
 * the button: Playwright looks what is under the finger, then the note arrives, then the touch
 * does. Under load that lost 3 runs in 10, with the page left idle and no result. Somebody who
 * uses the app sees the note and taps it away or waits; the test does the same before it goes on.
 */
/**
 * Everything a finger can press on the page on top that the toast lies on. Re-check Android 8 GB, A-22 a: the three
 * controls this used to name were free, and the note lay on a fourth. A control counts with the part of it that is in
 * sight (what has scrolled under the header is not there).
 */
async function controlsUnderToast(page: Page, toastId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const toast = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect()
    const app = document.querySelector('.m-app')
    if (!toast || !app) return ['no toast']
    const frame = app.getBoundingClientRect()
    const out: string[] = []
    app.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="switch"], [role="tab"], [role="radio"], [role="checkbox"], [role="slider"]').forEach((el) => {
      if (el.closest('.m-toast-layer, [data-m-hidden], [data-m-exit], [aria-hidden="true"], [inert]')) return
      const r = el.getBoundingClientRect()
      const view = el.closest('.m-body')?.getBoundingClientRect() ?? frame
      const top = Math.max(r.top, view.top)
      const bottom = Math.min(r.bottom, view.bottom)
      if (r.width <= 0 || bottom <= top) return
      if (toast.left < r.right && toast.right > r.left && toast.top < bottom && toast.bottom > top) out.push(el.getAttribute('data-testid') ?? el.tagName)
    })
    return out
  }, toastId)
}

async function keySavedNoteAway(page: Page): Promise<void> {
  const note = page.getByTestId('m-toast-provider-key-saved')
  await expect(note).toBeVisible()
  // Round 5: the kit puts the note where it covers nothing to press. The buttons somebody needs
  // right after saving are free, so a quick tap on "Test connection" reaches the button.
  expect(await controlsUnderToast(page, 'm-toast-provider-key-saved')).toEqual([])
  // It may leave on its own in that very moment, which is just as good.
  await note.tap({ timeout: 2000 }).catch(() => {})
  await expect(note).toHaveCount(0)
}

async function signIn(page: Page): Promise<void> {
  await expect(page.getByTestId('m-account-screen')).toBeVisible()
  await page.getByTestId('m-account-email').fill(EMAIL)
  await page.getByTestId('m-account-password').fill(PASSWORD)
  await page.getByTestId('m-account-signin').tap()
  await expect(page.getByTestId('m-account-signedin')).toBeVisible()
}

async function openSignedIn(page: Page, route: string): Promise<void> {
  await openShell(page, { route: '/settings/account' })
  await signIn(page)
  await openShell(page, { route })
}

/** The Settings tab root. A tab root cannot be opened by address, so the tab bar is used. */
async function openSettingsRoot(page: Page): Promise<void> {
  await openShell(page)
  await page.getByTestId('m-page-back').tap()
  await page.getByTestId('m-nav-settings').tap()
  await expect(page.getByTestId('m-settings-screen')).toBeVisible()
  await screensLoaded(page)
}

/** Open a page in the build of one store preset (the developer switch ?store=, dev builds only). */
async function openInStore(page: Page, store: 'open' | 'play' | 'appstore', route: string): Promise<void> {
  // The presets of the two stores ask for the age before anything else (policy/AgeGate); answered once, as an adult.
  if (store !== 'open') await declareAdult(page)
  await page.goto(`${shellUrl({ route })}&store=${store}`)
  await page.getByTestId('m-app').waitFor()
  await screensLoaded(page)
}

const persisted = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key)

/** Errors a mocked failure is expected to print (the browser logs every failed request). */
function unexpected(errors: string[]): string[] {
  return errors.filter((line) => !/Failed to load resource|net::ERR_|status of 4\d\d|status of 5\d\d/.test(line))
}

const SAMPLE_BACKUP = JSON.stringify({
  app: 'locally-uncensored',
  kind: 'chat-export',
  version: 1,
  exportedAt: 1,
  count: 2,
  conversations: [
    { id: 'backup-1', title: 'Trip plan', messages: [{ id: 'm1', role: 'user', content: 'Where to?', timestamp: 1 }], model: 'm', systemPrompt: '', createdAt: 1, updatedAt: 2 },
    { id: 'backup-2', title: 'Recipe', messages: [{ id: 'm2', role: 'user', content: 'Soup', timestamp: 1 }], model: 'm', systemPrompt: '', createdAt: 1, updatedAt: 3 },
  ],
})

const SAMPLE_CHATGPT_EXPORT = JSON.stringify([
  {
    title: 'Holiday ideas',
    create_time: 1767225600,
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['a'] },
      a: { id: 'a', parent: 'root', children: ['b'], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Where should I go in spring?'] } } },
      b: { id: 'b', parent: 'a', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Lisbon is warm in spring.'] } } },
    },
  },
  {
    title: 'Bread',
    create_time: 1767312000,
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['a'] },
      a: { id: 'a', parent: 'root', children: [], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['How long does sourdough take?'] } } },
    },
  },
])

async function pickFile(page: Page, trigger: string, name: string, content: string | Buffer, mime = 'application/json'): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId(trigger).tap()
  await (await chooser).setFiles({ name, mimeType: mime, buffer: typeof content === 'string' ? Buffer.from(content) : content })
}

/**
 * The voice of the phone as the WebView offers it, made up for the test: `names` are its voices (the first is the
 * default), `null` takes speechSynthesis away like the Android System WebView. What was spoken lands in `__spoken`.
 */
async function fakePhoneVoice(page: Page, names: string[] | null): Promise<void> {
  await page.addInitScript((list) => {
    const w = window as unknown as { __spoken: Array<{ text: string; voice: string | null; rate: number; pitch: number }> }
    w.__spoken = []
    if (!list) {
      Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true })
      return
    }
    const voices = list.map((name, i) => ({ name, lang: name.includes('(de)') ? 'de-DE' : 'en-US', default: i === 0, voiceURI: name, localService: true }))
    const fake = {
      getVoices: () => voices,
      cancel() {},
      speak(u: SpeechSynthesisUtterance) {
        w.__spoken.push({ text: u.text, voice: u.voice ? u.voice.name : null, rate: u.rate, pitch: u.pitch })
        setTimeout(() => u.onend?.(new Event('end') as SpeechSynthesisEvent), 30)
      },
    }
    Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true })
    // The real class refuses a voice object it did not make itself.
    ;(window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
      text: string
      voice: unknown = null
      rate = 1
      pitch = 1
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(text: string) {
        this.text = text
      }
    }
  }, names)
}

const spoken = (page: Page) => page.evaluate(() => (window as unknown as { __spoken: Array<{ text: string; voice: string | null; rate: number; pitch: number }> }).__spoken)

const chatCount = (page: Page) =>
  page.evaluate(async () => {
    const { useChatStore } = ((await import(/* @vite-ignore */ '/src/stores/chatStore.ts' as string)) as typeof import('../../src/stores/chatStore'))
    return useChatStore.getState().conversations.length
  })

for (const size of SIZES) {
  test.describe(`settings ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    test('the Settings root lists every group and every row opens its page', async ({ page }) => {
      const backend = freshBackend()
      await mockBackend(page, backend)
      const errors = watchErrors(page)
      await openSettingsRoot(page)
      await expectClean(page)
      await expect(page.getByTestId('m-settings-account')).toContainText('Sign in to LU Cloud')

      const rows: Array<[string, string]> = [
        ['m-settings-account', 'm-account-screen'],
        ['m-settings-theme', 'm-settings-appearance-screen'],
        ['m-settings-chat', 'm-settings-chat-screen'],
        ['m-settings-personas', 'm-settings-personas-screen'],
        ['m-settings-memory', 'm-settings-memory-screen'],
        ['m-settings-voice', 'm-settings-voice-screen'],
        ['m-settings-agent', 'm-settings-agent-screen'],
        ['m-settings-search', 'm-settings-search-screen'],
        ['m-settings-workflows', 'm-settings-workflows-screen'],
        ['m-settings-engine', 'm-settings-engine-screen'],
        ['m-settings-providers', 'm-settings-providers-screen'],
        ['m-settings-remote', 'm-settings-remote-screen'],
        ['m-settings-storage', 'm-settings-storage-screen'],
        ['m-settings-data', 'm-settings-data-screen'],
        ['m-settings-privacy', 'm-settings-privacy-screen'],
        ['m-settings-content-policy', 'm-settings-content-policy-screen'],
        ['m-settings-troubleshooting', 'm-settings-troubleshooting-screen'],
        ['m-settings-about', 'm-settings-about-screen'],
      ]
      for (const [row, screen] of rows) {
        await page.getByTestId(row).tap()
        await expect(page.getByTestId(screen), row).toBeVisible()
        // Pages of this strand must be clean; the pages of other strands are theirs to measure.
        if (!/personas|memory|agent|search|workflows|engine|storage/.test(screen)) {
          await screensLoaded(page)
          expect(await layout(page), screen).toEqual(CLEAN)
        }
        await page.getByTestId('m-page-back').last().tap()
        await expect(page.getByTestId('m-settings-screen')).toBeVisible()
        await expect(page.getByTestId(screen)).toHaveCount(0)
      }
      expect(unexpected(errors())).toEqual([])
      expect(backend.calls.filter((c) => c.startsWith('UNMOCKED'))).toEqual([])
    })

    test('Appearance: theme, picture and the Cloud features switch act at once and survive a reload', async ({ page }) => {
      await mockBackend(page, freshBackend())
      await openShell(page, { route: '/settings/appearance' })
      await expectClean(page)
      await expect(page.getByTestId('m-settings-appearance-text-size')).toHaveText('Text size follows your phone settings.')

      await page.getByTestId('m-settings-appearance-theme-light').tap()
      await expect(page.locator('html')).toHaveClass(/light/)
      expect(await persisted(page, 'lu-mobile-theme')).toBe('light')
      await page.getByTestId('m-settings-appearance-theme-dark').tap()
      await expect(page.locator('html')).not.toHaveClass(/light/)

      // Switching Cloud features off says once where to find the switch again.
      const teasers = page.getByTestId('m-settings-appearance-cloud-teasers')
      await expect(teasers).toHaveAttribute('aria-checked', 'true')
      await teasers.tap()
      await expect(teasers).toHaveAttribute('aria-checked', 'false')
      await expect(page.getByTestId('m-settings-appearance-teasers-hint')).toBeVisible()
      await expectClean(page)

      // A profile picture from the library.
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAr7pYQ8AAAAASUVORK5CYII=', 'base64')
      await pickFile(page, 'm-settings-appearance-picture-choose', 'me.png', png, 'image/png')
      await expect(page.getByTestId('m-settings-appearance-picture')).toHaveAttribute('data-has', 'yes')
      await expect(page.getByTestId('m-settings-appearance-picture-remove')).toBeVisible()

      await openShell(page, { route: '/settings/appearance' })
      await expect(page.locator('html')).not.toHaveClass(/light/)
      await expect(page.getByTestId('m-settings-appearance-theme-dark')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('m-settings-appearance-cloud-teasers')).toHaveAttribute('aria-checked', 'false')
      await expect(page.getByTestId('m-settings-appearance-picture')).toHaveAttribute('data-has', 'yes')
      // The hint was a one time thing.
      await page.getByTestId('m-settings-appearance-cloud-teasers').tap()
      await page.getByTestId('m-settings-appearance-cloud-teasers').tap()
      await expect(page.getByTestId('m-settings-appearance-teasers-hint')).toHaveCount(0)

      await page.getByTestId('m-settings-appearance-picture-remove').tap()
      await expect(page.getByTestId('m-settings-appearance-picture')).toHaveAttribute('data-has', 'no')
      await page.getByTestId('m-settings-appearance-theme-system').tap()
      expect(await persisted(page, 'lu-mobile-theme')).toBe('system')
      // The root shows the choice.
      await openSettingsRoot(page)
      await expect(page.getByTestId('m-settings-theme')).toContainText('System')
    })

    test('Chat defaults: every control saves at once, survives a reload and resets after a question', async ({ page }) => {
      await mockBackend(page, freshBackend())
      await openShell(page, { route: '/settings/chat' })
      await expectClean(page)

      await page.getByRole('button', { name: 'Increase Temperature' }).tap()
      await page.getByRole('button', { name: 'Decrease Top P' }).tap()
      await page.getByRole('button', { name: 'Increase Top K' }).tap()
      await page.getByRole('button', { name: 'Increase Max length' }).tap()
      await page.getByRole('button', { name: 'Increase Compact automatically at' }).tap()
      await expect(page.getByTestId('m-settings-chat-compact-value')).toHaveText('5%')

      const stored = async () => {
        const raw = await page.evaluate(async () => {
          const { useSettingsStore } = ((await import(/* @vite-ignore */ '/src/stores/settingsStore.ts' as string)) as typeof import('../../src/stores/settingsStore'))
          const s = useSettingsStore.getState().settings
          return { temperature: s.temperature, topP: s.topP, topK: s.topK, maxTokens: s.maxTokens, compact: s.autoCompactThreshold }
        })
        return raw
      }
      expect(await stored()).toEqual({ temperature: 0.8, topP: 0.85, topK: 41, maxTokens: 256, compact: 0.05 })

      await openShell(page, { route: '/settings/chat' })
      expect(await stored()).toEqual({ temperature: 0.8, topP: 0.85, topK: 41, maxTokens: 256, compact: 0.05 })
      await expect(page.getByTestId('m-settings-chat-temperature')).toHaveValue('0.8')
      // N9: reading aloud is switched in ONE place, Voice. Here the row shows the state and leads there, signed out too.
      const readRow = page.getByTestId('m-settings-chat-read-aloud')
      await expect(readRow).toBeEnabled()
      await expect(readRow).toContainText('Off')
      await expect(readRow).toContainText('Switched under Voice')
      await expect(readRow.getByRole('switch')).toHaveCount(0)
      await readRow.tap()
      await expect(page.getByTestId('m-settings-voice-auto')).toBeVisible()
      await page.getByTestId('m-page-back').last().tap()
      await expect(page.getByTestId('m-settings-chat-temperature')).toBeVisible()

      // "Keep" leaves everything, "Reset" puts the defaults back.
      await page.getByTestId('m-settings-chat-reset').tap()
      await expect(page.getByTestId('m-dialog-chat-defaults-reset')).toBeVisible()
      await page.getByTestId('m-dialog-cancel').tap()
      expect((await stored()).temperature).toBe(0.8)
      await page.getByTestId('m-settings-chat-reset').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-toast-chat-defaults-reset')).toBeVisible()
      expect(await stored()).toEqual({ temperature: 0.7, topP: 0.9, topK: 40, maxTokens: 0, compact: 0 })
      await expect(page.getByTestId('m-settings-chat-compact-value')).toHaveText('Off')
      // N3: the overview says what the number is.
      await openSettingsRoot(page)
      await expect(page.getByTestId('m-settings-chat')).toContainText('Temperature 0.7')
      await expectClean(page)
    })

    test('Voice: signed out it says so, signed in the voice, the switches and the preview work and survive a reload', async ({ page }) => {
      const backend = freshBackend()
      await mockBackend(page, backend)
      await fakePhoneVoice(page, ['Samantha', 'Daniel', 'Anna (de)'])
      await openShell(page, { route: '/settings/voice' })
      await expect(page.getByTestId('m-settings-voice-state')).toHaveAttribute('data-state', 'signed-out')
      // The phone has a voice: the notice asks for a sign in for what needs one, and says that reading aloud does not.
      await expect(page.getByTestId('m-settings-voice-signed-out')).toContainText('Sign in for dictation and Cloud voices')
      await expect(page.getByTestId('m-settings-voice-signed-out')).toContainText('The voice of this phone reads answers without an account.')
      await expect(page.getByTestId('m-settings-voice-intro')).toContainText('Reading aloud works with the voice of this phone')
      await expect(page.getByTestId('m-settings-voice-cost')).toHaveText('Dictation and Cloud voice use credits. A fixed amount per request.')
      await expect(page.getByTestId('m-settings-voice-test')).toBeDisabled()
      await expect(page.getByTestId('m-settings-voice-preview-Wise_Woman')).toBeDisabled()
      await expectClean(page)

      await page.getByTestId('m-settings-voice-signin').tap()
      await signIn(page)
      await openShell(page, { route: '/settings/voice' })
      await expect(page.getByTestId('m-settings-voice-state')).toHaveAttribute('data-state', 'ready')
      await expect(page.getByTestId('m-settings-voice-dictation')).toContainText('Ready')
      await expectClean(page)

      // Read aloud on, then by itself; switching read aloud off takes "by itself" with it.
      const readAloud = page.getByTestId('m-settings-voice-read-aloud')
      const auto = page.getByTestId('m-settings-voice-auto')
      if ((await readAloud.getAttribute('aria-checked')) === 'false') await readAloud.tap()
      await expect(readAloud).toHaveAttribute('aria-checked', 'true')
      await auto.tap()
      await expect(auto).toHaveAttribute('aria-checked', 'true')

      await page.getByTestId('m-settings-voice-pick-Calm_Woman').tap()
      await expect(page.getByTestId('m-settings-voice-pick-Calm_Woman')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('m-settings-voice-pick-Wise_Woman')).toHaveAttribute('aria-checked', 'false')

      // The preview asks LU Cloud for exactly the picked voice.
      // M1: before the first request to LU Cloud the consent is asked. A no sends nothing and says why.
      await page.getByTestId('m-settings-voice-test').tap()
      await page.getByTestId('m-consent-decline').tap()
      await expect(page.getByTestId('m-settings-voice-failed')).toContainText('Nothing was sent')
      const tts = page.waitForRequest((r) => r.url() === `${CLOUD}/api/voice/tts` && r.method() === 'POST')
      await page.getByTestId('m-settings-voice-test').tap()
      await page.getByTestId('m-consent-agree').tap()
      expect((await tts).postDataJSON()).toMatchObject({ voice: 'Calm_Woman' })
      await expect(page.getByTestId('m-settings-voice-failed')).toHaveCount(0)
      const other = page.waitForRequest((r) => r.url() === `${CLOUD}/api/voice/tts` && r.method() === 'POST')
      await page.getByTestId('m-settings-voice-preview-Deep_Voice_Man').tap()
      expect((await other).postDataJSON()).toMatchObject({ voice: 'Deep_Voice_Man' })

      // An empty wallet is said in words.
      backend.tts = 'no-credits'
      await page.getByTestId('m-settings-voice-preview-Casual_Guy').tap()
      await expect(page.getByTestId('m-settings-voice-failed')).toHaveText('You are out of credits, so the preview could not be played.')
      backend.tts = 'ok'

      const system = page.getByTestId('m-settings-voice-system')
      const hasSystemVoice = (await system.count()) > 0
      if (hasSystemVoice) {
        await system.tap()
        await expect(system).toHaveAttribute('aria-checked', 'false')
        await page.getByRole('button', { name: 'Increase Speed' }).tap()
        await page.getByRole('button', { name: 'Decrease Pitch' }).tap()
      }

      await openShell(page, { route: '/settings/voice' })
      await expect(page.getByTestId('m-settings-voice-pick-Calm_Woman')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('m-settings-voice-read-aloud')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('m-settings-voice-auto')).toHaveAttribute('aria-checked', 'true')
      if (hasSystemVoice) {
        await expect(page.getByTestId('m-settings-voice-system')).toHaveAttribute('aria-checked', 'false')
        await expect(page.getByTestId('m-settings-voice-speed')).toHaveValue('1.1')
        await expect(page.getByTestId('m-settings-voice-pitch')).toHaveValue('0.9')
      }
      await page.getByTestId('m-settings-voice-read-aloud').tap()
      await expect(page.getByTestId('m-settings-voice-auto')).toBeDisabled()
      await expect(page.getByTestId('m-settings-voice-auto')).toContainText('Turn on Read aloud first')
      // Chat defaults shows the state of the same setting (E5.6) and has no second switch for it.
      await page.getByTestId('m-settings-voice-read-aloud').tap()
      await page.getByTestId('m-settings-voice-auto').tap()
      await openShell(page, { route: '/settings/chat' })
      await expect(page.getByTestId('m-settings-chat-read-aloud')).toContainText('On')
      await expect(page.getByTestId('m-settings-chat-read-aloud').getByRole('switch')).toHaveCount(0)
      expect(backend.calls.filter((c) => c.startsWith('UNMOCKED'))).toEqual([])
    })

    test('Account: the form has phone keyboards, and every way a sign in can fail says what to do', async ({ page, context }) => {
      const backend = freshBackend()
      await mockBackend(page, backend)
      await openShell(page, { route: '/settings/account' })
      await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
      await expectClean(page)

      const email = page.getByTestId('m-account-email')
      const password = page.getByTestId('m-account-password')
      await expect(email).toHaveAttribute('type', 'email')
      await expect(email).toHaveAttribute('inputmode', 'email')
      await expect(email).toHaveAttribute('autocomplete', 'username')
      await expect(email).toHaveAttribute('autocapitalize', 'none')
      await expect(password).toHaveAttribute('type', 'password')
      await expect(password).toHaveAttribute('autocomplete', 'current-password')
      // "Show" reveals what is typed and still keeps capitals off.
      await password.fill('abc')
      await page.getByTestId('m-account-password-show').tap()
      await expect(password).toHaveAttribute('type', 'text')
      await expect(password).toHaveAttribute('autocapitalize', 'none')
      await page.getByTestId('m-account-password-show').tap()
      await expect(password).toHaveAttribute('type', 'password')

      // Not an email: caught before anything is sent.
      await email.fill('nobody')
      await password.fill(PASSWORD)
      await page.getByTestId('m-account-signin').tap()
      await expect(page.getByText('Enter a valid email address.')).toBeVisible()
      expect(backend.calls.filter((c) => c.includes('/auth/v1/token'))).toEqual([])

      // Wrong password. The text the user typed stays.
      await email.fill(EMAIL)
      await password.fill('not-the-passphrase')
      await page.getByTestId('m-account-signin').tap()
      await expect(page.getByText('Email or password is not correct.')).toBeVisible()
      await expect(email).toHaveValue(EMAIL)
      await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
      await expectClean(page)

      // Email not confirmed.
      backend.password = 'unconfirmed'
      await password.fill(PASSWORD)
      await page.getByTestId('m-account-signin').tap()
      await expect(page.getByTestId('m-account-notice')).toHaveText('Check your inbox to confirm your email.')
      backend.password = 'ok'

      // No network.
      await context.setOffline(true)
      await expect(page.getByTestId('m-account-offline')).toContainText('No internet')
      await page.getByTestId('m-account-signin').tap()
      await expect(page.getByText('No internet. Try again when you are connected.').first()).toBeVisible()
      await page.getByTestId('m-account-google').tap()
      await expect(page.getByTestId('m-account-oauth-waiting')).toHaveCount(0)
      await context.setOffline(false)
      await expect(page.getByTestId('m-account-offline')).toHaveCount(0)

      // "Forgot password?" is a step in the app: a sheet with the address that is already typed.
      await page.getByTestId('m-account-forgot').tap()
      const reset = page.getByTestId('m-sheet-settings-forgot-password')
      await expect(reset).toBeVisible()
      await expect(page.getByTestId('m-account-reset-state')).toHaveAttribute('data-state', 'form')
      const resetEmail = page.getByTestId('m-account-reset-email')
      await expect(resetEmail).toHaveValue(EMAIL)
      await expect(resetEmail).toHaveAttribute('inputmode', 'email')
      expect(await layout(page)).toEqual(CLEAN)
      const recovers = () => backend.calls.filter((c) => c.startsWith('POST auth/auth/v1/recover')).length
      // Not an address: caught before anything is sent.
      await resetEmail.fill('nobody')
      await page.getByTestId('m-account-reset-send').tap()
      await expect(reset.getByText('Enter a valid email address.')).toBeVisible()
      expect(recovers()).toBe(0)
      // Asked too often: said in words, and the form stays.
      await resetEmail.fill(EMAIL)
      backend.recover = 'too-many'
      await page.getByTestId('m-account-reset-send').tap()
      await expect(page.getByTestId('m-account-reset-error')).toHaveText('Too many requests for this address. Wait a few minutes, then try again.')
      await expect(page.getByTestId('m-account-reset-state')).toHaveAttribute('data-state', 'form')
      backend.recover = 'ok'
      // No network: nothing is sent, and the sheet says why.
      await context.setOffline(true)
      await expect(page.getByTestId('m-account-reset-offline')).toBeVisible()
      const before = recovers()
      await page.getByTestId('m-account-reset-send').tap()
      await expect(page.getByTestId('m-account-reset-error')).toHaveText('No internet. Try again when you are connected.')
      expect(recovers()).toBe(before)
      await context.setOffline(false)
      // Sent: the sheet does not claim that the address has an account.
      await page.getByTestId('m-account-reset-send').tap()
      await expect(page.getByTestId('m-account-reset-state')).toHaveAttribute('data-state', 'sent')
      await expect(page.getByTestId('m-account-reset-sent')).toContainText('If this address has an account, an email is on its way.')
      await expect(reset).toContainText(EMAIL)
      await expect(reset).toContainText('Open the link in that email on this phone.')
      expect(recovers()).toBe(before + 1)
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-account-reset-again').tap()
      await expect.poll(recovers).toBe(before + 2)
      await page.getByTestId('m-account-reset-done').tap()
      await expect(reset).toHaveCount(0)
      // Nothing was handed to the browser: the website login is no part of this.
      expect((await opened(page)).filter((l) => l.includes('/login'))).toEqual([])
      // "What is LU Cloud?".
      await page.getByTestId('m-account-what-is-cloud').tap()
      await expect(page.getByTestId('m-cloud-screen')).toBeVisible()
      await page.getByTestId('m-page-back').last().tap()

      // And the one that works.
      await page.getByTestId('m-account-signin').tap()
      await expect(page.getByTestId('m-account-signedin')).toBeVisible()
      await expect(page.getByTestId('m-account-email-shown')).toHaveText(EMAIL)
      await expect(page.getByTestId('m-account-plan')).toContainText('Hosted')
      await expect(page.getByTestId('m-account-credits')).toBeVisible()
      await expect(page.getByTestId('m-account-signedin')).toContainText('750 left')
      await expectClean(page)
      // The password is not kept anywhere on the page.
      expect(await page.content()).not.toContain(PASSWORD)
    })

    test('Account: signed in it shows plan and credits, leads to the website, and signs out after a question', async ({ page }) => {
      const backend = freshBackend({ credits: { limit: 1000, used: 1000 } })
      await mockBackend(page, backend)
      await openShell(page, { route: '/settings/account' })
      await signIn(page)
      await expect(page.getByTestId('m-account-credits-empty')).toBeVisible()
      await expect(page.getByTestId('m-account-signedin')).toContainText('No credits left this period')

      await page.getByTestId('m-account-manage').tap()
      await page.getByTestId('m-account-buy').tap()
      await page.getByTestId('m-account-api-keys').tap()
      const links = await opened(page)
      expect(links).toContain(`${CLOUD}/account`)
      expect(links).toContain(`${CLOUD}/pricing`)

      await page.getByTestId('m-account-content-policy').tap()
      await expect(page.getByTestId('m-settings-content-policy-screen')).toBeVisible()
      await page.getByTestId('m-page-back').last().tap()
      await page.getByTestId('m-account-sync-memories').tap()
      await expect(page.getByTestId('m-settings-memory-screen')).toBeVisible()
      await page.getByTestId('m-page-back').last().tap()

      // Credits topped up on the website: "Refresh account" reads them.
      backend.credits = { limit: 1000, used: 100 }
      await page.getByTestId('m-account-refresh').tap()
      await expect(page.getByTestId('m-account-credits')).toBeVisible()
      await expect(page.getByTestId('m-account-signedin')).toContainText('900 left')

      // The account survives a reload, and the root shows it.
      await openSettingsRoot(page)
      await expect(page.getByTestId('m-settings-account')).toContainText(EMAIL)
      await expect(page.getByTestId('m-settings-credits')).toBeVisible()
      await expectClean(page)
      await page.getByTestId('m-settings-account').tap()

      // Sign out: "Stay signed in" keeps the session, "Sign out" ends it.
      await page.getByTestId('m-account-signout').tap()
      await expect(page.getByTestId('m-dialog-signout')).toContainText('Sign out of LU Cloud?')
      await page.getByTestId('m-dialog-cancel').tap()
      await expect(page.getByTestId('m-account-signedin')).toBeVisible()
      await page.getByTestId('m-account-signout').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
      await expect(page.getByTestId('m-toast-signed-out')).toBeVisible()
      // Asked for, so it is not "expired".
      await expect(page.getByTestId('m-account-session-expired')).toHaveCount(0)
      expect(backend.calls.some((c) => c.startsWith('POST auth/auth/v1/logout'))).toBe(true)
      await openShell(page, { route: '/settings/account' })
      await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
    })

    test('Account: creating an account asks to confirm the email, signs in when the server allows it, and says when the email is taken', async ({ page }) => {
      const backend = freshBackend({ signup: 'exists' })
      await mockBackend(page, backend)
      await openShell(page, { route: '/settings/account' })
      await page.getByTestId('m-account-mode-signup').tap()
      await expect(page.getByTestId('m-account-password')).toHaveAttribute('autocomplete', 'new-password')
      await expect(page.getByTestId('m-account-signin')).toHaveText('Create account')

      await page.getByTestId('m-account-email').fill(EMAIL)
      await page.getByTestId('m-account-password').fill('short')
      await page.getByTestId('m-account-signin').tap()
      await expect(page.getByText('The password needs at least 8 characters.')).toBeVisible()
      expect(backend.calls.filter((c) => c.includes('/auth/v1/signup'))).toEqual([])

      await page.getByTestId('m-account-password').fill(PASSWORD)
      await page.getByTestId('m-account-signin').tap()
      await expect(page.getByText('An account with this email already exists. Sign in instead.')).toBeVisible()

      backend.signup = 'confirm'
      await page.getByTestId('m-account-signin').tap()
      await expect(page.getByTestId('m-account-notice')).toHaveText('Check your inbox to confirm your email. Then sign in here.')
      await expect(page.getByTestId('m-account-mode-signin')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('m-account-email')).toHaveValue(EMAIL)
      await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
      await expectClean(page)

      backend.signup = 'session'
      backend.plan = 'none'
      await page.getByTestId('m-account-mode-signup').tap()
      await page.getByTestId('m-account-password').fill(PASSWORD)
      await page.getByTestId('m-account-signin').tap()
      await expect(page.getByTestId('m-account-signedin')).toBeVisible()
      await expect(page.getByTestId('m-account-plan')).toContainText('No active plan')
      await expect(page.getByTestId('m-account-manage')).toHaveText(/View plans/)
      await expectClean(page)
    })

    test('Credits empty (G5): the sheet opens where the paid call failed, with a title per cap', async ({ page }) => {
      await mockBackend(page, freshBackend())
      await openShell(page)
      const sheet = page.getByTestId('m-account-credits-empty')
      // Never at a plain start of the app.
      await expect(sheet).toHaveCount(0)

      await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:credits-exhausted', { detail: { reason: 'credits' } })))
      await expect(sheet).toBeVisible()
      await expect(sheet).toContainText("You're out of credits")
      await expect(sheet).toContainText('Your message is kept in the box. On device models still work and cost nothing.')
      await expectClean(page)
      await page.getByTestId('m-credits-plans').tap()
      expect(await opened(page)).toContain(`${CLOUD}/pricing`)
      // A second signal while it is open does not stack a second sheet.
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:credits-exhausted', { detail: { reason: 'credits' } })))
      await expect(page.locator('[data-testid="m-account-credits-empty"]')).toHaveCount(1)
      // In a chat, "Switch to an on device model" opens the model sheet.
      await page.getByTestId('m-credits-on-device').tap()
      await expect(sheet).toHaveCount(0)
      await expect(page.getByTestId('m-sheet-model')).toBeVisible()
      await page.goBack()

      await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:credits-exhausted', { detail: { reason: 'video_budget' } })))
      await expect(sheet).toContainText("This month's video budget is used up")
      await expect(page.getByTestId('m-credits-reason')).toHaveAttribute('data-reason', 'video_budget')
      await page.getByTestId('m-credits-not-now').tap()
      await expect(sheet).toHaveCount(0)

      await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:credits-exhausted', { detail: { reason: 'trainings' } })))
      await expect(sheet).toContainText('Top up to keep training')
      await page.goBack()
      await expect(sheet).toHaveCount(0)

      // Outside the Chat tab there is no chat to switch a model for.
      await page.getByTestId('m-page-back').tap()
      await page.getByTestId('m-nav-create').tap()
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:credits-exhausted')))
      await expect(sheet).toContainText("You're out of credits")
      await expect(page.getByTestId('m-credits-on-device')).toHaveCount(0)
    })

    test('Session expired (G6): the sheet comes up, nothing on the phone is lost, and signing in again works', async ({ page }) => {
      const backend = freshBackend()
      await mockBackend(page, backend)
      // Something to lose: two chats and a changed setting.
      await openShell(page, { route: '/settings/data' })
      await pickFile(page, 'm-settings-data-restore', 'backup.json', SAMPLE_BACKUP)
      await page.getByTestId('m-settings-data-restore-confirm').tap()
      // The page says "restored" only once the chats are written, so the app can be opened again at once.
      await expect(page.getByTestId('m-toast-restore-done')).toBeVisible()
      await openShell(page, { route: '/settings/appearance' })
      await page.getByTestId('m-settings-appearance-theme-light').tap()

      await openShell(page, { route: '/settings/account' })
      await signIn(page)

      // The server stops knowing the session. The next look at the account finds out.
      backend.sessionDead = true
      await page.getByTestId('m-account-refresh').tap()
      const sheet = page.getByTestId('m-account-session-expired')
      await expect(sheet).toBeVisible()
      await expect(sheet).toContainText('Please sign in again')
      await expect(sheet).toContainText('Chats and models on this phone are untouched. Your message is kept in the box.')
      await expectClean(page)
      await expect.poll(() => chatCount(page)).toBe(2)
      await expect(page.locator('html')).toHaveClass(/light/)

      // "Sign in" lands on the Account page, once, with the form.
      backend.sessionDead = false
      await page.getByTestId('m-session-signin').tap()
      await expect(sheet).toHaveCount(0)
      await expect(page.locator('[data-testid="m-account-screen"]')).toHaveCount(1)
      await signIn(page)
      await expect.poll(() => chatCount(page)).toBe(2)

      // The other way out: stay on device, and pick a model.
      backend.sessionDead = true
      await page.getByTestId('m-account-refresh').tap()
      await expect(sheet).toBeVisible()
      await page.getByTestId('m-session-on-device').tap()
      await expect(sheet).toHaveCount(0)
      await expect(page.getByTestId('m-sheet-model')).toBeVisible()
      await expect.poll(() => chatCount(page)).toBe(2)
    })

    test('LU Cloud (E3): the gate follows the account, and Cloud turns on only after the question', async ({ page }) => {
      const backend = freshBackend({ plan: 'none' })
      await mockBackend(page, backend)
      await openShell(page, { route: '/cloud' })
      const state = page.getByTestId('m-cloud-state')
      await expect(state).toHaveAttribute('data-state', 'signed-out')
      await expectClean(page)

      // Three plans, bought on the website.
      await page.getByTestId('m-cloud-plan-hosted').tap()
      await page.getByTestId('m-cloud-plan-hosted-pro').tap()
      await page.getByTestId('m-cloud-plan-hosted-max').tap()
      const links = await opened(page)
      expect(links).toContain(`${CLOUD}/checkout/start?plan=hosted&src=mobile`)
      expect(links).toContain(`${CLOUD}/checkout/start?plan=hosted-pro&src=mobile`)
      expect(links).toContain(`${CLOUD}/checkout/start?plan=hosted-max&src=mobile`)

      await page.getByTestId('m-cloud-signin').tap()
      await signIn(page)
      await page.getByTestId('m-page-back').last().tap()
      await expect(state).toHaveAttribute('data-state', 'no-plan')
      await expect(state).toContainText(`Signed in as ${EMAIL}.`)
      await page.getByTestId('m-cloud-recheck').tap()
      await expect(page.getByTestId('m-cloud-recheck-result')).toHaveText('No active plan found on this account yet.')
      await expectClean(page)

      // The payment failed.
      backend.plan = 'past-due'
      await page.getByTestId('m-cloud-recheck').tap()
      await expect(state).toHaveAttribute('data-state', 'past-due')
      await expect(page.getByTestId('m-cloud-past-due')).toContainText('Your last payment failed')
      await page.getByTestId('m-cloud-pay-invoice').tap()
      expect(await opened(page)).toContain(`${CLOUD}/account`)
      await expectClean(page)

      // Paid: "check again" finds the plan.
      backend.plan = 'active'
      await page.getByTestId('m-cloud-recheck').tap()
      await expect(state).toHaveAttribute('data-state', 'ready')
      await expect(page.getByTestId('m-cloud-ready')).toContainText("You're in. Cloud is ready.")
      await expectClean(page)

      const mode = () =>
        page.evaluate(async () => {
          const { useSettingsStore } = ((await import(/* @vite-ignore */ '/src/stores/settingsStore.ts' as string)) as typeof import('../../src/stores/settingsStore'))
          return useSettingsStore.getState().settings.appMode
        })

      // G11: "Stay on device" changes nothing.
      await page.getByTestId('m-cloud-turn-on').tap()
      const dialog = page.getByTestId('m-dialog-cloud-switch')
      await expect(dialog).toContainText('Switch to Cloud?')
      await expect(dialog).toContainText('Answers are billed to your lu-labs.ai credits.')
      await expect(page.getByTestId('m-dialog-confirm')).toHaveText('Switch to Cloud')
      await expect(page.getByTestId('m-dialog-cancel')).toHaveText('Stay on device')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-dialog-cancel').tap()
      expect(await mode()).toBe('local')

      // The first time, the consent to send content to LU Cloud follows the question. "Not now" keeps the app on device.
      await page.getByTestId('m-cloud-turn-on').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-sheet-ai-consent')).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-consent-decline').tap()
      await expect(page.getByTestId('m-sheet-ai-consent')).toHaveCount(0)
      expect(await mode()).toBe('local')

      await page.getByTestId('m-cloud-turn-on').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await page.getByTestId('m-consent-agree').tap()
      await expect(page.getByTestId('m-toast-cloud-on')).toBeVisible()
      expect(await mode()).toBe('cloud')

      // Still on after a reload; one tap goes back, without a question.
      await openShell(page, { route: '/cloud' })
      await expect(state).toHaveAttribute('data-state', 'ready')
      expect(await mode()).toBe('cloud')
      await page.getByTestId('m-cloud-turn-off').tap()
      await expect(page.getByTestId('m-toast-cloud-off')).toHaveText('Back on device')
      await expect(page.getByTestId('m-dialog-cloud-switch')).toHaveCount(0)
      expect(await mode()).toBe('local')
      await page.getByTestId('m-cloud-not-now').tap()
      await expect(page.getByTestId('m-cloud-screen')).toHaveCount(0)
    })

    test('Privacy: the anonymous counter can be switched off, stays off, and then nothing is counted', async ({ page }) => {
      const backend = freshBackend()
      await mockBackend(page, backend)
      const counted = () => backend.calls.filter((c) => c === 'POST cloud/api/funnel/switch').length
      await openSignedIn(page, '/cloud')
      await page.getByTestId('m-cloud-turn-on').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await page.getByTestId('m-consent-agree').tap()
      await expect(page.getByTestId('m-toast-cloud-on')).toBeVisible()
      // The phone counts anonymously only (review M2): the count per account is never sent, signed in or not.
      // The anonymous ping is a command of the native layer and does not exist in this browser run; that it
      // obeys the switch below is held by src/api/__tests__/mobile-switch-counter-anonymous.test.ts.
      await page.waitForTimeout(300)
      expect(counted()).toBe(0)

      await openShell(page, { route: '/settings/privacy' })
      await expectClean(page)
      const counter = page.getByTestId('m-settings-privacy-counter')
      await expect(counter).toHaveAttribute('aria-checked', 'true')
      // N15: while the counter is on the page does not claim "no analytics", and it says when the counter sends at all.
      await expect(page.getByTestId('m-settings-privacy-nothing-else')).toHaveText('Apart from that one counter LU has no analytics. No ad tracking, and your chats are not read for training.')
      await expect(page.getByTestId('m-settings-privacy-screen')).toContainText('Nothing is sent before you tap that switch')
      await counter.tap()
      await expect(counter).toHaveAttribute('aria-checked', 'false')
      await expect(page.getByTestId('m-settings-privacy-nothing-else')).toContainText('With the counter off LU has no analytics at all.')
      await expect(page.getByTestId('m-settings-privacy-counter-state')).toHaveText('The switch count is off')
      await page.getByTestId('m-settings-privacy-policy').tap()
      expect(await opened(page)).toContain(`${CLOUD}/privacy`)

      await openShell(page, { route: '/settings/privacy' })
      await expect(page.getByTestId('m-settings-privacy-counter')).toHaveAttribute('aria-checked', 'false')

      const before = counted()
      await openShell(page, { route: '/cloud' })
      await page.getByTestId('m-cloud-turn-off').tap()
      await expect(page.getByTestId('m-toast-cloud-off')).toBeVisible()
      await page.getByTestId('m-cloud-turn-on').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-toast-cloud-on')).toBeVisible()
      await page.waitForTimeout(300)
      expect(counted()).toBe(before)
    })

    test('Providers: a key is saved, tested and deleted, and is never shown', async ({ page }) => {
      const backend = freshBackend()
      await mockBackend(page, backend)
      const KEY = 'gsk_mock_key_for_tests_0123456789'
      await openShell(page, { route: '/settings/providers' })
      await expectClean(page)
      await expect(page.getByTestId('m-settings-providers-own')).toContainText('OpenRouter')
      await expect(page.getByTestId('m-settings-providers-own')).toContainText('Custom endpoint')
      await expect(page.getByTestId('m-settings-providers-row-groq')).toContainText('Not set up')

      await page.getByTestId('m-settings-providers-row-groq').tap()
      await expect(page.getByTestId('m-settings-provider-screen')).toBeVisible()
      const state = page.getByTestId('m-settings-provider-state')
      await expect(state).toHaveAttribute('data-key', 'none')
      await expectClean(page)
      // Without a key: no switch, no test.
      await expect(page.getByTestId('m-settings-provider-use')).toBeDisabled()
      await expect(page.getByTestId('m-settings-provider-use')).toContainText('Add an API key first')
      await expect(page.getByTestId('m-settings-provider-test')).toBeDisabled()

      const field = page.getByTestId('m-settings-provider-key')
      await expect(field).toHaveAttribute('type', 'password')
      await expect(field).toHaveAttribute('autocapitalize', 'none')
      // A key field has no "Show".
      await expect(page.getByTestId('m-settings-provider-key-show')).toHaveCount(0)
      await field.fill(KEY)
      await expect(field).toHaveAttribute('type', 'password')
      await page.getByTestId('m-settings-provider-key-save').tap()
      await keySavedNoteAway(page)
      await expect(state).toHaveAttribute('data-key', 'saved')
      await expect(page.getByTestId('m-settings-provider-key-state')).toHaveText('A key is saved on this phone. It is never shown again.')
      // The typed key left the page, and is nowhere in it or in the app storage in clear text.
      await expect(field).toHaveValue('')
      expect(await page.content()).not.toContain(KEY)
      expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain(KEY)

      // The test really uses the saved key.
      await page.getByTestId('m-settings-provider-test').tap()
      await expect(page.getByTestId('m-settings-provider-test-ok')).toHaveText('Connected. 3 models found.')
      expect(backend.providerAuth.at(-1)).toBe(`Bearer ${KEY}`)
      backend.provider = 'bad-key'
      await page.getByTestId('m-settings-provider-test').tap()
      await expect(page.getByTestId('m-settings-provider-test-failed')).toHaveText('The key was not accepted. Check it and save it again.')
      backend.provider = 'down'
      await page.getByTestId('m-settings-provider-test').tap()
      await expect(page.getByTestId('m-settings-provider-test-failed')).toHaveText('The provider did not answer. Check the address and your connection.')
      backend.provider = 'ok'
      await expectClean(page)

      await page.getByTestId('m-settings-provider-use').tap()
      await expect(page.getByTestId('m-settings-provider-use')).toHaveAttribute('aria-checked', 'true')

      // After a reload: still saved, still on, still usable, still not shown.
      await openShell(page, { route: '/settings/providers' })
      await expect(page.getByTestId('m-settings-providers-row-groq')).toContainText('On')
      await page.getByTestId('m-settings-providers-row-groq').tap()
      await expect(state).toHaveAttribute('data-key', 'saved')
      await expect(state).toHaveAttribute('data-enabled', 'yes')
      await expect(page.getByTestId('m-settings-provider-key')).toHaveValue('')
      expect(await page.content()).not.toContain(KEY)
      await page.getByTestId('m-settings-provider-test').tap()
      await expect(page.getByTestId('m-settings-provider-test-ok')).toHaveText('Connected. 3 models found.')
      expect(backend.providerAuth.at(-1)).toBe(`Bearer ${KEY}`)

      // Remove the key: a question first, then it is gone and the provider is off.
      await page.getByTestId('m-settings-provider-key-delete').tap()
      await expect(page.getByTestId('m-dialog-provider-key-remove')).toContainText('Remove this key?')
      await page.getByTestId('m-dialog-cancel').tap()
      await expect(state).toHaveAttribute('data-key', 'saved')
      await page.getByTestId('m-settings-provider-key-delete').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(state).toHaveAttribute('data-key', 'none')
      await expect(state).toHaveAttribute('data-enabled', 'no')
      await openShell(page, { route: '/settings/providers' })
      await expect(page.getByTestId('m-settings-providers-row-groq')).toContainText('Not set up')
    })

    test('Providers: Anthropic uses its own slot, and a custom endpoint checks its address', async ({ page }) => {
      const backend = freshBackend()
      await mockBackend(page, backend)
      const KEY = 'sk-ant-mock-key-for-tests-0123456789'
      await openShell(page, { route: '/settings/providers' })
      await page.getByTestId('m-settings-providers-row-anthropic').tap()
      const state = page.getByTestId('m-settings-provider-state')
      await page.getByTestId('m-settings-provider-key').fill(KEY)
      await page.getByTestId('m-settings-provider-key-save').tap()
      await keySavedNoteAway(page)
      await expect(state).toHaveAttribute('data-key', 'saved')
      expect(await page.content()).not.toContain(KEY)
      expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain(KEY)
      await page.getByTestId('m-settings-provider-test').tap()
      await expect(page.getByTestId('m-settings-provider-test-ok')).toHaveText('Connected. The key works.')
      expect(backend.providerAuth.at(-1)).toBe(KEY)
      backend.provider = 'bad-key'
      await page.getByTestId('m-settings-provider-test').tap()
      await expect(page.getByTestId('m-settings-provider-test-failed')).toContainText('The key was not accepted.')
      backend.provider = 'ok'
      await page.getByTestId('m-settings-provider-use').tap()
      await expect(state).toHaveAttribute('data-enabled', 'yes')

      await openShell(page, { route: '/settings/providers' })
      await expect(page.getByTestId('m-settings-providers-row-anthropic')).toContainText('On')
      await page.getByTestId('m-settings-providers-row-anthropic').tap()
      await expect(state).toHaveAttribute('data-key', 'saved')
      // "Remove provider" takes key and switch with it and leaves the page.
      await page.getByTestId('m-settings-provider-delete').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-settings-providers-screen')).toBeVisible()
      await expect(page.getByTestId('m-settings-providers-row-anthropic')).toContainText('Not set up')

      // Custom endpoint: the address rule.
      await page.getByTestId('m-settings-providers-row-custom').tap()
      const url = page.getByTestId('m-settings-provider-url')
      await expect(url).toHaveAttribute('inputmode', 'url')
      await expect(page.getByTestId('m-settings-provider-screen')).toContainText('Must start with https, or be a device on your network')
      await url.fill('http://example.com/v1')
      await page.getByTestId('m-settings-provider-url-save').tap()
      await expect(page.getByText('Enter an address that starts with https, or a device on your network.')).toBeVisible()
      await url.fill('https://api.groq.com/openai/v1/')
      await page.getByTestId('m-settings-provider-url-save').tap()
      await expect(page.getByTestId('m-toast-provider-url-saved')).toBeVisible()
      await expect(url).toHaveValue('https://api.groq.com/openai/v1')
      await page.getByTestId('m-settings-provider-key').fill('custom-mock-key-0123456789')
      await page.getByTestId('m-settings-provider-key-save').tap()
      await keySavedNoteAway(page)
      await page.getByTestId('m-settings-provider-test').tap()
      await expect(page.getByTestId('m-settings-provider-test-ok')).toHaveText('Connected. 3 models found.')
      await expectClean(page)
      await openShell(page, { route: '/settings/providers' })
      await expect(page.getByTestId('m-settings-providers-row-custom')).toContainText('Key saved')
      await page.getByTestId('m-settings-providers-row-custom').tap()
      await expect(page.getByTestId('m-settings-provider-url')).toHaveValue('https://api.groq.com/openai/v1')
    })

    test('Backup and import: all chats go into a file and come back from it', async ({ page }) => {
      await mockBackend(page, freshBackend())
      await openShell(page, { route: '/settings/data' })
      await expectClean(page)
      // Nothing to back up or delete yet.
      await page.getByTestId('m-settings-data-backup').tap()
      await expect(page.getByTestId('m-toast-backup-none')).toBeVisible()
      await expect(page.getByTestId('m-settings-data-all-delete')).toBeDisabled()

      // A file that is no backup says so and changes nothing.
      await pickFile(page, 'm-settings-data-restore', 'notes.json', 'this is not json', 'application/json')
      await expect(page.getByTestId('m-settings-data-restore-error')).toContainText('This is not a backup file.')
      await pickFile(page, 'm-settings-data-restore', 'other.json', '{"hello":"world"}')
      await expect(page.getByTestId('m-settings-data-restore-error')).toHaveText('No chats were found in this file.')
      await expect.poll(() => chatCount(page)).toBe(0)

      // A real one: summary first, then restore.
      await pickFile(page, 'm-settings-data-restore', 'backup.json', SAMPLE_BACKUP)
      await expect(page.getByTestId('m-settings-data-restore-found')).toContainText('2 chats found')
      await expect.poll(() => chatCount(page)).toBe(0)
      await expectClean(page)
      await page.getByTestId('m-settings-data-restore-confirm').tap()
      await expect(page.getByTestId('m-toast-restore-done')).toHaveText('2 chats restored')
      // "Restored" means written: the app is opened again at once, without waiting for anything, and both chats are there.
      await openShell(page, { route: '/settings/data' })
      await expect.poll(() => chatCount(page)).toBe(2)
      await expect(page.getByTestId('m-settings-data-all-delete')).toContainText('2 chats on this phone')
      // The same file again adds nothing.
      await pickFile(page, 'm-settings-data-restore', 'backup.json', SAMPLE_BACKUP)
      await page.getByTestId('m-settings-data-restore-confirm').tap()
      await expect(page.getByTestId('m-toast-restore-done')).toContainText('Nothing new')
      await expect.poll(() => chatCount(page)).toBe(2)

      // Back up: the file holds both chats.
      const download = page.waitForEvent('download')
      await page.getByTestId('m-settings-data-backup').tap()
      const file = await download
      expect(file.suggestedFilename()).toMatch(/^lu-chats-\d{4}-\d{2}-\d{2}-2\.json$/)
      const saved = JSON.parse(fs.readFileSync(await file.path(), 'utf8')) as { kind: string; count: number; conversations: Array<{ id: string }> }
      expect(saved.kind).toBe('chat-export')
      expect(saved.conversations.map((c) => c.id).sort()).toEqual(['backup-1', 'backup-2'])
      await expect(page.getByTestId('m-toast-backup-done')).toContainText('Backup of 2 chats')

      // "Save backup to this phone": in a browser that is a download too, and the page keeps saying where the file went.
      const second = page.waitForEvent('download')
      await page.getByTestId('m-settings-data-backup-save').tap()
      const kept = await second
      expect(kept.suggestedFilename()).toMatch(/^lu-chats-\d{4}-\d{2}-\d{2}-2\.json$/)
      const note = page.getByTestId('m-settings-data-backup-note')
      await expect(note).toContainText(`Backup of 2 chats downloaded as ${kept.suggestedFilename()}. It is in the downloads of this browser.`)
      await expect(note).toContainText('tap Restore from a backup file and pick that file')
      await expectClean(page)

      // The chats survive a reload.
      await openShell(page, { route: '/settings/data' })
      await expect.poll(() => chatCount(page)).toBe(2)
      await expect(page.getByTestId('m-settings-data-all-delete')).toContainText('2 chats on this phone')

      // The automatic backup needs the installed app, and says so here.
      await page.getByTestId('m-settings-data-auto-now').tap()
      await expect(page.getByTestId('m-toast-auto-backup-unavailable')).toBeVisible()
    })

    test('Backup and import: chats from another app are read on the phone and land in the chat list', async ({ page }) => {
      await mockBackend(page, freshBackend())
      await openShell(page, { route: '/settings/data' })
      await page.getByTestId('m-settings-data-import').tap()
      await expect(page.getByTestId('m-settings-data-import-screen')).toBeVisible()
      const state = page.getByTestId('m-settings-data-import-state')
      await expect(state).toHaveAttribute('data-state', 'pick')
      await expectClean(page)

      await pickFile(page, 'm-settings-data-import-choose', 'conversations.json', '{"not":"an export"}')
      await expect(page.getByTestId('m-settings-data-import-error')).toContainText('No chats were found.')
      await pickFile(page, 'm-settings-data-import-choose', 'export.zip', Buffer.from('this is not an archive'), 'application/zip')
      await expect(page.getByTestId('m-settings-data-import-error')).toContainText('This file could not be read.')

      await pickFile(page, 'm-settings-data-import-choose', 'conversations.json', SAMPLE_CHATGPT_EXPORT)
      await expect(page.getByTestId('m-settings-data-import-found')).toContainText('2 chats found from ChatGPT')
      // Making them searchable needs the document model, which this preview does not have: the switch says why.
      await expect(page.getByTestId('m-settings-data-import-searchable')).toBeDisabled()
      await expect(page.getByTestId('m-settings-data-import-searchable')).toContainText('Open Documents in a chat once')
      await expectClean(page)
      await page.getByTestId('m-settings-data-import-run').tap()
      await expect(page.getByTestId('m-settings-data-import-done')).toContainText('2 chats imported')
      await expect(page.getByTestId('m-settings-data-import-not-saved')).toHaveCount(0)
      // "Imported" means written: the app is opened again at once and both chats are there.
      await openShell(page, { route: '/settings/data/import' })
      await expect.poll(() => chatCount(page)).toBe(2)
      await expectClean(page)

      const chats = await page.evaluate(async () => {
        const { useChatStore } = ((await import(/* @vite-ignore */ '/src/stores/chatStore.ts' as string)) as typeof import('../../src/stores/chatStore'))
        return useChatStore.getState().conversations.map((c) => ({ title: c.title, messages: c.messages.map((m) => `${m.role}: ${m.content}`) }))
      })
      expect(chats.map((c) => c.title).sort()).toEqual(['Bread (ChatGPT)', 'Holiday ideas (ChatGPT)'])
      expect(chats.find((c) => c.title.startsWith('Holiday'))?.messages).toEqual(['user: Where should I go in spring?', 'assistant: Lisbon is warm in spring.'])

      // The same export twice adds nothing twice.
      await pickFile(page, 'm-settings-data-import-choose', 'conversations.json', SAMPLE_CHATGPT_EXPORT)
      await page.getByTestId('m-settings-data-import-run').tap()
      await expect(page.getByTestId('m-settings-data-import-done')).toBeVisible()
      await expect.poll(() => chatCount(page)).toBe(2)

      await page.getByTestId('m-settings-data-import-open-chats').tap()
      await expect(page.getByTestId('m-nav-chat')).toHaveAttribute('aria-selected', 'true')
    })

    test('Backup and import: "Delete all chats" asks twice and wants the word typed', async ({ page }) => {
      await mockBackend(page, freshBackend())
      await openShell(page, { route: '/settings/data' })
      await pickFile(page, 'm-settings-data-restore', 'backup.json', SAMPLE_BACKUP)
      await page.getByTestId('m-settings-data-restore-confirm').tap()
      await expect(page.getByTestId('m-toast-restore-done')).toBeVisible()
      await openShell(page, { route: '/settings/data' })
      await expect.poll(() => chatCount(page)).toBe(2)

      // First question: the safe answer keeps everything.
      await page.getByTestId('m-settings-data-all-delete').tap()
      await expect(page.getByTestId('m-dialog-delete-all-1')).toContainText('Delete all chats?')
      await page.getByTestId('m-dialog-cancel').tap()
      await expect.poll(() => chatCount(page)).toBe(2)

      // Second question: back keeps everything too.
      await page.getByTestId('m-settings-data-all-delete').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-dialog-delete-all-2')).toContainText('Really delete everything?')
      await page.goBack()
      await expect(page.getByTestId('m-dialog-delete-all-2')).toHaveCount(0)
      await expect.poll(() => chatCount(page)).toBe(2)

      // The word has to be typed exactly.
      await page.getByTestId('m-settings-data-all-delete').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-dialog-delete-all-2')).toBeVisible()
      await expect(page.getByTestId('m-dialog-confirm')).toBeDisabled()
      await page.getByTestId('m-dialog-gate').fill('delete')
      await expect(page.getByTestId('m-dialog-confirm')).toBeDisabled()
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-dialog-gate').fill('DELETE')
      // An unsent draft of Create sits in the storage of the phone. It goes with the chats.
      await page.evaluate(() => localStorage.setItem('lu-create-draft', JSON.stringify({ v: 1, at: Date.now(), prompt: 'a lighthouse' })))
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-toast-delete-all-done')).toHaveText('2 chats deleted')
      expect(await page.evaluate(() => localStorage.getItem('lu-create-draft'))).toBeNull()
      // "Deleted" means written: opened again at once, nothing comes back.
      await openShell(page, { route: '/settings/data' })
      await expect.poll(() => chatCount(page)).toBe(0)
      await expect(page.getByTestId('m-settings-data-all-delete')).toBeDisabled()
    })

    test('Content policy: belongs to the account, saves on the server, and "Off" asks for the age', async ({ page }) => {
      const backend = freshBackend()
      await mockBackend(page, backend)
      await openShell(page, { route: '/settings/content-policy' })
      const state = page.getByTestId('m-settings-content-policy-state')
      await expect(state).toHaveAttribute('data-state', 'signed-out')
      await expect(page.getByTestId('m-settings-content-policy-signed-out')).toContainText('Sign in to change this')
      await expect(page.getByTestId('m-settings-content-policy-strict')).toBeDisabled()
      await expectClean(page)

      await page.getByTestId('m-settings-content-policy-signin').tap()
      await signIn(page)
      await page.getByTestId('m-page-back').last().tap()
      await expect(state).toHaveAttribute('data-state', 'ready')
      await expect(state).toHaveAttribute('data-policy', 'soft')
      await expect(page.getByTestId('m-settings-content-policy-soft')).toHaveAttribute('aria-checked', 'true')

      await page.getByTestId('m-settings-content-policy-strict').tap()
      await expect(page.getByTestId('m-toast-content-policy-saved')).toBeVisible()
      await expect(state).toHaveAttribute('data-policy', 'strict')
      expect(backend.policy).toBe('strict')

      // "Off": "Keep the filter" keeps it.
      await page.getByTestId('m-settings-content-policy-off').tap()
      await expect(page.getByTestId('m-dialog-content-policy-age')).toContainText('Are you 18 or older?')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-dialog-cancel').tap()
      await expect(state).toHaveAttribute('data-policy', 'strict')
      expect(backend.policy).toBe('strict')

      // A save that fails says so and leaves the setting.
      backend.policyPutFails = true
      await page.getByTestId('m-settings-content-policy-soft').tap()
      await expect(page.getByTestId('m-settings-content-policy-save-failed')).toHaveText('This could not be saved. Your setting is unchanged.')
      await expect(state).toHaveAttribute('data-policy', 'strict')
      await expect(page.getByTestId('m-settings-content-policy-strict')).toHaveAttribute('aria-checked', 'true')
      backend.policyPutFails = false

      const put = page.waitForRequest((r) => r.url() === `${CLOUD}/api/account/content-policy` && r.method() === 'PUT')
      await page.getByTestId('m-settings-content-policy-off').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      expect((await put).postDataJSON()).toEqual({ policy: 'off', ageConfirmed: true })
      await expect(state).toHaveAttribute('data-policy', 'off')

      // What the server holds is what a reload shows.
      await openShell(page, { route: '/settings/content-policy' })
      await expect(state).toHaveAttribute('data-policy', 'off')
      await expect(page.getByTestId('m-settings-content-policy-off')).toHaveAttribute('aria-checked', 'true')
      await expectClean(page)
    })

    test('Troubleshooting: checks, diagnostics with honest gaps, self test, report, setup and reset', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      const backend = freshBackend()
      await mockBackend(page, backend)
      await openShell(page, { route: '/settings/chat' })
      await page.getByRole('button', { name: 'Increase Temperature' }).tap()
      await openShell(page, { route: '/settings/troubleshooting' })

      // Three lights, each with a word and a sentence.
      await expect(page.getByTestId('m-settings-troubleshooting-check-internet')).toHaveAttribute('data-light', 'ok')
      await expect(page.getByTestId('m-settings-troubleshooting-check-cloud')).toHaveAttribute('data-light', 'ok')
      await expect(page.getByTestId('m-settings-troubleshooting-check-cloud')).toContainText('Reachable')
      // No native layer in this preview: the engine line says that, it does not claim a state.
      await expect(page.getByTestId('m-settings-troubleshooting-check-engine')).toHaveAttribute('data-light', 'warn')
      await expect(page.getByTestId('m-settings-troubleshooting-check-engine')).toContainText('cannot be checked here')
      await expectClean(page)

      // Diagnostics: every row is there; what a browser cannot know says where it is shown, never "Not available".
      const diag = page.getByTestId('m-settings-troubleshooting-diagnostics')
      for (const label of ['Device', 'App version', 'Memory', 'Memory available to LU', 'Storage free', 'Storage used by LU', 'Accelerator', 'Model loaded', 'Last speed']) {
        await expect(diag).toContainText(label)
      }
      await expect(page.getByTestId('m-settings-troubleshooting-diag-app-version')).toContainText(/\d+\.\d+\.\d+/)
      await expect(page.getByTestId('m-settings-troubleshooting-diag-store-preset')).toContainText('Open build')
      await expect(page.getByTestId('m-settings-troubleshooting-diag-accelerator')).toContainText('Shown in the installed app')
      await expect(page.getByTestId('m-settings-troubleshooting-diag-model')).toContainText('Shown in the installed app')
      expect(await diag.innerText()).not.toContain('Not available')
      await expect(page.getByTestId('m-settings-troubleshooting-diag-speed')).toContainText('Not measured yet')

      // The self test needs the engine of the installed app, and says so.
      await page.getByTestId('m-settings-troubleshooting-self-test').tap()
      await expect(page.getByTestId('m-settings-troubleshooting-self-test-failed')).toHaveText('The self test needs the installed app.')
      await expectClean(page)

      // Copy report: the clipboard starts with the title.
      await page.getByTestId('m-settings-troubleshooting-copy-report').tap()
      await expect(page.getByTestId('m-toast-report-copied')).toBeVisible()
      const report = await page.evaluate(() => navigator.clipboard.readText())
      expect(report.split('\n')[0]).toBe('LU diagnostics report')
      expect(report).toContain('App version: ')
      expect(report).toContain('Device: ')
      expect(report).not.toContain('Not available')
      await page.getByTestId('m-settings-troubleshooting-copy-details').tap()
      await expect(page.getByTestId('m-toast-details-copied')).toBeVisible()

      // Share report and share log hand over a file.
      const reportFile = page.waitForEvent('download')
      await page.getByTestId('m-settings-troubleshooting-share-report').tap()
      const r = await reportFile
      expect(r.suggestedFilename()).toBe('lu-diagnostics.txt')
      expect(fs.readFileSync(await r.path(), 'utf8').split('\n')[0]).toBe('LU diagnostics report')
      const logFile = page.waitForEvent('download')
      await page.getByTestId('m-settings-troubleshooting-share-log').tap()
      const l = await logFile
      expect(l.suggestedFilename()).toBe('lu-log.txt')
      const logText = fs.readFileSync(await l.path(), 'utf8')
      expect(logText).toContain('Errors since LU was opened')
      // No log file in a browser: the shared text says that, and still carries the report and what this session recorded.
      expect(logText).toContain('The log file of the app could not be read here.')
      expect(logText.split('\n')[0]).toBe('LU diagnostics report')

      // Without network the lights change, with a sentence that says what still works.
      await context.setOffline(true)
      await page.getByTestId('m-settings-troubleshooting-run').tap()
      await expect(page.getByTestId('m-settings-troubleshooting-check-internet')).toHaveAttribute('data-light', 'warn')
      await expect(page.getByTestId('m-settings-troubleshooting-check-internet')).toContainText('On device models still work')
      await expect(page.getByTestId('m-settings-troubleshooting-check-cloud')).toContainText('Not checked without internet')
      await context.setOffline(false)
      await page.getByTestId('m-settings-troubleshooting-run').tap()
      await expect(page.getByTestId('m-settings-troubleshooting-check-cloud')).toHaveAttribute('data-light', 'ok')

      // Reset all settings: a question, then the defaults. Chats are not touched.
      const temperature = () =>
        page.evaluate(async () => {
          const { useSettingsStore } = ((await import(/* @vite-ignore */ '/src/stores/settingsStore.ts' as string)) as typeof import('../../src/stores/settingsStore'))
          return useSettingsStore.getState().settings.temperature
        })
      expect(await temperature()).toBe(0.8)
      await page.getByTestId('m-settings-troubleshooting-reset').tap()
      await expect(page.getByTestId('m-dialog-settings-reset')).toContainText('Reset all settings?')
      await page.getByTestId('m-dialog-cancel').tap()
      expect(await temperature()).toBe(0.8)
      await page.getByTestId('m-settings-troubleshooting-reset').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-toast-settings-reset')).toBeVisible()
      expect(await temperature()).toBe(0.7)

      // Run setup again: a question, then the first steps without the tab bar.
      await page.getByTestId('m-settings-troubleshooting-setup').tap()
      await expect(page.getByTestId('m-dialog-setup-again')).toContainText('Run setup again?')
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-onboarding-screen')).toBeVisible()
      expect(backend.calls.filter((c) => c.startsWith('UNMOCKED'))).toEqual([])
    })

    test('About and What is new: version, licenses, links, and the notes open once per version', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      await mockBackend(page, freshBackend())
      await openShell(page, { route: '/settings/about' })
      await expectClean(page)
      const version = (await page.getByTestId('m-settings-about-version-value').textContent()) ?? ''
      // M5: the store preset of this build is on the page, so a build made as the wrong one shows it.
      await expect(page.getByTestId('m-settings-about-build-value')).toHaveAttribute('data-m-preset', 'open')
      await expect(page.getByTestId('m-settings-about-build-value')).toHaveText('Open build')
      expect(version).toMatch(/^\d+\.\d+\.\d+/)
      // The version of the PHONE package (tauri.android.conf.json, tauri.ios.conf.json), not the
      // desktop's in package.json: the phone build hands it to this page as a build constant.
      expect(version.split(' ')[0]).toBe(phoneVersion(path.resolve(HERE, '../..')))
      await page.getByTestId('m-settings-about-version').tap()
      await expect(page.getByTestId('m-toast-version-copied')).toBeVisible()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`Locally Uncensored ${version}`)

      await page.getByTestId('m-settings-about-licenses').tap()
      await expect(page.getByTestId('m-sheet-settings-licenses')).toBeVisible()
      await expect(page.getByTestId('m-settings-licenses-own')).toContainText('GNU Affero General Public License, version 3')
      await expect(page.getByTestId('m-settings-licenses-list')).toContainText('llama.cpp')
      await expectClean(page)
      await page.getByTestId('m-settings-licenses-full').tap()
      await page.goBack()
      await expect(page.getByTestId('m-sheet-settings-licenses')).toHaveCount(0)

      // F3 of the second check on Android: every row that opens the browser says so, "Source code" too.
      await expect(page.getByTestId('m-settings-about-website')).toContainText('Opens lu-labs.ai in your browser')
      await expect(page.getByTestId('m-settings-about-source')).toContainText('Opens github.com in your browser')
      for (const id of ['m-settings-about-website', 'm-settings-about-source']) await expect(page.getByTestId(id)).toHaveAttribute('data-m-risk', 'leaves-app')
      await expectClean(page)
      await page.getByTestId('m-settings-about-website').tap()
      await page.getByTestId('m-settings-about-source').tap()
      const links = await opened(page)
      expect(links).toContain(CLOUD)
      expect(links.some((l) => l.startsWith('https://github.com/'))).toBe(true)
      expect(links.some((l) => l.endsWith('/LICENSE'))).toBe(true)

      await page.getByTestId('m-settings-about-whats-new').tap()
      await expect(page.getByTestId('m-whats-new-screen')).toBeVisible()
      await expect(page.getByTestId('m-whats-new-version')).toHaveText(`Version ${version.split(' ')[0]}`)
      await expect(page.getByTestId('m-whats-new-notes')).toContainText('LU is on your phone.')
      await expectClean(page)
      await page.getByTestId('m-whats-new-got-it').tap()
      await expect(page.getByTestId('m-whats-new-screen')).toHaveCount(0)
      await expect(page.getByTestId('m-settings-about-screen')).toBeVisible()

      // An update: the notes of the new version open by themselves, once.
      await page.evaluate(async () => {
        const { useSettingsStore } = ((await import(/* @vite-ignore */ '/src/stores/settingsStore.ts' as string)) as typeof import('../../src/stores/settingsStore'))
        const { useReleaseNotesStore } = ((await import(/* @vite-ignore */ '/src/stores/releaseNotesStore.ts' as string)) as typeof import('../../src/stores/releaseNotesStore'))
        useSettingsStore.getState().updateSettings({ onboardingDone: true })
        useReleaseNotesStore.getState().markNotesSeen('0.0.1')
      })
      // The frame of the shell watches for it, so no settings page has to be open.
      await openShell(page)
      await expect(page.getByTestId('m-whats-new-screen')).toBeVisible()
      await page.getByTestId('m-whats-new-got-it').tap()
      await expect(page.getByTestId('m-whats-new-screen')).toHaveCount(0)
      await openShell(page)
      await page.waitForTimeout(1200)
      await expect(page.getByTestId('m-whats-new-screen')).toHaveCount(0)
      await openSettingsRoot(page)
      await expect(page.getByTestId('m-whats-new-screen')).toHaveCount(0)
    })

    test('Remote desktop and the small sheets: state, links to the remote pages, price, link offer', async ({ page }) => {
      await mockBackend(page, freshBackend())
      await openShell(page, { route: '/settings/remote' })
      await expect(page.getByTestId('m-settings-remote-state')).toHaveAttribute('data-state', 'unpaired')
      await expect(page.getByTestId('m-settings-remote-status')).toContainText('Not connected')
      await expect(page.getByTestId('m-settings-remote-forget-delete')).toHaveCount(0)
      await expectClean(page)
      await page.getByTestId('m-settings-remote-connect').tap()
      await expect(page.getByTestId('m-remote-connect-screen')).toBeVisible()
      await page.getByTestId('m-page-back').last().tap()
      await page.getByTestId('m-settings-remote-how').tap()
      await expect(page.getByTestId('m-remote-help-screen')).toBeVisible()

      // G13 without a picked model.
      await openShell(page, { route: '/dev/routes' })
      await page.getByTestId('m-dev-sheet-open-price').tap()
      await expect(page.getByTestId('m-sheet-price')).toBeVisible()
      await expect(page.getByTestId('m-price-kind')).toHaveAttribute('data-kind', 'none')
      await expectClean(page)
      await page.getByTestId('m-price-close').tap()
      await expect(page.getByTestId('m-sheet-price')).toHaveCount(0)
      await page.getByTestId('m-dev-sheet-open-price').tap()
      await page.getByTestId('m-price-change-model').tap()
      await expect(page.getByTestId('m-sheet-price')).toHaveCount(0)
      await expect(page.getByTestId('m-sheet-model')).toBeVisible()
      await page.goBack()

      // G14 opened without a live offer: it says the link expired and offers nothing.
      await page.getByTestId('m-dev-sheet-open-link-offer').tap()
      await expect(page.getByTestId('m-link-offer-gone')).toContainText('Links are valid for 5 minutes.')
      await expect(page.getByTestId('m-link-offer-continue')).toHaveCount(0)
      await expectClean(page)
      await page.getByTestId('m-link-offer-dismiss').tap()
      await expect(page.getByTestId('m-sheet-link-offer')).toHaveCount(0)

      // A desktop link is offered, never followed by itself; "Continue" hands it to the remote pages.
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:deep-link', { detail: { url: 'lu://remote?address=studio.local:8765' } })))
      await expect(page.getByTestId('m-link-offer-kind')).toHaveAttribute('data-kind', 'remote')
      await expect(page.getByTestId('m-sheet-link-offer')).toContainText('Connect to studio.local:8765?')
      await expectClean(page)
      await page.getByTestId('m-link-offer-continue').tap()
      await expect(page.getByTestId('m-remote-connect-screen')).toBeVisible()
    })

    test('The quieter buttons: ways back, retries and second thoughts all do what they say', async ({ page }) => {
      const backend = freshBackend({ plan: 'none' })
      await mockBackend(page, backend)

      // Providers: the two built in rows lead on, and an address nobody knows has a way back.
      await openShell(page, { route: '/settings/providers' })
      await page.getByTestId('m-settings-providers-engine').tap()
      await expect(page.getByTestId('m-settings-engine-screen')).toBeVisible()
      await page.getByTestId('m-page-back').last().tap()
      await page.getByTestId('m-settings-providers-cloud').tap()
      await expect(page.getByTestId('m-account-screen')).toBeVisible()
      await openShell(page, { route: '/settings/providers/no-such-provider' })
      await expect(page.getByTestId('m-settings-provider-unknown')).toBeVisible()
      await expectClean(page)
      await page.getByTestId('m-settings-provider-back').tap()
      await expect(page.getByTestId('m-settings-providers-screen')).toBeVisible()
      await expect(page.getByTestId('m-settings-provider-unknown')).toHaveCount(0)

      // Restore: a backup that was read can still be turned down, and then nothing is added.
      await openShell(page, { route: '/settings/data' })
      await pickFile(page, 'm-settings-data-restore', 'backup.json', SAMPLE_BACKUP)
      await expect(page.getByTestId('m-settings-data-restore-found')).toBeVisible()
      await page.getByTestId('m-settings-data-restore-cancel').tap()
      await expect(page.getByTestId('m-settings-data-restore-found')).toHaveCount(0)
      expect(await chatCount(page)).toBe(0)

      // Import: "Choose another file" asks for a file again and reads the new one.
      await openShell(page, { route: '/settings/data/import' })
      await pickFile(page, 'm-settings-data-import-choose', 'conversations.json', SAMPLE_CHATGPT_EXPORT)
      await expect(page.getByTestId('m-settings-data-import-found')).toContainText('2 chats found')
      await pickFile(page, 'm-settings-data-import-another', 'one.json', JSON.stringify([JSON.parse(SAMPLE_CHATGPT_EXPORT)[0]]))
      await expect(page.getByTestId('m-settings-data-import-found')).toContainText('1 chat found')
      expect(await chatCount(page)).toBe(0)

      // Troubleshooting: "Refresh" reads the rows again.
      await openShell(page, { route: '/settings/troubleshooting' })
      await expect(page.getByTestId('m-settings-troubleshooting-diag-loading')).toHaveCount(0)
      await expect(page.getByTestId('m-settings-troubleshooting-read-at')).toHaveCount(0)
      await page.getByTestId('m-settings-troubleshooting-refresh').tap()
      // The figures are usually the same as before, so the page says when it read them again.
      await expect(page.getByTestId('m-settings-troubleshooting-read-at')).toContainText('Figures read again at')
      await expect(page.getByTestId('m-settings-troubleshooting-checked-at')).toHaveCount(0)
      await page.getByTestId('m-settings-troubleshooting-run').tap()
      await expect(page.getByTestId('m-settings-troubleshooting-checked-at')).toContainText('Checked again at')
      await expectClean(page)
      await expect(page.getByTestId('m-settings-troubleshooting-diag-loading')).toHaveCount(0)
      await expect(page.getByTestId('m-settings-troubleshooting-screen')).toContainText('App version')

      // Signed in without a plan: Voice says so and leads to the plans.
      await openSignedIn(page, '/settings/voice')
      await expect(page.getByTestId('m-settings-voice-state')).toHaveAttribute('data-state', 'no-plan')
      await expect(page.getByTestId('m-settings-voice-no-plan')).toBeVisible()
      await expectClean(page)
      const systemTest = page.getByTestId('m-settings-voice-test-system')
      if ((await systemTest.count()) > 0) {
        // The system voice of the browser: the button starts it and takes a second press without breaking.
        await systemTest.tap()
        await systemTest.tap()
        await expect(systemTest).toBeVisible()
      }
      await page.getByTestId('m-settings-voice-plans').tap()
      await expect(page.getByTestId('m-cloud-state')).toHaveAttribute('data-state', 'no-plan')

      // A plan without a credit budget: the gate waits and points to the account page.
      backend.plan = 'active'
      backend.credits = { limit: 0, used: 0 }
      await openShell(page, { route: '/cloud' })
      await expect(page.getByTestId('m-cloud-state')).toHaveAttribute('data-state', 'no-budget')
      await expect(page.getByTestId('m-cloud-wait')).toBeVisible()
      await expectClean(page)
      await page.getByTestId('m-cloud-open-account').tap()
      expect(await opened(page)).toContain(`${CLOUD}/account`)
      backend.credits = { limit: 1000, used: 250 }

      // Content policy: a failed read says so, and "Check again" reads it.
      backend.policyGetFails = true
      await openShell(page, { route: '/settings/content-policy' })
      await expect(page.getByTestId('m-settings-content-policy-load-failed')).toBeVisible()
      await expectClean(page)
      backend.policyGetFails = false
      await page.getByTestId('m-settings-content-policy-retry').tap()
      await expect(page.getByTestId('m-settings-content-policy-load-failed')).toHaveCount(0)
      await expect(page.getByTestId('m-settings-content-policy-soft')).toHaveAttribute('aria-checked', 'true')

      // Delete account: "Keep my account" closes the sheet and nothing is sent.
      await openShell(page, { route: '/settings/account' })
      await page.getByTestId('m-account-delete').tap()
      await expect(page.getByTestId('m-account-delete-explain')).toBeVisible()
      await page.getByTestId('m-account-delete-keep').tap()
      await expect(page.getByTestId('m-account-delete-explain')).toHaveCount(0)
      expect(backend.deleted).toBe(false)
      expect(backend.calls.filter((c) => c.includes('/api/account/delete'))).toEqual([])

      expect(backend.calls.filter((c) => c.startsWith('UNMOCKED'))).toEqual([])
    })

    test('Delete account: says what goes, wants the word typed, deletes on the server and signs out', async ({ page }) => {
      const backend = freshBackend({ deleteFails: true })
      await mockBackend(page, backend)
      await openShell(page, { route: '/settings/account' })
      // Signed out: where to delete, with the way on the website.
      await expect(page.getByTestId('m-account-delete-signed-out')).toContainText('sign in here first')
      await page.getByTestId('m-account-delete-website').tap()
      expect(await opened(page)).toContain(`${CLOUD}/delete-account`)
      await signIn(page)
      // Something on the phone that must survive.
      await openShell(page, { route: '/settings/data' })
      await pickFile(page, 'm-settings-data-restore', 'backup.json', SAMPLE_BACKUP)
      await page.getByTestId('m-settings-data-restore-confirm').tap()
      // The page says "restored" only once the chats are written, so the app can be opened again at once.
      await expect(page.getByTestId('m-toast-restore-done')).toBeVisible()
      await openShell(page, { route: '/settings/account' })

      await page.getByTestId('m-account-delete').tap()
      const sheet = page.getByTestId('m-sheet-settings-delete-account')
      await expect(sheet).toBeVisible()
      await expect(page.getByTestId('m-account-delete-explain')).toContainText('It cannot be undone.')
      await expect(page.getByTestId('m-account-delete-explain')).toContainText('Your plan and any credits that are left')
      await expect(page.getByTestId('m-account-delete-explain')).toContainText('Chats, models and settings on this phone stay.')
      await expect(page.getByTestId('m-account-delete-explain')).toContainText('A running subscription is cancelled together with the account.')
      await expectClean(page)

      // "Keep my account" in the question changes nothing.
      await page.getByTestId('m-account-delete-go-delete').tap()
      await expect(page.getByTestId('m-dialog-account-delete')).toContainText(EMAIL)
      await page.getByTestId('m-dialog-cancel').tap()
      expect(backend.calls.filter((c) => c.includes('/api/account/delete'))).toEqual([])

      // The word has to be typed.
      await page.getByTestId('m-account-delete-go-delete').tap()
      await expect(page.getByTestId('m-dialog-confirm')).toBeDisabled()
      await page.getByTestId('m-dialog-gate').fill('DELETE')
      expect(await layout(page)).toEqual(CLEAN)
      // A server that fails: nothing removed, still signed in, and the page says so.
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-account-delete-error')).toContainText('The account could not be deleted. Nothing was removed.')
      await expect(page.getByTestId('m-account-delete-error')).toContainText('hello@lu-labs.ai')
      await expect(page.getByTestId('m-account-delete-error-state')).toHaveAttribute('data-reason', 'server')
      await expect(page.getByTestId('m-account-delete-signin-again')).toHaveCount(0)
      await expect(page.getByTestId('m-account-signedin')).toBeVisible()
      expect(backend.deleted).toBe(false)
      backend.deleteFails = false

      // (Without network: see "Delete account without network" in the phone block below, where a session survives being offline.)

      // The server no longer takes the session: nothing deleted, and one button leads back to signing in.
      backend.deleteExpired = true
      backend.sessionDead = true
      await page.getByTestId('m-account-delete-go-delete').tap()
      await page.getByTestId('m-dialog-gate').fill('DELETE')
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-account-delete-error-state')).toHaveAttribute('data-reason', 'not-signed-in')
      await expect(page.getByTestId('m-account-delete-error')).toContainText('Your session has expired, so nothing was deleted.')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-account-delete-signin-again').tap()
      await expect(sheet).toHaveCount(0)
      await expect(page.getByTestId('m-account-session-expired')).toBeVisible()
      backend.deleteExpired = false
      backend.sessionDead = false
      await page.getByTestId('m-session-signin').tap()
      await signIn(page)
      expect(backend.deleted).toBe(false)
      await page.getByTestId('m-account-delete').tap()
      await expect(sheet).toBeVisible()

      await page.getByTestId('m-account-delete-go-delete').tap()
      await page.getByTestId('m-dialog-gate').fill('DELETE')
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-toast-account-deleted')).toHaveText('Your account is deleted')
      await expect(sheet).toHaveCount(0)
      await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
      expect(backend.deleted).toBe(true)
      // Not an iPhone: no Apple sheet and no code before the deletion (round 32).
      expect(backend.calls.filter((c) => c.includes('/api/account/apple-token'))).toEqual([])
      // Asked for, so not "session expired". And the phone kept its chats.
      await expect(page.getByTestId('m-account-session-expired')).toHaveCount(0)
      await expect.poll(() => chatCount(page)).toBe(2)
      await openShell(page, { route: '/settings/account' })
      await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
    })

    test('Contact and AI data sharing: About names support, privacy and terms; the consent can be given and withdrawn', async ({ page }) => {
      await mockBackend(page, freshBackend())
      await openShell(page, { route: '/settings/about' })
      await expect(page.getByTestId('m-settings-about-contact')).toContainText('hello@lu-labs.ai')
      await page.getByTestId('m-settings-about-contact').tap()
      await page.getByTestId('m-settings-about-privacy').tap()
      await page.getByTestId('m-settings-about-terms').tap()
      const links = await opened(page)
      expect(links).toContain('mailto:hello@lu-labs.ai')
      expect(links).toContain(`${CLOUD}/privacy`)
      expect(links).toContain(`${CLOUD}/terms`)
      await expectClean(page)

      await openShell(page, { route: '/settings/privacy' })
      const state = page.getByTestId('m-settings-privacy-ai-state')
      await expect(state).toHaveAttribute('data-allowed', 'no')
      await expect(page.getByTestId('m-settings-privacy-ai')).toContainText('Not allowed yet.')
      // "Not now" leaves it.
      await page.getByTestId('m-settings-privacy-ai-allow').tap()
      await expect(page.getByTestId('m-sheet-ai-consent')).toContainText('LU Cloud processes your content')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-consent-decline').tap()
      await expect(state).toHaveAttribute('data-allowed', 'no')
      await page.getByTestId('m-settings-privacy-ai-allow').tap()
      await page.getByTestId('m-consent-agree').tap()
      await expect(state).toHaveAttribute('data-allowed', 'yes')
      await expect(page.getByTestId('m-settings-privacy-ai')).toContainText('Allowed since')
      await expectClean(page)

      await openShell(page, { route: '/settings/privacy' })
      await expect(state).toHaveAttribute('data-allowed', 'yes')
      await page.getByTestId('m-settings-privacy-ai-withdraw-reset').tap()
      await expect(page.getByTestId('m-dialog-ai-consent-withdraw')).toContainText('Withdraw your consent?')
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(state).toHaveAttribute('data-allowed', 'no')
      await openShell(page, { route: '/settings/privacy' })
      await expect(state).toHaveAttribute('data-allowed', 'no')
    })

    test('Risk marks: what deletes or signs out says "destructive", what costs says "paid", and the ways out say nothing', async ({ page }) => {
      const backend = freshBackend()
      await mockBackend(page, backend)
      const risk = (id: string) => page.getByTestId(id).first().getAttribute('data-m-risk')
      const expectRisk = async (ids: string[], want: string | null) => {
        for (const id of ids) {
          await expect(page.getByTestId(id).first(), id).toBeVisible()
          await expect.poll(() => risk(id), { message: id }).toBe(want)
        }
      }
      // Signed out: the plans of the gate.
      await openShell(page, { route: '/cloud' })
      await expectRisk(['m-cloud-plan-hosted', 'm-cloud-plan-hosted-pro', 'm-cloud-plan-hosted-max'], 'paid')
      await expectRisk(['m-cloud-signin', 'm-cloud-not-now'], null)

      await openSignedIn(page, '/settings/account')
      await expectRisk(['m-account-signout', 'm-account-delete'], 'destructive')
      await expectRisk(['m-account-manage', 'm-account-buy'], 'paid')
      await expectRisk(['m-account-refresh'], null)
      // The sheet, with its button in the footer.
      await page.getByTestId('m-account-delete').tap()
      await expectRisk(['m-account-delete-go-delete'], 'destructive')
      await expectRisk(['m-account-delete-keep'], null)
      await page.getByTestId('m-account-delete-keep').tap()

      await openShell(page, { route: '/settings/voice' })
      await expectRisk(['m-settings-voice-test', 'm-settings-voice-preview-Wise_Woman', 'm-settings-voice-preview-Calm_Woman'], 'paid')
      expect(await risk('m-settings-voice-pick-Wise_Woman')).toBeNull()

      await openShell(page, { route: '/settings/chat' })
      await expectRisk(['m-settings-chat-reset'], 'destructive')
      await openShell(page, { route: '/settings/troubleshooting' })
      await expectRisk(['m-settings-troubleshooting-reset', 'm-settings-troubleshooting-setup'], 'destructive')
      await expectRisk(['m-settings-troubleshooting-run', 'm-settings-troubleshooting-self-test'], null)
      // The share sheet of the system is outside the app: its own mark, neither paid nor destructive.
      await expectRisk(['m-settings-troubleshooting-share-log', 'm-settings-troubleshooting-share-report'], 'leaves-app')

      // A control that appears later on a page that is already open is marked too.
      await openShell(page, { route: '/settings/data' })
      await expectRisk(['m-settings-data-all-delete'], 'destructive')
      await pickFile(page, 'm-settings-data-restore', 'backup.json', SAMPLE_BACKUP)
      await expectRisk(['m-settings-data-restore-confirm'], 'destructive')
      await expectRisk(['m-settings-data-restore-cancel', 'm-settings-data-backup-save'], null)
      await expectRisk(['m-settings-data-backup'], 'leaves-app')

      // The sheets of the resilience layer.
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:credits-exhausted', { detail: { reason: 'credits' } })))
      await expectRisk(['m-credits-plans'], 'paid')
      await expectRisk(['m-credits-not-now'], null)
      expect(await layout(page)).toEqual(CLEAN)
    })

    test('The profile picture is shown where the app shows the account', async ({ page }) => {
      await mockBackend(page, freshBackend())
      await openShell(page, { route: '/settings/appearance' })
      await expect(page.getByTestId('m-settings-appearance-picture')).toContainText('Shown on your account in Settings')
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAr7pYQ8AAAAASUVORK5CYII=', 'base64')
      await pickFile(page, 'm-settings-appearance-picture-choose', 'me.png', png, 'image/png')
      await expect(page.getByTestId('m-settings-appearance-picture')).toHaveAttribute('data-has', 'yes')

      await openShell(page, { route: '/settings/account' })
      await signIn(page)
      const onPage = page.getByTestId('m-account-avatar')
      await expect(onPage).toBeVisible()
      expect(await onPage.getAttribute('src')).toMatch(/^data:image\//)
      expect(await onPage.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
      await expectClean(page)

      // The card on top of Settings draws the same picture.
      await openSettingsRoot(page)
      const onCard = page.getByTestId('m-settings-account-avatar')
      await expect(onCard).toBeVisible()
      expect(await onCard.getAttribute('src')).toBe(await page.evaluate(async () => (((await import(/* @vite-ignore */ '/src/stores/settingsStore.ts' as string)) as typeof import('../../src/stores/settingsStore'))).useSettingsStore.getState().settings.userAvatarDataUrl))
      await expectClean(page)

      // Removed again: both places fall back to the plain icon.
      await page.getByTestId('m-settings-theme').tap()
      await page.getByTestId('m-settings-appearance-picture-remove').tap()
      await page.getByTestId('m-page-back').last().tap()
      await expect(page.getByTestId('m-settings-account-avatar')).toHaveCount(0)
      await page.getByTestId('m-settings-account').tap()
      await expect(page.getByTestId('m-account-signedin')).toBeVisible()
      await expect(page.getByTestId('m-account-avatar')).toHaveCount(0)
    })

    test('Voice of this phone: the voices come from one source, each can be heard, and the pick is what the chat reads', async ({ page }) => {
      await mockBackend(page, freshBackend())
      await fakePhoneVoice(page, ['Samantha', 'Daniel', 'Anna (de)'])
      await openShell(page, { route: '/settings/voice' })
      const section = page.getByTestId('m-settings-voice-phone')
      await expect(section).toHaveAttribute('data-source', 'web')
      await expect(page.getByTestId('m-settings-voice-phone-none')).toHaveCount(0)
      await expect(page.getByTestId('m-settings-voice-screen')).not.toContainText('no voice installed')
      // Signed out, and reading aloud is still a switch that works: the phone reads.
      await expect(page.getByTestId('m-settings-voice-read-aloud')).toBeEnabled()
      await expect(page.getByTestId('m-settings-voice-phone-pick-default')).toHaveAttribute('aria-checked', 'true')
      const list = page.getByTestId('m-settings-voice-phone-list')
      await expect(list).toContainText('Samantha')
      await expect(list).toContainText('Daniel')
      // Voices of another language wait behind "Show all".
      await expect(list).not.toContainText('Anna (de)')
      await page.getByTestId('m-settings-voice-phone-all').tap()
      await expect(list).toContainText('Anna (de)')
      await expectClean(page)

      // Hear one: the WebView is asked to say the preview with exactly that voice.
      await page.getByRole('button', { name: 'Preview Daniel' }).tap()
      await expect.poll(async () => (await spoken(page)).length).toBe(1)
      expect((await spoken(page))[0]).toMatchObject({ voice: 'Daniel', text: 'Hello. This is how I sound when I read an answer to you.' })
      // Pick it: saved where reading aloud in the chat looks it up, and it survives a reload.
      await list.locator('[data-m-id="Daniel"]').tap()
      await expect(list.locator('[data-m-id="Daniel"]')).toHaveAttribute('aria-checked', 'true')
      const saved = () => page.evaluate(() => (JSON.parse(localStorage.getItem('locally-uncensored-voice') ?? '{}') as { state?: { ttsVoice?: string } }).state?.ttsVoice)
      await expect.poll(saved).toBe('Daniel')
      await openShell(page, { route: '/settings/voice' })
      await expect(page.getByTestId('m-settings-voice-phone-list').locator('[data-m-id="Daniel"]')).toHaveAttribute('aria-checked', 'true')
      // "Test system voice" speaks with the pick, speed and pitch.
      await page.getByRole('button', { name: 'Increase Speed' }).tap()
      await page.getByTestId('m-settings-voice-test-system').tap()
      await expect.poll(async () => (await spoken(page)).length).toBe(1)
      expect((await spoken(page))[0]).toMatchObject({ voice: 'Daniel', rate: 1.1 })
      await expect(page.getByTestId('m-settings-voice-phone-failed')).toHaveCount(0)
    })

    test('No voice anywhere: only then the page says "no voice installed", and reading aloud is not a switch without effect', async ({ page }) => {
      await mockBackend(page, freshBackend())
      await fakePhoneVoice(page, null)
      await openShell(page, { route: '/settings/voice' })
      await expect(page.getByTestId('m-settings-voice-phone')).toHaveAttribute('data-source', 'none')
      await expect(page.getByTestId('m-settings-voice-phone-none')).toContainText('This phone has no voice installed.')
      await expect(page.getByTestId('m-settings-voice-intro')).toHaveText('Dictation and reading aloud run on LU Cloud. No voice was found on this phone.')
      await expect(page.getByTestId('m-settings-voice-signed-out')).toContainText('Sign in to use voice')
      await expect(page.getByTestId('m-settings-voice-phone-list')).toHaveCount(0)
      await expect(page.getByTestId('m-settings-voice-system')).toHaveCount(0)
      await expect(page.getByTestId('m-settings-voice-read-aloud')).toBeDisabled()
      await expect(page.getByTestId('m-settings-voice-read-aloud')).toContainText('Needs a voice.')
      await expect(page.getByTestId('m-settings-voice-auto')).toBeDisabled()
      await expectClean(page)
      // "Look again" asks again and comes to the same answer.
      await page.getByTestId('m-settings-voice-phone-again').tap()
      await expect(page.getByTestId('m-settings-voice-phone-none')).toBeVisible()
      // With LU Cloud there is a voice after all, so the switches work.
      await openSignedIn(page, '/settings/voice')
      await expect(page.getByTestId('m-settings-voice-read-aloud')).toBeEnabled()
    })

    test('Voice: dictation is a state with its reason, a blocked microphone is named, and the system voice switch writes what the chat reads', async ({ page }) => {
      const backend = freshBackend()
      await mockBackend(page, backend)
      await fakePhoneVoice(page, ['Samantha'])
      // The system refused the microphone for this app.
      await page.addInitScript(() => {
        const real = navigator.permissions?.query?.bind(navigator.permissions)
        if (!navigator.permissions) return
        navigator.permissions.query = ((what: PermissionDescriptor) => {
          if ((what as { name: string }).name === 'microphone' && sessionStorage.getItem('e2e-mic') === 'denied') {
            return Promise.resolve({ state: 'denied', addEventListener() {}, removeEventListener() {} } as unknown as PermissionStatus)
          }
          return real ? real(what) : Promise.reject(new Error('no permissions'))
        }) as typeof navigator.permissions.query
      })

      await openShell(page, { route: '/settings/voice' })
      const dictation = page.getByTestId('m-settings-voice-dictation-state')
      await expect(dictation).toHaveAttribute('data-state', 'signed-out')
      await expect(page.getByTestId('m-settings-voice-dictation')).toContainText('Off')
      await expect(page.getByTestId('m-settings-voice-dictation')).toContainText('Sign in to use it.')
      await expect(dictation).toContainText('There is no switch for dictation')
      // No switch that would switch nothing.
      await expect(page.getByTestId('m-settings-voice-dictation').getByRole('switch')).toHaveCount(0)
      await expectClean(page)

      await openSignedIn(page, '/settings/voice')
      await expect(dictation).toHaveAttribute('data-state', 'ready')
      await expect(page.getByTestId('m-settings-voice-dictation')).toContainText('On')
      await expect(page.getByTestId('m-settings-voice-mic-denied')).toHaveCount(0)

      // The preview says that it is loading while LU Cloud takes its time.
      backend.slowMs = 1200
      await page.getByTestId('m-settings-voice-preview-Wise_Woman').tap()
      // The first request to LU Cloud asks for the consent (M1).
      await page.getByTestId('m-consent-agree').tap()
      await expect(page.getByTestId('m-settings-voice-loading')).toBeVisible()
      await expect(page.getByTestId('m-settings-voice-loading')).toHaveCount(0)
      backend.slowMs = 0

      // The system voice: the switch says what it changes, and writes the key the chat reads.
      const system = page.getByTestId('m-settings-voice-system')
      if ((await system.count()) > 0) {
        const pref = () => page.evaluate(() => (JSON.parse(localStorage.getItem('lu-mobile-settings-prefs') ?? '{}') as { state?: { systemVoiceFallback?: boolean } }).state?.systemVoiceFallback)
        const allowed = () => page.evaluate(async () => (((await import(/* @vite-ignore */ '/src/lib/mobile-prefs.ts' as string)) as typeof import('../../src/lib/mobile-prefs'))).systemVoiceFallbackAllowed())
        await expect(system).toHaveAttribute('aria-checked', 'true')
        await expect(page.getByTestId('m-settings-voice-system-state')).toHaveText('While Cloud is off or does not answer, answers are read by the voice of this phone.')
        expect(await allowed()).toBe(true)
        await system.tap()
        await expect(page.getByTestId('m-settings-voice-system-state')).toHaveText('Reading aloud then only works with LU Cloud. Without it nothing is read.')
        await expect.poll(pref).toBe(false)
        expect(await allowed()).toBe(false)
        await expectClean(page)
        await system.tap()
        await expect.poll(pref).toBe(true)
      }

      // The microphone is blocked: said on top, the state follows, and the button leads to the system settings or says why not.
      await page.evaluate(() => sessionStorage.setItem('e2e-mic', 'denied'))
      await openShell(page, { route: '/settings/voice' })
      await expect(page.getByTestId('m-settings-voice-mic-denied')).toContainText('Microphone is blocked')
      await expect(dictation).toHaveAttribute('data-state', 'blocked')
      await expect(page.getByTestId('m-settings-voice-dictation')).toContainText('Allow it in the system settings of this phone.')
      await expectClean(page)
      await page.getByTestId('m-settings-voice-open-system').tap()
      await expect(page.getByTestId('m-toast-system-settings-failed')).toBeVisible()
      expect(backend.calls.filter((c) => c.startsWith('UNMOCKED'))).toEqual([])
    })

    test('The Cloud switch on the Chats root (G11): asks before it turns on, goes back in one tap, and counts through the same door', async ({ page }) => {
      const backend = freshBackend()
      await mockBackend(page, backend)
      const counted = () => backend.calls.filter((c) => c === 'POST cloud/api/funnel/switch').length
      const mode = () => page.evaluate(async () => (((await import(/* @vite-ignore */ '/src/stores/settingsStore.ts' as string)) as typeof import('../../src/stores/settingsStore'))).useSettingsStore.getState().settings.appMode)
      const openChats = async () => {
        await openShell(page)
        await page.getByTestId('m-page-back').tap()
        await page.getByTestId('m-nav-chat').tap()
        await expect(page.getByTestId('m-cloud-switch')).toBeVisible()
      }

      // Signed out: the switch leads to the gate, and nothing is switched.
      await openChats()
      const toggle = page.getByTestId('m-cloud-switch')
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await toggle.tap()
      await expect(page.getByTestId('m-cloud-screen')).toBeVisible()
      expect(await mode()).toBe('local')

      await page.getByTestId('m-cloud-signin').tap()
      await signIn(page)
      // The consent to send content to LU Cloud is asked once; here it was given before (the gate test covers the question).
      await page.evaluate(async () => (((await import(/* @vite-ignore */ '/src/mobile/policy/consent.ts' as string)) as typeof import('../../src/mobile/policy/consent'))).answerAiConsent(true))
      await openChats()
      await toggle.tap()
      await expect(page.getByTestId('m-dialog-cloud-switch')).toContainText('Switch to Cloud?')
      await page.getByTestId('m-dialog-cancel').tap()
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await toggle.tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-toast-cloud-on')).toBeVisible()
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      expect(await mode()).toBe('cloud')
      // One tap back, without a question.
      await toggle.tap()
      await expect(page.getByTestId('m-toast-cloud-off')).toHaveText('Back on device')
      await expect(page.getByTestId('m-dialog-cloud-switch')).toHaveCount(0)
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      expect(await mode()).toBe('local')

      // The calls other screens use are the same door: they count, and they respect the switch under Privacy.
      const before = counted()
      await page.evaluate(async () => {
        const { useSettingsStore } = ((await import(/* @vite-ignore */ '/src/stores/settingsStore.ts' as string)) as typeof import('../../src/stores/settingsStore'))
        const { leaveCloud } = ((await import(/* @vite-ignore */ '/src/mobile/screens/settings/parts/cloud-mode.ts' as string)) as typeof import('../../src/mobile/screens/settings/parts/cloud-mode'))
        useSettingsStore.getState().updateSettings({ appMode: 'cloud' })
        leaveCloud({ quiet: true })
      })
      // Counted anonymously through the native layer only (review M2): no count per account leaves the phone.
      await page.waitForTimeout(300)
      expect(counted()).toBe(0)
      expect(before).toBe(0)
      await expect(page.getByTestId('m-toast-cloud-off')).toHaveCount(0)
      await page.evaluate(async () => {
        const { useSettingsStore } = ((await import(/* @vite-ignore */ '/src/stores/settingsStore.ts' as string)) as typeof import('../../src/stores/settingsStore'))
        const { leaveCloud } = ((await import(/* @vite-ignore */ '/src/mobile/screens/settings/parts/cloud-mode.ts' as string)) as typeof import('../../src/mobile/screens/settings/parts/cloud-mode'))
        const { useMobilePrefs } = ((await import(/* @vite-ignore */ '/src/mobile/screens/settings/parts/prefs.ts' as string)) as typeof import('../../src/mobile/screens/settings/parts/prefs'))
        useMobilePrefs.getState().setPref('switchCounter', false)
        useSettingsStore.getState().updateSettings({ appMode: 'cloud' })
        leaveCloud({ quiet: true })
      })
      await page.waitForTimeout(300)
      expect(counted()).toBe(0)
      expect(await mode()).toBe('local')
    })

    test('The lines that show while something is read, and the ways out that need a special state', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      const backend = freshBackend()
      await mockBackend(page, backend)
      await openShell(page, { route: '/settings/account' })
      await signIn(page)

      // The account is read again: the page says that it is checking, then shows the account.
      // Long enough that the line is still there on a busy machine: the page has to load and draw inside this window.
      backend.slowMs = 3000
      await page.goto(shellUrl({ route: '/settings/account' }))
      await expect(page.getByTestId('m-account-checking')).toBeVisible()
      await expect(page.getByTestId('m-account-signedin')).toBeVisible()
      await expect(page.getByTestId('m-account-checking')).toHaveCount(0)
      await page.goto(shellUrl({ route: '/cloud' }))
      await expect(page.getByTestId('m-cloud-checking')).toBeVisible()
      await expect(page.getByTestId('m-cloud-state')).toHaveAttribute('data-state', 'ready')
      await page.goto(shellUrl({ route: '/settings/content-policy' }))
      await expect(page.getByTestId('m-settings-content-policy-loading')).toBeVisible()
      await expect(page.getByTestId('m-settings-content-policy-state')).toHaveAttribute('data-state', 'ready')
      await expect(page.getByTestId('m-settings-content-policy-loading')).toHaveCount(0)
      backend.slowMs = 0

      // A provider key from the clipboard: "Paste" fills the field, and the key is saved without ever being shown.
      const KEY = 'gsk_mock_key_from_the_clipboard_0123456789'
      await openShell(page, { route: '/settings/providers' })
      await page.getByTestId('m-settings-providers-row-anthropic').tap()
      await expect(page.getByTestId('m-settings-provider-note')).toBeVisible()
      await page.evaluate((key) => navigator.clipboard.writeText(`  ${key}\n`), KEY)
      await page.getByTestId('m-settings-provider-key-paste').tap()
      await expect(page.getByTestId('m-settings-provider-key')).toHaveValue(KEY)
      await expect(page.getByTestId('m-settings-provider-key')).toHaveAttribute('type', 'password')
      await page.getByTestId('m-settings-provider-key-save').tap()
      await keySavedNoteAway(page)
      await expect(page.getByTestId('m-settings-provider-state')).toHaveAttribute('data-key', 'saved')
      expect(await page.content()).not.toContain(KEY)
      await page.getByTestId('m-settings-provider-test').tap()
      await expect(page.getByTestId('m-settings-provider-test-ok')).toBeVisible()
      expect(backend.providerAuth.at(-1)).toBe(KEY)
      await page.evaluate(() => navigator.clipboard.writeText(''))

      // Signing out with memories that are not synced asks about exactly that, and "Sync first" leads to them.
      await openShell(page, { route: '/settings/account' })
      await expect(page.getByTestId('m-account-signedin')).toBeVisible()
      const seedMemory = () =>
        page.evaluate(async () => {
          const { useMemoryStore } = ((await import(/* @vite-ignore */ '/src/stores/memoryStore.ts' as string)) as typeof import('../../src/stores/memoryStore'))
          const entry = { id: 'e2e-memory-1', type: 'user', title: 'Likes tea', description: 'Drinks tea in the morning', content: 'Drinks tea in the morning.', tags: [], createdAt: 1, updatedAt: 1, source: 'manual' }
          useMemoryStore.setState({ activeMemoryOwner: 'user-1', entries: [entry], memorySyncBaselines: {} } as never)
        })
      await seedMemory()
      await page.getByTestId('m-account-signout').tap()
      await expect(page.getByTestId('m-dialog-signout-unsynced')).toContainText('1 memory is not synced yet. Sign out anyway?')
      await expect(page.getByTestId('m-dialog-cancel')).toHaveText('Sync first')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-dialog-cancel').tap()
      await expect(page.getByTestId('m-settings-memory-screen')).toBeVisible()
      await page.getByTestId('m-page-back').last().tap()
      await expect(page.getByTestId('m-account-signedin')).toBeVisible()

      // A sign out that cannot reach the server: either the session is gone from this phone, or the page says that it is not.
      backend.logoutDown = true
      await seedMemory()
      await page.getByTestId('m-account-signout').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      // Wait for the end of the attempt. Right after the tap the page still says signed-in, because the sign out is
      // running: reading the state then took that for "stayed signed in" and waited for an error that a sign out
      // finishing on the phone never shows (1 of a CI-like run without retries).
      // An attempt ends either with the notice (still signed in) or signed out; AccountPage has no third way.
      await expect.poll(async () => {
        if (await page.getByTestId('m-account-signout-error').isVisible().catch(() => false)) return 'error'
        return page.getByTestId('m-account-state').getAttribute('data-state').catch(() => null)
      }).toMatch(/^(error|signed-out)$/)
      const state = await page.getByTestId('m-account-state').getAttribute('data-state')
      if (state === 'signed-in') await expect(page.getByTestId('m-account-signout-error')).toContainText('Sign out did not finish.')
      else await expect(page.getByTestId('m-account-signout-error')).toHaveCount(0)
      expect(backend.calls.filter((c) => c.startsWith('UNMOCKED'))).toEqual([])
    })

    test('Import of a large export: the progress is shown, "Cancel" stops it, and what was imported until then is written', async ({ page }) => {
      await mockBackend(page, freshBackend())
      const TOTAL = 6000
      const big = JSON.stringify(
        Array.from({ length: TOTAL }, (_, i) => ({
          title: `Chat ${i}`,
          create_time: 1767225600 + i,
          mapping: {
            root: { id: 'root', message: null, parent: null, children: ['a'] },
            a: { id: 'a', parent: 'root', children: [], message: { author: { role: 'user' }, content: { content_type: 'text', parts: [`Question ${i}`] } } },
          },
        })),
      )
      await openShell(page, { route: '/settings/data/import' })
      await pickFile(page, 'm-settings-data-import-choose', 'conversations.json', big)
      await expect(page.getByTestId('m-settings-data-import-found')).toContainText(/6.?000 chats found/)
      await page.getByTestId('m-settings-data-import-run').tap()
      await expect(page.getByTestId('m-settings-data-import-progress')).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-settings-data-import-cancel').tap()
      const done = page.getByTestId('m-settings-data-import-done')
      await expect(done).toContainText(/Stopped\. [\d.,\s]+ chats? imported\./)
      await expect(page.getByTestId('m-settings-data-import-not-saved')).toHaveCount(0)
      const said = Number(((await done.innerText()).match(/Stopped\. ([\d.,\s]+) chat/)?.[1] ?? '').replace(/\D/g, ''))
      expect(said).toBeGreaterThan(0)
      expect(said).toBeLessThan(TOTAL)
      // Exactly what the page said is on the phone after the app is opened again at once.
      await openShell(page, { route: '/settings/data' })
      await expect.poll(() => chatCount(page)).toBe(said)
    })

    // Check on the iPhone, round 22, N10: at the largest text the address ran out of the box, and an attempt that
    // ended in "took too long to answer" stood there as a desktop.
    test('Remote desktop: an attempt that failed is no desktop, and the address of a real one breaks inside its box at the largest text', async ({ page }) => {
      const backend = freshBackend()
      await mockBackend(page, backend)
      await page.route(/^http:\/\/192\.168\.250\.250:11435\//, (route) => route.abort('connectionrefused'))
      await openShell(page, { route: '/settings/remote', fontScale: 200 })
      const state = page.getByTestId('m-settings-remote-state')
      await expect(state).toHaveAttribute('data-state', 'unpaired')
      const put = (pairedAt: number | null) =>
        page.evaluate(async (paired) => {
          const { getRemoteClientStore } = ((await import(/* @vite-ignore */ '/src/mobile/remote/remoteClientStore.ts' as string)) as { getRemoteClientStore: () => { useStore: { setState: (state: never) => void } } })
          const connection = { baseUrl: 'http://192.168.178.20:11435', address: '192.168.178.20:11435', route: 'lan', secure: false, pairedAt: paired, lastOkAt: paired, serverVersion: '', hostName: '' }
          getRemoteClientStore().useStore.setState({ connection, status: 'offline', token: '' } as never)
        }, pairedAt)

      // What a failed attempt leaves in memory: the page of the attempt needs it, this page does not show it as a desktop.
      await put(null)
      await expect(state).toHaveAttribute('data-state', 'unpaired')
      await expect(page.getByTestId('m-settings-remote-status')).toContainText('Not connected')
      await expect(page.getByTestId('m-settings-remote-status')).not.toContainText('192.168.178.20')
      await expect(page.getByTestId('m-settings-remote-forget-delete')).toHaveCount(0)
      await expect(page.getByTestId('m-settings-remote-retry')).toHaveCount(0)
      await expect(page.getByTestId('m-settings-remote-connect')).toBeVisible()

      // A desktop that worked once and does not answer now: named, and its address stays inside the box.
      await put(1_700_000_000_000)
      await expect(state).toHaveAttribute('data-state', 'offline')
      const box = page.getByTestId('m-settings-remote-status')
      await expect(box).toContainText('192.168.178.20:11435 does not answer right now')
      await expect(page.getByTestId('m-settings-remote-forget-delete')).toBeVisible()
      for (const width of [320, 375, 402]) {
        await page.setViewportSize({ width, height: 800 })
        const measured = await box.evaluate((el) => {
          const outer = el.getBoundingClientRect()
          const title = el.querySelector('.m-note-title') as HTMLElement
          // The ink of the title: every line box of its text.
          const range = document.createRange()
          range.selectNodeContents(title)
          const rects = Array.from(range.getClientRects())
          return {
            right: Math.max(...rects.map((r) => r.right)),
            left: Math.min(...rects.map((r) => r.left)),
            boxLeft: outer.left,
            boxRight: outer.right,
            lines: new Set(rects.map((r) => Math.round(r.top))).size,
            screen: document.documentElement.clientWidth,
            wrap: getComputedStyle(title).overflowWrap,
          }
        })
        expect(measured.wrap, `at ${width}`).toBe('anywhere')
        expect(measured.right, `at ${width}: ${JSON.stringify(measured)}`).toBeLessThanOrEqual(measured.boxRight + 0.5)
        expect(measured.left, `at ${width}`).toBeGreaterThanOrEqual(measured.boxLeft - 0.5)
        expect(measured.boxRight, `at ${width}`).toBeLessThanOrEqual(measured.screen + 0.5)
      }
      expect(await layout(page)).toEqual(CLEAN)
    })

    test('Remote desktop with a paired computer: retry when it is out of reach, the chats and disconnect when it is there, and forget', async ({ page }) => {
      const backend = freshBackend()
      await mockBackend(page, backend)
      // The paired computer of this test does not exist: whatever asks it gets no answer.
      await page.route(/^http:\/\/192\.168\.7\.20:8765\//, (route) => {
        backend.calls.push(`REMOTE ${new URL(route.request().url()).pathname}`)
        return route.abort('connectionrefused')
      })
      await openShell(page, { route: '/settings/remote' })
      await expect(page.getByTestId('m-settings-remote-state')).toHaveAttribute('data-state', 'unpaired')
      const put = (status: string) =>
        page.evaluate(async (wanted) => {
          const { getRemoteClientStore } = ((await import(/* @vite-ignore */ '/src/mobile/remote/remoteClientStore.ts' as string)) as { getRemoteClientStore: () => { useStore: { setState: (state: never) => void } } })
          const connection = { baseUrl: 'http://192.168.7.20:8765', address: '192.168.7.20:8765', route: 'lan', secure: false, pairedAt: 1_700_000_000_000, lastOkAt: 1_700_000_000_000, serverVersion: '1.0.0' }
          getRemoteClientStore().useStore.setState({ connection, status: wanted, token: 'mock-remote-token' } as never)
        }, status)
      const state = page.getByTestId('m-settings-remote-state')

      // Out of reach: "Try again" asks the computer once more, and the page stays honest about the answer.
      await put('offline')
      await expect(state).toHaveAttribute('data-state', 'offline')
      await expect(page.getByTestId('m-settings-remote-forget-delete')).toBeVisible()
      await expectClean(page)
      const asked = backend.calls.filter((c) => c.startsWith('REMOTE')).length
      await page.getByTestId('m-settings-remote-retry').tap()
      await expect.poll(() => backend.calls.filter((c) => c.startsWith('REMOTE')).length).toBeGreaterThan(asked)
      await expect(state).toHaveAttribute('data-state', 'offline')
      // The tap has an answer the user can see, also when the check fails at once (acceptance Android, W5, N15).
      await expect(page.getByTestId('m-toast-remote-still-offline')).toContainText('192.168.7.20:8765 still does not answer')
      await expect(page.getByTestId('m-settings-remote-connect')).toBeVisible()

      // Connected: the chats are one tap away, and "Disconnect" ends the link but keeps the computer.
      await put('connected')
      await expect(state).toHaveAttribute('data-state', 'connected')
      await expectClean(page)
      await page.getByTestId('m-settings-remote-open-chats').tap()
      await expect(page.getByTestId('m-nav-chat')).toHaveAttribute('aria-selected', 'true')
      await page.getByTestId('m-nav-settings').tap()
      await page.getByTestId('m-settings-remote').tap()
      await expect(state).toHaveAttribute('data-state', 'connected')
      await page.getByTestId('m-settings-remote-disconnect').tap()
      await expect(page.getByTestId('m-toast-remote-disconnected')).toBeVisible()
      await expect(state).not.toHaveAttribute('data-state', 'connected')
      await expect(page.getByTestId('m-settings-remote-forget-delete')).toBeVisible()

      // Forget: a question first, then the computer is gone from this phone.
      await page.getByTestId('m-settings-remote-forget-delete').tap()
      await expect(page.getByTestId('m-dialog-remote-forget')).toBeVisible()
      await page.getByTestId('m-dialog-cancel').tap()
      await expect(page.getByTestId('m-settings-remote-forget-delete')).toBeVisible()
      await page.getByTestId('m-settings-remote-forget-delete').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-toast-remote-forgotten')).toBeVisible()
      await expect(state).toHaveAttribute('data-state', 'unpaired')
      await expect(page.getByTestId('m-settings-remote-forget-delete')).toHaveCount(0)
      expect(backend.calls.filter((c) => c.startsWith('UNMOCKED'))).toEqual([])
    })

    for (const store of ['open', 'play', 'appstore'] as const) {
      test(`Store preset ${store}: buying surfaces and content levels follow the store`, async ({ page }) => {
        const backend = freshBackend({ plan: 'none' })
        await mockBackend(page, backend)
        const links = store === 'open'
        const text = store === 'play'
        const WORDS = /pricing|checkout|View plans|Choose |Manage subscription|Add credits|Pay open invoice|paid plans|Cancel anytime/i

        // The gate, signed out.
        await openInStore(page, store, '/cloud')
        await expect(page.getByTestId('m-cloud-state')).toHaveAttribute('data-state', 'signed-out')
        await expect(page.getByTestId('m-cloud-plans')).toHaveCount(links ? 1 : 0)
        await expect(page.getByTestId('m-cloud-plans-text')).toHaveCount(text ? 1 : 0)
        if (text) await expect(page.getByTestId('m-cloud-plans-text')).toHaveText('Plans and credits are available on lu-labs.ai.')
        if (!links) await expect(page.getByTestId('m-cloud-screen').getByRole('button', { name: /Choose/ })).toHaveCount(0)
        if (store === 'appstore') expect(await page.getByTestId('m-cloud-screen').innerText()).not.toMatch(WORDS)
        // Model counts only where the build lists the whole catalogue; the App Store build leaves models out and names no number (Apple 2.3.1).
        // Round 51: one number band (parts/cloud-counts.ts), the total large and the parts small.
        // Since r56 (18.10.2026, Option c) the Play build leaves the same models out, so it names no number either.
        const band = page.getByTestId('m-cloud-count')
        if (store !== 'open') {
          await expect(band).toContainText('Chat, image and video models on LU hardware')
          expect(await band.innerText()).not.toMatch(/\d/)
        } else {
          await expect(band.getByTestId('m-cloud-count-total')).toHaveText(/^\d+$/)
          await expect(band.getByTestId('m-cloud-count-split')).toContainText(/\d+ chat/)
          await expect(band.getByTestId('m-cloud-measured')).toHaveCount(1)
        }
        await expectClean(page)

        // The account without a plan, then with a failed payment.
        await openInStore(page, store, '/settings/account')
        await signIn(page)
        // A build without buy links speaks of LU Cloud being active or not, and names no plan (switch pricingWords).
        await expect(page.getByTestId('m-account-plan')).toContainText(links ? 'No active plan' : 'Not active')
        await expect(page.getByTestId('m-account-manage')).toHaveCount(links ? 1 : 0)
        await expect(page.getByTestId('m-account-api-keys')).toHaveCount(links ? 1 : 0)
        await expect(page.getByTestId('m-account-plans-text')).toHaveCount(text ? 1 : 0)
        // Account deletion is there in every store.
        await expect(page.getByTestId('m-account-delete')).toBeVisible()
        backend.plan = 'past-due'
        await page.getByTestId('m-account-refresh').tap()
        await expect(page.getByTestId('m-account-past-due')).toBeVisible()
        await expect(page.getByTestId('m-account-pay-invoice')).toHaveCount(links ? 1 : 0)
        if (store === 'appstore') {
          await expect(page.getByTestId('m-account-past-due')).toHaveText('LU Cloud is paused for this account.')
          expect(await page.getByTestId('m-account-screen').innerText()).not.toMatch(WORDS)
        }
        await expectClean(page)

        // With a plan: the state of plan and credits is shown in every store.
        backend.plan = 'active'
        await page.getByTestId('m-account-refresh').tap()
        await expect(page.getByTestId('m-account-credits')).toBeVisible()
        await expect(page.getByTestId('m-account-plan')).toContainText(links ? 'Hosted' : 'Active')
        if (!links) await expect(page.getByTestId('m-account-plan')).not.toContainText('Hosted')
        await expect(page.getByTestId('m-account-buy')).toHaveCount(links ? 1 : 0)
        await expect(page.getByTestId('m-account-manage')).toHaveCount(links ? 1 : 0)
        if (store === 'appstore') expect(await page.getByTestId('m-account-screen').innerText()).not.toMatch(WORDS)

        // Credits empty.
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:credits-exhausted', { detail: { reason: 'credits' } })))
        const sheet = page.getByTestId('m-account-credits-empty')
        await expect(sheet).toContainText("You're out of credits")
        await expect(page.getByTestId('m-credits-plans')).toHaveCount(links ? 1 : 0)
        await expect(page.getByTestId('m-credits-plans-text')).toHaveCount(text ? 1 : 0)
        if (store === 'appstore') expect(await sheet.innerText()).not.toMatch(/bought|pack|plan|pricing|renew/i)
        expect(await layout(page)).toEqual(CLEAN)
        await page.getByTestId('m-credits-not-now').tap()
        if (!links) expect((await opened(page)).filter((l) => /pricing|checkout/.test(l))).toEqual([])

        // What does this cost (G13), for a Cloud model with no credits left: a button, one sentence, or neither.
        backend.credits = { limit: 1000, used: 1000 }
        await page.getByTestId('m-account-refresh').tap()
        await expect(page.getByTestId('m-account-signedin')).toContainText('0 left')
        await page.evaluate(async () => {
          const { useModelStore } = ((await import(/* @vite-ignore */ '/src/stores/modelStore.ts' as string)) as typeof import('../../src/stores/modelStore'))
          const { nav } = ((await import(/* @vite-ignore */ '/src/mobile/nav/index.ts' as string)) as typeof import('../../src/mobile/nav/index'))
          const model = { name: 'lu-cloud::e2e-large', provider: 'lu-cloud', providerName: 'LU Cloud', model: 'e2e-large', size: 0, type: 'text' }
          // The model list is read again whenever the account changes. The row of this test is put back each time.
          // The chosen model stays what the mode allows; the sheet is asked about this row by name.
          const put = () => {
            const now = useModelStore.getState()
            if (now.models.some((m) => m.name === model.name)) return
            useModelStore.setState({ models: [...now.models, model] } as never)
          }
          put()
          useModelStore.subscribe(put)
          nav.openSheet('price', { model: model.name })
        })
        const price = page.getByTestId('m-sheet-price')
        await expect(price).toBeVisible()
        await expect(page.getByTestId('m-price-kind')).toHaveAttribute('data-kind', 'credits')
        await expect(price).toContainText(store === 'appstore' ? 'No credits are left.' : 'No credits are left this period.')
        await expect(page.getByTestId('m-price-plans')).toHaveCount(links ? 1 : 0)
        await expect(page.getByTestId('m-price-plans-text')).toHaveCount(text ? 1 : 0)
        if (text) await expect(page.getByTestId('m-price-plans-text')).toHaveText('Plans and credits are available on lu-labs.ai.')
        if (store === 'appstore') expect(await price.innerText()).not.toMatch(/bought|pack|\bplans?\b|pricing|renew|lu-labs\.ai/i)
        expect(await layout(page)).toEqual(CLEAN)
        if (links) {
          await page.getByTestId('m-price-plans').tap()
          expect(await opened(page)).toContain(`${CLOUD}/pricing`)
        }
        await page.getByTestId('m-price-close').tap()
        await expect(price).toHaveCount(0)
        backend.credits = { limit: 1000, used: 250 }

        // Content policy.
        await openInStore(page, store, '/settings/content-policy')
        const state = page.getByTestId('m-settings-content-policy-state')
        await expect(state).toHaveAttribute('data-state', 'ready')
        if (store === 'open') {
          await expect(page.getByTestId('m-settings-content-policy-off')).toBeVisible()
          await expect(page.getByTestId('m-settings-content-policy-strict')).toBeVisible()
        }
        if (store === 'play') {
          await expect(page.getByTestId('m-settings-content-policy-strict')).toBeVisible()
          await expect(page.getByTestId('m-settings-content-policy-soft')).toBeVisible()
          await expect(page.getByTestId('m-settings-content-policy-off')).toHaveCount(0)
          await expect(page.getByTestId('m-settings-content-policy-off-elsewhere')).toHaveCount(0)
          await page.getByTestId('m-settings-content-policy-strict').tap()
          await expect(state).toHaveAttribute('data-policy', 'strict')
          // The account was set to "Off" somewhere else: this build cannot offer it, and says so instead of showing nothing picked.
          backend.policy = 'off'
          await openInStore(page, store, '/settings/content-policy')
          await expect(state).toHaveAttribute('data-state', 'ready')
          await expect(page.getByTestId('m-settings-content-policy-off-elsewhere')).toBeVisible()
          await expect(page.getByTestId('m-settings-content-policy-off-elsewhere')).toContainText('In this app Create uses the Standard filter anyway.')
          await expect(page.getByTestId('m-settings-content-policy-off')).toHaveCount(0)
          await expectClean(page)
          await page.getByTestId('m-settings-content-policy-soft').tap()
          await expect(state).toHaveAttribute('data-policy', 'soft')
          await expect(page.getByTestId('m-settings-content-policy-off-elsewhere')).toHaveCount(0)
        }
        if (store === 'appstore') {
          await expect(page.getByTestId('m-settings-content-policy-list')).toHaveCount(0)
          await expect(page.getByTestId('m-settings-content-policy-fixed')).toHaveText('Standard')
          await expect(page.getByTestId('m-settings-content-policy-fixed-text')).toHaveText('In this app Create always uses the Standard filter, or Strict when the account is set to it.')
          // No purchase, so no link either.
          await expect(page.getByTestId('m-settings-content-policy-fixed-open')).toHaveCount(0)
          expect(backend.calls.filter((c) => c === 'PUT cloud/api/account/content-policy')).toEqual([])
        }
        await expectClean(page)

        // Session expired (G6): the sheet has two ways on and says nothing about buying, in every store.
        await openInStore(page, store, '/settings/account')
        await expect(page.getByTestId('m-account-signedin')).toBeVisible()
        backend.sessionDead = true
        await page.getByTestId('m-account-refresh').tap()
        const expired = page.getByTestId('m-account-session-expired')
        await expect(expired).toBeVisible()
        await expect(page.getByTestId('m-session-signin')).toBeVisible()
        await expect(page.getByTestId('m-session-on-device')).toBeVisible()
        expect(await expired.innerText()).not.toMatch(/bought|pack|\bplans?\b|pricing|renew|credits|lu-labs\.ai/i)
        await expect(expired.getByRole('button', { name: /plan|credit|pricing/i })).toHaveCount(0)
        expect(await layout(page)).toEqual(CLEAN)
        expect(backend.calls.filter((c) => c.startsWith('UNMOCKED'))).toEqual([])
      })
    }
  })
}

// The way back from the browser. A phone is told apart by its user agent, so this block runs as one.
// Re-check Android 8 GB, A-22 a. A custom endpoint that has a key already is a long page: the switch at the top, the
// address, the key field, "Replace key", "Remove key", "Test connection", "Remove provider". With the page scrolled to
// its end, "Key saved" lay on "Test connection" (toast 714 to 766, button 694 to 738), and the top was taken by the
// switch. The toast now takes the room between the controls.
for (const phone of [
  { name: '412x915, the phone of the report', width: 412, height: 915 },
  { name: '390x844', width: 390, height: 844 },
  { name: '320x568', width: 320, height: 568 },
] as const) {
  test.describe(`settings, "Key saved" and the buttons under the field, ${phone.name}`, () => {
    test.use({ viewport: { width: phone.width, height: phone.height } })

    test('replacing the key of a custom endpoint: the note lies on no control, wherever the page stands', async ({ page }) => {
      const backend = freshBackend()
      await mockBackend(page, backend)
      await openShell(page, { route: '/settings/providers' })
      await page.getByTestId('m-settings-providers-row-custom').tap()
      await page.getByTestId('m-settings-provider-url').fill('https://api.groq.com/openai/v1')
      await page.getByTestId('m-settings-provider-url-save').tap()
      await expect(page.getByTestId('m-toast-provider-url-saved')).toBeVisible()
      await page.getByTestId('m-settings-provider-key').fill('custom-mock-key-0123456789')
      await page.getByTestId('m-settings-provider-key-save').tap()
      await keySavedNoteAway(page)
      const state = page.getByTestId('m-settings-provider-state')
      await expect(state).toHaveAttribute('data-key', 'saved')

      const body = page.locator('[data-testid="m-settings-provider-screen"] .m-body')
      const places: string[] = []
      // The end of the page (the picture of the report), its top, and the middle.
      for (const where of ['end', 'top', 'middle'] as const) {
        await body.evaluate((el, at) => el.scrollTo(0, at === 'end' ? el.scrollHeight : at === 'top' ? 0 : (el.scrollHeight - el.clientHeight) / 2), where)
        const field = page.getByTestId('m-settings-provider-key')
        await field.scrollIntoViewIfNeeded()
        await field.fill(`replaced-mock-key-${where}-0123456789`)
        if (where === 'end') await body.evaluate((el) => el.scrollTo(0, el.scrollHeight))
        const save = page.getByTestId('m-settings-provider-key-save')
        await save.scrollIntoViewIfNeeded()
        await save.tap()
        const note = page.getByTestId('m-toast-provider-key-saved')
        await expect(note).toBeVisible()
        // At once, and again when the page has settled (the kit measures a second time after 350 ms).
        expect(await controlsUnderToast(page, 'm-toast-provider-key-saved'), `${where}, at once`).toEqual([])
        await page.waitForTimeout(450)
        if ((await note.count()) > 0) expect(await controlsUnderToast(page, 'm-toast-provider-key-saved'), `${where}, settled`).toEqual([])
        places.push((await page.locator('.m-toast-layer').getAttribute('data-place').catch(() => null)) ?? 'gone')
        // The button somebody needs next takes the tap while the note is still there.
        const test = page.getByTestId('m-settings-provider-test')
        await test.scrollIntoViewIfNeeded()
        await page.waitForTimeout(400)
        if ((await note.count()) > 0) expect(await controlsUnderToast(page, 'm-toast-provider-key-saved'), `${where}, after scrolling to the button`).toEqual([])
        await test.tap()
        await expect(page.getByTestId('m-settings-provider-test-ok')).toHaveText('Connected. 3 models found.')
        await expect(note).toHaveCount(0, { timeout: 8000 })
      }
      // On a page this full neither end is free at every stop: the room between the controls was used at least once.
      expect(places, places.join(' ')).toContain('gap')
    })
  })
}

test.describe('settings, sign in through the browser', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' })

  test('Continue with Google opens the browser, and the link that comes back finishes the sign in', async ({ page }) => {
    const backend = freshBackend()
    await mockBackend(page, backend)
    await openShell(page, { route: '/settings/account' })
    await page.getByTestId('m-account-google').tap()
    await expect(page.getByTestId('m-account-oauth-waiting')).toContainText('Waiting for your browser.')
    expect(await layout(page)).toEqual(CLEAN)

    // The provider page went to the system browser, with the app link as the way back.
    const link = (await opened(page)).find((l) => l.startsWith(`${AUTH}/auth/v1/authorize`)) ?? ''
    expect(link).toContain('provider=google')
    expect(decodeURIComponent(link)).toContain('redirect_to=lu://oauth/callback')
    expect(link).toContain('code_challenge=')

    // The system hands the link to the app. The user started this sign in a moment ago, so it is finished without a second question.
    expect(backend.calls.some((c) => c.includes('grant_type=pkce'))).toBe(false)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:deep-link', { detail: { url: 'lu://oauth/callback?code=mock-oauth-code' } })))
    await expect(page.getByTestId('m-account-signedin')).toBeVisible()
    await expect(page.getByTestId('m-sheet-link-offer')).toHaveCount(0)
    await expect(page.getByTestId('m-account-email-shown')).toHaveText(EMAIL)
    expect(backend.calls.some((c) => c.includes('grant_type=pkce'))).toBe(true)
    expect(await layout(page)).toEqual(CLEAN)
  })

  // Round 43: the account server led the browser to the website instead of back into the app (check on the Android phone, 15.10.2026).
  test('back in LU by hand and no link came: one sentence with "Try again", the wait ends, email and password stay right there', async ({ page }) => {
    const backend = freshBackend()
    await mockBackend(page, backend)
    await openShell(page, { route: '/settings/account' })
    await page.getByTestId('m-account-google').tap()
    await expect(page.getByTestId('m-account-oauth-waiting')).toContainText('Waiting for your browser.')
    await page.evaluate(() => {
      window.dispatchEvent(new Event('lu:background'))
      window.dispatchEvent(new Event('lu:foreground'))
    })
    const box = page.getByTestId('m-account-oauth-not-back')
    await expect(box).toHaveText(/Sign-in did not come back to LU\. Try again, or sign in with your email and password\./)
    await expect(page.getByTestId('m-account-oauth-waiting')).toHaveCount(0)
    await expect(page.getByTestId('m-account-google')).not.toHaveAttribute('aria-busy', 'true')
    await expect(page.getByTestId('m-account-email')).toBeVisible()
    await expect(page.getByTestId('m-account-password')).toBeVisible()
    expect(await layout(page)).toEqual(CLEAN)

    // "Try again" opens the browser once more; this time the link comes and signs in.
    await page.getByTestId('m-account-oauth-not-back-retry').tap()
    await expect(box).toHaveCount(0)
    await expect(page.getByTestId('m-account-oauth-waiting')).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:deep-link', { detail: { url: 'lu://oauth/callback?code=mock-oauth-code' } })))
    await expect(page.getByTestId('m-account-signedin')).toBeVisible()
  })

  test('back in LU together with the link: signed in, and no word about a link that did not come', async ({ page }) => {
    const backend = freshBackend()
    await mockBackend(page, backend)
    await openShell(page, { route: '/settings/account' })
    await page.getByTestId('m-account-github').tap()
    await expect(page.getByTestId('m-account-oauth-waiting')).toBeVisible()
    await page.evaluate(() => {
      window.dispatchEvent(new Event('lu:background'))
      window.dispatchEvent(new Event('lu:foreground'))
      window.dispatchEvent(new CustomEvent('lu:deep-link', { detail: { url: 'lu://oauth/callback?code=mock-oauth-code' } }))
    })
    await expect(page.getByTestId('m-account-signedin')).toBeVisible()
    await page.waitForTimeout(2500)
    await expect(page.getByTestId('m-account-oauth-not-back')).toHaveCount(0)
  })

  test('Forgot password: back in LU and the link of the mail did not come, the sheet asks and offers "Try again"', async ({ page }) => {
    const backend = freshBackend()
    await mockBackend(page, backend)
    await openShell(page, { route: '/settings/account' })
    await page.getByTestId('m-account-email').fill(EMAIL)
    await page.getByTestId('m-account-forgot').tap()
    await page.getByTestId('m-account-reset-send').tap()
    await expect(page.getByTestId('m-account-reset-sent')).toBeVisible()
    await page.evaluate(() => {
      window.dispatchEvent(new Event('lu:background'))
      window.dispatchEvent(new Event('lu:foreground'))
    })
    await expect(page.getByTestId('m-account-reset-not-back')).toContainText('Did the link open a web page instead of LU?')
    expect(await layout(page)).toEqual(CLEAN)
    const asked = () => backend.calls.filter((c) => c.startsWith('POST auth/auth/v1/recover')).length
    const before = asked()
    await page.getByTestId('m-account-reset-not-back-retry').tap()
    await expect.poll(asked).toBe(before + 1)
    await expect(page.getByTestId('m-account-reset-not-back')).toHaveCount(0)
  })

  test('an Android phone has no "Sign in with Apple", and the sentence about the same way to sign in stands under the buttons', async ({ page }) => {
    await mockBackend(page, freshBackend())
    for (const store of ['open', 'play', 'appstore'] as const) {
      await openInStore(page, store, '/settings/account')
      await expect(page.getByTestId('m-account-google')).toBeVisible()
      await expect(page.getByTestId('m-account-github')).toBeVisible()
      await expect(page.getByTestId('m-account-apple')).toHaveCount(0)
      expect(await page.getByTestId('m-account-screen').innerText(), store).not.toMatch(/apple/i)
      await expect(page.getByTestId('m-account-same-signin')).toHaveText('Use the same sign-in you used before to reach your existing account.')
    }
  })

  test('LU Cloud out of reach on a phone: the session is kept, the account says what it cannot know, the gate says offline', async ({ page }) => {
    const backend = freshBackend()
    await mockBackend(page, backend)
    await openShell(page, { route: '/settings/account' })
    await signIn(page)
    backend.cloudDown = true
    await openShell(page, { route: '/settings/account' })
    await expect(page.getByTestId('m-account-offline-kept')).toBeVisible()
    await expect(page.getByTestId('m-account-signedin')).toBeVisible()
    await expect(page.getByTestId('m-account-email-shown')).toHaveText(EMAIL)
    expect(await layout(page)).toEqual(CLEAN)
    await openShell(page, { route: '/cloud' })
    await expect(page.getByTestId('m-cloud-state')).toHaveAttribute('data-state', 'offline')
    await expect(page.getByTestId('m-cloud-offline')).toBeVisible()
    expect(await layout(page)).toEqual(CLEAN)
    // Back in reach: the next look at the account knows the plan again.
    backend.cloudDown = false
    await openShell(page, { route: '/settings/account' })
    await expect(page.getByTestId('m-account-offline-kept')).toHaveCount(0)
    await expect(page.getByTestId('m-account-signedin')).toContainText('Hosted')
  })

  test('Forgot password: the link of the mail comes back into the app, and the new password is set there', async ({ page }) => {
    const backend = freshBackend()
    await mockBackend(page, backend)
    await openShell(page, { route: '/settings/account' })
    await page.getByTestId('m-account-email').fill(EMAIL)
    await page.getByTestId('m-account-forgot').tap()
    await expect(page.getByTestId('m-account-reset-email')).toHaveValue(EMAIL)
    await page.getByTestId('m-account-reset-send').tap()
    await expect(page.getByTestId('m-account-reset-sent')).toContainText('If this address has an account, an email is on its way.')
    // The mail leads back into this app, not to a website.
    const asked = backend.calls.find((c) => c.startsWith('POST auth/auth/v1/recover')) ?? ''
    expect(decodeURIComponent(asked)).toContain('redirect_to=lu://oauth/callback')
    expect(await opened(page)).toEqual([])
    await page.getByTestId('m-account-reset-done').tap()
    await expect(page.getByTestId('m-sheet-settings-forgot-password')).toHaveCount(0)
    await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')

    // The user taps the link in the mail. The system hands it to the app.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:deep-link', { detail: { url: 'lu://oauth/callback?code=mock-oauth-code' } })))
    const sheet = page.getByTestId('m-sheet-settings-new-password')
    await expect(sheet).toBeVisible()
    await expect(page.getByTestId('m-sheet-link-offer')).toHaveCount(0)
    await expect(page.getByTestId('m-account-new-password-text')).toHaveText(`You opened the reset link for ${EMAIL}. Choose a new password.`)
    const field = page.getByTestId('m-account-new-password')
    await expect(field).toHaveAttribute('type', 'password')
    await expect(field).toHaveAttribute('autocomplete', 'new-password')
    expect(await layout(page)).toEqual(CLEAN)

    // Too short: caught before anything is sent.
    await field.fill('short')
    await page.getByTestId('m-account-new-password-save').tap()
    await expect(sheet.getByText('The password needs at least 8 characters.')).toBeVisible()
    expect(backend.calls.filter((c) => c.startsWith('PUT auth/auth/v1/user'))).toEqual([])
    // The old password again: the server says no, in the phone's words.
    backend.newPassword = 'same'
    await field.fill('another-mock-passphrase')
    await page.getByTestId('m-account-new-password-save').tap()
    await expect(sheet.getByText('That is your current password. Choose a different one.')).toBeVisible()
    expect(backend.passwordChanges).toBe(0)
    backend.newPassword = 'ok'
    await page.getByTestId('m-account-new-password-save').tap()
    await expect(page.getByTestId('m-toast-password-changed')).toHaveText('Password changed')
    await expect(sheet).toHaveCount(0)
    expect(backend.passwordChanges).toBe(1)
    // The link signed the user in, and the typed password is nowhere on the page.
    await expect(page.getByTestId('m-account-signedin')).toBeVisible()
    await expect(page.getByTestId('m-account-email-shown')).toHaveText(EMAIL)
    expect(await page.content()).not.toContain('another-mock-passphrase')
    expect(backend.calls.filter((c) => c.startsWith('UNMOCKED'))).toEqual([])
  })

  test('Forgot password: "Not now" keeps the old password, and the link is good for one use', async ({ page }) => {
    const backend = freshBackend()
    await mockBackend(page, backend)
    await openShell(page, { route: '/settings/account' })
    await page.getByTestId('m-account-email').fill(EMAIL)
    await page.getByTestId('m-account-forgot').tap()
    await page.getByTestId('m-account-reset-send').tap()
    await expect(page.getByTestId('m-account-reset-sent')).toBeVisible()
    // The link comes back while the sheet of the request is still open.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:deep-link', { detail: { url: 'lu://oauth/callback?code=mock-oauth-code' } })))
    const sheet = page.getByTestId('m-sheet-settings-new-password')
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText('Without a new password the old one stays.')
    await page.getByTestId('m-account-new-password-not-now').tap()
    await expect(sheet).toHaveCount(0)
    expect(backend.passwordChanges).toBe(0)
    // What the sheet said is true: the link signed the user in.
    await page.getByTestId('m-account-reset-done').tap()
    await expect(page.getByTestId('m-account-signedin')).toBeVisible()
    // The same link a second time does nothing: no second sheet, no second exchange.
    const exchanges = backend.calls.filter((c) => c.includes('grant_type=pkce')).length
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:deep-link', { detail: { url: 'lu://oauth/callback?code=mock-oauth-code' } })))
    await page.waitForTimeout(600)
    await expect(sheet).toHaveCount(0)
    expect(backend.calls.filter((c) => c.includes('grant_type=pkce')).length).toBe(exchanges)
  })

  test('Delete account without network: nothing is deleted, the sheet says so and stays for the next try', async ({ page, context }) => {
    const backend = freshBackend()
    await mockBackend(page, backend)
    await openShell(page, { route: '/settings/account' })
    await signIn(page)
    await page.getByTestId('m-account-delete').tap()
    const sheet = page.getByTestId('m-sheet-settings-delete-account')
    await expect(sheet).toBeVisible()
    await expect(page.getByTestId('m-account-delete-explain')).toBeVisible()
    // A fulfilled route ignores the offline switch of the browser, so the mock has to lose its network too.
    await context.setOffline(true)
    backend.cloudDown = true
    await page.getByTestId('m-account-delete-go-delete').tap()
    await page.getByTestId('m-dialog-gate').fill('DELETE')
    await page.getByTestId('m-dialog-confirm').tap()
    await expect(page.getByTestId('m-account-delete-error-state')).toHaveAttribute('data-reason', 'offline')
    await expect(page.getByTestId('m-account-delete-error')).toHaveText('No internet. Your account was not deleted. Try again when you are connected.')
    await expect(page.getByTestId('m-account-delete-signin-again')).toHaveCount(0)
    expect(await layout(page)).toEqual(CLEAN)
    expect(backend.deleted).toBe(false)
    expect(backend.calls.filter((c) => c === 'POST cloud/api/account/delete').length).toBe(1)
    await context.setOffline(false)
    backend.cloudDown = false
    // Connected again: the same button deletes.
    await page.getByTestId('m-account-delete-go-delete').tap()
    await page.getByTestId('m-dialog-gate').fill('DELETE')
    await page.getByTestId('m-dialog-confirm').tap()
    await expect(page.getByTestId('m-toast-account-deleted')).toBeVisible()
    await expect(sheet).toHaveCount(0)
    expect(backend.deleted).toBe(true)
    await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
  })

  test('The new steps on the smallest phone with the largest text: 320 px wide, text at 200 percent', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    const backend = freshBackend({ deleteFails: true })
    await mockBackend(page, backend)
    const big = (route: string) => openShell(page, { route, fontScale: 200 })

    // Reset password: the form, then what it says after sending.
    await big('/settings/account')
    await page.getByTestId('m-account-email').fill(EMAIL)
    await page.getByTestId('m-account-forgot').tap()
    await expect(page.getByTestId('m-account-reset-email')).toHaveValue(EMAIL)
    expect(await layout(page), 'reset form').toEqual(CLEAN)
    await page.getByTestId('m-account-reset-send').tap()
    await expect(page.getByTestId('m-account-reset-sent')).toBeVisible()
    expect(await layout(page), 'reset sent').toEqual(CLEAN)

    // Choose a new password, opened by the link of the mail.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:deep-link', { detail: { url: 'lu://oauth/callback?code=mock-oauth-code' } })))
    await expect(page.getByTestId('m-sheet-settings-new-password')).toBeVisible()
    await page.getByTestId('m-account-new-password').fill('short')
    await page.getByTestId('m-account-new-password-save').tap()
    await expect(page.getByText('The password needs at least 8 characters.')).toBeVisible()
    expect(await layout(page), 'new password').toEqual(CLEAN)
    await page.getByTestId('m-account-new-password-not-now').tap()

    // Signed in by the link: the account card with a picture, and a deletion the server declines.
    await big('/settings/account')
    await expect(page.getByTestId('m-account-signedin')).toBeVisible()
    expect(await layout(page), 'account').toEqual(CLEAN)
    await page.getByTestId('m-account-delete').tap()
    await expect(page.getByTestId('m-account-delete-explain')).toBeVisible()
    await page.getByTestId('m-account-delete-go-delete').tap()
    await page.getByTestId('m-dialog-gate').fill('DELETE')
    await page.getByTestId('m-dialog-confirm').tap()
    await expect(page.getByTestId('m-account-delete-error-state')).toHaveAttribute('data-reason', 'server')
    expect(await layout(page), 'delete error').toEqual(CLEAN)

    // The pages that changed: Voice with the dictation state, Troubleshooting with its rows, Backup with the written line.
    for (const [route, screen] of [
      ['/settings/voice', 'm-settings-voice-screen'],
      ['/settings/troubleshooting', 'm-settings-troubleshooting-screen'],
      ['/settings/data', 'm-settings-data-screen'],
    ] as const) {
      await big(route)
      await expect(page.getByTestId(screen)).toBeVisible()
      expect(await layout(page), route).toEqual(CLEAN)
    }
    expect(backend.deleted).toBe(false)
  })

  test('"Cancel" ends the wait, a foreign sign in link is no offer, and a refused code ends the wait', async ({ page }) => {
    const backend = freshBackend()
    await mockBackend(page, backend)
    await openShell(page, { route: '/settings/account' })
    await page.getByTestId('m-account-github').tap()
    await expect(page.getByTestId('m-account-oauth-waiting')).toBeVisible()
    expect((await opened(page)).some((l) => l.includes('provider=github'))).toBe(true)
    await page.getByTestId('m-account-oauth-cancel').tap()
    await expect(page.getByTestId('m-account-oauth-waiting')).toHaveCount(0)
    await expect(page.getByTestId('m-account-google')).toBeEnabled()

    // A sign in link that is not the callback is no offer at all: no sheet, nothing is exchanged (review N3).
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:deep-link', { detail: { url: 'lu://auth?code=mock-oauth-code' } })))
    await page.waitForTimeout(300)
    await expect(page.getByTestId('m-sheet-link-offer')).toHaveCount(0)
    await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
    expect(backend.calls.some((c) => c.includes('grant_type=pkce'))).toBe(false)

    // A code the server refuses, while the page waits for the browser: the wait ends with the reason.
    await page.getByTestId('m-account-google').tap()
    await expect(page.getByTestId('m-account-oauth-waiting')).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:deep-link', { detail: { url: 'lu://oauth/callback?code=some-other-code' } })))
    await expect(page.getByTestId('m-account-oauth-waiting')).toHaveCount(0)
    await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
    await expect(page.getByTestId('m-sheet-link-offer')).toHaveCount(0)
  })
})

// "Sign in with Apple" (round 15): the sheet of the system on an iPhone, played by the mock of the native layer,
// and the auth server, played by the route mock. An iPhone is told apart by its user agent.
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

// Check on the iPhone, round 22, N5: "Continue with Google" and "Continue with GitHub" opened no browser. The provider
// page went through the shell plugin, which starts a program, and an iPhone has none. Played here: the native layer
// of an iPhone (the sign-in sheet of the system) and of an Android phone (the opener of the plugin).
test.describe('settings, Continue with Google and GitHub through the native layer', () => {
  test.describe('on an iPhone', () => {
    test.use({ userAgent: IPHONE_UA })

    for (const provider of ['google', 'github'] as const) {
      test(`Continue with ${provider}: the sign-in sheet of the system, the link it hands back signs in, and the app is never left`, async ({ page }) => {
        const errors = watchErrors(page)
        const backend = freshBackend()
        await startPhone(page, backend, { webAuth: 'ok', openExternal: 'ok' })
        await openShell(page, { route: '/settings/account' })
        await page.getByTestId(`m-account-${provider}`).tap()
        await expect(page.getByTestId('m-account-signedin')).toBeVisible()
        await expect(page.getByTestId('m-account-email-shown')).toHaveText(EMAIL)
        const record = await phone(page)
        // One sheet, for the page of the provider, waiting for the scheme of the app.
        expect(record.webAuth).toHaveLength(1)
        expect(record.webAuth[0].callbackScheme).toBe('lu')
        expect(record.webAuth[0].url).toContain(`${AUTH}/auth/v1/authorize`)
        expect(record.webAuth[0].url).toContain(`provider=${provider}`)
        expect(decodeURIComponent(record.webAuth[0].url)).toContain('redirect_to=lu://oauth/callback')
        expect(record.webAuth[0].url).toContain('code_challenge=')
        // No browser, no shell plugin, no window: the app was never left.
        expect(record.external).toEqual([])
        expect(record.calls).not.toContain('plugin:shell|open')
        expect(await opened(page)).toEqual([])
        expect(backend.calls.some((c) => c.includes('grant_type=pkce'))).toBe(true)
        await expect(page.getByTestId('m-account-oauth-waiting')).toHaveCount(0)
        expect(await layout(page)).toEqual(CLEAN)
        expect(unexpected(errors())).toEqual([])
      })
    }

    test('closing the sheet says nothing, waits for nothing, and the other ways in still work', async ({ page }) => {
      const errors = watchErrors(page)
      const backend = freshBackend()
      await startPhone(page, backend, { webAuth: 'closed' })
      await openShell(page, { route: '/settings/account' })
      const before = await page.getByTestId('m-account-screen').innerText()
      await page.getByTestId('m-account-google').tap()
      await expect.poll(async () => (await phone(page)).webAuth.length).toBe(1)
      await expect(page.getByTestId('m-account-google')).not.toHaveAttribute('aria-busy', 'true')
      await expect(page.getByTestId('m-account-oauth-waiting')).toHaveCount(0)
      await expect(page.getByTestId('m-account-oauth-not-opened')).toHaveCount(0)
      await expect(page.getByTestId('m-account-error')).toHaveCount(0)
      await expect(page.locator('[data-testid^="m-toast-"]')).toHaveCount(0)
      await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
      expect(await page.getByTestId('m-account-screen').innerText()).toBe(before)
      expect(backend.calls.some((c) => c.includes('grant_type=pkce'))).toBe(false)
      await expect(page.getByTestId('m-account-github')).toBeEnabled()
      await signIn(page)
      expect(unexpected(errors())).toEqual([])
    })

    test('the sheet does not come up: an honest sentence with "Try again", never "Waiting for your browser", and the second try signs in', async ({ page }) => {
      const backend = freshBackend()
      await startPhone(page, backend, { webAuth: 'fail-once' })
      await openShell(page, { route: '/settings/account' })
      await page.getByTestId('m-account-google').tap()
      const box = page.getByTestId('m-account-oauth-not-opened')
      await expect(box).toContainText('The sign-in page did not open. Try again, or sign in with your email and password.')
      await expect(page.getByTestId('m-account-oauth-waiting')).toHaveCount(0)
      await expect(page.getByTestId('m-account-google')).not.toHaveAttribute('aria-busy', 'true')
      await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
      // The words of the system are not on the page.
      expect(await page.getByTestId('m-account-screen').innerText()).not.toMatch(/shell|os error|No such file/i)
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-account-oauth-retry').tap()
      await expect(page.getByTestId('m-account-signedin')).toBeVisible()
      expect((await phone(page)).webAuth).toHaveLength(2)
      expect((await phone(page)).calls).not.toContain('plugin:shell|open')
    })

    test('an app whose native part has no sheet yet takes the opener of the plugin, and says that it waits for the browser', async ({ page }) => {
      const backend = freshBackend()
      await startPhone(page, backend, { openExternal: 'ok' })
      await openShell(page, { route: '/settings/account' })
      await page.getByTestId('m-account-github').tap()
      await expect(page.getByTestId('m-account-oauth-waiting')).toContainText('Waiting for your browser.')
      const record = await phone(page)
      expect(record.external).toHaveLength(1)
      expect(record.external[0]).toContain('provider=github')
      expect(record.calls).not.toContain('plugin:shell|open')
      // The link comes back through the system and finishes the sign-in.
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:deep-link', { detail: { url: 'lu://oauth/callback?code=mock-oauth-code' } })))
      await expect(page.getByTestId('m-account-signedin')).toBeVisible()
    })
  })

  test.describe('on an Android phone', () => {
    test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' })

    test('Continue with Google: the opener of the plugin, never the sign-in sheet of iOS and never the shell plugin', async ({ page }) => {
      const backend = freshBackend()
      await startPhone(page, backend, { webAuth: 'ok', openExternal: 'ok' })
      await openShell(page, { route: '/settings/account' })
      await page.getByTestId('m-account-google').tap()
      await expect(page.getByTestId('m-account-oauth-waiting')).toContainText('Waiting for your browser.')
      const record = await phone(page)
      expect(record.external).toHaveLength(1)
      expect(record.external[0]).toContain('provider=google')
      expect(decodeURIComponent(record.external[0])).toContain('redirect_to=lu://oauth/callback')
      expect(record.webAuth).toEqual([])
      expect(record.calls).not.toContain('plugin:shell|open')
      expect(await opened(page)).toEqual([])
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:deep-link', { detail: { url: 'lu://oauth/callback?code=mock-oauth-code' } })))
      await expect(page.getByTestId('m-account-signedin')).toBeVisible()
    })

    test('no browser on the phone opens the link: the sentence with "Try again" at once, and no wait', async ({ page }) => {
      const backend = freshBackend()
      await startPhone(page, backend, { openExternal: 'fail' })
      await openShell(page, { route: '/settings/account' })
      await page.getByTestId('m-account-google').tap()
      await expect(page.getByTestId('m-account-oauth-not-opened')).toBeVisible()
      await expect(page.getByTestId('m-account-oauth-retry')).toHaveText('Try again')
      await expect(page.getByTestId('m-account-oauth-waiting')).toHaveCount(0)
      await expect(page.getByTestId('m-account-google')).toBeEnabled()
      expect((await phone(page)).calls).not.toContain('plugin:shell|open')
    })
  })
})

test.describe('settings, Sign in with Apple on an iPhone', () => {
  test.use({ userAgent: IPHONE_UA })

  /** Top edge, size and colours of a button on the page Account. */
  const look = (page: Page, testid: string) =>
    page.getByTestId(testid).evaluate((el) => {
      const box = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return { top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height), background: style.backgroundColor, color: style.color, fontSize: parseFloat(style.fontSize) }
    })

  for (const store of ['open', 'play', 'appstore'] as const) {
    test(`${store}: the button stands above Google and GitHub, as large as they are, in Apple's colours in both themes`, async ({ page }) => {
      const backend = freshBackend()
      await startPhone(page, backend, { apple: 'ok' })
      if (store !== 'open') await declareAdult(page)
      for (const theme of ['dark', 'light'] as const) {
        await page.goto(`${shellUrl({ route: '/settings/account', theme })}&store=${store}`)
        await page.getByTestId('m-app').waitFor()
        await screensLoaded(page)
        const apple = page.getByTestId('m-account-apple')
        await expect(apple).toBeVisible()
        await expect(apple).toContainText('Sign in with Apple')
        await expect(apple).toHaveAccessibleName('Sign in with Apple')
        const [a, g, h] = [await look(page, 'm-account-apple'), await look(page, 'm-account-google'), await look(page, 'm-account-github')]
        // Above the other two, and not a smaller or narrower button than they are.
        expect(a.top, theme).toBeLessThan(g.top)
        expect(g.top, theme).toBeLessThan(h.top)
        expect(a.width, theme).toBe(g.width)
        expect(a.height, theme).toBeGreaterThanOrEqual(g.height)
        expect(a.height, theme).toBeGreaterThanOrEqual(44)
        expect(a.fontSize, theme).toBeGreaterThanOrEqual(g.fontSize)
        // Apple's rule for the button: white on a dark page, black on a light one.
        expect([a.background, a.color], theme).toEqual(theme === 'dark' ? ['rgb(255, 255, 255)', 'rgb(0, 0, 0)'] : ['rgb(0, 0, 0)', 'rgb(255, 255, 255)'])
        await expect(page.getByTestId('m-account-same-signin')).toHaveText('Use the same sign-in you used before to reach your existing account.')
        expect((await look(page, 'm-account-same-signin')).top, theme).toBeGreaterThan(h.top)
        expect(await layout(page), theme).toEqual(CLEAN)
      }
      expect(backend.appleSeen).toEqual([])
    })
  }

  test('a tap opens the sheet of the system and signs in: no browser, no link, the nonce holds', async ({ page }) => {
    const errors = watchErrors(page)
    const backend = freshBackend()
    await startPhone(page, backend, { apple: 'ok' })
    await declareAdult(page)
    await page.goto(`${shellUrl({ route: '/settings/account' })}&store=appstore`)
    await page.getByTestId('m-app').waitFor()
    await screensLoaded(page)
    await page.getByTestId('m-account-apple').tap()
    await expect(page.getByTestId('m-account-signedin')).toBeVisible()
    await expect(page.getByTestId('m-account-email-shown')).toHaveText(EMAIL)
    // One sheet, one token, and what the server compared: the nonce of the page against the hash Apple signed.
    const record = await phone(page)
    expect(record.apple).toHaveLength(1)
    expect(record.apple[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(backend.appleSeen).toHaveLength(1)
    expect(backend.appleSeen[0].provider).toBe('apple')
    expect(backend.appleSeen[0].nonce).toBe(record.apple[0])
    expect(backend.appleSeen[0].tokenNonce).toBe(createHash('sha256').update(record.apple[0]).digest('hex'))
    // No browser was opened and no link is waited for.
    expect(await opened(page)).toEqual([])
    expect(backend.calls.some((c) => c.includes('/auth/v1/authorize') || c.includes('grant_type=pkce'))).toBe(false)
    await expect(page.getByTestId('m-account-oauth-waiting')).toHaveCount(0)
    // The name Apple handed out went nowhere.
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + document.body.innerText)).not.toMatch(/Ada|Lovelace/)
    expect(await layout(page)).toEqual(CLEAN)
    expect(unexpected(errors())).toEqual([])
  })

  test('closing the sheet says nothing and changes nothing', async ({ page }) => {
    const errors = watchErrors(page)
    const backend = freshBackend()
    await startPhone(page, backend, { apple: 'closed' })
    await openShell(page, { route: '/settings/account' })
    const before = await page.getByTestId('m-account-screen').innerText()
    await page.getByTestId('m-account-apple').tap()
    await expect.poll(async () => (await phone(page)).apple.length).toBe(1)
    await expect(page.getByTestId('m-account-apple')).not.toHaveAttribute('aria-busy', 'true')
    await expect(page.getByTestId('m-account-error')).toHaveCount(0)
    await expect(page.getByTestId('m-account-notice')).toHaveCount(0)
    await expect(page.locator('[data-testid^="m-toast-"]')).toHaveCount(0)
    await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
    expect(await page.getByTestId('m-account-screen').innerText()).toBe(before)
    expect(backend.appleSeen).toEqual([])
    // And the other ways in still work after it.
    await expect(page.getByTestId('m-account-google')).toBeEnabled()
    await signIn(page)
    expect(unexpected(errors())).toEqual([])
  })

  test('a phone without an Apple Account: the sentence of the system sheet, and the form still works', async ({ page }) => {
    const backend = freshBackend()
    await startPhone(page, backend, { apple: 'no-apple-account' })
    await openShell(page, { route: '/settings/account' })
    await page.getByTestId('m-account-apple').tap()
    await expect(page.getByTestId('m-account-error')).toHaveText('Sign in with Apple is not available right now. Check that this device is signed in to an Apple Account in the system settings, then try again.')
    expect(backend.appleSeen).toEqual([])
    expect(await layout(page)).toEqual(CLEAN)
    await signIn(page)
    await expect(page.getByTestId('m-account-error')).toHaveCount(0)
  })

  test('the account server does not know Apple yet: one sentence of the app, not the text of the server', async ({ page }) => {
    const backend = freshBackend({ apple: 'not-set-up' })
    await startPhone(page, backend, { apple: 'ok' })
    await openShell(page, { route: '/settings/account' })
    await page.getByTestId('m-account-apple').tap()
    await expect(page.getByTestId('m-account-error')).toHaveText('Sign in with Apple did not work. Try again, or sign in another way.')
    expect(await page.getByTestId('m-account-screen').innerText()).not.toMatch(/issuer|appleid\.apple\.com|provider/i)
    await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
    expect(backend.appleSeen).toHaveLength(1)
  })

  test('a native part older than the command: one sentence, nobody is asked', async ({ page }) => {
    const backend = freshBackend()
    await startPhone(page, backend)
    await openShell(page, { route: '/settings/account' })
    await page.getByTestId('m-account-apple').tap()
    await expect(page.getByTestId('m-account-error')).toHaveText('Sign in with Apple is not available on this device.')
    expect(backend.appleSeen).toEqual([])
  })

  // Round 32, Apple 5.1.1(v): deleting an account that uses Sign in with Apple ends the link at Apple too. The server
  // revokes inside the deletion with what it got from POST /api/account/apple-token; the phone asks the sheet once more.
  const signInWithAppleAndAskToDelete = async (page: Page) => {
    await openShell(page, { route: '/settings/account' })
    await page.getByTestId('m-account-apple').tap()
    await expect(page.getByTestId('m-account-signedin')).toBeVisible()
    await page.getByTestId('m-account-delete').tap()
    await expect(page.getByTestId('m-sheet-settings-delete-account')).toBeVisible()
    await page.getByTestId('m-account-delete-go-delete').tap()
    await page.getByTestId('m-dialog-gate').fill('DELETE')
    await page.getByTestId('m-dialog-confirm').tap()
  }
  const cloudCalls = (backend: Backend) => backend.calls.filter((c) => c.includes('/api/account/apple-token') || c.includes('/api/account/delete'))

  test('deleting an account made with Apple: a fresh sheet, its code to the server before the deletion, then deleted', async ({ page }) => {
    const errors = watchErrors(page)
    const backend = freshBackend()
    await startPhone(page, backend, { apple: 'ok' })
    await signInWithAppleAndAskToDelete(page)
    await expect(page.getByTestId('m-toast-account-deleted')).toHaveText('Your account is deleted')
    await expect(page.getByTestId('m-sheet-settings-delete-account')).toHaveCount(0)
    await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
    // Two sheets: the sign in and the one before the deletion, each with its own nonce. Only the second code went to the server.
    const record = await phone(page)
    expect(record.apple).toHaveLength(2)
    expect(record.apple[0]).not.toBe(record.apple[1])
    expect(backend.appleCodes).toEqual(['mock-apple-code-2'])
    expect(cloudCalls(backend)).toEqual(['POST cloud/api/account/apple-token', 'POST cloud/api/account/delete'])
    expect(backend.deleted).toBe(true)
    // The phone does not claim what only the server knows.
    expect(await page.locator('body').innerText()).not.toMatch(/revoked|ended at Apple/i)
    expect(unexpected(errors())).toEqual([])
  })

  test('closing the Apple sheet deletes nothing; "Delete without Apple" deletes and says the link was not ended', async ({ page }) => {
    const backend = freshBackend()
    await startPhone(page, backend, { apple: 'ok' })
    await openShell(page, { route: '/settings/account' })
    await page.getByTestId('m-account-apple').tap()
    await expect(page.getByTestId('m-account-signedin')).toBeVisible()
    await page.evaluate(() => {
      ;(window as unknown as { __phoneOpts: { apple: string } }).__phoneOpts.apple = 'closed'
    })
    await page.getByTestId('m-account-delete').tap()
    await page.getByTestId('m-account-delete-go-delete').tap()
    await page.getByTestId('m-dialog-gate').fill('DELETE')
    await page.getByTestId('m-dialog-confirm').tap()
    await expect(page.getByTestId('m-account-delete-apple-cancelled')).toContainText('Nothing was deleted. This account uses Sign in with Apple')
    expect(cloudCalls(backend)).toEqual([])
    expect(backend.deleted).toBe(false)
    await expect(page.getByTestId('m-account-signedin')).toBeVisible()
    expect(await layout(page)).toEqual(CLEAN)

    await page.getByTestId('m-account-delete-without-apple').tap()
    await expect(page.getByTestId('m-account-delete-apple-left')).toContainText('Your account is deleted. LU could not end Sign in with Apple for it.')
    await expect(page.getByTestId('m-account-delete-apple-left')).toContainText('Sign in with Apple, and remove LU.')
    expect(cloudCalls(backend)).toEqual(['POST cloud/api/account/delete'])
    expect(backend.deleted).toBe(true)
    expect(await layout(page)).toEqual(CLEAN)
    await page.getByTestId('m-account-delete-close').tap()
    await expect(page.getByTestId('m-sheet-settings-delete-account')).toHaveCount(0)
    await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
  })

  for (const [why, over, opts] of [
    ['no network for the code', { appleToken: 'down' }, { apple: 'ok' }],
    ['the server has no Apple keys yet', { appleToken: 'not-stored' }, { apple: 'ok' }],
  ] as const) {
    test(`${why}: the account is deleted, and the sheet says the Apple link was not ended`, async ({ page }) => {
      const backend = freshBackend(over)
      await startPhone(page, backend, opts)
      await signInWithAppleAndAskToDelete(page)
      await expect(page.getByTestId('m-account-delete-apple-left')).toContainText('LU could not end Sign in with Apple for it.')
      await expect(page.getByTestId('m-toast-account-deleted')).toHaveCount(0)
      expect(backend.appleCodes).toEqual(['mock-apple-code-2'])
      expect(backend.deleted).toBe(true)
      await expect(page.getByTestId('m-account-state')).toHaveAttribute('data-state', 'signed-out')
      expect(await layout(page)).toEqual(CLEAN)
    })
  }

  test('the Apple sheet fails before the deletion: deleted, and said that the link was not ended', async ({ page }) => {
    const backend = freshBackend()
    await startPhone(page, backend, { apple: 'ok' })
    await openShell(page, { route: '/settings/account' })
    await page.getByTestId('m-account-apple').tap()
    await expect(page.getByTestId('m-account-signedin')).toBeVisible()
    await page.evaluate(() => {
      ;(window as unknown as { __phoneOpts: { apple: string } }).__phoneOpts.apple = 'no-apple-account'
    })
    await page.getByTestId('m-account-delete').tap()
    await page.getByTestId('m-account-delete-go-delete').tap()
    await page.getByTestId('m-dialog-gate').fill('DELETE')
    await page.getByTestId('m-dialog-confirm').tap()
    await expect(page.getByTestId('m-account-delete-apple-left')).toBeVisible()
    expect(backend.appleCodes).toEqual([])
    expect(cloudCalls(backend)).toEqual(['POST cloud/api/account/delete'])
  })

  test('an account with a password on the iPhone: no Apple sheet before the deletion', async ({ page }) => {
    const backend = freshBackend()
    await startPhone(page, backend, { apple: 'ok' })
    await openShell(page, { route: '/settings/account' })
    await signIn(page)
    await page.getByTestId('m-account-delete').tap()
    await page.getByTestId('m-account-delete-go-delete').tap()
    await page.getByTestId('m-dialog-gate').fill('DELETE')
    await page.getByTestId('m-dialog-confirm').tap()
    await expect(page.getByTestId('m-toast-account-deleted')).toHaveText('Your account is deleted')
    expect((await phone(page)).apple).toEqual([])
    expect(cloudCalls(backend)).toEqual(['POST cloud/api/account/delete'])
  })

  test('the smallest phone: all three buttons and the sentence fit', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await startPhone(page, freshBackend(), { apple: 'ok' })
    for (const fontScale of [100, 200]) {
      await openShell(page, { route: '/settings/account', fontScale })
      await page.getByTestId('m-account-apple').scrollIntoViewIfNeeded()
      await expect(page.getByTestId('m-account-apple')).toContainText('Sign in with Apple')
      expect(await layout(page), `text at ${fontScale} percent`).toEqual(CLEAN)
    }
  })
})

// The installed app: the same pages with the native layer answering. The layer is a mock of the Tauri bridge
// (what the commands answer is made up here); a phone is told apart by its user agent.
interface PhoneMock {
  /** 'none': the secure storage of the phone cannot be used, so a provider key stays in the app's own storage. */
  keychain?: 'ok' | 'none'
  /** 'fail': the log file cannot be read. */
  log?: 'ok' | 'fail'
  /** What the save dialog of the system answers: a folder was picked, the dialog was closed, or this build has no such command. */
  save?: 'picked' | 'closed' | 'missing'
  /** The voices the speech engine of the phone lists. Left out: the phone has no engine. */
  voices?: Array<{ id: string; name: string; lang: string; local: boolean; default: boolean }>
  /** What the sheet "Sign in with Apple" of the system ends in. Left out: this native part has no such command. */
  apple?: 'ok' | 'closed' | 'no-apple-account'
  /** What the sign-in sheet of the system for Google and GitHub ends in (iOS, round 22). Left out: this native part has no such command. */
  webAuth?: 'ok' | 'closed' | 'fail' | 'fail-once'
  /** 'fail': no app on the phone opens the link. Left out: the opener of the plugin answers as before. */
  openExternal?: 'ok' | 'fail'
}

interface PhoneRecord {
  calls: string[]
  /** Every nonce handed to the sheet "Sign in with Apple". */
  apple: string[]
  shared: Array<Record<string, unknown>>
  temp: Array<Record<string, unknown>>
  backups: string[]
  /** Every file handed to the save dialog of the system. */
  saved: Array<Record<string, unknown>>
  /** Every text handed to the speech engine of the phone, with voice, speed and language. */
  spoken: Array<Record<string, unknown>>
  /** Every start of the sign-in sheet of the system: the page and the scheme it waits for. */
  webAuth: Array<{ url: string; callbackScheme: string }>
  /** Every link handed to the opener of the plugin. */
  external: string[]
  hosts: string[]
  proxied: Array<{ url: string; headers: Record<string, string> | null }>
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function installPhone(opts: PhoneMock): void {
  const w = window as any
  const GIB = 1024 * 1024 * 1024
  const record: PhoneRecord = { calls: [], apple: [], shared: [], temp: [], backups: [], saved: [], spoken: [], webAuth: [], external: [], hosts: [], proxied: [] }
  // Who listens to which event of the native layer, so the mock can send `tts-end` like the plugin does.
  const listeners: Record<string, number[]> = {}
  const emit = (event: string, payload: unknown) => (listeners[event] ?? []).forEach((id) => w[`_${id}`]?.({ event, id, payload }))
  w.__phone = record
  // A test may change what the mocked sheets answer from here on (page.evaluate on window.__phoneOpts).
  w.__phoneOpts = opts
  const secrets: Record<string, string> = {}
  const router = (cmd: string, args: any): Promise<unknown> => {
    record.calls.push(cmd)
    switch (cmd) {
      case 'plugin:lu-native|device_info':
        return Promise.resolve({
          platform: 'android',
          model: 'Pixel 8',
          manufacturer: 'Google',
          isEmulator: false,
          totalMemoryBytes: 8 * GIB,
          availableMemoryBytes: 3 * GIB,
          lowMemory: false,
          diskFreeBytes: 40 * GIB,
          diskTotalBytes: 128 * GIB,
          fontScale: 1.3,
          systemVersion: '14',
          socModel: 'Tensor G3',
          sdkInt: 34,
          appVersion: '9.9.9',
          modelsDir: '/data/models',
        })
      // "Sign in with Apple" as AppleSignIn.swift answers: Apple writes the SHA-256 of the nonce into the token.
      case 'plugin:lu-native|apple_sign_in': {
        if (!opts.apple) return Promise.reject('Command apple_sign_in not found')
        record.apple.push(String(args?.nonce ?? ''))
        if (opts.apple === 'closed') return Promise.resolve({ cancelled: true })
        if (opts.apple === 'no-apple-account') {
          return Promise.reject('Sign in with Apple is not available right now. Check that this device is signed in to an Apple Account in the system settings, then try again.')
        }
        const part = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(args?.nonce ?? ''))).then((hash) => {
          const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
          // Since round 32 with the one-time code of the sheet, a new one each time.
          return { cancelled: false, identityToken: `${part({ alg: 'RS256' })}.${part({ iss: 'https://appleid.apple.com', nonce: hex })}.mock`, authorizationCode: `mock-apple-code-${record.apple.length}`, fullName: 'Ada Lovelace', givenName: 'Ada', familyName: 'Lovelace' }
        })
      }
      // The sign-in sheet of the system as WebAuth.swift answers: the link the page ended on, or cancelled.
      case 'plugin:lu-native|web_auth': {
        if (!opts.webAuth) return Promise.reject('Command plugin:lu-native|web_auth not found')
        record.webAuth.push({ url: String(args?.url ?? ''), callbackScheme: String(args?.callbackScheme ?? '') })
        if (opts.webAuth === 'closed') return Promise.resolve({ cancelled: true })
        if (opts.webAuth === 'fail' || (opts.webAuth === 'fail-once' && record.webAuth.length === 1)) return Promise.reject('The sign-in page could not be shown. Try again.')
        return Promise.resolve({ cancelled: false, url: 'lu://oauth/callback?code=mock-oauth-code' })
      }
      case 'plugin:lu-native|open_external':
        if (!opts.openExternal) return Promise.resolve(0)
        record.external.push(String(args?.url ?? ''))
        if (opts.openExternal === 'fail') return Promise.reject('No app on this phone can open this link.')
        return Promise.resolve(null)
      // What the shell plugin answered on the iPhone of the check (round 22, N5). Nothing may ask it any more.
      case 'plugin:shell|open':
        return Promise.reject('Scoped shell IO error: No such file or directory (os error 2)')
      case 'read_log_tail':
        if (opts.log === 'fail') return Promise.reject('log file is locked')
        return Promise.resolve({ file: 'lu.log', text: '12:00:01 INFO engine started\n12:00:05 WARN slow answer from the mock', lineCount: 2, truncated: true, lastCrash: '2026-10-07 09:15 panic in mock_module' })
      case 'plugin:lu-native|share_file':
        record.shared.push(args ?? {})
        return Promise.resolve({ presented: true })
      case 'plugin:lu-native|tts_voices':
        return Promise.resolve({ available: (opts.voices ?? []).length > 0, voices: opts.voices ?? [] })
      case 'plugin:lu-native|tts_speak': {
        if ((opts.voices ?? []).length === 0) return Promise.reject('This phone has no voice for reading aloud. Install a text to speech engine in the system settings.')
        record.spoken.push(args ?? {})
        const id = `tts-${record.spoken.length}`
        setTimeout(() => emit('tts-start', { id }), 10)
        setTimeout(() => emit('tts-end', { id, stopped: false }), 120)
        return Promise.resolve({ id })
      }
      case 'plugin:lu-native|tts_stop':
        return Promise.resolve({ ok: true })
      case 'plugin:lu-native|save_to_files':
        if (opts.save === 'missing') return Promise.reject('Command save_to_files not found')
        record.saved.push(args ?? {})
        return Promise.resolve(opts.save === 'closed' ? { saved: false } : { saved: true, uri: 'content://documents/lu-chats.json' })
      case 'save_to_device':
        return Promise.reject('Command save_to_device not found')
      case 'plugin:lu-native|write_temp_file':
        record.temp.push(args ?? {})
        return Promise.resolve({ path: '/cache/share/lu-file.txt', bytes: 1 })
      case 'plugin:lu-native|delete_temp_file':
        return Promise.resolve(true)
      case 'backup_stores':
        record.backups.push(String(args?.data ?? ''))
        return Promise.resolve(null)
      case 'register_openai_host':
        record.hosts.push(String(args?.host ?? ''))
        return Promise.resolve(null)
      case 'proxy_localhost': {
        const url = String(args?.url ?? '')
        record.proxied.push({ url, headers: args?.headers ?? null })
        if (url === 'https://llm.example.org/v1/models') return Promise.resolve(JSON.stringify({ object: 'list', data: [{ id: 'own-model-a' }, { id: 'own-model-b' }] }))
        return Promise.reject('nothing listens there')
      }
      case 'secret_get':
        if (opts.keychain === 'none') return Promise.reject('no secure storage on this device')
        return Promise.resolve(secrets[args?.account] ?? null)
      case 'secret_set':
        if (opts.keychain === 'none') return Promise.reject('no secure storage on this device')
        secrets[args?.account] = args?.secret ?? args?.value ?? ''
        return Promise.resolve(null)
      case 'secret_delete':
        delete secrets[args?.account]
        return Promise.resolve(null)
      case 'bundled_engine_status':
        return Promise.resolve({ running: false, healthy: false, port: 8127, model_path: null, ctx: null, inProcess: true, accelerator: null, cpuOnly: false, sanityNote: null })
      case 'bundled_embed_status':
        return Promise.resolve({ running: false, healthy: false, port: 8128, model_path: null })
      case 'list_bundled_models':
        return Promise.resolve({ dir: '/data/models', models: [] })
      case 'list_orphan_downloads':
        return Promise.resolve([])
      default:
        if (cmd === 'plugin:event|listen') {
          ;(listeners[String(args.event)] ??= []).push(Number(args.handler))
          return Promise.resolve(args.handler)
        }
        if (cmd === 'plugin:event|unlisten') return Promise.resolve(null)
        if (cmd.startsWith('plugin:')) return Promise.resolve(0)
        return Promise.resolve(null)
    }
  }
  let callbackId = 0
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(cb: (v: any) => void) {
      const id = ++callbackId
      w[`_${id}`] = cb
      return id
    },
    unregisterCallback(id: number) {
      delete w[`_${id}`]
    },
    convertFileSrc: (path: string) => path,
    invoke: (cmd: string, args: any) => router(cmd, args),
  }
  w.__TAURI__ = w.__TAURI_INTERNALS__
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => w.__TAURI_INTERNALS__.unregisterCallback(id) }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const phone = (page: Page) => page.evaluate(() => (window as unknown as { __phone: PhoneRecord }).__phone)

async function startPhone(page: Page, backend: Backend, opts: PhoneMock = {}): Promise<void> {
  await mockBackend(page, backend)
  await page.addInitScript(installPhone, opts)
  // The engine of the mocked phone has no HTTP face. What asks it directly gets an empty answer.
  await page.route(/^http:\/\/(127\.0\.0\.1|localhost):81\d\d\//, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
}

/** Everything text that went to the share sheet: handed over directly, or written to a file for it first. */
function sharedText(record: PhoneRecord): string {
  const parts: string[] = []
  for (const item of [...record.temp, ...record.shared]) {
    if (typeof item.text === 'string') parts.push(item.text)
    for (const field of ['bytesBase64', 'dataBase64', 'chunkBase64']) {
      const value = item[field]
      if (typeof value === 'string' && value) parts.push(Buffer.from(value, 'base64').toString('utf8'))
    }
  }
  return parts.join('\n')
}

test.describe('settings in the installed app (mocked native layer)', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' })

  for (const size of SIZES) {
    test(`Troubleshooting ${size.name}: the phone answers, so no row is empty, and "Share log" hands over the log file`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
      const backend = freshBackend()
      await startPhone(page, backend)
      await openShell(page, { route: '/settings/troubleshooting' })
      const diag = page.getByTestId('m-settings-troubleshooting-diagnostics')
      await expect(page.getByTestId('m-settings-troubleshooting-diag-device')).toContainText('Pixel 8')
      await expect(page.getByTestId('m-settings-troubleshooting-diag-device')).toContainText('Google')
      await expect(page.getByTestId('m-settings-troubleshooting-diag-system')).toContainText('Android 14')
      await expect(page.getByTestId('m-settings-troubleshooting-diag-memory')).toContainText('8')
      await expect(page.getByTestId('m-settings-troubleshooting-diag-memory-free')).toContainText('3')
      await expect(page.getByTestId('m-settings-troubleshooting-diag-storage-free')).toContainText('40')
      await expect(page.getByTestId('m-settings-troubleshooting-diag-text-size')).toContainText('130')
      // N16: one sum of what LU keeps, split into models and the rest. The mocked phone has no model installed.
      await expect(page.getByTestId('m-settings-troubleshooting-diag-storage-used')).toContainText(/Models 0 B, chats and files \d/)
      // What the phone reports is shown. Nothing reads "Not available", and nothing sends the user to "the installed app": this is it.
      const text = await diag.innerText()
      expect(text).not.toContain('Not available')
      expect(text).not.toContain('Shown in the installed app')
      // The last unexpected end of the app comes from the log, and says where the full record is.
      await expect(page.getByTestId('m-settings-troubleshooting-diag-crash')).toContainText('panic in mock_module')
      expect(await layout(page)).toEqual(CLEAN)

      // "Share log": the end of the log file and the crash record go to the share sheet of the phone.
      await page.getByTestId('m-settings-troubleshooting-share-log').tap()
      await expect(page.getByTestId('m-toast-log-shared')).toBeVisible()
      const record = await phone(page)
      expect(record.calls).toContain('read_log_tail')
      expect(record.calls).toContain('plugin:lu-native|share_file')
      const sent = sharedText(record)
      expect(sent).toContain('LU diagnostics report')
      expect(sent).toContain('App log')
      expect(sent).toContain('12:00:01 INFO engine started')
      expect(sent).toContain('12:00:05 WARN slow answer from the mock')
      expect(sent).toContain('panic in mock_module')
      expect(sent).toContain('Only the last 2 lines are included.')
      expect(sent).toContain('Pixel 8')
      expect(sent).not.toContain('could not be read here')
      expect(backend.calls.filter((c) => c.startsWith('UNMOCKED'))).toEqual([])
    })
  }

  test('"Share log" with a log file that cannot be read: the rest is shared, and the text says what is missing', async ({ page }) => {
    await startPhone(page, freshBackend(), { log: 'fail' })
    await openShell(page, { route: '/settings/troubleshooting' })
    await expect(page.getByTestId('m-settings-troubleshooting-diag-device')).toContainText('Pixel 8')
    await expect(page.getByTestId('m-settings-troubleshooting-diag-crash')).toHaveCount(0)
    await page.getByTestId('m-settings-troubleshooting-share-log').tap()
    await expect(page.getByTestId('m-toast-log-shared')).toBeVisible()
    const sent = sharedText(await phone(page))
    expect(sent).toContain('The log file of the app could not be read here.')
    expect(sent).toContain('Errors since LU was opened')
  })

  test('H2 Android: no speechSynthesis in the WebView, the voices come from the native layer and can be heard', async ({ page }) => {
    await fakePhoneVoice(page, null)
    await startPhone(page, freshBackend(), {
      voices: [
        { id: 'de-de-x-deb-local', name: 'Deutsch', lang: 'de-DE', local: true, default: true },
        { id: 'en-us-x-sfg-local', name: 'English US', lang: 'en-US', local: true, default: false },
        { id: 'en-us-x-sfg-network', name: 'English US online', lang: 'en-US', local: false, default: false },
      ],
    })
    await openShell(page, { route: '/settings/voice' })
    await expect(page.getByTestId('m-settings-voice-phone')).toHaveAttribute('data-source', 'native')
    // The phone HAS a voice: nothing on the page says otherwise, and reading aloud needs no account.
    await expect(page.getByTestId('m-settings-voice-phone-none')).toHaveCount(0)
    await expect(page.getByTestId('m-settings-voice-screen')).not.toContainText('no voice installed')
    await expect(page.getByTestId('m-settings-voice-intro')).toContainText('Reading aloud works with the voice of this phone')
    await expect(page.getByTestId('m-settings-voice-read-aloud')).toBeEnabled()
    const list = page.getByTestId('m-settings-voice-phone-list')
    await expect(list).toContainText('English US')
    await expect(list.locator('[data-m-id="en-us-x-sfg-network"]')).toContainText('needs internet')
    // The native voice has speed and no pitch, so there is no pitch slider.
    await expect(page.getByTestId('m-settings-voice-speed')).toBeVisible()
    await expect(page.getByTestId('m-settings-voice-pitch')).toHaveCount(0)
    expect(await layout(page)).toEqual(CLEAN)

    // The default voice of a German phone reading the English preview: the language of the text goes along.
    await page.getByTestId('m-settings-voice-test-system').tap()
    await expect.poll(async () => (await phone(page)).spoken.length).toBe(1)
    expect((await phone(page)).spoken[0]).toMatchObject({ text: 'Hello. This is how I sound when I read an answer to you.', lang: 'en-US', rate: 1 })
    expect((await phone(page)).spoken[0].voice).toBeUndefined()
    // The button goes back to "Test system voice" when the phone says the text ended.
    await expect(page.getByTestId('m-settings-voice-test-system')).toHaveText('Test system voice')

    // Hear one voice and pick it: exactly that voice is asked for, and the pick is saved.
    await page.getByRole('button', { name: 'Preview English US', exact: true }).tap()
    await expect.poll(async () => (await phone(page)).spoken.length).toBe(2)
    expect((await phone(page)).spoken[1]).toMatchObject({ voice: 'en-us-x-sfg-local', lang: 'en-US' })
    await list.locator('[data-m-id="en-us-x-sfg-local"]').tap()
    await expect(list.locator('[data-m-id="en-us-x-sfg-local"]')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('m-settings-voice-phone-failed')).toHaveCount(0)
    expect((await phone(page)).calls).toContain('plugin:lu-native|tts_voices')
  })

  test('H2: a phone without a speech engine and without speechSynthesis is the only one told "no voice installed"', async ({ page }) => {
    await fakePhoneVoice(page, null)
    await startPhone(page, freshBackend())
    await openShell(page, { route: '/settings/voice' })
    await expect(page.getByTestId('m-settings-voice-phone')).toHaveAttribute('data-source', 'none')
    await expect(page.getByTestId('m-settings-voice-phone-none')).toContainText('This phone has no voice installed.')
    expect((await phone(page)).calls).toContain('plugin:lu-native|tts_voices')
    expect((await phone(page)).spoken).toHaveLength(0)
  })

  test('M8 "Save backup to this phone": the file goes through the save dialog of the system, and the page says where it is', async ({ page }) => {
    await startPhone(page, freshBackend())
    await openShell(page, { route: '/settings/data' })
    await pickFile(page, 'm-settings-data-restore', 'backup.json', SAMPLE_BACKUP)
    await page.getByTestId('m-settings-data-restore-confirm').tap()
    await expect(page.getByTestId('m-toast-restore-done')).toHaveText('2 chats restored')

    await page.getByTestId('m-settings-data-backup-save').tap()
    const note = page.getByTestId('m-settings-data-backup-note')
    await expect(note).toContainText(/Backup of 2 chats saved as lu-chats-\d{4}-\d{2}-\d{2}-2\.json in the folder you picked\./)
    await expect(note).toContainText('tap Restore from a backup file and pick that file')
    await expect(page.getByTestId('m-settings-data-backup-note-text')).toHaveAttribute('data-ok', 'yes')
    await expect(page.getByTestId('m-toast-backup-done')).toHaveText('Backup of 2 chats saved')
    const record = await phone(page)
    expect(record.calls).toContain('plugin:lu-native|save_to_files')
    expect(record.calls).not.toContain('plugin:lu-native|share_file')
    expect(record.saved).toHaveLength(1)
    expect(String(record.saved[0].filename)).toMatch(/^lu-chats-.*-2\.json$/)
    expect(await layout(page)).toEqual(CLEAN)

    // Sharing stays possible next to it, and says that the place is the choice of the other app.
    await page.getByTestId('m-settings-data-backup').tap()
    await expect(note).toContainText('handed to the share sheet')
    expect((await phone(page)).calls).toContain('plugin:lu-native|share_file')
  })

  test('M8 the save dialog closed without a folder: nothing is claimed', async ({ page }) => {
    await startPhone(page, freshBackend(), { save: 'closed' })
    await openShell(page, { route: '/settings/data' })
    await pickFile(page, 'm-settings-data-restore', 'backup.json', SAMPLE_BACKUP)
    await page.getByTestId('m-settings-data-restore-confirm').tap()
    await expect(page.getByTestId('m-toast-restore-done')).toHaveText('2 chats restored')
    await page.getByTestId('m-settings-data-backup-save').tap()
    await expect(page.getByTestId('m-settings-data-backup-note')).toHaveText('Nothing was saved. The save dialog was closed without picking a folder.')
    await expect(page.getByTestId('m-settings-data-backup-note-text')).toHaveAttribute('data-ok', 'no')
    await expect(page.getByTestId('m-toast-backup-done')).toHaveCount(0)
  })

  test('M8 a build without the save command: the page sends the user to Share backup instead of claiming a file', async ({ page }) => {
    await startPhone(page, freshBackend(), { save: 'missing' })
    await openShell(page, { route: '/settings/data' })
    await pickFile(page, 'm-settings-data-restore', 'backup.json', SAMPLE_BACKUP)
    await page.getByTestId('m-settings-data-restore-confirm').tap()
    await expect(page.getByTestId('m-toast-restore-done')).toHaveText('2 chats restored')
    await page.getByTestId('m-settings-data-backup-save').tap()
    await expect(page.getByTestId('m-settings-data-backup-note')).toContainText('Use Share backup and pick Files or another app.')
    await expect(page.getByTestId('m-toast-backup-done')).toHaveCount(0)
  })

  test('The automatic backup carries the phone settings and no secrets, and the row says when it was really written', async ({ page }) => {
    const backend = freshBackend()
    // No secure storage: the provider key stays in the storage of the app, reversed and encoded. That is the case that must not leak.
    await startPhone(page, backend, { keychain: 'none' })
    const KEY = 'gsk_mock_key_that_must_not_travel_0123456789'
    const ENCODED = Buffer.from(KEY.split('').reverse().join('')).toString('base64')

    await openShell(page, { route: '/settings/providers' })
    await page.getByTestId('m-settings-providers-row-groq').tap()
    await page.getByTestId('m-settings-provider-key').fill(KEY)
    await page.getByTestId('m-settings-provider-key-save').tap()
    await expect(page.getByTestId('m-settings-provider-state')).toHaveAttribute('data-key', 'saved')
    // The premise of this test: without secure storage the encoded key really sits in the storage of the app.
    expect(await persisted(page, 'lu-providers')).toContain(ENCODED)
    // A search key in the chat settings, as plain text.
    await page.evaluate(async () => {
      const { useSettingsStore } = ((await import(/* @vite-ignore */ '/src/stores/settingsStore.ts' as string)) as typeof import('../../src/stores/settingsStore'))
      useSettingsStore.getState().updateSettings({ braveApiKey: 'BSA-mock-search-key-0123456789' } as never)
    })

    await openShell(page, { route: '/settings/appearance' })
    await page.getByTestId('m-settings-appearance-theme-light').tap()
    await openShell(page, { route: '/settings/privacy' })
    await page.getByTestId('m-settings-privacy-counter').tap()
    await expect(page.getByTestId('m-settings-privacy-counter')).toHaveAttribute('aria-checked', 'false')

    await openShell(page, { route: '/settings/data' })
    await expect(page.getByTestId('m-settings-data-auto')).toContainText('Automatic backup')
    await page.getByTestId('m-settings-data-auto-now').tap()
    await expect(page.getByTestId('m-toast-auto-backup-done')).toBeVisible()
    await expect(page.getByTestId('m-settings-data-auto')).toContainText('Last written')
    expect(await layout(page)).toEqual(CLEAN)

    const record = await phone(page)
    expect(record.backups.length).toBeGreaterThan(0)
    for (const raw of record.backups) {
      // No key in any form, in any snapshot that was handed to the native layer.
      expect(raw).not.toContain(KEY)
      expect(raw).not.toContain(ENCODED)
      expect(raw).not.toContain('BSA-mock-search-key-0123456789')
    }
    const last = JSON.parse(record.backups.at(-1) ?? '{}') as Record<string, string>
    // The phone settings are part of it.
    expect(last['lu-mobile-theme']).toBe('light')
    expect(JSON.parse(last['lu-mobile-settings-prefs']).state.switchCounter).toBe(false)
    // The provider keeps its entry, without the key.
    const providers = JSON.parse(last['lu-providers']) as { state: { providers: Record<string, { apiKey?: string; baseUrl?: string }> } }
    const entries = Object.values(providers.state.providers)
    expect(entries.some((entry) => (entry.baseUrl ?? '').includes('groq'))).toBe(true)
    expect(entries.map((entry) => entry.apiKey ?? '').filter(Boolean)).toEqual([])
    // And the app itself still has the key: leaving it out of the backup took nothing away.
    expect(await persisted(page, 'lu-providers')).toContain(ENCODED)
  })

  test('A custom endpoint on any https host: "Test connection" goes through the native layer, which the page policy does not block', async ({ page }) => {
    const backend = freshBackend()
    await startPhone(page, backend)
    await openShell(page, { route: '/settings/providers' })
    await page.getByTestId('m-settings-providers-row-custom').tap()
    await page.getByTestId('m-settings-provider-url').fill('https://llm.example.org/v1')
    await page.getByTestId('m-settings-provider-url-save').tap()
    await expect(page.getByTestId('m-toast-provider-url-saved')).toBeVisible()
    await page.getByTestId('m-settings-provider-key').fill('own-endpoint-mock-key-0123456789')
    await page.getByTestId('m-settings-provider-key-save').tap()
    await keySavedNoteAway(page)
    await expect(page.getByTestId('m-settings-provider-state')).toHaveAttribute('data-key', 'saved')
    await page.getByTestId('m-settings-provider-test').tap()
    await expect(page.getByTestId('m-settings-provider-test-ok')).toHaveText('Connected. 2 models found.')
    const record = await phone(page)
    // The host was announced to the native layer first, then asked through it, with the key.
    expect(record.hosts).toContain('llm.example.org')
    const asked = record.proxied.find((call) => call.url === 'https://llm.example.org/v1/models')
    expect(asked).toBeTruthy()
    expect(Object.values(asked?.headers ?? {}).join(' ')).toContain('own-endpoint-mock-key-0123456789')
    // Switched on, its models are in the model list of the app (audit 1.3, 1.6, 15.8: a provider that is saved is also used).
    await page.getByTestId('m-settings-provider-use').tap()
    await expect(page.getByTestId('m-settings-provider-state')).toHaveAttribute('data-enabled', 'yes')
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu-models-refresh')))
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const { useModelStore } = ((await import(/* @vite-ignore */ '/src/stores/modelStore.ts' as string)) as typeof import('../../src/stores/modelStore'))
          return useModelStore.getState().models.filter((m) => m.name.includes('own-model-')).length
        }),
      )
      .toBe(2)
    // The page itself never asked that host: the policy of the page would have refused it.
    expect(backend.calls.filter((c) => c.includes('llm.example.org'))).toEqual([])
    expect(backend.calls.filter((c) => c.startsWith('UNMOCKED'))).toEqual([])
  })
})

// Screenshots of every page and sheet of the strand, for looking at them. Not part of a normal run.
test.describe('settings screenshots', () => {
  test.skip(!process.env.LU_SETTINGS_SHOTS, 'set LU_SETTINGS_SHOTS=1 to write the screenshots')
  test.use({ deviceScaleFactor: 1 })

  const VARIANTS = [
    { name: '390x844-dark', width: 390, height: 844, theme: 'dark', fs: 100 },
    { name: '390x844-light', width: 390, height: 844, theme: 'light', fs: 100 },
    { name: '320x568-light-200', width: 320, height: 568, theme: 'light', fs: 200 },
    { name: '844x390-land-dark', width: 844, height: 390, theme: 'dark', fs: 100 },
  ] as const

  for (const v of VARIANTS) {
    test(v.name, async ({ page }) => {
      test.setTimeout(600_000)
      fs.mkdirSync(SHOTS, { recursive: true })
      const backend = freshBackend()
      await mockBackend(page, backend)
      await page.setViewportSize({ width: v.width, height: v.height })
      const problems: string[] = []
      const options = { theme: v.theme, fontScale: v.fs }

      const settle = async () => {
        await screensLoaded(page)
        await page.evaluate(async () => {
          await document.fonts.ready
          const finite = document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
          await Promise.all(finite.map((a) => a.finished.catch(() => undefined)))
        })
        await page.waitForTimeout(250)
      }
      /** One picture of what is on screen, and one more of the end of a page that scrolls. */
      const shot = async (view: string) => {
        await settle()
        // A toast from the step before would cover the very thing the picture is for.
        await page.locator('.m-toast').first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => undefined)
        await page.evaluate(() => {
          const bodies = [...document.querySelectorAll('.m-page:not([data-m-hidden]) .m-body')]
          const el = (document.querySelector('.m-dlg') ?? document.querySelector('.m-sheet-body') ?? bodies[bodies.length - 1]) as HTMLElement | undefined
          if (el) el.scrollTop = 0
        })
        await page.waitForTimeout(100)
        const report = await measureLayout(page)
        if (report.overflow.length || report.small.length || report.pageScrolls) problems.push(`${view}: ${JSON.stringify(report)}`)
        await page.screenshot({ path: path.join(SHOTS, `${v.name}--${view}.png`) })
        const more = await page.evaluate(() => {
          const sheet = document.querySelector('.m-sheet-body')
          const bodies = [...document.querySelectorAll('.m-page:not([data-m-hidden]) .m-body')]
          const el = (document.querySelector('.m-dlg') ?? sheet ?? bodies[bodies.length - 1]) as HTMLElement | undefined
          if (!el || el.scrollHeight <= el.clientHeight + 8) return false
          el.scrollTop = el.scrollHeight
          return true
        })
        if (more) {
          await page.waitForTimeout(150)
          await page.screenshot({ path: path.join(SHOTS, `${v.name}--${view}-end.png`) })
        }
      }
      const open = (route: string) => openShell(page, { ...options, route })
      const sheet = async (id: string) => {
        await open('/dev/routes')
        await page.getByTestId(`m-dev-sheet-open-${id}`).tap()
      }

      // Signed out.
      await openShell(page, options)
      await page.getByTestId('m-page-back').tap()
      await page.getByTestId('m-nav-settings').tap()
      await shot('01-settings-signed-out')
      await open('/settings/account')
      await shot('02-account-signed-out')
      await page.getByTestId('m-account-email').fill(EMAIL)
      await page.getByTestId('m-account-password').fill('wrong-one')
      await page.getByTestId('m-account-signin').tap()
      await expect(page.getByText('Email or password is not correct.')).toBeVisible()
      await shot('03-account-wrong-password')
      await open('/cloud')
      await shot('04-cloud-signed-out')
      await open('/settings/voice')
      await shot('05-voice-signed-out')
      await open('/settings/content-policy')
      await shot('06-content-policy-signed-out')

      // Signed in, with a plan.
      await open('/settings/account')
      await signIn(page)
      await shot('07-account-signed-in')
      await page.getByTestId('m-account-delete').tap()
      await shot('08-delete-account-sheet')
      await page.getByTestId('m-account-delete-go-delete').tap()
      await shot('09-delete-account-dialog')
      await openShell(page, options)
      await page.getByTestId('m-page-back').tap()
      await page.getByTestId('m-nav-settings').tap()
      await shot('10-settings-signed-in')
      await open('/cloud')
      await shot('11-cloud-ready')
      await page.getByTestId('m-cloud-turn-on').tap()
      await shot('12-cloud-switch-dialog')
      await open('/settings/appearance')
      await shot('13-appearance')
      await open('/settings/chat')
      await shot('14-chat-defaults')
      await open('/settings/voice')
      await shot('15-voice')
      await open('/settings/providers')
      await shot('16-providers')
      await page.getByTestId('m-settings-providers-row-custom').tap()
      await shot('17-provider-custom')
      await open('/settings/providers')
      await page.getByTestId('m-settings-providers-row-groq').tap()
      await page.getByTestId('m-settings-provider-key').fill('gsk_mock_key_for_shots_0123456789')
      await page.getByTestId('m-settings-provider-key-save').tap()
      await keySavedNoteAway(page)
      await page.getByTestId('m-settings-provider-test').tap()
      await expect(page.getByTestId('m-settings-provider-test-ok')).toBeVisible()
      await shot('18-provider-key-saved')
      await open('/settings/remote')
      await shot('19-remote')
      await open('/settings/data')
      await pickFile(page, 'm-settings-data-restore', 'backup.json', SAMPLE_BACKUP)
      await shot('20-data-restore-found')
      await page.getByTestId('m-settings-data-restore-confirm').tap()
      await page.getByTestId('m-settings-data-all-delete').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await shot('21-data-delete-dialog')
      await open('/settings/data/import')
      await pickFile(page, 'm-settings-data-import-choose', 'conversations.json', SAMPLE_CHATGPT_EXPORT)
      await shot('22-data-import-found')
      await page.getByTestId('m-settings-data-import-run').tap()
      await shot('23-data-import-done')
      await open('/settings/privacy')
      await shot('24-privacy')
      await open('/settings/content-policy')
      await shot('25-content-policy')
      await open('/settings/troubleshooting')
      await page.getByTestId('m-settings-troubleshooting-self-test').tap()
      await shot('26-troubleshooting')
      await open('/settings/about')
      await shot('27-about')
      await page.getByTestId('m-settings-about-licenses').tap()
      await shot('28-licenses-sheet')
      await open('/whats-new')
      await shot('29-whats-new')

      // The sheets of the strand.
      await openShell(page, options)
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:credits-exhausted', { detail: { reason: 'credits' } })))
      await shot('30-credits-sheet')
      await sheet('session')
      await shot('31-session-sheet')
      await sheet('price')
      await shot('32-price-sheet')
      await open('/dev/routes')
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:deep-link', { detail: { url: 'lu://auth?code=mock-oauth-code' } })))
      await shot('33-link-offer-sheet')

      // Account states that need another backend answer.
      backend.plan = 'past-due'
      await open('/settings/account')
      await shot('34-account-past-due')
      backend.plan = 'none'
      await open('/cloud')
      await shot('35-cloud-no-plan')

      expect(problems).toEqual([])
    })
  }
})
