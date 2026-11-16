import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'
import { characterPill, openCharacterHub, openCharacterTraining } from './support/character-hub'

/**
 * The Character area of Create (3.1.0 part B, the stage David chose on
 * 16.11.2026): one pill "Character" instead of Character, Motion, Lipsync
 * and Swap. The characters are tabs, the picked one stands on the left with
 * its photos beside it, and the bar at the foot switches between Image,
 * Swap, Motion and Talk. Without a character the area shows its three steps
 * and "Create a character"; "New character" is a page of its own.
 * Swap, the sound choice and the lip sync step need the account switch of
 * the server (features.characterHub); without it Swap says "Coming soon".
 *
 * Tauri stubbed, cloud mocked, Create is never pressed. LU_HUB_SHOTS_DIR,
 * when set, receives the screens in the dark and the light theme, at 1296
 * and at 375 px; LU_HUB_MEDIA_DIR brings real pictures and clips (clip.webm,
 * podcast.webm, mr-bean.png, sam-altman.png, oma.png, frame-new.jpg).
 */

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const SWAP_CATALOG = [
  ['scail-2', 'SCAIL 2'],
  ['kling-v3-pro-motion-control', 'Kling 3.0 Pro • Motion Control'],
  ['openjutsu-character-swap', 'OpenJutsu Character Swap'],
  ['wan-2.2-animate-replace', 'Wan 2.2 Animate Replace'],
].map(([id, label]) => ({ id, label, kind: 'video', ops: ['studio'], quote_required: true, t2v: false, i2v: false }))
  .concat([{ id: 'nano-banana-pro-edit', label: 'Nano Banana Pro', kind: 'image', ops: ['studio'], quote_required: true, t2v: false, i2v: false }])
  .concat([{ id: 'flux-dev-lora-ultra-fast', label: 'Flux Dev LoRA', kind: 'image', lora: true, credits: { base: 3000 } } as never])
  .concat([{
    id: 'latentsync', label: 'LatentSync', kind: 'video', ops: ['lipsync'], quote_required: false, t2v: false, i2v: false,
    credits: { base: 9000, length: { basis: 'audio', block: 1, per_block: 3000, min: 3, max: 300, quote: 10 } },
  } as never])

const LORAS = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Bean', trigger_word: 'beanchar', base_family: 'flux', created_at: '2026-11-01T10:00:00Z', source: 'trained', preview_url: null, base_url: 'https://lu-labs.ai/e2e/char/mr-bean.png' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Mila', trigger_word: 'milachar', base_family: 'qwen-image', created_at: '2026-11-02T10:00:00Z', source: 'trained', preview_url: null, base_url: null },
]

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }

async function media(name: string, mimeType: string) {
  const dir = process.env.LU_HUB_MEDIA_DIR
  if (dir) {
    const { readFileSync, existsSync } = await import('node:fs')
    if (existsSync(`${dir}/${name}`)) return { name, mimeType, buffer: readFileSync(`${dir}/${name}`) }
  }
  return { name, mimeType, buffer: PNG_1PX }
}

/** A short clip the WebView can decode: a real one from the media folder,
 *  else one recorded from a canvas in the page. */
