import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * B50 (Discord, 30.10.2026): a character trained in LU came out as noise with a
 * checker pattern on Z-Image. Its workflow showed CFG 30 and the LoRA at 2.0.
 * Now a note stands next to each slider, with the range that works; the value
 * stays as set (David: a note, never a lock).
 *
 * A stand-in ComfyUI answers over proxy_localhost, as in
 * lora-stack-search-and-wide-strength.spec.ts. LU_SHOTS=<folder> writes the
 * screenshots there.
 */

const MODEL = 'z_image_bf16.safetensors'
const CHAR = 'char_jolene_zimage.safetensors'
const SHOTS = process.env.LU_SHOTS

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(([lora, model]) => {
    const w = window as unknown as { __PROMPTS__: string[]; __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string; method?: string; body?: string }) => Promise<unknown> } }
    if (!localStorage.getItem('create-store')) {
      localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local', imageModel: model }, version: 2 }))
    }
    w.__PROMPTS__ = []
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    const combo = (v: string[]) => [v]
    const nodes = {
      UNETLoader: { input: { required: { unet_name: combo([model as string]), weight_dtype: combo(['default']) } } },
      CLIPLoader: { input: { required: { clip_name: combo(['qwen_3_4b.safetensors']), type: combo(['qwen_image']) } } },
      LoraLoader: { input: { required: { lora_name: combo([lora as string]) } } },
      LoraLoaderModelOnly: { input: { required: { lora_name: combo([lora as string]) } } },
      VAELoader: { input: { required: { vae_name: combo(['ae.safetensors']) } } },
      KSampler: { input: { required: { sampler_name: combo(['euler']), scheduler: combo(['simple']) } } },
      EmptySD3LatentImage: { input: { required: {} } }, EmptyLatentImage: { input: { required: {} } }, CLIPTextEncode: { input: { required: {} } },
      VAEDecode: { input: { required: {} } }, SaveImage: { input: { required: {} } },
    } as Record<string, unknown>
    bridge.invoke = (command, args) => {
      if (command === 'sniff_model_files') return Promise.resolve([])
      if (command !== 'proxy_localhost' || !args?.url?.includes(':8188')) return invoke(command, args)
      const url = args.url
      if (url.includes('/system_stats')) return Promise.resolve(JSON.stringify({ devices: [{ name: 'RTX 3060', type: 'cuda', vram_total: 12 * 1024 ** 3 }] }))
      if (url.endsWith('/prompt') && args.method === 'POST') {
        w.__PROMPTS__.push(String(args.body))
        return Promise.resolve(JSON.stringify({ prompt_id: 'p1', number: 1, node_errors: {} }))
      }
      const one = /\/object_info\/([^/?]+)/.exec(url)
      if (one) return Promise.resolve(JSON.stringify(one[1] in nodes ? { [one[1]]: nodes[one[1]] } : {}))
      if (url.includes('/object_info')) return Promise.resolve(JSON.stringify(nodes))
      return Promise.resolve('{}')
    }
  }, [CHAR, MODEL] as const)
}

const shot = async (page: Page, name: string, testId: string) => {
  if (!SHOTS) return
  await page.waitForTimeout(500)
  await page.getByTestId(testId).evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

test('Z-Image at CFG 30 and a character at 2.0: a note at each slider, gone again at a fitting value', async ({ page }) => {
  await boot(page)
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: 'Image', exact: true }).click()
  await page.getByRole('button', { name: 'Advanced settings' }).click()

  // CFG: quiet at the start (3.5), a note at 30.
  // The CFG slider is the one that goes to 30 (ParamGroups.tsx).
  const cfg = page.locator('input[type="range"][max="30"]')
  await expect(cfg).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('cfg-hint')).toHaveCount(0)
  await cfg.fill('30')
  await expect(page.getByTestId('cfg-hint')).toHaveText('This model works best at CFG 1 to 5. Above 10 the picture turns to noise or a checker pattern.')
  await shot(page, 'p8-b50-1-cfg-30', 'cfg-hint')

  // The character LoRA at 2.0.
  const expert = page.getByRole('button', { name: 'Expert', exact: true })
  if (!(await page.getByText(/^LoRA stack/).isVisible())) await expert.click()
  await page.getByRole('button', { name: /char_jolene_zimage/ }).click()
  const strength = page.getByRole('textbox', { name: 'Strength of char_jolene_zimage' })
  await expect(page.getByTestId('lora-strength-hint')).toHaveCount(0)
  await strength.fill('2')
  await strength.blur()
  await expect(page.getByTestId('lora-strength-hint')).toHaveText('Above 1.5 most LoRAs break the picture. 0.6 to 1.2 is the usual range.')
  await shot(page, 'p8-b50-2-lora-2', 'lora-strength-hint')

  // A note, never a lock: the values stay as set, and back in range the notes go.
  await expect(cfg).toHaveValue('30')
  await cfg.fill('4')
  await expect(page.getByTestId('cfg-hint')).toHaveCount(0)
  await strength.fill('0.8')
  await strength.blur()
  await expect(page.getByTestId('lora-strength-hint')).toHaveCount(0)
})
