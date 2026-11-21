import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * 3.1.3, David on purple: "Unload all models" was the only way to free a GGUF
 * of the LU Engine. Its rows now carry the same On/Off switch as Ollama and
 * LM Studio, the Models page an Unload button, and LU Cloud at the foot of
 * the picker is one line. The engine is a stand-in here; the real process and
 * VRAM are proven on Windows (report 313-KLEINFIXES).
 *
 * Run: LU_E2E_PORT=5403 npx playwright test e2e/lu-engine-unload.spec.ts
 * Pictures: add LU_E2E_SHOT_DIR=/path/to/folder
 */
const PATH = `/mock/${DEFAULT_MODEL_NAME}.gguf`

async function boot(page: Page, dark = true) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
  await page.addInitScript(([dk]) => {
    window.localStorage.setItem('lu-providers', JSON.stringify({ state: { hideBackendSelector: true, providers: {
      ollama: { id: 'ollama', name: 'Ollama', enabled: false, baseUrl: 'http://localhost:11434', apiKey: '', isLocal: true },
      openai: { id: 'openai', name: 'LU Engine', enabled: true, baseUrl: 'http://127.0.0.1:8127/v1', apiKey: '', isLocal: true, managed: true },
      anthropic: { id: 'anthropic', name: 'Anthropic', enabled: false, baseUrl: 'https://api.anthropic.com', apiKey: '', isLocal: false },
      'lu-cloud': { id: 'lu-cloud', name: 'LU Cloud', enabled: false, baseUrl: 'https://lu-labs.ai/api/inference/v1', apiKey: '', isLocal: false },
    } }, version: 1 }))
    document.documentElement.classList.toggle('dark', dk as boolean)
  }, [dark])
  await page.addInitScript(([path]) => {
    type Bridge = { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> }
    const w = window as unknown as { __TAURI_INTERNALS__: Bridge; __E2E_LU__: { path: string | null; stops: number; swaps: number } }
    const state = { path: path as string | null, stops: 0, swaps: 0 }
    w.__E2E_LU__ = state
    const inner = w.__TAURI_INTERNALS__.invoke
    w.__TAURI_INTERNALS__.invoke = (c, a) => {
      if (c === 'bundled_engine_status') return Promise.resolve({ running: !!state.path, healthy: !!state.path, port: 8127, model_path: state.path, ctx: 8192 })
      if (c === 'stop_bundled_engine') { state.stops += 1; state.path = null; return Promise.resolve(null) }
      if (c === 'offload_local_models') { state.stops += 1; state.path = null; return Promise.resolve({ offloaded: ['bundled-engine'], notOurs: [] }) }
      if (c === 'swap_bundled_model') { state.swaps += 1; state.path = path as string }
      return inner(c, a)
    }
  }, [PATH])
  await page.goto('/')
}

const trigger = (page: Page) => page.getByRole('button', { name: 'Select chat model', exact: true })
const seen = (page: Page) => page.evaluate(() => (window as unknown as { __E2E_LU__: { path: string | null; stops: number; swaps: number } }).__E2E_LU__)

test('a GGUF row switches off and on, and Unload all stays there', async ({ page }) => {
  await boot(page)
  await trigger(page).click()
  const menu = page.getByTestId('model-picker-menu')
  const toggle = menu.getByTestId('load-toggle').first()
  await expect(toggle).toHaveAttribute('data-state', 'on')
  await expect(menu.getByTestId('ollama-unload-all')).toBeVisible()
  await toggle.click()
  await expect(toggle).toHaveAttribute('data-state', 'off')
  expect(await seen(page)).toMatchObject({ path: null, stops: 1 })
  await toggle.click()
  await expect.poll(async () => (await seen(page)).swaps).toBe(1)
  await trigger(page).click()
  await expect(page.getByTestId('model-picker-menu').getByTestId('load-toggle').first()).toHaveAttribute('data-state', 'on')
  await page.getByTestId('ollama-unload-all').click()
  await expect(page.getByTestId('ollama-unload-all')).toContainText('Unloaded')
  await expect(page.getByTestId('model-picker-menu').getByTestId('load-toggle').first()).toHaveAttribute('data-state', 'off')
})

for (const dark of [true, false]) {
  test(`LU Cloud is one line that opens the Cloud panel (${dark ? 'dark' : 'light'})`, async ({ page }) => {
    await boot(page, dark)
    if (!dark) {
      await page.getByRole('button', { name: /light mode|dark mode|theme/i }).first().click()
      await expect(page.locator('html')).not.toHaveClass(/dark/)
    }
    await trigger(page).click()
    const row = page.getByTestId('picker-lu-cloud')
    await expect(row).toHaveText('LU Cloud')
    await expect(page.getByText(/Frontier chat models/)).toHaveCount(0)
    if (process.env.LU_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.LU_E2E_SHOT_DIR}/lu-cloud-${dark ? 'dark' : 'light'}.png` })
    await row.click()
    await expect(page.getByText(/Run uncensored models in the cloud/)).toBeVisible()
  })
}
