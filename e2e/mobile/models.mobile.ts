/* eslint-disable @typescript-eslint/no-explicit-any -- the stub below is
   serialized into the page and stands in for Tauri's untyped `invoke` bridge. */
/**
 * Strand 4 of the mobile shell: onboarding (A1 to A4), Models (M1 to M4),
 * the engine page (E13), the storage page (E14), the storage dialog (G9)
 * and the engine notices (G10). Runs in a browser with a mocked native side.
 *
 * The mock is a small phone: a model folder with files, free storage,
 * downloads that move a step with every poll, an engine that holds one
 * model. Its "disk" (installed files, partial files, free storage) lives in
 * localStorage, so a reload of the page is what a killed and restarted app
 * is: the running transfers are gone, the files are still there.
 *
 * Checked in two sizes (390x844 and 320x568). Every test ends with a look at
 * the layout (nothing sticks out, no target under 44 px) where it stops.
 *
 * Screenshots for mobile-docs/design/strang-shots/models are written with
 *   LU_MODELS_SHOTS=1 npx playwright test --project=mobile models
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { MOBILE_CHAT_MODELS } from '../../src/mobile/data/mobile-models'
import { SIZES, answerCloudProbe, declareAdult, measureLayout, screensLoaded, shellUrl, watchErrors, type OpenOptions } from './support'

const MIB = 1_048_576
const EMBED = 'nomic-embed-text-v1.5.Q4_K_M.gguf'
/** The smallest model of the phone catalogue. */
const SMALL = [...MOBILE_CHAT_MODELS].sort((a, b) => a.sizeBytes - b.sizeBytes)[0]

interface MockOptions {
  /** Free storage in bytes. Default 40 GB. */
  freeBytes?: number
  /** File names that are on the phone at the start, with their size. */
  installed?: Array<{ filename: string; bytes: number }>
  /** File name of the model the engine holds at the start. */
  loaded?: string
  /** Share of a file that arrives with every poll. Default 0.34. */
  step?: number
  /** Transfers stand still until `window.__M.hold = false`. */
  hold?: boolean
  /** The next transfer breaks once its share reaches `at`, with this message. */
  fail?: { at: number; error: string }
  /** The engine refuses to load, with this message. */
  loadError?: string
  /** Where the engine computes. */
  accelerator?: 'gpu' | 'cpu'
  /** The engine fell back to the processor by itself. */
  cpuOnly?: boolean
  /** Partial files of an earlier run. */
  partials?: Array<{ filename: string; bytes: number }>
  /** Answer of the Hugging Face search and the file trees of its hits. */
  search?: { hits: Array<{ id: string; downloads: number }>; trees: Record<string, Array<{ type: string; path: string; size: number }>> }
  /** Memory the phone reports, in GB. Default 8. */
  ramGb?: number
}

/** Runs inside the page, before the app. */
function installMock(opts: MockOptions): void {
  const w = window as any
  const DISK = 'e2e-models-disk'
  const GB = 1_073_741_824
  const dir = '/data/lu/models'
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(DISK) || 'null')
    } catch {
      return null
    }
  })()
  const disk: { free: number; files: Record<string, number>; partials: Record<string, number>; secrets: Record<string, string>; onboarding: boolean } = saved ?? {
    free: opts.freeBytes ?? 40 * GB,
    files: Object.fromEntries((opts.installed ?? []).map((f) => [f.filename, f.bytes])),
    partials: Object.fromEntries((opts.partials ?? []).map((f) => [f.filename, f.bytes])),
    secrets: {},
    onboarding: false,
  }
  const save = () => localStorage.setItem(DISK, JSON.stringify(disk))
  save()

  const rows: Record<string, { progress: number; total: number; speed: number; filename: string; status: string; error?: string; verified?: boolean }> = {}
  const M = {
    disk,
    rows,
    hold: !!opts.hold,
    step: opts.step ?? 0.34,
    fail: opts.fail ?? null,
    loadError: opts.loadError ?? null,
    accelerator: opts.accelerator ?? 'gpu',
    cpuOnly: !!opts.cpuOnly,
    tuningNote: null as string | null,
    /** How long a load takes in ms. 0 is the usual 150. */
    loadMs: 0,
    loaded: saved ? null : opts.loaded ? `${dir}/${opts.loaded}` : null,
    ctx: 4096,
    calls: [] as Array<{ cmd: string; args: any }>,
    opened: [] as string[],
  }
  w.__M = M
  // Off a phone (these tests keep the user agent of the test browser) the native bridge opens a link with
  // window.open. Recorded here, so no tab is opened and the test can read where the link led.
  w.open = (url?: string | URL) => {
    M.opened.push(String(url ?? ''))
    return null
  }

  const stemOf = (filename: string) => filename.replace(/\.[^.]+$/, '')
  const enc = (s: string) => Array.from(new TextEncoder().encode(s))
  const sse = (text: string) => {
    const frame = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'e2e', object: 'chat.completion.chunk', model: 'e2e', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    return [frame({ role: 'assistant' }, null), frame({ content: text.slice(0, 20) }, null), frame({ content: text.slice(20) }, null), frame({}, 'stop') + 'data: [DONE]\n\n']
  }
  const answerOf = (body: string): string => {
    if (/1 to 50/.test(body)) return Array.from({ length: 50 }, (_, i) => String(i + 1)).join('\n')
    if (/sheep/.test(body)) return 'All but 9 run away, so the farmer has 9 sheep left.'
    if (/fibonacci/.test(body)) return 'def fibonacci(n):\n    """Return the nth Fibonacci number."""\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a'
    return 'ready'
  }

  function tick(): void {
    for (const [id, row] of Object.entries(rows)) {
      if (row.status === 'pausing') {
        row.status = 'paused'
        continue
      }
      if (row.status === 'connecting') {
        row.status = 'downloading'
        continue
      }
      if (row.status !== 'downloading' || M.hold) continue
      if (row.progress >= row.total) {
        // The poll before showed the full bar ("Verifying"). Now the file is there.
        row.status = 'complete'
        disk.files[id] = row.total
        delete disk.partials[id]
        disk.free = Math.max(0, disk.free - row.total)
        save()
        continue
      }
      row.progress = Math.min(row.total, row.progress + Math.ceil(row.total * M.step))
      row.speed = Math.ceil(row.total * M.step)
      disk.partials[id] = row.progress
      if (M.fail && row.progress / row.total >= M.fail.at) {
        row.status = 'error'
        row.error = M.fail.error.replace('{file}', id)
        if (/checksum/.test(row.error)) {
          row.progress = 0
          delete disk.partials[id]
        }
        M.fail = null
      }
      save()
    }
  }

  function router(cmd: string, args: any): Promise<any> {
    M.calls.push({ cmd, args })
    switch (cmd) {
      case 'is_onboarding_done':
        return Promise.resolve(disk.onboarding)
      case 'set_onboarding_done':
        disk.onboarding = true
        save()
        return Promise.resolve(null)
      case 'device_info':
        return Promise.resolve({ platform: 'android', model: 'E2E Phone', ramTotalBytes: (opts.ramGb ?? 8) * GB, storageFreeBytes: disk.free, storageTotalBytes: 128 * GB })
      case 'detect_model_path':
        return Promise.resolve(dir)
      case 'check_download_space': {
        const need = Number(args?.requiredBytes) || 0
        return Promise.resolve({ fits: need <= disk.free, requiredBytes: need, reservedBytes: 0, availableBytes: disk.free })
      }
      case 'download_model_to_path': {
        const id: string = args?.filename
        if (disk.files[id]) return Promise.resolve({ status: 'exists', id })
        const live = rows[id]
        if (live && ['connecting', 'downloading', 'pausing'].includes(live.status)) return Promise.resolve({ status: 'already_running', id })
        rows[id] = { progress: disk.partials[id] ?? 0, total: Number(args?.expectedBytes) || 1_000_000, speed: 0, filename: id, status: 'connecting' }
        return Promise.resolve({ status: 'started', id })
      }
      case 'download_progress': {
        tick()
        return Promise.resolve(JSON.parse(JSON.stringify(rows)))
      }
      case 'pause_download':
        if (rows[args?.id]) rows[args.id].status = 'pausing'
        return Promise.resolve(null)
      case 'cancel_download':
        delete rows[args?.id]
        delete disk.partials[args?.id]
        save()
        return Promise.resolve(null)
      case 'clear_download_entry':
        delete rows[args?.id]
        return Promise.resolve(null)
      case 'resume_download':
        return Promise.reject('resume_download is for the image folders, not for a model file')
      case 'find_orphan_downloads': {
        const live = new Set(Object.keys(rows))
        return Promise.resolve(
          Object.entries(disk.partials)
            .filter(([id]) => !live.has(id))
            .map(([id, bytes]) => ({ stem: stemOf(id), path: `${dir}/${stemOf(id)}.download`, dir, bytes })),
        )
      }
      case 'delete_orphan_download': {
        for (const id of Object.keys(disk.partials)) {
          if (`${dir}/${stemOf(id)}.download` === args?.path) delete disk.partials[id]
        }
        save()
        return Promise.resolve(null)
      }
      case 'list_bundled_models':
        return Promise.resolve({
          dir,
          models: Object.entries(disk.files).map(([id, size]) => ({ name: id.replace(/\.gguf$/i, ''), path: `${dir}/${id}`, size, loaded: M.loaded === `${dir}/${id}`, ctx_train: 8192 })),
        })
      case 'start_bundled_engine':
      case 'swap_bundled_model': {
        if (M.loadError) return Promise.reject(M.loadError)
        M.loaded = args?.modelPath
        const ctx = Number(args?.tuning?.ctx) || 4096
        M.ctx = Math.min(ctx, 4096)
        // The phone engine answers with a note when it had to drop the chosen cache settings (ENGINE-NACHZUG.md section 5).
        // `loadMs` makes a load last, so a test can act while it runs.
        return new Promise((resolve) => setTimeout(() => resolve({ status: 'started', port: 8127, ...(M.tuningNote ? { tuningNote: M.tuningNote } : {}) }), Number(M.loadMs) || 150))
      }
      case 'stop_bundled_engine':
        M.loaded = null
        return Promise.resolve(null)
      case 'bundled_engine_status':
        return Promise.resolve({ running: !!M.loaded, healthy: !!M.loaded, port: 8127, model_path: M.loaded, ctx: M.loaded ? M.ctx : null, inProcess: true, accelerator: M.loaded ? M.accelerator : null, cpuOnly: M.cpuOnly, sanityNote: null })
      case 'delete_bundled_model': {
        const id = String(args?.path || '').split('/').pop() || ''
        const bytes = disk.files[id] ?? 0
        if (M.loaded === args?.path) return Promise.reject('The model is loaded.')
        delete disk.files[id]
        disk.free += bytes
        save()
        return Promise.resolve({ deleted: bytes ? 1 : 0, bytes })
      }
      case 'bundled_embed_status':
        return Promise.resolve({ running: false, healthy: false, port: 8128, model_path: null })
      case 'fetch_external': {
        const url: string = args?.url || ''
        if (url.includes('/api/models?search=')) return Promise.resolve(JSON.stringify(url.includes('nothing') ? [] : (opts.search?.hits ?? [])))
        for (const [repo, entries] of Object.entries(opts.search?.trees ?? {})) {
          if (url.includes(`/api/models/${repo}/tree/main`)) return Promise.resolve(JSON.stringify(entries))
        }
        return Promise.reject('HTTP 404')
      }
      case 'proxy_localhost_stream_chunked': {
        const channel = args?.onChunk
        const parts = sse(answerOf(String(args?.body ?? '')))
        parts.forEach((part, i) => setTimeout(() => channel?.onmessage?.(enc(part)), 30 + i * 30))
        setTimeout(() => channel?.onmessage?.([]), 30 + parts.length * 30)
        return Promise.resolve(null)
      }
      case 'proxy_localhost_stream':
        return Promise.resolve(enc(sse(answerOf(String(args?.body ?? ''))).join('')))
      case 'proxy_localhost':
        return Promise.reject('nothing listens there')
      case 'secret_set':
        disk.secrets[args?.account] = args?.secret ?? args?.value ?? ''
        save()
        return Promise.resolve(null)
      case 'secret_get':
        return Promise.resolve(disk.secrets[args?.account] ?? null)
      case 'secret_delete':
        delete disk.secrets[args?.account]
        save()
        return Promise.resolve(null)
      // The native bridge opens a link through its plugin on a phone, the contract command is the older way.
      case 'plugin:lu-native|open_external':
      case 'open_external_url':
        M.opened.push(args?.url)
        return Promise.resolve(null)
      default:
        if (cmd === 'plugin:event|listen') return Promise.resolve(args.handler)
        if (cmd === 'plugin:event|unlisten') return Promise.resolve(null)
        if (cmd.startsWith('plugin:')) return Promise.resolve(0)
        return Promise.resolve(null)
    }
  }

  let callbackId = 0
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(cb: (v: any) => void) {
      const id = ++callbackId
      w[`_${id}`] = cb
      return id
    },
    unregisterCallback(id: number) {
      delete w[`_${id}`]
    },
    convertFileSrc: (p: string) => p,
    invoke: (cmd: string, args: any) => router(cmd, args),
  }
  w.__TAURI__ = w.__TAURI_INTERNALS__
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_e: string, id: number) => w.__TAURI_INTERNALS__.unregisterCallback(id) }
}

/** What the mocked Hugging Face knows when a test does not say otherwise. */
const DEMO_SEARCH: NonNullable<MockOptions['search']> = {
  hits: [
    { id: 'e2e-lab/Tiny-1B-GGUF', downloads: 1200 },
    { id: 'e2e-lab/Large-30B-GGUF', downloads: 800 },
  ],
  trees: {
    'e2e-lab/Tiny-1B-GGUF': [
      { type: 'file', path: 'Tiny-1B-Q4_K_M.gguf', size: 700 * MIB },
      { type: 'file', path: 'Tiny-1B-Q8_0.gguf', size: 1228 * MIB },
      { type: 'file', path: 'Tiny-1B-F32.gguf', size: 30_000 * MIB },
    ],
    'e2e-lab/Large-30B-GGUF': [{ type: 'file', path: 'Large-30B-Q4_K_M.gguf', size: 18_000 * MIB }],
  },
}

interface StartOptions extends OpenOptions {
  mock?: MockOptions
  /** A pretended phone for the fit calculation, for example "android:4". */
  device?: string
}

/** Open the shell on the mocked phone. */
async function start(page: Page, options: StartOptions = {}): Promise<void> {
  await page.addInitScript(installMock, { search: DEMO_SEARCH, ...(options.mock ?? {}) })
  if (options.device) {
    await page.addInitScript((device) => {
      // A test may switch the phone between two starts ("e2e-device").
      localStorage.setItem('lu-mobile-device', localStorage.getItem('e2e-device') ?? device)
    }, options.device)
  }
  // The engine of the mocked phone has no HTTP face. What the logic layer asks it directly gets an empty answer.
  await page.route(/^http:\/\/(127\.0\.0\.1|localhost):81\d\d\//, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await answerCloudProbe(page)
  await page.goto(shellUrl(options))
  await page.getByTestId('m-app').waitFor()
  await screensLoaded(page)
}

/** The app was killed and is opened again: same disk, nothing in memory. */
async function restart(page: Page, options: OpenOptions = {}): Promise<void> {
  await page.goto(shellUrl(options))
  await page.getByTestId('m-app').waitFor()
  await screensLoaded(page)
}

/** Open a page of the running app, without loading it again (what is in memory stays). */
async function restartKeepingMemory(page: Page, route: '/settings/engine' | '/settings/engine/advanced'): Promise<void> {
  await page.evaluate(async (target) => {
    const spec = '/src/mobile/nav/index.ts'
    const mod = await import(/* @vite-ignore */ spec)
    mod.nav.push(target)
  }, route)
}

const mock = (page: Page) => ({
  set: (patch: Record<string, unknown>) => page.evaluate((p) => Object.assign((window as any).__M, p), patch),
  calls: (cmd: string) => page.evaluate((c) => (window as any).__M.calls.filter((x: any) => x.cmd === c), cmd),
  disk: () => page.evaluate(() => (window as any).__M.disk as { free: number; files: Record<string, number>; partials: Record<string, number>; onboarding: boolean }),
  loaded: () => page.evaluate(() => (window as any).__M.loaded as string | null),
})

const CLEAN = { overflow: [], small: [], pageScrolls: false }

/**
 * The layout report of support.ts, taken a moment after the last tap: the
 * browser keeps a tapped button in its pressed state (slightly smaller) for
 * a few hundred milliseconds, and a button measured in that moment reads as
 * 43 px.
 */
async function layoutOf(page: Page): Promise<unknown> {
  await page.waitForTimeout(400)
  return measureLayout(page)
}
/** The element with this test id on the page that is on top. The page below stays mounted and hidden, with the same ids. */
// A page that was just left slides out for a moment (the scaffold animates it); it is not what is on screen any more.
const at = (page: Page, testid: string) => page.locator(`[data-testid="${testid}"]:visible:not(.m-page[data-m-exit] *)`)

/** Catalogue id of the card the onboarding proposes. */
async function proposalId(page: Page): Promise<string | null> {
  const card = at(page, 'm-onboarding-model-card').filter({ has: page.locator('[data-testid="m-onboarding-model-recommended"]') })
  await expect(card).toHaveCount(1)
  return card.getAttribute('data-m-id')
}

/** Sign in to LU Cloud the way a finished sign in leaves the store. */
async function signIn(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const spec = '/src/stores/cloudAuthStore.ts'
    const mod = await import(/* @vite-ignore */ spec)
    mod.useCloudAuthStore.getState().setSignedIn({ id: 'e2e-user', email: 'e2e@example.com' }, { licenseActive: false, tier: null, access: true, quota: null })
  })
}

