import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tauriMockInit, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat, expectWorkspaceAsk, answerWorkspaceAsk } from './support/ui'

/**
 * The first use of computer control in a chat asks the user, as the card of
 * the tool call in the conversation. Always: here every permission is on
 * "auto" and the question still comes. Deny runs nothing. Allow holds for
 * that chat, and a new chat asks again.
 *
 * No real screen, mouse or keyboard: the Rust side is the mock
 * (e2e/support/tauri-mock.ts) with `chatQuestion` on, which keeps the yes of
 * a chat the way the engine does. The engine itself is tested in Rust
 * (commands/computer/desk/engine/tests.rs), the real window on the box.
 */

const SHOTS = process.env.LU_COMPUTER_SHOTS
const MODEL = 'gemma-3-12b-it-q4_k_m'
const screen = (name: string) => readFileSync(resolve(process.cwd(), 'e2e/fixtures/computer-task', name)).toString('base64')
const SCREENS = ['01-editor.jpg', '02-save-dialog.jpg', '03-saved.jpg'].map(screen)
const step = (value: Record<string, unknown>) => ({ text: JSON.stringify(value) })
const ASK_FOR_THE_SCREEN = { text: 'I will type it.', toolCalls: [{ name: 'computer_task', args: { goal: 'Type hello into Notepad' } }] }

async function boot(page: Page, agentTurns: TauriMockOptions['agentTurns'], dark = false) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: 'unused', modelName: MODEL, platform: 'windows' as const, replyChunkDelayMs: 8, agentTurns,
    computer: { screens: SCREENS, shrinks: false, chatQuestion: true },
  })
  await seedOnboardingDone(page)
  await page.addInitScript(() => {
    // Everything that could be mistaken for a way around the question is on.
    window.localStorage.setItem('locally-uncensored-permissions', JSON.stringify({
      state: {
        globalPermissions: { filesystem: 'auto', terminal: 'auto', desktop: 'auto', web: 'auto', system: 'auto', image: 'auto', video: 'auto', workflow: 'auto' },
        conversationOverrides: {}, perToolOverrides: {}, modeScope: 'agent',
      },
      version: 2,
    }))
    window.localStorage.setItem('locally-uncensored-computer', JSON.stringify({
      state: { enabled: true, alwaysAllowed: [{ key: 'notepad.exe', name: 'Notepad' }], executorModel: null, screenInput: 'auto' },
      version: 1,
    }))
  })
  if (dark) await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.getByRole('banner')).toBeVisible()
}

async function startAgentChat(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Chat' }).click()
  await openNewChat(page)
  const agentToggle = page.getByRole('main').getByRole('button', { name: 'Agent', exact: true })
  if (!/Agent Mode is on/i.test((await agentToggle.getAttribute('title')) ?? '')) await agentToggle.click()
  // A new agent chat asks where to work with its first message (3.1.2).
  expectWorkspaceAsk(page)
  await expect(agentToggle).toHaveAttribute('title', /Agent Mode is on/i, { timeout: 10_000 })
}

async function send(page: Page, text: string) {
  const composer = page.locator('textarea').first()
  await expect(composer).toBeEnabled({ timeout: 20_000 })
  // A run that has just ended holds the composer for a moment: Enter is taken once it is free.
  await expect(async () => {
    await composer.fill(text)
    await composer.press('Enter')
    await expect(composer).toHaveValue('', { timeout: 1_500 })
  }).toPass({ timeout: 20_000 })
  await answerWorkspaceAsk(page)
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return
  await page.waitForTimeout(450)
  await page.screenshot({ path: `${SHOTS}/${name}` })
}

const fired = (page: Page) => page.evaluate(() => (window as unknown as { __E2E_COMPUTER_FIRED__?: unknown[] }).__E2E_COMPUTER_FIRED__ ?? [])
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __E2E_COMPUTER_CALLS__?: { cmd: string }[] }).__E2E_COMPUTER_CALLS__ ?? []).map((c) => c.cmd))
const bodies = (page: Page) => page.evaluate(() => ((window as unknown as { __E2E_CHAT_BODIES__?: string[] }).__E2E_CHAT_BODIES__ ?? []))
const card = (page: Page) => page.getByRole('group', { name: 'Allow computer control in this chat' })

