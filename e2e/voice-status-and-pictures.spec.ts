import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tauriMockInit, DEFAULT_MODEL_NAME, DEFAULT_ASSISTANT_REPLY } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { appModules, type AppWindow } from './support/ui'

/**
 * The Voice surface with the two shared building blocks: the status line in
 * plain words, and the pictures of a screen task on its card in the
 * transcript. The session state is set directly, without a voice loop; the
 * talk against the real one is voice-session-live.spec.ts.
 *
 * LU_VOICE_SHOTS=<folder> also writes pictures of each state.
 */

const SHOTS = process.env.LU_VOICE_SHOTS
const screen = (name: string) => readFileSync(resolve(process.cwd(), 'e2e/fixtures/computer-task', name)).toString('base64')
const SCREENS = ['01-editor.jpg', '02-save-dialog.jpg', '03-saved.jpg'].map(screen)

type Look = { theme: 'dark' | 'light'; width: number; height: number; tag: string }
const LOOKS: Look[] = [
  { theme: 'dark', width: 1280, height: 800, tag: 'dark' },
  { theme: 'light', width: 1280, height: 800, tag: 'light' },
  { theme: 'dark', width: 900, height: 600, tag: '900x600' },
]

async function boot(page: Page, look: Look) {
  await page.setViewportSize({ width: look.width, height: look.height })
  await page.addInitScript(() => {
    MediaDevices.prototype.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream
  })
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const,
    voiceLoop: { installed: true, session: { port: 9, token: 'e2e-launch-token'.padEnd(64, '0') } },
  })
  await seedOnboardingDone(page)
  if (look.theme === 'light') {
    await page.addInitScript(() => {
      const raw = window.localStorage.getItem('chat-settings')
      const stored = raw ? JSON.parse(raw) : { state: { settings: {} }, version: 0 }
      stored.state.settings = { ...(stored.state.settings ?? {}), theme: 'light' }
      window.localStorage.setItem('chat-settings', JSON.stringify(stored))
    })
  }
  await page.goto('/')
  if (look.width < 1024) {
    await page.getByRole('button', { name: 'Main navigation' }).click()
    await page.getByRole('menuitem', { name: 'Voice' }).click()
  } else {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Voice', exact: true }).click()
  }
  await expect(page.getByTestId('voice-view')).toBeVisible()
  await expect(page.getByTestId('voice-view').getByRole('button', { name: 'Start voice' })).toBeVisible()
}

/** Dispatch session events, as the voice loop would. */
async function play(page: Page, events: Record<string, unknown>[]) {
  await appModules(page, ['/src/stores/voiceSessionStore.ts'])
  await page.evaluate((list) => {
    const { useVoiceSessionStore } = (window as unknown as AppWindow).__APP__['/src/stores/voiceSessionStore.ts']
    for (const event of list) useVoiceSessionStore.getState().dispatch(event)
  }, events)
}

const TALK = [
  { type: 'start', at: 0, muted: false },
  { type: 'brain', modelLabel: 'Qwen3.5 9B', notice: null },
  { type: 'ready' },
  { type: 'user-text', text: 'Add coffee to my shopping list and save it.', final: true },
]

