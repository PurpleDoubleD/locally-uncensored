/**
 * "My computer" in Create and "Sign in with my computer" (R53, LU 3.0.7),
 * in a browser without Tauri.
 *
 * The page runs as on a phone: the commands remote_sealed_* are answered in
 * the test process by the stand in of Rust (fakeSealed.ts), which talks to
 * the stand in of the desktop (fakeDesktop.ts with `sealed` and `create`,
 * the Create routes of remote_create.rs). lu-labs.ai and the account server
 * are answered in the page; nothing leaves the machine.
 *
 * Held here: "My computer" only when paired over the channel and the
 * computer names Create; no price, no credits on that page; the job runs to
 * the gallery with the report button; cancel ends it on the computer; 403
 * is said honestly; nothing goes in plain text over the internet; the App
 * Store package has no "My computer"; the page fits 412x915 without
 * scrolling; "Sign in with my computer" only behind its switch.
 *
 *   LU_E2E_PORT=5393 LU_E2E_ONLY=remote-create npx playwright test --project=mobile --workers=2
 */
import { crc32, deflateSync } from 'node:zlib'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { seedFakeGallery } from '../../src/mobile/remote/__tests__/fakeDesktopCreate'
import { startFakeDesktop, type FakeDesktop } from '../../src/mobile/remote/__tests__/fakeDesktop'
import { createFakeSealedPhone, type FakeSealedPhone } from '../../src/mobile/remote/__tests__/fakeSealed'
import { CLOUD_PROBE, declareAdult, measureLayout, openShell, shellUrl, watchErrors } from './support'

const NET = 'https://quiet-river-lamp.trycloudflare.com'

interface Phone {
  sealed: FakeSealedPhone
  plain: string[]
}

function toDesk(desk: FakeDesktop, url: string): string {
  const u = new URL(url)
  if (u.origin !== NET) throw new Error('remote_client_request: The desktop could not be reached.')
  return `${desk.url}${u.pathname}${u.search}`
}

async function phone(context: BrowserContext, desk: FakeDesktop): Promise<Phone> {
  const sealed = createFakeSealedPhone(async (url, body) => {
    const res = await fetch(toDesk(desk, url), { method: 'POST', body: Buffer.from(body), headers: { 'content-type': 'application/octet-stream' } })
    const headers: Record<string, string> = {}
    const ra = res.headers.get('retry-after')
    if (ra) headers['retry-after'] = ra
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()), headers }
  })
  const state: Phone = { sealed, plain: [] }
  const secrets = new Map<string, string>()
  await context.route(CLOUD_PROBE, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '' }))
  await context.exposeFunction('__e2eSecret', (op: string, account: string, value?: string): string | null => {
    if (op === 'set') secrets.set(account, String(value ?? ''))
    if (op === 'delete') secrets.delete(account)
    return op === 'get' ? (secrets.get(account) ?? null) : null
  })
  await context.exposeFunction('__e2ePlain', async (args: { baseUrl: string; path: string; method: string; token: string | null; body: string | null }) => {
    state.plain.push(`${args.method} ${args.baseUrl}${args.path}`)
    const answer = await fetch(toDesk(desk, `${args.baseUrl}${args.path}`), { method: args.method, body: args.body ?? undefined })
    return { status: answer.status, body: answer.status === 204 ? '' : await answer.text(), refreshedToken: null, memoryRevoked: false }
  })
  await context.exposeFunction('__e2eSealed', async (cmd: string, args: Record<string, unknown>) => {
    try {
      return { ok: true, value: await sealed.invoke(cmd, args) }
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) }
    }
  })
  await context.addInitScript(() => {
    type Hooks = {
      __e2eSecret: (op: string, account: string, value?: string) => Promise<string | null>
      __e2ePlain: (args: Record<string, unknown>) => Promise<unknown>
      __e2eSealed: (cmd: string, args: Record<string, unknown>) => Promise<{ ok: boolean; value?: unknown; error?: string }>
    }
    const hooks = window as unknown as Hooks
    let callbacks = 0
    const invoke = async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      const account = String(args.account ?? '')
      if (command.startsWith('remote_sealed_')) {
        const r = await hooks.__e2eSealed(command, args)
        if (!r.ok) throw r.error
        return r.value
      }
      if (command.endsWith('scan_qr')) {
        const qr = (window as unknown as { __e2eQr?: string }).__e2eQr
        return qr ? { text: qr } : null
      }
      switch (command) {
        case 'secret_set':
          return hooks.__e2eSecret('set', account, String(args.value))
        case 'secret_get':
          return hooks.__e2eSecret('get', account)
        case 'secret_delete':
          return hooks.__e2eSecret('delete', account)
        case 'remote_client_request':
          return hooks.__e2ePlain(args)
        case 'plugin:event|listen':
          return ++callbacks
        default:
          return null
      }
    }
    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { configurable: true, value: { unregisterListener: () => undefined } })
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke,
        transformCallback: () => ++callbacks,
        unregisterCallback: () => undefined,
        convertFileSrc: (file: string) => file,
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
      },
    })
  })
  return state
}

