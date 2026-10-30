import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'
import { mlxCalls, comfyCalls, hfToken, requireCall } from './support/recorded'

/**
 * macOS local Create — the MLX path (MAC-5).
 *
 * The Mac has no ComfyUI: local images and video run through the in-process
 * MLX sidecar (commands/mlx.rs, video.rs). Until this file the whole surface
 * had zero e2e coverage, so the platform split was only ever verified by
 * reading code. Every test here pins the platform explicitly — the app derives
 * it from navigator, so an unpinned spec would silently test whatever laptop
 * ran it.
 *
 * What's covered: which lanes the Mac offers, that image and video actually
 * dispatch to MLX (and never to ComfyUI), that the installer a fresh Mac needs
 * exists and works, and — as the regression guard — that Windows is untouched.
 */

const MAC_OPTS: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'mac',
}

test('mac settings: Local Media is about the engines, and its models live in the Model Manager', async ({ page }) => {
  // The panel used to be a second model list with its own Install and Remove
  // per row. A failed model install is now reported where the model is, on the
  // lane of the Model Manager (mac-model-manager.spec.ts).
  await page.addInitScript(tauriMockInit, {
    ...MAC_OPTS,
    mlx: { engineInstalled: true, videoEngineInstalled: true, installedImages: ['sd-turbo'], installedVideos: [] },
  })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Settings$/ }).click()
  await page.getByRole('button', { name: /AI Backends/i }).click()
  await page.getByRole('button', { name: /Local Media \(Apple MLX\)/i }).click()

  const panel = page.getByTestId('mlx-media-settings')
  await expect(panel.locator('[data-mlx-engine="image"]')).toHaveAttribute('data-engine-state', 'ready')
  await expect(panel.locator('[data-mlx-engine="video"]')).toHaveAttribute('data-engine-state', 'ready')
  await expect(panel.locator('[data-mlx-row="models"]')).toContainText('1 model installed')
  // No catalogue here: not the installed model, not one that could be.
  await expect(panel.getByText('SD Turbo', { exact: true })).toHaveCount(0)
  await expect(panel.getByText('Juggernaut XL v9', { exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: /^Install$/ })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: /Remove/i })).toHaveCount(0)
  // Nothing is loaded in the mocked engine, so there is nothing to free.
  await expect(panel.getByRole('button', { name: 'Free memory' })).toBeDisabled()
  await expect(panel.locator('[data-mlx-row="storage"]')).toContainText('/tmp/lu-e2e/mlx-video')
  if (process.env.LU_SHOTS) {
    await page.setViewportSize({ width: 1280, height: 1000 })
    await panel.locator('[data-mlx-row="storage"]').scrollIntoViewIfNeeded()
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${process.env.LU_SHOTS}/settings-local-media.png` })
  }

  await panel.getByRole('button', { name: 'Manage models' }).click()
  await expect(page.getByTestId('mac-media-image')).toBeVisible()
  await expect(page.locator('[data-mac-media-tile="sd-turbo"]')).toHaveAttribute('data-state', 'installed')
})

async function bootLocalCreate(page: Page, opts: TauriMockOptions) {
  await page.addInitScript(tauriMockInit, opts)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
}

test('mac local: MLX lanes run locally, cloud-only lanes stay visible as teasers', async ({ page }) => {
  await bootLocalCreate(page, MAC_OPTS)

  // The two lanes MLX genuinely serves are plain, selectable radios.
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('radio', { name: 'Video', exact: true })).toBeVisible()

  // Everything hosted-only keeps its place in the bar as a locked teaser —
  // The owner's rule: what can't run locally is still shown, not deleted.
  // R5-67 renamed the upscale label to "Enhance Image" (parity with web).
  // Enhance Image is locked here because no upscaler is installed; with
  // SeedVR2 it is a local tab (the Enhance walk below).
  // Music is here because this Mac has no music engine: since 14.10.2026 a
  // Mac with ACE-Step 1.5 installed has a local Music tab (mac-music.spec.ts),
  // one without it keeps the teaser.
  for (const label of ['Enhance Image', 'Erase Object', 'Talking Character', 'Music', 'Extend Video', 'Motion Control']) {
    await expect(page.getByRole('radio', { name: `${label}, runs on LU Cloud` })).toBeVisible()
  }
  // Character Studio is a local tab: "Use character" runs the LoRA from the
  // Mac's LoRA folder through MLX.
  await expect(page.getByRole('radio', { name: 'Character Studio', exact: true })).toBeVisible()

  // A locked lane opens the teaser instead of switching the lane, and on a
  // Mac without the music engine the teaser offers no local Music either.
  await page.getByRole('radio', { name: 'Music, runs on LU Cloud' }).click()
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeChecked()

  // Remove Background runs on every Mac through macOS Vision: a plain tab.
  await expect(page.getByRole('radio', { name: 'Remove Background', exact: true })).toBeVisible()
  // Lanes that need a model this Mac does not have are not offered: a
  // visible-but-broken button would be the worse outcome.
  await expect(page.getByRole('radio', { name: /^Edit \/ Image to Image/ })).toHaveCount(0)
  await expect(page.getByRole('radio', { name: /^Animate Image/ })).toHaveCount(0)
})

test('mac local: Remove Background cuts out through macOS Vision, never through ComfyUI', async ({ page }) => {
  await bootLocalCreate(page, MAC_OPTS)
  await page.getByRole('radio', { name: 'Remove Background', exact: true }).click()
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'car.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
  await expect(page.getByRole('img', { name: 'source' })).toBeVisible({ timeout: 15_000 })
  // No node pack to install: the Mac has the tool built in.
  await expect(page.getByText(/ComfyUI/)).toHaveCount(0)
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'mlx_cutout').length, { timeout: 30_000 })
    .toBe(1)
  expect(String(requireCall(await mlxCalls(page), 'mlx_cutout').raw.image)).toContain('start-images')
  expect(await comfyCalls(page)).toHaveLength(0)
})

test('mac local: Enhance Image runs SeedVR2 on the Mac once it is installed, never ComfyUI', async ({ page }) => {
  // Without an upscaler the tab stays a locked teaser (the first walk above).
  // With SeedVR2 installed it is a plain tab, and the run goes to mlx_upscale.
  await bootLocalCreate(page, {
    ...MAC_OPTS,
    mlx: { engineInstalled: true, mfluxEngineInstalled: true, installedImages: ['sd-turbo', 'seedvr2-3b'] },
  })
  const tab = page.getByRole('radio', { name: 'Enhance Image', exact: true })
  await expect(tab).toBeVisible({ timeout: 15_000 })
  await tab.click()
  await expect(tab).toBeChecked()
  // The one setting the run takes: the factor. 2x is where it starts.
  const factor = page.getByRole('radiogroup', { name: 'Enhance factor' })
  await expect(factor.getByRole('radio', { name: '2x' })).toBeChecked()
  await factor.getByRole('radio', { name: '4x' }).click()
  await expect(factor.getByRole('radio', { name: '4x' })).toBeChecked()
  // No resolution of the hosted tool and no model picker on this tab.
  await expect(page.getByRole('radio', { name: '8K' })).toHaveCount(0)
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'car.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
  await expect(page.getByRole('img', { name: 'source' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/ComfyUI/)).toHaveCount(0)
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'mlx_upscale').length, { timeout: 30_000 })
    .toBe(1)
  const call = requireCall(await mlxCalls(page), 'mlx_upscale').raw
  expect(String(call.image)).toContain('start-images')
  expect(call.scale).toBe(4)
  expect(String(call.run)).toMatch(/^run-/)
  // The upscaler is never handed a prompt as an image model.
  expect((await mlxCalls(page)).filter((c) => c.cmd === 'mlx_generate')).toHaveLength(0)
  expect(await comfyCalls(page)).toHaveLength(0)
  // The result lands in the gallery of this Mac, and Create is free again.
  await expect(page.getByRole('button', { name: /^Create$/ }).last()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Enhance failed/)).toHaveCount(0)
})

test('mac local: image generate dispatches to MLX, never to ComfyUI', async ({ page }) => {
  await bootLocalCreate(page, MAC_OPTS)
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })

  const composer = page.locator('textarea').first()
  await composer.fill('a red apple on a wooden table')
  await page.getByRole('button', { name: /^Create$/ }).last().click()

  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'mlx_generate').length, { timeout: 30_000 })
    .toBeGreaterThan(0)

  const gen = requireCall(await mlxCalls(page), 'mlx_generate')
  expect(gen.prompt).toContain('a red apple')

  // The render came back as a data: PNG and is on screen.
  await expect(page.locator('img[src^="data:image/png"]').first()).toBeVisible({ timeout: 30_000 })

  // The point of the whole platform split: no ComfyUI call was even attempted.
  expect(await comfyCalls(page)).toHaveLength(0)
})

test('mac local: video generate dispatches to the MLX video model', async ({ page }) => {
  await bootLocalCreate(page, MAC_OPTS)
  await page.getByRole('radio', { name: 'Video', exact: true }).click()

  const composer = page.locator('textarea').first()
  await composer.fill('slow drifting clouds over a lake')
  await page.getByRole('button', { name: /^Create$/ }).last().click()

  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'video_generate').length, { timeout: 40_000 })
    .toBeGreaterThan(0)

  const gen = requireCall(await mlxCalls(page), 'video_generate')
  expect(gen.id).toBe('wan21-t2v-1.3b')
  expect(gen.prompt).toContain('drifting clouds')
  // Nothing typed into the negative field: nothing goes out.
  expect(gen.raw.negative_prompt).toBeUndefined()
})

test('mac local: a video model that reads a negative prompt shows the field and gets it', async ({ page }) => {
  // Wan samples with guidance and reads one (`negativePrompt` of its
  // catalogue entry, from `takes_negative_prompt` in video.rs).
  await bootLocalCreate(page, MAC_OPTS)
  await page.getByRole('radio', { name: 'Video', exact: true }).click()
  // The clip counts at the rate of the entry: 81 frames at Wan's 16.
  await expect(page.getByTestId('mac-video-length')).toContainText('81 frames · 5.1s')
  await page.locator('textarea').first().fill('slow drifting clouds over a lake')
  await page.getByRole('button', { name: 'Negative', exact: true }).click()
  await page.locator('#negative-prompt-field textarea').fill('blurry, static')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'video_generate').length, { timeout: 40_000 })
    .toBeGreaterThan(0)
  const gen = requireCall(await mlxCalls(page), 'video_generate')
  expect(gen.id).toBe('wan21-t2v-1.3b')
  expect(gen.raw.negative_prompt).toBe('blurry, static')
  // 81 frames at 16, with the half frame of margin Rust cuts off again.
  expect(Number(gen.raw.seconds)).toBeCloseTo(81.5 / 16, 5)
})

test('mac local: a distilled LTX pack shows no negative field and gets none', async ({ page }) => {
  // The second engine runs distilled alone and ends with an error on the
  // flag, so the field would be a field nothing reads.
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { installedVideos: ['ltx-2.3-q4'], ltx2EngineInstalled: true } })
  // Typed on the Image tab, where the field is shown: it must not travel.
  await page.getByRole('button', { name: 'Negative', exact: true }).click()
  await page.locator('#negative-prompt-field textarea').fill('blurry, static')
  await page.getByRole('radio', { name: 'Video', exact: true }).click()
  // 49 frames at the 24 of its entry, and no slider for steps or guidance.
  await expect(page.getByTestId('mac-video-length')).toContainText('49 frames · 2.0s')
  await expect(page.getByRole('button', { name: 'Negative', exact: true })).toHaveCount(0)
  await expect(page.locator('#negative-prompt-field')).toHaveCount(0)
  await expect(page.getByText('Quality (steps)')).toHaveCount(0)
  await page.locator('textarea').first().fill('slow drifting clouds over a lake')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'video_generate').length, { timeout: 40_000 })
    .toBeGreaterThan(0)
  const gen = requireCall(await mlxCalls(page), 'video_generate')
  expect(gen.id).toBe('ltx-2.3-q4')
  expect(gen.raw.negative_prompt).toBeUndefined()
  expect(Number(gen.raw.seconds)).toBeCloseTo(49.5 / 24, 5)
})

test('mac local: a Wan takes a size on its grid and a step count, and the run gets exactly those', async ({ page }) => {
  // Wan reads `--width`, `--height` (floored to 16) and `--steps`
  // (`size_grid` and `default_steps` in video.rs).
  await bootLocalCreate(page, MAC_OPTS)
  await page.getByRole('radio', { name: 'Video', exact: true }).click()
  await openDrawer(page)
  await expect(drawer(page).getByText('Guidance', { exact: true })).toHaveCount(0)
  // The steps start at the config's own 50 of Wan 2.1.
  await expect(slider(page, 'Steps')).toHaveValue('50')
  await expect(drawer(page).getByTestId('mac-video-size')).toContainText('Runs at 832×480 px')
  await drawer(page).getByRole('button', { name: 'Swap orientation' }).click()
  await expect(drawer(page).getByTestId('mac-video-size')).toContainText('Runs at 480×832 px')
  await slider(page, 'Steps').fill('8')
  // Wan's 720p chip would ask for more than this model's own pixels.
  await expect(drawer(page).getByRole('button', { name: '720p', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.locator('textarea').first().fill('slow drifting clouds over a lake')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'video_generate').length, { timeout: 40_000 })
    .toBeGreaterThan(0)
  const gen = requireCall(await mlxCalls(page), 'video_generate')
  expect(gen.id).toBe('wan21-t2v-1.3b')
  expect([gen.raw.width, gen.raw.height, gen.raw.steps]).toEqual([480, 832, 8])
})

test('mac local: a distilled LTX pack takes a size on 64 inside its own pixels, and no steps', async ({ page }) => {
  // `-W`/`-H` floor to 64 on the second engine, and `--distilled` reads no
  // `--steps`. A size larger than the pack's own is brought down before the
  // run, keeping its shape.
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { installedVideos: ['ltx-2.3-q4'], ltx2EngineInstalled: true } })
  await page.getByRole('radio', { name: 'Video', exact: true }).click()
  await openDrawer(page)
  await expect(drawer(page).getByText('Steps', { exact: true })).toHaveCount(0)
  await expect(drawer(page).getByTestId('mac-video-size')).toContainText('Runs at 768×512 px')
  await drawer(page).getByRole('button', { name: '1:1', exact: true }).click()
  await expect(drawer(page).getByTestId('mac-video-size')).toContainText('Runs at 576×576 px')
  await expect(drawer(page).getByTestId('mac-video-size')).toContainText('steps of 64 px')
  await page.keyboard.press('Escape')
  await page.locator('textarea').first().fill('slow drifting clouds over a lake')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'video_generate').length, { timeout: 40_000 })
    .toBeGreaterThan(0)
  const gen = requireCall(await mlxCalls(page), 'video_generate')
  expect(gen.id).toBe('ltx-2.3-q4')
  expect([gen.raw.width, gen.raw.height]).toEqual([576, 576])
  expect(gen.raw.steps).toBeUndefined()
})

test('mac local: an LTX-2.5 pack takes the shot list, written out as cuts in its prompt', async ({ page }) => {
  // LTX-2.5 cuts where the prompt says so in prose (lib/ltx-multishot), and
  // the pack reads the prompt as ComfyUI does. LTX-2.3 is offered no list.
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { installedVideos: ['ltx-2.3-q4', 'ltx-2.5-q4'], ltx2EngineInstalled: true } })
  await page.getByRole('radio', { name: 'Video', exact: true }).click()
  await openDrawer(page)
  await expect(drawer(page).getByText('Shots', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /LTX-2\.3 Distilled 4-bit/ }).first().click()
  await page.getByRole('option', { name: /LTX-2\.5 Distilled 4-bit/ }).first().click()
  await openDrawer(page)
  await slider(page, 'Shots').fill('2')
  await drawer(page).getByPlaceholder('Describe the next shot…').fill('close up of her face, she smiles')
  await page.keyboard.press('Escape')
  await page.locator('textarea').first().fill('a woman in a red coat walks through the rain')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'video_generate').length, { timeout: 40_000 })
    .toBeGreaterThan(0)
  const gen = requireCall(await mlxCalls(page), 'video_generate')
  expect(gen.id).toBe('ltx-2.5-q4')
  expect(gen.prompt).toBe('a woman in a red coat walks through the rain. A hard cut transitions to the next shot, with the same characters. close up of her face, she smiles.')
})

// A real picture, one pixel wide: the Stage decodes what it is handed.
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('mac local: Animate Image hands the picked image to the MLX video model', async ({ page }) => {
  // Wan 2.2 TI2V starts from text or from an image. The lane is the one
  // Windows and the cloud have: the tab, the drop area, the preview.
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { installedVideos: ['wan21-t2v-1.3b', 'wan22-ti2v-5b-q8'] } })
  await page.getByRole('radio', { name: 'Animate Image', exact: true }).click()
  await expect(page.getByText('Drop an image to animate')).toBeVisible({ timeout: 15_000 })

  // The button waits for the image and says so.
  const create = page.getByRole('button', { name: /^Create$/ }).last()
  await page.locator('textarea').first().fill('slow push in, leaves moving')
  await expect(create).toBeDisabled()
  await expect(page.getByTitle('Add a start image first.')).toBeVisible()

  await page.locator('input[type="file"]').first().setInputFiles({ name: 'start.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
  // The preview replaces the drop area, and the hint is gone with it.
  await expect(page.getByText('Drop an image to animate')).toHaveCount(0)
  await expect(page.getByTitle('Add a start image first.')).toHaveCount(0)
  await expect(create).toBeEnabled()
  if (process.env.LU_SHOTS) await page.screenshot({ path: `${process.env.LU_SHOTS}/mac-animate-source.png` })
  await create.click()

  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'video_generate').length, { timeout: 40_000 })
    .toBeGreaterThan(0)
  const calls = await mlxCalls(page)
  const staged = requireCall(calls, 'video_stage_start_image')
  expect(Number(staged.raw.bytes)).toBeGreaterThan(0)
  const gen = requireCall(calls, 'video_generate')
  // The model that takes an image, not the text only one, and the path the
  // staging answered with.
  expect(gen.id).toBe('wan22-ti2v-5b-q8')
  expect(gen.prompt).toContain('slow push in')
  expect(gen.raw.init_image).toBe('/tmp/lu-e2e/videos/start-images/e2e-start.png')
  expect(await comfyCalls(page)).toHaveLength(0)
})

// M1 (14.10.2026): Extend Video on a Mac. The last frame of the picked clip
// becomes the start image of an image to video run, as on Windows, on the
// models that Animate runs on. The clip is one the browser records here, so
// it is a real video the page decodes; such a clip reports no duration until
// it is sought to its end (lib/video-frames lastFrame).
test('mac local: Extend Video hands the last frame of the picked clip to the MLX video model', async ({ page }) => {
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { installedVideos: ['wan21-t2v-1.3b', 'wan22-ti2v-5b-q8'] } })
  await page.getByRole('radio', { name: 'Extend Video', exact: true }).click()
  const clip = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 48
    const ctx = canvas.getContext('2d')!
    const recorder = new MediaRecorder(canvas.captureStream(10), { mimeType: 'video/webm' })
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => chunks.push(e.data)
    const stopped = new Promise((resolve) => { recorder.onstop = resolve })
    recorder.start()
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i % 2 ? '#c03' : '#03c'
      ctx.fillRect(0, 0, 64, 48)
      await new Promise((r) => setTimeout(r, 100))
    }
    recorder.stop()
    await stopped
    const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer())
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return btoa(binary)
  })
  await page.locator('input[type="file"][accept^="video/"]').setInputFiles({ name: 'dance.webm', mimeType: 'video/webm', buffer: Buffer.from(clip, 'base64') })
  await expect(page.getByText('Continues: dance.webm')).toBeVisible({ timeout: 20_000 })
  await page.locator('textarea').first().fill('she keeps dancing as the camera pulls back')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'video_generate').length, { timeout: 40_000 })
    .toBeGreaterThan(0)
  const calls = await mlxCalls(page)
  expect(Number(requireCall(calls, 'video_stage_start_image').raw.bytes)).toBeGreaterThan(0)
  const gen = requireCall(calls, 'video_generate')
  // The model that takes an image, not the text only one.
  expect(gen.id).toBe('wan22-ti2v-5b-q8')
  expect(gen.prompt).toContain('keeps dancing')
  expect(gen.raw.init_image).toBe('/tmp/lu-e2e/videos/start-images/e2e-start.png')
  expect(await comfyCalls(page)).toHaveLength(0)
})

// Found by the how-it-works film (15.10.2026): Extend on a Mac showed the
// ComfyUI graph's steps, size chips and frames under LTX-2.3 Distilled 4-bit,
// and a Negative switch the model never reads. It is the same run as
// Animate, so it has the same row: the length on the model's grid.
test('mac local: Extend Video shows the length of its model and no slider of the ComfyUI graph', async ({ page }) => {
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { installedVideos: ['ltx-2.3-q4'] } })
  await page.getByRole('radio', { name: 'Extend Video', exact: true }).click()
  await expect(page.getByTestId('mac-video-length')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Quality (steps)')).toHaveCount(0)
  await expect(page.getByText('336p', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Negative', exact: true })).toHaveCount(0)
  expect(await comfyCalls(page)).toHaveLength(0)
})

test('mac local: a model that needs a start image waits for it and starts nothing', async ({ page }) => {
  // Wan 2.2 I2V cannot run from text. Without an image it would load two 14B
  // experts and then fail on a tensor shape, so nothing is called before the
  // image is there.
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { installedVideos: ['wan22-i2v-a14b'] } })
  await page.getByRole('radio', { name: 'Animate Image', exact: true }).click()
  await expect(page.getByText('Drop an image to animate')).toBeVisible({ timeout: 15_000 })

  await page.locator('textarea').first().fill('slow drifting clouds over a lake')
  const create = page.getByRole('button', { name: /^Create$/ }).last()
  await expect(create).toBeDisabled()
  await expect(page.getByTitle('Add a start image first.')).toBeVisible()
  // Enter in the prompt field is the other way to start a run.
  await page.locator('textarea').first().press('Enter')
  await page.waitForTimeout(500)
  expect((await mlxCalls(page)).filter((c) => c.cmd === 'video_generate' || c.cmd === 'video_stage_start_image')).toHaveLength(0)

  // Video is text to video and has no model here: it offers the setup instead
  // of a model that cannot run in it.
  await page.getByRole('radio', { name: 'Video', exact: true }).click()
  await expect(page.getByText('Local video generation needs a one-time setup')).toBeVisible()
  await expect(page.getByText(/turns a start image into video/)).toHaveCount(0)
})

// ── Qwen-Image 2.1 on the Mac: what Windows can do with it in Create ──

const QWEN_MAC: TauriMockOptions = {
  ...MAC_OPTS,
  mlx: { installedImages: ['sd-turbo', 'qwen-image-2.1-8bit'], mfluxEngineInstalled: true },
}

/** The settings drawer. ParamGroups is rendered in here and nowhere else. */
function drawer(page: Page) {
  return page.locator('aside').filter({ hasText: 'Advanced settings' })
}

async function openDrawer(page: Page) {
  await page.getByRole('button', { name: 'Advanced settings' }).click()
  // Output is in the drawer on every tab. Quality is not on the Mac's video
  // tab while its model takes no size and no steps.
  await expect(drawer(page).getByRole('button', { name: 'Output', exact: true })).toBeVisible({ timeout: 15_000 })
}

/** The range input under a labelled slider of the drawer. */
function slider(page: Page, label: string) {
  return drawer(page).getByText(label, { exact: true }).locator('xpath=../following-sibling::div[1]//input[@type="range"]')
}

/** The number input under a labelled field of the drawer. */
function field(page: Page, label: string) {
  return drawer(page).getByText(label, { exact: true }).locator('xpath=following-sibling::div[1]//input[@type="number"]')
}

async function generates(page: Page): Promise<number> {
  return (await mlxCalls(page)).filter((c) => c.cmd === 'mlx_generate').length
}

test('mac local: Edit with Qwen-Image 2.1 hands the picked image and the prompt to mlx_generate', async ({ page }) => {
  await bootLocalCreate(page, QWEN_MAC)
  // The tab Windows has, under the name Windows has.
  await page.getByRole('radio', { name: 'Edit / Image to Image', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Edit / Image to Image', exact: true })).toBeChecked()
  // No ComfyUI on a Mac: the stage asks for an image, not for nodes.
  await expect(page.getByText(/ComfyUI/)).toHaveCount(0)

  await page.locator('input[type="file"]').first().setInputFiles({ name: 'car.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
  await expect(page.getByRole('img', { name: 'source' })).toBeVisible({ timeout: 15_000 })
  // An edit from the prompt, and under a mask where one is painted (mflux
  // --mask-image). The reference strip is the one Windows shows.
  await expect(page.getByText(/leave the mask empty to edit the whole image/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Paint mask/ })).toBeVisible()
  await expect(page.getByTestId('reference-strip')).toBeVisible()
  if (process.env.LU_SHOTS) await page.screenshot({ path: `${process.env.LU_SHOTS}/mac-edit-source.png` })

  await page.locator('textarea').first().fill('make the car blue')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(() => generates(page), { timeout: 30_000 }).toBe(1)

  const calls = await mlxCalls(page)
  expect(Number(requireCall(calls, 'video_stage_start_image').raw.bytes)).toBeGreaterThan(0)
  const gen = requireCall(calls, 'mlx_generate')
  // The model that edits, not the first of the list, the prompt, and the
  // path the staging answered with.
  expect(gen.model).toBe('qwen-image-2.1-8bit')
  expect(gen.prompt).toBe('make the car blue')
  expect(gen.raw.images).toEqual(['/tmp/lu-e2e/videos/start-images/e2e-start.png'])
  // Where Windows opens this model: 25 steps and CFG 1.0. The canvas, the
  // side the image is scaled to, is 1056 and not Windows' 1024: on the Mac
  // the model does not edit on 1024 x 1024 and the engine runs 1056 (real
  // run, 09.10.2026). One image: the result takes its shape, so no size
  // goes out.
  expect(gen.steps).toBe(25)
  expect(gen.raw.guidance).toBe(1)
  expect(gen.raw.resolution).toBe(1056)
  expect(gen.raw.width).toBeUndefined()
  expect(gen.raw.height).toBeUndefined()
  await expect(page.locator('img[src^="data:image/png"]').first()).toBeVisible({ timeout: 30_000 })
  expect(await comfyCalls(page)).toHaveLength(0)
})

// Discord feature request "Native HiRes Upscale in the EDIT" (3.0.8): the
// switch is in Edit too, and the edited picture goes back in for the second
// pass at the larger size, as a picture made in Create does.
test('mac local: Native HiRes in Edit runs the edited picture again at the larger size', async ({ page }) => {
  await bootLocalCreate(page, QWEN_MAC)
  await page.getByRole('radio', { name: 'Edit / Image to Image', exact: true }).click()
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'car.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
  await expect(page.getByRole('img', { name: 'source' })).toBeVisible({ timeout: 15_000 })
  await openDrawer(page)
  const hires = drawer(page).getByRole('button', { name: /Native HiRes/ })
  await expect(hires).toBeVisible()
  await hires.click()
  await expect(drawer(page).getByText('A second pass over the edited picture at a larger size')).toBeVisible()
  if (process.env.LU_SHOTS) await page.screenshot({ path: `${process.env.LU_SHOTS}/mac-edit-hires-drawer.png` })
  await page.keyboard.press('Escape')

  await page.locator('textarea').first().fill('make the car blue')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(() => generates(page), { timeout: 30_000 }).toBe(2)
  const gens = (await mlxCalls(page)).filter((c) => c.cmd === 'mlx_generate')
  // First the edit of the picked picture, as without HiRes.
  expect(gens[0].raw.images).toEqual(['/tmp/lu-e2e/videos/start-images/e2e-start.png'])
  expect(gens[0].raw.resolution).toBe(1056)
  // Then the edited picture (768 x 512 from the engine) at 1.5 times its size.
  expect(gens[1].raw.images).toHaveLength(1)
  expect([gens[1].width, gens[1].height]).toEqual([1152, 768])
  expect(gens[1].prompt).toBe('make the car blue')
  await expect(page.locator('img[src^="data:image/png"]').first()).toBeVisible({ timeout: 30_000 })
  expect(await comfyCalls(page)).toHaveLength(0)
})

test('mac local: an edit with a reference sends both images, the edited one first, and its size', async ({ page }) => {
  await bootLocalCreate(page, QWEN_MAC)
  await page.getByRole('radio', { name: 'Edit / Image to Image', exact: true }).click()
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'person.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
  await expect(page.getByRole('img', { name: 'source' })).toBeVisible({ timeout: 15_000 })
  const strip = page.getByTestId('reference-strip')
  await strip.locator('input[type="file"]').setInputFiles({ name: 'scene.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
  await expect(strip.locator('img')).toHaveCount(1, { timeout: 15_000 })

  await page.locator('textarea').first().fill('put the person from image 1 into the scene of image 2')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(() => generates(page), { timeout: 30_000 }).toBe(1)
  const gen = requireCall(await mlxCalls(page), 'mlx_generate')
  expect(gen.raw.images).toHaveLength(2)
  // With several images the engine would follow the last one. The size is
  // worked out from the first: a square picture, at the 1056 x 1056 an edit
  // runs on and never at 1024 x 1024.
  expect([gen.width, gen.height]).toEqual([1056, 1056])
  expect(gen.raw.resolution).toBe(1056)
})

test('mac local: steps, CFG, size, seed and negative prompt reach Qwen-Image 2.1', async ({ page }) => {
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { installedImages: ['qwen-image-2.1-8bit'], mfluxEngineInstalled: true } })
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await openDrawer(page)
  // The values Windows opens Qwen-Image 2.1 at.
  await expect(drawer(page).getByText('Steps', { exact: true }).locator('xpath=following-sibling::span')).toHaveText('25')
  await expect(drawer(page).getByText('CFG scale', { exact: true }).locator('xpath=following-sibling::span')).toHaveText('1.0')
  await slider(page, 'Steps').fill('40')
  await slider(page, 'CFG scale').fill('4')
  await field(page, 'Width').fill('832')
  await field(page, 'Height').fill('1216')
  await field(page, 'Seed (−1 = random)').fill('1234')
  // The model writes an alpha channel, here as on Windows.
  await expect(drawer(page).getByRole('switch', { name: /Transparent background/ })).toBeVisible()
  // What the second engine has no flag for is not on the panel. Expert is
  // there for the one thing it takes, the LoRA stack (tests further down).
  const expert = drawer(page).getByRole('button', { name: 'Expert', exact: true })
  await expect(expert).toBeVisible()
  if (!(await drawer(page).getByText(/^LoRA stack/).isVisible())) await expert.click()
  await expect(drawer(page).getByText(/^LoRA stack/)).toBeVisible()
  for (const label of ['Sampler', 'Scheduler', 'VAE', 'Skip CLIP layers', 'Denoise (raw)']) {
    await expect(drawer(page).getByText(label, { exact: true })).toHaveCount(0)
  }
  // HiRes runs on the Mac for a model that edits: a second pass over the
  // picture (lib/mac-hires). The latent upscale method is Windows only.
  await expect(drawer(page).getByText('Native HiRes')).toBeVisible()
  await expect(drawer(page).getByText('Latent upscale method')).toHaveCount(0)
  if (process.env.LU_SHOTS) await page.screenshot({ path: `${process.env.LU_SHOTS}/mac-qwen21-settings.png` })
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Negative', exact: true }).click()
  await page.getByPlaceholder('What to avoid…').fill('blurry, low quality')
  await page.locator('textarea').first().fill('a poster with the title SPRING')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(() => generates(page), { timeout: 30_000 }).toBe(1)
  const gen = requireCall(await mlxCalls(page), 'mlx_generate')
  expect(gen.model).toBe('qwen-image-2.1-8bit')
  expect([gen.steps, gen.seed, gen.width, gen.height]).toEqual([40, 1234, 832, 1216])
  expect(gen.raw.guidance).toBe(4)
  expect(gen.raw.negative_prompt).toBe('blurry, low quality')
  expect(gen.raw.images).toBeUndefined()
})

test('mac local: the Turbo pack runs at its own steps, and the sliders that cannot reach it are not shown', async ({ page }) => {
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { installedImages: ['qwen-image-2.1-turbo'], mfluxEngineInstalled: true } })
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await openDrawer(page)
  await expect(drawer(page).getByText('Steps', { exact: true })).toHaveCount(0)
  await expect(drawer(page).getByText('CFG scale', { exact: true })).toHaveCount(0)
  await expect(field(page, 'Width')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText('Quality', { exact: true })).toHaveCount(0)

  await page.locator('textarea').first().fill('a lighthouse at dusk')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(() => generates(page), { timeout: 30_000 }).toBe(1)
  const gen = requireCall(await mlxCalls(page), 'mlx_generate')
  expect(gen.model).toBe('qwen-image-2.1-turbo')
  expect(gen.steps).toBeUndefined()
  expect(gen.raw.guidance).toBeUndefined()
  // It edits as well: the tab is there with this pack alone.
  await expect(page.getByRole('radio', { name: 'Edit / Image to Image', exact: true })).toBeVisible()
})

test('mac local: Cancel ends the image the second engine is making, and nothing is said as an error', async ({ page }) => {
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { installedImages: ['qwen-image-2.1-8bit'], mfluxEngineInstalled: true, imageGenerateWaits: true } })
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await page.locator('textarea').first().fill('a red apple on a wooden table')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(() => generates(page), { timeout: 30_000 }).toBe(1)
  // The step the engine reports is on the stage while it runs.
  await expect(page.getByText('Step 3/25').first()).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'mlx_generate_cancel').length, { timeout: 15_000 })
    .toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: /^Create$/ }).last()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Generation failed/)).toHaveCount(0)
  await expect(page.getByText(/stopped the engine/)).toHaveCount(0)
  await expect(page.locator('img[src^="data:image/png"]')).toHaveCount(0)
})

// GH #148: "Improve my prompt" with the Qwen-Image 2.1 prompt enhancer from
// the Model Manager (commands/mlx_enhancer.rs). It rewrites on the Mac, before
// the picture, and the picture takes its prompt.
const ENHANCED_MAC: TauriMockOptions = {
  ...MAC_OPTS,
  mlx: {
    installedImages: ['qwen-image-2.1-8bit', 'qwen-image-2.1-pe-t2i-4bit', 'qwen-image-2.1-pe-i2i-4bit'],
    mfluxEngineInstalled: true,
    enhancerAnswer: 'The user wants a poster.\n</think>\n\nA long rewritten prompt from the Qwen enhancer.',
  },
}
const improveSwitch = (page: Page) => drawer(page).getByRole('switch', { name: /Improve my prompt/ })

test('mac local: the Qwen enhancer rewrites a new picture on the Mac, before the image, and the image takes its prompt', async ({ page }) => {
  await bootLocalCreate(page, ENHANCED_MAC)
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await openDrawer(page)
  await expect(improveSwitch(page)).toBeVisible()
  await improveSwitch(page).click()
  await expect(improveSwitch(page)).toHaveAttribute('aria-checked', 'true')
  // Only the official edition has an MLX build: no "No Filter" entry.
  await expect(drawer(page).getByRole('radiogroup', { name: 'Rewritten by' }).getByRole('radio')).toHaveText(['Qwen enhancer', 'Chat model'])
  await expect(drawer(page).getByRole('radio', { name: 'Qwen enhancer', exact: true })).toHaveAttribute('aria-checked', 'true')
  await field(page, 'Seed (−1 = random)').fill('77')
  await page.keyboard.press('Escape')

  await page.locator('textarea').first().fill('a poster')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(() => generates(page), { timeout: 30_000 }).toBe(1)
  const calls = await mlxCalls(page)
  const order = calls.map((c) => c.cmd).filter((c) => c === 'mlx_enhance_prompt' || c === 'mlx_generate')
  expect(order).toEqual(['mlx_enhance_prompt', 'mlx_generate'])
  const enhance = requireCall(calls, 'mlx_enhance_prompt')
  expect(enhance.model).toBe('qwen-image-2.1-pe-t2i-4bit')
  expect(enhance.prompt).toBe('a poster')
  expect(enhance.raw.images).toEqual([])
  expect(enhance.seed).toBe(77)
  expect(typeof enhance.raw.run).toBe('string')
  const gen = requireCall(calls, 'mlx_generate')
  expect(gen.model).toBe('qwen-image-2.1-8bit')
  expect(gen.prompt).toBe('A long rewritten prompt from the Qwen enhancer.')
  await expect(page.locator('img[src^="data:image/png"]').first()).toBeVisible({ timeout: 30_000 })
  expect(await comfyCalls(page)).toHaveLength(0)
})

test('mac local: the edit enhancer reads the image of the edit, and the edit takes its prompt', async ({ page }) => {
  await bootLocalCreate(page, ENHANCED_MAC)
  await page.getByRole('radio', { name: 'Edit / Image to Image', exact: true }).click()
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'car.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
  await expect(page.getByRole('img', { name: 'source' })).toBeVisible({ timeout: 15_000 })
  await openDrawer(page)
  await improveSwitch(page).click()
  await expect(improveSwitch(page)).toHaveAttribute('aria-checked', 'true')
  // A chat model cannot see the picture: the enhancer is the only writer.
  await expect(drawer(page).getByRole('radiogroup', { name: 'Rewritten by' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.locator('textarea').first().fill('make the car blue')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(() => generates(page), { timeout: 30_000 }).toBe(1)
  const calls = await mlxCalls(page)
  const enhance = requireCall(calls, 'mlx_enhance_prompt')
  expect(enhance.model).toBe('qwen-image-2.1-pe-i2i-4bit')
  expect(enhance.prompt).toBe('make the car blue')
  expect(enhance.raw.images).toEqual(['/tmp/lu-e2e/videos/start-images/e2e-start.png'])
  const gen = requireCall(calls, 'mlx_generate')
  expect(gen.prompt).toBe('A long rewritten prompt from the Qwen enhancer.')
  expect(gen.raw.images).toEqual(['/tmp/lu-e2e/videos/start-images/e2e-start.png'])
  expect(calls.findIndex((c) => c.cmd === 'mlx_enhance_prompt')).toBeLessThan(calls.findIndex((c) => c.cmd === 'mlx_generate'))
})

test('mac local: without the enhancer installed the switch is the chat model one, and nothing goes to it', async ({ page }) => {
  await bootLocalCreate(page, QWEN_MAC)
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await openDrawer(page)
  await expect(improveSwitch(page)).toBeVisible()
  await expect(drawer(page).getByRole('radiogroup', { name: 'Rewritten by' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  // Edit: the chat model writes there too (B48), still no row to choose.
  await page.getByRole('radio', { name: 'Edit / Image to Image', exact: true }).click()
  await openDrawer(page)
  await expect(improveSwitch(page)).toBeVisible()
  await expect(drawer(page).getByRole('radiogroup', { name: 'Rewritten by' })).toHaveCount(0)
  expect((await mlxCalls(page)).some((c) => c.cmd === 'mlx_enhance_prompt')).toBe(false)
})

test('mac local: a model that takes no image gets no image field', async ({ page }) => {
  // Wan 2.1 is text to video. No Animate tab, and nothing on the Video lane
  // that takes a picture.
  await bootLocalCreate(page, MAC_OPTS)
  await page.getByRole('radio', { name: 'Video', exact: true }).click()
  await expect(page.getByRole('radio', { name: /^Animate Image/ })).toHaveCount(0)
  await expect(page.getByText('Drop an image to animate')).toHaveCount(0)
  await expect(page.locator('input[type="file"][accept^="image"]')).toHaveCount(0)
  await expect(page.getByTitle('Add a start image first.')).toHaveCount(0)
})

test('fresh mac: Local Media sets the engine up, and the model is installed in the Model Manager', async ({ page }) => {
  // A Mac that has never generated anything: no venv, no models. Before MAC-3
  // this state had no way out — the Rust install commands existed but nothing
  // called them, so local Create just failed.
  await page.addInitScript(tauriMockInit, {
    ...MAC_OPTS,
    mlx: { engineInstalled: false, videoEngineInstalled: false, installedImages: [], installedVideos: [] },
  })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: /^Settings$/ }).click()
  await page.getByRole('button', { name: /AI Backends/i }).click()

  // The Mac gets the MLX panel where other platforms get the ComfyUI panel.
  const section = page.getByRole('button', { name: /Local Media \(Apple MLX\)/i })
  await expect(section).toBeVisible({ timeout: 15_000 })
  await section.click()
  await expect(page.getByRole('button', { name: /ComfyUI/i })).toHaveCount(0)

  // The engine is a setting: it is set up here.
  const panel = page.getByTestId('mlx-media-settings')
  const imageEngine = panel.locator('[data-mlx-engine="image"]')
  await expect(imageEngine).toHaveAttribute('data-engine-state', 'missing')
  await expect(imageEngine).toContainText('A one-time setup of about 5 GB')
  await expect(panel.locator('[data-mlx-row="models"]')).toContainText('None installed yet')
  await imageEngine.getByRole('button', { name: 'Set up the image engine' }).click()
  await expect(imageEngine).toHaveAttribute('data-engine-state', 'ready', { timeout: 20_000 })
  expect((await mlxCalls(page)).some((c) => c.cmd === 'install_mlx_diffusion')).toBe(true)

  // A model is not: Manage models leads to the catalogue, and Get installs it.
  await panel.getByRole('button', { name: 'Manage models' }).click()
  const lane = page.getByTestId('mac-media-image')
  await expect(lane.locator('[data-engine-state="ready"]')).toBeVisible()
  const pick = page.locator('[data-mac-media-tile="sd-turbo"]')
  await pick.getByRole('button', { name: /^Get/ }).click()
  await expect(pick).toHaveAttribute('data-state', 'installed', { timeout: 20_000 })

  const calls = await mlxCalls(page)
  expect(calls.some((c) => c.cmd === 'mlx_image_install_model' && c.id === 'sd-turbo')).toBe(true)
})

test('fresh mac: Create itself offers the setup, and it is the MLX one', async ({ page }) => {
  // The gap MAC-3 left open: the installer existed in Settings, but Create —
  // where the user actually is when they hit the wall — showed an empty stage
  // and a "one-time setup is needed" line with nothing to press. The card the
  // other platforms get was gated on ComfyUI being *down*, and on a Mac that
  // question is never asked, so it could not fire.
  const fresh: TauriMockOptions = {
    ...MAC_OPTS,
    mlx: { engineInstalled: false, videoEngineInstalled: false, installedImages: [], installedVideos: [] },
  }
  await bootLocalCreate(page, fresh)

  const card = page.getByText(/Local image generation needs a one-time setup/i)
  await expect(card).toBeVisible({ timeout: 20_000 })
  // Mac copy, not the ComfyUI bundle copy — no ComfyUI download is promised.
  await expect(page.getByText(/Apple MLX/i).first()).toBeVisible()
  await expect(page.getByText(/ComfyUI/i)).toHaveCount(0)

  await page.getByRole('button', { name: /Download & install/i }).click()

  // Engine first, then the SMALLEST model in the catalog — the setup path
  // must not pull the 4.4 GB one when a 2.6 GB one would do.
  await expect
    .poll(async () => (await mlxCalls(page)).map((c) => c.cmd), { timeout: 30_000 })
    .toContain('mlx_image_install_model')
  const calls = await mlxCalls(page)
  expect(calls.some((c) => c.cmd === 'install_mlx_diffusion')).toBe(true)
  expect(requireCall(calls, 'mlx_image_install_model').id).toBe('sd-turbo')

  // The hard rule: nothing in this flow reaches for ComfyUI.
  expect(await comfyCalls(page)).toHaveLength(0)
})

test('mac: the Model Manager offers MLX media instead of hiding the rails', async ({ page }) => {
  // The Image/Video rails used to be removed on macOS because the grid behind
  // them is ComfyUI-driven and dead there. Removing them left a Mac user with
  // no model surface for media at all — "where do I get models" had no answer
  // in the place that is literally called Models.
  await page.addInitScript(tauriMockInit, MAC_OPTS)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: /^Models$/ }).first().click()
  // A rail carries its installed count, so its name is "Image 1", not "Image".
  await page.locator('aside').getByRole('button', { name: /^Image/ }).click()

  // The rails are the Model Manager's own tiles now (mac-model-manager.spec.ts
  // has the surface itself); what this test holds is that media is offered at
  // all, each kind under its own rail.
  await expect(page.getByTestId('mac-media-image')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-mac-media-tile="sd-turbo"]')).toBeVisible()
  // Video belongs under its own rail, not doubled up in the image one.
  await expect(page.getByText('Wan 2.1 T2V 1.3B', { exact: true })).toHaveCount(0)

  // An official Wan is a mainstream model, so it is there without a switch.
  await page.locator('aside').getByRole('button', { name: /^Video/ }).click()
  await expect(page.getByText('Wan 2.1 T2V 1.3B', { exact: true })).toBeVisible({ timeout: 15_000 })
})

test('windows local is unchanged: ComfyUI lanes still offered', async ({ page }) => {
  // Guard against fixing the Mac by breaking everyone else.
  await bootLocalCreate(page, { ...MAC_OPTS, platform: 'windows' })

  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('radio', { name: 'Remove Background', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Edit / Image to Image', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Animate Image', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Music', exact: true })).toBeVisible()
})

test('windows local is unchanged: Edit and its settings are the ComfyUI ones, and nothing goes to MLX', async ({ page }) => {
  // The Mac got an Edit lane of its own on 08.10.2026. Everything it left
  // out or changed must still be on the Windows surface.
  await bootLocalCreate(page, { ...MAC_OPTS, platform: 'windows' })
  await page.getByRole('radio', { name: 'Edit / Image to Image', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Edit / Image to Image', exact: true })).toBeChecked()
  // The strength slider of the Edit tab stays.
  await expect(page.getByText('Edit strength')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Quality', { exact: true })).toBeVisible()
  await openDrawer(page)
  for (const label of ['Steps', 'CFG scale', 'Batch size']) {
    await expect(drawer(page).getByText(label, { exact: true })).toBeVisible()
  }
  // The Expert section with what ComfyUI takes, mask feather included.
  const expert = drawer(page).getByRole('button', { name: 'Expert', exact: true })
  await expect(expert).toBeVisible()
  if (!(await drawer(page).getByText('Sampler', { exact: true }).isVisible())) await expert.click()
  for (const label of ['Sampler', 'Scheduler', 'Denoise (raw)', 'Mask edge feather', 'VAE', 'Skip CLIP layers']) {
    await expect(drawer(page).getByText(label, { exact: true })).toBeVisible()
  }
  // The LoRA stack is ComfyUI's: its words, no way into a Mac folder, and
  // the Mac's folder is never asked for.
  await expect(drawer(page).getByText(/^LoRA stack/)).toBeVisible()
  await expect(drawer(page).getByRole('button', { name: /Rescan/ })).toHaveAttribute('title', "Re-scan ComfyUI's models/loras folder")
  await expect(drawer(page).getByRole('button', { name: /Open folder/ })).toHaveCount(0)
  expect((await mlxCalls(page)).filter((c) => c.cmd.startsWith('mlx_generate') || c.cmd.startsWith('mlx_lora') || c.cmd === 'video_stage_start_image')).toHaveLength(0)
})

// ── The LoRA stack on the Mac (09.10.2026) ──────────────────────────────
// Windows hands the stack to ComfyUI. The Mac's second image engine takes
// LoRA files itself, from a folder of the app (commands/mlx_loras.rs).

const QWEN_LORAS: NonNullable<TauriMockOptions['mlx']> = {
  installedImages: ['qwen-image-2.1-8bit'],
  mfluxEngineInstalled: true,
  loras: [{ name: 'qwen/detail.safetensors' }, { name: 'slider.safetensors' }, { name: 'unused.safetensors' }],
}

async function openStack(page: Page) {
  await openDrawer(page)
  const expert = drawer(page).getByRole('button', { name: 'Expert', exact: true })
  await expect(expert).toBeVisible({ timeout: 15_000 })
  if (!(await drawer(page).getByText(/^LoRA stack/).isVisible())) await expert.click()
  await expect(drawer(page).getByRole('button', { name: /Rescan/ })).toBeVisible()
}

const savedStack = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('create-store') || '{}').state?.selectedLoras)

test('mac local: a LoRA is added, its strength set, and Generate sends the stack in the order it was picked', async ({ page }) => {
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: QWEN_LORAS })
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await openStack(page)
  // The files of the folder, a subfolder under its path. Nothing of ComfyUI.
  await expect(drawer(page).getByRole('button', { name: /qwen\/detail/ })).toBeVisible()
  await expect(drawer(page).getByRole('button', { name: /unused/ })).toBeVisible()
  await expect(drawer(page).getByText(/ComfyUI/)).toHaveCount(0)
  await expect(drawer(page).getByText(/active/)).toHaveCount(0)

  await drawer(page).getByRole('button', { name: /slider/ }).click()
  await drawer(page).getByRole('button', { name: /qwen\/detail/ }).click()
  await expect(drawer(page).getByText('· 2 active')).toBeVisible()
  // The strength is a number that can be typed, negative included.
  const strength = drawer(page).getByRole('textbox', { name: 'Strength of slider' })
  await expect(strength).toHaveValue('0.80')
  await strength.fill('-4')
  await strength.blur()
  await expect(strength).toHaveValue('-4.00')
  // The field is named after the file, without its folder.
  const detail = drawer(page).getByRole('textbox', { name: 'Strength of detail' })
  await detail.fill('1.25')
  await detail.blur()
  await expect.poll(() => savedStack(page)).toEqual([{ name: 'slider.safetensors', strength: -4 }, { name: 'qwen/detail.safetensors', strength: 1.25 }])
  if (process.env.LU_SHOTS) await page.screenshot({ path: `${process.env.LU_SHOTS}/mac-lora-stack.png` })

  // Open folder shows the Mac's folder in Finder.
  await drawer(page).getByRole('button', { name: /Open folder/ }).click()
  await expect.poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'mlx_loras_open_folder').length).toBe(1)
  await page.keyboard.press('Escape')

  await page.locator('textarea').first().fill('a lighthouse at dusk')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(() => generates(page), { timeout: 30_000 }).toBe(1)
  const gen = requireCall(await mlxCalls(page), 'mlx_generate')
  expect(gen.model).toBe('qwen-image-2.1-8bit')
  expect(gen.raw.loras).toEqual([{ name: 'slider.safetensors', strength: -4 }, { name: 'qwen/detail.safetensors', strength: 1.25 }])
  expect(await comfyCalls(page)).toHaveLength(0)
})

// M12 (14.10.2026): the quantized LTX packs and Wan take `--lora` too. The
// stack in Create is the same one, and a video run sends it.
test('mac local: an LTX video run sends the LoRA stack, and a Kohya file is refused on its row', async ({ page }) => {
  await bootLocalCreate(page, {
    ...MAC_OPTS,
    mlx: { installedVideos: ['ltx-2.3-q4'], ltx2EngineInstalled: true, loras: [{ name: 'ltx/dance.safetensors' }, { name: 'kohya_style.safetensors', keys: 'kohya' }] },
  })
  await page.getByRole('radio', { name: 'Video', exact: true }).click()
  await openStack(page)
  await expect(drawer(page).getByTestId('lora-stack-refused')).toContainText('Kohya format')
  await drawer(page).getByRole('button', { name: /ltx\/dance/ }).click()
  await expect(drawer(page).getByText('· 1 active')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.locator('textarea').first().fill('a dancer on a rooftop at night')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'video_generate').length, { timeout: 40_000 })
    .toBeGreaterThan(0)
  const gen = requireCall(await mlxCalls(page), 'video_generate')
  expect(gen.id).toBe('ltx-2.3-q4')
  expect(gen.raw.loras).toEqual([{ name: 'ltx/dance.safetensors', strength: 0.8 }])
  expect(await comfyCalls(page)).toHaveLength(0)
})

// GitHub discussion #150: long LoRA names were cut off at the drawer's width.
// The Mac's stack has the same rows, and one more kind: a file the run would
// refuse. Both show the whole name.
test('mac local: LoRA names that differ only at their end are readable in full, a refused file included', async ({ page }) => {
  const twins = [
    'qwen_image_cinematic_portrait_lighting_detail_enhancer_v2_epoch_08_rank32',
    'qwen_image_cinematic_portrait_lighting_detail_enhancer_v2_epoch_12_rank64',
  ]
  const kohya = 'qwen_image_cinematic_portrait_lighting_detail_enhancer_v1_kohya_export_rank16'
  // Tall enough that the whole stack is in the picture.
  await page.setViewportSize({ width: 1280, height: 1100 })
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { ...QWEN_LORAS, loras: [...twins.map((n) => ({ name: `${n}.safetensors` })), { name: `${kohya}.safetensors`, keys: 'kohya' as const }] } })
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await openStack(page)
  await drawer(page).getByRole('button', { name: twins[1] }).click()
  await expect(drawer(page).getByText('· 1 active')).toBeVisible()
  await expect(drawer(page).getByTestId('lora-stack-refused')).toBeVisible()
  await drawer(page).getByTestId('lora-stack-refused').scrollIntoViewIfNeeded()
  if (process.env.LU_SHOTS) {
    // The Expert group is still unfolding: the picture waits, the checks below do not need to.
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${process.env.LU_SHOTS}/mac-lora-names-${process.env.LU_SHOT_TAG ?? 'after'}.png` })
  }
  for (const name of [...twins, kohya]) {
    const whole = await drawer(page).getByText(name, { exact: true }).evaluate((el) => {
      const side = el.closest('aside') as HTMLElement
      return getComputedStyle(el).textOverflow !== 'ellipsis' && el.scrollWidth <= el.clientWidth + 1
        && el.getBoundingClientRect().right <= side.getBoundingClientRect().right
    })
    expect(whole, `${name} is cut off`).toBe(true)
  }
  await expect(drawer(page).getByRole('textbox', { name: `Strength of ${twins[1]}` })).toHaveValue('0.80')
})

