import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * GH #170: the persona picked in Plugins is the one whose prompt is sent.
 *
 * The chat used to keep a frozen copy of the persona that was active when it
 * was created. Picking another persona in the Plugins menu moved only the
 * app wide pick, so the menu named persona B while the request still carried
 * persona A, in an open chat and in a fresh one that was created before the
 * pick. The model then introduced itself as the other character.
 *
 * Measured at the payload: the system message of the request.
 *
 * Run: CI=1 npx playwright test e2e/persona-pick-is-what-is-sent.spec.ts
 */

const FIRST = 'qwen3:4b'
const SECOND = 'llama3.1:8b'

const WALT = { id: 'p-walt', name: 'Walt', icon: 'User', isBuiltIn: false, systemPrompt: 'You are Walt. WALT-ONLY-MARKER.' }
const BARON = { id: 'p-baron', name: 'Baron', icon: 'User', isBuiltIn: false, systemPrompt: 'You are Baron. BARON-ONLY-MARKER.' }

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

/** Personas switched on, two custom personas, Walt picked app wide. */
async function seedPersonas(page: Page) {
  // Release notes marked as read, then the settings blob replaced by one
  // with the personas in it (init scripts run in order).
  await seedOnboardingDone(page)
  await page.addInitScript((personas) => {
    window.localStorage.setItem(
      'chat-settings',
      JSON.stringify({
        state: {
          settings: { onboardingDone: true, appMode: 'local', personasEnabled: true },
          personas,
          activePersonaId: 'p-walt',
          _version: 10,
        },
        version: 10,
      }),
    )
  }, [WALT, BARON])
}

async function pickChatPersona(page: Page, name: string) {
  await page.getByRole('button', { name: /^Persona/ }).click()
  await page.getByRole('button', { name, exact: true }).click()
}

async function sendAndReadSystem(page: Page, model: string): Promise<string> {
  await page.evaluate(() => { Reflect.set(window, '__E2E_CHAT_BODIES__', []) })
  await page.locator('textarea').first().fill('What is your name?')
  await page.getByRole('button', { name: /Send message/i }).click()
  await expect.poll(async () => (await chatBodies(page)).filter((b) => b.model === model).length, { timeout: 30_000 })
    .toBeGreaterThan(0)
  const body = (await chatBodies(page)).find((b) => b.model === model)
  if (!body) throw new Error('no request reached the model')
  return systemOf(body)
}

test('a persona picked in Plugins after the chat was opened is the one that is sent', async ({ page }) => {
  const opts: TauriMockOptions = { assistantReply: 'Hello.', modelName: DEFAULT_MODEL_NAME, platform: 'mac' }
  await page.addInitScript(tauriMockInit, opts)
  await seedPersonas(page)
  await page.goto('/')
  await openNewChat(page)

  await page.getByRole('button', { name: /Plugins/ }).click()
  await pickChatPersona(page, 'Baron')
  // The Persona switch above turned it on for this chat (3.1.0 plugin rows).
  // The menu names Baron for this chat.
  await expect(page.getByTestId('plugins-persona')).toContainText('Baron')
  await page.keyboard.press('Escape')

  const system = await sendAndReadSystem(page, DEFAULT_MODEL_NAME)
  expect(system).toContain('BARON-ONLY-MARKER')
  expect(system).not.toContain('WALT-ONLY-MARKER')
})

test('after a group with own personas is switched off, the chat persona from Plugins is sent', async ({ page }) => {
  const opts: TauriMockOptions = {
    assistantReply: 'Hello.',
    modelName: DEFAULT_MODEL_NAME,
    platform: 'mac',
    ollamaModels: [FIRST, SECOND],
  }
  await page.addInitScript(tauriMockInit, opts)
  await seedPersonas(page)
  await page.goto('/')
  await openNewChat(page)

  // The reporter's group: Baron on one model, Walt on the other.
  await page.getByRole('button', { name: /Plugins/ }).click()
  await page.getByRole('button', { name: /Group chat/ }).click()
  for (const [model, persona] of [[FIRST, 'Baron'], [SECOND, 'Walt']] as const) {
    const row = page.locator(`[data-testid="group-participant"][data-model="${model}"]`)
    await row.getByRole('button').first().click()
    await row.getByTestId('group-persona-trigger').click()
    await row.getByTestId('group-persona-list').getByRole('button', { name: persona, exact: true }).click()
  }
  // Group chat off, Baron picked for the chat and switched on.
  await page.getByTitle('Turn off group chat for this chat').click()
  await pickChatPersona(page, 'Baron')
  // The Persona switch above turned it on for this chat (3.1.0 plugin rows).
  await page.keyboard.press('Escape')

  const system = await sendAndReadSystem(page, DEFAULT_MODEL_NAME)
  expect(system).toContain('BARON-ONLY-MARKER')
  expect(system).not.toContain('WALT-ONLY-MARKER')
  // A plain chat, not a group turn.
  expect(system).not.toContain('group conversation')
})
