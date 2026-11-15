import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'
import { openCharacterAction } from './support/character-hub'

/**
 * Billing by length in the Create tab (3.0.6).
 *
 * The server prices a voice by its characters and a talking video by the
 * seconds of its audio, and sends the rule in the catalog (`credits.length`).
 * The app shows the price of what is typed, and sends that figure as the
 * ceiling (`max_credits`): without a ceiling the server starts only what the
 * catalog figure covers.
 *
 * Run: CI=1 LU_E2E_PORT=5601 npx playwright test e2e/create-length-price.spec.ts
 */

const OUT = process.env.LU_E2E_SHOT_DIR

async function boot(page: Page, lengthCatalog: boolean) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, paidPlan: true, lengthCatalog })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
  await openCharacterAction(page, 'Talking Character')
  await page.getByRole('button', { name: /Add voice/ }).click()
  await page.getByRole('button', { name: /Generate a voice/ }).click()
}

test('the voice button shows the price of the typed text and sends it as the ceiling', async ({ page }) => {
  await boot(page, true)
  const text = page.getByPlaceholder('What should the character say?')
  const make = page.getByRole('button', { name: /^Make voice/ })

  // Nothing typed: no figure to show.
  await expect(make).toHaveText('Make voice')
  // 250 characters are three blocks of 100 at 105 credits.
  await text.fill('a'.repeat(250))
  await expect(make).toHaveText('Make voice · 315 credits')
  // A short line is one block.
  await text.fill('Hello there, how are you today?')
  await expect(make).toHaveText('Make voice · 105 credits')
  if (OUT) await page.screenshot({ path: `${OUT}/create-voice-price-by-length.png` })

  const posted = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST')
  await make.click()
  const body = (await posted).postDataJSON() as { model: string; params: Record<string, unknown> }
  expect(body.model).toBe('qwen3-tts')
  expect(body.params.op).toBe('tts')
  expect(body.params.max_credits).toBe(105)
})

test('a server from before the rule: no figure on the button and no ceiling sent', async ({ page }) => {
  await boot(page, false)
  const make = page.getByRole('button', { name: /^Make voice/ })
  await page.getByPlaceholder('What should the character say?').fill('Hello there, how are you today?')
  await expect(make).toHaveText('Make voice')
  const posted = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST')
  await make.click()
  const body = (await posted).postDataJSON() as { params: Record<string, unknown> }
  expect(body.params.op).toBe('tts')
  expect('max_credits' in body.params).toBe(false)
})
