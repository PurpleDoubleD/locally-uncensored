/**
 * What the scaffold of the mobile shell connects and supplies, in a browser
 * without Tauri: the global notices (storage, credits, replaced model, a
 * link from outside), the back signal of the native layer, text scale with
 * its cap and its event, the short slide of a page that leaves, the toast
 * that keeps away from the buttons of a dialog, and the diagnostics figures.
 *
 * The parts that need a phone (safe areas, the keyboard, the system back
 * key, dark and light from the system) are measured on the emulator and in
 * the simulator; the shots are under mobile-docs/belege/shell-*.png.
 */
import { expect, test, type Page } from '@playwright/test'
import { ROUTES } from '../../src/mobile/nav/routes'
import { CLEAN_LAYOUT, androidTextZoom, clippedSymbols, declareAdult, measureLayout, openShell, screensLoaded, shellUrl, textLines, topPage, watchErrors } from './support'

async function signal(page: Page, name: string, detail: unknown = null): Promise<void> {
  await page.evaluate(([n, d]) => window.dispatchEvent(new CustomEvent(n as string, { detail: d })), [name, detail] as const)
}

async function toChatsRoot(page: Page): Promise<void> {
  await page.getByTestId('m-page-back').tap()
  await expect(page.getByTestId('m-chats-screen')).toBeVisible()
}

test.describe('scaffold of the mobile shell', () => {
  test('a full chat storage shows a notice that leads to the storage page', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page)
    await signal(page, 'lu:storage-quota-exceeded', { key: 'chat-conversations' })
    const toast = page.getByTestId('m-toast-storage-full')
    await expect(toast).toContainText('running out of space')
    await toast.getByRole('button', { name: 'Manage storage' }).tap()
    await expect(page.getByTestId('m-settings-storage-screen')).toBeVisible()
    await expect(toast).toHaveCount(0)
    expect(errors()).toEqual([])
  })

  test('out of credits opens the sheet once, and back closes it', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page)
    await signal(page, 'lu:credits-exhausted', { reason: 'credits' })
    await expect(page.getByTestId('m-sheet-credits')).toBeVisible()
    // The same signal again while the sheet is open does not stack a second one.
    await signal(page, 'lu:credits-exhausted', { reason: 'credits' })
    await expect(page.getByTestId('m-sheet-credits')).toHaveCount(1)
    await page.goBack()
    await expect(page.getByTestId('m-sheet-credits')).toHaveCount(0)
    await expect(page.getByTestId('m-chat-screen')).toBeVisible()
    expect(errors()).toEqual([])
  })

  test('a link from outside becomes an offer and runs nothing by itself', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page)
    await signal(page, 'lu:deep-link', { url: 'lu://remote?address=192.168.0.12%3A8080' })
    await expect(page.getByTestId('m-sheet-link-offer')).toBeVisible()
    // A link that is not ours offers nothing.
    await page.goBack()
    await expect(page.getByTestId('m-sheet-link-offer')).toHaveCount(0)
    await signal(page, 'lu:deep-link', { url: 'https://example.com/' })
    await page.waitForTimeout(200)
    await expect(page.getByTestId('m-sheet-link-offer')).toHaveCount(0)
    expect(errors()).toEqual([])
  })

  test('the back signal of the native layer closes sheet, then page, and reports the root', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page, { route: '/dev/ui' })
    await page.getByTestId('m-dev-ui-open-sheet').tap()
    await expect(page.getByTestId('m-sheet-dev-demo')).toBeVisible()

    const back = () =>
      page.evaluate(() => {
        const detail: { handled?: boolean } = {}
        window.dispatchEvent(new CustomEvent('lu:back', { detail }))
        return detail.handled
      })
    expect(await back()).toBe(true)
    await expect(page.getByTestId('m-sheet-dev-demo')).toHaveCount(0)
    await expect(page.getByTestId('m-dev-ui-screen')).toBeVisible()
    expect(await back()).toBe(true)
    await expect(page.getByTestId('m-dev-ui-screen')).toHaveCount(0)
    expect(await back()).toBe(true)
    await expect(page.getByTestId('m-chats-screen')).toBeVisible()
    await expect(page.getByTestId('m-nav')).toBeVisible()
    // At the root of the Chat tab nothing is left to close: the app may end.
    expect(await back()).toBe(false)
    await expect(page.getByTestId('m-chats-screen')).toBeVisible()
    expect(errors()).toEqual([])
  })

  test('a page that leaves slides out briefly and is gone, the one below stays itself', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page)
    await toChatsRoot(page)
    await page.getByTestId('m-nav-settings').tap()
    await expect(page.getByTestId('m-settings-screen')).toBeVisible()
    await signal(page, 'lu:storage-quota-exceeded')
    await page.getByRole('button', { name: 'Manage storage' }).tap()
    await expect(page.getByTestId('m-settings-storage-screen')).toBeVisible()

    // The step back goes through the history, so the leaving page shows up a moment after the tap.
    const during = await page.evaluate(async () => {
      ;(document.querySelector('[data-testid="m-page-back"]') as HTMLElement).click()
      let leaving: Element | null = null
      for (let i = 0; i < 60 && !leaving; i += 1) {
        leaving = document.querySelector('.m-page[data-m-exit]')
        if (!leaving) await new Promise((done) => requestAnimationFrame(done))
      }
      return {
        route: leaving?.getAttribute('data-route') ?? null,
        inert: leaving?.hasAttribute('inert') ?? null,
        hidden: leaving?.getAttribute('aria-hidden') ?? null,
        animation: leaving ? getComputedStyle(leaving).animationName : null,
      }
    })
    expect(during).toEqual({ route: '/settings/storage', inert: true, hidden: 'true', animation: 'm-slide-out' })
    await expect(page.locator('.m-page[data-m-exit]')).toHaveCount(0)
    await expect(page.getByTestId('m-settings-storage-screen')).toHaveCount(0)
    await expect(page.getByTestId('m-settings-screen')).toBeVisible()
    // A tab switch changes at once, nothing lingers.
    const afterSwitch = await page.evaluate(() => {
      ;(document.querySelector('[data-testid="m-nav-models"]') as HTMLElement).click()
      return document.querySelectorAll('.m-page[data-m-exit]').length
    })
    expect(afterSwitch).toBe(0)
    expect(errors()).toEqual([])
  })

  test('with reduced motion the leaving page fades instead of sliding', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openShell(page, { route: '/dev/ui' })
    const animation = await page.evaluate(async () => {
      ;(document.querySelector('[data-testid="m-page-back"]') as HTMLElement).click()
      let leaving: Element | null = null
      for (let i = 0; i < 60 && !leaving; i += 1) {
        leaving = document.querySelector('.m-page[data-m-exit]')
        if (!leaving) await new Promise((done) => requestAnimationFrame(done))
      }
      return leaving ? getComputedStyle(leaving).animationName : null
    })
    expect(animation).toBe('m-fade-out')
    await expect(page.locator('.m-page[data-m-exit]')).toHaveCount(0)
  })

  test('text scale: the switch fixes it, the system size is measured, capped at 200 percent and announced', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page, { fontScale: 200 })
    await expect(page.locator('html')).toHaveAttribute('data-font-scale', '200')

    await openShell(page)
    await expect(page.locator('html')).toHaveAttribute('data-font-scale', '100')
    // The user sets a larger default size (what a system setting does to the root).
    const heard = await page.evaluate(async () => {
      const events: number[] = []
      window.addEventListener('lu:font-scale', (event) => events.push((event as CustomEvent<{ scale: number }>).detail.scale))
      const style = document.createElement('style')
      style.id = 'test-root-size'
      style.textContent = "html[data-shell='mobile'] { font-size: 24px !important }"
      document.head.appendChild(style)
      await new Promise((resolve) => setTimeout(resolve, 400))
      const at150 = { events: [...events], attr: document.documentElement.dataset.fontScale, title: parseFloat(getComputedStyle(document.querySelector('.m-hdr-title')!).fontSize) }
      // Far above the cap: 400 percent.
      style.textContent = "html[data-shell='mobile'] { font-size: 64px }"
      await new Promise((resolve) => setTimeout(resolve, 400))
      return { at150, capped: { last: events.at(-1), attr: document.documentElement.dataset.fontScale, root: getComputedStyle(document.documentElement).fontSize } }
    })
    expect(heard.at150.events).toEqual([1.5])
    expect(heard.at150.attr).toBe('150')
    expect(heard.at150.title).toBeGreaterThan(24)
    expect(heard.capped).toEqual({ last: 2, attr: '200', root: '32px' })
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    expect(errors()).toEqual([])
  })

  test('pause and resume from the native layer do not disturb the shell', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page)
    await toChatsRoot(page)
    await page.getByTestId('m-nav-models').tap()
    await signal(page, 'lu:background')
    await signal(page, 'lu:memory-warning', { level: 'critical' })
    await signal(page, 'lu:foreground')
    await expect(page.getByTestId('m-models-screen')).toBeVisible()
    await expect(page.getByTestId('m-nav-models')).toHaveAttribute('aria-selected', 'true')
    expect(errors()).toEqual([])
  })

  // Round 57 (David): a cold start always lands in a new, empty chat, with the model choice and the composer.
  // Only a return from the background keeps what was open (the test above). The other tabs keep their pages.
  test('a cold start opens a new chat; the tab that was open waits behind its tab, and empty chats never pile up', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page)
    await toChatsRoot(page)
    await page.getByTestId('m-nav-settings').tap()
    await page.getByTestId('m-settings-about').tap()
    await expect(page.getByTestId('m-settings-about-screen')).toBeVisible()
    for (let start = 0; start < 2; start += 1) {
      await page.reload()
      await page.getByTestId('m-app').waitFor()
      await screensLoaded(page)
      await expect(page.getByTestId('m-chat-screen')).toBeVisible()
      // Without a model the empty chat says how to get one (the text with a model: chat.mobile.ts, round 57).
      await expect(page.getByTestId('m-chat-empty')).toBeVisible()
      await expect(page.getByTestId('m-chat-options')).toBeVisible()
      await expect(page.getByTestId('m-chat-input')).toBeVisible()
    }
    // The new chat is no chat of the list until its first message: two starts left nothing behind.
    await toChatsRoot(page)
    await expect(page.getByTestId('m-nav-chat')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('m-chats-item')).toHaveCount(0)
    await page.getByTestId('m-nav-settings').tap()
    await expect(page.getByTestId('m-settings-about-screen')).toBeVisible()
    expect(errors()).toEqual([])
  })

  test('safe area values from the native layer move header and tab bar, and go back to the system values', async ({ page }) => {
    await openShell(page)
    await toChatsRoot(page)
    await signal(page, 'lu:safe-area', { top: 59, right: 0, bottom: 34, left: 0 })
    const withInsets = await page.evaluate(() => ({
      header: Math.round(document.querySelector('.m-page:not([data-m-hidden]) .m-hdr')!.getBoundingClientRect().top),
      lastTab: Math.round(window.innerHeight - document.querySelector('.m-tab')!.getBoundingClientRect().bottom),
    }))
    expect(withInsets).toEqual({ header: 59, lastTab: 34 })
    await signal(page, 'lu:safe-area', null)
    const without = await page.evaluate(() => Math.round(document.querySelector('.m-page:not([data-m-hidden]) .m-hdr')!.getBoundingClientRect().top))
    expect(without).toBe(0)
  })
})

