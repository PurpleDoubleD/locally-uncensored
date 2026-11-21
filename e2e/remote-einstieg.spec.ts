import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * The way into Remote (3.1.3, David's test on a fresh Windows PC): with the
 * side panel collapsed, Remote looked like a chat and a message there just
 * got an answer from the local model. The entry has to read the same in every
 * state. The Rust side is stubbed for the Remote commands only.
 */
const SHOTS = process.env.LU_REMOTE_SHOTS

async function boot(page: Page, paired: boolean) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript((hasPhone: boolean) => {
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }
    const inner = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__)
    const lan = 'http://192.168.1.20:11435'
    const perms = { filesystem: false, downloads: false, process_control: false, shell: false }
    w.__TAURI_INTERNALS__.invoke = (cmd: string, args: unknown) => {
      switch (cmd) {
        case 'pick_folder': return Promise.resolve('/Users/alex/projects/notes')
        case 'set_chat_workspace_override': return Promise.resolve(null)
        case 'start_remote_server':
          return Promise.resolve({ port: 11435, passcode: '482913', passcodeExpiresAt: Math.floor(Date.now() / 1000) + 900, lanUrl: lan, mobileUrl: `${lan}/mobile`, permissions: perms })
        case 'remote_qr_code': return Promise.resolve({ qr_png_base64: '', url: `${lan}/mobile`, passcode: '482913' })
        case 'remote_connected_devices': return Promise.resolve([])
        case 'remote_paired_devices':
          return Promise.resolve({ devices: hasPhone ? [{ device_id: 'p1', name: 'Pixel', fingerprint: 'AB12', paired_at: 1, last_seen: 1 }] : [] })
      }
      return inner(cmd, args)
    }
  }, paired)
  await page.goto('/')
  await expect(page.getByTestId('sidebar-rail').or(page.getByRole('button', { name: 'Collapse sidebar' })).first()).toBeVisible({ timeout: 20_000 })
}

async function setPanel(page: Page, open: boolean) {
  const rail = page.getByTestId('sidebar-rail')
  if (open && await rail.isVisible()) await page.getByTestId('sidebar-toggle').click()
  if (!open && !(await rail.isVisible())) await page.getByTestId('sidebar-toggle').first().click()
  await expect(rail).toBeVisible({ visible: !open })
}

const remoteButton = (page: Page) => page.getByRole('button', { name: 'Remote', exact: true }).first()

async function expectEntry(page: Page) {
  await expect(page.getByTestId('remote-entry')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Use LU from your phone' })).toBeVisible()
  // No composer that would quietly answer from the local model.
  await expect(page.locator('textarea:visible')).toHaveCount(0)
}

for (const open of [false, true]) {
  const panel = open ? 'panel open' : 'panel collapsed'

  test(`${panel}, no chat: Remote shows the entry`, async ({ page }) => {
    await boot(page, false)
    await setPanel(page, open)
    await remoteButton(page).click()
    await expectEntry(page)
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/entry-${open ? 'open' : 'collapsed'}.png` })
  })

  test(`${panel}, open chat: Remote shows the entry, and Chat comes back with its draft`, async ({ page }) => {
    await boot(page, false)
    await setPanel(page, open)
    const box = page.locator('textarea:visible').first()
    await box.fill('half a thought')
    await remoteButton(page).click()
    await expectEntry(page)
    await page.locator('aside').getByRole('button', { name: 'Chat', exact: true }).first().click()
    await expect(page.locator('textarea:visible').first()).toHaveValue('half a thought')
  })

  test(`${panel}: New Chat inside Remote stays on the entry`, async ({ page }) => {
    await boot(page, false)
    await setPanel(page, open)
    await remoteButton(page).click()
    if (!open) {
      await page.getByRole('button', { name: 'New Chat' }).click()
      await expectEntry(page)
    }
    await expectEntry(page)
  })

  test(`${panel}: starting from the entry brings up the QR panel`, async ({ page }) => {
    await boot(page, false)
    await setPanel(page, open)
    await remoteButton(page).click()
    await page.getByRole('button', { name: 'Same Wi-Fi' }).click()
    await expect(page.getByText('LIVE', { exact: true })).toBeVisible()
    await expect(page.getByTestId('remote-entry')).toHaveCount(0)
    // The composer comes back at its normal height, not stretched.
    await expect.poll(() => page.locator('textarea:visible').first().evaluate((e) => e.getBoundingClientRect().height)).toBeLessThan(60)
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/live-from-${open ? 'open' : 'collapsed'}.png` })
  })
}

async function openChat(page: Page) {
  const box = page.locator('textarea:visible').first()
  await box.fill('hello')
  await box.press('Enter')
  await expect(page.getByTestId('continue-on-phone')).toBeVisible({ timeout: 15_000 })
}

test('phone icon, no phone paired: leads to the setup and shares nothing', async ({ page }) => {
  await boot(page, false)
  await openChat(page)
  const icon = page.getByTestId('continue-on-phone')
  await expect(icon).toHaveAttribute('title', 'Set up your phone')
  await icon.click()
  await expectEntry(page)
  const shared = await page.evaluate(() => (localStorage.getItem('chat-conversations') ?? '').includes('"remoteShared":true'))
  expect(shared).toBe(false)
})

test('phone icon, phone paired: shares, and a second click stops it', async ({ page }) => {
  await boot(page, true)
  await openChat(page)
  const icon = page.getByTestId('continue-on-phone')
  await expect(icon).toHaveAttribute('title', 'Continue on phone')
  await icon.click()
  await expect(icon).toHaveAttribute('aria-pressed', 'true')
  await expect(icon).toHaveAttribute('title', 'Stop sharing with phone')
  await icon.click()
  await expect(icon).toHaveAttribute('aria-pressed', 'false')
})
