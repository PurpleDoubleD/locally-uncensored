import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * Was der Kontext-Chip ueber Auto-Verdichtung verraet.
 *
 * Eine Testleserin stellte am 03.09.2026 die Schwelle auf 80 %, beobachtete
 * den Balken wie vorgesehen — und wurde bei einer Anzeige von 62 % verdichtet,
 * ohne jede Vorwarnung. Ihr Satz: „Die einzige Vorwarnung, die es gibt,
 * funktioniert nicht — genau in dem Moment, fuer den ich sie eingeschaltet
 * habe."
 *
 * Der frueher Ausschlag ist Absicht: `shouldAutoCompact` zieht einen
 * Sicherheitsabschlag ab, solange der Fuellstand nur geschaetzt ist, und die
 * Anzeige fragt bewusst dieselbe Funktion. Genau deshalb MUSS sie die
 * wirksame Schwelle auch zeigen — sonst ist der Abschlag eine Ueberraschung
 * statt einer Vorsichtsmassnahme.
 *
 * `auto-compact-mark` gab es laengst; angefahren hat es in `e2e/` bis heute
 * nichts. Diese Datei ist die fehlende Sperrklinke.
 */

async function boot(page: Page, schwelle: number) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  if (schwelle > 0) {
    await page.addInitScript((s: number) => {
      const roh = window.localStorage.getItem('chat-settings')
      const env = roh ? JSON.parse(roh) : { state: { settings: {} }, version: 10 }
      env.state.settings = { ...env.state.settings, autoCompactThreshold: s }
      window.localStorage.setItem('chat-settings', JSON.stringify(env))
    }, schwelle)
  }
  await page.goto('/')
  await openNewChat(page)
  // Der Zaehler erscheint erst, wenn das Gespraech Nachrichten hat
  // (`TokenCounter.tsx:53`) — auf einem leeren Chat gaebe es nichts zu zaehlen.
  const feld = page.locator('textarea').first()
  await feld.click()
  await feld.type('Hallo, eine erste Nachricht.')
  await page.keyboard.press('Enter')
  await expect(page.getByText(/PONG_BUILTIN_OK/)).toBeVisible({ timeout: 20_000 })
}

const marke = (page: Page) => page.locator('[data-testid="auto-compact-mark"]')

test('ohne die Einstellung zeigt der Balken keine Marke', async ({ page }) => {
  // Auto-Compact ist ab Werk aus (`autoCompactThreshold: 0`). Eine Marke fuer
  // etwas, das nicht passieren wird, waere eine Behauptung.
  await boot(page, 0)
  // Gegenprobe, dass der Zaehler ueberhaupt da ist — sonst pruefte die Zeile
  // darunter nur, dass eine leere Seite keine Marke hat.
  await expect(page.locator('.lu-hud-num').first()).toHaveText(/\d+.*\/.*\d/)
  await expect(marke(page)).toHaveCount(0)
})

test('mit der Einstellung steht die Marke da — und zwar auf der WIRKSAMEN Schwelle', async ({ page }) => {
  await boot(page, 0.8)
  await expect(marke(page)).toHaveCount(1)

  const links = await marke(page).evaluate((el) => (el as HTMLElement).style.left)
  const prozent = Number.parseFloat(links)
  expect(Number.isFinite(prozent), `left war "${links}"`).toBe(true)

  // Das ist der ganze Punkt: die Marke steht UNTER den eingestellten 80 %,
  // weil der Fuellstand hier geschaetzt ist und der Abschlag greift. Stuende
  // sie auf 80, waere sie eine Luege ueber den eigenen Ausloeser.
  expect(prozent).toBeLessThan(80)
  expect(prozent).toBeGreaterThan(30)
})

test('der Chip sagt in Worten, wie viel Fenster noch bleibt', async ({ page }) => {
  await boot(page, 0.8)
  const chip = page.locator('[data-testid="auto-compact-mark"]').locator('xpath=ancestor::span[@title][1]')
  const titel = await chip.getAttribute('title')
  expect(titel, 'der Fuellstand traegt einen Titel').toBeTruthy()
  expect(titel!).toMatch(/Auto-compaction|before auto-compaction/i)
})
