import { test, expect, type Page } from '@playwright/test'
import { writeFileSync } from 'fs'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { gradientPng } from './support/png'
import { appModules, type AppWindow } from './support/ui'

/**
 * N2 for 3.1.0 on a Windows or Linux desktop with a stand-in ComfyUI that
 * lists the Qwen-Image 2.1 nodes and records every graph posted to /prompt:
 *
 *   C75  a Qwen-Image 2.1 edit in a shape of its own ("Custom size")
 *   C72  a workflow of the user's own takes the LoRA stack, and one whose
 *        loader does not fit the model says so before and after the run
 *   C79  the LoRA list under Workflow parameters has a search and is LU's
 *        own list, readable in LU Dark
 *
 * LU_SHOTS=<folder> writes the screenshots and the posted graphs there.
 */

const QWEN = 'qwen_image_2.1_int8_convrot.safetensors'
const SHOTS = process.env.LU_SHOTS
const PNG = gradientPng(768, 512).toString('base64')
const LORAS = ['detail_slider.safetensors', ...Array.from({ length: 30 }, (_, i) => `style_${String(i).padStart(2, '0')}.safetensors`)]

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(({ model, loras }) => {
    const w = window as unknown as { __PROMPTS__: string[]; __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string; method?: string; body?: string }) => Promise<unknown> } }
    if (!localStorage.getItem('create-store')) {
      localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local', imageModel: model }, version: 2 }))
    }
    w.__PROMPTS__ = []
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    const combo = (v: string[]) => [v]
    const nodes: Record<string, unknown> = {
      UNETLoader: { input: { required: { unet_name: combo([model]), weight_dtype: combo(['default', 'fp8_e4m3fn']) } } },
      CheckpointLoaderSimple: { input: { required: { ckpt_name: combo(['juggernaut.safetensors']) } } },
      CLIPLoader: { input: { required: { clip_name: combo(['qwen3vl_8b_int8_convrot.safetensors']), type: combo(['qwen_image', 'stable_diffusion']), device: combo(['default', 'cpu']) } } },
      VAELoader: { input: { required: { vae_name: combo(['qwen_image_2.1_vae_bf16.safetensors']) } } },
      LoraLoader: { input: { required: { model: ['MODEL'], clip: ['CLIP'], lora_name: combo(loras), strength_model: ['FLOAT', { default: 1, min: -100, max: 100, step: 0.01 }], strength_clip: ['FLOAT', { default: 1, min: -100, max: 100, step: 0.01 }] } } },
      LoraLoaderModelOnly: { input: { required: { model: ['MODEL'], lora_name: combo(loras), strength_model: ['FLOAT', { default: 1 }] } } },
      KSampler: { input: { required: { model: ['MODEL'], seed: ['INT'], steps: ['INT'], cfg: ['FLOAT'], sampler_name: combo(['euler']), scheduler: combo(['simple']), positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], denoise: ['FLOAT', { default: 1, min: 0, max: 1, step: 0.01 }] } } },
      TextEncodeQwenImage21: { input: { required: { clip: ['CLIP'], prompt: ['STRING'], negative_prompt: ['STRING'], resolution: ['INT'] }, optional: { vae: ['VAE'], 'images.image_1': ['IMAGE'] } } },
      ImageScale: { input: { required: { image: ['IMAGE'], upscale_method: combo(['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos']), width: ['INT'], height: ['INT'], crop: combo(['disabled', 'center']) } } },
      CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } } },
      ImageScaleToTotalPixels: { input: { required: {} } },
      EmptyLatentImage: { input: { required: { width: ['INT'], height: ['INT'], batch_size: ['INT'] } } },
      VAEEncode: { input: { required: {} } }, VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
      SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } } }, LoadImage: { input: { required: { image: combo(['source.png']) } } },
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
        const images = [{ filename: `n2_${hist[1]}.png`, subfolder: '', type: 'output' }]
        return Promise.resolve(JSON.stringify({ [hist[1]]: { status: { status_str: 'success', completed: true, messages: [] }, outputs: { '9': { images } } } }))
      }
      if (url.includes('/queue')) return Promise.resolve(JSON.stringify({ queue_running: [], queue_pending: [] }))
      const one = /\/object_info\/([^/?]+)/.exec(url)
      if (one) return Promise.resolve(JSON.stringify(one[1] in nodes ? { [one[1]]: nodes[one[1]] } : {}))
      if (url.includes('/object_info')) return Promise.resolve(JSON.stringify(nodes))
      return Promise.resolve('{}')
    }
  }, { model: QWEN, loras: LORAS })
  await page.route(/:8188\/view/, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG, 'base64') }))
}

