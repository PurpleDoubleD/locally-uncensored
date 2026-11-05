import { test, expect, type Page } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'
import { mlxCalls } from './support/recorded'

/**
 * 3.0.9 P8 (Discord, 28.10.2026: "can the built-in trainer do styles,
 * concepts, poses?"). The Train tab has a Style / concept mode next to
 * Character: the field is the style's name, the trigger word is a choice,
 * every picture is captioned by what is in it, the steps are the mode's own,
 * and the result is `style_<name>_zimage`, switched on in the Image tab's
 * LoRA stack with its strength, not a character on the shelf.
 *
 * LU_P8_PICS: a folder of pictures for the board (the box run's own style
 * set); without it the board gets one-pixel pictures. LU_SHOTS: where the
 * screenshots go.
 */

const ZIMAGE_MAC: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'mac',
  mlx: { engineInstalled: true, mfluxEngineInstalled: true, installedImages: ['z-image-turbo-4bit'], trainPolls: 2, trainAdapterReady: true },
}

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function pictures(n: number) {
  const dir = process.env.LU_P8_PICS
  if (dir) {
    return readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().slice(0, n)
      .map((f) => ({ name: f, mimeType: f.endsWith('.png') ? 'image/png' : 'image/jpeg', buffer: readFileSync(join(dir, f)) }))
  }
  return Array.from({ length: n }, (_, i) => ({ name: `picture-${i}.png`, mimeType: 'image/png', buffer: ONE_PIXEL_PNG }))
}

const shot = async (page: Page, name: string) => {
  if (!process.env.LU_SHOTS) return
  // The switches and drawers slide; the picture is of the state they reach.
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${process.env.LU_SHOTS}/${name}.png` })
}

async function openTrainTab(page: Page) {
  await page.addInitScript(tauriMockInit, ZIMAGE_MAC)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: 'Character Studio', exact: true }).click()
  await page.getByRole('radio', { name: 'Train new', exact: true }).click()
}

const calls = async (page: Page, cmd: string) => (await mlxCalls(page)).filter((c) => c.cmd === cmd)

test('mac: a style is trained with content captions and lands switched on in the LoRA stack', async ({ page }) => {
  await openTrainTab(page)
  const controls = page.getByTestId('mac-train-controls')
  await expect(controls).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('radio', { name: 'Character', exact: true })).toBeChecked()
  await shot(page, 'p8-1-train-tab-character')

  await page.getByRole('radio', { name: 'Style / concept', exact: true }).click()
  await expect(page.getByTestId('style-mode-note')).toContainText('Teaches a look, a concept or a pose')
  await expect(page.getByText('Drop 4 to 100 pictures in the style here')).toBeVisible()
  // FEHLER-P8 #1: the line over Create speaks of the style too.
  await expect(page.getByText('Add 4 to 100 pictures that share the style above, give it a name, then hit Create to train.')).toBeVisible()
  await expect(page.getByText(/photos of one person or character/)).toHaveCount(0)
  await expect(page.getByTestId('mac-train-hint')).toContainText('Standard, 1600 steps')
  await expect(page.getByTestId('mac-train-hint')).toContainText('The style lands in your LoRA folder')
  await controls.getByPlaceholder('Name, e.g. inkwash').fill('p8lino')
  await page.getByRole('radio', { name: 'Quick', exact: true }).click()
  await expect(page.getByTestId('mac-train-hint')).toContainText('Quick, 600 steps')

  const files = pictures(4)
  await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles(files)
  await expect(controls).toContainText('4/100 pictures')
  await expect(page.getByTestId('train-caption-help')).toContainText('what is left unnamed is what the LoRA learns')
  const fields = page.getByPlaceholder('e.g. a fox in a forest')
  await expect(fields).toHaveCount(4)
  await fields.nth(0).fill('a fox in a forest')
  await fields.nth(1).fill('an old lighthouse on a rocky cliff')
  await expect(page.getByText("Training runs on this Mac and lands the style in the Mac's LoRA folder.")).toBeVisible()
  await shot(page, 'p8-2-style-mode-ready')

  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(async () => (await calls(page, 'mlx_train_start')).length, { timeout: 30_000 }).toBe(1)
  const [clear] = await calls(page, 'mlx_train_clear')
  expect(clear.raw.set).toBe('style-p8lino')
  const staged = (await calls(page, 'mlx_train_stage')).map((c) => c.raw.caption)
  expect(staged).toEqual(['p8lino, a fox in a forest', 'p8lino, an old lighthouse on a rocky cliff', 'p8lino', 'p8lino'])
  const [start] = await calls(page, 'mlx_train_start')
  expect(start.raw).toMatchObject({ set: 'style-p8lino', trigger: 'p8lino', steps: 600, kind: 'style' })

  // Through: no shelf, the Image tab with the style switched on.
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeChecked({ timeout: 20_000 })
  await expect(page.getByText(/Training failed/)).toHaveCount(0)
  await page.getByRole('button', { name: 'Advanced settings' }).click()
  const drawer = page.locator('aside').filter({ hasText: 'Advanced settings' })
  const expert = drawer.getByRole('button', { name: 'Expert', exact: true })
  await expect(expert).toBeVisible({ timeout: 15_000 })
  if (!(await drawer.getByText(/^LoRA stack/).isVisible())) await expert.click()
  await expect(drawer.getByText('· 1 active')).toBeVisible({ timeout: 15_000 })
  const strength = drawer.getByRole('textbox', { name: 'Strength of style_p8lino_zimage' })
  await expect(strength).toHaveValue('0.80')
  await strength.fill('0.6')
  await strength.blur()
  await expect(strength).toHaveValue('0.60')
  await expect(drawer.getByText(/^LoRA stack/)).toBeVisible()
  await shot(page, 'p8-3-style-in-lora-stack')
  await expect(drawer.getByText(/^LoRA stack/)).toBeVisible()

  // The character shelf does not list a style.
  await page.keyboard.press('Escape')
  await page.getByRole('radio', { name: 'Character Studio', exact: true }).click()
  await page.getByRole('radio', { name: 'Use character', exact: true }).click()
  await expect(page.getByTestId('mac-no-characters')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTitle('Trigger word: p8lino')).toHaveCount(0)
})

test('mac: a style without trigger word is captioned by its content alone', async ({ page }) => {
  await openTrainTab(page)
  await page.getByRole('radio', { name: 'Style / concept', exact: true }).click()
  await page.getByTestId('mac-train-controls').getByPlaceholder('Name, e.g. inkwash').fill('p8lino')
  await page.getByTestId('style-trigger').uncheck()
  await expect(page.getByTestId('style-trigger-hint')).toContainText('No trigger word')
  await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles(pictures(4))
  await page.getByPlaceholder('e.g. a fox in a forest').nth(0).fill('a fox in a forest')
  await shot(page, 'p8-4-style-without-trigger')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(async () => (await calls(page, 'mlx_train_start')).length, { timeout: 30_000 }).toBe(1)
  const staged = (await calls(page, 'mlx_train_stage')).map((c) => c.raw.caption)
  expect(staged).toEqual(['a fox in a forest', '', '', ''])
})
