import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * GH #175: sampling values stored per persona, and per group member.
 *
 * A persona carries its own temperature, top P, top K, min P, penalties and
 * max tokens. They apply wherever the persona speaks: in its chat, and on its
 * seat in a group, where every member runs on the values of its own persona.
 * The Sampling popup says which values hold for whom, and a value moved there
 * still wins for this chat.
 *
 * Measured at the payload of each request.
 *
 * Run: CI=1 npx playwright test e2e/persona-sampling.spec.ts
 */

const FIRST = 'qwen3:4b'
const SECOND = 'llama3.1:8b'

const WALT = {
  id: 'p-walt', name: 'Walt', icon: 'User', isBuiltIn: false, systemPrompt: 'You are Walt.',
  sampling: { temperature: 1.25, repeatPenalty: 1.2 },
}
const BARON = {
  id: 'p-baron', name: 'Baron', icon: 'User', isBuiltIn: false, systemPrompt: 'You are Baron.',
  sampling: { temperature: 0.35, minP: 0.07 },
}

type WireBody = Record<string, unknown> & { model: string }

async function chatBodies(page: Page): Promise<WireBody[]> {
  const raw = await page.evaluate(() => {
    const bodies: unknown = Reflect.get(window, '__E2E_CHAT_BODIES__')
    return Array.isArray(bodies) ? bodies.map(String) : []
  })
  return raw.map((b) => JSON.parse(b) as WireBody).filter((b) => Array.isArray(b.messages))
}

/** A sampler as the request carries it: top level on the OpenAI protocol,
 *  inside `options` on Ollama. */
function sampler(body: WireBody, key: string): unknown {
  const options = body.options
  if (options && typeof options === 'object' && key in options) return (options as Record<string, unknown>)[key]
  return body[key]
}

async function seed(page: Page, personas: unknown[]) {
  await seedOnboardingDone(page)
  await page.addInitScript((list) => {
    window.localStorage.setItem(
      'chat-settings',
      JSON.stringify({
        state: {
          settings: { onboardingDone: true, appMode: 'local', personasEnabled: true },
          personas: list,
          activePersonaId: 'unrestricted',
          _version: 10,
        },
        version: 10,
      }),
    )
  }, personas)
}

async function send(page: Page, text: string) {
  await page.evaluate(() => { Reflect.set(window, '__E2E_CHAT_BODIES__', []) })
  await page.locator('textarea').first().fill(text)
  await page.getByRole('button', { name: /Send message/i }).click()
}

async function goToSettings(page: Page) {
  const nav = page.getByRole('navigation', { name: 'Main' })
  const direct = nav.getByRole('button', { name: 'Settings', exact: true })
  if (await direct.isVisible().catch(() => false)) return direct.click()
  await nav.getByRole('button', { name: 'Main navigation' }).click()
  await nav.getByRole('menuitem', { name: 'Settings', exact: true }).click()
}