test('mac local: untick takes a LoRA out, a file gone from the folder leaves the stack, and a run without a stack sends none', async ({ page }) => {
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: QWEN_LORAS })
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await openStack(page)
  await drawer(page).getByRole('button', { name: /slider/ }).click()
  await drawer(page).getByRole('button', { name: /unused/ }).click()
  await expect(drawer(page).getByText('· 2 active')).toBeVisible()
  // Untick: the row stays, the LoRA is out.
  await drawer(page).getByRole('button', { name: /unused/ }).click()
  await expect(drawer(page).getByText('· 1 active')).toBeVisible()
  await expect.poll(() => savedStack(page)).toEqual([{ name: 'slider.safetensors', strength: 0.8 }])

  // The file is deleted in Finder. Rescan reads the folder again.
  await page.evaluate(() => {
    const w = window as unknown as { __E2E_MLX_LORAS__: Array<{ name: string }> }
    w.__E2E_MLX_LORAS__ = w.__E2E_MLX_LORAS__.filter((l) => l.name !== 'slider.safetensors')
  })
  await drawer(page).getByRole('button', { name: /Rescan/ }).click()
  await expect(drawer(page).getByRole('button', { name: /slider/ })).toHaveCount(0)
  await expect(drawer(page).getByText(/active/)).toHaveCount(0)
  await expect.poll(() => savedStack(page)).toEqual([])
  await page.keyboard.press('Escape')

  await page.locator('textarea').first().fill('a lighthouse at dusk')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(() => generates(page), { timeout: 30_000 }).toBe(1)
  expect(requireCall(await mlxCalls(page), 'mlx_generate').raw.loras).toBeUndefined()
})

