/**
 * CA (14.11.2026): the phone's remote agent drives the desktop's model, which
 * can be a paid cloud model. Until now only 50 steps and five failures in a
 * row stopped it. It now runs the same loop guard as the desktop.
 */
import { describe, it, expect } from 'vitest'
import { runRemoteAgentLoop } from '../remoteAgent'

function stubClient(sameCall: boolean) {
  let n = 0
  const sent: Array<Array<{ role: string; content: string }>> = []
  return {
    sent,
    client: {
      chatWithTools: async (req: { messages: Array<{ role: string; content: string }> }) => {
        sent.push(req.messages)
        n++
        return {
          content: '',
          thinking: '',
          toolCalls: [{ function: { name: 'file_read', arguments: { path: sameCall ? 'notes.txt' : `notes-${n}.txt` } } }],
        }
      },
      runAgentTool: async () => ({ ok: true, result: 'the same text every time' }),
    },
  }
}

describe('remote agent loop guard', () => {
  it('the same read over and over ends as looping, well before the 50-step limit', async () => {
    const s = stubClient(true)
    const res = await runRemoteAgentLoop({
      client: s.client as never, model: 'm', chatId: 'c', tools: ['file_read'],
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'read notes' }] as never,
    })
    expect(res.end).toBe('looping')
    expect(res.steps.length).toBeLessThan(10)
    // The steer reached the model after the results, before the end.
    expect(s.sent.flat().some((m) => m.role === 'user' && /exactly the same|same arguments/i.test(m.content))).toBe(true)
  })

  it('honest progress is never stopped by the guard', async () => {
    const s = stubClient(false)
    const res = await runRemoteAgentLoop({
      client: s.client as never, model: 'm', chatId: 'c', tools: ['file_read'], maxIterations: 12,
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'read all notes' }] as never,
    })
    expect(res.end).toBe('max-iterations')
  })
})
