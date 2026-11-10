import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { bootWithFakeComfy } from './support/fake-comfy'

/**
 * 3.1.0 P-C, Create:
 *  - C50 (Discord 06.11.): the Start ComfyUI card carries "Start ComfyUI
 *    when LU starts", which before sat folded away in Settings.
 *  - Discord 08.11.: local Enhance had 2x and 4x only. It now has a size menu
 *    (factors, long sides, typed values) and a model menu.
 * LU_SHOTS=<folder> writes the screens.
 */
const SHOTS = process.env.LU_SHOTS
// A short wait first: the menus fade in and out.
const shot = async (page: Page, name: string) => { if (SHOTS) { await page.waitForTimeout(500); await page.screenshot({ path: `${SHOTS}/${name}.png` }) } }

async function toCreate(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
}

test('C50: the Start ComfyUI card has the autostart switch, and it saves', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(() => {
    const w = window as unknown as { __AUTOSTART__: unknown[]; __TAURI_INTERNALS__: { invoke: (c: string, a: { files?: Array<{ filename: string }> } & Record<string, unknown>) => Promise<unknown> } }
    w.__AUTOSTART__ = []
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    let autostart = false
    bridge.invoke = (command, args) => {
      if (command === 'comfyui_status') return Promise.resolve({ running: false, starting: false, isLocal: true, found: true, autostart })
      if (command === 'set_comfyui_autostart') { autostart = !!args.enabled; w.__AUTOSTART__.push(args.enabled); return Promise.resolve({ status: 'saved' }) }
      // Every starter file is on disk: the card offers Start, not a download.
      if (command === 'check_model_sizes') return Promise.resolve((args.files ?? []).map((f) => ({ filename: f.filename, exists: true, actualBytes: 1, complete: true })))
      return invoke(command, args)
    }
  })
  await toCreate(page)
  await page.getByRole('radio', { name: 'Image', exact: true }).click()
  await expect(page.getByText('Your model files are already here')).toBeVisible({ timeout: 20_000 })
  const box = page.getByRole('checkbox', { name: 'Start ComfyUI when LU starts' })
  await expect(box).not.toBeChecked()
  await box.check()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __AUTOSTART__: unknown[] }).__AUTOSTART__)).toEqual([true])
  await shot(page, 'C50-start-comfyui-mit-autostart')
})

test('Enhance: a size menu with long sides and typed values, and a model menu', async ({ page }) => {
  await bootWithFakeComfy(page, {
    checkpoints: ['juggernautXL_v9.safetensors'], loras: [], imageModel: 'juggernautXL_v9.safetensors',
    upscaleModels: ['RealESRGAN_x4plus.safetensors', '2x-AnimeSharp.pth', '4x-UltraSharp.pth'],
  })
  await toCreate(page)
  await page.getByRole('radio', { name: /Enhance/ }).first().click()
  const size = page.getByRole('button', { name: 'Upscale size' })
  await expect(size).toContainText('2x', { timeout: 20_000 })
  await size.click()
  await shot(page, 'enhance-1-groessen-menue')
  await page.getByRole('option', { name: /^3840 px/ }).click()
  await expect(size).toContainText('3840 px')
  await size.click()
  await page.getByRole('option', { name: 'Other factor…' }).click()
  const typed = page.getByRole('textbox', { name: 'Upscale factor' })
  await typed.fill('2.5')
  await typed.press('Enter')
  await expect(size).toContainText('2.5x')
  const model = page.getByRole('button', { name: 'Upscale model' })
  await expect(model).toContainText('Auto: RealESRGAN_x4plus')
  await model.click()
  await page.getByRole('option', { name: /^4x-UltraSharp/ }).click()
  await expect(model).toContainText('4x-UltraSharp')
  await shot(page, 'enhance-2-faktor-und-modell')
  // Kept over a reload.
  await expect.poll(() => page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('create-store') || '{}').state
    return [s.upscaleFactor, s.upscaleLongSide, s.upscaleModelPick]
  })).toEqual([2.5, null, '4x-UltraSharp.pth'])
})
