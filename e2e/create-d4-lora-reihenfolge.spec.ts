import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { gradientPng } from './support/png'

/**
 * 3.0.9 D4, clicked through on a stand-in ComfyUI (Windows or Linux, local):
 * two LoRAs picked, the second moved up with its button, and the graph posted
 * to /prompt chains them in the new order. The order is saved with the picks
 * and is still there after a reload. LU_SHOTS=<folder> writes the screenshots.
 * The stand-in is the one of create-q1-309.spec.ts.
 */

const MODEL = 'juggernautXL.safetensors'
const VIDEO = 'wan2.2_t2v_14B_fp8.safetensors'
const LORAS = ['film_grain_xl.safetensors', 'detail_tweaker_xl.safetensors']
const SHOTS = process.env.LU_SHOTS
const PNG = gradientPng(512, 384).toString('base64')

type Posted = { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, { assistantReply: 'Turn only her jacket deep red and keep everything else exactly as it is.', modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(([list, model, video]) => {
    const w = window as unknown as { __PROMPTS__: string[]; __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string; method?: string; body?: string }) => Promise<unknown> } }
    if (!localStorage.getItem('create-store')) {
      localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local', imageModel: model, videoModel: video }, version: 2 }))
    }
    w.__PROMPTS__ = []
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    const combo = (v: string[]) => [v]
    const nodes = {
      CheckpointLoaderSimple: { input: { required: { ckpt_name: combo([model as string]) } } },
      UNETLoader: { input: { required: { unet_name: combo([video as string]) } } },
      LoraLoader: { input: { required: { lora_name: combo(list as string[]) } } },
      VAELoader: { input: { required: { vae_name: combo(['ae.safetensors']) } } },
      KSampler: { input: { required: { sampler_name: combo(['euler']), scheduler: combo(['simple']) } } },
      EmptyLatentImage: { input: { required: {} } }, CLIPTextEncode: { input: { required: {} } },
      VAEEncode: { input: { required: {} } }, VAEDecode: { input: { required: {} } }, SaveImage: { input: { required: {} } },
      LoadImage: { input: { required: { image: combo(['source.png']) } } }, RepeatLatentBatch: { input: { required: {} } },
    } as Record<string, unknown>
    // As many pictures as the graph makes: the repeat of an edit, else one.
    const made = (body: string) => {
      const graph = JSON.parse(body).prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>
      const repeat = Object.values(graph).find((n) => n.class_type === 'RepeatLatentBatch')
      return Number(repeat?.inputs.amount ?? 1)
    }
    bridge.invoke = (command, args) => {
      if (command === 'sniff_model_files') return Promise.resolve([])
      if (command !== 'proxy_localhost' || !args?.url?.includes(':8188')) return invoke(command, args)
      const url = args.url
      if (url.includes('/system_stats')) return Promise.resolve(JSON.stringify({ devices: [{ name: 'RTX 3060', type: 'cuda', vram_total: 12 * 1024 ** 3 }] }))
      if (url.endsWith('/prompt') && args.method === 'POST') {
        w.__PROMPTS__.push(String(args.body))
        return Promise.resolve(JSON.stringify({ prompt_id: `p${w.__PROMPTS__.length}`, number: 1, node_errors: {} }))
      }
      const hist = /\/history\/(p(\d+))/.exec(url)
      if (hist) {
        const n = made(w.__PROMPTS__[Number(hist[2]) - 1])
        const images = Array.from({ length: n }, (_, i) => ({ filename: `q1_${hist[1]}_${i}.png`, subfolder: '', type: 'output' }))
        return Promise.resolve(JSON.stringify({ [hist[1]]: { status: { status_str: 'success', completed: true, messages: [] }, outputs: { '9': { images } } } }))
      }
      if (url.includes('/queue')) return Promise.resolve(JSON.stringify({ queue_running: [], queue_pending: [] }))
      const one = /\/object_info\/([^/?]+)/.exec(url)
      if (one) return Promise.resolve(JSON.stringify(one[1] in nodes ? { [one[1]]: nodes[one[1]] } : {}))
      if (url.includes('/object_info')) return Promise.resolve(JSON.stringify(nodes))
      return Promise.resolve('{}')
    }
  }, [LORAS, MODEL, VIDEO] as const)
  // The pictures the stand-in names are served as they would be by ComfyUI.
  await page.route(/:8188\/view/, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG, 'base64') }))
}

