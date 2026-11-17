// @vitest-environment jsdom
/**
 * 3.1.2: Agent fragt im Chat, wo er arbeitet.
 *
 * Einschalten oeffnet nichts mehr. Die erste Nachricht eines Chats ohne
 * Arbeitsordner wartet im Verlauf unter einer Karte "Sandbox / Folder…", und
 * nach der Wahl geht genau diese Nachricht hinaus.
 *
 * Lauf: npx vitest run src/components/chat/__tests__/agent-ordner-im-chat.test.tsx
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mobile = vi.hoisted(() => ({ on: false }))
vi.mock('../../../lib/device-kind', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isMobile: () => mobile.on,
}))
vi.mock('../../../api/backend', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  backendCall: vi.fn(),
  isTauri: () => true,
}))

import { WorkspaceAskCard } from '../WorkspaceAskCard'
import { backendCall } from '../../../api/backend'
import { useAgentModeStore } from '../../../stores/agentModeStore'
import { useChatStore } from '../../../stores/chatStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import {
  __resetWorkspaceAskForTests,
  hasOpenAsk,
  parkForWorkspaceAsk,
  resolveWorkspaceAsk,
  workspaceAskNeeded,
} from '../../../lib/agent-workspace-ask'

const call = vi.mocked(backendCall)
let CONV = ''

function messages() {
  return useChatStore.getState().conversations.find((c) => c.id === CONV)?.messages ?? []
}

beforeEach(() => {
  cleanup()
  call.mockReset()
  mobile.on = false
  __resetWorkspaceAskForTests()
  useAgentModeStore.setState({ workspaces: {}, agentModeActive: {}, lastFolder: undefined })
  useSettingsStore.getState().updateSettings({ defaultWorkspace: null })
  CONV = useChatStore.getState().createConversation('qwen2.5:7b', '')
  useAgentModeStore.getState().setAgentModeActive(CONV, true)
})

describe('wann gefragt wird', () => {
  it('ein Chat ohne Arbeitsordner und ohne Vorgabe fragt', async () => {
    expect(await workspaceAskNeeded(CONV)).toBe('')
  })

  it('ein Chat mit Arbeitsordner fragt nicht', async () => {
    useAgentModeStore.getState().setWorkspace(CONV, { kind: 'sandbox' })
    expect(await workspaceAskNeeded(CONV)).toBeNull()
  })

  it('ein gueltiger Vorgabeordner ersetzt die Frage, ein abgelehnter bringt seinen Grund mit', async () => {
    useSettingsStore.getState().updateSettings({ defaultWorkspace: { kind: 'folder', path: '/Users/x/repo' } })
    call.mockResolvedValueOnce(undefined)
    expect(await workspaceAskNeeded(CONV)).toBeNull()
    call.mockRejectedValueOnce(new Error('a home or mount container is not a workspace'))
    expect(await workspaceAskNeeded(CONV)).toMatch(/Cannot use "\/Users\/x\/repo"/)
  })

  it('auf dem Handy wird nie gefragt, dort gibt es nur die Sandbox', async () => {
    mobile.on = true
    expect(await workspaceAskNeeded(CONV)).toBeNull()
  })
})

describe('die Karte', () => {
  it('die Nachricht steht sofort im Verlauf, darunter die Frage mit zwei Wegen', () => {
    parkForWorkspaceAsk(CONV, 'build me a todo app', '')
    render(<WorkspaceAskCard conversationId={CONV} resend={vi.fn()} />)
    expect(messages().map((m) => [m.role, m.content])).toEqual([['user', 'build me a todo app']])
    expect(screen.getByText('Where should I work?')).toBeTruthy()
    expect(screen.getByTestId('workspace-ask-sandbox').textContent?.trim()).toBe('Sandbox')
    expect(screen.getByTestId('workspace-ask-folder').textContent?.trim()).toBe('Folder…')
    // Die Grenze steht vor der Wahl da, wie im Dialog.
    expect(screen.getByTestId('workspace-ask-boundary').textContent).toMatch(/Commands run on this computer/)
  })

  it('Sandbox setzt die Sandbox und schickt genau diese Nachricht weiter', async () => {
    const images = [{ data: 'aGk=', mimeType: 'image/png', name: 'a.png' }] as never
    parkForWorkspaceAsk(CONV, 'look at this', '', images)
    const resend = vi.fn()
    render(<WorkspaceAskCard conversationId={CONV} resend={resend} />)
    fireEvent.click(screen.getByTestId('workspace-ask-sandbox'))
    await waitFor(() => expect(resend).toHaveBeenCalledTimes(1))
    expect(resend).toHaveBeenCalledWith('look at this', images, undefined, undefined)
    expect(useAgentModeStore.getState().workspaces[CONV]).toEqual({ kind: 'sandbox' })
    // Die geparkte Zeile ist weg, der Sendeweg legt sie neu an: nie doppelt.
    expect(messages()).toEqual([])
    expect(hasOpenAsk(CONV)).toBe(false)
    expect(screen.queryByTestId('workspace-ask')).toBeNull()
  })

  it('Folder… oeffnet den Ordnerwaehler als Arbeitsordner und schickt nach der Wahl weiter', async () => {
    parkForWorkspaceAsk(CONV, 'fix the tests', '')
    call.mockResolvedValueOnce('/Users/x/app')
    const resend = vi.fn()
    render(<WorkspaceAskCard conversationId={CONV} resend={resend} />)
    fireEvent.click(screen.getByTestId('workspace-ask-folder'))
    await waitFor(() => expect(resend).toHaveBeenCalledWith('fix the tests', undefined, undefined, undefined))
    expect(call).toHaveBeenCalledWith('pick_folder', { asWorkspace: true })
    expect(useAgentModeStore.getState().workspaces[CONV]).toEqual({ kind: 'folder', path: '/Users/x/app', extraPaths: [] })
    expect(useAgentModeStore.getState().lastFolder).toBe('/Users/x/app')
  })

  it('abgebrochener Waehler laesst die Frage offen und sendet nichts', async () => {
    parkForWorkspaceAsk(CONV, 'fix the tests', '')
    call.mockResolvedValueOnce(null)
    const resend = vi.fn()
    render(<WorkspaceAskCard conversationId={CONV} resend={resend} />)
    fireEvent.click(screen.getByTestId('workspace-ask-folder'))
    await waitFor(() => expect(screen.getByTestId('workspace-ask-folder').textContent?.trim()).toBe('Folder…'))
    expect(resend).not.toHaveBeenCalled()
    expect(useAgentModeStore.getState().workspaces[CONV]).toBeUndefined()
    expect(messages()).toHaveLength(1)
  })

  it('ein abgelehnter Ordner steht als Grund da und wird nicht gesetzt', async () => {
    parkForWorkspaceAsk(CONV, 'fix the tests', '')
    call.mockRejectedValueOnce(new Error('Refusing a system folder as the workspace: /etc'))
    const resend = vi.fn()
    render(<WorkspaceAskCard conversationId={CONV} resend={resend} />)
    fireEvent.click(screen.getByTestId('workspace-ask-folder'))
    await waitFor(() => expect(screen.getByTestId('workspace-ask-error').textContent).toMatch(/system folder/))
    expect(resend).not.toHaveBeenCalled()
    expect(useAgentModeStore.getState().workspaces[CONV]).toBeUndefined()
  })

  it('der Grund fuer einen abgelehnten Vorgabeordner steht in der Karte', () => {
    parkForWorkspaceAsk(CONV, 'hi', 'Cannot use "/Users/x" as the workspace: nope.')
    render(<WorkspaceAskCard conversationId={CONV} resend={vi.fn()} />)
    expect(screen.getByTestId('workspace-ask-error').textContent).toMatch(/Cannot use/)
  })

  it('wer weiterschreibt statt zu waehlen, verliert nichts: alles geht als eine Nachricht', async () => {
    parkForWorkspaceAsk(CONV, 'first', '')
    parkForWorkspaceAsk(CONV, 'second', '')
    const resend = vi.fn()
    await resolveWorkspaceAsk(CONV, { kind: 'sandbox' }, resend)
    expect(resend).toHaveBeenCalledWith('first\n\nsecond', undefined, undefined, undefined)
    expect(messages()).toEqual([])
  })

  it('eine Wahl ueber die Plakette beantwortet die Karte mit', async () => {
    parkForWorkspaceAsk(CONV, 'hello', '')
    const resend = vi.fn()
    render(<WorkspaceAskCard conversationId={CONV} resend={resend} />)
    act(() => useAgentModeStore.getState().setWorkspace(CONV, { kind: 'folder', path: '/Users/x/b', extraPaths: [] }))
    await waitFor(() => expect(resend).toHaveBeenCalledWith('hello', undefined, undefined, undefined))
    expect(screen.queryByTestId('workspace-ask')).toBeNull()
  })

  it('geht die geparkte Nachricht anders weg (geloescht), geht die Frage mit', async () => {
    parkForWorkspaceAsk(CONV, 'hello', '')
    render(<WorkspaceAskCard conversationId={CONV} resend={vi.fn()} />)
    expect(screen.getByTestId('workspace-ask')).toBeTruthy()
    act(() => useChatStore.getState().deleteMessage(CONV, messages()[0].id))
    await waitFor(() => expect(hasOpenAsk(CONV)).toBe(false))
    expect(screen.queryByTestId('workspace-ask')).toBeNull()
  })

  it('ohne offene Frage zeigt die Karte nichts', () => {
    render(<WorkspaceAskCard conversationId={CONV} resend={vi.fn()} />)
    expect(screen.queryByTestId('workspace-ask')).toBeNull()
  })
})