async function openModels(page: Page): Promise<void> {
  // A start lands in a new chat (a pushed page without the tab bar). The tab Models keeps the pages it had
  // (round 57), so the way to its root goes back through them as well.
  await expect(at(page, 'm-page-back').or(at(page, 'm-nav'))).toBeVisible()
  while ((await at(page, 'm-nav').count()) === 0) await at(page, 'm-page-back').tap()
  await at(page, 'm-nav-models').tap()
  await expect(at(page, 'm-page-back').or(at(page, 'm-nav'))).toBeVisible()
  while ((await at(page, 'm-nav').count()) === 0) await at(page, 'm-page-back').tap()
  if ((await at(page, 'm-models-segment-new').getAttribute('aria-checked')) !== 'true') await at(page, 'm-models-segment-new').tap()
  await expect(at(page, 'm-models-screen')).toBeVisible()
  await expect(at(page, 'm-models-catalog')).toBeVisible()
}

test.describe('a fresh install, no developer switch', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    // What makes the app take the phone shell on a phone: the device itself, not a query.
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  })
  test.setTimeout(120_000)

  test('from the first screen through the onboarding to the first answer in a chat', async ({ page }) => {
    const errors = watchErrors(page)
    await page.addInitScript(installMock, { search: DEMO_SEARCH, step: 0.5 })
    await page.route(/^http:\/\/(127\.0\.0\.1|localhost):81\d\d\//, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
    await answerCloudProbe(page)
    // The plain address: no ?mobile, no ?dev, no ?onboarding, no ?route, no pretended device.
    await page.goto('/')
    await page.getByTestId('m-app').waitFor()
    await screensLoaded(page)
    expect(new URL(page.url()).search).toBe('')

    // A1: the welcome, with a way on. Never a page without one.
    await expect(at(page, 'm-onboarding-screen')).toBeVisible()
    await expect(at(page, 'm-nav')).toHaveCount(0)
    await at(page, 'm-onboarding-next').tap()

    // A2: the proposal for this phone, downloaded to the end.
    await expect(at(page, 'm-onboarding-model-screen')).toBeVisible()
    await expect(at(page, 'm-onboarding-model-recommended')).toHaveAttribute('aria-checked', 'true')
    await at(page, 'm-onboarding-download').tap()
    await expect(at(page, 'm-onboarding-model-ready')).toBeVisible({ timeout: 30_000 })
    await at(page, 'm-onboarding-next').tap()

    // A3: the document model can wait.
    await expect(at(page, 'm-onboarding-documents-screen')).toBeVisible()
    await at(page, 'm-onboarding-skip').tap()

    // A4, then the first chat.
    await expect(at(page, 'm-onboarding-done-screen')).toBeVisible()
    await expect(at(page, 'm-onboarding-done-status')).toHaveAttribute('data-state', 'ready')
    await at(page, 'm-onboarding-done').tap()
    await expect(at(page, 'm-chat-screen')).toBeVisible()
    expect((await mock(page).disk()).onboarding).toBe(true)

    // The downloaded model is the model of the chat, and it answers.
    await expect(at(page, 'm-chat-model')).not.toContainText('Choose a model')
    await at(page, 'm-chat-input').fill('Are you there?')
    await at(page, 'm-chat-send').tap()
    await expect(page.locator('[data-testid="m-chat-message"][data-m-role="assistant"]').last()).toContainText('ready', { timeout: 30_000 })
    expect(await layoutOf(page)).toEqual(CLEAN)

    // Round 12, F12: on a fresh install the phone does not learn from chats until the user turns it on.
    await at(page, 'm-page-back').tap()
    await at(page, 'm-nav-settings').tap()
    await at(page, 'm-settings-memory').tap()
    await expect(at(page, 'm-memory-learn')).toHaveAttribute('aria-checked', 'false')
    await expect(at(page, 'm-memory-learn')).toContainText('After an answer LU asks the model once more what is worth keeping')
    await expect(at(page, 'm-memory-outside')).toBeDisabled()
    // Check 4 on Android, F1: with the switch off there is no word about a model, with it on the page says which one learns.
    await expect(at(page, 'm-memory-learn-with')).toHaveCount(0)
    await at(page, 'm-memory-learn').tap()
    await expect(at(page, 'm-memory-learn')).toHaveAttribute('aria-checked', 'true')
    await expect(at(page, 'm-memory-learn-with')).toContainText('Learning is done by the chat model on this phone, now ')
    await expect(at(page, 'm-memory-learn-with')).toContainText('A small model misses things.')
    await expect(at(page, 'm-memory-learn-with')).toContainText('is kept either way')
    expect(await layoutOf(page)).toEqual(CLEAN)
    expect(errors()).toEqual([])
  })
})

