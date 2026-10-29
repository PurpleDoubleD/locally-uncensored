import { test, expect, type Page, type Locator } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { oeffneSeitenleiste } from './support/ui'

/**
 * GH #174: a long story is safe to experiment with.
 *
 *  1. "Duplicate chat" in the chat list (hover button) and the chat menu
 *     (right click): an independent copy with the chat's own settings.
 *  2. "Branch from here" on a message: a new chat up to that message.
 *  3. Regenerate keeps the earlier answer: "< 1/2 >" on the answer.
 *
 * The chat is seeded as a group chat with a persona switch and sampling
 * values of its own, the settings the issue names.
 *
 * Run: LU_E2E_PORT=5296 CI=1 npx playwright test e2e/chat-duplicate-and-branch.spec.ts
 */

const CONV_ID = 'seeded-story'
const TITLE = 'Harbour story'
const TURNS = [
  ['Q1 tell me about the harbour', 'A1 the harbour is old'],
  ['Q2 and the lighthouse', 'A2 the lighthouse is red'],
  ['Q3 who lives there', 'A3 a keeper and a cat'],
] as const
const GROUP = ['qwen3:4b', 'llama3.1:8b']

function seededChat() {
  const now = Date.now()
  const messages = TURNS.flatMap(([q, a], i) => [
    { id: `u${i + 1}`, role: 'user', content: q, timestamp: now - 10_000 + i * 2 },
    { id: `a${i + 1}`, role: 'assistant', content: a, timestamp: now - 10_000 + i * 2 + 1, modelId: GROUP[i % 2], groupPersonaId: 'some-persona', groupSpeakerName: 'Captain' },
  ])
  return {
    state: {
      conversations: [{
        id: CONV_ID, title: TITLE, messages, model: DEFAULT_MODEL_NAME, systemPrompt: 'You are a sea captain.',
        mode: 'lu', createdAt: now - 20_000, updatedAt: now - 10_000, personaEnabled: true, personaId: 'some-persona',
        groupModels: GROUP, groupPersonas: { [GROUP[1]]: 'some-persona' }, sampling: { temperature: 0.35, topP: 0.8 },
      }],
      activeConversationId: CONV_ID,
    },
    version: 0,
  }
}

async function boot(page: Page, opts: { group?: boolean } = {}) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  const seed = seededChat()
  if (!opts.group) {
    const conv = seed.state.conversations[0] as Record<string, unknown>
    delete conv.groupModels
    delete conv.groupPersonas
  }
  await page.addInitScript((raw: string) => {
    if (sessionStorage.getItem('e2e-seeded')) return
    sessionStorage.setItem('e2e-seeded', '1')
    localStorage.setItem('chat-conversations', raw)
  }, JSON.stringify(seed))
  await page.goto('/')
  await expect(said(page, TURNS[2][1])).toBeVisible({ timeout: 30_000 })
}

function said(page: Page, text: string): Locator {
  return page.getByRole('main').locator('p').filter({ hasText: text })
}

function bubbleOf(page: Page, text: string): Locator {
  return said(page, text).first().locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " group ")][1]')
}

interface StoredConv {
  id: string; title: string; messages: { id: string; content: string; groupPersonaId?: string; groupSpeakerName?: string }[]
  personaEnabled?: boolean; personaId?: string; systemPrompt: string; groupModels?: string[]; groupPersonas?: Record<string, string>
  sampling?: Record<string, number>; forks?: Record<string, unknown>
}

async function stored(page: Page): Promise<StoredConv[]> {
  return page.evaluate(async () => {
    const raw: string | null = await new Promise((res) => {
      const req = indexedDB.open('locally-uncensored-store', 1)
      req.onsuccess = () => {
        const r = req.result.transaction('kv', 'readonly').objectStore('kv').get('chat-conversations')
        r.onsuccess = () => res(typeof r.result === 'string' ? r.result : null)
        r.onerror = () => res(null)
      }
      req.onerror = () => res(null)
    })
    return raw ? JSON.parse(raw).state.conversations : []
  })
}

/** A sidebar row by its exact title: "Story" must not also match "Story (copy)". */
const row = (page: Page, title: string) => page.getByRole('option').filter({
  has: page.locator('p').filter({ hasText: new RegExp(`^${title.replace(/[()]/g, '\\$&')}$`) }),
})

