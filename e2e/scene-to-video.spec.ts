import { test, expect, type Page, type Locator } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'

/**
 * Scene to Video (3.1.3) in the real app, Tauri stubbed:
 *
 *   Cloud    the tab, the empty stage, a scene video with its first frame,
 *            Look and Style in the settings, Create with the price, the run
 *            the server gets, the result; the first frame step on GPT Image 2.
 *   Local    (Windows, stand-in ComfyUI) the graph posted to /prompt: depth
 *            of the scene into Wan 2.1 VACE; the card for the depth pack;
 *            the card for the VACE download; a too short clip.
 *   Mac      the locked pill and its cloud sheet.
 *
 * Nothing is booked: the cloud is mocked, ComfyUI is a stand-in. The clips are
 * e2e/fixtures/scene-room.mp4 (a grey room blockout rendered in Blender, a
 * five second dolly) and scene-short.mp4 (its first 1.2 s).
 * LU_SCENE_SHOTS=<folder> receives screenshots in the dark and light theme.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIP = readFileSync(join(HERE, 'fixtures', 'scene-room.mp4'))
const SHORT = readFileSync(join(HERE, 'fixtures', 'scene-short.mp4'))
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const SHOTS = process.env.LU_SCENE_SHOTS
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }

const SCENE_CATALOG = [
  ['wan-3.0-video-edit', 'Wan 3.0 Scene'],
  ['seedance-2.5-flash-video-edit', 'Seedance 2.5 Flash'],
  ['wan-2.1-vace', 'Wan 2.1 VACE'],
  ['aleph-2', 'Aleph 2'],
  ['flux-3-video-edit', 'FLUX 3 Video Edit'],
].map(([id, label]) => ({ id, label, kind: 'video', ops: ['studio'], quote_required: true, t2v: false, i2v: false }))
  .concat([{ id: 'gpt-image-2-edit', label: 'GPT Image 2', kind: 'image', ops: ['studio'], quote_required: true, t2v: false, i2v: false }])

async function shoot(page: Page, name: string) {
  if (!SHOTS) return
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => {
      document.documentElement.classList.toggle('dark', t === 'dark')
      document.documentElement.classList.toggle('light', t === 'light')
    }, theme)
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` })
  }
  await page.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.classList.remove('light') })
}

/** Visible, inside the window, and the element on top at its middle: a
 *  click there reaches it (no overlay, nothing cut off). */
async function expectClickable(loc: Locator) {
  await expect(loc).toBeVisible()
  const box = await loc.boundingBox()
  expect(box, 'on screen').not.toBeNull()
  const size = loc.page().viewportSize()!
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 0.5)
  expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 0.5)
  const hit = await loc.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!top && (top === el || el.contains(top))
  })
  expect(hit, 'nothing covers it').toBe(true)
}

const scenePill = (page: Page) => page.getByRole('radio', { name: /^Scene to Video/ })
const createButton = (page: Page) => page.locator('[data-prompt-window]').getByRole('button', { name: /^Create/ })
const promptField = (page: Page) => page.locator('[data-prompt-window] textarea').first()

// ── Cloud ──────────────────────────────────────────────────────────────────

interface Seen { submits: Array<{ kind: string; model: string; prompt: string; params: Record<string, unknown> }>; uploads: string[]; adopts: unknown[] }

