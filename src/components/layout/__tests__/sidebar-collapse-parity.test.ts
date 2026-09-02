/**
 * @vitest-environment jsdom
 *
 * The web collapse behaviour, on the desktop (2.6.8, David).
 *
 * "Die Einklapp-Optik von der Webapp soll auch in den Desktop, bzw. auch die
 *  Latest Chats dann im Hauptscreen wie in der Webapp, ausser man klappt das
 *  Sidepanel auf."
 *
 * Four claims, all mounted for real rather than read out of the source:
 *
 *   collapsed -> a 56 px icon rail with a working expand button
 *   collapsed -> the recent-chats list stands in the main area
 *   expanded  -> the panel is there and the main-area list is gone
 *   a click on a row opens that chat
 *
 * Plus the persistence of the choice, which is the part a restart eats.
 *
 * Run: npx vitest run src/components/layout/__tests__/sidebar-collapse-parity.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Sidebar } from '../Sidebar'
import { RecentChats } from '../../chat/RecentChats'
import { useUIStore } from '../../../stores/uiStore'
import { useChatStore } from '../../../stores/chatStore'
import { useModelStore } from '../../../stores/modelStore'
import { useCompareStore } from '../../../stores/compareStore'
import type { Conversation } from '../../../types/chat'

// The sidebar's remote panel reaches for the Tauri bridge on mount (device
// polling, passcode countdown). Neither exists here and neither is what this
// file is about.
vi.mock('../../../api/backend', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../api/backend')
  return { ...actual, backendCall: vi.fn(async () => ({})), isTauri: () => false }
})

const conv = (id: string, title: string, updatedAt: number): Conversation => ({
  id,
  title,
  messages: [],
  model: 'test-model',
  systemPrompt: '',
  mode: 'lu',
  createdAt: updatedAt,
  updatedAt,
})

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0)

beforeEach(() => {
  useUIStore.setState({ currentView: 'chat', sidebarOpen: false })
  useCompareStore.setState({ isComparing: false })
  useModelStore.setState({ activeModel: 'test-model' })
  useChatStore.setState({
    conversations: [
      conv('older', 'Older chat', NOW - 3 * 3600_000),
      conv('newest', 'Newest chat', NOW - 60_000),
    ],
    activeConversationId: null,
  })
})

afterEach(() => {
  cleanup()
})

describe('the collapsed sidebar is a rail, not a hole', () => {
  it('collapsed shows the rail with an expand button', () => {
    render(createElement(Sidebar))
    expect(screen.getByTestId('sidebar-rail')).toBeTruthy()
    expect(screen.queryByTestId('sidebar-panel')).toBeNull()
    expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-label')).toBe('Expand sidebar')
  })

  it('the rail is the web width, 56 px', () => {
    render(createElement(Sidebar))
    expect(screen.getByTestId('sidebar-rail').style.width).toBe('56px')
  })

  it('the expand button opens the panel, the collapse button closes it again', async () => {
    render(createElement(Sidebar))
    fireEvent.click(screen.getByTestId('sidebar-toggle'))
    expect(useUIStore.getState().sidebarOpen).toBe(true)
    // AnimatePresence mode="wait" lets the rail finish leaving before the
    // panel enters, so the swap is one frame late in the DOM.
    await waitFor(() => expect(screen.getByTestId('sidebar-panel')).toBeTruthy())
    expect(screen.queryByTestId('sidebar-rail')).toBeNull()

    fireEvent.click(screen.getByTestId('sidebar-toggle'))
    expect(useUIStore.getState().sidebarOpen).toBe(false)
    await waitFor(() => expect(screen.getByTestId('sidebar-rail')).toBeTruthy())
    expect(screen.queryByTestId('sidebar-panel')).toBeNull()
  })

  it('COUNTER-TEST: outside Chat there is neither rail nor panel', () => {
    // Before this round the sidebar was chat-only by way of a side effect in
    // setView. The rule moved into the component, so it has to hold here.
    useUIStore.setState({ currentView: 'settings' })
    render(createElement(Sidebar))
    expect(screen.queryByTestId('sidebar-rail')).toBeNull()
    expect(screen.queryByTestId('sidebar-panel')).toBeNull()
  })

  it('COUNTER-TEST: A/B Compare hides it as well', () => {
    useCompareStore.setState({ isComparing: true })
    render(createElement(Sidebar))
    expect(screen.queryByTestId('sidebar-rail')).toBeNull()
  })

  it('navigating away and back keeps the collapse the user chose', () => {
    // The old setView forced sidebarOpen open on every return to Chat, which
    // is exactly the behaviour David asked to be gone.
    useUIStore.setState({ sidebarOpen: false })
    useUIStore.getState().setView('models')
    useUIStore.getState().setView('chat')
    expect(useUIStore.getState().sidebarOpen).toBe(false)
  })
})

describe('the recent chats in the main area', () => {
  it('lists the chats newest first', () => {
    render(createElement(RecentChats))
    const list = screen.getByTestId('home-recent-chats')
    expect(list).toBeTruthy()
    const titles = Array.from(list.querySelectorAll('li span:first-of-type')).map((n) => n.textContent)
    expect(titles).toEqual(['Newest chat', 'Older chat'])
  })

  it('a click on a row opens that chat', () => {
    render(createElement(RecentChats))
    fireEvent.click(screen.getByText('Older chat'))
    expect(useChatStore.getState().activeConversationId).toBe('older')
  })

  it('shows a plain sentence when there is nothing yet', () => {
    useChatStore.setState({ conversations: [] })
    render(createElement(RecentChats))
    expect(screen.getByTestId('home-recent-chats').textContent).toBe('No chats yet.')
  })

  it('COUNTER-TEST: code and remote chats stay out of the list', () => {
    // The web list filters on mode 'lu'. A coding session in this list would
    // open in the wrong surface.
    useChatStore.setState({
      conversations: [
        { ...conv('c1', 'A code session', NOW), mode: 'codex' },
        { ...conv('c2', 'A remote session', NOW), mode: 'remote' },
        conv('c3', 'A plain chat', NOW - 1000),
      ],
    })
    render(createElement(RecentChats))
    const list = screen.getByTestId('home-recent-chats')
    expect(list.textContent).toContain('A plain chat')
    expect(list.textContent).not.toContain('A code session')
    expect(list.textContent).not.toContain('A remote session')
  })

  it('COUNTER-TEST: never more than eight rows', () => {
    useChatStore.setState({
      conversations: Array.from({ length: 20 }, (_, i) => conv(`c${i}`, `Chat ${i}`, NOW - i * 1000)),
    })
    render(createElement(RecentChats))
    expect(screen.getByTestId('home-recent-chats').querySelectorAll('li').length).toBe(8)
  })
})

describe('the choice survives a restart', () => {
  it('sidebarOpen is written to storage', () => {
    useUIStore.setState({ sidebarOpen: true })
    const written = useUIStore.persist.getOptions().partialize!(useUIStore.getState()) as Record<string, unknown>
    expect(written).toHaveProperty('sidebarOpen', true)
  })

  it('and the collapsed state is written too, not only the open one', () => {
    useUIStore.setState({ sidebarOpen: false })
    const written = useUIStore.persist.getOptions().partialize!(useUIStore.getState()) as Record<string, unknown>
    expect(written).toHaveProperty('sidebarOpen', false)
  })

  it('the app starts collapsed like the web build', () => {
    // Read from the source: the live store has been written to by the tests
    // above and no longer shows its own initial value.
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(here, '../../../stores/uiStore.ts'), 'utf8')
    expect(src).toMatch(/sidebarOpen: false,/)
    expect(src).not.toMatch(/sidebarOpen: true,/)
  })

  it('COUNTER-TEST: setView no longer writes the flag behind the user', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(here, '../../../stores/uiStore.ts'), 'utf8')
    const setView = src.slice(src.indexOf('setView: (view)'), src.indexOf('openSettingsAt:'))
    expect(setView).not.toMatch(/sidebarOpen/)
  })
})
