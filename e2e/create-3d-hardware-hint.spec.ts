import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * Local 3D on a PC with an 8 GB card (3.1.1, W40): the 3D tab says before the
 * setup that TRELLIS.2 asks for 12 GB, in one line above the stage, and the
 * setup stays offered. Anlass: an RX 6600 with 8 GB that waited long and then
 * failed in a loader.
 */
test('an 8 GB card: the 3D tab says so before the setup, and the setup stays', async ({ page }) => {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
    platform: 'windows',
    invokeOverrides: {
      detect_gpus: [{ index: 0, vendor: 'AMD', name: 'AMD Radeon RX 6600', memory_mib: 8192, source: 'registry' }],
    },
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).first().click()
  await page.getByRole('radio', { name: /3D/ }).first().click()

  const line = page.getByTestId('three-d-hardware')
  await expect(line).toHaveText('Local 3D needs a graphics card with 12 GB or more. Yours has 8 GB.', { timeout: 15_000 })
  await expect(page.getByTestId('three-d-hardware-cloud')).toHaveText('Use a LU Cloud 3D model instead.')
  await expect(page.getByRole('heading', { name: 'Local 3D needs a one-time download' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Local image generation/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Download & install' })).toBeEnabled()
  await page.screenshot({ path: 'test-results/three-d-hardware-hint.png' })
})