async function openCloud(page: Page): Promise<Seen> {
  await page.setViewportSize({ width: 1296, height: 900 })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, extraCatalogModels: SCENE_CATALOG })
  const seen: Seen = { submits: [], uploads: [], adopts: [] }
  await page.route('https://lu-labs.ai/**', async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    if (req.method() === 'OPTIONS') return route.fallback()
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (path === '/api/jobs/upload' && req.method() === 'POST') {
      seen.uploads.push(req.headers()['content-type'] ?? '')
      return json({ path: `e2e-user-1/staged-${seen.uploads.length}.bin` })
    }
    if (path === '/api/jobs/adopt' && req.method() === 'POST') {
      seen.adopts.push(req.postDataJSON())
      return json({ path: `e2e-user-1/adopted-${seen.adopts.length}.jpg` })
    }
    if (path === '/api/jobs' && req.method() === 'POST') {
      const body = req.postDataJSON() as Seen['submits'][number]
      seen.submits.push(body)
      const id = body.model === 'gpt-image-2-edit' ? 'job-frame-1' : 'job-scene-1'
      return json({ id, status: 'queued', created_at: new Date().toISOString(), quota: { kind: body.kind, cost: 30000, used: 0, limit: 2_550_000 } }, 202)
    }
    const job = /^\/api\/jobs\/(job-(?:frame|scene)-1)$/.exec(path)
    if (job && req.method() === 'GET') {
      const frame = job[1] === 'job-frame-1'
      return json({ job: {
        id: job[1], kind: frame ? 'image' : 'video', model: frame ? 'gpt-image-2-edit' : 'wan-3.0-video-edit', provider: 'upstream', status: 'succeeded',
        result_url: `https://lu-labs.ai/e2e/${job[1]}.${frame ? 'png' : 'mp4'}`, attestation: null, cost_units: 30000,
        created_at: new Date().toISOString(), completed_at: new Date().toISOString(), error: null,
      } })
    }
    if (path === '/e2e/job-frame-1.png') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'image/png' }, body: PNG_1PX })
    if (path === '/e2e/job-scene-1.mp4') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'video/mp4' }, body: CLIP })
    return route.fallback()
  })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
  return seen
}

test('cloud: the Scene tab takes a grey scene, prices the run and sends Wan 3.0 Scene the video and the look', async ({ page }) => {
  const seen = await openCloud(page)
  await expectClickable(scenePill(page))
  await expect(scenePill(page)).toContainText('NEW')
  await scenePill(page).click()
  await expect(scenePill(page)).toHaveAttribute('aria-checked', 'true')

  // Empty: the drop field and the open own-frame field, Create waits.
  const empty = page.locator('[data-scene-empty]')
  await expectClickable(empty)
  await expect(empty).toContainText('Replace any scene with its camera move.')
  await expect(page.locator('[data-scene-own]')).toContainText('Your own first frame')
  await expect(createButton(page)).toBeDisabled()
  await shoot(page, 'cloud-01-empty')

  // A scene: the clip and its first frame side by side, measured.
  await page.getByTestId('scene-stage-input').setInputFiles({ name: 'room.mp4', mimeType: 'video/mp4', buffer: CLIP })
  await expect(page.locator('[data-scene-previews] figcaption').first()).toHaveText('Scene · 5.0 s · 16:9', { timeout: 15_000 })
  await expect(page.locator('[data-scene-frame="taken"]')).toBeVisible({ timeout: 15_000 })
  await expect(createButton(page)).toBeDisabled()

  // Look and Style write the prompt.
  await page.locator('[data-prompt-window] button[title="Advanced settings"]').click()
  const settings = page.locator('[data-scene-settings]')
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: 'Look' }).click()
  await page.getByRole('option', { name: /Interior/ }).click()
  await settings.getByRole('button', { name: 'Style' }).click()
  await page.getByRole('option', { name: /^Cinematic/ }).click()
  await expect(page.locator('[data-scene-look-note]')).toHaveText('A lived-in room with soft window light.')
  await shoot(page, 'cloud-02-settings')
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  // The drawer slides out; its backdrop is gone with it.
  await expect(page.locator('aside').filter({ hasText: 'Advanced settings' })).toHaveCount(0)
  await expect(promptField(page)).toHaveValue(/^A cozy modern living room.*cinematic film look/)

  // The price stands on Create; one click sends the run.
  await expect(createButton(page)).toBeEnabled({ timeout: 15_000 })
  await expect(createButton(page)).toHaveText(/^Create · \S+/)
  await expectClickable(createButton(page))
  await shoot(page, 'cloud-03-ready')
  await createButton(page).click()
  await expect.poll(() => seen.submits.length, { timeout: 20_000 }).toBe(1)
  const run = seen.submits[0]
  expect(run.model).toBe('wan-3.0-video-edit')
  expect(run.kind).toBe('video')
  expect(run.prompt).toMatch(/^A cozy modern living room.*Keep the camera movement, the timing, the framing and the position of every object from the video\.$/)
  expect(run.params.op).toBe('studio')
  expect(run.params.video_path).toBe('e2e-user-1/staged-1.bin')
  expect(run.params.label).toBe('Scene to Video')
  expect(run.params.image_paths).toBeUndefined()
  // The result is on the stage.
  await expect(page.locator('video').first()).toBeVisible({ timeout: 20_000 })
  await shoot(page, 'cloud-04-result')
})