test('mac local: Turbo, an edit and a batch each carry the stack', async ({ page }) => {
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { ...QWEN_LORAS, installedImages: ['qwen-image-2.1-turbo'] } })
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await openStack(page)
  await drawer(page).getByRole('button', { name: /qwen\/detail/ }).click()
  await expect(drawer(page).getByText('· 1 active')).toBeVisible()
  // A batch of two: one run per image, each with the stack.
  await slider(page, 'Batch size').fill('2')
  await page.keyboard.press('Escape')
  await page.locator('textarea').first().fill('a lighthouse at dusk')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(() => generates(page), { timeout: 30_000 }).toBe(2)
  const STACK = [{ name: 'qwen/detail.safetensors', strength: 0.8 }]
  let runs = (await mlxCalls(page)).filter((c) => c.cmd === 'mlx_generate')
  expect(runs.map((c) => c.model)).toEqual(['qwen-image-2.1-turbo', 'qwen-image-2.1-turbo'])
  expect(runs.map((c) => c.raw.loras)).toEqual([STACK, STACK])
  // Turbo's own adapter is the engine's business: the request names no steps.
  expect(runs[0].steps).toBeUndefined()

  // Edit keeps its own picks (B24): none until one is ticked there, then
  // the same stack goes out with the image.
  await page.getByRole('radio', { name: 'Edit / Image to Image', exact: true }).click()
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'car.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
  await openStack(page)
  await expect(drawer(page).getByText('· 1 active')).toHaveCount(0)
  await drawer(page).getByRole('button', { name: /qwen\/detail/ }).click()
  await expect(drawer(page).getByText('· 1 active')).toBeVisible()
  await slider(page, 'Batch size').fill('1')
  await page.keyboard.press('Escape')
  await page.locator('textarea').first().fill('make the car blue')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(() => generates(page), { timeout: 30_000 }).toBe(3)
  runs = (await mlxCalls(page)).filter((c) => c.cmd === 'mlx_generate')
  expect(runs[2].raw.images).toHaveLength(1)
  expect(runs[2].raw.loras).toEqual(STACK)
})

