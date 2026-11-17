import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tauriMockInit, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat, appModules, type AppWindow, expectWorkspaceAsk, answerWorkspaceAsk } from './support/ui'

/**
 * Every state of LU while it works on the screen, in both themes: the panel
 * at work and after a step that did not work, with each question, with the
 * switch to Autonomous and paused, and the bar of a window that does not
 * shrink. Through all of them the panel keeps its size and its place.
 *
 * With LU_COMPUTER_SHOTS set to a folder, each state is saved there as a
 * picture, over a picture of a desktop as the real window would lie over
 * one. No real window, screen, mouse or keyboard: Rust is the mock.
 */

const SHOTS = process.env.LU_COMPUTER_SHOTS
const MODEL = 'gemma-3-12b-it-q4_k_m'
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

type Theme = 'dark' | 'light'
const THEMES: Theme[] = ['dark', 'light']

async function boot(page: Page, theme: Theme, opts: { computer?: NonNullable<TauriMockOptions['computer']>; allowed?: boolean } = {}) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: 'unused', modelName: MODEL, platform: 'windows' as const, replyChunkDelayMs: 8, agentTurns: SAVE_TASK,
    computer: { screens: SCREENS, actionMs: 60_000, ...opts.computer },
  })
  await seedOnboardingDone(page)
  await page.addInitScript((allowed) => {
    window.localStorage.setItem('locally-uncensored-permissions', JSON.stringify({
      state: {
        globalPermissions: { filesystem: 'auto', terminal: 'auto', desktop: 'auto', web: 'auto', system: 'auto', image: 'auto', video: 'auto', workflow: 'auto' },
        conversationOverrides: {}, perToolOverrides: {}, modeScope: 'agent',
      },
      version: 2,
    }))
    window.localStorage.setItem('locally-uncensored-computer', JSON.stringify({
      state: { enabled: true, alwaysAllowed: allowed ? [{ key: 'notepad.exe', name: 'Notepad' }] : [], executorModel: null },
      version: 1,
    }))
  }, opts.allowed === true)
  await page.goto('/')
  await expect(page.getByRole('banner')).toBeVisible()
  await appModules(page, ['/src/stores/settingsStore.ts', '/src/stores/computerStore.ts', '/src/lib/computer/prompts.ts'])
  await page.evaluate((wanted) => {
    const { useSettingsStore } = (window as unknown as AppWindow).__APP__['/src/stores/settingsStore.ts']
    useSettingsStore.getState().updateSettings({ theme: wanted })
  }, theme)
  await expect(page.locator('html')).toHaveClass(new RegExp(theme))
}

/** A desktop behind the surface, as behind the see-through window. */
async function desktopBehind(page: Page) {
  await page.evaluate((image) => {
    if (document.getElementById('e2e-desktop')) return
    const desktop = document.createElement('div')
    desktop.id = 'e2e-desktop'
    desktop.style.cssText = `position:fixed;inset:0;z-index:0;pointer-events:none;background:#31506e center / cover url(data:image/jpeg;base64,${image})`
    document.body.prepend(desktop)
  }, SCREENS[0])
}

async function shot(page: Page, theme: Theme, name: string, corner = true) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.waitForTimeout(600)
  const view = page.viewportSize()!
  await page.screenshot({
    path: `${SHOTS}/${name}-${theme}.png`,
    clip: corner ? { x: view.width - 620, y: 0, width: 620, height: Math.min(view.height, 640) } : undefined,
  })
}

