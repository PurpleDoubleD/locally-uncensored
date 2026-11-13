/**
 * Runs the fixed bench tasks (tasks.ts) through the real Agent and Code tabs
 * and writes one JSON row per run. See playwright.agent-live.config.ts.
 */
import { test, expect, type Page } from '@playwright/test'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { seedOnboardingDone } from '../support/cloud-mock'
import { appModules, type AppWindow } from '../support/ui'
import { TASKS, type BenchTask } from './tasks'

const HOME = process.env.LU_BENCH_HOME!
const OUT = process.env.LU_BENCH_OUT || join(HOME, 'out')
const LABEL = process.env.LU_BENCH_LABEL || 'run'
const MODELS = (process.env.LU_BENCH_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean)
const WANTED = (process.env.LU_BENCH_TASKS || '').split(',').map((s) => s.trim()).filter(Boolean)
const RUNS = Number(process.env.LU_BENCH_RUNS) || 1
const RUN_MS = Number(process.env.LU_BENCH_RUN_MS) || 10 * 60_000
/** Cloud mode: the picker lists LU Cloud models. Needs a signed-in session. */
const CLOUD = process.env.LU_BENCH_CLOUD === '1'
/** CA: LU's own engine (the bundled llama-server, same binary and flags) run as
 *  a test instance on its own port, e.g. http://127.0.0.1:18731/v1. The app
 *  reaches it through the same OpenAI-compatible slot the built-in engine
 *  uses; only the lifecycle is outside the app. Ollama stays off. */
const ENGINE_URL = process.env.LU_BENCH_ENGINE_URL || ''

const STORES = [
  '/src/stores/chatStore.ts',
  '/src/stores/settingsStore.ts',
  '/src/stores/permissionStore.ts',
  '/src/stores/agentModeStore.ts',
  '/src/stores/codexStore.ts',
  '/src/stores/toolAuditStore.ts',
  '/src/stores/generationStore.ts',
  '/src/stores/providerStore.ts',
]

const tasks = TASKS.filter((t) => !WANTED.length || WANTED.includes(t.id))

async function boot(page: Page) {
  await seedOnboardingDone(page)
  await page.goto('/')
  await appModules(page, STORES)
  // No approval cards: the bench measures the model and the loop, not a user.
  await page.evaluate(() => {
    const A = (window as unknown as AppWindow).__APP__
    const perm = A['/src/stores/permissionStore.ts'].usePermissionStore.getState()
    for (const cat of ['filesystem', 'terminal', 'system', 'web', 'desktop', 'image', 'video', 'workflow', 'mcp']) {
      perm.setGlobalPermission(cat, 'auto')
    }
    // Memory extraction writes into the profile between runs; each run is a
    // fresh context anyway, but keep the background model calls out of the
    // measured time.
    A['/src/stores/settingsStore.ts'].useSettingsStore.getState().updateSettings({ codexDefaultMode: 'bypass' })
  })
  if (ENGINE_URL) {
    await page.evaluate((url) => {
      const A = (window as unknown as AppWindow).__APP__
      const prov = A['/src/stores/providerStore.ts'].useProviderStore.getState()
      prov.setProviderConfig('openai', { enabled: true, baseUrl: url, managed: false })
      prov.setProviderConfig('ollama', { enabled: false })
    }, ENGINE_URL)
    // The picker reads the providers when it loads its list.
    await page.reload()
    await appModules(page, STORES)
  }
}

async function pickModel(page: Page, label: string) {
  const picker = page.getByRole('button', { name: 'Select chat model', exact: true })
  await expect(picker).toBeVisible({ timeout: 60_000 })
  await picker.click()
  await page.getByTestId('model-picker-menu').getByRole('button', { name: new RegExp(label, 'i') }).first().click()
}

