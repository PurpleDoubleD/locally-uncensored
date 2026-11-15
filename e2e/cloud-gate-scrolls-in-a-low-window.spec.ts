import { test, expect, type Locator, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'

/**
 * A window 230 px high (a tiling window manager gives the app a strip): the
 * cloud gate is taller than the window. The shared Modal centred its panel in
 * an overlay that did not scroll, so the panel was cut off at both ends and
 * "Sign in" lay below the window edge, out of reach.
 *
 * The overlay scrolls now. This spec walks the whole signed-out way through the
 * gate in a 900x230 window with the mouse wheel and real clicks, and checks
 * that Escape and the X still close it.
 */

const LOW = { width: 900, height: 230 }

test.use({ viewport: LOW })

/** Is the whole element inside the window? Visible pixels on both sides. */
async function insideWindow(el: Locator): Promise<boolean> {
  const box = await el.boundingBox()
  if (!box) return false
  return box.y >= 0 && box.y + box.height <= LOW.height && box.x >= 0 && box.x + box.width <= LOW.width
}

/** Turn the wheel over the dialog until the element is inside the window. */
async function wheelTo(page: Page, el: Locator): Promise<void> {
  await page.mouse.move(LOW.width / 2, LOW.height / 2)
  for (let i = 0; i < 40 && !(await insideWindow(el)); i++) {
    const box = await el.boundingBox()
    await page.mouse.wheel(0, box && box.y < 0 ? -60 : 60)
    await page.waitForTimeout(50)
  }
  expect(await insideWindow(el), 'the wheel never brought the element into the window').toBe(true)
}

async function openGate(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'none' })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await cloudSwitch(page).click()
  await expect(page.getByRole('dialog')).toBeVisible()
}

test('the gate is taller than a 230 px window, and every button is reached by scrolling', async ({ page }) => {
  await openGate(page)

  // The premise: the panel does not fit, and the way to the sign in form
  // starts below the window edge.
  const dialog = page.getByRole('dialog')
  const panel = await dialog.boundingBox()
  expect(panel!.height, 'the gate fits into the window, this spec tests nothing').toBeGreaterThan(LOW.height)
  // Since 3.1.0 the sign in sits at the top of the panel (funnel Nr. 11), so
  // the button below the window edge is the last one, "See all plans".
  const toLogin = page.getByRole('button', { name: /Already bought\? Sign in/i })
  const allPlans = page.getByRole('button', { name: /See all plans/i })

  // The top of the dialog is not cut off: the wheel brings the X into the
  // window, and from up there the end of the panel is below the edge.
  await wheelTo(page, dialog.locator('[data-dialog-close]'))
  expect(await insideWindow(allPlans)).toBe(false)
  await wheelTo(page, allPlans)
  await allPlans.click({ trial: true })

  // And back up to the sign in.
  await wheelTo(page, toLogin)
  await toLogin.click()

  // The sign in step. The form is filled from the keyboard, the button is
  // reached with the wheel and pressed with a real click.
  await page.getByPlaceholder('Email').fill('qa@lu-labs.ai')
  await page.getByPlaceholder('Password').fill('e2e-password')
  const signIn = page.getByRole('button', { name: /^Sign in$/i })
  await wheelTo(page, signIn)
  await signIn.click()

  // The click arrived: the account has no plan, and the gate says so.
  await expect(page.getByText(/no active plan/i)).toBeAttached({ timeout: 20_000 })
  // The last button of that wall is reachable too.
  const again = page.getByRole('button', { name: /I bought, check again/i })
  await wheelTo(page, again)
  await again.click({ trial: true })
})

test('Escape and the X close the gate in the low window, and Tab stays inside it', async ({ page }) => {
  await openGate(page)
  const dialog = page.getByRole('dialog')

  // The focus trap: a dozen Tabs never leave the dialog, and a focused button
  // further down is scrolled into the window.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab')
    const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))
    expect(inside, `Tab ${i + 1} left the dialog`).toBe(true)
    const focused = page.locator(':focus')
    const box = await focused.boundingBox()
    expect(box!.y + box!.height, `Tab ${i + 1}: the focused control is below the window`).toBeLessThanOrEqual(LOW.height + 1)
    expect(box!.y, `Tab ${i + 1}: the focused control is above the window`).toBeGreaterThanOrEqual(-1)
  }

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await cloudSwitch(page).click()
  await expect(dialog).toBeVisible()
  const x = dialog.locator('[data-dialog-close]')
  await wheelTo(page, x)
  await x.click()
  await expect(dialog).toBeHidden()
})
