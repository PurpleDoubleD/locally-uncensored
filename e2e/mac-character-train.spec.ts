import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'
import { mlxCalls, comfyCalls } from './support/recorded'
import { openCharacterTraining } from './support/character-hub'

/**
 * Character training on a Mac (src-tauri/src/commands/mlx_train.rs,
 * src/api/mlx-train.ts).
 *
 * Until 3.0.8 the Train tab of Character Studio on a Mac only said that
 * training does not run there. With the MLX image engine and Z-Image Turbo
 * it trains: the photos of the board, the trigger word and the steps go to
 * Rust, the run reports its steps, Stop ends it, and the character lands in
 * the Mac's LoRA folder, where the Use shelf lists it. The Windows trainer
 * (start_character_training) is never called on a Mac.
 */

const MAC: TauriMockOptions = { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'mac' }
const ZIMAGE_MAC: TauriMockOptions = { ...MAC, mlx: { engineInstalled: true, mfluxEngineInstalled: true, installedImages: ['z-image-turbo-4bit'] } }

// A real picture, one pixel wide: the board decodes what it is handed.
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function openTrainTab(page: Page, opts: TauriMockOptions) {
  await page.addInitScript(tauriMockInit, opts)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
  await openCharacterTraining(page)
}

async function addPhotos(page: Page, n: number) {
  const files = Array.from({ length: n }, (_, i) => ({ name: `photo-${i}.png`, mimeType: 'image/png', buffer: ONE_PIXEL_PNG }))
  await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles(files)
}

// One second of a 64x64 test pattern, VP8 in WebM: the clip of
// create-save-character.spec.ts, so the frames are real decoded pictures.
const CLIP = Buffer.from('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', 'base64')
const VIDEO_ITEM = {
  id: 'mac-video-1', type: 'video', filename: '', subfolder: '', localPath: '/tmp/lu-e2e/mlx-video/clip.webm', prompt: 'a red fox on a hill',
  negativePrompt: '', model: 'ltx-2.3', modelType: 'ltx', seed: 7, steps: 8, cfgScale: 1, sampler: '', scheduler: '',
  width: 64, height: 64, batchSize: 1, createdAt: 1_760_000_000_000,
  intent: 'video',
}

const calls = async (page: Page, cmd: string) => (await mlxCalls(page)).filter((c) => c.cmd === cmd)

test('mac with Z-Image Turbo: Train new trains the character locally and it lands on the Use shelf', async ({ page }) => {
  await openTrainTab(page, { ...ZIMAGE_MAC, mlx: { ...ZIMAGE_MAC.mlx, trainPolls: 2 } })

  const controls = page.getByTestId('mac-train-controls')
  await expect(controls).toBeVisible({ timeout: 15_000 })
  // The board, the hint and the controls tell one story: this Mac trains,
  // with the limits its trainer holds (mlx_train.rs MIN_PHOTOS, MAX_PHOTOS).
  await expect(page.getByText('Drop 4 to 100 photos of your character here')).toBeVisible()
  await expect(page.getByText(/does not run on a Mac/)).toHaveCount(0)
  await expect(page.getByTestId('mac-train-note')).toHaveCount(0)
  // The first run fetches the training adapter, and the line says so.
  await expect(page.getByTestId('mac-train-hint')).toContainText('downloads a 340 MB training adapter')
  await expect(page.getByTestId('mac-train-hint')).toContainText('Standard, 1200 steps')
  await controls.getByPlaceholder('Trigger word, e.g. davechar').fill('luxfox')
  await addPhotos(page, 4)
  // How-it-works film (15.10.2026): the board said "Training runs on your
  // GPU" and the model chip named the picked image model, "MLX SD Turbo".
  await expect(page.getByText("Training runs on this Mac and lands the character in the Mac's LoRA folder.")).toBeVisible()
  await expect(page.getByText(/runs on your GPU/)).toHaveCount(0)
  await expect(page.getByTestId('mac-train-base')).toHaveText('Trains on Z-Image Turbo')
  await expect(controls).toContainText('4/100 photos')

  await page.getByRole('button', { name: /^Create$/ }).last().click()

  await expect.poll(async () => (await calls(page, 'mlx_train_start')).length, { timeout: 30_000 }).toBe(1)
  const [clear] = await calls(page, 'mlx_train_clear')
  expect(clear.raw.set).toBe('luxfox')
  const staged = await calls(page, 'mlx_train_stage')
  expect(staged).toHaveLength(4)
  for (const s of staged) {
    expect(s.raw.set).toBe('luxfox')
    // The trigger word leads every caption: the engine has no other way to
    // tie the token to the character.
    expect(s.raw.caption).toBe('luxfox, a photo of luxfox')
    expect(s.raw.bytes).toBe(ONE_PIXEL_PNG.length)
  }
  const [start] = await calls(page, 'mlx_train_start')
  expect(start.raw).toMatchObject({ set: 'luxfox', trigger: 'luxfox', steps: 1200 })
  expect(typeof start.raw.run).toBe('string')

  // Through: the tab turns to Use, and the new character is on the shelf.
  // In the Character area: the panel turns to Image, and the new character
  // is in the list of the head line.
  await expect(page.getByRole('button', { name: 'Action' })).toContainText('Image', { timeout: 20_000 })
  await page.getByRole('button', { name: 'Character', exact: true }).click()
  await expect(page.getByRole('option', { name: /^luxfox/ })).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Escape')
  await expect(page.getByText(/Training failed/)).toHaveCount(0)
  // The Windows trainer and ComfyUI are never asked.
  const names = await page.evaluate(() => ((window as unknown as { __TAURI_CALLS__?: Array<{ cmd: string }> }).__TAURI_CALLS__ ?? []).map((c) => c.cmd))
  expect(names).not.toContain('start_character_training')
  expect(names).not.toContain('stage_training_image')
  expect(await comfyCalls(page)).toHaveLength(0)
})

