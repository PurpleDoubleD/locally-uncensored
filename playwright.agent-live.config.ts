import { defineConfig, devices } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The agent test bench (C59): the real app, the real agent loop, a real model.
 *
 * Not part of `npm run test:e2e`. Nothing is mocked: the app runs in the
 * browser against the Vite dev server, whose /local-api routes execute the
 * file and shell tools for real (dev-server/fs-routes.ts, exec-routes.ts), and
 * the model answers from the Ollama on this machine or from LU Cloud.
 *
 * The dev server gets a HOME of its own (LU_BENCH_HOME), so every workspace,
 * sandbox and file the agent touches lies under that folder and never in the
 * owner's home. The browser profile is a fresh Playwright context per run.
 *
 *   LU_BENCH_MODELS=<picker label regex>[,…]   which models (required)
 *   LU_BENCH_TASKS=AG1,CO2                      which tasks (default: all)
 *   LU_BENCH_RUNS=3                             runs per task and model
 *   LU_BENCH_OUT=<folder>                       where results.jsonl goes
 *   LU_BENCH_LABEL=vorher|nachher               written into every row
 *
 *   npx playwright test -c playwright.agent-live.config.ts
 */
const port = Number(process.env.LU_BENCH_PORT) || 5291
const home = process.env.LU_BENCH_HOME || join(tmpdir(), 'lu-agent-bench-home')
mkdirSync(home, { recursive: true })
process.env.LU_BENCH_HOME = home

export default defineConfig({
  testDir: './e2e/agent-live',
  testMatch: /.*\.bench\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // One run of a 9B model on a multi-step task takes minutes; the spec ends a
  // run itself after LU_BENCH_RUN_MS and records it as a timeout.
  timeout: 24 * 60 * 60_000,
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