test('cloud: Generate from prompt makes the own first frame on GPT Image 2 Edit, and the run takes it', async ({ page }) => {
  const seen = await openCloud(page)
  await scenePill(page).click()
  await page.getByTestId('scene-stage-input').setInputFiles({ name: 'room.mp4', mimeType: 'video/mp4', buffer: CLIP })
  await expect(page.locator('[data-scene-frame="taken"]')).toBeVisible({ timeout: 15_000 })
  const generate = page.locator('[data-scene-own-generate]')
  await expect(generate).toBeDisabled()
  await expect(page.locator('[data-scene-own-hint]')).toHaveText('Write a prompt to generate.')
  await promptField(page).fill('a sunny scandinavian living room')
  await expectClickable(generate)
  await expect(page.locator('[data-scene-own-credits]')).toBeVisible()
  await generate.click()
  await expect(page.locator('[data-scene-frame="own"]')).toBeVisible({ timeout: 20_000 })
  expect(seen.submits[0].model).toBe('gpt-image-2-edit')
  expect(seen.submits[0].prompt).toMatch(/^a sunny scandinavian living room\. Restyle this exact frame\./)
  await shoot(page, 'cloud-05-own-frame')
  await createButton(page).click()
  await expect.poll(() => seen.submits.length, { timeout: 20_000 }).toBe(2)
  expect(seen.submits[1].params.image_paths).toEqual(['e2e-user-1/adopted-1.jpg'])
  expect(seen.submits[1].prompt).toContain('The reference image shows the first frame.')
})

test('cloud: without a connection the upload fails, the app says so and nothing is booked', async ({ page }) => {
  const seen = await openCloud(page)
  await scenePill(page).click()
  await page.getByTestId('scene-stage-input').setInputFiles({ name: 'room.mp4', mimeType: 'video/mp4', buffer: CLIP })
  await expect(page.locator('[data-scene-frame="taken"]')).toBeVisible({ timeout: 15_000 })
  await promptField(page).fill('a forest clearing at dawn')
  await expect(createButton(page)).toBeEnabled({ timeout: 15_000 })
  // The line drops: every upload fails at the network.
  await page.route(/lu-labs\.ai\/api\/jobs\/upload/, (route) => (route.request().method() === 'OPTIONS' ? route.fallback() : route.abort('internetdisconnected')))
  await createButton(page).click()
  await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 20_000 })
  expect(seen.submits).toHaveLength(0)
  await expect(createButton(page)).toBeEnabled()
  await shoot(page, 'cloud-06-offline')
})

// ── Local (Windows, stand-in ComfyUI) ──────────────────────────────────────

const VACE = 'wan2.1_vace_1.3B_fp16.safetensors'
const ANIMATE = 'Wan2.2-Animate-14B-Q4_K_M.gguf'
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>

