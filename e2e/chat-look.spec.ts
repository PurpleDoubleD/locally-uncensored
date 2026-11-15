import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { gradientPng } from './support/png'

/**
 * 3.1.0 P-M: the chat look (C58), the reading zoom (C42) and the Memory quick
 * menu (C38), in the real app with the Tauri bridge mocked.
 *
 *  - Ctrl + wheel over the transcript zooms the messages, the prompt box keeps
 *    its size, and the zoom survives a reload. Ctrl + 0 resets it.
 *  - A right click in a zoomed transcript opens the menu AT the pointer.
 *  - A preset colours quoted speech; custom CSS with url() loads nothing.
 *  - A background picture from a file shows under a scrim and survives a reload.
 *  - A long memory opens in full and can be edited in place.
 *
 * Run: LU_E2E_PORT=5391 CI=1 npx playwright test e2e/chat-look.spec.ts --project=chromium
 */

const CONV = 'look-chat'
const REPLY = '*She smiles.* "Welcome back," she says. The harbour is quiet tonight.'

function seed(): string {
  const now = Date.now()
  return JSON.stringify({
    state: {
      conversations: [{
        id: CONV, title: 'Harbour', model: DEFAULT_MODEL_NAME, systemPrompt: '', mode: 'lu',
        createdAt: now - 20_000, updatedAt: now - 10_000, personaEnabled: false,
        messages: [
          { id: 'u1', role: 'user', content: '*I wave.* "Hello!"', timestamp: now - 10_000 },
          { id: 'a1', role: 'assistant', content: REPLY, timestamp: now - 9_000, modelId: 'qwen2.5-7b-instruct-q4_k_m' },
        ],
      }],
      activeConversationId: CONV,
    },
    version: 0,
  })
}

const LONG = 'The user writes slow fantasy roleplay in the port city of Kessel. Their character is Arin, a courier who owes the harbour guild money. Avoid modern slang.'

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, attachmentStore: true })
  await seedOnboardingDone(page)
  await page.addInitScript(({ raw, mem }) => {
    if (sessionStorage.getItem('e2e-seeded')) return
    sessionStorage.setItem('e2e-seeded', '1')
    localStorage.setItem('chat-conversations', raw)
    const now = Date.now()
    localStorage.setItem('locally-uncensored-memory', JSON.stringify({ state: { entries: [
      { id: 'mem1', type: 'user', title: 'Roleplay setting', description: mem.slice(0, 120), content: mem, tags: [], createdAt: now, updatedAt: now, source: 'manual' },
    ] }, version: 0 }))
  }, { raw: seed(), mem: LONG })
  await page.goto('/')
  await expect(reply(page)).toBeVisible({ timeout: 30_000 })
}

function reply(page: Page) {
  return page.getByText('The harbour is quiet tonight.', { exact: false }).first()
}

async function zoomOf(page: Page): Promise<number> {
  return page.getByTestId('chat-look-chat').evaluate((el) => Number(getComputedStyle(el).getPropertyValue('--lu-chat-zoom')))
}

test('Ctrl + wheel zooms the messages only, and the zoom stays', async ({ page }) => {
  await boot(page)
  const composer = page.getByPlaceholder('Message...')
  const composerBefore = (await composer.boundingBox())!.height
  const textBefore = (await reply(page).boundingBox())!.height

  await reply(page).hover()
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -100)
  await page.mouse.wheel(0, -100)
  await page.mouse.wheel(0, -100)
  await page.keyboard.up('Control')

  await expect.poll(() => zoomOf(page)).toBeCloseTo(1.3, 2)
  await expect(page.getByTestId('chat-zoom-badge')).toContainText('130%')
  expect((await reply(page).boundingBox())!.height).toBeGreaterThan(textBefore * 1.2)
  expect((await composer.boundingBox())!.height).toBeCloseTo(composerBefore, 0)

  await page.reload()
  await expect(reply(page)).toBeVisible({ timeout: 30_000 })
  expect(await zoomOf(page)).toBeCloseTo(1.3, 2)

  await page.keyboard.press('Control+0')
  await expect.poll(() => zoomOf(page)).toBe(1)
})

