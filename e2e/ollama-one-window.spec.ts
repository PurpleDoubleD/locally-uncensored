import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { expectWorkspaceAsk, answerWorkspaceAsk } from './support/ui'

/**
 * One Ollama model, one context window, and what a too large one costs.
 *
 * Ollama loads a model again for every request that names another num_ctx
 * than the one it is loaded with. The app now has one source for that number
 * (src/api/ollama.ts `ollamaNumCtx`), and this spec reads what really leaves
 * the app against an Ollama that is a stand-in: the load from the picker, the
 * chat turn, the reload from the context menu and the turn after it.
 *
 * The second half is the note about a model that does not sit in graphics
 * memory entirely. It is what Ollama's /api/ps reports after a load, shown
 * where the window is set and on the model's row, and nowhere near the
 * composer.
 *
 * Run: LU_E2E_PORT=5403 npx playwright test e2e/ollama-one-window.spec.ts
 */

const MODEL = 'big-model:27b'
const OTHER = 'other-model:9b'
const GB = 1024 * 1024 * 1024

type OllamaOptions = Pick<TauriMockOptions, 'ollamaLoaded' | 'ollamaPs' | 'ollamaContextLength'>

async function boot(page: Page, ollama: OllamaOptions) {
  const opts: TauriMockOptions = {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
    platform: 'windows',
    ollamaModels: [OTHER, MODEL],
    ollamaContextLength: 131072,
    ...ollama,
  }
  await page.addInitScript(tauriMockInit, opts)
  await seedOnboardingDone(page)
  await page.goto('/')
}

const pickerTrigger = (page: Page) => page.getByRole('button', { name: 'Select chat model', exact: true })
const pickerMenu = (page: Page) => page.getByTestId('model-picker-menu')
const row = (page: Page, name: string) => pickerMenu(page).getByRole('button').filter({ hasText: name }).filter({ has: page.getByTestId('load-toggle') })
const toggle = (page: Page, name: string) => row(page, name).getByTestId('load-toggle')
const contextButton = (page: Page) => page.getByRole('button', { name: 'Context window' })
const composer = (page: Page) => page.locator('textarea').first()

async function openPicker(page: Page) {
  await expect(pickerTrigger(page)).toBeVisible({ timeout: 30_000 })
  await pickerTrigger(page).click()
  await expect(pickerMenu(page)).toBeVisible()
  await expect(toggle(page, MODEL)).toBeVisible()
}

async function pick(page: Page, name: string) {
  await openPicker(page)
  await row(page, name).click()
  await expect(pickerTrigger(page)).toContainText(name.split(':')[0])
}

