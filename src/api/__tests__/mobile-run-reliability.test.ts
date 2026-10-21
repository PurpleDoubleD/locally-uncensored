import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import * as core from '../../../mobile-client/agent-core.js'
import { declarationSource } from './mobile-client-shell'

// jsdom is already the project's browser-test runtime, but has no bundled
// declarations. Describe only the constructor surface used by these tests.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string; runScripts: 'dangerously' }) => { window: Window & typeof globalThis }
}

interface Message {
  role: string
  content: string
  hidden?: boolean
  tool_calls?: Array<{ id?: string; function: { name: string; arguments: unknown } }>
  tool_call_id?: string
  name?: string
  agentSteps?: Array<{ type: string; content: string; live?: boolean; outcome?: string }>
  runOutcome?: string
}
interface Chat { id: string; title: string; mode: string; msgs: Message[] }
interface Run { done: Promise<string>; budget: { charBudget: number; outputTokens: number }; controller: AbortController }
interface Harness {
  start: () => Run
  stop: () => void
  navigate: (id: string, model: string) => void
  remove: (id: string) => void
  state: () => { chats: Chat[]; msgs: Message[]; currentChatId: string; agentRunning: boolean }
}
type Fetch = (url: string, init?: RequestInit) => Promise<Response>
const json = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }))
const call = (id: string, path: string) => ({ id, type: 'function', function: { name: 'file_read', arguments: { path } } })

/** Execute the shipped shell functions together, with real fetch parsing and
 * promises. Only the DOM rendering and persistence sinks are replaced. */
