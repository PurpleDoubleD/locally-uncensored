import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch, cloudSwitchBehindModal, type CloudScenario } from './support/cloud-mock'

/**
 * 2.5.7 cloud gate — the wall in front of Cloud mode (David's 4-options flow).
 *
 * (a) signed in without a plan → the three plan buttons (name + monthly EUR
 *     price) open lu-labs.ai/pricing in the SYSTEM browser (asserted via the
 *     mocked shell-open recorder), the switch stays off;
 * (b) licensed but not yet enabled server-side (access:false) → the
 *     "server hasn't switched Cloud on" wall with Check again, switch stays
 *     off (the 2.5.7 closed-beta wording is gone — launch is open);
 * (c) "Stay on Local" closes the gate with the switch off.
 */

async function boot(page: Page, scenario: CloudScenario) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await routeCloud(page, scenario)
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
}

test('signed in without a plan: plan buttons → browser, switch stays off', async ({ page }) => {
  await boot(page, { license: 'none' })
  await signInViaGate(page)

  await expect(page.getByText(/no active plan/i)).toBeVisible({ timeout: 20_000 })

  // David's 4 options: three plans (with the monthly price up front) + back
  // to Local. `€` in the pattern keeps "Max" from matching the window's
  // Maximize button.
  await expect(page.getByRole('button', { name: /^Hosted €19/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Pro €49/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Stay on Local/i })).toBeVisible()
  await page.getByRole('button', { name: /^Max €99/ }).click()

  const opened = await page.evaluate(() => (window as unknown as { __E2E_OPENED_URLS__?: string[] }).__E2E_OPENED_URLS__ ?? [])
  expect(opened.some((u) => u.includes('/pricing#max'))).toBe(true)

  // Gate holds: the switch is still off. Read through the modal-proof locator —
  // the gate is still open here, and an open dialog marks the rest of the page
  // `inert` + `aria-hidden`, so the role query would find nothing and this
  // would fail for a reason that has nothing to do with the switch.
  await expect(cloudSwitchBehindModal(page)).toHaveAttribute('aria-checked', 'false')
})

test('licensed but not server-enabled (access:false): wall with Check again, switch stays off', async ({ page }) => {
  await boot(page, { license: 'active', tier: 'hosted-pro', access: false })
  await signInViaGate(page)

  await expect(page.getByText(/hasn't switched Cloud on/i)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: /Check again/i })).toBeVisible()
  // Same reason as above: the wall IS the open dialog, so the switch behind it
  // is out of the accessibility tree by design.
  await expect(cloudSwitchBehindModal(page)).toHaveAttribute('aria-checked', 'false')
})

test('"Stay on Local" closes the gate with the switch off', async ({ page }) => {
  await boot(page, { license: 'none' })
  await signInViaGate(page)

  await expect(page.getByText(/no active plan/i)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /Stay on Local/i }).click()

  await expect(page.getByText(/no active plan/i)).toBeHidden()
  await expect(cloudSwitch(page)).not.toBeChecked()
})
