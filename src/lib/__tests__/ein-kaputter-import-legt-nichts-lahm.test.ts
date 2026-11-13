// T1 Nacht-Durchtest 3.0.9 (Jäger A, A4): ein Chat-Backup mit einer Nachricht
// `"content": null` (oder 42) wurde mit "Imported 1 chat." angenommen. Die
// Chatansicht stürzte ab ("null is not an object (evaluating 'a.length')"),
// auch nach dem Neustart, und eine Suche in der Seitenleiste riss die ganze
// App mit ("e.content.toLowerCase is not a function").
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseImportedChats } from '../chat-export'
import { useChatStore } from '../../stores/chatStore'

const broken = JSON.stringify([{
  id: 'imp-1', title: 'Imported broken', createdAt: 1, updatedAt: 2,
  messages: [
    { id: 'm1', role: 'user', content: 'hello', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: null, timestamp: 2 },
    { id: 'm3', role: 'assistant', content: 42, timestamp: 3 },
    { role: 'user', content: 'no id', timestamp: 4 },
    { id: 'm5', role: 'hacker', content: 'bad role', timestamp: 5 },
    'not even an object',
  ],
}])

describe('importing a chat backup with broken messages', () => {
  it('turns every message into one the chat view can draw', () => {
    const [c] = parseImportedChats(broken)
    for (const m of c.messages) {
      expect(typeof m.content).toBe('string')
      expect(typeof m.id).toBe('string')
      expect(['user', 'assistant', 'system', 'tool']).toContain(m.role)
    }
    expect(c.messages.map((m) => m.content)).toEqual(['hello', '', '42', 'no id'])
  })

  it('the sidebar search survives a message that is not text', () => {
    useChatStore.setState({ conversations: [{ ...JSON.parse(broken)[0], messages: [{ id: 'x', role: 'assistant', content: 42, timestamp: 1 }] }] } as never)
    expect(() => useChatStore.getState().searchConversations('zz')).not.toThrow()
  })
})
