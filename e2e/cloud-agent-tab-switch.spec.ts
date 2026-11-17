import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME, DEFAULT_ASSISTANT_REPLY } from './support/tauri-mock'
import { seedOnboardingDone, routeCloud, signInViaGate, cloudSwitch } from './support/cloud-mock'
import { expectWorkspaceAsk, answerWorkspaceAsk } from './support/ui'

/**
 * Customer case 30.09.2026, second mail, the customer's own
 * setup: LU Cloud model, desktop app, a run in progress, a trip to Settings.
 * "task is stopped and start from begining again". Same checks as the
 * built-in engine spec in coding-agent.spec.ts, over the cloud transport.
 */
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' }

async function bootCloud(page: Page, bodies: string[], stepMs: number, failAt = -1, files: Record<string, string> = {}, autoCompact = true) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, files })
  await seedOnboardingDone(page)
  if (!autoCompact) {
    await page.addInitScript(() => {
      const raw = window.localStorage.getItem('chat-settings')
      const env = raw ? JSON.parse(raw) : { state: { settings: {} }, version: 10 }
      env.state.settings = { ...env.state.settings, autoCompact: false }
      window.localStorage.setItem('chat-settings', JSON.stringify(env))
    })
  }
  await page.addInitScript(() => {
    window.localStorage.setItem('locally-uncensored-permissions', JSON.stringify({
      state: {
        globalPermissions: { filesystem: 'auto', terminal: 'auto', desktop: 'auto', web: 'auto', system: 'auto', image: 'auto', video: 'auto', workflow: 'auto' },
        conversationOverrides: {}, perToolOverrides: {}, modeScope: 'agent',
      },
      version: 2,
    }))
  })
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, paidPlan: true })
  await page.route('**/api/inference/v1/models', (route) => route.fulfill({
    status: 200, headers: cors, contentType: 'application/json',
    body: JSON.stringify({ object: 'list', data: [{
      id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6', context_length: 262144, supports_tools: true, think: 'never',
    }] }),
  }))
  let n = 0
  await page.route('**/api/inference/v1/chat/completions', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    bodies.push(route.request().postData() ?? '')
    const i = n++
    await new Promise((r) => setTimeout(r, stepMs))
    // The line drops mid-run, the way the 60 s idle cut ended the customer's runs.
    if (i === failAt) return route.abort('connectionreset').catch(() => {})
    const call = { index: 0, id: `c${i}`, type: 'function', function: { name: 'file_read', arguments: JSON.stringify({ path: `src/file-${i}.ts` }) } }
    const sse = [
      { choices: [{ index: 0, delta: { role: 'assistant', content: `step ${i + 1}` }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ].map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
    return route.fulfill({ status: 200, headers: cors, contentType: 'text/event-stream', body: sse }).catch(() => {})
  })
  await page.goto('/')
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked()
}

async function pickKimi(page: Page) {
  await page.getByRole('button', { name: 'Select chat model', exact: true }).click()
  await page.getByRole('button', { name: /Kimi K2\.6/ }).first().click()
}

for (const mode of ['code', 'agent'] as const) {
  test(`cloud ${mode}: a trip to Settings neither stops nor restarts the run`, async ({ page }) => {
    const bodies: string[] = []
    await bootCloud(page, bodies, 400)
    // The model first, in the chat view: it is global, the Code tab then
    // opens with it.
    await page.getByRole('button', { name: /New Chat/i }).first().click()
    await pickKimi(page)
    if (mode === 'code') {
      await page.getByRole('button', { name: 'Code', exact: true }).click()
      await expect(async () => {
        await page.getByRole('button', { name: /New Chat/i }).first().click()
        await expect(page.locator('textarea').first()).toBeVisible({ timeout: 2_000 })
      }).toPass({ timeout: 30_000 })
    }
    if (mode === 'agent') {
      const toggle = page.getByRole('main').getByRole('button', { name: 'Agent', exact: true })
      // The toggle needs a conversation; the model pick may have reset it.
      await expect(async () => {
        if (!(await toggle.isVisible().catch(() => false))) {
          await page.getByRole('button', { name: /New Chat/i }).first().click()
        }
        await expect(toggle).toBeVisible({ timeout: 2_000 })
      }).toPass({ timeout: 30_000 })
      await toggle.click()
      expectWorkspaceAsk(page)
      await expect(toggle).toHaveAttribute('title', /Agent Mode is on/i, { timeout: 10_000 })
    }
    const composer = page.locator('textarea').first()
    await expect(composer).toBeEnabled({ timeout: 20_000 })
    await composer.fill('walk the whole source tree')
    await composer.press('Enter')
    await answerWorkspaceAsk(page)
    await expect.poll(() => bodies.length, { timeout: 20_000 }).toBeGreaterThan(2)

    const header = page.getByRole('banner')
    const before = bodies.length
    await header.getByRole('button', { name: 'Settings' }).click()
    await page.waitForTimeout(3_000)
    const whileAway = bodies.length
    await header.getByRole('button', { name: 'Chat' }).click()

    expect(whileAway, 'the run stopped while Settings was open').toBeGreaterThan(before)
    await expect(page.getByRole('button', { name: /Stop/i })).toBeVisible({ timeout: 20_000 })
    const back = bodies.length
    await expect.poll(() => bodies.length, { timeout: 20_000 }).toBeGreaterThan(back)

    const last = JSON.parse(bodies[bodies.length - 1])
    expect(JSON.stringify(last.messages)).toContain('src/file-0.ts')
    const asks = (last.messages as Array<{ role: string; content: unknown }>)
      .filter((m) => m.role === 'user' && JSON.stringify(m.content).includes('walk the whole source tree'))
    expect(asks.length).toBe(1)
    await page.getByRole('button', { name: /Stop/i }).click()
  })
}

for (const mode of ['code', 'agent'] as const) {
  test(`cloud ${mode}: after a dropped run, "continue" picks up where it was`, async ({ page }) => {
    const bodies: string[] = []
    await bootCloud(page, bodies, 150, 4)
    await page.getByRole('button', { name: /New Chat/i }).first().click()
    await pickKimi(page)
    if (mode === 'code') {
      await page.getByRole('button', { name: 'Code', exact: true }).click()
      await expect(async () => {
        await page.getByRole('button', { name: /New Chat/i }).first().click()
        await expect(page.locator('textarea').first()).toBeVisible({ timeout: 2_000 })
      }).toPass({ timeout: 30_000 })
    } else {
      const toggle = page.getByRole('main').getByRole('button', { name: 'Agent', exact: true })
      await expect(async () => {
        if (!(await toggle.isVisible().catch(() => false))) {
          await page.getByRole('button', { name: /New Chat/i }).first().click()
        }
        await expect(toggle).toBeVisible({ timeout: 2_000 })
      }).toPass({ timeout: 30_000 })
      await toggle.click()
      expectWorkspaceAsk(page)
      await expect(toggle).toHaveAttribute('title', /Agent Mode is on/i, { timeout: 10_000 })
    }
    const composer = page.locator('textarea').first()
    await expect(composer).toBeEnabled({ timeout: 20_000 })
    await composer.fill('walk the whole source tree')
    await composer.press('Enter')
    await answerWorkspaceAsk(page)

    // The run dies on the fifth request and hands the composer back.
    await expect.poll(() => bodies.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(5)
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 90_000 })
    const beforeContinue = bodies.length

    await composer.fill('continue')
    await composer.press('Enter')
    await expect.poll(() => bodies.length, { timeout: 30_000 }).toBeGreaterThan(beforeContinue)

    // The first request of the new run still knows the steps already done:
    // either the calls themselves, or the run ledger once the kept chain was
    // capped (a long run keeps its last 30 steps and a ledger for the rest).
    const first = JSON.stringify(JSON.parse(bodies[beforeContinue]).messages)
    const doneSteps = beforeContinue - 1
    if (doneSteps > 30) {
      expect(first, '"continue" lost the earlier steps without a ledger').toContain('[Run ledger]')
      expect(first).toMatch(/older steps/)
    } else {
      for (const done of ['src/file-0.ts', 'src/file-1.ts', 'src/file-2.ts', 'src/file-3.ts']) {
        expect(first, `"continue" lost ${done}`).toContain(done)
      }
    }
    const stop = page.getByRole('button', { name: /Stop/i })
    if (await stop.isVisible().catch(() => false)) await stop.click()
  })
}

