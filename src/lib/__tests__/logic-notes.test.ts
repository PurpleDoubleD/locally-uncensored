/**
 * A sentence of the logic layer is never the text of an answer (acceptance on
 * the large iPhone, G8).
 *
 * The chat hook and the agent loop write what went wrong into `content`. Only
 * some of these paths also write the field. This pins, for EVERY sentence
 * either of them can write:
 *   1. the reader (viewAnswer) gives an answer text without the sentence,
 *      and an error that carries it,
 *   2. the preview of the chat list, the search, Copy and Share never see it,
 *   3. the hooks still write the sentences this file knows (read from their
 *      source, so a new branch in a catch cannot slip by).
 *
 * Run: npx vitest run src/lib/__tests__/logic-notes.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DISCONNECT_WITHOUT_ANSWER, emptyAnswerExplanation } from '../answer-notes'
import { CREDITS_EXHAUSTED_MESSAGE } from '../credits-exhausted'
import { AGENT_ERROR_HEAD, RATE_LIMIT_HEAD, SWITCHED_MODEL_HEAD, REQUEST_LIMIT_FALLBACK_HEAD, THINKING_UNSUPPORTED_HEAD, splitLogicNote } from '../logic-notes'
import { requestLimitMessage } from '../request-limit'
import { answerBody, viewAnswer } from '../message-error'
import { MULTIMODAL_UNSUPPORTED_MESSAGE } from '../ollama-errors'
import { PLATFORM_TEXTS } from '../platform-text'
import { BAD_REQUEST_SENTENCE, TEMPLATE_REFUSAL_SENTENCE, explainSendRefusal } from '../template-refusal'
import { matchChats, previewLine } from '../../mobile/screens/chat/parts/logic/chat-list'
import { messageText } from '../../mobile/screens/chat/parts/logic/messages'
import type { Conversation, Message } from '../../types/chat'

const here = dirname(fileURLToPath(import.meta.url))
const chatHook = readFileSync(resolve(here, '../../hooks/useChat.ts'), 'utf8')
const agentHook = readFileSync(resolve(here, '../../hooks/useAgentChat.ts'), 'utf8')

const THINKING_LITERAL = 'This model does not support thinking mode. Disable the Think button or switch to a compatible model (Qwen 3, DeepSeek-R1, Gemma 4).'
// What the agent loop wrote up to 2.5. No hook writes it any more, chats saved back then still carry it.
const RATE_LIMIT_LITERAL =
  'The server is limiting how many requests this account may send in a short window, and the run waited for it once already. Give it a minute, then send your message again. Nothing was charged for the refused attempts.'
const PLAN_LINE = '\n\nThe plan stopped at 2 of 5. Everything finished so far stays in this chat. After signing in, send a new message naming only what is still left, rather than the original prompt.'

/** Every sentence a run can leave in `content`, with what the reader must make of it. */
const SENTENCES: { name: string; text: string; kind: string; finishReason?: string; thinking?: string; aloneOnly?: true }[] = [
  { name: 'stream broke before any text', text: DISCONNECT_WITHOUT_ANSWER, kind: 'network', finishReason: 'disconnect' },
  { name: 'token budget gone, nothing written', text: emptyAnswerExplanation({ finishReason: 'length', captured: false, keepThinking: false }), kind: 'empty', finishReason: 'length' },
  { name: 'token budget gone while thinking', text: emptyAnswerExplanation({ finishReason: 'length', captured: true, keepThinking: true }), kind: 'empty', finishReason: 'length', thinking: 'hm', aloneOnly: true },
  { name: 'thought and never answered', text: emptyAnswerExplanation({ captured: true, keepThinking: true }), kind: 'empty', thinking: 'hm', aloneOnly: true },
  { name: 'the model was switched before any text', text: emptyAnswerExplanation({ finishReason: 'model_switch', captured: false, keepThinking: false }), kind: 'empty', finishReason: 'model_switch' },
  { name: 'LU Cloud ended the agent run for repeating, before any text', text: emptyAnswerExplanation({ finishReason: 'agent_loop_detected', captured: false, keepThinking: false }), kind: 'empty', finishReason: 'agent_loop_detected' },
  { name: 'LU Cloud ended the agent run at its step limit, before any text', text: emptyAnswerExplanation({ finishReason: 'agent_run_limit', captured: false, keepThinking: false }), kind: 'empty', finishReason: 'agent_run_limit' },
  { name: 'nothing visible came back', text: emptyAnswerExplanation({ captured: true, keepThinking: false }), kind: 'empty' },
  { name: 'picture for a model without eyes', text: MULTIMODAL_UNSUPPORTED_MESSAGE, kind: 'generic' },
  { name: 'template refused', text: explainSendRefusal(new Error('jinja: raise_exception')) ?? '', kind: 'generic' },
  { name: 'backend said 400', text: explainSendRefusal(Object.assign(new Error('bad request'), { status: 400 })) ?? BAD_REQUEST_SENTENCE, kind: 'generic' },
  { name: 'model cannot think', text: THINKING_LITERAL, kind: 'generic' },
  { name: 'empty wallet', text: CREDITS_EXHAUSTED_MESSAGE, kind: 'credits' },
  { name: 'empty wallet in a plan', text: `${CREDITS_EXHAUSTED_MESSAGE}\n\nThe plan stopped at 2 of 5. Everything finished so far stays in this chat.`, kind: 'credits' },
  { name: 'session ended, phone wording', text: PLATFORM_TEXTS.cloudSessionEndedMidRun.mobile + PLAN_LINE, kind: 'session' },
  { name: 'session ended, desktop wording', text: PLATFORM_TEXTS.cloudSessionEndedMidRun.desktop, kind: 'session' },
  { name: 'rate limit that did not clear, old wording', text: RATE_LIMIT_LITERAL, kind: 'generic' },
  { name: 'rate limit, the sentence of the app', text: requestLimitMessage({}), kind: 'limit' },
  { name: 'rate limit, the sentence of the app with a wait', text: requestLimitMessage({ retryAfterMs: 20_000, nothingCharged: true }), kind: 'limit' },
  { name: 'backend lost, phone wording', text: PLATFORM_TEXTS.agentBackendLost.mobile.replace('{details}', 'error sending request for url'), kind: 'engine' },
  { name: 'backend lost, desktop wording', text: PLATFORM_TEXTS.agentBackendLost.desktop.replace('{details}', 'HTTP 502'), kind: 'engine' },
  { name: 'no tools, phone wording', text: PLATFORM_TEXTS.agentNoToolSupport.mobile, kind: 'generic' },
  { name: 'no tools, desktop wording', text: PLATFORM_TEXTS.agentNoToolSupport.desktop, kind: 'generic' },
  { name: 'tool transport switched', text: PLATFORM_TEXTS.agentToolTransportSwitched.mobile, kind: 'generic' },
  { name: 'agent error, engine', text: 'Agent error: llama runner out of memory', kind: 'engine' },
  { name: 'agent error, anything', text: 'Agent error: something odd', kind: 'generic' },
]