/** Pair over the QR code (internet), as in remote-sealed.mobile.ts. */
async function pair(page: Page, desk: FakeDesktop, store?: 'play'): Promise<void> {
  await page.addInitScript((qr) => {
    ;(window as unknown as { __e2eQr?: string }).__e2eQr = qr
  }, desk.sealed!.qrLink({ net: NET }))
  await openShell(page, store ? { store } : {})
  await page.evaluate(async () => {
    const { nav } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/nav/index.ts`)
    nav.resetTo('chat', [])
  })
  await page.getByTestId('m-chats-segment-remote').tap()
  await page.getByTestId('m-remote-scan').tap()
  await page.getByTestId('m-remote-connect-submit').tap()
  await expect(page.getByTestId('m-remote-chat-screen')).toBeVisible()
}

/** The tab Create, from a cold start (which lands in a new chat). */
async function openCreateTab(page: Page, store?: 'appstore' | 'play'): Promise<void> {
  await openShell(page, store ? { store } : {})
  await page.evaluate(async () => {
    const { nav } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/nav/index.ts`)
    nav.resetTo('create', [])
  })
}

function nothingPlainOverTheInternet(p: Phone): void {
  for (const call of p.plain) expect(call).toBe(`GET ${NET}/remote-api/status`)
  for (const url of p.sealed.posts) expect(url.endsWith('/remote-api/sealed')).toBe(true)
}

/** The page of "My computer" shows no price, no credits and no time estimate. */
async function noPrice(page: Page): Promise<void> {
  await expect(page.getByTestId('m-create-credits')).toHaveCount(0)
  await expect(page.getByTestId('m-create-price')).toHaveCount(0)
  const text = (await page.getByTestId('m-app').innerText()).toLowerCase()
  expect(text).not.toMatch(/credit|\bcr\b|price|usually|about \d+ (s|sec|min)/)
}

let desk: FakeDesktop

test.beforeEach(async () => {
  desk = await startFakeDesktop({ sealed: true, create: true })
  desk.create!.imageBytes = 3000
})
test.afterEach(async () => {
  await desk.stop()
})


/**
 * Prompt v2 (c19cc0cad): no tool row above the field on "My computer". The tools are the group "What" in the
 * settings sheet, which the settings button under the field opens.
 */
async function computerTool(page: Page, id: string): Promise<void> {
  await page.getByTestId('m-create-computer-settings').tap()
  await page.getByTestId(`m-create-computer-tool-${id}`).tap()
  if (await page.getByTestId('m-create-computer-sheet').isVisible()) await page.getByTestId('m-sheet-close').tap()
  await expect(page.getByTestId('m-create-computer-stage')).toHaveAttribute('data-m-tool', id)
}

