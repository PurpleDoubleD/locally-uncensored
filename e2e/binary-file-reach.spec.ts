import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat, expectWorkspaceAsk, answerWorkspaceAsk } from './support/ui'

/**
 * Discord feature request "load binary files (such as ROMs) directly" (3.0.8)
 * in the real chat, with the backend stubbed (e2e/support/tauri-mock.ts): the
 * chip says where a binary goes, and in Agent mode the model gets the full
 * path.
 * Screenshots land in test-results/308-wuensche for the owner's design check.
 *
 * Run: npx playwright test e2e/binary-file-reach.spec.ts
 */

const SHOTS = resolve(process.cwd(), 'test-results/308-wuensche')
const ROM = {
  name: 'pokemon.gba', mimeType: 'application/octet-stream',
  buffer: Buffer.concat([Buffer.alloc(4, 0x2e), Buffer.from([0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21]), Buffer.alloc(0xa0 - 12, 0), Buffer.from('POKEMON EMER', 'latin1'), Buffer.alloc(200, 0xea)]),
}

test('a binary in plain chat says "summary only", in Agent mode it goes to the folder with its full path', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'mac' as const, agentTurns: [{ text: 'I can see the file.' }],
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  await openNewChat(page)

  await page.getByTestId('composer-file-input').setInputFiles(ROM)
  await expect(page.getByTestId('composer-file-chip')).toContainText('summary only')
  await page.screenshot({ path: `${SHOTS}/binary-1-plain-chat.png` })
  await expect(page.getByTestId('chat-notices')).toContainText('Models cannot read binary files')
  await page.getByRole('button', { name: /Remove pokemon.gba/ }).click()
  // Taken off the draft: the line about it goes too.
  await expect(page.getByText(/Models cannot read binary files/)).toHaveCount(0)

  const agentToggle = page.getByRole('main').getByRole('button', { name: 'Agent', exact: true })
  await agentToggle.click()
  expectWorkspaceAsk(page)
  await expect(agentToggle).toHaveAttribute('title', /Agent Mode is on/i, { timeout: 10_000 })
  await page.getByTestId('composer-file-input').setInputFiles(ROM)
  await expect(page.getByTestId('composer-file-chip')).toContainText('goes to the working folder')
  await page.screenshot({ path: `${SHOTS}/binary-2-agent-composer.png` })

  await page.locator('textarea').first().fill('what is this?')
  await page.getByRole('button', { name: /Send message/i }).click()
  await answerWorkspaceAsk(page)
  await expect(page.getByText('I can see the file.').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('chat-file-chip')).toContainText('file in the working folder')
  const bodies = await page.evaluate(() => (Reflect.get(window, '__E2E_CHAT_BODIES__') as unknown[]).map(String))
  const user = String((JSON.parse(bodies[0]) as { messages: Array<{ role: string; content: unknown }> }).messages.filter((m) => m.role === 'user').pop()?.content)
  expect(user).toContain('Path in your working folder: pokemon.gba')
  expect(user).toMatch(/Full path on this computer: \/.+\/pokemon\.gba/)
  await page.screenshot({ path: `${SHOTS}/binary-3-agent-sent.png` })
})
