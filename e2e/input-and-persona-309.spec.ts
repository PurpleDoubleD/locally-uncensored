import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * LU 3.0.9, package P2 "input and persona":
 *
 *  - GH #198: custom sampling rows of a persona and of a chat reach the
 *    request, top level on the OpenAI protocol and inside `options` on
 *    Ollama; the chat's row wins; in a group each member has its own.
 *  - GH #202: with "New line" Enter adds a line and Ctrl+Enter sends.
 *  - 375 px: Sampling, the model and Send stay in the frame, and the popup
 *    keeps off the right edge.
 *
 * Measured at the payload of each request.
 *
 * Run: CI=1 npx playwright test e2e/input-and-persona-309.spec.ts
 */

const FIRST = 'qwen3:4b'
const SECOND = 'llama3.1:8b'

const BARON = {
  id: 'p-baron', name: 'Baron', icon: 'User', isBuiltIn: false, systemPrompt: 'You are Baron.',
  customParams: [
    { key: 'dry_base', type: 'number', value: '1.75' },
    { key: 'dry_sequence_breakers', type: 'json', value: '["\\n", ":", "\\"", "*"]' },
    { key: 'logit_bias', type: 'json', value: '{"128": -100}' },
  ],
}
const WALT = {
  id: 'p-walt', name: 'Walt', icon: 'User', isBuiltIn: false, systemPrompt: 'You are Walt.',
  customParams: [{ key: 'xtc_probability', type: 'number', value: '0.9' }],
}

type WireBody = Record<string, unknown> & { model: string }

async function chatBodies(page: Page): Promise<WireBody[]> {
  const raw = await page.evaluate(() => {
    const bodies: unknown = Reflect.get(window, '__E2E_CHAT_BODIES__')
    return Array.isArray(bodies) ? bodies.map(String) : []
  })
  return raw.map((b) => JSON.parse(b) as WireBody).filter((b) => Array.isArray(b.messages))
}

async function seed(page: Page, personas: unknown[], settings: Record<string, unknown> = {}) {
  await seedOnboardingDone(page)
  await page.addInitScript(([list, extra]) => {
    window.localStorage.setItem(
      'chat-settings',
      JSON.stringify({
        state: {
          settings: { onboardingDone: true, appMode: 'local', personasEnabled: true, ...extra },
          personas: list,
          activePersonaId: 'unrestricted',
          _version: 10,
        },
        version: 10,
      }),
    )
  }, [personas, settings] as const)
}

async function send(page: Page, text: string) {
  await page.evaluate(() => { Reflect.set(window, '__E2E_CHAT_BODIES__', []) })
  await page.locator('textarea').first().fill(text)
  await page.getByRole('button', { name: /Send message/i }).click()
}

async function addRow(page: Page, key: string, value: string) {
  const panel = page.getByTestId('sampling-panel')
  await panel.getByTestId('custom-param-add').click()
  const row = panel.getByTestId('custom-param-row').last()
  await row.getByLabel('Parameter name').fill(key)
  await row.getByLabel('Parameter value').fill(value)
}

