import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'

/**
 * A9 in the shipped UI: the Docs button exists in Cloud mode.
 *
 * "There's no document tab in cloud chat to add documents and audio clips"
 * (aldrich_ironhart, Discord #general, 2026-09-01). It was hidden on
 * `appMode === 'cloud'`, on the belief that Document Chat needs a local chat
 * backend. It needs a local EMBEDDING backend, a different sidecar, one the app
 * runs in Cloud mode too.
 *
 * The unit tests own the rule and the request body. This spec owns the thing a
 * unit test cannot see: that a real user who flips the Cloud switch and starts a
 * chat finds the button, can open the panel, and reads a privacy statement that
 * matches the lane actually in use.
 *
 * The Tauri mock reports the bundled embeddings server up, which is the
 * everyday case: the app resumes it on start regardless of app mode.
 *
 * Run: npx playwright test e2e/cloud-document-chat.spec.ts
 */

async function bootIntoCloud(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await silenceReleaseNotes(page)
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
}

/** The "What is new" sheet greets a fresh profile and covers the whole app.
 *  A real user clicks it away, so the spec does too. */
async function silenceReleaseNotes(page: Page) {
  const gotIt = page.getByRole('button', { name: /^Got it$/ })
  // isVisible() answers immediately, and the sheet mounts a beat after load,
  // so wait for it explicitly instead of asking too early and moving on.
  await gotIt.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
  if (await gotIt.count()) {
    await gotIt.click()
    await expect(gotIt).toHaveCount(0, { timeout: 10_000 })
  }
}

/** The composer only exists inside a conversation. */
async function openChat(page: Page) {
  await page.getByRole('button', { name: /New Chat/i }).first().click()
  await expect(page.getByTestId('composer-send-slot')).toBeVisible({ timeout: 20_000 })
}

const docsButton = (page: Page) => page.getByTestId('docs-toggle')

test('cloud chat offers Docs, and the panel says where the text goes', async ({ page }) => {
  await bootIntoCloud(page)
  await openChat(page)

  // The report, answered: the button is on the composer row in Cloud mode.
  await expect(docsButton(page)).toBeVisible({ timeout: 20_000 })
  // And it is pressable, because the panel behind it is also the install path
  // for the embedding engine (review B1).
  await expect(docsButton(page)).toBeEnabled()

  // The Cloud badge is up, so this really is the cloud composer and not the
  // local one wearing its name.
  await expect(page.getByTestId('composer-cloud-state')).toBeVisible()

  await docsButton(page).click()
  await expect(page.getByText(/Document Chat/i).first()).toBeVisible({ timeout: 10_000 })

  // The privacy statement, on the lane the mock actually serves: the bundled
  // embeddings server, so the files stay on this machine.
  const local = page.getByTestId('rag-cloud-privacy')
  await expect(local).toBeVisible({ timeout: 10_000 })
  await expect(local).toContainText(/indexed on this computer and stay here/i)
  await expect(local).toContainText(/only the passages that match your question/i)

  // Negative control: the remote-host warning belongs to the other lane and
  // must not appear on this one.
  await expect(page.getByTestId('rag-cloud-privacy-remote')).toHaveCount(0)
})

test('local mode is unchanged: the button is there and says nothing about the cloud', async ({ page }) => {
  // Negative control for the whole fix. Local mode had the button all along and
  // must not have picked up a cloud sentence on the way.
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  await silenceReleaseNotes(page)
  await openChat(page)

  await expect(docsButton(page)).toBeVisible({ timeout: 20_000 })
  await expect(docsButton(page)).toHaveAttribute('title', /Document Chat \(RAG\)/)
  await docsButton(page).click()
  await expect(page.getByTestId('rag-cloud-privacy')).toHaveCount(0)
  await expect(page.getByTestId('rag-cloud-privacy-remote')).toHaveCount(0)
})
