import { expect, type Page } from '@playwright/test'

/**
 * Open a fresh conversation and wait for the composer to actually exist.
 *
 * Right after onboarding (or an appMode flip) the model list populates
 * asynchronously, and Sidebar.handleNewChat treats a click without an
 * active model as "nothing to chat with": local mode routes to the Models
 * page (the mylogz guard), cloud mode ignores the click. A real user just
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
