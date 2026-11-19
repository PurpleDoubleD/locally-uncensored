import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'
import { openCharacterHub } from './support/character-hub'

/**
 * A trained cloud character can be saved as a file (10.10.2026).
 *
 * The shelf under Character, "Use character", lists the characters of the
 * account. Each has a Download button that hands the backend the route of the
 * file and the session token; the backend asks where to save and streams the
 * weights to disk. The window never holds the file.
 */
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
const ID = '0b9d7c1e-1111-4222-8333-444455556666'

type Call = { id: string; url: string; authToken: string; defaultName: string; extension: string; extLabel: string }
type Answer = { status: 'saved'; path: string; bytes: number } | { status: 'cancelled' } | { status: 'refused'; code: number } | { error: string }

async function boot(page: Page, answer: Answer) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await page.addInitScript(([answer]) => {
    const w = window as unknown as {
      __SAVES__: unknown[]
      __CANCELS__: unknown[]
      __RELEASE__: () => void
      __STOP__: () => void
      __TAURI_INTERNALS__: { invoke: (c: string, a: Record<string, unknown>) => Promise<unknown>; transformCallback: unknown }
    }
    w.__SAVES__ = []
    w.__CANCELS__ = []
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    let handler: number | null = null
    bridge.invoke = (command, args) => {
      if (command === 'plugin:event|listen' && args.event === 'cloud-file-progress') handler = Number(args.handler)
      if (command === 'cancel_cloud_file') {
        w.__CANCELS__.push(args.id)
        // What the backend does: the running download answers "stopped".
        w.__STOP__()
        return Promise.resolve(null)
      }
      if (command === 'save_cloud_file_dialog') {
        w.__SAVES__.push(args)
        const tick = (received: number, total: number) => {
          const cb = (window as unknown as Record<string, (e: unknown) => void>)[`_${handler}`]
          cb?.({ event: 'cloud-file-progress', id: handler, payload: { id: args.id, received, total } })
        }
        return new Promise((resolve, reject) => {
          // A closed Save dialog downloads nothing. Otherwise the place is
          // picked, the backend says so before the first byte, and half of
          // the file is there until the test lets the rest through.
          if (!('status' in answer && answer.status === 'cancelled')) {
            tick(0, 0)
            setTimeout(() => tick(150, 300), 50)
          }
          w.__RELEASE__ = () => ('error' in answer ? reject(answer.error) : resolve(answer))
          w.__STOP__ = () => resolve({ status: 'stopped' })
        })
      }
      return invoke(command, args)
    }
  }, [answer] as const)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.route('https://lu-labs.ai/api/loras', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    return route.fulfill({
      status: 200, headers: CORS, contentType: 'application/json',
      body: JSON.stringify({ loras: [{ id: ID, name: 'Anna Müller', trigger_word: 'annachar', base_family: 'z-image', created_at: '2026-10-09T10:00:00Z' }] }),
    })
  })
  // The window must never ask for the file itself.
  let fileAsked = 0
  await page.route(`https://lu-labs.ai/api/loras/${ID}/file`, (route) => { fileAsked += 1; return route.fulfill({ status: 500, headers: CORS }) })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
  // The Character area: the character takes the stage, its file actions
  // stand under its name on the left.
  await openCharacterHub(page)
  await expect(page.getByRole('tab', { name: /Anna Müller/ })).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 })
  await expect(page.locator('[data-hub-tab-name]')).toHaveText('Anna Müller')
  // The file actions are rows of the character's menu (the three dots at its tab).
  await page.locator('[data-hub-menu]').click()
  await expect(page.locator('[data-hub-menu-list] [data-hub-download]')).toBeVisible({ timeout: 15_000 })
  return { fileAsked: () => fileAsked }
}

const saves = (page: Page) => page.evaluate(() => (window as unknown as { __SAVES__: Call[] }).__SAVES__)
const cancels = (page: Page) => page.evaluate(() => (window as unknown as { __CANCELS__: string[] }).__CANCELS__)
const release = (page: Page) => page.evaluate(() => (window as unknown as { __RELEASE__: () => void }).__RELEASE__())

