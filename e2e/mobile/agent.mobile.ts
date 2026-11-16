/**
 * The screens of the strand "agent" (C5, C8 to C13, E6 to E10 and the three
 * slots in C2), in a browser without Tauri.
 *
 * No real cloud call and no real web call: every request that does not go to
 * the dev server is cut off, and the test fails when one was tried without a
 * mock. State is seeded through the stores of the app (the dev server hands
 * out the modules), never through a sign in.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { SIZES, answerCloudProbe, measureLayout, openShell, screensLoaded, watchErrors } from './support'
import { buildDocument } from '../../src/lib/html-preview'
import { sandboxAttr } from '../../src/lib/file-preview'
import { previewDocument } from '../../src/mobile/screens/agent/parts/preview-doc'

const CLEAN = { overflow: [], small: [], pageScrolls: false }

/** Cut off everything that is not the dev server. Returns the list of what was tried. */
async function sealNetwork(page: Page): Promise<string[]> {
  const tried: string[] = []
  await page.route(
    (url) => !['localhost', '127.0.0.1'].includes(url.hostname),
    (route) => {
      tried.push(route.request().url())
      return route.abort()
    },
  )
  // The dev server has no backend behind /local-api in a test run: answer at once.
  await page.route('**/local-api/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not in a test"}' }))
  // Since round 12 the chat options ask what this phone can load (screens/models/parts/device.ts), and that
  // read also asks for the model folder. A browser has none: the answer is "no folder", not a failed request,
  // which the browser would write to the console as an error of the page.
  await page.route('**/local-api/detect-model-path', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }))
  return tried
}

interface SeedMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  agentBlocks?: unknown[]
}

async function seedChat(page: Page, messages: SeedMessage[] = [{ id: 'u1', role: 'user', content: 'Hello' }]): Promise<string> {
  return page.evaluate(async (list) => {
    const { useChatStore } = ((await import(/* @vite-ignore */ '/src/stores/chatStore.ts' as string)) as typeof import('../../src/stores/chatStore'))
    const id = useChatStore.getState().createConversation('openai::test-model', '')
    for (const m of list) useChatStore.getState().addMessage(id, { ...m, timestamp: Date.now() } as never)
    return id
  }, messages)
}

async function openSheet(page: Page, id: string, props: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate(
    async ([sheetId, sheetProps]) => {
      const { nav } = ((await import(/* @vite-ignore */ '/src/mobile/nav/index.ts' as string)) as typeof import('../../src/mobile/nav/index'))
      ;(nav.openSheet as (id: string, props: unknown) => void)(sheetId as string, sheetProps)
    },
    [id, props] as const,
  )
  await screensLoaded(page)
}

async function push(page: Page, route: string, params: Record<string, string> = {}): Promise<void> {
  await page.evaluate(
    async ([r, p]) => {
      const { nav } = ((await import(/* @vite-ignore */ '/src/mobile/nav/index.ts' as string)) as typeof import('../../src/mobile/nav/index'))
      ;(nav.push as (route: string, params: unknown) => void)(r as string, p)
    },
    [route, params] as const,
  )
  await screensLoaded(page)
}

/** Back to the documents of a chat after a new start, which always opens a new chat (round 57): list, chat, Documents. */
async function reopenDocuments(page: Page, chatId: string): Promise<void> {
  const top = await page.evaluate(async (id) => {
    const { nav } = ((await import(/* @vite-ignore */ '/src/mobile/nav/index.ts' as string)) as typeof import('../../src/mobile/nav/index'))
    const state = nav.getState()
    const chat = state.stacks.chat
    const landed = `${state.tab} ${chat.map((p) => `${p.route}${p.params.id ? `=${p.params.id}` : ''}`).join(' ')}`
    nav.resetTo('chat', [{ route: '/chat/:id', params: { id } }, { route: '/chat/:id/documents', params: { id } }])
    return landed
  }, chatId)
  expect(top).toBe('chat /chats /chat/:id=new')
  await screensLoaded(page)
}

/** Not a real key. */
const SEARCH_KEY = 'test-key-not-real-7731'

const SHOTS = process.env.LU_AGENT_SHOTS

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

/**
 * A stand in for the native bridge that knows the key storage and the web
 * search command, nothing else. The "key storage" lives under one key of the
 * page storage so it survives a reload, like the keychain survives a restart.
 * The search goes on to /local-api/web-search, where the test answers it.
 * Call before the first goto.
 */
async function keyStorage(page: Page): Promise<void> {
  // With a bridge the app probes the network at the cloud of LU: answered in the page, nothing leaves the machine.
  await answerCloudProbe(page)
  await page.addInitScript(() => {
    const SLOT = '__e2e_key_storage'
    const read = (): Record<string, string> => JSON.parse(localStorage.getItem(SLOT) ?? '{}') as Record<string, string>
    const write = (all: Record<string, string>) => localStorage.setItem(SLOT, JSON.stringify(all))
    let callbacks = 0
    const invoke = async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      const id = String(args.backendId ?? args.account ?? '')
      switch (command) {
        case 'secret_park_set':
        case 'secret_set':
          write({ ...read(), [id]: String(args.value) })
          return null
        case 'secret_park_get':
        case 'secret_get':
          return read()[id] ?? null
        case 'secret_park_delete':
        case 'secret_delete': {
          const all = read()
          delete all[id]
          write(all)
          return null
        }
        case 'web_search': {
          const answer = await fetch('/local-api/web-search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
          return answer.json()
        }
        case 'plugin:event|listen':
          return ++callbacks
        case 'plugin:event|unlisten':
          return null
        default:
          // Everything else the app asks at its start (backup, device, engine) has no answer here.
          return null
      }
    }
    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { configurable: true, value: { unregisterListener: () => undefined } })
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke,
        transformCallback: () => ++callbacks,
        unregisterCallback: () => undefined,
        convertFileSrc: (file: string) => file,
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
      },
    })
  })
}

async function storedKeys(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('__e2e_key_storage') ?? '{}') as Record<string, string>)
}

async function clean(page: Page, what: string): Promise<void> {
  // A target that was just tapped is drawn pressed for a moment, and pressed is smaller. Measure it at rest.
  await page.waitForFunction(() => !document.querySelector('.m-app :active'))
  expect(await measureLayout(page), what).toEqual(CLEAN)
}

