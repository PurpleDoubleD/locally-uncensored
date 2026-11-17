import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tauriMockInit, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat, appModules, type AppWindow, expectWorkspaceAsk, answerWorkspaceAsk } from './support/ui'

/**
 * The panel does not lock its corner of the display.
 *
 * It takes clicks, so what is under it is out of reach for the model and
 * black in every picture the model gets. When a step aims at a spot under
 * it, that step does not run and the user is not asked about it: the panel
 * slides to another corner, the model gets a new picture in which the old
 * place is free and the new one black, and decides again. The user can send
 * the panel to any corner with the grip at its top edge, and it stays there.
 *
 * With LU_COMPUTER_SHOTS set to a folder, the page before and after is saved
 * there, and so are the two pictures the model was shown. No real window,
 * screen, mouse or keyboard: Rust is the mock, with the rules of surface.rs.
 */

const SHOTS = process.env.LU_COMPUTER_SHOTS
const MODEL = 'gemma-3-12b-it-q4_k_m'
const screen = (name: string) => readFileSync(resolve(process.cwd(), 'e2e/fixtures/computer-task', name)).toString('base64')
const SCREENS = ['01-editor.jpg', '02-save-dialog.jpg', '03-saved.jpg'].map(screen)

const MARGIN = 12
const SIZE = { width: 380, height: 480 }
/** A spot under the panel in the top right corner: where a maximized app has its close button. */
const CLOSE = { x: 985, y: 20 }
/** A spot in the middle of the app, far from every corner. */
const TEXT = { x: 300, y: 300 }

const step = (value: Record<string, unknown>) => ({ text: JSON.stringify(value) })
const CLOSE_TASK: NonNullable<TauriMockOptions['agentTurns']> = [
  { text: 'I will close it.', toolCalls: [{ name: 'computer_task', args: { goal: 'Close the window' } }] },
  step({ thought: 'First the text field.', action: 'click', ...TEXT }),
  step({ thought: 'The close button is in the top right corner.', action: 'click', ...CLOSE }),
  step({ thought: 'Now I can see the close button.', action: 'click', ...CLOSE }),
  step({ thought: 'The window is closed.', action: 'done', summary: 'The window is closed.' }),
  { text: 'The window is closed.' },
]

interface CornerRecord { by: string; from?: string; corner: string; asked?: string | null }
interface LookRecord { frameId: number; corner: string; covered: number[] }
interface PictureRecord { frameId: number; image: string }
type Records = { __E2E_COMPUTER_CORNER__?: CornerRecord[]; __E2E_COMPUTER_LOOKS__?: LookRecord[]; __E2E_COMPUTER_PICTURES__?: PictureRecord[]; __E2E_COMPUTER_FIRED__?: unknown[]; __E2E_COMPUTER_SURFACE__?: { want: { still?: boolean } }[] }
const records = (page: Page) => page.evaluate(() => {
  const w = window as unknown as Records
  return { corners: w.__E2E_COMPUTER_CORNER__ ?? [], looks: w.__E2E_COMPUTER_LOOKS__ ?? [], fired: w.__E2E_COMPUTER_FIRED__ ?? [], surfaces: w.__E2E_COMPUTER_SURFACE__ ?? [] }
})
const pictures = (page: Page) => page.evaluate(() => (window as unknown as Records).__E2E_COMPUTER_PICTURES__ ?? [])

async function boot(page: Page, opts: { actionMs?: number } = {}) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: 'unused', modelName: MODEL, platform: 'windows' as const, replyChunkDelayMs: 8, agentTurns: CLOSE_TASK,
    computer: { screens: SCREENS, panelInTheWay: true, actionMs: opts.actionMs ?? 0 },
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
    window.localStorage.setItem('locally-uncensored-computer', JSON.stringify({ state: { enabled: true, alwaysAllowed: [], executorModel: null }, version: 1 }))
  })
  await page.goto('/')
  await expect(page.getByRole('banner')).toBeVisible()
  await appModules(page, ['/src/stores/settingsStore.ts', '/src/stores/computerStore.ts'])
  await page.evaluate(() => {
    const { useSettingsStore } = (window as unknown as AppWindow).__APP__['/src/stores/settingsStore.ts']
    useSettingsStore.getState().updateSettings({ theme: 'dark' })
  })
  await expect(page.locator('html')).toHaveClass(/dark/)
}

