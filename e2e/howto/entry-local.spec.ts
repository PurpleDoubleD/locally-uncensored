import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'fs'
import { Rec } from './rec'
import { openChat } from './model'

// Checks the how-to entries that are not on a Cloud Create stage: Settings
// Storage, Onboarding, Speech and Personas, the Remote tab, the mark
// next to Agent in a local chat, the agent's folder dialog and
// the local Character stage. Each opens its card, the film plays and the line
// follows it, and the card names its handbook page. Fixture: the films are
// answered from LU_HOWTO_FILMS (<name>.mp4), every other request is the rig's.
const FILMS = process.env.LU_HOWTO_FILMS ?? ''
const SHOTS = process.env.LU_HOWTO_SHOTS ?? ''
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

async function openCard(page: Page, topic: string, shot: string) {
  const entry = page.getByTestId(`howto-${topic}`)
  await expect(entry).toBeVisible({ timeout: 15_000 })
  await entry.getByRole('button').first().click()
  const card = page.getByTestId(`howto-card-${topic}`)
  await expect(card.getByTestId('howto-line')).not.toBeEmpty({ timeout: 15_000 })
  await expect(card.getByTestId('howto-guide')).toBeVisible()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${SHOTS}/${shot}.png` })
  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
}

test('local entries', async ({ page }) => {
  test.skip(!FILMS || !SHOTS, 'set LU_HOWTO_FILMS and LU_HOWTO_SHOTS')
  test.setTimeout(150_000)
  await Rec.boot(page, '_entry-local', 'entry', {
    mode: 'local',
    fixtures: async (p) => {
      await p.route('https://lu-labs.ai/howto/*.mp4', (route) => {
        const name = new URL(route.request().url()).pathname.split('/').pop()!
        return route.fulfill({ contentType: 'video/mp4', body: readFileSync(`${FILMS}/${name}`) })
      })
    },
  })

  // Settings, General, Onboarding, then AI Backends, Storage.
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Onboarding' }).click()
  await openCard(page, 'beginners', 'settings-onboarding')
  await page.getByRole('button', { name: 'AI Backends' }).first().click()
  const storage = page.getByRole('button', { name: 'Storage' })
  if ((await storage.getAttribute('aria-expanded')) !== 'true') await storage.click()
  await openCard(page, 'storage', 'settings-storage')
  await page.getByRole('button', { name: 'Voice & Remote' }).first().click()
  await openCard(page, 'dictation', 'settings-speech')
  await page.getByRole('button', { name: 'Agent' }).first().click()
  const personas = page.getByRole('button', { name: 'Personas' })
  if ((await personas.getAttribute('aria-expanded')) !== 'true') await personas.click()
  await openCard(page, 'persona-sampling', 'settings-personas')

  // The Remote tab of the sidebar.
  await page.getByRole('banner').getByRole('button', { name: 'Chat', exact: true }).click()
  await page.getByRole('button', { name: 'Toggle sidebar' }).click()
  await page.locator('aside').getByRole('button', { name: /^Remote/ }).first().click()
  await openCard(page, 'remote', 'remote-tab')
  await page.locator('aside').getByRole('button', { name: /^Chat/ }).first().click()
  await page.getByRole('button', { name: 'Toggle sidebar' }).click()

  // The mark next to Agent in a local chat (the rig's local model is picked).
  await page.getByRole('button', { name: 'Toggle sidebar' }).click()
  await page.getByRole('button', { name: /New Chat/i }).first().click()
  await page.getByRole('button', { name: 'Toggle sidebar' }).click()
  await openCard(page, 'chats', 'chat-mark')

})

test('agent folder dialog entry', async ({ page }) => {
  test.skip(!FILMS || !SHOTS, 'set LU_HOWTO_FILMS and LU_HOWTO_SHOTS')
  test.setTimeout(120_000)
  await Rec.boot(page, '_entry-agent', 'entry', {
    fixtures: async (p) => {
      await p.route('https://lu-labs.ai/howto/*.mp4', (route) => {
        const name = new URL(route.request().url()).pathname.split('/').pop()!
        return route.fulfill({ contentType: 'video/mp4', body: readFileSync(`${FILMS}/${name}`) })
      })
    },
  })
  const toggle = await openChat(page)
  await toggle.click()
  // Since 3.1.2 the switch opens no dialog; the badge next to it still does.
  await expect(toggle).toHaveAttribute('title', /Agent Mode is on/i)
  await page.getByTestId('agent-workspace-pill').click()
  await expect(page.getByText('Where should the agent work?')).toBeVisible()
  await openCard(page, 'sandbox', 'agent-dialog')
})