test.describe('My computer in Create', () => {
  test('signed out of LU Cloud: create an image on the computer, into the gallery, no price, nothing in plain text', async ({ page, context }) => {
    const errors = watchErrors(page)
    const p = await phone(context, desk)
    await page.setViewportSize({ width: 412, height: 915 })
    await pair(page, desk)
    desk.sealed!.devices.get(p.sealed.deviceId)!.rights.add('create')
    await openCreateTab(page)
    // The gate of LU Cloud offers the computer as well.
    await page.getByTestId('m-create-gate-computer').tap()
    await expect(page.getByTestId('m-create-computer-stage')).toBeVisible()
    await expect(page.getByTestId('m-create-computer-settings')).toContainText('FLUX.1 schnell')
    await noPrice(page)
    // Prompt v2: where it runs is part of the settings button, "My computer" in the summary, the whole words in its name.
    await expect(page.getByTestId('m-create-computer-settings')).toContainText('My computer')
    await expect(page.getByTestId('m-create-computer-settings')).toHaveAttribute('aria-label', /On your computer/)
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    // Nothing to scroll on 412x915 (round 45).
    const scroll = await page.evaluate(() => {
      const body = document.querySelector('.m-page:not([data-m-exit]) .m-page-body') as HTMLElement | null
      return body ? body.scrollHeight - body.clientHeight : -1
    })
    expect(scroll).toBeLessThanOrEqual(0)

    await page.getByTestId('m-create-computer-prompt').fill('a lighthouse at dusk')
    await page.getByTestId('m-create-computer-generate').tap()
    await expect(page.getByTestId('m-create-computer-result')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('m-create-computer-report')).toBeVisible()
    await expect(page.getByTestId('m-create-computer-result').locator('img')).toBeVisible()
    await noPrice(page)
    expect(desk.create!.bodies[0]).toMatchObject({ kind: 'image', prompt: 'a lighthouse at dusk', model: 'flux1-schnell.safetensors' })
    expect(String(desk.create!.bodies[0].client_request_id)).toMatch(/^lu-phone-/)

    // The result is in the gallery of the phone.
    await page.getByTestId('m-create-gallery').tap()
    await expect(page.locator('[data-testid="m-create-gallery-tile"][data-m-id^="pc_res_"]').first()).toBeVisible()
    await expect(page.locator('[data-testid="m-create-gallery-tile"][data-m-id^="pc_res_"]').first()).toHaveAttribute('data-state', 'ok')
    nothingPlainOverTheInternet(p)
    expect(errors()).toEqual([])
  })

  test('Bildgroesse: each model starts at its size, no size goes out unless set, SD 1.5 above 768 says so', async ({ page, context }) => {
    const note = 'SD 1.5 models are made for 512 x 512. Above 768 a picture takes much longer and often repeats parts of itself.'
    desk.create!.models.image = [
      { id: 'v1-5-pruned-emaonly-fp16.safetensors', name: 'SD 1.5', width: 512, height: 512, recommended_max: 768, note },
      { id: 'sdxl-base.safetensors', name: 'SDXL base', width: 1024, height: 1024 },
    ]
    const p = await phone(context, desk)
    await pair(page, desk)
    desk.sealed!.devices.get(p.sealed.deviceId)!.rights.add('create')
    await openCreateTab(page)
    await page.getByTestId('m-create-gate-computer').tap()
    const summary = page.getByTestId('m-create-computer-settings')
    await expect(summary).toHaveAttribute('aria-label', /SD 1\.5 · 512x512/)

    // Computer decides: the size is not sent, the computer takes the one of the family.
    await page.getByTestId('m-create-computer-prompt').fill('a lighthouse at dusk')
    await page.getByTestId('m-create-computer-generate').tap()
    await expect(page.getByTestId('m-create-computer-result')).toBeVisible({ timeout: 15_000 })
    expect(desk.create!.bodies[0]).toMatchObject({ kind: 'image', model: 'v1-5-pruned-emaonly-fp16.safetensors' })
    expect(desk.create!.bodies[0]).not.toHaveProperty('width')
    expect(desk.create!.bodies[0]).not.toHaveProperty('height')

    // Another model: its size, as long as the user set none.
    await page.getByTestId('m-create-computer-settings').tap()
    const sheet = page.getByTestId('m-create-computer-sheet')
    await sheet.getByTestId('m-create-computer-model-row').nth(1).tap()
    await expect(sheet.getByTestId('m-create-computer-width')).toHaveValue('1024')
    await sheet.getByTestId('m-create-computer-model-row').nth(0).tap()
    await expect(sheet.getByTestId('m-create-computer-width')).toHaveValue('512')
    await expect(sheet.getByTestId('m-create-computer-size-note')).toHaveCount(0)

    // Set by the user above 768: the sentence of the computer, in the sheet and on the stage; the size goes out.
    await sheet.getByTestId('m-create-computer-width').fill('1024')
    await expect(sheet.getByTestId('m-create-computer-size-note')).toHaveText(note)
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await page.screenshot({ path: test.info().outputPath('a17-size-note-sheet.png') })
    // The size set by the user stays when the model changes; SDXL has no sentence.
    await sheet.getByTestId('m-create-computer-model-row').nth(1).tap()
    await expect(sheet.getByTestId('m-create-computer-width')).toHaveValue('1024')
    await expect(sheet.getByTestId('m-create-computer-size-note')).toHaveCount(0)
    await sheet.getByTestId('m-create-computer-model-row').nth(0).tap()
    await page.getByTestId('m-sheet-close').tap()
    await expect(page.getByTestId('m-create-computer-composer').getByTestId('m-create-computer-size-note')).toHaveText(note)
    await page.screenshot({ path: test.info().outputPath('a17-size-note-stage.png') })
    await page.getByTestId('m-create-computer-generate').tap()
    await expect.poll(() => desk.create!.bodies.length, { timeout: 15_000 }).toBe(2)
    expect(desk.create!.bodies[1]).toMatchObject({ model: 'v1-5-pruned-emaonly-fp16.safetensors', width: 1024 })
    expect(desk.create!.bodies[1]).not.toHaveProperty('height')
  })

  test('cancel ends the job on the computer', async ({ page, context }) => {
    const p = await phone(context, desk)
    await pair(page, desk)
    desk.sealed!.devices.get(p.sealed.deviceId)!.rights.add('create')
    desk.create!.pollsToDone = 10_000
    await openCreateTab(page)
    await page.getByTestId('m-create-gate-computer').tap()
    await computerTool(page, 'video')
    await page.getByTestId('m-create-computer-prompt').fill('waves at night')
    await page.getByTestId('m-create-computer-generate').tap()
    await expect(page.getByTestId('m-create-computer-running')).toHaveAttribute('data-state', 'running', { timeout: 10_000 })
    await expect(page.getByTestId('m-create-computer-running-line')).toContainText('Sampling 12/30')
    await noPrice(page)
    await page.getByTestId('m-create-computer-cancel').tap()
    await expect(page.getByTestId('m-create-computer-generate')).toBeVisible()
    expect(desk.create!.cancels.length).toBe(1)
    expect(desk.create!.jobs[0].state).toBe('cancelled')
  })

  test('without Create for this phone there is no "My computer"; switched off later it is said honestly', async ({ page, context }) => {
    const p = await phone(context, desk)
    await pair(page, desk)
    await openCreateTab(page)
    await expect(page.getByTestId('m-create-gate')).toBeVisible()
    await expect(page.getByTestId('m-create-gate-computer')).toHaveCount(0)
    desk.sealed!.devices.get(p.sealed.deviceId)!.rights.add('create')
    await openCreateTab(page)
    await page.getByTestId('m-create-gate-computer').tap()
    await expect(page.getByTestId('m-create-computer-settings')).toBeVisible()
    // The switch goes off on the computer while the page is open.
    desk.create!.enabled = false
    await page.getByTestId('m-create-computer-prompt').fill('a fox')
    await page.getByTestId('m-create-computer-generate').tap()
    await expect(page.getByTestId('m-create-computer-error')).toContainText('Create is not allowed on your computer for this phone')
  })

  test('the App Store package has no "My computer", whatever the computer offers', async ({ page, context }) => {
    await phone(context, desk)
    await declareAdult(page)
    await openCreateTab(page, 'appstore')
    await expect(page.getByTestId('m-create-gate')).toBeVisible()
    await expect(page.getByTestId('m-create-gate-computer')).toHaveCount(0)
    await expect(page.getByTestId('m-create-source-computer')).toHaveCount(0)
    await expect(page.getByTestId('m-create-computer-stage')).toHaveCount(0)
  })
})

