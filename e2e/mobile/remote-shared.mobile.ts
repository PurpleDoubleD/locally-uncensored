/**
 * A17: shared chats of the computer (CHATS-V1.md) on the phone, in a
 * browser without Tauri. The commands remote_sealed_* are answered by the
 * stand in of Rust (fakeSealed.ts), which talks to the stand in of the
 * desktop (fakeDesktop.ts with `sealed` and `chats`). Nothing leaves the
 * machine.
 *
 * Held here: the list of shared chats with "Working" and new messages, a
 * chat with its history and "Load earlier messages", the answer live, tool
 * and approval cards, Stop, a new chat on the computer, the line of the
 * connection and reconnecting by itself, the outbox across a lost
 * connection and a restart of the app, the sheet "Running on your computer".
 *
 *   LU_E2E_PORT=5293 LU_E2E_ONLY=remote-shared npx playwright test --project=mobile
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { startFakeDesktop, type FakeDesktop } from '../../src/mobile/remote/__tests__/fakeDesktop'
import { createFakeSealedPhone, type FakeSealedPhone } from '../../src/mobile/remote/__tests__/fakeSealed'
import { addFakeChat, fakeDesktopTypes } from '../../src/mobile/remote/__tests__/fakeDesktopChats'
import { CLOUD_PROBE, measureLayout, openShell, watchErrors } from './support'

const NET = 'https://quiet-river-lamp.trycloudflare.com'

interface Phone {
  sealed: FakeSealedPhone
  plain: string[]
  offline: boolean
}

function toDesk(desk: FakeDesktop, p: Phone, url: string): string {
  if (p.offline) throw new Error('remote_client_request: The desktop could not be reached.')
  const u = new URL(url)
  if (u.origin !== NET) throw new Error('remote_client_request: The desktop could not be reached.')
  return `${desk.url}${u.pathname}${u.search}`
}

async function phone(context: BrowserContext, desk: FakeDesktop): Promise<Phone> {
  const state: Phone = { sealed: null as unknown as FakeSealedPhone, plain: [], offline: false }
  state.sealed = createFakeSealedPhone(async (url, body) => {
    const res = await fetch(toDesk(desk, state, url), { method: 'POST', body: Buffer.from(body), headers: { 'content-type': 'application/octet-stream' } })
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()), headers: {} }
  })
  const secrets = new Map<string, string>()
  await context.route(CLOUD_PROBE, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '' }))
  await context.exposeFunction('__e2eSecret', (op: string, account: string, value?: string): string | null => {
    if (op === 'set') secrets.set(account, String(value ?? ''))
    if (op === 'delete') secrets.delete(account)
    return op === 'get' ? (secrets.get(account) ?? null) : null
  })
  await context.exposeFunction('__e2ePlain', async (args: { baseUrl: string; path: string; method: string; body: string | null }) => {
    state.plain.push(`${args.method} ${args.baseUrl}${args.path}`)
    const answer = await fetch(toDesk(desk, state, `${args.baseUrl}${args.path}`), { method: args.method, body: args.body ?? undefined })
    return { status: answer.status, body: answer.status === 204 ? '' : await answer.text(), refreshedToken: null, memoryRevoked: false }
  })
  await context.exposeFunction('__e2eSealed', async (cmd: string, args: Record<string, unknown>) => {
    try {
      return { ok: true, value: await state.sealed.invoke(cmd, args) }
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
      // Notices of the computer: only when a test sets the state of the system (else no question, as before).
      const notify = (window as unknown as { __e2eNotify?: { granted: boolean; needed: boolean; asked: boolean; systemSays: boolean; asks: number; settings: number } }).__e2eNotify
      if (notify && command.endsWith('remote_notify_permission')) {
        if (args.ask !== false && !notify.asked && !notify.granted) {
          notify.asks += 1
          notify.asked = true
          notify.granted = notify.systemSays
        }
        return { granted: notify.granted, needed: notify.needed, asked: notify.asked }
      }
      if (notify && command.endsWith('open_system_settings')) {
        notify.settings += 1
        return null
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

async function toRemoteHome(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { nav } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/nav/index.ts`)
    nav.resetTo('chat', [])
  })
  await page.getByTestId('m-chats-segment-remote').tap()
}

/** Pair over the QR code (internet); a computer that shares its chats leads back to their list. */
async function pair(page: Page, desk: FakeDesktop): Promise<void> {
  await page.addInitScript((qr) => {
    ;(window as unknown as { __e2eQr?: string }).__e2eQr = qr
  }, desk.sealed!.qrLink({ net: NET }))
  await openShell(page)
  await toRemoteHome(page)
  await page.getByTestId('m-remote-scan').tap()
  await page.getByTestId('m-remote-connect-submit').tap()
  await expect(page.getByTestId('m-remote-connected')).toBeVisible()
}

