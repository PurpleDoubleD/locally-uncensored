import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { openNewChat } from './support/ui'

/**
 * C77: an API model on a hosted OpenAI-compatible endpoint that reports no
 * context window. The context button offers the model window and says where
 * the number comes from. Screenshots go to LU_SHOTS_DIR when it is set.
 *
 * Real app in the browser with the Tauri bridge mocked; the hosted endpoint
 * is never asked (its window is not probed, LAN rule), so nothing leaves the
 * machine.
 */
const SHOTS = process.env.LU_SHOTS_DIR

/** A store module of the running app, loaded by its dev server path (same instance as the app's). */
type Store = { getState: () => any; setState: (u: unknown) => void } // eslint-disable-line @typescript-eslint/no-explicit-any
const PROVIDERS = '/src/stores/providerStore.ts'
const MODELS = '/src/stores/modelStore.ts'
const SETTINGS = '/src/stores/settingsStore.ts'

test('C77: the model window of an API model without metadata can be set, and its source is shown', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await page.goto('/')
  await page.getByRole('button', { name: /Get Started/i }).click()
  await page.getByRole('button', { name: /Continue/i }).click()
  await page.getByRole('button', { name: /Skip for now/i }).click()
  await page.getByRole('button', { name: /Qwen 2\.5 7B/i }).click()
  await page.getByRole('button', { name: /Install \d+ model/i }).click()
  await page.getByRole('button', { name: /Skip for now/i }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: /Get Started/i }).click()
  await openNewChat(page)

  // A hosted OpenAI-compatible endpoint as an extra entry, and its model picked.
  const model = await page.evaluate(async (path) => {
    const { useProviderStore } = (await import(/* @vite-ignore */ path)) as { useProviderStore: Store }
    const entry = useProviderStore.getState().addOpenAIEntry({ name: 'Some API', baseUrl: 'https://api.example-llm.test/v1', isLocal: false })
    return `openai:${entry}::vendor/brand-new-model-x`
  }, PROVIDERS)
  // The model list refreshes for the new entry (which lists nothing here) and
  // puts the picker back on a listed model; pick the API model after that.
  await page.waitForTimeout(4000)
  await page.evaluate(async ({ name, path }) => {
    const { useModelStore } = (await import(/* @vite-ignore */ path)) as { useModelStore: Store }
    const row = { name, model: 'vendor/brand-new-model-x', provider: 'openai', providerName: 'Some API', type: 'text', size: 0 }
    useModelStore.setState((st: { models: unknown[] }) => ({ models: [...st.models, row] }))
    useModelStore.getState().setActiveModel(name)
  }, { name: model, path: MODELS })
  expect(model).toContain('brand-new-model-x')
  const trigger = page.getByRole('button', { name: /^Context window/ })
  await expect(trigger).toBeVisible()
  await expect(page.getByText('brand-new-model-x').first()).toBeVisible()
  await expect(trigger).toHaveAttribute('title', /Model context window: 8K, estimated\./)
  await trigger.click()
  const section = page.getByTestId('context-model-window')
  await expect(section).toContainText("This API does not report the model's context window")
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/c77-1-vorher-8k-geschaetzt.png` })

  await section.getByRole('button', { name: /^128K/ }).click()
  await expect(trigger).toHaveAttribute('title', /Model context window: 128K, set by you\./)
  const stored = await page.evaluate(async (path) => {
    const { useSettingsStore } = (await import(/* @vite-ignore */ path)) as { useSettingsStore: Store }
    return useSettingsStore.getState().settings.contextWindowByModel as Record<string, number> | undefined
  }, SETTINGS)
  expect(Object.values(stored ?? {})).toContain(131072)
  await trigger.click()
  await expect(page.getByTestId('context-model-window')).toContainText('Now 128K, set by you.')
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/c77-2-nachher-128k-von-dir.png` })
})
