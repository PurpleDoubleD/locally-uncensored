import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'
import { toolCalls } from './support/recorded'

/**
 * GH #147 (Windows, Code agent on LU Cloud, 2026-10-01), the two call shapes
 * from the reporter's screenshots, played through the real Code tab:
 *   1. a native call NAMED "function" carrying a todo list
 *   2. calls written as text: !function_call:{"call": "file_read", ...}
 * Before 3.0.4 the first came back "Unknown tool: function" and the second
 * stayed prose, so the run stopped and the model kept "correcting".
 */

type Turn = { text?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }

async function boot(page: Page, agentTurns: Turn[]) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: 'unused in agent specs',
    modelName: DEFAULT_MODEL_NAME,
    replyChunkDelayMs: 4,
    agentTurns,
    files: { 'verifier.py': 'def verify():\n    return True\n' },
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await openNewChat(page)
}

async function instruct(page: Page, text: string) {
  const composer = page.locator('textarea').first()
  const echoed = page.getByRole('main').locator('p').filter({ hasText: text })
  await expect(composer).toBeEnabled({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 20_000 })
  await expect(async () => {
    if ((await echoed.count()) === 0) {
      await composer.fill(text)
      await composer.press('Enter')
    }
    await expect(echoed).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}

test('a call named "function" and a !function_call text both run their tool', async ({ page }) => {
  await boot(page, [
    {
      text: 'Continuing. Gathering project files for analysis.',
      toolCalls: [{ name: 'function', args: { todos: [
        { content: 'Read the verifier', status: 'in_progress' },
        { content: 'Summarize it', status: 'pending' },
      ] } }],
    },
    { text: 'We\'ll proceed.\n\n!function_call:{"call": "file_read", "arguments": {"path": "core/verifier.py"}}' },
    { text: 'VERIFIER_READ_DONE' },
  ])

  await instruct(page, 'look at core/verifier.py')
  const main = page.getByRole('main')
  await expect(main.getByText('VERIFIER_READ_DONE')).toBeVisible({ timeout: 30_000 })

  // The todo list landed in the plan, the file was really read.
  await expect(page.getByTestId('plan-pinned').getByTestId('plan-title')).toBeVisible({ timeout: 15_000 })
  const reads = (await toolCalls(page)).filter((c) => c.cmd === 'fs_read')
  expect(reads.some((c) => (c.path ?? '').replace(/\\/g, '/').endsWith('core/verifier.py'))).toBe(true)

  // No dead end on screen, no raw call text in the answer.
  await expect(main.getByText(/Unknown tool: function/)).toHaveCount(0)
  await expect(main.getByText(/!function_call/)).toHaveCount(0)
})