async function clip(page: Page, file: string, shownAs: string) {
  const dir = process.env.LU_HUB_MEDIA_DIR
  if (dir) {
    const { readFileSync, existsSync } = await import('node:fs')
    if (existsSync(`${dir}/${file}`)) return { name: shownAs, mimeType: 'video/webm', buffer: readFileSync(`${dir}/${file}`) }
  }
  const b64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 320; canvas.height = 180
    const ctx = canvas.getContext('2d')!
    const paint = (t: number) => {
      ctx.fillStyle = '#d8d4cc'; ctx.fillRect(0, 0, 320, 180)
      ctx.fillStyle = '#6b4f3a'; ctx.beginPath(); ctx.arc(120 + t, 70, 28, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#2f2a28'; ctx.beginPath(); ctx.arc(215 - t, 76, 28, 0, Math.PI * 2); ctx.fill()
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
  return { name: shownAs, mimeType: 'video/webm', buffer: Buffer.from(b64, 'base64') }
}

interface Boot { hub: boolean; width?: number; height?: number; mock?: Partial<TauriMockOptions>; local?: boolean }

async function boot(page: Page, { hub, width = 1296, height = 900, mock = {}, local = false }: Boot): Promise<{ submits: unknown[] }> {
  const narrow = width < 600 ? { width, height } : null
  await page.setViewportSize(narrow ? { width: 1296, height: 900 } : { width, height })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, ...mock })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, extraCatalogModels: SWAP_CATALOG, characterHub: hub, loras: LORAS })
  const seen = { submits: [] as unknown[] }
  const pictures: Record<string, string> = { 'mr-bean.png': 'image/png' }
  await page.route('https://lu-labs.ai/**', async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    if (req.method() === 'OPTIONS') return route.fallback()
    // Nothing may book: any submit is recorded and refused.
    if (path === '/api/jobs' && req.method() === 'POST') {
      seen.submits.push(req.postDataJSON())
      return route.fulfill({ status: 400, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'e2e: no runs' }) })
    }
    const pic = /^\/e2e\/char\/(.+)$/.exec(path)?.[1]
    if (pic && pictures[pic]) {
      const m = await media(pic, pictures[pic])
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': m.mimeType }, body: m.buffer })
    }
    return route.fallback()
  })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  if (!local) {
    await signInViaGate(page)
    await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
  }
  await page.getByRole('button', { name: /^Create$/ }).click()
  // A phone-wide window: the app is opened wide (its head folds its tabs into
  // the menu there), then the window narrows.
  if (narrow) await page.setViewportSize({ width: narrow.width, height: narrow.height })
  return seen
}