test('a trackpad pinch zooms in WebKit, where it arrives as gesture events', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'gesture events are WebKit only (the Mac app)')
  await boot(page)
  const scope = page.getByTestId('chat-look-chat')
  const prevented = await scope.evaluate((el) => {
    const fire = (type: string, scale: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(e, 'scale', { value: scale })
      el.querySelector('.lu-chat-zoom')!.dispatchEvent(e)
      return e.defaultPrevented
    }
    return [fire('gesturestart', 1), fire('gesturechange', 1.25), fire('gesturechange', 1.5), fire('gestureend', 1.5)]
  })
  // Prevented: the WebView must not magnify the whole page at the same time.
  expect(prevented).toEqual([true, true, true, true])
  await expect.poll(() => zoomOf(page)).toBeCloseTo(1.5, 2)
  await expect(page.getByTestId('chat-zoom-badge')).toContainText('150%')
})

test('a right click in a zoomed transcript opens the menu at the pointer', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => localStorage.setItem('lu-chat-look', JSON.stringify({ state: { look: {}, zoom: 1.5, backgrounds: {} }, version: 0 })))
  await page.reload()
  await expect(reply(page)).toBeVisible({ timeout: 30_000 })
  // The chat view slides in (y 20 -> 0, 250 ms). While it moves, its
  // transform is the frame a fixed menu sits in, so a click in that window
  // lands the menu off the pointer. Under load the slide outlasts the boot.
  await expect.poll(() => reply(page).evaluate((el) => {
    for (let n: Element | null = el; n; n = n.parentElement) if (getComputedStyle(n).transform !== 'none') return false
    return true
  })).toBe(true)
  const box = (await reply(page).boundingBox())!
  const x = box.x + 40
  const y = box.y + box.height / 2
  await page.mouse.click(x, y, { button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const m = (await menu.boundingBox())!
  expect(Math.abs(m.x - x)).toBeLessThan(24)
  expect(Math.abs(m.y - y)).toBeLessThan(24)
})

test('the Roleplay preset colours quotes; custom CSS with url() loads nothing', async ({ page }) => {
  const asked: string[] = []
  page.on('request', (r) => { if (r.url().includes('evil.example')) asked.push(r.url()) })
  await boot(page)
  await page.getByTestId('chat-look-button').click()
  const panel = page.getByTestId('chat-look-panel')
  await panel.getByRole('button', { name: 'Roleplay' }).click()
  const quote = page.locator('.lu-msg-model-text .lu-quote').first()
  await expect(quote).toHaveText('"Welcome back,"')
  const colours = await quote.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el.parentElement!).color])
  expect(colours[0]).not.toBe(colours[1])
  await expect(page.locator('.lu-msg-user-text .lu-action')).toHaveText('*I wave.*')

  await panel.getByRole('button', { name: /Custom CSS/ }).click()
  await panel.getByLabel('Use custom CSS').click()
  await panel.getByRole('textbox', { name: 'Custom CSS' }).fill('.lu-quote { font-weight: 700; background: url(https://evil.example/t.png) }\n@import url(https://evil.example/x.css);\nbody { display: none }')
  await expect(panel.getByTestId('chat-css-dropped')).toBeVisible()
  await expect(quote).toHaveCSS('font-weight', '700')
  await expect(page.locator('body')).toBeVisible()
  const css = await page.getByTestId('chat-custom-css').textContent()
  expect(css).not.toMatch(/url|@import|evil/)
  await page.waitForTimeout(500)
  expect(asked).toEqual([])
})