/** Opens a conversation in the task's tab and returns its id. */
async function openConversation(page: Page, task: BenchTask, model: string, ws: string): Promise<string> {
  if (task.tab === 'code') {
    const side = page.getByRole('button', { name: 'Toggle sidebar' })
    await side.click()
    await page.locator('aside').getByRole('button', { name: /^Code/ }).first().click()
    await pickModel(page, model)
    await expect(async () => {
      await page.getByRole('button', { name: /New Chat/i }).first().click()
      await expect(page.getByText('No code chats yet.')).toBeHidden({ timeout: 1_000 })
    }).toPass({ timeout: 30_000 })
    await side.click()
  } else {
    await pickModel(page, model)
    await expect(async () => {
      await page.getByRole('button', { name: /New Chat/i }).first().click()
      await expect(page.locator('textarea').first()).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 30_000 })
  }
  const convId = await page.evaluate(() =>
    (window as unknown as AppWindow).__APP__['/src/stores/chatStore.ts'].useChatStore.getState().activeConversationId as string,
  )
  expect(convId).toBeTruthy()
  await page.evaluate(({ convId, ws, tab, mode }) => {
    const A = (window as unknown as AppWindow).__APP__
    if (tab === 'agent') {
      const am = A['/src/stores/agentModeStore.ts'].useAgentModeStore.getState()
      am.setWorkspace(convId, { kind: 'folder', path: ws })
      am.setAgentModeActive(convId, true)
    } else {
      const cx = A['/src/stores/codexStore.ts'].useCodexStore.getState()
      cx.setWorkingDirectory(ws)
      cx.syncThreadWorkingDirectory?.(convId)
      cx.chooseCodexMode(convId, mode, false)
    }
  }, { convId, ws, tab: task.tab, mode: task.codeMode ?? 'bypass' })
  return convId
}

/** Earlier chats and skills for A7/A8 tasks. A build without a skill store
 *  (the before state) just does not get the skills. */
async function seedApp(page: Page, task: BenchTask) {
  if (!task.seed) return
  await page.evaluate(async (sd) => {
    const A = (window as unknown as AppWindow).__APP__
    const chat = A['/src/stores/chatStore.ts'].useChatStore
    const now = Date.now()
    const convs = (sd.conversations ?? []).map((c, i) => {
      const at = now - c.daysAgo * 86_400_000
      return {
        id: `seed-${i}-${at}`, title: c.title, model: 'seed', systemPrompt: '', mode: 'lu', createdAt: at, updatedAt: at,
        messages: c.messages.map((m, j) => ({ id: `seed-${i}-${j}`, role: m.role, content: m.content, timestamp: at + j * 1000 })),
      }
    })
    if (convs.length) chat.setState((st: { conversations: unknown[] }) => ({ conversations: [...convs, ...st.conversations] }))
    if (sd.skills?.length) {
      try {
        const path = '/src/stores/skillStore.ts'
        const mod = await import(/* @vite-ignore */ path)
        for (const sk of sd.skills) mod.useSkillStore.getState().addSkill({ ...sk, status: 'active' })
      } catch { /* no skills in this build */ }
    }
  }, task.seed)
}

/** Sends each prelude message in a conversation of its own and waits for it. */
async function runPrelude(page: Page, task: BenchTask, model: string, ws: string) {
  if (!task.prelude?.length) return
  const convId = await openConversation(page, task, model, ws)
  for (const text of task.prelude) {
    const box = page.locator('textarea').first()
    await box.fill(text)
    await box.press('Enter')
    await waitForRun(page, convId)
  }
  // The automatic memory extraction runs after the turn, in the background.
  await page.waitForTimeout(15_000)
}

function seed(ws: string, files: Record<string, string>) {
  rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(ws, p)), { recursive: true })
    writeFileSync(join(ws, p), content)
  }
}

/** Waits until the run has started and then stayed idle for a few seconds. */
async function waitForRun(page: Page, convId: string): Promise<'done' | 'timeout'> {
  const started = Date.now()
  let seenBusy = false
  let idleSince = 0
  while (Date.now() - started < RUN_MS) {
    const busy = await page.evaluate((id) => {
      const A = (window as unknown as AppWindow).__APP__
      const g = A['/src/stores/generationStore.ts'].useGenerationStore.getState()
      return !!g.generating?.[id]
    }, convId)
    if (busy) { seenBusy = true; idleSince = 0 } else if (seenBusy) {
      idleSince ||= Date.now()
      if (Date.now() - idleSince > 4_000) return 'done'
    } else if (Date.now() - started > 60_000) {
      return 'done' // never started: recorded as an empty run
    }
    await page.waitForTimeout(1_000)
  }
  const stop = page.getByRole('button', { name: /^Stop/i }).first()
  if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => {})
  await page.waitForTimeout(3_000)
  return 'timeout'
}

interface Facts {
  answer: string
  toolCalls: Array<{ name: string; args: unknown; status: string; result?: string }>
  reflections: string[]
  usage: unknown
  errors: string[]
}

