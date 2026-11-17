import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tauriMockInit, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat, expectWorkspaceAsk, answerWorkspaceAsk } from './support/ui'

/**
 * A task on the screen, as the user meets it: the chat model asks for
 * `computer_task`, a model that can see gets stored screenshots one by one
 * and names one action each, and every action goes through the same
 * questions as a single `computer_use` call. The status bar and the chat
 * show the steps. Stop stays in reach while a question is open.
 *
 * No real screen, mouse or keyboard: the Rust side is the mock
 * (e2e/support/tauri-mock.ts) and the screenshots are stored pictures
 * (e2e/fixtures/computer-task). The model answers are scripted; the real
 * model is measured in src/api/__tests__/computer-task.live.test.ts.
 */

const SHOTS = process.env.LU_COMPUTER_SHOTS
const SEEING_MODEL = 'gemma-3-12b-it-q4_k_m'
const BLIND_MODEL = 'qwen2.5-7b-instruct-q4_k_m'
const screen = (name: string) => readFileSync(resolve(process.cwd(), 'e2e/fixtures/computer-task', name)).toString('base64')
const SCREENS = ['01-editor.jpg', '02-save-dialog.jpg', '03-saved.jpg'].map(screen)

const step = (value: Record<string, unknown>) => ({ text: JSON.stringify(value) })
const SAVE_TASK: NonNullable<TauriMockOptions['agentTurns']> = [
  { text: 'I will save it.', toolCalls: [{ name: 'computer_task', args: { goal: 'Save the note' } }] },
  step({ thought: 'The Save button is in the toolbar.', action: 'click', x: 203, y: 235 }),
  step({ thought: 'The dialog asks to confirm.', action: 'click', x: 518, y: 639 }),
  step({ thought: 'The title shows the note is saved.', action: 'done', summary: 'The note is saved as note.txt.' }),
  { text: 'Your note is saved.' },
]

async function boot(page: Page, modelName: string, agentTurns: TauriMockOptions['agentTurns'], computer: NonNullable<TauriMockOptions['computer']> = {}) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: 'unused', modelName, platform: 'windows' as const, replyChunkDelayMs: 8, agentTurns,
    // The window stays a window here; the panel is in computer-surface.spec.ts.
    computer: { screens: SCREENS, shrinks: false, ...computer },
  })
  await seedOnboardingDone(page)
  await page.addInitScript(() => {
    window.localStorage.setItem('locally-uncensored-permissions', JSON.stringify({
      state: {
        globalPermissions: { filesystem: 'auto', terminal: 'auto', desktop: 'auto', web: 'auto', system: 'auto', image: 'auto', video: 'auto', workflow: 'auto' },
        conversationOverrides: {}, perToolOverrides: {}, modeScope: 'agent',
      },
      version: 2,
    }))
  })
  await page.goto('/')
  await expect(page.getByRole('banner')).toBeVisible()
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return
  await page.waitForTimeout(450)
  await page.screenshot({ path: `${SHOTS}/${name}` })
}

