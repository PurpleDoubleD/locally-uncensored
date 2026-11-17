import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat, expectWorkspaceAsk, answerWorkspaceAsk } from './support/ui'

/**
 * Any file attaches to a chat (Discord: a ROM for a model that
 * helps with ROM hacking).
 *
 * Before this the paperclip took images only, and everything else was turned
 * away with a notice. Now a binary becomes a chip, and the model receives a
 * description of it: name, type from the signature, size, SHA-256, a hex dump
 * of the start and the readable strings. In Agent mode the file is also
 * copied into the working folder, so the file tools can open it.
 *
 * Measured at the payload, not on the screen: the request body is what the
 * model reads.
 *
 * Run: CI=1 npx playwright test e2e/chat-file-attachment.spec.ts
 */

/** An iNES header, sixteen bytes of code, and a title a strings pass finds. */
function nesRom(): Buffer {
  const header = Buffer.from([0x4e, 0x45, 0x53, 0x1a, 0x02, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0])
  const code = Buffer.from([0xa9, 0x00, 0x8d, 0x00, 0x20, 0xff, 0xfe, 0x80, 0x81, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06])
  const title = Buffer.from('SUPER PLUMBER QUEST\0', 'latin1')
  return Buffer.concat([header, code, title, Buffer.alloc(64, 0xea)])
}

const ROM = { name: 'plumber.nes', mimeType: 'application/octet-stream', buffer: nesRom() }

interface Recorded { cmd: string; path?: string; offset?: number; last?: boolean; base64Length?: number }

async function chatBodies(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bodies: unknown = Reflect.get(window, '__E2E_CHAT_BODIES__')
    return Array.isArray(bodies) ? bodies.map(String) : []
  })
}

async function toolCalls(page: Page): Promise<Recorded[]> {
  return page.evaluate(() => {
    const calls: unknown = Reflect.get(window, '__E2E_TOOL_CALLS__')
    return Array.isArray(calls) ? (calls as Recorded[]) : []
  })
}

/** The last user message of the last request, as the model receives it. */
async function lastUserMessage(page: Page): Promise<string> {
  const bodies = await chatBodies(page)
  const body = JSON.parse(bodies[bodies.length - 1]) as { messages: Array<{ role: string; content: unknown }> }
  const users = body.messages.filter((m) => m.role === 'user')
  return String(users[users.length - 1].content)
}

test('a binary file becomes a chip and reaches the model as a description', async ({ page }) => {
  const opts: TauriMockOptions = { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'mac' }
  await page.addInitScript(tauriMockInit, opts)
  await seedOnboardingDone(page)
  await page.goto('/')
  await openNewChat(page)

  await page.getByTestId('composer-file-input').setInputFiles(ROM)
  const composerChip = page.getByTestId('composer-file-chip')
  await expect(composerChip).toBeVisible()
  await expect(composerChip).toContainText('plumber.nes')
  await expect(composerChip).toContainText('NES ROM (iNES)')
  // Plain chat says, above the transcript, that the model only gets a summary
  // of a binary and where it gets the file itself (3.0.7).
  const line = page.getByTestId('chat-notices')
  await expect(line).toContainText('Models cannot read binary files. "plumber.nes" (NES ROM (iNES)')
  await expect(line).toContainText('turn on Agent mode or use Code')

  const field = page.locator('textarea').first()
  await field.fill('what is this rom?')
  await page.getByRole('button', { name: /Send message/i }).click()

  await expect(page.getByText(DEFAULT_ASSISTANT_REPLY).first()).toBeVisible({ timeout: 20_000 })

  // The bubble shows what was typed plus the chip, not the hex dump.
  const sentChip = page.getByTestId('chat-file-chip')
  await expect(sentChip).toBeVisible()
  await expect(sentChip).toContainText('plumber.nes')
  await expect(page.getByText('[Attached file: plumber.nes]')).toHaveCount(0)
  await expect(composerChip).toHaveCount(0)

  // The model gets the description.
  const sent = await lastUserMessage(page)
  expect(sent).toContain('what is this rom?')
  expect(sent).toContain('[Attached file: plumber.nes]')
  expect(sent).toContain('Type: NES ROM (iNES)')
  expect(sent).toContain(`(${ROM.buffer.length} bytes)`)
  expect(sent).toMatch(/SHA-256: [0-9a-f]{64}/)
  expect(sent).toContain('4e 45 53 1a')
  expect(sent).toContain('SUPER PLUMBER QUEST')
  expect(sent).toContain('The file itself is not available to you in this chat.')

  // A plain chat has no working folder, so nothing is written to disk.
  expect((await toolCalls(page)).filter((c) => c.cmd === 'fs_write_bytes')).toHaveLength(0)

  // What is stored is the description and the chip, never the bytes. Read
  // after a reload, so this is what really went to disk; the file name is the
  // control that the right record was read.
  await page.reload()
  await expect(page.getByTestId('chat-file-chip')).toContainText('plumber.nes', { timeout: 20_000 })
  const stored = await page.evaluate(async () => {
    const out: string[] = []
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(info.name as string)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      for (const store of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const req = db.transaction(store, 'readonly').objectStore(store).getAll()
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        out.push(JSON.stringify(rows))
      }
      db.close()
    }
    return out.join('\n')
  })
  expect(stored).toContain('plumber.nes')
  expect(stored).not.toContain(ROM.buffer.toString('base64').slice(0, 40))
})

test('in Agent mode the file is copied into the working folder and the model is told the path', async ({ page }) => {
  const opts: TauriMockOptions = {
    assistantReply: 'unused in this spec',
    modelName: DEFAULT_MODEL_NAME,
    platform: 'mac',
    agentTurns: [{ text: 'I can see the file.' }],
  }
  await page.addInitScript(tauriMockInit, opts)
  await seedOnboardingDone(page)
  await page.goto('/')
  await openNewChat(page)
  const agentToggle = page.getByRole('main').getByRole('button', { name: 'Agent', exact: true })
  await agentToggle.click()
  expectWorkspaceAsk(page)
  await expect(agentToggle).toHaveAttribute('title', /Agent Mode is on/i, { timeout: 10_000 })

  await page.getByTestId('composer-file-input').setInputFiles(ROM)
  await expect(page.getByTestId('composer-file-chip')).toBeVisible()
  // In Agent mode the file goes into the folder: no "summary only" line.
  await expect(page.getByText(/Models cannot read binary files/)).toHaveCount(0)
  await page.locator('textarea').first().fill('patch the title')
  await page.getByRole('button', { name: /Send message/i }).click()
  await answerWorkspaceAsk(page)

  await expect(page.getByText('I can see the file.').first()).toBeVisible({ timeout: 20_000 })

  const writes = (await toolCalls(page)).filter((c) => c.cmd === 'fs_write_bytes')
  expect(writes).toHaveLength(1)
  expect(writes[0].path).toBe('plumber.nes')
  expect(writes[0].offset).toBe(0)
  expect(writes[0].last).toBe(true)
  expect(writes[0].base64Length).toBe(ROM.buffer.toString('base64').length)

  const bodies = await chatBodies(page)
  const first = JSON.parse(bodies[0]) as { messages: Array<{ role: string; content: unknown }> }
  const user = String(first.messages.filter((m) => m.role === 'user').pop()?.content)
  expect(user).toContain('patch the title')
  expect(user).toContain('Path in your working folder: plumber.nes')
  expect(user).toContain('Type: NES ROM (iNES)')
  // Facts and path, no dump, and nothing is run unasked.
  expect(user).not.toContain('4e 45 53 1a')
  expect(user).toContain('Do not run the file or open it as a program unless the user asks you to.')
})