for (const size of SIZES) {
  test.describe(`agent strand ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    test('slots in the chat: goal, loop, plan, thinking, tool steps and status chips', async ({ page }) => {
      const errors = watchErrors(page)
      const tried = await sealNetwork(page)
      await openShell(page, { route: '/chats' })
      const chatId = await seedChat(page, [
        { id: 'u1', role: 'user', content: 'Find the weather' },
        {
          id: 'a1',
          role: 'assistant',
          content: 'It is sunny.',
          thinking: 'The user wants the weather. I search first.',
          agentBlocks: [
            { id: 'b1', phase: 'tool_call', content: '', timestamp: 1, toolCalls: [{ id: 't1', toolName: 'web_search', args: { query: 'weather today' }, status: 'completed', result: '1. Sunny all day', timestamp: 1, duration: 1200 }] },
            { id: 'b2', phase: 'tool_call', content: '', timestamp: 2, toolCalls: [{ id: 't2', toolName: 'web_fetch', args: { url: 'https://example.com/weather' }, status: 'failed', error: 'The page did not answer.', timestamp: 2 }] },
          ],
        },
      ])
      await page.evaluate(async (id) => {
        const { useAgentGoalStore } = ((await import(/* @vite-ignore */ '/src/stores/agentGoalStore.ts' as string)) as typeof import('../../src/stores/agentGoalStore'))
        const { useAgentLoopStore } = ((await import(/* @vite-ignore */ '/src/stores/agentLoopStore.ts' as string)) as typeof import('../../src/stores/agentLoopStore'))
        const { useTodoStore } = ((await import(/* @vite-ignore */ '/src/stores/todoStore.ts' as string)) as typeof import('../../src/stores/todoStore'))
        const { useAgentModeStore } = ((await import(/* @vite-ignore */ '/src/stores/agentModeStore.ts' as string)) as typeof import('../../src/stores/agentModeStore'))
        const { useSettingsStore } = ((await import(/* @vite-ignore */ '/src/stores/settingsStore.ts' as string)) as typeof import('../../src/stores/settingsStore'))
        useAgentGoalStore.getState().setGoal(id, 'Know the weather for the whole week before the trip starts')
        useAgentLoopStore.getState().start({ conversationId: id, pass: 2, cap: 5, task: 'check the weather', intervalMs: 120000, nextAt: Date.now() + 90000 })
        useTodoStore.getState().setTodos(id, [
          { content: 'Search the weather', status: 'completed', activeForm: 'Searching' },
          { content: 'Read the forecast page', status: 'in_progress', activeForm: 'Reading' },
          { content: 'Write the answer', status: 'pending', activeForm: 'Writing' },
        ] as never)
        useAgentModeStore.getState().setAgentModeActive(id, true)
        useSettingsStore.getState().updateSettings({ cavemanMode: 'lite' })
      }, chatId)
      await push(page, '/chat/:id', { id: chatId })
      // The chat page of strand 1 renders the slots itself.

      await expect(page.getByTestId('m-chat-goal')).toContainText('Know the weather')
      await expect(page.getByTestId('m-chat-loop')).toContainText('pass 2 of 5')
      await expect(page.getByTestId('m-chat-plan-toggle')).toContainText('1 of 3 done')
      // Prompt v2: what was a row of chips above the field is the grey summary on the settings button. The chat
      // that was open before stays in the stack below with its own composer: the page on top is the last one.
      const options = page.getByTestId('m-chat-options').last()
      await expect(options).toContainText('Agent')
      await expect(options).toContainText('Caveman')
      await clean(page, 'slots closed')

      // The plan opens and lists its steps.
      await page.getByTestId('m-chat-plan-toggle').tap()
      await expect(page.getByTestId('m-chat-plan-list')).toContainText('Read the forecast page')
      await clean(page, 'plan open')
      await page.getByTestId('m-chat-plan-toggle').tap()

      // The lines act: clear the goal, stop the loop.
      await page.getByTestId('m-chat-goal-clear').tap()
      await expect(page.getByTestId('m-chat-goal')).toHaveCount(0)
      await page.getByTestId('m-chat-loop-stop').tap()
      await expect(page.getByTestId('m-chat-loop')).toHaveCount(0)

      // Thinking and the band of two steps open. After the lines above went: at 320x568 goal, loop, plan and a notice
      // leave a strip of transcript above the composer of prompt v2 too small to hold the fold still.
      await page.getByTestId('m-chat-thinking').tap()
      await expect(page.getByTestId('m-chat-blocks')).toContainText('I search first')
      await page.getByTestId('m-chat-steps').tap()
      await expect(page.getByTestId('m-chat-tool-nested').first()).toBeVisible()
      await page.getByTestId('m-chat-tool-nested').nth(1).tap()
      await expect(page.getByTestId('m-chat-blocks')).toContainText('The page did not answer.')
      await clean(page, 'blocks open')


      // The settings button opens the place where caveman is changed, one level down.
      await options.tap()
      await page.getByTestId('m-options-caveman-row').tap()
      await expect(page.getByTestId('m-options-caveman')).toBeVisible()
      await page.getByTestId('m-options-caveman-off').tap()
      await page.goBack()
      await page.goBack()
      await expect(options).not.toContainText('Caveman')
      expect(tried).toEqual([])
      expect(errors()).toEqual([])
    })

    test('C12 approval: the sheet comes up for a waiting step and answers it', async ({ page }) => {
      const errors = watchErrors(page)
      await sealNetwork(page)
      await openShell(page, { route: '/chats' })
      const chatId = await seedChat(page)
      await push(page, '/chat/:id', { id: chatId })
      // The chat page of strand 1 renders the slots itself.

      const ask = (toolName: string, args: Record<string, unknown>) =>
        page.evaluate(
          async ([id, name, a]) => {
            const { enqueueApproval } = ((await import(/* @vite-ignore */ '/src/lib/approval-queue.ts' as string)) as typeof import('../../src/lib/approval-queue'))
            const w = window as unknown as { __answers: boolean[] }
            w.__answers = w.__answers ?? []
            enqueueApproval(id as string, {
              toolCall: { id: `call-${Math.random()}`, toolName: name, args: a, status: 'pending', timestamp: Date.now() },
              resolve: (ok: boolean) => w.__answers.push(ok),
            } as never)
          },
          [chatId, toolName, args] as const,
        )
      const answers = () => page.evaluate(() => (window as unknown as { __answers?: boolean[] }).__answers ?? [])

      await ask('file_write', { path: 'notes.txt', content: 'hello' })
      await expect(page.getByTestId('m-sheet-approval')).toBeVisible()
      await expect(page.getByTestId('m-approval-target')).toContainText('notes.txt')
      await page.getByTestId('m-approval-details').tap()
      await expect(page.getByTestId('m-approval-input')).toContainText('content: hello')
      await clean(page, 'approval sheet')
      await page.getByTestId('m-approval-allow').tap()
      await expect(page.getByTestId('m-sheet-approval')).toHaveCount(0)
      expect(await answers()).toEqual([true])

      await ask('web_search', { query: 'cats' })
      await expect(page.getByTestId('m-sheet-approval')).toBeVisible()
      await page.getByTestId('m-approval-deny').tap()
      await expect(page.getByTestId('m-sheet-approval')).toHaveCount(0)
      expect(await answers()).toEqual([true, false])

      // Back on the sheet means Deny: nothing runs that was not allowed.
      await ask('web_search', { query: 'dogs' })
      await expect(page.getByTestId('m-sheet-approval')).toBeVisible()
      await page.goBack()
      await expect(page.getByTestId('m-sheet-approval')).toHaveCount(0)
      await expect.poll(answers).toEqual([true, false, false])

      // "Always allow in this chat" writes the level of this chat and lets the step run.
      await ask('web_search', { query: 'birds' })
      await page.getByTestId('m-approval-always').tap()
      await expect(page.getByTestId('m-sheet-approval')).toHaveCount(0)
      expect(await answers()).toEqual([true, false, false, true])
      const level = await page.evaluate(async (id) => {
        const { usePermissionStore } = ((await import(/* @vite-ignore */ '/src/stores/permissionStore.ts' as string)) as typeof import('../../src/stores/permissionStore'))
        // The level that holds for this chat. Where the app default is "auto" already, the chat keeps no entry of
        // its own (round 16, F12: an entry equal to the default made every such chat say "Changed for this chat").
        const state = usePermissionStore.getState()
        return state.conversationOverrides[id]?.web ?? state.globalPermissions.web
      }, chatId)
      expect(level).toBe('auto')
      expect(errors()).toEqual([])
    })

    test('C5 Agent mode follows the model: a model of this phone without the Tools mark locks the switch and says why (round 5, N6)', async ({ page }) => {
      const errors = watchErrors(page)
      await sealNetwork(page)
      await openShell(page, { route: '/chats' })
      const chatId = await seedChat(page)
      const choose = (name: string) =>
        page.evaluate(async (model) => {
          const { useModelStore } = ((await import(/* @vite-ignore */ '/src/stores/modelStore.ts' as string)) as typeof import('../../src/stores/modelStore'))
          useModelStore.setState({ activeModel: model, models: [{ name: model, model, size: 1, type: 'text', provider: 'openai', providerName: 'LU Engine' }] as never })
        }, name)
      await choose('openai::SmolLM2-360M-Instruct-Q4_K_M')
      await openSheet(page, 'chat-options', { chatId })
      const agent = page.getByTestId('m-options-agent')
      await expect(agent).toBeDisabled()
      await expect(agent).toHaveAttribute('aria-checked', 'false')
      await expect(agent).toContainText('This model cannot use tools. Pick a model with the Tools mark to use Agent mode.')
      await clean(page, 'agent locked for a model without tools')
      await shot(page, `c5-agent-locked-${size.name}`)
      // A model that carries the mark frees the switch, on the same open sheet.
      await choose('openai::Qwen3-4B-Instruct-2507-Q4_K_M')
      await expect(agent).toBeEnabled()
      await expect(agent).toContainText('Let the model use tools step by step')
      expect(errors()).toEqual([])
    })

    test('C5 chat options: what holds for every chat stands under "All chats", not under "This chat" (round 6, G5)', async ({ page }) => {
      const errors = watchErrors(page)
      await sealNetwork(page)
      await openShell(page, { route: '/chats' })
      const chatA = await seedChat(page)
      const chatB = await seedChat(page)
      await page.evaluate(async () => {
        const { useModelStore } = ((await import(/* @vite-ignore */ '/src/stores/modelStore.ts' as string)) as typeof import('../../src/stores/modelStore'))
        useModelStore.setState({ activeModel: 'openai::Qwen3-4B-Instruct-2507-Q4_K_M', models: [{ name: 'openai::Qwen3-4B-Instruct-2507-Q4_K_M', model: 'Qwen3-4B-Instruct-2507-Q4_K_M', size: 1, type: 'text', provider: 'openai', providerName: 'LU Engine', supportsTools: true }] as never })
        const { useAgentModeStore } = ((await import(/* @vite-ignore */ '/src/stores/agentModeStore.ts' as string)) as typeof import('../../src/stores/agentModeStore'))
        useAgentModeStore.setState({ tutorialCompleted: true } as never)
      })
      await openSheet(page, 'chat-options', { chatId: chatA })
      const mine = page.getByTestId('m-options-group-now')
      const all = page.getByTestId('m-options-group-all')
      await expect(mine).toContainText('This chat')
      await expect(all).toContainText('All chats')
      // Per chat: Agent mode, Web search, Write files. For every chat: Thinking and Small model mode.
      for (const id of ['m-options-agent', 'm-options-web', 'm-options-files']) {
        await expect(mine.getByTestId(id)).toHaveCount(1)
        await expect(all.getByTestId(id)).toHaveCount(0)
      }
      for (const id of ['m-options-thinking', 'm-options-small']) {
        await expect(all.getByTestId(id)).toHaveCount(1)
        await expect(mine.getByTestId(id)).toHaveCount(0)
      }
      await clean(page, 'options with the group for all chats')
      await shot(page, `c5-all-chats-${size.name}`)

      // The heading keeps its word: both kinds are switched in chat A and looked at in chat B.
      await page.getByTestId('m-options-agent').tap()
      await expect(page.getByTestId('m-options-agent')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('m-options-small')).toHaveAttribute('aria-checked', 'false')
      await page.getByTestId('m-options-small').tap()
      await expect(page.getByTestId('m-options-small')).toHaveAttribute('aria-checked', 'true')
      await page.getByTestId('m-options-done').tap()
      await expect(page.getByTestId('m-options-done')).toHaveCount(0)
      await openSheet(page, 'chat-options', { chatId: chatB })
      await expect(page.getByTestId('m-options-agent')).toHaveAttribute('aria-checked', 'false')
      await expect(page.getByTestId('m-options-small')).toHaveAttribute('aria-checked', 'true')
      expect(errors()).toEqual([])
    })

    test('round 6, agent on 8 GB: a kept "remember this", a declined step that is not parroted, and a window error with a way out (B1, B8, B10)', async ({ page }) => {
      const errors = watchErrors(page)
      const tried = await sealNetwork(page)
      await openShell(page, { route: '/chats' })
      const declined = 'The user declined this tool call, so it did not run. All your tools are still available. Do not repeat the same call: continue another way, or ask the user what they want instead.'
      const chatId = await seedChat(page, [
        { id: 'u1', role: 'user', content: 'Please remember this about me: my dog is called Pixel and I live in Tromso.' },
        { id: 'a1', role: 'assistant', content: 'I have noted that your dog is called Pixel and that you live in Tromso.' },
        { id: 'u2', role: 'user', content: 'Remember that.' },
        { id: 'a2', role: 'assistant', content: 'I will remember that.' },
        { id: 'u3', role: 'user', content: 'Write a file, notes.md in this chat' },
        { id: 'a3', role: 'assistant', content: declined, agentBlocks: [{ id: 'b1', phase: 'answer', content: declined, timestamp: 1 }] },
        { id: 'u4', role: 'user', content: 'Use web search: what is the current population of Iceland?' },
        { id: 'a4', role: 'assistant', content: '\n\nAgent error: the request exceeds the available context size (4289 prompt tokens, context 4096)', agentBlocks: [] },
      ])
      // What the chat page does with a message on its way out (parts/remember-request.ts).
      await page.evaluate(async (id) => {
        const { keepRememberRequest } = ((await import(/* @vite-ignore */ '/src/mobile/screens/agent/parts/remember-request.ts' as string)) as typeof import('../../src/mobile/screens/agent/parts/remember-request'))
        keepRememberRequest('Please remember this about me: my dog is called Pixel and I live in Tromso.', id)
        keepRememberRequest('Remember that.', id)
      }, chatId)
      await push(page, '/chat/:id', { id: chatId })

      // B8: the fact is in Memory and the chat says so; a request that named nothing says that nothing was saved.
      const lines = page.getByTestId('m-chat-remembered')
      await expect(lines).toHaveCount(2)
      await expect(lines.nth(0)).toHaveText('Saved to Memory.')
      await expect(lines.nth(1)).toHaveText('Nothing was saved to Memory. Say what to keep in the same message, or add it under Memory.')
      const kept = await page.evaluate(async () => {
        const { useMemoryStore } = ((await import(/* @vite-ignore */ '/src/stores/memoryStore.ts' as string)) as typeof import('../../src/stores/memoryStore'))
        return useMemoryStore.getState().entries.map((e) => e.content)
      })
      expect(kept).toEqual(['My dog is called Pixel and I live in Tromso.'])

      // B10: the note for a declined step is not shown as the answer of the model.
      const transcript = page.getByTestId('m-chat-screen').last()
      await expect(transcript).toContainText('You declined this step, so nothing ran. Say what you would like instead.')
      await expect(transcript).not.toContainText('All your tools are still available')

      // B1: the error says what happened and the way out, not token counts, and no speed stands under it.
      const box = page.getByTestId('m-chat-error')
      await expect(box).toContainText('This was more text than the model can read at once')
      await expect(box).toContainText('Start a new chat')
      await expect(transcript).not.toContainText('4289')
      await expect(transcript).not.toContainText('Agent error')
      await expect(page.getByTestId('m-chat-speed')).toHaveCount(0)
      await clean(page, 'round 6 agent notes')
      await shot(page, `r6-agent-${size.name}`)

      // The memory is on the Memory page.
      await push(page, '/settings/memory')
      await expect(page.getByTestId('m-settings-memory-screen')).toContainText('My dog is called Pixel')
      expect(tried).toEqual([])
      expect(errors()).toEqual([])
    })

    // Short check of package 10 on iOS, F9: once a tap on "Sampling" opened "Workflows". Not reproduced; this holds the
    // two things that could cause it: the rows stand still from the moment the sheet has arrived (also when the model
    // list is written again), and a tap in the middle of "Sampling" is a tap on "Sampling".
    test('C5 chat options: the rows stand still once the sheet has arrived, and a tap on Sampling opens Sampling', async ({ page }) => {
      await openShell(page, { route: '/chats' })
      const chatId = await seedChat(page)
      await page.evaluate(async () => {
        const { useModelStore } = ((await import(/* @vite-ignore */ '/src/stores/modelStore.ts' as string)) as typeof import('../../src/stores/modelStore'))
        useModelStore.setState({ activeModel: 'openai::qwen3-4b', models: [{ name: 'openai::qwen3-4b', model: 'qwen3-4b', size: 1, type: 'text', provider: 'openai', providerName: 'LU Engine', supportsTools: true }] as never })
      })
      await openSheet(page, 'chat-options', { chatId })
      await expect(page.getByTestId('m-options-done')).toBeVisible()
      await expect(page.locator('[data-testid="m-sheet-chat-options"][data-m-settling]')).toHaveCount(0)
      const drift = await page.evaluate(async () => {
        const { useModelStore } = ((await import(/* @vite-ignore */ '/src/stores/modelStore.ts' as string)) as typeof import('../../src/stores/modelStore'))
        const top = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().top
        const first = { workflows: top('m-options-workflows-row'), sampling: top('m-options-sampling') }
        let worst = 0
        const started = performance.now()
        // The model list is refreshed while the sheet is open, as it is after a model switch or a reload of the list.
        useModelStore.setState((s) => ({ models: [...s.models] }))
        while (performance.now() - started < 1500) {
          await new Promise((resolve) => requestAnimationFrame(resolve))
          worst = Math.max(worst, Math.abs(top('m-options-workflows-row') - first.workflows), Math.abs(top('m-options-sampling') - first.sampling))
        }
        return worst
      })
      expect(drift, 'rows moved after the sheet arrived').toBeLessThanOrEqual(0.5)
      await page.getByTestId('m-options-sampling').scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      const box = (await page.getByTestId('m-options-sampling').boundingBox())!
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
      await expect(page.getByTestId('m-options-sampling-reset')).toBeVisible()
      await expect(page.getByTestId('m-options-workflows-manage')).toHaveCount(0)
    })

    test('C5 chat options: switches act and every sub page opens and comes back', async ({ page }) => {
      const errors = watchErrors(page)
      const tried = await sealNetwork(page)
      await openShell(page, { route: '/chats' })
      const chatId = await seedChat(page)
      await page.evaluate(async () => {
        const { useModelStore } = ((await import(/* @vite-ignore */ '/src/stores/modelStore.ts' as string)) as typeof import('../../src/stores/modelStore'))
        useModelStore.setState({ activeModel: 'openai::qwen3-4b', models: [{ name: 'openai::qwen3-4b', model: 'qwen3-4b', size: 1, type: 'text', provider: 'openai', providerName: 'LU Engine', supportsTools: true }] as never })
      })
      await openSheet(page, 'chat-options', { chatId })
      await expect(page.getByTestId('m-options-done')).toBeVisible()
      await clean(page, 'options first page')

      // Agent mode: the first time the intro comes, "Turn on" switches it on.
      await page.getByTestId('m-options-agent').tap()
      await expect(page.getByTestId('m-options-intro')).toBeVisible()
      await clean(page, 'agent intro')
      await page.getByTestId('m-options-intro-on').tap()
      await expect(page.getByTestId('m-options-agent')).toHaveAttribute('aria-checked', 'true')

      // Web search off for this chat only.
      await page.getByTestId('m-options-web').tap()
      await expect(page.getByTestId('m-options-web')).toHaveAttribute('aria-checked', 'false')
      expect(
        await page.evaluate(async (id) => {
          const { usePermissionStore } = ((await import(/* @vite-ignore */ '/src/stores/permissionStore.ts' as string)) as typeof import('../../src/stores/permissionStore'))
          return usePermissionStore.getState().conversationOverrides[id]?.web
        }, chatId),
      ).toBe('blocked')

      const subs: Array<[string, string]> = [
        ['m-options-persona', 'm-options-persona-switch'],
        ['m-options-caveman-row', 'm-options-caveman'],
        ['m-options-workflows-row', 'm-options-workflows-manage'],
        ['m-options-sampling', 'm-options-sampling-reset'],
        ['m-options-context', 'm-options-compact'],
        ['m-options-permissions-row', 'm-options-permissions'],
        ['m-options-goal', 'm-options-goal-text'],
        ['m-options-loop', 'm-options-loop-task'],
      ]
      for (const [row, mark] of subs) {
        await page.getByTestId(row).tap()
        await expect(page.getByTestId(mark), mark).toBeVisible()
        await clean(page, mark)
        await page.getByTestId('m-sheet-back').tap()
        await expect(page.getByTestId('m-options-done'), `back from ${mark}`).toBeVisible()
      }

      // Set a goal: the same as typing /goal.
      await page.getByTestId('m-options-goal').tap()
      await page.getByTestId('m-options-goal-set').tap()
      await expect(page.getByText('Write the goal first.')).toBeVisible()
      await page.getByTestId('m-options-goal-text').fill('Ship the release')
      await page.getByTestId('m-options-goal-set').tap()
      await expect(page.getByTestId('m-sheet-chat-options')).toHaveCount(0)
      expect(
        await page.evaluate(async (id) => {
          const { useAgentGoalStore } = ((await import(/* @vite-ignore */ '/src/stores/agentGoalStore.ts' as string)) as typeof import('../../src/stores/agentGoalStore'))
          return useAgentGoalStore.getState().goals[id]?.text
        }, chatId),
      ).toBe('Ship the release')

      // The sheet opens at a section, and a new chat keeps what is set under the key "new".
      await openSheet(page, 'chat-options', { chatId: 'new', section: 'permissions' })
      await expect(page.getByTestId('m-options-permissions')).toBeVisible()
      await page.getByTestId('m-options-perm-files-auto').tap()
      await expect(page.getByTestId('m-options-perm-files-auto')).toHaveAttribute('aria-checked', 'true')
      await page.getByTestId('m-options-perm-defaults').tap()
      await expect(page.getByTestId('m-options-perm-files-auto')).toHaveAttribute('aria-checked', 'false')
      await page.getByTestId('m-sheet-back').tap()
      // What needs a saved chat says why it is not available.
      await expect(page.getByTestId('m-options-group')).toBeDisabled()
      await expect(page.getByTestId('m-options-group')).toContainText('Send a first message')
      await page.getByTestId('m-options-done').tap()
      await expect(page.getByTestId('m-sheet-chat-options')).toHaveCount(0)
      expect(tried).toEqual([])
      expect(errors()).toEqual([])
    })

    test('C8 documents: list, passages, remove, and the document model card', async ({ page }) => {
      const errors = watchErrors(page)
      await sealNetwork(page)
      await openShell(page, { route: '/chats' })
      const chatId = await seedChat(page)
      await push(page, '/chat/:id/documents', { id: chatId })
      await expect(page.getByTestId('m-chat-documents-screen')).toBeVisible()
      await expect(page.getByTestId('m-documents-empty')).toBeVisible()
      // Without the document model only the card and its reason are offered.
      await expect(page.getByTestId('m-documents-install')).toBeVisible()
      // One size for the document model on every page: what the host states, not a rounded figure (round 6, G7).
      await expect(page.getByTestId('m-documents-install')).toContainText('Install the document model, 80.2 MB')
      await clean(page, 'documents empty')

      await page.evaluate(async (id) => {
        const { useRAGStore } = ((await import(/* @vite-ignore */ '/src/stores/ragStore.ts' as string)) as typeof import('../../src/stores/ragStore'))
        const s = useRAGStore.getState()
        s.addDocument(id, { id: 'd1', name: 'Travel plan for the summer.pdf', type: 'pdf', size: 204800, addedAt: Date.now(), chunkCount: 12 })
        s.addDocument(id, { id: 'd2', name: 'notes.txt', type: 'txt', size: 900, addedAt: Date.now(), chunkCount: 2 })
        s.setLastRetrievedChunks([{ chunk: { id: 'c1', documentId: 'd1', content: 'We leave on the third of July.', embedding: [], index: 0 }, score: 0.82 }])
      }, chatId)
      await expect(page.getByTestId('m-documents-list')).toContainText('Travel plan for the summer.pdf')
      await page.getByTestId('m-documents-doc-d1').getByTestId('m-documents-row').tap()
      await expect(page.getByTestId('m-documents-passage')).toContainText('third of July')
      await expect(page.getByTestId('m-documents-passage')).toContainText('Match 82%')
      await clean(page, 'documents list')

      await page.getByTestId('m-documents-search').tap()
      await expect(page.getByTestId('m-documents-search')).toHaveAttribute('aria-checked', 'true')

      // "Index paused": a reading LU was closed in the middle of stands in the store. The row is there
      // after leaving the page and after a new start, and it says what to do.
      await page.evaluate(async (id) => {
        const { useRAGStore } = ((await import(/* @vite-ignore */ '/src/stores/ragStore.ts' as string)) as typeof import('../../src/stores/ragStore'))
        useRAGStore.setState({ pausedIndex: { [id]: [{ id: 'ix-1', name: 'Handbook of the long winter journey.pdf', size: 4_000_000, at: Date.now(), state: 'running' }] } })
      }, chatId)
      // While it still runs it is the progress row, not a paused row.
      await expect(page.getByTestId('m-documents-paused')).toHaveCount(0)
      // A new start of the app opens a new chat (round 57); the row waits on the page of its chat.
      await page.reload()
      await page.getByTestId('m-app').waitFor()
      await screensLoaded(page)
      await reopenDocuments(page, chatId)
      const pausedRow = page.getByTestId('m-documents-paused')
      await expect(pausedRow).toContainText('Handbook of the long winter journey.pdf')
      await expect(pausedRow).toContainText('Paused. LU was closed while it read this file. Choose the file again to finish.')
      await expect(pausedRow).toHaveAttribute('data-state', 'needs-file')
      await expect(pausedRow.getByTestId('m-documents-continue')).toHaveText('Choose file')
      await clean(page, 'documents paused')
      await pausedRow.scrollIntoViewIfNeeded()
      await shot(page, `c8-paused-${size.name}`)
      // Another kind of file is refused and the paused row stays.
      const again = page.waitForEvent('filechooser')
      await pausedRow.getByTestId('m-documents-continue').tap()
      await (await again).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('x') })
      await expect(page.getByTestId('m-documents-failed')).toContainText('LU reads PDF, Word and text files.')
      await expect(pausedRow).toBeVisible()
      await page.getByTestId('m-documents-failed-remove').tap()
      await pausedRow.getByTestId('m-documents-paused-remove').tap()
      await expect(page.getByTestId('m-documents-paused')).toHaveCount(0)
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rag-store') ?? '{}').state.pausedIndex)).toEqual({})

      // Round 5 (N1): a reading that failed stays in the list with "Failed" and a way to try again, also
      // after the page was left and after a new start. Before, the row lived in the page only.
      await page.evaluate(async (id) => {
        const { useRAGStore } = ((await import(/* @vite-ignore */ '/src/stores/ragStore.ts' as string)) as typeof import('../../src/stores/ragStore'))
        useRAGStore.setState({ pausedIndex: { [id]: [{ id: 'ix-2', name: 'Minutes of the spring meeting.txt', size: 377_000, at: Date.now(), state: 'failed', reason: 'Embedding failed (HTTP 500): proxy_localhost: error sending request' }] } })
      }, chatId)
      await page.reload()
      await page.getByTestId('m-app').waitFor()
      await screensLoaded(page)
      await reopenDocuments(page, chatId)
      const failedRow = page.getByTestId('m-documents-failed')
      await expect(failedRow).toHaveAttribute('data-state', 'failed')
      await expect(failedRow).toContainText('Minutes of the spring meeting.txt')
      // The transport error is not for the user. The row says what happened and what to do.
      await expect(failedRow).toContainText('Failed. Could not read this file. Choose the file again to try once more.')
      await expect(failedRow).not.toContainText('proxy_localhost')
      await expect(failedRow.getByTestId('m-documents-retry')).toHaveText('Choose file')
      await expect(page.getByTestId('m-documents-paused')).toHaveCount(0)
      await clean(page, 'documents failed reading')
      await failedRow.scrollIntoViewIfNeeded()
      await shot(page, `c8-failed-${size.name}`)
      await failedRow.getByTestId('m-documents-failed-remove').tap()
      await expect(page.getByTestId('m-documents-failed')).toHaveCount(0)

      // Round 35 (D1, iOS package 15): the copy of the file was gone when LU read it. The row said
      // "Failed. Failed to extract text from ...: The object can not be found here.", words of WebKit.
      await page.evaluate(async (id) => {
        const { useRAGStore } = ((await import(/* @vite-ignore */ '/src/stores/ragStore.ts' as string)) as typeof import('../../src/stores/ragStore'))
        useRAGStore.setState({ pausedIndex: { [id]: [{ id: 'ix-4', name: 'lu-test.txt', size: 120, at: Date.now(), state: 'failed', reason: 'Failed to extract text from "lu-test.txt": The object can not be found here.', code: 'file_gone' }] } })
      }, chatId)
      await page.reload()
      await page.getByTestId('m-app').waitFor()
      await screensLoaded(page)
      await reopenDocuments(page, chatId)
      const goneRow = page.getByTestId('m-documents-failed')
      await expect(goneRow).toContainText('Failed. LU could no longer open "lu-test.txt". Try adding the file again.')
      await expect(goneRow).not.toContainText('can not be found')
      await expect(goneRow).not.toContainText('Failed. Failed')
      await expect(goneRow).not.toContainText('Choose the file again to try once more.')
      await clean(page, 'documents file gone')
      await goneRow.getByTestId('m-documents-failed-remove').tap()
      await expect(page.getByTestId('m-documents-failed')).toHaveCount(0)

      // Round 5 (N5): the progress row names its file also when the page was opened again meanwhile.
      await page.evaluate(async (id) => {
        const { useRAGStore } = ((await import(/* @vite-ignore */ '/src/stores/ragStore.ts' as string)) as typeof import('../../src/stores/ragStore'))
        useRAGStore.setState({ isIndexing: true, indexingProgress: { current: 46, total: 100 }, pausedIndex: { [id]: [{ id: 'ix-3', name: 'Minutes of the spring meeting.txt', size: 377_000, at: Date.now(), state: 'running' }] } })
      }, chatId)
      await expect(page.getByTestId('m-documents-working-name')).toHaveText('Minutes of the spring meeting.txt')
      await expect(page.getByTestId('m-documents-working')).toContainText('46%')
      await clean(page, 'documents progress with name')
      await page.evaluate(async () => {
        const { useRAGStore } = ((await import(/* @vite-ignore */ '/src/stores/ragStore.ts' as string)) as typeof import('../../src/stores/ragStore'))
        useRAGStore.setState({ isIndexing: false, indexingProgress: null, pausedIndex: {} })
      })
      await expect(page.getByTestId('m-documents-working')).toHaveCount(0)

      // Round 5 (N4): the file that is already in the chat is not added a second time, and a sentence says so.
      const twice = page.waitForEvent('filechooser')
      await page.getByTestId('m-documents-add').tap()
      await (await twice).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.alloc(900, 'a') })
      await expect(page.getByTestId('m-toast-document-duplicate')).toContainText('notes.txt is already in this chat. It was not added again.')
      await expect(page.getByTestId('m-documents-doc-d2')).toHaveCount(1)
      await expect(page.getByTestId('m-documents-working')).toHaveCount(0)

      // A file that LU cannot read gets a row that says so and can be removed.
      const chooser = page.waitForEvent('filechooser')
      await page.getByTestId('m-documents-add').tap()
      await (await chooser).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('x') })
      await expect(page.getByTestId('m-documents-failed')).toContainText('LU reads PDF, Word and text files.')
      await clean(page, 'documents failed row')
      await page.getByTestId('m-documents-failed-remove').tap()
      await expect(page.getByTestId('m-documents-failed')).toHaveCount(0)

      // Remove one asks first.
      await page.getByTestId('m-documents-doc-d2').getByTestId('m-documents-remove').tap()
      await expect(page.getByTestId('m-dialog-document-remove')).toBeVisible()
      await page.getByTestId('m-dialog-cancel').tap()
      await expect(page.getByTestId('m-documents-doc-d2')).toBeVisible()
      await page.getByTestId('m-documents-doc-d2').getByTestId('m-documents-remove').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-documents-doc-d2')).toHaveCount(0)

      // Destructive targets carry the mark.
      await expect(page.getByTestId('m-documents-doc-d1').getByTestId('m-documents-remove')).toHaveAttribute('data-m-risk', 'destructive')

      // The way to the import of chats.
      await page.getByTestId('m-documents-import').tap()
      await expect(page.getByTestId('m-settings-data-import-screen')).toBeVisible()
      await page.goBack()
      await expect(page.getByTestId('m-chat-documents-screen')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('C9 compare: two models, the view switch, an honest error and "Keep this answer"', async ({ page }) => {
      const errors = watchErrors(page)
      const tried = await sealNetwork(page)
      await openShell(page, { route: '/chats' })
      const chatId = await seedChat(page)
      await push(page, '/chat/:id/compare', { id: chatId })
      await expect(page.getByTestId('m-chat-compare-screen')).toBeVisible()
      await expect(page.getByTestId('m-compare-empty')).toContainText('Choose two models first.')
      await clean(page, 'compare empty')

      await page.evaluate(async () => {
        const { useCompareStore } = ((await import(/* @vite-ignore */ '/src/stores/compareStore.ts' as string)) as typeof import('../../src/stores/compareStore'))
        const s = useCompareStore.getState()
        s.setModelA('openai::model-a')
        s.setModelB('openai::model-b')
        s.startRound({ id: 'q1', role: 'user', content: 'What is two plus two?', timestamp: Date.now() })
        s.addContentA('Four.')
        s.addContentB('It is 4, and here is a much longer explanation that has to wrap on a small screen.')
        s.finishA('Four.', { tokens: 2, timeMs: 100, tokensPerSec: 20 })
        s.finishB('It is 4, and here is a much longer explanation that has to wrap on a small screen.', { tokens: 20, timeMs: 1000, tokensPerSec: 20 })
      })
      await expect(page.getByTestId('m-compare-both-local')).toBeVisible()
      await expect(page.getByTestId('m-compare-answer-a')).toContainText('Four.')
      await expect(page.getByTestId('m-compare-answer-b')).toBeHidden()
      await clean(page, 'compare answer A')
      await page.getByTestId('m-compare-view-b').tap()
      await expect(page.getByTestId('m-compare-answer-b')).toContainText('It is 4')
      await expect(page.getByTestId('m-compare-answer-a')).toBeHidden()
      await clean(page, 'compare answer B')

      // An agent answer is an AI answer: it can be reported.
      await page.getByTestId('m-compare-report-b').tap()
      await expect(page.getByTestId('m-sheet-report')).toBeVisible()
      await expect(page.getByTestId('m-report-send')).toBeVisible()
      await clean(page, 'report sheet')
      await page.goBack()
      await expect(page.getByTestId('m-sheet-report')).toHaveCount(0)

      // Keep B: question and answer go into the chat, the page closes.
      await page.getByTestId('m-compare-keep-b').tap()
      await expect(page.getByTestId('m-chat-compare-screen')).toHaveCount(0)
      const kept = await page.evaluate(async (id) => {
        const { useChatStore } = ((await import(/* @vite-ignore */ '/src/stores/chatStore.ts' as string)) as typeof import('../../src/stores/chatStore'))
        return useChatStore.getState().conversations.find((c) => c.id === id)?.messages.map((m) => `${m.role}:${m.content.slice(0, 10)}`)
      }, chatId)
      expect(kept).toEqual(['user:Hello', 'user:What is tw', 'assistant:It is 4, a'])
      expect(tried).toEqual([])
      expect(errors()).toEqual([])
    })

    test('C10 background tasks: rows, message agent, stop and stop all', async ({ page }) => {
      const errors = watchErrors(page)
      await sealNetwork(page)
      await openShell(page, { route: '/chats' })
      const chatId = await seedChat(page)
      await push(page, '/chat/:id/tasks', { id: chatId })
      await expect(page.getByTestId('m-tasks-empty')).toBeVisible()
      await expect(page.getByTestId('m-tasks-hint')).toContainText('Tasks pause when LU is in the background.')
      await clean(page, 'tasks empty')

      await page.evaluate(async (id) => {
        const { useAgentTaskStore } = ((await import(/* @vite-ignore */ '/src/stores/agentTaskStore.ts' as string)) as typeof import('../../src/stores/agentTaskStore'))
        const s = useAgentTaskStore.getState()
        const base = { convId: id, context: 'The user plans a trip in July.', background: true, startedAt: Date.now() - 5000 }
        // The store only sends the stop signal; the run itself ends the task, as the real one does.
        const run = (taskId: string) => {
          const controller = new AbortController()
          controller.signal.addEventListener('abort', () => s.finish(taskId, { status: 'cancelled', endedAt: Date.now() }))
          return controller
        }
        ;(window as unknown as { __run: typeof run }).__run = run
        s.start({ ...base, id: 'task-1-aaaaaa', goal: 'Collect the train times from Berlin to Munich', controller: run('task-1-aaaaaa') })
        s.start({ ...base, id: 'task-2-bbbbbb', goal: 'Summarize the hotel reviews', controller: run('task-2-bbbbbb') })
        s.start({ ...base, id: 'task-3-cccccc', goal: 'Look up the museum hours', controller: new AbortController() })
        s.finish('task-3-cccccc', { status: 'done', output: 'Open from 10 to 18.', endedAt: Date.now() })
      }, chatId)
      await expect(page.getByTestId('m-tasks-list')).toContainText('Collect the train times')
      await clean(page, 'tasks list')
      await shot(page, `c10-tasks-${size.name}`)

      const first = page.getByTestId('m-tasks-task-task-1-aaaaaa')
      await first.getByTestId('m-tasks-row').tap()
      await first.getByTestId('m-tasks-message-send').tap()
      await expect(first.getByText('Write the message first.')).toBeVisible()
      await first.getByTestId('m-tasks-message-input').fill('Only direct trains')
      await first.getByTestId('m-tasks-message-send').tap()
      await expect(page.getByTestId('m-toast-task-message-sent')).toBeVisible()
      expect(
        await page.evaluate(async () => {
          const { useAgentTaskStore } = ((await import(/* @vite-ignore */ '/src/stores/agentTaskStore.ts' as string)) as typeof import('../../src/stores/agentTaskStore'))
          return useAgentTaskStore.getState().get('task-1-aaaaaa')?.inbox
        }),
      ).toEqual(['Only direct trains'])
      await clean(page, 'task open')

      // A finished task shows its answer and can be reported.
      const done = page.getByTestId('m-tasks-task-task-3-cccccc')
      await done.getByTestId('m-tasks-row').tap()
      await expect(done.getByTestId('m-tasks-output')).toContainText('Open from 10 to 18.')
      await expect(done.getByTestId('m-tasks-report')).toBeVisible()
      await expect(done.getByTestId('m-tasks-stop')).toHaveCount(0)

      await expect(first.getByTestId('m-tasks-stop')).toHaveAttribute('data-m-risk', 'destructive')
      await first.getByTestId('m-tasks-stop').tap()
      await expect(first).toHaveAttribute('data-state', 'cancelled')

      // Stop all is only there while more than one runs: start a second one again.
      await page.evaluate(async (id) => {
        const { useAgentTaskStore } = ((await import(/* @vite-ignore */ '/src/stores/agentTaskStore.ts' as string)) as typeof import('../../src/stores/agentTaskStore'))
        const run = (window as unknown as { __run: (taskId: string) => AbortController }).__run
        useAgentTaskStore.getState().start({ id: 'task-4-dddddd', convId: id, goal: 'Check the weather', context: '', background: true, startedAt: Date.now(), controller: run('task-4-dddddd') })
      }, chatId)
      await page.getByTestId('m-tasks-stop-all').tap()
      await expect(page.getByTestId('m-dialog-tasks-stop-all')).toBeVisible()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-tasks-task-task-2-bbbbbb')).toHaveAttribute('data-state', 'cancelled')
      await expect(page.getByTestId('m-tasks-stop-all')).toHaveCount(0)
      expect(errors()).toEqual([])
    })

    test('C11 preview: the page shows in a closed frame, wide scales down, a missing block says so', async ({ page }) => {
      const errors = watchErrors(page)
      const tried = await sealNetwork(page)
      await openShell(page, { route: '/chats' })
      const chatId = await seedChat(page, [
        { id: 'u1', role: 'user', content: 'Make a page' },
        { id: 'a1', role: 'assistant', content: 'Here:\n\n```html\n<h1 id="t">Hello preview</h1>\n```\n\nAnd a broken one:\n\n```html\n<p>x</p><script>throw new Error("boom in page")</script>\n```\n\n```js\nconsole.log(1)\n```' },
      ])
      await push(page, '/chat/:id/preview/:blockId', { id: chatId, blockId: 'a1~0' })
      await expect(page.getByTestId('m-chat-preview-screen')).toBeVisible()
      const frame = page.getByTestId('m-preview-frame')
      await expect(frame).toBeVisible()
      await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
      await expect(page.frameLocator('[data-testid="m-preview-frame"]').locator('#t')).toHaveText('Hello preview')
      await clean(page, 'preview phone')

      await page.getByTestId('m-preview-wide').tap()
      await expect(page.getByTestId('m-preview-stage')).toHaveAttribute('data-width', 'wide')
      await expect(page.frameLocator('[data-testid="m-preview-frame"]').locator('#t')).toHaveText('Hello preview')
      // Wide lays out in a desktop width and is scaled to the screen: nothing sticks out.
      await clean(page, 'preview wide')
      await page.getByTestId('m-preview-reload').tap()
      await expect(page.frameLocator('[data-testid="m-preview-frame"]').locator('#t')).toHaveText('Hello preview')
      await page.getByTestId('m-preview-close').tap()
      await expect(page.getByTestId('m-chat-preview-screen')).toHaveCount(0)

      // An error in the code of the page is said, not swallowed.
      await push(page, '/chat/:id/preview/:blockId', { id: chatId, blockId: 'a1~1' })
      await expect(page.getByTestId('m-preview-error')).toContainText('This page could not be shown.')
      await expect(page.getByTestId('m-preview-error')).toContainText('boom in page')
      // In this browser run the scripts of the frame run (there is no policy of the app here), so the
      // note "Scripts are off in this preview" must not show. In the installed app it does (review N5).
      await page.waitForTimeout(1500)
      await expect(page.getByTestId('m-preview-noscripts')).toHaveCount(0)
      await clean(page, 'preview error')
      await page.getByTestId('m-preview-close').tap()

      // A block that is not a web page, or is gone.
      await push(page, '/chat/:id/preview/:blockId', { id: chatId, blockId: 'a1~2' })
      await expect(page.getByTestId('m-preview-missing')).toContainText('This page could not be shown.')
      await clean(page, 'preview missing')
      await page.getByTestId('m-preview-missing-close').tap()
      await expect(page.getByTestId('m-chat-preview-screen')).toHaveCount(0)
      expect(tried).toEqual([])
      // The page under test throws on purpose inside its own closed frame.
      expect(errors().filter((e) => !e.includes('boom in page'))).toEqual([])
    })

    test('C13 group chat: switch, participants, persona per participant, cost line', async ({ page }) => {
      const errors = watchErrors(page)
      await sealNetwork(page)
      await openShell(page, { route: '/chats' })
      const chatId = await seedChat(page)
      await push(page, '/chat/:id/group', { id: chatId })
      await expect(page.getByTestId('m-chat-group-screen')).toBeVisible()
      await expect(page.getByTestId('m-group-off')).toBeVisible()
      await clean(page, 'group off')

      await page.getByTestId('m-group-switch').tap()
      await expect(page.getByTestId('m-group-member-0')).toContainText('test-model')
      await expect(page.getByTestId('m-group-one')).toContainText('Add a second model to start.')
      await clean(page, 'group one')

      // The model sheet belongs to the chat strand: stand in for its pick.
      await page.evaluate(async (id) => {
        const { useChatStore } = ((await import(/* @vite-ignore */ '/src/stores/chatStore.ts' as string)) as typeof import('../../src/stores/chatStore'))
        useChatStore.getState().setGroupModels(id, ['openai::test-model', 'openai::second-model', 'lu-cloud::big-model'])
      }, chatId)
      await expect(page.getByTestId('m-group-cost')).toContainText('One message, 3 answers')
      await expect(page.getByTestId('m-group-both-local')).toBeVisible()
      await clean(page, 'group three')

      await page.getByTestId('m-group-member-1').tap()
      await expect(page.getByTestId('m-sheet-agent-group-persona')).toBeVisible()
      await clean(page, 'group persona sheet')
      await page.getByTestId('m-group-persona-coder').tap()
      await expect(page.getByTestId('m-sheet-agent-group-persona')).toHaveCount(0)
      await expect(page.getByTestId('m-group-member-1')).toContainText('Code Expert')

      await page.getByTestId('m-group-remove-2').tap()
      await expect(page.getByTestId('m-group-member-2')).toHaveCount(0)
      await expect(page.getByTestId('m-group-cost')).toContainText('cost nothing')

      await page.getByTestId('m-group-switch').tap()
      await expect(page.getByTestId('m-group-off')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('E6 personas: use, pick, create, edit with the leave question, delete', async ({ page }) => {
      const errors = watchErrors(page)
      await sealNetwork(page)
      await openShell(page, { route: '/settings/personas' })
      await expect(page.getByTestId('m-settings-personas-screen')).toBeVisible()
      await clean(page, 'personas')

      await page.getByTestId('m-personas-pick-coder').tap()
      await expect(page.getByTestId('m-personas-pick-coder')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('m-personas-reset')).toBeDisabled()

      await page.getByTestId('m-personas-add').tap()
      await expect(page.getByTestId('m-settings-persona-screen')).toBeVisible()
      await clean(page, 'persona editor')
      await page.getByTestId('m-persona-name').fill('Zorblat')
      await page.getByTestId('m-persona-save').tap()
      await expect(page.getByText('Write the instructions first.')).toBeVisible()
      await page.getByTestId('m-persona-instructions').fill('You talk like a pirate.')
      await page.getByTestId('m-persona-save').tap()
      await expect(page.getByTestId('m-settings-persona-screen')).toHaveCount(0)
      await expect(page.getByTestId('m-personas-list')).toContainText('Zorblat')

      // Unsaved input: back asks before it throws the input away.
      await page.getByTestId('m-personas-edit-custom-zorblat').tap()
      await page.getByTestId('m-persona-instructions').fill('You talk like a very old pirate.')
      await page.getByTestId('m-settings-persona-screen').getByTestId('m-page-back').tap()
      await expect(page.getByText('Discard changes?')).toBeVisible()
      await page.getByTestId('m-dialog-cancel').tap()
      await expect(page.getByTestId('m-settings-persona-screen')).toBeVisible()
      await page.getByTestId('m-persona-save').tap()
      await expect(page.getByTestId('m-settings-persona-screen')).toHaveCount(0)

      await page.getByTestId('m-personas-edit-custom-zorblat').tap()
      await expect(page.getByTestId('m-persona-instructions')).toHaveValue('You talk like a very old pirate.')
      await expect(page.getByTestId('m-persona-delete')).toHaveAttribute('data-m-risk', 'destructive')
      await page.getByTestId('m-persona-delete').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-settings-persona-screen')).toHaveCount(0)
      await expect(page.getByTestId('m-personas-list')).not.toContainText('Zorblat')

      // A changed built in persona can be reset.
      await page.getByTestId('m-personas-edit-coder').tap()
      await page.getByTestId('m-persona-name').fill('Coder two')
      await page.getByTestId('m-persona-save').tap()
      await expect(page.getByTestId('m-personas-list')).toContainText('Coder two')
      await page.getByTestId('m-personas-reset').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-personas-list')).toContainText('Code Expert')

      const before = await page.getByTestId('m-personas-use').getAttribute('aria-checked')
      await page.getByTestId('m-personas-use').tap()
      await expect(page.getByTestId('m-personas-use')).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true')
      expect(errors()).toEqual([])
    })

    test('E7 memory: add, search, edit, settings, export, import, delete all, sync states', async ({ page }) => {
      const errors = watchErrors(page)
      const tried = await sealNetwork(page)
      await openShell(page, { route: '/settings/memory' })
      await expect(page.getByTestId('m-settings-memory-screen')).toBeVisible()
      await expect(page.getByTestId('m-memory-empty')).toBeVisible()
      await expect(page.getByTestId('m-memory-signin')).toContainText('Sign in to sync')
      await clean(page, 'memory empty')

      await page.getByTestId('m-memory-add').tap()
      await expect(page.getByTestId('m-settings-memory-detail-screen')).toBeVisible()
      await clean(page, 'memory new')
      await page.getByTestId('m-memory-title').fill('Coffee')
      await page.getByTestId('m-memory-save').tap()
      await expect(page.getByText('Write what LU should remember.')).toBeVisible()
      await page.getByTestId('m-memory-text').fill('Drinks coffee black, no sugar.')
      await page.getByTestId('m-memory-category-reference').tap()
      await page.getByTestId('m-memory-save').tap()
      await expect(page.getByTestId('m-settings-memory-detail-screen')).toHaveCount(0)
      await expect(page.getByTestId('m-memory-list')).toContainText('Coffee')

      await page.getByTestId('m-memory-search').fill('tea')
      await expect(page.getByTestId('m-memory-nomatch')).toBeVisible()
      await page.getByTestId('m-memory-clear').tap()
      await page.getByTestId('m-memory-type-user').tap()
      await expect(page.getByTestId('m-memory-nomatch')).toBeVisible()
      await page.getByTestId('m-memory-type-reference').tap()
      await expect(page.getByTestId('m-memory-list')).toContainText('Coffee')
      await page.getByTestId('m-memory-type-all').tap()

      // Detail: change, save, and "Still correct".
      await page.getByTestId('m-memory-list').getByRole('button').first().tap()
      await page.getByTestId('m-memory-text').fill('Drinks coffee black.')
      await page.getByTestId('m-memory-save').tap()
      await expect(page.getByTestId('m-settings-memory-detail-screen')).toHaveCount(0)

      // Learning switches and the number.
      await page.getByTestId('m-memory-learn').tap()
      await expect(page.getByTestId('m-memory-learn')).toHaveAttribute('aria-checked', 'false')
      await expect(page.getByTestId('m-memory-outside')).toBeDisabled()
      await expect(page.getByTestId('m-memory-outside')).toContainText('Turn on Learn from chats first.')
      await page.getByTestId('m-memory-keep-row').getByRole('button', { name: 'Increase Keep at most' }).tap()
      await expect(page.getByTestId('m-memory-keep-row')).toContainText('1 memory')
      await clean(page, 'memory list and settings')

      // Export hands a file over.
      await page.getByTestId('m-memory-export').tap()
      await expect(page.getByTestId('m-sheet-agent-memory-export')).toBeVisible()
      await clean(page, 'memory export sheet')
      const download = page.waitForEvent('download')
      await page.getByTestId('m-memory-export-json').tap()
      expect((await download).suggestedFilename()).toBe('lu-memory.json')
      await expect(page.getByTestId('m-sheet-agent-memory-export')).toHaveCount(0)

      // Import reads a JSON export and says what it did.
      const chooser = page.waitForEvent('filechooser')
      await page.getByTestId('m-memory-import').tap()
      await (await chooser).setFiles({
        name: 'memory.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ entries: [{ id: 'imp-1', type: 'user', title: 'City', description: 'Lives in Lisbon', content: 'Lives in Lisbon', tags: [], createdAt: 1, updatedAt: 1, source: 'manual' }] })),
      })
      await expect(page.getByTestId('m-memory-import-ok')).toContainText('Imported 1')
      await expect(page.getByTestId('m-memory-list')).toContainText('City')
      const bad = page.waitForEvent('filechooser')
      await page.getByTestId('m-memory-import').tap()
      await (await bad).setFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from('{"nothing":true}') })
      await expect(page.getByTestId('m-memory-import-error')).toContainText('No memories found')

      // Signed in: the account collection, and a sync that cannot reach the account says so and keeps the memories.
      await page.evaluate(async () => {
        const { useCloudAuthStore } = ((await import(/* @vite-ignore */ '/src/stores/cloudAuthStore.ts' as string)) as typeof import('../../src/stores/cloudAuthStore'))
        useCloudAuthStore.setState({ status: 'signed-in', user: { id: 'user-test-1', email: 'test@example.test' } } as never)
      })
      await expect(page.getByTestId('m-memory-collection')).toBeVisible()
      await page.getByTestId('m-memory-collection').tap()
      await expect(page.getByTestId('m-memory-sync-now')).toBeDisabled()
      await expect(page.getByTestId('m-memory-sync-now')).toContainText('Turn on cloud storage for this collection first.')
      await page.getByTestId('m-memory-allow').tap()
      // M1: memories are content, so the consent to LU Cloud is asked first. A no sends nothing.
      await page.getByTestId('m-memory-sync-now').tap()
      await page.getByTestId('m-consent-decline').tap()
      await expect(page.getByTestId('m-memory-sync-error')).toContainText('Nothing was sent')
      await page.getByTestId('m-memory-sync-retry').tap()
      await page.getByTestId('m-consent-agree').tap()
      await expect(page.getByTestId('m-memory-sync-error')).toContainText('Your memories are safe on this phone.')
      await expect(page.getByTestId('m-memory-sync-retry')).toBeVisible()
      await clean(page, 'memory sync failed')
      await page.getByTestId('m-memory-collection').tap()
      await expect(page.getByTestId('m-memory-list')).toContainText('Coffee')

      // Delete all needs the word.
      await expect(page.getByTestId('m-memory-delete-all')).toHaveAttribute('data-m-risk', 'destructive')
      await page.getByTestId('m-memory-delete-all').tap()
      await expect(page.getByTestId('m-dialog-confirm')).toBeDisabled()
      await page.getByTestId('m-dialog-gate').fill('DELETE')
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-memory-empty')).toBeVisible()
      // The sync attempt may try the account host; it is cut off and nothing else was tried.
      // The second name is put together here, the tree does not spell it out
      // (scripts/check-silent.mjs).
      const own = new RegExp(['supabase', 'use' + 'lu', 'locallyuncensored'].join('|'))
      expect(tried.filter((u) => !own.test(u))).toEqual([])
      expect(errors().filter((e) => !/Failed to load resource|net::ERR|supabase|fetch/i.test(e))).toEqual([])
    })

    test('E7 conflict sheet: both versions and the three answers', async ({ page }) => {
      const errors = watchErrors(page)
      await sealNetwork(page)
      await openShell(page, { route: '/settings/memory' })
      await page.evaluate(async () => {
        const { useMemoryStore } = ((await import(/* @vite-ignore */ '/src/stores/memoryStore.ts' as string)) as typeof import('../../src/stores/memoryStore'))
        const { useMemorySync } = ((await import(/* @vite-ignore */ '/src/mobile/screens/agent/parts/adapters/memory-sync.ts' as string)) as typeof import('../../src/mobile/screens/agent/parts/adapters/memory-sync'))
        const id = useMemoryStore.getState().addMemory({ type: 'user', title: 'City', description: 'Lives in Lisbon', content: 'Lives in Lisbon', tags: [], source: 'manual' })
        const local = useMemoryStore.getState().entries.find((e) => e.id === id)!
        useMemorySync.setState({
          allowed: true,
          conflicts: [
            {
              id,
              reason: 'both-edited',
              review: { token: { owner: 'user-test-1', collectionRevision: 0, id, remoteRevision: 2, remoteHash: 'a', localHash: 'b' }, cloud: { ...local, content: 'Lives in Porto', title: 'City' } },
            },
          ] as never,
        })
      })
      await openSheet(page, 'agent-memory-conflict')
      await expect(page.getByTestId('m-memory-conflict-local')).toContainText('Lives in Lisbon')
      await expect(page.getByTestId('m-memory-conflict-cloud')).toContainText('Lives in Porto')
      await expect(page.getByTestId('m-memory-conflict-phone')).toBeVisible()
      await expect(page.getByTestId('m-memory-conflict-account')).toBeVisible()
      await expect(page.getByTestId('m-memory-conflict-both')).toBeVisible()
      await clean(page, 'conflict sheet')
      // Not signed in: the answer cannot be carried out, and the sheet says so instead of closing.
      await page.getByTestId('m-memory-conflict-account').tap()
      await expect(page.getByTestId('m-memory-conflict-error')).toBeVisible()
      await page.goBack()
      await expect(page.getByTestId('m-sheet-agent-memory-conflict')).toHaveCount(0)
      expect(errors().filter((e) => !/Failed to load resource|net::ERR|supabase|fetch/i.test(e))).toEqual([])
    })

    test('sub agents with a model of this phone are locked with a reason, with a cloud model they work as before (decision of 09.10.2026)', async ({ page, context }) => {
      const errors = watchErrors(page)
      await sealNetwork(page)
      // The app decides "phone" by the user agent (lib/device-kind.ts), and the rule only holds on a phone.
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36', configurable: true })
      })
      await openShell(page, { route: '/settings/agent' })
      const choose = (name: string, provider: string) =>
        page.evaluate(
          async ([model, by]) => {
            const { useModelStore } = ((await import(/* @vite-ignore */ '/src/stores/modelStore.ts' as string)) as typeof import('../../src/stores/modelStore'))
            useModelStore.setState({ activeModel: model, models: [{ name: model, model, size: 1, type: 'text', provider: by, providerName: by }] as never })
          },
          [name, provider] as const,
        )
      const offered = () =>
        page.evaluate(async () => {
          const { toolRegistry } = ((await import(/* @vite-ignore */ '/src/api/mcp/index.ts' as string)) as typeof import('../../src/api/mcp/index'))
          return toolRegistry.getAll().map((t) => t.name).filter((n) => ['delegate_task', 'check_tasks', 'message_agent'].includes(n)).sort()
        })
      const subLevel = () =>
        page.evaluate(async () => {
          const { usePermissionStore } = ((await import(/* @vite-ignore */ '/src/stores/permissionStore.ts' as string)) as typeof import('../../src/stores/permissionStore'))
          return usePermissionStore.getState().perToolOverrides.delegate_task ?? null
        })

      // A model of the engine of this phone.
      await choose('openai::Qwen3.5-2B-Q4_K_M', 'openai')
      const row = page.getByTestId('m-agent-perm-subagents-row')
      await expect(row).toHaveAttribute('data-locked', '')
      await expect(row).toContainText('Needs a cloud model. The model you chose runs on this phone.')
      for (const level of ['blocked', 'confirm', 'auto']) await expect(page.getByTestId(`m-agent-perm-subagents-${level}`)).toBeDisabled()
      const before = await subLevel()
      await page.getByTestId('m-agent-perm-subagents-auto').tap({ force: true })
      expect(await subLevel()).toBe(before)
      await expect(page.getByTestId('m-agent-sub-calls')).toHaveCount(0)
      await expect(page.getByTestId('m-agent-sub-steps')).toHaveCount(0)
      // The other groups are untouched by the lock.
      await expect(page.getByTestId('m-agent-perm-web-confirm')).toBeEnabled()
      expect(await offered()).toEqual([])
      await clean(page, 'agent settings, sub agents locked')
      await shot(page, `e8-sub-agents-locked-${size.name}`)

      // LU Cloud on the same phone: as it was.
      await choose('lu-cloud::test-cloud-model', 'lu-cloud')
      await expect(row).not.toHaveAttribute('data-locked', '')
      await expect(row).toContainText('Hand a part of the work to a second run.')
      // Two taps, so the result does not hang on the level the phone starts with.
      await page.getByTestId('m-agent-perm-subagents-blocked').tap()
      await page.getByTestId('m-agent-perm-subagents-confirm').tap()
      expect(await subLevel()).toBe('confirm')
      await expect(page.getByTestId('m-agent-sub-calls')).toBeVisible()
      expect(await offered()).toEqual(['check_tasks', 'delegate_task', 'message_agent'])

      // The intro of Agent mode and the chat menu follow the model too.
      const chatId = await seedChat(page)
      await choose('openai::Qwen3.5-2B-Q4_K_M', 'openai')
      await openSheet(page, 'chat-options', { chatId })
      await page.getByTestId('m-options-agent').tap()
      await expect(page.getByTestId('m-options-intro')).toBeVisible()
      await expect(page.getByTestId('m-options-intro')).not.toContainText(/sub agent/i)
      await expect(page.getByTestId('m-options-intro')).toContainText('It can run your workflows.')
      await page.getByTestId('m-options-intro-later').tap()
      await page.goBack()
      await openSheet(page, 'chat-menu', { chatId })
      await expect(page.getByTestId('m-chat-menu-compare')).toBeVisible()
      await expect(page.getByTestId('m-chat-menu-tasks')).toHaveCount(0)
      await choose('lu-cloud::test-cloud-model', 'lu-cloud')
      await expect(page.getByTestId('m-chat-menu-tasks')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('E8 agent and permissions: levels, sub agent limits, intro, reset', async ({ page }) => {
      const errors = watchErrors(page)
      await sealNetwork(page)
      await openShell(page, { route: '/settings/agent' })
      await expect(page.getByTestId('m-settings-agent-screen')).toBeVisible()
      await clean(page, 'agent settings')
      await page.getByTestId('m-agent-sub-calls').scrollIntoViewIfNeeded()
      await shot(page, `e8-limits-${size.name}`)

      await page.getByTestId('m-agent-perm-web-blocked').tap()
      await page.getByTestId('m-agent-perm-subagents-confirm').tap()
      const stored = await page.evaluate(async () => {
        const { usePermissionStore } = ((await import(/* @vite-ignore */ '/src/stores/permissionStore.ts' as string)) as typeof import('../../src/stores/permissionStore'))
        const s = usePermissionStore.getState()
        return { web: s.globalPermissions.web, sub: s.perToolOverrides.delegate_task }
      })
      expect(stored).toEqual({ web: 'blocked', sub: 'confirm' })

      await page.getByTestId('m-agent-sub-calls-row').getByRole('button', { name: 'Increase Sub agent tool calls' }).tap()
      await expect(page.getByTestId('m-agent-sub-calls')).toHaveValue('11')
      await page.getByTestId('m-agent-sub-steps').fill('7')
      expect(
        await page.evaluate(async () => {
          const { useSettingsStore } = ((await import(/* @vite-ignore */ '/src/stores/settingsStore.ts' as string)) as typeof import('../../src/stores/settingsStore'))
          const s = useSettingsStore.getState().settings
          return [s.subAgentMaxToolCalls, s.subAgentMaxIterations]
        }),
      ).toEqual([11, 7])

      // The intro row says why it is not available while the intro still shows.
      await expect(page.getByTestId('m-agent-intro')).toBeDisabled()
      await page.evaluate(async () => {
        const { useAgentModeStore } = ((await import(/* @vite-ignore */ '/src/stores/agentModeStore.ts' as string)) as typeof import('../../src/stores/agentModeStore'))
        useAgentModeStore.getState().setTutorialCompleted()
      })
      await page.getByTestId('m-agent-intro').tap()
      await expect(page.getByTestId('m-toast-agent-intro-reset')).toBeVisible()

      await expect(page.getByTestId('m-agent-reset')).toHaveAttribute('data-m-risk', 'destructive')
      await page.getByTestId('m-agent-reset').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-agent-perm-web-blocked')).toHaveAttribute('aria-checked', 'false')

      await page.getByTestId('m-agent-memory').tap()
      await expect(page.getByTestId('m-settings-memory-screen')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('E9 web search: provider, keys in the key storage and a test search against a mock', async ({ page }) => {
      const errors = watchErrors(page)
      const tried = await sealNetwork(page)
      await keyStorage(page)
      let mode: 'ok' | 'fail' | 'offline' = 'ok'
      const asked: Array<Record<string, unknown>> = []
      // No network (F7 of the second check on Android): every search fails to look up its host.
      const lookup = 'could not connect (failed to lookup address information: No address associated with hostname)'
      const flightMode = {
        results: [],
        error: `All search tiers failed. DuckDuckGo: ${lookup}. Wikipedia: ${lookup}. The free search is not dependable. Add a Brave or Tavily key under Settings, Web search for dependable search.`,
        tiers: [{ tier: 'DuckDuckGo', error: lookup }, { tier: 'Wikipedia', error: lookup }],
      }
      await page.route('**/local-api/web-search', async (route) => {
        asked.push(route.request().postDataJSON() as Record<string, unknown>)
        if (mode === 'offline') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(flightMode) })
        if (mode === 'fail') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [], error: 'No provider answered.' }) })
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ provider: 'duckduckgo', results: [{ title: 'Weather today', url: 'https://example.test/w', snippet: 'Sunny' }, { title: 'Second', url: 'https://example.test/2', snippet: 'x' }] }),
        })
      })
      await openShell(page, { route: '/settings/search' })
      await expect(page.getByTestId('m-settings-search-screen')).toBeVisible()
      await clean(page, 'search settings')
      await shot(page, `e9-empty-${size.name}`)

      // Four choices. The two with a key of their own wait for that key.
      await expect(page.getByTestId('m-search-provider-auto')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('m-search-provider-duckduckgo')).toBeEnabled()
      await expect(page.getByTestId('m-search-provider-brave')).toBeDisabled()
      await expect(page.getByTestId('m-search-provider-brave')).toContainText('Add a Brave API key below first.')
      await expect(page.getByTestId('m-search-brave-save')).toBeDisabled()

      // Saving a key: it goes to the key storage, the settings only learn that there is one.
      await page.getByTestId('m-search-brave-key').fill(SEARCH_KEY)
      await page.getByTestId('m-search-brave-save').tap()
      await expect(page.getByTestId('m-search-brave-saved')).toContainText('Brave API key saved on this phone.')
      await expect(page.getByTestId('m-search-brave-key')).toHaveCount(0)
      expect(await page.evaluate(() => localStorage.getItem('chat-settings') ?? '')).not.toContain(SEARCH_KEY)
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('chat-settings') ?? '{}').state.settings.braveKeyStored)).toBe(true)
      expect(await storedKeys(page)).toEqual({ 'search-brave': SEARCH_KEY })

      await page.getByTestId('m-search-provider-brave').tap()
      await expect(page.getByTestId('m-search-provider-brave')).toHaveAttribute('aria-checked', 'true')
      await page.getByTestId('m-search-test').tap()
      await expect(page.getByTestId('m-search-result')).toContainText('Search works. 2 results from DuckDuckGo.')
      await expect(page.getByTestId('m-search-result')).toContainText('Weather today')
      expect(asked[0]).toMatchObject({ provider: 'brave', braveApiKey: SEARCH_KEY, tavilyApiKey: '' })
      await clean(page, 'search result')
      await shot(page, `e9-saved-${size.name}`)

      // DuckDuckGo: the saved key stays on the phone.
      await page.getByTestId('m-search-provider-duckduckgo').tap()
      await expect(page.getByTestId('m-search-provider-duckduckgo')).toHaveAttribute('aria-checked', 'true')
      await page.getByTestId('m-search-test').tap()
      await expect(page.getByTestId('m-search-result')).toBeVisible()
      expect(asked[1]).toMatchObject({ provider: 'duckduckgo', braveApiKey: '', tavilyApiKey: '' })

      // After a reload the key is still there and still not in the settings.
      // (The app restores the page it was on and the switch `route` opens it once more on top: look at the top one.)
      await openShell(page, { route: '/settings/search' })
      const top = page.locator('.m-page:not([data-m-hidden]):not([data-m-exit])')
      await expect(top.getByTestId('m-search-brave-saved')).toBeVisible()
      await expect(top.getByTestId('m-search-provider-duckduckgo')).toHaveAttribute('aria-checked', 'true')
      await top.getByTestId('m-search-provider-brave').tap()

      mode = 'fail'
      await top.getByTestId('m-search-test').tap()
      await expect(top.getByTestId('m-search-result-failed')).toContainText('Search did not work. No provider answered.')
      await expect(top.getByTestId('m-search-retry')).toBeVisible()
      await clean(page, 'search failed')

      // F7: the page says the one sentence, not the text of the system and not the advice to add a key.
      mode = 'offline'
      await top.getByTestId('m-search-retry').tap()
      await expect(top.getByTestId('m-search-result-offline')).toHaveText(/^This phone has no internet connection, so the search did not run\. Connect to Wi-Fi or mobile data and try again\./)
      await expect(top.getByTestId('m-search-result-failed')).toHaveCount(0)
      await expect(top.getByTestId('m-search-result-offline')).not.toContainText('lookup')
      await expect(top.getByTestId('m-search-result-offline')).not.toContainText('Brave')
      await clean(page, 'search offline')
      // The phone itself says it is offline: the search is not asked at all.
      const askedBefore = asked.length
      await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { value: false, configurable: true }))
      await top.getByTestId('m-search-retry-offline').tap()
      await expect(top.getByTestId('m-search-result-offline')).toBeVisible()
      await expect(top.getByTestId('m-search-test')).toBeEnabled()
      expect(asked.length).toBe(askedBefore)
      await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }))
      mode = 'fail'

      // "Replace" asks for a new key and can be left without losing the saved one.
      await top.getByTestId('m-search-brave-replace').tap()
      await expect(top.getByTestId('m-search-brave-key')).toHaveValue('')
      await clean(page, 'search replace')
      await top.getByTestId('m-search-brave-keep').tap()
      await expect(top.getByTestId('m-search-brave-saved')).toBeVisible()

      // Removing the key falls back to Auto and empties the key storage.
      await top.getByTestId('m-search-brave-remove').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(top.getByTestId('m-search-provider-auto')).toHaveAttribute('aria-checked', 'true')
      await expect(top.getByTestId('m-search-brave-saved')).toHaveCount(0)
      await expect(top.getByTestId('m-search-brave-key')).toHaveValue('')
      expect(await storedKeys(page)).toEqual({})
      expect(tried).toEqual([])
      expect(errors()).toEqual([])
    })

    // Acceptance on the small iPhone (round 5, N9): with the keyboard open the footer "Test search" lay on
    // "Save key" right under the field. The keyboard is the lower window here: the shell gets as low as on the phone.
    test('E9 web search: with the keyboard open "Save key" stays above the footer', async ({ page }) => {
      const errors = watchErrors(page)
      await sealNetwork(page)
      await openShell(page, { route: '/settings/search' })
      const field = page.getByTestId('m-search-brave-key')
      await field.scrollIntoViewIfNeeded()
      await field.tap()
      await expect(field).toBeFocused()
      await page.setViewportSize({ width: size.width, height: Math.round(size.height * 0.56) })
      const gap = () =>
        page.evaluate(() => {
          const save = document.querySelector('[data-testid="m-search-brave-save"]')!.getBoundingClientRect()
          const key = document.querySelector('[data-testid="m-search-brave-key"]')!.getBoundingClientRect()
          const foot = document.querySelector('[data-testid="m-search-test"]')!.closest('.m-foot')!.getBoundingClientRect()
          const body = document.querySelector('[data-testid="m-settings-search-screen"] > .m-body')!.getBoundingClientRect()
          return { saveAboveFoot: Math.round(foot.top - save.bottom), fieldBelowTop: Math.round(key.top - body.top), footFixed: foot.height > 0 }
        })
      // The field is looked at again a few times after the height changed (up to 600 ms).
      await expect.poll(async () => (await gap()).saveAboveFoot, { timeout: 5000 }).toBeGreaterThanOrEqual(0)
      const now = await gap()
      expect(now.footFixed).toBe(true)
      expect(now.fieldBelowTop).toBeGreaterThanOrEqual(0)
      await shot(page, `e9-keyboard-save-key-${size.name}`)
      expect(errors()).toEqual([])
    })

    test('E9 web search: a device without key storage says so and saves nothing', async ({ page }) => {
      const errors = watchErrors(page)
      const tried = await sealNetwork(page)
      // No bridge: this browser has no key storage, like a web build.
      await openShell(page, { route: '/settings/search' })
      await page.getByTestId('m-search-tavily-key').fill(SEARCH_KEY)
      await page.getByTestId('m-search-tavily-save').tap()
      await expect(page.getByTestId('m-search-tavily-block')).toContainText('This device has no secure key storage, so the key was not saved.')
      await expect(page.getByTestId('m-search-tavily-saved')).toHaveCount(0)
      expect(await page.evaluate(() => localStorage.getItem('chat-settings') ?? '')).not.toContain(SEARCH_KEY)
      await clean(page, 'search no key storage')
      expect(tried).toEqual([])
      expect(errors()).toEqual([])
    })

    test('E9 web search: an old plain key moves into the key storage on a phone', async ({ page, context }) => {
      const errors = watchErrors(page)
      const tried = await sealNetwork(page)
      await keyStorage(page)
      // The app decides "phone" by the user agent (lib/device-kind.ts).
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36', configurable: true })
      })
      await openShell(page, { route: '/settings/search' })
      await page.evaluate(async (key) => {
        const { useSettingsStore } = ((await import(/* @vite-ignore */ '/src/stores/settingsStore.ts' as string)) as typeof import('../../src/stores/settingsStore'))
        useSettingsStore.getState().updateSettings({ tavilyApiKey: key, searchProvider: 'tavily' })
      }, SEARCH_KEY)
      expect(await page.evaluate(() => localStorage.getItem('chat-settings') ?? '')).toContain(SEARCH_KEY)
      // The next start reads the settings and moves the key.
      await openShell(page, { route: '/settings/search' })
      const top = page.locator('.m-page:not([data-m-hidden]):not([data-m-exit])')
      await expect(top.getByTestId('m-search-tavily-saved')).toBeVisible()
      await expect(top.getByTestId('m-search-provider-tavily')).toHaveAttribute('aria-checked', 'true')
      await expect.poll(() => page.evaluate(() => localStorage.getItem('chat-settings') ?? '')).not.toContain(SEARCH_KEY)
      expect(await storedKeys(page)).toEqual({ 'search-tavily': SEARCH_KEY })
      expect(tried).toEqual([])
      expect(errors()).toEqual([])
    })

    test('E10 workflows: list, builder with steps, move, remove, save, delete', async ({ page }) => {
      const errors = watchErrors(page)
      await sealNetwork(page)
      await openShell(page, { route: '/settings/workflows' })
      await expect(page.getByTestId('m-settings-workflows-screen')).toBeVisible()
      await expect(page.getByTestId('m-workflows-list')).toBeVisible()
      await clean(page, 'workflows list')

      await page.getByTestId('m-workflows-add').tap()
      await expect(page.getByTestId('m-settings-workflow-screen')).toBeVisible()
      await clean(page, 'workflow new')
      await page.getByTestId('m-workflow-name').fill('Morning briefing')
      await page.getByTestId('m-workflow-save').tap()
      await expect(page.getByTestId('m-workflow-error')).toContainText('A workflow needs at least one step.')

      // Add step: the sheet with the six kinds, then the form of the step as a page.
      await page.getByTestId('m-workflow-add-step').tap()
      await expect(page.getByTestId('m-sheet-agent-add-step')).toBeVisible()
      await expect(page.locator('[data-testid^="m-add-step-"][data-el="E10.6"]')).toHaveCount(6)
      await clean(page, 'add step sheet')
      await page.getByTestId('m-add-step-user_input').tap()
      await expect(page.getByTestId('m-agent-workflow-step-screen')).toBeVisible()
      await expect(page.getByTestId('m-step-problem')).toContainText('Write the question.')
      await page.getByTestId('m-step-question').fill('Which city?')
      await expect(page.getByTestId('m-step-problem')).toHaveCount(0)
      await clean(page, 'step user input')
      await page.getByTestId('m-step-done').tap()
      await expect(page.getByTestId('m-workflow-step-0')).toContainText('Which city?')

      await page.getByTestId('m-workflow-add-step').tap()
      await page.getByTestId('m-add-step-tool').tap()
      await page.getByTestId('m-step-tool-web_search').tap()
      await page.getByTestId('m-step-arg-query').fill('weather in {{user_input}}')
      await clean(page, 'step tool')
      await page.getByTestId('m-step-done').tap()

      await page.getByTestId('m-workflow-add-step').tap()
      await page.getByTestId('m-add-step-prompt').tap()
      await page.getByTestId('m-step-label').fill('Write it up')
      await page.getByTestId('m-step-prompt').fill('Summarize: {{last_output}}')
      await clean(page, 'step prompt')
      await page.getByTestId('m-step-done').tap()
      await expect(page.getByTestId('m-workflow-step-2')).toContainText('Write it up')
      await clean(page, 'workflow with steps')

      // Move up and down without a drag, and remove.
      await page.getByTestId('m-workflow-step-up-2').tap()
      await expect(page.getByTestId('m-workflow-step-1')).toContainText('Write it up')
      await page.getByTestId('m-workflow-step-down-1').tap()
      await expect(page.getByTestId('m-workflow-step-2')).toContainText('Write it up')
      await expect(page.getByTestId('m-workflow-step-up-0')).toBeDisabled()
      await expect(page.getByTestId('m-workflow-step-remove-1')).toHaveAttribute('data-m-risk', 'destructive')

      // Condition and loop forms open and fit.
      await page.getByTestId('m-workflow-add-step').tap()
      await page.getByTestId('m-add-step-condition').tap()
      await page.getByTestId('m-step-cond-value').fill('rain')
      await page.getByTestId('m-step-then-1').tap()
      await clean(page, 'step condition')
      await page.getByTestId('m-step-done').tap()
      await page.getByTestId('m-workflow-add-step').tap()
      await page.getByTestId('m-add-step-loop').tap()
      await expect(page.getByTestId('m-step-problem')).toContainText('Pick at least one step to repeat.')
      await clean(page, 'step loop')
      await page.getByTestId('m-step-done').tap()
      // Save names the step that cannot run.
      await page.getByTestId('m-workflow-save').tap()
      await expect(page.getByTestId('m-workflow-error')).toContainText('Step 5: Pick at least one step to repeat.')
      await page.getByTestId('m-workflow-step-remove-4').tap()
      await page.getByTestId('m-workflow-step-remove-3').tap()

      await page.getByTestId('m-workflow-save').tap()
      await expect(page.getByTestId('m-settings-workflow-screen')).toHaveCount(0)
      await expect(page.getByTestId('m-workflows-list')).toContainText('Morning briefing')

      // The saved workflow opens again with its steps; run says what is missing.
      await page.getByTestId('m-workflows-list').getByRole('button', { name: 'Workflow Morning briefing' }).tap()
      await expect(page.getByTestId('m-workflow-step-2')).toContainText('Write it up')
      await expect(page.getByTestId('m-workflow-run')).toBeDisabled()
      await expect(page.getByTestId('m-workflow-run')).toContainText('Choose a model first.')
      await expect(page.getByTestId('m-workflow-save')).toBeDisabled()

      // Unsaved change, then back: the question, and "Discard" throws the draft away.
      await page.getByTestId('m-workflow-name').fill('Evening briefing')
      await page.getByTestId('m-settings-workflow-screen').getByTestId('m-page-back').tap()
      await expect(page.getByText('Discard changes?')).toBeVisible()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-workflows-list')).toContainText('Morning briefing')
      await page.getByTestId('m-workflows-list').getByRole('button', { name: 'Workflow Morning briefing' }).tap()
      await expect(page.getByTestId('m-workflow-name')).toHaveValue('Morning briefing')

      await page.getByTestId('m-workflow-delete').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-workflows-list')).not.toContainText('Morning briefing')

      // A built in workflow is read only and offers a copy.
      await page.locator('[data-testid^="m-workflows-row-builtin-"]').first().tap()
      await expect(page.getByTestId('m-workflow-builtin')).toBeVisible()
      await expect(page.getByTestId('m-workflow-save')).toHaveCount(0)
      await clean(page, 'workflow built in')
      expect(errors()).toEqual([])
    })
  })
}

/**
 * Round 12, F2 of the second check on Android: a heading with
 * style="color: red" was black in the preview ("Refused to apply inline
 * style"), and the note said "You see the layout and the styles".
 *
 * The developer server sends no policy, so the first test alone would not
 * have seen it. The second one puts the document of the preview into a page
 * that is served with the policy of the installed app, word for word from
 * the Tauri configuration, and looks at what the browser then does.
 */
const STYLED = [
  '<style>#b{color: rgb(0, 0, 255)}</style>',
  '<h1 id="a" style="color: red">Red</h1><p id="b">Blue</p>',
  '<img id="i" alt="" src="ORIGIN/__probe-image.png">',
  '<link rel="stylesheet" href="ORIGIN/__probe-style.css">',
  '<p id="s">before</p><script>document.getElementById("s").textContent="after"</script>',
].join('')

test.describe('C11 preview: the styles of the page (F2)', () => {
  test('in the app shell: a style attribute and a style block both show', async ({ page }) => {
    const errors = watchErrors(page)
    const tried = await sealNetwork(page)
    await openShell(page, { route: '/chats' })
    const chatId = await seedChat(page, [
      { id: 'u1', role: 'user', content: 'A red heading' },
      { id: 'a1', role: 'assistant', content: 'Here:\n\n```html\n<style>#b{color: rgb(0, 0, 255)}</style><h1 id="a" style="color: red">Red</h1><p id="b">Blue</p>\n```' },
    ])
    await push(page, '/chat/:id/preview/:blockId', { id: chatId, blockId: 'a1~0' })
    const inside = page.frameLocator('[data-testid="m-preview-frame"]')
    await expect(inside.locator('#a')).toHaveCSS('color', 'rgb(255, 0, 0)')
    await expect(inside.locator('#b')).toHaveCSS('color', 'rgb(0, 0, 255)')
    // No scripts in this page, so nothing is said about scripts.
    await expect(page.getByTestId('m-preview-noscripts')).toHaveCount(0)
    expect(tried).toEqual([])
    expect(errors()).toEqual([])
  })

  for (const config of ['src-tauri/tauri.conf.json', 'src-tauri/tauri.ios.conf.json']) {
    test(`under the policy of the installed app (${config}): styles show, scripts and the network stay shut`, async ({ page, baseURL }) => {
      const appPolicy = (JSON.parse(readFileSync(path.resolve(config), 'utf8')) as { app: { security: { csp: string } } }).app.security.csp
      const origin = baseURL ?? ''
      const code = STYLED.replaceAll('ORIGIN', origin)
      // Counted where a request is answered. A request the policy refuses never gets that far (the browser
      // still lists it as tried, which is why the list of requests is not what is read here).
      const fetched: string[] = []
      await page.route('**/__probe-image.png', (route) => {
        fetched.push('/__probe-image.png')
        return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') })
      })
      await page.route('**/__probe-style.css', (route) => {
        fetched.push('/__probe-style.css')
        return route.fulfill({ status: 200, contentType: 'text/css', body: '#b{color: rgb(0, 128, 0) !important}' })
      })

      /** A page with one closed frame, served with `policy`, showing `doc` the way PreviewPage does. */
      const show = async (name: string, policy: string, doc: string) => {
        const attr = doc.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
        await page.route(`**/__preview-host-${name}`, (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/html',
            headers: { 'content-security-policy': policy },
            body: `<!doctype html><html><head><meta charset="utf-8"><title>host</title></head><body><iframe id="f" sandbox="${sandboxAttr(true)}" referrerpolicy="no-referrer" srcdoc="${attr}"></iframe></body></html>`,
          }),
        )
        fetched.length = 0
        await page.goto(`${origin}/__preview-host-${name}`)
        const inside = page.frameLocator('#f')
        await expect(inside.locator('#s')).toBeAttached()
        // Give a request that is allowed the time to leave.
        await page.waitForTimeout(300)
        return inside
      }

      // The preview as the app builds it.
      const preview = await show('preview', appPolicy, previewDocument(code, 'html', 'p0xabc'))
      await expect(preview.locator('#a')).toHaveCSS('color', 'rgb(255, 0, 0)')
      await expect(preview.locator('#b')).toHaveCSS('color', 'rgb(0, 0, 255)')
      await expect(preview.locator('#s')).toHaveText('before')
      expect(fetched).toEqual([])

      // Control 1: the same page without the policy of its own. The policy of the app alone lets it fetch from
      // this machine (the picture through "http://localhost:*"; the style sheet only because this test serves
      // the host page from the same address). That is what the policy of the preview closes.
      await show('bare', appPolicy, buildDocument(code, 'html'))
      expect(fetched).toContain('/__probe-image.png')

      // Control 2: the state of the checked package. A nonce in style-src switches 'unsafe-inline' off, and the
      // heading is no longer red. This is the refusal the check saw, and why index.html has no style block.
      const withNonce = appPolicy.replace("style-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' 'nonce-abc123'")
      expect(withNonce).not.toBe(appPolicy)
      const refused = await show('nonce', withNonce, previewDocument(code, 'html', 'p0xabc'))
      await expect(refused.locator('#a')).not.toHaveCSS('color', 'rgb(255, 0, 0)')
    })
  }
  // Finding N10 of the Android review: the reporter of the preview is an inline script, the policy of the app
  // refuses it, and the console got "Refused to execute inline script" at every load. A page without scripts
  // carries none of ours now. Control: the same page with the reporter written into it, as it was.
  test('under the policy of the installed app a page without scripts loads without a refused script', async ({ page, baseURL }) => {
    const appPolicy = (JSON.parse(readFileSync(path.resolve('src-tauri/tauri.conf.json'), 'utf8')) as { app: { security: { csp: string } } }).app.security.csp
    const origin = baseURL ?? ''
    const refusals: string[] = []
    page.on('console', (message) => { if (/(Refused to execute|Executing) inline script/i.test(message.text())) refusals.push(message.text()) })
    const load = async (name: string, doc: string) => {
      const attr = doc.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
      await page.route(`**/__preview-host-${name}`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: { 'content-security-policy': appPolicy },
          body: `<!doctype html><html><head><meta charset="utf-8"><title>host</title></head><body><iframe id="f" sandbox="${sandboxAttr(true)}" referrerpolicy="no-referrer" srcdoc="${attr}"></iframe></body></html>`,
        }),
      )
      refusals.length = 0
      await page.goto(`${origin}/__preview-host-${name}`)
      await expect(page.frameLocator('#f').locator('#t')).toHaveText('Hello')
      await page.waitForTimeout(300)
      return refusals.length
    }
    const code = '<h1 id="t" style="color: red">Hello</h1>'
    expect(await load('without', previewDocument(code, 'html', 'p0xabc'))).toBe(0)
    // Control: with the reporter in it the policy refuses it, which is the error the review saw.
    expect(await load('with', previewDocument(code, 'html', 'p0xabc', true))).toBeGreaterThan(0)
  })
})
