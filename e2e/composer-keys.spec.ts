import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * The composer's keyboard contract, which nothing anywhere asserted.
 *
 * Written to settle a tester's report of 2026-09-03: that Enter neither sent
 * nor broke the line, that Shift+Enter produced no paragraph, and that neither
 * Cmd+A nor the arrow keys did anything — i.e. that the field was unusable for
 * anyone writing more than a sentence. `handleKeyDown` says otherwise
 * (Enter && !shiftKey -> preventDefault + send; everything else falls through
 * to the textarea), so one of the two is wrong, and a report is not evidence.
 *
 * Playwright presses real keys through the browser, which a DOM-level
 * automation harness does not. If the contract holds here, the report was an
 * artefact of how the field was driven, and saying so is worth more than
 * "fixing" behaviour that was never broken.
 */

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  await openNewChat(page)
  return page.locator('textarea').first()
}

test('Shift+Enter breaks the line, Enter sends', async ({ page }) => {
  const box = await boot(page)
  await box.click()
  await box.type('Zeile1')
  await page.keyboard.press('Shift+Enter')
  await box.type('Zeile2')
  expect(await box.inputValue()).toBe('Zeile1\nZeile2')

  await page.keyboard.press('Enter')
  await expect(page.getByText('Zeile1', { exact: false }).first()).toBeVisible()
  expect(await box.inputValue()).toBe('')
})

test('the caret and select-all work like a text field', async ({ page }) => {
  const box = await boot(page)
  await box.click()
  await box.type('abc')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await box.type('X')
  expect(await box.inputValue()).toBe('aXbc')

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await page.keyboard.press('Backspace')
  expect(await box.inputValue()).toBe('')
})

test('starting a new chat does not carry the old draft along', async ({ page }) => {
  // Reported alongside the above: an unsent draft reappeared in the next chat.
  // A draft belongs to the conversation it was written in, or to nothing.
  const box = await boot(page)
  await box.click()
  await box.type('ein unfertiger Entwurf')
  await openNewChat(page)
  // Wartende Zusicherung, nicht Momentaufnahme: der Wechsel raeumt das Feld in
  // einem Effekt, und openNewChat kehrt zurueck, sobald das Feld sichtbar ist —
  // eine Zeile frueher.
  await expect(page.locator('textarea').first()).toHaveValue('')
})

test('a draft comes back when you return to the chat you wrote it in', async ({ page }) => {
  // Die Gegenprobe zum Fix oben. Beim Wechsel einfach zu leeren waere dieselbe
  // Sorte Fehler, nur teurer: der halbe Satz waere nicht am falschen Ort,
  // sondern weg. Er wird beiseitegelegt, nicht weggeworfen.
  const box = await boot(page)
  await box.click()
  await box.type('Satz fuer Chat eins')

  await openNewChat(page)
  await expect(page.locator('textarea').first()).toHaveValue('')

  // Zurueck in den ersten Chat: die Seitenleistenzeile, die gerade NICHT
  // ausgewaehlt ist.
  await page.getByRole('option', { selected: false }).first().click()
  await expect(page.locator('textarea').first()).toHaveValue('Satz fuer Chat eins')
})
