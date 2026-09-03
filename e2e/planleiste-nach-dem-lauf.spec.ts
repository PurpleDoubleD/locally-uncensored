import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * Die Planleiste muss sagen, wann der Lauf vorbei ist.
 *
 * Persona-Befund vom 03.09.2026: "die Planleiste blieb nach einem fertigen
 * Lauf auf PLAN 3/4 stehen". Nachgemessen stimmte das genau so, und die Zahl
 * war sogar richtig. Der Aufraeum-Steer (`plan-reconcile.ts`, Budget zwei)
 * gibt irgendwann auf, und dann endet der Lauf mit offenem Plan. Falsch war
 * nur, dass nichts es sagte: kein Stop-Knopf mehr, aber ein Kreisel, der
 * weiterdrehte, und die Ueberschrift des vierten Punktes daneben.
 *
 * Das Modell schreibt hier absichtlich eine eigene Schlusszeile. Damit faellt
 * der Hinweis aus `turn-summary.ts` weg, der nur bei stummem Modell greift.
 * Genau auf diesem Pfad ist der Befund entstanden, und deshalb faehrt der
 * Test ihn.
 */

type Turn = { text?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }

async function bootAgent(page: Page, agentTurns: Turn[]) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
    replyChunkDelayMs: 5,
    agentTurns,
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

const PLAN_MIT_LUECKE: Turn = {
  text: 'der Plan steht',
  toolCalls: [{
    name: 'todo_write',
    args: {
      todos: [
        { content: 'Schritt eins', status: 'completed' },
        { content: 'Schritt zwei', status: 'completed' },
        { content: 'Schritt drei', status: 'completed' },
        { content: 'Schritt vier', status: 'in_progress' },
      ],
    },
  }],
}

test('nach dem Lauf sagt die Planleiste, dass sie stehengeblieben ist', async ({ page }) => {
  // Vier gleiche Schlussrunden: die zwei Aufraeum-Steers laufen ins Leere, und
  // der Lauf endet so, wie die Persona ihn gesehen hat.
  const fertig: Turn = { text: 'Fertig, alles erledigt.' }
  await bootAgent(page, [PLAN_MIT_LUECKE, fertig, fertig, fertig, fertig])

  const box = page.locator('textarea').first()
  await box.click()
  await box.type('mach vier Schritte')
  await page.keyboard.press('Enter')

  const band = page.getByTestId('plan-header')
  await expect(band).toBeVisible({ timeout: 30_000 })

  // Der Lauf muss WIRKLICH vorbei sein, sonst prueft der Rest nichts.
  const gestoppt = page.getByTestId('plan-run-stopped')
  await expect(gestoppt).toBeVisible({ timeout: 60_000 })
  await expect(gestoppt).toHaveText(/the run ended here, 3 of 4 steps done, 1 still open/)

  // Und der Kreisel steht. Gemessen war er der zweite Teil derselben Luege:
  // aufgeklappt drehte er sich nach dem Ende des Laufs unbegrenzt weiter.
  await band.getByRole('button').first().click()
  await expect(band.getByText('Schritt vier')).toBeVisible()
  const drehend = await band.locator('.animate-spin').count()
  expect(drehend).toBe(0)
})

test('waehrend der Lauf laeuft, sagt sie nichts von einem Ende', async ({ page }) => {
  // Gegenprobe. Ohne sie waere die Zusicherung oben auch dann gruen, wenn die
  // Zeile einfach immer stuende, und dann waere sie wertlos.
  await bootAgent(page, [
    PLAN_MIT_LUECKE,
    // Eine lange Kette von Werkzeugrunden haelt den Lauf offen, waehrend
    // gemessen wird.
    ...Array.from({ length: 12 }, () => ({
      text: 'weiter',
      toolCalls: [{ name: 'file_list', args: { path: '.' } }],
    })),
  ])

  const box = page.locator('textarea').first()
  await box.click()
  await box.type('lauf lange')
  await page.keyboard.press('Enter')

  const band = page.getByTestId('plan-header')
  await expect(band).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('plan-run-stopped')).toHaveCount(0)
})
