import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * A local chat model with image input comes with its image part.
 *
 * The owner's test machine, October 2026: Qwen 3.5 9B was on disk without the
 * second file that lets it take pictures, so the app treated it as a text
 * model and Computer control worked blind. Here, against the Tauri mock:
 * the download fetches both files as one, a cancel takes both, an installed
 * model without the part gets one click that adds it, and a model whose part
 * does not fit the graphics memory is loaded without it and says so.
 *
 * Screenshots: LU_IMAGE_PART_SHOTS=<dir> LU_E2E_PORT=5651 npx playwright test e2e/image-part.spec.ts
 */

const SHOTS = process.env.LU_IMAGE_PART_SHOTS
const DIR = '/tmp/lu-e2e/models'
const MODEL = 'Qwen3.5-9B-abliterated.Q4_K_M'
const MODEL_FILE = `${MODEL}.gguf`
const PART_FILE = `${MODEL}.mmproj.gguf`
const PART_URL = 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/mmproj-F16.gguf'
const PART_BYTES = 918166080
const TILE_TITLE = 'Download 5.9 GB (model 5 GB, image input 0.9 GB)'
const NO_ROOM = 'Loaded without image input: the graphics memory has no room for the image part next to the model. A smaller context makes room.'

// A 1x1 PNG, enough for the composer to take it as a picture.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

interface DlCall { url: string; destDir: string; filename: string; expectedBytes: number | null; expectedSha256: string | null }
type Theme = 'dark' | 'light'

