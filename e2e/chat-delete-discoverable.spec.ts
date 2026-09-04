import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { openNewChat, oeffneSeitenleiste } from './support/ui'

/**
 * Deleting a chat has to be findable (sweenscapehub, Discord 2026-07-30):
 * "I have searched the whole app and right clicked the chats, checked github
 * readme faq — there doesn't seem to be a intuitive way to delete a chat".
 *
 * The button existed the whole time, at 10 px, unlabelled, and only while the
 * pointer sat on the row. Right-click, the gesture they tried first, did
 * nothing. So this spec pins the two ways out: the context menu, and hover
 * buttons that carry a name a human and a screen reader can both read.
 *
 * Run: npx playwright test e2e/chat-delete-discoverable.spec.ts
 */

/** Conversation rows in the sidebar, counted by their delete affordance. */
const rowCount = async (page: Page) => await page.getByRole('button', { name: 'Delete chat' }).count()

/**
 * Den Zeiger dorthin fahren, wo der Loeschknopf der ersten Zeile sitzt — auf
 * demselben Weg wie eine Hand, und ohne einen einzigen Klassenselektor.
 *
 * Warum das nicht mehr `locator.hover()` sein kann (D-S15, 287903aa): die
 * Aktionsleiste der Zeile hat ihren Layoutplatz abgegeben und liegt jetzt
 * `absolute` UEBER dem Datum. Damit der unsichtbare Kasten im Ruhezustand
 * nicht die Klicks der Zeile abfaengt, traegt er `pointer-events-none` und
 * bekommt Zeigerereignisse erst zurueck, wenn die ZEILE ueberfahren wird.
 * (Am Basisstand gab es diese Regel nicht — dort gewann die Leiste den
 * Hit-Test schon im Ruhezustand, weil `opacity: 0` Klicks weiterhin annimmt.
 * Genau diese Eigenschaft war der Fehler, den D-S15 weggenommen hat.)
 *
 * Playwrights `hover()` prueft VOR der Bewegung, ob das Ziel Zeigerereignisse
 * empfaengt — und im Ruhezustand tut es das nicht: Henne und Ei. Ein Mensch
 * hat das Problem nie, weil seine eine Bewegung beides tut: sie betritt die
 * Zeile UND landet auf dem Knopf. `mouse.move` prueft nichts, es bewegt nur,
 * und ist damit die getreue Nachbildung.
 *
 * Nachgemessen am laufenden Dev-Server (Chromium, 1280x720):
 *   ohne Bewegung  `elementFromPoint` in der Knopfmitte -> SPAN "Just now"
 *   nach EINER     `elementFromPoint` in der Knopfmitte -> das Trash-Icon
 * Eine Bewegung genuegt also; ein zweiter Anlauf ist nicht noetig.
 *
 * Rueckgabe: der Knopf, plus die Stelle, an der der Zeiger jetzt steht —
 * dort setzen die Rechtsklicks auf.
 */
async function pointerOnFirstRow(page: Page) {
  const del = page.getByRole('button', { name: 'Delete chat' }).first()
  const box = await del.boundingBox()
  if (!box) throw new Error('Die Zeile hat keinen Loeschknopf mit Ausdehnung')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  return { del, x, y }
}

async function bootWithTwoChats(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await page.goto('/')
  await page.getByRole('button', { name: /Get Started/i }).click()
  await page.getByRole('button', { name: /Continue/i }).click()
  await page.getByRole('button', { name: /Skip for now/i }).click()
  await expect(page.getByRole('heading', { name: /Pick a starter model/i })).toBeVisible()
  await page.getByRole('button', { name: /Qwen 2\.5 0\.5B/i }).click()
  await page.getByRole('button', { name: /Install \d+ model/i }).click()
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /Skip for now/i }).click()
  await page.getByRole('button', { name: /Get Started/i }).click()

  // Seit 2.6.8 startet die Leiste zugeklappt (uiStore.ts:158), und die
  // Gespraechsliste lebt in ihr. Ohne diesen Klick zaehlt `rowCount` null
  // Zeilen und der ganze Aufbau laeuft in eine Frist. Gemessen am 04.09.2026:
  // vorher 0 Loeschknoepfe, nach dem Klick 1, Leiste 288 px.
  await oeffneSeitenleiste(page)

  // Two conversations so a delete shows up as a count change. The first one
  // carries a real exchange, the second is the empty chat you get from the
  // button — both are rows in the sidebar.
  await openNewChat(page)
  await page.locator('textarea').first().fill('first chat')
  await page.locator('textarea').first().press('Enter')
  await expect(page.getByText(DEFAULT_ASSISTANT_REPLY).first()).toBeVisible({ timeout: 30_000 })
  await openNewChat(page)
  await expect.poll(async () => await rowCount(page)).toBe(2)
}

