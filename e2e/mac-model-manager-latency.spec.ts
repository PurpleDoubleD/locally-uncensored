import { test, expect, type Page, type Locator } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'
import { mlxCalls } from './support/recorded'

/**
 * The Mac media lanes answer a click before the backend does.
 *
 * Owner's finding on the real Mac build (M5 Pro, 08.10.2026): the Model
 * Manager took five to six seconds to open, a Get took as long before it
 * started, a Stop longer still, and the download tray had no Stop at all.
 * The backend was that slow (it imported MLX for a status), and the interface
 * showed nothing until the backend had answered.
 *
 * Both halves are fixed. This file holds the second one: the mock's backend
 * is made busy (`__E2E_MLX_DELAY_MS__`, every MLX command is taken up seconds
 * late), and each click still has to show within 200 ms, measured in the
 * page from the click to the frame that carries the new state. What the
 * backend says afterwards still decides, so the refusals are here too.
 */

const MAC: TauriMockOptions = { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'mac' }
/** How late the busy backend takes a command up. Far above the budget. */
const BUSY_MS = 3000
/** The budget of the task: a click is visible in under 200 ms. */
const BUDGET_MS = 200

async function openModels(page: Page, opts: TauriMockOptions) {
  await page.addInitScript(tauriMockInit, opts)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('banner').getByRole('button', { name: 'Models', exact: true }).click()
}

const rail = (page: Page, name: 'Chat' | 'Image' | 'Video') =>
  page.locator('aside:has(+ [data-testid="models-pane"])').getByRole('button', { name: new RegExp(`^${name}`) })
const tile = (page: Page, id: string) => page.locator(`[data-mac-media-tile="${id}"]`)
const busy = (page: Page, ms: number) => page.evaluate((v) => { (window as unknown as { __E2E_MLX_DELAY_MS__: number }).__E2E_MLX_DELAY_MS__ = v }, ms)
const refuse = (page: Page, cmd: string, sentence: string) =>
  page.evaluate(([c, s]) => { (window as unknown as { __E2E_MLX_REFUSE__: Record<string, string> }).__E2E_MLX_REFUSE__ = { [c]: s } }, [cmd, sentence])
const sent = async (page: Page, cmd: string) => (await mlxCalls(page)).filter((c) => c.cmd === cmd).length

/**
 * Click `click` and measure, inside the page, how long it takes until `shown`
 * matches (or, with `gone`, no longer matches). Frame by frame, so the number
 * is what a person sees and not what a test runner polls.
 */
async function reaction(click: Locator, shown: string, gone = false): Promise<number> {
  await expect(click).toBeVisible()
  return click.evaluate(async (target, [shownSel, wantGone]) => {
    const there = () => !!document.querySelector(shownSel as string)
    if (there() !== !!wantGone) throw new Error(`${shownSel} is already ${wantGone ? 'gone' : 'there'} before the click`)
    const clicked = performance.now()
    ;(target as HTMLElement).click()
    for (;;) {
      if (there() === !wantGone) return performance.now() - clicked
      if (performance.now() - clicked > 10_000) return -1
      await new Promise((frame) => requestAnimationFrame(frame))
    }
  }, [shown, gone] as const).then((ms) => {
    // The number itself, for the proof table (proof/mac/LATENZ-MODEL-MANAGER.md).
    console.log(`[latency] ${test.info().title.split(':')[0]} | ${shown}${gone ? ' gone' : ''} | ${ms.toFixed(1)} ms`)
    // Never there within ten seconds is not "under 200 ms".
    if (ms < 0) throw new Error(`the click was never answered: ${shown} did not ${gone ? 'go' : 'appear'}`)
    return ms
  })
}

const get = (page: Page, id: string) => tile(page, id).getByRole('button', { name: /^Get/ })
const stopOn = (page: Page, id: string) => tile(page, id).getByRole('button', { name: /^Stop installing/ })
const removeNow = (page: Page) => page.getByRole('dialog', { name: 'Remove model' }).getByRole('button', { name: 'Remove', exact: true })

