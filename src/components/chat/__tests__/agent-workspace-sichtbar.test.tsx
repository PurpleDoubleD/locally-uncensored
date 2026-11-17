// @vitest-environment jsdom
/**
 * Discord 28.09.2026: "I still can't get my models to access my
 * files", mit jeder Agent-Berechtigung auf Auto. Wer den Ordnerdialog
 * wegklickte, arbeitete still in der Sandbox des Chats, und die Plakette neben
 * dem Agent-Schalter verschwand: kein Hinweis, wo der Agent arbeitet, und kein
 * Klick, der das aendert. Die Plakette zeigt jetzt immer den Ort, an dem der
 * Lauf wirklich arbeitet, und ein Klick fuehrt zu "Pick a folder…".
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AgentWorkspaceBadge } from '../AgentWorkspaceBadge'
import { useAgentModeStore } from '../../../stores/agentModeStore'
import { useChatStore } from '../../../stores/chatStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useChatNoticeStore } from '../../../stores/chatNoticeStore'
import { OUTSIDE_WORKSPACE_NOTICE } from '../../../lib/workspace-refusal'

const CONV = 'conv-x'

beforeEach(() => {
  cleanup()
  useChatStore.setState({ activeConversationId: CONV })
  useAgentModeStore.setState({ agentModeActive: { [CONV]: true }, workspaces: {} })
  useSettingsStore.getState().updateSettings({ defaultWorkspace: null })
  useChatNoticeStore.getState().clear()
})

describe('the pill shows where the agent really works', () => {
  it('nothing chosen: it says Choose…, grey, not Sandbox, and a click opens the folder choice', () => {
    // 3.1.2: the first message asks in the chat. Until then nothing is chosen,
    // and a green "Sandbox" here read as a choice already made.
    render(<AgentWorkspaceBadge />)
    const pill = screen.getByTestId('agent-workspace-pill')
    expect(pill.textContent).toBe('Choose…')
    expect(pill.textContent).not.toContain('Sandbox')
    expect(pill.className).not.toMatch(/emerald|green/)
    // Nothing of this chat's own to leave, so no x.
    expect(screen.queryByTestId('agent-workspace-leave')).toBeNull()
    fireEvent.click(pill)
    const options = screen.getByTestId('agent-workspace-options')
    expect(within(options).getByText('Pick a folder…')).toBeTruthy()
  })

  it('once Sandbox is chosen it says Sandbox', () => {
    useAgentModeStore.getState().setWorkspace(CONV, { kind: 'sandbox' })
    render(<AgentWorkspaceBadge />)
    expect(screen.getByTestId('agent-workspace-pill').textContent).toBe('Sandbox')
  })

  it('a remembered default folder is what the run uses, so that is what it shows', () => {
    useSettingsStore.getState().updateSettings({ defaultWorkspace: { kind: 'folder', path: 'C:\\Users\\x\\Documents\\notes' } })
    render(<AgentWorkspaceBadge />)
    expect(screen.getByTestId('agent-workspace-pill').textContent).toContain('notes')
  })

  it('agent mode off: no pill at all', () => {
    useAgentModeStore.setState({ agentModeActive: { [CONV]: false }, workspaces: {} })
    render(<AgentWorkspaceBadge />)
    expect(screen.queryByTestId('agent-workspace-pill')).toBeNull()
  })

  it('choosing a place clears the line about the refused file', () => {
    useChatNoticeStore.getState().show('agent-outside-workspace', OUTSIDE_WORKSPACE_NOTICE)
    render(<AgentWorkspaceBadge />)
    fireEvent.click(screen.getByTestId('agent-workspace-pill'))
    fireEvent.click(within(screen.getByTestId('agent-workspace-options')).getByText('Sandbox'))
    expect(useAgentModeStore.getState().workspaces[CONV]).toEqual({ kind: 'sandbox' })
    expect(useChatNoticeStore.getState().notices.map((n) => n.id)).not.toContain('agent-outside-workspace')
  })
})

describe('the refusal reaches the user whatever the model says', () => {
  it('the agent chat raises the line at the end of the run, from the applied calls', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '..', '..', '..', 'hooks', 'useAgentChat.ts'), 'utf8')
    expect(src).toContain('hasUnrecoveredOutsideRefusal(steps)')
    expect(src).toContain("show('agent-outside-workspace', OUTSIDE_WORKSPACE_NOTICE)")
    // In the finally, after every applyResultToToolCall, which is what turns
    // file_edit's text into a failure.
    expect(src.indexOf('hasUnrecoveredOutsideRefusal(steps)'))
      .toBeGreaterThan(src.lastIndexOf('applyResultToToolCall(entry.ac, result)'))
    expect(src.indexOf('hasUnrecoveredOutsideRefusal(steps)'))
      .toBeGreaterThan(src.indexOf('    } finally {', src.indexOf('// ── Agent Loop ──')))
  })
})
