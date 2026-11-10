import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { gradientPng } from './support/png'

/**
 * C56 (3.1.0), the_cave_dweller on Discord: RTX 4090 + RTX 5080, 64 GB RAM.
 * "One big model across two cards", clicked through on simulated cards and a
 * stand-in ComfyUI (Windows), no real two-card machine:
 *  (a) Settings → Hardware shows the toggle next to "Card per task", the
 *      default puts the model on the bigger card, and Rust gets the split.
 *  (b) Create with the split on and a ComfyUI that sees both cards: the graph
 *      posted to /prompt has ComfyUI's own Select CLIP/VAE Device nodes on
 *      gpu:1 behind the loaders, and every reader goes through them.
 *  (c) The same with a ComfyUI that still runs on one card: the graph goes
 *      out exactly as before.
 * LU_SHOTS=<folder> writes the screenshots there.
 */

const MODEL = 'juggernautXL.safetensors'
const SHOTS = process.env.LU_SHOTS
const PNG = gradientPng(512, 384).toString('base64')

const R5080 = { index: 0, vendor: 'nvidia', name: 'NVIDIA GeForce RTX 5080', memory_mib: 16303, source: 'nvidia-smi' }
const R4090 = { index: 1, vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', memory_mib: 24564, source: 'nvidia-smi' }
/** ComfyUI v0.42.4 /system_stats with LU's split: model card first. */
const TWO = [
  { name: 'cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync', type: 'cuda', index: 0, vram_total: 25757220864 },
  { name: 'cuda:1 NVIDIA GeForce RTX 5080 : cudaMallocAsync', type: 'cuda', index: 1, vram_total: 17094475776 },
]
const ONE = [TWO[0]]

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>

async function boot(page: Page, devices: unknown[]) {
  await page.addInitScript(tauriMockInit, { assistantReply: 'ok', modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(([model, cards, devs]) => {
    const w = window as unknown as { __PROMPTS__: string[]; __ROLES__: unknown[]; __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string; method?: string; body?: string; roles?: unknown }) => Promise<unknown> } }
    if (!localStorage.getItem('create-store')) {
      localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local', imageModel: model }, version: 2 }))
    }
    w.__PROMPTS__ = []
    w.__ROLES__ = []
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    const combo = (v: string[]) => [v]
    // Outputs as ComfyUI v0.42.4 declares them: the split reads them.
    const nodes: Record<string, unknown> = {
      CheckpointLoaderSimple: { input: { required: { ckpt_name: combo([model as string]) } }, output: ['MODEL', 'CLIP', 'VAE'] },
      VAELoader: { input: { required: { vae_name: combo(['sdxl_vae.safetensors']) } }, output: ['VAE'] },
      KSampler: { input: { required: { sampler_name: combo(['euler']), scheduler: combo(['simple']) } }, output: ['LATENT'] },
      EmptyLatentImage: { input: { required: {} }, output: ['LATENT'] },
      CLIPTextEncode: { input: { required: {} }, output: ['CONDITIONING'] },
      VAEDecode: { input: { required: {} }, output: ['IMAGE'] },
      SaveImage: { input: { required: {} }, output: [] },
      SelectCLIPDevice: { input: { required: { clip: ['CLIP'], device: [['default', 'cpu', 'gpu:0', 'gpu:1']] } }, output: ['CLIP'] },
      SelectVAEDevice: { input: { required: { vae: ['VAE'], device: [['default', 'gpu:0', 'gpu:1']] } }, output: ['VAE'] },
    }
    bridge.invoke = (command, args) => {
      if (command === 'detect_gpus') return Promise.resolve(cards)
      if (command === 'set_gpu_roles') { w.__ROLES__.push(args?.roles); return Promise.resolve(null) }
      if (command === 'describe_gpu_roles') return Promise.resolve([])
      if (command === 'sniff_model_files') return Promise.resolve([])
      if (command !== 'proxy_localhost' || !args?.url?.includes(':8188')) return invoke(command, args)
      const url = args.url
      if (url.includes('/system_stats')) return Promise.resolve(JSON.stringify({ system: { comfyui_version: '0.42.4' }, devices: devs }))
      if (url.endsWith('/prompt') && args.method === 'POST') {
        w.__PROMPTS__.push(String(args.body))
        return Promise.resolve(JSON.stringify({ prompt_id: `p${w.__PROMPTS__.length}`, number: 1, node_errors: {} }))
      }
      const hist = /\/history\/(p(\d+))/.exec(url)
      if (hist) {
        return Promise.resolve(JSON.stringify({ [hist[1]]: { status: { status_str: 'success', completed: true, messages: [] }, outputs: { '9': { images: [{ filename: `split_${hist[1]}.png`, subfolder: '', type: 'output' }] } } } }))
      }
      if (url.includes('/queue')) return Promise.resolve(JSON.stringify({ queue_running: [], queue_pending: [] }))
      const one = /\/object_info\/([^/?]+)/.exec(url)
      if (one) return Promise.resolve(JSON.stringify(one[1] in nodes ? { [one[1]]: nodes[one[1]] } : {}))
      if (url.includes('/object_info')) return Promise.resolve(JSON.stringify(nodes))
      return Promise.resolve('{}')
    }
  }, [MODEL, [R5080, R4090], devices] as const)
  await page.route(/:8188\/view/, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG, 'base64') }))
}

