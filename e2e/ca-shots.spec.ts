import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * Pictures of a coding run for the CA review (Code tab and Agent mode), not a
 * test of anything. Runs only when LU_CA_SHOTS names a folder:
 *
 *   LU_CA_SHOTS=/path LU_E2E_PORT=5431 npx playwright test e2e/ca-shots.spec.ts --project=chromium
 */
const OUT = process.env.LU_CA_SHOTS

const MATH = [
  'export function mean(xs: number[]): number {',
  '  return xs.reduce((a, b) => a + b, 0) / xs.length',
  '}',
  '',
  'export function median(xs: number[]): number {',
  '  return 0 // TODO',
  '}',
].join('\n')

type Turn = { text?: string; thinking?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }

const CODE_RUN: Turn[] = [
  { text: 'Let me look at the file first.', toolCalls: [{ name: 'file_read', args: { path: 'src/math.ts' } }] },
  {
    text: '`median` returns 0. I will sort a copy and take the middle.',
    toolCalls: [{
      name: 'file_edit',
      args: {
        path: 'src/math.ts',
        old_string: '  return 0 // TODO',
        new_string: '  const s = [...xs].sort((a, b) => a - b)\n  const m = Math.floor(s.length / 2)\n  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2',
      },
    }],
  },
  { text: 'Now the tests.', toolCalls: [{ name: 'shell_execute', args: { command: 'npm test -- math' } }] },
  { text: '`median()` is implemented and the tests pass.\n\n- sorts a copy, so the input stays unchanged\n- even length: mean of the two middle values' },
]

type Theme = 'dark' | 'light'

async function boot(page: Page, turns: Turn[], width: number, theme: Theme, holdTools = false) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: 'unused',
    modelName: DEFAULT_MODEL_NAME,
    replyChunkDelayMs: 6,
    agentTurns: turns,
    holdTools,
    toolDelayMs: 250,
    files: { 'math.ts': MATH },
    realWriteStatus: true,
  })
  await seedOnboardingDone(page)
  await page.setViewportSize({ width, height: 900 })
  await page.goto('/')
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  if (isDark !== (theme === 'dark')) {
    await page.getByRole('banner').getByTitle(/^(Light|Dark) Mode$/).click()
  }
}

async function send(page: Page, text: string) {
  const composer = page.locator('textarea').first()
  await expect(composer).toBeEnabled({ timeout: 20_000 })
  await composer.fill(text)
  await composer.press('Enter')
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/${name}.png` })
}

test.describe('CA shots', () => {
  test.skip(!OUT, 'set LU_CA_SHOTS to a folder')
  for (const theme of ['dark', 'light'] as const) {
    for (const width of [1280, 375]) {
      test(`code tab ${theme} ${width}`, async ({ page }) => {
        await boot(page, CODE_RUN, width, theme)
        if (width >= 1024) await page.getByRole('button', { name: 'Code', exact: true }).click()
        else {
          await page.getByRole('banner').getByRole('button', { name: 'Main navigation' }).click().catch(() => {})
          await page.getByRole('button', { name: 'Code', exact: true }).first().click().catch(() => {})
        }
        await openNewChat(page)
        await send(page, 'median() in src/math.ts is missing, implement it and run the tests')
        // Ask mode: the edit and the shell command wait for the user.
        await page.waitForTimeout(2500)
        await shot(page, `code-${theme}-${width}-1-waiting`)
        for (let i = 0; i < 4; i++) {
          const allow = page.getByRole('button', { name: /^(Approve|Apply all|Run ⏎|Run)$/ }).first()
          if (await allow.isVisible().catch(() => false)) {
            await allow.click()
            await page.waitForTimeout(1200)
          }
        }
        await page.waitForTimeout(2000)
        await shot(page, `code-${theme}-${width}-2-done`)
      })
    }
  }

  test('agent mode dark 1280', async ({ page }) => {
    await boot(page, CODE_RUN, 1280, 'dark')
    await openNewChat(page)
    await page.getByRole('main').getByRole('button', { name: 'Agent', exact: true }).click()
    await send(page, 'median() in src/math.ts is missing, implement it and run the tests')
    await page.waitForTimeout(2500)
    await shot(page, 'agent-dark-1280-1-waiting')
    for (let i = 0; i < 4; i++) {
      const allow = page.getByRole('button', { name: /^(Approve|Apply all|Run ⏎|Run)$/ }).first()
      if (await allow.isVisible().catch(() => false)) {
        await allow.click()
        await page.waitForTimeout(1200)
      }
    }
    await page.waitForTimeout(2000)
    await shot(page, 'agent-dark-1280-2-done')
  })

  for (const theme of ['dark', 'light'] as const) {
    test(`rewind ${theme} 1280`, async ({ page }) => {
      await boot(page, CODE_RUN, 1280, theme)
      await page.getByRole('button', { name: 'Code', exact: true }).click()
      await openNewChat(page)
      await send(page, 'median() in src/math.ts is missing, implement it and run the tests')
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(1500)
        const allow = page.getByRole('button', { name: /^(Approve|Apply all|Run ⏎|Run)$/ }).first()
        if (await allow.isVisible().catch(() => false)) await allow.click()
      }
      await page.waitForTimeout(2000)
      const rewind = page.getByRole('button', { name: 'Rewind' }).first()
      await page.locator('[data-rewind]').first().hover()
      await rewind.click()
      await expect(page.getByRole('dialog', { name: 'Rewind to before this message' })).toBeVisible()
      await shot(page, `rewind-${theme}-1280-menu`)
      await page.getByRole('button', { name: 'Files and chat' }).click()
      await page.waitForTimeout(800)
      await shot(page, `rewind-${theme}-1280-after`)
    })
  }
})

const PLAN_RUN: Turn[] = [
  {
    text: 'Here is the plan.',
    toolCalls: [{ name: 'todo_write', args: { todos: [
      { content: 'Read src/math.ts', status: 'completed' },
      { content: 'Implement median()', status: 'in_progress' },
      { content: 'Run the tests', status: 'pending' },
      { content: 'Summarise the change', status: 'pending' },
    ] } }],
  },
  { text: 'Reading the file.', toolCalls: [{ name: 'file_read', args: { path: 'src/math.ts' } }] },
  { text: 'I stopped here: `median()` still needs its even-length case.' },
]

test.describe('CA shots: pinned plan', () => {
  test.skip(!OUT, 'set LU_CA_SHOTS to a folder')
  for (const theme of ['dark', 'light'] as const) {
    for (const width of [1280, 375]) {
      test(`plan ${theme} ${width}`, async ({ page }) => {
        await boot(page, PLAN_RUN, width, theme, true)
        // The Code tab: the plan used to sit in its right column.
        if (width >= 1024) await page.getByRole('button', { name: 'Code', exact: true }).click()
        else {
          await page.getByRole('banner').getByRole('button', { name: 'Main navigation' }).click().catch(() => {})
          await page.getByRole('button', { name: 'Code', exact: true }).first().click().catch(() => {})
        }
        await openNewChat(page)
        await send(page, 'median() in src/math.ts is missing, implement it and run the tests')
        await expect(page.getByTestId('plan-pinned')).toBeVisible({ timeout: 30_000 })
        await shot(page, `plan-${theme}-${width}-1-running`)
        await page.evaluate(() => (window as unknown as { __E2E_RELEASE_TOOLS__?: () => void }).__E2E_RELEASE_TOOLS__?.())
        await expect(page.getByTestId('plan-run-stopped')).toBeVisible({ timeout: 60_000 })
        await shot(page, `plan-${theme}-${width}-2-ended`)
      })
    }
  }
})
