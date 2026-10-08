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
  /**
   * /api/me license.paidPlan: hat dieses Konto je gezahlt?
   *
   * Die Freimengenmarke und der stehende Flash-Satz haengen daran und nicht am
   * Lizenzstatus, weil der Chat-Vermittler nach derselben Regel abrechnet. Ohne
   * Angabe fehlt das Feld in der Antwort, der Klient liest das als "noch nicht
   * beantwortet" und verspricht nichts. Ein Fall, der die Marke sehen will,
   * sagt es hier.
   */
  paidPlan?: boolean
  /**
   * P9: the extended /api/jobs/catalog contract the Create-Studio port reads
   * (Portplan Abschnitt 4, Punkt 5): a Studio model entry carrying
   * `api_schema`/`pricing`/`quote_required`, plus `clip.durations` and
   * `credits.by_duration` on the classic video entry (dd29f359). The Preset
   * shelf and StudioParams gate purely on `quote_required` being present on
   * AT LEAST ONE entry (never a version number, Portplan Abschnitt 4);
   * leaving this unset reproduces an OLDER server's catalog (no entry knows
   * Studio at all), the shelf must stay hidden.
   */
  studioCatalog?: boolean
  /**
   * Status /api/jobs/studio-quote answers with. 200 (default) returns a
   * flat, deterministic price; 404 reproduces "the route exists but this
   * server build predates Studio" (Portplan Abschnitt 4: "This feature needs
   * a newer LU Cloud server. Try again later."); 'unreachable' does not
   * register the route at all, reproducing the pre-P0 CORS gap the same way
   * (both collapse to the identical client-side message).
   */
  studioQuoteStatus?: 200 | 404 | 'unreachable'
  /**
   * 02.10.2026: the catalog of a server that ships `tier` and `weights` on
   * every entry plus a Studio image model (Nucleus). Leaving it unset
   * reproduces the server of today: no entry carries either field, and the
   * pickers must stand there neutral (no mark, no "Older models" row).
   */
  tierCatalog?: boolean
}

