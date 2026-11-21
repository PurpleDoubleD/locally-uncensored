import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

const TALL_FRAME = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="576" height="1024"><rect width="576" height="1024" fill="#789"/></svg>')}`

/** Discord 17.11.2026: the box under the running video covered its preview. */
for (const size of [{ width: 1280, height: 720 }, { width: 1100, height: 640 }]) {
  test(`the video preview and its progress stay inside the stage at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size)
    await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
    await seedOnboardingDone(page)
    await page.goto('/')
    await page.getByRole('button', { name: /^Create$/ }).first().click()
    await page.getByRole('radio', { name: 'Video', exact: true }).click()
    await page.evaluate(async ({ url, createPath, previewPath }) => {
      type Store = { setState: (next: Record<string, unknown>) => void }
      const create = (await import(/* @vite-ignore */ createPath)) as { useCreateStore: Store }
      const preview = (await import(/* @vite-ignore */ previewPath)) as { useRenderPreviewStore: Store }
      preview.useRenderPreviewStore.setState({ url, asked: true })
      create.useCreateStore.setState({ isGenerating: true, progressPhase: 'sampling', progress: 40, progressText: 'Sampling 4/20 12s' })
    }, { url: TALL_FRAME, createPath: '/src/stores/createStore.ts', previewPath: '/src/stores/renderPreviewStore.ts' })
    const figure = page.getByTestId('render-live-preview')
    await expect(figure).toBeVisible()
    await page.waitForTimeout(300)
    const box = await page.evaluate(() => {
      const stage = document.querySelector('[data-testid="create-stage"]')!.getBoundingClientRect()
      const img = document.querySelector('[data-testid="render-live-preview"] img')!.getBoundingClientRect()
      const cap = document.querySelector('[data-testid="render-live-preview"] figcaption')!.getBoundingClientRect()
      const bar = [...document.querySelectorAll('[data-testid="create-stage"] .w-56.h-1')].pop()!.getBoundingClientRect()
      return { stageTop: stage.top, stageBottom: stage.bottom, imgTop: img.top, imgHeight: img.height, capBottom: cap.bottom, barBottom: bar.bottom }
    })
    console.log(JSON.stringify({ size, ...box }))
    expect(box.imgTop).toBeGreaterThanOrEqual(box.stageTop)
    expect(box.capBottom).toBeLessThanOrEqual(box.stageBottom)
    expect(box.barBottom).toBeLessThanOrEqual(box.stageBottom)
    expect(box.imgHeight).toBeGreaterThanOrEqual(64)
  })
}