test.describe('Sign in with my computer', () => {
  test('off by default: no button', async ({ page, context }) => {
    const p = await phone(context, desk)
    await pair(page, desk)
    void p
    await openShell(page, { route: '/settings/account' })
    await expect(page.getByTestId('m-account-signin')).toBeVisible()
    await expect(page.getByTestId('m-account-computer-signin')).toHaveCount(0)
  })

  test('behind the switch: the computer asks, the phone redeems at lu-labs.ai, every refusal is named', async ({ page, context }) => {
    await phone(context, desk)
    const redeemed: string[] = []
    await context.route('https://lu-labs.ai/api/device-signin/redeem', async (route) => {
      redeemed.push(route.request().postData() ?? '')
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"invalid_code"}' })
    })
    await pair(page, desk)
    await page.goto(`${shellUrl({ route: '/settings/account' })}&computer-signin=on`)
    await page.getByTestId('m-app').waitFor()
    const button = page.getByTestId('m-account-computer-signin')
    await expect(button).toBeVisible()
    await expect(button).toContainText('Sign in with my computer')

    // The computer said no.
    desk.create!.signin = { status: 403, body: { error: 'signin_denied' } }
    await button.tap()
    await expect(page.getByTestId('m-account-computer-error')).toContainText('Sign in was not allowed on your computer.')
    expect(redeemed).toEqual([])

    // LU on the computer is signed out.
    desk.create!.signin = { status: 409, body: { error: 'desktop_signed_out', message: 'x' } }
    await button.tap()
    await expect(page.getByTestId('m-account-computer-error')).toContainText('LU on your computer is not signed in.')

    // The computer gave a code, lu-labs.ai refused it.
    desk.create!.signin = { status: 200, body: { code: 'Zx9_k-2mQpLr7TbWq1r2s3t4u5v6w7x8', expires: 1 } }
    await button.tap()
    await expect(page.getByTestId('m-account-computer-error')).toContainText('The sign in code is no longer valid.')
    expect(redeemed.length).toBe(1)
    expect(JSON.parse(redeemed[0])).toMatchObject({ code: 'Zx9_k-2mQpLr7TbWq1r2s3t4u5v6w7x8' })
    expect(Object.keys(JSON.parse(redeemed[0])).sort()).toEqual(['code', 'signature', 'time'])
    expect(desk.create!.signinAsks.length).toBe(3)
  })
})

