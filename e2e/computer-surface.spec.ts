import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tauriMockInit, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat, appModules, type AppWindow, expectWorkspaceAsk, answerWorkspaceAsk } from './support/ui'

/**
 * LU while it works on the screen (the owner's roadmap of 08.10.2026): the main
 * window shrinks to one small panel in the corner. The panel shows what the
 * model does, asks the questions, carries Pause and Stop and becomes the
 * paused view once the user reaches for the mouse or the keyboard. It keeps
 * its size and its place through all of that. The window comes back when
 * the work is over.
 *
 * No real window, screen, mouse or keyboard. Rust is the mock
 * (e2e/support/tauri-mock.ts): it records which surface the interface asks
 * for and answers as Windows would, and `window.__E2E_COMPUTER_HAND__`
 * stands in for the user's hand on the mouse. The page shows the pieces at
 * the sizes the window would have. What the real window does (shrinking,
 * the glow, the pause on a real mouse) is not proven here.
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

const PANEL = [380, 480]

interface SurfaceRecord { want: { mode: string; active: boolean; focus: boolean; monitorId: number | null }; applied: string }

async function boot(page: Page, agentTurns: TauriMockOptions['agentTurns'], opts: { computer?: NonNullable<TauriMockOptions['computer']>; allowed?: boolean } = {}) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: 'unused', modelName: MODEL, platform: 'windows' as const, replyChunkDelayMs: 8, agentTurns,
    computer: { screens: SCREENS, ...opts.computer },
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
    // Computer control is on, and for the autonomous runs Notepad is always allowed.
    window.localStorage.setItem('locally-uncensored-computer', JSON.stringify({
      state: { enabled: true, alwaysAllowed: allowed ? [{ key: 'notepad.exe', name: 'Notepad' }] : [], executorModel: null },
      version: 1,
    }))
  }, opts.allowed === true)
  await page.goto('/')
  await expect(page.getByRole('banner')).toBeVisible()
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return
  await page.waitForTimeout(450)
  await page.screenshot({ path: `${SHOTS}/${name}` })
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

/** The session asks only before sensitive actions, as after the switch in a question. */
const autonomous = (page: Page) => appModules(page, ['/src/stores/computerStore.ts']).then(() => page.evaluate(() => {
  const { useComputerStore } = (window as unknown as AppWindow).__APP__['/src/stores/computerStore.ts']
  useComputerStore.getState().setAutonomous(true)
}))
/** The user moves the mouse. The engine notices when it is asked or acts next. */
const moveTheMouse = (page: Page) => page.evaluate(() => { (window as unknown as { __E2E_COMPUTER_HAND__?: boolean }).__E2E_COMPUTER_HAND__ = true })

const fired = (page: Page) => page.evaluate(() => (window as unknown as { __E2E_COMPUTER_FIRED__?: { action: Record<string, unknown> }[] }).__E2E_COMPUTER_FIRED__ ?? [])
const bodies = (page: Page) => page.evaluate(() => ((window as unknown as { __E2E_CHAT_BODIES__?: string[] }).__E2E_CHAT_BODIES__ ?? []))
const surfaces = (page: Page) => page.evaluate(() => ((window as unknown as { __E2E_COMPUTER_SURFACE__?: SurfaceRecord[] }).__E2E_COMPUTER_SURFACE__ ?? []))
const windowShapes = (page: Page) => page.evaluate(() => ((window as unknown as { __E2E_COMPUTER_WINDOW__?: { mode: string; by: string }[] }).__E2E_COMPUTER_WINDOW__ ?? []))
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __E2E_COMPUTER_CALLS__?: { cmd: string; args?: Record<string, unknown> }[] }).__E2E_COMPUTER_CALLS__ ?? []))
const pageShown = (page: Page) => page.locator('#root').evaluate((root) => getComputedStyle(root).visibility === 'visible')