async function say(page: Page, text: string, turn: number, answersOnScreen = turn) {
  // A send in the half second in which the turn before it is still being
  // closed keeps the text in the composer. So: send until it has left.
  await expect(async () => {
    if ((await composer(page).inputValue()) !== text) await composer(page).fill(text)
    await page.getByRole('button', { name: /Send message/i }).click()
    await expect(composer(page)).toHaveValue('', { timeout: 1_000 })
  }).toPass({ timeout: 20_000 })
  await answerWorkspaceAsk(page)
  await expect.poll(async () => (await chatWindows(page)).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(turn)
  await expect(page.getByText(DEFAULT_ASSISTANT_REPLY)).toHaveCount(answersOnScreen, { timeout: 20_000 })
}

interface OllamaBody { model?: string; keep_alive?: unknown; options?: { num_ctx?: number } }
const bodies = (page: Page, key: '__E2E_OLLAMA_CHAT__' | '__E2E_OLLAMA_GENERATE__') =>
  page.evaluate((k) => ((window as unknown as Record<string, OllamaBody[] | undefined>)[k] ?? []), key)
/** The num_ctx of every chat request that went to the model, in order. */
const chatWindows = async (page: Page) => (await bodies(page, '__E2E_OLLAMA_CHAT__')).filter((b) => b.model === MODEL).map((b) => b.options?.num_ctx)
/** The num_ctx of every load of the model (an unload carries none and is left out). */
const loadWindows = async (page: Page) => (await bodies(page, '__E2E_OLLAMA_GENERATE__')).filter((b) => b.model === MODEL && b.keep_alive !== 0).map((b) => b.options?.num_ctx)

test('the load from the picker, the chat turn and the turn after a change of the window all name one window', async ({ page }) => {
  await boot(page, { ollamaLoaded: [] })
  await pick(page, MODEL)

  // Load it with its switch, as a person does before the first message.
  await openPicker(page)
  await toggle(page, MODEL).click()
  await expect(toggle(page, MODEL)).toHaveAttribute('data-state', 'on')
  await page.keyboard.press('Escape')
  await expect(pickerMenu(page)).toHaveCount(0)

  // A model trained on 131072 tokens runs a chat in 16384, and the counter
  // in the session strip divides by the same number.
  await say(page, 'Hello', 1)
  expect(await loadWindows(page)).toEqual([16384])
  expect(await chatWindows(page)).toEqual([16384])
  await expect(contextButton(page)).toHaveText(/\/16(\.4)?[kK]/)

  // A second turn: still the same window, no other number anywhere.
  await say(page, 'And again', 2)
  expect(new Set(await chatWindows(page))).toEqual(new Set([16384]))

  // Change the window where it is set. The model is loaded again once, with
  // the new window, and the next turn names exactly that one.
  await contextButton(page).click()
  await page.getByRole('button', { name: '32K', exact: true }).click()
  await expect.poll(() => loadWindows(page)).toEqual([16384, 32768])
  await page.keyboard.press('Escape')
  const before = (await chatWindows(page)).length
  await say(page, 'After the change', before + 1)
  expect((await chatWindows(page)).slice(before)).toEqual((await chatWindows(page)).slice(before).map(() => 32768))

  // Nothing ever went to this model without a window.
  expect([...(await loadWindows(page)), ...(await chatWindows(page))]).not.toContain(undefined)
})

test('a model that runs partly on the CPU says so where the window is set and on its row, not at the composer', async ({ page }) => {
  // What `ollama ps` showed for a 14B at 32768 on a 12 GB card: 34%/66% CPU/GPU.
  await boot(page, { ollamaLoaded: [MODEL], ollamaPs: { [MODEL]: { size: 15 * GB, size_vram: Math.round(9.9 * GB) } } })
  await pick(page, MODEL)
  // The session strip, where the window is set, belongs to a conversation.
  await say(page, 'Hello', 1)

  // Closed, nothing is said anywhere.
  await expect(page.getByTestId('context-cpu-note')).toHaveCount(0)

  // In the list of the context window, below the choices.
  await contextButton(page).click()
  const note = page.getByTestId('context-cpu-note')
  await expect(note).toHaveText('Loaded now with this window: 15 GB, 34% of it on the CPU, so answers are slower. A smaller context window needs less memory.')
  // The note is part of the opened list: it lives inside the control, and
  // it leaves with the list.
  await expect(contextButton(page).locator('xpath=..').getByTestId('context-cpu-note')).toHaveCount(1)
  await expect(composer(page)).toHaveValue('')
  // Not in the composer, and not in the band above it.
  await expect(page.locator('form, [data-testid="chat-composer"]').getByTestId('context-cpu-note')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(note).toHaveCount(0)

  // On the row of the model in the picker, next to its switch.
  await openPicker(page)
  await expect(row(page, MODEL).getByTestId('ollama-on-cpu')).toHaveText('34% on the CPU')
  await expect(row(page, MODEL).getByTestId('ollama-on-cpu')).toHaveAttribute('title', /Ollama reports 15 GB for this model as it is loaded now, and 9\.9 GB of that in graphics memory\./)
  await expect(row(page, OTHER).getByTestId('ollama-on-cpu')).toHaveCount(0)
})

test('control: a model that sits in graphics memory entirely gets no note, and one that is not loaded gets none either', async ({ page }) => {
  await boot(page, { ollamaLoaded: [MODEL], ollamaPs: { [MODEL]: { size: 12 * GB, size_vram: 12 * GB } } })
  await pick(page, MODEL)
  await say(page, 'Hello', 1)

  await contextButton(page).click()
  await expect(page.getByText('Reloads the model on change.')).toBeVisible()
  await expect(page.getByTestId('context-cpu-note')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await openPicker(page)
  await expect(toggle(page, MODEL)).toHaveAttribute('data-state', 'on')
  await expect(pickerMenu(page).getByTestId('ollama-on-cpu')).toHaveCount(0)
})

test('Agent mode runs the same model in its agent window, and the counter divides by what is sent', async ({ page }) => {
  await boot(page, { ollamaLoaded: [] })
  await pick(page, MODEL)
  await say(page, 'Hello', 1)
  expect(await chatWindows(page)).toEqual([16384])
  await expect(contextButton(page)).toHaveText(/\/16(\.4)?[kK]/)

  // The one reload that is left, and it is a choice: a turn with the tool
  // catalogue needs more room than a chat (lib/context-window.ts). Agent
  // mode starts its own conversation.
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  await page.getByRole('button', { name: 'New Agent Chat' }).click()
  // The first message of the agent chat asks where to work (3.1.2); `say` answers Sandbox.
  expectWorkspaceAsk(page)
  // Before the first word: the strip already shows the window of this surface.
  await expect(contextButton(page)).toHaveText(/ctx 32K/)
  const before = (await chatWindows(page)).length
  await say(page, 'Say hello', before + 1, 1)
  const agentTurn = (await chatWindows(page)).slice(before)
  expect(agentTurn.length).toBeGreaterThan(0)
  expect(new Set(agentTurn)).toEqual(new Set([32768]))
  await expect(contextButton(page)).toHaveText(/\/32(\.8)?[kK]/)
})
