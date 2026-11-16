import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'

/**
 * A list that is lifted out of the tree (`position: fixed`, portal on body)
 * follows its trigger on every scroll. When the trigger sits in a scrolling
 * panel and is scrolled out of it, the list used to follow it out of the
 * panel and out of the window, and hung over whatever lies there.
 *
 * Measured in the advanced settings drawer of Create: the Sampler select sits
 * at the end of a panel that scrolls. The promise: while the trigger can be
 * seen, the list sits on it inside the window. Once the trigger is scrolled
 * out of its panel, the list is not shown, and it comes back with the trigger.
 */

const OPTS: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'windows',
}

function drawer(page: Page) {
  return page.locator('aside').filter({ hasText: 'Advanced settings' })
}

function samplerSelect(page: Page) {
  return drawer(page)
    .getByText('Sampler', { exact: true })
    .locator('xpath=../following-sibling::div[1]')
    .locator('button[aria-haspopup="listbox"]')
}

async function bootIntoDrawer(page: Page) {
  await page.addInitScript(tauriMockInit, OPTS)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).first().click()
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeChecked({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Advanced settings' }).click()
  await expect(drawer(page).getByRole('button', { name: 'Quality', exact: true })).toBeVisible({ timeout: 15_000 })
  await drawer(page).getByRole('button', { name: 'Expert', exact: true }).click()
  await expect(samplerSelect(page)).toBeVisible()
}

/** Trigger, list, the scrolling panel of the trigger and the window, in visible pixels. */
async function measure(page: Page) {
  return samplerSelect(page).evaluate((trigger) => {
    let panel = trigger.parentElement as HTMLElement
    while (!/(auto|scroll)/.test(getComputedStyle(panel).overflowY) || panel.scrollHeight <= panel.clientHeight) {
      panel = panel.parentElement as HTMLElement
    }
    const listbox = document.querySelector('[role="listbox"]') as HTMLElement | null
    const menu = listbox?.parentElement ?? null
    const box = (el: Element) => {
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
    }
    return {
      trigger: box(trigger),
      panel: box(panel),
      menu: menu ? box(menu) : null,
      menuShown: menu !== null && getComputedStyle(menu).visibility !== 'hidden',
      scrollTop: panel.scrollTop,
      scrollMax: panel.scrollHeight - panel.clientHeight,
      width: window.innerWidth,
      height: window.innerHeight,
    }
  })
}

/** Scrolls the panel of the trigger the way a wheel does: through the element, with a scroll event. */
async function scrollPanelTo(page: Page, top: number) {
  await samplerSelect(page).evaluate((trigger, y) => {
    let panel = trigger.parentElement as HTMLElement
    while (!/(auto|scroll)/.test(getComputedStyle(panel).overflowY) || panel.scrollHeight <= panel.clientHeight) {
      panel = panel.parentElement as HTMLElement
    }
    panel.scrollTop = y
  }, top)
  // Two frames: the scroll event, then the placement that answers it.
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
}

test('a list whose trigger is scrolled out of its panel is not left hanging in the window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 })
  await bootIntoDrawer(page)

  // Bring the trigger to the middle of its panel, so there is room to scroll
  // it out on either side.
  const before = await measure(page)
  expect(before.scrollMax, 'the panel has to scroll for this test to mean anything').toBeGreaterThan(200)
  await scrollPanelTo(page, before.scrollTop + (before.trigger.top - (before.panel.top + before.panel.bottom) / 2))

  await samplerSelect(page).click()
  const list = page.getByRole('listbox')
  await expect(list).toBeVisible()
  await expect.poll(() => list.evaluate((el) => getComputedStyle(el.parentElement as HTMLElement).opacity)).toBe('1')

  const open = await measure(page)
  // One pixel for sub-pixel rounding: under load the trigger was seen 0.14 px
  // past the panel edge (16.11.2026, seven parallel runs).
  expect(open.trigger.top, 'the trigger starts inside its panel').toBeGreaterThanOrEqual(open.panel.top - 1)
  expect(open.trigger.bottom, 'the trigger ends inside its panel').toBeLessThanOrEqual(open.panel.bottom + 1)
  expect(open.menuShown).toBe(true)

  // A small scroll: the trigger stays in view and the list stays on it.
  await scrollPanelTo(page, open.scrollTop + 20)
  const moved = await measure(page)
  expect(moved.trigger.top, 'the trigger moved with the panel').toBeLessThan(open.trigger.top - 10)
  expect(moved.menuShown).toBe(true)
  const menu = moved.menu!
  const above = menu.bottom <= moved.trigger.top + 1
  const gap = above ? moved.trigger.top - menu.bottom : menu.top - moved.trigger.bottom
  expect(gap, 'gap between trigger and list').toBeGreaterThanOrEqual(0)
  expect(gap, 'gap between trigger and list').toBeLessThanOrEqual(8)
  expect(menu.top).toBeGreaterThanOrEqual(0)
  expect(menu.bottom).toBeLessThanOrEqual(moved.height)

  // Scroll the trigger out at the bottom of its panel.
  await scrollPanelTo(page, 0)
  const gone = await measure(page)
  expect(gone.trigger.top, 'the trigger left its panel').toBeGreaterThanOrEqual(gone.panel.bottom)
  expect(gone.menuShown, 'the list is still shown although its trigger is out of sight').toBe(false)
  await expect(list).toBeHidden()

  // And out at the top.
  await scrollPanelTo(page, gone.scrollMax)
  const goneAbove = await measure(page)
  if (goneAbove.trigger.bottom <= goneAbove.panel.top) {
    expect(goneAbove.menuShown, 'the list is still shown although its trigger is out of sight').toBe(false)
  }

  // Back in view: the list is back on its trigger.
  await scrollPanelTo(page, open.scrollTop)
  const back = await measure(page)
  expect(back.menuShown).toBe(true)
  await expect(list).toBeVisible()
  expect(Math.abs(back.menu!.top - open.menu!.top), 'the list is back where it was').toBeLessThanOrEqual(1)
})