test('Get: the tile is installing with the click, seconds before the busy backend takes the command up', async ({ page }) => {
  await openModels(page, { ...MAC, mlx: { engineInstalled: true, installedImages: [], installPolls: 40 } })
  await rail(page, 'Image').click()
  const pick = tile(page, 'flux2-klein-4b')
  await expect(pick).toHaveAttribute('data-state', 'idle')
  await busy(page, BUSY_MS)

  const ms = await reaction(get(page, 'flux2-klein-4b'), '[data-mac-media-tile="flux2-klein-4b"][data-state="installing"]')
  expect(ms, `the tile took ${ms} ms to react`).toBeGreaterThanOrEqual(0)
  expect(ms).toBeLessThan(BUDGET_MS)
  // The backend has not even been asked to install yet: this was the click.
  expect(await sent(page, 'mlx_image_install_model')).toBe(0)
  // It offers Stop, and the other tiles of the lane wait.
  await expect(pick.getByRole('button', { name: 'Stop installing FLUX.2 klein 4B' })).toBeVisible()
  await expect(tile(page, 'sd-turbo').getByRole('button', { name: /^Get/ })).toBeDisabled()
  // And the download tray lists it already.
  await expect(page.locator('[data-mlx-install="image-model"]')).toContainText('FLUX.2 klein 4B')

  // The backend catches up, and the same tile is the real install.
  await expect.poll(() => sent(page, 'mlx_image_install_model'), { timeout: 20_000 }).toBe(1)
  await expect(pick).toHaveAttribute('data-state', 'installing')
})

test('Get without the engine: "Engine first" and the setup card are there with the click', async ({ page }) => {
  await openModels(page, { ...MAC, mlx: { engineInstalled: false, installedImages: [], installedVideos: [], installPolls: 40 } })
  await rail(page, 'Image').click()
  const lane = page.getByTestId('mac-media-image')
  await expect(lane.locator('[data-engine-state="missing"]')).toBeVisible()
  await busy(page, BUSY_MS)

  const ms = await reaction(get(page, 'flux2-klein-4b'), '[data-mac-media-tile="flux2-klein-4b"][data-state="queued"]')
  expect(ms).toBeGreaterThanOrEqual(0)
  expect(ms).toBeLessThan(BUDGET_MS)
  await expect(tile(page, 'flux2-klein-4b')).toContainText('Engine first…')
  await expect(lane.locator('[data-engine-state="installing"]')).toBeVisible()
  expect(await sent(page, 'install_mlx_diffusion')).toBe(0)
  await expect.poll(() => sent(page, 'install_mlx_diffusion'), { timeout: 20_000 }).toBe(1)
  expect(await sent(page, 'mlx_image_install_model')).toBe(0)
})

test('Stop: the tile offers Get again with the click, and stays that way while the busy backend stops the download', async ({ page }) => {
  await openModels(page, { ...MAC, mlx: { engineInstalled: true, installedImages: [], installPolls: 400 } })
  await rail(page, 'Image').click()
  const pick = tile(page, 'flux2-klein-4b')
  await pick.getByRole('button', { name: /^Get/ }).click()
  await expect.poll(() => sent(page, 'mlx_image_install_model')).toBe(1)
  await expect(pick).toHaveAttribute('data-state', 'installing')
  await busy(page, BUSY_MS)

  const ms = await reaction(stopOn(page, 'flux2-klein-4b'), '[data-mac-media-tile="flux2-klein-4b"][data-state="idle"]')
  expect(ms).toBeGreaterThanOrEqual(0)
  expect(ms).toBeLessThan(BUDGET_MS)
  expect(await sent(page, 'mlx_image_cancel_install')).toBe(0)
  await expect(pick.getByRole('button', { name: /^Get/ })).toBeEnabled()
  await expect(page.locator('[data-mlx-install="image-model"]')).toHaveCount(0)

  // Nothing comes back while the backend works through it, and a stopped
  // download is not an error.
  await expect.poll(() => sent(page, 'mlx_image_cancel_install'), { timeout: 20_000 }).toBe(1)
  await page.waitForTimeout(BUSY_MS + 1500)
  await expect(pick).toHaveAttribute('data-state', 'idle')
  await expect(page.getByTestId('mac-media-image').getByRole('alert')).toHaveCount(0)
  expect(await sent(page, 'mlx_image_cancel_install')).toBe(1)
})

test('a Get the backend refuses: the tile is back, and the lane says why', async ({ page }) => {
  const sentence = 'Not enough free disk space for FLUX.2 klein 4B: it needs 8 GB and 3 GB are free.'
  await openModels(page, { ...MAC, mlx: { engineInstalled: true, installedImages: [] } })
  await rail(page, 'Image').click()
  const pick = tile(page, 'flux2-klein-4b')
  await expect(pick).toHaveAttribute('data-state', 'idle')
  await refuse(page, 'mlx_image_install_model', sentence)
  await busy(page, 1200)

  const ms = await reaction(get(page, 'flux2-klein-4b'), '[data-mac-media-tile="flux2-klein-4b"][data-state="installing"]')
  expect(ms).toBeLessThan(BUDGET_MS)
  // The answer arrives, and the guess does not outlive it.
  await expect(page.getByTestId('mac-media-image').getByRole('alert')).toContainText(sentence, { timeout: 20_000 })
  await expect(pick).toHaveAttribute('data-state', 'idle')
  await expect(pick.getByRole('button', { name: /^Get/ })).toBeEnabled()
  await expect(page.locator('[data-mlx-install="image-model"]')).toHaveCount(0)
})

