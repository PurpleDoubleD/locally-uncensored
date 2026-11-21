import { test, expect, type Page } from '@playwright/test'
import { PNG, bootLocal, type Graph, type TrainerState } from './support/character-local'
import { openCharacterHub } from './support/character-hub'

/** Screens of the Character area for David's review (LU_V2_SHOTS=<folder>). */
const DIR = process.env.LU_V2_SHOTS

async function shoot(page: Page, name: string) {
  if (!DIR) return
  for (const t of ['dark', 'light'] as const) {
    await page.evaluate((x) => { document.documentElement.classList.toggle('dark', x === 'dark'); document.documentElement.classList.toggle('light', x === 'light') }, t)
    await page.waitForTimeout(250)
    await page.screenshot({ path: `${DIR}/${name}-${t}.png` })
  }
  await page.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.classList.remove('light') })
}

async function newWithPhotos(page: Page) {
  await page.locator('[data-hub-new]').click()
  await page.locator('input[aria-label="Photos or a LoRA file"]').setInputFiles(Array.from({ length: 9 }, (_, i) => ({ name: `f-${i}.png`, mimeType: 'image/png', buffer: PNG })))
  await page.locator('[data-hub-new-name]').fill('Mara')
}

for (const trainer of ['none', 'bases', 'ready'] as TrainerState[]) {
  test(`shots: train ${trainer}`, async ({ page }) => {
    test.skip(!DIR, 'set LU_V2_SHOTS')
    await bootLocal(page, { trainer })
    await openCharacterHub(page)
    await expect(page.locator('[data-hub-new]')).toBeVisible({ timeout: 15_000 })
    await newWithPhotos(page)
    if (trainer === 'none') await shoot(page, 'new-character')
    await page.locator('[data-hub-way="train"]').click()
    await page.getByRole('button', { name: 'Continue to training' }).click()
    await expect(page.locator('[data-hub-training]')).toBeVisible()
    await page.waitForTimeout(500)
    await shoot(page, `train-${trainer}`)
  })
}

test('shots: cloud sheet and motion without model', async ({ page }) => {
  test.skip(!DIR, 'set LU_V2_SHOTS')
  await bootLocal(page, { videoModels: false })
  await openCharacterHub(page)
  await expect(page.locator('[data-hub-new]')).toBeVisible({ timeout: 15_000 })
  await page.locator('[data-hub-action="motion"]').click()
  await page.waitForTimeout(500)
  await shoot(page, 'motion-no-model')
  await page.locator('[data-hub-action="talk"]').click()
  await page.waitForTimeout(500)
  await shoot(page, 'talk-no-model')
  await page.locator('[data-hub-action="image"]').click()
})

const axis = async (page: Page) => { const w = (await page.locator('[data-character-hub]').boundingBox())!; return w.x + w.width / 2 }
const posted = (page: Page) => page.evaluate(() => (window as unknown as { __PROMPTS__: string[] }).__PROMPTS__.map((p) => (JSON.parse(p) as { prompt: unknown }).prompt)) as Promise<Graph[]>
const onTop = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => {
  const r = el.getBoundingClientRect()
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
  return r.width > 4 && !!hit && (hit === el || el.contains(hit))
})

test('New character: on the middle axis of the page before it, no scrollbar, air around the last line', async ({ page }) => {
  await bootLocal(page)
  await openCharacterHub(page)
  await expect(page.locator('[data-hub-new]')).toBeVisible({ timeout: 15_000 })
  await newWithPhotos(page)
  const mid = await axis(page)
  const box = (await page.locator('.hub-new').boundingBox())!
  expect(Math.abs(box.x + box.width / 2 - mid)).toBeLessThanOrEqual(1)
  const cols = await page.locator('.hub-new').evaluate((el) => [...el.children].map((c) => c.getBoundingClientRect()).map((r) => [r.left, r.right]))
  // The gap between the two columns lies on the axis.
  expect(Math.abs((cols[0][1] + cols[1][0]) / 2 - mid)).toBeLessThanOrEqual(1)
  // Nothing of the window under an unsaved character, the line is said once.
  await expect(page.locator('[data-prompt-window], [data-hub-actions], [data-hub-local-line]')).toHaveCount(0)
  await expect(page.getByText('Save the character first.')).toHaveCount(0)
  await expect(page.locator('[data-hub-after]')).toHaveCount(1)
  const room = (await page.locator('.hub-new-scroll').boundingBox())!
  const block = (await page.locator('.hub-new-scroll > .hub-center').boundingBox())!
  expect(Math.abs((block.y + block.height / 2) - (room.y + room.height / 2))).toBeLessThanOrEqual(2)
  const m = await page.locator('.hub-new-scroll').evaluate((el) => ({ bar: (el as HTMLElement).offsetWidth - el.clientWidth, over: el.scrollHeight - el.clientHeight }))
  expect(m.bar).toBe(0)
  expect(m.over).toBeLessThanOrEqual(0)
  const way = (await page.locator('[data-hub-way="train"]').boundingBox())!
  const after = (await page.locator('[data-hub-after]').boundingBox())!
  expect(after.y - (way.y + way.height)).toBeGreaterThanOrEqual(20)
})

