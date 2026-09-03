import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * The app ships in English. On 2026-09-02 one settings panel did not: the whole
 * local-API surface — labels, buttons, hints, error text — was German, and it
 * had shipped that way through 8,671 green tests. None of them could have seen
 * it: `vitest.config.ts` runs `environment: 'node'`, so of 146 .tsx files not
 * one is ever rendered, and no spec in `e2e/` had ever opened the settings
 * page at all. A human found it by looking at the screen.
 *
 * This is the ratchet for that class of bug: walk every top-level view and
 * every settings section in a real browser and read what is actually on screen.
 *
 * Two signals, deliberately different in kind:
 *   - any umlaut or ß in rendered UI text. Near-zero false alarm in an English
 *     product, and it catches German nobody thought to list.
 *   - a short list of umlaut-free German words that this app plausibly shows.
 *
 * A guard that cries wolf on correct code gets switched off, so both signals
 * skip what is legitimately not our prose: model ids and repo names, code and
 * preformatted blocks, and anything the user or a model typed.
 */

const GERMAN_WORDS =
  /\b(Speichern|Abbrechen|Einstellungen|Fehler|Entfernen|Starten|Anhalten|Beenden|Verbindung|Sicherheit|Adresse|Kopieren|Erlaubte|Erlaubt|Aktiviert|Deaktiviert|Anfragen|Werkzeuge|Modelle|Nachricht|Einträge|Nicht verfügbar|Keine)\b/

/** Text that is data, not our prose. */
const NOT_OUR_PROSE = /^[\w.-]+\/[\w.-]+|GGUF|\.gguf|^https?:|^[A-Za-z0-9_-]+:[A-Za-z0-9._-]+$/

async function germanOnScreen(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ words, data }) => {
      const wordRe = new RegExp(words)
      const dataRe = new RegExp(data)
      const hits: string[] = []
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        if (el.children.length !== 0) continue
        if (el.closest('code, pre, textarea, [data-testid="message-content"]')) continue
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        const t = (el.textContent || '').trim()
        if (!t || dataRe.test(t)) continue
        if (/[äöüÄÖÜß]/.test(t) || wordRe.test(t)) hits.push(t.slice(0, 120))
      }
      return hits
    },
    { words: GERMAN_WORDS.source, data: NOT_OUR_PROSE.source },
  )
}

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()
}

const VIEWS = ['Chat', 'Create', 'Compare', 'Benchmark', 'Models', 'Settings']

test('no German reaches the screen in any top-level view', async ({ page }) => {
  await boot(page)
  for (const view of VIEWS) {
    await page.getByRole('button', { name: view, exact: true }).first().click()
    await page.waitForTimeout(600)
    expect(await germanOnScreen(page), `German text in the ${view} view`).toEqual([])
  }
})

const TABS = ['General', 'AI Backends', 'Agent', 'Voice & Remote']

/**
 * Open every collapsed section on the current tab. Driven by `aria-expanded`,
 * so an already-open section is never clicked shut — a blind "click them all"
 * pass closes as many panels as it opens and the walk misses half the screen.
 */
async function openEverySection(page: Page) {
  for (let round = 0; round < 12; round++) {
    // Visible, and inside the settings body: the header carries a hidden
    // menu button with the same attribute, and waiting for it to become
    // clickable is a thirty-second way to learn nothing.
    const collapsed = page.locator('main button[aria-expanded="false"]:visible')
    const n = await collapsed.count()
    if (n === 0) return
    await collapsed.first().click()
    await page.waitForTimeout(220)
  }
  throw new Error('sections kept appearing after 12 rounds — the walk is not converging')
}

test('no German reaches the screen in any settings section', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: 'Settings' }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings' }).first()).toBeVisible()

  for (const tab of TABS) {
    await page.getByRole('button', { name: tab, exact: true }).first().click()
    await page.waitForTimeout(400)
    await openEverySection(page)
    expect(await germanOnScreen(page), `German text on the "${tab}" settings tab`).toEqual([])
  }
})

test('the settings walk really reaches the Local API panel', async ({ page }) => {
  // The guard above is only worth its runtime if it passes over the panel that
  // shipped in German. This pins that it does — without it, a future layout
  // change could quietly move the panel out of the walk and leave two green
  // tests guarding an empty room.
  await boot(page)
  await page.getByRole('button', { name: 'Settings' }).first().click()
  await page.getByRole('button', { name: 'Voice & Remote', exact: true }).first().click()
  await page.waitForTimeout(400)
  await openEverySection(page)
  await expect(page.getByText('Local API', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
})