/** The words of a sentence that would give it away in a text. */
function marks(text: string): string {
  return text.split('\n')[0].slice(0, 40)
}

const msg = (content: string, extra: Partial<Message> = {}): Message => ({ id: 'a1', role: 'assistant', content, timestamp: 2, modelId: 'SmolLM2-360M', ...extra }) as Message
const chat = (messages: Message[]): Conversation => ({ id: 'c', title: 'T', messages, model: 'x', systemPrompt: '', createdAt: 1, updatedAt: 1 }) as Conversation
const asked = { id: 'u1', role: 'user', content: 'What I asked', timestamp: 1 } as Message

describe('G8: no sentence of a failed run is the text of the answer', () => {
  it('the list has no empty entry', () => {
    for (const s of SENTENCES) expect(s.text.length, s.name).toBeGreaterThan(20)
    expect(explainSendRefusal(new Error('jinja: raise_exception'))).toContain(TEMPLATE_REFUSAL_SENTENCE.slice(0, 40))
  })

  for (const s of SENTENCES) {
    it(`${s.name}: alone it leaves no answer text, and the error says what happened`, () => {
      const message = msg(s.text, { finishReason: s.finishReason as Message['finishReason'], thinking: s.thinking })
      const view = viewAnswer(message, { cloud: false })
      expect(view.body).toBe('')
      expect(view.error?.kind).toBe(s.kind)
      expect(answerBody(message)).toBe('')
      expect(messageText(message)).toBe('')
    })

    // The two sentences about thinking are only written into an answer that has no text at all.
    it.skipIf(s.aloneOnly)(`${s.name}: behind a part of the answer, the part stays and the sentence goes`, () => {
      const message = msg(`The part that arrived.\n\n${s.text}`, { finishReason: s.finishReason as Message['finishReason'], thinking: s.thinking })
      const view = viewAnswer(message, { cloud: false })
      expect(view.body).toBe('The part that arrived.')
      expect(view.error).not.toBeNull()
      expect(view.body).not.toContain(marks(s.text))
    })

    it(`${s.name}: the chat list shows the question, the search does not find the sentence`, () => {
      const c = chat([asked, msg(s.text, { finishReason: s.finishReason as Message['finishReason'], thinking: s.thinking })])
      expect(previewLine(c)).toBe('What I asked')
      const word = marks(s.text).split(/\s+/).find((w) => w.length > 6 && !'What I asked'.includes(w)) ?? ''
      if (word) expect(matchChats([c], word)).toEqual([])
    })
  }

  it('the report of the large iPhone: the sentence about the connection is not the preview of the chat', () => {
    const c = chat([asked, msg('An earlier answer.'), { ...asked, id: 'u2', content: 'What is the secret code of file 11?' }, msg(DISCONNECT_WITHOUT_ANSWER, { id: 'a2', finishReason: 'disconnect' })])
    expect(previewLine(c)).toBe('An earlier answer.')
    expect(previewLine(c)).not.toMatch(/connection/i)
  })

  it('a field written by the hook still wins', () => {
    const view = viewAnswer(msg(`Part\n\n${CREDITS_EXHAUSTED_MESSAGE}`, { error: { kind: 'credits', detail: '', at: 4 } }))
    expect(view).toEqual({ body: 'Part', error: { kind: 'credits', detail: '' } })
  })

  it('a request limit in the words of the server: the field carries it, the answer keeps its part', () => {
    const said = 'This model is at its shared limit. Try again in about 40 seconds.'
    expect(splitLogicNote(`Part\n\n${said}`)).toBeNull()
    const view = viewAnswer(msg(`Part\n\n${said}`, { error: { kind: 'limit', detail: said, at: 4 } }))
    expect(view).toEqual({ body: 'Part', error: { kind: 'limit', detail: said } })
  })

  it('the model that cannot think gets a sentence without a button of the desktop', () => {
    expect(viewAnswer(msg(THINKING_LITERAL)).error?.detail).not.toMatch(/Think button/)
  })
})

