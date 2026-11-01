import { test, expect, type Page } from '@playwright/test'
import { writeFileSync } from 'fs'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { gradientPng } from './support/png'
import { appModules, type AppWindow } from './support/ui'

/**
 * 3.0.9 D6 / B46 (Discord boromirofgeo 30.10.2026): the Edit strength of a
 * Qwen-Image 2.1 edit through ComfyUI is back, and it reaches the graph.
 * Windows or Linux, local: a Mac runs this model on MLX, where the slider was
 * never gone.
 *
 * The stand-in ComfyUI lists the Qwen-Image 2.1 nodes and records every graph
 * posted to /prompt. LU_SHOTS=<folder> writes the screenshots and the posted
 * graphs there.
 */

const QWEN = 'qwen_image_2.1_int8_convrot.safetensors'
const SHOTS = process.env.LU_SHOTS
const PNG = gradientPng(768, 512).toString('base64')

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript((model) => {
    const w = window as unknown as { __PROMPTS__: string[]; __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string; method?: string; body?: string }) => Promise<unknown> } }
    if (!localStorage.getItem('create-store')) {
      localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local', imageModel: model }, version: 2 }))
    }
    w.__PROMPTS__ = []
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    const combo = (v: string[]) => [v]
    const nodes: Record<string, unknown> = {
      UNETLoader: { input: { required: { unet_name: combo([model as string]) } } },
      CLIPLoader: { input: { required: { clip_name: combo(['qwen3vl_8b_int8_convrot.safetensors']) } } },
      VAELoader: { input: { required: { vae_name: combo(['qwen_image_2.1_vae_bf16.safetensors']) } } },
      KSampler: { input: { required: { sampler_name: combo(['euler']), scheduler: combo(['simple']) } } },
      TextEncodeQwenImage21: { input: { required: { clip: ['CLIP'], prompt: ['STRING'], negative_prompt: ['STRING'], resolution: ['INT'] }, optional: { vae: ['VAE'], 'images.image_1': ['IMAGE'] } } },
      ImageScaleToTotalPixels: { input: { required: {} } },
      EmptyLatentImage: { input: { required: {} } }, VAEEncode: { input: { required: {} } }, VAEDecode: { input: { required: {} } },
      SaveImage: { input: { required: {} } }, LoadImage: { input: { required: { image: combo(['source.png']) } } },
      VAEEncodeForInpaint: { input: { required: {} } }, InpaintModelConditioning: { input: { required: {} } }, LoadImageMask: { input: { required: {} } },
    }
    bridge.invoke = (command, args) => {
      if (command === 'sniff_model_files') return Promise.resolve([])
      if (command !== 'proxy_localhost' || !args?.url?.includes(':8188')) return invoke(command, args)
      const url = args.url
      if (url.includes('/system_stats')) return Promise.resolve(JSON.stringify({ devices: [{ name: 'RTX 4090', type: 'cuda', vram_total: 24 * 1024 ** 3 }] }))
      if (url.endsWith('/prompt') && args.method === 'POST') {
        w.__PROMPTS__.push(String(args.body))
        return Promise.resolve(JSON.stringify({ prompt_id: `p${w.__PROMPTS__.length}`, number: 1, node_errors: {} }))
      }
      const hist = /\/history\/(p\d+)/.exec(url)
      if (hist) {
        const images = [{ filename: `d6_${hist[1]}.png`, subfolder: '', type: 'output' }]
        return Promise.resolve(JSON.stringify({ [hist[1]]: { status: { status_str: 'success', completed: true, messages: [] }, outputs: { '9': { images } } } }))
      }
      if (url.includes('/queue')) return Promise.resolve(JSON.stringify({ queue_running: [], queue_pending: [] }))
      const one = /\/object_info\/([^/?]+)/.exec(url)
      if (one) return Promise.resolve(JSON.stringify(one[1] in nodes ? { [one[1]]: nodes[one[1]] } : {}))
      if (url.includes('/object_info')) return Promise.resolve(JSON.stringify(nodes))
      return Promise.resolve('{}')
    }
  }, QWEN)
  await page.route(/:8188\/view/, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG, 'base64') }))
}