const shot = async (page: Page, name: string) => {
  if (!SHOTS) return
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

const posted = (page: Page) => page.evaluate(() => (window as unknown as { __PROMPTS__: string[] }).__PROMPTS__.map((p) => (JSON.parse(p) as { prompt: Graph }).prompt))

/** Settings → Hardware → the toggle, as a user turns it on. Persisted, so
 *  the next page load keeps it. */
async function turnOnSplit(page: Page) {
  await page.goto('/')
  await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Hardware (GPU picker)' }).click()
  const toggle = page.getByLabel('One big model across two cards')
  await expect(toggle).toBeVisible({ timeout: 15_000 })
  return toggle
}

/** `stay`: go to Create inside the running app. A page load would undo the
 *  setting, because seedOnboardingDone writes the settings on every load. */
async function createOnePicture(page: Page, stay = false) {
  if (!stay) await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: 'Image', exact: true }).click()
  await page.getByRole('textbox').filter({ hasText: '' }).first().fill('a lighthouse at dusk')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(async () => (await posted(page)).length, { timeout: 20_000 }).toBe(1)
  return (await posted(page))[0]
}

test('(a) Settings → Hardware: the toggle, the bigger card for the model, Rust gets the split', async ({ page }) => {
  await boot(page, TWO)
  const toggle = await turnOnSplit(page)
  await toggle.scrollIntoViewIfNeeded()
  await shot(page, 'c56-1-hardware-aus')
  await toggle.check()
  await expect(page.getByLabel('Model on')).toHaveValue('nvidia:1')
  await expect(page.getByLabel('Text encoder and VAE on')).toHaveValue('nvidia:0')
  await expect(page.getByLabel('Pictures and video (ComfyUI)')).toBeDisabled()
  await expect(page.getByTestId('gpu-roles-restart-hint')).toBeVisible()
  await page.getByTestId('comfy-split').scrollIntoViewIfNeeded()
  await shot(page, 'c56-2-hardware-an')
  await expect.poll(() => page.evaluate(() => {
    const roles = (window as unknown as { __ROLES__: Array<{ comfySplit?: { model: { index: number }; helper: { index: number } } }> }).__ROLES__
    const last = roles[roles.length - 1]
    return last?.comfySplit ? [last.comfySplit.model.index, last.comfySplit.helper.index] : null
  })).toEqual([1, 0])
})

test('(b) Create with the split on and ComfyUI on both cards: text encoder and VAE go to gpu:1', async ({ page }) => {
  await boot(page, TWO)
  await (await turnOnSplit(page)).check()
  const graph = await createOnePicture(page, true)
  const selects = Object.entries(graph).filter(([, n]) => n.class_type === 'SelectCLIPDevice' || n.class_type === 'SelectVAEDevice')
  expect(selects.map(([, n]) => n.class_type).sort()).toEqual(['SelectCLIPDevice', 'SelectVAEDevice'])
  for (const [, n] of selects) expect(n.inputs.device).toBe('gpu:1')
  const clipNode = selects.find(([, n]) => n.class_type === 'SelectCLIPDevice')![0]
  const vaeNode = selects.find(([, n]) => n.class_type === 'SelectVAEDevice')![0]
  for (const n of Object.values(graph)) {
    if (n.class_type === 'CLIPTextEncode') expect((n.inputs.clip as [string, number])[0]).toBe(clipNode)
    if (n.class_type === 'VAEDecode') expect((n.inputs.vae as [string, number])[0]).toBe(vaeNode)
    // The diffusion model stays on ComfyUI's default card.
    if (n.class_type === 'KSampler') expect(graph[(n.inputs.model as [string, number])[0]].class_type).not.toMatch(/^Select/)
  }
  await shot(page, 'c56-3-create-mit-split')
})

test('(c) the split on but ComfyUI still on one card: the graph goes out as before', async ({ page }) => {
  await boot(page, ONE)
  await (await turnOnSplit(page)).check()
  const graph = await createOnePicture(page, true)
  expect(Object.values(graph).some((n) => n.class_type.startsWith('Select'))).toBe(false)
})

test('(d) the split off: the graph goes out as before', async ({ page }) => {
  await boot(page, TWO)
  const graph = await createOnePicture(page)
  expect(Object.values(graph).some((n) => n.class_type.startsWith('Select'))).toBe(false)
})
