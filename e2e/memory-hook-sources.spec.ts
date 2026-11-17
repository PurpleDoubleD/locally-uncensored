import { expect, test } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat, appModules, type AppWindow, expectWorkspaceAsk, answerWorkspaceAsk } from './support/ui'
import { isRecord } from './support/recorded'
import type { MemoryFile } from '../src/types/agent-mode'

for (const mode of ['Chat', 'Agent', 'Code'] as const) {
 for (const collection of ['local', 'account'] as const) {
  test(`${mode} ${collection} sends selected memory without a per-answer sources chip`, async ({ page }, testInfo) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.route('**/*', route => {
      const hostname = new URL(route.request().url()).hostname
      return hostname === 'localhost' || hostname === '127.0.0.1' ? route.continue() : route.abort()
    })
    await page.addInitScript(tauriMockInit, {
      assistantReply: 'SOURCEPROOF answer from the transport fixture.',
      modelName: DEFAULT_MODEL_NAME,
    })
    await seedOnboardingDone(page)
    await page.goto('/')
    if (mode === 'Code') await page.getByRole('button', { name: 'Code', exact: true }).click()
    await openNewChat(page)
    if (mode === 'Agent') {
      const toggle = page.getByRole('main').getByRole('button', { name: 'Agent', exact: true })
      await toggle.click()
      expectWorkspaceAsk(page)
      await expect(toggle).toHaveAttribute('title', /Agent Mode is on/i)
    }
    // Seed only input state. Retrieval, hooks, provider serialization, answer
    // mutation and rendering all remain production code.
    await appModules(page, ['/src/stores/memoryStore.ts', '/src/stores/chatStore.ts', '/src/stores/cloudAuthStore.ts'])
    await page.evaluate(async selectedCollection => {
      const memory = (window as unknown as AppWindow).__APP__['/src/stores/memoryStore.ts'] as typeof import('../src/stores/memoryStore')
      const chat = (window as unknown as AppWindow).__APP__['/src/stores/chatStore.ts'] as typeof import('../src/stores/chatStore')
      await memory.useMemoryStore.persist.rehydrate()
      if (selectedCollection === 'account') {
        const { useCloudAuthStore } = (window as unknown as AppWindow).__APP__['/src/stores/cloudAuthStore.ts'] as typeof import('../src/stores/cloudAuthStore')
        useCloudAuthStore.getState().setSignedIn({ id: 'proof-owner' }, { licenseActive: false, tier: null, access: true, quota: null })
        if (!memory.useMemoryStore.getState().selectMemoryCollection('proof-owner')) throw new Error('Could not select proof collection')
      }
      memory.__setMemoryEmbedFn(async () => [])
      const entry = (id: string, extra: Partial<MemoryFile> = {}): MemoryFile => ({
        id, title: `Sourceproof ${id}`, content: `SOURCEPROOF_${id}`, description: '', type: 'user',
        tags: [], source: 'manual', createdAt: Date.now(), updatedAt: Date.now(), ...extra,
      })
      memory.useMemoryStore.setState({ entries: [entry('global'), entry('project', { scope: 'proof' }),
        entry('private', { sensitive: true }), entry('foreign', { scope: 'other' }), entry('stale', { stale: true })] })
      const active = chat.useChatStore.getState().activeConversationId
      if (!active) throw new Error('No active proof conversation')
      chat.useChatStore.getState().setConversationMemoryScope(active, 'proof')
    }, collection)
    const composer = page.locator('textarea').first()
    await expect(composer).toBeEnabled()
    await composer.fill('sourceproof preferences please')
    await page.getByRole('button', { name: 'Send message' }).click()
    await answerWorkspaceAsk(page)
    await expect(page.getByRole('main').getByText('SOURCEPROOF answer from the transport fixture.', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 30_000 })
    await appModules(page, ['/src/stores/chatStore.ts'])
    const result = await page.evaluate(async () => {
      const chat = (window as unknown as AppWindow).__APP__['/src/stores/chatStore.ts'] as typeof import('../src/stores/chatStore')
      await chat.flushChatPersist()
      const bodies: unknown = Reflect.get(window, '__E2E_CHAT_BODIES__')
      if (!Array.isArray(bodies) || !bodies.every(body => typeof body === 'string')) throw new Error('Missing transport bodies')
      return { bodies: bodies as string[] }
    })
    const body = result.bodies.find(value => value.includes('sourceproof preferences please'))
    expect(body).toBeDefined()
    const payload: unknown = JSON.parse(body!)
    if (!isRecord(payload) || !Array.isArray(payload.messages)) throw new Error('Missing provider messages')
    const system = payload.messages.filter(isRecord).filter(message => message.role === 'system').map(message => message.content).join('\n')
    // Since 3.0.8 (A7, lib/turn-context.ts) Chat and Agent send the memories
    // behind the user's newest message, so the system prompt stays the same
    // for the whole chat; Code keeps them in the system prompt.
    const afterTheWords = payload.messages.filter(isRecord).filter(message => message.role === 'user')
      .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
      .join('\n').split('sourceproof preferences please').slice(1).join('')
    const carrier = mode === 'Code' ? system : afterTheWords
    if (mode !== 'Code') expect(system).not.toContain('<remembered_context>')
    expect(carrier).toContain('<remembered_context>')
    expect(carrier).toContain('SOURCEPROOF_global')
    expect(carrier).toContain('SOURCEPROOF_project')
    for (const excluded of ['private', 'foreign', 'stale']) expect(body).not.toContain(`SOURCEPROOF_${excluded}`)
    // Regression guard: the "Memory sources" chip under an answer was removed
    // (2026-09-19: the purple brain icon already shows memory is active,
    // repeating it under every reply was noise). Retrieval above still runs in
    // full; only the per-answer disclosure is gone.
    await expect(page.getByText('Memory sources', { exact: false })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('memory-hook-sources.png') })
    expect(pageErrors).toEqual([])
  })
 }
}
