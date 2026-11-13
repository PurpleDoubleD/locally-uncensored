import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * Pictures of the open context list in the Code tab for the CA review (U5):
 * what fills the window, and the small window note. Not a test of anything.
 * Runs only when LU_CA_SHOTS names a folder:
 *
 *   LU_CA_SHOTS=/path LU_E2E_PORT=5431 npx playwright test e2e/u5-context-shots.spec.ts --project=chromium
 */
const OUT = process.env.LU_CA_SHOTS

const MATH = 'export function median(xs: number[]): number {\n  return 0 // TODO\n}\n'

type Turn = { text?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }
const RUN: Turn[] = [
  { text: 'Let me look at the file first.', toolCalls: [{ name: 'file_read', args: { path: 'src/math.ts' } }] },
  { text: '`median` returns 0 for now. It needs a sort and the middle value.' },
]

type Theme = 'dark' | 'light'

async function boot(page: Page, width: number, theme: Theme, smallWindow: boolean) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: 'unused',
    modelName: DEFAULT_MODEL_NAME,
    replyChunkDelayMs: 4,
    agentTurns: RUN,
    toolDelayMs: 150,
    files: { 'math.ts': MATH },
  })
  await seedOnboardingDone(page)
  if (smallWindow) {
    // The Ollama num_ctx the list itself writes, set to 8K before boot.
    await page.addInitScript(() => {
      const raw = window.localStorage.getItem('chat-settings')
      const env = raw ? JSON.parse(raw) : { state: { settings: {} }, version: 10 }
      env.state.settings = { ...env.state.settings, contextWindowOverride: 8192 }
      window.localStorage.setItem('chat-settings', JSON.stringify(env))
    })
  }
  await page.setViewportSize({ width, height: 900 })
  await page.goto('/')
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  if (isDark !== (theme === 'dark')) {
    await page.getByRole('banner').getByTitle(/^(Light|Dark) Mode$/).click()
  }
}

async function toCodeTab(page: Page, width: number) {
  if (width >= 1024) await page.getByRole('button', { name: 'Code', exact: true }).click()
  else {
    await page.getByRole('banner').getByRole('button', { name: 'Main navigation' }).click().catch(() => {})
    await page.getByRole('button', { name: 'Code', exact: true }).first().click().catch(() => {})
  }
  await openNewChat(page)
}

async function send(page: Page, text: string) {
  const composer = page.locator('textarea').first()
  await expect(composer).toBeEnabled({ timeout: 20_000 })
  await composer.fill(text)
  await composer.press('Enter')
}

async function openList(page: Page) {
  await page.getByRole('button', { name: /^Context window/ }).first().click()
  await expect(page.getByTestId('context-breakdown')).toBeVisible()
  await page.waitForTimeout(400)
}

test.describe('U5 context shots', () => {
  test.skip(!OUT, 'set LU_CA_SHOTS to a folder')
  for (const theme of ['dark', 'light'] as const) {
    for (const width of [1280, 375]) {
      test(`after a run ${theme} ${width}`, async ({ page }) => {
        await boot(page, width, theme, false)
        await toCodeTab(page, width)
        await send(page, 'median() in src/math.ts returns 0, have a look')
        await page.waitForTimeout(4000)
        await openList(page)
        await page.screenshot({ path: `${OUT}/u5-run-${theme}-${width}.png` })
      })

      test(`small window ${theme} ${width}`, async ({ page }) => {
        await boot(page, width, theme, true)
        await toCodeTab(page, width)
        await send(page, 'median() in src/math.ts returns 0, have a look')
        await page.waitForTimeout(4000)
        await openList(page)
        await page.screenshot({ path: `${OUT}/u5-small-${theme}-${width}.png` })
      })
    }
  }
})
