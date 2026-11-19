import { test, expect, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { gradientPng } from './support/png'
import { openCharacterHub } from './support/character-hub'

/**
 * The Character area in LOCAL mode on a Windows or Linux desktop (3.1.3,
 * David 19.11.2026: the area works on this computer in full). A stand-in
 * ComfyUI lists a Z-Image model, a local character LoRA (char_*), Wan 2.2
 * Animate and Wan 2.2 S2V with the nodes of their lanes, and records every
 * graph posted to /prompt. Each of the four actions is started for real
 * against it: Image (the LoRA), Swap (Wan 2.2 Animate, replace), Motion
 * (Animate with the pose) and Talk (S2V). The graphs are checked, not only
 * the text on the page. Nothing runs in the cloud.
 *
 * LU_SHOTS=<folder> writes the screens (dark and light) and the graphs there.
 */

const ZIMAGE = 'z_image_turbo_bf16.safetensors'
const ANIMATE = 'Wan2.2-Animate-14B-Q4_K_M.gguf'
const S2V = 'Wan2.2-S2V-14B-Q4_K_M.gguf'
const LORA = 'char_opa_zimage.safetensors'
const SHOTS = process.env.LU_SHOTS
const PNG = gradientPng(512, 768)

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>

/** The app's own object_info fixture, and every node the builders name (a
 *  recent ComfyUI with the packs LU installs for these lanes). */
const OBJECT_INFO = {
  ...Object.fromEntries(['ADE_ApplyAnimateDiffModelSimple','ADE_LoadAnimateDiffModel','ADE_UseEvolvedSampling','ApplyTextureToMesh','AudioEncoderEncode','AudioEncoderLoader','BakeAmbientOcclusion','BakeNormalMapFromMesh','BakeTextureFromVoxel','BasicGuider','BasicScheduler','BlockSparseAttention','CFGGuider','CFGNorm','CFGOverride','CLIPLoader','CLIPSetLastLayer','CLIPTextEncode','CLIPVisionEncode','CLIPVisionLoader','CheckpointLoaderSimple','ConditioningZeroOut','CreateVideo','DWPreprocessor','DecimateMesh','DualCFGGuider','DualCLIPLoader','EmptyImage','EmptyLTXVLatentVideo','EmptyLatentImage','EmptyTrellis2LatentStructure','EmptyYuE2LatentAudio','FluxKontextImageScale','FluxKontextMultiReferenceLatentMethod','FramePackSampler','GetVideoComponents','GrowMask','ImageCompositeMasked','ImageCropToMask','ImageOnlyCheckpointLoader','ImageScale','ImageScaleBy','ImageScaleToTotalPixels','ImageToMask','ImageUpscaleWithModel','InpaintModelConditioning','KSampler','KSamplerAdvanced','KSamplerSelect','LoadAudio','LoadBackgroundRemovalModel','LoadFramePackModel','LoadImage','LoadImageMask','LoadVideo','LoraLoader','LoraLoaderModelOnly','ManualSigmas','MaskComposite','MeshSmoothNormals','MiniMaxH3SigmaShift','ModelSamplingAuraFlow','ModelSamplingFlux','ModelSamplingSD3','QuadrupleCLIPLoader','QwenImage21Cache','RMBG','RandomNoise','ReferenceLatent','RemeshMesh','RemoveBackground','RescaleCFG','SVD_img2vid_Conditioning','SamplerCustomAdvanced','SaveAudioMP3','SaveGLB','SaveImage','SaveVideo','TextEncodeQwenImage21','TextEncodeQwenImageEditPlus','ThresholdMask','Trellis2Conditioning','Trellis2ShapeStage','Trellis2TextureStage','Trellis2UpsampleStage','TrimVideoLatent','TripleCLIPLoader','UNETLoader','UnetLoaderGGUF','UnwrapMesh','UpscaleModelLoader','VAEDecode','VAEDecodeAudio','VAEEncode','VAEEncodeForInpaint','VAELoader','VHS_LoadVideo','VaeDecodeShapeTrellis','VaeDecodeStructureTrellis2','VaeDecodeTextureTrellis','VideoLinearCFGGuidance','Wan22ImageToVideoLatent','WanAnimateToVideo','WanSoundImageToVideo','WanVaceToVideo','YuE2GenerateMusic'].map((n) => [n, { input: { required: {} } }])),
  ...JSON.parse(readFileSync(join(process.cwd(), 'src/api/__tests__/fixtures/comfy-ui/object-info.json'), 'utf8')),
} as Record<string, unknown>

async function boot(page: Page) {
  await page.setViewportSize({ width: 1296, height: 900 })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(({ zimage, animate, s2v, lora, base }) => {
    const w = window as unknown as { __PROMPTS__: string[]; __UPLOADS__: string[]; __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string; method?: string; body?: string; filename?: string }) => Promise<unknown> } }
    if (!localStorage.getItem('create-store')) {
      localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local', imageModel: zimage }, version: 2 }))
    }
    w.__PROMPTS__ = []
    w.__UPLOADS__ = []
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    const combo = (v: string[]) => [v]
    const any = { input: { required: {} } }
    const nodes: Record<string, unknown> = {
      ...base,
      UNETLoader: { input: { required: { unet_name: combo([zimage]), weight_dtype: combo(['default']) } } },
      UnetLoaderGGUF: { input: { required: { unet_name: combo([animate, s2v]) } } },
      CLIPLoader: { input: { required: { clip_name: combo(['qwen_3_4b.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors']), type: combo(['lumina2', 'wan', 'qwen_image', 'stable_diffusion']), device: combo(['default']) } } },
      VAELoader: { input: { required: { vae_name: combo(['ae.safetensors', 'wan_2.1_vae.safetensors']) } } },
      AudioEncoderLoader: { input: { required: { audio_encoder_name: combo(['wav2vec2_large_english_fp16.safetensors']) } } },
      LoraLoader: { input: { required: { model: ['MODEL'], clip: ['CLIP'], lora_name: combo([lora]), strength_model: ['FLOAT', { default: 1 }], strength_clip: ['FLOAT', { default: 1 }] } } },
      LoraLoaderModelOnly: { input: { required: { model: ['MODEL'], lora_name: combo([lora]), strength_model: ['FLOAT', { default: 1 }] } } },
      KSampler: { input: { required: { model: ['MODEL'], seed: ['INT'], steps: ['INT'], cfg: ['FLOAT'], sampler_name: combo(['euler', 'res_multistep']), scheduler: combo(['simple']), positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], denoise: ['FLOAT', { default: 1 }] } } },
      ImageScale: { input: { required: { image: ['IMAGE'], upscale_method: combo(['nearest-exact', 'lanczos']), width: ['INT'], height: ['INT'], crop: combo(['disabled', 'center']) } } },
      LoadImage: { input: { required: { image: combo(['source.png']) } } },
      DWPreprocessor: any, WanAnimateToVideo: any, WanSoundImageToVideo: any, TrimVideoLatent: any,
      LoadVideo: any, GetVideoComponents: any, CreateVideo: any, SaveVideo: any, VHS_LoadVideo: any, VHS_VideoCombine: any,
      LoadAudio: any, AudioEncoderEncode: any, ModelSamplingSD3: any, ModelSamplingAuraFlow: any,
      ImageToMask: any, MaskComposite: any, ThresholdMask: any, GrowMask: any, EmptyImage: any, ImageCompositeMasked: any,
      CLIPTextEncode: any, EmptySD3LatentImage: any, EmptyLatentImage: any, VAEDecode: any, VAEDecodeTiled: any, SaveImage: any,
      ConditioningZeroOut: any,
    }
    bridge.invoke = (command, args) => {
      if (command === 'sniff_model_files') return Promise.resolve([])
      if (command === 'detect_gpus') return Promise.resolve([{ index: 0, vendor: 'nvidia', name: 'RTX 3060', memory_mib: 12288, source: 'e2e' }])
      if (command === 'comfy_upload_image') {
        w.__UPLOADS__.push(String(args?.filename))
        return Promise.resolve(JSON.stringify({ name: String(args?.filename), subfolder: '', type: 'input' }))
      }
      if (command !== 'proxy_localhost' || !args?.url?.includes(':8188')) return invoke(command, args)
      const url = args.url
      if (url.includes('/system_stats')) return Promise.resolve(JSON.stringify({ devices: [{ name: 'RTX 3060', type: 'cuda', vram_total: 12 * 1024 ** 3 }] }))
      if (url.endsWith('/prompt') && args.method === 'POST') {
        w.__PROMPTS__.push(String(args.body))
        return Promise.resolve(JSON.stringify({ prompt_id: `p${w.__PROMPTS__.length}`, number: 1, node_errors: {} }))
      }
      const hist = /\/history\/(p\d+)/.exec(url)
      if (hist) {
        const images = [{ filename: `local_${hist[1]}.png`, subfolder: '', type: 'output' }]
        return Promise.resolve(JSON.stringify({ [hist[1]]: { status: { status_str: 'success', completed: true, messages: [] }, outputs: { '99': { images } } } }))
      }
      if (url.includes('/queue')) return Promise.resolve(JSON.stringify({ queue_running: [], queue_pending: [] }))
      const one = /\/object_info\/([^/?]+)/.exec(url)
      if (one) {
        const type = decodeURIComponent(one[1])
        return Promise.resolve(JSON.stringify(type in nodes ? { [type]: nodes[type] } : {}))
      }
      if (url.includes('/object_info')) return Promise.resolve(JSON.stringify(nodes))
      return Promise.resolve('{}')
    }
  }, { zimage: ZIMAGE, animate: ANIMATE, s2v: S2V, lora: LORA, base: OBJECT_INFO })
  await page.route(/:8188\/view/, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
}