test('mac: Stop ends the training in Rust and is no error', async ({ page }) => {
  await openTrainTab(page, { ...ZIMAGE_MAC, mlx: { ...ZIMAGE_MAC.mlx, trainPolls: 400 } })
  await page.getByTestId('mac-train-controls').getByPlaceholder('Trigger word, e.g. davechar').fill('luxfox')
  await addPhotos(page, 5)
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(async () => (await calls(page, 'mlx_train_start')).length, { timeout: 30_000 }).toBe(1)
  await expect(page.getByText(/Training \d+\/\d+/).first()).toBeVisible({ timeout: 15_000 })

  // The stop button of a running Create.
  await page.getByRole('button', { name: /^Cancel$/ }).first().click()
  await expect.poll(async () => (await calls(page, 'mlx_train_cancel')).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
  const [cancel] = await calls(page, 'mlx_train_cancel')
  const [start] = await calls(page, 'mlx_train_start')
  expect(cancel.raw.run).toBe(start.raw.run)
  await expect(page.getByRole('button', { name: /^Create$/ }).last()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Training failed/)).toHaveCount(0)
})

test('mac without Z-Image Turbo: the Train tab says what it needs and Create does not train', async ({ page }) => {
  await openTrainTab(page, { ...MAC, mlx: { engineInstalled: true, installedImages: ['sd-turbo'] } })
  await expect(page.getByTestId('mac-train-note')).toContainText('needs Z-Image Turbo', { timeout: 15_000 })
  // GH #194: the inputs stay, the missing install sits above them with its button.
  const controls = page.getByTestId('mac-train-controls')
  await expect(controls.getByRole('button', { name: 'Install Z-Image Turbo' })).toBeVisible()
  await controls.getByPlaceholder('Trigger word, e.g. davechar').fill('luxfox')
  await addPhotos(page, 5)
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect(page.getByText(/Install it in the Model Manager, then hit Create again/)).toBeVisible({ timeout: 15_000 })
  expect(await calls(page, 'mlx_train_start')).toHaveLength(0)
})

test('mac: frames of a video go through Use frames for a character into the Mac training', async ({ page }) => {
  // A video the Mac made earlier: in the gallery, its file on the Mac's disk.
  await page.addInitScript(([item, clip]) => {
    if (!window.localStorage.getItem('create-store')) {
      window.localStorage.setItem('create-store', JSON.stringify({ state: { gallery: [item] }, version: 2 }))
    }
    (window as unknown as { __E2E_MEDIA_FILES__: Record<string, string> }).__E2E_MEDIA_FILES__ = { [String(item.localPath)]: clip }
  }, [VIDEO_ITEM, CLIP.toString('base64')] as const)
  await openTrainTab(page, { ...ZIMAGE_MAC, mlx: { ...ZIMAGE_MAC.mlx, trainPolls: 2 } })

  // The video in the large view, and its frames picked in the window.
  await page.getByRole('radio', { name: 'Image', exact: true }).click()
  await page.getByRole('button', { name: 'Open the gallery' }).click()
  await page.locator('aside button:has(video)').click()
  await page.getByTitle('Use frames of this video for a character').click({ force: true })
  const dialog = page.getByRole('dialog', { name: 'Use frames for a character' })
  await expect(dialog.getByTestId('character-frames').locator('img')).toHaveCount(8, { timeout: 20_000 })
  await dialog.getByRole('button', { name: 'Untick frame 1' }).click()
  await dialog.getByRole('button', { name: 'Train with 7 frames' }).click()
  await expect(dialog).toHaveCount(0)

  // They land on the Train tab of the Mac, which trains them here.
  await expect(page.locator('[data-hub-head]')).toContainText('Train')
  const controls = page.getByTestId('mac-train-controls')
  await expect(controls).toContainText('7/100 photos', { timeout: 15_000 })
  await controls.getByPlaceholder('Trigger word, e.g. davechar').fill('foxclip')
  await page.getByRole('button', { name: /^Create$/ }).last().click()

  await expect.poll(async () => (await calls(page, 'mlx_train_start')).length, { timeout: 30_000 }).toBe(1)
  const staged = await calls(page, 'mlx_train_stage')
  expect(staged).toHaveLength(7)
  for (const s of staged) expect(Number(s.raw.bytes)).toBeGreaterThan(100)
  const [start] = await calls(page, 'mlx_train_start')
  expect(start.raw).toMatchObject({ set: 'foxclip', trigger: 'foxclip' })
  // The new character is in the list of the head line of the Character area.
  await expect(page.getByRole('button', { name: 'Action' })).toContainText('Image', { timeout: 20_000 })
  await page.getByRole('button', { name: 'Character', exact: true }).click()
  await expect(page.getByRole('option', { name: /^foxclip/ })).toBeVisible({ timeout: 10_000 })
})
