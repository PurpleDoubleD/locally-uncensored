import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat, expectWorkspaceAsk, answerWorkspaceAsk } from './support/ui'

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

async function bootAgent(page: Page, agentTurns: Turn[], holdTools = false) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
    replyChunkDelayMs: 5,
    agentTurns,
    holdTools,
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
  expectWorkspaceAsk(page)
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
  await answerWorkspaceAsk(page)

  const band = page.getByTestId('plan-pinned')
  await expect(band).toBeVisible({ timeout: 30_000 })

  // Der Lauf muss WIRKLICH vorbei sein, sonst prueft der Rest nichts.
  const gestoppt = page.getByTestId('plan-run-stopped')
  await expect(gestoppt).toBeVisible({ timeout: 60_000 })
  // Seit 14.11.2026 ohne Zahlen (David: kein Zaehler, nirgends, planStoppedLabel).
  await expect(gestoppt).toContainText('the run ended before every step was done')

  // Und der Kreisel steht. Gemessen war er der zweite Teil derselben Luege:
  // aufgeklappt drehte er sich nach dem Ende des Laufs unbegrenzt weiter.
  // Die Liste ist offen, seit sie unter der neuesten Nachricht haengt (CA).
  await expect(band.getByTestId('plan-steps').getByText('Schritt vier')).toBeVisible()
  const drehend = await band.locator('.animate-spin').count()
  expect(drehend).toBe(0)
})

test('waehrend der Lauf laeuft, sagt sie nichts von einem Ende', async ({ page }) => {
  // The counter check. Without it the assertion above would also pass if the
  // line simply always stood there, and then it would be worth nothing.
  //
  // The run is held open inside a tool call that does not answer until this
  // spec lets it go. A chain of twelve identical tool rounds stood here
  // before, and it did not hold anything: the loop guard halts three
  // identical rounds in a row, so the run was over about 200 ms after the
  // band appeared, and on a loaded machine the check came after that.
  await bootAgent(
    page,
    [
      PLAN_MIT_LUECKE,
      { text: 'weiter', toolCalls: [{ name: 'file_list', args: { path: '.' } }] },
      { text: 'Fertig, alles erledigt.' },
    ],
    true,
  )

  const box = page.locator('textarea').first()
  await box.click()
  await box.type('lauf lange')
  await page.keyboard.press('Enter')
  await answerWorkspaceAsk(page)

  const band = page.getByTestId('plan-pinned')
  await expect(band).toBeVisible({ timeout: 30_000 })

  // The tool call has reached the bridge and is waiting: from here the run
  // cannot end until the release below.
  await expect
    .poll(() => page.evaluate(() => {
      const calls = (window as unknown as { __E2E_TOOL_CALLS__?: Array<{ cmd: string }> }).__E2E_TOOL_CALLS__ ?? []
      return calls.some((c) => c.cmd === 'fs_list')
    }), { timeout: 30_000 })
    .toBe(true)

  const gestoppt = page.getByTestId('plan-run-stopped')
  await expect(gestoppt).toHaveCount(0)

  // And the same run, let go, ends with the plan open and says so. That is
  // what proves the zero above was measured on a run that was still going.
  await page.evaluate(() => (window as unknown as { __E2E_RELEASE_TOOLS__: () => void }).__E2E_RELEASE_TOOLS__())
  await expect(gestoppt).toBeVisible({ timeout: 60_000 })
})
