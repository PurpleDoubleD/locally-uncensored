import { test, expect, type Page } from '@playwright/test'
import { bootWithFakeComfy } from './support/fake-comfy'
import { gradientPng } from './support/png'

/**
 * Mod report of 05.11. (3.0.9, desktop): "It has a prompt already loaded and
 * I've tried to change it. Selected just cancels my keyboard." Image, Image to
 * Video and the others. A prompt that is already in the field is selected
 * (all keys, a double click, a drag, a triple click) and typed over. The keys
 * belong to the field also while the gallery shows a result or has several
 * pictures selected (its own Ctrl+A, D3).
 */

const CK = 'juggernautXL.safetensors'
const item = (i: number) => ({
  id: `g${i}`, type: 'image', filename: `apple_0000${i}_.png`, subfolder: '', prompt: `an apple ${i}`, negativePrompt: '',
  model: CK, modelType: 'sdxl', seed: 7, steps: 20, cfgScale: 7, sampler: 'euler', scheduler: 'simple',
  width: 1024, height: 1024, batchSize: 1, createdAt: Date.now() - i * 1000,
})

async function typeOver(page: Page) {
  const field = page.locator('textarea').first()
  await field.fill('a cat on a roof at night')
  await page.mouse.click(5, 300)

  await field.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('a dog')
  await expect(field).toHaveValue('a dog')
  await expect(field).toBeFocused()

  await field.fill('a cat on a roof')
  await field.dblclick()
  await page.keyboard.type('one')
  // One word was selected and replaced; which one depends on the font.
  await expect(field).toHaveValue(/one/)
  expect((await field.inputValue()).split(' ').length).toBe(5)

  const b = (await field.boundingBox())!
  await page.mouse.move(b.x + 4, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width - 10, b.y + b.height / 2, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.type('a horse')
  await expect(field).toHaveValue('a horse')

  await field.click({ clickCount: 3 })
  await page.keyboard.press('Backspace')
  await page.keyboard.type('a bird')
  await expect(field).toHaveValue('a bird')
  await expect(field).toBeFocused()
}

test('a prompt already in the field can be selected and typed over, with and without gallery picks', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.addInitScript((g) => {
    localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local', imageModel: 'juggernautXL.safetensors', gallery: g }, version: 2 }))
  }, [item(1), item(2), item(3)])
  await bootWithFakeComfy(page, { checkpoints: [CK], loras: [], imageModel: CK })
  const png = gradientPng(256, 256)
  await page.route('**/view?**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }))
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
  await typeOver(page)

  const tiles = page.locator('[data-gallery-id]')
  if (await tiles.count() === 0) await page.getByRole('button', { name: 'Open the gallery' }).click()
  await expect(tiles).toHaveCount(3)
  await tiles.first().click()
  await typeOver(page)

  await tiles.nth(1).click({ modifiers: ['ControlOrMeta'] })
  await tiles.nth(2).click({ modifiers: ['ControlOrMeta'] })
  await expect(page.locator('[data-gallery-id][aria-pressed="true"]')).toHaveCount(2)
  await typeOver(page)

  for (const tab of ['Video', 'Animate Image']) {
    await page.getByRole('radio', { name: tab, exact: true }).click()
    await typeOver(page)
  }
})