async function boot(page: Page, extra: Partial<TauriMockOptions> = {}, theme: Theme = 'dark') {
  const opts: TauriMockOptions = { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows', ...extra }
  await page.addInitScript(tauriMockInit, opts)
  await seedOnboardingDone(page)
  if (theme === 'light') {
    await page.addInitScript(() => {
      const stored = JSON.parse(window.localStorage.getItem('chat-settings') ?? '{}')
      stored.state.settings.theme = 'light'
      window.localStorage.setItem('chat-settings', JSON.stringify(stored))
    })
  }
  await page.goto('/')
  // The download flow asks which engine the chat runs on, and the model list
  // lands asynchronously. A chat that opens proves the built-in engine is it.
  await openNewChat(page)
}

async function shot(page: Page, name: string, theme: Theme) {
  if (!SHOTS) return
  await page.waitForTimeout(450)
  await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` })
}

const read = <T,>(page: Page, bucket: string) => page.evaluate((b) => ((window as unknown as Record<string, T[]>)[b] ?? []), bucket)
const dlCalls = async (page: Page) => (await read<DlCall>(page, '__E2E_DL_CALLS__')).filter((c) => c.filename.startsWith(MODEL))
const cancels = (page: Page) => read<{ id: string }>(page, '__E2E_DL_CANCELS__')
const engineCalls = (page: Page) => read<{ cmd: string; modelPath: string }>(page, '__E2E_ENGINE_CALLS__')
const release = (page: Page) => page.evaluate(() => { (window as unknown as { __E2E_DL_RELEASE__: boolean }).__E2E_DL_RELEASE__ = true })

/** Models, Get new, Unfiltered, with the one tile of the model in view. */
async function openTile(page: Page) {
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  await page.getByRole('button', { name: 'Unfiltered', exact: true }).click()
  await page.getByPlaceholder(/^Search models/).fill('Qwen 3.5 9B Abliterated')
  const tile = page.getByTitle(TILE_TITLE).first()
  await expect(tile).toBeVisible({ timeout: 15_000 })
  return tile
}

/** The download list in the header. It opens by itself when a download
 *  starts, so a click on its button is only needed when it is shut. */
async function openDownloadList(page: Page) {
  const cancel = page.getByTitle('Cancel all')
  await page.waitForTimeout(600)
  if (!(await cancel.isVisible().catch(() => false))) await page.getByTitle('Downloads').click()
  await expect(cancel).toBeVisible()
}

async function openInstalled(page: Page) {
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  await page.getByRole('button', { name: /^Installed/ }).click()
}

async function attachPicture(page: Page) {
  await page.getByTestId('composer-file-input').setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: PNG })
}

for (const theme of ['dark', 'light'] as const) {
  test(`the download brings the image part: one size, two files, one row (${theme})`, async ({ page }) => {
    await boot(page, { holdDownloads: true }, theme)
    const tile = await openTile(page)
    // The size on the button is the whole download, said before the click.
    await shot(page, '01-tile-names-the-whole-download', theme)

    // The existing details dialog carries the tick, set by default.
    await page.getByRole('button', { name: /^Details for/ }).first().click()
    const tick = page.getByTestId('include-image-input')
    await expect(tick).toContainText('Include image input (+0.9 GB)')
    await expect(tick.getByRole('checkbox')).toBeChecked()
    await expect(tick).toContainText('The download is 5.9 GB in total.')
    await shot(page, '02-details-tick', theme)
    await page.keyboard.press('Escape')

    await tile.click()
    await expect.poll(async () => (await dlCalls(page)).length).toBe(2)
    const [model, part] = await dlCalls(page)
    expect(model.filename).toBe(MODEL_FILE)
    expect(part).toMatchObject({ url: PART_URL, destDir: DIR, filename: PART_FILE, expectedBytes: PART_BYTES })
    expect(part.expectedSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(model.destDir).toBe(DIR)

    // One row in the download list for both files.
    await openDownloadList(page)
    await expect(page.getByText('Qwen 3.5 9B Abliterated', { exact: true }).last()).toBeVisible()
    await expect(page.getByTitle('Cancel all')).toHaveCount(1)
    await shot(page, '03-one-download-row', theme)
  })
}

test('cancelling the download cancels both files', async ({ page }) => {
  await boot(page, { holdDownloads: true })
  await (await openTile(page)).click()
  await expect.poll(async () => (await dlCalls(page)).length).toBe(2)
  await openDownloadList(page)
  await page.getByTitle('Cancel all').click()
  await expect.poll(async () => (await cancels(page)).map((c) => c.id).sort()).toEqual([MODEL_FILE, PART_FILE].sort())
  // Nothing was loaded, and the tile offers the download again.
  await expect(page.getByTitle(TILE_TITLE).first()).toBeVisible()
  expect((await engineCalls(page)).filter((c) => c.modelPath?.includes(MODEL))).toHaveLength(0)
})

test('the tick taken out downloads the model alone', async ({ page }) => {
  await boot(page, { holdDownloads: true })
  await openTile(page)
  await page.getByRole('button', { name: /^Details for/ }).first().click()
  const tick = page.getByTestId('include-image-input')
  await tick.getByRole('checkbox').uncheck()
  await expect(tick).toContainText('Without it the model answers text only. You can add it later under Installed.')
  await page.keyboard.press('Escape')
  // The tile now names the model alone. Since P11 the title also names where
  // the download goes ("Download 5 GB to LU Engine"), so only the size part is
  // pinned here: model alone, no image input in it.
  await page.getByTitle(/^Download 5 GB( to .+)?$/).first().click()
  await expect.poll(async () => (await dlCalls(page)).length).toBe(1)
  await page.waitForTimeout(500)
  expect((await dlCalls(page)).map((c) => c.filename)).toEqual([MODEL_FILE])
})

test('a drive with room for the model only gets the model, and the page says so', async ({ page }) => {
  // Room for the 5.6 GB model, not for 0.9 GB more.
  await boot(page, { holdDownloads: true, freeDiskBytes: 6_000_000_000 })
  await (await openTile(page)).click()
  await expect(page.getByText('Qwen 3.5 9B Abliterated is downloading without image input: the drive has no room for the extra 0.9 GB. You can add it later under Installed.')).toBeVisible()
  expect((await dlCalls(page)).map((c) => c.filename)).toEqual([MODEL_FILE])
})

for (const theme of ['dark', 'light'] as const) {
  test(`an installed model without its image part gets the one click (${theme})`, async ({ page }) => {
    await boot(page, { holdDownloads: true, bundledModels: [{ name: MODEL, size: 5627045216 }] }, theme)

    // 1. In the chat, at the top of the transcript, when a picture is attached.
    await attachPicture(page)
    const notices = page.getByTestId('chat-notices')
    await expect(notices).toContainText('This model can take images, but its image part is not installed.')
    await expect(notices.getByTestId('add-image-input')).toHaveText('Add image input (0.9 GB)')
    // Never in or right above the field the user types in.
    const noticeBox = await notices.boundingBox()
    const fieldBox = await page.locator('textarea').first().boundingBox()
    expect(noticeBox!.y + noticeBox!.height).toBeLessThan(fieldBox!.y - 100)
    await shot(page, '04-chat-offer-at-the-top', theme)

    // 2. Not in the Computer control settings.
    await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    const section = page.getByTestId('computer-control-settings')
    if (!(await section.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: 'Agent Permissions', exact: true }).click()
    }
    if (!(await page.getByTestId('computer-screen-model').isVisible().catch(() => false))) {
      await section.getByRole('button', { name: 'Computer control' }).click()
    }
    const screenModel = page.getByTestId('computer-screen-model')
    await screenModel.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    // No offer here: how computer control runs follows the model, and the
    // model without its image part works from the list. Adding the part is
    // model management and lives under Installed.
    await expect(screenModel.getByTestId('computer-screen-model-hint')).toContainText('works from the list of buttons and fields of the window in front, without a picture.')
    await expect(screenModel.getByTestId('add-image-input')).toHaveCount(0)
    await expect(screenModel.getByTestId('add-image-input-line')).toHaveCount(0)
    await shot(page, '05-computer-control-no-offer', theme)

    // 3. In the model manager, at the model. One click starts the download.
    await openInstalled(page)
    const add = page.getByTestId('add-image-input')
    await expect(add).toHaveText('Add image input (0.9 GB)')
    await shot(page, '06-installed-offer', theme)
    await add.click()
    await expect.poll(async () => (await dlCalls(page)).length).toBe(1)
    expect((await dlCalls(page))[0]).toMatchObject({ url: PART_URL, destDir: DIR, filename: PART_FILE, expectedBytes: PART_BYTES })
    await expect(page.getByTestId('add-image-input-progress')).toContainText('Adding image input 40%')
    await shot(page, '07-installed-adding', theme)

    // The part lands: the offer is gone, and the loaded model is loaded
    // again so that it sees.
    await release(page)
    await expect(page.getByTestId('add-image-input')).toHaveCount(0, { timeout: 20_000 })
    await expect(page.getByTestId('add-image-input-progress')).toHaveCount(0)
    await expect.poll(async () => (await engineCalls(page)).some((c) => c.cmd === 'swap_bundled_model' && c.modelPath === `${DIR}/${MODEL_FILE}`), { timeout: 20_000 }).toBe(true)

    // The same picture again: the model reads it now, and nothing is said.
    await page.getByRole('banner').getByRole('button', { name: 'Chat' }).click()
    await expect(page.locator('textarea').first()).toBeVisible()
    await attachPicture(page)
    await expect(page.getByTestId('chat-notices').getByText(/image/i)).toHaveCount(0)
  })
}

test('a model whose image part fits the graphics memory sees the picture', async ({ page }) => {
  await boot(page, { bundledModels: [{ name: MODEL, size: 5627045216, imagePart: true }] })
  await attachPicture(page)
  await page.waitForTimeout(800)
  await expect(page.getByText(/can't read images|image part/)).toHaveCount(0)
  await openInstalled(page)
  await expect(page.getByText(MODEL).first()).toBeVisible()
  await expect(page.getByTestId('add-image-input')).toHaveCount(0)
  await expect(page.getByTestId('lu-engine-switch-note')).toHaveCount(0)
})

for (const theme of ['dark', 'light'] as const) {
  test(`without room for the image part the model loads without it and says so (${theme})`, async ({ page }) => {
    await boot(page, { imagePartFits: false, bundledModels: [{ name: MODEL, size: 5627045216, imagePart: true }] }, theme)
    // The sentence of the engine, at the place that reports on the engine.
    await openInstalled(page)
    await expect(page.getByTestId('lu-engine-switch-note')).toContainText(NO_ROOM, { timeout: 20_000 })
    // The part is installed, so there is nothing to download.
    await expect(page.getByTestId('add-image-input')).toHaveCount(0)
    await shot(page, '08-loaded-without-image-input', theme)

    // A picture attached in the chat is answered with the truth about it.
    await page.getByRole('banner').getByRole('button', { name: 'Chat' }).click()
    await expect(page.locator('textarea').first()).toBeVisible()
    await attachPicture(page)
    await expect(page.getByTestId('chat-notices')).toContainText('This model was loaded without its image part, so it cannot read the attachment.')
    await shot(page, '09-chat-loaded-without', theme)
  })
}