async function startAgentChat(page: Page) {
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

const setAutonomous = (page: Page) => page.evaluate(() => {
  const { useComputerStore } = (window as unknown as AppWindow).__APP__['/src/stores/computerStore.ts']
  useComputerStore.getState().setAutonomous(true)
})
const moveTheMouse = (page: Page) => page.evaluate(() => { (window as unknown as { __E2E_COMPUTER_HAND__?: boolean }).__E2E_COMPUTER_HAND__ = true })
const pageShown = (page: Page) => page.locator('#root').evaluate((root) => getComputedStyle(root).visibility === 'visible')

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test('the questions in the panel, the switch to Autonomous, and the panel at work', async ({ page }) => {
      await boot(page, theme)
      await startAgentChat(page)
      await send(page, 'Save my note.')
      const surface = page.getByTestId('computer-surface')
      const panel = page.getByTestId('computer-panel')

      const app = panel.getByRole('group', { name: 'Allow LU to control Notepad?' })
      await expect(app).toBeVisible({ timeout: 30_000 })
      await expect(surface).toHaveAttribute('data-surface', 'panel')
      await expect(surface).toHaveAttribute('data-waiting', '')
      const box = await surface.boundingBox()
      await desktopBehind(page)
      await shot(page, theme, '02-panel-app-question')
      await app.getByRole('button', { name: 'Allow for this session' }).click()

      const confirm = panel.getByRole('group', { name: 'Confirm this action' })
      await expect(confirm).toContainText('Click at 203, 235 in Notepad')
      await shot(page, theme, '03-panel-confirm-supervised')
      expect(await surface.boundingBox()).toEqual(box)
      await confirm.getByRole('button', { name: 'Autonomous' }).click()
      await expect(confirm.getByRole('button', { name: 'Autonomous' })).toHaveAttribute('aria-pressed', 'true')
      await shot(page, theme, '04-panel-confirm-autonomous-on')
      // The switch changes the session, never the shape of what is shown.
      expect(await surface.boundingBox()).toEqual(box)
      await confirm.getByRole('button', { name: 'Confirm' }).click()

      await expect(panel.getByTestId('computer-now')).toContainText('Step 1: Click at 203, 235')
      await expect(surface).not.toHaveAttribute('data-waiting', '')
      expect(await surface.boundingBox()).toEqual(box)
      await shot(page, theme, '01-working')

      // A step that did not work, and the stretch after the task while the answer is written.
      await page.evaluate(() => {
        const { useComputerStore } = (window as unknown as AppWindow).__APP__['/src/stores/computerStore.ts']
        const task = useComputerStore.getState().task
        useComputerStore.getState().setTask({ ...task, steps: [{ n: 1, label: 'Click at 203, 235', ok: false }] })
      })
      await expect(panel.getByTestId('computer-now')).toContainText('did not work')
      expect(await surface.boundingBox()).toEqual(box)
      await shot(page, theme, '06-step-did-not-work')
      expect(await pageShown(page)).toBe(false)
    })

    test('a sensitive action is asked for in an autonomous session too', async ({ page }) => {
      await boot(page, theme, { allowed: true, computer: { sensitive: true } })
      await startAgentChat(page)
      await setAutonomous(page)
      await send(page, 'Save my note.')
      const confirm = page.getByTestId('computer-panel').getByRole('group', { name: 'Confirm this action' })
      await expect(confirm).toBeVisible({ timeout: 30_000 })
      await expect(confirm).toContainText('also in an autonomous session')
      await desktopBehind(page)
      await shot(page, theme, '05-panel-confirm-sensitive')
    })

    test('the paused view, in the panel', async ({ page }) => {
      await boot(page, theme, { allowed: true })
      await startAgentChat(page)
      await setAutonomous(page)
      await send(page, 'Save my note.')
      await expect(page.getByTestId('computer-now')).toContainText('Step 1: Click at 203, 235', { timeout: 30_000 })
      const box = await page.getByTestId('computer-surface').boundingBox()
      await desktopBehind(page)
      await shot(page, theme, '01b-working-autonomous')
      await moveTheMouse(page)
      const paused = page.getByRole('alertdialog', { name: 'LU has paused' })
      await expect(paused).toBeVisible({ timeout: 2000 })
      expect(await page.getByTestId('computer-surface').boundingBox()).toEqual(box)
      await shot(page, theme, '07-paused-view')
    })

    test('a window that does not shrink: the bar, the question above the input field, and the stop', async ({ page }) => {
      await boot(page, theme, { computer: { shrinks: false } })
      await startAgentChat(page)
      await send(page, 'Save my note.')
      const app = page.getByRole('group', { name: 'Allow LU to control Notepad?' })
      await expect(app).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('computer-control-bar')).toBeVisible()
      await shot(page, theme, '08-window-question-above-the-input', false)
      await app.getByRole('button', { name: 'Allow for this session' }).click()
      const confirm = page.getByRole('group', { name: 'Confirm this action' })
      await expect(confirm).toBeVisible()
      await confirm.getByRole('button', { name: 'Autonomous' }).click()
      await expect(confirm.getByRole('button', { name: 'Autonomous' })).toHaveAttribute('aria-pressed', 'true')
      await shot(page, theme, '09-window-confirm-autonomous-on', false)
      await confirm.getByRole('button', { name: 'Confirm' }).click()
      await expect(page.getByTestId('computer-control-bar')).toContainText('Step 1 of at most 25')
      await shot(page, theme, '10-window-bar-at-work', false)
      await page.getByTestId('computer-control-bar').getByTestId('computer-stop').click()
      await expect(page.getByTestId('computer-note')).toContainText('Computer control stopped.')
      await shot(page, theme, '11-window-bar-stopped', false)
    })
  })
}
