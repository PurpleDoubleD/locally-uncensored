import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'
import { mlxCalls } from './support/recorded'
import { gradientPng } from './support/png'

/**
 * C75 on a Mac (Qwen-Image 2.1 on the second engine): "Custom size" cuts the
 * picture to the shape of the size fields before it is staged, centred and at
 * its own pixels, because the engine's edit follows its first image. The
 * default stays: the picture goes in as it is.
 *
 * LU_SHOTS=<folder> writes the screenshot there.
 */

const QWEN_MAC: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'mac',
  mlx: { installedImages: ['sd-turbo', 'qwen-image-2.1-8bit'], mfluxEngineInstalled: true },
}

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, QWEN_MAC)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: 'Edit / Image to Image', exact: true }).click()
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: gradientPng(768, 512) })
  await expect(page.getByRole('img', { name: 'source' })).toBeVisible({ timeout: 15_000 })
}

/** Width and height of the first picture staged for the engine. */
const stagedSize = (page: Page, b64: string) => page.evaluate(async (data) => {
  const img = new Image()
  img.src = `data:image/png;base64,${data}`
  await img.decode()
  return [img.naturalWidth, img.naturalHeight]
}, b64)

async function editOnce(page: Page) {
  await page.locator('textarea').first().fill('make it a night scene')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'mlx_generate').length, { timeout: 30_000 }).toBe(1)
  return mlxCalls(page)
}

test('C75 Mac: "Custom size" in 9:16 hands the engine the whole 3:2 picture and a 9:16 canvas', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: 'Advanced settings' }).click()
  const drawer = page.locator('aside').filter({ hasText: 'Advanced settings' })
  const shape = drawer.getByTestId('qwen-edit-shape')
  await expect(shape).toBeVisible({ timeout: 15_000 })
  await shape.getByRole('radio', { name: 'Custom size' }).click()
  await drawer.getByRole('button', { name: '9:16', exact: true }).click()
  await expect(shape).toContainText('nothing of it is cut off')
  await shape.scrollIntoViewIfNeeded()
  if (process.env.LU_SHOTS) {
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${process.env.LU_SHOTS}/c75-mac-edit-seitenverhaeltnis.png` })
  }
  await page.keyboard.press('Escape')

  const calls = await editOnce(page)
  // Since a8ccb0c62 nothing is cut: only the upload is staged, as it is.
  const staged = calls.filter((c) => c.cmd === 'video_stage_start_image')
  expect(staged).toHaveLength(1)
  expect(await stagedSize(page, String(staged[0].raw.data))).toEqual([768, 512])
  const gen = calls.find((c) => c.cmd === 'mlx_generate')!
  expect(gen.raw.images).toEqual(['/tmp/lu-e2e/videos/start-images/e2e-start.png'])
  expect(Math.abs(Number(gen.raw.width) / Number(gen.raw.height) - 9 / 16)).toBeLessThan(0.03)
})

test('COUNTER-CHECK C75 Mac: by default the picture goes in as it is', async ({ page }) => {
  await boot(page)
  const calls = await editOnce(page)
  // Only the upload: the edit reads the staged picture as it is.
  const staged = calls.filter((c) => c.cmd === 'video_stage_start_image')
  expect(staged).toHaveLength(1)
  expect(await stagedSize(page, String(staged[0].raw.data))).toEqual([768, 512])
})
