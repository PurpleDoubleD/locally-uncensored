import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { Rec, HOWTO_OUT } from './rec'

// A trained local character in the other Create tabs (3.0.7, characters
// everywhere). Recorded on the 3.0.7 Desktop head 0c2b9bcda
// (probe/desktop-307-all-3). Facts, all from that head:
//  - CharacterChip.tsx: the chip "Character" sits next to the model chip on
//    Image, Edit and the video tabs in Local mode (characterChipShown, with
//    lib/character-run.ts CHARACTER_IMAGE_LANES and CHARACTER_VIDEO_LANES).
//    Each trained character is listed as "Z Image character". Picking one on
//    an image tab switches to the Z Image model it was trained for
//    (lib/character-base.ts characterBaseModel).
//  - CharacterChip.tsx CharacterNote: on Image and Edit the note reads
//    "“<trigger>” goes into your prompt by itself. Describe the key features
//    too."; on a video tab "First an image of <name> is made with Z Image,
//    then the video starts from it."
//  - lib/character-run.ts EDIT_MASK_NO_CHARACTER: a character in Edit works
//    without a mask.
//  - CharacterChip.tsx characterMakesStart and Composer.tsx: a video tab with
//    a character needs no start image of its own.
//  - lib/characters.ts CHAIN_STEP_IMAGE / CHAIN_STEP_VIDEO and
//    hooks/useCreate.ts: the run shows "Step 1 of 2: character image", then
//    "Step 2 of 2: video".
//
// Fixtures (nothing on the page is altered; all answers come before the app
// loads, through Rec.boot's initScript and fixtures):
//  1. create-store in localStorage: Local backend with an SDXL checkpoint as
//     the image model and the Wan 2.2 file as the video model, as an earlier
//     session leaves it. Not real: no such session happened.
//  2. ComfyUI (port 8188, through the Tauri command proxy_localhost, the way
//     character-local.spec.ts does it): /system_stats reports one 16 GB GPU;
//     /object_info lists one SDXL checkpoint, the Z Image Turbo diffusion
//     model with its text encoder and VAE, one Wan 2.2 TI2V 5B video model
//     with its text encoder and VAE, ComfyUI's built-in inpaint nodes (local
//     Edit asks for them), and one LoRA, char_rustyfox_zimage.safetensors,
//     the file a finished local training run leaves. Not real: no ComfyUI
//     runs, no file exists, no run trained the character.
//  3. ComfyUI runs: POST /prompt answers a prompt id; /history of the first
//     prompt (the character image) stays empty, so the run stands at step 1,
//     until the spec sets window.__luStep1Done; then it reports one finished
//     image. /history of the second prompt (the video) stays empty, so the
//     run stands at step 2. The Tauri command comfy_upload_image (ComfyUI's
//     /upload/image) answers with the file's name, as ComfyUI does. Not real:
//     nothing is uploaded or rendered.
//  4. ComfyUI's /view: the finished "character image" is the example photo
//     fox-1.jpg of the Cloud character film, not a render. The <img> asks
//     127.0.0.1:8188 itself (page.route); the app's own fetch of it, which the
//     rig refuses on every foreign loopback port, is sent to /__lu_fx/view on
//     the page's origin (initScript), which page.route answers the same way.
//     The film never shows this image; it only lets step 2 start.
//  5. detect_gpus and sniff_model_files: one 16 GB card, no header sniffing.
//     Not real: example values.
// The Edit source picture is the example photo fox-2.jpg (set through the
// stage's own file input; picking a file is not the subject).
test.use({ viewport: { width: 1200, height: 1020 }, deviceScaleFactor: 2 })

const FOX = (n: number) => `${HOWTO_OUT}/character/assets/fox-${n}.jpg`

