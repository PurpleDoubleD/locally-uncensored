import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * Drei Unteragenten in einem Zug, und der Nutzer wird kein einziges Mal
 * unterbrochen.
 *
 * Auftrag 2.3 (David, 04.09.2026): "hintergrund bzw multiagents sollen NIEMALS
 * freigabe brauchen. ist bei claude code desktop auch nicht so richtig?"
 *
 * Gemessen wurde vorher genau das Gegenteil: delegate_task liegt in der
 * Kategorie 'workflow', die steht in DEFAULT_PERMISSIONS auf 'confirm', und
 * jede der drei Delegationen legte eine eigene Karte in die
 * Freigabe-Warteschlange. Der Lauf blieb an der ersten stehen und kam nie zu
 * den anderen beiden.
 *
 * Die Berechtigungen unten sind mit Absicht NICHT durchgehend auf 'auto':
 * 'workflow' bleibt auf 'confirm' stehen, damit dieser Test genau die eine
 * Frage stellt, um die es geht. Die Delegation war vorne nicht ausdruecklich
 * erlaubt und darf trotzdem nicht fragen, weil sie selbst nichts anfasst; was
 * ein Unteragent dann WIRKLICH tut, geht weiter durch denselben Gate wie im
 * Hauptlauf (siehe src/lib/agent-approval-policy.ts).
 *
 * Gemessen wird an der Wirkung: mit dem alten Stand blieb der Zug an der
 * ersten Freigabekarte stehen, es gab keinen zweiten Modellzug und damit auch
 * keinen Schlusssatz. Steht der Schlusssatz da und liegt kein Freigabestreifen
 * im Fenster, sind alle drei Delegationen ohne Rueckfrage gelaufen.
 */

/** Ein Zug mit drei Delegationen, danach nur noch Prosa (der letzte Eintrag wiederholt sich). */
const TURNS = [
  {
    text: 'I will fan this out.',
    toolCalls: [
      { name: 'delegate_task', args: { goal: 'Read the first file and report what it does.' } },
      { name: 'delegate_task', args: { goal: 'Read the second file and report what it does.' } },
      { name: 'delegate_task', args: { goal: 'Read the third file and report what it does.' } },
    ],
  },
  { text: 'All three came back.' },
]

const OPTS: TauriMockOptions = {
  assistantReply: 'unused in this spec',
  modelName: DEFAULT_MODEL_NAME,
  platform: 'mac',
  agentTurns: TURNS,
}

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, OPTS)
  await seedOnboardingDone(page)
  // Alles, was ein Unteragent anfassen koennte, ist vorne erlaubt. 'workflow'
  // bleibt auf der Vorgabe 'confirm' stehen: das ist der Punkt des Tests.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'locally-uncensored-permissions',
      JSON.stringify({
        state: {
          globalPermissions: {
            filesystem: 'auto', terminal: 'auto', desktop: 'auto', web: 'auto',
            system: 'auto', image: 'auto', video: 'auto', workflow: 'confirm',
          },
          conversationOverrides: {}, perToolOverrides: {}, modeScope: 'agent',
        },
        version: 3,
      }),
    )
  })
  await page.goto('/')
  await openNewChat(page)
  const agentToggle = page.getByRole('main').getByRole('button', { name: 'Agent', exact: true })
  await agentToggle.click()
  // Die Werkstatt-Frage kommt zuerst und legt den Rest der Seite auf inert.
  const sandbox = page.getByRole('button', { name: /^Sandbox/ })
  await expect(sandbox).toBeVisible({ timeout: 15_000 })
  await sandbox.click()
  await expect(page.getByRole('dialog', { name: /Agent workspace/i })).toHaveCount(0, { timeout: 10_000 })
  await expect(agentToggle).toHaveAttribute('title', /Agent Mode is on/i, { timeout: 10_000 })
}

test('drei Delegationen erzeugen keine einzige Freigabefrage', async ({ page }) => {
  await boot(page)

  const feld = page.locator('textarea').first()
  await feld.click()
  await feld.fill('Split this into three and hand each part to a sub-agent.')
  await page.keyboard.press('Enter')

  // Der Schlusssatz kommt aus dem ZWEITEN Modellzug. Den gab es mit dem alten
  // Stand nie: der erste Zug haengt an seiner ersten Freigabekarte.
  await expect(page.getByText('All three came back.')).toBeVisible({ timeout: 30_000 })

  // Kein Freigabestreifen, nirgends.
  await expect(page.getByText('Approve', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)

  // Und es waren wirklich drei Delegationen, nicht eine. Die Leiste faltet
  // gleichartige Aufrufe zusammen, also erst aufklappen.
  await page.getByRole('button', { name: /3 steps/ }).click()
  await expect(page.getByText('delegate_task', { exact: true })).toHaveCount(3)
})
