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

/** Opens the area (step 1 on a fresh session). */
export async function openCharacterHub(page: Page, timeout = 15_000): Promise<void> {
  await characterPill(page).click({ timeout })
  await expect(page.locator('[data-character-hub]')).toBeVisible({ timeout })
}

/** Step 2 without a character ("Just use a photo"), then the action row
 *  named like the old pill: 'Character Studio', 'Swap Character',
 *  'Motion Control', 'Talking Character' (a locked one reads
 *  "…, runs on LU Cloud"). */
export async function openCharacterAction(page: Page, name: string, timeout = 15_000): Promise<void> {
  await openCharacterHub(page, timeout)
  const hub = page.locator('[data-character-hub]')
  if ((await hub.getAttribute('data-character-hub')) === 'who') {
    await page.getByRole('button', { name: 'Just use a photo' }).click()
  }
  if ((await hub.getAttribute('data-character-hub')) !== 'panel') {
    await page.getByRole('radio', { name, exact: true }).click({ timeout })
  } else {
    // Already on a panel: switch the action in the head line.
    await page.getByRole('button', { name: 'Action' }).click()
    const label = { 'Character Studio': 'Image', 'Swap Character': 'Swap', 'Motion Control': 'Motion', 'Talking Character': 'Talk' }[name] ?? name
    await page.getByRole('option', { name: new RegExp(`^${label}`) }).click()
  }
}

/** "Train from photos": Character Studio's training. */
export async function openCharacterTraining(page: Page, timeout = 15_000): Promise<void> {
  await openCharacterHub(page, timeout)
  const hub = page.locator('[data-character-hub]')
  if ((await hub.getAttribute('data-character-hub')) !== 'who') {
    await page.getByRole('button', { name: 'Character', exact: true }).click()
    await page.getByRole('option', { name: /^New character/ }).click()
    return
  }
  await page.getByRole('button', { name: 'Train from photos' }).click()
}

/** Step 2 without a character, where the actions and their locks show. */
export async function openCharacterWhat(page: Page, timeout = 15_000): Promise<void> {
  await openCharacterHub(page, timeout)
  const hub = page.locator('[data-character-hub]')
  if ((await hub.getAttribute('data-character-hub')) === 'panel') {
    await page.getByRole('button', { name: 'Character', exact: true }).click()
    await page.getByRole('option', { name: 'All characters…' }).click()
  }
  await page.getByRole('button', { name: 'Just use a photo' }).click()
  await expect(hub).toHaveAttribute('data-character-hub', 'what')
}
