/**
 * B29 on Windows (I1, box 31.10.2026): WebView2 puts Tauri's init scripts into
 * every frame, the HTML preview's too. A model's page could then hook
 * `Headers`, call `invoke`, and read the app's invoke key off the header Tauri
 * sets. The preview server puts html_preview_guard.js in front of every page;
 * this proves in Chromium (the engine of WebView2) that the key stays put.
 *
 * Playwright's init script runs in every frame, as WebView2's does. It stands
 * in for Tauri 2.10.3's injection: the same non-configurable properties, the
 * key in a closure, `invoke` -> `postMessage` -> `new Headers` ->
 * `headers.set('Tauri-Invoke-Key', key)` -> `fetch`, and on a failed fetch the
 * `window.ipc.postMessage` path with the key in the message.
 *
 * Run: npx playwright test e2e/html-preview-guard.spec.ts --project=chromium
 */
import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src-tauri/src/html_preview_guard.js'), 'utf8')
const KEY = 'K3Y-of-the-app-0123456789'

function tauriLike(key: string) {
  const w = window as unknown as Record<string, unknown>
  const sent: { where: string; headerKey: string | null; viaIpc: boolean }[] = []
  Object.defineProperty(window, '__lu_sent', { value: sent })
  Object.defineProperty(window, 'isTauri', { value: true })
  Object.defineProperty(window, 'ipc', {
    // wry: `postMessage: s => window.chrome.webview.postMessage(s)`
    value: Object.freeze({
      postMessage: (s: string) => {
        sent.push({ where: location.href, headerKey: null, viaIpc: s.includes(key) })
        const c = (window as unknown as { chrome?: { webview?: { postMessage: (s: string) => void } } }).chrome
        if (c && c.webview) c.webview.postMessage(s)
      },
    }),
  })
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: { plugins: {} } })
  const internals = w.__TAURI_INTERNALS__ as Record<string, unknown>
  ;(function () {
    const __TAURI_INVOKE_KEY__ = key
    let failed = false
    function sendIpcMessage(message: { cmd: string; payload: unknown; options?: { headers?: Record<string, string> } }): Promise<unknown> {
      if (!failed) {
        const headers = new Headers((message.options && message.options.headers) || {})
        headers.set('Content-Type', 'application/json')
        headers.set('Tauri-Invoke-Key', __TAURI_INVOKE_KEY__)
        return fetch('http://ipc.localhost/' + message.cmd, { method: 'POST', body: JSON.stringify(message.payload), headers }).then(
          (r) => r,
          (): Promise<unknown> => {
            failed = true
            return sendIpcMessage(message)
          },
        )
      }
      ;(window as unknown as { ipc: { postMessage: (s: string) => void } }).ipc.postMessage(
        JSON.stringify({ cmd: message.cmd, payload: message.payload, __TAURI_INVOKE_KEY__ }),
      )
      return Promise.resolve()
    }
    Object.defineProperty(internals, 'postMessage', { value: sendIpcMessage })
    Object.defineProperty(internals, 'invoke', {
      value: (cmd: string, payload: unknown) => new Promise((ok, no) => { try { sendIpcMessage({ cmd, payload }).then(ok, no) } catch (e) { no(e) } }),
    })
  })()
  // What reaches the "app": the transport records the header it was given.
  const realFetch = window.fetch
  Object.defineProperty(window, '__lu_fetch', { value: realFetch })
  window.fetch = ((url: string, init?: RequestInit) => {
    if (String(url).startsWith('http://ipc.localhost/')) {
      sent.push({ where: location.href, headerKey: new Headers(init?.headers).get('Tauri-Invoke-Key'), viaIpc: false })
      return Promise.resolve(new Response('{}'))
    }
    return realFetch(url, init)
  }) as typeof fetch
}

