// @vitest-environment jsdom
/**
 * 3.1.2: Agent einschalten oeffnet nichts. Kein Dialog "Where should the
 * agent work?", der Schalter ist sofort an; gefragt wird bei der ersten
 * Nachricht im Chat (agent-ordner-im-chat.test.tsx).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentModeToggle } from '../AgentModeToggle'
import { useAgentModeStore } from '../../../stores/agentModeStore'
import { useChatStore } from '../../../stores/chatStore'
import { useModelStore } from '../../../stores/modelStore'
import { useSettingsStore } from '../../../stores/settingsStore'

beforeEach(() => {
  cleanup()
  useAgentModeStore.setState({ workspaces: {}, agentModeActive: {} })
  useSettingsStore.getState().updateSettings({ defaultWorkspace: null })
  useModelStore.setState({ activeModel: 'qwen2.5:7b' })
})

describe('der Agent-Schalter', () => {
  it('schaltet sofort ein, ohne Dialog und ohne Ordnerwahl', async () => {
    const conv = useChatStore.getState().createConversation('qwen2.5:7b', '')
    render(<AgentModeToggle />)
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }))
    expect(useAgentModeStore.getState().agentModeActive[conv]).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('Where should the agent work?')).toBeNull()
    // Nichts wird still gesetzt: die Wahl faellt bei der ersten Nachricht.
    expect(useAgentModeStore.getState().workspaces[conv]).toBeUndefined()
  })
})
