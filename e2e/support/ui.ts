import { expect, type Page } from '@playwright/test'

/**
 * Open a fresh conversation and wait for the composer to actually exist.
 *
 * Right after onboarding (or an appMode flip) the model list populates
 * asynchronously, and Sidebar.handleNewChat treats a click without an
 * active model as "nothing to chat with": local mode routes to the Models
 * page (the a user guard), cloud mode ignores the click. A real user just
 * clicks New Chat again once the list is in; this retry mirrors that user
 * instead of racing the fetch. The race never fires on a fast machine but
 * is near-deterministic on the slow Windows PW box, where the first click
 * always loses against the model-list round trip.
 */
export async function openNewChat(page: Page): Promise<void> {
  await expect(async () => {
    // Land back in the chat view first in case an earlier losing click
    // parked us on the Models page.
    const back = page.getByRole('button', { name: /Back to chat/i })
    if (await back.isVisible().catch(() => false)) await back.click()
    await page.getByRole('button', { name: /New Chat/i }).click()
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}

/**
 * Die Seitenleiste aufklappen, weil sie seit 2.6.8 zugeklappt startet.
 *
 * `uiStore.ts:158` setzt `sidebarOpen: false`. Auf v2.6.7 stand dort `true`,
 * und `setView` zog sie im Chat zusaetzlich immer wieder auf
 * (`sidebarOpen: view === 'chat'`). Beides ist bewusst gefallen, der Kommentar
 * im Store sagt es: "Navigation no longer touches sidebarOpen."
 *
 * Fuer den Kunden ist das ein Klick, fuer diese Specs war es ein Totalausfall:
 * die Gespraechsliste mit ihren Loeschknoepfen und ihren `option`-Rollen lebt
 * IN der Leiste, also fanden elf Faelle gar nichts mehr.
 *
 * Nachgemessen am 04.09.2026 im laufenden Chromium, frischer Zustand, nach dem
 * Onboarding und einem abgeschickten Satz:
 *   vorher   0 Knoepfe "Delete chat", 0 `option`-Rollen, 1 Knopf "Expand sidebar"
 *   nachher  1 Knopf "Delete chat", 1 `option`-Rolle, Leiste 288 px breit
 * Ein Klick. Die Funktion ist also nicht verschwunden, sie steht hinter einer
 * Handlung, die diese Specs bis heute nicht gemacht haben.
 *
 * Der Aufruf ist absichtlich vertraeglich: steht die Leiste schon offen, tut
 * er nichts. So bleibt er richtig, falls der Standard eines Tages zurueckkippt.
 */
export async function oeffneSeitenleiste(page: Page): Promise<void> {
  const auf = page.getByRole('button', { name: /Expand sidebar/i })
  if (await auf.count()) {
    await auf.first().click()
    // Auf die Liste warten, nicht auf eine Frist: die Leiste faehrt animiert
    // auf, und ein fester Schlaf waere auf der langsamen Box zu kurz.
    await expect(page.getByRole('button', { name: 'New Chat' }).first()).toBeVisible({ timeout: 10_000 })
  }
}

/**
 * Pick a chat model in the composer's picker, the way a user does.
 *
 * Needed in Cloud mode since 3.0.5: the app no longer picks a hosted chat
 * model by itself, so a spec that wants a conversation there names its model
 * first, exactly like a new account has to. "New Chat" without a picked model
 * stays on the landing page.
 */
export async function pickChatModel(page: Page, name: RegExp): Promise<void> {
  const picker = page.getByRole('button', { name: 'Select chat model', exact: true })
  await expect(picker).toBeVisible({ timeout: 20_000 })
  await picker.click()
  await page.getByTestId('model-picker-menu').getByRole('button', { name }).click()
  await expect(picker).toContainText(name)
}

/**
 * Load modules of the app into the page once, so a spec can call into them
 * without importing inside `page.evaluate`.
 *
 * `await import('/src/...')` inside an awaited `page.evaluate` holds a
 * promise across the DevTools protocol. Chromium sometimes drops it, and
 * Playwright reports any such protocol error as "Execution context was
 * destroyed, most likely because of a navigation", although the page never
 * navigated and the code in the page ran (seen on 08.10.2026 in about one
 * run in ten of voice-computer.spec.ts; the page still had its state and its
 * navigation entry said "navigate", not "reload").
 *
 * Here the page keeps the promise itself and the spec waits for the result.
 * Afterwards `window.__APP__[path]` is the module, in every evaluate, until
 * the page navigates or reloads: call it again after that.
 */
export async function appModules(page: Page, paths: string[]): Promise<void> {
  await page.evaluate((wanted) => {
    const w = window as unknown as { __APP__?: Record<string, unknown> }
    w.__APP__ ??= {}
    for (const path of wanted) void import(/* @vite-ignore */ path).then((module) => { w.__APP__![path] = module })
  }, paths)
  await page.waitForFunction((wanted) => {
    const loaded = (window as unknown as { __APP__?: Record<string, unknown> }).__APP__ ?? {}
    return wanted.every((path) => path in loaded)
  }, paths)
}

/** The page after `appModules`: `(window as unknown as AppWindow).__APP__[path]` is a loaded module. */
export type AppWindow = { __APP__: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Agent Mode asks for its workspace in the chat since 3.1.2.
 *
 * Switching Agent on opens no dialog any more. The FIRST message of an agent
 * chat without a workspace is parked in the thread under a card ("Where
 * should I work?", Sandbox / Folder…), and nothing goes to the model until
 * the card is answered. Then exactly that message is sent again.
 *
 * `expectWorkspaceAsk` marks the page right after Agent Mode was switched on
 * in a fresh chat; the spec's send helper then calls `answerWorkspaceAsk`
 * after every send. Only the first send after the mark waits for the card and
 * picks Sandbox (it touches nothing outside ~/agent-workspace); every later
 * send returns at once, so the mark costs nothing there.
 */
const workspaceAskPending = new WeakSet<Page>()

export function expectWorkspaceAsk(page: Page): void {
  workspaceAskPending.add(page)
}

export async function answerWorkspaceAsk(page: Page): Promise<void> {
  if (!workspaceAskPending.has(page)) return
  workspaceAskPending.delete(page)
  const sandbox = page.getByTestId('workspace-ask-sandbox')
  await expect(sandbox).toBeVisible({ timeout: 15_000 })
  await sandbox.click()
  await expect(page.getByTestId('workspace-ask')).toHaveCount(0, { timeout: 10_000 })
}
