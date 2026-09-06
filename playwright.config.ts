import { defineConfig, devices } from '@playwright/test'

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
 * We serve the app with `npm run dev` (Vite, port 5273 — the tauri devUrl). The
 * dev middleware only spawns on `/local-api/*` requests, which the mock never
 * triggers, so boot has no side effects.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://localhost:5273',
    trace: 'on-first-retry',
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5273',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
