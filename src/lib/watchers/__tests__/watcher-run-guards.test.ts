// Watchers: a watcher's run cannot change LU or make watchers, and its cap
// is the last word on what runs without a question.
import { afterEach, describe, expect, it } from 'vitest'
import { checkSelfControl } from '../../self-control-policy'
import { useWatcherStore } from '../../../stores/watcherStore'
import { usePermissionStore } from '../../../stores/permissionStore'
import { setCapMap, setTurnCaps, clearTurnCaps } from '../../remote-turn-caps'
import { watcherCaps } from '../caps'
import { NO_RIGHTS, type Watcher } from '../types'
import type { AgentRunContext } from '../../../api/agent-context'

const w = { id: 'w1', name: 'Prices', conversation_id: 'watch-chat' } as Watcher

afterEach(() => {
  useWatcherStore.setState({ watchers: [], hints: [] })
  clearTurnCaps('watch-chat')
  clearTurnCaps('phone-chat')
  usePermissionStore.setState({ perToolOverrides: {} })
})

describe('a watcher run and the self-control tools', () => {
  it('refuses every change from inside a watcher chat, before any card', () => {
    useWatcherStore.setState({ watchers: [w], hints: [] })
    const run = { settingsCard: true, conversationId: 'watch-chat' } as unknown as AgentRunContext
    const verdict = checkSelfControl(run, { names: () => true, strong: false, what: 'a watcher' })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reply).toMatch(/watcher's run/)
  })
})

describe('the cap of a watcher run', () => {
  it('runs what was ticked without a question, even over a per-tool ask', () => {
    usePermissionStore.setState({ perToolOverrides: { shell_execute: 'confirm' } })
    setCapMap('watch-chat', watcherCaps({ ...NO_RIGHTS, terminal: true }))
    const p = usePermissionStore.getState()
    expect(p.getEffectivePermissionForTool('shell_execute', 'terminal', 'watch-chat')).toBe('auto')
    expect(p.getEffectivePermissionForTool('web_search', 'web', 'watch-chat')).toBe('blocked')
  })

  it('never lets through a tool the user blocked by name', () => {
    usePermissionStore.setState({ perToolOverrides: { shell_execute: 'blocked' } })
    setCapMap('watch-chat', watcherCaps({ ...NO_RIGHTS, terminal: true }))
    expect(usePermissionStore.getState().getEffectivePermissionForTool('shell_execute', 'terminal', 'watch-chat')).toBe('blocked')
  })

  it('leaves the phone cap as it was: only blocks, never a free pass', () => {
    usePermissionStore.setState({ perToolOverrides: { shell_execute: 'confirm' } })
    setTurnCaps('phone-chat', { agent: true, files: true, terminal: true, create: true })
    expect(usePermissionStore.getState().getEffectivePermissionForTool('shell_execute', 'terminal', 'phone-chat')).toBe('confirm')
  })
})