test.describe('scaffold supplies, in the catalogue', () => {
  test('the shell is as high as the visible part of the screen, not as the screen', async ({ page }) => {
    await openShell(page, { route: '/dev/ui' })
    // What platform/keyboard.ts sets when a keyboard covers the lower part and the system scrolled the page.
    const rect = await page.evaluate(() => {
      const root = document.documentElement
      root.style.setProperty('--m-vh', '300px')
      root.style.setProperty('--m-vtop', '40px')
      const box = document.querySelector('[data-testid="m-app"]')!.getBoundingClientRect()
      const foot = document.querySelector('.m-page:not([data-m-hidden])')!.getBoundingClientRect()
      return { top: Math.round(box.top), height: Math.round(box.height), pageBottom: Math.round(foot.bottom) }
    })
    expect(rect).toEqual({ top: 40, height: 300, pageBottom: 340 })
  })

  test('the diagnostics figures are there, follow a reported speed and wrap on a small phone', async ({ page }) => {
    const errors = watchErrors(page)
    await page.setViewportSize({ width: 320, height: 568 })
    await openShell(page, { route: '/dev/ui' })
    const report = page.getByTestId('m-dev-ui-diagnostics')
    await report.scrollIntoViewIfNeeded()
    await expect(report).toContainText('LU diagnostics')
    await expect(report).toContainText('Engine:')
    await expect(report).toContainText('Last speed: not measured yet')
    await expect(report).toContainText('Text size: 100 percent')
    await page.getByTestId('m-dev-ui-diag-speed').tap()
    await expect(report).toContainText('Last speed: 12 tokens per second (96 tokens in 8.0 s, Gemma 3 4B, on device)')
    expect(await measureLayout(page)).toEqual({ overflow: [], small: [], pageScrolls: false })
    expect(errors()).toEqual([])
  })

  test('the app says it when it replaced the chat model by itself', async ({ page }) => {
    await openShell(page, { route: '/dev/ui' })
    await page.getByTestId('m-dev-ui-model-note').tap()
    await expect(page.getByTestId('m-toast-model-note')).toContainText('is gone from the model list')
  })
})

test.describe('landscape', () => {
  test.use({ viewport: { width: 844, height: 390 } })

  test('a toast does not lie on the buttons of a dialog or a sheet', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page, { route: '/dev/ui' })
    await page.getByTestId('m-dev-ui-dialog').tap()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await signal(page, 'lu:storage-quota-exceeded')
    const toast = page.getByTestId('m-toast-storage-full')
    await expect(toast).toBeVisible()

    const overlap = async (selector: string) =>
      page.evaluate((sel) => {
        const t = document.querySelector('.m-toast')!.getBoundingClientRect()
        return [...document.querySelectorAll(sel)]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && !(r.right <= t.left || r.left >= t.right || r.bottom <= t.top || r.top >= t.bottom)).length
      }, selector)
    expect(await overlap('[role="alertdialog"] button')).toBe(0)
    // The toast itself is inside the window and still tappable.
    const box = await toast.boundingBox()
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(390)

    await page.goBack()
    await expect(dialog).toHaveCount(0)
    await page.getByTestId('m-dev-ui-open-sheet').tap()
    await expect(page.getByTestId('m-sheet-dev-demo')).toBeVisible()
    await signal(page, 'lu:storage-quota-exceeded')
    await expect(toast).toBeVisible()
    expect(await overlap('[data-testid="m-sheet-dev-demo"] button')).toBe(0)
    expect(errors()).toEqual([])
  })

  test('without anything open the toast sits at the bottom, clear of the rail', async ({ page }) => {
    await openShell(page)
    await toChatsRoot(page)
    await signal(page, 'lu:storage-quota-exceeded')
    const toast = page.getByTestId('m-toast-storage-full')
    await expect(toast).toBeVisible()
    const box = (await toast.boundingBox())!
    // Since the short check on Android, package 8, the empty chat list has its "New chat" as the footer of
    // the page. A page with something fixed below its content gets the toast at the top of the content, as
    // with a composer: at the bottom it would lie on that button. A page without one keeps it at the bottom.
    const screen = page.getByTestId('m-chats-screen')
    await expect(screen).toBeVisible()
    const foot = await screen.getAttribute('data-m-foot')
    const jump = await page.getByTestId('m-foot-jump').count()
    const rail = (await page.getByTestId('m-nav').boundingBox())!
    if (foot === 'fixed' || jump) {
      const body = (await screen.locator(':scope > .m-body').boundingBox())!
      expect(box.y).toBeGreaterThanOrEqual(body.y)
      expect(box.y + box.height).toBeLessThanOrEqual(body.y + body.height)
      const hit = await page.evaluate(() => {
        const t = document.querySelector('[data-testid="m-toast-storage-full"]')!.getBoundingClientRect()
        return [...document.querySelectorAll('[data-testid="m-chats-screen"] button')]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && !(r.right <= t.left || r.left >= t.right || r.bottom <= t.top || r.top >= t.bottom)).length
      })
      expect(hit).toBe(0)
    } else {
      expect(box.y).toBeGreaterThan(195)
    }
    // Clear of the rail either way.
    expect(box.x >= rail.x + rail.width || box.x + box.width <= rail.x || box.y >= rail.y + rail.height || box.y + box.height <= rail.y).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Runde 2: the kit. Everything here is looked at in the catalogue /dev/ui and
// on the three developer pages /dev/frame, /dev/composer and /dev/viewer.
// ---------------------------------------------------------------------------

/** 320 by 568 px at 200 percent text: the tightest case the shell supports. */
const SMALL = { width: 320, height: 568 }

async function rect(page: Page, selector: string): Promise<{ top: number; bottom: number; left: number; right: number; width: number; height: number }> {
  return page.evaluate((sel) => {
    const r = document.querySelector(sel)!.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }
  }, selector)
}

function apart(a: { top: number; bottom: number; left: number; right: number }, b: { top: number; bottom: number; left: number; right: number }): boolean {
  return a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom
}

for (const variant of [
  { name: '390x844', width: 390, height: 844, fontScale: 100 },
  { name: '390x844 at 200 percent', width: 390, height: 844, fontScale: 200 },
  { name: '320x568 at 200 percent', width: 320, height: 568, fontScale: 200 },
] as const) {
  test.describe(`kit, ${variant.name}`, () => {
    test.use({ viewport: { width: variant.width, height: variant.height } })

    test('the catalogue with the new parts has nothing sticking out and no small target', async ({ page }) => {
      const errors = watchErrors(page)
      await openShell(page, { route: '/dev/ui', fontScale: variant.fontScale })
      for (const id of ['risk', 'fold', 'permission', 'layout', 'middle', 'markdown']) {
        await expect(page.getByTestId(`m-dev-ui-sec-${id}`)).toBeAttached()
      }
      // The colours of the code arrive a moment later; measure with them in place.
      await expect(page.locator('.m-code[data-highlight] .token').first()).toBeAttached()
      expect(await measureLayout(page)).toEqual(CLEAN_LAYOUT)
      expect(errors()).toEqual([])
    })

    test('the developer pages for frame, composer and viewer are clean', async ({ page }) => {
      const errors = watchErrors(page)
      for (const [route, screen] of [
        ['/dev/frame', 'm-dev-frame-screen'],
        ['/dev/composer', 'm-dev-composer-screen'],
        ['/dev/viewer', 'm-dev-viewer-screen'],
      ] as const) {
        await openShell(page, { route, fontScale: variant.fontScale })
        await expect(page.getByTestId(screen)).toBeVisible()
        expect(await measureLayout(page), route).toEqual(CLEAN_LAYOUT)
      }
      expect(errors()).toEqual([])
    })
  })
}