for (const size of SIZES) {
  test.describe(`models and onboarding ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } })
    test.setTimeout(90_000)

    test('onboarding: the last step does not say all set while the starter model still downloads', async ({ page }) => {
      const errors = watchErrors(page)
      await start(page, { skipOnboarding: false, device: 'android:8', mock: { hold: true } })
      await at(page, 'm-onboarding-next').tap()
      await at(page, 'm-onboarding-download').tap()
      await expect(at(page, 'm-onboarding-progress')).toBeVisible()
      await mock(page).set({ hold: false, step: 0.1 })
      await expect(at(page, 'm-onboarding-progress').getByRole('progressbar')).not.toHaveAttribute('aria-valuenow', '0')
      await mock(page).set({ hold: true })
      // On through the steps while it loads.
      await at(page, 'm-onboarding-next').tap()
      await at(page, 'm-onboarding-skip').tap()
      const done = at(page, 'm-onboarding-done-screen')
      await expect(done).toBeVisible()
      const status = at(page, 'm-onboarding-done-status')
      await expect(status).toHaveAttribute('data-state', 'downloading')
      await expect(done.locator('.m-hdr-title')).toHaveText('Almost ready')
      await expect(status).toContainText('is still downloading')
      // The download itself is on the page, with its bar and its buttons.
      const bar = at(page, 'm-onboarding-done-progress')
      await expect(bar).toBeVisible()
      expect(Number(await bar.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(0)
      expect(Number(await status.getAttribute('data-m-percent'))).toBeGreaterThan(0)
      await expect(at(page, 'm-onboarding-done-models')).toBeVisible()
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-onboarding-done-pause').tap()
      await expect(status).toHaveAttribute('data-state', 'paused')
      await expect(status).toContainText('is paused. Resume it here')
      await at(page, 'm-onboarding-done-resume').tap()
      // It finishes while the page is open: now it is all set.
      await mock(page).set({ hold: false, step: 0.5 })
      await expect(status).toHaveAttribute('data-state', 'ready', { timeout: 20_000 })
      await expect(done.locator('.m-hdr-title')).toHaveText("You're all set")
      await expect(at(page, 'm-onboarding-done-download')).toHaveCount(0)
      await expect(at(page, 'm-onboarding-done-models')).toHaveCount(0)
      expect(errors()).toEqual([])
    })

    test('onboarding: recommendation, download with pause, resume and cancel, document model, done, never again', async ({ page }) => {
      const errors = watchErrors(page)
      await start(page, { skipOnboarding: false, device: 'android:8', mock: { hold: true } })

      // A1
      await expect(at(page, 'm-onboarding-screen')).toBeVisible()
      await expect(at(page, 'm-nav')).toHaveCount(0)
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-onboarding-next').tap()

      // A2: the proposal for this phone is chosen and the button names its size.
      await expect(at(page, 'm-onboarding-model-screen')).toBeVisible()
      const proposal = at(page, 'm-onboarding-model-recommended')
      await expect(proposal).toBeVisible()
      await expect(proposal).toHaveAttribute('aria-checked', 'true')
      await expect(at(page, 'm-onboarding-model-device')).toContainText('8 GB memory')
      const download = at(page, 'm-onboarding-download')
      await expect(download).toContainText(/Download \d/)
      expect(await layoutOf(page)).toEqual(CLEAN)

      // Another card can be chosen, and the other kind shows another list.
      await at(page, 'm-onboarding-model-segment-unfiltered').tap()
      await expect(at(page, 'm-onboarding-model-recommended')).toHaveAttribute('aria-checked', 'true')
      await at(page, 'm-onboarding-model-segment-mainstream').tap()
      const other = at(page, 'm-onboarding-model-item').first()
      await other.tap()
      await expect(other).toHaveAttribute('aria-checked', 'true')
      await expect(proposal).toHaveAttribute('aria-checked', 'false')
      await proposal.tap()
      await expect(proposal).toHaveAttribute('aria-checked', 'true')

      // Download: progress, pause, resume.
      await download.tap()
      const progress = at(page, 'm-onboarding-progress')
      await expect(progress).toBeVisible()
      await expect(at(page, 'm-onboarding-transfer')).toHaveAttribute('data-state', /waiting|running/)
      await mock(page).set({ hold: false, step: 0.1 })
      await expect(at(page, 'm-onboarding-transfer')).toHaveAttribute('data-state', 'running')
      await expect(progress.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow', '0')
      await at(page, 'm-onboarding-pause').tap()
      await expect(at(page, 'm-onboarding-transfer')).toHaveAttribute('data-state', 'paused')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-onboarding-resume').tap()
      await expect(at(page, 'm-onboarding-transfer')).toHaveAttribute('data-state', /waiting|running/)

      // Cancel stands next to Pause and removes what was downloaded: it asks first, and "Keep downloading" changes nothing.
      await at(page, 'm-onboarding-cancel').tap()
      await expect(at(page, 'm-dialog-download-cancel')).toContainText('Cancel the download of')
      await expect(at(page, 'm-dialog-download-cancel')).toContainText('downloaded so far are removed')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-dialog-cancel').tap()
      await expect(at(page, 'm-onboarding-transfer')).toHaveAttribute('data-state', /waiting|running/)
      expect(Object.keys((await mock(page).disk()).partials)).not.toEqual([])
      // Confirmed: no error, the card can be chosen again, the partial file is gone.
      await at(page, 'm-onboarding-cancel').tap()
      await at(page, 'm-dialog-confirm').tap()
      await expect(at(page, 'm-toast-download-cancelled')).toBeVisible()
      await expect(at(page, 'm-onboarding-download')).toBeVisible()
      await expect(at(page, 'm-onboarding-error')).toHaveCount(0)
      expect(Object.keys((await mock(page).disk()).partials)).toEqual([])

      // Download again and let it finish.
      await mock(page).set({ step: 0.5 })
      await at(page, 'm-onboarding-download').tap()
      await expect(at(page, 'm-onboarding-model-ready')).toBeVisible({ timeout: 20_000 })
      await at(page, 'm-onboarding-next').tap()

      // A3: the document model.
      await expect(at(page, 'm-onboarding-documents-screen')).toBeVisible()
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-onboarding-documents-install').tap()
      await expect(at(page, 'm-onboarding-documents-ready')).toHaveText('Document Chat is ready.', { timeout: 20_000 })
      expect(Object.keys((await mock(page).disk()).files)).toContain(EMBED)
      await at(page, 'm-onboarding-next').tap()

      // A4
      await expect(at(page, 'm-onboarding-done-screen')).toBeVisible()
      await expect(at(page, 'm-onboarding-done-status')).toHaveAttribute('data-state', 'ready')
      await expect(at(page, 'm-onboarding-done-status')).toContainText('is ready.')
      await expect(at(page, 'm-onboarding-done-models')).toHaveCount(0)
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-onboarding-done').tap()
      await expect(at(page, 'm-chat-screen')).toBeVisible()
      expect((await mock(page).disk()).onboarding).toBe(true)

      // Never again, also after a restart.
      await restart(page, { skipOnboarding: false })
      await expect(at(page, 'm-chat-screen')).toBeVisible()
      await expect(at(page, 'm-onboarding-screen')).toHaveCount(0)
      expect(errors()).toEqual([])
    })

    test('onboarding: small and large phone get another proposal, too large is locked, skip leads through', async ({ page }) => {
      const errors = watchErrors(page)
      await start(page, { skipOnboarding: false, device: 'android:4' })
      await at(page, 'm-onboarding-next').tap()
      await expect(at(page, 'm-onboarding-model-device')).toContainText('4 GB memory')
      const small = await proposalId(page)

      // Too large: visible, not selectable, says why.
      const locked = at(page, 'm-onboarding-model-item-toolarge').first()
      await locked.scrollIntoViewIfNeeded()
      await expect(locked).toHaveAttribute('aria-disabled', 'true')
      await expect(at(page, 'm-onboarding-model-toolarge-hint').first()).toContainText('Needs about')
      // The card is a disabled radio for assistive technology and still answers a tap with the reason.
      await locked.tap({ force: true })
      await expect(at(page, 'm-toast-too-large')).toContainText('Too large. It needs about')
      await expect(locked).toHaveAttribute('aria-checked', 'false')
      await expect(at(page, 'm-onboarding-model-recommended')).toHaveAttribute('aria-checked', 'true')
      expect(await layoutOf(page)).toEqual(CLEAN)

      // The same step on a 12 GB phone proposes a larger model and locks fewer.
      const lockedSmall = await at(page, 'm-onboarding-model-item-toolarge').count()
      await page.evaluate(() => localStorage.setItem('e2e-device', 'android:12'))
      await restart(page, { skipOnboarding: false })
      if (await at(page, 'm-onboarding-screen').count()) await at(page, 'm-onboarding-next').tap()
      await expect(at(page, 'm-onboarding-model-device')).toContainText('12 GB memory')
      const large = await proposalId(page)
      expect(large).not.toBe(small)
      expect(await at(page, 'm-onboarding-model-item-toolarge').count()).toBeLessThan(lockedSmall)

      // Skip: no model, document step skipped, the last step offers Models.
      await at(page, 'm-onboarding-skip').tap()
      await expect(at(page, 'm-onboarding-documents-screen')).toBeVisible()
      await at(page, 'm-onboarding-skip').tap()
      await expect(at(page, 'm-onboarding-done-status')).toHaveAttribute('data-state', 'none')
      await expect(at(page, 'm-onboarding-done-status')).toContainText('No model yet. Install one in Models.')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-onboarding-done-models').tap()
      await expect(at(page, 'm-models-screen')).toBeVisible()
      await expect(at(page, 'm-nav')).toBeVisible()
      expect((await mock(page).disk()).onboarding).toBe(true)
      expect((await mock(page).calls('download_model_to_path')).length).toBe(0)

      await restart(page, { skipOnboarding: false })
      await expect(at(page, 'm-onboarding-screen')).toHaveCount(0)
      await expect(at(page, 'm-onboarding-model-screen')).toHaveCount(0)
      expect(errors()).toEqual([])
    })

    test('onboarding: Cloud only after signing in', async ({ page }) => {
      const errors = watchErrors(page)
      await start(page, { skipOnboarding: false, device: 'android:8' })
      await expect(at(page, 'm-onboarding-account')).toHaveText('I have an LU Cloud account')
      await at(page, 'm-onboarding-account').tap()
      // The account page (strand 5) opens as a page of the flow.
      await expect(at(page, 'm-onboarding-screen')).toHaveCount(0)
      await signIn(page)
      // Signed in: the flow moves on to the model step, which now offers the Cloud only way out.
      await expect(at(page, 'm-onboarding-model-screen')).toBeVisible()
      await expect(at(page, 'm-onboarding-skip')).toHaveText('Skip, use Cloud only')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-page-back').tap()
      await expect(at(page, 'm-onboarding-account')).toContainText('Signed in as e2e@example.com')
      await at(page, 'm-onboarding-account').tap()
      await at(page, 'm-onboarding-skip').tap()
      await expect(at(page, 'm-toast-cloud-only')).toBeVisible()
      await at(page, 'm-onboarding-skip').tap()
      await expect(at(page, 'm-onboarding-done-status')).toHaveAttribute('data-state', 'cloud')
      await expect(at(page, 'm-onboarding-done-status')).toContainText('LU Cloud is ready.')
      await at(page, 'm-onboarding-done').tap()
      await expect(at(page, 'm-chat-screen')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('catalogue: a 4 GB phone locks what a 12 GB phone offers, with the reason', async ({ page }) => {
      const errors = watchErrors(page)
      await start(page, { device: 'android:4' })
      await openModels(page)
      await expect(at(page, 'm-models-device')).toContainText('4 GB memory')
      await expect(at(page, 'm-models-small-note')).toBeVisible()

      // "Fits this phone" is on: nothing that is too large.
      await expect(at(page, 'm-models-filter-fits')).toHaveAttribute('aria-pressed', 'true')
      await expect(at(page, 'm-models-item-toolarge')).toHaveCount(0)
      const fitting = await at(page, 'm-models-item').count()
      expect(fitting).toBeGreaterThan(0)
      expect(await layoutOf(page)).toEqual(CLEAN)

      // Off: the too large ones are shown, locked, with the reason and no download.
      await at(page, 'm-models-filter-fits').tap()
      const locked = at(page, 'm-models-item-toolarge')
      await expect(locked.first()).toBeVisible()
      await expect(locked.first().getByTestId('m-models-item-fit')).toHaveText('Too large for this phone')
      await expect(locked.first().getByTestId('m-models-toolarge-hint')).toContainText('Needs about')
      await expect(locked.first().getByTestId('m-models-download')).toHaveCount(0)
      const lockedIds = await locked.evaluateAll((els) => els.map((el) => el.getAttribute('data-m-id')))
      await locked.first().scrollIntoViewIfNeeded()
      expect(await layoutOf(page)).toEqual(CLEAN)

      // The card leads to the explanation in whole sentences (5.3).
      await locked.first().getByTestId('m-models-item-open').tap()
      await expect(at(page, 'm-models-detail-screen')).toBeVisible()
      await expect(at(page, 'm-models-detail-fit')).toHaveText('Too large for this phone')
      await expect(at(page, 'm-models-detail-fit-text')).toContainText('LU will not download it')
      await expect(at(page, 'm-models-detail-download')).toHaveCount(0)
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-models-detail-cloud').tap()
      await expect(at(page, 'm-cloud-screen')).toBeVisible()
      await at(page, 'm-page-back').tap()
      await at(page, 'm-models-detail-smaller').tap()
      await expect(at(page, 'm-models-screen')).toBeVisible()
      await expect(at(page, 'm-models-filter-fits')).toHaveAttribute('aria-pressed', 'true')
      await expect(at(page, 'm-models-item-toolarge')).toHaveCount(0)
      // Sent here with a view set, the page starts at its top, not at the locked card far down where it was left.
      await expect.poll(() => at(page, 'm-models-screen').locator('.m-body').evaluate((el) => el.scrollTop)).toBe(0)
      await expect(at(page, 'm-models-segment')).toBeInViewport()

      // Other filters.
      await at(page, 'm-models-filter-unfiltered').tap()
      await expect(at(page, 'm-models-item').first()).toContainText('No Filter')
      await at(page, 'm-models-filter-unfiltered').tap()
      await at(page, 'm-models-filter-mainstream').tap()
      await expect(at(page, 'm-models-item').first()).toBeVisible()
      await at(page, 'm-models-filter-mainstream').tap()
      // No catalogue model reads images on the phone, so there is no filter that could only come up empty (M4).
      await expect(at(page, 'm-models-filter-vision')).toHaveCount(0)
      await expect(page.locator('[data-testid="m-models-catalog"]')).not.toContainText('Vision')
      await at(page, 'm-models-filter-fits').tap()
      // Models that did not answer a plain question say so and stand last (M5).
      const order = await at(page, 'm-models-item').or(at(page, 'm-models-item-toolarge')).evaluateAll((cards) => cards.map((card) => ({ id: card.getAttribute('data-m-id'), weak: !!card.querySelector('[data-testid="m-models-item-weak"]') })))
      const weak = order.filter((card) => card.weak).map((card) => card.id)
      expect([...weak].sort()).toEqual(['gemma-3-1b-abliterated', 'qwen2.5-1.5b-abliterated', 'smollm2-360m'])
      expect(order.slice(-3).every((card) => card.weak)).toBe(true)
      await expect(at(page, 'm-models-item-weak').first()).toHaveText('Did not answer a plain request in our test.')
      await expect(at(page, 'm-models-item-toolarge').first()).toBeVisible()

      // The same catalogue on a 12 GB phone.
      await page.evaluate(() => localStorage.setItem('e2e-device', 'android:12'))
      await restart(page)
      await openModels(page)
      await expect(at(page, 'm-models-device')).toContainText('12 GB memory')
      expect(await at(page, 'm-models-item').count()).toBeGreaterThan(fitting)
      await at(page, 'm-models-filter-fits').tap()
      const openIds = await at(page, 'm-models-item').evaluateAll((els) => els.map((el) => el.getAttribute('data-m-id')))
      const unlocked = lockedIds.filter((id) => openIds.includes(id))
      expect(unlocked.length).toBeGreaterThan(0)
      const freed = page.locator(`[data-testid="m-models-item"][data-m-id="${unlocked[0]}"]:visible`)
      await expect(freed.getByTestId('m-models-download')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('install with pause, resume and cancel, load, make it the chat model, delete the loaded model', async ({ page }) => {
      const errors = watchErrors(page)
      await start(page, { device: 'android:8', mock: { hold: true } })
      await openModels(page)
      const id = await at(page, 'm-models-item').first().getAttribute('data-m-id')
      const card = page.locator(`[data-m-id="${id}"]:visible`).and(page.locator('[data-testid="m-models-item"]'))
      await expect(card).toHaveAttribute('data-state', 'available')

      await card.getByTestId('m-models-download').tap()
      await expect(card.getByTestId('m-models-progress')).toBeVisible()
      await expect(at(page, 'm-models-downloads')).toHaveAccessibleName('Downloads, 1 active')
      await expect(at(page, 'm-nav-models')).toHaveAccessibleName(/1 download running/)
      await mock(page).set({ hold: false, step: 0.1 })
      await expect(card).toHaveAttribute('data-state', 'running')
      await card.getByTestId('m-models-pause').tap()
      await expect(card).toHaveAttribute('data-state', 'paused')
      await expect(card.getByTestId('m-models-progress')).toContainText('Paused')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await card.getByTestId('m-models-resume').tap()
      await expect(card).toHaveAttribute('data-state', /waiting|running/)
      await card.getByTestId('m-models-cancel').tap()
      await at(page, 'm-dialog-confirm').tap()
      await expect(at(page, 'm-toast-download-cancelled')).toHaveText('Download cancelled')
      await expect(card).toHaveAttribute('data-state', 'available')
      await expect(at(page, 'm-models-error')).toHaveCount(0)
      expect(Object.keys((await mock(page).disk()).partials)).toEqual([])

      await mock(page).set({ step: 0.5 })
      await card.getByTestId('m-models-download').tap()
      await expect(at(page, 'm-toast-installed')).toContainText('installed', { timeout: 20_000 })
      await expect(card).toHaveAttribute('data-state', 'installed')
      await expect(card.getByTestId('m-models-item-installed')).toBeVisible()

      // Installed view: the storage card and the model.
      await at(page, 'm-models-segment-installed').tap()
      await expect(at(page, 'm-models-installed')).toBeVisible()
      await expect(at(page, 'm-models-storage')).toContainText('used')
      expect(await layoutOf(page)).toEqual(CLEAN)

      // Load, unload, load.
      await card.getByTestId('m-models-load').tap()
      await expect(at(page, 'm-toast-loaded')).toContainText('is loaded')
      await expect(card).toHaveAttribute('data-state', 'loaded')
      expect(await mock(page).loaded()).toContain('.gguf')
      await card.getByTestId('m-models-unload').tap()
      await expect(at(page, 'm-toast-unloaded')).toBeVisible()
      await expect(card).toHaveAttribute('data-state', 'installed')
      expect(await mock(page).loaded()).toBeNull()

      // Chat model: set, said, marked. It is loaded with it.
      await card.getByTestId('m-models-use').tap()
      await expect(at(page, 'm-toast-chat-model')).toContainText('is now the chat model')
      await expect(card).toContainText('Chat model')
      await expect(card.getByTestId('m-models-use')).toHaveCount(0)
      await expect(card).toHaveAttribute('data-state', 'loaded')
      expect(await layoutOf(page)).toEqual(CLEAN)

      // Detail page of the installed, loaded model.
      await card.getByTestId('m-models-item-open').tap()
      await expect(at(page, 'm-models-detail-screen')).toBeVisible()
      await expect(at(page, 'm-models-detail-is-chat')).toBeVisible()
      await expect(at(page, 'm-models-detail-context')).toContainText('4K on this phone')
      await expect(at(page, 'm-models-detail-checksum')).toContainText('Verified')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-models-detail-hf').tap()
      expect((await page.evaluate(() => (window as any).__M.opened as string[]))[0]).toMatch(/^https:\/\/huggingface\.co\//)
      await at(page, 'm-models-detail-unload').tap()
      await expect(at(page, 'm-toast-unloaded')).toBeVisible()
      await expect(at(page, 'm-models-detail-verdict')).toHaveAttribute('data-state', 'installed')
      await at(page, 'm-models-detail-load').tap()
      await expect(at(page, 'm-toast-loaded')).toBeVisible()
      await expect(at(page, 'm-models-detail-verdict')).toHaveAttribute('data-state', 'loaded')

      // Delete the loaded model: asked first, "Keep" keeps it.
      await at(page, 'm-models-detail-delete').scrollIntoViewIfNeeded()
      await at(page, 'm-models-detail-delete').tap()
      await expect(at(page, 'm-dialog-delete-model')).toContainText('This model is loaded right now.')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-dialog-cancel').tap()
      expect(Object.keys((await mock(page).disk()).files).length).toBe(1)
      await at(page, 'm-models-detail-delete').tap()
      await at(page, 'm-dialog-confirm').tap()
      await expect(at(page, 'm-toast-deleted')).toContainText('Freed')
      expect(Object.keys((await mock(page).disk()).files)).toEqual([])
      expect(await mock(page).loaded()).toBeNull()
      await expect(at(page, 'm-models-detail-download')).toBeVisible()
      await at(page, 'm-page-back').tap()
      await expect(at(page, 'm-models-empty')).toBeVisible()
      await at(page, 'm-models-empty-getnew').tap()
      await expect(at(page, 'm-models-catalog')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('storage full: before the download the dialog, during the download the kept part', async ({ page }) => {
      const errors = watchErrors(page)
      await start(page, { device: 'android:8', mock: { freeBytes: 200 * MIB } })
      await openModels(page)
      await at(page, 'm-models-download').first().tap()
      const dialog = at(page, 'm-dialog-storage-full')
      await expect(dialog).toContainText('Not enough storage')
      await expect(dialog).toContainText('This phone has 200.0 MB free.')
      await expect(dialog).toContainText('Free up')
      expect(await layoutOf(page)).toEqual(CLEAN)
      expect((await mock(page).calls('download_model_to_path')).length).toBe(0)
      await at(page, 'm-dialog-cancel').tap()
      await expect(at(page, 'm-models-catalog')).toBeVisible()
      await at(page, 'm-models-download').first().tap()
      await at(page, 'm-dialog-confirm').tap()
      // "Manage installed models" leads to the Installed view.
      await expect(at(page, 'm-models-segment-installed')).toHaveAttribute('aria-checked', 'true')
      await expect(at(page, 'm-models-empty')).toBeVisible()

      // Storage runs out while the file arrives.
      await page.evaluate(() => {
        const M = (window as any).__M
        M.disk.free = 40 * 1_073_741_824
        M.step = 0.3
        M.fail = { at: 0.5, error: 'Not enough free space for {file}. It still needs 1.4 GB and the drive has 0.0 GB free' }
      })
      await at(page, 'm-models-segment-new').tap()
      const id = await at(page, 'm-models-item').first().getAttribute('data-m-id')
      const card = page.locator(`[data-m-id="${id}"]:visible`).and(page.locator('[data-testid="m-models-item"]'))
      await card.getByTestId('m-models-download').tap()
      // Said at once in a dialog, wherever the user is: where it stopped, that the part is kept, the way to make room.
      const ranOut = at(page, 'm-dialog-storage-ran-out')
      await expect(ranOut).toContainText('Storage ran out', { timeout: 15_000 })
      await expect(ranOut).toContainText('What arrived is kept.')
      await expect(ranOut).toContainText('Free up 1.4 GB, then resume the download.')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-dialog-confirm').tap()
      await expect(at(page, 'm-settings-storage-screen')).toBeVisible()
      await at(page, 'm-page-back').tap()
      const box = card.getByTestId('m-models-error')
      await expect(box).toContainText('Storage ran out at')
      await expect(box).toContainText('Free up 1.4 GB to continue.')
      await expect(card).toHaveAttribute('data-state', 'storage')
      await box.scrollIntoViewIfNeeded()
      expect(await layoutOf(page)).toEqual(CLEAN)
      expect(Object.keys((await mock(page).disk()).partials).length).toBe(1)
      await card.getByTestId('m-models-error-storage').tap()
      await expect(at(page, 'm-settings-storage-screen')).toBeVisible()
      await at(page, 'm-page-back').tap()
      // Still no room: Resume asks first and does not start a transfer that would fail the same way.
      const before = (await mock(page).calls('download_model_to_path')).length
      await page.evaluate(() => {
        ;(window as any).__M.disk.free = 100 * 1_048_576
      })
      await card.getByTestId('m-models-resume').tap()
      await expect(dialog).toContainText('The rest of')
      await expect(dialog).toContainText('What arrived is kept.')
      await at(page, 'm-dialog-cancel').tap()
      expect((await mock(page).calls('download_model_to_path')).length).toBe(before)
      await expect(card).toHaveAttribute('data-state', 'storage')
      expect(Object.keys((await mock(page).disk()).partials).length).toBe(1)
      // Room was made: the download goes on from its part.
      await page.evaluate(() => {
        ;(window as any).__M.disk.free = 40 * 1_073_741_824
      })
      await card.getByTestId('m-models-resume').tap()
      await expect(card).toHaveAttribute('data-state', 'installed', { timeout: 20_000 })
      expect(errors()).toEqual([])
    })

    test('download interrupted: network gone, broken transfer, damaged file, sign in needed, remove', async ({ page, context }) => {
      const errors = watchErrors(page)
      await start(page, { device: 'android:8', mock: { step: 0.2, fail: { at: 0.3, error: 'error sending request: connection reset' } } })
      await openModels(page)
      const ids = await at(page, 'm-models-item').evaluateAll((els) => els.slice(0, 2).map((el) => el.getAttribute('data-m-id')))
      const cardOf = (id: string | null) => page.locator(`[data-m-id="${id}"]:visible`).and(page.locator('[data-testid="m-models-item"]'))
      const first = cardOf(ids[0])

      // The network goes away in the middle: the row waits, no red box.
      await first.getByTestId('m-models-download').tap()
      await at(page, 'm-models-downloads').tap()
      await expect(at(page, 'm-models-downloads-screen')).toBeVisible()
      await context.setOffline(true)
      const row = at(page, 'm-models-downloads-item')
      await expect(row).toHaveAttribute('data-state', 'waiting-network', { timeout: 15_000 })
      await expect(row).toContainText('Waiting for network')
      await expect(at(page, 'm-models-downloads-error')).toHaveCount(0)
      expect(await layoutOf(page)).toEqual(CLEAN)

      // Models without a network: Get new says so, Installed stays usable.
      await at(page, 'm-page-back').tap()
      await expect(at(page, 'm-models-offline')).toContainText('The list of models needs a connection. Installed models still work')
      // The headline says "No internet" once, the sentence below does not repeat it (N1).
      expect((await at(page, 'm-models-offline').innerText()).match(/No internet/g)?.length).toBe(1)
      await at(page, 'm-models-offline-retry').tap()
      // The button looks again and says so while the answer is out.
      await expect(at(page, 'm-models-offline-retry')).toHaveText('Checking')
      await expect(at(page, 'm-toast-still-offline')).toBeVisible()
      await expect(at(page, 'm-models-offline-retry')).toHaveText('Try again')
      // The download that was started here stays in sight with its state, the rest of the catalogue is gone (N2).
      await expect(at(page, 'm-models-catalog-inflight').getByTestId('m-models-item')).toHaveCount(1)
      await expect(first).toHaveAttribute('data-state', /waiting/)
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-models-segment-installed').tap()
      await expect(at(page, 'm-models-storage')).toBeVisible()
      await at(page, 'm-models-segment-new').tap()

      // The transfer breaks while there is no network. Still no red box: it waits.
      await expect.poll(() => page.evaluate(() => Object.values((window as any).__M.rows as Record<string, { status: string }>)[0]?.status), { timeout: 15_000 }).toBe('error')
      await expect(at(page, 'm-models-offline')).toBeVisible()

      // Back online: the transfer goes on by itself, from where it stopped.
      await context.setOffline(false)
      await expect(first).toHaveAttribute('data-state', 'installed', { timeout: 25_000 })

      // A transfer that breaks with a network: red box, the part is kept, Resume.
      const second = cardOf(ids[1])
      await mock(page).set({ fail: { at: 0.3, error: 'error sending request: connection reset' } })
      await second.getByTestId('m-models-download').tap()
      const box = second.getByTestId('m-models-error')
      await expect(box).toContainText('Download interrupted', { timeout: 15_000 })
      await expect(box).toContainText('The part that arrived is kept, so you will not start over.')
      await expect(second).toHaveAttribute('data-state', 'interrupted')
      await box.scrollIntoViewIfNeeded()
      expect(await layoutOf(page)).toEqual(CLEAN)
      const kept = Object.values((await mock(page).disk()).partials)[0]
      expect(kept).toBeGreaterThan(0)
      // The same row in the downloads list, with Remove.
      await at(page, 'm-models-downloads').tap()
      await expect(at(page, 'm-models-downloads-error')).toContainText('Download interrupted')
      await expect(at(page, 'm-models-downloads-remove')).toBeVisible()
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-page-back').tap()

      // Damaged file: removed, "Download again".
      await mock(page).set({ fail: { at: 0.9, error: '{file} does not match the checksum of its source. The file was discarded.' } })
      await second.getByTestId('m-models-resume').tap()
      await expect(second.getByTestId('m-models-error')).toContainText('The file was damaged on the way. LU removed it.', { timeout: 20_000 })
      await expect(second.getByTestId('m-models-retry')).toHaveText('Download again')
      expect(Object.keys((await mock(page).disk()).partials)).toEqual([])

      // The source wants a sign in: the way to the token.
      await mock(page).set({ fail: { at: 0.1, error: 'Download failed (HTTP 401)' } })
      await second.getByTestId('m-models-retry').tap()
      await expect(second.getByTestId('m-models-error')).toContainText('This model needs a Hugging Face token.', { timeout: 15_000 })
      await second.getByTestId('m-models-error-token').tap()
      await expect(at(page, 'm-settings-storage-token')).toBeVisible()
      await at(page, 'm-page-back').tap()

      // Remove takes the row and the part away.
      await second.getByTestId('m-models-remove').tap()
      await expect(second).toHaveAttribute('data-state', 'available')
      expect(Object.keys((await mock(page).disk()).partials)).toEqual([])

      // The source does not answer: Retry starts again.
      await mock(page).set({ fail: { at: 0.1, error: 'Download failed (HTTP 503)' } })
      await second.getByTestId('m-models-download').tap()
      await expect(second.getByTestId('m-models-error')).toContainText('Hugging Face did not answer.', { timeout: 15_000 })
      await second.getByTestId('m-models-retry').tap()
      await expect(second).toHaveAttribute('data-state', 'installed', { timeout: 25_000 })
      expect(errors().filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::/.test(e))).toEqual([])
    })

    test('app killed during a download: after the restart the part is kept and the download goes on', async ({ page }) => {
      const errors = watchErrors(page)
      await start(page, { device: 'android:8', mock: { step: 0.2 } })
      await openModels(page)
      const id = await at(page, 'm-models-item').first().getAttribute('data-m-id')
      await at(page, 'm-models-download').first().tap()
      await expect.poll(async () => Object.values((await mock(page).disk()).partials)[0] ?? 0, { timeout: 15_000 }).toBeGreaterThan(0)

      // Killed and opened again. The mock holds its transfers until told otherwise.
      await page.addInitScript(() => {
        window.addEventListener('DOMContentLoaded', () => {
          ;(window as any).__M.hold = true
        })
      })
      await restart(page)
      const kept = Object.values((await mock(page).disk()).partials)[0]
      expect(kept).toBeGreaterThan(0)
      await openModels(page)
      const card = page.locator(`[data-m-id="${id}"]:visible`).and(page.locator('[data-testid="m-models-item"]'))
      await expect(card).toHaveAttribute('data-state', 'paused')
      await expect(card).toContainText('Kept from before the restart')
      await expect(card.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow', '0')
      expect(await layoutOf(page)).toEqual(CLEAN)

      // The downloads list has it as paused. Resume continues from the part.
      await at(page, 'm-models-downloads').tap()
      const row = at(page, 'm-models-downloads-item')
      await expect(row).toHaveAttribute('data-state', 'paused')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-models-downloads-resume').tap()
      await expect(row).toHaveAttribute('data-state', /waiting|running/)
      const started = await mock(page).calls('download_model_to_path')
      expect(started.length).toBe(1)
      expect((await page.evaluate(() => Object.values((window as any).__M.rows as Record<string, { progress: number }>)[0].progress))).toBe(kept)
      expect((await mock(page).calls('resume_download')).length).toBe(0)
      await mock(page).set({ hold: false, step: 0.5 })
      await expect(at(page, 'm-models-downloads-done')).toBeVisible({ timeout: 20_000 })
      await expect(at(page, 'm-toast-installed')).toBeVisible()
      // The finished row leaves by itself.
      await expect(at(page, 'm-models-downloads-empty')).toBeVisible({ timeout: 10_000 })
      await at(page, 'm-models-downloads-getnew').tap()
      await expect(card).toHaveAttribute('data-state', 'installed')

      // The row opens the model.
      await mock(page).set({ hold: true })
      await at(page, 'm-models-download').first().tap()
      await at(page, 'm-models-downloads').tap()
      await at(page, 'm-models-downloads-open').tap()
      await expect(at(page, 'm-models-detail-screen')).toBeVisible()
      await expect(at(page, 'm-models-detail-progress')).toBeVisible()
      await at(page, 'm-models-detail-pause').tap()
      await expect(at(page, 'm-models-detail-transfer')).toHaveAttribute('data-state', 'paused')
      await at(page, 'm-models-detail-resume').tap()
      await at(page, 'm-models-detail-cancel').tap()
      await at(page, 'm-dialog-confirm').tap()
      await expect(at(page, 'm-models-detail-download')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('onboarding killed during a download: the picked card stays the chosen one and ends as ready', async ({ page }) => {
      const errors = watchErrors(page)
      await start(page, { skipOnboarding: false, device: 'android:8', mock: { step: 0.2 } })
      await at(page, 'm-onboarding-next').tap()
      // Not the proposal: the pick has to survive on its own.
      const other = at(page, 'm-onboarding-model-item').first()
      await other.tap()
      await at(page, 'm-onboarding-download').tap()
      await expect.poll(async () => Object.values((await mock(page).disk()).partials)[0] ?? 0, { timeout: 15_000 }).toBeGreaterThan(0)

      await page.addInitScript(() => {
        window.addEventListener('DOMContentLoaded', () => {
          ;(window as any).__M.hold = true
        })
      })
      await restart(page, { skipOnboarding: false })
      if (await at(page, 'm-onboarding-model-screen').count() === 0) await at(page, 'm-onboarding-next').tap()
      await expect(at(page, 'm-onboarding-transfer')).toHaveAttribute('data-state', 'paused')
      await expect(at(page, 'm-onboarding-transfer')).toContainText('Kept from before the restart')
      const chosen = page.locator('[data-testid="m-onboarding-model-card"][data-state="selected"]:visible')
      await expect(chosen).toHaveCount(1)
      const chosenId = await chosen.getAttribute('data-m-id')
      expect(await layoutOf(page)).toEqual(CLEAN)

      await at(page, 'm-onboarding-resume').tap()
      await mock(page).set({ hold: false, step: 0.5 })
      await expect(at(page, 'm-onboarding-model-ready')).toBeVisible({ timeout: 20_000 })
      await expect(at(page, 'm-onboarding-download')).toHaveCount(0)
      await expect(chosen).toHaveAttribute('data-m-id', chosenId ?? '')
      await expect(at(page, 'm-onboarding-model-recommended')).toHaveAttribute('aria-checked', 'false')
      await at(page, 'm-onboarding-next').tap()
      await expect(at(page, 'm-onboarding-documents-screen')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('engine: does not start, falls back to the processor, memory warning, settings, self test', async ({ page }) => {
      const errors = watchErrors(page)
      const file = SMALL.filename
      // An iPhone: the only platform whose engine has a graphics path, so the switch and the layers are there.
      await start(page, { device: 'ios:8', mock: { installed: [{ filename: file, bytes: SMALL.sizeBytes }], loadError: 'Not enough memory for this model: it needs about 5000 MB and 3000 MB are free.' } })
      await openModels(page)
      await at(page, 'm-models-segment-installed').tap()

      // The engine refuses: said on the spot, with the way to the details.
      await at(page, 'm-models-load').tap()
      const failed = at(page, 'm-toast-load-failed')
      await expect(failed).toContainText('Not enough free memory to load')
      await failed.getByRole('button', { name: 'Details' }).tap()
      await expect(at(page, 'm-settings-engine-screen')).toBeVisible()
      await expect(at(page, 'm-settings-engine-status')).toHaveAttribute('data-state', 'none')
      const notice = at(page, 'm-settings-engine-notice-failed')
      await expect(notice).toContainText(`Not enough free memory to load ${SMALL.name} right now.`)
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-settings-engine-notice-retry').tap()
      await expect(notice).toBeVisible()

      // Another failure names its reason.
      await mock(page).set({ loadError: 'The model file is damaged.' })
      await at(page, 'm-settings-engine-notice-retry').tap()
      await expect(notice).toContainText(`${SMALL.name} could not start. The model file is damaged.`)

      // Try again once the cause is gone: it runs, on the processor, and the page says so.
      await mock(page).set({ loadError: null, accelerator: 'cpu', cpuOnly: true })
      await at(page, 'm-settings-engine-notice-retry').tap()
      await expect(at(page, 'm-settings-engine-status')).toHaveAttribute('data-state', 'running')
      await expect(at(page, 'm-settings-engine-model')).toContainText(SMALL.name)
      await expect(at(page, 'm-settings-engine-accelerator')).toContainText('Processor')
      await expect(at(page, 'm-settings-engine-context-loaded')).toContainText('4K tokens')
      await expect(at(page, 'm-settings-engine-notice-cpu')).toContainText('Graphics acceleration is not available. LU is running on the processor, which is slower.')
      await expect(notice).toHaveCount(0)
      expect(await layoutOf(page)).toEqual(CLEAN)

      // Self test.
      await at(page, 'm-settings-engine-selftest').tap()
      await expect(at(page, 'm-settings-engine-selftest-result')).toContainText('The engine answers.')

      // Memory warning of the system: the model is unloaded, "Load again" brings it back.
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:memory-warning', { detail: { level: 'critical' } })))
      await expect(at(page, 'm-settings-engine-status')).toHaveAttribute('data-state', 'none')
      const unloaded = at(page, 'm-settings-engine-notice-unloaded')
      await expect(unloaded).toContainText('The model was unloaded to free memory.')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await mock(page).set({ accelerator: 'gpu', cpuOnly: false })
      await at(page, 'm-settings-engine-notice-load-again').tap()
      await expect(at(page, 'm-settings-engine-status')).toHaveAttribute('data-state', 'running')
      await expect(at(page, 'm-settings-engine-accelerator')).toContainText('Graphics acceleration')
      await expect(at(page, 'm-settings-engine-notice-cpu')).toHaveCount(0)

      // Context: only sizes this phone carries, applied by a restart.
      await at(page, 'm-settings-engine-context-2048').tap()
      await expect(at(page, 'm-toast-engine-applied')).toContainText('2K')
      await expect(at(page, 'm-settings-engine-context-loaded')).toContainText('2K tokens')
      await expect(at(page, 'm-settings-engine-context-8192')).toHaveCount(0)

      // Graphics acceleration off: the engine starts again without layers.
      await at(page, 'm-settings-engine-gpu').tap()
      await expect(at(page, 'm-settings-engine-gpu')).toHaveAttribute('aria-checked', 'false')
      await expect.poll(async () => (await mock(page).calls('swap_bundled_model')).at(-1)?.args?.tuning?.gpuLayers).toBe(0)

      // Threads and background. A stepped value restarts the engine once, a moment after the last tap.
      await at(page, 'm-settings-engine-threads').scrollIntoViewIfNeeded()
      const swapsBefore = (await mock(page).calls('swap_bundled_model')).length
      await page.getByRole('button', { name: 'Increase Threads' }).tap()
      await page.getByRole('button', { name: 'Increase Threads' }).tap()
      await expect(at(page, 'm-settings-engine-threads')).toHaveValue('2')
      await expect.poll(async () => (await mock(page).calls('swap_bundled_model')).at(-1)?.args?.tuning?.threads).toBe(2)
      expect((await mock(page).calls('swap_bundled_model')).length).toBe(swapsBefore + 1)
      await expect(at(page, 'm-toast-engine-applied')).toContainText('The engine now runs with the new settings')
      // Gone for good: a switch the phone engine never applied, and every sentence that said "not used yet".
      await expect(at(page, 'm-settings-engine-mlock')).toHaveCount(0)
      await expect(at(page, 'm-settings-engine-screen')).not.toContainText(/does not use this setting|Keep model in memory/)
      await at(page, 'm-settings-engine-background').tap()
      await expect(at(page, 'm-settings-engine-background')).toHaveAttribute('aria-checked', 'true')
      expect(await layoutOf(page)).toEqual(CLEAN)

      // Leaving the app with that switch on unloads the model.
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
      await expect.poll(() => mock(page).loaded()).toBeNull()
      await page.evaluate(() => window.dispatchEvent(new Event('pageshow')))
      await expect(at(page, 'm-settings-engine-notice-unloaded')).toBeVisible()
      await at(page, 'm-settings-engine-notice-load-again').tap()
      await expect(at(page, 'm-settings-engine-status')).toHaveAttribute('data-state', 'running')

      // The self test result belongs to the loaded model: after an unload it is gone, also when the same model comes back.
      await at(page, 'm-settings-engine-selftest').scrollIntoViewIfNeeded()
      await at(page, 'm-settings-engine-selftest').tap()
      await expect(at(page, 'm-settings-engine-selftest-result')).toContainText('The engine answers.')
      await at(page, 'm-settings-engine-unload').tap()
      await expect(at(page, 'm-settings-engine-status')).toHaveAttribute('data-state', 'none')
      await expect(at(page, 'm-settings-engine-selftest-result')).toHaveCount(0)
      await at(page, 'm-settings-engine-notice-load-again').or(at(page, 'm-settings-engine-models')).first().waitFor()
      await page.evaluate(async (path) => {
        const spec = '/src/mobile/screens/models/parts/engine.ts'
        const mod = await import(/* @vite-ignore */ spec)
        await mod.loadModel({ name: path.split('/').pop()!.replace(/\.gguf$/, ''), path })
      }, `/data/lu/models/${file}`)
      await expect(at(page, 'm-settings-engine-status')).toHaveAttribute('data-state', 'running')
      await expect(at(page, 'm-settings-engine-selftest-result')).toHaveCount(0)

      // Advanced is a page of its own. Every value there acts: a change loads the model again with it.
      await at(page, 'm-settings-engine-advanced').scrollIntoViewIfNeeded()
      await at(page, 'm-settings-engine-advanced').tap()
      await expect(at(page, 'm-settings-engine-advanced-screen')).toBeVisible()
      await at(page, 'm-settings-engine-advanced-flash-on').tap()
      await expect(at(page, 'm-settings-engine-advanced-flash-on')).toHaveAttribute('aria-checked', 'true')
      await expect.poll(async () => (await mock(page).calls('swap_bundled_model')).at(-1)?.args?.tuning?.flashAttn).toBe('on')
      await expect(at(page, 'm-toast-engine-applied')).toBeVisible()
      await expect(at(page, 'm-settings-engine-advanced-flash-on')).toBeEnabled()
      await at(page, 'm-settings-engine-advanced-cachek-q8_0').tap()
      await expect(at(page, 'm-settings-engine-advanced-cachek-q8_0')).toHaveAttribute('aria-checked', 'true')
      await expect.poll(async () => (await mock(page).calls('swap_bundled_model')).at(-1)?.args?.tuning?.cacheTypeK).toBe('q8_0')
      // What the phone engine never applies is not offered: 4 bit cache, memory mapping.
      await expect(at(page, 'm-settings-engine-advanced-cachek-q4_0')).toHaveCount(0)
      await expect(at(page, 'm-settings-engine-advanced-cachev-q4_0')).toHaveCount(0)
      await expect(at(page, 'm-settings-engine-advanced-mmap')).toHaveCount(0)
      await expect(at(page, 'm-settings-engine-advanced-screen')).not.toContainText(/does not use|Memory mapping|q4_0/)
      // The engine could not open the model with the chosen cache settings: it says so, here and on the engine page.
      await mock(page).set({ tuningNote: 'This model could not be loaded with the chosen Flash Attention and cache settings, so it was loaded with the standard ones.' })
      await at(page, 'm-settings-engine-advanced-cachev-q8_0').tap()
      await expect.poll(async () => (await mock(page).calls('swap_bundled_model')).at(-1)?.args?.tuning?.cacheTypeV).toBe('q8_0')
      await expect(at(page, 'm-settings-engine-notice-tuning')).toContainText('it was loaded with the standard ones')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await mock(page).set({ tuningNote: null })
      // Graphics acceleration was switched off above: the layers stand at 0 and go up from there.
      await expect(at(page, 'm-settings-engine-advanced-layers')).toHaveValue('0')
      await page.getByRole('button', { name: 'Increase Layers on the graphics chip' }).tap()
      await expect(at(page, 'm-settings-engine-advanced-layers')).toHaveValue('10')
      await expect.poll(async () => (await mock(page).calls('swap_bundled_model')).at(-1)?.args?.tuning).toMatchObject({ gpuLayers: 10, flashAttn: 'on', cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', threads: 2, ctx: 2048 })
      await expect(at(page, 'm-settings-engine-notice-tuning')).toHaveCount(0)
      await at(page, 'm-page-back').tap()
      await expect(at(page, 'm-settings-engine-screen')).toBeVisible()
      await expect(at(page, 'm-settings-engine-gpu')).toHaveAttribute('aria-checked', 'true')

      // Restart and unload.
      await at(page, 'm-settings-engine-restart').tap()
      await expect(at(page, 'm-toast-engine-restarted')).toBeVisible()
      await at(page, 'm-settings-engine-unload').tap()
      await expect(at(page, 'm-settings-engine-status')).toHaveAttribute('data-state', 'none')
      await at(page, 'm-settings-engine-selftest').tap()
      await expect(at(page, 'm-toast-engine-selftest-nomodel')).toBeVisible()

      // Reset: asked first.
      await at(page, 'm-settings-engine-reset').scrollIntoViewIfNeeded()
      await at(page, 'm-settings-engine-reset').tap()
      await expect(at(page, 'm-dialog-engine-reset')).toBeVisible()
      await at(page, 'm-dialog-confirm').tap()
      await expect(at(page, 'm-toast-engine-reset-done')).toBeVisible()
      await expect(at(page, 'm-settings-engine-context-auto')).toHaveAttribute('aria-checked', 'true')
      await expect(at(page, 'm-settings-engine-gpu')).toHaveAttribute('aria-checked', 'true')
      await expect(at(page, 'm-settings-engine-background')).toHaveAttribute('aria-checked', 'false')
      await expect(at(page, 'm-settings-engine-threads')).toHaveValue('0')
      await at(page, 'm-settings-engine-models').tap()
      await expect(at(page, 'm-models-screen')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('engine on Android: no switch for graphics, no layers, and a stored 4 bit cache shows as 8 bit', async ({ page }) => {
      const errors = watchErrors(page)
      const file = SMALL.filename
      await start(page, { device: 'android:8', route: '/settings/engine', mock: { installed: [{ filename: file, bytes: SMALL.sizeBytes }], loaded: file, accelerator: 'cpu' } })
      await expect(at(page, 'm-settings-engine-screen')).toBeVisible()
      await expect(at(page, 'm-settings-engine-status')).toHaveAttribute('data-state', 'running')
      // The phone engine has no graphics path on Android: a switch for it would do nothing, so there is none.
      await expect(at(page, 'm-settings-engine-gpu')).toHaveCount(0)
      await expect(at(page, 'm-settings-engine-no-graphics')).toContainText('This phone computes on the processor.')
      await expect(at(page, 'm-settings-engine-mlock')).toHaveCount(0)
      expect(await layoutOf(page)).toEqual(CLEAN)

      // A backup from the desktop may carry values the phone never applies. They are shown as what really runs.
      await page.evaluate(async () => {
        const spec = '/src/stores/settingsStore.ts'
        const mod = await import(/* @vite-ignore */ spec)
        const now = mod.useSettingsStore.getState().settings.builtinEngine
        mod.useSettingsStore.getState().updateSettings({ builtinEngine: { ...now, cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', mlock: true, noMmap: true } })
      })
      await at(page, 'm-settings-engine-advanced').scrollIntoViewIfNeeded()
      await at(page, 'm-settings-engine-advanced').tap()
      await expect(at(page, 'm-settings-engine-advanced-screen')).toBeVisible()
      await expect(at(page, 'm-settings-engine-advanced-layers')).toHaveCount(0)
      await expect(at(page, 'm-settings-engine-advanced-cachek-q8_0')).toHaveAttribute('aria-checked', 'true')
      await expect(at(page, 'm-settings-engine-advanced-cachev-q8_0')).toHaveAttribute('aria-checked', 'true')
      // With flash attention off the values cannot be quantized, and the page says what happens instead.
      await at(page, 'm-settings-engine-advanced-flash-off').tap()
      await expect(at(page, 'm-settings-engine-advanced-cache-hint')).toContainText('the values stay at f16')
      await expect.poll(async () => (await mock(page).calls('swap_bundled_model')).at(-1)?.args?.tuning?.flashAttn).toBe('off')
      expect(await layoutOf(page)).toEqual(CLEAN)
      expect(errors()).toEqual([])
    })

    test('storage page: bar, delete a model, partial files, no speed limit, Wi-Fi only, token, cache', async ({ page }) => {
      const errors = watchErrors(page)
      const other = MOBILE_CHAT_MODELS[1]
      await start(page, {
        device: 'android:8',
        route: '/settings/storage',
        mock: {
          freeBytes: 900 * MIB,
          installed: [
            { filename: SMALL.filename, bytes: SMALL.sizeBytes },
            { filename: EMBED, bytes: 84_106_624 },
          ],
          partials: [{ filename: other.filename, bytes: 300 * MIB }],
        },
      })
      await expect(at(page, 'm-settings-storage-screen')).toBeVisible()
      await expect(at(page, 'm-settings-storage-low')).toContainText('Only 900.0 MB are free.')
      await expect(at(page, 'm-settings-storage-free')).toContainText('900.0 MB')
      await expect(at(page, 'm-settings-storage-model')).toHaveCount(2)
      expect(await layoutOf(page)).toEqual(CLEAN)

      // Partial files of an earlier run: asked, then deleted.
      const partials = at(page, 'm-settings-storage-partials-clear')
      await expect(partials).toContainText('1 partial file, 300.0 MB')
      await partials.tap()
      await expect(at(page, 'm-dialog-cleanup')).toContainText('This frees 300.0 MB.')
      await at(page, 'm-dialog-confirm').tap()
      await expect(at(page, 'm-toast-cleanup-done')).toHaveText('Freed 300.0 MB')
      await expect(partials).toContainText('Nothing to clean')
      expect((await mock(page).disk()).partials).toEqual({})
      await partials.tap()
      await expect(at(page, 'm-toast-cleanup-none')).toBeVisible()

      // Delete a model from its row.
      const row = page.locator(`[data-testid="m-settings-storage-model"][data-m-id="${SMALL.filename.replace(/\.gguf$/, '')}"]:visible`)
      await row.getByTestId('m-settings-storage-delete').tap()
      await expect(at(page, 'm-dialog-delete-model')).toContainText(`Delete ${SMALL.name}?`)
      await at(page, 'm-dialog-confirm').tap()
      await expect(at(page, 'm-toast-deleted')).toBeVisible()
      await expect(at(page, 'm-settings-storage-model')).toHaveCount(1)
      await expect(at(page, 'm-settings-storage-low')).toHaveCount(0)

      // No speed limit on the phone: the system download service has none (M1).
      await expect(page.locator('[data-testid^="m-settings-storage-limit"]')).toHaveCount(0)
      expect(await mock(page).calls('set_download_limit')).toEqual([])
      // Wi-Fi only.
      await at(page, 'm-settings-storage-wifi').scrollIntoViewIfNeeded()
      await at(page, 'm-settings-storage-wifi').tap()
      await expect(at(page, 'm-settings-storage-wifi')).toHaveAttribute('aria-checked', 'true')
      // A field of the settings store, so it travels with a backup.
      expect(await page.evaluate(async () => {
        const spec = '/src/stores/settingsStore.ts'
        const mod = await import(/* @vite-ignore */ spec)
        return mod.useSettingsStore.getState().settings.mobileDownloadWifiOnly
      })).toBe(true)
      expect(await layoutOf(page)).toEqual(CLEAN)

      // Hugging Face token (a made up test value).
      await at(page, 'm-settings-storage-token').scrollIntoViewIfNeeded()
      await at(page, 'm-settings-storage-token').fill('hf_e2e_made_up')
      await at(page, 'm-settings-storage-token-save').tap()
      await expect(at(page, 'm-toast-token-saved')).toBeVisible()
      await expect(at(page, 'm-settings-storage-token')).toHaveValue('')
      await expect(at(page, 'm-settings-storage-screen')).toContainText('A token is stored on this phone.')
      await at(page, 'm-settings-storage-token-remove').tap()
      await expect(at(page, 'm-toast-token-removed')).toBeVisible()
      await expect(at(page, 'm-settings-storage-token-remove')).toHaveCount(0)

      // Cache and the way to the downloads.
      await at(page, 'm-settings-storage-cache-clear').scrollIntoViewIfNeeded()
      await at(page, 'm-settings-storage-cache-clear').tap()
      await expect(at(page, 'm-toast-cache-empty').or(at(page, 'm-toast-cache-cleared'))).toBeVisible()
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-settings-storage-downloads').tap()
      await expect(at(page, 'm-models-downloads-empty')).toContainText('No downloads')
      await expect(at(page, 'm-models-downloads-footer')).toContainText('Downloads keep running when you leave LU')
      expect(await layoutOf(page)).toEqual(CLEAN)
      expect(errors()).toEqual([])
    })

    test('benchmark: loads the model first, measures, shows the single values, clears', async ({ page }) => {
      const errors = watchErrors(page)
      await start(page, { device: 'android:8', route: '/models/benchmark', mock: { installed: [{ filename: SMALL.filename, bytes: SMALL.sizeBytes }] } })
      await expect(at(page, 'm-models-benchmark-screen')).toBeVisible()
      await expect(at(page, 'm-models-benchmark-model-pick')).toHaveAttribute('aria-checked', 'true')
      await expect(at(page, 'm-models-benchmark-willload')).toContainText('is not loaded. LU loads it first')
      await expect(at(page, 'm-models-benchmark-noresults')).toBeVisible()
      expect(await layoutOf(page)).toEqual(CLEAN)

      await at(page, 'm-models-benchmark-run').tap()
      await expect(at(page, 'm-models-benchmark-speed')).toContainText('tokens per second', { timeout: 20_000 })
      await expect(at(page, 'm-models-benchmark-run')).toBeVisible({ timeout: 20_000 })
      await expect(at(page, 'm-models-benchmark-accuracy')).toHaveText('3 of 3 answers right')
      await expect(at(page, 'm-models-benchmark-result')).toContainText('Measured on this phone')
      expect(await mock(page).loaded()).toContain(SMALL.filename)
      await at(page, 'm-models-benchmark-result-toggle').tap()
      await expect(at(page, 'm-models-benchmark-result-details')).toContainText('Reasoning')
      expect(await layoutOf(page)).toEqual(CLEAN)

      // Stop ends a run early.
      await at(page, 'm-models-benchmark-run').tap()
      await at(page, 'm-models-benchmark-stop').tap()
      await expect(at(page, 'm-models-benchmark-run')).toBeVisible({ timeout: 20_000 })

      await at(page, 'm-models-benchmark-clear').scrollIntoViewIfNeeded()
      await at(page, 'm-models-benchmark-clear').tap()
      await expect(at(page, 'm-dialog-benchmark-clear')).toBeVisible()
      await at(page, 'm-dialog-confirm').tap()
      await expect(at(page, 'm-toast-benchmark-cleared')).toBeVisible()
      await expect(at(page, 'm-models-benchmark-noresults')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('benchmark without a model, and from the detail page', async ({ page }) => {
      const errors = watchErrors(page)
      await start(page, { device: 'android:8', route: '/models/benchmark' })
      await expect(at(page, 'm-models-benchmark-empty')).toContainText('Install a model first')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-models-benchmark-getnew').tap()
      await expect(at(page, 'm-models-screen')).toBeVisible()
      // The row in Installed leads there too.
      await at(page, 'm-models-segment-installed').tap()
      await at(page, 'm-models-benchmark').tap()
      await expect(at(page, 'm-models-benchmark-screen')).toBeVisible()
      await at(page, 'm-page-back').tap()
      await at(page, 'm-models-partials-clear').tap()
      await expect(at(page, 'm-toast-cleanup-none')).toBeVisible()
      await at(page, 'm-models-storage').tap()
      await expect(at(page, 'm-settings-storage-screen')).toBeVisible()
      await expect(at(page, 'm-settings-storage-none')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('search on Hugging Face: hits with a verdict, variants, a too large variant is locked, install', async ({ page }) => {
      const errors = watchErrors(page)
      const repo = 'e2e-lab/Tiny-1B-GGUF'
      await start(page, {
        device: 'android:8',
        mock: {
          step: 0.5,
          search: {
            hits: [{ id: repo, downloads: 1200 }],
            trees: {
              [repo]: [
                { type: 'file', path: 'Tiny-1B-Q4_K_M.gguf', size: 700 * MIB },
                { type: 'file', path: 'Tiny-1B-Q8_0.gguf', size: 1228 * MIB },
                { type: 'file', path: 'Tiny-1B-F32.gguf', size: 30_000 * MIB },
                { type: 'file', path: 'README.md', size: 1200 },
              ],
            },
          },
        },
      })
      await openModels(page)
      await at(page, 'm-models-search').fill('tiny')
      const hit = at(page, 'm-models-hits').locator('[data-testid="m-models-item"]')
      await expect(hit).toBeVisible({ timeout: 10_000 })
      await expect(hit.getByTestId('m-models-item-fit')).toHaveText('Should run well on this phone')
      await expect(hit.getByTestId('m-models-download')).toContainText('Download 700.0 MB')
      expect(await layoutOf(page)).toEqual(CLEAN)

      await hit.getByTestId('m-models-item-open').tap()
      await expect(at(page, 'm-models-detail-screen')).toBeVisible()
      const variants = at(page, 'm-models-detail-variant')
      await expect(variants).toHaveCount(3)
      await expect(page.locator('[data-testid="m-models-detail-variant"][data-m-id="Q4_K_M"]:visible')).toHaveAttribute('data-state', 'selected')
      const big = page.locator('[data-testid="m-models-detail-variant"][data-m-id="F32"]:visible')
      await expect(big).toHaveAttribute('data-state', 'too-large')
      await expect(big.getByTestId('m-models-detail-variant-pick')).toBeDisabled()
      await expect(big).toContainText('Too large for this phone')
      await page.locator('[data-testid="m-models-detail-variant"][data-m-id="Q8_0"]:visible').getByTestId('m-models-detail-variant-pick').tap()
      await expect(at(page, 'm-models-detail-download')).toContainText('Download 1.2 GB')
      await expect(at(page, 'm-models-detail-size')).toContainText('1.2 GB')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-models-detail-download').tap()
      await expect(at(page, 'm-toast-installed')).toBeVisible({ timeout: 20_000 })
      expect(Object.keys((await mock(page).disk()).files)).toEqual(['Tiny-1B-Q8_0.gguf'])
      await expect(at(page, 'm-models-detail-use')).toBeVisible()
      await at(page, 'm-models-detail-benchmark').tap()
      await expect(at(page, 'm-models-benchmark-screen')).toBeVisible()
      await at(page, 'm-page-back').tap()
      await at(page, 'm-page-back').tap()

      // The installed file shows up in Installed, also without a catalogue entry.
      await at(page, 'm-models-search').fill('')
      await at(page, 'm-models-segment-installed').tap()
      await expect(at(page, 'm-models-installed')).toContainText('Tiny-1B-Q8_0')
      await at(page, 'm-models-segment-new').tap()

      // No hit.
      await at(page, 'm-models-search').fill('nothing-like-this')
      await expect(at(page, 'm-models-search-empty')).toContainText('No model LU can run matches nothing-like-this.', { timeout: 10_000 })
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-models-search-clear').tap()
      await expect(at(page, 'm-models-catalog')).toBeVisible()

      // An id that points nowhere.
      await restart(page, { route: '/models/no-such-model' })
      await expect(at(page, 'm-models-detail-notfound')).toContainText('This model is not in the list any more.')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-models-detail-notfound-back').tap()
      await expect(at(page, 'm-models-screen')).toBeVisible()
      expect(errors()).toEqual([])
    })
    test('store policy: without the unfiltered catalogue and without foreign files', async ({ page }) => {
      const errors = watchErrors(page)
      const hidden = MOBILE_CHAT_MODELS.filter((m) => m.uncensored).sort((a, b) => a.sizeBytes - b.sizeBytes)
      const mine = hidden[0]
      const repo = 'e2e-lab/Tiny-1B-GGUF'
      const tree = [{ type: 'file', path: 'Tiny-1B-Q4_K_M.gguf', size: 700 * MIB }]
      const search = { hits: [{ id: 'e2e-lab/Tiny-1B-abliterated-GGUF', downloads: 9000 }, { id: repo, downloads: 1200 }], trees: { [repo]: tree, 'e2e-lab/Tiny-1B-abliterated-GGUF': tree } }
      // The App Store preset of the scaffold (src/mobile/policy): no unfiltered catalogue, no foreign files.
      // It asks for the age first; answered once, as an adult.
      await declareAdult(page)
      await start(page, { skipOnboarding: false, store: 'appstore', device: 'android:8', mock: { installed: [{ filename: mine.filename, bytes: mine.sizeBytes }], search } })

      // Onboarding: one kind only, and still a proposal that fits.
      await at(page, 'm-onboarding-next').tap()
      await expect(at(page, 'm-onboarding-model-recommended')).toHaveAttribute('aria-checked', 'true')
      await expect(at(page, 'm-onboarding-model-segment')).toHaveCount(0)
      const offered = await at(page, 'm-onboarding-model-card').evaluateAll((els) => els.map((el) => el.getAttribute('data-m-id')))
      expect(offered.length).toBeGreaterThan(0)
      expect(offered.filter((id) => hidden.some((m) => m.id === id))).toEqual([])
      await at(page, 'm-onboarding-skip').tap()
      await at(page, 'm-onboarding-skip').tap()
      await at(page, 'm-onboarding-done').tap()
      await expect(at(page, 'm-chat-screen')).toBeVisible()

      // Models: no search, no kind chips, no unfiltered card, also with every filter off.
      await openModels(page)
      await expect(at(page, 'm-models-search')).toHaveCount(0)
      await expect(at(page, 'm-models-filter-unfiltered')).toHaveCount(0)
      await at(page, 'm-models-filter-fits').tap()
      const listed = await page.locator('[data-testid^="m-models-item"][data-m-id]:visible').evaluateAll((els) => els.map((el) => el.getAttribute('data-m-id')))
      expect(listed.length).toBe(MOBILE_CHAT_MODELS.length - hidden.length)
      expect(listed.filter((id) => hidden.some((m) => m.id === id))).toEqual([])
      expect(await layoutOf(page)).toEqual(CLEAN)

      // The model that is already on the phone stays usable.
      await at(page, 'm-models-segment-installed').tap()
      const card = page.locator(`[data-m-id="${mine.id}"]:visible`).and(page.locator('[data-testid="m-models-item"]'))
      await expect(card).toHaveAttribute('data-state', 'installed')
      await card.getByTestId('m-models-load').tap()
      await expect(card).toHaveAttribute('data-state', 'loaded')
      await card.getByTestId('m-models-item-open').tap()
      await expect(at(page, 'm-models-detail-withdrawn')).toContainText('The copy on this phone keeps working.')
      await expect(at(page, 'm-models-detail-variant')).toHaveCount(1)
      expect(await layoutOf(page)).toEqual(CLEAN)

      // By its address there is nothing to get either: not an unfiltered catalogue model, not a foreign repository.
      await restart(page, { store: 'appstore', route: `/models/${hidden[1].id}` })
      await expect(at(page, 'm-models-detail-notfound')).toContainText('This model is not available in this version of LU.')
      await expect(at(page, 'm-models-detail-download')).toHaveCount(0)
      await restart(page, { store: 'appstore', route: `/models/${encodeURIComponent(`hf:${repo}`)}` })
      await expect(at(page, 'm-models-detail-notfound')).toContainText('This model is not available in this version of LU.')
      expect((await mock(page).calls('download_model_to_path')).length).toBe(0)

      // "Foreign files allowed, unfiltered ones not" is no preset of the scaffold; the rule is held by
      // the unit tests of repoOffered and downloadVerdict (screens/models/__tests__/catalog-policy.test.ts).

      // The open build: both kinds, the search, both hits.
      await restart(page)
      await openModels(page)
      await expect(at(page, 'm-models-filter-unfiltered')).toBeVisible()
      await at(page, 'm-models-filter-fits').tap()
      await expect(page.locator('[data-testid^="m-models-item"][data-m-id]:visible')).toHaveCount(MOBILE_CHAT_MODELS.length)
      await at(page, 'm-models-search').fill('tiny')
      await expect(at(page, 'm-models-hits').locator('[data-testid="m-models-item"]')).toHaveCount(2, { timeout: 10_000 })
      await restart(page, { route: `/models/${hidden[1].id}` })
      await expect(at(page, 'm-models-detail-download')).toBeVisible()
      expect(errors()).toEqual([])
    })
    test('asked before a download: mobile data, tight fit. And the notice lines for the chat', async ({ page }) => {
      const errors = watchErrors(page)
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'connection', { configurable: true, value: { type: 'cellular' } })
        localStorage.setItem('lu-mobile-download-wifi-only', '1')
      })
      await start(page, { device: 'android:8', mock: { hold: true, installed: [{ filename: SMALL.filename, bytes: SMALL.sizeBytes }], loadError: 'The model file is damaged.' } })
      await openModels(page)

      // Wi-Fi only is on and the phone is on mobile data: asked first.
      const free = at(page, 'm-models-item').filter({ has: page.locator('[data-testid="m-models-download"]') })
      await free.first().getByTestId('m-models-download').tap()
      await expect(at(page, 'm-dialog-mobile-data')).toContainText('You are not on Wi-Fi.')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-dialog-cancel').tap()
      // "Wait for Wi-Fi" (round 9, N4). In the phone app the download is started under the rule and native code
      // holds it until Wi-Fi (screens/models/__tests__/wifi-only.test.ts). Here nothing can hold a download back,
      // so nothing is started, and the app says so instead of doing nothing.
      await expect(at(page, 'm-toast-download-not-queued')).toContainText('Tap Download again when you are on Wi-Fi.')
      expect((await mock(page).calls('download_model_to_path')).length).toBe(0)
      // The switch is a setting now. The value above came from where it lived before and still counted; switching it
      // off writes the setting and removes the old key.
      await page.evaluate(async () => {
        const spec = '/src/mobile/screens/models/parts/adapters/prefs.ts'
        const mod = await import(/* @vite-ignore */ spec)
        mod.setPref('wifiOnly', false)
      })
      expect(await page.evaluate(() => localStorage.getItem('lu-mobile-download-wifi-only'))).toBeNull()

      // A tight fit is said before the download starts.
      const tight = at(page, 'm-models-item').filter({ has: page.locator('[data-fit="tight"]') }).first()
      await tight.scrollIntoViewIfNeeded()
      await tight.getByTestId('m-models-download').tap()
      await expect(at(page, 'm-dialog-tight-fit')).toContainText('This model is close to the limit. Other apps may be closed while it runs.')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-dialog-cancel').tap()
      expect((await mock(page).calls('download_model_to_path')).length).toBe(0)
      await tight.getByTestId('m-models-download').tap()
      await at(page, 'm-dialog-confirm').tap()
      await expect(tight.getByTestId('m-models-progress')).toBeVisible()

      // A failed download that is not running any more is pointed at from the top of Models.
      await page.evaluate(() => {
        const M = (window as any).__M
        M.hold = false
        M.step = 0.5
        M.fail = { at: 0.4, error: 'error sending request: connection reset' }
      })
      await expect(at(page, 'm-models-download-notice')).toBeVisible({ timeout: 15_000 })
      await at(page, 'm-models-download-notice-open').tap()
      await expect(at(page, 'm-models-downloads-error')).toBeVisible()
      await at(page, 'm-models-downloads-remove').tap()
      await expect(at(page, 'm-models-downloads-empty')).toBeVisible()
      await at(page, 'm-page-back').tap()

      // G10 as lines, the way the chat shows them. The frame keeps one copy mounted out of sight; the chat page of
      // strand 1 renders the same component in its notice area.
      await at(page, 'm-models-segment-installed').tap()
      await at(page, 'm-models-load').tap()
      await expect(at(page, 'm-toast-load-failed')).toContainText('could not start')
      const lines = page.getByTestId('m-engine-notices')
      await expect(lines.getByTestId('m-engine-notice-failed')).toContainText(`${SMALL.name} could not start. The model file is damaged.`)
      await expect(lines.getByRole('button', { name: 'Try again', includeHidden: true })).toHaveCount(1)
      await expect(lines.getByRole('button', { name: 'Pick another model', includeHidden: true })).toHaveCount(1)
      await mock(page).set({ loadError: null, accelerator: 'cpu', cpuOnly: true })
      await at(page, 'm-models-load').tap()
      await expect(at(page, 'm-toast-loaded')).toBeVisible()
      await expect(lines.getByTestId('m-engine-notice-cpu')).toContainText('LU is running on the processor, which is slower.')
      await expect(lines.getByRole('button', { name: 'Details', includeHidden: true })).toHaveCount(1)
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:memory-warning')))
      await expect(lines.getByTestId('m-engine-notice-unloaded')).toContainText('The model was unloaded to free memory.')
      await expect(lines.getByRole('button', { name: 'Load again', includeHidden: true })).toHaveCount(1)
      expect(errors()).toEqual([])
    })
    test('onboarding again: a model is already on the phone, the document model too, and no network', async ({ page, context }) => {
      const errors = watchErrors(page)
      const second = MOBILE_CHAT_MODELS.filter((m) => !m.uncensored).sort((a, b) => a.sizeBytes - b.sizeBytes)[1]
      await start(page, {
        skipOnboarding: false,
        device: 'android:8',
        mock: { installed: [{ filename: second.filename, bytes: second.sizeBytes }, { filename: EMBED, bytes: 84_106_624 }] },
      })
      await at(page, 'm-onboarding-next').tap()
      await expect(at(page, 'm-onboarding-model-recommended')).toBeVisible()
      // The next page is fetched while there is a network (the dev server serves pages one by one; the app has them all).
      await at(page, 'm-onboarding-skip').tap()
      await expect(at(page, 'm-onboarding-documents-screen')).toBeVisible()
      await at(page, 'm-page-back').tap()

      // No network: said, with "Try again", and the download is locked with the reason.
      await context.setOffline(true)
      await expect(at(page, 'm-onboarding-model-offline')).toContainText('No internet. You need a connection once to download a model.')
      await at(page, 'm-onboarding-model-offline-retry').tap()
      // The button looks again and says so while the answer is out.
      await expect(at(page, 'm-onboarding-model-offline-retry')).toHaveText('Checking')
      await expect(at(page, 'm-toast-still-offline')).toBeVisible()
      await expect(at(page, 'm-onboarding-model-offline-retry')).toHaveText('Try again')
      await expect(at(page, 'm-onboarding-download')).toBeDisabled()
      await expect(at(page, 'm-onboarding-download')).toContainText('No internet')
      expect(await layoutOf(page)).toEqual(CLEAN)

      // The installed model can be taken without a download, also offline.
      const mine = at(page, 'm-onboarding-model-card').and(page.locator(`[data-m-id="${second.id}"]`))
      await mine.scrollIntoViewIfNeeded()
      await mine.getByRole('radio').tap()
      await expect(mine).toContainText('Installed')
      await expect(at(page, 'm-onboarding-model-ready')).toHaveText('Already on this phone')
      await expect(at(page, 'm-onboarding-download')).toHaveCount(0)
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-onboarding-use').tap()
      await expect(at(page, 'm-onboarding-documents-screen')).toBeVisible()
      expect(await mock(page).loaded()).toContain(second.filename)
      expect((await mock(page).calls('download_model_to_path')).length).toBe(0)

      // The document model is there already.
      await expect(at(page, 'm-onboarding-documents-ready')).toHaveText('Already installed. Document Chat is ready.')
      await expect(at(page, 'm-onboarding-documents-install')).toHaveCount(0)
      await context.setOffline(false)
      await at(page, 'm-onboarding-next').tap()
      await expect(at(page, 'm-onboarding-done-status')).toHaveAttribute('data-state', 'ready')
      await expect(at(page, 'm-onboarding-done-status')).toContainText(`${second.name} is ready.`)
      await at(page, 'm-onboarding-done').tap()
      await expect(at(page, 'm-chat-screen')).toBeVisible()
      expect(errors().filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::/.test(e))).toEqual([])
    })

    // Check 4 on Android, F5: on the page of the catalogue model the mark "Tools" stayed when a 2 bit packing was chosen.
    test('the page of a catalogue model: the Tools mark follows the packing that is chosen', async ({ page }) => {
      const errors = watchErrors(page)
      const repo = 'unsloth/Qwen3.5-2B-GGUF'
      await start(page, {
        device: 'android:8',
        mock: {
          search: {
            hits: [],
            trees: {
              [repo]: [
                { type: 'file', path: 'Qwen3.5-2B-Q4_K_M.gguf', size: 1280835840 },
                { type: 'file', path: 'Qwen3.5-2B-UD-IQ2_M.gguf', size: 820 * MIB },
                { type: 'file', path: 'Qwen3.5-2B-UD-IQ2_XXS.gguf', size: 733 * MIB },
                // Check 4 on an iPhone, N1: the same with IQ2_XXS. Every spelling of a 2 bit packing, and one of 1 bit.
                { type: 'file', path: 'Qwen3.5-2B-IQ2_XS.gguf', size: 760 * MIB },
                { type: 'file', path: 'Qwen3.5-2B-IQ2_S.gguf', size: 790 * MIB },
                { type: 'file', path: 'Qwen3.5-2B-Q2_K.gguf', size: 850 * MIB },
                { type: 'file', path: 'Qwen3.5-2B-Q2_K_L.gguf', size: 870 * MIB },
                { type: 'file', path: 'Qwen3.5-2B-IQ1_S.gguf', size: 600 * MIB },
                { type: 'file', path: 'Qwen3.5-2B-IQ3_XXS.gguf', size: 940 * MIB },
                { type: 'file', path: 'Qwen3.5-2B-Q3_K_S.gguf', size: 980 * MIB },
              ],
            },
          },
        },
      })
      await openModels(page)
      await page.locator('[data-testid="m-models-item"][data-m-id="qwen3.5-2b"]:visible').getByTestId('m-models-item-open').tap()
      await expect(at(page, 'm-models-detail-screen')).toBeVisible()
      await expect(at(page, 'm-models-detail-variant')).toHaveCount(10)
      const pick = (quant: string) => page.locator(`[data-testid="m-models-detail-variant"][data-m-id="${quant}"]:visible`).getByTestId('m-models-detail-variant-pick').tap()
      // The packing of the catalogue: the model drives tools.
      await expect(at(page, 'm-models-detail-tools')).toBeVisible()
      await expect(at(page, 'm-models-detail-thinking')).toBeVisible()
      for (const quant of ['IQ2_M', 'IQ2_XXS', 'IQ2_XS', 'IQ2_S', 'Q2_K', 'Q2_K_L', 'IQ1_S']) {
        await pick(quant)
        await expect(at(page, 'm-models-detail-fit')).toContainText('Packed very small, answers may be poor')
        await expect(at(page, 'm-models-detail-tools')).toHaveCount(0)
        // What does not depend on the packing stays.
        await expect(at(page, 'm-models-detail-thinking')).toBeVisible()
      }
      // 3 bits and more carry it again.
      await pick('IQ3_XXS')
      await expect(at(page, 'm-models-detail-tools')).toBeVisible()
      await pick('Q3_K_S')
      await expect(at(page, 'm-models-detail-tools')).toBeVisible()
      await pick('Q4_K_M')
      await expect(at(page, 'm-models-detail-tools')).toBeVisible()
      expect(await layoutOf(page)).toEqual(CLEAN)
      expect(errors()).toEqual([])
    })

    test('another packing of a catalogue model: same verdict and marks once installed, and "Use in chat" waits for a load that is running', async ({ page }) => {
      const errors = watchErrors(page)
      // The case of the acceptance run (Android, re-run, N1 and N2): Qwen 3.5 2B as IQ2_M on a 4 GB phone.
      const variant = 'Qwen3.5-2B-UD-IQ2_M'
      await start(page, { device: 'android:4', mock: { installed: [{ filename: SMALL.filename, bytes: SMALL.sizeBytes }, { filename: `${variant}.gguf`, bytes: 820 * MIB }] } })
      await openModels(page)
      await at(page, 'm-models-segment-installed').tap()
      const card = page.locator(`[data-testid="m-models-item"][data-m-id="file:${variant}"]:visible`)
      const small = page.locator(`[data-testid="m-models-item"][data-m-id="${SMALL.id}"]:visible`)
      await expect(card).toHaveCount(1)
      // It is the catalogue model in another packing: its name, its marks, and the verdict the detail page gave before the download.
      await expect(card).toContainText('Qwen 3.5 2B IQ2_M')
      // Round 12, F8: a 2 bit packing of a model this small never reads as a plain verdict about memory. The badge says what the packing costs.
      await expect(card.getByTestId('m-models-item-fit')).toContainText('Packed very small, answers may be poor')
      await expect(card.getByTestId('m-models-item-fit')).not.toContainText('run well')
      await expect(card.getByTestId('m-models-item-thinking')).toBeVisible()
      // Check on Android with 4 GB, F3: a 2 bit packing does not carry the Tools mark, Agent mode does not take it.
      await expect(card.getByTestId('m-models-item-tools')).toHaveCount(0)
      await expect(page.locator(`[data-testid="m-models-item-toolarge"][data-m-id="file:${variant}"]`)).toHaveCount(0)
      expect(await layoutOf(page)).toEqual(CLEAN)

      // The detail page of the file says the same.
      await card.getByTestId('m-models-item-open').tap()
      await expect(at(page, 'm-models-detail-fit')).toContainText('Packed very small, answers may be poor')
      await expect(at(page, 'm-models-detail-thinking')).toBeVisible()
      await expect(at(page, 'm-models-detail-tools')).toHaveCount(0)
      await expect(at(page, 'm-models-detail-memory')).toContainText('1.3 GB')
      await expect(at(page, 'm-models-detail-context')).toContainText('Up to 4K on this phone')
      // Where the model comes from and its license belong to the model too (round 10, point 7).
      await expect(at(page, 'm-models-detail-source')).toContainText('unsloth/Qwen3.5-2B-GGUF')
      await expect(at(page, 'm-models-detail-source')).toContainText('This file is another build of it.')
      await expect(at(page, 'm-models-detail-license')).toContainText('apache-2.0')
      await expect(at(page, 'm-models-detail-hf')).toHaveAttribute('data-m-risk', 'leaves-app')
      await expect(at(page, 'm-models-detail-hf')).toContainText('Opens huggingface.co in your browser')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-models-detail-hf').tap()
      expect((await page.evaluate(() => (window as any).__M.opened as string[])).at(-1)).toBe('https://huggingface.co/unsloth/Qwen3.5-2B-GGUF')
      await at(page, 'm-page-back').tap()

      // A load that lasts. A tap on "Use in chat" of the other model is kept and said, not dropped.
      await mock(page).set({ loadMs: 2500 })
      await small.getByTestId('m-models-use').tap()
      await expect(small.getByTestId('m-models-load')).toHaveAttribute('aria-busy', 'true')
      await expect(card.getByTestId('m-models-use')).toBeEnabled()
      await card.getByTestId('m-models-use').tap()
      await expect(card.getByTestId('m-models-item-queued')).toContainText(`Loads after ${SMALL.name}`)
      await expect(card.getByTestId('m-models-use')).toBeDisabled()
      expect(await layoutOf(page)).toEqual(CLEAN)
      // It runs by itself once the first load is through, and it is the model the user ends up with.
      await expect(at(page, 'm-toast-chat-model')).toContainText('Qwen 3.5 2B IQ2_M is now the chat model', { timeout: 15_000 })
      await expect(card).toContainText('Chat model')
      await expect(card.getByTestId('m-models-item-queued')).toHaveCount(0)
      await expect(card).toHaveAttribute('data-state', 'loaded')
      expect(await mock(page).loaded()).toContain(`${variant}.gguf`)
      expect(errors().filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::/.test(e))).toEqual([])
    })

    test('the catalogue card names the packing that is on the phone or on its way (G11)', async ({ page }) => {
      const errors = watchErrors(page)
      // The case of the large iPhone: Qwen 3.5 2B is there in its smallest packing only.
      const qwen = MOBILE_CHAT_MODELS.find((m) => /^qwen3\.5-2b-q4_k_m/i.test(m.filename))!
      const xxs = 'Qwen3.5-2B-UD-IQ2_XXS'
      await start(page, { device: 'android:8', mock: { installed: [{ filename: `${xxs}.gguf`, bytes: Math.round(732.7 * MIB) }], hold: true } })
      await openModels(page)
      const card = page.locator(`[data-m-id="${qwen.id}"]:visible`).filter({ has: page.getByTestId('m-models-item-open') })
      await expect(card).toHaveCount(1)
      // It does not offer the full download as if nothing were there. It says which packing is, and acts on that file.
      await expect(card.getByTestId('m-models-item-installed')).toContainText('Installed: IQ2_XXS, 732.7 MB')
      await expect(card.getByTestId('m-models-download')).toHaveCount(0)
      await expect(card.getByTestId('m-models-use')).toBeVisible()
      expect(await layoutOf(page)).toEqual(CLEAN)
      await card.getByTestId('m-models-use').tap()
      await expect(at(page, 'm-toast-chat-model')).toContainText('Qwen 3.5 2B IQ2_XXS is now the chat model')
      expect(await mock(page).loaded()).toContain(`${xxs}.gguf`)

      // Another model, whose packing is on its way: the card shows that download, with its name.
      const other = MOBILE_CHAT_MODELS.find((m) => m.id !== qwen.id && m.id !== SMALL.id && /q4_k_m/i.test(m.filename))!
      const packing = other.filename.replace(/q4_k_m/i, 'IQ3_XXS')
      await page.evaluate(async (id) => {
        const spec = '/src/stores/downloadStore.ts'
        const mod = await import(/* @vite-ignore */ spec)
        // In `ownRows` as well, as the app writes a row of its own: the next poll rebuilds `downloads` from
        // `ownRows` plus what the native side reports, and a row in `downloads` alone was gone whenever that
        // poll came before the card was looked at (CI-like run without retries: 4 of 10 red).
        const { downloads, ownRows } = mod.useDownloadStore.getState()
        const row = { id, filename: id, progress: 40_000_000, total: 400_000_000, speed: 0, status: 'paused' }
        mod.useDownloadStore.setState({ downloads: { ...downloads, [id]: row }, ownRows: { ...ownRows, [id]: row } })
      }, packing)
      const loading = page.locator(`[data-m-id="${other.id}"]:visible`).filter({ has: page.getByTestId('m-models-item-open') })
      await loading.scrollIntoViewIfNeeded()
      await expect(loading.getByTestId('m-models-item-packing-loading')).toContainText('Downloading IQ3_XXS')
      await expect(loading.getByTestId('m-models-transfer')).toHaveAttribute('data-m-id', packing)
      await expect(loading.getByTestId('m-models-download')).toHaveCount(0)
      expect(await layoutOf(page)).toEqual(CLEAN)
      expect(errors().filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::/.test(e))).toEqual([])
    })

    test('"Use in chat" says where the model is used now: one tap on the toast opens a new chat with it (G10)', async ({ page }) => {
      const errors = watchErrors(page)
      await start(page, { device: 'android:8', mock: { installed: [{ filename: SMALL.filename, bytes: SMALL.sizeBytes }] } })
      await openModels(page)
      await at(page, 'm-models-segment-installed').tap()
      await at(page, 'm-models-use').tap()
      const said = at(page, 'm-toast-chat-model')
      await expect(said).toContainText(`${SMALL.name} is now the chat model`)
      expect(await layoutOf(page)).toEqual(CLEAN)
      await said.getByRole('button', { name: 'New chat' }).tap()
      await expect(at(page, 'm-chat-screen')).toBeVisible()
      await expect(at(page, 'm-chat-screen').getByTestId('m-chat-model')).toContainText(SMALL.name)
      await expect(at(page, 'm-chat-screen').getByTestId('m-chat-empty-model')).toContainText(SMALL.name)
      // Back leads to the list of chats, not to a page that is gone.
      await at(page, 'm-page-back').tap()
      await expect(at(page, 'm-chats-screen')).toBeVisible()
      expect(errors().filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::/.test(e))).toEqual([])
    })

    test('engine notices: pick another model, dismiss what the chat reported, document step without a network', async ({ page, context }) => {
      const errors = watchErrors(page)
      await start(page, { device: 'android:8', mock: { installed: [{ filename: SMALL.filename, bytes: SMALL.sizeBytes }], loadError: 'The model file is damaged.' } })
      await openModels(page)
      await at(page, 'm-models-segment-installed').tap()
      await at(page, 'm-models-use').tap()
      // "Use in chat" could not load it: said, with the way to the engine page.
      await at(page, 'm-toast-load-failed').getByRole('button', { name: 'Details' }).tap()
      await expect(at(page, 'm-settings-engine-notice-failed')).toBeVisible()
      await at(page, 'm-settings-engine-notice-pick').first().tap()
      await expect(at(page, 'm-models-screen')).toBeVisible()

      // A failure the chat itself announced (logic layer) shows up on the engine page and can be put away.
      await page.evaluate(async () => {
        const spec = '/src/stores/luEngineSwitchStore.ts'
        const mod = await import(/* @vite-ignore */ spec)
        mod.useLuEngineSwitchStore.getState().announce('The model could not be loaded for this chat.', 'error')
      })
      await restartKeepingMemory(page, '/settings/engine')
      await expect(at(page, 'm-settings-engine-notice-failed')).toContainText('The model could not be loaded for this chat.')
      expect(await layoutOf(page)).toEqual(CLEAN)
      await at(page, 'm-settings-engine-notice-dismiss').tap()
      await expect(at(page, 'm-settings-engine-notice-failed')).toHaveCount(0)

      // A3 without a network (reached through the flow of a fresh phone).
      await page.evaluate(() => {
        const disk = (window as any).__M.disk
        disk.onboarding = false
        localStorage.setItem('e2e-models-disk', JSON.stringify(disk))
        localStorage.removeItem('lu-settings')
      })
      await page.evaluate(async () => {
        const spec = '/src/mobile/nav/index.ts'
        const mod = await import(/* @vite-ignore */ spec)
        mod.nav.startFlow('onboarding')
        mod.nav.push('/setup/model')
        mod.nav.push('/setup/documents')
      })
      await expect(at(page, 'm-onboarding-documents-install')).toBeEnabled()
      await context.setOffline(true)
      await expect(at(page, 'm-onboarding-documents-offline')).toContainText('No internet. You need a connection once to install the document model.')
      await expect(at(page, 'm-onboarding-documents-install')).toBeDisabled()
      expect(await layoutOf(page)).toEqual(CLEAN)
      await context.setOffline(false)
      await expect(at(page, 'm-onboarding-documents-install')).toBeEnabled()
      expect(errors().filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::/.test(e))).toEqual([])
    })
  })
}

// Check on the iPhone, round 22, N14: in the customer flow the tap on the tab "Chat" right after "Use in chat" did
// nothing in three of six runs. Asked here of the page itself: from the tap on "Use in chat" until the toast has
// gone, on every frame, what lies on the tab "Chat", and does a tap at once land in the chat.
test.describe('N14: nothing lies over the tab bar after "Use in chat"', () => {
  const variant = 'Qwen3.5-2B-UD-IQ2_M'
  const cases = [
    { name: '402x874', width: 402, height: 874, fontScale: undefined as number | undefined },
    { name: '375x667', width: 375, height: 667, fontScale: undefined as number | undefined },
    { name: '320x568 at 200 percent', width: 320, height: 568, fontScale: 200 },
  ]
  for (const size of cases) {
    for (const loadMs of [0, 900]) {
      test(`${size.name}, a load of ${loadMs} ms: the tab "Chat" is the top element on every frame, and a tap at once opens the chat`, async ({ page }) => {
        await page.setViewportSize({ width: size.width, height: size.height })
        await start(page, { device: 'android:8', fontScale: size.fontScale, mock: { installed: [{ filename: SMALL.filename, bytes: SMALL.sizeBytes }, { filename: `${variant}.gguf`, bytes: 820 * MIB }] } })
        await openModels(page)
        await at(page, 'm-models-segment-installed').tap()
        const first = page.locator(`[data-testid="m-models-item"][data-m-id="${SMALL.id}"]:visible`)
        const second = page.locator(`[data-testid="m-models-item"][data-m-id="file:${variant}"]:visible`)
        // The first model is the chat model, as in the customer flow. Then the toast of that step is waited out.
        await first.getByTestId('m-models-use').tap()
        await expect(at(page, 'm-toast-chat-model')).toContainText(`${SMALL.name} is now the chat model`)
        await expect(at(page, 'm-toast-chat-model')).toHaveCount(0, { timeout: 10_000 })
        if (loadMs) await mock(page).set({ loadMs })

        // Watch the tab on every frame: who is the top element at its middle, at its upper and at its lower edge.
        await page.evaluate(() => {
          const w = window as unknown as { __TAB_WATCH__: { frames: number; covered: string[]; stop: boolean } }
          const watch = (w.__TAB_WATCH__ = { frames: 0, covered: [] as string[], stop: false })
          const look = () => {
            if (watch.stop) return
            const tab = document.querySelector('[data-testid="m-nav-chat"]')
            if (tab) {
              const r = tab.getBoundingClientRect()
              for (const [name, y] of [['middle', (r.top + r.bottom) / 2], ['top', r.top + 3], ['bottom', r.bottom - 3]] as const) {
                const hit = document.elementFromPoint((r.left + r.right) / 2, y)
                if (!hit || !tab.contains(hit)) {
                  const who = hit ? `${hit.tagName.toLowerCase()}.${String(hit.className).replace(/\s+/g, '.')}[${hit.getAttribute('data-testid') ?? ''}]` : 'nothing'
                  const line = `${name}: ${who}`
                  if (!watch.covered.includes(line)) watch.covered.push(line)
                }
              }
              if (tab.closest('[inert]')) {
                if (!watch.covered.includes('inert')) watch.covered.push('inert')
              }
            } else if (!watch.covered.includes('no tab bar')) {
              watch.covered.push('no tab bar')
            }
            watch.frames += 1
            requestAnimationFrame(look)
          }
          requestAnimationFrame(look)
        })

        await second.getByTestId('m-models-use').tap()
        // Until the model is the chat model and its toast has come and gone.
        await expect(at(page, 'm-toast-chat-model')).toContainText('Qwen 3.5 2B IQ2_M is now the chat model', { timeout: 15_000 })
        await expect(at(page, 'm-toast-chat-model')).toHaveCount(0, { timeout: 10_000 })
        const seen = await page.evaluate(() => {
          const w = window as unknown as { __TAB_WATCH__: { frames: number; covered: string[]; stop: boolean } }
          w.__TAB_WATCH__.stop = true
          return w.__TAB_WATCH__
        })
        expect(seen.frames).toBeGreaterThan(60)
        expect(seen.covered, `over the tab "Chat" on ${seen.frames} frames`).toEqual([])

        // And the tap itself, with no pause after "Use in chat": while the model loads, and the moment its toast shows.
        await first.getByTestId('m-models-use').tap()
        await at(page, 'm-nav-chat').tap()
        await expect(at(page, 'm-nav-chat')).toHaveAttribute('aria-selected', 'true')
        await expect(at(page, 'm-chats-screen').or(at(page, 'm-chat-screen')).first()).toBeVisible()
        await at(page, 'm-nav-models').tap()
        await expect(at(page, 'm-toast-chat-model')).toHaveCount(0, { timeout: 10_000 })
        await second.getByTestId('m-models-use').tap()
        await expect(at(page, 'm-toast-chat-model')).toBeVisible({ timeout: 15_000 })
        await at(page, 'm-nav-chat').tap()
        await expect(at(page, 'm-nav-chat')).toHaveAttribute('aria-selected', 'true')
      })
    }
  }
})

test.describe('models and onboarding 320x568 at 200 percent', () => {
  test.use({ viewport: { width: 320, height: 568 } })

  const footHeight = (page: Page) => page.evaluate(() => Math.round(Array.from(document.querySelectorAll('.m-foot')).filter((el) => (el as HTMLElement).offsetParent !== null).at(-1)?.getBoundingClientRect().height ?? 0))

  test('onboarding: the footer keeps only its main button, progress and Skip stand in the page', async ({ page }) => {
    const errors = watchErrors(page)
    await start(page, { skipOnboarding: false, fontScale: 200, device: 'android:8', mock: { hold: true } })
    await at(page, 'm-onboarding-next').tap()
    await expect(at(page, 'm-onboarding-model-screen')).toBeVisible()
    await expect(at(page, 'm-onboarding-model-recommended')).toHaveAttribute('aria-checked', 'true')

    // Pick: one button in the footer. Skip is in the page, above the list, and still leads on.
    await expect(at(page, 'm-onboarding-download')).toBeVisible()
    await expect(page.locator('.m-foot [data-testid="m-onboarding-skip"]')).toHaveCount(0)
    await expect(page.locator('.m-foot [data-testid="m-onboarding-download"]:visible')).toHaveCount(1)
    await expect(at(page, 'm-onboarding-model-aside').locator('[data-testid="m-onboarding-skip"]')).toBeVisible()
    expect(await footHeight(page)).toBeLessThan(568 * 0.34)
    expect(await layoutOf(page)).toEqual(CLEAN)

    // Downloading: the bar with Pause and Cancel is in the page, the footer holds Continue and nothing scrolls inside it.
    await at(page, 'm-onboarding-download').tap()
    await expect(at(page, 'm-onboarding-progress')).toBeVisible()
    await expect(page.locator('.m-foot [data-testid="m-onboarding-progress"]')).toHaveCount(0)
    await expect(page.locator('.m-foot [data-testid="m-onboarding-next"]:visible')).toHaveCount(1)
    expect(await footHeight(page)).toBeLessThan(568 * 0.3)
    const inFoot = await page.evaluate(() => {
      const foot = Array.from(document.querySelectorAll('.m-foot')).filter((el) => (el as HTMLElement).offsetParent !== null).at(-1)
      const box = foot?.firstElementChild as HTMLElement | undefined
      return box ? box.scrollHeight <= box.clientHeight + 1 : false
    })
    expect(inFoot).toBe(true)
    await mock(page).set({ hold: false, step: 0.1 })
    await at(page, 'm-onboarding-pause').tap()
    await expect(at(page, 'm-onboarding-transfer')).toHaveAttribute('data-state', 'paused')
    expect(await layoutOf(page)).toEqual(CLEAN)
    await at(page, 'm-onboarding-cancel').tap()
    await at(page, 'm-dialog-confirm').tap()
    await expect(at(page, 'm-onboarding-download')).toBeVisible()

    // Skip from the page.
    await at(page, 'm-onboarding-skip').tap()
    await expect(at(page, 'm-onboarding-documents-screen')).toBeVisible()
    expect(errors()).toEqual([])
  })

  // Acceptance on the small iPhone (round 5, N3): at the largest text the notice ended in the middle of its
  // sentence, the last line half cut, and the transcript began right under the cut. The sizes of that phone.
  test('chat: the processor notice wraps, pushes the transcript and can be closed', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    const errors = watchErrors(page)
    await start(page, { fontScale: 200, device: 'android:8', route: '/chat/new', mock: { installed: [{ filename: SMALL.filename, bytes: SMALL.sizeBytes }], loaded: SMALL.filename, accelerator: 'cpu', cpuOnly: true } })
    const notice = at(page, 'm-chat-screen').getByTestId('m-engine-notice-cpu')
    await expect(notice).toBeVisible({ timeout: 15_000 })
    await expect(notice).toContainText('Graphics acceleration is not available. LU is running on the processor, which is slower.')
    const geo = await notice.evaluate((el) => {
      const banners = el.closest('.m-banners') as HTMLElement
      const text = el.querySelector('.m-grow') as HTMLElement
      const b = banners.getBoundingClientRect()
      const t = text.getBoundingClientRect()
      const body = (banners.nextElementSibling as HTMLElement).getBoundingClientRect()
      return {
        // Nothing of the notices is cut: what they need is what they have.
        cut: banners.scrollHeight - banners.clientHeight,
        textInside: t.top >= b.top - 1 && t.bottom <= b.bottom + 1,
        // The page starts under the notices.
        gap: Math.round(body.top - b.bottom),
        // The sentence has the line, the buttons stand under it.
        textShare: t.width / b.width,
      }
    })
    expect(geo.cut).toBeLessThanOrEqual(1)
    expect(geo.textInside).toBe(true)
    expect(geo.gap).toBeGreaterThanOrEqual(0)
    expect(geo.textShare).toBeGreaterThan(0.6)
    await page.screenshot({ path: test.info().outputPath('r5-processor-notice-largest-text.png') })
    // Closing it keeps the chat open and the notice gone.
    await notice.getByTestId('m-engine-notice-cpu-dismiss').tap()
    await expect(at(page, 'm-chat-screen').getByTestId('m-engine-notice-cpu')).toHaveCount(0)
    await expect(at(page, 'm-chat-screen')).toBeVisible()
    expect(errors()).toEqual([])
  })

  // Acceptance on the large iPhone (round 6, G6): on its side and at the largest text the notice lay on the
  // heading of the empty chat. The sizes of the large and of the small iPhone on their side.
  for (const land of [{ width: 956, height: 440 }, { width: 667, height: 375 }]) {
    test(`chat on its side ${land.width}x${land.height}: the processor notice never lies on the empty chat`, async ({ page }) => {
      await page.setViewportSize(land)
      const errors = watchErrors(page)
      await start(page, { fontScale: 200, device: 'android:8', route: '/chat/new', mock: { installed: [{ filename: SMALL.filename, bytes: SMALL.sizeBytes }], loaded: SMALL.filename, accelerator: 'cpu', cpuOnly: true } })
      const screen = at(page, 'm-chat-screen')
      const notice = screen.getByTestId('m-engine-notice-cpu')
      await expect(notice).toBeVisible({ timeout: 15_000 })
      await expect(screen.getByTestId('m-chat-empty')).toBeVisible()
      // The toast about the processor passes. What stays is the notice line and the page under it.
      await expect(page.locator('[data-testid^="m-toast-"]')).toHaveCount(0, { timeout: 15_000 })
      const geo = await notice.evaluate((el) => {
        const banners = el.closest('.m-banners') as HTMLElement
        const page = banners.closest('.m-page') as HTMLElement
        const b = banners.getBoundingClientRect()
        const empty = page.querySelector('[data-testid="m-chat-empty"]') as HTMLElement
        const title = (empty.querySelector('h1, h2, h3, .m-empty-title') ?? empty) as HTMLElement
        const t = title.getBoundingClientRect()
        const body = page.querySelector('.m-body') as HTMLElement
        const bodyBox = body.getBoundingClientRect()
        const composer = page.querySelector('.m-composer') as HTMLElement
        const c = composer.getBoundingClientRect()
        // What is drawn at the middle of the heading: the heading itself, or something that lies on it.
        const top = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2)
        return {
          bannerBottom: Math.round(b.bottom),
          bannerCut: banners.scrollHeight - banners.clientHeight,
          titleTop: Math.round(t.top),
          titleBottom: Math.round(t.bottom),
          bodyTop: Math.round(bodyBox.top),
          bodyBottom: Math.round(bodyBox.bottom),
          scrolled: Math.round(body.scrollTop),
          bodyRoom: Math.round(body.clientHeight),
          bodyScrolls: body.scrollHeight - body.clientHeight,
          composerTop: Math.round(c.top),
          titleOnTop: !!top && (title === top || title.contains(top)),
          viewport: window.innerHeight,
        }
      })
      await page.screenshot({ path: test.info().outputPath(`r6-notice-on-its-side-${land.width}.png`) })
      // The page starts under the notices, and the heading of the empty chat is drawn in the page, not under a notice.
      expect(geo.bodyTop).toBeGreaterThanOrEqual(geo.bannerBottom)
      expect(geo.scrolled).toBe(0)
      expect(geo.titleTop).toBeGreaterThanOrEqual(geo.bannerBottom)
      // The whole heading is in the page: not under the notice, not under the text field.
      expect(geo.titleBottom).toBeLessThanOrEqual(geo.bodyBottom)
      expect(geo.titleBottom).toBeLessThanOrEqual(geo.composerTop)
      expect(geo.titleOnTop).toBe(true)
      expect(await layoutOf(page)).toEqual(CLEAN)
      expect(errors()).toEqual([])
    })
  }

  test('search field: a placeholder that fits, and a line that names the source', async ({ page }) => {
    const errors = watchErrors(page)
    await start(page, { fontScale: 200, device: 'android:8' })
    await openModels(page)
    const field = at(page, 'm-models-search')
    await expect(field).toHaveAttribute('placeholder', 'Search')
    await expect(at(page, 'm-models-screen')).toContainText('Finds models on Hugging Face in the file format LU runs.')
    // The placeholder is not wider than the room the field gives it.
    const fits = await field.evaluate((el) => {
      const input = el as HTMLInputElement
      const style = getComputedStyle(input)
      const canvas = document.createElement('canvas').getContext('2d')!
      canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const room = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      return canvas.measureText(input.placeholder).width <= room
    })
    expect(fits).toBe(true)
    expect(await layoutOf(page)).toEqual(CLEAN)
    await field.fill('tiny')
    await expect(at(page, 'm-models-hits').locator('[data-testid="m-models-item"]').first()).toBeVisible({ timeout: 10_000 })
    expect(errors()).toEqual([])
  })
})

test.describe('onboarding proposal on the phone', () => {
  test('the smallest class gets a model that answers, marked tight, and the download asks first', async ({ page }) => {
    const errors = watchErrors(page)
    await start(page, { skipOnboarding: false, device: 'android:3', mock: { hold: true, ramGb: 3 } })
    await at(page, 'm-onboarding-next').tap()
    // Not SmolLM2 360M (it fits comfortably and answers wrongly), but the smallest model that answers correctly.
    expect(await proposalId(page)).toBe('qwen3.5-0.8b')
    const card = at(page, 'm-onboarding-model-card').filter({ has: page.locator('[data-testid="m-onboarding-model-recommended"]') })
    await expect(card.locator('[data-testid="m-onboarding-model-fit"]')).toContainText('Tight')
    await expect(at(page, 'm-onboarding-model-card').first()).toHaveAttribute('data-m-id', 'qwen3.5-0.8b')
    await at(page, 'm-onboarding-download').tap()
    await expect(at(page, 'm-dialog-tight-fit')).toBeVisible()
    await at(page, 'm-dialog-confirm').tap()
    await expect(at(page, 'm-onboarding-progress')).toBeVisible()
    // The other kind on the same phone: a proposal that fits.
    await at(page, 'm-onboarding-cancel').tap()
    await at(page, 'm-dialog-confirm').tap()
    await at(page, 'm-onboarding-model-segment-unfiltered').tap()
    expect(await proposalId(page)).toBe('qwen2.5-0.5b-abliterated')
    expect(errors()).toEqual([])
  })

  test('a build without the unfiltered catalogue proposes a model that is not listed as unfiltered', async ({ page }) => {
    const errors = watchErrors(page)
    await declareAdult(page)
    await start(page, { skipOnboarding: false, store: 'appstore', device: 'ios:8' })
    await at(page, 'm-onboarding-next').tap()
    await expect(at(page, 'm-onboarding-model-segment')).toHaveCount(0)
    expect(await proposalId(page)).toBe('qwen3-1.7b')
    const ids = await at(page, 'm-onboarding-model-card').evaluateAll((cards) => cards.map((c) => c.getAttribute('data-m-id') ?? ''))
    expect(ids.length).toBeGreaterThan(3)
    expect(ids.filter((id) => /abliterated|dolphin|uncensored/.test(id))).toEqual([])
    expect(errors()).toEqual([])
  })
})


/**
 * Screenshots of every page and dialog of the strand, for looking at them.
 * Not part of a normal run: it writes images into the repo.
 */
const SHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../mobile-docs/design/strang-shots/models')

const VARIANTS = [
  { name: '390x844-dark', width: 390, height: 844, theme: 'dark', fs: 100 },
  { name: '390x844-light', width: 390, height: 844, theme: 'light', fs: 100 },
  { name: '320x568-light-200', width: 320, height: 568, theme: 'light', fs: 200 },
  { name: '844x390-landscape', width: 844, height: 390, theme: 'dark', fs: 100 },
] as const

test.describe('models screenshots', () => {
  test.skip(!process.env.LU_MODELS_SHOTS, 'set LU_MODELS_SHOTS=1 to write the screenshots')
  test.use({ deviceScaleFactor: 1 })

  for (const v of VARIANTS) {
    test(`shots ${v.name}`, async ({ page, context }) => {
      test.setTimeout(300_000)
      const problems: string[] = []
      const shot = async (view: string) => {
        await screensLoaded(page)
        await page.evaluate(async () => {
          await document.fonts.ready
          const finite = document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
          await Promise.all(finite.map((a) => a.finished.catch(() => undefined)))
        })
        await page.waitForTimeout(450)
        const layout = await measureLayout(page)
        if (layout.overflow.length || layout.small.length || layout.pageScrolls) problems.push(`${view}: ${JSON.stringify(layout)}`)
        await page.screenshot({ path: path.join(SHOTS, `${v.name}--${view}.png`) })
      }
      const hold = (on: boolean, step = 0.2) => mock(page).set({ hold: on, step })
      const partial = async () => expect.poll(async () => Object.values((await mock(page).disk()).partials)[0] ?? 0, { timeout: 15_000 }).toBeGreaterThan(0)
      await page.setViewportSize({ width: v.width, height: v.height })
      const look = { theme: v.theme, fontScale: v.fs }

      // Onboarding.
      await start(page, { ...look, skipOnboarding: false, device: 'android:8', mock: { hold: true } })
      await shot('a1-welcome')
      await at(page, 'm-onboarding-next').tap()
      await expect(at(page, 'm-onboarding-model-recommended')).toBeVisible()
      await shot('a2-pick')
      await at(page, 'm-onboarding-download').tap()
      await hold(false)
      await partial()
      await hold(true)
      await shot('a2-downloading')
      await at(page, 'm-onboarding-pause').tap()
      await expect(at(page, 'm-onboarding-transfer')).toHaveAttribute('data-state', 'paused')
      await shot('a2-paused')
      await at(page, 'm-onboarding-next').tap()
      await shot('a3-documents')
      await at(page, 'm-onboarding-skip').tap()
      await shot('a4-done-paused')
      await at(page, 'm-page-back').tap()
      await at(page, 'm-page-back').tap()
      await at(page, 'm-onboarding-cancel').tap()
      await at(page, 'm-dialog-confirm').tap()
      await page.evaluate(() => {
        const M = (window as any).__M
        M.hold = false
        M.step = 0.4
        M.fail = { at: 0.3, error: 'error sending request: connection reset' }
      })
      await at(page, 'm-onboarding-download').tap()
      await expect(at(page, 'm-onboarding-error')).toBeVisible({ timeout: 15_000 })
      await shot('a2-interrupted')
      await at(page, 'm-onboarding-resume').tap()
      await expect(at(page, 'm-onboarding-model-ready')).toBeVisible({ timeout: 20_000 })
      await page.waitForTimeout(3200)
      await shot('a2-installed')
      await at(page, 'm-onboarding-next').tap()
      await at(page, 'm-onboarding-skip').tap()
      await shot('a4-done-ready')
      await at(page, 'm-onboarding-done').tap()
      await expect(at(page, 'm-chat-screen')).toBeVisible()

      // Models on a small phone.
      await page.evaluate(() => {
        localStorage.setItem('e2e-device', 'android:4')
        ;(window as any).__M.disk.files['Qwen3-0.6B-Q4_K_M.gguf'] = 396_705_472
        localStorage.setItem('e2e-models-disk', JSON.stringify((window as any).__M.disk))
      })
      await restart(page, look)
      await hold(true)
      await openModels(page)
      await shot('m1-get-new')
      await at(page, 'm-models-filter-fits').tap()
      await at(page, 'm-models-item-toolarge').first().scrollIntoViewIfNeeded()
      await shot('m1-too-large')
      await at(page, 'm-models-item-toolarge').first().getByTestId('m-models-item-open').tap()
      await shot('m2-too-large')
      await at(page, 'm-page-back').tap()
      await at(page, 'm-models-filter-fits').tap()

      // A running download, a broken one, a tight one.
      const open = at(page, 'm-models-item').filter({ has: page.locator('[data-testid="m-models-download"]') })
      await open.first().scrollIntoViewIfNeeded()
      await open.first().getByTestId('m-models-download').tap()
      await hold(false)
      await partial()
      await hold(true)
      await at(page, 'm-models-progress').first().scrollIntoViewIfNeeded()
      await shot('m1-downloading')
      await page.evaluate(() => {
        const M = (window as any).__M
        M.fail = { at: 0.1, error: 'Not enough free space for {file}. It still needs 1.4 GB and the drive has 0.0 GB free' }
        M.hold = false
        M.step = 0.3
      })
      await expect(at(page, 'm-models-error')).toBeVisible({ timeout: 15_000 })
      await hold(true)
      await at(page, 'm-models-error').scrollIntoViewIfNeeded()
      await shot('m1-error-storage')
      await open.first().scrollIntoViewIfNeeded()
      await open.first().getByTestId('m-models-download').tap()
      if (await at(page, 'm-dialog-tight-fit').count()) {
        await shot('m1-tight-dialog')
        await at(page, 'm-dialog-confirm').tap()
      }
      await hold(false, 0.15)
      await page.waitForTimeout(2500)
      await hold(true)
      await at(page, 'm-models-downloads').tap()
      await expect(at(page, 'm-models-downloads-screen')).toBeVisible()
      await shot('m3-downloads')
      await at(page, 'm-page-back').tap()

      // Installed, detail, delete.
      await at(page, 'm-models-segment-installed').tap()
      await at(page, 'm-models-load').first().tap()
      await expect(at(page, 'm-toast-loaded')).toBeVisible()
      await at(page, 'm-models-use').first().tap()
      await expect(at(page, 'm-toast-chat-model')).toBeVisible()
      await page.waitForTimeout(3300)
      await shot('m1-installed')
      await at(page, 'm-models-item-open').first().tap()
      await shot('m2-installed')
      await at(page, 'm-models-detail-delete').scrollIntoViewIfNeeded()
      await shot('m2-installed-end')
      await at(page, 'm-models-detail-delete').tap()
      await shot('g3-delete-loaded')
      await at(page, 'm-dialog-cancel').tap()
      await at(page, 'm-page-back').tap()

      // Storage dialog.
      await page.evaluate(() => {
        ;(window as any).__M.disk.free = 200 * 1_048_576
      })
      await at(page, 'm-models-segment-new').tap()
      await open.first().scrollIntoViewIfNeeded()
      await open.first().getByTestId('m-models-download').tap()
      if (await at(page, 'm-dialog-tight-fit').count()) await at(page, 'm-dialog-confirm').tap()
      await expect(at(page, 'm-dialog-storage-full')).toBeVisible()
      await shot('g9-storage-full')
      await at(page, 'm-dialog-cancel').tap()

      // Benchmark, engine, storage.
      await at(page, 'm-models-segment-installed').tap()
      await at(page, 'm-models-benchmark').scrollIntoViewIfNeeded()
      await at(page, 'm-models-benchmark').tap()
      await at(page, 'm-models-benchmark-run').tap()
      await expect(at(page, 'm-models-benchmark-accuracy')).toBeVisible({ timeout: 20_000 })
      await expect(at(page, 'm-models-benchmark-run')).toBeVisible({ timeout: 20_000 })
      await at(page, 'm-models-benchmark-result-toggle').tap()
      await shot('m4-benchmark')
      await at(page, 'm-page-back').tap()
      await at(page, 'm-models-storage').scrollIntoViewIfNeeded()
      await at(page, 'm-models-storage').tap()
      await shot('e14-storage')
      await at(page, 'm-settings-storage-cache-clear').scrollIntoViewIfNeeded()
      await shot('e14-storage-end')
      await mock(page).set({ accelerator: 'cpu', cpuOnly: true })
      await restart(page, { ...look, route: '/settings/engine' })
      await page.evaluate(() => {
        const M = (window as any).__M
        M.loaded = '/data/lu/models/Qwen3-0.6B-Q4_K_M.gguf'
        M.accelerator = 'cpu'
        M.cpuOnly = true
      })
      await expect(at(page, 'm-settings-engine-status')).toHaveAttribute('data-state', 'running', { timeout: 10_000 })
      await expect(at(page, 'm-settings-engine-notice-cpu')).toBeVisible({ timeout: 10_000 })
      await at(page, 'm-settings-engine-selftest').tap()
      await expect(at(page, 'm-settings-engine-selftest-result')).toBeVisible()
      await shot('e13-engine')
      await at(page, 'm-settings-engine-reset').scrollIntoViewIfNeeded()
      await shot('e13-engine-end')
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:memory-warning')))
      await expect(at(page, 'm-settings-engine-notice-unloaded')).toBeVisible()
      await at(page, 'm-settings-engine-notice-unloaded').scrollIntoViewIfNeeded()
      await shot('e13-engine-unloaded')
      await at(page, 'm-settings-engine-advanced').scrollIntoViewIfNeeded()
      await at(page, 'm-settings-engine-advanced').tap()
      await expect(at(page, 'm-settings-engine-advanced-screen')).toBeVisible()
      await shot('e13-advanced')
      await at(page, 'm-page-back').tap()
      await expect(at(page, 'm-settings-engine-screen')).toBeVisible()

      // Search, empty downloads, no network.
      await page.evaluate(() => {
        ;(window as any).__M.disk.free = 40 * 1_073_741_824
        localStorage.setItem('e2e-device', 'android:8')
      })
      await restart(page, look)
      await openModels(page)
      await at(page, 'm-models-search').fill('tiny')
      await expect(at(page, 'm-models-hits').locator('[data-testid="m-models-item"]').first()).toBeVisible({ timeout: 10_000 })
      await expect(at(page, 'm-models-hits').locator('[data-testid="m-models-item-fit"]').first()).toBeVisible({ timeout: 10_000 })
      await shot('m1-search')
      await at(page, 'm-models-hits').locator('[data-testid="m-models-item-open"]').first().tap()
      await expect(at(page, 'm-models-detail-variant').first()).toBeVisible()
      await shot('m2-search-hit')
      await at(page, 'm-page-back').tap()
      await at(page, 'm-models-search').fill('')
      await context.setOffline(true)
      await expect(at(page, 'm-models-offline')).toBeVisible()
      await shot('m1-offline')
      await context.setOffline(false)
      expect(problems).toEqual([])
    })
  }
})
