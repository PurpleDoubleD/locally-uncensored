import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'
import { mlxCalls, comfyCalls, hfToken, requireCall } from './support/recorded'

/**
 * macOS local Create — the MLX path (MAC-5).
 *
 * The Mac has no ComfyUI: local images and video run through the in-process
 * MLX sidecar (commands/mlx.rs, video.rs). Until this file the whole surface
 * had zero e2e coverage, so the platform split was only ever verified by
 * reading code. Every test here pins the platform explicitly — the app derives
 * it from navigator, so an unpinned spec would silently test whatever laptop
 * ran it.
 *
 * What's covered: which lanes the Mac offers, that image and video actually
 * dispatch to MLX (and never to ComfyUI), that the installer a fresh Mac needs
 * exists and works, and — as the regression guard — that Windows is untouched.
 */

const MAC_OPTS: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'mac',
}

async function bootLocalCreate(page: Page, opts: TauriMockOptions) {
  await page.addInitScript(tauriMockInit, opts)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
}

test('mac local: MLX lanes run locally, cloud-only lanes stay visible as teasers', async ({ page }) => {
  await bootLocalCreate(page, MAC_OPTS)

  // The two lanes MLX genuinely serves are plain, selectable radios.
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('radio', { name: 'Video', exact: true })).toBeVisible()

  // Everything hosted-only keeps its place in the bar as a locked teaser —
  // David's rule: what can't run locally is still shown, not deleted.
  for (const label of ['Upscale', 'Erase Object', 'Character Studio', 'Talking Character', 'Music', 'Extend Video', 'Motion Control']) {
    await expect(page.getByRole('radio', { name: `${label}, runs on LU Cloud` })).toBeVisible()
  }

  // A locked lane opens the teaser instead of switching the lane.
  await page.getByRole('radio', { name: 'Music, runs on LU Cloud' }).click()
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeChecked()

  // Lanes that need a ComfyUI upload/node have no Mac path at all and are not
  // offered — a visible-but-broken button would be the worse outcome.
  await expect(page.getByRole('radio', { name: /^Remove Background/ })).toHaveCount(0)
  await expect(page.getByRole('radio', { name: /^Edit \/ Image to Image/ })).toHaveCount(0)
  await expect(page.getByRole('radio', { name: /^Animate Image/ })).toHaveCount(0)
})

test('mac local: image generate dispatches to MLX, never to ComfyUI', async ({ page }) => {
  await bootLocalCreate(page, MAC_OPTS)
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })

  const composer = page.locator('textarea').first()
  await composer.fill('a red apple on a wooden table')
  await page.getByRole('button', { name: /^Create$/ }).last().click()

  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'mlx_generate').length, { timeout: 30_000 })
    .toBeGreaterThan(0)

  const gen = requireCall(await mlxCalls(page), 'mlx_generate')
  expect(gen.prompt).toContain('a red apple')

  // The render came back as a data: PNG and is on screen.
  await expect(page.locator('img[src^="data:image/png"]').first()).toBeVisible({ timeout: 30_000 })

  // The point of the whole platform split: no ComfyUI call was even attempted.
  expect(await comfyCalls(page)).toHaveLength(0)
})

test('mac local: video generate dispatches to the MLX video model', async ({ page }) => {
  await bootLocalCreate(page, MAC_OPTS)
  await page.getByRole('radio', { name: 'Video', exact: true }).click()

  const composer = page.locator('textarea').first()
  await composer.fill('slow drifting clouds over a lake')
  await page.getByRole('button', { name: /^Create$/ }).last().click()

  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'video_generate').length, { timeout: 40_000 })
    .toBeGreaterThan(0)

  const gen = requireCall(await mlxCalls(page), 'video_generate')
  expect(gen.id).toBe('wan21-t2v-1.3b')
  expect(gen.prompt).toContain('drifting clouds')
})

test('fresh mac: the Local Media panel installs the engine and a model', async ({ page }) => {
  // A Mac that has never generated anything: no venv, no models. Before MAC-3
  // this state had no way out — the Rust install commands existed but nothing
  // called them, so local Create just failed.
  await page.addInitScript(tauriMockInit, {
    ...MAC_OPTS,
    mlx: { engineInstalled: false, videoEngineInstalled: false, installedImages: [], installedVideos: [] },
  })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: /^Settings$/ }).click()
  await page.getByRole('button', { name: /AI Backends/i }).click()

  // The Mac gets the MLX installer where other platforms get the ComfyUI panel.
  const section = page.getByRole('button', { name: /Local Media \(Apple MLX\)/i })
  await expect(section).toBeVisible({ timeout: 15_000 })
  await section.click()
  await expect(page.getByRole('button', { name: /ComfyUI/i })).toHaveCount(0)

  // Engine first: a model can't install without it.
  await expect(page.getByText(/about 3 GB of Python packages/i)).toBeVisible()
  await page.getByRole('button', { name: /Install engine/i }).first().click()
  await expect(page.getByText(/^Installed/).first()).toBeVisible({ timeout: 20_000 })

  // Then a model — the catalog row flips to installed and offers Remove.
  await page.getByRole('button', { name: /^Install$/ }).first().click()
  await expect(page.getByRole('button', { name: /Remove/i }).first()).toBeVisible({ timeout: 20_000 })

  const calls = await mlxCalls(page)
  expect(calls.some((c) => c.cmd === 'mlx_image_install_model' && c.id === 'sd-turbo')).toBe(true)
})