for (const size of [
  { name: '360x640', width: 360, height: 640 },
  { name: '320x568', width: 320, height: 568 },
] as const) {
  test.describe(`kit at the text zoom of Android, 200 percent, ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    // The kit rule behind acceptance row 5.8: a symbol in a line of text grows with the text or has room.
    test('no ring and no icon of the kit is cut by anything around it', async ({ page }) => {
      const errors = watchErrors(page)
      for (const route of ['/dev/ui', '/dev/frame', '/dev/composer', '/dev/viewer'] as const) {
        await openShell(page, { route, os: 'android' })
        await androidTextZoom(page, 2)
        expect(await clippedSymbols(page), route).toEqual([])
      }
      expect(errors()).toEqual([])
    })

    test('a ring is a whole ring at every size: the track is seen and the line grows with it', async ({ page }) => {
      await openShell(page, { route: '/dev/ui', os: 'android' })
      await androidTextZoom(page, 2)
      const rings = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.m-app .m-ring')].map((el) => {
          const style = getComputedStyle(el)
          const parts = style.borderLeftColor.match(/[\d.]+/g)?.map(Number) ?? []
          return { width: parseFloat(style.width), height: parseFloat(style.height), line: parseFloat(style.borderLeftWidth), track: parts.length >= 4 ? parts[parts.length - 1] : 1, display: style.display }
        }),
      )
      expect(rings.length).toBeGreaterThan(0)
      for (const ring of rings) {
        expect(ring.width, JSON.stringify(ring)).toBeGreaterThan(0)
        expect(ring.width).toBe(ring.height)
        expect(ring.track, JSON.stringify(ring)).toBeGreaterThanOrEqual(0.2)
        expect(ring.line / ring.width, JSON.stringify(ring)).toBeGreaterThanOrEqual(0.1)
        // Never a bare inline box: that has no width and no height of its own.
        expect(ring.display).not.toBe('inline')
      }
    })
  })
}

test.describe('kit: marks on targets', () => {
  test('paid and destructive targets carry data-m-risk on the target itself', async ({ page }) => {
    await openShell(page, { route: '/dev/ui' })
    await expect(page.getByTestId('m-dev-ui-risk-paid')).toHaveAttribute('data-m-risk', 'paid')
    await expect(page.getByTestId('m-dev-ui-risk-destructive')).toHaveAttribute('data-m-risk', 'destructive')
    await expect(page.getByTestId('m-dev-ui-risk-icon')).toHaveAttribute('data-m-risk', 'destructive')
    await expect(page.getByTestId('m-dev-ui-risk-chip')).toHaveAttribute('data-m-risk', 'paid')
    await expect(page.getByTestId('m-dev-ui-risk-row')).toHaveAttribute('data-m-risk', 'destructive')
    await expect(page.getByTestId('m-dev-ui-composer2-send')).toHaveAttribute('data-m-risk', 'paid')
    // What an inventory does with it: every marked target is a button it can leave alone.
    const marked = await page.locator('[data-m-risk]').evaluateAll((els) => els.map((el) => `${el.tagName} ${el.getAttribute('data-m-risk')}`))
    expect(marked.length).toBeGreaterThanOrEqual(6)
    // A link in a text is the one marked target that is no button: it leaves the app, and says so.
    expect(marked.filter((m) => !m.startsWith('BUTTON '))).toEqual(marked.filter((m) => m === 'A leaves-app'))
    expect(marked.every((m) => /^(BUTTON|A) (paid|destructive|leaves-app|sensor)$/.test(m))).toBe(true)
    // A plain button has no mark.
    expect(await page.getByTestId('m-dev-ui-btn-primary').getAttribute('data-m-risk')).toBeNull()
  })

  test('a row is found by the id of its entry, carries its state, and a chosen row can be tapped again', async ({ page }) => {
    await openShell(page, { route: '/dev/ui' })
    const gemma = page.locator('[data-testid="m-dev-ui-model-row"][data-m-id="gemma"]')
    const qwen = page.locator('[data-testid="m-dev-ui-model-row"][data-m-id="qwen"]')
    await gemma.scrollIntoViewIfNeeded()
    await expect(gemma).toHaveAttribute('data-state', 'loaded')
    await expect(qwen).toHaveAttribute('data-state', 'idle')
    await expect(gemma).toHaveAttribute('aria-checked', 'true')
    const picks = page.getByTestId('m-dev-ui-model-picks')
    await expect(picks).toHaveText('Picked 0 times')
    // The chosen row again: with `reselect` the choice is reported (a sheet would close on it).
    await gemma.tap()
    await expect(picks).toHaveText('Picked 1 times')
    await qwen.tap()
    await expect(qwen).toHaveAttribute('aria-checked', 'true')
    await expect(picks).toHaveText('Picked 2 times')
    // A radio row without `reselect` stays quiet on a second tap.
    await page.getByTestId('m-dev-ui-radio-standard').tap()
    await expect(page.getByTestId('m-dev-ui-radio-standard')).toHaveAttribute('aria-checked', 'true')
  })

  test('a banner takes two buttons, each with its own test id', async ({ page }) => {
    await openShell(page, { route: '/dev/ui' })
    const banner = page.getByTestId('m-dev-ui-banner-two')
    await banner.scrollIntoViewIfNeeded()
    await expect(banner.getByRole('button')).toHaveCount(2)
    await page.getByTestId('m-dev-ui-banner-open').tap()
    await expect(page.getByTestId('m-toast')).toHaveText('Opened')
    await page.getByTestId('m-dev-ui-banner-dismiss').tap()
    await expect(page.getByTestId('m-toast')).toHaveText('Dismissed')
    await page.getByTestId('m-dev-ui-banner-load').tap()
    await expect(page.getByTestId('m-toast')).toHaveText('Loading again')
  })
})

test.describe('kit: new parts work', () => {
  test('Fold opens and closes, the permission row and the number field report their values', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page, { route: '/dev/ui' })
    const fold = page.getByTestId('m-dev-ui-fold')
    await fold.scrollIntoViewIfNeeded()
    await expect(fold).toHaveAttribute('aria-expanded', 'false')
    await fold.tap()
    await expect(fold).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('region', { name: 'Thought' })).toContainText('The museum closes early')
    await fold.tap()
    await expect(page.getByRole('region', { name: 'Thought' })).toHaveCount(0)

    await expect(page.getByTestId('m-dev-ui-perm-web-confirm')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('m-dev-ui-perm-web-auto').tap()
    await expect(page.getByTestId('m-dev-ui-perm-web-auto')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('radiogroup', { name: 'Permission for Web' })).toBeVisible()

    const keep = page.getByTestId('m-dev-ui-number-int')
    await keep.scrollIntoViewIfNeeded()
    await expect(page.getByLabel('Keep at most', { exact: true })).toHaveValue('20')
    await page.getByRole('button', { name: 'Increase Keep at most' }).tap()
    await expect(keep).toHaveValue('21')
    await keep.fill('')
    await expect(keep).toHaveValue('')
    await keep.fill('7.6')
    await expect(keep).toHaveValue('8')
    await keep.fill('5000')
    await expect(keep).toHaveValue('200')
    expect(errors()).toEqual([])
  })

  test('a password can be shown, a key never, and a search field has one way to clear it', async ({ page }) => {
    await openShell(page, { route: '/dev/ui' })
    const secret = page.getByTestId('m-dev-ui-secret')
    await secret.scrollIntoViewIfNeeded()
    await expect(secret).toHaveAttribute('type', 'password')
    await page.getByTestId('m-dev-ui-secret-show').tap()
    await expect(secret).toHaveAttribute('type', 'text')
    await expect(secret).toHaveValue('correct horse')
    await page.getByTestId('m-dev-ui-secret-show').tap()
    await expect(secret).toHaveAttribute('type', 'password')

    const key = page.getByTestId('m-dev-ui-key')
    await expect(page.getByTestId('m-dev-ui-key-paste')).toHaveText('Paste')
    await key.fill('hf_secret')
    await expect(key).toHaveAttribute('type', 'password')
    await expect(page.getByTestId('m-dev-ui-key-paste')).toHaveCount(0)

    const search = page.getByTestId('m-dev-ui-search')
    await search.scrollIntoViewIfNeeded()
    await expect(search).toHaveAttribute('type', 'search')
    await search.fill('lisbon')
    const field = page.locator('.m-field', { has: search })
    await expect(field.getByRole('button')).toHaveCount(1)
    // The cross the engine draws into a search field by itself is off.
    const engineCross = await page.evaluate(() => {
      const found: string[] = []
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSStyleRule && rule.selectorText.includes('::-webkit-search-cancel-button')) found.push(rule.style.display)
        }
      }
      return found
    })
    expect(engineCross).toEqual(['none'])
    await field.getByRole('button', { name: 'Clear Search chats' }).tap()
    await expect(search).toHaveValue('')
    await expect(field.getByRole('button')).toHaveCount(0)
  })

  test('the Markdown of the kit colours code, asks before a link and offers the preview of a page', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page, { route: '/dev/ui' })
    const section = page.getByTestId('m-dev-ui-sec-markdown')
    await section.scrollIntoViewIfNeeded()
    const blocks = section.getByTestId('m-md-code')
    await expect(blocks).toHaveCount(2)
    // Colours: the keyword of the TypeScript block takes the keyword token of the theme.
    const keyword = blocks.first().locator('.token', { hasText: /^const$/ }).first()
    await expect(keyword).toHaveText('const')
    const colours = await keyword.evaluate((el) => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--m-code-keyword)'
      document.body.appendChild(probe)
      const wanted = getComputedStyle(probe).color
      probe.remove()
      return { got: getComputedStyle(el).color, wanted, plain: getComputedStyle(el.closest('pre')!).color }
    })
    expect(colours.got).toBe(colours.wanted)
    expect(colours.got).not.toBe(colours.plain)
    await expect(blocks.first().locator('.m-code-lang')).toHaveText('ts')
    // The text of the block is still the code, colours or not.
    await expect(blocks.first().locator('pre')).toContainText("const stops: string[] = ['museum', 'river', 'viewpoint']")
    // Only the web page offers Preview, and it says which block it is.
    await expect(section.getByTestId('m-md-code-preview')).toHaveCount(1)
    await section.getByTestId('m-md-code-preview').tap()
    await expect(page.getByTestId('m-toast-dev-preview')).toHaveText('Preview of block 1')
    // A link does not leave the app by itself: the screen gets the address.
    await section.getByTestId('m-md-link').tap()
    await expect(page.getByTestId('m-toast-dev-link')).toHaveText('Link: https://example.com/lisbon')
    // The wide table scrolls inside its own box.
    const table = await section.locator('.m-md-table').evaluate((el) => ({ box: el.clientWidth, inner: el.scrollWidth, right: el.getBoundingClientRect().right }))
    expect(table.inner).toBeGreaterThan(table.box)
    expect(table.right).toBeLessThanOrEqual(390)
    expect(errors()).toEqual([])
  })

  test('without a handler of its own a link asks first', async ({ page }) => {
    await openShell(page, { route: '/dev/ui' })
    // The same component, the way a screen without a link sheet uses it.
    const asked = await page.evaluate(async () => {
      const { askAndOpenLink } = ((await import(/* @vite-ignore */ '/src/mobile/ui/Markdown.tsx' as string)) as typeof import('../../src/mobile/ui/Markdown'))
      void askAndOpenLink('https://example.com/lisbon')
      return true
    })
    expect(asked).toBe(true)
    const dialog = page.getByTestId('m-dialog-open-link')
    await expect(dialog).toContainText('Open link?')
    await expect(dialog).toContainText('https://example.com/lisbon')
    await page.getByTestId('m-dialog-cancel').tap()
    await expect(dialog).toHaveCount(0)
  })
})

test.describe('kit: titles and file names', () => {
  test.use({ viewport: SMALL })

  test('at 320 px and 200 percent "Troubleshooting" stays whole in the header and breaks at a syllable in the list', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page, { route: '/settings/troubleshooting', fontScale: 200 })
    await expect(page.getByTestId('m-settings-troubleshooting-screen')).toBeVisible()
    const title = await textLines(page, '[data-testid="m-settings-troubleshooting-screen"] .m-hdr-text')
    expect(title).toEqual({ lines: 1, torn: [], text: 'Troubleshooting' })

    // The same word as the title of a row, where there is room for about eleven letters.
    await openShell(page, { route: '/dev/frame', fontScale: 200 })
    const row = page.getByTestId('m-dev-frame-row-1')
    await expect(row).toBeVisible()
    const inRow = await textLines(page, '[data-testid="m-dev-frame-row-1"] .m-row-title')
    expect(inRow.text).toBe('Troubleshooting')
    expect(inRow.torn).toEqual([])
    expect(inRow.lines).toBe(2)
    // The name of the button is still the plain word.
    await expect(page.getByRole('button', { name: 'Troubleshooting', exact: true })).toHaveCount(1)
    expect(errors()).toEqual([])
  })

  test('without the break points the same word is torn: the measurement can see it', async ({ page }) => {
    await openShell(page, { route: '/dev/frame', fontScale: 200 })
    await expect(page.getByTestId('m-dev-frame-row-1')).toBeVisible()
    await page.addStyleTag({ content: '.m-shy::after { content: none !important } .m-row-title { hyphens: none !important; -webkit-hyphens: none !important }' })
    const inRow = await textLines(page, '[data-testid="m-dev-frame-row-1"] .m-row-title')
    expect(inRow.torn.length).toBeGreaterThan(0)
  })

  test('a page title takes two lines at most, however long it is', async ({ page }) => {
    await openShell(page, { route: '/dev/frame', fontScale: 200 })
    const text = page.locator('[data-testid="m-dev-frame-screen"] .m-hdr-text')
    await expect(text).toBeVisible()
    const box = await text.evaluate((el) => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight), full: el.scrollHeight }))
    expect(box.height).toBeLessThanOrEqual(box.line * 2 + 1)
    // It really is longer than two lines, so the limit did something.
    expect(box.full).toBeGreaterThan(box.line * 2 + 1)
    // The whole title is still the name of the page.
    await expect(page.getByTestId('m-dev-frame-screen')).toHaveAttribute('aria-label', 'Troubleshooting and diagnostics for the models on this phone')
    // And the header leaves most of the screen to the content.
    const header = await rect(page, '[data-testid="m-dev-frame-screen"] .m-hdr')
    expect(header.height).toBeLessThan(SMALL.height * 0.3)
  })

  test('a long file name in the viewer is one line with the middle left out and the ending in sight', async ({ page }) => {
    await openShell(page, { route: '/dev/viewer', fontScale: 200 })
    const title = page.locator('[data-testid="m-dev-viewer-screen"] .m-viewer-title')
    await expect(title).toHaveText('beach-holiday-lisbon-day-two-evening-light-final-export.png')
    const shape = await title.evaluate((el) => {
      const head = el.querySelector('.m-mid-head')!
      const tail = el.querySelector('.m-mid-tail')!
      const bar = el.getBoundingClientRect()
      const t = tail.getBoundingClientRect()
      return {
        oneLine: bar.height <= parseFloat(getComputedStyle(el).fontSize) * 1.6,
        tail: tail.textContent,
        tailInside: t.left >= bar.left - 1 && t.right <= bar.right + 1 && t.width > 0,
        headCut: head.scrollWidth > head.clientWidth,
        ellipsis: getComputedStyle(head).textOverflow,
      }
    })
    expect(shape).toEqual({ oneLine: true, tail: 'ort.png', tailInside: true, headCut: true, ellipsis: 'ellipsis' })
  })
})

test.describe('kit: footer and segmented at 320 px and 200 percent', () => {
  test.use({ viewport: SMALL })

  test('a tall footer takes at most 46 percent of the page and scrolls inside, the main button stays reachable', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page, { route: '/dev/frame', fontScale: 200 })
    await page.getByTestId('m-dev-frame-more').tap()
    const sizes = await page.evaluate(() => {
      const screen = document.querySelector('[data-testid="m-dev-frame-screen"]')!
      const foot = screen.querySelector('.m-foot')!
      const body = screen.querySelector('.m-body')!
      return { screen: screen.getBoundingClientRect().height, foot: foot.getBoundingClientRect().height, inner: foot.scrollHeight, body: body.getBoundingClientRect().height }
    })
    expect(sizes.foot).toBeLessThanOrEqual(sizes.screen * 0.46 + 1)
    expect(sizes.inner).toBeGreaterThan(sizes.foot + 100)
    // Under a title of two lines the content still keeps room for three full targets.
    expect(sizes.body).toBeGreaterThan(3 * 44)
    const main = page.getByTestId('m-dev-frame-main')
    await main.scrollIntoViewIfNeeded()
    await expect(main).toBeInViewport({ ratio: 1 })
    await main.tap()
    expect(await measureLayout(page)).toEqual(CLEAN_LAYOUT)
    expect(errors()).toEqual([])
  })

  test('options that do not fit all go under each other, at full width', async ({ page }) => {
    await openShell(page, { route: '/dev/ui', fontScale: 200 })
    const group = page.getByTestId('m-dev-ui-seg-long')
    await group.scrollIntoViewIfNeeded()
    await expect(group).toHaveAttribute('data-stacked', '')
    const boxes = await group.locator('[role="radio"]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ left: Math.round(r.left), width: Math.round(r.width), top: Math.round(r.top) })))
    expect(boxes).toHaveLength(3)
    expect(new Set(boxes.map((b) => b.left)).size).toBe(1)
    expect(new Set(boxes.map((b) => b.width)).size).toBe(1)
    expect(new Set(boxes.map((b) => b.top)).size).toBe(3)
    // No label is torn.
    for (const id of ['draft', 'standard', 'high']) {
      expect((await textLines(page, `[data-testid="m-dev-ui-seg-long-${id}"]`)).torn, id).toEqual([])
    }
    await page.getByTestId('m-dev-ui-seg-long-high').tap()
    await expect(page.getByTestId('m-dev-ui-seg-long-high')).toHaveAttribute('aria-checked', 'true')
  })

  test('a chip with a short label is a full target', async ({ page }) => {
    await openShell(page, { route: '/dev/ui', fontScale: 100 })
    const chip = page.getByTestId('m-dev-ui-chip-ratio-1x1')
    await chip.scrollIntoViewIfNeeded()
    const box = await chip.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)
  })
})

test.describe('kit: segmented with room', () => {
  test('the same options stay in one row when they fit, and follow the text size when it changes', async ({ page }) => {
    await openShell(page, { route: '/dev/ui' })
    const group = page.getByTestId('m-dev-ui-seg-long')
    await group.scrollIntoViewIfNeeded()
    expect(await group.getAttribute('data-stacked')).toBeNull()
    const tops = await group.locator('[role="radio"]').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)))
    expect(new Set(tops).size).toBe(1)
    // The system text size grows while the page is open.
    await page.addStyleTag({ content: "html[data-shell='mobile'] { font-size: 34px !important }" })
    await expect(group).toHaveAttribute('data-stacked', '')
  })
})

test.describe('kit: stacked sheets and mounted pages', () => {
  test('Close and Back belong to the sheet and the page on top, every id is in the document once', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page, { route: '/dev/ui' })
    // Two pages are mounted: the catalogue on top, the chat below it.
    await expect(page.getByTestId('m-page-back')).toHaveCount(1)
    await expect(page.getByTestId('m-page-back-under')).toHaveCount(1)
    expect(await page.getByTestId('m-page-back').evaluate((el) => el.closest('.m-page')?.getAttribute('data-route'))).toBe('/dev/ui')

    await page.getByTestId('m-dev-ui-open-sheet').tap()
    await expect(page.getByTestId('m-sheet-dev-demo')).toBeVisible()
    await expect(page.getByTestId('m-sheet-close')).toHaveCount(1)
    await page.getByTestId('m-dev-sheet-stack').tap()
    await expect(page.getByTestId('m-dev-sheet-note')).toHaveText('This sheet lies on top of another one.')
    await expect(page.getByTestId('m-sheet-dev-demo')).toHaveCount(2)
    for (const id of ['m-sheet-close', 'm-sheet-scrim']) {
      await expect(page.getByTestId(id), id).toHaveCount(1)
      await expect(page.getByTestId(`${id}-under-1`), id).toHaveCount(1)
    }
    // The bare id is the one of the sheet on top.
    expect(await page.getByTestId('m-sheet-close').evaluate((el) => !!el.closest('[role="dialog"]')?.querySelector('[data-testid="m-dev-sheet-note"]'))).toBe(true)
    // A dialog above the top sheet does not take the id away from it.
    await page.getByTestId('m-dev-sheet-confirm').last().tap()
    await expect(page.getByTestId('m-dialog-demo')).toBeVisible()
    await expect(page.getByTestId('m-sheet-close')).toHaveCount(1)
    await page.getByTestId('m-dialog-cancel').tap()

    await page.getByTestId('m-sheet-close').tap()
    await expect(page.getByTestId('m-sheet-dev-demo')).toHaveCount(1)
    await expect(page.getByTestId('m-dev-sheet-note')).toHaveCount(0)
    await expect(page.getByTestId('m-sheet-close')).toHaveCount(1)
    await expect(page.getByTestId('m-sheet-close-under-1')).toHaveCount(0)
    await page.getByTestId('m-sheet-close').tap()
    await expect(page.getByTestId('m-sheet-dev-demo')).toHaveCount(0)

    // Back: the page that leaves gives the id up at once, the one that comes back takes it.
    await page.getByTestId('m-page-back').tap()
    await expect(page.getByTestId('m-chat-screen')).toBeVisible()
    await expect(page.locator('.m-page[data-m-exit]')).toHaveCount(0)
    await expect(page.getByTestId('m-page-back')).toHaveCount(1)
    expect(await page.getByTestId('m-page-back').evaluate((el) => el.closest('.m-page')?.getAttribute('data-route'))).toBe('/chat/:id')
    expect(errors()).toEqual([])
  })

  test('no notice of the engine is in the document twice, and none is hidden in the frame', async ({ page }) => {
    await openShell(page)
    await expect(page.getByTestId('m-chat-screen')).toBeVisible()
    const found = await page.evaluate(() => ({
      hiddenInFrame: document.querySelectorAll('.m-app > [hidden]').length,
      double: [...document.querySelectorAll('[data-testid^="m-engine-notice"]')].map((el) => el.getAttribute('data-testid')).filter((id, i, all) => all.indexOf(id) !== i),
    }))
    expect(found).toEqual({ hiddenInFrame: 0, double: [] })
    // Away from the chat an unseen copy keeps the state of the engine current. There is still one of each.
    await page.getByTestId('m-chat-back').or(page.getByTestId('m-page-back')).first().tap()
    await page.getByTestId('m-nav-models').tap()
    await expect(page.locator('.m-page[data-m-exit]')).toHaveCount(0)
    await expect(page.locator('.m-app > [hidden]')).toHaveCount(1)
    expect(await page.getByTestId('m-engine-notices').count()).toBeLessThanOrEqual(1)
  })

  test('every sheet is found as m-sheet-<id>, an id of its own stays as a second mark around it', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page)
    await expect(page.getByTestId('m-chat-screen')).toBeVisible()
    // The options of the chat pass their own id (m-options).
    await page.evaluate(async () => {
      const { navApi } = ((await import(/* @vite-ignore */ '/src/mobile/nav/api.ts' as string)) as typeof import('../../src/mobile/nav/api'))
      navApi.openSheet('chat-options', {})
    })
    const sheet = page.getByTestId('m-sheet-chat-options')
    await expect(sheet).toBeVisible()
    await screensLoaded(page)
    await expect(sheet).toHaveAttribute('role', 'dialog')
    await expect(sheet).toHaveAttribute('data-m-sheet-alias', 'm-options')
    const own = page.getByTestId('m-options')
    await expect(own).toHaveCount(1)
    await expect(own).toBeVisible()
    expect(await own.evaluate((el) => !!el.querySelector(':scope > [data-testid="m-sheet-chat-options"]'))).toBe(true)
    // The grabber is for a finger only: nothing for assistive technology, and the Close button is there.
    const grab = sheet.locator('.m-sheet-grab')
    await expect(grab).toHaveAttribute('aria-hidden', 'true')
    await expect(sheet.getByTestId('m-sheet-close')).toHaveCount(1)
    // Pulling it down still closes the sheet.
    const box = (await grab.boundingBox())!
    await grab.dispatchEvent('pointerdown', { clientX: box.x + box.width / 2, clientY: box.y + 4, pointerId: 1, bubbles: true })
    await grab.dispatchEvent('pointermove', { clientX: box.x + box.width / 2, clientY: box.y + 140, pointerId: 1, bubbles: true })
    await grab.dispatchEvent('pointerup', { clientX: box.x + box.width / 2, clientY: box.y + 140, pointerId: 1, bubbles: true })
    await expect(sheet).toHaveCount(0)
    expect(errors().filter((e) => !/setPointerCapture|InvalidPointerId|NotFoundError/.test(e))).toEqual([])
  })
})

test.describe('kit: toast', () => {
  for (const variant of [
    { name: '390x844', width: 390, height: 844, fontScale: 100 },
    { name: '320x568 at 200 percent', width: 320, height: 568, fontScale: 200 },
    { name: '844x390 on its side', width: 844, height: 390, fontScale: 100 },
  ] as const) {
    test.describe(variant.name, () => {
      test.use({ viewport: { width: variant.width, height: variant.height } })

      test('on a page with a composer it lies neither on the composer nor on the end of the list', async ({ page }) => {
        const errors = watchErrors(page)
        await openShell(page, { route: '/dev/composer', fontScale: variant.fontScale })
        const last = page.getByTestId('m-dev-composer-row-16')
        await last.scrollIntoViewIfNeeded()
        await page.getByTestId('m-dev-composer-mic').tap()
        const toast = page.getByTestId('m-toast-dev-composer')
        await expect(toast).toBeVisible()
        await expect(page.locator('.m-toast-layer')).toHaveAttribute('data-place', 'top')
        await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)).map((a) => a.finished.catch(() => undefined))))
        const boxes = {
          toast: await rect(page, '.m-toast'),
          composer: await rect(page, '[data-testid="m-dev-composer"]'),
          last: await rect(page, '[data-testid="m-dev-composer-row-16"]'),
          header: await rect(page, '[data-testid="m-dev-composer-screen"] .m-hdr'),
        }
        expect(apart(boxes.toast, boxes.composer)).toBe(true)
        expect(apart(boxes.toast, boxes.last)).toBe(true)
        // It does not lie on the header and its back arrow either.
        expect(apart(boxes.toast, boxes.header)).toBe(true)
        expect(boxes.toast.top).toBeGreaterThanOrEqual(0)
        expect(boxes.toast.right).toBeLessThanOrEqual(variant.width)
        // The composer stays usable under it.
        await page.getByTestId('m-dev-composer-input').fill('Still typing')
        await expect(page.getByTestId('m-dev-composer-send')).toBeEnabled()
        expect(errors()).toEqual([])
      })

      test('on a page with a footer it does not lie on the footer', async ({ page }) => {
        await openShell(page, { route: '/dev/frame', fontScale: variant.fontScale })
        const button = page.getByTestId('m-dev-frame-toast')
        await button.scrollIntoViewIfNeeded()
        await button.tap()
        await expect(page.getByTestId('m-toast-dev-frame')).toBeVisible()
        await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)).map((a) => a.finished.catch(() => undefined))))
        const toast = await rect(page, '.m-toast')
        const foot = await rect(page, '[data-testid="m-dev-frame-screen"] .m-foot')
        expect(apart(toast, foot)).toBe(true)
      })
    })
  }

  // Re-check Android 8 GB, A-22 a: "Key saved" lay on "Test connection". The rule of the kit, for every page: a toast lies
  // on nothing a finger can press. The catalogue is the page with the most controls there is, so it is walked from its
  // first line to its last, and at every stop a toast is shown and looked at.
  for (const variant of [
    { name: '390x844', width: 390, height: 844, fontScale: 100 },
    { name: '412x915, the phone of the report', width: 412, height: 915, fontScale: 100 },
    { name: '320x568 at 200 percent', width: 320, height: 568, fontScale: 200 },
  ] as const) {
    test.describe(`a toast covers no control, ${variant.name}`, () => {
      test.use({ viewport: { width: variant.width, height: variant.height } })

      test('wherever the catalogue is scrolled to', async ({ page }) => {
        test.setTimeout(180_000)
        const errors = watchErrors(page)
        await openShell(page, { route: '/dev/ui', fontScale: variant.fontScale })
        const body = '[data-testid="m-dev-ui-screen"] .m-body'
        await page.locator(body).waitFor()
        const range = await page.evaluate((sel) => {
          const el = document.querySelector(sel)!
          return { max: el.scrollHeight - el.clientHeight, step: el.clientHeight }
        }, body)
        expect(range.max).toBeGreaterThan(range.step * 3)
        const places: Record<string, number> = {}
        const noRoom: number[] = []
        // A little less than a screen per stop, so the controls stand at other heights every time.
        for (let at = 0, stop = 0; at <= range.max + 1 && stop < 40; at += Math.round(range.step * 0.83), stop++) {
          await page.evaluate(([sel, y]) => document.querySelector(sel as string)!.scrollTo(0, y as number), [body, Math.min(at, range.max)] as const)
          await page.evaluate(async (text) => {
            const kit = await import('/src/mobile/ui/Toast.tsx' as string)
            kit.toast(text, { testid: 'place' })
          }, `Key saved ${stop}`)
          const toast = page.getByTestId('m-toast-place')
          await expect(toast).toHaveText(`Key saved ${stop}`)
          // The place is measured when the toast comes and once more 350 ms later, when the page stands.
          await page.waitForTimeout(450)
          const seen = await page.evaluate((sel) => {
            const app = document.querySelector('.m-app')!
            const layer = document.querySelector('.m-toast-layer') as HTMLElement
            const t = document.querySelector('.m-toast')!.getBoundingClientRect()
            const view = document.querySelector(sel)!.getBoundingClientRect()
            const frame = app.getBoundingClientRect()
            const controls = 'button, a[href], input, textarea, select, [role="button"], [role="switch"], [role="tab"], [role="radio"], [role="checkbox"], [role="slider"]'
            const covered: string[] = []
            const boxes: Array<{ top: number; bottom: number }> = []
            app.querySelectorAll(controls).forEach((el) => {
              if (layer.contains(el) || el.closest('[data-m-hidden], [data-m-exit], [aria-hidden="true"], [inert]')) return
              const r = el.getBoundingClientRect()
              const clip = el.closest(sel) ? view : frame
              const top = Math.max(r.top, clip.top)
              const bottom = Math.min(r.bottom, clip.bottom)
              if (r.width <= 0 || bottom <= top) return
              if (r.left < t.right && r.right > t.left) boxes.push({ top, bottom })
              if (t.left < r.right && t.right > r.left && t.top < bottom && t.bottom > top) covered.push(`${el.getAttribute('data-testid') ?? el.tagName} ${Math.round(top)}..${Math.round(bottom)}`)
            })
            // Is there any room of the height of the toast between the controls, from the top of the content to the usual place?
            boxes.sort((a, b) => a.top - b.top)
            let edge = view.top + 8
            let room = false
            const floor = frame.bottom - 76
            for (const b of [...boxes, { top: floor + 4, bottom: floor + 4 }]) {
              if (b.top - 4 - edge >= t.height && edge + t.height <= floor) room = true
              edge = Math.max(edge, b.bottom + 4)
            }
            return { place: layer.dataset.place ?? '', covered, room, toast: [Math.round(t.top), Math.round(t.bottom), Math.round(t.left), Math.round(t.right)], width: window.innerWidth, height: window.innerHeight }
          }, body)
          places[seen.place] = (places[seen.place] ?? 0) + 1
          // On the screen, whole.
          expect(seen.toast[0], `stop ${stop}`).toBeGreaterThanOrEqual(0)
          expect(seen.toast[1], `stop ${stop}`).toBeLessThanOrEqual(seen.height)
          expect(seen.toast[2], `stop ${stop}`).toBeGreaterThanOrEqual(0)
          expect(seen.toast[3], `stop ${stop}`).toBeLessThanOrEqual(seen.width)
          // The rule. Only a screen with no room at all between its controls may have the toast on one, and that is counted.
          if (seen.room) expect(seen.covered, `stop ${stop} at ${at}px, place ${seen.place}`).toEqual([])
          else if (seen.covered.length > 0) noRoom.push(stop)
          await toast.tap()
          await expect(toast).toHaveCount(0)
        }
        // The walk met all three places, or the test proves nothing about the two new ones.
        expect(Object.keys(places).sort(), JSON.stringify(places)).toEqual(expect.arrayContaining(['bottom', 'gap']))
        // Screens of nothing but controls are rare in the catalogue, also on the smallest phone at 200 percent, where the
        // toast is three lines high: more than a quarter of the stops would mean the search for room is broken.
        const stops = Object.values(places).reduce((sum, n) => sum + n, 0)
        expect(noRoom.length, `no room at stops ${noRoom.join(', ')} of ${stops}`).toBeLessThanOrEqual(Math.floor(stops / 4))
        expect(errors()).toEqual([])
      })
    })
  }

  test('on a page without anything fixed below it stays at the bottom, and a tap takes it away', async ({ page }) => {
    await openShell(page, { route: '/dev/ui' })
    await page.getByTestId('m-dev-ui-toast').scrollIntoViewIfNeeded()
    await page.getByTestId('m-dev-ui-toast').tap()
    const toast = page.getByTestId('m-toast')
    await expect(toast).toHaveText('Copied')
    await expect(page.locator('.m-toast-layer')).toHaveAttribute('data-place', 'bottom')
    const box = await toast.boundingBox()
    expect(box!.y).toBeGreaterThan(844 / 2)
    await toast.tap()
    await expect(toast).toHaveCount(0)
  })

  test('a plain toast leaves sooner at 200 percent text, one with a button keeps its time', async ({ page }) => {
    // How long a toast was in the document, measured in the page itself.
    const shownFor = (button: string) =>
      page.evaluate(async (testid) => {
        const started = performance.now()
        ;(document.querySelector(`[data-testid="${testid}"]`) as HTMLElement).click()
        await new Promise<void>((resolve) => {
          const seen = () => document.querySelector('.m-toast')
          const wait = () => (seen() ? resolve() : requestAnimationFrame(wait))
          wait()
        })
        await new Promise<void>((resolve) => {
          const wait = () => (document.querySelector('.m-toast') ? requestAnimationFrame(wait) : resolve())
          wait()
        })
        return performance.now() - started
      }, button)

    await openShell(page, { route: '/dev/ui', fontScale: 100 })
    const normal = await shownFor('m-dev-ui-toast')
    expect(normal).toBeGreaterThan(2850)
    expect(normal).toBeLessThan(3600)

    await openShell(page, { route: '/dev/ui', fontScale: 200 })
    const large = await shownFor('m-dev-ui-toast')
    expect(large).toBeGreaterThan(2250)
    expect(large).toBeLessThan(2850)
    const withButton = await shownFor('m-dev-ui-toast-action')
    expect(withButton).toBeGreaterThan(2850)
  })
})

test.describe('kit: composer on its side', () => {
  for (const variant of [
    { name: '844x390', width: 844, height: 390, fontScale: 100 },
    { name: '844x390 at 200 percent', width: 844, height: 390, fontScale: 200 },
    { name: '568x320', width: 568, height: 320, fontScale: 100 },
  ] as const) {
    test.describe(variant.name, () => {
      test.use({ viewport: { width: variant.width, height: variant.height } })

      test('the composer takes at most a third of the height, empty and with a long text', async ({ page }) => {
        const errors = watchErrors(page)
        await openShell(page, { route: '/dev/composer', fontScale: variant.fontScale })
        const composer = page.getByTestId('m-dev-composer')
        await expect(composer).toBeVisible()
        const third = variant.height / 3
        expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(third + 0.5)
        // Prompt v2: the one warning, the settings button with its summary, Attach and the shared slot are all still
        // there, in one row.
        const row = await page.evaluate(() => {
          const tops = (sel: string) => [...document.querySelectorAll(`[data-testid="m-dev-composer"] ${sel}`)].map((el) => Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2))
          return { chips: tops('.m-chip'), buttons: tops('.m-ib'), tune: tops('.m-composer-tune'), slot: tops('.m-send') }
        })
        expect(row.chips).toHaveLength(1)
        expect(row.buttons).toHaveLength(1)
        expect(row.tune).toHaveLength(1)
        expect(row.slot).toHaveLength(1)
        const centres = [...row.chips, ...row.buttons, ...row.tune, ...row.slot]
        expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(2)

        await page.getByTestId('m-dev-composer-input').fill(Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of a long message`).join('\n'))
        await expect(page.getByTestId('m-dev-composer-send')).toBeVisible()
        expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(third + 0.5)
        // The field scrolls inside instead of growing.
        const field = await page.getByTestId('m-dev-composer-input').evaluate((el) => ({ box: el.clientHeight, inner: el.scrollHeight }))
        expect(field.inner).toBeGreaterThan(field.box)
        expect(field.box).toBeGreaterThanOrEqual(43)
        expect(await measureLayout(page)).toEqual(CLEAN_LAYOUT)
        expect(errors()).toEqual([])
      })
    })
  }

  test('upright the composer keeps its status row above the field and grows with the text', async ({ page }) => {
    await openShell(page, { route: '/dev/composer' })
    const order = await page.evaluate(() => {
      const top = (sel: string) => document.querySelector(`[data-testid="m-dev-composer"] ${sel}`)!.getBoundingClientRect().top
      return { status: top('.m-composer-status'), field: top('textarea'), row: top('.m-composer-row') }
    })
    expect(order.status).toBeLessThan(order.field)
    expect(order.field).toBeLessThan(order.row)
    const before = (await page.getByTestId('m-dev-composer-input').boundingBox())!.height
    // Prompt v2: the field starts at three lines, so it takes six to grow by more than 40 px.
    await page.getByTestId('m-dev-composer-input').fill('One\nTwo\nThree\nFour\nFive\nSix')
    const after = (await page.getByTestId('m-dev-composer-input').boundingBox())!.height
    expect(after).toBeGreaterThan(before + 40)
  })
})

