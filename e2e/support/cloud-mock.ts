import type { Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Network mock for the LU Cloud e2e specs: intercepts the Supabase auth host
 * and every lu-labs.ai API the desktop client calls, so the full account →
 * gate → cloud-mode flow runs with zero real accounts or credits.
 *
 * Fulfilled responses still pass the browser's CORS checks (the app origin is
 * localhost:5173, the APIs are cross-origin), so every response carries
 * wildcard CORS headers and OPTIONS preflights are answered.
 */

export interface CloudScenario {
  /** /api/me license.status — 'active' or 'none' (signed in, no plan). */
  license: 'active' | 'none'
  /** Launch gate: false = licensed but closed-beta walled. Default true. */
  access?: boolean
  /** Server MEDIA_LIVE switch surfaced via the catalog. Default true. */
  mediaLive?: boolean
  tier?: string
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
}

const USER = { id: 'e2e-user-1', email: 'qa@lu-labs.ai', aud: 'authenticated', role: 'authenticated' }

// 1×1 transparent PNG for the mocked render result.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

export async function routeCloud(page: Page, scenario: CloudScenario): Promise<void> {
  const access = scenario.access !== false
  const tier = scenario.tier ?? 'hosted-max'

  const json = (status: number, body: unknown) => ({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  // ── Supabase auth (password grant + user probe) ────────────────────────
  await page.route('**/auth/v1/**', async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const url = req.url()
    if (url.includes('/token')) {
      return route.fulfill(
        json(200, {
          access_token: 'e2e-access-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'e2e-refresh-token',
          user: USER,
        }),
      )
    }
    if (url.includes('/user')) return route.fulfill(json(200, USER))
    if (url.includes('/logout')) return route.fulfill(json(204, {}))
    return route.fulfill(json(200, {}))
  })

  // ── lu-labs.ai API surface ─────────────────────────────────────────────
  await page.route('https://lu-labs.ai/**', async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const path = new URL(req.url()).pathname

    if (path === '/api/me') {
      return route.fulfill(
        json(200, {
          user: { id: USER.id, email: USER.email },
          license:
            scenario.license === 'active'
              ? { status: 'active', tier, access }
              : { status: 'none' },
          profile: null,
        }),
      )
    }

    if (path === '/api/jobs/quota') {
      return route.fulfill(
        json(200, {
          tier,
          period: '2026-07',
          limits: { credits: 2_550_000 },
          costs: { image: 1200, video: 40000 },
          used: { credits_used: 12_345 },
          remaining: { credits: 2_537_655 },
          topup: { credits: 0 },
          video: { limit: 300_000, used: 0, remaining: 300_000 },
          trainings: { limit: 2, used: 0, remaining: 2 },
        }),
      )
    }

    if (path === '/api/jobs/catalog') {
      return route.fulfill(
        json(200, {
          models: [
            { id: 'flux-schnell', label: 'Flux Schnell (fast)', kind: 'image', edit: false, cfg: true, negative_prompt: false, credits: { base: 300 } },
            { id: 'flux-dev', label: 'Flux Dev (quality)', kind: 'image', edit: true, cfg: true, negative_prompt: false, credits: { base: 1200 } },
            { id: 'wan-2.2-720p', label: 'Wan 2.2 720p', kind: 'video', edit: false, cfg: false, negative_prompt: true, clip: { short: 5, long: 8 }, credits: { base: 40000, long: 64000 } },
          ],
          ops: { removebg: 1000, eraser: 2500, upscale_image: 1000, upscale_video_per_s: 500, upscale_video_min: 2500 },
          voice: { stt: 600, tts_per_1k_chars: 8000 },
          media_live: scenario.mediaLive !== false,
          tier,
          monthly_credits: 2_550_000,
        }),
      )
    }

    if (path === '/api/inference/v1/models') {
      return route.fulfill(
        json(200, {
          object: 'list',
          tier,
          data: [
            {
              id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
              object: 'model',
              owned_by: 'lu-labs',
              name: 'Llama 3.1 8B Turbo',
              context_length: 131072,
              max_output_length: 8192,
              input_modalities: ['text'],
              think: 'never',
            },
            {
              id: 'Qwen/Qwen3-30B-A3B',
              object: 'model',
              owned_by: 'lu-labs',
              name: 'Qwen3 30B A3B',
              context_length: 40960,
              max_output_length: 8192,
              input_modalities: ['text'],
              think: 'toggle',
            },
          ],
        }),
      )
    }

    if (path === '/api/jobs' && req.method() === 'POST') {
      return route.fulfill(
        json(202, {
          id: 'job-e2e-1',
          status: 'queued',
          created_at: new Date().toISOString(),
          quota: { kind: 'image', cost: 300, used: 12_645, limit: 2_550_000 },
        }),
      )
    }

    if (path === '/api/jobs/job-e2e-1') {
      return route.fulfill(
        json(200, {
          job: {
            id: 'job-e2e-1',
            kind: 'image',
            model: 'flux-schnell',
            provider: 'wavespeed',
            status: 'succeeded',
            result_url: 'https://lu-labs.ai/e2e/result.png',
            attestation: null,
            cost_units: 300,
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            error: null,
          },
        }),
      )
    }

    if (path === '/e2e/result.png') {
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'image/png' }, body: PNG_1PX })
    }

    return route.fulfill(json(404, { error: `unmocked path ${path}` }))
  })
}