describe('G8: an answer of a model is left alone', () => {
  const answers = [
    'Agent error handling is a broad topic. Agent error: is what the log prints.',
    'Here is why "The model hit its token limit before writing an answer." shows up: the budget was too small.',
    "Sure.\n\nI didn't return anything the first time because the stream broke.",
    'This model does not support thinking, as the card says.',
    'The server is limited to 10 requests.',
    'Lost the connection? Check the router first.',
  ]
  for (const text of answers) {
    it(text.slice(0, 50), () => {
      expect(splitLogicNote(text)).toBeNull()
      expect(viewAnswer(msg(text))).toEqual({ body: text, error: null })
    })
  }
  it('nothing is judged while the answer is still being written', () => {
    expect(viewAnswer(msg(DISCONNECT_WITHOUT_ANSWER), { streaming: true })).toEqual({ body: DISCONNECT_WITHOUT_ANSWER, error: null })
  })
})

describe('guard: the hooks write the sentences this reader knows', () => {
  const catchOf = (source: string, marker: string): string => {
    const from = source.indexOf(marker)
    expect(from, marker).toBeGreaterThan(0)
    const start = source.lastIndexOf('} catch (err) {', from)
    return source.slice(start, source.indexOf('} finally {', from))
  }

  it('the literals are still in the hooks, word for word', () => {
    expect(chatHook).toContain(THINKING_LITERAL)
    expect(agentHook).toContain(THINKING_LITERAL)
    expect(THINKING_LITERAL.startsWith(THINKING_UNSUPPORTED_HEAD)).toBe(true)
    // The sentence of a request limit is no literal of the hook any more: lib/request-limit.ts chooses it, and
    // it may be the server's own. The reader knows the app's sentence by its start; for the server's the hook
    // has to write the field, in the same branch.
    expect(agentHook).not.toContain(RATE_LIMIT_HEAD)
    for (const facts of [{}, { retryAfterMs: 20_000 }, { nothingCharged: true, again: 'try again' }]) {
      expect(requestLimitMessage(facts).startsWith(REQUEST_LIMIT_FALLBACK_HEAD)).toBe(true)
    }
    const from = agentHook.indexOf('} else if (httpStatusOf(err) === 429) {')
    expect(from).toBeGreaterThan(0)
    const branch = agentHook.slice(from, agentHook.indexOf('} else if (', from + 10))
    expect(branch).toContain('const limitText = requestLimitMessageOf(err')
    expect(branch.match(/updateMessageContent\(/g)).toHaveLength(1)
    expect(branch).toMatch(/updateMessageError\(\s*convId!, assistantMessage\.id,\s*\{ kind: 'limit', detail: limitText, at: runState\.content\.length \}/)
    expect(agentHook).toContain(`'\\n\\n${AGENT_ERROR_HEAD}' + errorMsg`)
    expect(RATE_LIMIT_LITERAL.startsWith(RATE_LIMIT_HEAD)).toBe(true)
  })

  it('the catch of a plain send has the seven branches read here, the catch of an agent run its fourteen', () => {
    // A new branch writes a new sentence into the answer. It belongs into lib/logic-notes.ts and into the list above.
    // The seventh and the twelfth (3.0.8, A28) are the LU Cloud outage: the server's sentence, so they write the field too.
    // A22: the multimodal branch now asks why (api/image-part-heal); its sentences are read above.
    // The thirteenth (15.11.2026): LU Cloud cut a step for repeating, SERVER_LOOP_MESSAGE.
    // The fourteenth (A49): LU Cloud ended the run (409), emptyAnswerExplanation with the stop's finishReason.
    const plain = catchOf(chatHook, 'await explainImageRefusal(activeModel)')
    expect(plain.match(/updateMessageContent\(/g)).toHaveLength(7)
    const agent = catchOf(agentHook, "'\\n\\nAgent error: ' + errorMsg")
    expect(agent.match(/updateMessageContent\(/g)).toHaveLength(14)
  })

  it('an empty turn is explained through one function, in both paths of the chat hook', () => {
    // Twice for an empty turn, once for an answer that lost its model to a pick (SWITCHED_MODEL_HEAD in the reader).
    expect(chatHook.match(/emptyAnswerExplanation\(\{/g)).toHaveLength(3)
    expect(emptyAnswerExplanation({ finishReason: 'model_switch', captured: false, keepThinking: false }).startsWith(SWITCHED_MODEL_HEAD)).toBe(true)
  })
})

describe('15.11.2026: the sentence of a step LU Cloud cut for repeating', () => {
  it('is read as a note of the app, alone and after a partial answer', async () => {
    const { SERVER_LOOP_MESSAGE } = await import('../agent-core/server-loop-cut')
    const { splitLogicNote } = await import('../logic-notes')
    expect(splitLogicNote(SERVER_LOOP_MESSAGE)?.kind).toBe('generic')
    expect(splitLogicNote(`Checked the first two logs.\n\n${SERVER_LOOP_MESSAGE}`)?.body).toBe('Checked the first two logs.')
  })
})

describe('A22: the image part sentences are notes, not answers', () => {
  it('each is read as a note of the app', async () => {
    const { imagePartNotLoadedSentence, imagePartReloadedSentence, noImagePartSentence } = await import('../image-part-notes')
    const { splitLogicNote } = await import('../logic-notes')
    for (const s of [
      noImagePartSentence('gemma-4-12b'),
      imagePartNotLoadedSentence('gemma-4-12b', 'Loaded without image input: the graphics memory has no room for the image part next to the model. A smaller context makes room.'),
      imagePartReloadedSentence('gemma-4-12b'),
    ]) {
      const note = splitLogicNote(s)
      expect(note?.body ?? null, s).toBe('')
      expect(note?.kind).toBe('generic')
    }
  })
})