async function shoot(page: Page, name: string, focus?: string) {
  const dir = process.env.LU_HUB_SHOTS_DIR
  if (!dir) return
  // The area from its top, as the sketches show it.
  await page.evaluate(() => { for (const el of document.querySelectorAll('[data-character-hub] .hub-body, [data-character-hub] .hub-new, [data-character-hub] .overflow-y-auto')) el.scrollTop = 0 })
  if (focus) await page.locator(focus).first().evaluate((el) => el.scrollIntoView({ block: 'end' }))
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => {
      document.documentElement.classList.toggle('dark', t === 'dark')
      document.documentElement.classList.toggle('light', t === 'light')
    }, theme)
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${dir}/desktop-hub-v2-${name}-${theme}.png` })
  }
  await page.evaluate(() => {
    document.documentElement.classList.add('dark')
    document.documentElement.classList.remove('light')
  })
}

/** A saved photo character, made the way a customer makes one: the page
 *  "New character", photos, a name, Save. */
async function savePhotoCharacter(page: Page, name: string, file: string, copies: number) {
  const photo = await media(file, 'image/png')
  await page.locator('[data-hub-new]').click()
  await expect(page.locator('[data-character-hub]')).toHaveAttribute('data-character-hub', 'new')
  // Nothing stands there before the user's own photos.
  await expect(page.locator('[data-hub-photos]')).toHaveCount(0)
  await page.locator('input[aria-label="Photos or a LoRA file"]').setInputFiles(
    Array.from({ length: copies }, (_, i) => ({ ...photo, name: `${name}-${i + 1}.png` })),
  )
  await expect(page.locator('[data-hub-photos]')).toHaveAttribute('data-hub-photos', String(copies))
  await page.locator('[data-hub-new-name]').fill(name)
  await page.getByRole('button', { name: `Save ${name}`, exact: true }).click()
  await expect(page.locator(`[data-hub-character^="saved:"]`, { hasText: name })).toHaveAttribute('aria-selected', 'true')
}

/** A tap on the first frame at a share of its width and height. */
async function tapFrame(page: Page, x: number, y: number) {
  const frame = page.getByRole('group', { name: /First frame of your video/ })
  const box = await frame.boundingBox()
  if (!box) throw new Error('first frame not on screen')
  await frame.click({ position: { x: box.width * x, y: box.height * y } })
}

test('one pill: the characters as tabs, the stage, and the bar switches the action', async ({ page }) => {
  const seen = await boot(page, { hub: true })

  // The four old pills are one now, marked new.
  await expect(characterPill(page)).toBeVisible()
  await expect(characterPill(page)).toContainText('NEW')
  for (const old of ['Motion Control', 'Talking Character', 'Swap Character', 'Character Studio']) {
    await expect(page.getByRole('radio', { name: old, exact: true })).toHaveCount(0)
  }

  // Every source is a tab; the first character takes the stage by itself.
  await openCharacterHub(page)
  const hub = page.locator('[data-character-hub]')
  await expect(hub).toHaveAttribute('data-character-hub', 'what')
  const bean = page.locator('[data-hub-character="cloud:11111111-1111-4111-8111-111111111111"]')
  await expect(bean).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-hub-card]')).toContainText('Trained · Flux')
  await page.locator('[data-hub-character="cloud:22222222-2222-4222-8222-222222222222"]').click()
  await expect(page.locator('[data-hub-card]')).toContainText('Trained · Qwen')
  await savePhotoCharacter(page, 'Sam', 'sam-altman.png', 12)
  await expect(page.locator('[data-hub-card]')).toContainText('Photos · 12')
  // Only the character's own photos stand on the stage.
  await expect(page.getByRole('list', { name: 'Photos of Sam' }).locator('img')).toHaveCount(12)
  await savePhotoCharacter(page, 'Oma', 'oma.png', 8)
  await expect(page.locator('[data-hub-photo-only]')).toBeVisible()
  await shoot(page, 'a-wer')

  // What Bean should do: the bar asks, nothing is picked yet.
  await bean.click()
  await expect(hub).toHaveAttribute('data-character-hub', 'what')
  await expect(page.locator('[data-hub-action-line]')).toHaveText('What should Bean do?')
  for (const a of ['image', 'swap', 'motion', 'talk']) await expect(page.locator(`[data-hub-action="${a}"]`)).toHaveAttribute('aria-checked', 'false')
  await shoot(page, 'b-was')

  // Swap, Bean on person 1, with the catalogue's price.
  await page.getByRole('radio', { name: 'Swap Character', exact: true }).click()
  await expect(hub).toHaveAttribute('data-character-hub', 'panel')
  await expect(page.locator('[data-hub-action-meta]')).toHaveText('8k / s')
  await expect(page.locator('[data-swap-controls]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Character for person 1' })).toContainText('Bean')
  await page.locator('[data-swap-controls] input[type=file][accept^="video"]').setInputFiles(await clip(page, 'clip.webm', 'clip.mp4'))
  await expect(page.locator('[data-hub-clip]')).toContainText('clip.mp4')
  await expect(page.getByRole('group', { name: /First frame of your video/ })).toBeVisible({ timeout: 20_000 })
  await tapFrame(page, 0.45, 0.33)
  await tapFrame(page, 0.66, 0.36)
  await expect(page.getByRole('textbox', { name: 'Who person 1 replaces' })).toHaveAttribute('placeholder', 'the person on the left')
  await expect(page.getByRole('textbox', { name: 'Who person 2 replaces' })).toHaveAttribute('placeholder', 'the person on the right')
  // Person 2 becomes Sam, from the list.
  await page.getByRole('button', { name: 'Character for person 2' }).click()
  await page.getByRole('option', { name: /^Sam/ }).click()
  await expect(page.getByRole('button', { name: 'Character for person 2' })).toContainText('Sam')
  // The sound: original by default, lip sync only for one person.
  await expect(page.getByRole('radio', { name: 'Original sound' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('radio', { name: 'New voice, lips in sync' })).toBeDisabled()
  await page.getByRole('checkbox').check()
  // The bar: model, length, price with its parts.
  // (6 s and 62k with the real clip of LU_HUB_MEDIA_DIR; the clip recorded
  // in the page is shorter.)
  await expect(page.getByRole('button', { name: 'Length' })).toContainText(/\d+ s/)
  await expect(page.locator('[data-clip-price]')).toContainText(/\d+k/)
  await expect(page.locator('[data-clip-split]')).toContainText(/frame 14k \+ video \d+k/)
  await shoot(page, 'c-swap')

  // Another action keeps the character.
  await page.getByRole('radio', { name: 'Motion Control', exact: true }).click()
  await expect(page.locator('[data-motion-controls]')).toBeVisible()
  await expect(page.locator('[data-portrait-line]')).toContainText('Bean', { timeout: 15_000 })
  // The video of Swap came along; the X in the bar takes it away.
  await expect(page.locator('[data-hub-clip]')).toContainText('clip.mp4')
  await page.getByRole('button', { name: 'Remove the video' }).click()
  await page.locator('[data-motion-controls] input[type=file][accept^="video"]').setInputFiles(await clip(page, 'podcast.webm', 'podcast.mp4'))
  await expect(page.locator('[data-hub-clip]')).toContainText('podcast.mp4')
  await expect(page.locator('[data-sound-controls=motion]')).toBeVisible()
  // Another character's tab takes the portrait's place.
  await page.locator('[data-hub-character^="saved:"]', { hasText: 'Sam' }).click()
  await expect(page.locator('[data-portrait-line]')).toContainText('Sam', { timeout: 15_000 })
  await shoot(page, 'e-motion')

  // Talk, then Image with its price.
  await page.getByRole('radio', { name: 'Talking Character', exact: true }).click()
  await expect(page.locator('[data-talk-controls]')).toBeVisible()
  await bean.click()
  await page.getByRole('radio', { name: 'Character Studio', exact: true }).click()
  await expect(page.locator('[data-hub-action-meta]')).toContainText('from 3k')
  await page.getByRole('radio', { name: 'Talking Character', exact: true }).click()
  await expect(page.locator('[data-talk-controls]')).toBeVisible()

  // The pill goes back to the action that was open.
  await page.getByRole('radio', { name: /^Image$/ }).click()
  await expect(hub).toHaveCount(0)
  await characterPill(page).click()
  await expect(hub).toHaveAttribute('data-character-hub', 'panel')
  await expect(page.locator('[data-talk-controls]')).toBeVisible()

  expect(seen.submits).toHaveLength(0)
})

test('Image runs on the character, More options keeps its file actions', async ({ page }) => {
  await boot(page, { hub: true })
  await openCharacterHub(page)
  await page.locator('[data-hub-character^="cloud:1111"]').click()
  await page.getByRole('radio', { name: 'Character Studio', exact: true }).click()
  await expect(page.getByTestId('character-use-hint')).toContainText('beanchar')
  // The prompt sits in the bar, like the chat's composer.
  await expect(page.getByPlaceholder('Describe the scene for your character…')).toBeVisible()
  await page.getByRole('button', { name: 'More options' }).click()
  const more = page.getByTestId('hub-more')
  await expect(more.locator('[data-character-file-actions]')).toBeVisible()
  await expect(more.getByTestId('character-download')).toBeVisible()
  // The same file actions stand at the character on the stage.
  await expect(page.locator('[data-hub-card] [data-character-file-actions]')).toBeVisible()
})

test('without the account switch: Swap says coming soon, Motion has no sound choice', async ({ page }) => {
  const seen = await boot(page, { hub: false })
  await openCharacterHub(page)
  await page.locator('[data-hub-photo-only]').click()
  await expect(page.locator('[data-hub-card="photo"]')).toContainText('Just use a photo')
  await shoot(page, 'ohne-schalter-b')
  await page.getByRole('radio', { name: 'Swap Character', exact: true }).click()
  await expect(page.locator('[data-hub-action-meta]')).toHaveText('Coming soon to your LU Cloud')
  await expect(page.locator('[data-swap-unavailable="soon"]')).toHaveText('Coming soon to your LU Cloud')
  await expect(page.locator('[data-swap-controls]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Create/ }).last()).toBeDisabled()
  await shoot(page, 'ohne-schalter-swap')
  await page.getByRole('radio', { name: 'Motion Control', exact: true }).click()
  await expect(page.locator('[data-motion-controls]')).toBeVisible()
  await expect(page.locator('[data-sound-controls]')).toHaveCount(0)
  expect(seen.submits).toHaveLength(0)
})

test('with the switch: Swap is one click, the check stops after the frame', async ({ page }) => {
  await boot(page, { hub: true })
  // The built frame of the frame step, from the mock (no booking).
  const frameNew = await media('frame-new.jpg', 'image/jpeg')
  let frames = 0
  await page.route('https://lu-labs.ai/**', async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (path === '/api/jobs/upload' && req.method() === 'POST') return json({ path: `e2e-user-1/staged-${Date.now()}.bin` })
    if (path === '/api/jobs' && req.method() === 'POST') {
      const body = req.postDataJSON() as { params?: { swap_step?: string } }
      if (body.params?.swap_step !== 'frame') return json({ error: 'e2e: only the frame step is mocked' }, 400)
      frames++
      return json({ id: `job-frame-${frames}`, status: 'queued', created_at: new Date().toISOString(), quota: { kind: 'image', cost: 14000, used: 0, limit: 2_550_000 } }, 202)
    }
    const job = /^\/api\/jobs\/(job-frame-\d+)$/.exec(path)
    if (job) {
      return json({ job: { id: job[1], kind: 'image', model: 'nano-banana-pro-edit', provider: 'upstream', status: 'succeeded', result_url: `https://lu-labs.ai/e2e/${job[1]}.jpg`, attestation: null, cost_units: 14000, created_at: new Date().toISOString(), completed_at: new Date().toISOString(), error: null } })
    }
    if (/^\/e2e\/job-frame-\d+\.jpg$/.test(path)) return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': frameNew.mimeType }, body: frameNew.buffer })
    return route.fallback()
  })
  await openCharacterHub(page)
  await page.locator('[data-hub-character^="cloud:1111"]').click()
  await page.getByRole('radio', { name: 'Swap Character', exact: true }).click()
  await page.locator('[data-swap-controls] input[type=file][accept^="video"]').setInputFiles(await clip(page, 'clip.webm', 'clip.mp4'))
  await expect(page.getByRole('group', { name: /First frame of your video/ })).toBeVisible({ timeout: 20_000 })
  await tapFrame(page, 0.45, 0.33)
  await page.getByRole('checkbox').check()
  await page.getByRole('switch', { name: 'Check first frame before video' }).click()
  await page.getByRole('button', { name: /^Create · / }).last().click()
  await expect(page.getByText('Does this look right?')).toBeVisible({ timeout: 20_000 })
  await shoot(page, 'd-swap-pruefen')
  await expect(page.getByRole('button', { name: /^Continue · / })).toBeEnabled()
  await expect(page.getByRole('button', { name: /^Try again · 14k/ })).toBeEnabled()
  expect(frames).toBe(1)
})