test('right-clicking a chat offers rename and delete, and delete removes it', async ({ page }) => {
  await bootWithTwoChats(page)
  const before = await rowCount(page)
  expect(before).toBeGreaterThanOrEqual(2)

  await pointerOnFirstRow(page)
  await page.mouse.down({ button: 'right' })
  await page.mouse.up({ button: 'right' })

  const menu = page.getByRole('menu', { name: /Chat actions/i })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /Rename/i })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /Delete chat/i })).toBeVisible()

  await menu.getByRole('menuitem', { name: /Delete chat/i }).click()
  await expect(menu).toHaveCount(0)
  await expect.poll(async () => await rowCount(page)).toBe(before - 1)
})

test('escape closes the menu without deleting anything', async ({ page }) => {
  await bootWithTwoChats(page)
  const before = await rowCount(page)

  await pointerOnFirstRow(page)
  await page.mouse.down({ button: 'right' })
  await page.mouse.up({ button: 'right' })
  await expect(page.getByRole('menu', { name: /Chat actions/i })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: /Chat actions/i })).toHaveCount(0)
  expect(await rowCount(page)).toBe(before)
})

test('the row buttons carry names, so they are findable without guessing', async ({ page }) => {
  await bootWithTwoChats(page)
  // Named for a screen reader and tooltipped for everyone else — the 10 px
  // unlabelled icon is what sent sweenscapehub to Discord.
  await expect(page.getByRole('button', { name: 'Delete chat' }).first()).toHaveAttribute('title', 'Delete chat')
  await expect(page.getByRole('button', { name: 'Rename chat' }).first()).toHaveAttribute('title', 'Rename chat')
})

/**
 * Die Eigenschaft, die D-S15 (287903aa) NEU eingefuehrt hat, und die genau
 * der Grund war, warum die drei Tests oben ihren Weg aendern mussten.
 *
 * Die Aktionsleiste liegt seit dem ausserhalb des Flusses, direkt ueber dem
 * Datum. Das kauft der Spalte +53 % Titelbreite und verlangt dafuer eine
 * Gegenregel: ein unsichtbarer Kasten darf die Klicks nicht abfangen, die der
 * Zeile gelten. Beide Haelften stehen hier, denn nur zusammen sind sie richtig
 * — `pointer-events-none` allein waere ein Knopf, den niemand je erreicht,
 * und die Leiste ohne die Regel waere ein unsichtbarer Loeschknopf ueber dem
 * Datum jeder Zeile.
 */
test('the hover bar hides from the pointer at rest and takes it back on hover', async ({ page }) => {
  await bootWithTwoChats(page)
  const del = page.getByRole('button', { name: 'Delete chat' }).first()
  const box = (await del.boundingBox())!
  const at: [number, number] = [box.x + box.width / 2, box.y + box.height / 2]

  // Ruhe: an der Stelle des Knopfes liegt die Zeile, nicht der Knopf. Sonst
  // stuende ueber jedem Datum ein unsichtbarer "Delete chat".
  const atRest = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null,
    at,
  )
  expect(atRest, 'im Ruhezustand faengt die unsichtbare Leiste Zeigerereignisse ab').toBeNull()

  // Eine Zeigerbewegung — und derselbe Punkt gehoert dem Knopf.
  await page.mouse.move(...at)
  const onHover = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null,
    at,
  )
  expect(onHover, 'nach dem Ueberfahren der Zeile ist der Loeschknopf immer noch unerreichbar').toBe('Delete chat')

  // Und er tut, was er verspricht — ueber den Knopf, nicht ueber das Menue.
  const before = await rowCount(page)
  await del.click()
  await expect.poll(async () => await rowCount(page)).toBe(before - 1)
})

test('the row buttons are reachable by keyboard alone', async ({ page }) => {
  await bootWithTwoChats(page)
  // Kein Zeiger im Spiel: `opacity-0` blendet die Leiste aus, `focus-within`
  // holt sie zurueck. Ohne diesen Zweig waere Umbenennen/Loeschen fuer eine
  // Tastatur GAR NICHT erreichbar — das Kontextmenue der Zeile haengt an
  // `onContextMenu` und ist ebenfalls nur mit Zeiger zu oeffnen.
  await page.locator('input[placeholder="Search..."]').focus()
  // Seit KF-8 steht die ZEILE vor ihren Knoepfen — das ist der ganze Punkt
  // jenes Befunds, und deshalb kostet der Weg zu „Rename" hier einen Tab
  // mehr als vorher.
  await page.keyboard.press('Tab')
  await expect(page.getByRole('option').first()).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Rename chat' }).first()).toBeFocused()
  await page.keyboard.press('Tab')

  const del = page.getByRole('button', { name: 'Delete chat' }).first()
  await expect(del).toBeFocused()
  await expect(del.locator('xpath=..')).toHaveCSS('pointer-events', 'auto')

  const before = await rowCount(page)
  await page.keyboard.press('Enter')
  await expect.poll(async () => await rowCount(page)).toBe(before - 1)
})

