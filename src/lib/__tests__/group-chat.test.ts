// Group chat v1 (a user): turn order, attribution tagging, and the
// store half. Component wiring is source-guarded (no render harness here).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { isGroupChat, groupSystemPrompt, groupHistory, groupSpeakers, hasOwnPersonas, stripImpersonatedSpeakers, GROUP_CHAT_MAX } from '../group-chat'
import { useChatStore } from '../../stores/chatStore'
import type { Message } from '../../types/chat'

const msg = (o: Partial<Message>): Message => ({
  id: `m-${Math.random().toString(36).slice(2)}`,
  role: 'user',
  content: 'hello',
  timestamp: Date.now(),
  ...o,
})

describe('isGroupChat', () => {
  it('needs at least two models', () => {
    expect(isGroupChat(undefined)).toBe(false)
    expect(isGroupChat([])).toBe(false)
    expect(isGroupChat(['a'])).toBe(false)
    expect(isGroupChat(['a', 'b'])).toBe(true)
    expect(isGroupChat(['a', 'b', 'c', 'd'])).toBe(true)
  })
})

describe('groupSystemPrompt', () => {
  it('names the speaker and the other participants, not the speaker twice', () => {
    const p = groupSystemPrompt('qwen', ['qwen', 'gemma', 'llama'], '')
    expect(p).toContain('You are "qwen"')
    expect(p).toContain('"gemma"')
    expect(p).toContain('"llama"')
    expect(p.indexOf('"qwen"')).toBe(p.lastIndexOf('"qwen"'))
  })

  it('keeps the persona prompt in front when the chat has one', () => {
    const p = groupSystemPrompt('qwen', ['qwen', 'gemma'], 'You are a pirate.')
    expect(p.startsWith('You are a pirate.')).toBe(true)
    expect(p).toContain('You are "qwen"')
  })
})

describe('groupHistory', () => {
  const history: Message[] = [
    msg({ role: 'user', content: 'what is love' }),
    msg({ role: 'assistant', content: 'baby dont hurt me', modelId: 'gemma' }),
    msg({ role: 'assistant', content: 'no more', modelId: 'qwen' }),
    msg({ role: 'assistant', content: '' }),
  ]

  it('tags the OTHER models and leaves own turns clean', () => {
    const forQwen = groupHistory(history, 'qwen')
    expect(forQwen[1].content).toBe('[gemma] baby dont hurt me')
    expect(forQwen[2].content).toBe('no more')
  })

  it('leaves user lines untouched and drops empty placeholders', () => {
    const forQwen = groupHistory(history, 'qwen')
    expect(forQwen[0]).toMatchObject({ role: 'user', content: 'what is love' })
    expect(forQwen).toHaveLength(3)
  })

  it('carries image attachments through', () => {
    const withImg = [msg({ role: 'user', content: 'look', images: [{ name: 'x.png', data: 'AAA', mimeType: 'image/png' }] })]
    const out = groupHistory(withImg, 'qwen')
    expect(out[0].images).toEqual([{ data: 'AAA', mimeType: 'image/png' }])
  })
})

describe('stripImpersonatedSpeakers', () => {
  const others = ['phi-4-mini', 'granite-4.0-micro', 'hf.co/Qwen/Qwen3-4B-GGUF']

  it('cuts a fabricated next-speaker line and everything after it', () => {
    const out = stripImpersonatedSpeakers(
      'I disagree, because the topic is fresh.\n[phi-4-mini] Actually it is not.',
      others,
    )
    expect(out).toBe('I disagree, because the topic is fresh.')
  })

  it('cuts a whole impersonated multi-turn tail', () => {
    const out = stripImpersonatedSpeakers(
      'My take.\n\n[granite-4.0-micro] no\n[phi-4-mini] yes',
      others,
    )
    expect(out).toBe('My take.')
  })

  it('matches an id even when it contains regex metacharacters', () => {
    const out = stripImpersonatedSpeakers('Real.\n[hf.co/Qwen/Qwen3-4B-GGUF] fake', others)
    expect(out).toBe('Real.')
  })

  it('leaves an inline mention of another model untouched (negative control)', () => {
    const t = 'I agree with [phi-4-mini] on this one.'
    expect(stripImpersonatedSpeakers(t, others)).toBe(t)
  })

  it('leaves an ordinary bracketed word untouched (negative control)', () => {
    const t = 'See the note [1] and the label [draft] below.'
    expect(stripImpersonatedSpeakers(t, others)).toBe(t)
  })

  it('returns the text unchanged when there are no other models', () => {
    const t = 'solo answer'
    expect(stripImpersonatedSpeakers(t, [])).toBe(t)
  })
})