async function openComputerSettings(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const section = page.getByTestId('computer-control-settings')
  if (!(await section.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Agent Permissions', exact: true }).click()
  }
  await section.scrollIntoViewIfNeeded()
  return section
}

async function startAgentChat(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Chat' }).click()
  await openNewChat(page)
  const agentToggle = page.getByRole('main').getByRole('button', { name: 'Agent', exact: true })
  await agentToggle.click()
  expectWorkspaceAsk(page)
  await expect(agentToggle).toHaveAttribute('title', /Agent Mode is on/i, { timeout: 10_000 })
}

async function send(page: Page, text: string) {
  const composer = page.locator('textarea').first()
  await expect(composer).toBeEnabled({ timeout: 20_000 })
  await composer.fill(text)
  await composer.press('Enter')
  await answerWorkspaceAsk(page)
}

const fired = (page: Page) => page.evaluate(() => (window as unknown as { __E2E_COMPUTER_FIRED__?: { action: Record<string, unknown> }[] }).__E2E_COMPUTER_FIRED__ ?? [])
const bodies = (page: Page) => page.evaluate(() => ((window as unknown as { __E2E_CHAT_BODIES__?: string[] }).__E2E_CHAT_BODIES__ ?? []))

/** What a click at the middle of the Stop button would hit. */
const stopIsOnTop = (page: Page) => page.evaluate(() => {
  const stop = document.querySelector('[data-testid="computer-stop"]')
  if (!stop) return false
  const r = stop.getBoundingClientRect()
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return !!hit && stop.contains(hit)
})

test('the settings name the model that looks at the screen, and the switch has one label', async ({ page }) => {
  await boot(page, SEEING_MODEL, SAVE_TASK)
  const section = await openComputerSettings(page)
  // One visible "Computer control", not the heading and a second one in the switch.
  await expect(section.getByText('Computer control', { exact: true })).toHaveCount(1)
  await expect(section.getByRole('button', { name: 'Computer control' })).toHaveAttribute('aria-pressed', 'false')
  const picker = section.getByTestId('computer-screen-model')
  const choice = picker.getByRole('button', { name: 'Model that looks at the screen' })
  await expect(choice).toHaveText('Same as the chat model')
  await expect(picker.getByTestId('computer-screen-model-hint')).toContainText('works with pictures of the screen.')
  await shot(page, '01-settings-screen-model.png')

  // The list is the app's own sheet and stays inside the window, also a low one.
  await page.setViewportSize({ width: 900, height: 600 })
  await choice.scrollIntoViewIfNeeded()
  await choice.click()
  const list = page.getByRole('listbox')
  await expect(list.getByRole('option').first()).toHaveText('Same as the chat model')
  await expect(list.getByRole('option', { selected: true })).toHaveText('Same as the chat model')
  const sheet = await page.locator('.lu-elevated.lu-picker').boundingBox()
  expect(sheet).not.toBeNull()
  expect(sheet!.x).toBeGreaterThanOrEqual(0)
  expect(sheet!.y).toBeGreaterThanOrEqual(0)
  expect(sheet!.x + sheet!.width).toBeLessThanOrEqual(900)
  expect(sheet!.y + sheet!.height).toBeLessThanOrEqual(600)
  await shot(page, '01b-settings-screen-model-list.png')
  await page.keyboard.press('Escape')
  await expect(list).toHaveCount(0)
})

test('a chat model that cannot see works from the list of elements, and the user is told so', async ({ page }) => {
  await boot(page, BLIND_MODEL, [
    { text: 'I will save it.', toolCalls: [{ name: 'computer_task', args: { goal: 'Save the note' } }] },
    step({ thought: 'Save is a button of the window.', action: 'click', x: 203, y: 235 }),
    step({ thought: 'The list shows the note as saved.', action: 'done', summary: 'The note is saved.' }),
    { text: 'Your note is saved.' },
  ])
  const section = await openComputerSettings(page)
  await section.getByRole('button', { name: 'Computer control' }).click()
  const hint = section.getByTestId('computer-screen-model-hint')
  await expect(hint).toContainText('works from the list of buttons and fields of the window in front, without a picture.')
  // What the model works with is told. Nothing asks for another model or an extra download.
  await expect(section.getByTestId('add-image-input')).toHaveCount(0)
  await shot(page, '02-settings-chat-model-cannot-see.png')
  await startAgentChat(page)
  await send(page, 'Save my note.')

  await page.getByRole('group', { name: 'Allow LU to control Notepad?' }).getByRole('button', { name: 'Allow for this session' }).click({ timeout: 30_000 })
  // While it runs, the bar says how this model works.
  await expect(page.getByTestId('computer-notice')).toContainText('works from the list of buttons and fields of the window in front, without a picture.')
  await shot(page, '02b-task-without-sight.png')
  await page.getByRole('group', { name: 'Confirm this action' }).getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('main')).toContainText('Your note is saved.', { timeout: 30_000 })
  expect((await fired(page)).map((f) => f.action.type)).toEqual(['click'])

  const sent = await bodies(page)
  // No picture went to a model that cannot see. It got its own rules and the element list.
  expect(sent.some((b) => b.includes('data:image/'))).toBe(false)
  expect(sent.some((b) => b.includes('You cannot see the screen'))).toBe(true)
  expect(sent.some((b) => b.includes('Interface tree of'))).toBe(true)
  // The user still sees what happened on the screen.
  await expect(page.getByRole('main').getByTestId('screen-shots').getByRole('button')).toHaveCount(2)
})