async function collect(page: Page, convId: string): Promise<Facts> {
  return page.evaluate((id) => {
    const A = (window as unknown as AppWindow).__APP__
    const conv = A['/src/stores/chatStore.ts'].useChatStore.getState().conversations.find((c: { id: string }) => c.id === id)
    const msgs = (conv?.messages ?? []) as Array<{ role: string; content: string; agentBlocks?: Array<{ phase: string; content: string; toolCalls?: Array<{ toolName: string; args: unknown; status: string }> }>; requestUsage?: unknown; error?: { kind: string; detail: string } }>
    const assistant = msgs.filter((m) => m.role === 'assistant')
    const blocks = assistant.flatMap((m) => m.agentBlocks ?? [])
    const audit = (A['/src/stores/toolAuditStore.ts'].useToolAuditStore.getState().entries[id] ?? []) as Array<{ toolName: string; args: unknown; status: string; resultPreview?: string; error?: string }>
    const fromBlocks = blocks.flatMap((b) => (b.toolCalls ?? []).map((c) => ({ name: c.toolName, args: c.args, status: c.status })))
    return {
      answer: assistant.map((m) => m.content).join('\n').trim(),
      toolCalls: (audit.length ? audit.map((e) => ({ name: e.toolName, args: e.args, status: e.status, result: String(e.resultPreview ?? e.error ?? '').slice(0, 240) })) : fromBlocks).filter((c) => c.name !== 'context_decay'),
      reflections: blocks.filter((b) => b.phase === 'reflection').map((b) => b.content.slice(0, 300)),
      usage: assistant.map((m) => m.requestUsage ?? null),
      errors: assistant.flatMap((m) => (m.error ? [`${m.error.kind}: ${m.error.detail}`] : [])),
    }
  }, convId)
}

mkdirSync(OUT, { recursive: true })

for (const model of MODELS) {
  for (const task of tasks) {
    for (let r = 1; r <= RUNS; r++) {
      test(`${LABEL} ${model} ${task.id} #${r}`, async ({ page }) => {
        test.skip(CLOUD, 'cloud runs need a signed-in profile, see the report')
        const runId = `${LABEL}-${task.id}-${r}-${Date.now()}`
        const ws = join(HOME, 'ws', runId)
        seed(ws, task.files)
        await boot(page)
        await seedApp(page, task)
        await runPrelude(page, task, model, ws)
        const convId = await openConversation(page, task, model, ws)
        const t0 = Date.now()
        const box = page.locator('textarea').first()
        await box.fill(task.prompt)
        await box.press('Enter')
        const end = await waitForRun(page, convId)
        const ms = Date.now() - t0
        const facts = await collect(page, convId)
        let check = { ok: false, detail: 'check crashed' }
        try { check = task.check(ws, facts.answer, { toolCalls: facts.toolCalls }) } catch (e) { check = { ok: false, detail: String(e) } }
        const failed = facts.toolCalls.filter((c) => /error|rejected|failed/.test(c.status)).length
        const row = {
          label: LABEL, model, task: task.id, tab: task.tab, run: r, end, ms,
          ok: check.ok, detail: check.detail,
          calls: facts.toolCalls.length, failedCalls: failed,
          tools: facts.toolCalls.map((c) => c.name),
          // What each call sent and got back, short: enough to see why a run went wrong.
          trace: facts.toolCalls.map((c) => ({ name: c.name, status: c.status, args: JSON.stringify(c.args ?? {}).slice(0, 240), result: c.result ?? '' })),
          planned: facts.toolCalls.some((c) => c.name === 'todo_write'),
          guardSteer: facts.reflections.filter((s) => /Loop guard steered/i.test(s)).length,
          guardHalt: facts.reflections.filter((s) => /Loop guard halted/i.test(s)).length + (/\(halted:/.test(facts.answer) ? 1 : 0),
          budgetHalt: /Agent halted/.test(facts.answer),
          unknownTool: facts.toolCalls.filter((c) => /unknown/i.test(c.status)).length,
          earlyStop: !check.ok && end === 'done' && !facts.errors.length,
          errors: facts.errors,
          usage: facts.usage,
          answer: facts.answer.slice(0, 1500),
          reflections: facts.reflections,
          ws,
        }
        appendFileSync(join(OUT, 'results.jsonl'), JSON.stringify(row) + '\n')
      })
    }
  }
}