async function startTask(page: Page) {
  await openNewChat(page)
  const agentToggle = page.getByRole('main').getByRole('button', { name: 'Agent', exact: true })
  await agentToggle.click()
  expectWorkspaceAsk(page)
  await expect(agentToggle).toHaveAttribute('title', /Agent Mode is on/i, { timeout: 10_000 })
  const composer = page.locator('textarea').first()
  await expect(composer).toBeEnabled({ timeout: 20_000 })
  await composer.fill('Close the window.')
  await composer.press('Enter')
  await answerWorkspaceAsk(page)
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

async function shot(page: Page, name: string) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

function savePicture(name: string, image: string | undefined) {
  if (!SHOTS || !image) return
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(image, 'base64'))
}

/** Where the panel is on the page, as the corner it is nearest to and its distance from those two edges. */
async function place(page: Page) {
  const box = (await page.getByTestId('computer-surface').boundingBox())!
  const view = page.viewportSize()!
  const right = view.width - (box.x + box.width)
  const bottom = view.height - (box.y + box.height)
  return {
    corner: `${box.y < bottom ? 'top' : 'bottom'}_${box.x < right ? 'left' : 'right'}`,
    gap: [Math.round(Math.min(box.x, right)), Math.round(Math.min(box.y, bottom))],
    size: [Math.round(box.width), Math.round(box.height)],
  }
}
const at = (corner: string) => ({ corner, gap: [MARGIN, MARGIN], size: [SIZE.width, SIZE.height] })

/** Is this spot of a picture the model got black? `x` and `y` are on the 0..1000 grid. */
const isBlack = (page: Page, image: string, x: number, y: number) => page.evaluate(async ({ image, x, y }) => {
  const picture = new Image()
  await new Promise((done, failed) => { picture.onload = done; picture.onerror = failed; picture.src = `data:image/png;base64,${image}` })
  const canvas = document.createElement('canvas')
  canvas.width = picture.naturalWidth
  canvas.height = picture.naturalHeight
  const pen = canvas.getContext('2d')!
  pen.drawImage(picture, 0, 0)
  const [r, g, b] = pen.getImageData(Math.round((x / 1000) * canvas.width), Math.round((y / 1000) * canvas.height), 1, 1).data
  return r + g + b === 0
}, { image, x, y })

