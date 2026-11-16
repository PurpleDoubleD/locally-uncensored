/**
 * Strand 6, Remote and resilience, in a browser without Tauri.
 *
 * Remote: the screens R1 to R5 talk to a stand in for the desktop server,
 * the same one the unit tests of the logic layer use
 * (src/mobile/remote/__tests__/fakeDesktop.ts, a real HTTP server that
 * follows mobile-docs/REMOTE-PROTOKOLL.md with the status codes and texts of
 * remote.rs). The page asks for a Wi-Fi address; Playwright carries each
 * call to the stand in and adds the CORS headers a browser wants. On a phone
 * that hop is the Rust transport (screens/remote/parts/transport.ts), which
 * is tested with vitest. Nothing here reaches a real desktop or a cloud.
 *
 * Resilience: the offline line with a confirmed answer, the storage notices,
 * the notice about picked up jobs, the error screen with "Copy report".
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { startFakeDesktop, type FakeDesktop } from '../../src/mobile/remote/__tests__/fakeDesktop'
import { CLOUD_PROBE, measureLayout, openShell, screensLoaded, SIZES, watchErrors } from './support'

/** The address the "desktop" shows. Never dialled for real: every call to it is carried to the stand in. */
const ADDRESS = '192.168.1.20:11435'
const BASE = `http://${ADDRESS}`
const CODE = '482913'

const SHOTS = process.env.LU_REMOTE_SHOTS

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

interface Bridge {
  /** The desktop does not answer at all (off, other network, firewall). */
  down: boolean
  /** Something else answers at the address. */
  foreign: boolean
  calls: string[]
}

/** Carry every call for `base` to the stand in, the way the Rust transport does on a phone. */
async function bridge(page: Page, desk: FakeDesktop, base: string = BASE): Promise<Bridge> {
  const state: Bridge = { down: false, foreign: false, calls: [] }
  await page.route(`${base}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    state.calls.push(`${request.method()} ${url.pathname}`)
    if (state.down) return route.abort('connectionrefused')
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'x-lu-refreshed-token, x-lu-remote-memory-revoked',
    }
    if (state.foreign) return route.fulfill({ status: 200, contentType: 'text/html', body: '<html>router</html>', headers: cors })
    const headers: Record<string, string> = {}
    const sent = request.headers()
    if (sent.authorization) headers.authorization = sent.authorization
    if (sent['content-type']) headers['content-type'] = sent['content-type']
    try {
      const answer = await fetch(`${desk.url}${url.pathname}${url.search}`, {
        method: request.method(),
        headers,
        body: request.postData() ?? undefined,
      })
      const out: Record<string, string> = { ...cors, 'content-type': answer.headers.get('content-type') ?? 'text/plain' }
      for (const name of ['x-lu-refreshed-token', 'x-lu-remote-memory-revoked']) {
        const value = answer.headers.get(name)
        if (value) out[name] = value
      }
      const body = answer.status === 204 ? undefined : await answer.text()
      await route.fulfill({ status: answer.status, headers: out, body })
    } catch {
      await route.abort('connectionrefused').catch(() => undefined)
    }
  })
  return state
}

interface DeviceBridge {
  /** The secure storage of the "phone": account to value. Lives in the test, not in the page. */
  secrets: Map<string, string>
  /** Calls of remote_client_request as "METHOD path". */
  requests: string[]
}

/**
 * The app as it runs on a phone: a Tauri bridge is there. The secure storage
 * (`secret_get`, `secret_set`, `secret_delete`) keeps its values in the test
 * process, so nothing of it is in the storage of the page, and it is still
 * there when the app is opened again, like the Keystore after the app was
 * closed. `remote_client_request` carries each call to the stand in for the
 * desktop, as the Rust transport does. Every other command of the start has
 * no answer. Set up on the context, so it holds for every page of it: a
 * closed and newly opened page is the app after a restart.
 */
async function deviceBridge(context: BrowserContext, desk: FakeDesktop): Promise<DeviceBridge> {
  const state: DeviceBridge = { secrets: new Map(), requests: [] }
  // With a bridge the app probes the network at the cloud of LU: answered here, nothing leaves the machine.
  await context.route(CLOUD_PROBE, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '' }))
  await context.exposeFunction('__e2eSecret', (op: string, account: string, value?: string): string | null => {
    if (op === 'set') state.secrets.set(account, String(value ?? ''))
    if (op === 'delete') state.secrets.delete(account)
    return op === 'get' ? (state.secrets.get(account) ?? null) : null
  })
  await context.exposeFunction(
    '__e2eRemoteRequest',
    async (args: { baseUrl: string; path: string; method: string; token: string | null; body: string | null }) => {
      state.requests.push(`${args.method} ${args.path}`)
      if (args.baseUrl !== BASE) throw new Error('remote_client_request: connection refused')
      const headers: Record<string, string> = {}
      if (args.token) headers.authorization = `Bearer ${args.token}`
      if (args.body != null) headers['content-type'] = 'application/json'
      const answer = await fetch(`${desk.url}${args.path}`, { method: args.method, headers, body: args.body ?? undefined })
      return {
        status: answer.status,
        body: answer.status === 204 ? '' : await answer.text(),
        refreshedToken: answer.headers.get('x-lu-refreshed-token'),
        memoryRevoked: answer.headers.get('x-lu-remote-memory-revoked') === '1',
      }
    },
  )
  await context.addInitScript(() => {
    type Hooks = {
      __e2eSecret: (op: string, account: string, value?: string) => Promise<string | null>
      __e2eRemoteRequest: (args: Record<string, unknown>) => Promise<unknown>
    }
    const hooks = window as unknown as Hooks
    let callbacks = 0
    const invoke = async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      const account = String(args.account ?? '')
      switch (command) {
        case 'secret_set':
          return hooks.__e2eSecret('set', account, String(args.value))
        case 'secret_get':
          return hooks.__e2eSecret('get', account)
        case 'secret_delete':
          return hooks.__e2eSecret('delete', account)
        case 'remote_client_request':
          return hooks.__e2eRemoteRequest(args)
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

/** A small real PNG (8 by 8 px, one colour), so the page can decode it, shrink it and make a preview. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4YaOBFTEMLQkAdntLARs7+acAAAAASUVORK5CYII=', 'base64')

/** This browser reads no QR codes, like an iPhone WebView without the native scanner. */
async function withoutScanner(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'BarcodeDetector', { value: undefined, configurable: true })
  })
}

/** This browser reads QR codes from a camera picture, like an Android WebView. The "camera" shows `text`. */
async function withCamera(page: Page, text: string): Promise<void> {
  await page.addInitScript((qr) => {
    class FakeDetector {
      async detect(): Promise<Array<{ rawValue: string }>> {
        const shown = (window as unknown as { __luQr?: string }).__luQr
        return shown ? [{ rawValue: shown }] : []
      }
    }
    ;(window as unknown as { __luQr?: string }).__luQr = qr
    Object.defineProperty(window, 'BarcodeDetector', { value: FakeDetector, configurable: true })
    const media = {
      getUserMedia: async () => {
        const canvas = document.createElement('canvas')
        canvas.width = 320
        canvas.height = 240
        const paint = () => canvas.getContext('2d')?.fillRect(0, 0, 320, 240)
        paint()
        setInterval(paint, 100)
        return canvas.captureStream(10)
      },
    }
    Object.defineProperty(navigator, 'mediaDevices', { value: media, configurable: true })
  }, text)
}

/**
 * R1 is the segment "Remote desktop" of the chat list. Go to the root of the
 * chat tab and pick the segment, as a user does. Safe to call again.
 */
async function showHome(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { nav } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/nav/index.ts`)
    const state = nav.getState()
    if (state.flow || state.tab !== 'chat' || state.stacks.chat.length !== 1) nav.resetTo('chat', [])
  })
  await expect(page.locator('.m-page[data-m-exit]')).toHaveCount(0)
  await page.getByTestId('m-chats-segment-remote').tap()
  await expect(page.getByTestId('m-remote-screen')).toBeVisible()
  await expect(page.getByTestId('m-remote-screen')).not.toHaveAttribute('data-m-status', 'loading')
}

async function openHome(page: Page): Promise<void> {
  await openShell(page)
  await showHome(page)
}

/** The back arrow of the page on top. Pages below stay in the document, so there can be several. */
async function back(page: Page): Promise<void> {
  await page.locator('.m-page:not([data-m-hidden]):not([data-m-exit])').getByTestId('m-page-back').tap()
  // The page slides out first; only then is the one below measured or used.
  await expect(page.locator('.m-page[data-m-exit]')).toHaveCount(0)
}

/** Back to the chat list, and R1 in it. */
async function backHome(page: Page): Promise<void> {
  await back(page)
  await showHome(page)
}

/** From R1 through R2 to a fresh chat with the desktop. */
async function pair(page: Page, code: string = CODE): Promise<void> {
  await page.getByTestId('m-remote-enter').tap()
  await expect(page.getByTestId('m-remote-connect-screen')).toBeVisible()
  await page.getByTestId('m-remote-connect-address').fill(ADDRESS)
  await page.getByTestId('m-remote-connect-passcode').fill(code)
  await page.getByTestId('m-remote-connect-submit').tap()
  await expect(page.getByTestId('m-remote-chat-screen')).toBeVisible()
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId('m-remote-chat-input').fill(text)
  await page.getByTestId('m-remote-chat-send').tap()
}

let desk: FakeDesktop

test.beforeEach(async () => {
  desk = await startFakeDesktop({ passcode: CODE, reply: 'Hello from the desktop model.' })
})
test.afterEach(async () => {
  await desk.stop()
})