describe('chatStore.setGroupModels', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: [], activeConversationId: null })
  })

  it('stores the line-up on the conversation and caps it at four', () => {
    const id = useChatStore.getState().createConversation('gemma4:12b', '', 'lu')
    useChatStore.getState().setGroupModels(id, ['a', 'b', 'c', 'd', 'e'])
    const conv = useChatStore.getState().conversations[0]
    expect(conv.groupModels).toEqual(['a', 'b', 'c', 'd'])
    expect(conv.groupModels!.length).toBe(GROUP_CHAT_MAX)
  })

  it('clearing turns the chat back into a single-model chat', () => {
    const id = useChatStore.getState().createConversation('gemma4:12b', '', 'lu')
    useChatStore.getState().setGroupModels(id, ['a', 'b'])
    useChatStore.getState().setGroupModels(id, [])
    expect(isGroupChat(useChatStore.getState().conversations[0].groupModels)).toBe(false)
  })
})

describe('wiring (source guards)', () => {
  const useChatSrc = readFileSync(join(__dirname, '../../hooks/useChat.ts'), 'utf8')
  const bubbleSrc = readFileSync(join(__dirname, '../../components/chat/MessageBubble.tsx'), 'utf8')
  const pluginsSrc = readFileSync(join(__dirname, '../../components/chat/PluginsDropdown.tsx'), 'utf8')

  it('the group branch runs BEFORE the chat-tools router', () => {
    const branch = useChatSrc.indexOf('isGroupChat(groupConv.groupModels)')
    const router = useChatSrc.indexOf('resolveChatToolRoute(')
    expect(branch).toBeGreaterThan(-1)
    expect(router).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(router)
  })

  it('every group turn is labeled and one abort spans the whole round', () => {
    expect(useChatSrc).toContain('modelId: model')
    expect(useChatSrc).toContain('await runGroupTurn(convId, model, table, turn)')
    expect(useChatSrc).toContain('if (abort.signal.aborted) break')
    // The turn's controller follows the round's: Stop still ends the round.
    expect(useChatSrc).toContain("abort.signal.addEventListener('abort', endTurn)")
  })

  it('the bubble names the speaker only when a turn carries a model', () => {
    expect(bubbleSrc).toContain('{!isUser && message.modelId && (')
  })

  it('the dropdown writes the line-up onto the active conversation', () => {
    expect(pluginsSrc).toContain('setGroupModels(')
    expect(pluginsSrc).toContain('GROUP_CHAT_MAX')
  })
})

// ── 3.0.5, a user on Discord: a persona per participant ─────────────────
//
// Every model in a group used to answer under the ONE persona of the chat, so
// two models were both told they are the same character and spoke over each
// other. Each participant can now have its own.
describe('groupSpeakers', () => {
  const personas = [
    { id: 'sherlock', name: 'Sherlock', systemPrompt: 'You are Sherlock Holmes.' },
    { id: 'watson', name: 'Watson', systemPrompt: 'You are Doctor Watson.' },
  ]

  it('a participant with its own persona is called by it and speaks as it', () => {
    const speakers = groupSpeakers(['qwen', 'gemma'], { qwen: 'sherlock', gemma: 'watson' }, personas)
    expect(speakers).toEqual({
      qwen: { name: 'Sherlock', personaPrompt: 'You are Sherlock Holmes.', personaId: 'sherlock' },
      gemma: { name: 'Watson', personaPrompt: 'You are Doctor Watson.', personaId: 'watson' },
    })
    expect(hasOwnPersonas(speakers)).toBe(true)
  })

  it('THE DEFAULT IS WHAT IT WAS: no pick, no persona, the model name', () => {
    const speakers = groupSpeakers(['qwen', 'gemma'], undefined, personas)
    expect(speakers).toEqual({ qwen: { name: 'qwen' }, gemma: { name: 'gemma' } })
    expect(hasOwnPersonas(speakers)).toBe(false)
    expect(hasOwnPersonas(undefined)).toBe(false)
  })

  it('one participant may have a persona while the other follows the chat', () => {
    const speakers = groupSpeakers(['qwen', 'gemma'], { gemma: 'watson' }, personas)
    expect(speakers.qwen).toEqual({ name: 'qwen' })
    expect(speakers.gemma.name).toBe('Watson')
  })

  it('a persona that was deleted since reads as no pick, never as an empty role', () => {
    expect(groupSpeakers(['qwen'], { qwen: 'gone' }, personas)).toEqual({ qwen: { name: 'qwen' } })
  })

  it('two participants on the SAME persona still get two names', () => {
    const speakers = groupSpeakers(['qwen', 'gemma'], { qwen: 'sherlock', gemma: 'sherlock' }, personas)
    expect(speakers.qwen.name).toBe('Sherlock (qwen)')
    expect(speakers.gemma.name).toBe('Sherlock (gemma)')
  })

})