test('a step that aims under the panel does not run: the panel moves, and the next picture shows the spot', async ({ page }) => {
  // Each action takes a moment, so the panel can be looked at while the last one runs.
  await boot(page, { actionMs: 2500 })
  await startTask(page)
  const surface = page.getByTestId('computer-surface')
  const panel = page.getByTestId('computer-panel')

  // The panel comes up in the top right corner and asks for the app.
  const app = panel.getByRole('group', { name: 'Allow LU to control Notepad?' })
  await expect(app).toBeVisible({ timeout: 30_000 })
  await expect(surface).toHaveAttribute('data-corner', 'top_right')
  expect(await place(page)).toEqual(at('top_right'))
  await desktopBehind(page)
  await shot(page, '01-before-panel-top-right')
  await app.getByRole('button', { name: 'Allow for this session' }).click()

  // A first step in the middle of the app: the panel is in nobody's way and stays.
  const confirm = panel.getByRole('group', { name: 'Confirm this action' })
  await expect(confirm).toContainText(`Click at ${TEXT.x}, ${TEXT.y} in Notepad`, { timeout: 30_000 })
  expect(await place(page)).toEqual(at('top_right'))
  await confirm.getByRole('button', { name: 'Confirm' }).click()

  // Then the model clicks where the close button is: under the panel. The
  // session is supervised, and still the user is asked only once about that
  // click: about the one chosen from a picture that shows the spot. The
  // panel is in the bottom right corner by then.
  await expect(confirm).toContainText(`Click at ${CLOSE.x}, ${CLOSE.y} in Notepad`, { timeout: 30_000 })
  await expect(surface).toHaveAttribute('data-corner', 'bottom_right')
  await expect.poll(() => place(page)).toEqual(at('bottom_right'))
  const log = await records(page)
  expect(log.corners).toEqual([{ by: 'action', from: 'top_right', corner: 'bottom_right', action: { type: 'click', ...CLOSE } }])
  expect(log.fired).toEqual([{ action: { type: 'click', ...TEXT } }])
  // The step that did not run is not counted and not shown as failed: this is the second step, not the third.
  await expect(panel.getByTestId('computer-task-step')).toContainText(`Step 2 of at most 25: Click at ${CLOSE.x}, ${CLOSE.y}`)
  await expect(panel.getByTestId('computer-task-step')).not.toContainText('did not work')
  // Pause and Stop moved with the panel and are on the page.
  await expect(panel.getByTestId('computer-pause-button')).toBeInViewport({ ratio: 1 })
  await expect(panel.getByTestId('computer-stop')).toBeInViewport({ ratio: 1 })
  await shot(page, '02-after-panel-bottom-right')

  // What the model saw. Before: the top right corner black, the bottom right
  // one shown. After: the other way round, in the very picture it chose its
  // second click from.
  const first = log.looks.filter((look) => look.corner === 'top_right').at(-1)!
  const second = log.looks.find((look) => look.corner === 'bottom_right')!
  expect(first.covered).toEqual([796, 11, 994, 456])
  expect(second.covered).toEqual([796, 544, 994, 989])
  expect(second.frameId).toBeGreaterThan(first.frameId)
  const seen = await pictures(page)
  const before = seen.find((p) => p.frameId === first.frameId)!.image
  const after = seen.find((p) => p.frameId === second.frameId)!.image
  expect(await isBlack(page, before, CLOSE.x, CLOSE.y)).toBe(true)
  expect(await isBlack(page, before, 900, 800)).toBe(false)
  expect(await isBlack(page, after, CLOSE.x, CLOSE.y)).toBe(false)
  expect(await isBlack(page, after, 900, 800)).toBe(true)
  savePicture('03-model-saw-before', before)
  savePicture('04-model-saw-after', after)

  // The click the user confirms is the one that runs, once.
  await confirm.getByRole('button', { name: 'Confirm' }).click()
  await expect.poll(async () => (await records(page)).fired).toEqual([{ action: { type: 'click', ...TEXT } }, { action: { type: 'click', ...CLOSE } }])
  // It stays where it went: nothing needs the bottom right corner.
  expect(await place(page)).toEqual(at('bottom_right'))
  expect((await records(page)).corners).toHaveLength(1)
  await expect(page.getByRole('main')).toContainText('The window is closed.', { timeout: 30_000 })
})