test('#174 Duplicate chat from the chat menu: an independent copy with persona, group and sampling', async ({ page }) => {
  await boot(page, { group: true })
  await oeffneSeitenleiste(page)
  await row(page, TITLE).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Chat actions' })
  await menu.getByRole('menuitem', { name: 'Duplicate chat' }).click()

  // The copy opens at once and sits at the top of the list.
  await expect(row(page, `${TITLE} (copy)`)).toHaveAttribute('aria-selected', 'true')
  for (const [q, a] of TURNS) {
    await expect(said(page, q)).toBeVisible()
    await expect(said(page, a)).toBeVisible()
  }

  await expect.poll(async () => (await stored(page)).length).toBe(2)
  const [copy, original] = await stored(page)
  expect(copy.title).toBe(`${TITLE} (copy)`)
  expect(copy.id).not.toBe(original.id)
  expect(copy.messages.map((m) => m.content)).toEqual(original.messages.map((m) => m.content))
  expect(copy.personaEnabled).toBe(true)
  expect(copy.personaId).toBe(original.personaId)
  expect(copy.systemPrompt).toBe('You are a sea captain.')
  expect(copy.groupModels).toEqual(GROUP)
  expect(copy.groupPersonas).toEqual({ [GROUP[1]]: 'some-persona' })
  expect(copy.sampling).toEqual({ temperature: 0.35, topP: 0.8 })
  // The speaker fields of the group answers come along with the messages.
  expect(copy.messages[1]).toMatchObject({ groupPersonaId: 'some-persona', groupSpeakerName: 'Captain' })

  // Independent: a change in the copy stays in the copy.
  const bubble = bubbleOf(page, TURNS[0][0])
  await bubble.hover()
  await bubble.getByRole('button', { name: 'Delete message' }).click()
  await bubble.getByRole('button', { name: 'Delete message' }).click()
  await expect(said(page, TURNS[0][0])).toHaveCount(0)
  await row(page, TITLE).first().click()
  await expect(row(page, TITLE).first()).toHaveAttribute('aria-selected', 'true')
  await expect(said(page, TURNS[0][0])).toBeVisible()
  await expect.poll(async () => (await stored(page)).find((c) => c.id === CONV_ID)?.messages.length).toBe(6)
})

test('#174 Duplicate chat from the chat list: the hover button makes the copy too', async ({ page }) => {
  await boot(page)
  await oeffneSeitenleiste(page)
  const del = page.getByRole('button', { name: 'Duplicate chat' }).first()
  // Hover the row as Playwright does, once it stands still. The box used to be measured right after the sidebar
  // opened, while it still slid in: the mouse then sat beside the row, the bar stayed pointer-events-none, and
  // every click attempt hit the row's date instead until the timeout (1 of 20 in the CI-like container).
  await row(page, TITLE).first().hover()
  await del.click()
  await expect(row(page, `${TITLE} (copy)`)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('option')).toHaveCount(2)
  await expect(said(page, TURNS[2][1])).toBeVisible()
})

test('#174 Branch from here: a new chat up to and including that message', async ({ page }) => {
  await boot(page)
  await oeffneSeitenleiste(page)
  const bubble = bubbleOf(page, TURNS[1][1])
  await bubble.hover()
  await bubble.getByRole('button', { name: 'Branch from here' }).click()

  await expect(row(page, `${TITLE} (branch)`)).toHaveAttribute('aria-selected', 'true')
  await expect(said(page, TURNS[0][0])).toBeVisible()
  await expect(said(page, TURNS[1][1])).toBeVisible()
  await expect(said(page, TURNS[2][0])).toHaveCount(0)
  await expect(said(page, TURNS[2][1])).toHaveCount(0)

  // The new chat answers from there, and the original keeps all of it.
  await page.locator('textarea').first().fill('Q3b what does the keeper eat')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(said(page, DEFAULT_ASSISTANT_REPLY)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 30_000 })
  await row(page, TITLE).first().click()
  await expect(said(page, TURNS[2][1])).toBeVisible()
  await expect(said(page, 'Q3b what does the keeper eat')).toHaveCount(0)

  // Also from the right click menu of a message.
  await bubbleOf(page, TURNS[0][1]).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Branch from here' }).click()
  await expect(row(page, `${TITLE} (branch)`)).toHaveCount(2)
  await expect(said(page, TURNS[0][1])).toBeVisible()
  await expect(said(page, TURNS[1][0])).toHaveCount(0)
})

test('#174 Regenerate keeps the earlier answer: "< 1/2 >" on the answer', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => { Reflect.set(window, '__E2E_CHAT_BODIES__', []) })
  const bubble = bubbleOf(page, TURNS[2][1])
  await bubble.hover()
  await bubble.getByRole('button', { name: 'Regenerate response' }).click()

  await expect(said(page, DEFAULT_ASSISTANT_REPLY)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 30_000 })
  await expect(said(page, TURNS[2][1])).toHaveCount(0)
  // The question is asked once, not twice.
  await expect(said(page, TURNS[2][0])).toHaveCount(1)

  const switcher = page.getByTestId('fork-switcher')
  await expect(switcher).toHaveCount(1)
  await expect(switcher).toContainText('2/2')
  // It sits on the answer: the question did not change.
  await expect(bubbleOf(page, DEFAULT_ASSISTANT_REPLY).getByTestId('fork-switcher')).toHaveCount(1)

  await switcher.getByRole('button', { name: 'Previous version' }).click()
  await expect(said(page, TURNS[2][1])).toBeVisible()
  await expect(said(page, DEFAULT_ASSISTANT_REPLY)).toHaveCount(0)
  await expect(page.getByTestId('fork-switcher')).toContainText('1/2')

  // A second regenerate from the old version adds a third, nothing is lost.
  const again = bubbleOf(page, TURNS[2][1])
  await again.hover()
  await again.getByRole('button', { name: 'Regenerate response' }).click()
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('fork-switcher')).toContainText('3/3')
  await expect.poll(async () => {
    const conv = (await stored(page)).find((c) => c.id === CONV_ID)
    return conv?.forks ? Object.keys(conv.forks).length : 0
  }).toBe(1)
})