test('one panel from the first question to the end of the task: same size, same place, and the window comes back', async ({ page }) => {
  await boot(page, SAVE_TASK, { computer: { actionMs: 1500 } })
  await startAgentChat(page)
  expect(await pageShown(page)).toBe(true)
  await send(page, 'Save my note.')

  // Step 1 wants to click in Notepad. LU is shrunk, so the question stands in the panel.
  const surface = page.getByTestId('computer-surface')
  const panel = page.getByTestId('computer-panel')
  const app = panel.getByRole('group', { name: 'Allow LU to control Notepad?' })
  await expect(app).toBeVisible({ timeout: 30_000 })
  await expect(surface).toHaveAttribute('data-surface', 'panel')
  // The window is the panel now: the page is not shown, and nothing is a dialog.
  expect(await pageShown(page)).toBe(false)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('computer-control-bar')).toHaveCount(0)
  const box = (await surface.boundingBox())!
  expect([Math.round(box.width), Math.round(box.height)]).toEqual(PANEL)
  // Top right corner.
  const view = page.viewportSize()!
  expect(view.width - (box.x + box.width)).toBeLessThan(24)
  expect(box.y).toBeLessThan(24)
  // Same words and the same four answers as the dialog had. The way out has the first focus.
  await expect(app).toContainText('Terminals, password managers, system dialogs and LU itself stay off limits')
  for (const name of ['Allow once', 'Allow for this session', 'Always allow', 'Deny']) await expect(app.getByRole('button', { name, exact: true })).toBeVisible()
  await expect(app.getByRole('button', { name: 'Deny', exact: true })).toBeFocused()
  // What the model does, and Pause and Stop, each with its shortcut.
  await expect(panel.getByTestId('computer-task-step')).toContainText('Step 1 of at most 25: Click at 203, 235')
  await expect(panel.getByTestId('computer-now')).toHaveText('Waiting for your answer')
  await expect(panel.getByTestId('computer-stop')).toHaveAttribute('aria-keyshortcuts', 'Ctrl+Alt+Esc')
  await expect(panel.getByTestId('computer-pause-button')).toHaveAttribute('aria-keyshortcuts', 'Ctrl+Alt+Space')
  // Nothing runs until the user answers, and the panel says so.
  await expect(surface).toHaveAttribute('data-waiting', '')
  // The window takes no focus from the app LU works in.
  expect((await surfaces(page)).at(-1)).toMatchObject({ want: { mode: 'panel', active: true, focus: false }, applied: 'panel' })
  expect(await fired(page)).toEqual([])
  await shot(page, '01-question-in-the-panel.png')
  await app.getByRole('button', { name: 'Allow for this session' }).click()

  // The action itself, because the session is supervised. The switch is right here.
  const confirm = panel.getByRole('group', { name: 'Confirm this action' })
  await expect(confirm).toContainText('Click at 203, 235 in Notepad')
  await expect(confirm.getByRole('button', { name: 'Decline' })).toBeFocused()
  await shot(page, '02-confirmation-in-the-panel.png')

  // The switch to Autonomous, right in the question. It switches the session
  // that is running: no session ends, so Rust never puts the window back,
  // and neither the panel nor anything in it moves.
  const toggle = confirm.getByRole('button', { name: 'Autonomous' })
  const places = async () => ({
    panel: await surface.boundingBox(),
    toggle: await toggle.boundingBox(),
    confirm: await confirm.getByRole('button', { name: 'Confirm' }).boundingBox(),
  })
  // The question has faded in and stands still.
  await page.waitForTimeout(400)
  const before = await places()
  const shapesBefore = await windowShapes(page)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(confirm.getByTestId('computer-autonomy-state')).toContainText('On for this session')
  await page.waitForTimeout(400)
  expect(await places()).toEqual(before)
  expect(await windowShapes(page)).toEqual(shapesBefore)
  expect((await calls(page)).map((c) => c.cmd)).not.toContain('computer_session_end')
  expect((await calls(page)).filter((c) => c.cmd === 'computer_session_set_autonomous').map((c) => c.args?.autonomous)).toEqual([true])
  // And back again, the same way.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(await places()).toEqual(before)
  expect(await windowShapes(page)).toEqual(shapesBefore)
  await confirm.getByRole('button', { name: 'Confirm' }).click()

  // Now the agent has the mouse. The panel is still the panel: same size,
  // same place, with the step in its head and Pause and Stop in reach.
  await expect(panel.getByTestId('computer-now')).toContainText(/Step \d: Click at/)
  await expect(surface).toHaveAttribute('data-surface', 'panel')
  await expect(surface).not.toHaveAttribute('data-waiting', '')
  expect(await surface.boundingBox()).toEqual(box)
  await expect(panel.getByTestId('status-glyph').first()).toBeVisible()
  await expect(panel.getByTestId('computer-shortcuts')).toContainText('Pause Ctrl+Alt+Space')
  await expect(panel.getByTestId('computer-shortcuts')).toContainText('Stop Ctrl+Alt+Esc')
  await expect(panel.getByTestId('computer-stop')).toBeEnabled()
  await expect(panel.getByTestId('computer-pause-button')).toBeEnabled()
  // What the model did so far runs through the panel.
  await expect(panel.getByTestId('computer-activity').locator('[data-tool="computer_task"]')).toBeVisible()
  expect(await pageShown(page)).toBe(false)
  expect((await surfaces(page)).at(-1)).toMatchObject({ want: { mode: 'panel', active: true, focus: false }, applied: 'panel' })
  await shot(page, '03-panel-while-the-agent-works.png')

  // The task ends: the window is the window again, with the answer in the chat.
  await expect(page.getByRole('main')).toContainText('Your note is saved.', { timeout: 30_000 })
  await expect(surface).toHaveCount(0)
  expect(await pageShown(page)).toBe(true)
  expect((await fired(page)).map((f) => f.action.type)).toEqual(['click', 'click'])
  await shot(page, '04-window-back-after-the-task.png')

  // The glow follows the work: asked for with every surface that is not the
  // window, and taken down with the last call.
  const log = await surfaces(page)
  expect(log.length).toBeGreaterThan(3)
  for (const entry of log) {
    expect(entry.want.active).toBe(entry.want.mode !== 'window')
    expect(entry.applied).toBe(entry.want.mode)
  }
  expect(log.at(-1)).toMatchObject({ want: { mode: 'window', active: false }, applied: 'window' })
  // The real window changed its shape exactly twice: to the panel, and back.
  expect((await windowShapes(page)).map((shape) => shape.mode)).toEqual(['panel', 'window'])
  // The panel went to the display the task looked at.
  expect(log.some((entry) => entry.want.mode === 'panel' && entry.want.monitorId === 1)).toBe(true)
  // Nothing about the shape of the window is kept for the next start.
  const stored = await page.evaluate(() => localStorage.getItem('locally-uncensored-computer') ?? '')
  expect(stored).not.toMatch(/surface|panel|paused|monitorId/)
})