/**
 * The version this build IS. `ReleaseNotesModal` imports package.json directly
 * and compares against that string, so anything else here would rot at the
 * next version bump — and rot silently, because the symptom is a modal, not an
 * error. Read the same way tts-csp.spec.ts reads tauri.conf.json.
 */
const APP_VERSION: string = (
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'),
  ) as { version: string }
).version

/**
 * Pre-seed the persisted state so the app boots straight into chat (no
 * onboarding walk) in LOCAL mode. The settingsStore merge() backfills every
 * missing field from defaults, so the minimal shape is enough.
 *
 * TWO markers, not one, and the second is the one that used to be missing:
 *
 * `onboardingDone: true` with NO release-notes stamp is not "a user who has
 * finished onboarding" — it is exactly the fingerprint of an UPGRADER, and
 * that is a state the app deliberately reacts to. `shouldShowReleaseNotes`
 * (stores/releaseNotesStore.ts) reads `lastNotesVersion === null` together
 * with `onboardingDone === true` as "has not seen this version's notes yet"
 * and opens the "What is new" sheet, which is a `fixed inset-0 z-[90]`
 * backdrop over the whole app. Every click a spec then issues lands on the
 * backdrop, so the specs did not fail on what they assert — they never got to
 * assert it. The specs that walk the real onboarding wizard were unaffected,
 * because finishing it stamps the version; only the ones that took this
 * shortcut were hit. That is the whole difference between the green and the
 * red half of this suite.
 *
 * So the stamp belongs here: it is not a workaround for the sheet, it is the
 * rest of the state "onboarded on this build" actually consists of. A spec
 * that wants to see the sheet simply does not call this helper.
 */
export async function seedOnboardingDone(page: Page): Promise<void> {
  await page.addInitScript((version: string) => {
    window.localStorage.setItem(
      'chat-settings',
      JSON.stringify({ state: { settings: { onboardingDone: true, appMode: 'local' }, _version: 10 }, version: 10 }),
    )
    // Same key and shape zustand's persist writes for useReleaseNotesStore
    // (no `version` option there, so the envelope version is 0).
    window.localStorage.setItem(
      'lu_release_notes',
      JSON.stringify({ state: { lastNotesVersion: version }, version: 0 }),
    )
  }, APP_VERSION)
}

/** The purple Cloud light-switch in the header (right cluster). */
export function cloudSwitch(page: Page) {
  return page.getByRole('switch', { name: /^Cloud$/i })
}

/**
 * The same switch, reachable WHILE a modal is open.
 *
 * `ui/Modal` puts `inert` + `aria-hidden="true"` on the rest of the page for
 * as long as a dialog is up (Modal.tsx, "(2) Hintergrund inert"), which is
 * exactly what a dialog is supposed to do. The consequence for a spec is that
 * every role-based query — `cloudSwitch()` included — finds NOTHING behind an
 * open gate, and an assertion like "the switch stayed off" then fails with
 * `element(s) not found` instead of telling you about the switch.
 *
 * This reads the SAME `aria-checked` attribute through a locator the dialog
 * does not filter. It is not a weaker assertion, it is the same one asked in a
 * way the dialog cannot swallow. Use `cloudSwitch()` whenever no modal is up.
 */
export function cloudSwitchBehindModal(page: Page) {
  return page.locator('button[role="switch"][aria-label="Cloud"]')
}

/** Sign in through the CloudGateModal that the header switch opens. The
 *  signed-out gate is a stepped flow: hero → plans → in-app sign-in. */
export async function signInViaGate(page: Page): Promise<void> {
  await cloudSwitch(page).click()
  await page.getByRole('button', { name: /Get LU Cloud/i }).click()
  await page.getByRole('button', { name: /Already got an account/i }).click()
  await page.getByPlaceholder('Email').fill('qa@lu-labs.ai')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: /^Sign in$/i }).click()
}