test('cloud code: a long run that outgrew its window keeps a ledger for "continue"', async ({ page }) => {
  const bodies: string[] = []
  // 45 files of about 1.5k tokens each: the run passes the 32K send window and
  // gets trimmed long before the line drops on request 46.
  //
  // Auto-compact off: this pins the mechanical trim and its ledger, the
  // safety net under the summary. The mock answers every request with a
  // tool call, the summary request too, and counts requests in order.
  const files: Record<string, string> = {}
  for (let i = 0; i < 60; i++) files[`file-${i}.ts`] = `// file ${i}\n` + 'const x = 1\n'.repeat(500)
  await bootCloud(page, bodies, 60, 45, files, false)
  await page.getByRole('button', { name: /New Chat/i }).first().click()
  await pickKimi(page)
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await expect(async () => {
    await page.getByRole('button', { name: /New Chat/i }).first().click()
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  const composer = page.locator('textarea').first()
  await expect(composer).toBeEnabled({ timeout: 20_000 })
  await composer.fill('walk the whole source tree')
  await composer.press('Enter')
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 120_000 })
  expect(bodies.length).toBeGreaterThanOrEqual(46)
  // The run really was trimmed mid-way.
  expect(bodies.some((b) => b.includes('[Run ledger]'))).toBe(true)

  const beforeContinue = bodies.length
  await composer.fill('continue')
  await composer.press('Enter')
  await expect.poll(() => bodies.length, { timeout: 30_000 }).toBeGreaterThan(beforeContinue)
  const first = JSON.stringify(JSON.parse(bodies[beforeContinue]).messages)
  expect(first, 'the persisted chain lost the ledger').toContain('[Run ledger]')
  expect(first).toContain('src/file-0.ts')
  // The newest steps are there as real calls, not only as ledger lines.
  const calls = (JSON.parse(bodies[beforeContinue]).messages as Array<{ tool_calls?: Array<{ function: { arguments: string } }> }>)
    .flatMap((m) => m.tool_calls ?? []).map((c) => c.function.arguments)
  expect(calls.some((a) => a.includes('src/file-44.ts'))).toBe(true)
  const stop = page.getByRole('button', { name: /Stop/i })
  if (await stop.isVisible().catch(() => false)) await stop.click()
})