// ---------------------------------------------------------------------------
// Findings of the first start on a phone (08.10.2026).
// ---------------------------------------------------------------------------

test.describe('device findings', () => {
  test('the content of a sheet takes taps only once the sheet stands still', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page, { route: '/dev/ui' })
    // Watch the sheet from its first frame on.
    await page.evaluate(() => {
      const log: Array<{ settling: boolean; body: string; close: string }> = []
      ;(window as unknown as { __settle: typeof log }).__settle = log
      const look = () => {
        const sheet = document.querySelector('[data-testid="m-sheet-dev-demo"]')
        if (sheet) {
          const body = sheet.querySelector(':scope > .m-sheet-body')
          const close = sheet.querySelector('[data-testid="m-sheet-close"]')
          // A second sheet on top takes the id of the Close button: the watching ends there.
          if (!body || !close) return
          log.push({ settling: sheet.hasAttribute('data-m-settling'), body: getComputedStyle(body).pointerEvents, close: getComputedStyle(close).pointerEvents })
        }
        if (log.length < 200) requestAnimationFrame(look)
      }
      requestAnimationFrame(look)
    })
    await page.getByTestId('m-dev-ui-open-sheet').tap()
    const sheet = page.getByTestId('m-sheet-dev-demo')
    await expect(sheet).toBeVisible()
    await expect(sheet).not.toHaveAttribute('data-m-settling', '')
    const log = await page.evaluate(() => (window as unknown as { __settle: Array<{ settling: boolean; body: string; close: string }> }).__settle)
    const moving = log.filter((frame) => frame.settling)
    const still = log.filter((frame) => !frame.settling)
    // It was on its way for some frames, and in every one of them the content let no tap through.
    expect(moving.length).toBeGreaterThan(2)
    expect(moving.every((frame) => frame.body === 'none')).toBe(true)
    // Close worked from the first frame.
    expect(log.every((frame) => frame.close !== 'none')).toBe(true)
    expect(still.length).toBeGreaterThan(0)
    expect(still.every((frame) => frame.body !== 'none')).toBe(true)
    // And the row then does what it says.
    await page.getByTestId('m-dev-sheet-stack').tap()
    await expect(page.getByTestId('m-dev-sheet-note')).toBeVisible()
    expect(errors()).toEqual([])
  })

  test('the question about a link shows its real title and text in its first frame, never a skeleton', async ({ page }) => {
    const errors = watchErrors(page)
    await openShell(page)
    await expect(page.getByTestId('m-chat-screen')).toBeVisible()
    await page.evaluate(() => {
      const seen: Array<{ title: string; loading: boolean; hasContinue: boolean }> = []
      ;(window as unknown as { __offer: typeof seen }).__offer = seen
      new MutationObserver(() => {
        const sheet = document.querySelector('[data-testid="m-sheet-link-offer"]')
        if (!sheet) return
        seen.push({
          title: sheet.querySelector('.m-sheet-title')?.textContent ?? '',
          loading: !!document.querySelector('[data-m-loading]') || !!sheet.querySelector('.m-skel'),
          hasContinue: !!sheet.querySelector('[data-testid="m-link-offer-continue"]'),
        })
      }).observe(document.body, { childList: true, subtree: true })
      window.dispatchEvent(new CustomEvent('lu:deep-link', { detail: { url: 'lu://remote?url=https%3A%2F%2F192.168.77.5%3A8443&code=123456' } }))
    })
    const sheet = page.getByTestId('m-sheet-link-offer')
    await expect(sheet).toBeVisible()
    await expect(page.getByTestId('m-link-offer-continue')).toBeVisible()
    await expect(sheet).toContainText('192.168.77.5')
    const seen = await page.evaluate(() => (window as unknown as { __offer: Array<{ title: string; loading: boolean; hasContinue: boolean }> }).__offer)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.filter((frame) => frame.loading)).toEqual([])
    expect(seen.every((frame) => frame.hasContinue)).toBe(true)
    expect(new Set(seen.map((frame) => frame.title)).size).toBe(1)
    // Nothing happened by itself: the link waits for an answer.
    await page.getByTestId('m-link-offer-dismiss').tap()
    await expect(sheet).toHaveCount(0)
    expect(errors()).toEqual([])
  })

  for (const size of [
    { name: '360x592', width: 360, height: 592 },
    { name: '320x568', width: 320, height: 568 },
  ] as const) {
    test.describe(`a toast in the chat, ${size.name}`, () => {
      test.use({ viewport: { width: size.width, height: size.height } })

      test('it does not lie on the input, and a tap on it takes neither the focus nor the text', async ({ page }) => {
        const errors = watchErrors(page)
        await openShell(page)
        const input = page.getByTestId('m-chat-input')
        await expect(input).toBeVisible()
        await input.tap()
        await input.pressSequentially('Hello th')
        await page.evaluate(async () => {
          const { toast } = ((await import(/* @vite-ignore */ '/src/mobile/ui/Toast.tsx' as string)) as typeof import('../../src/mobile/ui/Toast'))
          toast('SmolLM2 360M installed', { testid: 'installed' })
        })
        const note = page.getByTestId('m-toast-installed')
        await expect(note).toBeVisible()
        await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)).map((a) => a.finished.catch(() => undefined))))
        const boxes = { toast: await rect(page, '[data-testid="m-toast-installed"]'), input: await rect(page, '[data-testid="m-chat-input"]'), composer: await rect(page, '.m-composer') }
        expect(apart(boxes.toast, boxes.input)).toBe(true)
        expect(apart(boxes.toast, boxes.composer)).toBe(true)
        // Typing goes on while it is there.
        await input.pressSequentially('ere')
        await expect(input).toHaveValue('Hello there')
        // A tap on the note takes it away and leaves the field as it was.
        await note.tap()
        await expect(note).toHaveCount(0)
        await expect(input).toBeFocused()
        await expect(input).toHaveValue('Hello there')
        await input.pressSequentially('.')
        await expect(input).toHaveValue('Hello there.')
        expect(errors()).toEqual([])
      })
    })
  }

  test('after a reload "back" stays in the app and closes the top page', async ({ page }) => {
    const errors = watchErrors(page)
    // The way the app runs on a phone: with the native layer in the window.
    await page.addInitScript(() => {
      ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: async () => { throw new Error('no native layer in this test') },
        transformCallback: () => 0,
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      }
    })
    await page.goto(shellUrl({ route: '/dev/ui' }))
    await page.getByTestId('m-dev-ui-screen').waitFor()
    await page.reload()
    await page.getByTestId('m-dev-ui-screen').last().waitFor()
    await page.evaluate(() => { (window as unknown as { __same: boolean }).__same = true })
    // The history has settled: the page sits on its sentinel.
    await expect.poll(() => page.evaluate(() => typeof (history.state as { luNav?: number } | null)?.luNav)).toBe('number')
    for (let i = 0; i < 3; i += 1) {
      await page.goBack()
      await page.waitForTimeout(300)
      expect(await page.evaluate(() => (window as unknown as { __same?: boolean }).__same === true), `back ${i + 1}`).toBe(true)
      if (await page.evaluate(() => typeof (history.state as { luNav?: number } | null)?.luNav !== 'number')) break
    }
    expect(page.url()).toContain('mobile=1')
    await expect(page.getByTestId('m-app')).toBeVisible()
    // The mock of the native layer answers every command with an error, so the console is not looked at here.
    void errors
  })
})