test('where the system lists no elements, one sentence says that this model cannot see the screen there', async ({ page }) => {
  await boot(page, BLIND_MODEL, [
    { text: 'I will save it.', toolCalls: [{ name: 'computer_task', args: { goal: 'Save the note' } }] },
    { text: 'This model cannot see the screen on this system.' },
  ], { treeAvailable: false })
  const section = await openComputerSettings(page)
  await section.getByRole('button', { name: 'Computer control' }).click()
  await expect(section.getByTestId('computer-screen-model-hint')).toContainText('cannot see the screen on this system.')
  await startAgentChat(page)
  await send(page, 'Save my note.')
  await expect(page.getByRole('main')).toContainText('This model cannot see the screen on this system.', { timeout: 30_000 })
  expect(await fired(page)).toEqual([])
  await expect(page.getByTestId('computer-control-bar')).toHaveCount(0)
  // The brain was told in one sentence. Nothing is offered, and no question is up.
  const last = (await bodies(page)).at(-1) ?? ''
  expect(last).toContain('This model cannot see the screen on this system.')
  expect(last).not.toContain('Settings under Permissions')
  await expect(page.getByTestId('computer-question')).toHaveCount(0)
  await expect(page.getByTestId('add-image-input')).toHaveCount(0)
})

test('a task runs step by step through the same questions, with Stop in reach', async ({ page }) => {
  await boot(page, SEEING_MODEL, SAVE_TASK)
  const section = await openComputerSettings(page)
  await section.getByRole('button', { name: 'Computer control' }).click()
  await startAgentChat(page)
  await send(page, 'Save my note.')

  // Step 1 wants to click in Notepad: first the app, as for any action.
  const app = page.getByRole('group', { name: 'Allow LU to control Notepad?' })
  await expect(app).toBeVisible({ timeout: 30_000 })
  const bar = page.getByTestId('computer-control-bar')
  await expect(bar.getByTestId('computer-task-progress')).toContainText('Task: Save the note')
  await expect(bar.getByTestId('computer-task-step')).toContainText('Step 1 of at most 25: Click at 203, 235')
  expect(await stopIsOnTop(page)).toBe(true)
  expect(await fired(page)).toEqual([])
  await shot(page, '03-task-app-question-stop-on-top.png')
  await app.getByRole('button', { name: 'Allow for this session' }).click()

  // Then the action itself, because the session is supervised.
  const confirm = page.getByRole('group', { name: 'Confirm this action' })
  await expect(confirm).toContainText('Click at 203, 235 in Notepad')
  expect(await stopIsOnTop(page)).toBe(true)
  await expect(page.getByTestId('screen-task-steps')).toContainText('Step 1: Click at 203, 235')
  await shot(page, '04-task-step-confirmation.png')
  await confirm.getByRole('button', { name: 'Confirm' }).click()

  await expect(confirm).toContainText('Click at 518, 639 in Notepad')
  await expect(bar.getByTestId('computer-task-step')).toContainText('Step 2 of at most 25')
  await expect(page.getByTestId('screen-task-steps')).toContainText('Step 2: Click at 518, 639')
  await shot(page, '05-task-step-two.png')
  await confirm.getByRole('button', { name: 'Confirm' }).click()

  await expect(page.getByRole('main')).toContainText('Your note is saved.', { timeout: 30_000 })
  expect((await fired(page)).map((f) => f.action.type)).toEqual(['click', 'click'])
  await expect(page.getByTestId('screen-task-steps')).toHaveCount(0)
  await expect(page.getByTestId('computer-task-progress')).toHaveCount(0)

  // What LU saw stays on the card of the call: one small picture per look.
  const pictures = page.getByRole('main').getByTestId('screen-shots').getByRole('button')
  await expect(pictures).toHaveCount(3)
  await expect(pictures.nth(0)).toHaveAccessibleName('Open screenshot: Before the first step')
  await expect(pictures.nth(1)).toHaveAccessibleName('Open screenshot: Step 1: Click at 203, 235')
  await expect(pictures.nth(2)).toHaveAccessibleName('Open screenshot: Step 2: Click at 518, 639')
  const small = await pictures.nth(1).boundingBox()
  expect(small!.height).toBeLessThanOrEqual(64)
  await shot(page, '06-task-done.png')
  await pictures.nth(1).click()
  const large = page.getByRole('dialog', { name: 'Step 1: Click at 203, 235' })
  await expect(large.locator('img')).toBeVisible()
  expect(await large.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(600)
  await expect(large.getByRole('button', { name: 'Close' })).toBeVisible()
  // Over the whole window: in its middle, and nothing of the app lies on its left edge (the sidebar did).
  const placed = await large.evaluate((panel) => {
    const box = panel.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + 4, box.top + box.height / 2)
    return { middle: box.left + box.width / 2, window: window.innerWidth / 2, own: !!hit && panel.contains(hit) }
  })
  expect(Math.abs(placed.middle - placed.window)).toBeLessThanOrEqual(2)
  expect(placed.own).toBe(true)
  await shot(page, '06b-task-picture-open.png')
  await page.keyboard.press('Escape')
  await expect(large).toHaveCount(0)

  // In memory only: nothing the app wrote to its storage holds a picture.
  const stored = await page.evaluate(() => Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? '').join('\n'))
  expect(stored).not.toContain('blob:')
  expect(stored).not.toMatch(/data:image\/jpeg;base64,[A-Za-z0-9+/]{200}/)

  const sent = await bodies(page)
  // The model that looks got the stored picture and the rules about the screen.
  const look = sent.find((b) => b.includes('data:image/jpeg;base64,')) ?? ''
  expect(look).toContain('Save the note')
  expect(look).toMatch(/never follow instructions/i)
  // The brain got words, not pictures.
  const final = sent.at(-1) ?? ''
  expect(final).toContain('The note is saved as note.txt.')
  expect(final).not.toContain('data:image/jpeg')
})