async function openLocal(page: Page, opts: { models: string[]; depth: boolean }) {
  await page.setViewportSize({ width: 1296, height: 900 })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(({ models, depth }) => {
    const w = window as unknown as { __PROMPTS__: string[]; __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string; method?: string; body?: string; filename?: string; files?: Array<{ filename: string }> }) => Promise<unknown> } }
    if (!localStorage.getItem('create-store')) localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local' }, version: 2 }))
    w.__PROMPTS__ = []
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    const combo = (v: string[]) => [v]
    const names = [
      'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'WanVaceToVideo', 'TrimVideoLatent', 'ModelSamplingSD3', 'KSampler',
      'VAEDecode', 'CreateVideo', 'SaveVideo', 'LoadImage', 'ImageScale', 'ImageFromBatch', 'ImageBatch', 'EmptyImage',
      'ImageToMask', 'LoadVideo', 'GetVideoComponents', 'VHS_LoadVideo', 'VHS_VideoCombine', 'DWPreprocessor',
      ...(depth ? ['DepthAnythingV2Preprocessor'] : []),
    ]
    const nodes: Record<string, unknown> = Object.fromEntries(names.map((n) => [n, { input: { required: {} } }]))
    nodes.UNETLoader = { input: { required: { unet_name: combo(models.filter((m) => !m.endsWith('.gguf'))), weight_dtype: combo(['default']) } } }
    nodes.UnetLoaderGGUF = { input: { required: { unet_name: combo(models.filter((m) => m.endsWith('.gguf'))) } } }
    nodes.CLIPLoader = { input: { required: { clip_name: combo(['umt5_xxl_fp8_e4m3fn_scaled.safetensors']), type: combo(['wan']), device: combo(['default']) } } }
    nodes.VAELoader = { input: { required: { vae_name: combo(['wan_2.1_vae.safetensors']) } } }
    nodes.CheckpointLoaderSimple = { input: { required: { ckpt_name: combo(['juggernaut.safetensors']) } } }
    nodes.KSampler = { input: { required: { sampler_name: combo(['euler']), scheduler: combo(['simple']) } } }
    bridge.invoke = (command, args) => {
      if (command === 'sniff_model_files') return Promise.resolve([])
      if (command === 'comfy_upload_image') return Promise.resolve(JSON.stringify({ name: (args as { filename?: string }).filename, subfolder: '', type: 'input' }))
      if (command === 'check_model_sizes') return Promise.resolve((args?.files ?? []).map((f) => ({ filename: f.filename, exists: true, complete: true })))
      if (command !== 'proxy_localhost' || !args?.url?.includes(':8188')) return invoke(command, args)
      const url = args.url
      if (url.includes('/system_stats')) return Promise.resolve(JSON.stringify({ devices: [{ name: 'RTX 3060', type: 'cuda', vram_total: 12 * 1024 ** 3 }] }))
      if (url.endsWith('/prompt') && args.method === 'POST') {
        w.__PROMPTS__.push(String(args.body))
        return Promise.resolve(JSON.stringify({ prompt_id: `p${w.__PROMPTS__.length}`, number: 1, node_errors: {} }))
      }
      if (url.includes('/upload/image')) return Promise.resolve(JSON.stringify({ name: 'room.mp4', subfolder: '', type: 'input' }))
      const hist = /\/history\/(p\d+)/.exec(url)
      if (hist) {
        const images = [{ filename: `scene_${hist[1]}.mp4`, subfolder: '', type: 'output' }]
        return Promise.resolve(JSON.stringify({ [hist[1]]: { status: { status_str: 'success', completed: true, messages: [] }, outputs: { '20': { images, animated: [true] } } } }))
      }
      if (url.includes('/queue')) return Promise.resolve(JSON.stringify({ queue_running: [], queue_pending: [] }))
      const one = /\/object_info\/([^/?]+)/.exec(url)
      if (one) return Promise.resolve(JSON.stringify(one[1] in nodes ? { [one[1]]: nodes[one[1]] } : {}))
      if (url.includes('/object_info')) return Promise.resolve(JSON.stringify(nodes))
      return Promise.resolve('{}')
    }
  }, opts)
  await page.route(/:8188\/view/, (route) => route.fulfill({ status: 200, contentType: 'video/mp4', body: CLIP }))
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
}

const posted = (page: Page) => page.evaluate(() => (window as unknown as { __PROMPTS__: string[] }).__PROMPTS__.map((p) => (JSON.parse(p) as { prompt: Graph }).prompt))

