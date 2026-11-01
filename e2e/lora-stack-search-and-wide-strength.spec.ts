import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * Discord 2026-10-23, feature request on the LoRA stack, clicked through as
 * asked for:
 *  - a search above the stack, because with many LoRAs it had to be scrolled,
 *  - closing Advanced settings put the list back at the top; the search and
 *    the scroll position stay now,
 *  - the file name of a LoRA can be copied (trigger words are kept in it),
 *  - slider LoRAs need -10 to 15 and the like: the number field takes -20 to
 *    20, and that number is the one in the graph ComfyUI gets.
 *
 * A stand-in ComfyUI answers over proxy_localhost, as in
 * lora-stack-follows-the-folder.spec.ts. LU_SHOTS=<folder> writes the
 * screenshots there.
 */

const MODEL = 'juggernautXL.safetensors'
const LORAS = [
  ...Array.from({ length: 24 }, (_, i) => `style_${String(i + 1).padStart(2, '0')}_xl.safetensors`),
  'age_slider_xl.safetensors',
  'detail_slider_xl.safetensors',
  'ohwx woman, red dress.safetensors',
]
const SHOTS = process.env.LU_SHOTS

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(([list, model]) => {
    const w = window as unknown as { __PROMPTS__: string[]; __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string; method?: string; body?: string }) => Promise<unknown> } }
    if (!localStorage.getItem('create-store')) {
      localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local', imageModel: model }, version: 2 }))
    }
    w.__PROMPTS__ = []
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    const combo = (v: string[]) => [v]
    const nodes = {
      CheckpointLoaderSimple: { input: { required: { ckpt_name: combo([model as string]) } } },
      LoraLoader: { input: { required: { lora_name: combo(list as string[]) } } },
      VAELoader: { input: { required: { vae_name: combo(['ae.safetensors']) } } },
      KSampler: { input: { required: { sampler_name: combo(['euler']), scheduler: combo(['simple']) } } },
      EmptyLatentImage: { input: { required: {} } }, CLIPTextEncode: { input: { required: {} } },
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
  }, [LORAS, MODEL] as const)
}

async function openAdvanced(page: Page) {
  await page.getByRole('button', { name: 'Advanced settings' }).click()
  const expert = page.getByRole('button', { name: 'Expert', exact: true })
  await expect(expert).toBeVisible({ timeout: 15_000 })
  if (!(await page.getByText(/^LoRA stack/).isVisible())) await expert.click()
  await expect(page.getByRole('searchbox', { name: 'Search LoRAs' })).toBeVisible({ timeout: 15_000 })
}

const stack = (page: Page) => page.getByTestId('lora-stack-list')
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return
  // The stack sits low in the drawer: bring its head into view first.
  // The drawer and the Expert section slide in; the picture waits for them.
  await page.waitForTimeout(500)
  await page.getByText(/^LoRA stack/).evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

test('search, kept position, copy, and a wide negative strength that reaches the graph', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await boot(page)
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: 'Image', exact: true }).click()
  await openAdvanced(page)
  await shot(page, 'lora-1-stack-mit-suche')

  // The search narrows the list, case does not count.
  const search = page.getByRole('searchbox', { name: 'Search LoRAs' })
  await search.fill('SLIDER')
  await expect(stack(page).getByRole('button', { name: /slider/ })).toHaveCount(2)
  await expect(page.getByRole('button', { name: /style_01_xl/ })).toHaveCount(0)
  await shot(page, 'lora-2-suche-slider')

  // Closing the drawer and opening it again keeps the search.
  await page.keyboard.press('Escape')
  await expect(search).toHaveCount(0)
  await openAdvanced(page)
  await expect(page.getByRole('searchbox', { name: 'Search LoRAs' })).toHaveValue('SLIDER')
  await page.getByRole('searchbox', { name: 'Search LoRAs' }).fill('')

  // And the scroll position of the list.
  await stack(page).evaluate((el) => { el.scrollTop = 200; el.dispatchEvent(new Event('scroll')) })
  await page.keyboard.press('Escape')
  await openAdvanced(page)
  await expect.poll(() => stack(page).evaluate((el) => el.scrollTop)).toBe(200)
  await shot(page, 'lora-3-position-nach-schliessen')

  // Copy the file name, trigger words included, without turning it on.
  const row = page.getByRole('button', { name: /ohwx woman, red dress/ })
  await row.scrollIntoViewIfNeeded()
  await row.locator('xpath=following-sibling::button').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('ohwx woman, red dress')
  await expect(page.getByText(/active/)).toHaveCount(0)

  // Two slider LoRAs at -10 and 15.
  await page.getByRole('searchbox', { name: 'Search LoRAs' }).fill('slider')
  await page.getByRole('button', { name: /age_slider_xl/ }).click()
  await page.getByRole('button', { name: /detail_slider_xl/ }).click()
  const age = page.getByRole('textbox', { name: 'Strength of age_slider_xl' })
  const detail = page.getByRole('textbox', { name: 'Strength of detail_slider_xl' })
  await age.fill('-10')
  await age.blur()
  await detail.fill('15')
  await detail.blur()
  await expect(age).toHaveValue('-10.00')
  await expect(detail).toHaveValue('15.00')
  await expect(page.getByText('· 2 active')).toBeVisible()
  // D4b: each slider widened to its typed value, 0 in the middle.
  await expect(page.locator('input[type=range][min="-10"][max="10"]')).toHaveValue('-10')
  await expect(page.locator('input[type=range][min="-15"][max="15"]')).toHaveValue('15')
  await shot(page, 'lora-4-staerke-minus10-und-15')
  // 25 is pulled back to the end of the range.
  await detail.fill('25')
  await detail.blur()
  await expect(detail).toHaveValue('20.00')
  await detail.fill('15')
  await detail.blur()

  // Kept over a reload, the way the store persists it.
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('create-store') || '{}').state?.selectedLoras))
    .toEqual([{ name: 'age_slider_xl.safetensors', strength: -10 }, { name: 'detail_slider_xl.safetensors', strength: 15 }])

  // The graph ComfyUI gets carries both values on both sides of LoraLoader.
  await page.keyboard.press('Escape')
  await page.getByRole('textbox', { name: 'Describe your image…' }).fill('a lighthouse at dusk')
  // The second "Create" is the run button of the composer, the first the rail.
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __PROMPTS__: string[] }).__PROMPTS__.length), { timeout: 20_000 }).toBeGreaterThan(0)
  const posted = await page.evaluate(() => JSON.parse((window as unknown as { __PROMPTS__: string[] }).__PROMPTS__[0]))
  const loaders = Object.values(posted.prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>)
    .filter((n) => n.class_type === 'LoraLoader')
    .map((n) => [n.inputs.lora_name, n.inputs.strength_model, n.inputs.strength_clip])
  expect(loaders).toEqual([
    ['age_slider_xl.safetensors', -10, -10],
    ['detail_slider_xl.safetensors', 15, 15],
  ])
})