test('the grip sends the panel to any corner, and it stays there', async ({ page }) => {
  await boot(page)
  await startTask(page)
  const surface = page.getByTestId('computer-surface')
  const panel = page.getByTestId('computer-panel')
  await expect(panel.getByRole('group', { name: 'Allow LU to control Notepad?' })).toBeVisible({ timeout: 30_000 })
  await desktopBehind(page)
  const grip = panel.getByTestId('computer-grip')
  await expect(grip).toHaveAttribute('title', /press for the next corner, or drag toward a corner/)

  // The grip is a short bar at the top edge, in the middle: clear of Pause and Stop.
  const box = (await surface.boundingBox())!
  const bar = (await grip.boundingBox())!
  const pause = (await panel.getByTestId('computer-pause-button').boundingBox())!
  expect(Math.round(bar.y)).toBe(Math.round(box.y) + 1)
  expect(Math.abs(bar.x + bar.width / 2 - (box.x + box.width / 2))).toBeLessThan(2)
  expect(bar.x + bar.width).toBeLessThan(pause.x)
  expect(bar.height).toBeLessThan(pause.y - box.y + pause.height / 2)

  // A press: once around the display.
  for (const corner of ['bottom_right', 'bottom_left', 'top_left', 'top_right']) {
    await grip.click()
    await expect(surface).toHaveAttribute('data-corner', corner)
    await expect.poll(() => place(page)).toEqual(at(corner))
    await expect(panel.getByTestId('computer-pause-button')).toBeInViewport({ ratio: 1 })
    await expect(panel.getByTestId('computer-stop')).toBeInViewport({ ratio: 1 })
  }

  // A drag toward the bottom left: straight to that corner, in one request.
  const from = (await grip.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x - 400, from.y + 300, { steps: 6 })
  // The panel waits for the grip to be let go.
  expect(await place(page)).toEqual(at('top_right'))
  await page.mouse.up()
  await expect(surface).toHaveAttribute('data-corner', 'bottom_left')
  await expect.poll(() => place(page)).toEqual(at('bottom_left'))
  await shot(page, '05-grip-panel-bottom-left')
  const corners = (await records(page)).corners
  expect(corners.map((c) => c.by)).toEqual(['grip', 'grip', 'grip', 'grip', 'grip'])
  expect(corners.at(-1)).toMatchObject({ asked: 'bottom_left', corner: 'bottom_left' })
  expect(corners.slice(0, 4).every((c) => c.asked === null)).toBe(true)

  // The interface says again every few seconds what it wants. The corner is not its to change back.
  const asked = (await records(page)).surfaces.length
  await expect.poll(async () => (await records(page)).surfaces.length, { timeout: 10_000 }).toBeGreaterThan(asked)
  await expect(surface).toHaveAttribute('data-corner', 'bottom_left')
  expect(await place(page)).toEqual(at('bottom_left'))

  // The question is still there and still answered where the panel is now.
  await panel.getByRole('button', { name: 'Allow for this session' }).click()
  const confirm = panel.getByRole('group', { name: 'Confirm this action' })
  await expect(confirm).toContainText(`Click at ${TEXT.x}, ${TEXT.y} in Notepad`, { timeout: 30_000 })
  await confirm.getByRole('button', { name: 'Confirm' }).click()
  // The model aims at the top right corner, which is free now: nothing moves.
  await expect(confirm).toContainText(`Click at ${CLOSE.x}, ${CLOSE.y} in Notepad`, { timeout: 30_000 })
  expect((await records(page)).corners).toHaveLength(5)
  expect(await place(page)).toEqual(at('bottom_left'))
})

test('with less motion asked for, the panel changes corners in one step', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await boot(page)
  await startTask(page)
  const surface = page.getByTestId('computer-surface')
  await expect(page.getByTestId('computer-panel').getByRole('group', { name: 'Allow LU to control Notepad?' })).toBeVisible({ timeout: 30_000 })
  expect(await surface.evaluate((node) => getComputedStyle(node).transitionProperty)).toBe('none')
  // Rust is told too: there the window itself is what would slide.
  expect((await records(page)).surfaces.at(-1)!.want.still).toBe(true)
  await page.getByTestId('computer-grip').click()
  expect(await place(page)).toEqual(at('bottom_right'))
})

test('without that wish the panel slides, and Rust is told so', async ({ page }) => {
  await boot(page)
  await startTask(page)
  const surface = page.getByTestId('computer-surface')
  await expect(page.getByTestId('computer-panel').getByRole('group', { name: 'Allow LU to control Notepad?' })).toBeVisible({ timeout: 30_000 })
  expect(await surface.evaluate((node) => getComputedStyle(node).transitionProperty)).toBe('left, top')
  expect(await surface.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe('0.24s, 0.24s')
  expect((await records(page)).surfaces.at(-1)!.want.still).toBe(false)
})