/**
 * KF-8 — ein Tastaturnutzer konnte jeden Chat umbenennen und loeschen, aber
 * keinen einzigen oeffnen.
 *
 * Gemessen am Basisstand, Tab-Reihenfolge ab dem Suchfeld:
 *   Rename chat, Delete chat, Rename chat, Delete chat, New Chat, ...
 * Die Chatzeilen kamen NICHT vor. Sie waren ein `<div>` mit `onClick`, ohne
 * Rolle und ohne `tabIndex` — die zerstoerenden Aktionen lagen auf dem Weg,
 * die harmlose nicht.
 *
 * Dieser Fall MISST die Reihenfolge, statt sie zu behaupten: er liest nach
 * jedem Tab das `document.activeElement` aus und vergleicht die ganze Kette.
 * Faellt die Zeile wieder heraus, verschwinden die beiden `option:`-Eintraege
 * und der Vergleich wird rot.
 */

/** Was gerade den Fokus hat, als `Rolle:Name` — aus dem Dokument gelesen. */
const focusedAs = (page: Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null
  if (!a || a === document.body) return 'NICHTS'
  const rolle = a.getAttribute('role') ?? a.tagName.toLowerCase()
  // Eine Zeile traegt ihren Titel im <p>; ihr textContent haette das Datum
  // mit drin und wuerde bei jeder Formatierungsaenderung wackeln.
  if (rolle === 'option') return `option:${(a.querySelector('p')?.textContent ?? '').trim()}`
  return `${rolle}:${a.getAttribute('aria-label') ?? (a.textContent ?? '').trim()}`
})

/** Die naechsten `n` Tab-Stopps ab dem aktuellen Fokus. */
async function tabOrder(page: Page, n: number): Promise<string[]> {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab')
    out.push(await focusedAs(page))
  }
  return out
}

test('KF-8: Tab erreicht die Chatzeilen, und zwar vor ihren Knoepfen', async ({ page }) => {
  await bootWithTwoChats(page)
  await page.locator('input[placeholder="Search..."]').focus()

  // Die Liste sagt auch, dass sie eine Liste ist — und welche Zeile gewaehlt
  // ist. Vorher war „aktiv" ausschliesslich eine Hintergrundfarbe.
  await expect(page.getByRole('listbox', { name: 'Conversations' })).toBeVisible()
  await expect(page.getByRole('option')).toHaveCount(2)
  await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')

  expect(await tabOrder(page, 7)).toEqual([
    'option:New Chat',
    'button:Rename chat',
    'button:Delete chat',
    'option:first chat',
    'button:Rename chat',
    'button:Delete chat',
    'button:New Chat',
  ])
})

test('KF-8: Enter und Leertaste oeffnen den Chat, den Tab erreicht hat', async ({ page }) => {
  await bootWithTwoChats(page)
  const erste = page.getByRole('option').first()
  const zweite = page.getByRole('option').nth(1)
  await expect(zweite).toHaveAttribute('aria-selected', 'false')

  // Vier Tabs ab dem Suchfeld: Zeile 1, Umbenennen, Loeschen, Zeile 2.
  await page.locator('input[placeholder="Search..."]').focus()
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab')
  await expect(zweite).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(zweite).toHaveAttribute('aria-selected', 'true')
  await expect(erste).toHaveAttribute('aria-selected', 'false')
  await expect(page.getByText(DEFAULT_ASSISTANT_REPLY).first()).toBeVisible()

  // Dieselbe Tuer, andere Hand. Ein `<div tabIndex={0}>` haette genau hier
  // geschwiegen: Leertaste scrollt, wenn nichts sie abfaengt.
  await erste.focus()
  await page.keyboard.press('Space')
  await expect(erste).toHaveAttribute('aria-selected', 'true')
  await expect(zweite).toHaveAttribute('aria-selected', 'false')
})

test('KF-8: die Zeile heisst „New Chat" und ist trotzdem kein Knopf', async ({ page }) => {
  await bootWithTwoChats(page)
  // `chatStore.createConversation` nennt einen frischen Chat woertlich
  // „New Chat". Traege die Zeile `role="button"`, haette jeder
  // `getByRole('button', { name: /New Chat/i })` ab der ersten leeren
  // Unterhaltung zwei Treffer — auch der in `e2e/support/ui.ts`, ueber den
  // JEDER Spec dieser Suite seine Chats anlegt. Das ist der Grund, warum die
  // Zeile `option` traegt und nicht `button`, und hier steht er als Messung.
  // Die Kollision zuerst: DAS ist die Zusicherung, und sie muss auch dann
  // sprechen, wenn die Zeile ihre Rolle ganz verliert.
  await expect(page.getByRole('button', { name: /New Chat/i })).toHaveCount(1)
  await expect(page.getByRole('option').filter({ hasText: 'New Chat' })).toHaveCount(1)
})
