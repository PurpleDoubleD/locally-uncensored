// @vitest-environment jsdom
/**
 * GH #223 (07.11.2026): "when I select a workspace folder, I can't change it".
 * Der Ordnerdialog sprang beim Wiederoeffnen gleich zu den Zusatzordnern. Dort
 * liessen sich Extras hinzufuegen und entfernen, der Hauptordner aber stand fest.
 * Derselbe Dialog sitzt in Voice, in der Agent-Plakette und im Umschalter.
 *
 * Jetzt: Hauptordner wechseln, ein Extra zum Hauptordner machen, den
 * Hauptordner entfernen (ein Extra rueckt nach, ohne Extras geht es zurueck
 * zur Auswahl).
 *
 * Lauf: npx vitest run src/components/chat/__tests__/der-hauptordner-laesst-sich-wechseln.test.tsx
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../../../api/backend', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  backendCall: vi.fn(),
  isTauri: () => true,
}))

import { AgentWorkspaceDialog } from '../AgentWorkspaceDialog'
import { backendCall } from '../../../api/backend'
import { useAgentModeStore } from '../../../stores/agentModeStore'
import type { AgentWorkspace } from '../../../types/agent-workspace'

const call = vi.mocked(backendCall)
const A = 'C:\\Users\\jade\\random'
const B = 'D:\\code\\project'
const C = 'D:\\code\\other'

beforeEach(() => {
  cleanup()
  call.mockReset()
  useAgentModeStore.setState({ lastFolder: null, workspaces: {} })
})

function openOn(initial: AgentWorkspace) {
  const onChoose = vi.fn()
  render(
    <AgentWorkspaceDialog open conversationId="voice" initialWorkspace={initial} onChoose={onChoose} onClose={() => {}} />,
  )
  return onChoose
}

const primaryText = () => screen.getByTestId('agent-workspace-primary').textContent ?? ''

describe('the primary workspace folder can be changed and removed', () => {
  it('Change… picks a new primary and saves it', async () => {
    call.mockResolvedValueOnce(B)
    const onChoose = openOn({ kind: 'folder', path: A, extraPaths: [] })
    fireEvent.click(screen.getByTestId('agent-workspace-change-primary'))
    await waitFor(() => expect(primaryText()).toContain(B))
    expect(call).toHaveBeenCalledWith('pick_folder', { asWorkspace: true })
    fireEvent.click(screen.getByTestId('agent-workspace-save'))
    expect(onChoose).toHaveBeenCalledWith({ kind: 'folder', path: B, extraPaths: [] })
  })

  it('a cancelled picker keeps the primary', async () => {
    call.mockResolvedValueOnce(null)
    const onChoose = openOn({ kind: 'folder', path: A, extraPaths: [B] })
    fireEvent.click(screen.getByTestId('agent-workspace-change-primary'))
    await waitFor(() => expect(screen.getByTestId('agent-workspace-change-primary').hasAttribute('disabled')).toBe(false))
    fireEvent.click(screen.getByTestId('agent-workspace-save'))
    expect(onChoose).toHaveBeenCalledWith({ kind: 'folder', path: A, extraPaths: [B] })
  })

  it('picking an extra as the new primary does not list it twice', async () => {
    call.mockResolvedValueOnce('d:/CODE/project/')
    const onChoose = openOn({ kind: 'folder', path: A, extraPaths: [B, C] })
    fireEvent.click(screen.getByTestId('agent-workspace-change-primary'))
    await waitFor(() => expect(primaryText()).toContain('d:/CODE/project/'))
    fireEvent.click(screen.getByTestId('agent-workspace-save'))
    expect(onChoose).toHaveBeenCalledWith({ kind: 'folder', path: 'd:/CODE/project/', extraPaths: [C] })
  })

  it('Make primary swaps an extra with the primary, and the old one can then go', () => {
    const onChoose = openOn({ kind: 'folder', path: A, extraPaths: [B, C] })
    fireEvent.click(screen.getAllByTestId('agent-workspace-make-primary')[0])
    expect(primaryText()).toContain(B)
    // The old primary is now the first extra; remove it like any extra.
    fireEvent.click(screen.getAllByTitle('Remove').find((el) => el.getAttribute('data-testid') !== 'agent-workspace-remove-primary')!)
    fireEvent.click(screen.getByTestId('agent-workspace-save'))
    expect(onChoose).toHaveBeenCalledWith({ kind: 'folder', path: B, extraPaths: [C] })
  })

  it('removing the primary moves the first extra up', () => {
    const onChoose = openOn({ kind: 'folder', path: A, extraPaths: [B, C] })
    fireEvent.click(screen.getByTestId('agent-workspace-remove-primary'))
    expect(primaryText()).toContain(B)
    fireEvent.click(screen.getByTestId('agent-workspace-save'))
    expect(onChoose).toHaveBeenCalledWith({ kind: 'folder', path: B, extraPaths: [C] })
  })

  it('removing the only folder goes back to the choices, where Sandbox clears it', () => {
    const onChoose = openOn({ kind: 'folder', path: A, extraPaths: [] })
    fireEvent.click(screen.getByTestId('agent-workspace-remove-primary'))
    expect(screen.queryByTestId('agent-workspace-extras')).toBeNull()
    expect(screen.getByTestId('agent-workspace-options')).toBeTruthy()
    expect(onChoose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Sandbox'))
    expect(onChoose).toHaveBeenCalledWith({ kind: 'sandbox' })
  })
})