const shot = async (page: Page, name: string) => {
  if (!SHOTS) return
  // The large view and the drawer fade in: the picture waits for them.
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

async function openCreate(page: Page, tab: string) {
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: tab, exact: true }).click()
}


async function pickLora(page: Page, name: string) {
  await page.getByRole('button', { name: 'Advanced settings' }).click()
  const expert = page.getByRole('button', { name: 'Expert', exact: true })
  await expect(expert).toBeVisible({ timeout: 15_000 })
  if (!(await page.getByText(/^LoRA stack/).isVisible())) await expert.click()
  await page.getByRole('button', { name: new RegExp(name.replace('.safetensors', '')) }).first().click()
  await page.keyboard.press('Escape')
}

const posted = (page: Page) => page.evaluate(() => (window as unknown as { __PROMPTS__: string[] }).__PROMPTS__.map((p) => JSON.parse(p) as Posted))
const savedLoras = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem('create-store') || '{}').state?.selectedLoras ?? []).map((l: { name: string }) => l.name))


/** The LoRAs from the checkpoint to the sampler, in chain order. */
function chain(graph: Posted['prompt']): string[] {
  const sampler = Object.values(graph).find((n) => n.class_type === 'KSampler')!
  const out: string[] = []
  let at = (sampler.inputs.model as [string, number])[0]
  while (graph[at]?.class_type === 'LoraLoader') {
    out.unshift(String(graph[at].inputs.lora_name))
    at = (graph[at].inputs.model as [string, number])[0]
  }
  return out
}

async function openStack(page: Page) {
  await page.getByRole('button', { name: 'Advanced settings' }).click()
  const expert = page.getByRole('button', { name: 'Expert', exact: true })
  await expect(expert).toBeVisible({ timeout: 15_000 })
  if (!(await page.getByText(/^LoRA stack/).isVisible())) await expert.click()
}

test('D4: a LoRA moved up runs first, and the order is kept after a reload', async ({ page }) => {
  await boot(page)
  await openCreate(page, 'Image')
  await pickLora(page, LORAS[0])
  await pickLora(page, LORAS[1])
  expect(await savedLoras(page)).toEqual(LORAS)

  // Two picks: the order list stands above the stack, in the order of the clicks.
  await openStack(page)
  const order = page.getByTestId('lora-order')
  await expect(order.getByRole('listitem')).toHaveText([/film_grain_xl/, /detail_tweaker_xl/])
  await shot(page, 'd4-1-reihenfolge-vorher')
  await page.getByRole('button', { name: 'Move detail_tweaker_xl up' }).click()
  await expect(order.getByRole('listitem')).toHaveText([/detail_tweaker_xl/, /film_grain_xl/])
  await expect.poll(() => savedLoras(page)).toEqual([LORAS[1], LORAS[0]])
  await shot(page, 'd4-2-reihenfolge-nachher')
  await page.keyboard.press('Escape')

  await page.getByRole('textbox').filter({ hasText: '' }).first().fill('a lighthouse at dusk')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(async () => (await posted(page)).length, { timeout: 20_000 }).toBe(1)
  const graph = (await posted(page))[0].prompt
  expect(chain(graph)).toEqual([LORAS[1], LORAS[0]])
  console.log(`[D4] LoRA chain in the posted graph: ${chain(graph).join(' -> ')}`)

  // A reload (the app started again) keeps the order.
  await page.reload()
  await page.getByRole('button', { name: /^Create$/ }).first().click()
  await expect.poll(() => savedLoras(page)).toEqual([LORAS[1], LORAS[0]])
  await openStack(page)
  await expect(page.getByTestId('lora-order').getByRole('listitem')).toHaveText([/detail_tweaker_xl/, /film_grain_xl/])
})
