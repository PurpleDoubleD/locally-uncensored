import { test, expect, type Locator, type Page } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'
import { mockModelsAnswer } from './support/chat-catalogue'
import { openNewChat, expectWorkspaceAsk, answerWorkspaceAsk } from './support/ui'

/**
 * The Beta mark in the running app (the owner for 3.0.6: what is not finished to
 * the last proof is marked Beta, clearly, where the customer switches it on
 * or meets it first).
 *
 * One mark (components/ui/BetaMark), one list (lib/beta.ts). This file walks
 * to every place the mark stands at, in both themes and in a wide and a
 * narrow window, and holds four things each time: the word is there, the
 * hover sentence is the one of the list, it is readable (4.5 to 1), and it is
 * not cut off. Which files carry a mark is lib/__tests__/beta-marks.test.ts.
 *
 * Run: CI=1 LU_E2E_PORT=5701 npx playwright test e2e/beta-marks.spec.ts
 * Pictures: LU_BETA_SHOTS=<folder> writes every place there.
 */

const SHOTS = process.env.LU_BETA_SHOTS
const NOTE = {
  computer: /^Beta: computer control is new/,
  voice: /^Beta: Voice is new/,
  create: /^Beta: Create in chat is new/,
  direct: /^Beta: these models are new in LU Cloud/,
}
const THEMES = ['dark', 'light'] as const
const SIZES = [['wide', 1440, 900], ['narrow', 760, 820]] as const

async function shot(page: Page, name: string) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.waitForTimeout(450)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

/** The app starts dark; the header button switches. */
async function setTheme(page: Page, theme: 'dark' | 'light') {
  if (theme === 'light') await page.getByRole('button', { name: 'Light Mode' }).click()
}

/** A destination of the main navigation: a row of buttons, or a menu in a narrow window. */
async function goTo(page: Page, name: 'Settings' | 'Voice') {
  const nav = page.getByRole('navigation', { name: 'Main' })
  const direct = nav.getByRole('button', { name, exact: true })
  if (await direct.isVisible().catch(() => false)) return direct.click()
  await nav.getByRole('button', { name: 'Main navigation' }).click()
  await nav.getByRole('menuitem', { name, exact: true }).click()
}

/** WCAG contrast of the mark's word on what is painted behind it. */
async function contrastOf(mark: Locator): Promise<number> {
  return mark.evaluate((el) => {
    const parse = (c: string): [number, number, number, number] => {
      const srgb = c.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/)
      if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])]
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) return [0, 0, 0, 0]
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
      return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]
    }
    const layers: [number, number, number, number][] = []
    for (let n: Element | null = el; n; n = n.parentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor)
      if (bg[3] > 0) layers.push(bg)
      if (bg[3] >= 1) break
    }
    let back: [number, number, number] = document.documentElement.classList.contains('light') ? [255, 255, 255] : [0, 0, 0]
    for (const [r, g, b, a] of layers.reverse()) {
      back = [r * a + back[0] * (1 - a), g * a + back[1] * (1 - a), b * a + back[2] * (1 - a)]
    }
    const text = parse(getComputedStyle(el).color)
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const a = lum(text), b = lum(back)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  })
}

/** The word, the sentence, readable, whole, and inside the window. */
async function holds(mark: Locator, note: RegExp) {
  await expect(mark).toBeVisible()
  await expect(mark).toHaveText('Beta')
  await expect(mark).toHaveAttribute('title', note)
  expect(await contrastOf(mark)).toBeGreaterThanOrEqual(4.5)
  const whole = await mark.evaluate((el) => {
    const box = el.getBoundingClientRect()
    return el.scrollWidth <= el.clientWidth + 1 && box.width > 20 && box.left >= 0 && box.right <= window.innerWidth
  })
  expect(whole).toBe(true)
  // Nothing covers it: the point in its middle is the mark itself. Asked
  // until it holds, because a menu or a dialog may still be sliding in.
  await expect.poll(() => mark.evaluate((el) => {
    const box = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
  })).toBe(true)
}

