import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * The sampling control opens a popup and leaves the prompt window alone.
 *
 * 2026-09-11: "der sample anklickbar im prompt fenster muss ein pop up
 * sein, und nicht das prompt fenster veraendern. mit einem sauberen x zum
 * wegklicken und nicht einfach wieder auf den text klicken zum entfernen, soll
 * windows mac und webapp ueberall gleich sein."
 *
 * The fields used to render as a sibling below the trigger, inside the action
 * row, so opening them grew the composer by the height of the panel and moved
 * the text field with it. The unit tests can only say that the panel is out of
 * the flow: jsdom has no layout, every box there measures 0, and a height
 * comparison would pass whatever the component did. This file is where the
 * pixels are actually compared, in a real engine with real layout.
 *
 * Measured, before and after opening: the text field, the action row the
 * trigger sits in, and the send button at the end of that row. If any of the
 * three moves or changes size, the popup is not a popup.
 */

interface Kasten { x: number; y: number; w: number; h: number }
interface Masse { textarea: Kasten; row: Kasten; send: Kasten }

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  await openNewChat(page)
}

/** The composer's geometry, rounded to whole pixels: sub-pixel jitter from the
 *  font stack is not a layout change and must not fail this. */
async function masse(page: Page): Promise<Masse> {
  return page.evaluate(() => {
    const runden = (el: Element | null): { x: number; y: number; w: number; h: number } => {
      if (!el) return { x: -1, y: -1, w: -1, h: -1 }
      const b = el.getBoundingClientRect()
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
    }
    const send = document.querySelector('[data-testid="composer-send-slot"]')
    // The row is the first ancestor with a box of its own: since 3.0.9 the send
    // slot sits in a cluster that is `display: contents` in a wide window.
    let row = send?.parentElement ?? null
    while (row && getComputedStyle(row).display === 'contents') row = row.parentElement
    return {
      textarea: runden(document.querySelector('textarea')),
      row: runden(row),
      send: runden(send),
    }
  })
}

test('the popup opens over the composer and moves nothing in it', async ({ page }) => {
  await boot(page)

  const trigger = page.getByTestId('sampling-trigger')
  await expect(trigger).toBeVisible({ timeout: 15_000 })

  const vorher = await masse(page)
  // Sanity: the measurement found real boxes. Without this the comparison
  // below could compare two rows of -1 and pass by reading nothing.
  expect(vorher.textarea.w).toBeGreaterThan(0)
  expect(vorher.row.h).toBeGreaterThan(0)
  expect(vorher.send.w).toBeGreaterThan(0)

  await trigger.click()
  const panel = page.getByTestId('sampling-panel')
  await expect(panel).toBeVisible()

  const nachher = await masse(page)
  expect(nachher).toEqual(vorher)

  // And it really is a popup: it hangs above its trigger and reaches up over
  // the transcript, instead of taking room inside the row.
  const kasten = await panel.boundingBox()
  const ausloeser = await trigger.boundingBox()
  expect(kasten).not.toBeNull()
  expect(ausloeser).not.toBeNull()
  expect(kasten!.y + kasten!.height).toBeLessThanOrEqual(ausloeser!.y + 1)
  expect(kasten!.y).toBeLessThan(vorher.row.y)
})

test('a second press on the trigger leaves the popup standing', async ({ page }) => {
  await boot(page)

  const trigger = page.getByTestId('sampling-trigger')
  await trigger.click()
  await expect(page.getByTestId('sampling-panel')).toBeVisible()

  await trigger.click()
  await expect(page.getByTestId('sampling-panel')).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
})

test('the X closes it, and so does Escape', async ({ page }) => {
  await boot(page)

  const trigger = page.getByTestId('sampling-trigger')
  await trigger.click()
  const x = page.getByRole('button', { name: 'Close sampling settings' })
  await expect(x).toBeVisible()
  await x.click()
  await expect(page.getByTestId('sampling-panel')).toHaveCount(0)
  // The keyboard comes back to the trigger, so the popup can be reopened
  // without reaching for the mouse again.
  await expect(trigger).toBeFocused()

  await trigger.click()
  await expect(page.getByTestId('sampling-panel')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('sampling-panel')).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('a value set in the popup is still there when it is opened again', async ({ page }) => {
  await boot(page)

  const trigger = page.getByTestId('sampling-trigger')
  await trigger.click()
  // Der Ausloeser traegt seit B18 selbst einen Namen ("Sampling: temperature
  // 0.7"), damit ihn eine Vorlesehilfe im geschlossenen Zustand ansagt. Ein
  // Name auf Text trifft damit zwei Elemente. Gemeint ist der Regler im Popup,
  // also greift der Fall ihn ueber seine Rolle.
  const temperature = page.getByRole('slider', { name: 'Temperature' })
  await temperature.fill('1.45')
  await page.getByRole('button', { name: 'Close sampling settings' }).click()

  await trigger.click()
  await expect(page.getByRole('slider', { name: 'Temperature' })).toHaveValue('1.45')
  // The closed trigger shows the same number, which is how the row says that
  // something is on the wire without the popup being open.
  await page.keyboard.press('Escape')
  await expect(trigger).toContainText('1.45')
})
