/** Screenshot of the C59 switch in Settings → Agent Permissions. Runs only with LU_BENCH_SHOT=<png path>. */
import { test, expect } from '@playwright/test'
import { seedOnboardingDone } from '../support/cloud-mock'

const OUT = process.env.LU_BENCH_SHOT

test('C59 switch in the settings', async ({ page }) => {
  test.skip(!OUT, 'set LU_BENCH_SHOT')
  await seedOnboardingDone(page)
  await page.goto('/')
  await page.getByRole('button', { name: /settings/i }).first().click()
  const label = page.getByText('Short tool list for local models', { exact: true })
  await label.scrollIntoViewIfNeeded()
  await expect(label).toBeVisible()
  await expect(page.getByText(/finds every other tool with tool_search/)).toBeVisible()
  const box = await label.locator('xpath=ancestor::*[self::section or self::div][4]').boundingBox()
  await page.screenshot({ path: OUT!, clip: box ?? undefined })
})
