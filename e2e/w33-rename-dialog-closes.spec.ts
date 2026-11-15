import { test, expect } from '@playwright/test'
import { bootWithFakeComfy } from './support/fake-comfy'

/**
 * W33 (15.11.2026): in the hidden test window of the Mac the "Rename and
 * note" dialog was still in the page after Save, when the next dialog opened.
 * The suspicion was its closing animation, which a hidden window never plays
 * to the end. Here the window is a real one with animations running, in
 * Chromium and in WebKit (the engine of the Mac app): after Save the dialog
 * is gone and the row shows the new name.
 */

const FILE = 'w33_detail_tweaker_xl.safetensors'

test('Save closes the Rename and note dialog of a LoRA, from the right click and from the pencil', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await bootWithFakeComfy(page, { checkpoints: ['juggernautXL.safetensors'], loras: [FILE], imageModel: 'juggernautXL.safetensors' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  await page.getByRole('button', { name: /^LoRAs/ }).click()
  await page.getByRole('button', { name: /^Installed/ }).click()

  const dialog = page.getByRole('dialog', { name: 'Rename and note' })

  // Right click on the row, Rename…, Save.
  await page.getByText('w33_detail_tweaker_xl', { exact: false }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Rename/ }).click()
  await expect(dialog).toBeVisible()
  await page.getByTestId('lora-edit-name').fill('Detail Tweaker')
  await page.getByTestId('lora-edit-save').click()
  await expect(dialog).toHaveCount(0, { timeout: 2000 })
  await expect(page.getByText('Detail Tweaker', { exact: true }).first()).toBeVisible()
  if (process.env.LU_SHOTS) await page.screenshot({ path: `${process.env.LU_SHOTS}/w33-after-save-${test.info().project.name}.png` })

  // The pencil opens it again with the stored name; Save closes it again.
  await page.getByRole('button', { name: `Rename ${FILE}` }).first().click()
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('lora-edit-name')).toHaveValue('Detail Tweaker')
  await page.getByTestId('lora-edit-name').fill('Detail Tweaker 2')
  await page.getByTestId('lora-edit-save').click()
  await expect(dialog).toHaveCount(0, { timeout: 2000 })
  await expect(page.getByText('Detail Tweaker 2', { exact: true }).first()).toBeVisible()
})
