import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FINISH_PROMPT, finishSection, finishWithoutTools } from '../finish'

describe('a clean end at the limit (CA U6)', () => {
  it('asks once without tools and returns the summary', async () => {
    const chatWithTools = vi.fn(async () => ({ content: '<think>hm</think>Done: median. Open: docs. Next: run lint.' }))
    const out = await finishWithoutTools({ provider: { chatWithTools }, model: 'm', messages: [{ role: 'user', content: 'task' }] })
    expect(out).toBe('Done: median. Open: docs. Next: run lint.')
    const [, msgs, tools] = chatWithTools.mock.calls[0] as unknown as [string, { content: string }[], unknown[]]
    expect(tools).toEqual([])
    expect(msgs[msgs.length - 1].content).toBe(FINISH_PROMPT)
  })

  it('gives up quietly: an error, an empty answer, a stop, a timeout', async () => {
    expect(await finishWithoutTools({ provider: { chatWithTools: async () => { throw new Error('400') } }, model: 'm', messages: [] })).toBeNull()
    expect(await finishWithoutTools({ provider: { chatWithTools: async () => ({ content: '  ' }) }, model: 'm', messages: [] })).toBeNull()
    const stopped = new AbortController(); stopped.abort()
    expect(await finishWithoutTools({ provider: { chatWithTools: vi.fn() }, model: 'm', messages: [], signal: stopped.signal })).toBeNull()
    const hang = { chatWithTools: (_m: string, _x: unknown, _t: unknown, o?: { signal?: AbortSignal }) => new Promise((_, rej) => o?.signal?.addEventListener('abort', () => rej(new Error('aborted')))) }
    expect(await finishWithoutTools({ provider: hang, model: 'm', messages: [], timeoutMs: 20 })).toBeNull()
  })

  it('appends under the halt line only when there is something to say', () => {
    expect(finishSection(null)).toBe('')
    expect(finishSection('x')).toContain('Where it stopped')
  })

  it('both loops run it at the budget and loop-guard halts, never at the cost brake', () => {
    const src = (p: string) => readFileSync(resolve(__dirname, '../../..', p), 'utf8')
    for (const f of ['hooks/useAgentChat.ts', 'hooks/useCodex.ts']) {
      expect(src(f).match(/finishWithoutTools\(/g)?.length).toBe(3)
      const brake = src(f).indexOf("if (brake.action === 'halt')")
      expect(src(f).slice(brake, brake + 500)).not.toContain('finishWithoutTools')
    }
  })
})