test('Remove: the question closes and the tile is gone with the click, and a refusal brings it back', async ({ page }) => {
  await openModels(page, { ...MAC, mlx: { engineInstalled: true, installedImages: ['sd-turbo'] } })
  await rail(page, 'Image').click()
  await page.getByRole('button', { name: /^Installed/ }).click()
  await expect(tile(page, 'sd-turbo')).toBeVisible()

  // Refused first: an install is running, says the backend.
  const sentence = 'An install is running. Wait for it to finish first.'
  await refuse(page, 'mlx_image_delete_model', sentence)
  await busy(page, 1200)
  await tile(page, 'sd-turbo').getByRole('button', { name: 'Remove SD Turbo' }).click()
  await expect(page.getByRole('dialog', { name: 'Remove model' })).toBeVisible()
  let ms = await reaction(removeNow(page), '[data-mac-media-tile="sd-turbo"]', true)
  expect(ms).toBeGreaterThanOrEqual(0)
  expect(ms).toBeLessThan(BUDGET_MS)
  await expect(page.getByRole('dialog', { name: 'Remove model' })).toBeHidden()
  await expect(page.getByTestId('mac-media-image').getByRole('alert')).toContainText(sentence, { timeout: 20_000 })
  await expect(tile(page, 'sd-turbo')).toHaveAttribute('data-state', 'installed')

  // And for real, on a backend that takes its time.
  await page.evaluate(() => { (window as unknown as { __E2E_MLX_REFUSE__: Record<string, string> }).__E2E_MLX_REFUSE__ = {} })
  await busy(page, BUSY_MS)
  await tile(page, 'sd-turbo').getByRole('button', { name: 'Remove SD Turbo' }).click()
  ms = await reaction(removeNow(page), '[data-mac-media-tile="sd-turbo"]', true)
  expect(ms).toBeLessThan(BUDGET_MS)
  expect(await sent(page, 'mlx_image_delete_model')).toBe(0)
  await expect(page.getByText('No image models installed yet')).toBeVisible()
  await expect.poll(() => sent(page, 'mlx_image_delete_model'), { timeout: 20_000 }).toBe(1)
  await page.waitForTimeout(BUSY_MS + 500)
  await expect(page.getByText('No image models installed yet')).toBeVisible()
  await expect(page.getByTestId('mac-media-image').getByRole('alert')).toHaveCount(0)
})

test('opened again, the Model Manager draws its tiles at once, whatever the backend is doing', async ({ page }) => {
  await openModels(page, { ...MAC, mlx: { engineInstalled: true, installedImages: ['sd-turbo'] } })
  await rail(page, 'Image').click()
  await expect(tile(page, 'sd-turbo')).toBeVisible()
  await page.getByRole('banner').getByRole('button', { name: 'Chat', exact: true }).click()
  await expect(page.getByTestId('mac-media-image')).toHaveCount(0)
  await busy(page, BUSY_MS)

  // From the click to the tiles, and how much of that the page itself took
  // to come in: the views of the app change with a short transition, which is
  // not a wait for anything. What is held to the budget is the time from the
  // page being there to its tiles being there. Before, that was a skeleton
  // until four commands had answered.
  const times = await page.getByRole('banner').getByRole('button', { name: 'Models', exact: true }).evaluate(async (target) => {
    const clicked = performance.now()
    ;(target as HTMLElement).click()
    let pane = -1
    for (;;) {
      const now = performance.now() - clicked
      if (pane < 0 && document.querySelector('[data-testid="models-pane"]')) pane = now
      if (document.querySelector('[data-mac-media-tile="sd-turbo"]')) return { pane, tiles: now }
      if (now > 10_000) return { pane, tiles: -1 }
      await new Promise((frame) => requestAnimationFrame(frame))
    }
  })
  console.log(`[latency] opened again | page there after ${times.pane.toFixed(1)} ms, tiles after ${times.tiles.toFixed(1)} ms`)
  expect(times.tiles, JSON.stringify(times)).toBeGreaterThanOrEqual(0)
  expect(times.tiles - times.pane, JSON.stringify(times)).toBeLessThan(BUDGET_MS)
  // And the whole way stays far below what the backend would have cost.
  expect(times.tiles).toBeLessThan(BUSY_MS / 3)
  await expect(page.locator('[data-mac-media-tile]').first()).toBeVisible()
  // Image and Video are one read: the switch is a render, not a request.
  const video = await reaction(rail(page, 'Video'), '[data-testid="mac-media-video"] [data-mac-media-tile]')
  expect(video).toBeGreaterThanOrEqual(0)
  expect(video).toBeLessThan(BUDGET_MS)
})