test('a background from a file shows under a scrim and stays after a reload', async ({ page }) => {
  await boot(page)
  await page.getByTestId('chat-look-button').click()
  const panel = page.getByTestId('chat-look-panel')
  await panel.locator('input[type="file"]').setInputFiles({ name: 'harbour.png', mimeType: 'image/png', buffer: gradientPng(640, 360) })
  const bg = page.getByTestId('chat-background')
  await expect(bg.locator('img')).toHaveAttribute('src', /^data:image\/jpeg/)
  await expect(panel.getByLabel('Background dimming')).toBeVisible()
  const shots = process.env.LU_SHOTS_DIR
  if (shots) {
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await page.screenshot({ path: `${shots}/nachher-hintergrund-${await page.evaluate(() => document.documentElement.classList.contains('dark') ? 'dark' : 'light')}-1280.png` })
  }
  await page.reload()
  await expect(reply(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('chat-background').locator('img')).toHaveAttribute('src', /^data:image\/jpeg/)
})

test('the Memory quick menu opens a long memory in full and edits it', async ({ page }) => {
  await boot(page)
  await page.getByTitle('Memory: view, add or delete the context injected into prompts').click()
  await page.getByRole('button', { name: /Roleplay setting/, expanded: false }).click()
  await expect(page.getByTestId('memory-full')).toHaveText(LONG)
  await page.getByLabel('Edit Roleplay setting').click()
  await page.getByRole('textbox', { name: 'Memory', exact: true }).fill(LONG + ' Arin carries a brass key.')
  await page.getByTestId('memory-save').click()
  await expect(page.getByTestId('memory-full')).toContainText('Arin carries a brass key.')
  await page.reload()
  await expect(reply(page)).toBeVisible({ timeout: 30_000 })
  // Read back through the app, wherever the store keeps it.
  await page.getByTitle('Memory: view, add or delete the context injected into prompts').click()
  await page.getByRole('button', { name: /Roleplay setting/, expanded: false }).click()
  await expect(page.getByTestId('memory-full')).toContainText('Arin carries a brass key.')
})

test('the line spacing slider spaces lines, paragraphs and messages, in Chat and Code', async ({ page }) => {
  await boot(page)
  const lineRatio = (sel: string) => page.locator(sel).first().evaluate((el) => {
    const t = (el.querySelector('p') ?? el) as HTMLElement
    return parseFloat(getComputedStyle(t).lineHeight) / parseFloat(getComputedStyle(t).fontSize)
  })
  const gap = (sel: string) => page.locator(sel).first().evaluate((el) => parseFloat(getComputedStyle(el).paddingTop))
  const before = { model: await lineRatio('.lu-msg-model-text'), user: await lineRatio('.lu-msg-user-text'), row: await gap('.lu-msg-row') }

  await page.getByTestId('chat-look-button').click()
  const slider = page.getByTestId('chat-look-panel').getByRole('slider', { name: 'Line spacing' })
  // One step from the default: nothing jumps, the gaps match the classes they replace.
  await slider.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('chat-look-chat')).toHaveClass(/lu-look-leading/)
  expect(Math.abs((await gap('.lu-msg-row')) - before.row)).toBeLessThan(1)
  // All the way up: every line and every gap opens.
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight')
  await expect.poll(() => lineRatio('.lu-msg-model-text')).toBeGreaterThan(before.model + 0.4)
  expect(await lineRatio('.lu-msg-user-text')).toBeGreaterThan(before.user + 0.4)
  expect(await gap('.lu-msg-row')).toBeGreaterThan(before.row * 1.25)

  // The Code transcript reads with the same spacing (prose, not code blocks).
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('chat-look-code')).toHaveCount(0)
  await page.getByRole('button', { name: 'Code', exact: true }).first().click()
  const code = page.getByTestId('chat-look-code')
  await expect(code).toHaveClass(/lu-look-leading/)
  expect(await code.evaluate((el) => getComputedStyle(el).getPropertyValue('--lu-look-leading'))).toBe('2.2')
})
