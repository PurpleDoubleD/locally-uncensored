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

/**
 * Dasselbe fuer das Tools-Menue im Composer.
 *
 * Persona B2 meldete „das Menue schliesst sich nicht mit Escape und schluckt
 * danach Klicks". Nachgemessen am 03.09.2026 im laufenden Build stimmte das:
 * nach Escape stand `aria-expanded="true"`, und ein Klick auf „New Chat"
 * landete auf `DIV.fixed inset-0 z-40`. Der Datei-Waechter in
 * `src/hooks/__tests__/escape-schliesst-alles.test.ts` liess ChatView.tsx
 * durch, weil dort ein Genehmigungsdialog auf 'Escape' hoert.
 *
 * Der Knopf steht nur im Agentenmodus, deshalb der Umweg ueber den Schalter
 * und den Arbeitsplatz-Dialog.
 */
test('Escape schliesst das Tools-Menue im Composer und gibt die Klicks frei', async ({ page }) => {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  await openNewChat(page)

  const agentToggle = page.getByRole('main').getByRole('button', { name: 'Agent', exact: true })
  await agentToggle.click()
  const sandbox = page.getByRole('button', { name: /^Sandbox/ })
  await expect(sandbox).toBeVisible({ timeout: 15_000 })
  await sandbox.click()
  await expect(page.getByRole('dialog', { name: /Agent workspace/i })).toHaveCount(0, { timeout: 10_000 })

  const tools = page.getByRole('button', { name: /^Tools/ })
  await expect(tools).toBeVisible({ timeout: 10_000 })
  await tools.click()
  await expect(tools).toHaveAttribute('aria-expanded', 'true')

  await page.keyboard.press('Escape')
  await expect(tools).toHaveAttribute('aria-expanded', 'false', { timeout: 3000 })

  // Und der Klick danach kommt wirklich an. „Sieht zu aus" war ja der Irrtum:
  // die deckende Flaeche bleibt sonst liegen, auch wenn das Panel weg ist.
  const neuerChat = page.getByRole('button', { name: /New Chat/i }).first()
  const kasten = await neuerChat.boundingBox()
  expect(kasten).not.toBeNull()
  const getroffen = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x as number, y as number)
    return el ? `${el.tagName}.${(el as HTMLElement).className}` : 'NICHTS'
  }, [kasten!.x + kasten!.width / 2, kasten!.y + kasten!.height / 2])
  expect(getroffen).not.toContain('fixed inset-0')
})
