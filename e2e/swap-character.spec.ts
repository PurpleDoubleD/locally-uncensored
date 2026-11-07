import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'

/**
 * Swap Character (07.11.2026, port of the web's C52) in the real app, Tauri
 * stubbed, cloud mocked: the pill, the panel in the web's order, people up to
 * four, Create only with every input and the consent, its price on the button.
 * Nothing is booked: the spec never presses Create.
 *
 * Media come from LU_SWAP_MEDIA_DIR (clip.mp4, face1.png, face2.png) when it is
 * set; without it the spec uses a 1x1 picture and a stub clip, which tests the
 * same panel and only looks plainer. LU_SWAP_SHOTS_DIR, when set, receives
 * screenshots of the tab in the dark and the light theme.
 */

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/** The three swap models as a server that knows them lists them. */
const SWAP_CATALOG = [
  ['openjutsu-character-swap', 'OpenJutsu Character Swap'],
  ['wan-2.2-animate-replace', 'Wan 2.2 Animate Replace'],
  ['scail-2', 'SCAIL 2'],
].map(([id, label]) => ({ id, label, kind: 'video', ops: ['studio'], quote_required: true, t2v: false, i2v: false }))

async function media(name: string, mimeType: string) {
  const dir = process.env.LU_SWAP_MEDIA_DIR
  if (dir) {
    const { readFileSync } = await import('node:fs')
    return { name, mimeType, buffer: readFileSync(`${dir}/${name}`) }
  }
  return { name, mimeType, buffer: mimeType.startsWith('image') ? PNG_1PX : Buffer.from('stub') }
}

async function openSwap(page: Page) {
  await page.setViewportSize({ width: 1296, height: 900 })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, extraCatalogModels: SWAP_CATALOG })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: 'Swap Character', exact: true }).click()
  await expect(page.locator('[data-swap-controls]')).toBeVisible({ timeout: 15_000 })
}

async function shoot(page: Page, name: string) {
  const dir = process.env.LU_SWAP_SHOTS_DIR
  if (!dir) return
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => {
      document.documentElement.classList.toggle('dark', t === 'dark')
      document.documentElement.classList.toggle('light', t === 'light')
    }, theme)
    await page.waitForTimeout(250)
    await page.screenshot({ path: `${dir}/desktop-app-${name}-${theme}.png` })
  }
  await page.evaluate(() => {
    document.documentElement.classList.add('dark')
    document.documentElement.classList.remove('light')
  })
}

test('Swap Character: panel, people, consent and price before Create', async ({ page }) => {
  await openSwap(page)
  const panel = page.locator('[data-swap-controls]')
  const create = page.getByRole('button', { name: /^Create/ }).last()

  await expect(panel.locator('[data-swap-tips]')).toContainText('People only: animals are refused')
  await expect(page.locator('[data-swap-stage]')).toBeVisible()
  await expect(create).toBeDisabled()
  await shoot(page, 'swap-empty')

  // The original video, then one photo: still waits for the consent.
  await panel.locator('input[type=file][accept^="video"]').setInputFiles(await media('clip.mp4', 'video/mp4'))
  await page.locator('[data-swap-photo-input="1"]').setInputFiles(await media('face1.png', 'image/png'))
  await expect(page.getByRole('button', { name: 'Change photo of person 1' })).toBeVisible()
  await expect(create).toBeDisabled()

  // A second person without a photo keeps Create off.
  await page.getByRole('button', { name: /Add person/ }).click()
  await expect(page.getByRole('button', { name: /Add person/ })).toHaveText('+ Add person (2/4)')
  await page.getByRole('checkbox').check()
  await expect(create).toBeDisabled()
  await page.locator('[data-swap-photo-input="2"]').setInputFiles(await media('face2.png', 'image/png'))
  await page.getByRole('textbox', { name: 'Who person 1 replaces' }).fill('the woman on the left')
  await page.getByRole('textbox', { name: 'Who person 2 replaces' }).fill('the man in black')

  // Everything in: Create is armed and names its price.
  await expect(create).toBeEnabled({ timeout: 15_000 })
  await expect(page.locator('[data-clip-price]')).toContainText('credits')
  await shoot(page, 'swap-ready')

  // Up to four people, no more.
  await page.getByRole('button', { name: /Add person/ }).click()
  await page.getByRole('button', { name: /Add person/ }).click()
  await expect(page.getByRole('button', { name: /Add person/ })).toHaveText('+ Add person (4/4)')
  await expect(page.getByRole('button', { name: /Add person/ })).toBeDisabled()
  await expect(create).toBeDisabled()
  await shoot(page, 'swap-four-people')
})