const shot = async (page: Page, name: string) => {
  if (!SHOTS) return
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

const posted = (page: Page) => page.evaluate(() => (window as unknown as { __PROMPTS__: string[] }).__PROMPTS__.map((p) => (JSON.parse(p) as { prompt: Graph }).prompt))

const drawer = (page: Page) => page.locator('aside').filter({ hasText: 'Advanced settings' })

async function openCreate(page: Page, tab: 'Image' | 'Edit / Image to Image') {
  await boot(page)
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: tab, exact: true }).click()
  await appModules(page, ['/src/stores/createStore.ts', '/src/stores/workflowStore.ts', '/src/api/workflows.ts'])
}

const stageSource = (page: Page) => page.evaluate((png) => {
  const s = (window as unknown as AppWindow).__APP__['/src/stores/createStore.ts'].useCreateStore
  s.setState({ source: { filename: 'source.png', url: `data:image/png;base64,${png}`, width: 768, height: 512 }, sourceSetAt: Date.now() })
}, PNG)

/** A workflow of the user's own, assigned to the Qwen model by name. */
const installWorkflow = (page: Page, graph: Graph, name: string) => page.evaluate(({ graph, name, model }) => {
  const app = (window as unknown as AppWindow).__APP__
  const parameterMap = app['/src/api/workflows.ts'].autoDetectParameterMap(graph)
  app['/src/stores/workflowStore.ts'].useWorkflowStore.setState({
    installedWorkflows: [{ id: 'wf-n2', name, description: '', source: 'manual', modelTypes: ['qwenimage'], mode: 'image', workflow: graph, parameterMap, installedAt: 1 }],
    modelNameAssignments: { [model]: 'wf-n2' }, paramOverrides: {},
  })
}, { graph, name, model: QWEN })

const OWN_QWEN: Graph = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: QWEN, weight_dtype: 'default' } },
  '2': { class_type: 'LoraLoader', inputs: { model: ['1', 0], clip: ['4', 0], lora_name: 'detail_slider.safetensors', strength_model: 0.8, strength_clip: 0.8 }, _meta: { title: 'Detail LoRA' } },
  '4': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_8b_int8_convrot.safetensors', type: 'qwen_image', device: 'default' } },
  '5': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['2', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 1] } },
  '8': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  '3': { class_type: 'KSampler', inputs: { model: ['2', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['8', 0], seed: 1, steps: 20, cfg: 2.5, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
  '10': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['5', 0] } },
  '9': { class_type: 'SaveImage', inputs: { images: ['10', 0], filename_prefix: 'own' } },
}

const CHECKPOINT_WF: Graph = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'juggernaut.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  '3': { class_type: 'KSampler', inputs: { model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0], seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'sdxl' } },
}

test('C75: a Qwen-Image 2.1 edit in 16:9 from a 3:2 picture crops the source to that shape before the encode', async ({ page }) => {
  await openCreate(page, 'Edit / Image to Image')
  await stageSource(page)
  await page.getByRole('button', { name: 'Advanced settings' }).click()
  const shape = drawer(page).getByTestId('qwen-edit-shape')
  await expect(shape).toBeVisible({ timeout: 15_000 })
  // The default is the run of today.
  await expect(shape.getByRole('radio', { name: 'Like the picture' })).toHaveAttribute('aria-checked', 'true')
  await expect(shape).toContainText('The edit keeps the shape of the picture')
  await shape.getByRole('radio', { name: 'Custom size' }).click()
  await drawer(page).getByRole('button', { name: '16:9', exact: true }).click()
  await expect(shape).toContainText('The picture is scaled to fill that shape and cropped from its centre.')
  await shape.scrollIntoViewIfNeeded()
  await shot(page, 'c75-edit-seitenverhaeltnis')
  const size = await page.evaluate(() => {
    const s = (window as unknown as AppWindow).__APP__['/src/stores/createStore.ts'].useCreateStore.getState()
    return { width: s.width as number, height: s.height as number }
  })
  expect(size.width / size.height).toBeCloseTo(16 / 9, 1)
  await page.keyboard.press('Escape')

  await page.getByRole('textbox').filter({ hasText: '' }).first().fill('make it a beach at sunset')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(async () => (await posted(page)).length, { timeout: 20_000 }).toBe(1)
  const graph = (await posted(page))[0]
  const [scaleId, scale] = Object.entries(graph).find(([, n]) => n.class_type === 'ImageScale')!
  expect(scale.inputs).toMatchObject({ width: size.width, height: size.height, crop: 'center', upscale_method: 'lanczos' })
  expect(graph[(scale.inputs.image as [string, number])[0]].inputs.image).toBe('source.png')
  const enc = Object.values(graph).find((n) => n.class_type === 'TextEncodeQwenImage21')!
  expect(enc.inputs['images.image_1']).toEqual([scaleId, 0])
  if (SHOTS) writeFileSync(`${SHOTS}/c75-workflow-16zu9.json`, JSON.stringify(graph, null, 2))
})

