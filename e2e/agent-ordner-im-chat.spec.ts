import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * 3.1.2: Agent fragt im Chat, wo er arbeitet.
 *
 * Einschalten oeffnet keinen Dialog mehr. Die erste Nachricht wartet im
 * Verlauf unter der Karte "Where should I work?" mit Sandbox und Folder…,
 * und nach der Wahl geht genau diese Nachricht an das Modell, einmal.
 *
 * LU_SHOTS_OUT=<Ordner> legt dabei die Bilder fuer die Uebergabe ab.
 */
const OUT = process.env.LU_SHOTS_OUT ?? ''
const FIRST = 'make a small todo app in html'

type W = { __E2E_CHAT_BODIES__?: string[]; __E2E_INVOKE_OVERRIDES__?: Record<string, unknown> }

async function boot(page: Page, theme?: 'light' | 'dark') {
  await page.addInitScript(tauriMockInit, {
    assistantReply: 'unused', modelName: DEFAULT_MODEL_NAME, replyChunkDelayMs: 5,
    agentTurns: [{ text: 'Done, the app is in index.html.' }],
  })
  await seedOnboardingDone(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  if (theme) {
    const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
    if (isDark !== (theme === 'dark')) await page.getByRole('banner').getByTitle(/^(Light|Dark) Mode$/).click()
  }
  await openNewChat(page)
}

const toggle = (page: Page) => page.getByRole('main').getByRole('button', { name: 'Agent', exact: true })
const card = (page: Page) => page.getByTestId('workspace-ask')
const bodies = (page: Page) => page.evaluate(() => ((window as unknown as W).__E2E_CHAT_BODIES__ ?? []).slice())

async function turnOn(page: Page) {
  await toggle(page).click()
  await expect(toggle(page)).toHaveAttribute('title', /Agent Mode is on/i)
  // Kein Dialog, und der Schalter ist sofort bedienbar.
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('Where should the agent work?')).toHaveCount(0)
}

async function send(page: Page, text: string) {
  const composer = page.locator('textarea').first()
  await expect(composer).toBeEnabled({ timeout: 20_000 })
  await composer.fill(text)
  await composer.press('Enter')
}

async function shot(page: Page, name: string) {
  if (!OUT) return
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/${name}.png` })
}

test('Agent einschalten, erste Nachricht, Sandbox: die Nachricht laeuft weiter', async ({ page }) => {
  await boot(page)
  await turnOn(page)
  await send(page, FIRST)

  // Die Nachricht steht im Verlauf, darunter die Frage. Noch geht nichts ans Modell.
  await expect(card(page)).toBeVisible()
  await expect(card(page).getByText('Where should I work?')).toBeVisible()
  await expect(page.getByText(FIRST, { exact: true })).toHaveCount(1)
  expect(await bodies(page)).toHaveLength(0)

  await card(page).getByRole('button', { name: 'Sandbox' }).click()
  await expect(card(page)).toHaveCount(0)
  await expect(page.getByText('Done, the app is in index.html.')).toBeVisible({ timeout: 20_000 })
  // Genau diese Nachricht ging hinaus, und sie steht einmal da, nicht doppelt.
  const sent = await bodies(page)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain(FIRST)
  await expect(page.getByText(FIRST, { exact: true })).toHaveCount(1)
  await expect(page.getByTestId('agent-workspace-pill')).toHaveText('Sandbox')

  // Die Wahl gilt fuer den Chat: die naechste Nachricht fragt nicht mehr.
  await send(page, 'now add a dark mode')
  await expect.poll(async () => (await bodies(page)).length, { timeout: 20_000 }).toBe(2)
  await expect(card(page)).toHaveCount(0)
})

test('Folder… oeffnet den Ordnerwaehler, Abbrechen laesst die Frage offen, die Wahl schickt die Nachricht', async ({ page }) => {
  await boot(page)
  await turnOn(page)
  await send(page, FIRST)
  await expect(card(page)).toBeVisible()

  // Abgebrochen: die Frage bleibt, nichts geht hinaus.
  await page.evaluate(() => { (window as unknown as W).__E2E_INVOKE_OVERRIDES__ = { pick_folder: null } })
  await card(page).getByRole('button', { name: 'Folder…' }).click()
  await expect(card(page).getByRole('button', { name: 'Folder…' })).toBeEnabled()
  await expect(card(page)).toBeVisible()
  expect(await bodies(page)).toHaveLength(0)

  // Gewaehlt: der Ordner gilt fuer den Chat, und die Nachricht laeuft weiter.
  await page.evaluate(() => {
    (window as unknown as W).__E2E_INVOKE_OVERRIDES__ = { pick_folder: '/Users/alex/projects/notes-app' }
  })
  await card(page).getByRole('button', { name: 'Folder…' }).click()
  await expect(card(page)).toHaveCount(0)
  await expect(page.getByTestId('agent-workspace-pill')).toHaveText('notes-app')
  await expect(page.getByText('Done, the app is in index.html.')).toBeVisible({ timeout: 20_000 })
  const sent = await bodies(page)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain(FIRST)
})

for (const theme of ['light', 'dark'] as const) {
  test(`Bilder ${theme}`, async ({ page }) => {
    test.skip(!OUT, 'set LU_SHOTS_OUT')
    await boot(page, theme)
    await turnOn(page)
    await shot(page, `nachher-${theme}-1440-1-eingeschaltet`)
    await send(page, FIRST)
    await expect(card(page)).toBeVisible()
    await shot(page, `nachher-${theme}-1440-2-frage-im-chat`)
    await card(page).getByRole('button', { name: 'Sandbox' }).click()
    await expect(page.getByText('Done, the app is in index.html.')).toBeVisible({ timeout: 20_000 })
    await shot(page, `nachher-${theme}-1440-3-weiter`)
  })
}