// ── The download tray (top right) ─────────────────────────────────────

const tray = (page: Page) => page.getByRole('banner').getByTitle('Downloads')
const trayRow = (page: Page, kind: string) => page.locator(`[data-mlx-install="${kind}"]`)
/** The count on the tray's icon. It is what the budget is held to: the tray
 *  closes itself when its last download is stopped, and the row leaves the
 *  page when that 120 ms fade is over, which is a transition and not a wait. */
const NOTHING_RUNNING = '[data-downloads-active="0"]'

/** Fully opaque all the way up: a row of a tray that is fading in or out is not. */
const settled = (row: Locator) =>
  row.evaluate((el) => {
    for (let n: Element | null = el; n; n = n.parentElement) if (parseFloat(getComputedStyle(n).opacity) < 1) return false
    return true
  }).catch(() => false)

async function openTray(page: Page, kind: string) {
  // The tray opens itself when a download starts, and a click on an open tray
  // closes it. Looked at once, a tray still opening read as closed and the
  // click shut it (red on the Linux runner, 3.0.8 release run), so look again
  // after every click until the row is there.
  //
  // And a tray on its way out still reads as open: a click outside it (the
  // tests leave the Model Manager through the header) closes it with a fade
  // (framer-motion `exit`, 120 ms), and for that long its rows are in the
  // page and visible. On the CI runner the look landed in the fade: no click,
  // the row "was there", then the panel left, and the Stop under test was gone
  // (no Stop for 15 s) or was clicked after it had left the page (never
  // answered). Locally the fade was always over before the look. So a row only
  // counts when its panel is fully opaque, not in a fade either way; a fading
  // row is waited out and the tray opened again. (Reproduced with the fade
  // slowed down through CDP `Animation.setPlaybackRate`: red every time
  // before, green after.)
  await expect(async () => {
    const row = trayRow(page, kind)
    if (!(await row.isVisible().catch(() => false))) await tray(page).click()
    await expect.poll(() => settled(row), { timeout: 1000 }).toBe(true)
  }).toPass({ timeout: 15_000 })
}

test('the download tray has a Stop for a running model download: the row is gone with the click, without an error', async ({ page }) => {
  await openModels(page, { ...MAC, mlx: { engineInstalled: true, installedImages: [], installPolls: 400 } })
  await rail(page, 'Image').click()
  const pick = tile(page, 'flux2-klein-4b')
  await pick.getByRole('button', { name: /^Get/ }).click()
  await expect.poll(() => sent(page, 'mlx_image_install_model')).toBe(1)
  await openTray(page, 'image-model')
  const stop = trayRow(page, 'image-model').getByRole('button', { name: 'Stop installing FLUX.2 klein 4B' })
  await expect(stop).toBeVisible()
  await expect(stop).toHaveAttribute('title', 'Stop')
  await busy(page, BUSY_MS)

  const ms = await reaction(page.locator('[data-mlx-stop="image-model"]'), NOTHING_RUNNING)
  expect(ms).toBeLessThan(BUDGET_MS)
  await expect(trayRow(page, 'image-model')).toHaveCount(0, { timeout: 1000 })
  // The tile heard it in the same moment, although the click was not on it.
  await expect(pick).toHaveAttribute('data-state', 'idle', { timeout: 500 })
  expect(await sent(page, 'mlx_image_cancel_install')).toBe(0)

  // The same Stop as the tile's, once, and no error anywhere afterwards.
  await expect.poll(() => sent(page, 'mlx_image_cancel_install'), { timeout: 20_000 }).toBe(1)
  await page.waitForTimeout(BUSY_MS + 1500)
  await expect(trayRow(page, 'image-model')).toHaveCount(0)
  await expect(page.getByTestId('mac-media-image').getByRole('alert')).toHaveCount(0)
  await expect(page.getByText('The install did not finish.')).toHaveCount(0)
  await expect(pick).toHaveAttribute('data-state', 'idle')
  await expect(pick.getByRole('button', { name: /^Get/ })).toBeEnabled()
  expect(await sent(page, 'mlx_image_cancel_install')).toBe(1)
  expect(await sent(page, 'video_cancel_model_install')).toBe(0)
})

