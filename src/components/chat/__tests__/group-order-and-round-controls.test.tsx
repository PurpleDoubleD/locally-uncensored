// @vitest-environment jsdom
/**
 * 3.0.9, GH #199, #200, #201: what a person sees and clicks in a group chat.
 *
 *  - #200: the group menu shows the speaking order (1, 2, 3) and changes it
 *    with arrows or by dragging; the session strip names who answers the next
 *    round, lets a member sit it out, and offers Skip speaker and Stop round
 *    while a round runs.
 *  - #199: Regenerate on a speaker with later answers asks first; "Regenerate
 *    whole round" is an action of its own.
 *  - #201: an answer whose request left older turns out says so.
 *
 * Run: npx vitest run src/components/chat/__tests__/group-order-and-round-controls.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PluginsDropdown } from '../PluginsDropdown'
import { MessageList } from '../MessageList'
import { GroupRoundBar } from '../GroupRoundBar'
import { useChatStore } from '../../../stores/chatStore'
import { useModelStore } from '../../../stores/modelStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useGroupRoundStore, groupTurnStarted, groupRoundEnded } from '../../../stores/groupRoundStore'
import { BUILT_IN_PERSONAS, DEFAULT_SETTINGS } from '../../../lib/constants'
import type { AIModel } from '../../../types/models'
import type { Message } from '../../../types/chat'

const A = 'openai::walt'
const B = 'openai::baron'
const C = 'openai::clara'
const textModel = (name: string): AIModel => ({ name, type: 'text' } as AIModel)

let convId = ''
beforeEach(() => {
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useGroupRoundStore.setState({ live: {} })
  useModelStore.setState({ models: [textModel(A), textModel(B), textModel(C)], activeModel: A, inventoryLoaded: true })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, personas: [...BUILT_IN_PERSONAS] })
  convId = useChatStore.getState().createConversation(A, '')
  useChatStore.getState().setActiveConversation(convId)
  useChatStore.getState().setGroupModels(convId, [A, B, C])
})
afterEach(cleanup)

const conversation = () => useChatStore.getState().conversations.find((c) => c.id === convId)!
const orderShown = () => screen.getAllByTestId('group-order-row').map((r) => r.getAttribute('data-model'))

function openGroupMenu() {
  render(<PluginsDropdown openUpward />)
  fireEvent.click(screen.getByRole('button', { name: /Plugins/ }))
  fireEvent.click(screen.getByRole('button', { name: /Group chat/ }))
}

describe('GH #200: the speaking order in the group menu', () => {
  it('is shown, numbered, in the order of the round', () => {
    openGroupMenu()
    expect(orderShown()).toEqual([A, B, C])
    expect(screen.getAllByTestId('group-order-row').map((r) => r.textContent)).toEqual(['1walt', '2baron', '3clara'])
    // The place also stands at each ticked model in the list.
    expect(screen.getAllByTestId('group-participant-place').map((p) => p.textContent)).toEqual(['1', '2', '3'])
  })

  it('the arrows move a member one place', () => {
    openGroupMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Move clara up' }))
    expect(conversation().groupModels).toEqual([A, C, B])
    fireEvent.click(screen.getByRole('button', { name: 'Move walt down' }))
    expect(conversation().groupModels).toEqual([C, A, B])
    expect(orderShown()).toEqual([C, A, B])
    // The ends cannot move further.
    expect((screen.getByRole('button', { name: 'Move clara up' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Move baron down' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('dragging a row drops it at the place of the row it lands on', () => {
    openGroupMenu()
    const rows = screen.getAllByTestId('group-order-row')
    const data = { effectAllowed: '', setData: () => {}, getData: () => '' }
    fireEvent.dragStart(rows[2], { dataTransfer: data })
    fireEvent.dragOver(rows[0], { dataTransfer: data })
    fireEvent.drop(rows[0], { dataTransfer: data })
    expect(conversation().groupModels).toEqual([C, A, B])
  })
})

describe('GH #200: the round bar', () => {
  it('names the next round in order, and a click lets a member sit it out', () => {
    render(<GroupRoundBar onStop={() => {}} />)
    const chips = () => screen.getAllByTestId('group-next-speaker')
    expect(chips().map((c) => c.textContent)).toEqual(['1walt', '2baron', '3clara'])
    fireEvent.click(chips()[0])
    expect(conversation().groupSitOut).toEqual([A])
    expect(chips()[0].getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(chips()[0])
    expect(conversation().groupSitOut).toBeUndefined()
  })

  it('the last one answering cannot sit out too', () => {
    useChatStore.getState().setGroupSitOut(convId, [A, B])
    render(<GroupRoundBar onStop={() => {}} />)
    expect((screen.getAllByTestId('group-next-speaker')[2] as HTMLButtonElement).disabled).toBe(true)
  })

  it('while a round runs: who speaks, Skip speaker and Stop round', () => {
    const skip = vi.fn()
    const stop = vi.fn()
    groupTurnStarted(convId, { speaker: B, index: 1, total: 3 }, skip)
    render(<GroupRoundBar onStop={stop} />)
    expect(screen.getByTestId('group-round-speaker').textContent).toBe('2/3baron')
    fireEvent.click(screen.getByTestId('group-skip-speaker'))
    expect(skip).toHaveBeenCalledTimes(1)
    // A double click is one skip (T1 A8): it used to end the next turn too.
    fireEvent.click(screen.getByTestId('group-skip-speaker'))
    expect(skip).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('group-stop-round'))
    expect(stop).toHaveBeenCalledTimes(1)
    groupRoundEnded(convId)
  })

  it('the last speaker has nobody to skip to', () => {
    groupTurnStarted(convId, { speaker: C, index: 2, total: 3 }, () => {})
    render(<GroupRoundBar onStop={() => {}} />)
    expect((screen.getByTestId('group-skip-speaker') as HTMLButtonElement).disabled).toBe(true)
    groupRoundEnded(convId)
  })

  it('negative control: nothing in a chat that is not a group', () => {
    useChatStore.getState().setGroupModels(convId, [])
    const { container } = render(<GroupRoundBar onStop={() => {}} />)
    expect(container.innerHTML).toBe('')
  })
})

function seedRound(extra: Partial<Message>[] = []) {
  const messages: Message[] = [
    { id: 'u1', role: 'user', content: 'go', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: 'walt says', modelId: A, timestamp: 2 },
    { id: 'b1', role: 'assistant', content: 'baron says', modelId: B, timestamp: 3 },
    { id: 'c1', role: 'assistant', content: 'clara says', modelId: C, timestamp: 4 },
  ].map((m, i) => ({ ...m, ...(extra[i] ?? {}) })) as Message[]
  useChatStore.setState((s) => ({
    conversations: s.conversations.map((c) => (c.id === convId ? { ...c, messages } : c)),
  }))
}

/** The Regenerate of the n-th answer (0 walt, 1 baron, 2 clara). */
const regenerateOn = (n: number) => screen.getAllByRole('button', { name: 'Regenerate response' })[n]

