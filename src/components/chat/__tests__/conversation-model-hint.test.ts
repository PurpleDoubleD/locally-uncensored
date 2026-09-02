/**
 * @vitest-environment jsdom
 *
 * Meldung 4, after David moved it out of sight (2026-09-02).
 *
 * "mach das woanders hin, versteckter bitte, muss nicht so sein."
 *
 * The information itself stays: a chat whose answers were written by another
 * model than the one picked right now still says so. It just says it on the
 * picker instead of in a chip of its own, as a 4 px dot plus the full sentence
 * in the tooltip. This file mounts the real composer and checks both ends of
 * that: the mark and the sentence are there when the two models differ, and
 * nothing at all is there when they do not.
 *
 * Run: npx vitest run src/components/chat/__tests__/conversation-model-hint.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { ChatView } from '../ChatView'
import { useChatStore } from '../../../stores/chatStore'
import { useModelStore } from '../../../stores/modelStore'
import { useUIStore } from '../../../stores/uiStore'
import { useCompareStore } from '../../../stores/compareStore'
import type { Conversation } from '../../../types/chat'

// The composer's dictation button reaches for the microphone and the Tauri
// bridge on mount. Neither exists here and neither is what this file is about.
vi.mock('../VoiceButton', () => ({ VoiceButton: () => null }))

const HERMES = 'openai::Hermes-3-Llama-3.2-3B.Q4_K_M'
const QWEN = 'openai::Qwen3-4B-Q4_K_M'
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0)

/** A chat with one question and one answer, the answer recorded as `by`. */
const chat = (by: string): Conversation => ({
  id: 'c1',
  title: 'KANARIE2',
  messages: [
    { id: 'm1', role: 'user', content: 'q', timestamp: NOW - 2000 },
    { id: 'm2', role: 'assistant', content: 'a', timestamp: NOW - 1000, modelId: by },
  ],
  model: by,
  systemPrompt: '',
  mode: 'lu',
  createdAt: NOW - 3000,
  updatedAt: NOW - 1000,
} as Conversation)

/** Open `conv` with the global pick standing on `picked`. */
function show(conv: Conversation, picked: string) {
  useChatStore.setState({ conversations: [conv], activeConversationId: conv.id })
  useModelStore.setState({ activeModel: picked, models: [] })
  render(createElement(ChatView))
}

/** The picker in the composer row. */
const picker = () => screen.getAllByLabelText('Select chat model')[0]

beforeEach(() => {
  useUIStore.setState({ currentView: 'chat', sidebarOpen: false })
  useCompareStore.setState({ isComparing: false })
})

afterEach(() => {
  cleanup()
})

describe('what the open chat ran on, now hidden on the picker', () => {
  it('the models differ: a dot marks the picker', () => {
    show(chat(HERMES), QWEN)
    const dot = screen.getByTestId('conversation-model-dot')
    // 4 px, gray, barely there. A mark, not a message.
    expect(dot.className).toContain('w-1')
    expect(dot.className).toContain('h-1')
    expect(dot.className).toContain('bg-gray-500')
    expect(dot.className).toContain('opacity-60')
    // Absolute, so the row keeps its width whether the dot is drawn or not.
    expect(dot.className).toContain('absolute')
  })

  it('the models differ: the picker tooltip says the whole thing', () => {
    show(chat(HERMES), QWEN)
    expect(picker().getAttribute('title')).toBe(
      'The answers in this chat were written by Hermes-3-Llama-3.2-3B.Q4_K_M. ' +
      'The next answer runs on the model picked here.',
    )
  })

  it('the models differ: the row still shows no second model name', () => {
    // This is the point of the move. The information is reachable, it is not
    // printed. The chip used to write "answers: <name>" right here.
    show(chat(HERMES), QWEN)
    expect(document.body.textContent).not.toContain('answers:')
    expect(picker().textContent).not.toContain('Hermes')
  })

  it('NEGATIVE CONTROL: same model, no dot and the ordinary tooltip', () => {
    // A chat continuing on the picked model has nothing to report, and saying
    // it anyway would print the same name twice.
    show(chat(QWEN), QWEN)
    expect(screen.queryByTestId('conversation-model-dot')).toBeNull()
    expect(picker().getAttribute('title')).toBe(
      'Model: Qwen3-4B-Q4_K_M, click to switch',
    )
  })

  it('NEGATIVE CONTROL: a chat with no answer yet claims nothing', () => {
    const fresh = { ...chat(HERMES), messages: [chat(HERMES).messages[0]] } as Conversation
    show(fresh, QWEN)
    expect(screen.queryByTestId('conversation-model-dot')).toBeNull()
    expect(picker().getAttribute('title')).toBe(
      'Model: Qwen3-4B-Q4_K_M, click to switch',
    )
  })
})
