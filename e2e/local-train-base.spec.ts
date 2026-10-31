import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * GH #210 (31.10.2026, Linux, 3.0.8): on Train new the model chip still listed
 * every image model, and a tester picked Qwen-Image 2.1 as the training model.
 * The local trainer trains on Z-Image Base alone, so on Windows and Linux the
 * chip now says so and offers no list. Use character gets the picker back.
 * LU_SHOTS=<folder> writes the screenshot there.
 */
const SHOTS = process.env.LU_SHOTS

test('Windows, Train new: the chip says local training uses Z-Image, Use character keeps the picker', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(() => {
    if (!localStorage.getItem('create-store')) {
      localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local', imageModel: 'qwen_image_2.1_fp8.safetensors' }, version: 2 }))
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: 'Character Studio', exact: true }).click()
  await page.getByRole('radio', { name: 'Train new' }).click()

  const chip = page.getByTestId('local-train-base')
  await expect(chip).toHaveText('Local training uses Z-Image')
  await expect(chip).toHaveAttribute('title', /Training for other models is in LU Cloud/)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/p8-b210-1-train-chip.png` })

  await page.getByRole('radio', { name: 'Use character' }).click()
  await expect(page.getByTestId('local-train-base')).toHaveCount(0)
})