function nothingPlainOverTheInternet(p: Phone): void {
  for (const call of p.plain) expect(call).toBe(`GET ${NET}/remote-api/status`)
  for (const url of p.sealed.posts) expect(url.endsWith('/remote-api/sealed')).toBe(true)
}

let desk: FakeDesktop

test.beforeEach(async () => {
  desk = await startFakeDesktop({ sealed: true, chats: true })
  desk.chats!.holdMs = 1_500
  desk.chats!.stepMs = 60
})
test.afterEach(async () => {
  await desk.stop()
})

test.describe('Remote desktop with shared chats', () => {
  test('the list, a chat with its history, the answer live, a tool, what the desktop types', async ({ page, context }) => {
    const errors = watchErrors(page)
    const trip = addFakeChat(desk.chats!, { title: 'Plan the trip', history: 60 })
    trip.unread = 2
    const p = await phone(context, desk)
    await pair(page, desk)
    await expect(page.getByTestId('m-remote-screen').getByTestId('m-remote-line-text')).toHaveText('Connected over the internet')
    const row = page.getByTestId('m-remote-shared-row')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('Plan the trip')
    await expect(page.getByTestId('m-remote-shared-unread')).toHaveText('2')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await row.tap()
    await expect(page.getByTestId('m-remote-shared-thread')).toHaveAttribute('data-m-count', '50')
    await page.getByTestId('m-remote-shared-older').tap()
    await expect(page.getByTestId('m-remote-shared-thread')).toHaveAttribute('data-m-count', '60')
    expect(desk.chats!.reads).toContain(trip.id)

    desk.chats!.toolNext = { name: 'web_search', summary: 'flights to Lisbon' }
    desk.chats!.reply = 'Here are three flights to Lisbon on Friday.'
    await page.getByTestId('m-remote-shared-input').fill('find flights')
    await page.getByTestId('m-remote-shared-send').tap()
    await expect(page.getByTestId('m-remote-shared-live')).toBeVisible()
    await expect(page.locator('[data-testid="m-remote-shared-tool"][data-m-tool="web_search"]').first()).toBeVisible()
    await expect(page.getByTestId('m-remote-shared-answer').last()).toContainText('three flights to Lisbon', { timeout: 15_000 })
    await expect(page.getByTestId('m-remote-shared-live')).toHaveCount(0)
    await expect(page.locator('[data-testid="m-remote-shared-question"]', { hasText: 'find flights' })).toHaveCount(1)
    await page.screenshot({ path: test.info().outputPath('a17-shared-chat.png') })
    // Feinschliff: the tool stays under the answer, closed to one line, open for the details.
    const kept = page.getByTestId('m-remote-shared-answer').last().getByTestId('m-remote-shared-tool')
    await expect(kept).toHaveAttribute('data-m-state', 'done')
    await expect(kept.getByTestId('m-remote-shared-tool-head')).toContainText('Ran: Web search')
    await expect(kept.getByTestId('m-remote-shared-tool-detail')).toBeHidden()
    await kept.getByTestId('m-remote-shared-tool-head').tap()
    await expect(kept.getByTestId('m-remote-shared-tool-detail')).toContainText('web_search')
    await expect(kept.getByTestId('m-remote-shared-tool-detail')).toContainText('flights to Lisbon')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })

    fakeDesktopTypes(desk.chats!, trip, 'typed on the desk')
    await expect(page.locator('[data-testid="m-remote-shared-question"][data-m-from="desktop"]', { hasText: 'typed on the desk' })).toBeVisible()

    // Loaded again (LU closed and opened): the tool line is still there, from the history of the computer.
    await page.reload()
    await page.getByTestId('m-app').waitFor()
    await toRemoteHome(page)
    await page.getByTestId('m-remote-shared-row').tap()
    await expect(page.locator('[data-testid="m-remote-shared-tool"][data-m-tool="web_search"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="m-remote-shared-tool"][data-m-tool="web_search"]')).toHaveAttribute('data-m-state', 'done')
    nothingPlainOverTheInternet(p)
    expect(errors()).toEqual([])
  })

  test('approval card: Allow once, then Deny; Stop ends an answer', async ({ page, context }) => {
    const errors = watchErrors(page)
    addFakeChat(desk.chats!, { title: 'Build' })
    await phone(context, desk)
    await pair(page, desk)
    await page.getByTestId('m-remote-shared-row').tap()
    desk.chats!.approvalNext = { tool: 'shell_execute', summary: 'npm run build', detail: 'npm run build --silent' }
    await page.getByTestId('m-remote-shared-input').fill('build it')
    await page.getByTestId('m-remote-shared-send').tap()
    const card = page.locator('[data-testid="m-remote-shared-approval"][data-state="open"]')
    await expect(card).toBeVisible()
    await expect(card).toContainText('npm run build --silent')
    await page.screenshot({ path: test.info().outputPath('a17-approval.png') })
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await page.getByTestId('m-remote-shared-allow-once').tap()
    await expect(page.getByTestId('m-remote-shared-answer').last()).toContainText('Sure. Here is the plan.', { timeout: 15_000 })
    expect(desk.chats!.decisions.map((d) => d.decision)).toEqual(['once'])

    desk.chats!.approvalNext = { tool: 'file_write', summary: 'notes.md', detail: '' }
    await page.getByTestId('m-remote-shared-input').fill('write notes')
    await page.getByTestId('m-remote-shared-send').tap()
    await page.getByTestId('m-remote-shared-deny').tap()
    await expect(page.getByTestId('m-remote-shared-answer').last()).toContainText('I did not run it.')

    desk.chats!.stepMs = 400
    desk.chats!.reply = 'one two three four five six seven eight nine ten'
    await page.getByTestId('m-remote-shared-input').fill('count slowly')
    await page.getByTestId('m-remote-shared-send').tap()
    await expect(page.getByTestId('m-remote-shared-live')).toBeVisible()
    await page.getByTestId('m-remote-shared-stop').tap()
    await expect(page.getByTestId('m-remote-shared-live')).toHaveCount(0)
    expect(desk.chats!.stops.length).toBe(1)
    await expect(page.getByTestId('m-remote-shared-answer').last()).not.toContainText('ten')
    expect(errors()).toEqual([])
  })

  test('a new chat on the computer, and the sheet "Running on your computer" with Stop', async ({ page, context }) => {
    await phone(context, desk)
    await pair(page, desk)
    await page.getByTestId('m-remote-new-shared').tap()
    await page.getByTestId('m-remote-new-shared-model-1').tap()
    await page.getByTestId('m-remote-new-shared-code').tap()
    await expect(page.getByTestId('m-remote-shared-composer')).toBeVisible()
    expect(desk.chats!.chats[0].mode).toBe('code')
    desk.chats!.stepMs = 500
    await page.getByTestId('m-remote-shared-input').fill('refactor the parser')
    await page.getByTestId('m-remote-shared-send').tap()
    await expect(page.getByTestId('m-remote-shared-live')).toBeVisible()
    expect(desk.chats!.posts[0]).toMatchObject({ content: 'refactor the parser', model: 'lu-engine::Qwen3.5-9B-Q4_K_M' })
    await page.getByTestId('m-remote-shared-tasks').tap()
    const task = page.getByTestId('m-remote-task')
    await expect(task).toHaveCount(1)
    await expect(task).toContainText('New Chat')
    await page.getByTestId('m-remote-task-stop').tap()
    await expect(page.getByTestId('m-remote-tasks-empty')).toBeVisible({ timeout: 10_000 })
    expect(desk.chats!.stops).toEqual([desk.chats!.chats[0].id])
  })

  test('Feinschliff: a new chat shows as "New Chat", after the first message with the name the computer gives it', async ({ page, context }) => {
    desk.chats!.stepMs = 30
    // The computer names it a while after the answer (like a title the desktop makes from the first message).
    desk.chats!.titleAfterMs = 2_500
    await phone(context, desk)
    await pair(page, desk)
    await page.getByTestId('m-remote-new-shared').tap()
    await page.getByTestId('m-remote-new-shared-chat').tap()
    await expect(page.getByTestId('m-remote-shared-composer')).toBeVisible()
    await page.getByTestId('m-remote-shared-input').fill('Plan a weekend in Porto')
    await page.getByTestId('m-remote-shared-send').tap()
    await expect(page.getByTestId('m-remote-shared-answer').last()).toContainText('Sure', { timeout: 15_000 })
    await page.locator('.m-page:not([data-m-hidden]):not([data-m-exit])').getByTestId('m-page-back').tap()
    const row = page.getByTestId('m-remote-shared-row')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('Plan a weekend in Porto', { timeout: 15_000 })
  })

  test('Benachrichtigungen: once after pairing "Get notified when your computer is done?", Allow asks the system; not again', async ({ page, context }) => {
    await page.addInitScript(() => {
      // An Android phone: only there (and on an iPhone) LU talks to its native layer.
      Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', configurable: true })
      ;(window as unknown as { __e2eNotify: unknown }).__e2eNotify = { granted: false, needed: true, asked: false, systemSays: true, asks: 0, settings: 0 }
    })
    addFakeChat(desk.chats!, { title: 'Trip', history: 2 })
    await phone(context, desk)
    await pair(page, desk)
    const sheet = page.getByTestId('m-dialog-remote-notify')
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText('Get notified when your computer is done?')
    await expect(page.getByTestId('m-dialog-cancel')).toHaveText('Not now')
    await expect(page.locator('.m-page[data-m-exit]')).toHaveCount(0)
    await page.waitForTimeout(400)
    await page.screenshot({ path: test.info().outputPath('a17-notify-offer.png') })
    await page.getByTestId('m-dialog-confirm').tap()
    await expect(sheet).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __e2eNotify: { asks: number } }).__e2eNotify.asks)).toBe(1)
    // The first shared chat does not ask a second time.
    await page.getByTestId('m-remote-shared-row').tap()
    await expect(page.getByTestId('m-remote-shared-thread')).toBeVisible()
    await expect(sheet).toHaveCount(0)
    // Nor the next start, even where the system could still ask.
    await page.reload()
    await page.getByTestId('m-app').waitFor()
    await toRemoteHome(page)
    await expect(page.getByTestId('m-remote-shared-row')).toBeVisible()
    await page.waitForTimeout(800)
    await expect(sheet).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __e2eNotify: { asks: number } }).__e2eNotify.asks)).toBe(0)
  })

  test('Benachrichtigungen: the switch in Settings asks while the permission is missing; refused, a sentence and Open settings', async ({ page, context }) => {
    await page.addInitScript(() => {
      // Not now at the sheet before: the switch is the way to ask later.
      Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', configurable: true })
      localStorage.setItem('lu-remote-notices-offered', '1')
      ;(window as unknown as { __e2eNotify: unknown }).__e2eNotify = { granted: false, needed: true, asked: false, systemSays: false, asks: 0, settings: 0 }
    })
    await phone(context, desk)
    await pair(page, desk)
    await expect(page.getByTestId('m-dialog-remote-notify')).toHaveCount(0)
    const toSettings = () =>
      page.evaluate(async () => {
        const { nav } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/nav/index.ts`)
        nav.resetTo('settings', [{ route: '/settings/remote' }])
      })
    await toSettings()
    const sw = page.getByTestId('m-settings-remote-notices')
    // On in LU, but the phone does not show them yet: the switch says so.
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('m-settings-remote-notices-denied')).toHaveCount(0)
    await sw.tap()
    // The system asked, the user said no: a sentence and the way to the settings of the phone.
    await expect(page.getByTestId('m-settings-remote-notices-denied')).toContainText('turned off in the settings of your phone')
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(await page.evaluate(() => (window as unknown as { __e2eNotify: { asks: number } }).__e2eNotify.asks)).toBe(1)
    await page.getByTestId('m-settings-remote-notices-open-settings').tap()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __e2eNotify: { settings: number } }).__e2eNotify.settings)).toBe(1)
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await page.screenshot({ path: test.info().outputPath('a17-notify-denied.png') })
    // Allowed in the settings of the phone, back in LU: the switch is on.
    await page.evaluate(() => {
      const n = (window as unknown as { __e2eNotify: { granted: boolean } }).__e2eNotify
      n.granted = true
    })
    await toRemoteHome(page)
    await toSettings()
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('m-settings-remote-notices-denied')).toHaveCount(0)
  })

  test('Windows-Firewall: the computer says its Wi-Fi is blocked; over the internet the line says so', async ({ page, context }) => {
    desk.lanBlocked = true
    await phone(context, desk)
    await pair(page, desk)
    const line = page.getByTestId('m-remote-screen').getByTestId('m-remote-line')
    await expect(line.getByTestId('m-remote-line-text')).toHaveText('Connected over the internet')
    await expect(line.getByTestId('m-remote-line-lan-blocked')).toHaveText('Wi-Fi is blocked on your computer, see LU there')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await page.screenshot({ path: test.info().outputPath('a17-lan-blocked.png') })
  })

  test('Feinschliff: a very long model label is cut in the chip with an ellipsis, the list shows it whole', async ({ page, context }) => {
    const long = 'Qwen3.5 35B A3B Instruct Abliterated Heretic Uncensored Q4_K_M with a very long name (LU Engine)'
    desk.chats!.chatModels = { models: [{ name: 'lu-engine::long', label: long }], default: 'lu-engine::long' }
    const chat = addFakeChat(desk.chats!, { title: 'Long model' })
    chat.model = 'lu-engine::long'
    await page.setViewportSize({ width: 320, height: 568 })
    await phone(context, desk)
    await pair(page, desk)
    await page.getByTestId('m-remote-shared-row').tap()
    const chip = page.getByTestId('m-remote-shared-model')
    await expect(chip).toHaveAttribute('aria-label', new RegExp(long.replace(/[().]/g, '\\$&')))
    // Prompt v2: the chip is the settings button; the model is the bold first part of its summary.
    const name = chip.locator('.m-composer-tune-text b')
    const cut = await name.evaluate((el) => ({ cut: el.scrollWidth > el.clientWidth, ellipsis: getComputedStyle(el).textOverflow, right: el.getBoundingClientRect().right }))
    expect(cut).toMatchObject({ cut: true, ellipsis: 'ellipsis' })
    expect(cut.right).toBeLessThanOrEqual(320)
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await page.screenshot({ path: test.info().outputPath('a17-long-model.png') })
    await chip.tap()
    await expect(page.getByTestId('m-remote-shared-model-0')).toContainText(long)
  })

  test('Abgleich: an error of the turn as a card with Try again; waiting for the computer; the model chip of the chat', async ({ page, context }) => {
    const errors = watchErrors(page)
    const chat = addFakeChat(desk.chats!, { title: 'Desk busy', history: 2 })
    await phone(context, desk)
    await pair(page, desk)
    await page.getByTestId('m-remote-shared-row').tap()
    await expect(page.getByTestId('m-remote-shared-model')).toContainText('Qwen3 8B')
    await page.getByTestId('m-remote-shared-model').tap()
    await page.getByTestId('m-remote-shared-model-1').tap()
    await expect(page.getByTestId('m-remote-shared-model')).toContainText('Qwen3.5 9B (LU Engine)')

    desk.chats!.errorNext = 'The window of LU did not take the message in time.'
    await page.getByTestId('m-remote-shared-input').fill('are you there?')
    await page.getByTestId('m-remote-shared-send').tap()
    const card = page.getByTestId('m-remote-shared-turn-error')
    await expect(card).toContainText('The window of LU did not take the message in time.')
    expect(desk.chats!.posts[0]).toMatchObject({ content: 'are you there?', model: 'lu-engine::Qwen3.5-9B-Q4_K_M' })
    await page.screenshot({ path: test.info().outputPath('a17-turn-error.png') })

    desk.chats!.waitNext = 1_500
    await page.getByTestId('m-remote-shared-turn-retry').tap()
    await expect(page.getByTestId('m-remote-shared-waiting')).toHaveText('Waiting for your computer, someone is typing there')
    await expect(page.getByTestId('m-remote-shared-turn-error')).toHaveCount(0)
    await expect(page.getByTestId('m-remote-shared-answer').last()).toContainText('Sure. Here is the plan.', { timeout: 15_000 })
    await expect(page.getByTestId('m-remote-shared-waiting')).toHaveCount(0)
    // Two messages of history, twice the question (the computer kept the first), one answer: nothing doubled by the stream.
    await expect(page.getByTestId('m-remote-shared-thread')).toHaveAttribute('data-m-count', String(chat.messages.length))
    expect(errors()).toEqual([])
  })

  test('a PDF goes with the message; a tap on a notice opens its chat', async ({ page, context }) => {
    const chat = addFakeChat(desk.chats!, { title: 'Read this' })
    await phone(context, desk)
    await pair(page, desk)
    // The link behind "Answer ready" (lu://remote/notice?chat=...), as the native layer hands it in.
    await page.evaluate((url) => window.dispatchEvent(new CustomEvent('lu:deep-link', { detail: { url } })), `lu://remote/notice?chat=${chat.id}`)
    await expect(page.getByTestId('m-remote-shared-composer')).toBeVisible()
    const chooser = page.waitForEvent('filechooser')
    await page.getByTestId('m-remote-shared-attach').tap()
    await (await chooser).setFiles({ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%fake\n') })
    await expect(page.getByTestId('m-remote-shared-tray')).toContainText('invoice.pdf')
    await page.getByTestId('m-remote-shared-input').fill('what is the total?')
    await page.getByTestId('m-remote-shared-send').tap()
    await expect.poll(() => chat.messages.find((m) => m.content === 'what is the total?')?.attachments.map((a) => a.mime)).toEqual(['application/pdf'])
    expect(desk.create!.uploads[0]).toMatchObject({ mime: 'application/pdf', name: 'invoice.pdf' })
  })

  test('offline: the message waits visibly, survives a restart, goes once when the computer is back; the line reconnects', async ({ page, context }) => {
    const chat = addFakeChat(desk.chats!, { title: 'Notes' })
    const p = await phone(context, desk)
    await pair(page, desk)
    await page.getByTestId('m-remote-shared-row').tap()
    await expect(page.getByTestId('m-remote-shared-empty')).toBeVisible()
    p.offline = true
    await page.getByTestId('m-remote-shared-input').fill('remember the milk')
    await page.getByTestId('m-remote-shared-send').tap()
    await expect(page.getByTestId('m-remote-shared-outbox-state')).toHaveText('Waiting to send')
    await expect(page.getByTestId('m-remote-shared-screen').getByTestId('m-remote-line')).toHaveAttribute('data-state', /reconnecting|unreachable/, { timeout: 30_000 })
    await page.screenshot({ path: test.info().outputPath('a17-waiting.png') })

    // LU is closed and opened again, still without the computer.
    await page.reload()
    await page.getByTestId('m-app').waitFor()
    await toRemoteHome(page)
    p.offline = false
    // Back in reach: reconnecting runs by itself, the message goes once.
    await expect(page.getByTestId('m-remote-screen').getByTestId('m-remote-line-text')).toHaveText('Connected over the internet', { timeout: 30_000 })
    await expect.poll(() => chat.messages.filter((m) => m.content === 'remember the milk').length, { timeout: 20_000 }).toBe(1)
    const ids = desk.chats!.posts.filter((x) => x.content === 'remember the milk').map((x) => x.client_id)
    expect(new Set(ids).size).toBe(1)
    await page.getByTestId('m-remote-shared-row').tap()
    await expect(page.locator('[data-testid="m-remote-shared-question"]', { hasText: 'remember the milk' })).toHaveCount(1)
    await expect(page.getByTestId('m-remote-shared-outbox')).toHaveCount(0)
  })
})
