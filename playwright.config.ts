import { defineConfig, devices } from '@playwright/test'
import { mobileTestMatch } from './e2e/mobile/filter'

/**
 * Playwright harness for the 2.5.7 built-in-engine onboarding (P3b).
 *
 * The suite drives the real React app in a headless browser with the Tauri
 * bridge stubbed (see `e2e/support/tauri-mock.ts`): injecting
 * `window.__TAURI_INTERNALS__` makes `isTauri()` true, so every backend call
 * and the streaming chat proxy route through our in-page invoke router instead
 * of a real Rust sidecar. That lets the fresh-onboarding → first-chat happy
 * path run with zero external processes (no Ollama, no llama-server).
 *
 * We serve the app with `npm run dev` (Vite, port 5273, the tauri devUrl). The
 * dev middleware only spawns on `/local-api/*` requests, which the mock never
 * triggers, so boot has no side effects.
 */
// Several worktrees on one machine: the fixed port plus reuseExistingServer made
// a run test the dev server of ANOTHER worktree (two red tests on 03.10.2026 that
// pass on their own server). LU_E2E_PORT gives a run its own server on its own
// port, and such a run never adopts a server that is already there.
const ownPort = Number(process.env.LU_E2E_PORT) || 0
const port = ownPort || 5273
const origin = `http://localhost:${port}`

// The mobile shell is only in a bundle that names the phone
// (VITE_LU_BUILD_TARGET=mobile, src/main.tsx). The desktop projects keep the
// server they always had, without the variable, so they test the pure desktop
// bundle. The project `mobile` gets a server of its own with the variable, on
// the next port (LU_E2E_MOBILE_PORT picks another one). It is never adopted
// from somebody else: only a server this run started is known to carry the
// variable. It is started unless the command line picks projects and `mobile`
// is not among them.
const mobilePort = Number(process.env.LU_E2E_MOBILE_PORT) || port + 1
const mobileOrigin = `http://localhost:${mobilePort}`
const pickedProjects = process.argv.flatMap((arg, i, all) =>
  arg.startsWith('--project=') ? [arg.slice('--project='.length)] : arg === '--project' && all[i + 1] ? [all[i + 1]] : [],
)
const mobileRuns = pickedProjects.length === 0 || pickedProjects.includes('mobile')

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // No second try, on CI either. 3.0.8 gave CI two and skipped two tests there; both turned out to be real races
  // that only the slower runner hit (a "trained" toast after a stopped training, a tray read during its fade,
  // 3.0.9). A retry hides that kind of finding, so a red test stays red everywhere.
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: origin,
    trace: 'on-first-retry',
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // The mobile shell (src/mobile). Its files end in `.mobile.ts`, which the
    // default pattern of the project above does not pick up, so the desktop
    // suite runs exactly the files it always ran. Touch, a phone viewport, and
    // the developer switch `?mobile=1` in every address (e2e/mobile/support.ts).
    // The second size (320x568) is set per describe block in the specs.
    //
    // One strand only: LU_E2E_ONLY=agent (or agent,chat) picks the files by
    // their own name. The filter on the command line (`playwright test agent`)
    // is matched against the whole path of a file, and in a worktree called
    // s-agent or r2-agent every file has "agent" in its path.
    {
      name: 'mobile',
      testMatch: mobileTestMatch(process.env.LU_E2E_ONLY),
      use: {
        ...devices['Desktop Chrome'],
        baseURL: mobileOrigin,
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
      },
    },
    // WebKit is the engine of the macOS app (WKWebView). Only the voice
    // session runs on it: its audio path is the part of the app where the two
    // engines really differ. `npx playwright test --project=webkit`.
    { name: 'webkit', testMatch: /voice-(session|cold-start|thinking)-live\.spec\.ts/, use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      command: ownPort ? `npx vite --port ${port} --strictPort` : 'npm run dev',
      url: origin,
      reuseExistingServer: !process.env.CI && !ownPort,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    ...(mobileRuns
      ? [
          {
            command: `npx vite --port ${mobilePort} --strictPort`,
            env: { VITE_LU_BUILD_TARGET: 'mobile' },
            url: mobileOrigin,
            reuseExistingServer: false,
            timeout: 120_000,
            stdout: 'ignore' as const,
            stderr: 'pipe' as const,
          },
        ]
      : []),
  ],
})
