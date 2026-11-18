import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { tauriMockInit, DEFAULT_MODEL_NAME, DEFAULT_ASSISTANT_REPLY } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * 3.1.2, A38 (GitHub #256) and A39 (GitHub #257), as the user meets them in
 * Settings → Agent → Agent Permissions: the token limit per run right after
 * the credit limits, without a LU Cloud account, and the switch "Share date
 * and time with the model", on by default. Both land in the stored settings.
 *
 * LU_A38_SHOTS=<folder> saves a picture of the rows in light and dark.
 */

const SHOTS = process.env.LU_A38_SHOTS
// The app's own module, loaded in the page: Vite serves one instance per URL.
const CLOCK_SHARE_URL = '/src/lib/clock-share.ts'

async function boot(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.goto('/')
  await expect(page.getByRole('banner')).toBeVisible()
}

async function openPermissions(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const limit = page.getByTestId('run-token-limit-settings')
  if (!(await limit.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Agent Permissions', exact: true }).click()
  }
  await limit.scrollIntoViewIfNeeded()
  await expect(limit).toBeVisible()
  return limit
}

const stored = (page: Page) =>
  page.evaluate(() => {
    const raw = window.localStorage.getItem('chat-settings')
    const s = raw ? (JSON.parse(raw).state?.settings ?? {}) : {}
    return { tokens: s.agentRunHaltTokens as number | undefined, clock: s.shareClockWithModel as boolean | undefined }
  })

test.describe('A38/A39: agent limits in Agent Permissions', () => {
  test('the token limit sits after the credit limits and is kept', async ({ page }) => {
    await boot(page)
    const limit = await openPermissions(page)
    const select = limit.getByTestId('run-token-limit')
    await expect(select).toHaveValue('2000000')
    await expect(select.locator('option')).toHaveText(['2M tokens', '5M tokens', '10M tokens', 'No limit'])
    // Right after the credit limits, in the same list.
    const order = await page.evaluate(() => {
      const credit = document.querySelector('[data-testid="credit-limits"]')!
      const tokens = document.querySelector('[data-testid="run-token-limit-settings"]')!
      return credit.nextElementSibling === tokens
    })
    expect(order).toBe(true)
    await select.selectOption('0')
    // Kept in the stored settings (a reload would re-run the seed script).
    await expect.poll(async () => (await stored(page)).tokens).toBe(0)
    await expect(select).toHaveValue('0')
  })

  test('the clock switch is on by default and turns off', async ({ page }) => {
    await boot(page)
    await openPermissions(page)
    const toggle = page.getByRole('switch', { name: 'Share date and time with the model' })
    await toggle.scrollIntoViewIfNeeded()
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect.poll(async () => (await stored(page)).clock).toBe(false)
    // The app's own module answers the way every agent path asks.
    const line = await page.evaluate(async (url) => {
      const m = (await import(/* @vite-ignore */ url)) as { agentClockLine: () => string }
      return m.agentClockLine()
    }, CLOCK_SHARE_URL)
    expect(line).toBe('')
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`picture of the rows (${theme})`, async ({ page }) => {
      test.skip(!SHOTS, 'only with LU_A38_SHOTS')
      await boot(page)
      if (theme === 'light') await page.getByRole('button', { name: 'Light Mode' }).click()
      else if (await page.getByRole('button', { name: 'Dark Mode' }).isVisible().catch(() => false)) await page.getByRole('button', { name: 'Dark Mode' }).click()
      await openPermissions(page)
      // From the loop guard to the clock switch: the rows this change touches.
      const from = page.getByRole('switch', { name: 'Loop guard' })
      const to = page.getByRole('switch', { name: 'Share date and time with the model' })
      await to.scrollIntoViewIfNeeded()
      await to.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await page.waitForTimeout(800)
      const top = (await from.boundingBox())!
      const bottom = (await to.boundingBox())!
      const column = (await page.getByTestId('credit-limits').boundingBox())!
      mkdirSync(SHOTS!, { recursive: true })
      await page.screenshot({
        path: `${SHOTS}/agent-permissions-${theme}.png`,
        clip: { x: column.x - 24, y: Math.max(0, top.y - 24), width: column.width + 48, height: bottom.y + bottom.height + 64 - Math.max(0, top.y - 24) },
      })
    })
  }
})