const MOCK: TauriMockOptions = { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' }

for (const theme of THEMES) {
  for (const [label, width, height] of SIZES) {
    const tag = `${theme}-${label}`

    test(`computer control: the switch in the permission settings (${tag})`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await page.addInitScript(tauriMockInit, { ...MOCK, computer: { shrinks: false } })
      await seedOnboardingDone(page)
      await page.goto('/')
      await expect(page.getByRole('banner')).toBeVisible()
      await setTheme(page, theme)
      await goTo(page, 'Settings')
      await page.getByRole('button', { name: 'Agent', exact: true }).click()
      const section = page.getByTestId('computer-control-settings')
      if (!(await section.isVisible().catch(() => false))) {
        await page.getByRole('button', { name: 'Agent Permissions', exact: true }).click()
      }
      await section.scrollIntoViewIfNeeded()
      const mark = section.locator('.lu-beta')
      await expect(mark).toHaveCount(1)
      await holds(mark, NOTE.computer)
      // On the line of the name, left of the switch.
      await expect(mark.locator('xpath=..')).toHaveText('Computer controlBeta')
      // Measured in one go: the section may still be scrolling into place.
      const at = await section.evaluate((el) => {
        const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.left, right: r.right, mid: r.top + r.height / 2 } }
        const beta = el.querySelector('.lu-beta')!
        return { mark: rect(beta), name: rect(beta.parentElement!), toggle: rect(el.querySelector('[aria-label="Computer control"]')!) }
      })
      expect(Math.abs(at.mark.mid - at.name.mid)).toBeLessThan(6)
      expect(at.mark.right).toBeLessThan(at.toggle.x)
      // The sentence stands in the open here, not only on hover.
      await expect(section.getByTestId('computer-control-beta-note')).toHaveText(NOTE.computer)
      await section.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await shot(page, `desktop-${tag}-1-computer-control-settings`)
    })

    test(`voice: the title of the tab, its settings, and the line that switches computer control on (${tag})`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await page.addInitScript(() => {
        MediaDevices.prototype.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream
      })
      await page.addInitScript(tauriMockInit, {
        ...MOCK,
        voiceLoop: { installed: true, session: { port: 9, token: 'e2e-launch-token'.padEnd(64, '0') } },
      })
      await seedOnboardingDone(page)
      await page.goto('/')
      await expect(page.getByRole('banner')).toBeVisible()
      await setTheme(page, theme)
      await goTo(page, 'Voice')
      const view = page.getByTestId('voice-view')
      await expect(view).toBeVisible()
      const mark = view.locator('header .lu-beta')
      await expect(mark).toHaveCount(1)
      await holds(mark, NOTE.voice)
      const title = (await view.getByRole('heading', { name: 'Voice' }).boundingBox())!
      const box = (await mark.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(title.x + title.width)
      expect(Math.abs(box.y + box.height / 2 - (title.y + title.height / 2))).toBeLessThan(6)
      await shot(page, `desktop-${tag}-2-voice-tab`)

      // The settings are a popup with an X; its title carries the mark, its name stays plain.
      await view.getByRole('button', { name: 'Voice settings' }).click()
      const settings = page.getByRole('dialog', { name: 'Voice settings', exact: true })
      await expect(settings).toBeVisible()
      await expect(settings.getByRole('button', { name: 'Close' })).toBeVisible()
      await holds(settings.locator('.lu-beta'), NOTE.voice)
      await shot(page, `desktop-${tag}-3-voice-settings`)
      await page.keyboard.press('Escape')
      await expect(settings).toHaveCount(0)

      // "Whole computer" switches computer control on: the mark stands on that line.
      await view.getByTestId('voice-scope').click()
      await view.getByRole('menuitemradio', { name: /Whole computer/ }).click()
      const whole = page.getByRole('dialog', { name: 'Whole computer' })
      await expect(whole).toBeVisible()
      const line = whole.getByRole('listitem').filter({ hasText: 'Computer control is switched on for this.' })
      await holds(line.locator('.lu-beta'), NOTE.computer)
      await expect(whole.locator('.lu-beta')).toHaveCount(1)
      await shot(page, `desktop-${tag}-4-voice-whole-computer`)
    })

    test(`computer control: the head of the small window (${tag})`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      const screens = ['01-editor.jpg', '02-save-dialog.jpg', '03-saved.jpg']
        .map((name) => readFileSync(resolve(process.cwd(), 'e2e/fixtures/computer-task', name)).toString('base64'))
      await page.addInitScript(tauriMockInit, {
        assistantReply: 'unused', modelName: 'gemma-3-12b-it-q4_k_m', platform: 'windows' as const, replyChunkDelayMs: 8,
        agentTurns: [
          { text: 'I will save it.', toolCalls: [{ name: 'computer_task', args: { goal: 'Save the note' } }] },
          { text: JSON.stringify({ thought: 'The Save button is in the toolbar.', action: 'click', x: 203, y: 235 }) },
          { text: 'Stopped.' },
        ],
        computer: { screens, actionMs: 1500 },
      })
      await seedOnboardingDone(page)
      await page.addInitScript(() => {
        window.localStorage.setItem('locally-uncensored-permissions', JSON.stringify({
          state: {
            globalPermissions: { filesystem: 'auto', terminal: 'auto', desktop: 'auto', web: 'auto', system: 'auto', image: 'auto', video: 'auto', workflow: 'auto' },
            conversationOverrides: {}, perToolOverrides: {}, modeScope: 'agent',
          },
          version: 2,
        }))
        window.localStorage.setItem('locally-uncensored-computer', JSON.stringify({
          state: { enabled: true, alwaysAllowed: [], executorModel: null },
          version: 1,
        }))
      })
      await page.goto('/')
      await expect(page.getByRole('banner')).toBeVisible()
      await setTheme(page, theme)
      await openNewChat(page)
      const agentToggle = page.getByRole('main').getByRole('button', { name: 'Agent', exact: true })
      await agentToggle.click()
      expectWorkspaceAsk(page)
      await expect(agentToggle).toHaveAttribute('title', /Agent Mode is on/i, { timeout: 10_000 })
      const composer = page.locator('textarea').first()
      await expect(composer).toBeEnabled({ timeout: 20_000 })
      await composer.fill('Save my note.')
      await composer.press('Enter')
      await answerWorkspaceAsk(page)

      const panel = page.getByTestId('computer-panel')
      await expect(panel.getByRole('group', { name: 'Allow LU to control Notepad?' })).toBeVisible({ timeout: 30_000 })
      const mark = panel.locator('.lu-beta')
      await expect(mark).toHaveCount(1)
      await holds(mark, NOTE.computer)
      // In the head, between what LU does and Stop, and Stop keeps its place.
      const stop = (await panel.getByTestId('computer-stop').boundingBox())!
      const box = (await mark.boundingBox())!
      expect(box.x + box.width).toBeLessThanOrEqual(stop.x)
      expect(Math.abs(box.y + box.height / 2 - (stop.y + stop.height / 2))).toBeLessThan(6)
      await shot(page, `desktop-${tag}-5-computer-control-window`)
    })

    test(`create in chat: the switch under Plugins, and the order that waits (${tag})`, async ({ page }) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
      const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
      const say = (text: string) => sse([
        { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ])
      await page.setViewportSize({ width, height })
      await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
      await seedOnboardingDone(page)
      await routeCloud(page, { license: 'active', access: true, mediaLive: true, paidPlan: true, tierCatalog: true, createChat: true })
      let turn = 0
      await page.route('**/api/inference/v1/chat/completions', async (route) => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
        const body = JSON.parse(route.request().postData() ?? '{}') as { messages: Array<{ role: string }>; tools?: unknown[] }
        turn += 1
        const last = body.messages[body.messages.length - 1]
        const reply = last?.role === 'tool'
          ? say('Here is the order. Say yes or press Start.')
          : body.tools?.length
            ? sse([
                { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
                { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${turn}`, type: 'function', function: { name: 'create_order', arguments: JSON.stringify({ items: [{ intent: 'image', prompt: 'a red fox in the snow' }] }) } }] }, finish_reason: null }] },
                { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
              ])
            : say('Plain answer.')
        return route.fulfill({ status: 200, headers: cors, contentType: 'text/event-stream', body: reply })
      })
      await page.goto('/')
      await signInViaGate(page)
      await expect(cloudSwitch(page)).toBeChecked()
      await setTheme(page, theme)
      await page.getByRole('button', { name: /New Chat/i }).first().click()
      await page.getByRole('button', { name: 'Select chat model', exact: true }).click()
      await page.getByRole('button', { name: /GLM 5\.3 Flash/ }).first().click()

      await page.getByRole('main').getByRole('button', { name: 'Plugins' }).first().click()
      const toggle = page.getByTestId('plugins-create-switch')
      await expect(toggle).toBeVisible()
      const row = toggle.locator('xpath=..')
      const mark = row.locator('.lu-beta')
      await expect(mark).toHaveCount(1)
      await holds(mark, NOTE.create)
      // Right of the name, left of the switch, and the switch is not pushed out of the menu.
      const name = (await row.getByText('Create', { exact: true }).boundingBox())!
      const box = (await mark.boundingBox())!
      const sw = (await toggle.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(name.x + name.width)
      expect(box.x + box.width).toBeLessThanOrEqual(sw.x)
      const sheet = (await row.locator('xpath=../..').boundingBox())!
      expect(sw.x + sw.width).toBeLessThanOrEqual(sheet.x + sheet.width)
      await shot(page, `desktop-${tag}-6-create-switch`)
      await toggle.click()
      await page.keyboard.press('Escape')

      const composer = page.locator('textarea').first()
      await expect(composer).toBeEnabled({ timeout: 20_000 })
      // Nothing of it in or over the chat input.
      await expect(page.locator('form .lu-beta, [data-testid="chat-input"] .lu-beta')).toHaveCount(0)
      await composer.fill('make an image of a red fox in the snow')
      await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled({ timeout: 20_000 })
      await composer.press('Enter')
      const card = page.getByTestId('create-order').first()
      await expect(card.getByRole('button', { name: /^Start/ })).toBeVisible({ timeout: 30_000 })
      const line = card.getByTestId('create-order-beta')
      await expect(line).toContainText('Create in chat is new. Read the order before you start it.')
      await holds(line.locator('.lu-beta'), NOTE.create)
      await shot(page, `desktop-${tag}-7-create-order`)
      // The line belongs to the moment before the OK: declined, it is gone.
      await card.getByRole('button', { name: 'Not now' }).click()
      await expect(card.getByTestId('create-order-beta')).toHaveCount(0)
    })

    test(`direct models: one mark on the head of their group, none on the rows (${tag})`, async ({ page }) => {
      const direct = [
        { id: 'direct/gemma-4', name: 'Gemma 4 Unfiltered', native_name: 'Gemma 4 Uncensored' },
        { id: 'direct/glm-4.7-flash-heretic', name: 'GLM 4.7 Flash Heretic' },
        { id: 'direct/aion-3.0', name: 'Aion 3.0' },
      ]
      const base = mockModelsAnswer()
      const listing = {
        ...base,
        data: [
          ...base.data,
          ...direct.map((m) => ({
            id: m.id, object: 'model', owned_by: 'lu-labs', name: m.name,
            ...(m.native_name ? { native_name: m.native_name } : {}),
            context_length: 128000, max_output_length: 8192, input_modalities: ['text'], think: 'never',
            supports_tools: true, unrestricted: true,
            credit_rates: { input_per_million: 11080, output_per_million: 34091 },
          })),
        ],
      }
      await page.setViewportSize({ width, height })
      await page.addInitScript(tauriMockInit, MOCK)
      await seedOnboardingDone(page)
      await routeCloud(page, { license: 'active', access: true, mediaLive: true, paidPlan: true })
      await page.route('**/api/inference/v1/models', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(listing) }))
      await page.goto('/')
      await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
      await signInViaGate(page)
      await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
      await setTheme(page, theme)
      await page.getByRole('button', { name: 'Select chat model', exact: true }).click()
      const menu = page.getByTestId('model-picker-menu')
      await expect(menu).toBeVisible()
      await expect.poll(() => menu.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
      const head = menu.locator('.lu-picker-head[data-family="Uncensored"]')
      await expect(head).toBeVisible()
      await holds(head.locator('.lu-beta'), NOTE.direct)
      // One mark in the whole list: the other heads and every row stay as they were.
      await expect(menu.locator('.lu-beta')).toHaveCount(1)
      await expect(menu.getByRole('option').locator('.lu-beta')).toHaveCount(0)
      await shot(page, `desktop-${tag}-8-direct-models-picker`)
    })
  }
}
