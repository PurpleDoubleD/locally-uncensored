import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * David's Windows PC, 21.11.2026 (RTX 5080, 16 GB):
 *  - the 3D way switch and the setup card stand in the middle of the prompt
 *  - "Download & install" says first which model, how big, and if it fits
 *  - a pip run of the trainer setup is in the Downloads tray from anywhere,
 *    with a stop and without a pause button that could not work
 */
const GPU = [{ index: 0, vendor: 'NVIDIA', name: 'NVIDIA GeForce RTX 5080', memory_mib: 16376, source: 'nvidia-smi' }]
const TRAINER_JOB = {
  id: 'trainer',
  label: 'Trainer setup',
  status: 'running',
  phase: 'Setting up the trainer (3/4): installing PyTorch into the trainer venv (~2.5 GB, one time)...',
  progress: 0,
  total: 0,
  speed: 0,
  canCancel: true,
  note: 'This step can be stopped, not paused.',
}

async function open3d(page: Page, overrides: Record<string, unknown>) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
    platform: 'windows' as const,
    invokeOverrides: { detect_gpus: GPU, ...overrides },
  })
  await seedOnboardingDone(page)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).first().click()
  await page.getByRole('radio', { name: /3D/ }).first().click()
}

/** The tray opens itself when a job appears, and a click elsewhere shuts it.
 *  Waits out its animation first, or the click below would close it again. */
async function openTray(page: Page) {
  await page.waitForTimeout(400)
  if (!(await page.locator('[data-install-job="trainer"]').isVisible())) await page.getByTitle('Downloads').click()
}

const middle = async (page: Page, testId: string) => {
  const box = await page.getByTestId(testId).boundingBox()
  expect(box, testId).not.toBeNull()
  return box!.x + box!.width / 2
}

test('the 3D way switch and the setup card stand on the axis of the prompt', async ({ page }) => {
  await open3d(page, { install_jobs: [] })
  await expect(page.getByTestId('three-d-setup')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(300)
  const axis = await middle(page, 'three-d-controls')
  const way = await page.getByTestId('three-d-way').locator(':scope > *').first().boundingBox()
  const wayOff = Math.abs(way!.x + way!.width / 2 - axis)
  const cardOff = Math.abs(await middle(page, 'three-d-setup') - axis)
  expect(wayOff, 'the way switch').toBeLessThan(2)
  expect(cardOff, 'the setup card').toBeLessThan(2)
})

test('the setup names the model, its size and the fit, and loads nothing before the click', async ({ page }) => {
  await open3d(page, { install_jobs: [] })
  const row = page.getByTestId('three-d-choice-trellis2')
  await expect(row).toContainText('TRELLIS.2', { timeout: 10_000 })
  await expect(row).toContainText('Recommended')
  await expect(row).toContainText('GB')
  await expect(row).toContainText('Fits your 16 GB graphics card.')
  await expect(row).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTitle('Downloads')).toHaveAttribute('data-downloads-active', '0')
})

test('a running trainer setup is in the tray on every screen, with a stop and no pause', async ({ page }) => {
  await open3d(page, { install_jobs: [TRAINER_JOB] })
  const tray = page.getByTitle('Downloads')
  await expect(tray).toHaveAttribute('data-downloads-active', '1', { timeout: 10_000 })
  const row = page.locator('[data-install-job="trainer"]')
  await openTray(page)
  await expect(row).toBeVisible()
  await expect(row).toContainText('This step can be stopped, not paused.')
  await expect(row.getByTitle('Pause')).toHaveCount(0)
  await expect(page.locator('[data-install-job-stop="trainer"]')).toBeVisible()

  await page.getByRole('button', { name: /^Chat$/ }).first().click().catch(() => undefined)
  await expect(tray).toHaveAttribute('data-downloads-active', '1')

  await openTray(page)
  await page.evaluate(() => {
    const w = window as unknown as { __E2E_INVOKE_OVERRIDES__?: Record<string, unknown> }
    w.__E2E_INVOKE_OVERRIDES__ = { ...(w.__E2E_INVOKE_OVERRIDES__ ?? {}), cancel_install_job: null }
  })
  await page.locator('[data-install-job-stop="trainer"]').click()
  await page.evaluate((job) => {
    const w = window as unknown as { __E2E_INVOKE_OVERRIDES__?: Record<string, unknown> }
    w.__E2E_INVOKE_OVERRIDES__ = { ...(w.__E2E_INVOKE_OVERRIDES__ ?? {}), install_jobs: [{ ...job, status: 'cancelled', canCancel: false, note: '' }] }
  }, TRAINER_JOB)
  await expect(row).toContainText('Stopped', { timeout: 5_000 })
  await expect(tray).toHaveAttribute('data-downloads-active', '0')
})
