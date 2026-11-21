import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * Create, 3.1.3: with ComfyUI down and slow answers, a tab shows one setup
 * card and keeps it. Before, the work surface came first, then "needs a
 * one-time download", then "Your model files are already here".
 */
test('a slow answer: the stage waits, then shows one card and keeps it', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, never> & { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> }; __SEEN__: string[] }
    localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local' }, version: 2 }))
    const later = <T,>(fn: () => T) => new Promise<T>((res, rej) => setTimeout(() => { try { res(fn()) } catch (e) { rej(e) } }, 500))
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    bridge.invoke = (command: string, raw: unknown) => {
      const args = raw as { url?: string; files: Array<{ filename: string; expectedBytes: number }> }
      if (command === 'comfyui_status') return later(() => ({ running: false, starting: false, found: true, complete: true, isLocal: true }))
      if (command === 'check_model_sizes') return later(() => args.files.map((f) => ({ filename: f.filename, exists: true, complete: true, actualBytes: f.expectedBytes })))
      if (command === 'proxy_localhost' && args?.url?.includes(':8188')) return later(() => { throw new Error('connection refused') })
      return invoke(command, args)
    }
    w.__SEEN__ = []
    const look = () => {
      const layer = document.querySelector('[data-testid="create-stage"] [data-stage-layer="present"]')
      if (!layer) return
      const face = layer.querySelector('[data-testid="stage-pending"]') ? 'wait' : layer.querySelector('.t-title')?.textContent ?? 'work'
      const seen = w.__SEEN__ as string[]
      if (seen[seen.length - 1] !== face) seen.push(face)
    }
    const loop = () => { look(); requestAnimationFrame(loop) }
    requestAnimationFrame(loop)
  })
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).first().click()
  await page.getByRole('radio', { name: 'Video', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start ComfyUI' })).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(800)

  const seen = await page.evaluate(() => (window as unknown as { __SEEN__: string[] }).__SEEN__)
  const faces = seen.filter((f) => f !== 'wait')
  // The Image tab may have answered before the switch. On Video only one card.
  expect(faces.filter((f) => /video generation/i.test(f))).toEqual([])
  expect(faces[faces.length - 1]).toBe('Your model files are already here')
  expect(faces.filter((f) => f === 'What do you want to create?' || f === 'Describe a scene to animate')).toEqual([])
})