function harness(fetch: Fetch, history: Message[] = [], context = 8192): Harness {
  const a: Chat = { id: 'a', title: 'Origin', mode: 'codex', msgs: [...history, { role: 'user', content: 'Read these files.' }, { role: 'assistant', content: '', agentSteps: [] }] }
  const b: Chat = { id: 'b', title: 'Other', mode: 'codex', msgs: [{ role: 'user', content: 'Unrelated task' }] }
  let counter = 0
  const dependencies = {
    ...core,
    fetch,
    initialChats: [a, b],
    initialContext: context,
    AbortController,
    renderChat: vi.fn(), renderShell: vi.fn(), persistChats: vi.fn(), persistState: vi.fn(),
    getCaveman: () => 'off', CAVEMAN_REMINDERS: {},
    isThinkingCompatible: () => false, isPlainTextPlanner: () => false,
    clearAuthAndReload: vi.fn(), absorbRefresh: (response: Response) => response,
    authJson: async () => ({ contextWindow: context, contextModel: 'managed::model-a' }),
    applyTodoWrite: vi.fn(),
    window: {}, document: { querySelector: () => null },
    mkMsg: (role: string, content: string, extra?: object) => ({ id: `message-${++counter}`, role, content, agentSteps: [], ...extra }),
  }
  const names = [
    'uid', 'findChat', 'updateChatMessages', 'syncCurrentChat', 'loadChat', 'deleteChat', 'contextModelKey', 'rememberContextWindow',
    'persistAgentRun', 'stopAgentRun', 'appendRunStep', 'nativeToolChat', 'runAgentTool', 'postChatEvent', 'runToolLoop',
  ]
  return new Function(...Object.keys(dependencies), `
    var chats = initialChats, currentChatId = 'a', currentModel = 'managed::model-a';
    var msgs = chats[0].msgs, streaming = false, agentRunning = false, abortCtrl = null;
    var activeAgentRun = null, thinking = false, pendingImages = [], TOKEN = 'test-token';
    var contextWindows = {'model-a': initialContext};
    ${names.map(declarationSource).join('\n')}
    return {
      start: function(){ return runToolLoop('System instructions', ['file_read'], 'Coding Agent'); },
      stop: stopAgentRun,
      navigate: function(id, model){ loadChat(id); currentModel = model; },
      remove: deleteChat,
      state: function(){ return {chats:chats, msgs:msgs, currentChatId:currentChatId, agentRunning:agentRunning}; }
    };
  `)(...Object.values(dependencies)) as Harness
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('mobile context capacity', () => {
  it('reserves output, tool schemas and framing at 8K and 256K', () => {
    const tools = core.buildToolDefs(['file_read'])
    const small = core.agentContextBudget(8192, tools)
    const large = core.agentContextBudget(262144, tools)
    expect(small.outputTokens).toBe(2048)
    expect(large.outputTokens).toBe(16384)
    expect(large.charBudget).toBeGreaterThan(650000)
    expect(large.charBudget).toBeLessThan((262144 - large.outputTokens) * 3)
    expect(small.charBudget).toBeLessThan(24000)
    expect(core.agentContextBudget(undefined, tools)).toEqual(small)
    expect(core.agentContextBudget(NaN, tools)).toEqual(small)
    expect(core.agentContextBudget(8192, tools).charBudget).toBeLessThan(core.agentContextBudget(8192, []).charBudget)
  })

  it('retains a 100K transcript for a matching 256K model instead of compacting it at 24K', async () => {
    const requests: Array<{ messages: Message[]; options: { num_predict: number } }> = []
    const h = harness(async (url, init) => {
      if (url !== '/api/chat') return json({})
      requests.push(JSON.parse(String(init?.body)))
      return json({ message: { content: 'Read complete.' } })
    }, [
      { role: 'user', content: 'Initial task' },
      ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'z'.repeat(10000) })),
    ], 262144)
    await h.start().done
    expect(requests[0].messages.reduce((n, m) => n + m.content.length, 0)).toBeGreaterThan(100000)
    expect(requests[0].options.num_predict).toBe(16384)
  })

  it('does not lend the managed model capacity to another selected model', async () => {
    const h = harness(async () => json({ message: { content: 'Done.' } }), [], 262144)
    h.navigate('a', 'different-model:latest')
    const run = h.start()
    await run.done
    expect(run.budget.outputTokens).toBe(2048)
    expect(run.budget.charBudget).toBeLessThan(24000)
  })

  it('reports an oversized protected task instead of silently truncating it at the backend', async () => {
    let inference = 0
    const h = harness(async (url) => {
      if (url === '/api/chat') inference++
      return json({ message: { content: 'Done.' } })
    }, [{ role: 'user', content: 'x'.repeat(50000) }])
    expect(await h.start().done).toBe('failed')
    expect(inference).toBe(0)
    expect(h.state().chats[0].msgs.at(-1)?.agentSteps?.some((s) => s.content.includes('active context budget'))).toBe(true)
  })

  it('compacts whole tool exchanges and preserves the current user task', () => {
    const firstCall = call('old-id', 'old.txt')
    const lastCall = call('new-id', 'new.txt')
    const out = core.compactApiMessages([
      { role: 'system', content: 'system' }, { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'x'.repeat(30000), tool_calls: [firstCall] },
      { role: 'tool', content: 'old', tool_call_id: 'old-id', name: 'file_read' },
      { role: 'user', content: 'Current task' },
      { role: 'assistant', content: '', tool_calls: [lastCall] },
      { role: 'tool', content: 'new', tool_call_id: 'new-id', name: 'file_read' },
    ], 2000)
    expect(out.some((m: Message) => m.content === 'Current task')).toBe(true)
    expect(out.some((m: Message) => m.tool_call_id === 'old-id')).toBe(false)
    expect(out.find((m: Message) => m.tool_calls)?.tool_calls?.[0].id).toBe('new-id')
    expect(out.find((m: Message) => m.role === 'tool')?.tool_call_id).toBe('new-id')
  })
})