describe('GH #199: regenerate in a group', () => {
  it('a speaker with later answers asks first: keep them, or from here', () => {
    seedRound()
    const one = vi.fn(async () => true)
    const whole = vi.fn()
    render(<MessageList isGenerating={false} onRegenerate={whole} onRegenerateSpeaker={one} />)
    fireEvent.click(regenerateOn(1))
    expect(one).not.toHaveBeenCalled()
    expect(screen.getByTestId('regen-speaker-question').textContent).toContain('One later speaker of this round already answered.')
    fireEvent.click(screen.getByTestId('regen-keep-later'))
    expect(one).toHaveBeenCalledWith(convId, 'b1', 'only')

    fireEvent.click(regenerateOn(0))
    expect(screen.getByTestId('regen-speaker-question').textContent).toContain('2 later speakers')
    fireEvent.click(screen.getByTestId('regen-from-here'))
    expect(one).toHaveBeenLastCalledWith(convId, 'a1', 'from-here')
    expect(whole).not.toHaveBeenCalled()
  })

  it('the last speaker regenerates at once, nothing to ask', () => {
    seedRound()
    const one = vi.fn(async () => true)
    render(<MessageList isGenerating={false} onRegenerate={() => {}} onRegenerateSpeaker={one} />)
    fireEvent.click(regenerateOn(2))
    expect(screen.queryByTestId('regen-speaker-question')).toBeNull()
    expect(one).toHaveBeenCalledWith(convId, 'c1', 'only')
  })

  it('a member who left the group is not offered to be asked again, the round still is (T1 A9)', () => {
    seedRound()
    useChatStore.getState().setGroupModels(convId, [A, B])
    const one = vi.fn(async () => true)
    render(<MessageList isGenerating={false} onRegenerate={() => {}} onRegenerateSpeaker={one} />)
    // walt and baron keep theirs; clara's answer has none any more.
    expect(screen.getAllByRole('button', { name: 'Regenerate response' })).toHaveLength(2)
    expect(screen.getAllByTestId('regenerate-round')).toHaveLength(3)
  })

  it('"Regenerate whole round" is its own action', () => {
    seedRound()
    const one = vi.fn(async () => true)
    const whole = vi.fn()
    render(<MessageList isGenerating={false} onRegenerate={whole} onRegenerateSpeaker={one} />)
    fireEvent.click(screen.getAllByTestId('regenerate-round')[1])
    expect(whole).toHaveBeenCalledWith(convId, 'b1')
    expect(one).not.toHaveBeenCalled()
  })
})

describe('GH #201: a trimmed request is said in the chat', () => {
  it('the answer whose request left turns out carries the line, with its speaker and window', () => {
    seedRound([{}, {}, { historyTrim: { dropped: 12, window: 262144 } }])
    render(<MessageList isGenerating={false} />)
    const notes = screen.getAllByTestId('history-trim-note')
    expect(notes).toHaveLength(1)
    expect(notes[0].textContent).toBe('12 earlier messages were not sent to baron: they no longer fit its 256K context. The chat itself keeps them.')
  })

  it('negative control: no line where the whole chat went out', () => {
    seedRound()
    render(<MessageList isGenerating={false} />)
    expect(screen.queryByTestId('history-trim-note')).toBeNull()
  })
})