test('moving the mouse pauses the agent: the paused view asks in the panel, takes an instruction, and "Let it continue" goes on from a new look', async ({ page }) => {
  await boot(page, SAVE_TASK, { computer: { actionMs: 1500 }, allowed: true })
  await startAgentChat(page)
  await autonomous(page)
  await send(page, 'Save my note.')

  const surface = page.getByTestId('computer-surface')
  await expect(page.getByTestId('computer-now')).toContainText('Step 1: Click at 203, 235', { timeout: 30_000 })
  const working = await surface.boundingBox()
  await moveTheMouse(page)

  // The question comes up while the agent is still in its step, not at the next one.
  const paused = page.getByRole('alertdialog', { name: 'LU has paused' })
  await expect(paused).toBeVisible({ timeout: 2000 })
  // In the panel, which stays where and as large as it is.
  await expect(surface).toHaveAttribute('data-surface', 'panel')
  await expect(surface).toHaveAttribute('data-waiting', '')
  expect(await surface.boundingBox()).toEqual(working)
  await expect(paused).toContainText('You moved the mouse or pressed a key. LU does nothing until you choose.')
  await expect(paused.getByRole('button', { name: 'Take over' })).toBeFocused()
  await expect(paused.getByRole('button', { name: 'Let it continue' })).toBeVisible()
  // Now the panel takes the keyboard, so the instruction can be typed.
  expect((await surfaces(page)).at(-1)).toMatchObject({ want: { mode: 'panel', active: true, focus: true }, applied: 'panel' })
  // What the model did so far, with the chat's own blocks and the pictures.
  const activity = paused.getByTestId('computer-activity')
  await expect(activity.getByTestId('computer-task-progress')).toContainText('Task: Save the note')
  await expect(activity.locator('[data-tool="computer_task"]')).toBeVisible()
  await expect(activity.getByTestId('screen-shots').getByRole('button').first()).toBeVisible()

  // Nothing runs while the question is open, however long it stays.
  const before = (await fired(page)).length
  await page.waitForTimeout(2500)
  expect((await fired(page)).length).toBe(before)
  await expect(paused).toBeVisible()
  expect((await calls(page)).filter((c) => c.cmd === 'computer_takeover_answer')).toEqual([])
  await shot(page, '05-paused-view.png')

  await paused.getByLabel('Instruction for LU').fill('Save it as draft.txt')
  await shot(page, '06-paused-view-with-instruction.png')
  await paused.getByRole('button', { name: 'Let it continue' }).click()
  await expect(paused).toHaveCount(0)
  // The panel is at work again, and on to the end.
  await expect(page.getByTestId('computer-now')).toContainText(/Step \d|Working on the screen/)
  expect(await surface.boundingBox()).toEqual(working)
  await expect(page.getByRole('main')).toContainText('Your note is saved.', { timeout: 30_000 })
  expect(await pageShown(page)).toBe(true)
  expect((await calls(page)).filter((c) => c.cmd === 'computer_takeover_answer').map((c) => c.args)).toEqual([{ continue: true }])

  // The model that looks at the screen got the instruction and a new look.
  const sent = await bodies(page)
  expect(sent.some((b) => b.includes('The user added while you worked: Save it as draft.txt'))).toBe(true)
  expect(sent.some((b) => b.includes('the user used the mouse or the keyboard, so LU paused') || b.includes('so LU paused and this step did not run'))).toBe(true)
})