// Round 4, acceptance android-knoepfe (M8 and M9).
test.describe('kit: the footer of a low page', () => {
  for (const view of [
    { name: '592x360', width: 592, height: 360, fontScale: 100 },
    { name: '592x360 at 200 percent', width: 592, height: 360, fontScale: 200 },
    { name: '844x390 at 200 percent', width: 844, height: 390, fontScale: 200 },
  ]) {
    test.describe(view.name, () => {
      test.use({ viewport: { width: view.width, height: view.height } })

      test('on its side the footer is the end of the scrolling content, and the main button is reached by scrolling', async ({ page }) => {
        const errors = watchErrors(page)
        await openShell(page, { route: '/dev/frame', fontScale: view.fontScale })
        const screen = page.getByTestId('m-dev-frame-screen')
        await expect(screen).toHaveAttribute('data-m-foot', 'scrolls')
        await expect(screen.locator('.m-body > .m-foot')).toHaveCount(1)
        await expect(screen.locator(':scope > .m-foot')).toHaveCount(0)
        // The content has the whole height under the header.
        const sizes = await screen.evaluate((el) => {
          const body = el.querySelector('.m-body')!.getBoundingClientRect()
          return { body: body.height, screen: el.getBoundingClientRect().height, bottom: body.bottom }
        })
        const main = page.getByTestId('m-dev-frame-main')
        // F8 and F15 of the run on the 4 GB phone: while the footer is out of sight, a round button
        // at the lower right says that there is more and leads to it with one tap.
        const jump = page.getByTestId('m-foot-jump')
        const hidden = await main.evaluate((el) => el.getBoundingClientRect().top >= window.innerHeight - 8)
        // Its strip is all the content gives up (iPhone, package 8, B3): the rest under the header is the content's.
        const strip = hidden ? await screen.locator('.m-foot-jump-slot').evaluate((el) => el.getBoundingClientRect().height) : 0
        expect(strip).toBeLessThanOrEqual(64)
        expect(sizes.bottom).toBeGreaterThan(view.height - 2 - strip)
        expect(sizes.body).toBeGreaterThan(sizes.screen * 0.55)
        if (hidden) {
          await expect(jump).toBeVisible()
          await expect(jump).toBeInViewport({ ratio: 1 })
          expect(await jump.getAttribute('aria-label')).toBe('Go to the buttons of this page')
          const size = (await jump.boundingBox())!
          expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(48)
          // The button stands under the scrolling content, never on it.
          const bodyBottom = await screen.evaluate((el) => el.querySelector('.m-body')!.getBoundingClientRect().bottom)
          expect(size.y).toBeGreaterThanOrEqual(bodyBottom - 0.5)
          await jump.tap()
        } else {
          await main.scrollIntoViewIfNeeded()
        }
        await expect(main).toBeInViewport({ ratio: 1 })
        // With the footer on screen the button is gone.
        await expect(jump).toHaveCount(0)
        await main.tap()
        expect(await measureLayout(page)).toEqual(CLEAN_LAYOUT)
        expect(errors()).toEqual([])
      })
    })
  }

  // F8 of the run on the 4 GB phone (360 by 640 dp, largest text): upright the footer never leaves its place.
  for (const view of [
    { name: '360x640 at 200 percent', width: 360, height: 640 },
    { name: '360x592 at 200 percent', width: 360, height: 592 },
    { name: '320x568 at 200 percent', width: 320, height: 568 },
  ]) {
    test.describe(view.name, () => {
      test.use({ viewport: { width: view.width, height: view.height } })

      test('upright at the largest text the footer is fixed, compact, and the content scrolls above it', async ({ page }) => {
        const errors = watchErrors(page)
        await openShell(page, { route: '/dev/frame', fontScale: 200 })
        const screen = page.getByTestId('m-dev-frame-screen')
        await expect(screen).toHaveAttribute('data-m-foot', 'fixed')
        await expect(screen.locator(':scope > .m-foot')).toHaveCount(1)
        await expect(page.getByTestId('m-foot-jump')).toHaveCount(0)
        const main = page.getByTestId('m-dev-frame-main')
        await expect(main).toBeInViewport({ ratio: 1 })
        const sizes = await screen.evaluate((el) => {
          const foot = el.querySelector(':scope > .m-foot')!
          const body = el.querySelector('.m-body')!
          return { foot: foot.getBoundingClientRect().height, padding: parseFloat(getComputedStyle(foot).paddingTop), body: body.getBoundingClientRect().height, screen: el.getBoundingClientRect().height }
        })
        // Tight room: the footer gives up padding, and it never takes more than its 46 percent.
        expect(await page.evaluate(() => document.documentElement.getAttribute('data-m-room'))).toBe('tight')
        expect(sizes.padding).toBeLessThanOrEqual(8)
        expect(sizes.foot).toBeLessThanOrEqual(sizes.screen * 0.46 + 1)
        expect(sizes.body).toBeGreaterThan(3 * 32)
        await main.tap()
        expect(await measureLayout(page)).toEqual(CLEAN_LAYOUT)
        expect(errors()).toEqual([])
      })
    })
  }

  // F15 of the run on the 4 GB phone: at the largest text the welcome page showed no button on the first
  // screen, and in the Play build nothing said that the page went on.
  for (const view of [
    { name: '360x640', width: 360, height: 640 },
    { name: '360x592', width: 360, height: 592 },
    { name: '320x568', width: 320, height: 568 },
  ]) {
    for (const store of ['open', 'play'] as const) {
      test.describe(`welcome ${view.name} at 200 percent, ${store}`, () => {
        test.use({ viewport: { width: view.width, height: view.height } })

        test('the first screen shows both buttons, the text scrolls above them', async ({ page }) => {
          const errors = watchErrors(page)
          if (store === 'play') await declareAdult(page)
          await openShell(page, { skipOnboarding: false, fontScale: 200, store })
          const screen = page.getByTestId('m-onboarding-screen')
          await expect(screen).toHaveAttribute('data-m-foot', 'fixed')
          for (const id of ['m-onboarding-next', 'm-onboarding-account']) {
            await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 })
          }
          // Nothing of the text is lost: it scrolls to its last line above the footer.
          const ends = await screen.evaluate((el) => {
            const body = el.querySelector('.m-body')!
            body.scrollTop = body.scrollHeight
            const text = el.querySelector('[data-testid="m-onboarding-intro"] p')!.getBoundingClientRect()
            const foot = el.querySelector(':scope > .m-foot')!.getBoundingClientRect()
            return { textBottom: text.bottom, footTop: foot.top, body: body.clientHeight }
          })
          expect(ends.textBottom).toBeLessThanOrEqual(ends.footTop)
          // At least three lines of the text at a time.
          expect(ends.body).toBeGreaterThan(3 * 32 * 1.4)
          await expect(page.getByTestId('m-onboarding-next')).toBeInViewport({ ratio: 1 })
          expect(await measureLayout(page)).toEqual(CLEAN_LAYOUT)
          await page.getByTestId('m-onboarding-next').tap()
          await expect(topPage(page).getByTestId('m-onboarding-intro')).toHaveCount(0)
          expect(errors()).toEqual([])
        })
      })
    }
  }

  test.describe('welcome on its side at 200 percent', () => {
    test.use({ viewport: { width: 640, height: 360 } })

    test('the button is below the first screen, and a round button leads to it', async ({ page }) => {
      const errors = watchErrors(page)
      await openShell(page, { skipOnboarding: false, fontScale: 200 })
      await expect(page.getByTestId('m-onboarding-screen')).toHaveAttribute('data-m-foot', 'scrolls')
      const next = page.getByTestId('m-onboarding-next')
      await expect(next).not.toBeInViewport()
      const jump = page.getByTestId('m-foot-jump')
      await expect(jump).toBeInViewport({ ratio: 1 })
      await jump.tap()
      await expect(next).toBeInViewport({ ratio: 1 })
      await expect(jump).toHaveCount(0)
      expect(errors()).toEqual([])
    })
  })

  test('upright the footer stays fixed below the content', async ({ page }) => {
    await openShell(page, { route: '/dev/frame' })
    const screen = page.getByTestId('m-dev-frame-screen')
    await expect(screen).toHaveAttribute('data-m-foot', 'fixed')
    await expect(screen.locator(':scope > .m-foot')).toHaveCount(1)
    await expect(page.getByTestId('m-dev-frame-main')).toBeInViewport({ ratio: 1 })
  })
})

