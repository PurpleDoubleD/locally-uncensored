import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * GH #148: the Qwen-Image 2.1 prompt enhancer behind the one
 * switch "Improve my prompt". A rebuilt ComfyUI answers through
 * proxy_localhost with a local Qwen-Image 2.1 and, per test, the enhancer
 * files in its text encoder folder. Nothing is rendered.
 */

// Once per image model file of the family: the official weights and the Noct
// Q finetune, whose file name says neither "qwen" nor "2.1".
const WEIGHTS = [
  ['official weights', 'qwen_image_2.1_int8_convrot.safetensors'],
  ['Noct Q', 'NoctQ_V4_int8_convrot.safetensors'],
] as const
const ENCODER = 'qwen3vl_8b_int8_convrot.safetensors'
const ENHANCERS = [
  'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors',
  'qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors',
  'qwen3.5_9b_qwen_image_2.1_pe_t2i_heretic.int8_convrot.safetensors',
  'qwen3.5_9b_qwen_image_2.1_pe_i2i_heretic.int8_convrot.safetensors',
]

async function bootWithFakeComfy(page: Page, model: string, textEncoders: string[]) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(([model, encoders]) => {
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string }) => Promise<unknown> } }
    if (!localStorage.getItem('create-store')) {
      localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local', imageModel: model }, version: 2 }))
    }
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    const combo = (v: string[]) => [v]
    const nodes: Record<string, unknown> = {
      UNETLoader: { input: { required: { unet_name: combo([model as string]) } } },
      CLIPLoader: { input: { required: { clip_name: combo(encoders as string[]) } } },
      VAELoader: { input: { required: { vae_name: combo(['qwen_image_2.1_vae_bf16.safetensors']) } } },
      KSampler: { input: { required: { sampler_name: combo(['euler']), scheduler: combo(['simple']) } } },
    }
    bridge.invoke = (command, args) => {
      if (command === 'sniff_model_files') return Promise.resolve([])
      if (command !== 'proxy_localhost' || !args?.url?.includes(':8188')) return invoke(command, args)
      const url = args.url
      if (url.includes('/system_stats')) return Promise.resolve(JSON.stringify({ devices: [{ name: 'RTX 4090', type: 'cuda', vram_total: 24 * 1024 ** 3 }] }))
      const one = /\/object_info\/([^/?]+)/.exec(url)
      if (one) return Promise.resolve(JSON.stringify(one[1] in nodes ? { [one[1]]: nodes[one[1]] } : {}))
      if (url.includes('/object_info')) return Promise.resolve(JSON.stringify(nodes))
      return Promise.resolve('{}')
    }
  }, [model, textEncoders] as const)
}

async function openAdvanced(page: Page, intent: string) {
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: intent, exact: true }).click()
  await page.getByRole('button', { name: 'Advanced settings' }).click()
}

const theSwitch = (page: Page) => page.getByRole('switch', { name: /Improve my prompt/ })
const writers = (page: Page) => page.getByRole('radiogroup', { name: 'Rewritten by' })
const saved = (page: Page) => page.evaluate(() => {
  const state = JSON.parse(localStorage.getItem('create-store') || '{}').state
  return { improvePrompt: state?.improvePrompt, improveWith: state?.improveWith }
})

for (const [weights, model] of WEIGHTS) {
  test(`${weights}: with the enhancers installed, the one switch offers who writes and remembers the pick`, async ({ page }) => {
    await bootWithFakeComfy(page, model, [ENCODER, ...ENHANCERS])
    await openAdvanced(page, 'Image')
    await expect(theSwitch(page)).toBeVisible({ timeout: 15_000 })
    await expect(theSwitch(page)).toHaveCount(1)
    await expect(theSwitch(page)).toHaveAttribute('aria-checked', 'false')
    await expect(writers(page)).toHaveCount(0)

    await theSwitch(page).click()
    await expect(theSwitch(page)).toHaveAttribute('aria-checked', 'true')
    await expect(writers(page).getByRole('radio')).toHaveText(['Qwen enhancer', 'Qwen enhancer, No Filter', 'Chat model'])
    await expect(page.getByRole('radio', { name: 'Qwen enhancer', exact: true })).toHaveAttribute('aria-checked', 'true')

    await page.getByRole('radio', { name: 'Qwen enhancer, No Filter' }).click()
    await expect(page.getByRole('radio', { name: 'Qwen enhancer, No Filter' })).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => saved(page)).toEqual({ improvePrompt: true, improveWith: 'unfiltered' })

    // Nothing of it sits in or above the prompt field: with the drawer closed
    // the page shows neither the switch nor the row.
    await page.keyboard.press('Escape')
    await expect(theSwitch(page)).toHaveCount(0)
    await expect(page.getByText('Rewritten by')).toHaveCount(0)
  })

  test(`${weights}: Edit gets the switch through the edit enhancer and lists no chat model`, async ({ page }) => {
    await bootWithFakeComfy(page, model, [ENCODER, ...ENHANCERS])
    await openAdvanced(page, 'Edit / Image to Image')
    await expect(theSwitch(page)).toBeVisible({ timeout: 15_000 })
    await theSwitch(page).click()
    await expect(writers(page).getByRole('radio')).toHaveText(['Qwen enhancer', 'Qwen enhancer, No Filter'])
  })

  test(`${weights}: without an enhancer the switch is the chat model switch: no row, on Edit too (B48)`, async ({ page }) => {
    await bootWithFakeComfy(page, model, [ENCODER])
    await openAdvanced(page, 'Image')
    await expect(theSwitch(page)).toBeVisible({ timeout: 15_000 })
    await theSwitch(page).click()
    await expect(theSwitch(page)).toHaveAttribute('aria-checked', 'true')
    await expect(writers(page)).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.getByRole('radio', { name: 'Edit / Image to Image', exact: true }).click()
    await page.getByRole('button', { name: 'Advanced settings' }).click()
    await expect(page.getByRole('button', { name: 'Quality' })).toBeVisible()
    await expect(theSwitch(page)).toBeVisible()
    await expect(writers(page)).toHaveCount(0)
  })
}