/** A real 32 x 32 PNG (a photo for the file chooser), coloured by `seed`. */
function photo(seed: number): Buffer {
  const w = 32
  const raw = Buffer.alloc((w * 3 + 1) * w)
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) raw.set([(x * 8 + seed) & 255, (y * 8) & 255, seed & 255], y * (w * 3 + 1) + 1 + x * 3)
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(w, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

async function addPhotos(page: Page, testid: string, count: number): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId(testid).tap()
  await (await chooser).setFiles(Array.from({ length: count }, (_, i) => ({ name: `photo-${i + 1}.png`, mimeType: 'image/png', buffer: photo(i * 40) })))
}

test.describe('A17: the whole tool row on my computer', () => {
  test('a 3.0.8 computer: every tool, edit with references, music plays, a tool without model says why', async ({ page, context }) => {
    const errors = watchErrors(page)
    desk.create!.v2 = true
    desk.create!.unavailable.removebg = 'Cutting out needs the background model. Install it in Create on your computer.'
    const p = await phone(context, desk)
    await page.setViewportSize({ width: 412, height: 915 })
    await pair(page, desk)
    desk.sealed!.devices.get(p.sealed.deviceId)!.rights.add('create')
    await openCreateTab(page)
    await page.getByTestId('m-create-gate-computer').tap()
    // Prompt v2: the tool row is the group "What" in the settings sheet.
    await page.getByTestId('m-create-computer-settings').tap()
    for (const id of ['image', 'edit', 'removebg', 'upscale', 'video', 'character', 'music']) await expect(page.getByTestId(`m-create-computer-tool-${id}`)).toBeAttached()
    await page.getByTestId('m-sheet-close').tap()
    await noPrice(page)
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await page.screenshot({ path: test.info().outputPath('a17-computer-tools.png') })

    // Cutout: not available, the reason of the computer, Create stays off.
    await computerTool(page, 'removebg')
    await expect(page.getByTestId('m-create-computer-unavailable')).toContainText('Cutting out needs the background model.')
    await expect(page.getByTestId('m-create-computer-generate')).toBeDisabled()

    // Edit: three photos from the library, a prompt, the computer gets them in order.
    await computerTool(page, 'edit')
    await expect(page.getByTestId('m-create-computer-generate')).toBeDisabled()
    await addPhotos(page, 'm-create-computer-photo-add', 3)
    await expect(page.getByTestId('m-create-computer-photo')).toHaveCount(3)
    await expect(page.getByTestId('m-create-computer-paint')).toBeVisible()
    await page.getByTestId('m-create-computer-prompt').fill('make the sky purple')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await page.screenshot({ path: test.info().outputPath('a17-computer-edit.png') })
    await page.getByTestId('m-create-computer-generate').tap()
    await expect(page.getByTestId('m-create-computer-result')).toBeVisible({ timeout: 15_000 })
    const edit = desk.create!.bodies.find((b) => b.kind === 'edit')!
    expect((edit.input_ids as string[]).length).toBe(3)
    expect(edit.input_ids).toEqual(desk.create!.uploads.slice(0, 3).map((u) => u.id))
    expect(edit.mask_id).toBeUndefined()

    // Music: style, lyrics, a track that plays on the stage.
    await computerTool(page, 'music')
    await page.getByTestId('m-create-computer-prompt').fill('calm piano, slow')
    await page.getByTestId('m-create-computer-lyrics').fill('la la la')
    await page.getByTestId('m-create-computer-generate').tap()
    await expect(page.getByTestId('m-create-computer-result')).toHaveAttribute('data-m-kind', 'audio', { timeout: 15_000 })
    await expect(page.getByTestId('m-create-computer-result').locator('audio')).toBeVisible()
    expect(desk.create!.bodies.find((b) => b.kind === 'music')).toMatchObject({ prompt: 'calm piano, slow', lyrics: 'la la la' })

    // Character: the list of the computer, the pick goes with the job.
    await computerTool(page, 'character')
    await expect(page.getByTestId('m-create-computer-character')).toHaveText('Mia')
    await page.getByTestId('m-create-computer-prompt').fill('Mia at the beach')
    await page.getByTestId('m-create-computer-generate').tap()
    await expect(page.getByTestId('m-create-computer-result')).toHaveAttribute('data-m-kind', 'image', { timeout: 15_000 })
    expect(desk.create!.bodies.at(-1)).toMatchObject({ kind: 'image', character: 'chr_mia' })

    // Enhance: one photo, factor 4.
    await computerTool(page, 'upscale')
    await expect(page.getByTestId('m-create-computer-prompt')).toHaveCount(0)
    await expect(page.getByTestId('m-create-computer-photo')).toHaveCount(1)
    await page.getByRole('radio', { name: '4x' }).tap()
    await page.getByTestId('m-create-computer-generate').tap()
    await expect(page.getByTestId('m-create-computer-result')).toBeVisible({ timeout: 15_000 })
    const up = desk.create!.bodies.at(-1)!
    expect(up).toMatchObject({ kind: 'upscale', factor: 4 })
    expect(typeof up.input_id).toBe('string')
    await noPrice(page)
    nothingPlainOverTheInternet(p)
    expect(errors()).toEqual([])
  })

  test('the gallery of the computer: a tab next to the phone, previews, a tap brings the file and it plays', async ({ page, context }) => {
    const errors = watchErrors(page)
    desk.create!.v2 = true
    seedFakeGallery(desk.create!)
    const p = await phone(context, desk)
    await pair(page, desk)
    desk.sealed!.devices.get(p.sealed.deviceId)!.rights.add('create')
    await openCreateTab(page)
    await page.getByTestId('m-create-gate-computer').tap()
    await page.getByTestId('m-create-gallery').tap()
    await page.getByTestId('m-create-gallery-tab-computer').tap()
    await expect(page.getByTestId('m-create-computer-gallery-tile')).toHaveCount(2)
    const image = page.locator('[data-testid="m-create-computer-gallery-tile"][data-m-kind="image"]')
    await expect(image).toHaveAttribute('data-state', 'ok')
    await expect(image.locator('img')).toBeVisible()
    // The track: no preview, a tap brings it and the result view plays it.
    await page.locator('[data-testid="m-create-computer-gallery-tile"][data-m-kind="audio"] button').tap()
    await expect(page.locator('audio').first()).toBeAttached({ timeout: 15_000 })
    await page.goBack()
    // The picture: into the phone gallery as well.
    await page.getByTestId('m-create-gallery-tab-computer').tap()
    await image.locator('button').tap()
    await expect(page.locator('img').first()).toBeVisible()
    expect(desk.create!.galleryAsks.some((a) => a.endsWith('/file'))).toBe(true)
    nothingPlainOverTheInternet(p)
    expect(errors()).toEqual([])
  })

  test('a 3.0.7 computer keeps its two tools and no gallery tab', async ({ page, context }) => {
    const p = await phone(context, desk)
    await pair(page, desk)
    desk.sealed!.devices.get(p.sealed.deviceId)!.rights.add('create')
    await openCreateTab(page)
    await page.getByTestId('m-create-gate-computer').tap()
    await page.getByTestId('m-create-computer-settings').tap()
    await expect(page.getByTestId('m-create-computer-tools').getByRole('radio')).toHaveCount(2)
    await expect(page.getByTestId('m-create-computer-tool-image')).toBeVisible()
    await expect(page.getByTestId('m-create-computer-tool-video')).toBeVisible()
    await page.getByTestId('m-sheet-close').tap()
    await page.getByTestId('m-create-gallery').tap()
    await expect(page.getByTestId('m-create-gallery-tabs')).toHaveCount(0)
  })
})

