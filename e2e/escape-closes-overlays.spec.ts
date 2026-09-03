import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * Escape muss jede aufgeklappte Liste wieder schliessen.
 *
 * Zwei Persona-Laeufe am 03.09.2026 meldeten unabhaengig voneinander dasselbe
 * Bild aus verschiedenen Winkeln: „unsichtbare Menue-Reste blockieren die
 * Eingabe", „Escape schliesst keine Menues", „Enter sendet nicht", „mein
 * erster Tippversuch ging komplett verloren". Nachgemessen ist das EIN Fehler
 * mit drei Gesichtern: die Modellauswahl bleibt nach Escape offen (voll
 * deckend, `pointer-events: auto`) und liegt ueber dem Eingabefeld. Wer sie
 * mit Escape geschlossen zu haben glaubt, tippt danach gegen ein Panel.
 *
 * `document.elementFromPoint` statt Sichtpruefung: „sieht geschlossen aus"
 * war ja gerade der Irrtum. Gefragt wird, wohin ein Klick wirklich geht.
 */

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  await openNewChat(page)
}

/** Was ein Klick in der rechten Haelfte des Eingabefeldes tatsaechlich trifft. */
async function trefferUeberComposer(page: Page) {
  return page.evaluate(() => {
    const ta = document.querySelector('textarea')
    if (!ta) return 'KEIN-EINGABEFELD'
    const b = ta.getBoundingClientRect()
    const el = document.elementFromPoint(b.left + b.width * 0.75, b.top + b.height / 2)
    return el?.tagName ?? 'NICHTS'
  })
}

test('Escape schliesst die Modellauswahl und gibt das Eingabefeld frei', async ({ page }) => {
  await boot(page)
  expect(await trefferUeberComposer(page)).toBe('TEXTAREA')

  await page.getByRole('button', { name: 'Select chat model' }).click()
  await page.waitForTimeout(300)
  // Gegenprobe: die Liste liegt wirklich ueber dem Feld — sonst pruefte der
  // Test unten nichts.
  expect(await trefferUeberComposer(page)).not.toBe('TEXTAREA')

  await page.keyboard.press('Escape')
  await expect.poll(() => trefferUeberComposer(page), { timeout: 3000 }).toBe('TEXTAREA')

  // Und danach laesst sich wirklich tippen — das war das Symptom.
  const box = page.locator('textarea').first()
  await box.click()
  await box.type('geht wieder')
  await expect(box).toHaveValue('geht wieder')
})