async function shot(page: Page, name: string) {
  if (!SHOTS) return
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

for (const look of LOOKS) {
  test(`a running tool reads in plain words, and a screen task shows its pictures (${look.tag})`, async ({ page }) => {
    await boot(page, look)
    const view = page.getByTestId('voice-view')
    const status = view.getByTestId('voice-status')

    await play(page, [...TALK.map((e) => (e.type === 'start' ? { ...e, at: Date.now() } : e)), { type: 'bot-thinking' }])
    await expect(status).toHaveText('Thinking')
    await shot(page, `01-thinking-${look.tag}`)

    await play(page, [{ type: 'tool-running', id: 'call-1', name: 'file_write', args: { path: 'shopping.txt', content: 'milk\nbread\ncoffee' } }])
    await expect(status).toHaveText('Writing')
    await expect(view).not.toContainText('Running file_write')
    // The call itself looks as it does in the chat: a plain sentence in the
    // shimmer (3.1.0, tool steps in plain words) and three dots.
    const writing = view.locator('[data-tool="file_write"]')
    await expect(writing).toHaveAttribute('data-status', 'running')
    await expect(writing.locator('.lu-tool-shimmer')).toHaveText('Writing shopping.txt')
    await expect(writing.locator('.lu-band-dot')).toHaveCount(3)
    await shot(page, `02-tool-writing-${look.tag}`)

    await play(page, [
      { type: 'tool-done', id: 'call-1', status: 'completed', result: 'Wrote shopping.txt', durationMs: 40 },
      { type: 'tool-running', id: 'call-2', name: 'web_search', args: { query: 'coffee prices' } },
    ])
    await expect(status).toHaveText('Searching')
    await play(page, [{ type: 'tool-done', id: 'call-2', status: 'completed', result: 'Three results.', durationMs: 1300 }, { type: 'bot-text', text: 'Done. Coffee is on the list.' }, { type: 'bot-speaking' }])
    await expect(status).toHaveText('Speaking')
    // Two calls in a row are one band, folded once they are done, and open on a click.
    const band = view.getByRole('group', { name: 'Tools' })
    await expect(band).toContainText('2 steps')
    await expect(band).toContainText('1.3s')
    await expect(band.locator('[data-tool]')).toHaveCount(0)
    await shot(page, `03-speaking-${look.tag}`)
    await play(page, [{ type: 'bot-silent' }])
    await expect(status).toHaveText('Listening')

    // A screen task: the status names the step, the card shows what LU saw.
    await play(page, [
      { type: 'user-text', text: 'Now save my note on the screen.', final: true },
      { type: 'tool-running', id: 'call-3', name: 'computer_task', args: { goal: 'Save the note' } },
    ])
    await appModules(page, ['/src/lib/computer/screen-shots.ts', '/src/stores/computerStore.ts'])
    await page.evaluate((screens) => {
      const shots = (window as unknown as AppWindow).__APP__['/src/lib/computer/screen-shots.ts']
      const { useComputerStore } = (window as unknown as AppWindow).__APP__['/src/stores/computerStore.ts']
      shots.clearScreenShots()
      shots.keepScreenShot('call-3', 1, { data: screens[0], mimeType: 'image/jpeg' })
      shots.captionScreenShot(1, 'Before the first step')
      shots.keepScreenShot('call-3', 2, { data: screens[1], mimeType: 'image/jpeg' })
      shots.captionScreenShot(2, 'Step 1: Click at 203, 235')
      shots.noteWithheldScreenShot('call-3')
      useComputerStore.getState().setTask({
        goal: 'Save the note', maxSteps: 25, phase: 'acting', modelLabel: 'Qwen3.5 9B',
        steps: [{ n: 1, label: 'Click at 203, 235', ok: true }, { n: 2, label: 'Type 8 characters', ok: null }],
      })
    }, SCREENS)
    await expect(status).toHaveText('Working on the screen: Type 8 characters')
    const card = view.locator('[data-tool="computer_task"]')
    const strip = card.getByTestId('screen-shots')
    await expect(strip.getByRole('button')).toHaveCount(2)
    await expect(strip.getByTestId('screen-shot-withheld')).toHaveText('Not shown: a password field had the focus.')
    // Nothing reaches out of the window.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    for (const name of ['Mute microphone', 'Stop voice']) {
      const box = (await view.getByRole('button', { name, exact: true }).boundingBox())!
      expect(box.y + box.height).toBeLessThanOrEqual(look.height)
    }
    await shot(page, `04-screen-task-pictures-${look.tag}`)

    // A click opens the picture large, as in the chat, with its X, and Escape closes it.
    await strip.getByRole('button', { name: 'Open screenshot: Step 1: Click at 203, 235' }).click()
    const large = page.getByRole('dialog', { name: 'Step 1: Click at 203, 235' })
    await expect(large.locator('img')).toBeVisible()
    await expect(large.getByRole('button', { name: 'Close' })).toBeVisible()
    await shot(page, `05-picture-open-${look.tag}`)
    await page.keyboard.press('Escape')
    await expect(large).toHaveCount(0)

    // The task is over: the steps go, the pictures stay on the card.
    await appModules(page, ['/src/stores/computerStore.ts'])
    await page.evaluate(() => {
      const { useComputerStore } = (window as unknown as AppWindow).__APP__['/src/stores/computerStore.ts']
      useComputerStore.getState().setTask(null)
    })
    await play(page, [{ type: 'tool-done', id: 'call-3', status: 'completed', result: 'The screen task is finished.' }])
    await expect(card.getByTestId('screen-task-steps')).toHaveCount(0)
    await expect(strip.getByRole('button')).toHaveCount(2)

    // The approval: the strip of the chat, and the waiting call as its open tool block.
    await play(page, [{ type: 'tool-waiting', id: 'call-4', name: 'file_write', args: { path: 'note.txt', content: 'hello' } }])
    await expect(status).toHaveText('Waiting for your approval')
    const approval = view.getByTestId('voice-approval')
    await expect(approval.getByTestId('approval-what')).toHaveText('Voice wants to change a file. Nothing happens until you answer.')
    await expect(approval.getByTestId('approval-what')).toHaveAttribute('title', 'file_write')
    await expect(approval).not.toContainText('file_write')
    await expect(approval.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
    await expect(approval.getByRole('button', { name: 'Reject', exact: true })).toBeVisible()
    const waiting = view.locator('[data-tool="file_write"][data-status="pending_approval"]')
    await expect(waiting.locator('pre').first()).toContainText('"content": "hello"')
    await expect(waiting.getByRole('button', { name: 'Approve' })).toBeVisible()
    for (const name of ['Mute microphone', 'Stop voice']) {
      const box = (await view.getByRole('button', { name, exact: true }).boundingBox())!
      expect(box.y + box.height).toBeLessThanOrEqual(look.height)
    }
    await shot(page, `06-approval-${look.tag}`)
  })
}

test('what is said while a local model gets ready is kept and shown', async ({ page }) => {
  await boot(page, LOOKS[0])
  const view = page.getByTestId('voice-view')
  await play(page, [
    { type: 'start', at: Date.now(), muted: false },
    { type: 'brain', modelLabel: 'Qwen3.5 9B', notice: null },
    { type: 'start-step', step: 'warming', coldStart: false },
    { type: 'user-text', text: 'What is the capital of France?', final: true },
  ])
  await expect(view.getByTestId('voice-status')).toHaveText('Getting ready')
  await expect(view.locator('li[data-role="user"]')).toHaveText('What is the capital of France?')
  await shot(page, '07-getting-ready-keeps-the-sentence-dark')
  await play(page, [{ type: 'ready' }])
  await expect(view.getByTestId('voice-status')).toHaveText('Thinking')
  await play(page, [{ type: 'bot-text', text: 'Paris.' }, { type: 'bot-speaking' }])
  await expect(view.locator('li[data-role]')).toHaveCount(2)
})

for (const look of LOOKS) {
  test(`the voice settings are a popup on the shared sheet, with its X (${look.tag})`, async ({ page }) => {
    await boot(page, look)
    await page.getByTestId('voice-view').getByRole('button', { name: 'Voice settings' }).click()
    const dialog = page.getByRole('dialog', { name: 'Voice settings' })
    await expect(dialog).toHaveClass(/lu-dialog/)
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible()
    for (const name of ['Repair', 'Uninstall']) await expect(dialog.getByRole('button', { name })).toHaveClass(/lu-dialog-btn/)
    await shot(page, `08-voice-settings-${look.tag}`)
    await dialog.getByRole('button', { name: 'Uninstall' }).click()
    await expect(dialog.getByRole('button', { name: 'Remove' })).toHaveClass(/lu-dialog-btn-danger/)
    await shot(page, `09-voice-settings-uninstall-${look.tag}`)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
}
