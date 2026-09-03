/**
 * Two interleaving agent runs cannot reach into each other (plan 2.6.6, C1
 * ERZWINGUNG / blocker S3).
 *
 * Two runs at once are reachable from the UI today: a Coding run survives the
 * tab switch, a second Coding conversation frees the send, and the Chat/Agent
 * send is not locked. While the whole run context was ONE globalThis object,
 * that meant a Bypass run B flipped the read-only flag of a Plan run A mid-run,
 * B's cleanup nulled A's workspace so later writes went to
 * agent-workspace/default, A's todo_write landed in B's conversation, and a
 * chat-artifact run captured the coding run's writes.
 *
 * These tests run A and B genuinely interleaved and pin all four. Each one has
 * its negative control right next to it: the SAME call with the run not
 * threaded reads the module global and shows the old, broken answer.
 *
 * Run: npx vitest run src/api/__tests__/codex-run-isolation.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The vitest env is 'node', so todoStore's zustand persist has no storage and
// logs one warning per write. Irrelevant here: every assertion reads the live
// store, and the state is reset in beforeEach.

// `body` traegt genau das, was backendCall als zweites Argument annimmt.
type BridgeArgs = Record<string, unknown> | undefined
const backendCalls: { cmd: string; body: BridgeArgs }[] = []

vi.mock('../backend', () => ({
  backendCall: vi.fn(async (cmd: string, body: BridgeArgs) => {
    backendCalls.push({ cmd, body })
    if (cmd === 'shell_execute') return { stdout: 'ok', stderr: '', exitCode: 0 }
    if (cmd === 'fs_write') return { status: 'saved', path: `${String(body?.workingDirectory ?? 'default')}/${String(body?.path)}` }
    if (cmd === 'fs_read') return { content: 'file bytes' }
    if (cmd === 'fs_list') return { entries: [], count: 0 }
    return { ok: true }
  }),
  fetchExternal: vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })),
  isOllamaLocal: () => true,
}))
// The delegate/workflow imports drag in the provider stack, which nothing here
// touches. Stub them so the module graph loads in a node test.
vi.mock('../agents/sub-agent', () => ({
  DELEGATE_TASK_TOOL_DEF: { name: 'delegate_task', description: '', category: 'system', inputSchema: {} },
  buildDelegateExecutor: () => async () => 'stub',
}))
vi.mock('../../lib/workflow-engine', () => ({ WorkflowEngine: class {} }))

import { registerBuiltinTools } from '../mcp/builtin-tools'
import { ToolRegistry } from '../mcp/tool-registry'
import { beginAgentRun, endAgentRun, clearActiveChatId, type AgentRunContext } from '../agent-context'
import { useTodoStore } from '../../stores/todoStore'

const registry = new ToolRegistry()
registerBuiltinTools(registry)

const ws = (path: string) => ({ kind: 'folder' as const, path })

const startPlanRunA = (): AgentRunContext =>
  beginAgentRun({
    chatId: 'plan-a',
    conversationId: 'conv-A',
    workspace: ws('/repo-a'),
    readOnlyShellTurn: true,
    mode: 'plan',
  })

const startBypassRunB = (): AgentRunContext =>
  beginAgentRun({
    chatId: 'bypass-b',
    conversationId: 'conv-B',
    workspace: ws('/repo-b'),
    readOnlyShellTurn: false,
    // B is a plain-chat artifact run as well, so the capture gate is exercised
    // in the same interleave.
    artifactMode: true,
    mode: 'bypass',
  })

const MUTATING = 'rm -rf build'

beforeEach(() => {
  backendCalls.length = 0
  clearActiveChatId()
  useTodoStore.setState({ byConversation: {}, updatedAt: {} })
})
afterEach(() => clearActiveChatId())

describe('run A stays read-only before, during and after run B', () => {
  it('refuses A mutating shell before B, while B runs, and after B ended', async () => {
    const a = startPlanRunA()

    const before = await registry.execute('shell_execute', { command: MUTATING }, 1, a)
    expect(before).toContain('Refused')

    const b = startBypassRunB()
    const during = await registry.execute('shell_execute', { command: MUTATING }, 1, a)
    expect(during).toContain('Refused')

    // B is allowed to do exactly what A may not. Without this the test would
    // pass on a build where nothing runs at all.
    const bRan = await registry.execute('shell_execute', { command: MUTATING }, 1, b)
    expect(bRan).not.toContain('Refused')

    endAgentRun(b)
    const after = await registry.execute('shell_execute', { command: MUTATING }, 1, a)
    expect(after).toContain('Refused')

    endAgentRun(a)
  })

  it('negative control: the same call on the module global runs through while B is up', async () => {
    const a = startPlanRunA()
    // Unthreaded, exactly as every executor gate read it before C1.
    expect(await registry.execute('shell_execute', { command: MUTATING })).toContain('Refused')

    const b = startBypassRunB()
    // The global now belongs to B, so A's read-only guarantee is simply gone.
    expect(await registry.execute('shell_execute', { command: MUTATING })).not.toContain('Refused')

    endAgentRun(b)
    endAgentRun(a)
  })

  it('A may still run its inspection commands', async () => {
    const a = startPlanRunA()
    const out = await registry.execute('shell_execute', { command: 'git status' }, 1, a)
    expect(out).not.toContain('Refused')
    endAgentRun(a)
  })
})

describe("A's plan lands in A's conversation", () => {
  it('todo_write follows the run, not whichever run started last', async () => {
    const a = startPlanRunA()
    const b = startBypassRunB()

    await registry.execute('todo_write', { todos: [{ content: 'read the router', status: 'in_progress' }] }, 1, a)

    expect(useTodoStore.getState().getTodos('conv-A').map((t) => t.content)).toEqual(['read the router'])
    expect(useTodoStore.getState().getTodos('conv-B')).toEqual([])

    endAgentRun(b)
    endAgentRun(a)
  })

  it('negative control: unthreaded, the same plan lands in B', async () => {
    const a = startPlanRunA()
    const b = startBypassRunB()

    await registry.execute('todo_write', { todos: [{ content: 'read the router', status: 'in_progress' }] })

    expect(useTodoStore.getState().getTodos('conv-B').map((t) => t.content)).toEqual(['read the router'])
    expect(useTodoStore.getState().getTodos('conv-A')).toEqual([])

    endAgentRun(b)
    endAgentRun(a)
  })
})

describe("B's cleanup does not strip A's workspace", () => {
  it("A's reads still resolve against its own jail root after B ended", async () => {
    const a = startPlanRunA()
    const b = startBypassRunB()
    endAgentRun(b)

    backendCalls.length = 0
    await registry.execute('file_read', { path: 'src/main.ts' }, 1, a)
    const call = backendCalls.find((c) => c.cmd === 'fs_read')
    // Erst nachweisen, dass der Aufruf ueberhaupt kam — sonst waeren die
    // beiden Zeilen darunter `undefined` gegen `undefined`.
    expect(call).toBeDefined()
    expect(call?.body?.workingDirectory).toBe('/repo-a')
    expect(call?.body?.chatId).toBe('plan-a')

    endAgentRun(a)
  })

  it('negative control: unthreaded, the same read has lost its root entirely', async () => {
    const a = startPlanRunA()
    const b = startBypassRunB()
    endAgentRun(b)

    backendCalls.length = 0
    await registry.execute('file_read', { path: 'src/main.ts' })
    const call = backendCalls.find((c) => c.cmd === 'fs_read')
    // Nulled by B on its way out, so the bridge falls back to
    // agent-workspace/default and the write lands nowhere near the project.
    expect(call).toBeDefined()
    expect(call?.body?.workingDirectory).toBeUndefined()
    expect(call?.body?.chatId).toBeUndefined()

    endAgentRun(a)
  })
})

describe("a chat-artifact run does not capture the coding run's writes", () => {
  it("A's file_write hits the disk path while B's is captured", async () => {
    // A is a Bypass coding run here (Plan has no writes), B is the plain-chat
    // artifact run that used to swallow them.
    const a = beginAgentRun({
      chatId: 'code-a', conversationId: 'conv-A', workspace: ws('/repo-a'),
      readOnlyShellTurn: false, artifactMode: false, mode: 'bypass',
    })
    const b = startBypassRunB()

    const aOut = await registry.execute('file_write', { path: 'out.txt', content: 'hello' }, 1, a)
    expect(aOut).toContain('File saved')
    expect(backendCalls.some((c) => c.cmd === 'fs_write' && c.body?.workingDirectory === '/repo-a')).toBe(true)

    const bOut = await registry.execute('file_write', { path: 'note.md', content: 'hi' }, 1, b)
    expect(bOut).toContain('nothing was written to disk')

    endAgentRun(b)
    endAgentRun(a)
  })

  it('negative control: unthreaded, the coding write is swallowed as a chat artifact', async () => {
    const a = beginAgentRun({
      chatId: 'code-a', conversationId: 'conv-A', workspace: ws('/repo-a'),
      readOnlyShellTurn: false, artifactMode: false, mode: 'bypass',
    })
    const b = startBypassRunB()

    backendCalls.length = 0
    const aOut = await registry.execute('file_write', { path: 'out.txt', content: 'hello' })
    expect(aOut).toContain('nothing was written to disk')
    expect(backendCalls.some((c) => c.cmd === 'fs_write')).toBe(false)

    endAgentRun(b)
    endAgentRun(a)
  })
})

describe('the retired names go through the same gate', () => {
  it("git_commit under A's plan run is refused even while B is unrestricted", async () => {
    const a = startPlanRunA()
    const b = startBypassRunB()
    expect(await registry.execute('git_commit', { message: 'wip' }, 1, a)).toContain('Refused')
    expect(await registry.execute('git_commit', { message: 'wip' }, 1, b)).not.toContain('Refused')
    endAgentRun(b)
    endAgentRun(a)
  })
})

describe('closing a run only clears the shared mirror when it owns it', () => {
  it('A closing first leaves B intact', async () => {
    const a = startPlanRunA()
    const b = startBypassRunB()
    // A is the older run, so it does not own the mirror any more.
    endAgentRun(a)
    const out = await registry.execute('shell_execute', { command: MUTATING }, 1, b)
    expect(out).not.toContain('Refused')
    endAgentRun(b)
  })

  it('an older run finishing does not take the newer run\'s context with it', async () => {
    // B first, then A, so A owns the mirror. B finishing must leave it alone:
    // this is the half a threaded call cannot see, and it is what a standalone
    // tool call from another tab reads.
    const b = startBypassRunB()
    const a = startPlanRunA()
    endAgentRun(b)

    backendCalls.length = 0
    await registry.execute('file_read', { path: 'src/main.ts' })
    const call = backendCalls.find((c) => c.cmd === 'fs_read')
    // Erst nachweisen, dass der Aufruf ueberhaupt kam — sonst waeren die
    // beiden Zeilen darunter `undefined` gegen `undefined`.
    expect(call).toBeDefined()
    expect(call?.body?.workingDirectory).toBe('/repo-a')
    expect(call?.body?.chatId).toBe('plan-a')
    expect(await registry.execute('shell_execute', { command: MUTATING })).toContain('Refused')

    endAgentRun(a)
  })
})