test('fresh mac: Create itself offers the setup, and it is the MLX one', async ({ page }) => {
  // The gap MAC-3 left open: the installer existed in Settings, but Create —
  // where the user actually is when they hit the wall — showed an empty stage
  // and a "one-time setup is needed" line with nothing to press. The card the
  // other platforms get was gated on ComfyUI being *down*, and on a Mac that
  // question is never asked, so it could not fire.
  const fresh: TauriMockOptions = {
    ...MAC_OPTS,
    mlx: { engineInstalled: false, videoEngineInstalled: false, installedImages: [], installedVideos: [] },
  }
  await bootLocalCreate(page, fresh)

  const card = page.getByText(/Local image generation needs a one-time setup/i)
  await expect(card).toBeVisible({ timeout: 20_000 })
  // Mac copy, not the ComfyUI bundle copy — no ComfyUI download is promised.
  await expect(page.getByText(/Apple MLX/i).first()).toBeVisible()
  await expect(page.getByText(/ComfyUI/i)).toHaveCount(0)

  await page.getByRole('button', { name: /Download & install/i }).click()

  // Engine first, then the SMALLEST model in the catalog — the setup path
  // must not pull the 4.4 GB one when a 2.6 GB one would do.
  await expect
    .poll(async () => (await mlxCalls(page)).map((c) => c.cmd), { timeout: 30_000 })
    .toContain('mlx_image_install_model')
  const calls = await mlxCalls(page)
  expect(calls.some((c) => c.cmd === 'install_mlx_diffusion')).toBe(true)
  expect(requireCall(calls, 'mlx_image_install_model').id).toBe('sd-turbo')

  // The hard rule: nothing in this flow reaches for ComfyUI.
  expect(await comfyCalls(page)).toHaveLength(0)
})

test('mac: the Model Manager offers MLX media instead of hiding the rails', async ({ page }) => {
  // The Image/Video rails used to be removed on macOS because the grid behind
  // them is ComfyUI-driven and dead there. Removing them left a Mac user with
  // no model surface for media at all — "where do I get models" had no answer
  // in the place that is literally called Models.
  await page.addInitScript(tauriMockInit, MAC_OPTS)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: /^Models$/ }).first().click()
  await page.getByRole('button', { name: /^Image$/ }).first().click()

  await expect(page.getByText(/Local media on this Mac runs on Apple MLX/i)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('SD Turbo', { exact: true })).toBeVisible()
  // Video belongs under its own rail, not doubled up in the image one.
  await expect(page.getByText('Wan 2.1 T2V 1.3B', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: /^Video$/ }).first().click()
  await expect(page.getByText('Wan 2.1 T2V 1.3B', { exact: true })).toBeVisible({ timeout: 15_000 })
})

test('windows local is unchanged: ComfyUI lanes still offered', async ({ page }) => {
  // Guard against fixing the Mac by breaking everyone else.
  await bootLocalCreate(page, { ...MAC_OPTS, platform: 'windows' })

  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('radio', { name: 'Remove Background', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Edit / Image to Image', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Animate Image', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Music', exact: true })).toBeVisible()
})

test('mac: saving the HuggingFace token in Settings pushes it to Rust', async ({ page }) => {
  // #160: without a token every hub download is anonymous and throttled.
  // Saving in Settings must arm Rust immediately, and the recorded call may
  // only say that a token is present, never echo the value.
  await page.addInitScript(tauriMockInit, MAC_OPTS)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: /^Settings$/ }).click()
  await page.getByRole('button', { name: /AI Backends/i }).click()
  await page.getByRole('button', { name: /Local Media \(Apple MLX\)/i }).click()

  await page.getByLabel('HuggingFace token').fill('hf_e2e_probe')
  await page.getByRole('button', { name: /^Save$/ }).click()
  await expect(page.getByRole('button', { name: /Saved/i })).toBeVisible({ timeout: 10_000 })

  expect(await hfToken(page)).toBe('hf_e2e_probe')

  const call = requireCall(await mlxCalls(page), 'set_hf_token')
  expect(call.present).toBe(true)
  // Against the UNPARSED record: a leak in a field this file does not model
  // would be invisible in the parsed projection, and the check would pass on
  // nothing. `raw` is exactly what the page pushed.
  expect(JSON.stringify(call.raw)).not.toContain('hf_e2e_probe')
})

test('mac: a stored token reaches Rust at boot, without opening Settings', async ({ page }) => {
  // The keychain is the store of record and Rust holds the token in memory
  // only, so a fresh app start must push it down again on its own. If it did
  // not, a download started straight from Create or the Model Manager would
  // still go out anonymous.
  await page.addInitScript(tauriMockInit, MAC_OPTS)
  await page.addInitScript(() => {
    ;(window as unknown as { __E2E_SECRETS__: Record<string, string> }).__E2E_SECRETS__ = {
      'huggingface-token': 'hf_boot_probe',
    }
  })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })

  await expect.poll(() => hfToken(page), { timeout: 15_000 }).toBe('hf_boot_probe')
})
