/**
 * @vitest-environment jsdom
 *
 * A8 review S1 and B1, at the wiring rather than at the store.
 *
 * The folder buttons are locked by `codexStore.sendsInFlight`. The store side
 * of that counter is proven in codexStore-working-directory.test.ts, and the
 * two views' reaction to it in the component tests. What neither of those can
 * see is the part that actually matters: that a send TAKES the counter before
 * its first await, and gives it back however it ends.
 *
 * It has to be synchronous. `setThreadStatus('running')`, the old signal, is
 * five awaits into the send (workspace slug over IPC, server tool support,
 * token budget, memory search, .lurules), and both buttons were free for that
 * whole stretch. A Remove pressed in the gap changed a store the send had
 * already read past.
 *
 * Run: npx vitest run src/hooks/__tests__/the-send-holds-the-working-directory.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

// The one await at the top of the send, and the reason the gap exists. Made to
// throw in the last test so the release path is proven for a rejection too,
// which is what a counter that only decremented in the body would leak on.
const slugThrows = { value: false }
vi.mock('../../api/workspace-slug', () => ({
  resolveChatWorkspaceSlug: async () => {
    if (slugThrows.value) throw new Error('bridge is gone')
    return 'slug'
  },
}))

const { useCodex } = await import('../useCodex')
const { useCodexStore } = await import('../../stores/codexStore')
const { useModelStore } = await import('../../stores/modelStore')
const { useChatStore } = await import('../../stores/chatStore')

const sendsInFlight = () => useCodexStore.getState().sendsInFlight

beforeEach(() => {
  slugThrows.value = false
  useCodexStore.setState({ sendsInFlight: 0, threads: {}, workingDirectory: '' })
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useModelStore.setState({ activeModel: null })
})

describe('a send holds the working directory for its whole length', () => {
  it('takes the lock synchronously, before the first await', () => {
    const { result } = renderHook(() => useCodex())
    // Negative control: nothing is held before the call.
    expect(sendsInFlight()).toBe(0)

    const pending = result.current.sendInstruction('do the thing')
    // Not awaited on purpose. This is the exact window the old lock missed.
    expect(sendsInFlight()).toBe(1)
    return pending
  })

  it('gives it back when the send returns', async () => {
    const { result } = renderHook(() => useCodex())
    await result.current.sendInstruction('do the thing')
    expect(sendsInFlight()).toBe(0)
  })

  it('gives it back when the send throws, so the folder is never locked for good', async () => {
    useModelStore.setState({ activeModel: 'ollama::qwen3:14b' })
    slugThrows.value = true
    const { result } = renderHook(() => useCodex())

    await expect(result.current.sendInstruction('do the thing')).rejects.toThrow('bridge is gone')
    // A leak here would hold both folder buttons for the rest of the session,
    // which is the same dead end A8 is about.
    expect(sendsInFlight()).toBe(0)
  })
})
