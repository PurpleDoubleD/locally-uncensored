/**
 * C59, after C60's live run 1: a 9B tried `file_read ~/.huggingface/token`
 * unasked. The read came back empty, but it must not get that far. Every
 * built-in tool now refuses a secret path before the backend sees the call,
 * in every mode (the guard sits at registration, Bypass has nothing to skip).
 *
 * Red without the guard: the backend records the read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendCalls: { cmd: string; body: Record<string, unknown> }[] = []

vi.mock('../../backend', () => ({
  backendCall: vi.fn(async (cmd: string, body: Record<string, unknown>) => {
    backendCalls.push({ cmd, body })
    if (cmd === 'shell_execute') return { stdout: 'ran', stderr: '', exitCode: 0 }
    if (cmd === 'fs_read') return { content: 'hf_SECRET', encoding: 'utf8' }
    if (cmd === 'fs_search') return { results: [] }
    return { ok: true }
  }),
  fetchExternal: vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })),
}))
vi.mock('../../agents/sub-agent', () => ({
  DELEGATE_TASK_TOOL_DEF: { name: 'delegate_task', description: '', category: 'system', inputSchema: {} },
  buildDelegateExecutor: () => async () => 'stub',
}))
vi.mock('../../../lib/workflow-engine', () => ({ WorkflowEngine: class {} }))

import { registerBuiltinTools, runRetiredTool } from '../builtin-tools'
import { ToolRegistry } from '../tool-registry'

const registry = new ToolRegistry()
registerBuiltinTools(registry)

beforeEach(() => { backendCalls.length = 0 })

const reaches = (cmd: string) => backendCalls.some((c) => c.cmd === cmd)

describe('secret paths never reach the backend', () => {
  it('file_read ~/.huggingface/token: refused, nothing read', async () => {
    const out = await registry.execute('file_read', { path: '~/.huggingface/token' })
    expect(out).toMatch(/^Error: Refused: ~\/\.huggingface\/token holds a Hugging Face access token/)
    expect(reaches('fs_read')).toBe(false)
  })

  it('the same for the other tools and spellings', async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['file_read', { path: '/Users/x/.ssh/id_ed25519' }, 'fs_read'],
      ['file_read', { path: '.env' }, 'fs_read'],
      ['file_list', { path: '~/.aws' }, 'fs_list'],
      ['file_search', { path: '~/.config/gcloud', pattern: 'token' }, 'fs_search'],
      ['shell_execute', { command: 'cat ~/.ssh/id_rsa' }, 'shell_execute'],
      ['shell_execute', { command: 'grep TOKEN "$HOME/.netrc"' }, 'shell_execute'],
      ['shell_execute', { command: 'ls', cwd: '~/.ssh' }, 'shell_execute'],
      ['shell_execute', { command: 'python3 -', stdin: 'print(open("/Users/x/.git-credentials").read())' }, 'shell_execute'],
    ]
    for (const [tool, args, cmd] of cases) {
      const out = await registry.execute(tool, args)
      expect(out, `${tool} ${JSON.stringify(args)}`).toMatch(/^Error: Refused:/)
      expect(reaches(cmd), `${tool} reached ${cmd}`).toBe(false)
    }
  })

  it('a retired tool name is no way around it', async () => {
    const out = await runRetiredTool('code_execute', { language: 'bash', code: 'cat ~/.aws/credentials', stdin: 'cat ~/.aws/credentials' })
    expect(out).toMatch(/Refused:/)
    expect(reaches('shell_execute')).toBe(false)
  })

  it('ordinary paths still run', async () => {
    await registry.execute('file_read', { path: 'notes.txt' })
    expect(reaches('fs_read')).toBe(true)
    await registry.execute('shell_execute', { command: 'ls -la src' })
    expect(reaches('shell_execute')).toBe(true)
  })
})