test('Train: one clear next step, its button on top; back keeps photos, name, word and descriptions', async ({ page }) => {
  await bootLocal(page, { trainer: 'none' })
  await openCharacterHub(page)
  await expect(page.locator('[data-hub-new]')).toBeVisible({ timeout: 15_000 })
  await newWithPhotos(page)
  await page.locator('[data-hub-way="train"]').click()
  await page.getByRole('button', { name: 'Continue to training' }).click()
  await expect(page.locator('[data-hub-train-title]')).toHaveText('Set up the trainer')
  await expect(page.locator('[data-hub-train-steps]')).toHaveAttribute('data-hub-train-steps', 'trainer')
  const main = page.getByRole('button', { name: 'Set up trainer' })
  await expect(main).toBeVisible()
  expect((await main.boundingBox())!.height).toBeGreaterThanOrEqual(38)
  expect(await onTop(page, 'button:has-text("Set up trainer")')).toBe(true)
  // Nothing else offers to start: no window, no row of actions.
  await expect(page.locator('[data-prompt-window], [data-hub-actions]')).toHaveCount(0)
  await expect(page.getByTestId('trainer-download-line')).toContainText('about 2.9 GB')
  await expect(page.locator('[data-hub-train-photos]')).toHaveAttribute('data-hub-train-photos', '9')
  // One photo less on this page: the way back brings that state.
  await page.locator('[data-hub-train-photos] .hub-train-photo').first().hover()
  await page.locator('[data-hub-train-photos] .hub-train-photo button').first().click()
  await page.locator('[data-hub-back]').click()
  await expect(page.locator('[data-character-hub]')).toHaveAttribute('data-character-hub', 'new')
  await expect(page.locator('[data-hub-photos]')).toHaveAttribute('data-hub-photos', '8')
  await expect(page.locator('[data-hub-new-name]')).toHaveValue('Mara')
  await expect(page.locator('[data-hub-way="train"]')).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('button', { name: 'Continue to training' }).click()
  await expect(page.locator('[data-hub-train-photos]')).toHaveAttribute('data-hub-train-photos', '8')
})

test('Train ready: the word is a labelled field, the window button starts the training', async ({ page }) => {
  await bootLocal(page, { trainer: 'ready' })
  await openCharacterHub(page)
  await expect(page.locator('[data-hub-new]')).toBeVisible({ timeout: 15_000 })
  await newWithPhotos(page)
  await page.locator('[data-hub-way="train"]').click()
  await page.getByRole('button', { name: 'Continue to training' }).click()
  await expect(page.locator('[data-hub-train-title]')).toHaveText('Ready to train')
  const word = page.getByRole('textbox', { name: 'Trigger word' })
  await expect(word).toHaveValue('Mara')
  await word.fill('maraface')
  await page.locator('[data-hub-back]').click()
  await page.getByRole('button', { name: 'Continue to training' }).click()
  await expect(page.getByRole('textbox', { name: 'Trigger word' })).toHaveValue('maraface')
  const start = page.getByRole('button', { name: 'Start training' })
  await expect(start).toBeEnabled()
  await expect(page.locator('[data-prompt-window], [data-hub-actions]')).toHaveCount(0)
  // Directly under the settings, above the folded options and the photos.
  const memory = (await page.locator('[data-hub-train-row="Graphics memory"]').boundingBox())!
  const b = (await start.boundingBox())!
  expect(b.y).toBeGreaterThan(memory.y + memory.height - 1)
  expect(b.y - (memory.y + memory.height)).toBeLessThanOrEqual(24)
  await expect(page.getByText('Local training uses Z-Image')).toBeHidden()
})

test('Image with a photo character runs inside the Character area, no second line, no way to Edit', async ({ page }) => {
  await bootLocal(page)
  await openCharacterHub(page)
  await expect(page.locator('[data-hub-new]')).toBeVisible({ timeout: 15_000 })
  await newWithPhotos(page)
  await page.getByRole('button', { name: 'Save Mara' }).click()
  await expect(page.locator('[data-hub-from-photos]')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-character-hub]')).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Edit / Image to Image', exact: true })).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByRole('radiogroup', { name: 'Create mode' }).getByRole('radio', { name: 'Character', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('[data-hub-action="image"]')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('button', { name: 'Continue in Edit' })).toHaveCount(0)
  await expect(page.locator('[data-hub-tabs-line]')).toHaveCount(0)
  await shoot(page, 'image-photo-character')
  await page.locator('[data-prompt-window] textarea').fill('Mara at the sea')
  await page.locator('[data-prompt-window]').getByRole('button', { name: /^Create/ }).click()
  await expect.poll(async () => (await posted(page)).length, { timeout: 20_000 }).toBe(1)
  expect(Object.values((await posted(page))[0]).some((n) => n.class_type === 'LoadImage')).toBe(true)
  await expect(page.locator('[data-character-hub]')).toBeVisible()
})

test('Motion and Talk without their model show the download alone, in the middle', async ({ page }) => {
  await bootLocal(page, { videoModels: false })
  await openCharacterHub(page)
  await expect(page.locator('[data-hub-new]')).toBeVisible({ timeout: 15_000 })
  for (const [a, text] of [['motion', 'Local motion control needs a one-time download'], ['talk', 'one-time download']] as const) {
    await page.locator(`[data-hub-action="${a}"]`).click()
    const title = page.getByText(text).first()
    await expect(title).toBeVisible()
    await expect(page.locator('[data-motion-controls], [data-talk-controls], [data-hub-tabs-line]')).toHaveCount(0)
    await expect(page.getByTestId('lane-input-note')).toHaveCount(0)
    const b = (await title.boundingBox())!
    expect(Math.abs(b.x + b.width / 2 - await axis(page))).toBeLessThanOrEqual(2)
  }
})