test('"Take over" ends the task like Stop, and the window says why', async ({ page }) => {
  await boot(page, [SAVE_TASK[0], SAVE_TASK[1], { text: 'I stopped, because you took over.' }], { computer: { actionMs: 1500 }, allowed: true })
  await startAgentChat(page)
  await autonomous(page)
  await send(page, 'Save my note.')
  await expect(page.getByTestId('computer-now')).toContainText('Step 1: Click at 203, 235', { timeout: 30_000 })
  await moveTheMouse(page)
  const paused = page.getByRole('alertdialog', { name: 'LU has paused' })
  await expect(paused).toBeVisible({ timeout: 2000 })
  await paused.getByRole('button', { name: 'Take over' }).click()

  await expect(paused).toHaveCount(0)
  await expect(page.getByTestId('computer-surface')).toHaveCount(0)
  expect(await pageShown(page)).toBe(true)
  await expect(page.getByTestId('computer-note')).toContainText('Computer control stopped. The user took over the mouse or keyboard')
  await expect(page.getByRole('main')).toContainText('I stopped, because you took over.', { timeout: 30_000 })
  expect((await bodies(page)).at(-1) ?? '').toMatch(/took over|stopped/i)
  expect((await calls(page)).filter((c) => c.cmd === 'computer_takeover_answer').map((c) => c.args)).toEqual([{ continue: false }])
  expect((await surfaces(page)).at(-1)).toMatchObject({ want: { mode: 'window', active: false }, applied: 'window' })
  await shot(page, '07-window-after-take-over.png')
})

test('Escape in the paused view takes over', async ({ page }) => {
  await boot(page, [SAVE_TASK[0], SAVE_TASK[1], { text: 'Stopped.' }], { computer: { actionMs: 1500 }, allowed: true })
  await startAgentChat(page)
  await autonomous(page)
  await send(page, 'Save my note.')
  await expect(page.getByTestId('computer-now')).toContainText('Step 1', { timeout: 30_000 })
  await moveTheMouse(page)
  const paused = page.getByRole('alertdialog', { name: 'LU has paused' })
  await expect(paused).toBeVisible({ timeout: 2000 })
  await paused.getByLabel('Instruction for LU').fill('ignored')
  await page.keyboard.press('Escape')
  await expect(paused).toHaveCount(0)
  await expect(page.getByTestId('computer-note')).toContainText('The user took over the mouse or keyboard')
  expect((await calls(page)).filter((c) => c.cmd === 'computer_takeover_answer').map((c) => c.args)).toEqual([{ continue: false }])
})