test('mac local: a model of the first image engine gets no LoRA stack and is sent none', async ({ page }) => {
  // SD Turbo runs in the diffusers sidecar, which has no place for a LoRA. A
  // stack left over from another model must not ride along.
  await page.addInitScript(() => {
    if (localStorage.getItem('create-store')) return
    localStorage.setItem('create-store', JSON.stringify({
      state: { backend: 'local', selectedLoras: [{ name: 'slider.safetensors', strength: 0.8 }] },
      version: 2,
    }))
  })
  await bootLocalCreate(page, { ...MAC_OPTS, mlx: { ...QWEN_LORAS, engineInstalled: true, installedImages: ['sd-turbo'] } })
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await openDrawer(page)
  await expect(drawer(page).getByText('Steps', { exact: true })).toBeVisible()
  await expect(drawer(page).getByRole('button', { name: 'Expert', exact: true })).toHaveCount(0)
  await expect(drawer(page).getByText(/LoRA stack/)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.locator('textarea').first().fill('a red apple')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(() => generates(page), { timeout: 30_000 }).toBe(1)
  const gen = requireCall(await mlxCalls(page), 'mlx_generate')
  expect(gen.model).toBe('sd-turbo')
  expect(gen.raw.loras).toBeUndefined()
})

test('mac settings: Local Media names the LoRA folder and opens it', async ({ page }) => {
  await page.addInitScript(tauriMockInit, {
    ...MAC_OPTS,
    mlx: { engineInstalled: true, videoEngineInstalled: true, installedImages: ['sd-turbo'], loras: [{ name: 'a.safetensors' }, { name: 'b.safetensors' }] },
  })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Settings$/ }).click()
  await page.getByRole('button', { name: /AI Backends/i }).click()
  await page.getByRole('button', { name: /Local Media \(Apple MLX\)/i }).click()
  const row = page.getByTestId('mlx-media-settings').locator('[data-mlx-row="loras"]')
  await expect(row).toContainText('2 LoRAs in this folder')
  await expect(row).toContainText('/tmp/lu-e2e/loras')
  await row.getByRole('button', { name: /Open folder/ }).click()
  await expect.poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'mlx_loras_open_folder').length).toBe(1)
})

