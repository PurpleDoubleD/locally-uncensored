import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'
import { characterPill, openCharacterTraining } from './support/character-hub'

/**
 * "Use frames for a character" (Discord): frames taken evenly across a
 * generated video, or picked by hand, start a training set in Character
 * Studio or become a named character that is kept on this machine. The frames
 * are real: Chromium decodes a small clip and the canvas reads them. The
 * character survives a reload and starts a training set with one click.
 */

// One second of a 64x64 test pattern, VP8 in WebM (about 3 KB).
const CLIP = Buffer.from('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', 'base64')
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }

const VIDEO_ITEM = {
  id: 'job-video-1', type: 'video', filename: 'clip.webm', subfolder: '', prompt: 'a knight walks through fog',
  negativePrompt: '', model: 'wan-2.2-720p', modelType: 'wan', seed: 7, steps: 20, cfgScale: 5, sampler: '', scheduler: '',
  width: 64, height: 64, batchSize: 1, createdAt: 1_760_000_000_000,
  remoteUrl: 'https://lu-labs.ai/e2e/clip.webm', jobId: 'job-video-1', intent: 'video',
}

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  // A finished cloud video in the gallery, as a persisted session leaves it.
  await page.addInitScript((item) => {
    if (!window.localStorage.getItem('create-store')) {
      window.localStorage.setItem('create-store', JSON.stringify({ state: { gallery: [item] }, version: 2 }))
    }
  }, VIDEO_ITEM)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.route('https://lu-labs.ai/e2e/clip.webm', (route) =>
    route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'video/webm' }, body: CLIP }))
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
}

async function intoCloudCreate(page: Page) {
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
}

/** Open the gallery and show its video in the large view. */
async function showVideo(page: Page) {
  await page.getByRole('radio', { name: /^Video$/ }).click()
  await page.getByRole('button', { name: 'Open the gallery' }).click()
  await page.locator('aside button:has(video)').click()
}

test('frames across a video become a saved character that survives a reload', async ({ page }) => {
  await boot(page)
  await intoCloudCreate(page)

  // The action sits on the video in the large view.
  await showVideo(page)
  await page.getByTitle('Use frames of this video for a character').click({ force: true })
  const dialog = page.getByRole('dialog', { name: 'Use frames for a character' })
  await expect(dialog).toBeVisible()

  // Eight frames across the clip, on their own, all ticked.
  const frames = dialog.getByTestId('character-frames').locator('img')
  await expect(frames).toHaveCount(8, { timeout: 20_000 })
  await expect(dialog.getByTestId('frames-picked')).toContainText('8 of 8 frames ticked.')
  // A frame is a real picture of the video's size.
  const size = await frames.first().evaluate(
    (img: HTMLImageElement) => img.decode().then(() => [img.naturalWidth, img.naturalHeight]),
  )
  expect(size).toEqual([64, 64])

  // Four instead, one of them left out, plus one added by hand.
  await dialog.getByLabel('Frames across the clip').fill('4')
  await dialog.getByRole('button', { name: 'Take 4 frames' }).click()
  await expect(frames).toHaveCount(4, { timeout: 20_000 })
  await dialog.getByRole('button', { name: 'Untick frame 3' }).click()
  await dialog.getByRole('button', { name: 'Add this frame' }).click()
  await expect(frames).toHaveCount(5)
  await expect(dialog.getByTestId('frames-picked')).toContainText('4 of 5 frames ticked.')

  await dialog.getByLabel('Character name').fill('Sir Aldous')
  await dialog.getByRole('button', { name: 'Save character' }).click()
  await expect(dialog.getByTestId('character-saved')).toContainText('Saved Sir Aldous with 4 photos. It is kept on this computer.')

  // Hand the photos to Character Studio: they start the training set.
  await dialog.getByRole('button', { name: 'Train in Character Studio' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(characterPill(page)).toBeChecked()
  await expect(page.locator('[data-hub-training]')).toContainText('Train a model')
  await expect(page.locator('[data-hub-train-photos="4"]')).toBeVisible()

  // After a reload the character is still there (the boot script puts the app
  // back into local mode, and the character is local anyway). One click adds
  // its photos to the local training set.
  await page.reload()
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
  await openCharacterTraining(page)
  const chip = page.getByTitle('Add the 4 photos of Sir Aldous')
  await expect(chip).toBeVisible({ timeout: 15_000 })
  await chip.click()
  await expect(page.locator('[data-hub-train-photos="4"]')).toBeVisible()
})

test('the lightbox of a video offers the same action, straight into a training set', async ({ page }) => {
  await boot(page)
  await intoCloudCreate(page)
  await showVideo(page)
  await page.getByTitle('Fullscreen').click({ force: true })
  await page.getByRole('button', { name: 'Use frames for a character', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Use frames for a character' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('character-frames').locator('img')).toHaveCount(8, { timeout: 20_000 })
  await dialog.getByRole('button', { name: 'Untick frame 1' }).click()
  await dialog.getByRole('button', { name: 'Train with 7 frames' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(characterPill(page)).toBeChecked()
  await expect(page.locator('[data-hub-train-photos="7"]')).toBeVisible()
})