describe('mobile run identity and durable history', () => {
  it('keeps inference, tools, steps, transcript and desktop events bound to the origin after navigation', async () => {
    const pending = deferred<Response>()
    const sent = deferred<void>()
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    let turns = 0
    const h = harness(async (url, init) => {
      const body = JSON.parse(String(init?.body))
      requests.push({ url, body })
      if (url === '/api/chat') {
        if (++turns === 1) { sent.resolve(); return pending.promise }
        return json({ message: { content: 'Origin task finished.' } })
      }
      return json(url === '/remote-api/agent-tool' ? 'origin file contents' : {})
    })
    const run = h.start()
    await sent.promise
    h.navigate('b', 'different-model:latest')
    pending.resolve(await json({ message: { tool_calls: [call('origin-call', 'a.txt')] } }))
    await run.done
    const state = h.state()
    expect(state.currentChatId).toBe('b')
    expect(state.msgs).toEqual([{ role: 'user', content: 'Unrelated task' }])
    expect(state.chats[0].msgs.at(-1)?.content).toBe('Origin task finished.')
    expect(state.chats[0].msgs.at(-1)?.agentSteps?.some((s) => s.type === 'observation')).toBe(true)
    expect(requests.filter((r) => r.url === '/api/chat').map((r) => r.body.model)).toEqual(['managed::model-a', 'managed::model-a'])
    expect(requests.find((r) => r.url === '/remote-api/agent-tool')?.body.chatId).toBe('a')
    expect(requests.find((r) => r.url === '/remote-api/chat-event')?.body).toMatchObject({ chat_id: 'a', model: 'managed::model-a' })
  })

  it('persists all completed tool calls after prompt compaction and keeps duplicate-name call IDs paired on replay', async () => {
    const requests: Array<{ messages: Message[] }> = []
    let turns = 0
    const h = harness(async (url, init) => {
      if (url === '/api/chat') {
        requests.push(JSON.parse(String(init?.body)))
        return json({ message: ++turns === 1
          ? { tool_calls: [call('one', 'one.txt'), call('two', 'two.txt')] }
          : { content: 'Files inspected.' } })
      }
      if (url === '/remote-api/agent-tool') return json('Full result ' + 'r'.repeat(30000))
      return json({})
    }, [
      { role: 'user', content: 'Original request' },
      ...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'old'.repeat(2000) })),
    ])
    await h.start().done
    const hidden = h.state().chats[0].msgs.filter((m) => m.hidden)
    expect(hidden.find((m) => m.role === 'assistant')?.tool_calls?.map((c) => c.id)).toEqual(['one', 'two'])
    expect(hidden.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.name, m.content.length])).toEqual([
      ['one', 'file_read', 30012], ['two', 'file_read', 30012],
    ])
    // The durable result is whole even though the model's compacted copy is capped.
    expect(requests[1].messages.find((m) => m.role === 'tool')!.content.length).toBeLessThan(30012)
    h.state().msgs.push({ role: 'user', content: 'Continue the task' }, { role: 'assistant', content: '', agentSteps: [] })
    h.navigate('b', 'other')
    h.navigate('a', 'managed::model-a')
    await h.start().done
    const replay = requests.at(-1)!.messages.filter((m) => m.role === 'tool')
    expect(replay.map((m) => [m.tool_call_id, m.name])).toEqual([['one', 'file_read'], ['two', 'file_read']])
  })
})

