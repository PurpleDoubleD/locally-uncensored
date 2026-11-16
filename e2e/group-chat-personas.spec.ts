import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * Every participant of a group chat can speak as its own persona (a user,
 * Discord).
 *
 * Before this a group had one persona for everyone, the chat's own, so two
 * models could not play two characters. The pick now sits on the participant
 * row in the Plugins menu, is stored on the conversation, and each model gets
 * its own system prompt that names it and the others.
 *
 * Measured at the payload: one request per participant, and the system
 * message of each is what decides who the model believes it is.
 *
 * Run: CI=1 npx playwright test e2e/group-chat-personas.spec.ts
 */

const FIRST = 'qwen3:4b'
const SECOND = 'llama3.1:8b'

interface WireBody { model: string; messages: Array<{ role: string; content: unknown }> }

async function chatBodies(page: Page): Promise<WireBody[]> {
  const raw = await page.evaluate(() => {
    const bodies: unknown = Reflect.get(window, '__E2E_CHAT_BODIES__')
    return Array.isArray(bodies) ? bodies.map(String) : []
  })
  return raw.map((b) => JSON.parse(b) as WireBody)
}

const systemOf = (body: WireBody) =>
  body.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')

async function pickPersona(page: Page, model: string, persona: string) {
  const row = page.locator(`[data-testid="group-participant"][data-model="${model}"]`)
  await row.getByTestId('group-persona-trigger').click()
  await row.getByTestId('group-persona-list').getByRole('button', { name: persona, exact: true }).click()
  await expect(row.getByTestId('group-persona-trigger')).toContainText(persona)
}

test('two participants answer as two different personas and know each other by name', async ({ page }) => {
  const opts: TauriMockOptions = {
    assistantReply: 'A short answer.',
    modelName: DEFAULT_MODEL_NAME,
    platform: 'mac',
    ollamaModels: [FIRST, SECOND],
  }
  await page.addInitScript(tauriMockInit, opts)
  await seedOnboardingDone(page)
  await page.goto('/')
  await openNewChat(page)

  await page.getByRole('button', { name: /Plugins/ }).click()
  await page.getByRole('button', { name: /Group chat/ }).click()
  for (const model of [FIRST, SECOND]) {
    const row = page.locator(`[data-testid="group-participant"][data-model="${model}"]`)
    await expect(row).toBeVisible()
    // No pick is offered before the model takes part.
    await expect(row.getByTestId('group-persona-trigger')).toHaveCount(0)
    await row.getByRole('button').first().click()
    await expect(row.getByTestId('group-persona-trigger')).toContainText('Chat persona')
  }

  await pickPersona(page, FIRST, 'Code Expert')
  await pickPersona(page, SECOND, 'Helpful Assistant')
  await page.keyboard.press('Escape')

  await page.evaluate(() => { Reflect.set(window, '__E2E_CHAT_BODIES__', []) })
  await page.locator('textarea').first().fill('introduce yourselves')
  await page.getByRole('button', { name: /Send message/i }).click()

  await expect.poll(async () => (await chatBodies(page)).filter((b) => b.model === FIRST || b.model === SECOND).length, { timeout: 30_000 })
    .toBe(2)
  const bodies = await chatBodies(page)
  const first = bodies.find((b) => b.model === FIRST)
  const second = bodies.find((b) => b.model === SECOND)
  if (!first || !second) throw new Error('one participant never got its turn')

  // Each one gets its own role and is told who the other is.
  expect(systemOf(first)).toContain('expert software engineer')
  expect(systemOf(first)).toContain('you are "Code Expert" and only "Code Expert"')
  expect(systemOf(first)).toContain('The other participants are "Helpful Assistant"')
  expect(systemOf(first)).not.toContain('friendly, helpful, and knowledgeable assistant')

  expect(systemOf(second)).toContain('friendly, helpful, and knowledgeable assistant')
  expect(systemOf(second)).toContain('you are "Helpful Assistant" and only "Helpful Assistant"')
  expect(systemOf(second)).toContain('The other participants are "Code Expert"')
  expect(systemOf(second)).not.toContain('expert software engineer')

  // The second speaker reads the first one's answer under the persona name.
  const heard = second.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n')
  expect(heard).toContain('[Code Expert]')

  // The bubbles say who spoke, persona first.
  const labels = page.getByTestId('answered-by')
  await expect(labels).toHaveCount(2, { timeout: 20_000 })
  await expect(labels.nth(0)).toContainText('Code Expert')
  await expect(labels.nth(1)).toContainText('Helpful Assistant')

  // The pick lives on the conversation: it is still there after a reload.
  await page.reload()
  await page.getByRole('button', { name: /Plugins/ }).click()
  // Group chat is still on, so its row is open already; a click on it would
  // switch it off (one row per plugin with its own switch, 3.1.0).
  await expect(page.locator(`[data-testid="group-participant"][data-model="${FIRST}"]`).getByTestId('group-persona-trigger')).toContainText('Code Expert')
  await expect(page.locator(`[data-testid="group-participant"][data-model="${SECOND}"]`).getByTestId('group-persona-trigger')).toContainText('Helpful Assistant')
})