test.describe('A17: Agent mode makes images on my computer', () => {
  test('image_generate runs on the computer, the image shows at the step and can be saved', async ({ page, context }) => {
    const errors = watchErrors(page)
    desk.create!.imageBytes = 2000
    desk.reply = 'Here is your fox.'
    const p = await phone(context, desk)
    await pair(page, desk)
    desk.sealed!.devices.get(p.sealed.deviceId)!.rights.add('create')
    // The right came after pairing: the status is read again when the chat opens anew.
    await page.evaluate(async () => {
      const { remote } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/screens/remote/parts/session.ts`)
      await remote().verifyConnection()
    })
    await page.getByTestId('m-remote-chat-options').tap()
    await expect(page.getByTestId('m-remote-options-agent')).toContainText('images, videos')
    await page.getByTestId('m-remote-options-agent').tap()
    await expect(page.getByTestId('m-remote-options-agent')).toHaveAttribute('aria-checked', 'true')
    await page.goBack()
    desk.nextToolCalls = [{ function: { name: 'image_generate', arguments: { prompt: 'a red fox' } } }]
    await page.getByTestId('m-remote-chat-input').fill('draw a fox')
    await page.getByTestId('m-remote-chat-send').tap()
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveAttribute('data-m-state', 'done', { timeout: 20_000 })
    const step = page.getByTestId('m-remote-chat-step')
    await expect(step).toHaveAttribute('data-m-tool', 'image_generate')
    await expect(step).toContainText('Make an image')
    await expect(page.getByTestId('m-remote-chat-step-media').locator('img')).toBeVisible()
    await expect(page.getByTestId('m-remote-chat-step-media-save')).toBeVisible()
    expect(desk.create!.bodies[0]).toMatchObject({ kind: 'image', prompt: 'a red fox' })
    // Never through agent-tool of the desktop.
    expect(desk.toolCalls).toEqual([])
    await page.screenshot({ path: test.info().outputPath('a17-agent-image.png') })
    nothingPlainOverTheInternet(p)
    expect(errors()).toEqual([])
  })
})

test.describe('A17: the painted area of an edit on my computer', () => {
  test('the mask editor of the cloud paints photo 1, the mask goes up as its own PNG', async ({ page, context }) => {
    const errors = watchErrors(page)
    desk.create!.v2 = true
    desk.create!.imageBytes = 2000
    const p = await phone(context, desk)
    await pair(page, desk)
    desk.sealed!.devices.get(p.sealed.deviceId)!.rights.add('create')
    await openCreateTab(page)
    await page.getByTestId('m-create-gate-computer').tap()
    await computerTool(page, 'edit')
    await addPhotos(page, 'm-create-computer-photo-add', 1)
    await page.getByTestId('m-create-computer-paint').tap()
    await expect(page.getByTestId('m-create-mask-screen')).toHaveAttribute('data-state', 'ready')
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="m-create-mask-canvas"]')
      if (!el) throw new Error('no mask canvas')
      const r = el.getBoundingClientRect()
      const send = (type: string, x: number) =>
        el.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: r.left + x * r.width, clientY: r.top + 0.5 * r.height }))
      send('pointerdown', 0.3)
      for (const x of [0.4, 0.5, 0.6]) send('pointermove', x)
      send('pointerup', 0.7)
    })
    await page.getByTestId('m-create-mask-done').tap()
    await expect(page.getByTestId('m-create-computer-mask-state')).toHaveText('Only the painted area of photo 1 changes.')
    await page.getByTestId('m-create-computer-prompt').fill('a hat')
    await page.getByTestId('m-create-computer-generate').tap()
    await expect(page.getByTestId('m-create-computer-result')).toBeVisible({ timeout: 15_000 })
    const body = desk.create!.bodies.find((b) => b.kind === 'edit')!
    expect(body.input_ids).toEqual([desk.create!.uploads[0].id])
    expect(body.mask_id).toBe(desk.create!.uploads[1].id)
    expect(desk.create!.uploads[1].mime).toBe('image/png')
    expect(errors()).toEqual([])
  })
})