describe('mobile cancellation and outcome', () => {
  it('aborts in-flight inference immediately and records stopped instead of completed', async () => {
    const sent = deferred<AbortSignal>()
    let inferenceId = ''
    let cancelledId = ''
    const h = harness(async (url, init) => {
      if (url === '/remote-api/cancel-inference') cancelledId = JSON.parse(String(init?.body)).id
      if (url !== '/api/chat') return json({})
      inferenceId = (init?.headers as Record<string, string>)['X-LU-Inference-ID']
      const signal = init?.signal as AbortSignal
      sent.resolve(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })))
      })
    })
    const run = h.start()
    const signal = await sent.promise
    h.stop()
    expect(signal.aborted).toBe(true)
    expect(inferenceId).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(cancelledId).toBe(inferenceId)
    expect(await run.done).toBe('stopped')
    expect(h.state().chats[0].msgs.at(-1)).toMatchObject({ content: 'Task stopped.', runOutcome: 'stopped' })
    expect(h.state().agentRunning).toBe(false)
  })

  it('settles the dispatched tool, skips remaining calls and stores a replayable stopped exchange', async () => {
    const toolStarted = deferred<void>()
    const tool = deferred<Response>()
    const toolCalls: string[] = []
    const h = harness(async (url, init) => {
      if (url === '/api/chat') return json({ message: { tool_calls: [call('one', 'one.txt'), call('two', 'two.txt')] } })
      if (url === '/remote-api/agent-tool') {
        toolCalls.push(JSON.parse(String(init?.body)).args.path)
        toolStarted.resolve()
        return tool.promise
      }
      return json({})
    })
    const run = h.start()
    await toolStarted.promise
    h.stop()
    tool.resolve(await json('read succeeded'))
    expect(await run.done).toBe('stopped')
    expect(toolCalls).toEqual(['one.txt'])
    expect(h.state().chats[0].msgs.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content])).toEqual([
      ['one', 'read succeeded'], ['two', 'Not executed: task stopped.'],
    ])
    expect(h.state().chats[0].msgs.at(-1)?.content).toBe('Task stopped: 1 file(s) read.')
  })

  it('records a failed inference without a misleading success summary', async () => {
    const h = harness(async (url) => {
      if (url === '/api/chat') throw new Error('backend disconnected')
      return json({})
    })
    expect(await h.start().done).toBe('failed')
    expect(h.state().chats[0].msgs.at(-1)).toMatchObject({ content: 'Task failed.', runOutcome: 'failed' })
  })

  it('counts failed operations without claiming that attempted reads succeeded', async () => {
    let turn = 0
    const h = harness(async (url) => {
      if (url === '/api/chat') return json({ message: { tool_calls: [call('call-' + (++turn), 'missing.txt')] } })
      if (url === '/remote-api/agent-tool') return json({ error: 'file does not exist' })
      return json({})
    })
    expect(await h.start().done).toBe('failed')
    expect(h.state().chats[0].msgs.at(-1)?.content).toBe('Task failed: 5 operation(s) failed.')
  })

  it('cancels a deleted origin chat and never resurrects it or mirrors a late answer elsewhere', async () => {
    const sent = deferred<void>()
    const mirrored: unknown[] = []
    const h = harness(async (url, init) => {
      if (url === '/remote-api/chat-event') mirrored.push(JSON.parse(String(init?.body)))
      if (url !== '/api/chat') return json({})
      sent.resolve()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })))
      })
    })
    const run = h.start()
    await sent.promise
    h.remove('a')
    expect(await run.done).toBe('stopped')
    expect(h.state().chats.map((c) => c.id)).toEqual(['b'])
    expect(h.state().msgs).toEqual([{ role: 'user', content: 'Unrelated task' }])
    expect(mirrored).toEqual([])
  })
})

describe('model picker treats backend metadata as text', () => {
  function picker(models: string[], selected: string) {
    const dom = new JSDOM('<body></body>', { url: 'http://localhost', runScripts: 'dangerously' })
    const persisted = vi.fn()
    const render = vi.fn()
    new Function('window', 'document', 'localStorage', 'renderShell', 'svgIcon', `
      var availableModels = ${JSON.stringify(models)}, currentModel = ${JSON.stringify(selected)};
      ${declarationSource('_openModelPicker')}
    `)(dom.window, dom.window.document, { setItem: persisted }, render, () => '<svg></svg>')
    ;(dom.window as unknown as { _openModelPicker: () => void })._openModelPicker()
    return { dom, persisted, render }
  }

  it('does not create injected event attributes, and selects the exact unmodified name', () => {
    const model = 'evil" onpointerover="window.pwned=1" onpointerdown="window.pwned=2" x="<img src=x>'
    const { dom, persisted, render } = picker([model, 'normal:latest'], model)
    const button = dom.window.document.querySelector<HTMLButtonElement>('.picker-item')!
    expect(button.textContent).toBe(model)
    expect(button.getAttribute('data-model')).toBe(model)
    expect(button.getAttribute('onpointerover')).toBeNull()
    expect(button.getAttribute('onpointerdown')).toBeNull()
    expect(button.querySelector('img')).toBeNull()
    button.dispatchEvent(new dom.window.Event('pointerover'))
    button.dispatchEvent(new dom.window.Event('pointerdown'))
    expect((dom.window as unknown as { pwned?: number }).pwned).toBeUndefined()
    expect(button.classList.contains('active')).toBe(true)
    button.click()
    expect(persisted).toHaveBeenCalledWith('lu-mobile-model', model)
    expect(render).toHaveBeenCalledOnce()
    expect(dom.window.document.querySelector('.picker-overlay')).toBeNull()
    dom.window.close()
  })

  it('keeps empty and close behavior', () => {
    const { dom } = picker([], '')
    expect(dom.window.document.querySelector('.picker-empty')?.textContent).toContain('No models found')
    dom.window.document.querySelector<HTMLButtonElement>('.picker-close')!.click()
    expect(dom.window.document.querySelector('.picker-overlay')).toBeNull()
    dom.window.close()
  })
})