// P9: one Studio model, shaped like a real /api/jobs/catalog entry once P0's
// CORS fix and the live server both carry the Studio fields. `minimax-music`
// matches a real STUDIO_MODELS id (src/lib/render/studio-models.json) so the
// app's own bundled provider schema (SchemaControl's source of truth, never
// the server) renders the same fields a live run would use: a flat-rate
// model with a bare `prompt` input, no upload, the simplest full booking path
// for an e2e run. `pricing`/`api_schema` mirror studio-contract.ts's own
// StudioModel/Schema shape (Portplan Abschnitt 2.1), present on the wire so
// a future server-truth switch is a data change, not a contract change; nothing
// on the client reads them yet (studioQuote() is the price source of record).
const STUDIO_CATALOG_MODEL = {
  id: 'minimax-music',
  label: 'MiniMax Music',
  kind: 'audio' as const,
  edit: false,
  cfg: false,
  negative_prompt: false,
  quote_required: true,
  pricing: { mode: 'flat', rates: { default: 0.15 } },
  api_schema: {
    type: 'object',
    properties: { prompt: { type: 'string', description: 'Prompt for the music generation.' } },
    required: ['prompt'],
  },
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
              ? { status: 'active', tier, access, ...(scenario.paidPlan === undefined ? {} : { paidPlan: scenario.paidPlan }) }
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
            { id: 'flux-schnell', label: 'Flux Schnell (fast)', kind: 'image', edit: false, cfg: true, negative_prompt: false, credits: { base: 300 }, ...(scenario.tierCatalog ? { tier: 'older', weights: 'open' } : {}) },
            { id: 'flux-dev', label: 'Flux Dev (quality)', kind: 'image', edit: true, cfg: true, negative_prompt: false, credits: { base: 1200 }, ...(scenario.tierCatalog ? { tier: 'older', weights: 'open' } : {}) },
            {
              id: 'wan-2.2-720p', label: 'Wan 2.2 720p', kind: 'video', edit: false, cfg: false, negative_prompt: true,
              // dd29f359: clip.durations/credits.by_duration let a model book
              // any advertised length, not just a fixed short/long pair.
              // 4/6/9 are deliberately NOT the 5/8 short/long pair, so a spec
              // asserting these three buttons proves the Length control
              // really reads the catalog and not a hardcoded fallback.
              clip: scenario.studioCatalog ? { short: 5, long: 8, durations: [4, 6, 9] } : { short: 5, long: 8 },
              credits: scenario.studioCatalog
                ? { base: 40000, long: 64000, by_duration: { '4': 32000, '6': 48000, '9': 72000 } }
                : { base: 40000, long: 64000 },
            },
            // Review B1 (Runde 2): the CLASSIC twin of two role intents
            // (Extend, Motion) that predates Studio and must keep working
            // when the catalog carries no `quote_required` at all, present
            // on EVERY scenario, not just studioCatalog, so
            // create-studio.spec.ts can prove the fallback actually resolves
            // to a real, pickable model instead of an empty list.
            { id: 'wan-2.2-spicy-extend', label: 'Wan 2.2 Uncensored Extend', kind: 'video', ops: ['extend'], t2v: false, i2v: false, adult: true, credits: { base: 15000 } },
            { id: 'wan-2.2-animate', label: 'Wan 2.2 Animate', kind: 'video', ops: ['motion'], t2v: false, i2v: false, credits: { base: 12000 } },
            ...(scenario.studioCatalog ? [STUDIO_CATALOG_MODEL] : []),
            ...(scenario.tierCatalog
              ? [{ id: 'z-image-turbo', label: 'Z-Image Turbo (fast)', kind: 'image' as const, edit: false, cfg: false, negative_prompt: false, credits: { base: 300 }, tier: 'best', weights: 'open' },
                 { id: 'nucleus-image', label: 'Nucleus', kind: 'image' as const, adult: true, ops: ['studio'], quote_required: true, tier: 'standard', weights: 'open-family' }]
              : []),
          ],
          ops: { removebg: 1000, eraser: 2500, upscale_image: 1000, upscale_video_per_s: 500, upscale_video_min: 2500 },
          voice: { stt: 600, tts_per_1k_chars: 8000 },
          media_live: scenario.mediaLive !== false,
          tier,
          monthly_credits: 2_550_000,
        }),
      )
    }

    // P9: POST /api/jobs/studio-quote, the provider-confirmed price a Studio
    // run asks for before it books (Portplan Abschnitt 4, Punkt 1). A flat,
    // deterministic number; real per-model pricing is studio-contract.ts's
    // job, not this mock's.
    if (path === '/api/jobs/studio-quote') {
      if (scenario.studioQuoteStatus === 404) return route.fulfill(json(404, { error: 'not found' }))
      // 'unreachable': the pre-P0 state (no withCors/OPTIONS at all). The
      // browser never lets a response reach the app, so the mock aborts
      // instead of fulfilling, the same failure shape a real CORS block
      // produces (studio.ts's own comment: this collapses to the identical
      // "newer LU Cloud server" text as a 404).
      if (scenario.studioQuoteStatus === 'unreachable') return route.abort('failed')
      return route.fulfill(json(200, { credits: 1500 }))
    }

    // P9: GET /api/jobs/runtime (Portplan Abschnitt 4, Punkt 2). Empty is a
    // valid, common answer (MIN_SAMPLES: silence over a guess). No spec
    // needs a populated runtime map, so this mock never returns one.
    if (path === '/api/jobs/runtime') {
      return route.fulfill(json(200, { runtimes: {} }))
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
              // The effort ladder, so the composer's effort control has
              // something to render on the mocked catalogue too. The Llama
              // entry above deliberately declares none: think 'never' models
              // get no ladder from the server, and no control from us.
              reasoning_effort_levels: ['low', 'medium', 'high'],
              reasoning_effort_default: 'high',
            },
            {
              // A model that always reasons, with its own ladder: the Think
              // button renders locked on and the effort control is live beside
              // it. Without an entry of this shape the mocked catalogue could
              // only ever exercise the toggle case.
              id: 'zai-org/GLM-5.3-Flash',
              object: 'model',
              owned_by: 'lu-labs',
              name: 'GLM 5.3 Flash',
              context_length: 1048576,
              max_output_length: 8192,
              input_modalities: ['text', 'image'],
              think: 'always',
              supports_tools: true,
              reasoning_effort_levels: ['low', 'medium', 'high', 'max'],
              reasoning_effort_default: 'high',
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

/** Sign in through the CloudGateModal that the header switch opens.
 *
 *  Seit dem 13.09.2026 hat der abgemeldete Weg zwei Schritte statt drei: das
 *  Verkaufs-Panel und die Anmeldung. Der Zwischenschritt mit den drei
 *  Planknoepfen ist geloescht, der Kaufknopf geht in den Browser. Wer schon
 *  zahlt, nimmt den Textlink darunter. */
export async function signInViaGate(page: Page): Promise<void> {
  await cloudSwitch(page).click()
  await page.getByRole('button', { name: /Already subscribed\? Sign in/i }).click()
  await page.getByPlaceholder('Email').fill('qa@lu-labs.ai')
  await page.getByPlaceholder('Password').fill('e2e-password')
  await page.getByRole('button', { name: /^Sign in$/i }).click()
}
