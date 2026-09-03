import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * Regression cover for the 2.6.3 renderer Out of Memory (Morgan, 2026-08-03).
 *
 * The fix has two halves that only a real browser can check together:
 *   1. chatStore persists through a COALESCING storage, so a streaming answer
 *      costs a handful of IndexedDB writes instead of one per animation frame.
 *      The risk of any write coalescing is losing the tail — so this asserts
 *      the finished answer really is on disk and survives a reload.
 *   2. MessageBubble is memo()d, which only holds up while MessageList hands it
 *      stable handlers. Get that wrong and the streaming bubble freezes
 *      mid-answer — invisible to unit tests, obvious here.
 *
 * The reply arrives in 24 frames so the store is driven the way a real engine
 * drives it, not in one shot.
 */

const REPLY = 'Streaming answer that arrives token by token and must land in full.'
const CHUNKS = 24

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: REPLY,
    modelName: DEFAULT_MODEL_NAME,
    replyChunks: CHUNKS,
    replyChunkDelayMs: 12,
  })
  await seedOnboardingDone(page)
  await page.goto('/')
}

/**
 * Scoped to the TRANSCRIPT, and to paragraphs. Two different traps:
 *
 *  1. the sidebar shows the first message as the conversation title, so a bare
 *     `getByText` matches it a second time — hence `getByRole('main')`;
 *  2. Playwright's text engine reads a `<textarea>`'s VALUE as its text. While
 *     a typed message still sits in the composer, `main.getByText('…MARKER')`
 *     therefore matches the COMPOSER. That is not a detail: it is how the
 *     previous version of this spec could assert "the second message is on
 *     screen" about a send the app had silently dropped — the text it found
 *     was the text still waiting in the input. Messages render as paragraphs;
 *     the composer does not.
 */
function inChat(page: Page, text: string) {
  return page.getByRole('main').locator('p').filter({ hasText: text })
}

async function send(page: Page, text: string) {
  const composer = page.locator('textarea').first()
  const sendButton = page.getByRole('button', { name: 'Send message' })
  // The transcript bubble, NOT the composer — see inChat() below for why the
  // difference decides whether this helper can tell a sent message from an
  // unsent one at all.
  const bubble = inChat(page, text)

  await expect(composer).toBeVisible({ timeout: 20_000 })
  // Send and Stop share ONE slot in this composer, so "Send is back" is the
  // observable end of the previous turn — ChatInput refuses a send while
  // `isGenerating`.
  await expect(sendButton).toBeVisible({ timeout: 30_000 })

  // That is necessary and NOT sufficient, which is what the flat 1.5 s sleep
  // this replaces was covering by accident. ChatInput also holds a 700 ms
  // double-fire lock (SEND_LOCK_MS, chat/ChatInput.tsx) measured from the last
  // ACCEPTED send, not from the end of the turn. A message that lands inside
  // that window is dropped in silence: no bubble, no error, the text simply
  // stays in the composer. Measured here on 2026-09-01: with a 24-frame reply
  // the turn is over ~300 ms after the send, so the second send landed at
  // ~500 ms — inside the lock — and this spec failed 3 runs out of 4.
  //
  // So the send verifies its own effect and, when it was swallowed, does what
  // a person does: press again. The retry is guarded by the bubble itself, so
  // an accepted send is never sent a second time.
  await expect(async () => {
    if ((await bubble.count()) === 0) {
      await composer.fill(text)
      await expect(sendButton).toBeEnabled()
      await sendButton.click()
    }
    await expect(bubble).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}


test('a streamed answer renders live, lands in full, and survives a reload', async ({ page }) => {
  await boot(page)
  // openNewChat, not a bare click: right after onboarding the model list is
  // still loading and Sidebar.handleNewChat drops a click with no active
  // model. Deterministic on the Windows box, invisible on a fast Mac — this
  // spec was the one E2E failure in the 2.6.3 Windows run.
  await openNewChat(page)

  await send(page, 'FIRST-TURN-MARKER')
  // The memoised bubble did not freeze: the WHOLE answer arrives, not the
  // first frame of it.
  await expect(inChat(page, REPLY)).toBeVisible({ timeout: 30_000 })
  await expect(inChat(page, 'FIRST-TURN-MARKER')).toBeVisible()

  // A second turn must not disturb the first — the memo keeps earlier bubbles
  // mounted, and they have to keep their content.
  await send(page, 'SECOND-TURN-MARKER')
  // Wait for the SECOND answer, not just the echoed prompt: two bubbles now
  // carry the reply. Reloading before this would test a half-streamed turn.
  await expect(inChat(page, REPLY)).toHaveCount(2, { timeout: 30_000 })
  await expect(inChat(page, 'SECOND-TURN-MARKER')).toBeVisible()
  await expect(inChat(page, 'FIRST-TURN-MARKER')).toBeVisible()

  // The coalescing storage must still have written it. Reload with a cold
  // renderer and read it back out of real IndexedDB.
  //
  // Wait for the app to say the turn is OVER first, not just for the answer to
  // be on screen. The two are not the same moment and the gap is the whole
  // point: the answer paints while the write is still in flight, so a reload
  // fired on the paint lands inside that window — measured at 3 to 4 runs in
  // 12 on a loaded machine, before and after the write became awaited. Since
  // stores/durability.ts, "Send is back in the slot Stop held" means the turn
  // is in IndexedDB, so this is the first instant at which the assertions
  // below are actually entitled to hold.
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 30_000 })
  await page.reload()

  await expect(inChat(page, 'FIRST-TURN-MARKER')).toBeVisible({ timeout: 30_000 })
  await expect(inChat(page, 'SECOND-TURN-MARKER')).toBeVisible()
  await expect(inChat(page, REPLY).first()).toBeVisible()

  // And assert it at the source, not just on screen: the persisted record
  // carries the COMPLETE answer, not a truncated prefix.
  const persisted = await page.evaluate(async () => {
    const raw: string | null = await new Promise((res) => {
      const req = indexedDB.open('locally-uncensored-store', 1)
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', 'readonly')
        const r = tx.objectStore('kv').get('chat-conversations')
        r.onsuccess = () => res(typeof r.result === 'string' ? r.result : null)
        r.onerror = () => res(null)
      }
      req.onerror = () => res(null)
    })
    if (!raw) return null
    const conv = JSON.parse(raw).state.conversations[0]
    return conv.messages.map((m: { role: string; content: string }) => m.content)
  })

  expect(persisted).not.toBeNull()
  expect(persisted!.some((c: string) => c.includes('FIRST-TURN-MARKER'))).toBe(true)
  expect(persisted!.some((c: string) => c.includes('SECOND-TURN-MARKER'))).toBe(true)
  expect(persisted!.filter((c: string) => c.includes(REPLY)).length).toBe(2)
})
