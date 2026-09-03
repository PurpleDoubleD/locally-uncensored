import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * Bekommt eine deutsche Bitte dieselben Werkzeuge wie eine englische?
 *
 * Persona-Lauf vom 03.09.2026, `llama3.2:3b`, normaler Chat. Zweimal in
 * frischen Chats getippt:
 *
 *   „Hol bitte die Seite https://example.com und sag mir woertlich, welche
 *    Ueberschrift dort steht."
 *
 * Im Payload an Ollama stand **kein `tools`-Feld**. Das Modell antwortete, es
 * koenne keine URLs aufrufen — auf Englisch lief derselbe Satz sauber. Die
 * Plugins-Leiste behauptete dabei die ganze Zeit „Chat Tools · web · file ·
 * image · video".
 *
 * Genau da setzt dieser Test an, und zwar an derselben Stelle, an der die
 * Persona gemessen hat: am abgeschickten Koerper, nicht am Bildschirm. Der
 * Unit-Test in `chat-tool-intent.test.ts` prueft die Erkennung; dass die
 * Kette von der Eingabe bis zum Payload haelt, prueft nur dieser hier.
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

async function schicke(page: Page, text: string) {
  await page.evaluate(() => { (window as never as { __E2E_CHAT_BODIES__?: string[] }).__E2E_CHAT_BODIES__ = [] })
  const feld = page.locator('textarea').first()
  await feld.click()
  await feld.fill(text)
  await page.keyboard.press('Enter')
  // Auf den abgeschickten Koerper warten statt auf eine feste Zeit — der
  // Werkzeugweg laeuft ueber einen anderen Ausfuehrer und braucht laenger.
  await expect
    .poll(async () => (await koerper(page)).length, { timeout: 20_000 })
    .toBeGreaterThan(0)
}

async function koerper(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as never as { __E2E_CHAT_BODIES__?: string[] }).__E2E_CHAT_BODIES__ ?? [],
  )
}

/** Welche Werkzeugnamen im ersten abgeschickten Koerper standen. */
async function werkzeuge(page: Page): Promise<string[]> {
  const bodies = await koerper(page)
  const namen: string[] = []
  for (const b of bodies) {
    try {
      const j = JSON.parse(b)
      for (const t of j.tools ?? []) {
        const n = t?.function?.name ?? t?.name
        if (typeof n === 'string') namen.push(n)
      }
    } catch { /* kein JSON — dann eben keine Werkzeuge */ }
  }
  return namen
}

test('eine deutsche Seiten-Bitte schickt die Werkzeuge mit', async ({ page }) => {
  await boot(page)
  await schicke(page, 'Hol bitte die Seite https://example.com und sag mir woertlich, welche Ueberschrift dort steht.')
  expect(await werkzeuge(page)).toContain('web_fetch')
})

test('dieselbe Bitte auf Englisch — der Vergleich, den die Persona gezogen hat', async ({ page }) => {
  await boot(page)
  await schicke(page, 'Please fetch the page https://example.com and tell me the exact heading.')
  expect(await werkzeuge(page)).toContain('web_fetch')
})

test('gewoehnliche Unterhaltung laeuft weiter ohne Werkzeuge', async ({ page }) => {
  // Ohne diese Gegenprobe waere der Test oben auch dann gruen, wenn die App
  // einfach jeder Nachricht Werkzeuge anhaengt — und genau daran verschluckt
  // sich ein kleines Modell (Persona-Befund 5: es plappert den Katalog nach).
  await boot(page)
  await schicke(page, 'Erklaer mir mal, wie Rekursion funktioniert.')
  expect(await werkzeuge(page)).toEqual([])
})
