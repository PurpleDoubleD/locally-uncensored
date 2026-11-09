import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * C26 (3.1.0): a How-it-works film opens over the whole window, and C25: the
 * dialog sheet it sits on is opaque white in the light theme. The films come
 * from lu-labs.ai; here a local clip stands in for them.
 */
const SHOTS = process.env.LU_SHOTS_DIR
const CLIP = readFileSync(new URL('../docs/assets/home/katana.mp4', import.meta.url))

test('the How-it-works film can be enlarged to the window (light theme)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route('https://lu-labs.ai/howto/**', (r) => r.fulfill({ body: CLIP, contentType: 'video/mp4' }))
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await page.addInitScript(() => {
    const raw = JSON.parse(localStorage.getItem('chat-settings') || '{}')
    raw.state.settings.theme = 'light'
    localStorage.setItem('chat-settings', JSON.stringify(raw))
  })
  await page.goto('/')
  await expect(page.locator('html')).toHaveClass(/light/)

  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Onboarding' }).click()
  const entry = page.getByTestId('howto-beginners')
  await expect(entry).toBeVisible()
  const topic = (await entry.getAttribute('data-testid'))!.slice('howto-'.length)
  await entry.locator('button').first().click()
  const card = page.getByTestId(`howto-card-${topic}`)
  await expect(card).toBeVisible()
  await expect(page.getByTestId('howto-video')).toBeVisible()
  const small = await page.getByTestId('howto-video').boundingBox()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/C26-1-karte-klein.png` })

  await page.getByTestId('howto-enlarge').click()
  const big = page.getByTestId('howto-video-large')
  await expect(big).toBeVisible()
  await page.waitForTimeout(1200)
  const box = await big.boundingBox()
  expect(box!.width).toBeGreaterThan(small!.width * 3)
  expect(box!.width).toBeGreaterThan(1000)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/C26-2-vergroessert-hell.png` })

  // C25: the sheet under the big film is .lu-dialog, opaque white in light.
  const bg = await page.locator('.lu-dialog').first().evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg).toBe('rgb(255, 255, 255)')

  await page.keyboard.press('Escape')
  await expect(big).toBeHidden()
  await expect(card).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()
})