/** The model's page: every hook it can set after the guard, then `invoke`. */
const ATTACK = `<script>
  window.stolen = [];
  const grab = (v) => { if (typeof v === 'string' && v.indexOf('K3Y') === 0) window.stolen.push(v) };
  try { const P = Headers.prototype; const s = P.set; P.set = function (k, v) { grab(v); return s.call(this, k, v) } } catch (e) {}
  try { const P = Headers.prototype; const a = P.append; P.append = function (k, v) { grab(v); return a.call(this, k, v) } } catch (e) {}
  try { const R = Headers; window.Headers = function (i) { const h = new R(i); const s = h.set.bind(h); h.set = (k, v) => { grab(v); return s(k, v) }; return h } } catch (e) {}
  try { Object.defineProperty(window, 'Headers', { value: function (i) { return { set: (k, v) => grab(v), append: () => {} } } }) } catch (e) {}
  try { const d = Object.defineProperty; Object.defineProperty = function (o, k, x) { if (x && typeof x.value === 'function') return o; return d(o, k, x) } } catch (e) {}
  try { const ap = Reflect.apply; Reflect.apply = function (f, t, args) { (args || []).forEach(grab); return ap(f, t, args) } } catch (e) {}
  try { const tl = String.prototype.toLowerCase; String.prototype.toLowerCase = function () { return 'x' } } catch (e) {}
  try { window.fetch = (u, i) => { try { new (window.__lu_fetch ? Headers : Headers)(i && i.headers) } catch (e) {} ; return Promise.reject(new TypeError('blocked')) } } catch (e) {}
  try { window.chrome = { webview: { postMessage: (s) => grab(JSON.parse(s).__TAURI_INVOKE_KEY__) } } } catch (e) {}
  window.result = (async () => {
    let invoke = 'none'
    try { await window.__TAURI_INTERNALS__.invoke('log_write', { line: 'from the frame' }); invoke = 'resolved' } catch (e) { invoke = 'rejected: ' + e.message }
    try { await window.__TAURI_INTERNALS__.postMessage({ cmd: 'log_write', payload: {} }) } catch (e) {}
    return { invoke, stolen: window.stolen.slice(), internals: typeof window.__TAURI_INTERNALS__, sent: (window.__lu_sent || []).slice() }
  })()
</script>`

/** The app's window, loaded by navigation so the init script runs in it. */
async function open(page: Page, html: string) {
  await page.route('http://lu-app.test/', (r) => r.fulfill({ contentType: 'text/html', body: html }))
  await page.goto('http://lu-app.test/')
}

async function frameResult(page: Page, withGuard: boolean) {
  const doc = (withGuard ? `<script>${GUARD}</script>` : '') + ATTACK
  await open(page, `<iframe id="f" sandbox="allow-scripts"></iframe>`)
  await page.locator('#f').evaluate((f, d) => { (f as HTMLIFrameElement).srcdoc = d }, doc)
  const frame = await (await page.locator('#f').elementHandle())!.contentFrame()
  await expect.poll(async () => frame!.evaluate(() => typeof (window as unknown as { result?: unknown }).result)).toBe('object')
  return frame!.evaluate(() => (window as unknown as { result: Promise<{ invoke: string; stolen: string[]; internals: string; sent: unknown[] }> }).result)
}

test.describe('B29 preview guard (Windows: Tauri in every frame)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(tauriLike, KEY)
  })

  test('COUNTER-CHECK: without the guard the page reads the key', async ({ page }) => {
    const r = await frameResult(page, false)
    expect(r.stolen).toContain(KEY)
  })

  test('with the guard no hook gets the key, and no call reaches the app', async ({ page }) => {
    const r = await frameResult(page, true)
    expect(r.stolen).toEqual([])
    expect(r.invoke).toMatch(/^rejected: No app access from the preview/)
    // Nothing left the frame, neither over "fetch" nor over window.ipc.
    expect(r.sent).toEqual([])
    // The globals are there (non-configurable, as on WebView2) and of no use.
    expect(r.internals).toBe('object')
  })

  test('the app window keeps its IPC: the guard does nothing in a top frame', async ({ page }) => {
    await open(page, `<script>${GUARD}</script><p>app</p>`)
    const r = await page.evaluate(async () => {
      const t = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, p: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
      await t.invoke('log_write', { line: 'from the app' })
      return (window as unknown as { __lu_sent: { headerKey: string | null }[] }).__lu_sent
    })
    expect(r).toEqual([expect.objectContaining({ headerKey: KEY })])
  })

  test('a page of its own still builds headers and calls the network the normal way', async ({ page }) => {
    await open(page, `<iframe id="f" sandbox="allow-scripts"></iframe>`)
    const doc = `<script>${GUARD}</script><script>
      const h = new Headers({ 'X-A': '1' }); h.set('X-B', '2'); h.append('X-B', '3');
      window.out = { a: h.get('X-A'), b: h.get('X-B'), inst: h instanceof Headers, req: new Request('https://example.com/', { headers: h }).headers.get('X-B') }
    </script>`
    await page.locator('#f').evaluate((f, d) => { (f as HTMLIFrameElement).srcdoc = d }, doc)
    const frame = await (await page.locator('#f').elementHandle())!.contentFrame()
    await expect.poll(async () => frame!.evaluate(() => (window as unknown as { out?: unknown }).out)).toEqual({ a: '1', b: '2, 3', inst: true, req: '2, 3' })
  })
})