test('Download on a cloud character saves its weights through the backend, with progress', async ({ page }) => {
  const wire = await boot(page, { status: 'saved', path: 'C:\\Users\\me\\Downloads\\Anna-Muller.safetensors', bytes: 300 })
  const button = page.getByRole('button', { name: 'Download character' })
  await expect(button).toHaveAttribute('title', 'Download the .safetensors file')
  await button.click()

  await expect.poll(() => saves(page)).toHaveLength(1)
  const [call] = await saves(page)
  expect(call.url).toBe(`https://lu-labs.ai/api/loras/${ID}/file`)
  expect(call.defaultName).toBe('Anna-Muller.safetensors')
  expect(call.extension).toBe('safetensors')
  expect(call.id).toMatch(new RegExp(`^lora-${ID}-\\d+$`))
  // The session of the app, the same one every cloud call carries.
  expect(call.authToken.length).toBeGreaterThan(10)

  // While the file comes in: the button is busy and says how far it is.
  await expect(button).toBeDisabled()
  await expect(button).toContainText('50%')
  await expect(button).toHaveAttribute('title', 'Saving the .safetensors file, 50%')
  // A second click starts no second download.
  await button.click({ force: true })
  expect(await saves(page)).toHaveLength(1)

  await release(page)
  await expect(button).toBeEnabled()
  await expect(button).toHaveAttribute('title', 'Download the .safetensors file')
  await expect(page.getByText(/Download failed/)).toHaveCount(0)
  expect(wire.fileAsked()).toBe(0)
})

test('a running download can be cancelled, and the row says "Download cancelled"', async ({ page }) => {
  await boot(page, { status: 'saved', path: 'C:\\Users\\me\\Downloads\\Anna-Muller.safetensors', bytes: 300 })
  const button = page.getByRole('button', { name: 'Download character' })
  const cancel = page.getByRole('button', { name: 'Cancel download' })
  // Nothing to cancel before a download runs.
  await expect(cancel).toHaveCount(0)
  await button.click()
  await expect(button).toContainText('50%')
  await expect(cancel).toHaveAttribute('title', 'Cancel the download')
  await cancel.click()

  // The backend was told to end exactly the download that is running.
  await expect.poll(() => cancels(page)).toHaveLength(1)
  const [call] = await saves(page)
  expect(await cancels(page)).toEqual([call.id])
  await expect(page.getByTestId('character-download-cancelled')).toHaveText('Download cancelled')
  await expect(button).toBeEnabled()
  await expect(cancel).toHaveCount(0)
  // Cancelled on purpose is no failure.
  await expect(page.getByText(/Download failed/)).toHaveCount(0)

  // A new download starts clean and can finish.
  await button.click()
  await expect.poll(() => saves(page)).toHaveLength(2)
  await expect(page.getByTestId('character-download-cancelled')).toHaveCount(0)
  await release(page)
  await expect(button).toBeEnabled()
  await expect(page.getByTestId('character-download-cancelled')).toHaveCount(0)
  expect(await cancels(page)).toHaveLength(1)
})

test('a closed Save dialog is no error', async ({ page }) => {
  await boot(page, { status: 'cancelled' })
  const button = page.getByRole('button', { name: 'Download character' })
  await button.click()
  await expect.poll(() => saves(page)).toHaveLength(1)
  // The dialog is still open: there is no download to cancel yet.
  await expect(page.getByRole('button', { name: 'Cancel download' })).toHaveCount(0)
  await release(page)
  await expect(button).toBeEnabled()
  await expect(page.getByText(/Download failed/)).toHaveCount(0)
})

test('a character that is gone says so in English, and the button is free again', async ({ page }) => {
  await boot(page, { status: 'refused', code: 404 })
  const button = page.getByRole('button', { name: 'Download character' })
  await button.click()
  await expect.poll(() => saves(page)).toHaveLength(1)
  await release(page)
  await expect(page.getByTestId('create-error-text')).toHaveText('Download failed: This character is no longer on your account.')
  await expect(button).toBeEnabled()
})

test('a download that breaks off passes the reason of the backend on', async ({ page }) => {
  await boot(page, { error: 'The download broke off before the file was complete. Try again.' })
  await page.getByRole('button', { name: 'Download character' }).click()
  await expect.poll(() => saves(page)).toHaveLength(1)
  await release(page)
  await expect(page.getByTestId('create-error-text')).toHaveText('Download failed: The download broke off before the file was complete. Try again.')
})