const shot = async (page: Page, name: string) => {
  if (!SHOTS) return
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

/** A source picture on the Edit stage, as ComfyUI's upload would leave it. */
const stageSource = (page: Page) => page.evaluate((png) => {
  const s = (window as unknown as AppWindow).__APP__['/src/stores/createStore.ts'].useCreateStore
  s.setState({ source: { filename: 'source.png', url: `data:image/png;base64,${png}`, width: 768, height: 512 }, sourceSetAt: Date.now() })
}, PNG)

const posted = (page: Page) => page.evaluate(() => (window as unknown as { __PROMPTS__: string[] }).__PROMPTS__.map((p) => (JSON.parse(p) as { prompt: Graph }).prompt))

async function openEdit(page: Page) {
  await boot(page)
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: 'Edit / Image to Image', exact: true }).click()
  await appModules(page, ['/src/stores/createStore.ts'])
  await stageSource(page)
}

/** The Edit strength row under the prompt: label, value, range input. */
const strengthRow = (page: Page) => page.locator('div.space-y-1\\.5').filter({ has: page.getByText('Edit strength', { exact: true }) }).first()

test('B46: Qwen-Image 2.1 Edit through ComfyUI has the Edit strength again, and 0.40 is the denoise of the run', async ({ page }) => {
  await openEdit(page)

  // At 1.00 by default: the run of today.
  const row = strengthRow(page)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row).toContainText('1.00')
  await shot(page, 'D6-B46-1')

  // The real range input, moved down to 0.40 with the keyboard.
  const range = row.locator('input[type="range"]')
  await range.focus()
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowLeft')
  await expect(row).toContainText('0.40')
  await page.getByRole('textbox').filter({ hasText: '' }).first().fill('make the jacket red')
  await shot(page, 'D6-B46-2')
  await page.getByRole('button', { name: /^Create$/ }).last().click()

  await expect.poll(async () => (await posted(page)).length, { timeout: 20_000 }).toBe(1)
  const low = (await posted(page))[0]
  const sampler = Object.values(low).find((n) => n.class_type === 'KSampler')!
  expect(sampler.inputs.denoise).toBe(0.4)
  const from = low[(sampler.inputs.latent_image as [string, number])[0]]
  expect(from.class_type).toBe('VAEEncode')
  const scale = low[(from.inputs.pixels as [string, number])[0]]
  expect(scale.class_type).toBe('ImageScaleToTotalPixels')
  expect(low[(scale.inputs.image as [string, number])[0]].inputs.image).toBe('source.png')

  if (SHOTS) {
    writeFileSync(`${SHOTS}/D6-workflow-staerke-0.40.json`, JSON.stringify(low, null, 2))
  }

  // The Advanced settings show the same field.
  await page.getByRole('button', { name: 'Advanced settings' }).click()
  const expert = page.getByRole('button', { name: 'Expert', exact: true })
  await expect(expert).toBeVisible({ timeout: 15_000 })
  const drawer = page.locator('aside').filter({ hasText: 'Advanced settings' })
  if (!(await drawer.getByText('Edit strength', { exact: true }).isVisible())) await expert.click()
  await expect(drawer.getByText('Edit strength', { exact: true })).toBeVisible()
  await expect(drawer.getByText('Denoise (raw)')).toHaveCount(0)
  await drawer.getByText('Edit strength', { exact: true }).scrollIntoViewIfNeeded()
  await shot(page, 'D6-B46-3')
})

test('COUNTER-CHECK B46: at 1.00 (the default) the run is the template edit of today', async ({ page }) => {
  await openEdit(page)
  await expect(strengthRow(page)).toContainText('1.00', { timeout: 15_000 })
  await page.getByRole('textbox').filter({ hasText: '' }).first().fill('make the jacket red')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(async () => (await posted(page)).length, { timeout: 20_000 }).toBe(1)
  const full = (await posted(page))[0]
  const sampler = Object.values(full).find((n) => n.class_type === 'KSampler')!
  expect(sampler.inputs.denoise).toBe(1)
  expect(full[(sampler.inputs.latent_image as [string, number])[0]].class_type).toBe('TextEncodeQwenImage21')
  expect(Object.values(full).some((n) => n.class_type === 'ImageScaleToTotalPixels')).toBe(false)
  if (SHOTS) writeFileSync(`${SHOTS}/D6-workflow-staerke-1.00.json`, JSON.stringify(full, null, 2))
})
