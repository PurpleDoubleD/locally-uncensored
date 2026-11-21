import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * "Branch from here" (3.1.3, David on purple: it seemed to do nothing). From
 * the last answer the new chat looks like the old one, so the app now says
 * that it opened one. Chat and Agent at a middle and at the last answer, with
 * hidden tool pairs, and after a restart. Code offers no branch: a copy of the
 * talk would not copy the files it changed.
 *
 * Run: LU_E2E_PORT=5405 npx playwright test e2e/chat-branch-every-mode.spec.ts
 */
const CONV = 'seeded-branch'
const now = Date.now()
const msg = (id: string, role: string, content: string, extra: Record<string, unknown> = {}) => ({ id, role, content, timestamp: now - 9000, ...extra })
const tools = (n: number) => [
  msg(`hc${n}`, 'assistant', '', { hidden: true, tool_calls: [{ id: `c${n}`, function: { name: 'file_read', arguments: { path: 'a.txt' } } }] }),
  msg(`hr${n}`, 'tool', 'file text', { hidden: true, tool_call_id: `c${n}` }),
]

async function boot(page: Page, agent: boolean) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' })
  await seedOnboardingDone(page)
  const messages = [
    msg('u1', 'user', 'Q1 first'), ...(agent ? tools(1) : []), msg('a1', 'assistant', 'A1 middle answer'),
    msg('u2', 'user', 'Q2 second'), ...(agent ? tools(2) : []), msg('a2', 'assistant', 'A2 last answer'),
  ]
  const seed = JSON.stringify({ state: { conversations: [{ id: CONV, title: 'Story', messages, model: DEFAULT_MODEL_NAME, systemPrompt: '', mode: 'lu', createdAt: now, updatedAt: now }], activeConversationId: CONV }, version: 0 })
  await page.addInitScript((raw: string) => {
    if (sessionStorage.getItem('e2e-seeded')) return
    sessionStorage.setItem('e2e-seeded', '1')
    localStorage.setItem('chat-conversations', raw)
  }, seed)
  await page.goto('/')
  await expect(said(page, 'A2 last answer')).toBeVisible({ timeout: 30_000 })
}

const said = (page: Page, text: string) => page.getByRole('main').locator('p').filter({ hasText: text })
const bubble = (page: Page, text: string) => said(page, text).first().locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " group ")][1]')

interface Stored { id: string; title: string; model: string; messages: { id: string; content: string; tool_calls?: { id: string }[]; tool_call_id?: string }[] }
const stored = (page: Page) => page.evaluate(async () => {
  const raw: string | null = await new Promise((res) => {
    const req = indexedDB.open('locally-uncensored-store', 1)
    req.onsuccess = () => {
      const r = req.result.transaction('kv', 'readonly').objectStore('kv').get('chat-conversations')
      r.onsuccess = () => res(typeof r.result === 'string' ? r.result : null)
      r.onerror = () => res(null)
    }
    req.onerror = () => res(null)
  })
  return (raw ? JSON.parse(raw).state.conversations : []) as unknown[]
}) as Promise<Stored[]>

for (const agent of [false, true]) {
  const name = agent ? 'Agent' : 'Chat'
  test(`${name}: branch at the last answer says so, and survives a restart`, async ({ page }) => {
    await boot(page, agent)
    const b = bubble(page, 'A2 last answer')
    await b.hover()
    await b.getByRole('button', { name: 'Branch from here' }).click()
    await expect(page.getByTestId('chat-notices')).toContainText('New chat opened: Story (branch)')
    await expect.poll(async () => (await stored(page)).length).toBe(2)
    const [copy, original] = await stored(page)
    expect(copy.title).toBe('Story (branch)')
    expect(copy.model).toBe(original.model)
    expect(copy.messages.length).toBe(original.messages.length)
    await page.reload()
    await expect(said(page, 'A2 last answer')).toBeVisible({ timeout: 30_000 })
    expect((await stored(page)).map((c) => c.title)).toEqual(['Story (branch)', 'Story'])
  })

  test(`${name}: branch at a middle answer, whole tool pairs, and it answers on`, async ({ page }) => {
    await boot(page, agent)
    const b = bubble(page, 'A1 middle answer')
    await b.hover()
    await b.getByRole('button', { name: 'Branch from here' }).click()
    await expect(said(page, 'A2 last answer')).toHaveCount(0)
    await expect.poll(async () => (await stored(page)).length).toBe(2)
    const [copy, original] = await stored(page)
    expect(copy.messages.at(-1)?.id).toBe('a1')
    expect(copy.messages.flatMap((m) => m.tool_call_id ?? [])).toEqual(copy.messages.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []))
    expect(original.messages.at(-1)?.id).toBe('a2')
    await page.locator('textarea').first().fill('Q3 go on')
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(said(page, DEFAULT_ASSISTANT_REPLY)).toBeVisible({ timeout: 30_000 })
  })
}

test('Code offers no branch, so there is no dead button', () => {
  const code = readFileSync('src/components/chat/CodexView.tsx', 'utf8')
  expect(code).not.toMatch(/Branch from here|MessageBubble|buildMessageMenu/)
})
