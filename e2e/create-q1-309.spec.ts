import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { gradientPng } from './support/png'
import { appModules, type AppWindow } from './support/ui'

/**
 * 3.0.9 Q1, clicked through on a stand-in ComfyUI (Windows or Linux, local):
 *  - B35: an Edit with the count at 4 sends one graph whose sampler starts
 *    from the source latent repeated four times, and four pictures come back.
 *  - B40: the large view lists the LoRA each picture was made with.
 *  - B47: a zoomed picture follows a drag with the mouse button held.
 *  - B24: a LoRA picked on Video is off on Image and back on Video.
 *  - B48: "Improve my prompt" rewrites an Edit instruction as an instruction.
 * The stand-in records every graph posted to /prompt and answers /history
 * with as many pictures as the graph makes. LU_SHOTS=<folder> writes the
 * screenshots there.
 */

const MODEL = 'juggernautXL.safetensors'
const VIDEO = 'wan2.2_t2v_14B_fp8.safetensors'
const LORAS = ['film_grain_xl.safetensors', 'wan22_motion_boost.safetensors']
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

async function store(page: Page) {
  await appModules(page, ['/src/stores/createStore.ts'])
}

/** A source picture on the Edit stage, as ComfyUI's upload would leave it. */
async function stageSource(page: Page) {
  await store(page)
  await page.evaluate((png) => {
    const s = (window as unknown as AppWindow).__APP__['/src/stores/createStore.ts'].useCreateStore
    s.setState({ source: { filename: 'source.png', url: `data:image/png;base64,${png}`, width: 512, height: 384 }, sourceSetAt: Date.now() })
  }, PNG)
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

test('B35 + B40 + B47: an Edit at count 4 makes four pictures, the large view names the LoRA and moves the zoomed picture', async ({ page }) => {
  await boot(page)
  await openCreate(page, 'Edit / Image to Image')
  await stageSource(page)
  await pickLora(page, LORAS[0])
  // The count chip stands next to Create on a ComfyUI edit too.
  await page.getByRole('button', { name: /^Images per run: / }).click()
  await page.getByRole('radio', { name: '4', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Images per run: 4' })).toBeVisible()
  await shot(page, 'q1-b35-1-edit-anzahl-4')
  await page.getByRole('textbox').filter({ hasText: '' }).first().fill('make her jacket red')
  await page.getByRole('button', { name: /^Create$/ }).last().click()

  await expect.poll(async () => (await posted(page)).length, { timeout: 20_000 }).toBe(1)
  const graph = (await posted(page))[0].prompt
  const sampler = Object.values(graph).find((n) => n.class_type === 'KSampler')!
  const from = graph[(sampler.inputs.latent_image as [string, number])[0]]
  expect(from.class_type).toBe('RepeatLatentBatch')
  expect(from.inputs.amount).toBe(4)
  expect(graph[(from.inputs.samples as [string, number])[0]].class_type).toBe('VAEEncode')

  // Four pictures land in the gallery, each with its LoRA.
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('create-store') || '{}').state?.gallery?.length ?? 0), { timeout: 30_000 }).toBe(4)
  const gallery = await page.evaluate(() => JSON.parse(localStorage.getItem('create-store') || '{}').state.gallery as { loras?: { name: string; strength: number }[] }[])
  expect(gallery.map((g) => g.loras?.map((l) => l.name))).toEqual(Array(4).fill([LORAS[0]]))
  await shot(page, 'q1-b35-2-vier-bilder')

  // B40: the large view lists the LoRA with its strength.
  await page.getByRole('button', { name: 'Open the gallery' }).click()
  await page.locator('img[src*="q1_p1_"]').first().click()
  const big = page.getByTestId('lightbox-image')
  await expect(big).toBeVisible()
  await page.getByText('Prompt and settings').click()
  await expect(page.getByTestId('run-settings')).toContainText(/LoRA\s*film grain xl · 0\.8/)
  await shot(page, 'q1-b40-lightbox-lora')

  // B47: zoom in with the wheel, then move the picture with the button held.
  const box = (await big.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -100)
  await page.mouse.wheel(0, -100)
  await expect.poll(async () => Number(await big.getAttribute('data-zoom'))).toBeGreaterThan(1.4)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 8 })
  await expect(big).toHaveAttribute('data-pan', '80,40')
  // Let go outside the picture: the view stays open.
  await page.mouse.move(5, 5, { steps: 4 })
  await page.mouse.up()
  await expect(big).toBeVisible()
  await shot(page, 'q1-b47-gezoomt-verschoben')
})

test('B24: a LoRA picked on Video is off on Image, and back on Video', async ({ page }) => {
  await boot(page)
  await openCreate(page, 'Image')
  await pickLora(page, LORAS[0])
  expect(await savedLoras(page)).toEqual([LORAS[0]])
  await page.getByRole('radio', { name: 'Video', exact: true }).click()
  await expect.poll(() => savedLoras(page)).toEqual([])
  await store(page)
  await page.evaluate((name) => (window as unknown as AppWindow).__APP__['/src/stores/createStore.ts'].useCreateStore.getState().toggleLora(name), LORAS[1])
  await page.getByRole('radio', { name: 'Image', exact: true }).click()
  await expect.poll(() => savedLoras(page)).toEqual([LORAS[0]])
  await shot(page, 'q1-b24-bild-ohne-video-lora')
  await page.getByRole('radio', { name: 'Video', exact: true }).click()
  await expect.poll(() => savedLoras(page)).toEqual([LORAS[1]])
})

test('B48: Improve my prompt on Edit rewrites the instruction, the graph gets the rewrite', async ({ page }) => {
  await boot(page)
  await openCreate(page, 'Edit / Image to Image')
  await stageSource(page)
  await page.getByRole('button', { name: 'Advanced settings' }).click()
  const sw = page.getByRole('switch', { name: /Improve my prompt/ })
  await expect(sw).toBeVisible({ timeout: 15_000 })
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await shot(page, 'q1-b48-schalter-in-edit')
  await page.keyboard.press('Escape')
  await page.getByRole('textbox').filter({ hasText: '' }).first().fill('make her jacket red')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(async () => (await posted(page)).length, { timeout: 30_000 }).toBe(1)
  const bodies = await page.evaluate(() => (window as unknown as { __E2E_CHAT_BODIES__?: string[] }).__E2E_CHAT_BODIES__ ?? [])
  expect(bodies.some((b) => b.includes('instructions for an image editing model') && b.includes('make her jacket red'))).toBe(true)
  const texts = Object.values((await posted(page))[0].prompt).filter((n) => n.class_type === 'CLIPTextEncode').map((n) => n.inputs.text)
  expect(texts).toContain('Turn only her jacket deep red and keep everything else exactly as it is.')
})