test.describe('remote desktop', () => {
  test('not set up: the start explains the three steps and leads to typing, help and back', async ({ page }) => {
    const errors = watchErrors(page)
    await withoutScanner(page)
    await bridge(page, desk)
    await openHome(page)
    await expect(page.getByTestId('m-remote-screen')).toHaveAttribute('data-m-status', 'unpaired')
    await expect(page.getByTestId('m-remote-intro')).toContainText('Use the models on your desktop')
    await expect(page.locator('.m-remote-steps > li')).toHaveCount(3)
    // No scanner in this browser: the button that could not work is not there.
    await expect(page.getByTestId('m-remote-scan')).toHaveCount(0)
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r1-unpaired')

    await page.getByTestId('m-remote-help').tap()
    await expect(page.getByTestId('m-remote-help-screen')).toBeVisible()
    await expect(page.getByTestId('m-remote-help-text').locator('h2')).toHaveText(['What it does', 'How to connect', 'What stays private'])
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r5-help')
    // "Connect now" leads back to R1, which is right under this page.
    await page.getByTestId('m-remote-help-connect').tap()
    await expect(page.getByTestId('m-remote-help-screen')).toHaveCount(0)
    await expect(page.getByTestId('m-remote-screen')).toBeVisible()
    expect(errors()).toEqual([])
  })

  test('typing the address and the code ends in a chat, and the answer of the desktop arrives', async ({ page }) => {
    const errors = watchErrors(page)
    await withoutScanner(page)
    await bridge(page, desk)
    desk.delayMs = 700
    await openHome(page)
    await pair(page)
    await expect(page.getByTestId('m-toast-remote-connected')).toContainText(`Connected to ${ADDRESS}`)
    await expect(page.getByTestId('m-remote-chat-screen').locator('.m-hdr-sub')).toHaveText(`On ${ADDRESS}`)
    await expect(page.getByTestId('m-remote-chat-empty')).toBeVisible()
    await expect(page.getByTestId('m-remote-chat-options')).toContainText('qwen3:8b')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r4-empty')

    await send(page, 'What is the capital of France?')
    // The desktop of 3.0.5 answers in one piece: the wait says so and offers Stop.
    await expect(page.getByTestId('m-remote-chat-working')).toContainText('Your desktop is working on it')
    await expect(page.getByTestId('m-remote-chat-stop')).toBeVisible()
    await expect(page.getByTestId('m-remote-chat-input')).toHaveValue('')
    await shot(page, 'r4-working')
    await expect(page.getByTestId('m-remote-chat-answer')).toContainText('Hello from the desktop model.')
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveAttribute('data-m-state', 'done')
    await expect(page.getByTestId('m-remote-chat-working')).toHaveCount(0)
    await expect(page.getByTestId('m-remote-chat-question')).toHaveText('What is the capital of France?')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r4-answer')
    // The question and the answer are mirrored into the chat on the desktop.
    await expect.poll(() => desk.chatEvents.map((event) => event.role)).toEqual(['user', 'assistant'])
    // The code never went into an address, and no call carried the token in one.
    expect(desk.log.every((line) => !line.includes(CODE) && !line.includes('token='))).toBe(true)

    // Back leads to R1, which now shows the desktop and the chat.
    await backHome(page)
    await expect(page.getByTestId('m-remote-screen')).toHaveAttribute('data-m-status', 'connected')
    await expect(page.getByTestId('m-remote-connected')).toContainText(`Connected to ${ADDRESS}`)
    await expect(page.getByTestId('m-remote-connected')).toContainText('Wi-Fi, desktop LU 3.0.5')
    await expect(page.getByTestId('m-remote-chats').locator('.m-row-title')).toHaveText(['What is the capital of France?'])
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r1-connected')
    expect(errors()).toEqual([])
  })

  test('a wrong address, a silent desktop and a foreign server each say what to do, and the typed text stays', async ({ page }) => {
    await withoutScanner(page)
    const net = await bridge(page, desk)
    await openHome(page)
    await page.getByTestId('m-remote-enter').tap()
    const address = page.getByTestId('m-remote-connect-address')
    const submit = page.getByTestId('m-remote-connect-submit')

    // The code typed into the address field: nothing goes out, the field says why.
    await address.fill('123456')
    await submit.tap()
    await expect(page.locator('.m-field-error')).toContainText('That address does not look right')
    expect(net.calls).toEqual([])
    await expect(address).toHaveValue('123456')

    // The desktop is off, its pairing panel closed, or the phone is in another network.
    // Round 57 (David): a desktop never paired asks for the pairing panel first, the list says the rest.
    net.down = true
    await address.fill(ADDRESS)
    await submit.tap()
    await expect(page.getByTestId('m-remote-connect-error')).toContainText('Open pairing on your computer')
    await expect(page.getByTestId('m-remote-connect-retry')).toBeVisible()
    await expect(page.locator('.m-field-error')).toHaveCount(0)
    await expect(page.getByText('Cannot reach your desktop')).toHaveCount(0)
    await expect(page.getByText('Your desktop answered')).toHaveCount(0)
    await expect(page.getByTestId('m-remote-connect-checks').locator('li')).toHaveCount(5)
    await expect(page.getByTestId('m-remote-connect-checks')).toContainText('Guest networks')
    await expect(address).toHaveValue(ADDRESS)
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r2-unreachable')

    // R1 says the same and offers the way back in.
    await backHome(page)
    await expect(page.getByTestId('m-remote-home-offline')).toContainText('Open pairing on your computer')
    await expect(page.getByTestId('m-remote-home-offline')).not.toContainText('Could not reach your desktop')
    await expect(page.getByTestId('m-remote-home-checks')).toBeVisible()
    await shot(page, 'r1-unreachable')
    // It comes back: "Try again" finds it and asks for the code.
    net.down = false
    await page.getByTestId('m-remote-home-retry').tap()
    await expect(page.getByTestId('m-remote-home-needs-code')).toContainText(`Your desktop at ${ADDRESS} answered`)
    await shot(page, 'r1-needs-code')

    // A router answers at the address, not LU.
    net.foreign = true
    await page.getByTestId('m-remote-home-enter-code').tap()
    await page.getByTestId('m-remote-connect-submit').tap()
    await expect(page.locator('.m-field-error')).toContainText('it is not LU Remote Access')
  })

  test('a wrong code is said under the code field, three of them lock the form for the time the desktop names', async ({ page }) => {
    await withoutScanner(page)
    await bridge(page, desk)
    await page.clock.install()
    await openHome(page)
    await page.getByTestId('m-remote-enter').tap()
    const passcode = page.getByTestId('m-remote-connect-passcode')
    const submit = page.getByTestId('m-remote-connect-submit')
    await page.getByTestId('m-remote-connect-address').fill(ADDRESS)

    // The address alone: the desktop is checked first, then the page asks for the code.
    await submit.tap()
    await expect(page.locator('.m-field-hint').last()).toContainText('Now enter the 6 digit code')
    expect(desk.log.filter((line) => line.includes('/remote-api/auth'))).toEqual([])

    await passcode.fill('123')
    await submit.tap()
    await expect(page.locator('.m-field-error')).toContainText('Enter all 6 digits')
    expect(desk.log.filter((line) => line.includes('/remote-api/auth'))).toEqual([])

    await passcode.fill('000001')
    await expect(page.locator('.m-field-error')).toContainText('That code is not correct')
    await expect(passcode).toHaveValue('000001')
    await expect(page.getByTestId('m-remote-connect-address')).toHaveValue(ADDRESS)
    await shot(page, 'r2-wrong-code')
    await passcode.fill('000002')
    await expect.poll(() => desk.log.filter((line) => line.includes('/remote-api/auth')).length).toBe(2)
    await passcode.fill('000003')
    await expect.poll(() => desk.log.filter((line) => line.includes('/remote-api/auth')).length).toBe(3)
    // The fourth try, even with the right code, is refused by the desktop for a minute.
    await passcode.fill(CODE)
    await expect(page.locator('.m-field-error')).toContainText('Too many wrong codes. Try again in 60 seconds.')
    await expect(submit).toBeDisabled()
    await expect(submit).toContainText(/Wait \d+ seconds/)
    await shot(page, 'r2-locked')

    // A minute later, on both clocks, the same code pairs.
    desk.advance(61)
    await page.clock.fastForward(61_000)
    await expect(submit).toBeEnabled()
    await passcode.fill('')
    await passcode.fill(CODE)
    await expect(page.getByTestId('m-remote-chat-screen')).toBeVisible()
  })

  test('a session that ran out in the middle of a chat: the message stays, the code is asked, the answer comes after', async ({ page }) => {
    await withoutScanner(page)
    await bridge(page, desk)
    await openHome(page)
    await pair(page)
    await send(page, 'first question')
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveAttribute('data-m-state', 'done')

    // "Disconnect" in the device list of the desktop: the token is worthless from now on.
    desk.dropAllDevices()
    await page.getByTestId('m-remote-chat-input').fill('a draft that must survive')
    await send(page, 'second question')
    const failed = page.getByTestId('m-remote-chat-answer').last()
    await expect(failed).toHaveAttribute('data-m-state', 'failed')
    await expect(page.getByTestId('m-remote-chat-answer-error')).toContainText('Your desktop ended this session')
    await expect(page.getByTestId('m-remote-chat-needs-code')).toContainText('Pair again')
    await expect(page.getByTestId('m-remote-chat-screen').locator('.m-hdr-sub')).toHaveText('Not connected')
    // Sending is blocked with a reason, the question itself is in the transcript and not lost.
    await page.getByTestId('m-remote-chat-input').fill('typed while locked out')
    await expect(page.getByTestId('m-remote-chat-send')).toBeDisabled()
    await expect(page.getByTestId('m-remote-chat-send')).toHaveAttribute('aria-label', 'Send, not connected')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r4-session-ended')

    await page.getByTestId('m-remote-chat-answer-action').tap()
    await expect(page.getByTestId('m-remote-connect-screen')).toBeVisible()
    await expect(page.getByTestId('m-remote-connect-address')).toHaveValue(ADDRESS)
    await page.getByTestId('m-remote-connect-passcode').fill(desk.shownPasscode())
    // Back in the same chat, with the draft, and the open question can be asked again.
    await expect(page.getByTestId('m-remote-chat-screen')).toBeVisible()
    await expect(page.getByTestId('m-remote-connect-screen')).toHaveCount(0)
    await expect(page.getByTestId('m-remote-chat-input')).toHaveValue('typed while locked out')
    await page.getByTestId('m-remote-chat-answer-action').tap()
    await expect(page.getByTestId('m-remote-chat-answer').last()).toHaveAttribute('data-m-state', 'done')
    await expect(page.getByTestId('m-remote-chat-question')).toHaveCount(2)
    // The second question was sent to the model once it could be, and mirrored once.
    expect(desk.chatEvents.filter((event) => event.role === 'user').map((event) => event.content)).toEqual(['first question', 'second question'])
  })

  test('the desktop vanishes while it answers: the box says so, Reconnect and Try again bring the answer', async ({ page }) => {
    await withoutScanner(page)
    const net = await bridge(page, desk)
    await openHome(page)
    await pair(page)

    net.down = true
    await send(page, 'are you there?')
    await expect(page.getByTestId('m-remote-chat-answer-error')).toContainText('Connection to your desktop was lost.')
    await expect(page.getByTestId('m-remote-chat-answer-error')).toContainText('Cannot reach your desktop')
    await expect(page.getByTestId('m-remote-chat-answer-action')).toHaveText('Reconnect')
    await expect(page.getByTestId('m-remote-chat-offline')).toBeVisible()
    await expect(page.getByTestId('m-remote-chat-question')).toHaveText('are you there?')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r4-connection-lost')

    // Still gone: Reconnect ends in the same honest state, not in a spinner.
    await page.getByTestId('m-remote-chat-answer-action').tap()
    await expect(page.getByTestId('m-remote-chat-offline')).toBeVisible()

    net.down = false
    await page.getByTestId('m-remote-chat-retry').tap()
    await expect(page.getByTestId('m-remote-chat-offline')).toHaveCount(0)
    await expect(page.getByTestId('m-remote-chat-answer-action')).toHaveText('Try again')
    await page.getByTestId('m-remote-chat-answer-action').tap()
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveAttribute('data-m-state', 'done')
    await expect(page.getByTestId('m-remote-chat-answer')).toContainText('Hello from the desktop model.')
  })

  test('Stop ends the wait, and the model of the desktop can be changed in a sheet', async ({ page }) => {
    const errors = watchErrors(page)
    await withoutScanner(page)
    await bridge(page, desk)
    await openHome(page)
    await pair(page)

    // Prompt v2: the model is one level down, settings button, then the row "Model".
    await page.getByTestId('m-remote-chat-options').tap()
    await page.getByTestId('m-remote-options-model').tap()
    await expect(page.getByTestId('m-sheet-remote-model')).toBeVisible()
    await expect(page.getByTestId('m-remote-model-list').locator('.m-row-title')).toHaveText(['qwen3:8b', 'gemma4:e4b'])
    await expect(page.getByTestId('m-remote-model-0')).toContainText('Chosen on the desktop')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r4-model-sheet')
    await page.getByTestId('m-remote-model-1').tap()
    await expect(page.getByTestId('m-sheet-remote-model')).toHaveCount(0)
    await expect(page.getByTestId('m-remote-chat-options')).toContainText('gemma4:e4b')

    desk.delayMs = 4000
    await send(page, 'a long one')
    await expect(page.getByTestId('m-remote-chat-working')).toBeVisible()
    await page.getByTestId('m-remote-chat-stop').tap()
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveAttribute('data-m-state', 'stopped')
    await expect(page.getByTestId('m-remote-chat-answer-note')).toContainText('Stopped')
    expect(desk.chatRequests.at(-1)?.body.model).toBe('gemma4:e4b')
    // Asked again without the wait, the answer comes, and the question is in the transcript once.
    desk.delayMs = 0
    await page.getByTestId('m-remote-chat-answer-action').tap()
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveAttribute('data-m-state', 'done')
    await expect(page.getByTestId('m-remote-chat-question')).toHaveCount(1)

    // Options: thinking is offered for a model that can, a persona changes the system prompt of the next request.
    await page.getByTestId('m-remote-chat-options').tap()
    await expect(page.getByTestId('m-sheet-remote-options')).toBeVisible()
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await page.getByTestId('m-remote-options-persona-coder').tap()
    await page.goBack()
    await send(page, 'with a persona')
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveCount(2)
    const messages = desk.chatRequests.at(-1)?.body.messages as Array<{ role: string; content: string }>
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('expert software engineer')
    expect(errors()).toEqual([])
  })

  test('an answer is made again, an own message is edited and sent again, as on the web page of the desktop', async ({ page }) => {
    const errors = watchErrors(page)
    await withoutScanner(page)
    await bridge(page, desk)
    await openHome(page)
    await pair(page)
    await send(page, 'frist question')
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveAttribute('data-m-state', 'done')
    await send(page, 'second question')
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveCount(2)
    await expect(page.getByTestId('m-remote-chat-answer').last()).toHaveAttribute('data-m-state', 'done')

    // Regenerate the last answer: the answer is replaced, the questions stay, the desktop gets no dropped answer.
    desk.reply = 'A **better** answer with `code`.'
    await page.getByTestId('m-remote-chat-answer-more').last().tap()
    await expect(page.getByTestId('m-sheet-remote-message')).toBeVisible()
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await page.getByTestId('m-remote-message-regenerate').tap()
    await expect(page.getByTestId('m-sheet-remote-message')).toHaveCount(0)
    await expect(page.getByTestId('m-remote-chat-answer').last()).toContainText('A better answer with code.')
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveCount(2)
    await expect(page.getByTestId('m-remote-chat-question')).toHaveCount(2)
    // The answer is formatted text, not raw marks.
    await expect(page.getByTestId('m-remote-chat-answer').last().locator('strong')).toHaveText('better')
    const again = desk.chatRequests.at(-1)?.body.messages as Array<{ role: string; content: string }>
    expect(again.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(again.at(-1)?.content).toBe('second question')

    // Edit the first message: the text is there to change, everything after it goes, the new text is asked.
    desk.reply = 'Answer to the corrected question.'
    await page.getByTestId('m-remote-chat-question-more').first().tap()
    await expect(page.getByTestId('m-remote-message-regenerate')).toHaveCount(0)
    await page.getByTestId('m-remote-message-edit').tap()
    const field = page.getByTestId('m-remote-message-edit-text')
    await expect(field).toHaveValue('frist question')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    // An emptied message is not sent.
    await field.fill('   ')
    await page.getByTestId('m-remote-message-edit-send').tap()
    await expect(page.getByTestId('m-sheet-remote-message')).toContainText('Write a message first.')
    await field.fill('first question')
    await page.getByTestId('m-remote-message-edit-send').tap()
    await expect(page.getByTestId('m-sheet-remote-message')).toHaveCount(0)
    await expect(page.getByTestId('m-remote-chat-question')).toHaveCount(1)
    await expect(page.getByTestId('m-remote-chat-question')).toContainText('first question')
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveCount(1)
    await expect(page.getByTestId('m-remote-chat-answer')).toContainText('Answer to the corrected question.')
    expect(desk.chatRequests.at(-1)?.body.messages).toEqual([{ role: 'user', content: 'first question' }])

    // While an answer is on its way, the rows say why they cannot work instead of doing nothing.
    desk.delayMs = 4_000
    await send(page, 'a slow one')
    await expect(page.getByTestId('m-remote-chat-working')).toBeVisible()
    await page.getByTestId('m-remote-chat-question-more').first().tap()
    const edit = page.getByTestId('m-remote-message-edit')
    await expect(edit).toBeDisabled()
    await expect(edit).toContainText('Wait until the current answer is done')
    expect(errors()).toEqual([])
  })

  test('an answer can be copied and reported, a chat renamed and deleted after a question', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await withoutScanner(page)
    await bridge(page, desk)
    await openHome(page)
    await pair(page)
    await send(page, 'tell me something')
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveAttribute('data-m-state', 'done')

    await page.getByTestId('m-remote-chat-answer-more').tap()
    await expect(page.getByTestId('m-sheet-remote-message')).toBeVisible()
    await page.getByTestId('m-remote-message-copy').tap()
    await expect(page.getByTestId('m-toast-remote-copied')).toHaveText('Copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Hello from the desktop model.')

    // The answer of a model is an AI answer: it can be reported from here.
    await page.getByTestId('m-remote-chat-answer-more').tap()
    await page.getByTestId('m-remote-message-report').tap()
    await expect(page.getByTestId('m-sheet-remote-message')).toHaveCount(0)
    await expect(page.getByTestId('m-sheet-report')).toBeVisible()
    await page.goBack()

    await page.getByTestId('m-remote-chat-menu').tap()
    await page.getByTestId('m-remote-chat-menu-rename').tap()
    await page.getByTestId('m-dialog-field').fill('Trip plan')
    await page.getByTestId('m-dialog-confirm').tap()
    await expect(page.getByTestId('m-remote-chat-screen').locator('.m-hdr-title')).toContainText('Trip plan')

    await page.getByTestId('m-remote-chat-menu').tap()
    const remove = page.getByTestId('m-remote-chat-menu-delete')
    expect(await remove.evaluate((el) => el.closest('[data-m-risk]')?.getAttribute('data-m-risk'))).toBe('destructive')
    await remove.tap()
    await expect(page.getByTestId('m-dialog-remote-delete-chat')).toContainText('Delete Trip plan?')
    // "Cancel" keeps everything.
    await page.getByTestId('m-dialog-cancel').tap()
    await expect(page.getByTestId('m-sheet-remote-chat-menu')).toBeVisible()
    await remove.tap()
    await page.getByTestId('m-dialog-confirm').tap()
    await expect(page.getByTestId('m-remote-chat-screen')).toHaveCount(0)
    // The chat is gone and the app is back in the chat list.
    await showHome(page)
    await expect(page.getByTestId('m-remote-chats-empty')).toBeVisible()
  })

  test('the pairing survives a restart; disconnect asks first, keeps the chats and remembers the desktop', async ({ page }) => {
    await withoutScanner(page)
    const net = await bridge(page, desk)
    await openHome(page)
    await pair(page)
    await send(page, 'remember me')
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveAttribute('data-m-state', 'done')

    // The app is closed and opened again: same desktop, same chat, no code. The start itself opens a new chat on
    // this phone (round 57); the remote chat waits under Remote desktop.
    await page.reload()
    await page.getByTestId('m-app').waitFor()
    await screensLoaded(page)
    await expect(page.getByTestId('m-chat-screen')).toBeVisible()
    await showHome(page)
    await expect(page.getByTestId('m-remote-connected')).toBeVisible()
    await page.locator('[data-testid^="m-remote-chat-row-"]').tap()
    await expect(page.getByTestId('m-remote-chat-screen')).toBeVisible()
    await expect(page.getByTestId('m-remote-chat-screen').locator('.m-hdr-sub')).toHaveText(`On ${ADDRESS}`)
    await expect(page.getByTestId('m-remote-chat-question')).toHaveText('remember me')
    await backHome(page)
    await expect(page.getByTestId('m-remote-connected')).toBeVisible()

    // Details of the connection, read only.
    await page.getByTestId('m-remote-details').tap()
    await expect(page.getByTestId('m-sheet-remote-connection')).toBeVisible()
    await expect(page.getByTestId('m-remote-connection-address')).toContainText(ADDRESS)
    await expect(page.getByTestId('m-remote-connection-status')).toContainText('Connected')
    await expect(page.getByTestId('m-remote-connection-permissions').locator('.m-row-val')).toHaveText(['Not allowed', 'Not allowed', 'Not allowed', 'Not allowed'])
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r1-connection-sheet')
    await page.goBack()

    const disconnect = page.getByTestId('m-remote-disconnect')
    expect(await disconnect.evaluate((el) => el.closest('[data-m-risk]')?.getAttribute('data-m-risk'))).toBe('destructive')
    await disconnect.tap()
    await expect(page.getByTestId('m-dialog-remote-disconnect')).toContainText(`Disconnect from ${ADDRESS}?`)
    await page.getByTestId('m-dialog-cancel').tap()
    await expect(page.getByTestId('m-remote-connected')).toBeVisible()
    await disconnect.tap()
    await page.getByTestId('m-dialog-confirm').tap()
    await expect(page.getByTestId('m-toast-remote-disconnected')).toBeVisible()
    // The session is gone on the desktop too, the chat is still readable here.
    await expect.poll(() => desk.devices.length).toBe(0)
    await expect(page.getByTestId('m-remote-home-needs-code')).toBeVisible()
    await expect(page.getByTestId('m-remote-chats').locator('.m-row-title')).toHaveText(['remember me'])
    await page.locator('[data-testid^="m-remote-chat-row-"]').tap()
    await expect(page.getByTestId('m-remote-chat-question')).toHaveText('remember me')
    await expect(page.getByTestId('m-remote-chat-needs-code')).toBeVisible()
    await backHome(page)

    // Forget the address: the start is back, and the desktop is offered as a recent one.
    await page.getByTestId('m-remote-home-forget').tap()
    await page.getByTestId('m-dialog-confirm').tap()
    await expect(page.getByTestId('m-remote-screen')).toHaveAttribute('data-m-status', 'unpaired')
    await expect(page.getByTestId('m-remote-chats').locator('.m-row-title')).toHaveText(['remember me'])
    await expect(page.getByTestId('m-remote-known')).toHaveCount(0)

    // Paired once more, then only disconnected and looked at from the start page of a fresh visit.
    await pair(page, desk.shownPasscode())
    await backHome(page)
    await page.getByTestId('m-remote-details').tap()
    await page.getByTestId('m-remote-connection-forget').tap()
    await page.getByTestId('m-dialog-cancel').tap()
    await page.goBack()
    expect(net.calls.length).toBeGreaterThan(0)
  })

  test('a desktop that was used before is one tap and the code away', async ({ page }) => {
    await withoutScanner(page)
    await bridge(page, desk)
    // Two desktops were paired earlier; none is set up now.
    await page.addInitScript(() => {
      if (localStorage.getItem('lu-mobile-remote-desktops')) return
      localStorage.setItem(
        'lu-mobile-remote-desktops',
        JSON.stringify([
          { baseUrl: 'http://192.168.1.20:11435', lastConnectedAt: Date.now() - 3_600_000 },
          { baseUrl: 'https://quiet-river-1234.trycloudflare.com', lastConnectedAt: Date.now() - 86_400_000 },
        ]),
      )
    })
    await openHome(page)
    await expect(page.getByTestId('m-remote-known').locator('.m-row-title')).toHaveText(['192.168.1.20:11435', 'quiet-river-1234.trycloudflare.com'])
    await expect(page.getByTestId('m-remote-known-0')).toContainText('Wi-Fi, last used 1 h ago')
    await expect(page.getByTestId('m-remote-known-1')).toContainText('It changes every time Remote Access restarts')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r1-known')

    // Removing one asks first and removes only the remembered address.
    await page.getByTestId('m-remote-known-remove-1').tap()
    await page.getByTestId('m-dialog-confirm').tap()
    await expect(page.getByTestId('m-remote-known').locator('.m-row-title')).toHaveText(['192.168.1.20:11435'])

    await page.getByTestId('m-remote-known-0').tap()
    await expect(page.getByTestId('m-remote-connect-screen')).toBeVisible()
    await expect(page.getByTestId('m-remote-connect-address')).toHaveValue(ADDRESS)
    await expect(page.locator('.m-field-hint').last()).toContainText('Now enter the 6 digit code')
    await page.getByTestId('m-remote-connect-passcode').fill(CODE)
    await expect(page.getByTestId('m-remote-chat-screen')).toBeVisible()
  })

  test('a pairing link fills address and code on the Connect page and never connects by itself', async ({ page }) => {
    const errors = watchErrors(page)
    await withoutScanner(page)
    await bridge(page, desk)
    await openShell(page)
    // The system hands the app a link, the way a tap on lu://remote... does.
    const taken = await page.evaluate(async (link) => {
      const { receiveDeepLink } = (await import(/* @vite-ignore */ `${location.origin}/src/mobile/nav/deeplink.ts`)) as { receiveDeepLink: (url: string) => boolean }
      return receiveDeepLink(link)
    }, `lu://remote?url=${encodeURIComponent(`${BASE}/mobile`)}&code=${CODE}`)
    expect(taken).toBe(true)
    await expect(page.getByTestId('m-link-offer-kind')).toHaveAttribute('data-kind', 'remote')
    await page.getByTestId('m-link-offer-continue').tap()

    await expect(page.getByTestId('m-remote-connect-screen')).toBeVisible()
    await expect(page.getByTestId('m-remote-connect-address')).toHaveValue(ADDRESS)
    await expect(page.getByTestId('m-remote-connect-passcode')).toHaveValue(CODE)
    await expect(page.getByTestId('m-remote-connect-from-link')).toContainText('Address and code came from a link.')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r2-from-link')
    // Nothing was sent to the desktop yet: the link only filled the fields.
    await page.waitForTimeout(300)
    expect(desk.log.filter((line) => line.includes('/remote-api/'))).toEqual([])
    await expect(page.getByTestId('m-remote-connect-status')).toHaveAttribute('data-m-status', 'unpaired')

    // The help page and back: address and code are still there.
    await page.getByTestId('m-remote-connect-help').tap()
    await expect(page.getByTestId('m-remote-help-screen')).toBeVisible()
    await back(page)
    await expect(page.getByTestId('m-remote-connect-address')).toHaveValue(ADDRESS)
    await expect(page.getByTestId('m-remote-connect-passcode')).toHaveValue(CODE)

    await page.getByTestId('m-remote-connect-submit').tap()
    await expect(page.getByTestId('m-remote-chat-screen')).toBeVisible()
    expect(errors()).toEqual([])
  })

  test('scanning with the camera of the page finds the address and asks for the code', async ({ page }) => {
    const errors = watchErrors(page)
    await withCamera(page, `${BASE}/mobile`)
    await bridge(page, desk)
    await openHome(page)
    // With a scanner the scan is the filled button.
    await page.getByTestId('m-remote-scan').tap()
    await expect(page.getByTestId('m-remote-connect-screen')).toBeVisible()
    await expect(page.getByTestId('m-remote-scan-screen')).toHaveCount(0)
    await expect(page.getByTestId('m-remote-connect-address')).toHaveValue(ADDRESS)
    await expect(page.locator('.m-field-hint').last()).toContainText('Now enter the 6 digit code')
    // The QR code of the desktop never carries the code: nothing was paired yet.
    expect(desk.log.filter((line) => line.includes('/remote-api/auth'))).toEqual([])
    await page.getByTestId('m-remote-connect-passcode').fill(CODE)
    await expect(page.getByTestId('m-remote-chat-screen')).toBeVisible()
    expect(errors()).toEqual([])
  })

  test('a scanned picture that carries a code pairs nothing by itself: address and code are shown, "Connect" decides', async ({ page }) => {
    const errors = watchErrors(page)
    // Review N4: a sticker with an address and a code. The QR code of the desktop never has the code.
    await withCamera(page, `lu://remote?url=${encodeURIComponent(`${BASE}/mobile`)}&code=${CODE}`)
    await bridge(page, desk)
    await openHome(page)
    await page.getByTestId('m-remote-scan').tap()
    await expect(page.getByTestId('m-remote-connect-screen')).toBeVisible()
    await expect(page.getByTestId('m-remote-connect-address')).toHaveValue(ADDRESS)
    await expect(page.getByTestId('m-remote-connect-passcode')).toHaveValue(CODE)
    await expect(page.getByTestId('m-remote-connect-from-link')).toContainText('The QR code of your desktop never contains the code')
    // Nothing was asked of the desktop: no check, no pairing.
    await page.waitForTimeout(500)
    expect(desk.log.filter((line) => line.includes('/remote-api/'))).toEqual([])
    await expect(page.getByTestId('m-remote-chat-screen')).toHaveCount(0)
    // The user's own tap pairs.
    await page.getByTestId('m-remote-connect-submit').tap()
    await expect(page.getByTestId('m-remote-chat-screen')).toBeVisible()
    expect(desk.log.filter((line) => line.includes('/remote-api/auth')).length).toBe(1)
    expect(errors()).toEqual([])
  })

  test('scanning: a code that is not from LU is said, a missing camera and a missing scanner lead to typing', async ({ page }) => {
    await withCamera(page, 'WIFI:S:guests;T:WPA;P:secret;;')
    await bridge(page, desk)
    await openShell(page, { route: '/remote/scan' })
    await expect(page.getByTestId('m-remote-scan-phase')).toHaveAttribute('data-m-phase', 'live')
    await expect(page.getByTestId('m-toast-remote-scan-foreign')).toContainText('not a code from LU Remote Access')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r3-live')
    // The camera goes on looking, and the way to typing is always there.
    await page.getByTestId('m-remote-scan-enter').tap()
    await expect(page.getByTestId('m-remote-connect-screen')).toBeVisible()

    // The camera is not allowed.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) },
      })
    })
    await page.getByTestId('m-remote-connect-scan').tap()
    await expect(page.getByTestId('m-remote-scan-denied')).toContainText('LU needs the camera to scan the code.')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r3-denied')
    // No native layer in a browser: the button says what to do instead of doing nothing.
    await page.getByTestId('m-remote-scan-settings').tap()
    await expect(page.getByTestId('m-toast-remote-scan-settings')).toContainText('allow the camera for LU')
    await page.getByTestId('m-remote-scan-close').tap()
    await expect(page.getByTestId('m-remote-scan-screen')).toHaveCount(0)
  })

  test('without any scanner the scan page says so and leads to typing', async ({ page }) => {
    await withoutScanner(page)
    await bridge(page, desk)
    await openShell(page, { route: '/remote/scan' })
    await expect(page.getByTestId('m-remote-scan-none')).toContainText('This phone cannot scan codes inside LU')
    await shot(page, 'r3-none')
    await page.getByTestId('m-remote-scan-enter').tap()
    await expect(page.getByTestId('m-remote-connect-screen')).toBeVisible()
    // And there, the button back to a scanner that does not exist is not offered.
    await expect(page.getByTestId('m-remote-connect-scan')).toHaveCount(0)
  })

  test('memory changed on the desktop: the session is paused with the reason and the way out', async ({ page }) => {
    await withoutScanner(page)
    await bridge(page, desk)
    await openHome(page)
    await pair(page)
    desk.revokeMemory()
    await send(page, 'still there?')
    await expect(page.getByTestId('m-remote-chat-blocked')).toContainText('Memory was changed on your desktop')
    await expect(page.getByTestId('m-remote-chat-blocked')).toContainText('Restart Remote Access on the desktop')
    await shot(page, 'r4-blocked')
    // Restarted on the desktop: a new code, and the old session is gone.
    desk.restart('777111')
    await page.getByTestId('m-remote-chat-retry').tap()
    await expect(page.getByTestId('m-remote-chat-needs-code')).toBeVisible()
    await page.getByTestId('m-remote-chat-enter-code').tap()
    await page.getByTestId('m-remote-connect-passcode').fill('777111')
    await expect(page.getByTestId('m-remote-chat-screen')).toBeVisible()
    await expect(page.getByTestId('m-remote-chat-blocked')).toHaveCount(0)
  })

  // Short check on the iPhone, package 8, B3: "Connect to desktop" on its side at the largest text. The round
  // button that leads to the footer lay on a word of the running text ("It ch[button]es every 15 minutes.").
  for (const view of [
    { name: '844x390', width: 844, height: 390 },
    { name: '592x360', width: 592, height: 360 },
  ]) {
    test(`Connect to desktop on its side at 200 percent, ${view.name}: the round button lies on no text and no field`, async ({ page }) => {
      const errors = watchErrors(page)
      await page.setViewportSize({ width: view.width, height: view.height })
      await withoutScanner(page)
      await bridge(page, desk)
      await openShell(page, { route: '/remote/connect', fontScale: 200 })
      const screen = page.getByTestId('m-remote-connect-screen')
      await expect(screen).toHaveAttribute('data-m-foot', 'scrolls')
      const jump = page.getByTestId('m-foot-jump')
      await expect(jump).toBeInViewport({ ratio: 1 })
      const covered = () =>
        screen.evaluate((el) => {
          const button = el.querySelector('[data-testid="m-foot-jump"]')!.getBoundingClientRect()
          const body = el.querySelector('.m-body')!
          const bodyBox = body.getBoundingClientRect()
          const out: string[] = []
          // Every piece of text and every control of the content that shares a pixel with the button.
          const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim()) continue
            const range = document.createRange()
            range.selectNodeContents(node)
            for (const r of Array.from(range.getClientRects())) {
              const top = Math.max(r.top, bodyBox.top)
              const bottom = Math.min(r.bottom, bodyBox.bottom)
              if (bottom - top > 1 && r.right > button.left + 1 && r.left < button.right - 1 && bottom > button.top + 1 && top < button.bottom - 1) out.push(node.textContent.trim().slice(0, 40))
            }
          }
          return { out, gap: button.top - bodyBox.bottom }
        })
      const atTop = await covered()
      expect(atTop.out).toEqual([])
      expect(atTop.gap).toBeGreaterThanOrEqual(-0.5)
      // Half way down as well: whatever line stands at the lower edge then.
      await screen.locator('.m-body').evaluate((el) => el.scrollTo({ top: 120 }))
      if (await jump.count()) expect((await covered()).out).toEqual([])
      if (await jump.count()) await jump.tap()
      await expect(page.getByTestId('m-remote-connect-submit')).toBeInViewport({ ratio: 1 })
      await expect(jump).toHaveCount(0)
      expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
      expect(errors()).toEqual([])
    })
  }

  for (const size of SIZES.slice(1)) {
    test(`the remote screens fit ${size.name}, also with text at 200 percent`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
      await withoutScanner(page)
      await bridge(page, desk)
      await openShell(page, { fontScale: 200 })
      await showHome(page)
      await expect(page.getByTestId('m-remote-screen')).toHaveAttribute('data-m-status', 'unpaired')
      expect(await measureLayout(page), 'R1').toEqual({ overflow: [], small: [], pageScrolls: false })
      await shot(page, `r1-unpaired-${size.name}-200`)
      await page.getByTestId('m-remote-enter').tap()
      expect(await measureLayout(page), 'R2').toEqual({ overflow: [], small: [], pageScrolls: false })
      await shot(page, `r2-${size.name}-200`)
      await page.getByTestId('m-remote-connect-address').fill(ADDRESS)
      await page.getByTestId('m-remote-connect-passcode').fill(CODE)
      await page.getByTestId('m-remote-connect-submit').tap()
      await expect(page.getByTestId('m-remote-chat-screen')).toBeVisible()
      await send(page, 'short question')
      await expect(page.getByTestId('m-remote-chat-answer')).toHaveAttribute('data-m-state', 'done')
      expect(await measureLayout(page), 'R4').toEqual({ overflow: [], small: [], pageScrolls: false })
      await shot(page, `r4-${size.name}-200`)
      await backHome(page)
      expect(await measureLayout(page), 'R1 connected').toEqual({ overflow: [], small: [], pageScrolls: false })
      await shot(page, `r1-connected-${size.name}-200`)
    })
  }

  for (const size of SIZES.slice(1)) {
    test(`round 2 fits ${size.name} with text at 200 percent: options, photo tray, tool steps, two desktops`, async ({ page }) => {
      await desk.stop()
      desk = await startFakeDesktop({ passcode: CODE, reply: 'The note says: file body.', hostname: 'Studio Mac of the long name' })
      desk.permissions.filesystem = true
      desk.permissions.shell = true
      await page.setViewportSize({ width: size.width, height: size.height })
      await withoutScanner(page)
      await bridge(page, desk)
      // An older chat of another desktop is on the phone.
      await page.addInitScript(() => {
        if (localStorage.getItem('__e2e_seeded')) return
        localStorage.setItem('__e2e_seeded', '1')
        localStorage.setItem('lu-mobile-remote-desktops', JSON.stringify([{ baseUrl: 'http://192.168.1.30:11435', lastConnectedAt: 1, name: 'Office PC' }]))
      })
      await openShell(page, { fontScale: 200 })
      await page.evaluate(async () => {
        const { getRemoteClientStore } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/remote/remoteClientStore.ts`)
        const store = getRemoteClientStore()
        await store.ready
        store.useStore.setState({
          chats: [
            {
              id: 'c-office',
              title: 'Quarterly numbers for the office',
              model: 'office:1b',
              thinkEnabled: false,
              systemPrompt: null,
              agentMode: false,
              caveman: 'off',
              baseUrl: 'http://192.168.1.30:11435',
              createdAt: 1,
              updatedAt: 2,
              messages: [
                { id: 'm1', role: 'user', content: 'Hello office', thinking: '', createdAt: 1, state: 'done', mirrored: true },
                { id: 'm2', role: 'assistant', content: 'From the office.', thinking: '', createdAt: 2, state: 'done' },
              ],
            },
          ],
        })
      })
      await showHome(page)
      await pair(page)

      await page.getByTestId('m-remote-chat-options').tap()
      await expect(page.getByTestId('m-remote-options-agent')).toContainText('web search, files, terminal commands')
      await page.getByTestId('m-remote-options-agent').tap()
      expect(await measureLayout(page), 'options').toEqual({ overflow: [], small: [], pageScrolls: false })
      await shot(page, `r4-options-${size.name}-200`)
      await page.goBack()
      await expect(page.getByTestId('m-sheet-remote-options')).toHaveCount(0)

      await page.getByTestId('m-remote-chat-attach').tap()
      expect(await measureLayout(page), 'attach sheet').toEqual({ overflow: [], small: [], pageScrolls: false })
      const chooser = page.waitForEvent('filechooser')
      await page.getByTestId('m-remote-attach-library').tap()
      await (await chooser).setFiles([
        { name: 'one.png', mimeType: 'image/png', buffer: PNG },
        { name: 'two.png', mimeType: 'image/png', buffer: PNG },
        { name: 'three.png', mimeType: 'image/png', buffer: PNG },
        { name: 'four.png', mimeType: 'image/png', buffer: PNG },
      ])
      await expect(page.getByTestId('m-remote-chat-tray').locator('img')).toHaveCount(4)
      expect(await measureLayout(page), 'tray').toEqual({ overflow: [], small: [], pageScrolls: false })
      await shot(page, `r4-tray-${size.name}-200`)
      // The tray is full: the sheet says so instead of opening a picker that leads nowhere.
      await page.getByTestId('m-remote-chat-attach').tap()
      await expect(page.getByTestId('m-remote-attach-library')).toBeDisabled()
      await expect(page.getByTestId('m-remote-attach-library')).toContainText('up to 4 photos')
      await page.goBack()
      await expect(page.getByTestId('m-sheet-remote-attach')).toHaveCount(0)

      desk.nextToolCalls = [
        { function: { name: 'file_read', arguments: { path: 'a/rather/long/folder/name/with/a/note-about-everything.txt' } } },
        { function: { name: 'shell_execute', arguments: { command: 'ls -la' } } },
      ]
      await send(page, 'Read the note')
      await expect(page.getByTestId('m-remote-chat-answer')).toHaveAttribute('data-m-state', 'done')
      await expect(page.getByTestId('m-remote-chat-step')).toHaveCount(2)
      await page.getByTestId('m-remote-chat-step').first().locator('summary').tap()
      for (const summary of await page.getByTestId('m-remote-chat-step').locator('summary').all()) {
        expect((await summary.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
      }
      expect(await measureLayout(page), 'steps').toEqual({ overflow: [], small: [], pageScrolls: false })
      await shot(page, `r4-steps-${size.name}-200`)

      await backHome(page)
      await expect(page.getByTestId('m-remote-chats-1')).toContainText('Chats on Office PC')
      expect(await measureLayout(page), 'R1 two desktops').toEqual({ overflow: [], small: [], pageScrolls: false })
      await shot(page, `r1-two-desktops-${size.name}-200`)
      await page.getByTestId('m-remote-chat-row-c-office').tap()
      await expect(page.getByTestId('m-remote-chat-other-desktop')).toBeVisible()
      expect(await measureLayout(page), 'chat of another desktop').toEqual({ overflow: [], small: [], pageScrolls: false })
      await shot(page, `r4-other-desktop-${size.name}-200`)
    })
  }

  test('on a phone the token lives in the secure storage, and after a restart the desktop is still paired', async ({ page, context }) => {
    const device = await deviceBridge(context, desk)
    await withoutScanner(page)
    await openHome(page)
    await pair(page)
    await send(page, 'remember me')
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveAttribute('data-m-state', 'done')

    // One entry, under the name the native layer uses, bound to the address. Every call went through Rust.
    expect([...device.secrets.keys()]).toEqual(['lu-remote-token'])
    const stored = JSON.parse(device.secrets.get('lu-remote-token') ?? '{}') as { baseUrl?: string; token?: string }
    expect(stored.baseUrl).toBe(BASE)
    expect(stored.token).toBeTruthy()
    expect(device.requests).toContain('POST /remote-api/auth')
    expect(device.requests).toContain('POST /api/chat')
    // The token is nowhere in the storage of the page: not in the old place in IndexedDB, not in localStorage.
    // The chat is, so the place that was looked at is the right one.
    const inPage = await page.evaluate(async (token) => {
      const { idbStorage } = await import(/* @vite-ignore */ `${location.origin}/src/lib/idbStorage.ts`)
      const { getRemoteClientStore } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/remote/remoteClientStore.ts`)
      await getRemoteClientStore().flush()
      const old = await idbStorage.getItem('lu-mobile-remote-token')
      const state = String((await idbStorage.getItem('lu-mobile-remote')) ?? '')
      const local = Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? '').join('\n')
      return { old, inState: state.includes(token), inLocal: local.includes(token), hasState: state.includes('remember me') }
    }, stored.token ?? '')
    expect(inPage).toEqual({ old: null, inState: false, inLocal: false, hasState: true })

    // The app is closed and opened again: a new page of the same phone. No code is asked, no new pairing is made.
    const pairings = () => desk.log.filter((line) => line === 'POST /remote-api/auth').length
    expect(pairings()).toBe(1)
    await page.close()
    const again = await context.newPage()
    await withoutScanner(again)
    await openHome(again)
    await expect(again.getByTestId('m-remote-screen')).toHaveAttribute('data-m-status', 'connected')
    await expect(again.getByTestId('m-remote-connected')).toContainText(`Connected to ${ADDRESS}`)
    await again.locator('[data-testid^="m-remote-chat-row-"]').tap()
    await expect(again.getByTestId('m-remote-chat-question')).toHaveText('remember me')
    await send(again, 'still there?')
    await expect(again.getByTestId('m-remote-chat-answer')).toHaveCount(2)
    await expect(again.getByTestId('m-remote-chat-answer').last()).toHaveAttribute('data-m-state', 'done')
    expect(pairings()).toBe(1)
    await backHome(again)

    // Disconnect removes the entry. After the next start the code is asked again, the chat is still readable.
    await again.getByTestId('m-remote-disconnect').tap()
    await again.getByTestId('m-dialog-confirm').tap()
    await expect(again.getByTestId('m-toast-remote-disconnected')).toBeVisible()
    await expect.poll(() => device.secrets.size).toBe(0)
    await again.close()
    const third = await context.newPage()
    await withoutScanner(third)
    await openHome(third)
    await expect(third.getByTestId('m-remote-home-needs-code')).toBeVisible()
    await expect(third.getByTestId('m-remote-chats').locator('.m-row-title')).toHaveText(['remember me'])
  })

  test('agent mode: the model uses a tool on the desktop, the step is shown and names a switch that is off', async ({ page }) => {
    const errors = watchErrors(page)
    await withoutScanner(page)
    await bridge(page, desk)
    desk.permissions.filesystem = true
    desk.reply = 'The note says: file body.'
    await openHome(page)
    await pair(page)

    await page.getByTestId('m-remote-chat-options').tap()
    await expect(page.getByTestId('m-sheet-remote-options')).toBeVisible()
    // What the desktop allows right now is said in words.
    await expect(page.getByTestId('m-remote-options-agent')).toContainText('web search, files')
    await expect(page.getByTestId('m-remote-options-agent')).not.toContainText('terminal commands')
    await page.getByTestId('m-remote-options-agent').tap()
    await expect(page.getByTestId('m-remote-options-agent')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('m-remote-options-caveman-lite').tap()
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r4-options-agent')
    await page.goBack()
    await expect(page.getByTestId('m-sheet-remote-options')).toHaveCount(0)

    desk.nextToolCalls = [{ function: { name: 'file_read', arguments: { path: 'note.txt' } } }]
    await send(page, 'Read note.txt')
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveAttribute('data-m-state', 'done')
    await expect(page.getByTestId('m-remote-chat-answer')).toContainText('The note says: file body.')
    await expect(page.getByTestId('m-remote-chat-note')).toContainText('Agent mode is on')
    const step = page.getByTestId('m-remote-chat-step')
    await expect(step).toHaveCount(1)
    await expect(step).toHaveAttribute('data-m-state', 'done')
    await expect(step).toContainText('Read file')
    await step.locator('summary').tap()
    await expect(step).toContainText('note.txt')
    await expect(step).toContainText('file body')
    expect((await step.locator('summary').boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r4-agent-step')
    // The tool ran on the desktop, for this chat, and the request offered files but no terminal.
    expect(desk.toolCalls).toHaveLength(1)
    expect(desk.toolCalls[0]).toMatchObject({ tool: 'file_read' })
    const offered = (desk.chatRequests[0].body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)
    expect(offered).toContain('file_read')
    expect(offered).not.toContain('shell_execute')

    // The switch is turned off on the desktop in the middle of a run: the step fails and says which switch.
    desk.nextToolCalls = [{ function: { name: 'file_read', arguments: { path: 'other.txt' } } }]
    desk.reply = 'I could not read it.'
    await page.route(`${BASE}/remote-api/agent-tool`, async (route) => {
      desk.permissions.filesystem = false
      await route.fallback()
    })
    await send(page, 'Read other.txt')
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveCount(2)
    await expect(page.getByTestId('m-remote-chat-answer').last()).toHaveAttribute('data-m-state', 'done')
    const refused = page.getByTestId('m-remote-chat-answer').last().getByTestId('m-remote-chat-step')
    await expect(refused).toHaveAttribute('data-m-state', 'failed')
    await refused.locator('summary').tap()
    await expect(refused.getByTestId('m-remote-chat-step-permission')).toContainText('"Files" is turned off on your desktop')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r4-agent-refused')
    expect(errors()).toEqual([])
  })

  test('agent mode with a model that cannot use tools says so and how to go on', async ({ page }) => {
    await desk.stop()
    desk = await startFakeDesktop({ passcode: CODE, models: ['notools:1b'] })
    await withoutScanner(page)
    await bridge(page, desk)
    await openHome(page)
    await pair(page)
    await page.getByTestId('m-remote-chat-options').tap()
    await page.getByTestId('m-remote-options-agent').tap()
    await page.goBack()
    await send(page, 'Hi')
    await expect(page.getByTestId('m-remote-chat-answer-error')).toContainText('This model cannot use tools')
    await expect(page.getByTestId('m-remote-chat-answer-error')).toContainText('turn Agent mode off')
    // The connection is fine: the same question goes through without Agent mode.
    await page.getByTestId('m-remote-chat-options').tap()
    await page.getByTestId('m-remote-options-agent').tap()
    await page.goBack()
    await page.getByTestId('m-remote-chat-answer-action').tap()
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveAttribute('data-m-state', 'done')
  })

  test('a photo is picked, waits above the text field, can be removed, and travels to the model with the message', async ({ page }) => {
    const errors = watchErrors(page)
    await withoutScanner(page)
    await bridge(page, desk)
    desk.reply = 'A small square.'
    await openHome(page)
    await pair(page)

    const pick = async () => {
      await page.getByTestId('m-remote-chat-attach').tap()
      await expect(page.getByTestId('m-sheet-remote-attach')).toBeVisible()
      const chooser = page.waitForEvent('filechooser')
      await page.getByTestId('m-remote-attach-library').tap()
      await (await chooser).setFiles({ name: 'square.png', mimeType: 'image/png', buffer: PNG })
      await expect(page.getByTestId('m-sheet-remote-attach')).toHaveCount(0)
    }
    await page.getByTestId('m-remote-chat-attach').tap()
    await expect(page.getByTestId('m-sheet-remote-attach')).toContainText('It needs a model that can read images')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r4-attach-sheet')
    await page.goBack()
    await expect(page.getByTestId('m-sheet-remote-attach')).toHaveCount(0)

    await pick()
    await expect(page.getByTestId('m-remote-chat-tray').locator('img')).toHaveCount(1)
    // A photo alone can be sent: the send button is there without any text.
    await expect(page.getByTestId('m-remote-chat-send')).toBeVisible()
    await page.getByTestId('m-remote-chat-tray-remove-0').tap()
    await expect(page.getByTestId('m-remote-chat-tray')).toHaveCount(0)

    await pick()
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r4-photo-tray')
    await send(page, 'What is this?')
    await expect(page.getByTestId('m-remote-chat-answer')).toContainText('A small square.')
    await expect(page.getByTestId('m-remote-chat-tray')).toHaveCount(0)
    await expect(page.getByTestId('m-remote-chat-photos').locator('img')).toHaveCount(1)
    const sent = desk.chatRequests[0].body.messages as Array<{ role: string; content: string; images?: string[] }>
    const question = sent.at(-1)
    expect(question?.content).toBe('What is this?')
    expect(question?.images).toHaveLength(1)
    // What went to the model is a real picture, as raw base64 without a data prefix.
    expect(question?.images?.[0].startsWith('data:')).toBe(false)
    expect(Buffer.from(question?.images?.[0] ?? '', 'base64').subarray(1, 4).toString()).toBe('PNG')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'r4-photo-sent')

    // After a restart the preview is still in the transcript (the start opens a new chat, round 57).
    await page.reload()
    await page.getByTestId('m-app').waitFor()
    await screensLoaded(page)
    await showHome(page)
    await page.locator('[data-testid^="m-remote-chat-row-"]').tap()
    await expect(page.getByTestId('m-remote-chat-screen')).toBeVisible()
    await expect(page.getByTestId('m-remote-chat-photos').locator('img')).toHaveCount(1)
    expect(errors()).toEqual([])
  })

  test('the photo sheet opened without a chat locks both rows and says why (acceptance Android, W5, N14)', async ({ page }) => {
    const errors = watchErrors(page)
    // The way the sweep of the acceptance frame opens it: the sheet alone, no remote chat behind it.
    await openShell(page, { route: '/dev/routes' })
    await page.getByTestId('m-dev-sheet-open-remote-attach').tap()
    await expect(page.getByTestId('m-sheet-remote-attach')).toBeVisible()
    for (const id of ['m-remote-attach-camera', 'm-remote-attach-library']) {
      await expect(page.getByTestId(id)).toBeDisabled()
      await expect(page.getByTestId(id)).toContainText('Open a chat with your desktop first.')
    }
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    expect(errors()).toEqual([])
  })

  test('a desktop that sends its computer name is called by it, and chats stay with the desktop they were held with', async ({ page }) => {
    const errors = watchErrors(page)
    await desk.stop()
    desk = await startFakeDesktop({ passcode: CODE, reply: 'From the studio.', hostname: 'Studio Mac' })
    const OTHER = '192.168.1.30:11435'
    const office = await startFakeDesktop({ passcode: CODE, reply: 'From the office.', models: ['office:1b'], hostname: 'Office PC' })
    try {
      await withoutScanner(page)
      await bridge(page, desk)
      await bridge(page, office, `http://${OTHER}`)
      await openHome(page)
      await pair(page)
      await expect(page.getByTestId('m-remote-chat-screen').locator('.m-hdr-sub')).toHaveText('On Studio Mac')
      await send(page, 'Hello studio')
      await expect(page.getByTestId('m-remote-chat-answer')).toContainText('From the studio.')
      await backHome(page)
      await expect(page.getByTestId('m-remote-connected')).toContainText('Connected to Studio Mac')
      // The address is still there to read, under the name.
      await expect(page.getByTestId('m-remote-connected')).toContainText(ADDRESS)
      await page.getByTestId('m-remote-details').tap()
      await expect(page.getByTestId('m-remote-connection-name')).toContainText('Studio Mac')
      await expect(page.getByTestId('m-remote-connection-address')).toContainText(ADDRESS)
      await page.goBack()
      expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
      await shot(page, 'r1-named')

      // The same phone now pairs with a second desktop.
      await page.getByTestId('m-remote-disconnect').tap()
      await expect(page.getByTestId('m-dialog-remote-disconnect')).toContainText('Disconnect from Studio Mac?')
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-remote-home-needs-code')).toBeVisible()
      await page.getByTestId('m-remote-home-enter-code').tap()
      await expect(page.getByTestId('m-remote-connect-screen')).toBeVisible()
      await page.getByTestId('m-remote-connect-address').fill(OTHER)
      await page.getByTestId('m-remote-connect-passcode').fill(CODE)
      await page.getByTestId('m-remote-connect-submit').tap()
      await expect(page.getByTestId('m-remote-chat-screen')).toBeVisible()
      await expect(page.getByTestId('m-remote-chat-screen').locator('.m-hdr-sub')).toHaveText('On Office PC')
      // A fresh chat, with a model of this desktop.
      await expect(page.getByTestId('m-remote-chat-empty')).toBeVisible()
      await expect(page.getByTestId('m-remote-chat-options')).toContainText('office:1b')
      await send(page, 'Hello office')
      await expect(page.getByTestId('m-remote-chat-answer')).toContainText('From the office.')
      await backHome(page)

      // Two groups, the connected desktop first, each under its name.
      await expect(page.getByTestId('m-remote-chats')).toContainText('Chats on Office PC')
      await expect(page.getByTestId('m-remote-chats').locator('.m-row-title')).toHaveText(['Hello office'])
      await expect(page.getByTestId('m-remote-chats-1')).toContainText('Chats on Studio Mac')
      await expect(page.getByTestId('m-remote-chats-1').locator('.m-row-title')).toHaveText(['Hello studio'])
      await expect(page.getByTestId('m-remote-chats-other-note')).toBeVisible()
      expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
      await shot(page, 'r1-two-desktops')

      // The chat of the studio can be read. It says where it belongs and is not continued at the office.
      await page.getByTestId('m-remote-chats-1').locator('[data-testid^="m-remote-chat-row-"]').tap()
      await expect(page.getByTestId('m-remote-chat-screen').locator('.m-hdr-sub')).toHaveText('On Studio Mac')
      await expect(page.getByTestId('m-remote-chat-other-desktop')).toContainText('This chat was held with Studio Mac')
      await expect(page.getByTestId('m-remote-chat-other-desktop')).toContainText('connected to Office PC')
      await expect(page.getByTestId('m-remote-chat-options')).toContainText('qwen3:8b')
      await page.getByTestId('m-remote-chat-input').fill('and now?')
      await expect(page.getByTestId('m-remote-chat-send')).toBeDisabled()
      expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
      await shot(page, 'r4-other-desktop')
      const before = office.chatRequests.length
      await page.getByTestId('m-remote-chat-other-new').tap()
      await expect(page.getByTestId('m-remote-chat-screen').locator('.m-hdr-sub').last()).toHaveText('On Office PC')
      expect(office.chatRequests.length).toBe(before)
      expect(desk.chatRequests).toHaveLength(1)

      // The office is forgotten: the studio is offered again, by its name, with its address under it.
      await backHome(page)
      await page.getByTestId('m-remote-details').tap()
      await page.getByTestId('m-remote-connection-forget').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-remote-screen')).toHaveAttribute('data-m-status', 'unpaired')
      await expect(page.getByTestId('m-remote-known').locator('.m-row-title')).toHaveText(['Studio Mac'])
      await expect(page.getByTestId('m-remote-known-0')).toContainText(ADDRESS)
      expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
      await shot(page, 'r1-known-named')
      expect(errors()).toEqual([])
    } finally {
      await office.stop()
    }
  })
})