test('C72 + C79: an own workflow takes the LoRA stack, and its LoRA list has a search', async ({ page }) => {
  await openCreate(page, 'Image')
  await installWorkflow(page, OWN_QWEN, 'My Qwen with a LoRA')
  await page.evaluate(() => {
    const s = (window as unknown as AppWindow).__APP__['/src/stores/createStore.ts'].useCreateStore
    s.setState({ selectedLoras: [{ name: 'style_07.safetensors', strength: 0.7 }] })
  })
  await page.getByRole('button', { name: 'Advanced settings' }).click()
  const params = drawer(page).getByRole('region', { name: 'Workflow parameters' })
  await expect(params).toBeVisible({ timeout: 15_000 })
  await params.getByRole('button', { name: /Detail LoRA/ }).click()
  await params.getByRole('button', { name: 'Lora name' }).click()
  const search = page.getByRole('textbox', { name: 'Search Lora name' })
  await expect(search).toBeVisible()
  await search.fill('style_1')
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(10)
  await shot(page, 'c79-lora-liste-mit-suche')
  await page.getByRole('listbox').getByRole('option', { name: 'style_12.safetensors' }).click()
  await expect(params.getByRole('button', { name: 'Lora name' })).toHaveText('style_12.safetensors')
  await page.keyboard.press('Escape')

  await page.getByRole('textbox').filter({ hasText: '' }).first().fill('a cat on a sofa')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(async () => (await posted(page)).length, { timeout: 20_000 }).toBe(1)
  const graph = (await posted(page))[0]
  // The workflow's own LoRA, with the file picked in the list.
  expect(graph['2'].inputs.lora_name).toBe('style_12.safetensors')
  // The stack's LoRA, chained in behind the model loader.
  const [addedId, added] = Object.entries(graph).find(([, n]) => n._meta?.title === 'LoRA (LU): style_07.safetensors')!
  expect(added.class_type).toBe('LoraLoader')
  expect(added.inputs).toMatchObject({ model: ['1', 0], clip: ['4', 0], strength_model: 0.7, strength_clip: 0.7 })
  expect(graph['2'].inputs.model).toEqual([addedId, 0])
  expect(graph['2'].inputs.clip).toEqual([addedId, 1])
  if (SHOTS) writeFileSync(`${SHOTS}/c72-workflow-mit-lora.json`, JSON.stringify(graph, null, 2))
})

test('C72: a workflow whose loader does not fit the model says so in the settings and under the result', async ({ page }) => {
  await openCreate(page, 'Image')
  await installWorkflow(page, CHECKPOINT_WF, 'My SDXL workflow')
  await page.getByRole('button', { name: 'Advanced settings' }).click()
  const misfit = drawer(page).getByTestId('own-workflow-misfit')
  await expect(misfit).toBeVisible({ timeout: 15_000 })
  await expect(misfit).toContainText('Your workflow "My SDXL workflow" is not used: this model is a diffusion model and needs a UNETLoader')
  await misfit.scrollIntoViewIfNeeded()
  await shot(page, 'c72-hinweis-lader-passt-nicht')
  await page.keyboard.press('Escape')

  await page.getByRole('textbox').filter({ hasText: '' }).first().fill('a cat on a sofa')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(async () => (await posted(page)).length, { timeout: 20_000 }).toBe(1)
  // LU's own graph ran, and the result says why.
  const graph = (await posted(page))[0]
  expect(Object.values(graph).some((n) => n.class_type === 'TextEncodeQwenImage21')).toBe(true)
  expect(Object.values(graph).some((n) => n.class_type === 'CheckpointLoaderSimple')).toBe(false)
  await expect(page.getByTestId('run-note')).toContainText('is not used', { timeout: 20_000 })
  await shot(page, 'c72-hinweis-am-ergebnis')
})
