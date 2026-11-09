import { defineConfig, devices } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * C60 live probe: LU runs itself from the chat, with a real model.
 *
 * Not part of `npm run test:e2e`. The real app in the browser against the
 * Vite dev server, the real Agent loop, the model from the Ollama on this
 * machine (read only: nothing is pulled or deleted there). The dev server gets
 * a HOME of its own, the browser a fresh profile per scenario, so nothing of
 * the owner's LU is read or written.
 *
 *   LU_C60_MODEL=<picker label regex>   the model (required)
 *   LU_C60_OUT=<folder>                 screenshots and results.jsonl
 *   LU_C60_ONLY=S1,S5                   which scenarios (default: all)
 *
 *   npx playwright test -c playwright.settings-live.config.ts
 */
const port = Number(process.env.LU_C60_PORT) || 5297
const home = process.env.LU_C60_HOME || join(tmpdir(), 'lu-c60-live-home')
mkdirSync(home, { recursive: true })
process.env.LU_C60_HOME = home

export default defineConfig({
  testDir: './e2e/settings-live',
  testMatch: /.*\.live\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 20 * 60_000,
  expect: { timeout: 30_000 },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${port}`,
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { HOME: home, USERPROFILE: home },
  },
})