test('local mode: Swap is locked to the cloud, the local lanes are there', async ({ page }) => {
  await boot(page, { hub: true, local: true, mock: { platform: 'mac', mlx: { ltx2EngineInstalled: true, installedVideos: ['ltx-2.3-q4', 'ltx-2.3-motion-control'], loras: [{ name: 'char_opa_zimage.safetensors' }] } } })
  await openCharacterHub(page)
  await expect(page.locator('[data-hub-character="mlx:char_opa_zimage.safetensors"]')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 })
  await expect(page.locator('[data-hub-card]')).toContainText('Local LoRA')
  // A local LoRA has no picture and no photos here: a line says so, nothing stands in.
  await expect(page.locator('[data-hub-no-photos]')).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Swap Character, runs on LU Cloud' })).toBeVisible()
  await shoot(page, 'lokal-b')
  await page.getByRole('radio', { name: 'Swap Character, runs on LU Cloud' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // Motion runs on this Mac: the LTX-2.3 pack, no sound choice.
  await page.getByRole('radio', { name: 'Motion Control', exact: true }).click()
  await expect(page.locator('[data-motion-controls]')).toBeVisible()
  await expect(page.locator('[data-hub-action-meta]')).toContainText('Local')
  await expect(page.locator('[data-sound-controls]')).toHaveCount(0)
  await shoot(page, 'lokal-e-motion')
})

test('the training is a page of the area, with the way back to the stage', async ({ page }) => {
  await boot(page, { hub: true })
  // The way of SaveCharacterModal and the chat: setIntent('character') with
  // the training tab. Here through the area's own page.
  await openCharacterTraining(page)
  const hub = page.locator('[data-character-hub]')
  await expect(hub).toHaveAttribute('data-character-hub', 'panel')
  await expect(page.locator('[data-hub-training]')).toContainText('Train a model')
  await page.locator('[data-hub-back]').click()
  await expect(page.locator('[data-hub-stage]')).toBeVisible()
  await expect(characterPill(page)).toHaveAttribute('aria-checked', 'true')
})

test('phone width: the same stage without the left column, the bar in its short form', async ({ page }) => {
  await boot(page, { hub: true, width: 375, height: 812 })
  await openCharacterHub(page)
  await shoot(page, 'handy-a-wer')
  await page.locator('[data-hub-character^="cloud:1111"]').click()
  await shoot(page, 'handy-b-was')
  await page.getByRole('radio', { name: 'Swap Character', exact: true }).click()
  await page.locator('[data-swap-controls] input[type=file][accept^="video"]').setInputFiles(await clip(page, 'clip.webm', 'clip.mp4'))
  await expect(page.getByRole('group', { name: /First frame of your video/ })).toBeVisible({ timeout: 20_000 })
  await tapFrame(page, 0.45, 0.33)
  await tapFrame(page, 0.66, 0.36)
  await page.getByRole('checkbox').check()
  await expect(page.locator('[data-hub-bar-summary]')).toContainText(/Auto · SCAIL-2 · 720p · \d+ s/)
  await shoot(page, 'handy-c-swap')
  await page.locator('[data-hub-bar-summary]').click()
  await expect(page.locator('[data-hub-bar-options]')).toBeVisible()
  await page.locator('[data-hub-bar-summary]').click()
  await page.getByRole('radio', { name: 'Motion Control', exact: true }).click()
  await expect(page.locator('[data-motion-controls]')).toBeVisible()
  await shoot(page, 'handy-e-motion')
})

test('no character yet: the three steps, one button, four examples and nothing else', async ({ page }) => {
  await boot(page, { hub: true, mock: {} })
  await page.route('https://lu-labs.ai/api/loras', (route) => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ loras: [] }) }))
  await openCharacterHub(page)
  const hub = page.locator('[data-character-hub]')
  await expect(hub).toHaveAttribute('data-character-hub', 'who')
  await expect(page.locator('[data-hub-empty] ol > li')).toHaveCount(3)
  await expect(page.locator('[data-hub-example]')).toHaveCount(4)
  await expect(page.locator('[data-hub-empty] h1, [data-hub-empty] h2')).toHaveCount(0)
  await shoot(page, 'leer')
  await page.locator('[data-hub-create] button').click()
  await expect(hub).toHaveAttribute('data-character-hub', 'new')
  // The page starts with the drop field alone.
  await expect(page.locator('[data-hub-drop]')).toBeVisible()
  await expect(page.locator('[data-hub-photos]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await shoot(page, 'neu-leer')
  const photo = await media('oma.png', 'image/png')
  await page.locator('input[aria-label="Photos or a LoRA file"]').setInputFiles(Array.from({ length: 5 }, (_, i) => ({ ...photo, name: `oma-${i + 1}.png` })))
  await page.locator('[data-hub-new-name]').fill('Oma')
  await expect(page.locator('[data-hub-save-summary]')).toHaveText('5 photos · kept on this computer · free')
  await shoot(page, 'neu-mit-fotos')
  await page.getByRole('button', { name: 'Save Oma', exact: true }).click()
  await expect(hub).toHaveAttribute('data-character-hub', 'what')
  await expect(page.locator('[data-hub-card-name]')).toHaveText('Oma')
  // Rename on the desktop.
  await page.locator('[data-hub-rename]').click()
  await page.getByRole('textbox', { name: 'New name for Oma' }).fill('Greta')
  await page.locator('[data-hub-rename-save]').click()
  await expect(page.locator('[data-hub-card-name]')).toHaveText('Greta')
  await expect(page.locator('[data-hub-character^="saved:"]')).toContainText('Greta')
})