test('mac: saving the HuggingFace token in Settings pushes it to Rust', async ({ page }) => {
  // #160: without a token every hub download is anonymous and throttled.
  // Saving in Settings must arm Rust immediately, and the recorded call may
  // only say that a token is present, never echo the value.
  await page.addInitScript(tauriMockInit, MAC_OPTS)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: /^Settings$/ }).click()
  await page.getByRole('button', { name: /AI Backends/i }).click()
  // 2.6.8: the field left the Mac media panel for a section of its own that
  // every platform has, because the GGUF downloader sends the token now too.
  await page.getByRole('button', { name: 'Hugging Face token', exact: true }).click()

  await page.getByLabel('Hugging Face token').fill('hf_e2e_probe')
  await page.getByRole('button', { name: /^Save$/ }).click()
  await expect(page.getByRole('button', { name: /Saved/i })).toBeVisible({ timeout: 10_000 })

  expect(await hfToken(page)).toBe('hf_e2e_probe')

  const call = requireCall(await mlxCalls(page), 'set_hf_token')
  expect(call.present).toBe(true)
  // Against the UNPARSED record: a leak in a field this file does not model
  // would be invisible in the parsed projection, and the check would pass on
  // nothing. `raw` is exactly what the page pushed.
  expect(JSON.stringify(call.raw)).not.toContain('hf_e2e_probe')
})

test('mac: a stored token reaches Rust at boot, without opening Settings', async ({ page }) => {
  // The keychain is the store of record and Rust holds the token in memory
  // only, so a fresh app start must push it down again on its own. If it did
  // not, a download started straight from Create or the Model Manager would
  // still go out anonymous.
  await page.addInitScript(tauriMockInit, MAC_OPTS)
  await page.addInitScript(() => {
    ;(window as unknown as { __E2E_SECRETS__: Record<string, string> }).__E2E_SECRETS__ = {
      'huggingface-token': 'hf_boot_probe',
    }
  })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })

  await expect.poll(() => hfToken(page), { timeout: 15_000 }).toBe('hf_boot_probe')
})
