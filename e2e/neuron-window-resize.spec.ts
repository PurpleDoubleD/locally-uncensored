import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * 3.1.3: the Neurons window grows and shrinks at its sides and corners, in the
 * real app with the Tauri bridge mocked.
 *
 * Run: LU_E2E_PORT=5397 CI=1 npx playwright test e2e/neuron-window-resize.spec.ts --project=chromium --project=webkit
 */

// The window only needs a calm backend: no presets, no job running.
const NEURON_BACKEND = {
  neuron_presets: [],
  neuron_status: {
    status: 'idle', kind: '', title: '', modelPath: '', phaseLabel: '', step: 0, total: 0,
    bytesDone: 0, bytesTotal: 0, rateBps: 0, etaSecs: null, elapsedSecs: 0, resultId: null, error: null,
  },
}

const win = (page: Page) => page.getByTestId('neuron-window')

async function box(page: Page) {
  const b = await win(page).boundingBox()
  if (!b) throw new Error('no window')
  return b
}

async function zoomOf(page: Page) {
  return win(page).evaluate((el) => {
    let z = 1
    for (let e: Element | null = el; e; e = e.parentElement) z *= parseFloat(getComputedStyle(e).zoom) || 1
    return z
  })
}

async function openWindow(page: Page) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, invokeOverrides: NEURON_BACKEND })
  await seedOnboardingDone(page)
  // The introduction lies over the window on the first open; it has its own tests.
  await page.addInitScript(() => {
    if (!localStorage.getItem('lu-neuron-tweaker')) {
      localStorage.setItem('lu-neuron-tweaker', JSON.stringify({ state: { introSeen: true }, version: 0 }))
    }
  })
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/')
  await showWindow(page)
}

/** Through the Plugins menu, as a user does. The test's start script seeds the
 *  settings on every load, so after a reload the plugin may be off again. */
async function showWindow(page: Page) {
  const menu = page.getByRole('button', { name: /^Plugins/ }).first()
  const sw = page.getByTestId('plugins-neurons-switch')
  await menu.click()
  if ((await sw.getAttribute('aria-pressed')) !== 'true') await sw.click()
  if (!(await win(page).isVisible())) {
    if (!(await page.getByTestId('plugins-neurons-open').isVisible())) await menu.click()
    await page.getByTestId('plugins-neurons-open').click()
  }
  await expect(win(page)).toBeVisible()
}

async function pull(page: Page, edge: string, dx: number, dy: number) {
  const g = await page.getByTestId(`neuron-resize-${edge}`).boundingBox()
  if (!g) throw new Error(`no grip ${edge}`)
  const x = g.x + g.width / 2
  const y = g.y + g.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 })
  await page.mouse.move(x + dx, y + dy, { steps: 4 })
  await page.mouse.up()
}

test('a corner pulls both sides, and the size survives a restart', async ({ page }) => {
  await openWindow(page)
  const before = await box(page)
  await pull(page, 'sw', -120, -80)
  const after = await box(page)
  expect(Math.abs(after.width - before.width - 120)).toBeLessThanOrEqual(2)
  expect(Math.abs(after.height - before.height + 80)).toBeLessThanOrEqual(2)
  expect(Math.abs(after.x + after.width - before.x - before.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1)

  await page.reload()
  await showWindow(page)
  const back = await box(page)
  expect(Math.abs(back.width - after.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(back.height - after.height)).toBeLessThanOrEqual(1)
})

test('a side pulls only that side, past the window edge too', async ({ page }) => {
  await openWindow(page)
  const before = await box(page)
  await pull(page, 'w', -60, 200)
  const after = await box(page)
  expect(Math.abs(after.width - before.width - 60)).toBeLessThanOrEqual(2)
  expect(after.height).toBeCloseTo(before.height, 0)
  expect(after.y).toBeCloseTo(before.y, 0)
})

test('the grips use the right pointers and do not sit on the title bar buttons', async ({ page }) => {
  await openWindow(page)
  const cursors = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' }
  for (const [edge, cursor] of Object.entries(cursors)) {
    await expect(page.getByTestId(`neuron-resize-${edge}`)).toHaveCSS('cursor', cursor)
  }
  const grips = await Promise.all(Object.keys(cursors).map((edge) => page.getByTestId(`neuron-resize-${edge}`).boundingBox()))
  for (const id of ['neuron-window-close', 'neuron-window-fold', 'neuron-help']) {
    const b = (await page.getByTestId(id).boundingBox())!
    for (const g of grips) {
      const apart = g!.x + g!.width <= b.x || b.x + b.width <= g!.x || g!.y + g!.height <= b.y || b.y + b.height <= g!.y
      expect(apart, id).toBe(true)
    }
  }
  await page.getByTestId('neuron-window-close').click()
  await expect(win(page)).toBeHidden()
})

test('moving by the title bar keeps the size', async ({ page }) => {
  await openWindow(page)
  await pull(page, 'se', -40, -60)
  const before = await box(page)
  const t = await page.getByTestId('neuron-window-title').boundingBox()
  await page.mouse.move(t!.x + 120, t!.y + 12)
  await page.mouse.down()
  await page.mouse.move(t!.x - 180, t!.y + 72, { steps: 6 })
  await page.mouse.up()
  const after = await box(page)
  expect(after.x).toBeLessThan(before.x - 200)
  expect(after.width).toBeCloseTo(before.width, 0)
  expect(after.height).toBeCloseTo(before.height, 0)
})

test('stays inside when the app window gets smaller, and takes its size back', async ({ page }) => {
  await openWindow(page)
  await pull(page, 'w', -300, 0)
  const large = await box(page)
  await page.setViewportSize({ width: 620, height: 520 })
  await expect.poll(async () => (await box(page)).width).toBeLessThan(large.width)
  const small = await box(page)
  const z = await zoomOf(page)
  expect(small.x).toBeGreaterThanOrEqual(0)
  expect(small.y).toBeGreaterThanOrEqual(0)
  expect(small.x + small.width).toBeLessThanOrEqual(620 + z)
  expect(small.y + small.height).toBeLessThanOrEqual(520 + z)
  await page.setViewportSize({ width: 1400, height: 900 })
  await expect.poll(async () => Math.round((await box(page)).width)).toBe(Math.round(large.width))
})