test('where the window does not shrink, the paused view covers the window and is answered the same way', async ({ page }) => {
  await boot(page, SAVE_TASK, { computer: { actionMs: 1500, shrinks: false }, allowed: true })
  await startAgentChat(page)
  await autonomous(page)
  await send(page, 'Save my note.')

  // The window stays, with its bar.
  await expect(page.getByTestId('computer-control-bar')).toContainText('Step 1 of at most 25: Click at 203, 235', { timeout: 30_000 })
  await expect(page.getByTestId('computer-panel')).toHaveCount(0)
  await moveTheMouse(page)

  const paused = page.getByRole('alertdialog', { name: 'LU has paused' })
  await expect(paused).toBeVisible({ timeout: 2000 })
  await expect(paused.getByRole('button', { name: 'Take over' })).toBeFocused()
  expect(await pageShown(page)).toBe(true)
  // The user is in another app: the window with the question comes forward.
  await expect.poll(async () => (await calls(page)).filter((c) => c.cmd === 'computer_request_attention').length).toBe(1)
  const before = (await fired(page)).length
  await page.waitForTimeout(1500)
  expect((await fired(page)).length).toBe(before)
  await shot(page, '09-paused-view-in-the-window.png')

  await paused.getByRole('button', { name: 'Let it continue' }).click()
  await expect(paused).toHaveCount(0)
  await expect(page.getByRole('main')).toContainText('Your note is saved.', { timeout: 30_000 })
  expect((await calls(page)).filter((c) => c.cmd === 'computer_takeover_answer').map((c) => c.args)).toEqual([{ continue: true }])
})

test('Stop in the panel ends the task and brings the window back', async ({ page }) => {
  await boot(page, [SAVE_TASK[0], SAVE_TASK[1], { text: 'I stopped, as you asked.' }])
  await startAgentChat(page)
  await send(page, 'Save my note.')
  const panel = page.getByTestId('computer-panel')
  await expect(panel.getByRole('group', { name: 'Allow LU to control Notepad?' })).toBeVisible({ timeout: 30_000 })
  await panel.getByTestId('computer-stop').click()
  await expect(page.getByTestId('computer-surface')).toHaveCount(0)
  await expect(page.getByTestId('computer-note')).toContainText('Computer control stopped.')
  await expect(page.getByRole('main')).toContainText('I stopped, as you asked.', { timeout: 30_000 })
  expect(await fired(page)).toEqual([])
  expect(await pageShown(page)).toBe(true)
})

test('the glow is one still page for reduced motion and never takes a click', async ({ page }) => {
  await page.goto('/computer-glow.html')
  const glow = page.locator('.glow')
  await expect(glow).toHaveCount(1)
  expect(await page.locator('script').count()).toBe(0)
  expect(await glow.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe('none')
  expect(await glow.evaluate((node) => getComputedStyle(node).animationName)).toBe('breathe')
  // The accent of the app, at the edge.
  expect(await glow.evaluate((node) => getComputedStyle(node).boxShadow)).toContain('rgba(160, 148, 248')
  if (SHOTS) {
    // On a picture of a desktop, as it would lie over one.
    await page.evaluate((image) => { document.body.style.background = `center / cover url(data:image/jpeg;base64,${image})` }, SCREENS[0])
    await page.screenshot({ path: `${SHOTS}/08-glow-at-the-edge.png` })
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await glow.evaluate((node) => getComputedStyle(node).animationName)).toBe('none')
})

test('Pause in the panel holds the agent while it works, and Stop ends it from there too', async ({ page }) => {
  await boot(page, [SAVE_TASK[0], SAVE_TASK[1], { text: 'I stopped, as you asked.' }], { computer: { actionMs: 1500 }, allowed: true })
  await startAgentChat(page)
  await autonomous(page)
  await send(page, 'Save my note.')
  const panel = page.getByTestId('computer-panel')
  await expect(panel.getByTestId('computer-now')).toContainText('Step 1: Click at 203, 235', { timeout: 30_000 })
  const box = await page.getByTestId('computer-surface').boundingBox()

  // The same hold as the pause shortcut, asked for with a click.
  await panel.getByTestId('computer-pause-button').click()
  const paused = page.getByRole('alertdialog', { name: 'LU has paused' })
  await expect(paused).toBeVisible()
  await expect(paused).toContainText('You asked LU to wait. LU does nothing until you choose.')
  expect((await calls(page)).filter((c) => c.cmd === 'computer_pause')).toHaveLength(1)
  expect(await page.getByTestId('computer-surface').boundingBox()).toEqual(box)
  const before = (await fired(page)).length
  await page.waitForTimeout(1500)
  expect((await fired(page)).length).toBe(before)

  await paused.getByRole('button', { name: 'Let it continue' }).click()
  await expect(paused).toHaveCount(0)
  await expect(panel.getByTestId('computer-stop')).toBeVisible()
  await panel.getByTestId('computer-stop').click()
  await expect(page.getByTestId('computer-surface')).toHaveCount(0)
  await expect(page.getByTestId('computer-note')).toContainText('Computer control stopped.')
  expect(await pageShown(page)).toBe(true)
})