test('a persona\'s custom rows go out as typed, and a row in the chat wins', async ({ page }) => {
  const opts: TauriMockOptions = { assistantReply: 'Hello.', modelName: DEFAULT_MODEL_NAME, platform: 'mac' }
  await page.addInitScript(tauriMockInit, opts)
  await seed(page, [BARON])
  await page.goto('/')
  await openNewChat(page)
  await page.getByRole('button', { name: /Plugins/ }).click()
  await page.getByRole('button', { name: /^Persona/ }).click()
  await page.getByRole('button', { name: 'Baron', exact: true }).click()
  await page.getByTitle('Enable persona for this chat').click()
  await page.keyboard.press('Escape')

  await send(page, 'hello')
  await expect.poll(async () => (await chatBodies(page)).length, { timeout: 30_000 }).toBeGreaterThan(0)
  let body = (await chatBodies(page))[0]
  expect(body.dry_base).toBe(1.75)
  expect(body.dry_sequence_breakers).toEqual(['\n', ':', '"', '*'])
  expect(body.logit_bias).toEqual({ '128': -100 })

  await expect(page.getByRole('button', { name: 'Regenerate response' })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('sampling-trigger').click()
  await expect(page.getByTestId('custom-params-inherited')).toContainText('dry_base')
  await addRow(page, 'dry_base', '2')
  await page.getByTestId('sampling-close').click()
  await page.waitForTimeout(800)
  await send(page, 'again')
  await expect.poll(async () => (await chatBodies(page)).length, { timeout: 30_000 }).toBeGreaterThan(0)
  body = (await chatBodies(page))[0]
  expect(body.dry_base).toBe(2)
  expect(body.logit_bias).toEqual({ '128': -100 })
  expect(JSON.stringify(body).match(/"dry_base"/g)).toHaveLength(1)
})

test('in a group every member sends its own persona\'s rows, inside Ollama\'s options', async ({ page }) => {
  const opts: TauriMockOptions = {
    assistantReply: 'A short answer.', modelName: DEFAULT_MODEL_NAME, platform: 'mac', ollamaModels: [FIRST, SECOND],
  }
  await page.addInitScript(tauriMockInit, opts)
  await seed(page, [BARON, WALT])
  await page.goto('/')
  await openNewChat(page)
  await page.getByRole('button', { name: /Plugins/ }).click()
  await page.getByRole('button', { name: /Group chat/ }).click()
  for (const [model, persona] of [[FIRST, 'Baron'], [SECOND, 'Walt']] as const) {
    const row = page.locator(`[data-testid="group-participant"][data-model="${model}"]`)
    await row.getByRole('button').first().click()
    await row.getByTestId('group-persona-trigger').click()
    await row.getByTestId('group-persona-list').getByRole('button', { name: persona, exact: true }).click()
  }
  await page.keyboard.press('Escape')
  await send(page, 'introduce yourselves')
  await expect.poll(async () => (await chatBodies(page)).filter((b) => b.model === FIRST || b.model === SECOND).length, { timeout: 30_000 })
    .toBe(2)
  const bodies = await chatBodies(page)
  const a = bodies.find((b) => b.model === FIRST)!.options as Record<string, unknown>
  const b = bodies.find((x) => x.model === SECOND)!.options as Record<string, unknown>
  expect(a.dry_base).toBe(1.75)
  expect(a.xtc_probability).toBeUndefined()
  expect(b.xtc_probability).toBe(0.9)
  expect(b.dry_base).toBeUndefined()
})

test('"New line": Enter adds a line, Ctrl+Enter sends', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: 'Hi.', modelName: DEFAULT_MODEL_NAME, platform: 'windows' } as TauriMockOptions)
  await seed(page, [], { enterKey: 'newline' })
  await page.goto('/')
  await openNewChat(page)
  await page.evaluate(() => { Reflect.set(window, '__E2E_CHAT_BODIES__', []) })
  const field = page.locator('textarea[data-lu-composer]')
  await expect(field).toHaveAttribute('placeholder', 'Message... (Ctrl+Enter to send)')
  await field.click()
  await page.keyboard.type('first line')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second line')
  await page.waitForTimeout(500)
  expect(await chatBodies(page)).toHaveLength(0)
  await expect(field).toHaveValue('first line\nsecond line')
  await page.keyboard.press('Control+Enter')
  await expect.poll(async () => (await chatBodies(page)).length, { timeout: 30_000 }).toBeGreaterThan(0)
})

test('375 px: Sampling, the model and Send stay in the frame, the popup off the edge', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: 'Hi.', modelName: DEFAULT_MODEL_NAME, platform: 'mac' } as TauriMockOptions)
  await seed(page, [])
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/')
  await openNewChat(page)
  for (const id of ['sampling-trigger', 'composer-send-slot']) {
    const box = (await page.getByTestId(id).boundingBox())!
    expect(box.x + box.width, id).toBeLessThanOrEqual(375)
  }
  await page.getByTestId('sampling-trigger').click()
  await expect.poll(async () => {
    const box = (await page.getByTestId('sampling-panel').boundingBox())!
    return box.x + box.width
  }).toBeLessThanOrEqual(371)
})
