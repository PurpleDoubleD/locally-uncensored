/**
 * M7 · "Der Boot-Chunk ist zu 22 % Syntax-Highlighting", the three
 * subscription findings: Sidebar, ChatView and AppShell each subscribed to a
 * whole store, so the entire sidebar, the entire chat chrome and the entire
 * app tree re-rendered once per animation frame for the full duration of every
 * streamed answer.
 *
 * The first half of this file MEASURES that on the real chatStore: it streams
 * 300 tokens into a message and counts how often each subscription shape would
 * have woken React. The second half guards the source, because there is no
 * render harness in this repo (same approach as tool-media-lifetime.test.ts).
 *
 * Run: npx vitest run src/components/layout/__tests__/streaming-does-not-repaint-the-app.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useChatStore } from '../../../stores/chatStore'
import { sameSidebarRows, toSidebarRow, conversationMatches, type SidebarRow } from '../sidebar-rows'
import type { Message } from '../../../types/chat'

const SRC = resolve(__dirname, '..', '..', '..')
const read = (...p: string[]) => readFileSync(resolve(SRC, ...p), 'utf8')

/** Strip comments: the negative guards below look for a subscription SHAPE,
 *  and the comments explaining why that shape is gone contain it verbatim. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const sidebar = codeOnly(read('components', 'layout', 'Sidebar.tsx'))
const appShell = codeOnly(read('components', 'layout', 'AppShell.tsx'))
const chatView = codeOnly(read('components', 'chat', 'ChatView.tsx'))

const TOKENS = 300

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    ...overrides,
  }
}

/**
 * Run a selector after every one of TOKENS streamed appends and count how many
 * distinct values it produced. That count IS the number of renders the
 * component would have been woken for.
 */
function wakeUpsWhileStreaming<T>(selector: (s: ReturnType<typeof useChatStore.getState>) => T): number {
  const id = useChatStore.getState().createConversation('m', '', 'lu')
  const m = message()
  useChatStore.getState().addMessage(id, m)

  let previous = selector(useChatStore.getState())
  let wakeUps = 1 // the first render
  let content = ''
  for (let i = 0; i < TOKENS; i++) {
    content += 'token '
    useChatStore.getState().updateMessageContent(id, m.id, content)
    const next = selector(useChatStore.getState())
    if (!Object.is(next, previous)) {
      wakeUps++
      previous = next
    }
  }
  return wakeUps
}

beforeEach(() => {
  useChatStore.setState({ conversations: [], activeConversationId: null })
})

describe('what a streamed answer costs each subscription shape', () => {
  it('the whole store wakes the subscriber on every single token', () => {
    // This is the shape Sidebar (useChatStore()) and AppShell (useUIStore())
    // used. The number is the finding.
    expect(wakeUpsWhileStreaming((s) => s)).toBe(TOKENS + 1)
  })

  it('so does the bare conversations array — the ChatView shape', () => {
    // A "targeted" selector is not automatically a cheap one: the array is
    // REPLACED on every flush, so `s.conversations` changes identity as often
    // as the whole store does.
    expect(wakeUpsWhileStreaming((s) => s.conversations)).toBe(TOKENS + 1)
  })

  it('the mode of the active conversation wakes it exactly once', () => {
    // ChatView's replacement: a string that does not move while tokens arrive.
    const wakeUps = wakeUpsWhileStreaming(
      (s) => s.conversations.find((c) => c.id === s.activeConversationId)?.mode,
    )
    expect(wakeUps).toBe(1)
  })

  it('the sidebar row projection wakes it exactly once', () => {
    // The production selector, verbatim: project, and hand back the previous
    // array whenever the projection is unchanged.
    let cache: SidebarRow[] = []
    const wakeUps = wakeUpsWhileStreaming((s) => {
      const next = s.conversations.map(toSidebarRow)
      if (sameSidebarRows(cache, next)) return cache
      cache = next
      return next
    })
    expect(wakeUps).toBe(1)
  })

  it('the message COUNT wakes it per message, not per token', () => {
    // The dispatched-chat QR auto-hide reads this. One append, one wake-up.
    expect(wakeUpsWhileStreaming((s) => s.conversations[0]?.messages.length ?? 0)).toBe(1)
  })
})