test('character-everywhere', async ({ page }) => {
  test.skip(!HOWTO_OUT, 'set LU_HOWTO_OUT')
  test.setTimeout(150_000)
  const foxView = readFileSync(FOX(1))
  const rec = await Rec.boot(page, 'character-everywhere', 'Use a character everywhere', {
    mode: 'local',
    tauri: { platform: 'windows' },
    initScript: () => {
      const SDXL = 'Juggernaut-XL_v9.safetensors'
      const WAN = 'wan2.2_ti2v_5B_fp16.safetensors'
      const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string; method?: string }) => Promise<unknown> }; __luStep1Done?: boolean }
      // Fixture 1: the state an earlier session leaves.
      if (!localStorage.getItem('create-store')) {
        localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local', imageModel: SDXL, videoModel: WAN }, version: 2 }))
      }
      const bridge = w.__TAURI_INTERNALS__
      const invoke = bridge.invoke
      const combo = (v: string[]) => [v]
      // Fixture 2: what a running ComfyUI lists.
      const nodes: Record<string, unknown> = {
        CheckpointLoaderSimple: { input: { required: { ckpt_name: combo([SDXL]) } } },
        UNETLoader: { input: { required: { unet_name: combo(['z_image_turbo_bf16.safetensors', WAN]) } } },
        CLIPLoader: { input: { required: { clip_name: combo(['qwen_3_4b.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors']) } } },
        LoraLoader: { input: { required: { lora_name: combo(['char_rustyfox_zimage.safetensors']) } } },
        VAELoader: { input: { required: { vae_name: combo(['ae.safetensors', 'wan2.2_vae.safetensors']) } } },
        KSampler: { input: { required: { sampler_name: combo(['euler']), scheduler: combo(['simple']) } } },
        LoadImage: { input: { required: { image: combo([]) } } },
        // ComfyUI's built-in inpaint nodes, which local Edit looks for.
        VAEEncodeForInpaint: { input: { required: {} } },
        InpaintModelConditioning: { input: { required: {} } },
        SaveImage: { input: { required: {} } },
        VHS_VideoCombine: { input: { required: {} } },
        Wan22ImageToVideoLatent: { input: { required: {} } },
      }
      // Fixture 4: the rig's fetch refuses every loopback port but the
      // page's own (e2e/support/tauri-mock.ts), so the app's fetch of the
      // finished image from ComfyUI's /view is sent to a path of the page's
      // own origin, which page.route answers with the example photo.
      const rigFetch = window.fetch.bind(window)
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (/^http:\/\/(127\.0\.0\.1|localhost):8188\/view/.test(u)) return rigFetch(`${location.origin}/__lu_fx/view`, init)
        return rigFetch(input, init)
      }
      let prompts = 0
      bridge.invoke = (command, args) => {
        // Fixture 5: one card, no header sniffing.
        if (command === 'sniff_model_files') return Promise.resolve([])
        // Fixture 3: ComfyUI's /upload/image (a Rust multipart post in the app) keeps the file under its name.
        if (command === 'comfy_upload_image') return Promise.resolve(JSON.stringify({ name: (args as unknown as { filename: string }).filename, subfolder: '', type: 'input' }))
        if (command === 'detect_gpus') return Promise.resolve([{ index: 0, vendor: 'nvidia', name: 'GPU', memory_mib: 16384, source: 'fixture' }])
        if (command !== 'proxy_localhost' || !args?.url?.includes(':8188')) return invoke(command, args)
        const url = args.url
        if (url.includes('/system_stats')) return Promise.resolve(JSON.stringify({ devices: [{ name: 'GPU', type: 'cuda', vram_total: 16 * 1024 ** 3 }] }))
        const one = /\/object_info\/([^/?]+)/.exec(url)
        if (one) return Promise.resolve(JSON.stringify(one[1] in nodes ? { [one[1]]: nodes[one[1]] } : {}))
        if (url.includes('/object_info')) return Promise.resolve(JSON.stringify(nodes))
        // Fixture 3: the two runs of the chain.
        if (url.endsWith('/prompt') && args.method === 'POST') {
          prompts += 1
          return Promise.resolve(JSON.stringify({ prompt_id: `p${prompts}`, number: prompts, node_errors: {} }))
        }
        const hist = /\/history\/(p\d+)/.exec(url)
        if (hist) {
          if (hist[1] === 'p1' && w.__luStep1Done) {
            return Promise.resolve(JSON.stringify({ p1: {
              status: { completed: true, status_str: 'success', messages: [] },
              outputs: { 9: { images: [{ filename: 'rustyfox_00001_.png', subfolder: '', type: 'output' }] } },
            } }))
          }
          return Promise.resolve('{}')
        }
        if (url.includes('/queue')) return Promise.resolve(JSON.stringify({ queue_running: [], queue_pending: [] }))
        return Promise.resolve('{}')
      }
    },
    fixtures: async (page) => {
      // Fixture 4: the finished character image is an example photo.
      // The <img> of the result asks ComfyUI's /view itself; the app's own
      // fetch of it arrives at /__lu_fx/view (see the initScript).
      await page.route(/^http:\/\/(127\.0\.0\.1|localhost):8188\/view/, (route) => route.fulfill({ status: 200, contentType: 'image/jpeg', body: foxView }))
      await page.route('**/__lu_fx/view', (route) => route.fulfill({ status: 200, contentType: 'image/jpeg', body: foxView }))
    },
  })

  await rec.openCreate('Image')
  const chip = page.getByRole('button', { name: 'Character' })
  await expect(chip).toBeVisible({ timeout: 20_000 })
  const modelChip = page.locator('button[aria-haspopup="listbox"]').filter({ hasText: 'Juggernaut' })
  await expect(modelChip).toBeVisible()
  await page.mouse.move(980, 520)

  await rec.key(700)
  rec.hold(0.3)
  rec.scene('On Image, the Character chip next to the model picks a trained character.')
  // Between the chip and the note above the prompt, so both stay in frame.
  await rec.cam({ x: 600, y: 790 }, 1.45)
  await rec.click(chip, { dur: 0.7, settle: 600, after: 0.3 })
  const pick = page.getByRole('option', { name: /rustyfox/ })
  await expect(pick).toBeVisible()
  await rec.click(pick, { dur: 0.5, settle: 800, after: 0.2 })
  const note = page.getByTestId('character-note')
  await expect(note).toContainText('goes into your prompt by itself')
  await expect(page.locator('button[aria-haspopup="listbox"]').filter({ hasText: /Z-Image/ })).toBeVisible()
  rec.hold(0.4)

  rec.scene('The model switches to Z Image, and the trigger word goes into the prompt by itself.')
  await rec.move(note, { dur: 0.6, at: { dy: 22 }, real: false })
  rec.hold(1.4)

  rec.scene('Edit uses the same character on your image, without a mask.')
  await rec.cam('full', 1, 0.8)
  await rec.click(page.getByRole('radio', { name: 'Edit / Image to Image', exact: true }), { dur: 0.8, settle: 800, after: 0.2 })
  await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles({
    name: 'fox.jpg', mimeType: 'image/jpeg', buffer: readFileSync(FOX(2)),
  })
  await expect(page.getByRole('button', { name: 'Paint mask' })).toBeVisible({ timeout: 15_000 })
  await expect(note).toContainText('goes into your prompt by itself')
  await rec.key(800)
  await rec.move(note, { dur: 0.6, at: { dy: 22 }, real: false })
  rec.hold(1.0)

  rec.scene('On Video, no start image is needed: an image of the character is made first.')
  await rec.click(page.getByRole('radio', { name: 'Video', exact: true }), { dur: 0.8, settle: 900, after: 0.2 })
  await expect(note).toContainText('First an image of rustyfox is made with Z Image, then the video starts from it.')
  await rec.move(note, { dur: 0.6, at: { dy: 22 }, real: false })
  rec.hold(1.0)

  rec.scene('Create runs two steps: the character image, then the video from it.')
  const vprompt = page.locator('textarea').first()
  await rec.click(vprompt, { dur: 0.6, at: { fx: 0.15 }, after: 0.1 })
  await rec.move({ x: 935, y: 870 }, { dur: 0.3, real: false })
  await rec.type(vprompt, 'walks through autumn leaves', { cps: 26 })
  const create = page.getByRole('button', { name: 'Create', exact: true }).last()
  await expect(create).toBeEnabled()
  await rec.click(create, { dur: 0.6, settle: 400, after: 0.1, until: () => expect(page.getByText(/^Step 1 of 2: character image/)).toBeVisible({ timeout: 20_000 }) })
  rec.hold(1.2)
  // Fixture 3: the character image is finished now.
  await page.evaluate(() => { (window as unknown as { __luStep1Done: boolean }).__luStep1Done = true })
  await expect(page.getByText(/^Step 2 of 2: video/)).toBeVisible({ timeout: 30_000 })
  await rec.key(600)
  rec.hold(1.4)
  rec.finish(1.0)
})