const posted = (page: Page) => page.evaluate(() => (window as unknown as { __PROMPTS__: string[] }).__PROMPTS__.map((p) => (JSON.parse(p) as { prompt: unknown }).prompt)) as Promise<Graph[]>
const types = (g: Graph) => Object.values(g).map((n) => n.class_type)
const nodeOf = (g: Graph, t: string) => Object.entries(g).find(([, n]) => n.class_type === t)!
const createButton = (page: Page) => page.locator('[data-prompt-window]').getByRole('button', { name: /^Create/ })

async function shoot(page: Page, name: string) {
  if (!SHOTS) return
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => {
      document.documentElement.classList.toggle('dark', t === 'dark')
      document.documentElement.classList.toggle('light', t === 'light')
    }, theme)
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/lokal-${name}-${theme}.png` })
  }
  await page.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.classList.remove('light') })
}

/** A short clip the WebView can decode, recorded from a canvas in the page:
 *  one figure walking from left to right. */
async function clip(page: Page, name: string) {
  const b64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 320; canvas.height = 180
    const ctx = canvas.getContext('2d')!
    const paint = (t: number) => {
      ctx.fillStyle = '#d8d4cc'; ctx.fillRect(0, 0, 320, 180)
      ctx.fillStyle = '#6b4f3a'; ctx.beginPath(); ctx.arc(120 + t * 4, 70, 28, 0, Math.PI * 2); ctx.fill()
    }
    paint(0)
    const rec = new MediaRecorder(canvas.captureStream(15), { mimeType: 'video/webm' })
    const parts: Blob[] = []
    rec.ondataavailable = (e) => parts.push(e.data)
    const done = new Promise<void>((r) => { rec.onstop = () => r() })
    rec.start()
    for (let i = 0; i < 12; i++) { paint(i); await new Promise((r) => setTimeout(r, 60)) }
    rec.stop()
    await done
    const bytes = new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer())
    let bin = ''
    for (const x of bytes) bin += String.fromCharCode(x)
    return btoa(bin)
  })
  return { name, mimeType: 'video/webm', buffer: Buffer.from(b64, 'base64') }
}

/** One second of silence as a WAV. */
function wav(): Buffer {
  const rate = 16000, n = rate
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  return b
}

async function savePhotoCharacter(page: Page, name: string, copies: number) {
  await page.locator('[data-hub-new]').click()
  await page.locator('input[aria-label="Photos or a LoRA file"]').setInputFiles(
    Array.from({ length: copies }, (_, i) => ({ name: `${name}-${i + 1}.png`, mimeType: 'image/png', buffer: PNG })),
  )
  await page.locator('[data-hub-new-name]').fill(name)
  await page.getByRole('button', { name: `Save ${name}`, exact: true }).click()
  await expect(page.locator('[data-hub-character^="saved:"]', { hasText: name })).toHaveAttribute('aria-selected', 'true')
}

async function tapFrame(page: Page, x: number, y: number) {
  const frame = page.getByRole('group', { name: /First frame of your video/ })
  const box = (await frame.boundingBox())!
  await frame.click({ position: { x: box.width * x, y: box.height * y } })
}

/** Is the element really on top at its middle (not covered, not cut off)? */
async function clickable(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return false
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return !!hit && (hit === el || el.contains(hit))
  })
}

test('local mode, Windows: the old local character is there, and Image, Swap, Motion and Talk all start on this computer', async ({ page }) => {
  test.setTimeout(120_000)
  await boot(page)
  await openCharacterHub(page)
  // The char_* LoRA of this machine is a character of the area, as before.
  const opa = page.locator(`[data-hub-character="local:${LORA}"]`)
  await expect(opa).toBeVisible({ timeout: 15_000 })
  await savePhotoCharacter(page, 'Sam', 6)

  // Every action is local here: no "runs on LU Cloud", the line says Local.
  for (const a of ['image', 'swap', 'motion', 'talk']) {
    const btn = page.locator(`[data-hub-action="${a}"]`)
    await expect(btn).toBeVisible()
    await expect(btn).not.toHaveAttribute('aria-label', /runs on LU Cloud/)
    expect(await clickable(page, `[data-hub-action="${a}"]`)).toBe(true)
  }

  // ── Image with the LoRA character ──
  await opa.click()
  await page.locator('[data-prompt-window] textarea').fill('opa at the beach')
  await createButton(page).click()
  await expect.poll(async () => (await posted(page)).length, { timeout: 20_000 }).toBe(1)
  {
    const g = (await posted(page))[0]
    expect(Object.values(g).some((n) => n.class_type.startsWith('LoraLoader') && n.inputs.lora_name === LORA)).toBe(true)
  }
  await shoot(page, 'a-image')

  // ── Swap: one person, Sam, Wan 2.2 Animate replace ──
  await page.locator('[data-hub-character^="saved:"]', { hasText: 'Sam' }).click()
  await page.locator('[data-hub-action="swap"]').click()
  await expect(page.locator('[data-swap-controls][data-swap-local]')).toBeVisible()
  await expect(page.locator('[data-hub-action-meta]')).toContainText('Local')
  await expect(page.locator('[data-swap-tips]')).toContainText('Runs on your computer with Wan 2.2 Animate')
  // The window waits and says why.
  await expect(createButton(page)).toBeDisabled()
  await page.locator('[data-swap-controls] input[type=file][accept^="video"]').setInputFiles(await clip(page, 'walk.webm'))
  await expect(page.getByRole('group', { name: /First frame of your video/ })).toBeVisible({ timeout: 20_000 })
  await tapFrame(page, 0.4, 0.4)
  await expect(page.getByRole('button', { name: 'Character for person 1' })).toContainText('Sam', { timeout: 15_000 })
  await expect(page.locator('[data-swap-figure="1"] [data-swap-place]')).toHaveText('main person')
  // A second person: the row says what the local way cannot, Create waits,
  // and the line names where it runs. Nothing switches by itself.
  await tapFrame(page, 0.8, 0.4)
  await expect(page.locator('[data-swap-row-limit="2"]')).toHaveText('Local (Wan 2.2 Animate) replaces one person.')
  await expect(page.locator('[data-swap-elsewhere]')).toContainText('LU Cloud')
  await expect(createButton(page)).toBeDisabled()
  await shoot(page, 'b-swap-zwei')
  await page.getByRole('button', { name: 'Remove mark 2' }).click()
  await expect(page.locator('[data-swap-row-limit]')).toHaveCount(0)
  await page.locator('[data-swap-consent] input').check()
  await expect(createButton(page)).toBeEnabled()
  expect(await clickable(page, '[data-prompt-window] button:has-text("Create")')).toBe(true)
  await shoot(page, 'b-swap')
  await createButton(page).click()
  await expect.poll(async () => (await posted(page)).length, { timeout: 20_000 }).toBe(2)
  {
    const g = (await posted(page))[1]
    const [, cond] = nodeOf(g, 'WanAnimateToVideo')
    const [maskId] = nodeOf(g, 'GrowMask')
    const [bgId] = nodeOf(g, 'ImageCompositeMasked')
    expect(cond.inputs.character_mask).toEqual([maskId, 0])
    expect(cond.inputs.background_video).toEqual([bgId, 0])
    expect(types(g)).toContain('VHS_LoadVideo')
    expect(types(g)).toContain('DWPreprocessor')
    expect(nodeOf(g, 'UnetLoaderGGUF')[1].inputs.unet_name).toBe(ANIMATE)
    if (SHOTS) writeFileSync(`${SHOTS}/lokal-swap-graph.json`, JSON.stringify(g, null, 2))
  }

  // ── Motion: Sam copies the moves of the clip ──
  await page.locator('[data-hub-action="motion"]').click()
  await expect(page.locator('[data-motion-controls]')).toBeVisible()
  await expect(page.locator('[data-portrait-line]')).toContainText('Sam', { timeout: 15_000 })
  await expect(page.locator('[data-hub-clip]')).toBeVisible()
  await createButton(page).click()
  await expect.poll(async () => (await posted(page)).length, { timeout: 20_000 }).toBe(3)
  {
    const g = (await posted(page))[2]
    const [, cond] = nodeOf(g, 'WanAnimateToVideo')
    expect(cond.inputs.pose_video).toBeTruthy()
    expect(cond.inputs.background_video).toBeUndefined()
  }
  await shoot(page, 'c-motion')

  // ── Talk: Sam says a line ──
  await page.locator('[data-hub-action="talk"]').click()
  await expect(page.locator('[data-talk-controls]')).toBeVisible()
  await page.locator('[data-talk-controls] input[type=file][accept^="audio"]').first().setInputFiles({ name: 'line.wav', mimeType: 'audio/wav', buffer: wav() })
  await createButton(page).click()
  await expect.poll(async () => (await posted(page)).length, { timeout: 20_000 }).toBe(4)
  expect(types((await posted(page))[3])).toContain('WanSoundImageToVideo')
  await shoot(page, 'd-talk')
})
