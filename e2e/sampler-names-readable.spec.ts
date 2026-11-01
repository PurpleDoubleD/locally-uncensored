import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * C24 (Discord xlollobx 31.10.2026): the Sampler and Scheduler pickers in
 * Create list "DPM++ SDE" and "Euler a", the names community tips use, with
 * ComfyUI's raw name small beside them, and the search finds either spelling.
 * Windows, local: a Mac runs MLX and has no sampler picker at all.
 *
 * ComfyUI answers through proxy_localhost, as in workflow-params.spec.ts, with
 * the KSampler lists of a current ComfyUI.
 */
const SAMPLERS = [
  'euler', 'euler_cfg_pp', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpm_fast',
  'dpmpp_2s_ancestral', 'dpmpp_sde', 'dpmpp_sde_gpu', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_2m_sde_gpu',
  'dpmpp_3m_sde', 'ddpm', 'lcm', 'ipndm', 'deis', 'res_multistep', 'ddim', 'uni_pc',
]
const SCHEDULERS = ['simple', 'sgm_uniform', 'karras', 'exponential', 'ddim_uniform', 'beta', 'normal', 'kl_optimal']
const OBJECT_INFO = {
  KSampler: { input: { required: { sampler_name: [SAMPLERS], scheduler: [SCHEDULERS] } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['juggernautXL.safetensors']] } } },
}

async function fakeComfy(page: Page) {
  await page.addInitScript((all: Record<string, unknown>) => {
    localStorage.setItem('create-store', JSON.stringify({
      state: { backend: 'local', imageModel: 'juggernautXL.safetensors', expertOpen: true },
      version: 2,
    }))
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string }) => Promise<unknown> } }
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    bridge.invoke = (command, args) => {
      if (command === 'sniff_model_files') return Promise.resolve([])
      if (command !== 'proxy_localhost' || !args?.url?.includes(':8188')) return invoke(command, args)
      const url = args.url
      if (url.includes('/system_stats')) return Promise.resolve(JSON.stringify({ devices: [{ name: 'RTX 3060', type: 'cuda', vram_total: 12 * 1024 ** 3 }] }))
      const one = /\/object_info\/([^/?]+)/.exec(url)
      if (one) return Promise.resolve(JSON.stringify(one[1] in all ? { [one[1]]: all[one[1]] } : {}))
      if (url.includes('/object_info')) return Promise.resolve(JSON.stringify(all))
      return Promise.resolve('{}')
    }
  }, OBJECT_INFO)
}

// Tall enough that the open list is readable in the screenshots.
test.use({ viewport: { width: 1280, height: 900 } })

const drawer = (page: Page) => page.locator('aside').filter({ hasText: 'Advanced settings' })
const names = (page: Page) => page.getByRole('option').locator('.lu-picker-name').allTextContents()
const shot = (name: string) => `${process.env.LU_SHOT_DIR ?? 'test-results'}/${name}.png`

test('Sampler and Scheduler show the community names and find both spellings', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await fakeComfy(page)
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).first().click()
  await page.getByRole('radio', { name: 'Image', exact: true }).click()
  await page.getByRole('button', { name: 'Advanced settings' }).click()

  const sampler = drawer(page).getByRole('button', { name: 'Sampler', exact: true })
  const scheduler = drawer(page).getByRole('button', { name: 'Scheduler', exact: true })
  await expect(drawer(page).getByRole('button', { name: 'Quality', exact: true })).toBeVisible({ timeout: 15_000 })
  if (!(await sampler.isVisible())) await drawer(page).getByRole('button', { name: 'Expert', exact: true }).click()
  // The SDXL defaults, dpmpp_2m and karras, under their readable names.
  await expect(sampler).toHaveText('DPM++ 2M', { timeout: 15_000 })
  await expect(scheduler).toHaveText('Karras')
  await expect(sampler.locator('[title]')).toHaveAttribute('title', 'dpmpp_2m')

  await sampler.click()
  // The whole list from ComfyUI, readable, raw name beside each row.
  await expect(page.getByRole('option')).toHaveCount(SAMPLERS.length)
  await expect(page.getByRole('option', { name: /^Euler a\s*euler_ancestral$/ })).toBeVisible()
  await sampler.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300) // the menu's 120 ms fade-in
  await page.screenshot({ path: shot('D2-C24-sampler-liste-1') })

  const search = page.getByPlaceholder('Search...')
  await search.fill('DPM++ SDE')
  expect(await names(page)).toEqual(['DPM++ SDE', 'DPM++ SDE GPU'])
  await page.waitForTimeout(300) // the menu's 120 ms fade-in
  await page.screenshot({ path: shot('D2-C24-sampler-suche-2') })
  await search.fill('euler_a')
  expect(await names(page)).toEqual(['Euler a'])
  await search.fill('dpmpp_2m_sde')
  expect(await names(page)).toEqual(['DPM++ 2M SDE', 'DPM++ 2M SDE GPU'])

  // A pick stores the raw name, the one ComfyUI takes.
  await page.getByRole('option').first().click()
  await expect(sampler).toHaveText('DPM++ 2M SDE')
  await expect(page.getByPlaceholder('Search...')).toHaveCount(0)
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('create-store') ?? '{}').state?.sampler)
  expect(stored).toBe('dpmpp_2m_sde')

  await scheduler.click()
  await page.getByPlaceholder('Search...').fill('sgm uniform')
  expect(await names(page)).toEqual(['SGM Uniform'])
  await page.getByRole('option').first().click()
  await expect(scheduler).toHaveText('SGM Uniform')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('create-store') ?? '{}').state?.scheduler)).toBe('sgm_uniform')
})