test('the first use asks in the conversation, and Deny runs nothing', async ({ page }) => {
  await boot(page, [ASK_FOR_THE_SCREEN, { text: 'I did not type anything.' }])
  await startAgentChat(page)
  await send(page, 'Type hello into Notepad.')

  await expect(card(page)).toBeVisible({ timeout: 30_000 })
  await expect(card(page)).toContainText('Allow computer control in this chat?')
  await expect(card(page)).toContainText('Beta')
  await expect(card(page)).toContainText('Ctrl+Alt+Esc')
  // A card of the conversation: above the input field, inside the list of messages, not part of the composer.
  const cardBox = (await card(page).boundingBox())!
  const inputBox = (await page.locator('textarea').first().boundingBox())!
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(inputBox.y)
  expect(await card(page).evaluate((el) => !!el.closest('form') || !!el.closest('[data-testid="chat-composer"]'))).toBe(false)
  // Nothing was looked at, nothing shows that LU works, and no other question is up.
  expect(await calls(page)).toEqual(['computer_chat_ask'])
  await expect(page.getByTestId('computer-control-bar')).toHaveCount(0)
  await expect(page.getByTestId('computer-question')).toHaveCount(0)
  // Enter does not answer it.
  await page.keyboard.press('Enter')
  await expect(card(page)).toBeVisible()
  await shot(page, 'chat-permission-light.png')

  await card(page).getByRole('button', { name: 'Deny' }).click()
  await expect(card(page)).toHaveCount(0)
  await expect(page.getByRole('main')).toContainText('I did not type anything.', { timeout: 30_000 })
  expect(await fired(page)).toEqual([])
  expect(await calls(page)).toEqual(['computer_chat_ask', 'computer_chat_answer'])
  const last = (await bodies(page)).at(-1) ?? ''
  expect(last).toContain('The user did not allow computer control in this chat.')
})

test('Allow holds for this chat, and a new chat asks again', async ({ page }) => {
  await boot(page, [
    ASK_FOR_THE_SCREEN,
    step({ thought: 'The editor is in front.', action: 'type', text: 'hello' }),
    step({ thought: 'The text is there.', action: 'done', summary: 'hello is typed.' }),
    { text: 'Typed it.' },
    // The same chat again: no question.
    ASK_FOR_THE_SCREEN,
    step({ thought: 'Nothing to do.', action: 'done', summary: 'hello is already there.' }),
    { text: 'It is still there.' },
    // A new chat.
    ASK_FOR_THE_SCREEN,
    { text: 'I did not type anything.' },
  ], true)
  await startAgentChat(page)
  await send(page, 'Type hello into Notepad.')
  await expect(card(page)).toBeVisible({ timeout: 30_000 })
  await shot(page, 'chat-permission-dark.png')
  await card(page).getByRole('button', { name: 'Allow' }).click()
  await expect(card(page)).toHaveCount(0)

  // The questions that were there before stay: the action is confirmed, the session is supervised.
  const confirm = page.getByRole('group', { name: 'Confirm this action' })
  await expect(confirm).toBeVisible({ timeout: 30_000 })
  expect(await fired(page)).toEqual([])
  await confirm.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('main')).toContainText('Typed it.', { timeout: 30_000 })
  expect(await fired(page)).toHaveLength(1)

  await send(page, 'Check that it is still there.')
  await expect(page.getByRole('main')).toContainText('It is still there.', { timeout: 30_000 })
  await expect(card(page)).toHaveCount(0)
  expect((await calls(page)).filter((c) => c === 'computer_chat_answer')).toHaveLength(1)

  await startAgentChat(page)
  await send(page, 'Type hello into Notepad.')
  await expect(card(page)).toBeVisible({ timeout: 30_000 })
  await card(page).getByRole('button', { name: 'Deny' }).click()
  await expect(page.getByRole('main')).toContainText('I did not type anything.', { timeout: 30_000 })
  expect(await fired(page)).toHaveLength(1)
})
