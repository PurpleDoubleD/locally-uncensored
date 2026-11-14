import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME, DEFAULT_ASSISTANT_REPLY } from '../e2e/support/tauri-mock'
import { seedOnboardingDone, cloudSwitch } from '../e2e/support/cloud-mock'

/**
 * Picture first (3.1.0) against the local web stack: the desktop's cloud way
 * "From text" paints a picture with an open image model, the server copies
 * that picture into the account's inputs (/api/jobs/adopt), and TRELLIS.2
 * makes the 3D model from it. Nothing is intercepted: the job routes, their
 * price checks and credit claims, the adopt route and the render worker are
 * the real server; the render provider is the stack's stand-in (it answers a
 * 3D job with a real GLB). No real provider, no money.
 *
 * Run: node scripts/create-chat-stack-probe.mjs <web repo> e2e-stack/create-3d-picture-first.spec.ts
 * with the stack of a web branch that carries 3D (feat/310-create-3d).
 */
const CLOUD = process.env.LU_STACK_CLOUD ?? ''
type Account = { email: string; password: string }
const RELEASED = JSON.parse(process.env.LU_STACK_RELEASED ?? '{}') as Account

interface Wire {
  posts: Array<{ path: string; status: number; body: Record<string, unknown> }>
  outside: string[]
}

async function signIn(page: Page, account: Account): Promise<Wire> {
  const wire: Wire = { posts: [], outside: [] }
  page.on('response', async (res) => {
    const req = res.request()
    if (!req.url().startsWith(CLOUD) || req.method() !== 'POST') return
    const path = new URL(req.url()).pathname
    if (!path.startsWith('/api/jobs')) return
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(req.postData() ?? '{}') } catch { body = {} }
    wire.posts.push({ path, status: res.status(), body })
  })
  page.on('requestfailed', (req) => {
    const host = new URL(req.url()).hostname
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== new URL(CLOUD).hostname && !host.endsWith('.supabase.co')) wire.outside.push(req.url())
  })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await page.goto('/')
  await cloudSwitch(page).click()
  await page.getByRole('button', { name: /Already subscribed\? Sign in/i }).click()
  await page.getByPlaceholder('Email').fill(account.email)
  await page.getByPlaceholder('Password').fill(account.password)
  await page.getByRole('button', { name: /^Sign in$/i }).click()
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 30_000 })
  return wire
}

test('picture first: z-image paints, the server adopts the picture, TRELLIS.2 makes the model', async ({ page }) => {
  test.setTimeout(240_000)
  const wire = await signIn(page, RELEASED)
  await page.getByRole('button', { name: /^Create$/ }).first().click()
  await page.getByRole('radio', { name: /3D/ }).first().click()
  await page.getByRole('radio', { name: 'From text' }).click()
  const chip = page.locator('button[aria-haspopup="listbox"]').last()
  await expect(chip).toContainText('Picture first', { timeout: 30_000 })
  await page.getByRole('radio', { name: 'Draft' }).click()
  await page.locator('textarea').first().fill('a clay teapot with a bamboo handle')
  await page.getByRole('button', { name: /^Create$/ }).last().click()

  await expect(page.getByTestId('model-viewer-canvas')).toBeVisible({ timeout: 180_000 })

  const jobs = wire.posts.filter((p) => p.path === '/api/jobs')
  const adopt = wire.posts.filter((p) => p.path.startsWith('/api/jobs/adopt'))
  expect(jobs.map((j) => [j.body.kind, j.body.model, j.status < 300])).toEqual([['image', 'z-image', true], ['3d', 'trellis-2', true]])
  expect(adopt.map((a) => a.status < 300)).toEqual([true])
  const step2 = jobs[1].body.params as Record<string, unknown>
  expect(String(step2.source_path)).toMatch(/\/job-/)
  expect(String(step2.source_prompt)).toContain('a clay teapot with a bamboo handle')
  expect(String((jobs[0].body as { prompt?: string }).prompt)).toContain('a single object, whole and centered')
  expect(wire.outside).toEqual([])
  await page.screenshot({ path: 'test-results/stack-picture-first.png' })
})