test.describe('resilience', () => {
  test('the offline line needs an answer, not only a link, and goes away by itself', async ({ page }) => {
    const errors = watchErrors(page)
    let reachable = false
    let probes = 0
    // The probe of the developer server asks the app's own origin (resilience/useOnline.ts).
    await page.route('**/LU-monogram.svg?t=*', (route) => {
      probes += 1
      return reachable ? route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }) : route.abort('internetdisconnected')
    })
    await page.clock.install()
    await openShell(page, { route: '/dev/ui' })
    // With Cloud on the chat page under this one needs the network too and carries its own line.
    const line = page.getByTestId('m-dev-ui-screen').getByTestId('m-app-offline')
    await expect(line).toHaveCount(0)

    // Cloud is off: nobody is asked, and LU Cloud being unreachable does not raise the line (H1).
    await page.clock.fastForward(46_000)
    await page.clock.fastForward(2_000)
    await expect(line).toHaveCount(0)
    expect(probes).toBe(0)

    // Cloud on: from now on LU Cloud has to answer.
    reachable = true
    await page.evaluate(async () => {
      const { useSettingsStore } = (await import(/* @vite-ignore */ '/src/stores/settingsStore.ts' as string)) as typeof import('../../src/stores/settingsStore')
      useSettingsStore.getState().updateSettings({ appMode: 'cloud' })
    })
    await expect.poll(() => probes).toBeGreaterThan(0)
    await expect(line).toHaveCount(0)

    // A Wi-Fi without internet: the browser still says "online", nothing answers.
    reachable = false
    expect(await page.evaluate(() => navigator.onLine)).toBe(true)
    await page.clock.fastForward(46_000)
    await page.clock.fastForward(2_000)
    await expect(line).toContainText('No internet. On device models still work.')
    await shot(page, 'g7-offline')

    // The network answers again: the line goes without a tap.
    reachable = true
    await page.clock.fastForward(4_000)
    await expect(line).toHaveCount(0)

    // No link at all shows at once, and "online" alone does not take the line away.
    await page.context().setOffline(true)
    await expect(line).toBeVisible()
    reachable = false
    await page.context().setOffline(false)
    await page.clock.fastForward(1_000)
    await expect(line).toBeVisible()
    reachable = true
    await page.clock.fastForward(13_000)
    await expect(line).toHaveCount(0)
    expect(errors().filter((text) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(text))).toEqual([])
  })

  test('storage: full shows a toast with the way out, not saved stays until it is saved again', async ({ page }) => {
    const errors = watchErrors(page)
    await page.clock.install()
    await openShell(page)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:storage-quota-exceeded', { detail: { key: 'chat-conversations' } })))
    await expect(page.getByTestId('m-toast-storage-full')).toContainText('LU is running out of space for chats.')

    const health = '/src/lib/storage-health.ts'
    await page.evaluate(async (file) => {
      const lib = (await import(/* @vite-ignore */ file)) as { reportStorageWriteFailure: (f: unknown) => void }
      lib.reportStorageWriteFailure({ key: 'chat-conversations', bytes: 1024, savedTo: 'nowhere', error: 'QuotaExceededError' })
    }, health)
    const line = page.getByTestId('m-app-storage-not-saved')
    // Round 21, F11: the line names the reason (the error is a full quota) and the chat it is about.
    await expect(line).toContainText('Your phone is out of storage. This chat is not saved yet.')
    // The line sits above the page, not under it, and nothing else shows the same thing twice.
    expect(await line.evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(60)
    await expect(page.getByTestId('m-app-storage-not-saved')).toHaveCount(1)
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'g12-not-saved')

    // The write works again: the line goes by itself and the app says that it is safe now.
    await page.evaluate(async (file) => {
      const lib = (await import(/* @vite-ignore */ file)) as { reportStorageWriteOk: (key: string) => void }
      lib.reportStorageWriteOk('chat-conversations')
    }, health)
    await page.clock.fastForward(6_000)
    await expect(line).toHaveCount(0)
    await expect(page.getByTestId('m-toast-storage-saved-again')).toContainText('Saved again')

    // The way out of the line leads to the storage page.
    await page.evaluate(async (file) => {
      const lib = (await import(/* @vite-ignore */ file)) as { reportStorageWriteFailure: (f: unknown) => void }
      lib.reportStorageWriteFailure({ key: 'chat-conversations', bytes: 1024, savedTo: 'nowhere', error: 'QuotaExceededError' })
    }, health)
    await line.getByRole('button', { name: 'Manage storage' }).tap()
    await expect(page.getByTestId('m-settings-storage-screen')).toBeVisible()
    expect(errors()).toEqual([])
  })

  test('renders that were booked before the app was closed are announced once', async ({ page }) => {
    await page.addInitScript(() => {
      const started = Date.now() - 120_000
      localStorage.setItem(
        'lu-pending-cloud-jobs',
        JSON.stringify([
          { id: 'job-1', kind: 'image', op: 'generate', model: 'm', prompt: 'p', startedAt: started, deadlineAt: started + 3_600_000, landing: 'gallery' },
          { id: 'job-2', kind: 'video', op: 'generate', model: 'm', prompt: 'p', startedAt: started, deadlineAt: started + 3_600_000, landing: 'gallery' },
        ]),
      )
    })
    await openShell(page)
    const toast = page.getByTestId('m-toast-cloud-picked')
    await expect(toast).toContainText('Picked up 2 running jobs. The result goes to your gallery.')
    await shot(page, 'g8-jobs')
    await toast.getByRole('button', { name: 'Open gallery' }).tap()
    await expect(page.getByTestId('m-create-gallery-screen')).toBeVisible()
  })

  test('an answer that was cut when the phone closed LU is said once, with the way to the chat', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page, { route: '/dev/ui' })
    await expect(page.getByTestId('m-app-resume')).toHaveCount(0)
    // What the recovery at the start leaves behind: the last answer of a chat carries the mark "interrupted".
    await page.evaluate(async () => {
      const file = '/src/stores/chatStore.ts'
      const lib = (await import(/* @vite-ignore */ file)) as { useChatStore: { setState: (s: unknown) => void } }
      const at = Date.now() - 60_000
      lib.useChatStore.setState({
        conversations: [
          {
            id: 'cut-chat',
            title: 'Trip plan',
            createdAt: at,
            updatedAt: at,
            model: 'm',
            messages: [
              { id: 'q1', role: 'user', content: 'Plan my trip', timestamp: at },
              { id: 'a1', role: 'assistant', content: 'Day one:', timestamp: at, finishReason: 'interrupted' },
            ],
          },
        ],
      })
    })
    const notice = page.getByTestId('m-app-resume')
    await expect(notice).toContainText('LU was closed while answering')
    await expect(notice).toContainText('The answer is saved up to that point.')
    // No chat is on the screen: nothing to mix it up with, the chat is not named.
    await expect(notice).not.toContainText('another chat')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'g8-interrupted')
    // One cut answer, and no model of this phone to go on inside it (round 10): the button only leads to its
    // chat. "Continue answer" stands here where the engine of the phone holds the model (chat.mobile.ts, H2);
    // anywhere else the step under the answer is "Regenerate", which is not taken from a notice.
    await expect(page.getByTestId('m-app-resume-open')).toHaveText('Open chat')
    await page.getByTestId('m-app-resume-open').tap()
    await expect(page.locator('.m-page:not([data-m-hidden])')).toHaveAttribute('data-route', '/chat/:id')
    await expect(notice).toHaveCount(0)
    // Said once: it does not come back after a restart.
    expect(await page.evaluate(() => localStorage.getItem('lu-mobile-resume-seen'))).toBe('["a1"]')
    expect(errors()).toEqual([])
  })

  test('the notice about a cut answer names its chat while a different chat is open (acceptance Android, N13)', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page, { route: '/dev/ui' })
    await page.evaluate(async () => {
      const lib = (await import(/* @vite-ignore */ '/src/stores/chatStore.ts' as string)) as { useChatStore: { setState: (s: unknown) => void } }
      const nav = (await import(/* @vite-ignore */ '/src/mobile/nav/api.ts' as string)) as { navApi: { resetTo: (tab: string, stack: unknown[]) => void } }
      const at = Date.now() - 60_000
      lib.useChatStore.setState({
        conversations: [
          {
            id: 'cut-chat',
            title: 'Trip plan',
            createdAt: at,
            updatedAt: at,
            model: 'm',
            messages: [
              { id: 'q1', role: 'user', content: 'Plan my trip', timestamp: at },
              { id: 'a1', role: 'assistant', content: '', timestamp: at, finishReason: 'interrupted' },
            ],
          },
          {
            id: 'other-chat',
            title: 'Tides',
            createdAt: at,
            updatedAt: at,
            model: 'm',
            messages: [
              { id: 'q2', role: 'user', content: 'Why are there tides?', timestamp: at },
              { id: 'a2', role: 'assistant', content: 'Because of the moon.', timestamp: at },
            ],
          },
        ],
      })
      nav.navApi.resetTo('chat', [{ route: '/chat/:id', params: { id: 'other-chat' } }])
    })
    await expect(page.locator('.m-page:not([data-m-hidden])')).toHaveAttribute('data-route', '/chat/:id')
    const notice = page.getByTestId('m-app-resume')
    await expect(notice).toContainText('Nothing of the answer was saved yet. Ask again to get it. It belongs to another chat: Trip plan.')
    await expect(page.getByTestId('m-app-resume-open')).toHaveText('Ask again')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    // In the chat it is about, the notice is gone: the box under the answer says it there (checks on Android with 4 GB, F7, and on the iPhone, M4).
    await page.evaluate(async () => {
      const nav = (await import(/* @vite-ignore */ '/src/mobile/nav/api.ts' as string)) as { navApi: { resetTo: (tab: string, stack: unknown[]) => void } }
      nav.navApi.resetTo('chat', [{ route: '/chat/:id', params: { id: 'cut-chat' } }])
    })
    await expect(notice).toHaveCount(0)
    await expect(page.getByTestId('m-chat-error')).toContainText('Nothing of the answer was saved.')
    expect(errors()).toEqual([])
  })

  test('an error that reaches the top: nothing is lost, the report can be copied, restart brings the app back', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await withoutScanner(page)
    await bridge(page, desk)
    await openHome(page)
    await pair(page)
    await send(page, 'before the crash')
    await expect(page.getByTestId('m-remote-chat-answer')).toHaveAttribute('data-m-state', 'done')

    // A component of the frame throws while it renders (a toast whose text is no text).
    await page.evaluate(async () => {
      const file = '/src/mobile/ui/Toast.tsx'
      const ui = (await import(/* @vite-ignore */ file)) as { useToastStore: { setState: (s: unknown) => void } }
      ui.useToastStore.setState({ current: { id: 999, text: { broken: true } } })
    })
    const fatal = page.getByTestId('m-fatal-screen')
    // The app was running: the screen says so, and not that it could not start. One title, not two.
    await expect(fatal).toContainText('LU ran into a problem.')
    await expect(fatal).not.toContainText('LU could not start.')
    await expect(fatal.locator('h1, h2, h3')).toHaveCount(1)
    await expect(page.getByTestId('m-fatal-safe')).toContainText('Nothing was deleted')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    await shot(page, 'g4-fatal')

    await page.getByTestId('m-fatal-copy').tap()
    await expect(page.getByTestId('m-fatal-copy-result')).toHaveAttribute('data-m-copied', 'yes')
    const report = await page.evaluate(() => navigator.clipboard.readText())
    expect(report).toContain('LU error report')
    expect(report).toContain('Screen: /remote/chat/:id')
    expect(report).toContain('LU diagnostics')
    // The report holds figures, never what was written in a chat.
    expect(report).not.toContain('before the crash')
    expect(report).not.toContain('Hello from the desktop model.')

    // The reset asks first, and "Cancel" leads back.
    await page.getByTestId('m-fatal-reset').tap()
    await expect(page.getByTestId('m-fatal-reset-confirm')).toBeVisible()
    // The mark is on the button that resets, not on a frame around it.
    await expect(page.getByTestId('m-fatal-reset-confirm')).toHaveAttribute('data-m-risk', 'destructive')
    await page.getByTestId('m-fatal-reset-cancel').tap()

    await page.getByTestId('m-fatal-retry').tap()
    await page.getByTestId('m-app').waitFor()
    await screensLoaded(page)
    // Same chat, same pairing, question and answer still there.
    await expect(page.getByTestId('m-remote-chat-question')).toHaveText('before the crash')
    await expect(page.getByTestId('m-remote-chat-answer')).toContainText('Hello from the desktop model.')
    await expect(page.getByTestId('m-remote-chat-screen').locator('.m-hdr-sub')).toHaveText(`On ${ADDRESS}`)
  })
})
