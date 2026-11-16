// @vitest-environment jsdom
/**
 * 3.0.5, a user on Discord: in the group menu each participant gets its own
 * persona, picked next to its name and stored on the conversation. The default
 * is what a group has always done: follow the persona setting of the chat.
 *
 * The picker lives in the Plugins menu, at the participant list. Nothing of
 * it stands in or above the prompt field.
 *
 * Run: npx vitest run src/components/chat/__tests__/group-participants-pick-their-persona.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { PluginsDropdown } from '../PluginsDropdown'
import { MessageList } from '../MessageList'
import { useChatStore } from '../../../stores/chatStore'
import { useModelStore } from '../../../stores/modelStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { BUILT_IN_PERSONAS, DEFAULT_SETTINGS } from '../../../lib/constants'
import type { AIModel } from '../../../types/models'

const A = 'openai::model-a'
const B = 'openai::model-b'
const C = 'openai::model-c'
const SHERLOCK = { id: 'sherlock', name: 'Sherlock', icon: 'Search', systemPrompt: 'You are Sherlock Holmes.', isBuiltIn: false }
const WATSON = { id: 'watson', name: 'Watson', icon: 'User', systemPrompt: 'You are Doctor Watson.', isBuiltIn: false }

const textModel = (name: string): AIModel => ({ name, type: 'text' } as AIModel)

let convId = ''
beforeEach(() => {
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useModelStore.setState({ models: [textModel(A), textModel(B), textModel(C)], activeModel: A })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, personas: [...BUILT_IN_PERSONAS, SHERLOCK, WATSON] })
  convId = useChatStore.getState().createConversation(A, '')
  useChatStore.getState().setActiveConversation(convId)
})
afterEach(cleanup)

const conversation = () => useChatStore.getState().conversations.find((c) => c.id === convId)!
const participant = (model: string) =>
  screen.getAllByTestId('group-participant').find((row) => row.getAttribute('data-model') === model)!

function openGroupMenu() {
  render(<PluginsDropdown openUpward />)
  fireEvent.click(screen.getByRole('button', { name: /Plugins/ }))
  // 3.1.0: Group chat is a row with a switch. A chat that is a group has it
  // on already; otherwise the switch opens the list.
  const sw = screen.getByRole('button', { name: /Group chat/ })
  if (sw.getAttribute('aria-pressed') !== 'true') fireEvent.click(sw)
}

describe('the group menu', () => {
  it('a model that is not in the group has no persona control', () => {
    openGroupMenu()
    expect(screen.getAllByTestId('group-participant')).toHaveLength(3)
    expect(screen.queryAllByTestId('group-persona-trigger')).toHaveLength(0)
  })

  it('a participant gets one, and it starts on the chat persona', () => {
    useChatStore.getState().setGroupModels(convId, [A, B])
    openGroupMenu()
    expect(screen.getAllByTestId('group-persona-trigger')).toHaveLength(2)
    expect(within(participant(A)).getByTestId('group-persona-trigger').textContent).toBe('Chat persona')
    expect(within(participant(C)).queryByTestId('group-persona-trigger')).toBeNull()
  })

  it('picking a persona for one participant stores it for THAT model in THIS chat', () => {
    useChatStore.getState().setGroupModels(convId, [A, B])
    openGroupMenu()
    fireEvent.click(within(participant(A)).getByTestId('group-persona-trigger'))
    const list = within(participant(A)).getByTestId('group-persona-list')
    // Every existing persona is on offer, plus the way back.
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Chat persona',
      ...BUILT_IN_PERSONAS.map((p) => p.name),
      'Sherlock',
      'Watson',
    ])
    fireEvent.click(within(list).getByRole('button', { name: 'Sherlock' }))

    expect(conversation().groupPersonas).toEqual({ [A]: 'sherlock' })
    expect(within(participant(A)).getByTestId('group-persona-trigger').textContent).toBe('Sherlock')
    expect(within(participant(B)).getByTestId('group-persona-trigger').textContent).toBe('Chat persona')
    // The list closes after the pick.
    expect(screen.queryByTestId('group-persona-list')).toBeNull()
  })

  it('two participants hold two different personas', () => {
    useChatStore.getState().setGroupModels(convId, [A, B])
    openGroupMenu()
    fireEvent.click(within(participant(A)).getByTestId('group-persona-trigger'))
    fireEvent.click(within(participant(A)).getByRole('button', { name: 'Sherlock' }))
    fireEvent.click(within(participant(B)).getByTestId('group-persona-trigger'))
    fireEvent.click(within(participant(B)).getByRole('button', { name: 'Watson' }))
    expect(conversation().groupPersonas).toEqual({ [A]: 'sherlock', [B]: 'watson' })
  })

  it('"Chat persona" takes the pick back', () => {
    useChatStore.getState().setGroupModels(convId, [A, B])
    useChatStore.getState().setGroupPersona(convId, A, 'sherlock')
    openGroupMenu()
    fireEvent.click(within(participant(A)).getByTestId('group-persona-trigger'))
    const list = within(participant(A)).getByTestId('group-persona-list')
    expect(within(list).getByRole('button', { name: 'Sherlock' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(list).getByRole('button', { name: 'Chat persona' }))
    expect('groupPersonas' in conversation()).toBe(false)
  })

  it('clicking the model name still takes it out of the group, and its pick with it', () => {
    useChatStore.getState().setGroupModels(convId, [A, B])
    useChatStore.getState().setGroupPersona(convId, A, 'sherlock')
    openGroupMenu()
    fireEvent.click(within(participant(A)).getByRole('button', { name: 'model-a' }))
    expect(conversation().groupModels).toEqual([B])
    expect('groupPersonas' in conversation()).toBe(false)
  })

  it('NEGATIVE CONTROL: picking a participant persona does not touch the chat persona or the global one', () => {
    useChatStore.getState().setGroupModels(convId, [A, B])
    const before = useSettingsStore.getState().activePersonaId
    const chatSwitch = conversation().personaEnabled
    openGroupMenu()
    fireEvent.click(within(participant(A)).getByTestId('group-persona-trigger'))
    fireEvent.click(within(participant(A)).getByRole('button', { name: 'Sherlock' }))
    expect(useSettingsStore.getState().activePersonaId).toBe(before)
    expect(conversation().personaEnabled).toBe(chatSwitch)
    expect(conversation().systemPrompt).toBe('')
  })
})

describe('the transcript names who spoke as whom', () => {
  it('a participant with its own persona is labelled with it, the other only with its model', () => {
    useChatStore.getState().setGroupModels(convId, [A, B])
    useChatStore.getState().setGroupPersona(convId, A, 'sherlock')
    useChatStore.getState().addMessage(convId, { id: 'u', role: 'user', content: 'who did it?', timestamp: 1 })
    useChatStore.getState().addMessage(convId, { id: 'a', role: 'assistant', content: 'The butler.', modelId: A, timestamp: 2 })
    useChatStore.getState().addMessage(convId, { id: 'b', role: 'assistant', content: 'Surely not.', modelId: B, timestamp: 3 })
    render(<MessageList isGenerating={false} />)
    expect(screen.getAllByTestId('answered-by').map((el) => el.textContent)).toEqual(['Sherlock · model-a', 'model-b'])
  })
})
