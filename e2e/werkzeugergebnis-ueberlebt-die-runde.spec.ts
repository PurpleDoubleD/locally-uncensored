import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * Ueberlebt ein Werkzeugergebnis die naechste Frage?
 *
 * Persona-Lauf vom 03.09.2026, Befund 6: „Nach Runde 1 stand im naechsten
 * Payload nur noch der Text der Assistentenantwort; das tool_call/tool-Paar
 * mit dem echten Seiteninhalt fehlte. Deshalb hat mein Nachhaken ‚Und wie
 * lautet nun die Ueberschrift?' die Seite ein zweites Mal geholt statt zu
 * antworten."
 *
 * Der Code-Grund: `useCodex` legt die Werkzeugkette am Ende eines Laufs als
 * versteckte Nachrichten in den Chat-Speicher (gedeckelt, mit Waisenschnitt —
 * `hooks/codex/hidden-history.ts`). `useAgentChat`, das den Agentenmodus UND
 * die Werkzeugzuege im normalen Chat bedient, tat das nicht: die Aufrufe
 * lebten nur in den Anzeige-Bloecken. Was der Nutzer als Karte SIEHT, sah das
 * Modell in der naechsten Runde nicht mehr.
 *
 * Gemessen wird am abgeschickten Koerper, so wie die Persona gemessen hat.
 */

const MARKE = 'MARKE_ERGEBNIS_4711'

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: 'unused',
    modelName: DEFAULT_MODEL_NAME,
    replyChunkDelayMs: 8,
    agentTurns: [
      // Runde 1: das Modell liest eine Datei …
      { text: 'ich sehe nach', toolCalls: [{ name: 'file_read', args: { path: 'notiz.txt' } }] },
      // … und antwortet, OHNE den Inhalt zu wiederholen. Genau darum geht es:
      // stuende die Marke im sichtbaren Text, waere der Test unten auch dann
      // gruen, wenn die Werkzeugkette verloren ginge.
      { text: 'Ich habe nachgesehen.' },
      // Runde 2, die Nachfrage.
      { text: 'Fertig.' },
    ],
    files: { 'notiz.txt': MARKE },
  })
  await seedOnboardingDone(page)
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'locally-uncensored-permissions',
      JSON.stringify({
        state: {
          globalPermissions: {
            filesystem: 'auto', terminal: 'auto', desktop: 'auto', web: 'auto',
            system: 'auto', image: 'auto', video: 'auto', workflow: 'auto',
          },
          conversationOverrides: {}, perToolOverrides: {}, modeScope: 'agent',
        },
        version: 2,
      }),
    )
  })
  await page.goto('/')
  await openNewChat(page)
  const agentToggle = page.getByRole('main').getByRole('button', { name: 'Agent', exact: true })
  await agentToggle.click()
  const sandbox = page.getByRole('button', { name: /^Sandbox/ })
  await expect(sandbox).toBeVisible({ timeout: 15_000 })
  await sandbox.click()
  await expect(page.getByRole('dialog', { name: /Agent workspace/i })).toHaveCount(0, { timeout: 10_000 })
  await expect(agentToggle).toHaveAttribute('title', /Agent Mode is on/i, { timeout: 10_000 })
}

async function sende(page: Page, text: string) {
  const composer = page.locator('textarea').first()
  const echoed = page.getByRole('main').locator('p').filter({ hasText: text })
  await expect(composer).toBeEnabled({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 20_000 })
  await expect(async () => {
    if ((await echoed.count()) === 0) {
      await composer.fill(text)
      await composer.press('Enter')
    }
    await expect(echoed).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}

const koerper = (page: Page) =>
  page.evaluate(() => (window as never as { __E2E_CHAT_BODIES__?: string[] }).__E2E_CHAT_BODIES__ ?? [])

test('die naechste Frage sieht das Ergebnis der letzten Runde noch', async ({ page }) => {
  await boot(page)

  await sende(page, 'Lies bitte die Datei notiz.txt')
  await expect(page.getByRole('main').getByText('Ich habe nachgesehen.')).toBeVisible({ timeout: 30_000 })

  // Ab hier zaehlt nur, was NEU hinausgeht.
  await page.evaluate(() => { (window as never as { __E2E_CHAT_BODIES__?: string[] }).__E2E_CHAT_BODIES__ = [] })
  await sende(page, 'Und was stand nun drin?')
  await expect(page.getByRole('main').getByText('Fertig.')).toBeVisible({ timeout: 30_000 })

  const bodies = await koerper(page)
  expect(bodies.length).toBeGreaterThan(0)
  expect(bodies.join('\n')).toContain(MARKE)
})
