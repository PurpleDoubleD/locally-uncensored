import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * GitHub #226: on a Linux without a Secret Service the Hugging Face token is
 * saved into a 0600 file by Rust, and the field says so and names the file.
 * Before 3.1.0 the same click ended in "keychain unsupported on this platform".
 */
const SHOTS = process.env.LU_SHOTS_DIR
const FILE = '/home/you/.local/share/lu-labs/secrets.json'

for (const kind of ['file', 'os'] as const) {
  test(`the Hugging Face token saves and says where it went (${kind})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript(tauriMockInit, {
      assistantReply: DEFAULT_ASSISTANT_REPLY,
      modelName: DEFAULT_MODEL_NAME,
      secretStore: kind === 'file' ? { kind: 'file' as const, path: FILE } : { kind: 'os' as const },
    })
    await seedOnboardingDone(page)
    await page.goto('/')
    await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click()
    const field = page.getByLabel('Hugging Face token')
    for (const tab of ['General', 'AI Backends', 'Agent', 'Voice & Remote']) {
      if (await field.isVisible()) break
      await page.getByRole('button', { name: tab }).first().click()
      const section = page.getByRole('button', { name: 'Hugging Face token' })
      if ((await section.count()) && (await section.first().getAttribute('aria-expanded')) === 'false') await section.first().click()
    }
    await field.fill('hf_e2e_token')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    const note = page.getByRole('status').filter({ hasText: 'No system keyring answered' })
    if (kind === 'file') {
      await expect(note).toContainText(FILE)
      await note.scrollIntoViewIfNeeded()
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/226-hf-token-datei-hinweis.png` })
    } else {
      await expect(note).toHaveCount(0)
    }
  })
}