describe('the projection still reflects everything a row paints', () => {
  it('a rename changes the projection', () => {
    const a = [toSidebarRow({ id: '1', title: 'Old', messages: [], model: '', systemPrompt: '', createdAt: 0, updatedAt: 0 })]
    const b = [toSidebarRow({ id: '1', title: 'New', messages: [], model: '', systemPrompt: '', createdAt: 0, updatedAt: 0 })]
    expect(sameSidebarRows(a, b)).toBe(false)
  })

  it('a new chat changes the projection', () => {
    const base = { title: 'x', messages: [], model: '', systemPrompt: '', createdAt: 0, updatedAt: 0 }
    const a = [toSidebarRow({ ...base, id: '1' })]
    const b = [toSidebarRow({ ...base, id: '1' }), toSidebarRow({ ...base, id: '2' })]
    expect(sameSidebarRows(a, b)).toBe(false)
  })

  it('a mode switch changes the projection', () => {
    const base = { id: '1', title: 'x', messages: [], model: '', systemPrompt: '', createdAt: 0, updatedAt: 0 }
    expect(sameSidebarRows(
      [toSidebarRow({ ...base, mode: 'lu' })],
      [toSidebarRow({ ...base, mode: 'codex' })],
    )).toBe(false)
  })

  it('the row carries the FORMATTED date, not the raw timestamp', () => {
    // The raw timestamp is rewritten by every flush; "Just now" is not. This
    // is the single field that decides whether the list stands still.
    const row = toSidebarRow({
      id: '1', title: 'x', messages: [], model: '', systemPrompt: '',
      createdAt: 0, updatedAt: Date.now(),
    })
    expect(row.date).toBe('Just now')
    expect(row).not.toHaveProperty('updatedAt')
  })
})

describe('search still finds what it found before', () => {
  const conv = {
    id: '1', title: 'Rust notes', model: '', systemPrompt: '', createdAt: 0, updatedAt: 0,
    messages: [message({ content: 'Borrow checker BASICS' }), message({ content: 'lifetimes' })],
  }

  it('matches on the title, case-folded', () => {
    expect(conversationMatches(conv, 'rust')).toBe(true)
  })

  it('matches inside a message body, case-folded', () => {
    expect(conversationMatches(conv, 'basics')).toBe(true)
  })

  it('does not match what is not there', () => {
    expect(conversationMatches(conv, 'python')).toBe(false)
  })
})

// ── source guards ──────────────────────────────────────────────────────────

describe('Sidebar subscribes to what it paints', () => {
  it('no whole-store subscription is left', () => {
    for (const store of ['useChatStore', 'useUIStore', 'useModelStore', 'useSettingsStore', 'useRemoteStore']) {
      // `useStore()` with no selector is the shape that costs a render per
      // frame. `useStore.getState()` and `useStore((s) => …)` are fine.
      expect(sidebar, store).not.toMatch(new RegExp(`${store}\\(\\)`))
    }
  })

  it('the list reads the projection, not the conversations array', () => {
    expect(sidebar).toContain('sameSidebarRows(rowCache.current, next)')
    // The only remaining reads of the raw array are at click time.
    const subscribed = sidebar.match(/useChatStore\(\(s\) => s\.conversations\b/g) ?? []
    expect(subscribed).toHaveLength(0)
  })

  it('the corpus scan is memoised and deferred, not re-run in the render body', () => {
    expect(sidebar).toContain('useDeferredValue(search)')
    expect(sidebar).toMatch(/const matches = useMemo\(/)
    // The old shape lowercased the needle once per conversation AND once per
    // message, inside the render body.
    expect(sidebar).not.toMatch(/includes\(search\.toLowerCase\(\)\)/)
  })
})

describe('ChatView subscribes to what it paints', () => {
  it('does not subscribe to the conversations array', () => {
    expect(chatView).not.toMatch(/useChatStore\(\(s\) => s\.conversations\)/)
    expect(chatView).toContain('const activeConvMode = useChatStore(')
  })

  it('reads the model / system prompt / export payload at click time instead', () => {
    expect(chatView).toMatch(/useChatStore\.getState\(\)\.conversations\s*\n?\s*\.find/)
  })
})

describe('AppShell subscribes to what it paints', () => {
  it('no whole-store uiStore subscription — the resize handle writes to it', () => {
    // ExplorerPanel's divider calls setExplorerWidth on every pointermove.
    // With `useUIStore()` here, that re-rendered Titlebar, Header, Sidebar and
    // the whole active view at pointer-event frequency.
    expect(appShell).not.toMatch(/useUIStore\(\)/)
    expect(appShell).toContain('useUIStore((s) => s.currentView)')
  })

  it('the same goes for the settings store it renders from', () => {
    expect(appShell).not.toMatch(/useSettingsStore\(\)/)
  })
})