test('local: the scene runs on Wan 2.1 VACE over a depth video of the clip, without a cloud step', async ({ page }) => {
  await openLocal(page, { models: [VACE, ANIMATE], depth: true })
  await expectClickable(scenePill(page))
  await scenePill(page).click()
  await expect(page.locator('[data-scene-empty]')).toBeVisible({ timeout: 15_000 })
  // Local offers no cloud frame step, and says where it is.
  await expect(page.locator('[data-scene-own-generate]')).toHaveCount(0)
  await shoot(page, 'local-01-empty')
  await page.getByTestId('scene-stage-input').setInputFiles({ name: 'room.mp4', mimeType: 'video/mp4', buffer: CLIP })
  await expect(page.locator('[data-scene-previews] figcaption').first()).toHaveText('Scene · 5.0 s · 16:9', { timeout: 15_000 })
  await expect(page.locator('[data-scene-own-hint]')).toHaveText('Generating a first frame runs on LU Cloud. Switch to Cloud for it.')
  // The model chip names the VACE file, not Animate.
  await expect(page.locator('[data-prompt-window]')).toContainText(/VACE/i)
  await promptField(page).fill('a cozy living room, soft window light, photoreal')
  await expect(createButton(page)).toHaveText('Create')
  await expectClickable(createButton(page))
  await shoot(page, 'local-02-ready')
  await createButton(page).click()
  await expect.poll(async () => (await posted(page)).length, { timeout: 30_000 }).toBe(1)
  const graph = (await posted(page))[0]
  const of = (t: string) => Object.values(graph).filter((n) => n.class_type === t)
  expect(of('VHS_LoadVideo')[0].inputs).toMatchObject({ force_rate: 16, frame_load_cap: 77 })
  expect(of('DepthAnythingV2Preprocessor')[0].inputs.ckpt_name).toBe('depth_anything_v2_vits.pth')
  expect(of('WanVaceToVideo')[0].inputs).toMatchObject({ width: 832, height: 480, length: 77 })
  expect(of('UNETLoader')[0].inputs.unet_name).toBe(VACE)
  expect(of('DWPreprocessor')).toHaveLength(0)
  expect(Object.values(graph).some((n) => n.class_type === 'CLIPTextEncode' && n.inputs.text === 'a cozy living room, soft window light, photoreal')).toBe(true)
  await expect(page.locator('video').first()).toBeVisible({ timeout: 30_000 })
  await shoot(page, 'local-03-result')
})

test('local: without the depth extractor the stage offers the controlnet aux install', async ({ page }) => {
  await openLocal(page, { models: [VACE], depth: false })
  await scenePill(page).click()
  await expect(page.getByText('Scene to Video needs the depth extractor')).toBeVisible({ timeout: 15_000 })
  await expectClickable(page.getByRole('button', { name: /Download & install|Install/ }).first())
  await shoot(page, 'local-04-no-depth')
})

test('local: with only Wan Animate the stage offers the VACE download', async ({ page }) => {
  await openLocal(page, { models: [ANIMATE], depth: true })
  await scenePill(page).click()
  await expect(page.getByText('Local Scene to Video needs a one-time download')).toBeVisible({ timeout: 15_000 })
  await shoot(page, 'local-05-no-model')
})

test('local: a clip under two seconds is named before anything runs', async ({ page }) => {
  await openLocal(page, { models: [VACE], depth: true })
  await scenePill(page).click()
  await page.getByTestId('scene-stage-input').setInputFiles({ name: 'short.mp4', mimeType: 'video/mp4', buffer: SHORT })
  await expect(page.locator('[data-scene-note]')).toHaveText(/Use a clip of 2 to 10 seconds\./, { timeout: 15_000 })
  await promptField(page).fill('a room')
  await expect(createButton(page)).toBeDisabled()
  await shoot(page, 'local-06-too-short')
})

// ── Mac ────────────────────────────────────────────────────────────────────

test('mac: Scene to Video is a locked cloud pill that opens the LU Cloud sheet', async ({ page }) => {
  await page.setViewportSize({ width: 1296, height: 900 })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'mac' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(() => {
    if (!localStorage.getItem('create-store')) localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local' }, version: 2 }))
  })
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
  const pill = page.getByRole('radio', { name: 'Scene to Video, runs on LU Cloud' })
  await expectClickable(pill)
  await expect(pill).toHaveAttribute('aria-checked', 'false')
  await shoot(page, 'mac-01-locked')
  await pill.click()
  await expect(page.getByText('Turn a grey 3D scene into a finished clip. Same camera, same timing, the look you describe.')).toBeVisible()
  await shoot(page, 'mac-02-sheet')
})