test('a persona made with its own sampling values runs on them, and the chat can still override', async ({ page }) => {
  const opts: TauriMockOptions = { assistantReply: 'Hello.', modelName: DEFAULT_MODEL_NAME, platform: 'mac' }
  await page.addInitScript(tauriMockInit, opts)
  await seed(page, [])
  await page.goto('/')
  await expect(page.getByRole('banner')).toBeVisible()

  // Settings, Agent, Personas: a new persona with three sampling values.
  await goToSettings(page)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const custom = page.getByRole('button', { name: 'Custom', exact: true })
  if (!(await custom.isVisible().catch(() => false))) await page.getByRole('button', { name: 'Personas', exact: true }).click()
  await custom.click()
  await page.getByPlaceholder('Persona name...').fill('Baron')
  await page.getByPlaceholder('System prompt...').fill('You are Baron.')
  const fields = page.getByTestId('persona-sampling')
  await fields.getByLabel('Temperature', { exact: true }).fill('0.35')
  await fields.getByLabel('Min P', { exact: true }).fill('0.07')
  await fields.getByLabel('Repeat penalty', { exact: true }).fill('1.12')
  await page.getByRole('button', { name: 'Save Persona' }).click()

  // A chat on Baron.
  await openNewChat(page)
  await page.getByRole('button', { name: /Plugins/ }).click()
  await page.getByRole('button', { name: /^Persona/ }).click()
  await page.getByRole('button', { name: 'Baron', exact: true }).click()
  await page.getByTitle('Enable persona for this chat').click()
  await page.keyboard.press('Escape')

  // The popup says the values come from Baron.
  await page.getByTestId('sampling-trigger').click()
  const speaker = page.getByTestId('sampling-speaker')
  await expect(speaker).toHaveCount(1)
  await expect(speaker).toContainText('Baron')
  await expect(speaker).toContainText('Min P 0.07')
  await expect(speaker).toContainText('Repeat penalty 1.12')
  // exact: the "?" next to it is "What temperature does" (3.0.9).
  await expect(page.getByTestId('sampling-panel').getByLabel('Temperature', { exact: true })).toHaveValue('0.35')
  await page.getByTestId('sampling-close').click()

  await send(page, 'hello')
  await expect.poll(async () => (await chatBodies(page)).length, { timeout: 30_000 }).toBeGreaterThan(0)
  let body = (await chatBodies(page))[0]
  expect(sampler(body, 'temperature')).toBe(0.35)
  expect(sampler(body, 'min_p')).toBe(0.07)
  expect(sampler(body, 'repeat_penalty')).toBe(1.12)

  // This chat moves its own temperature: that wins, the rest stays Baron's.
  // The first answer is done before the second turn goes out.
  await expect(page.getByRole('button', { name: 'Regenerate response' })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('sampling-trigger').click()
  await page.getByTestId('sampling-panel').getByLabel('Temperature', { exact: true }).fill('1.2')
  await page.getByTestId('sampling-close').click()
  await expect(page.getByTestId('sampling-panel')).toHaveCount(0)
  await expect(page.getByTestId('sampling-trigger')).toContainText('1.20')
  // Since 3.0.7 the double fire guard of the composer (SEND_LOCK_MS in
  // ChatInput.tsx) holds only for the SAME message within 700 ms, so this
  // different message would pass at once. The wait stays as a harmless margin.
  await page.waitForTimeout(800)
  await send(page, 'again')
  await expect.poll(async () => (await chatBodies(page)).length, { timeout: 30_000 }).toBeGreaterThan(0)
  body = (await chatBodies(page))[0]
  expect(sampler(body, 'temperature')).toBe(1.2)
  expect(sampler(body, 'min_p')).toBe(0.07)
})

test('in a group every member runs on the values of its own persona', async ({ page }) => {
  const opts: TauriMockOptions = {
    assistantReply: 'A short answer.',
    modelName: DEFAULT_MODEL_NAME,
    platform: 'mac',
    ollamaModels: [FIRST, SECOND],
  }
  await page.addInitScript(tauriMockInit, opts)
  await seed(page, [WALT, BARON])
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

  // The popup lists each member with the values that hold for it.
  await page.getByTestId('sampling-trigger').click()
  const first = page.locator(`[data-testid="sampling-speaker"][data-model="${FIRST}"]`)
  const second = page.locator(`[data-testid="sampling-speaker"][data-model="${SECOND}"]`)
  await expect(first).toContainText('Baron')
  await expect(first).toContainText('Temperature 0.35')
  await expect(first).toContainText('Min P 0.07')
  await expect(second).toContainText('Walt')
  await expect(second).toContainText('Temperature 1.25')
  await expect(second).toContainText('Repeat penalty 1.2')
  await page.getByTestId('sampling-close').click()

  await send(page, 'introduce yourselves')
  await expect.poll(async () => (await chatBodies(page)).filter((b) => b.model === FIRST || b.model === SECOND).length, { timeout: 30_000 })
    .toBe(2)
  const bodies = await chatBodies(page)
  const a = bodies.find((b) => b.model === FIRST)
  const b = bodies.find((x) => x.model === SECOND)
  if (!a || !b) throw new Error('one member never got its turn')
  expect(sampler(a, 'temperature')).toBe(0.35)
  expect(sampler(a, 'min_p')).toBe(0.07)
  expect(sampler(a, 'repeat_penalty')).toBeUndefined()
  expect(sampler(b, 'temperature')).toBe(1.25)
  expect(sampler(b, 'repeat_penalty')).toBe(1.2)
  expect(sampler(b, 'min_p')).toBeUndefined()
})
