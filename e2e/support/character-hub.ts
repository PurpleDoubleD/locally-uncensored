import { expect, type Page } from '@playwright/test'

/**
 * The Character area (3.1.0 part B): one pill "Character" for Character
 * Studio, Talking Character, Motion Control and Swap Character. Specs that
 * used to click those four pills go through here.
 */

/** The pill of the area. */
export function characterPill(page: Page) {
  // In the pill bar: the training's own switch has a radio "Character" too.
  return page.getByRole('radiogroup', { name: 'Create mode' }).getByRole('radio', { name: 'Character', exact: true })
}

/** Opens the area: its first page without a character, else the stage. */
export async function openCharacterHub(page: Page, timeout = 15_000): Promise<void> {
  await characterPill(page).click({ timeout })
  await expect(page.locator('[data-character-hub]')).toBeVisible({ timeout })
}

/** The stage without a character ("Just use a photo"), from wherever the
 *  area stands. With no character at all there is no stage: the area shows
 *  its first page, and this answers false. */
async function photoOnlyStage(page: Page, timeout: number): Promise<boolean> {
  const hub = page.locator('[data-character-hub]')
  // A character of the account takes the stage by itself.
  await expect(hub).not.toHaveAttribute('data-character-hub', 'who', { timeout: 1_500 }).catch(() => undefined)
  const step = await hub.getAttribute('data-character-hub')
  if (step === 'who') return false
  // A page of the area (New character, the training): back to the characters.
  const back = page.locator('[data-hub-back]')
  if (await back.count()) {
    await back.click()
    if ((await hub.getAttribute('data-character-hub')) === 'who') return false
  }
  await page.locator('[data-hub-photo-only]').click({ timeout })
  return true
}

/** An action without a character, named like the old pill:
 *  'Character Studio', 'Swap Character', 'Motion Control', 'Talking
 *  Character' (a locked one reads "…, runs on LU Cloud"). */
export async function openCharacterAction(page: Page, name: string, timeout = 15_000): Promise<void> {
  await openCharacterHub(page, timeout)
  // With or without a character: the row over the prompt window picks it.
  await photoOnlyStage(page, timeout)
  await page.getByRole('radio', { name, exact: true }).click({ timeout })
}

/** The training: "New character", "Train a model", on to the training. */
export async function openCharacterTraining(page: Page, timeout = 15_000): Promise<void> {
  await openCharacterHub(page, timeout)
  const hub = page.locator('[data-character-hub]')
  await expect(hub).not.toHaveAttribute('data-character-hub', 'who', { timeout: 1_500 }).catch(() => undefined)
  if (await page.locator('[data-hub-training]').count()) return
  const back = page.locator('[data-hub-back]')
  if (await back.count()) await back.click()
  if ((await hub.getAttribute('data-character-hub')) === 'who') await page.locator('[data-hub-create] button').click({ timeout })
  else await page.locator('[data-hub-new]').click({ timeout })
  await page.locator('[data-hub-way="train"]').click()
  await page.getByRole('button', { name: 'Continue to training' }).click()
  await expect(page.locator('[data-hub-training]')).toBeVisible({ timeout })
}

/** Opens "More options" of the training page, where the trainer's own choices
 *  and Reinstall stand since 3.1.3. */
export async function openTrainMore(page: Page, timeout = 15_000): Promise<void> {
  const more = page.locator('[data-hub-training] [data-hub-train-more]').filter({ has: page.locator('summary', { hasText: 'More options' }) }).last()
  await expect(more).toBeVisible({ timeout })
  if ((await more.getAttribute('open')) === null) await more.locator('summary').click({ timeout })
}

/** The stage without a character, where the actions and their locks show. */
export async function openCharacterWhat(page: Page, timeout = 15_000): Promise<void> {
  await openCharacterHub(page, timeout)
  // No character yet: Image (it runs everywhere) opens the stage.
  if (!(await photoOnlyStage(page, timeout))) await page.locator('[data-hub-action="image"]').click({ timeout })
  await expect(page.locator('[data-hub-stage]')).toBeVisible({ timeout })
}
