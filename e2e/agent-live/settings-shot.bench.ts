/** Screenshot of the C59 switch in Settings → Agent Permissions. Runs only with LU_BENCH_SHOT=<png path>. */
import { test, expect } from '@playwright/test'
import { seedOnboardingDone } from '../support/cloud-mock'

const OUT = process.env.LU_BENCH_SHOT

test('C59 switch in the settings', async ({ page }) => {
  test.skip(!OUT, 'set LU_BENCH_SHOT')
  // Tall enough that the whole block of agent switches is painted at once.
  await page.setViewportSize({ width: 1280, height: 4000 })
  await seedOnboardingDone(page)
  await page.goto('/')
  await page.getByRole('button', { name: /settings/i }).first().click()
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const label = page.getByText('Short tool list for local models', { exact: true })
  // The section opens on a click when it starts folded.
  if (!(await label.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /Agent Permissions/i }).first().click()
  }
  await label.scrollIntoViewIfNeeded()
  await expect(label).toBeVisible()
  await expect(page.getByText(/finds every other tool with tool_search/)).toBeVisible()
  // The switch row, the line under it and the switches just above it.
  // The section unfolds with an animation; measure after it has settled.
  await page.waitForTimeout(1500)
  const b = await label.boundingBox()
  await page.screenshot({ path: OUT!, clip: b ? { x: Math.max(0, b.x - 24), y: Math.max(0, b.y - 70), width: 800, height: 170 } : undefined })
})
