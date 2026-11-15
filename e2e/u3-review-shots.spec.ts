import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * Pictures of the per hunk review (U3), not a test of anything. A Code tab
 * Ask run stages one file_write with two hunks. Runs only when LU_CA_SHOTS
 * names a folder:
 *
 *   LU_CA_SHOTS=/path LU_E2E_PORT=5431 npx playwright test e2e/u3-review-shots.spec.ts --project=chromium
 */
const OUT = process.env.LU_CA_SHOTS

const BEFORE = [
  'export function mean(xs: number[]): number {',
  '  return xs.reduce((a, b) => a + b, 0) / xs.length',
  '}',
  '',
  'export function sum(xs: number[]): number {',
  '  return xs.reduce((a, b) => a + b, 0)',
  '}',
  '',
  'export function max(xs: number[]): number {',
  '  return Math.max(...xs)',
  '}',
  '',
  'export function median(xs: number[]): number {',
  '  return 0 // TODO',
  '}',
  '',
]
const AFTER = [...BEFORE]
AFTER[1] = '  if (xs.length === 0) return NaN'
AFTER.splice(2, 0, '  return sum(xs) / xs.length')
AFTER.splice(14, 1,
  '  const s = [...xs].sort((a, b) => a - b)',
  '  const m = Math.floor(s.length / 2)',
  '  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2',
)

type Turn = { text?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }
const RUN: Turn[] = [
  { text: 'Let me look at the file first.', toolCalls: [{ name: 'file_read', args: { path: 'src/stats.ts' } }] },
  {
    text: 'I will guard `mean` against an empty list and implement `median`.',
    toolCalls: [{ name: 'file_write', args: { path: 'src/stats.ts', content: AFTER.join('\n') } }],
  },
  { text: 'Both changes are staged for your review.' },
]

async function boot(page: Page, width: number, theme: 'dark' | 'light') {
  await page.addInitScript(tauriMockInit, {
    assistantReply: 'unused',
    modelName: DEFAULT_MODEL_NAME,
    replyChunkDelayMs: 6,
    agentTurns: RUN,
    toolDelayMs: 150,
    files: { 'stats.ts': BEFORE.join('\n') },
  })
  await seedOnboardingDone(page)
  await page.setViewportSize({ width, height: 900 })
  await page.goto('/')
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  if (isDark !== (theme === 'dark')) {
    await page.getByRole('banner').getByTitle(/^(Light|Dark) Mode$/).click()
  }
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/${name}.png` })
}

test.describe('U3 review shots', () => {
  test.skip(!OUT, 'set LU_CA_SHOTS to a folder')
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1280, 375]) {
      test(`review ${theme} ${width}`, async ({ page }) => {
        await boot(page, width, theme)
        if (width >= 1024) await page.getByRole('button', { name: 'Code', exact: true }).click()
        else {
          await page.getByRole('banner').getByRole('button', { name: 'Main navigation' }).click().catch(() => {})
          await page.getByRole('button', { name: 'Code', exact: true }).first().click().catch(() => {})
        }
        await openNewChat(page)
        const composer = page.locator('textarea').first()
        await expect(composer).toBeEnabled({ timeout: 20_000 })
        await composer.fill('mean() breaks on an empty list and median() is missing, fix both')
        await composer.press('Enter')
        await expect(page.getByTestId('staged-changes-panel')).toBeVisible({ timeout: 20_000 })
        await page.waitForTimeout(1500)
        await shot(page, `review-${theme}-${width}-1-start`)
        if (width < 640) {
          await page.getByTestId('staged-changes-review').click()
          await shot(page, `review-${theme}-${width}-2-open`)
        } else {
          await page.getByTestId('staged-hunk').first().hover()
          await shot(page, `review-${theme}-${width}-2-hover`)
        }
        await page.getByTestId('hunk-reject').first().click()
        await page.getByTestId('staged-hunk').nth(1).hover()
        await shot(page, `review-${theme}-${width}-3-one-rejected`)
      })
    }
  }
})
