import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'
import { mlxCalls, comfyCalls, requireCall } from './support/recorded'
import { openCharacterAction, openCharacterWhat } from './support/character-hub'

/**
 * Motion Control on a Mac (3.0.8). The tab runs on an LTX-2.3 pack of the
 * second video engine with the IC-LoRA Union Control (commands/video_motion.rs):
 * the character image is the start image, and the motion video goes along.
 *
 * Covered: the tab is local while such a pack is installed, the Stage offers
 * the LoRA as a one-time download until it is there, a run stages both
 * inputs and hands them to `video_generate`, and ComfyUI is never asked.
 */

const MAC_OPTS: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'mac',
}

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
// The first bytes of an MP4: a box size, then `ftyp`. The mock stages bytes
// without reading them.
const TINY_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(32)])

async function bootLocalCreate(page: Page, opts: TauriMockOptions) {
  await page.addInitScript(tauriMockInit, opts)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
}

test('mac motion: the tab offers its LoRA once, then the lane is ready', async ({ page }) => {
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { ltx2EngineInstalled: true, installedVideos: ['ltx-2.3-q4'] } })
  // A plain tab, not the cloud teaser.
  await openCharacterAction(page, 'Motion Control')
  await expect(page.getByText('Local motion control needs a one-time download')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/about 650 MB/)).toBeVisible()
  await page.getByRole('button', { name: /Download & install/i }).click()
  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'video_install_model').length, { timeout: 20_000 })
    .toBeGreaterThan(0)
  expect(requireCall(await mlxCalls(page), 'video_install_model').raw.id).toBe('ltx-2.3-motion-control')
  // With the LoRA in, the card goes and the lane's inputs are there.
  await expect(page.getByText('Local motion control needs a one-time download')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByText('Add driving video (dance/pose)')).toBeVisible()
  expect(await comfyCalls(page)).toHaveLength(0)
})

test('mac motion: a run stages the image and the motion video and starts the LTX pack with both', async ({ page }) => {
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { ltx2EngineInstalled: true, installedVideos: ['ltx-2.3-q4', 'ltx-2.3-motion-control'] } })
  await openCharacterAction(page, 'Motion Control')
  await expect(page.getByText('Add driving video (dance/pose)')).toBeVisible({ timeout: 15_000 })
  // The length follows the pack: 49 frames at 24 a second. It stands in the
  // settings of the prompt window, as every further value of the tab.
  await page.locator('[data-prompt-window] button[title="Advanced settings"]').click()
  await expect(page.locator('[data-hub-settings]').getByTestId('mac-video-length')).toContainText('49 frames')
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-hub-settings]')).toHaveCount(0)

  await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles({ name: 'fox.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
  await page.locator('input[type="file"][accept^="video/"]').first().setInputFiles({ name: 'walk.mp4', mimeType: 'video/mp4', buffer: TINY_MP4 })
  await expect(page.getByText('walk.mp4')).toBeVisible()
  await page.getByRole('button', { name: /^Create$/ }).last().click()

  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'video_generate').length, { timeout: 40_000 })
    .toBeGreaterThan(0)
  const calls = await mlxCalls(page)
  expect(Number(requireCall(calls, 'video_stage_motion_video').raw.bytes)).toBeGreaterThan(0)
  const gen = requireCall(calls, 'video_generate')
  expect(gen.id).toBe('ltx-2.3-q4')
  expect(gen.raw.motion_video).toBe('/tmp/lu-e2e/videos/motion-videos/e2e-motion.mp4')
  expect(gen.raw.init_image).toBeTruthy()
  // The lane has no prompt field, and the run says what LTX needs to hear.
  expect(gen.prompt).toContain('moves smoothly and naturally')
  expect(await comfyCalls(page)).toHaveLength(0)
})

test('mac motion: without an LTX-2.3 pack the tab stays the cloud teaser', async ({ page }) => {
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { ltx2EngineInstalled: true, installedVideos: ['ltx-2.5-q4'] } })
  await openCharacterWhat(page)
  await expect(page.getByRole('radio', { name: 'Motion Control, runs on LU Cloud' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('radio', { name: 'Motion Control', exact: true })).toHaveCount(0)
})