test('the tray stops an engine setup too, and the tile that waited for it is free at once', async ({ page }) => {
  await openModels(page, { ...MAC, mlx: { engineInstalled: false, installedImages: [], installedVideos: [], installPolls: 400 } })
  await rail(page, 'Image').click()
  const lane = page.getByTestId('mac-media-image')
  const pick = tile(page, 'flux2-klein-4b')
  await pick.getByRole('button', { name: /^Get/ }).click()
  await expect.poll(() => sent(page, 'install_mlx_diffusion')).toBe(1)
  await expect(pick).toHaveAttribute('data-state', 'queued')
  await openTray(page, 'image-engine')
  await expect(trayRow(page, 'image-engine').getByRole('button', { name: 'Stop installing MLX image engine' })).toBeVisible()

  const ms = await reaction(page.locator('[data-mlx-stop="image-engine"]'), NOTHING_RUNNING)
  expect(ms).toBeLessThan(BUDGET_MS)
  await expect(trayRow(page, 'image-engine')).toHaveCount(0, { timeout: 1000 })
  await expect(pick).toHaveAttribute('data-state', 'idle', { timeout: 500 })
  await expect(lane.locator('[data-engine-state="missing"]')).toBeVisible()
  await expect.poll(() => sent(page, 'mlx_image_cancel_install')).toBe(1)
  await page.waitForTimeout(2500)
  // The run ended with the Stop: the model was never asked for.
  expect(await sent(page, 'mlx_image_install_model')).toBe(0)
  await expect(lane.getByRole('alert')).toHaveCount(0)
  await expect(pick.getByRole('button', { name: /^Get/ })).toBeEnabled()
})

test('the tray stops a video download from any page, with the video lane\'s own Stop', async ({ page }) => {
  await openModels(page, { ...MAC, mlx: { engineInstalled: true, videoEngineInstalled: true, installedVideos: [], installPolls: 400 } })
  await rail(page, 'Video').click()
  const pick = tile(page, 'wan21-t2v-1.3b')
  await pick.getByRole('button', { name: /^Get/ }).click()
  await expect.poll(() => sent(page, 'video_install_model')).toBe(1)
  // Leave the Model Manager: the tray is all that is left to stop it from.
  await page.getByRole('banner').getByRole('button', { name: 'Chat', exact: true }).click()
  await expect(page.getByTestId('mac-media-video')).toHaveCount(0)
  await openTray(page, 'video-model')

  const ms = await reaction(page.locator('[data-mlx-stop="video-model"]'), NOTHING_RUNNING)
  expect(ms).toBeLessThan(BUDGET_MS)
  await expect(trayRow(page, 'video-model')).toHaveCount(0, { timeout: 1000 })
  await expect.poll(() => sent(page, 'video_cancel_model_install')).toBe(1)
  expect(await sent(page, 'mlx_image_cancel_install')).toBe(0)
  await page.waitForTimeout(2000)
  await expect(trayRow(page, 'video-model')).toHaveCount(0)
  await expect(page.getByText('The install did not finish.')).toHaveCount(0)

  // Back in the Model Manager the tile offers Get, with nothing to explain.
  await page.getByRole('banner').getByRole('button', { name: 'Models', exact: true }).click()
  await rail(page, 'Video').click()
  await expect(pick).toHaveAttribute('data-state', 'idle')
  await expect(page.getByTestId('mac-media-video').getByRole('alert')).toHaveCount(0)
})

test('a finished install keeps its Dismiss in the tray, and a PC has no MLX row to stop', async ({ page }) => {
  await openModels(page, { ...MAC, mlx: { engineInstalled: true, installedImages: [] } })
  await rail(page, 'Image').click()
  const pick = tile(page, 'sd-turbo')
  await pick.getByRole('button', { name: /^Get/ }).click()
  await expect(pick).toHaveAttribute('data-state', 'installed', { timeout: 30_000 })
  await openTray(page, 'image-model')
  await expect(trayRow(page, 'image-model')).toContainText('Complete')
  await expect(page.locator('[data-mlx-stop]')).toHaveCount(0)
  await trayRow(page, 'image-model').getByTitle('Dismiss').click()
  await expect(trayRow(page, 'image-model')).toHaveCount(0)
})

test('COUNTER-CHECK: on a PC the tray lists no MLX install and offers no MLX Stop', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await tray(page).click()
  await expect(page.getByText('No active downloads')).toBeVisible()
  await expect(page.locator('[data-mlx-install], [data-mlx-stop]')).toHaveCount(0)
  expect((await mlxCalls(page)).filter((c) => /install_status|cancel/.test(c.cmd))).toEqual([])
})
