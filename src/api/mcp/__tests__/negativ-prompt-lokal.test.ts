// B30 (2026-10-29): the local render tools checked every string argument as
// one text, the negative prompt included. A chat model that writes "child,
// underage" there to keep them out made an adult prompt read as content
// sexualizing minors. The negative prompt goes apart now (safety.ts); what the
// engines render is checked as before.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../backend', () => ({ backendCall: vi.fn(async () => ({ ok: true })), fetchExternal: vi.fn(async () => '') }))
vi.mock('../../agents/sub-agent', () => ({
  DELEGATE_TASK_TOOL_DEF: { name: 'delegate_task', description: '', category: 'system', inputSchema: {} },
  buildDelegateExecutor: () => async () => 'stub',
}))
vi.mock('../../../lib/workflow-engine', () => ({ WorkflowEngine: class {} }))

import { localRenderBlocked } from '../builtin-tools'

describe('localRenderBlocked reads the negative prompt apart', () => {
  it('an adult prompt whose negative prompt keeps minors out renders', () => {
    expect(localRenderBlocked({
      prompt: 'portrait of a 30 year old woman, sensual, lingerie',
      negativePrompt: 'child, underage, teen, nsfw, blurry',
    })).toBeNull()
  })

  it('a minor in the prompt or in any other argument is still refused', () => {
    expect(localRenderBlocked({ prompt: 'nude teen', negativePrompt: 'adult' })).toMatch(/^Error: /)
    expect(localRenderBlocked({ prompt: 'nude portrait', style: 'schoolgirl' })).toMatch(/^Error: /)
  })

  it('an unambiguous term in the negative prompt is refused as well', () => {
    expect(localRenderBlocked({ prompt: 'a portrait', negativePrompt: 'child porn' })).toMatch(/^Error: /)
  })
})