describe('groupSystemPrompt with own personas', () => {
  const speakers = {
    qwen: { name: 'Sherlock', personaPrompt: 'You are Sherlock Holmes.' },
    gemma: { name: 'Watson', personaPrompt: 'You are Doctor Watson.' },
    llama: { name: 'llama' },
  }
  const models = ['qwen', 'gemma', 'llama']

  it('each participant gets ITS persona, its own name and the others by name', () => {
    const sherlock = groupSystemPrompt('qwen', models, 'You are Sherlock Holmes.', speakers)
    expect(sherlock.startsWith('You are Sherlock Holmes.\n\n')).toBe(true)
    expect(sherlock).toContain('you are "Sherlock" and only "Sherlock"')
    expect(sherlock).toContain('The other participants are "Watson", "llama".')
    expect(sherlock).not.toContain('Doctor Watson')

    const watson = groupSystemPrompt('gemma', models, 'You are Doctor Watson.', speakers)
    expect(watson.startsWith('You are Doctor Watson.\n\n')).toBe(true)
    expect(watson).toContain('you are "Watson" and only "Watson"')
    expect(watson).toContain('The other participants are "Sherlock", "llama".')
    expect(watson).not.toContain('Sherlock Holmes')
  })

  it('tells the model not to take over another role', () => {
    const p = groupSystemPrompt('qwen', models, '', speakers)
    expect(p).toContain('never speak as another participant and never write their lines')
    expect(p).toContain('start with a [name] tag')
  })

  it('the participant without a persona is named by its model, and told the same', () => {
    const p = groupSystemPrompt('llama', models, 'BASE', speakers)
    expect(p).toContain('you are "llama" and only "llama"')
    expect(p).toContain('The other participants are "Sherlock", "Watson".')
  })

  it('NEGATIVE CONTROL: without own personas the wording is byte for byte the old one', () => {
    const plain = { qwen: { name: 'qwen' }, gemma: { name: 'gemma' } }
    expect(groupSystemPrompt('qwen', ['qwen', 'gemma'], 'P', plain)).toBe(groupSystemPrompt('qwen', ['qwen', 'gemma'], 'P'))
    expect(groupSystemPrompt('qwen', ['qwen', 'gemma'], 'P')).toBe(
      'P\n\nYou are "qwen", one of several AI models answering in the same group conversation with "gemma". ' +
      'What the other models said arrives as user messages that start with a [model-name] tag; the assistant messages are your own earlier turns. ' +
      'Answer as yourself in your own voice, add something new, and do not repeat what another model already said.',
    )
  })
})

describe('groupHistory with own personas', () => {
  const speakers = {
    qwen: { name: 'Sherlock', personaPrompt: 'S' },
    gemma: { name: 'Watson', personaPrompt: 'W' },
  }
  const history: Message[] = [
    { id: '1', role: 'user', content: 'who did it?', timestamp: 1 },
    { id: '2', role: 'assistant', content: 'The butler.', modelId: 'qwen', timestamp: 2 },
    { id: '3', role: 'assistant', content: 'Surely not.', modelId: 'gemma', timestamp: 3 },
  ]

  it('the other speaker arrives under its persona name, the own turns stay untagged', () => {
    expect(groupHistory(history, 'gemma', speakers).map((m) => [m.role, m.content])).toEqual([
      ['user', 'who did it?'],
      ['user', '[Sherlock] The butler.'],
      ['assistant', 'Surely not.'],
    ])
    expect(groupHistory(history, 'qwen', speakers).map((m) => [m.role, m.content])).toEqual([
      ['user', 'who did it?'],
      ['assistant', 'The butler.'],
      ['user', '[Watson] Surely not.'],
    ])
  })

  it('a turn by a model that has left the group keeps its model name', () => {
    const withGone: Message[] = [...history, { id: '4', role: 'assistant', content: 'Hm.', modelId: 'llama', timestamp: 4 }]
    expect(groupHistory(withGone, 'qwen', speakers).at(-1)!.content).toBe('[llama] Hm.')
  })

  it('a fabricated turn under the persona name is cut like one under the model name', () => {
    expect(stripImpersonatedSpeakers('My view.\n[Watson] I agree entirely.', ['gemma', 'Watson'])).toBe('My view.')
    expect(stripImpersonatedSpeakers('My view.\n[gemma] I agree entirely.', ['gemma', 'Watson'])).toBe('My view.')
  })
})