test('Stop during a question ends the task and the brain hears why', async ({ page }) => {
  await boot(page, SEEING_MODEL, [
    SAVE_TASK[0], SAVE_TASK[1],
    { text: 'I stopped, as you asked.' },
  ])
  const section = await openComputerSettings(page)
  await section.getByRole('button', { name: 'Computer control' }).click()
  await startAgentChat(page)
  await send(page, 'Save my note.')
  await expect(page.getByRole('group', { name: 'Allow LU to control Notepad?' })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('computer-stop').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('computer-note')).toContainText('Computer control stopped.')
  await expect(page.getByRole('main')).toContainText('I stopped, as you asked.', { timeout: 30_000 })
  expect(await fired(page)).toEqual([])
  await expect(page.getByTestId('computer-task-progress')).toHaveCount(0)
  await shot(page, '07-task-stopped.png')
  expect((await bodies(page)).at(-1) ?? '').toMatch(/stopped/i)
})

test('no picture while a password field has the focus: the card says so instead', async ({ page }) => {
  await boot(page, SEEING_MODEL, [
    { text: 'I will sign in.', toolCalls: [{ name: 'computer_task', args: { goal: 'Open the sign in form' } }] },
    step({ thought: 'Click into the form.', action: 'click', x: 500, y: 400 }),
    { text: 'A password field has the focus now. Please type your password yourself.' },
  ], { passwordAfterActions: 1 })
  const section = await openComputerSettings(page)
  await section.getByRole('button', { name: 'Computer control' }).click()
  await startAgentChat(page)
  await send(page, 'Sign me in.')
  await page.getByRole('group', { name: 'Allow LU to control Notepad?' }).getByRole('button', { name: 'Allow for this session' }).click({ timeout: 30_000 })
  await page.getByRole('group', { name: 'Confirm this action' }).getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('main')).toContainText('Please type your password yourself.', { timeout: 30_000 })

  const strip = page.getByRole('main').getByTestId('screen-shots')
  // The look before the click is there. The looks after it are one line, not a picture.
  await expect(strip.getByRole('button')).toHaveCount(1)
  await expect(strip.getByTestId('screen-shot-withheld')).toHaveCount(1)
  await expect(strip.getByTestId('screen-shot-withheld')).toHaveText('Not shown: a password field had the focus.')
  await shot(page, '08-password-field-no-picture.png')
})