test.describe('kit: the field with the focus stays in sight', () => {
  for (const view of [
    { name: '390x844', width: 390, height: 844, keyboard: 320 },
    { name: '360x592', width: 360, height: 592, keyboard: 275 },
  ]) {
    test.describe(view.name, () => {
      test.use({ viewport: { width: view.width, height: view.height } })

      test('the window gets lower by a keyboard: the field, its label and its hint are inside the scrolling area', async ({ page }) => {
        const errors = watchErrors(page)
        await openShell(page, { route: '/dev/ui' })
        const field = page.getByTestId('m-dev-ui-key')
        // Put the field at the lower edge of the page, where a tap finds it on a phone.
        await field.evaluate((el) => {
          const body = el.closest('.m-body')!
          const set = el.closest('.m-fieldset') ?? el
          body.scrollTop += set.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom + 4
        })
        await field.focus()
        // What an Android keyboard does to the window (adjustResize).
        await page.setViewportSize({ width: view.width, height: view.height - view.keyboard })
        await expect
          .poll(() =>
            field.evaluate((el) => {
              const body = el.closest('.m-body')!.getBoundingClientRect()
              const set = (el.closest('.m-fieldset') ?? el).getBoundingClientRect()
              return set.top >= body.top - 0.5 && set.bottom <= body.bottom + 0.5 && set.bottom <= window.innerHeight
            }),
          )
          .toBe(true)
        await expect(field).toBeInViewport({ ratio: 1 })
        await expect(field).toBeFocused()
        expect(errors()).toEqual([])
      })
    })
  }

  test('in a sheet as well', async ({ page }) => {
    await openShell(page, { route: '/dev/ui' })
    await page.getByTestId('m-dev-ui-report').scrollIntoViewIfNeeded()
    await page.getByTestId('m-dev-ui-report').tap()
    const sheet = page.getByTestId('m-sheet-report')
    await expect(sheet).toBeVisible()
    const field = sheet.locator('textarea, input:not([type="radio"]):not([type="checkbox"])').last()
    await field.focus()
    await page.setViewportSize({ width: 390, height: 844 - 320 })
    await expect
      .poll(() =>
        field.evaluate((el) => {
          const body = el.closest('.m-sheet-body')!.getBoundingClientRect()
          const box = el.getBoundingClientRect()
          return box.top >= body.top - 0.5 && box.bottom <= Math.min(body.bottom, window.innerHeight) + 0.5
        }),
      )
      .toBe(true)
  })

  // A phone on its side: the keyboard leaves about a third of the height. A field of several lines used to lie
  // partly under it (acceptance Android, re-run, N8). What a keyboard does to the window is done here the way the
  // tests above do it: the field gets the focus, then the window loses the height of the keyboard.
  for (const view of [
    { name: '592x360', width: 592, height: 360, left: 150 },
    { name: '568x320', width: 568, height: 320, left: 127 },
  ]) {
    test.describe(`on its side, ${view.name}`, () => {
      test.use({ viewport: { width: view.width, height: view.height } })

      /** The field, the room around it and the window, in one reading. */
      const measure = (page: Page, testid: string, scroller: string) =>
        page.getByTestId(testid).evaluate((el, sel) => {
          const field = el as HTMLTextAreaElement
          const box = field.getBoundingClientRect()
          const frame = field.closest('.m-textarea')!.getBoundingClientRect()
          const room = field.closest(sel)!.getBoundingClientRect()
          const bottom = Math.min(room.bottom, window.innerHeight)
          return {
            capped: field.hasAttribute('data-m-capped'),
            height: box.height,
            inside: frame.top >= room.top - 0.5 && frame.bottom <= bottom + 0.5,
            fitsRoom: frame.height <= bottom - room.top + 0.5,
            scrollsInside: field.scrollHeight > field.clientHeight + 1,
            atEnd: field.scrollTop + field.clientHeight >= field.scrollHeight - 2,
            atStart: field.scrollTop <= 1,
            room: bottom - room.top,
          }
        }, scroller)

      test('a field of twelve rows is capped to the room above the keyboard, its text scrolls inside, the caret stays in sight', async ({ page }) => {
        const errors = watchErrors(page)
        await openShell(page, { route: '/dev/ui' })
        const field = page.getByTestId('m-dev-ui-long-notes')
        await field.scrollIntoViewIfNeeded()
        const natural = (await field.boundingBox())!.height
        // Twelve rows are higher than the whole window of a phone on its side is with a keyboard.
        expect(natural).toBeGreaterThan(view.left)
        await field.fill(Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the instructions.`).join('\n'))
        await field.focus()
        await page.setViewportSize({ width: view.width, height: view.left })
        await expect(page.locator('html')).toHaveClass(/m-kb-open/)
        await expect.poll(async () => (await measure(page, 'm-dev-ui-long-notes', '.m-body')).inside).toBe(true)
        const open = await measure(page, 'm-dev-ui-long-notes', '.m-body')
        expect(open.capped).toBe(true)
        expect(open.fitsRoom, `field ${open.height} in a room of ${open.room}`).toBe(true)
        expect(open.height).toBeLessThan(natural)
        // At least one whole line is there to type in.
        expect(open.height).toBeGreaterThanOrEqual(20)
        expect(open.scrollsInside).toBe(true)
        // The caret is at the end of the text (fill put it there): the last line is what is shown.
        expect(open.atEnd).toBe(true)
        // Typing goes on at the caret and stays in sight.
        await page.keyboard.type(' More.')
        await expect(field).toHaveValue(/Line 40 of the instructions\. More\.$/)
        expect((await measure(page, 'm-dev-ui-long-notes', '.m-body')).atEnd).toBe(true)
        // The caret at the start: the first line is shown, not the last.
        await field.evaluate((el) => {
          const area = el as HTMLTextAreaElement
          area.setSelectionRange(0, 0)
          area.scrollTop = 0
        })
        await page.setViewportSize({ width: view.width, height: view.left + 8 })
        await expect.poll(async () => (await measure(page, 'm-dev-ui-long-notes', '.m-body')).inside).toBe(true)
        expect((await measure(page, 'm-dev-ui-long-notes', '.m-body')).atStart).toBe(true)
        expect(await measureLayout(page)).toEqual(CLEAN_LAYOUT)
        // The keyboard goes: the field gets the room that is back. Twelve rows are still more than a phone on its
        // side shows, so it stays capped, to that larger room.
        await page.setViewportSize({ width: view.width, height: view.height })
        await expect.poll(async () => (await measure(page, 'm-dev-ui-long-notes', '.m-body')).height).toBeGreaterThan(open.height + 50)
        const closed = await measure(page, 'm-dev-ui-long-notes', '.m-body')
        expect(closed.fitsRoom, `field ${closed.height} in a room of ${closed.room}`).toBe(true)
        expect(closed.inside).toBe(true)
        // The focus leaves: the cap goes and the field has its twelve rows again, also under a keyboard.
        await page.setViewportSize({ width: view.width, height: view.left })
        await expect.poll(async () => (await measure(page, 'm-dev-ui-long-notes', '.m-body')).height).toBeLessThan(closed.height)
        await field.blur()
        await expect.poll(async () => (await measure(page, 'm-dev-ui-long-notes', '.m-body')).capped).toBe(false)
        expect((await field.boundingBox())!.height).toBeCloseTo(natural, 0)
        expect(errors()).toEqual([])
      })

      test('a field of three rows in a sheet is inside the sheet above the keyboard', async ({ page }) => {
        const errors = watchErrors(page)
        await openShell(page, { route: '/dev/ui' })
        await page.getByTestId('m-dev-ui-report').scrollIntoViewIfNeeded()
        await page.getByTestId('m-dev-ui-report').tap()
        await expect(page.getByTestId('m-sheet-report')).toBeVisible()
        const reason = page.locator('[data-testid^="m-report-reason-"]').first()
        if (await reason.count()) await reason.tap()
        const note = page.getByTestId('m-report-note')
        await note.fill('One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight')
        await note.focus()
        await page.setViewportSize({ width: view.width, height: view.left })
        await expect(page.locator('html')).toHaveClass(/m-kb-open/)
        await expect.poll(async () => (await measure(page, 'm-report-note', '.m-sheet-body')).inside).toBe(true)
        const open = await measure(page, 'm-report-note', '.m-sheet-body')
        expect(open.fitsRoom, `field ${open.height} in a room of ${open.room}`).toBe(true)
        expect(open.height).toBeGreaterThanOrEqual(20)
        expect(open.atEnd).toBe(true)
        expect(errors()).toEqual([])
      })
    })
  }

  // A phone on its side, 640 by 360, with a keyboard that leaves 101 px: the grabber and the title of a sheet took
  // 57 of them, and the field lay 7 px under the keyboard in three sheets, at the largest text half of the note of
  // the report sheet (acceptance Android, second part, F13). In that room the sheet scrolls as one piece.
  for (const scale of [100, 200]) {
    test.describe(`a sheet on its side above a keyboard that leaves 101 px, text at ${scale} percent`, () => {
      test.use({ viewport: { width: 640, height: 360 } })

      for (const sheet of ['settings-forgot-password', 'settings-new-password', 'create-model', 'report']) {
        test(`${sheet}: the field with the focus is fully above the keyboard`, async ({ page }) => {
          const errors = watchErrors(page)
          await openShell(page, { route: '/dev/routes', fontScale: scale })
          const opener = page.getByTestId(`m-dev-sheet-open-${sheet}`)
          await opener.scrollIntoViewIfNeeded()
          await opener.tap()
          const box = page.getByTestId(`m-sheet-${sheet}`)
          await expect(box).toBeVisible()
          await expect(box).not.toHaveAttribute('data-m-settling', '')
          if (sheet === 'report') await box.locator('[data-testid^="m-report-reason-"]').first().tap()
          const field = box.locator('textarea, input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"])').first()
          await expect(field).toBeVisible()
          await field.focus()
          await page.setViewportSize({ width: 640, height: 101 })
          await expect(page.locator('html')).toHaveClass(/m-kb-open/)
          await expect(page.locator('html')).toHaveAttribute('data-m-room', 'cramped')
          const read = () =>
            field.evaluate((el) => {
              const frame = (el.closest('.m-textarea') ?? el).getBoundingClientRect()
              const dialog = el.closest('.m-sheet')!.getBoundingClientRect()
              return { top: Math.round(frame.top), bottom: Math.round(frame.bottom), view: window.innerHeight, sheetTop: Math.round(dialog.top), sheetBottom: Math.round(dialog.bottom) }
            })
          await expect.poll(async () => { const r = await read(); return r.top >= 0 && r.bottom <= r.view }).toBe(true)
          const at = await read()
          expect(at.bottom, `field ${at.top} to ${at.bottom} in ${at.view}`).toBeLessThanOrEqual(at.view)
          expect(at.top).toBeGreaterThanOrEqual(0)
          // The sheet itself ends with the visible part: nothing of it is under the keyboard.
          expect(at.sheetTop).toBeGreaterThanOrEqual(0)
          expect(at.sheetBottom).toBeLessThanOrEqual(at.view)
          await expect(field).toBeFocused()
          // The keyboard goes: the title and Close are there again.
          await page.setViewportSize({ width: 640, height: 360 })
          await expect(page.locator('html')).not.toHaveClass(/m-kb-open/)
          await expect(page.getByTestId('m-sheet-close')).toBeInViewport({ ratio: 1 })
          expect(errors()).toEqual([])
        })
      }
    })
  }
})

// The back swipe from the left edge on a page that fills the screen. The strip of the gesture lay under the viewer,
// so on "This file is no longer available." and on a result that is gone the swipe did nothing (acceptance iPhone,
// K13). The strip is above the viewer now, on every one of these pages.
test.describe('kit: the strip of the back swipe lies above a page that fills the screen', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  for (const [route, pattern] of [
    ['/dev/viewer', '/dev/viewer'],
    ['/chat/none/file/none', '/chat/:id/file/:fileId'],
    ['/create/item/none', '/create/item/:id'],
  ]) {
    test(`${route}: the left edge belongs to the swipe, and the swipe goes back`, async ({ page }) => {
      await openShell(page, { route, os: 'ios' })
      await expect(topPage(page)).toHaveAttribute('data-route', pattern)
      await expect(topPage(page).locator('.m-viewer')).toBeVisible()
      for (const part of [0.25, 0.5, 0.8]) {
        const hit = await page.evaluate((y) => document.elementFromPoint(6, y)?.className ?? '', Math.round(844 * part))
        expect(hit, `at ${part} of the height`).toBe('m-edge')
      }
      await page.mouse.move(6, 420)
      await page.mouse.down()
      await page.mouse.move(300, 424, { steps: 8 })
      await page.mouse.up()
      await expect(topPage(page)).not.toHaveAttribute('data-route', pattern)
    })
  }

  // The rule of the kit, held on every page of the app: whatever a page draws (its content, or the page that says
  // the thing is gone), the left edge belongs to the swipe. One run over all of them, each opened with ids that
  // do not exist, which is the case the phone showed (acceptance iPhone, second part, P1).
  test('every page that is not a tab root and not the onboarding has the strip on top at its left edge, and the swipe leaves it', async ({ page }) => {
    test.setTimeout(240_000)
    const pages = (Object.entries(ROUTES) as [string, { kind: string; screen: string; dev?: boolean }][]).filter(([route, def]) => (def.kind === 'page' || def.kind === 'full') && !def.dev && route !== '/create/mask')
    expect(pages.length).toBeGreaterThan(40)
    await openShell(page, { route: '/dev/routes', os: 'ios' })
    const failed: string[] = []
    for (const [route, def] of pages) {
      // Opened from the list of all screens, with ids that do not exist.
      const title = new RegExp(`^${route.replace(/[/:.]/g, '\\$&')}$`)
      await topPage(page).locator(`[data-testid="m-dev-route-${def.screen}"]`).filter({ has: page.locator('.m-row-title', { hasText: title }) }).evaluate((row) => (row as HTMLElement).click())
      await expect(topPage(page), route).toHaveAttribute('data-route', route)
      // The page slides in first: while it moves, the edge of the screen is not yet the edge of the page.
      const read = () => page.evaluate(() => [0.25, 0.5, 0.8].map((part) => document.elementFromPoint(6, Math.round(innerHeight * part))?.className ?? ''))
      const free = await expect.poll(async () => (await read()).every((name) => name === 'm-edge'), { timeout: 3000 }).toBe(true).then(() => true, () => false)
      if (!free) failed.push(`${route}: the edge shows ${(await read()).join(' | ')}`)
      await page.mouse.move(6, 420)
      await page.mouse.down()
      await page.mouse.move(300, 424, { steps: 6 })
      await page.mouse.up()
      const left = await expect(topPage(page)).toHaveAttribute('data-route', '/dev/routes', { timeout: 3000 }).then(() => true, () => false)
      if (!left) {
        failed.push(`${route}: the swipe did not leave the page`)
        await openShell(page, { route: '/dev/routes', os: 'ios' })
      }
    }
    expect(failed).toEqual([])
  })

  test('the mask editor has no strip: a stroke from the left edge paints', async ({ page }) => {
    await openShell(page, { route: '/create/mask', os: 'ios' })
    await expect(topPage(page)).toHaveAttribute('data-route', '/create/mask')
    const hit = await page.evaluate(() => document.elementFromPoint(6, 420)?.className ?? '')
    expect(hit).not.toBe('m-edge')
  })
})
