import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch, type CloudScenario } from './support/cloud-mock'

/**
 * 2.5.7 cloud create — hosted rendering through the global Cloud mode.
 *
 * (a) happy path: prompt → POST /api/jobs → poll → succeeded → the result
 *     lands in the gallery strip; the credits meter is visible; the
 *     cloud-only utility intents (Upscale/Erase) are offered.
 * (b) media_live:false from the catalog → generate degrades to the honest
 *     "coming soon" error instead of submitting.
 */

async function bootIntoCloudCreate(page: Page, scenario: CloudScenario) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await routeCloud(page, scenario)
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
}

test('cloud render: submit → poll → gallery, meter + utility intents present', async ({ page }) => {
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: true })

  // Cloud-only utility intents are offered on the cloud backend.
  // R5-67 renamed the upscale label to "Enhance Image" (parity with web);
  // the id stays 'upscale', only the visible text changed.
  await expect(page.getByRole('radio', { name: /Enhance Image/i })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('radio', { name: /Erase Object/i })).toBeVisible()

  // Credits meter reflects the mocked quota (remaining = 2,550,000 − 12,345).
  await expect(page.getByText('2537655')).toBeVisible()

  const composer = page.locator('textarea').first()
  await composer.fill('a lighthouse at dusk, cinematic')
  await page.getByRole('button', { name: /^Create$/ }).last().click()

  // The mocked job succeeds on the first poll; the image lands in the gallery.
  // Cloud results keep their remote signed URL (no base64 persistence).
  await expect(page.locator('img[src*="/e2e/result.png"]').first()).toBeVisible({ timeout: 30_000 })
})

test('the cloud picker prices every model, the meter counts runs (2.6.3)', async ({ page }) => {
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: true })

  // Image intent: the meter translates the balance into runs of the picked
  // model (flux-schnell at 300 credits → 2,537,655 / 300).
  await expect(page.getByText('≈8458 images')).toBeVisible({ timeout: 15_000 })

  // Every cloud picker option carries its wallet draw as a sublabel.
  await page.locator('button[aria-haspopup="listbox"]').last().click()
  await expect(page.getByRole('option', { name: /Flux Schnell/ })).toContainText('300 cr')
  await expect(page.getByRole('option', { name: /Flux Dev/ })).toContainText('1,200 cr')
  await page.keyboard.press('Escape')

  // Video intent: the mocked quota carries the 300k monthly video budget, so
  // the meter counts against the sub-budget (300,000 / 40,000), not the pool.
  await page.getByRole('radio', { name: /^Video$/ }).click()
  await expect(page.getByText('≈7 clips')).toBeVisible({ timeout: 15_000 })
  await page.locator('button[aria-haspopup="listbox"]').last().click()
  await expect(page.getByRole('option', { name: /Wan 2\.2 720p/ })).toContainText('40k cr')
  await page.keyboard.press('Escape')
})

test('ops start EMPTY and adopt a gallery image only on explicit pick', async ({ page }) => {
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: true })

  // Render once so the gallery holds an image the old auto-adopt would grab.
  const composer = page.locator('textarea').first()
  await composer.fill('a lighthouse at dusk, cinematic')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect(page.locator('img[src*="/e2e/result.png"]').first()).toBeVisible({ timeout: 30_000 })

  // Switching to Edit must NOT auto-adopt the gallery image (2026-07-10):
  // the stage shows the empty input slot with the explicit gallery pick strip.
  // (2.6.0 label: "Edit / Image to Image".)
  await page.getByRole('radio', { name: /Edit \/ Image to Image/i }).click()
  await expect(page.getByText(/Drop an image to edit/i)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/or pick from your gallery/i)).toBeVisible()

  // Explicit pick adopts the image as the op source (source preview appears).
  await page.getByRole('button', { name: /Use this gallery image as the source/i }).first().click()
  await expect(page.getByRole('button', { name: /Paint mask/i })).toBeVisible({ timeout: 15_000 })
})

test('local mode: local lanes usable, cloud-only ops shown as locked teasers', async ({ page }) => {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()

  // Local-capable lanes carry their plain label. Since 2.5.8/2.5.9 that
  // includes edit, animate (restored 2026-07-17) and the four specialized
  // categories with hasLocalLane — NOT just image/video/removebg.
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('radio', { name: 'Video', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Remove Background', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Edit / Image to Image', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Animate Image', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Music', exact: true })).toBeVisible()

  // Character Studio joined the local lanes in 2.6.0 (musubi trainer ships
  // in trainer.rs), so it renders as a plain selectable tab now.
  // Since 3.1.0 part B it is the Character area, one pill for four tabs.
  await expect(page.getByRole('radiogroup', { name: 'Create mode' }).getByRole('radio', { name: 'Character', exact: true })).toBeVisible()

  // Enhance Image runs on local ComfyUI on Windows and Linux since 3.0.7
  // (Discord wish D10), so it is a plain local tab here, not a teaser.
  await expect(page.getByRole('radio', { name: 'Enhance Image', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Enhance Image, runs on LU Cloud' })).toHaveCount(0)

  // cloudOnly WITHOUT a local lane (eraser) renders locked: aria-label gains
  // ", runs on LU Cloud" and a click opens the teaser instead of switching
  // the lane.
  await expect(page.getByRole('radio', { name: 'Erase Object, runs on LU Cloud' })).toBeVisible()

  await page.getByRole('radio', { name: 'Erase Object, runs on LU Cloud' }).click()
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeChecked()
})

test('media_live=false: generate shows the honest coming-soon message', async ({ page }) => {
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: false })

  const composer = page.locator('textarea').first()
  await composer.fill('a lighthouse at dusk, cinematic')
  await page.getByRole('button', { name: /^Create$/ }).last().click()

  await expect(page.getByText(/coming soon/i)).toBeVisible({ timeout: 15_000 })
})
