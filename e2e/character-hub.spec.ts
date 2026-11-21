import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'
import { characterPill, openCharacterHub, openCharacterTraining } from './support/character-hub'

/**
 * The Character area of Create (3.1.0 part B, as David set it on
 * 16.11.2026): one pill "Character" instead of Character, Motion, Lipsync
 * and Swap. The prompt window is the Composer of every tab: 660 wide,
 * centred, at the same place as on Image. Over it stands the row of the tab
 * (Image, Swap, Motion, Talk); the area above is one column of the same
 * width: the characters as tabs, the picked one as a head, its photos or
 * the inputs of the action. Without a character the area shows its three
 * steps and "Create a character"; "New character" is a page of its own.
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

const windowBox = async (page: Page) => (await page.locator('[data-prompt-window]').boundingBox())!
const settings = (page: Page) => page.locator('[data-prompt-window] button[title="Advanced settings"]')

/** The prompt window stands where it stood on Image: same left edge, same
 *  width, same lower edge. */
async function expectWindowAt(page: Page, image: { x: number; y: number; width: number; height: number }) {
  const now = await windowBox(page)
  expect(Math.abs(now.x - image.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(now.width - image.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(now.y + now.height - (image.y + image.height))).toBeLessThanOrEqual(1)
}

/** Everything of the stage stands on the middle axis of the prompt window:
 *  the row of the characters, the head, the name, the photos. */
async function expectOnAxis(page: Page, selectors: string[]) {
  const win = await windowBox(page)
  const axis = win.x + win.width / 2
  for (const sel of selectors) {
    const box = (await page.locator(sel).first().boundingBox())!
    expect(Math.abs(box.x + box.width / 2 - axis), sel).toBeLessThanOrEqual(2)
  }
}

/** A tap on the first frame at a share of its width and height. */
async function tapFrame(page: Page, x: number, y: number) {
  const frame = page.getByRole('group', { name: /First frame of your video/ })
  const box = await frame.boundingBox()
  if (!box) throw new Error('first frame not on screen')
  await frame.click({ position: { x: box.width * x, y: box.height * y } })
}

test('one pill: the characters as tabs, the stage, and the row over the window switches the action', async ({ page }) => {
  const seen = await boot(page, { hub: true })
  // Where the prompt window stands on Image.
  const onImage = await windowBox(page)
  expect(Math.round(onImage.width)).toBe(759)

  // The four old pills are one now, marked new.
  await expect(characterPill(page)).toBeVisible()
  await expect(characterPill(page)).toContainText('NEW')
  for (const old of ['Motion Control', 'Talking Character', 'Swap Character', 'Character Studio']) {
    await expect(page.getByRole('radio', { name: old, exact: true })).toHaveCount(0)
  }

  // Every source is a tab; the first character takes the stage by itself.
  await openCharacterHub(page)
  const hub = page.locator('[data-character-hub]')
  await expect(hub).toHaveAttribute('data-character-hub', 'panel')
  const bean = page.locator('[data-hub-character="cloud:11111111-1111-4111-8111-111111111111"]')
  await expect(bean).toHaveAttribute('aria-selected', 'true')
  // The same window as on Image, at the same place, and the area over it
  // is a column of its width.
  await expectWindowAt(page, onImage)
  const column = (await page.locator('.hub-scroll').boundingBox())!
  expect(Math.abs(column.width - onImage.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(column.x - onImage.x)).toBeLessThanOrEqual(1)
  await expect(page.locator('.hub-bar, [data-swap-bar]')).toHaveCount(0)
  // No card on the stage: the character's things are in the menu at its tab.
  await expect(page.locator('[data-hub-card]')).toHaveCount(0)
  await expect(page.locator('[data-hub-tab-name]')).toHaveText('Bean')
  await page.locator('[data-hub-character="cloud:22222222-2222-4222-8222-222222222222"]').click()
  await expect(page.locator('[data-hub-tab-name]')).toHaveText('Mila')
  await savePhotoCharacter(page, 'Sam', 'sam-altman.png', 12)
  await expect(page.locator('[data-hub-tab-name]')).toHaveText('Sam')
  // Only the character's own photos stand on the stage.
  await expect(page.getByRole('list', { name: 'Photos of Sam' }).locator('img')).toHaveCount(12)
  await savePhotoCharacter(page, 'Oma', 'oma.png', 8)
  await expect(page.locator('[data-hub-photo-only]')).toBeVisible()
  // With photos that fill the room the block starts at the top; shorter
  // (no card on the stage since 3.1.3) it stands in the middle.
  {
    const room = (await page.locator('.hub-scroll').boundingBox())!
    const block = (await page.locator('.hub-center').boundingBox())!
    if (block.height >= room.height - 1) expect(Math.abs(block.y - room.y)).toBeLessThanOrEqual(2)
    else expect(Math.abs((block.y + block.height / 2) - (room.y + room.height / 2))).toBeLessThanOrEqual(2)
  }
  // Four characters at this width: the row in full, around the middle, with
  // New character as its last entry; the head and the photos under it on
  // the same axis as the prompt window.
  await expect(page.locator('[data-hub-tabs]')).toHaveAttribute('data-hub-tabs-fit', 'names')
  await expect(page.locator('[role=tablist] > :last-child')).toHaveAttribute('data-hub-new', /.*/)
  await expectOnAxis(page, ['[role=tablist][aria-label="My characters"]', '.hub-photos'])
  await shoot(page, 'a-wer')

  // Bean on the stage: Image is the action, and the text field is there.
  await bean.click()
  await expect(hub).toHaveAttribute('data-character-hub', 'panel')
  await expect(page.locator('[data-hub-action="image"]')).toHaveAttribute('aria-checked', 'true')
  for (const a of ['swap', 'motion', 'talk']) await expect(page.locator(`[data-hub-action="${a}"]`)).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('[data-prompt-window] textarea')).toHaveAttribute('placeholder', 'Describe a new picture of Bean')
  await expect(page.locator('[data-prompt-window] textarea')).toBeEnabled()
  await expectWindowAt(page, onImage)
  await shoot(page, 'b-was')

  // Swap, Bean on person 1, with the catalogue's price.
  await page.getByRole('radio', { name: 'Swap Character', exact: true }).click()
  await expect(hub).toHaveAttribute('data-character-hub', 'panel')
  // Swap runs on this computer too since 3.1.3 (Windows/Linux, Wan 2.2 Animate).
  await expect(page.locator('[data-hub-action-meta]')).toHaveText('Local · 8k / s')
  await expect(page.locator('[data-swap-controls]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Character for person 1' })).toContainText('Bean')
  // The video comes in through the upload of the prompt window.
  await expectWindowAt(page, onImage)
  await expect(page.locator('[data-prompt-window] textarea')).toBeDisabled()
  await page.locator('[data-prompt-window] [data-hub-upload]').setInputFiles(await clip(page, 'clip.webm', 'clip.mp4'))
  await expect(page.locator('[data-hub-clip]')).toContainText('clip.mp4')
  await expect(page.getByRole('group', { name: /First frame of your video/ })).toBeVisible({ timeout: 20_000 })
  await tapFrame(page, 0.45, 0.33)
  await tapFrame(page, 0.66, 0.36)
  await expect(page.locator('[data-swap-figure="1"] [data-swap-place]')).toHaveText('left')
  await expect(page.locator('[data-swap-figure="2"] [data-swap-place]')).toHaveText('right')
  // Person 2 becomes Sam, from the list.
  await page.getByRole('button', { name: 'Character for person 2' }).click()
  await page.getByRole('option', { name: /^Sam/ }).click()
  await expect(page.getByRole('button', { name: 'Character for person 2' })).toContainText('Sam')
  // The sound: original by default, lip sync only for one person.
  await expect(page.getByRole('radio', { name: 'Original sound' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('radio', { name: 'New voice, lips in sync' })).toBeDisabled()
  await page.getByRole('checkbox').check()
  // One line says what runs and what the total is made of; the button of
  // the window names the total. (6 s and 62k with the real clip of
  // LU_HUB_MEDIA_DIR; the clip recorded in the page is shorter.)
  await expect(page.locator('[data-clip-price]')).toContainText(/\d+k/)
  await expect(page.locator('[data-clip-split]')).toContainText(/frame 14k \+ video \d+k/)
  await expect(page.locator('[data-prompt-window]').getByRole('button', { name: /^Create · \d+k$/ })).toBeEnabled()
  await expectWindowAt(page, onImage)
  await shoot(page, 'c-swap')
  // The length and the engines are in the settings of the window.
  await settings(page).click()
  await expect(page.locator('[data-hub-settings]').getByRole('button', { name: 'Length' })).toContainText(/\d+ s/)
  await expect(page.locator('[data-hub-settings] [data-swap-picks]')).toBeVisible()
  await shoot(page, 'c-swap-settings')
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-hub-settings]')).toHaveCount(0)

  // Another action keeps the character.
  await page.getByRole('radio', { name: 'Motion Control', exact: true }).click()
  await expect(page.locator('[data-motion-controls]')).toBeVisible()
  await expect(page.locator('[data-portrait-line]')).toContainText('Bean', { timeout: 15_000 })
  // The video of Swap came along; the X beside its name takes it away.
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

test('Image runs on the character, its file actions stand at the character', async ({ page }) => {
  await boot(page, { hub: true })
  await openCharacterHub(page)
  await page.locator('[data-hub-character^="cloud:1111"]').click()
  await page.getByRole('radio', { name: 'Character Studio', exact: true }).click()
  await expect(page.getByTestId('character-use-hint')).toContainText('beanchar')
  // The prompt sits in the window, as on every tab.
  await expect(page.getByPlaceholder('Describe a new picture of Bean')).toBeVisible()
  // The file actions are rows of the menu at the character's tab, once.
  await page.locator('[data-hub-menu]').click()
  await expect(page.locator('[data-hub-menu-list] [data-hub-download]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Download character' })).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-hub-menu-list]')).toBeHidden()
  // In the window: the field, the settings and Create. The model is in the
  // settings, not in the window.
  const win = page.locator('[data-prompt-window]')
  await expect(win.locator('button')).toHaveCount(2)
  await settings(page).click()
  await expect(page.locator('[data-hub-settings] [data-hub-setting="Model"]')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('without the account switch: Swap says coming soon, Motion has no sound choice', async ({ page }) => {
  const seen = await boot(page, { hub: false })
  await openCharacterHub(page)
  await page.locator('[data-hub-photo-only]').click()
  await expect(page.locator('[data-hub-photo-only]')).toHaveAttribute('aria-selected', 'true')
  // Nothing to rename or delete without a character: no three dots.
  await expect(page.locator('[data-hub-menu]')).toHaveCount(0)
  await shoot(page, 'ohne-schalter-b')
  await page.getByRole('radio', { name: 'Swap Character', exact: true }).click()
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
  await page.locator('[data-prompt-window]').getByRole('button', { name: /^Create · / }).click()
  await expect(page.getByText('Does this look right?')).toBeVisible({ timeout: 20_000 })
  await shoot(page, 'd-swap-pruefen')
  // The check goes through the same window: its field asks, its button goes on.
  await expect(page.locator('[data-prompt-window] textarea')).toHaveAttribute('placeholder', "What's wrong? (optional)")
  await expect(page.locator('[data-prompt-window]').getByRole('button', { name: /^Continue · / })).toBeEnabled()
  await expect(page.getByRole('button', { name: /^Try again · 14k/ })).toBeEnabled()
  await expect(page.locator('.hub-bar, [data-swap-bar]')).toHaveCount(0)
  expect(frames).toBe(1)
})

test('local mode on a Mac: Swap stays on the cloud (no local way there), the local lanes are there', async ({ page }) => {
  await boot(page, { hub: true, local: true, mock: { platform: 'mac', mlx: { ltx2EngineInstalled: true, installedVideos: ['ltx-2.3-q4', 'ltx-2.3-motion-control'], loras: [{ name: 'char_opa_zimage.safetensors' }] } } })
  await openCharacterHub(page)
  await expect(page.locator('[data-hub-character="mlx:char_opa_zimage.safetensors"]')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 })
  await expect(page.locator('[data-hub-character="mlx:char_opa_zimage.safetensors"]')).toHaveAttribute('title', /trigger word/)
  // A local LoRA has no picture and no photos here: a line says so, nothing stands in.
  await expect(page.locator('[data-hub-no-photos]')).toBeVisible()
  // Shorter than the room: the block stands in the middle between the row
  // of the characters and the row over the prompt window, not at the top.
  const room = (await page.locator('.hub-scroll').boundingBox())!
  const block = (await page.locator('.hub-center').boundingBox())!
  expect(block.height).toBeLessThan(room.height)
  expect(Math.abs((block.y + block.height / 2) - (room.y + room.height / 2))).toBeLessThanOrEqual(2)
  // Image is the action, and the window is ready for a text. The character
  // of this machine is not put into the run by opening the tab (its LoRA and
  // its model would follow into the Image tab): Create does that.
  await expect(page.locator('[data-hub-action="image"]')).toHaveAttribute('aria-checked', 'true')
  const field = page.locator('[data-prompt-window] textarea')
  await expect(field).toHaveAttribute('placeholder', 'Describe a new picture of opa')
  const make = page.locator('[data-prompt-window]').getByRole('button', { name: 'Create' })
  await expect(make).toBeDisabled()
  await expect(page.getByTestId('character-use-hint')).toHaveCount(0)
  await field.fill('opa at the beach')
  await expect(make).toBeEnabled()
  await field.fill('')
  // Picked by hand, the character is in the run and the note says how to call it.
  await page.locator('[data-hub-character="mlx:char_opa_zimage.safetensors"]').click()
  await expect(page.locator('[data-hub-step="panel"]')).toBeVisible()
  await expect(page.locator('[data-testid="character-use-hint"], [data-testid="character-model-warning"]')).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Swap Character, runs on LU Cloud' })).toBeVisible()
  await shoot(page, 'lokal-b')
  await page.getByRole('radio', { name: 'Swap Character, runs on LU Cloud' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  // The sheet of the Character area carries the LU mark, no stock icons.
  await expect(page.getByTestId('cloud-teaser-logo').locator('img')).toBeVisible()
  await expect(page.getByRole('dialog').locator('.lucide-cloud, .lucide-monitor-down, .lucide-sparkles')).toHaveCount(0)
  await shoot(page, 'cloud-blatt')
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
  // Back goes to the page it came from (photos and name), then to the stage.
  await page.locator('[data-hub-back]').click()
  await expect(hub).toHaveAttribute('data-character-hub', 'new')
  await page.locator('[data-hub-back]').click()
  await expect(page.locator('[data-hub-stage]')).toBeVisible()
  await expect(characterPill(page)).toHaveAttribute('aria-checked', 'true')
})

test('phone width: the same stage and the same window, nothing folded away', async ({ page }) => {
  await boot(page, { hub: true, width: 375, height: 812 })
  await openCharacterHub(page)
  // No room for names: the row is the round pictures, still in the middle,
  // and each one says its name.
  await expect(page.locator('[data-hub-tabs]')).toHaveAttribute('data-hub-tabs-fit', /picked|pictures/)
  await expect(page.locator('[data-hub-character^="cloud:2222"]')).toHaveAttribute('title', /Mila/)
  await expectOnAxis(page, ['[role=tablist][aria-label="My characters"]'])
  await shoot(page, 'handy-a-wer')
  await page.locator('[data-hub-character^="cloud:1111"]').click()
  await shoot(page, 'handy-b-was')
  await page.getByRole('radio', { name: 'Swap Character', exact: true }).click()
  await page.locator('[data-swap-controls] input[type=file][accept^="video"]').setInputFiles(await clip(page, 'clip.webm', 'clip.mp4'))
  await expect(page.getByRole('group', { name: /First frame of your video/ })).toBeVisible({ timeout: 20_000 })
  await tapFrame(page, 0.45, 0.33)
  await tapFrame(page, 0.66, 0.36)
  await page.getByRole('checkbox').check()
  await expect(page.locator('[data-swap-summary]')).toHaveText('SCAIL-2 · 720p')
  await expect(page.locator('[data-prompt-window]').getByRole('button', { name: /^Create · \d+k$/ })).toBeVisible()
  await shoot(page, 'handy-c-swap')
  await page.getByRole('radio', { name: 'Motion Control', exact: true }).click()
  await expect(page.locator('[data-motion-controls]')).toBeVisible()
  await shoot(page, 'handy-e-motion')
})

test('no character yet: the three steps, one button and the same window', async ({ page }) => {
  await boot(page, { hub: true, mock: {} })
  const onImage = await windowBox(page)
  await page.route('https://lu-labs.ai/api/loras', (route) => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ loras: [] }) }))
  await openCharacterHub(page)
  const hub = page.locator('[data-character-hub]')
  await expect(hub).toHaveAttribute('data-character-hub', 'who')
  await expect(page.locator('[data-hub-empty] ol > li')).toHaveCount(3)
  await expectOnAxis(page, ['[data-hub-empty] ol', '[data-hub-create]'])
  await expect(page.locator('[data-hub-example], [data-hub-empty] svg[viewBox="0 0 120 80"], [data-hub-empty] img')).toHaveCount(0)
  await expect(page.locator('[data-hub-empty] h1, [data-hub-empty] h2')).toHaveCount(0)
  // The window is there, with its field, and says what it waits for.
  await expectWindowAt(page, onImage)
  await expect(page.locator('[data-prompt-window] textarea')).toBeVisible()
  await expect(page.locator('[data-hub-action="image"]')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('lane-input-note')).toHaveText('Create a character first.')
  await expect(page.locator('[data-prompt-window]').getByRole('button', { name: 'Create' })).toBeDisabled()
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
  await expectWindowAt(page, onImage)
  await page.getByRole('button', { name: 'Save Oma', exact: true }).click()
  await expect(hub).toHaveAttribute('data-character-hub', 'panel')
  await expect(page.locator('[data-hub-tab-name]')).toHaveText('Oma')
  // A photo character: the field asks for the picture, the button goes on
  // to Edit with its photos.
  await expect(page.locator('[data-prompt-window] textarea')).toHaveAttribute('placeholder', 'Describe a new picture of Oma')
  await expect(page.getByRole('button', { name: 'Continue in Edit' })).toHaveCount(0)
  await expectWindowAt(page, onImage)
  // Rename on the desktop: the three dots at the tab, a short list in the
  // style of the model list (no card, no grey bubble), Rename in the tab.
  const onTop = (sel: string) => page.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return r.width > 4 && r.height > 4 && !!hit && (hit === el || el.contains(hit)) && r.right <= window.innerWidth && r.left >= 0
  })
  await page.locator('[data-hub-menu]').click()
  await expect(page.locator('[data-hub-menu-sheet].lu-picker [data-hub-menu-list]')).toBeVisible()
  await page.locator('[data-hub-menu-list] [data-hub-rename]').click()
  await page.getByRole('textbox', { name: 'New name for Oma' }).fill('Greta')
  await page.locator('[data-hub-rename-save]').click()
  await expect(page.locator('[data-hub-tab-name]')).toHaveText('Greta')
  await expect(page.locator('[data-hub-character^="saved:"]')).toContainText('Greta')
  // A narrow window: every row of the menu is on screen and on top.
  for (const width of [700, 520, 380]) {
    await page.setViewportSize({ width, height: 800 })
    await page.locator('[data-hub-menu]').click()
    for (const sel of ['[data-hub-rename]', '[data-hub-train]', '[data-hub-delete]']) {
      await expect(page.locator(`[data-hub-menu-list] ${sel}`)).toBeVisible()
      expect(await onTop(`[data-hub-menu-list] ${sel}`), `${sel} at ${width}`).toBe(true)
    }
    if (width === 380) await shoot(page, 'schmal-menue')
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-hub-menu-list]')).toBeHidden()
    await expectOnAxis(page, ['[role=tablist][aria-label="My characters"]', '.hub-photos'])
  }
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('[data-hub-menu]').click()
  await page.locator('[data-hub-menu-list] [data-hub-rename]').click()
  await page.getByRole('textbox', { name: 'New name for Greta' }).fill('Oma')
  await page.locator('[data-hub-rename-save]').click()
  await expect(page.locator('[data-hub-tab-name]')).toHaveText('Oma')
  // The line about Local and Cloud stands where the picked action shows its price.
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.locator('[data-hub-local-line]')).toHaveCount(1)
  await page.locator('[data-hub-action="motion"]').click()
  await expect(page.locator('[data-hub-local-line]')).toHaveText('Local runs on your own machine and costs nothing. Cloud prices in credits.')
  await page.setViewportSize({ width: 380, height: 800 })
  await expect(page.locator('[data-hub-local-line]')).toBeVisible()
})
