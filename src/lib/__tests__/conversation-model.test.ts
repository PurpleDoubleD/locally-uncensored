/**
 * Meldung 4 of the R5 re-measure on the 2.6.7 Windows build
 * (2026-08-30, ergebnis-r5-nachmessung.md).
 *
 * The app names a model beside every chat and that name was always the global
 * pick, never the chat's. Three cases were measured on the box:
 *
 *   1. global set to mlabonne_gemma-3-4b, then the 12 hour old chat PROBE-C
 *      opened. It read mlabonne_gemma-3-4b-it-abliterated-Q4_K_M. Every answer
 *      in that chat came from Hermes.
 *   2. global set to Qwen3-4B, then KANARIE2 (13 h old) and R5N-A opened. Both
 *      read Qwen3-4B-Q4_K_M.
 *   3. the display read Hermes-3-Llama-3.2-3B while the last answer of the
 *      open chat came provably from Qwen3-4B-Q4_K_M.
 *
 * The saved history could not have answered better. It held a `model` field
 * per conversation and none per message (0 hits for a message level "model" in
 * store_backup.json), so once two models have answered in one chat the model
 * of the last answer was not derivable at all. And even a single-answer chat
 * was wrong: a slip into Cloud mode sent one question to
 * google/gemma-4-26B-A4B-it while the record for that conversation read
 * openai::Hermes-3-Llama-3.2-3B.Q4_K_M.
 *
 * Run: npx vitest run src/lib/__tests__/conversation-model.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { conversationModel, conversationModelDiffers } from '../conversation-model'

const here = dirname(fileURLToPath(import.meta.url))
const src = (p: string) => readFileSync(resolve(here, '../..', p), 'utf8')

const HERMES = 'openai::Hermes-3-Llama-3.2-3B.Q4_K_M'
const QWEN = 'openai::Qwen3-4B-Q4_K_M'
const GEMMA = 'openai::mlabonne_gemma-3-4b-it-abliterated-Q4_K_M'
const CLOUD = 'lu-cloud::google/gemma-4-26B-A4B-it'

const user = (content = 'q') => ({ role: 'user' as const, content })
const answer = (modelId?: string) => ({ role: 'assistant' as const, modelId })

describe('a conversation says which model wrote its answers', () => {
  it('THE FIX: case 1 of the re-measure, a Hermes chat opened under a Gemma pick', () => {
    const conv = {
      // The record on the conversation followed the picker at some point, so
      // it cannot be trusted either. The answers can.
      model: GEMMA,
      messages: [user(), answer(HERMES), user(), answer(HERMES)],
    }
    expect(conversationModel(conv)).toBe(HERMES)
    expect(conversationModelDiffers(conv, GEMMA)).toBe(true)
  })

  it('THE FIX: case 3, two models answered in one chat and the last one counts', () => {
    const conv = {
      model: HERMES,
      messages: [user(), answer(HERMES), user(), answer(QWEN)],
    }
    expect(conversationModel(conv)).toBe(QWEN)
  })

  it('THE FIX: the cloud slip, one answer and the conversation field disagreeing', () => {
    const conv = { model: HERMES, messages: [user(), answer(CLOUD)] }
    expect(conversationModel(conv)).toBe(CLOUD)
  })

  it('THE FIX: an old chat with no model on its answers claims nothing new', () => {
    // The honest answer for a chat written before the record existed is the
    // conversation field, which is exactly what was known before and no more.
    const conv = { model: HERMES, messages: [user(), answer(undefined)] }
    expect(conversationModel(conv)).toBe(HERMES)
  })

  it('THE FIX: an old chat under a different pick still reports its own field', () => {
    const conv = { model: HERMES, messages: [user(), answer(undefined)] }
    expect(conversationModelDiffers(conv, QWEN)).toBe(true)
    expect(conversationModel(conv)).toBe(HERMES)
  })

  it('NEGATIVE CONTROL: the global pick is never the answer', () => {
    // The whole defect in one line. Whatever is picked globally, a chat that
    // knows nothing says nothing, it does not borrow the pick.
    expect(conversationModel({ model: '', messages: [] })).toBe('')
    expect(conversationModel(null)).toBe('')
    expect(conversationModel(undefined)).toBe('')
  })

  it('NEGATIVE CONTROL: a chat that has never answered reports no difference', () => {
    // Nothing to be honest or dishonest about yet, and the picker beside it
    // already says what the next answer would run on.
    expect(conversationModelDiffers({ model: HERMES, messages: [user()] }, QWEN)).toBe(false)
    expect(conversationModelDiffers({ model: '', messages: [] }, QWEN)).toBe(false)
  })

  it('NEGATIVE CONTROL: a chat continuing on its own model does not print it twice', () => {
    const conv = { model: QWEN, messages: [user(), answer(QWEN)] }
    expect(conversationModelDiffers(conv, QWEN)).toBe(false)
  })

  it('NEGATIVE CONTROL: a blank modelId is not a claim', () => {
    const conv = { model: HERMES, messages: [user(), answer('   ')] }
    expect(conversationModel(conv)).toBe(HERMES)
  })
})

describe('every assistant turn records the model that produced it', () => {
  it('THE FIX: plain chat writes the model onto the answer', () => {
    expect(src('hooks/useChat.ts')).toMatch(/modelId: activeModel,/)
  })

  it('THE FIX: the agent path writes the runner it actually resolved', () => {
    expect(src('hooks/useAgentChat.ts')).toMatch(/modelId: modelToUse,/)
  })

  it('THE FIX: the coding path writes it too', () => {
    expect(src('hooks/useCodex.ts')).toMatch(/modelId: activeModel,/)
  })

  it('THE FIX: the answer bubble already renders that name, for every chat', () => {
    expect(src('components/chat/MessageBubble.tsx'))
      .toMatch(/\{!isUser && message\.modelId && \(/)
  })
})

describe('the conversation displays read the conversation, not the picker', () => {
  it('THE FIX: the export header names the model of the last answer', () => {
    expect(src('lib/chat-export.ts')).toMatch(/_Model: \$\{conversationModelOf\(conversation\)\}/)
  })

  it('THE FIX: the composer still knows what the open chat ran on when it differs', () => {
    // David on 2026-09-02: "mach das woanders hin, versteckter bitte". The
    // chip in the composer row is gone; the reader behind it is not. It hands
    // the picker the name, and the picker carries the dot and the sentence
    // (proved by rendering in
    // components/chat/__tests__/conversation-model-hint.test.ts).
    const note = src('components/chat/ConversationModelNote.tsx')
    expect(note).toMatch(/conversationModelDiffers\(conv, activeModel\)/)
    expect(note).toMatch(/export function useConversationModelHint/)
    expect(src('components/chat/ChatView.tsx'))
      .toMatch(/<ModelSelector openUpward answeredBy=\{conversationModelHint\} \/>/)
    expect(src('components/models/ModelSelector.tsx'))
      .toMatch(/The answers in this chat were written by \$\{answeredBy\}/)
  })

  it('NEGATIVE CONTROL: no chip prints the name in the row any more', () => {
    // The old shape wrote "answers: <name>" beside the picker. Nothing draws
    // that text now, in either file, or the move would have been cosmetic.
    expect(src('components/chat/ConversationModelNote.tsx')).not.toMatch(/answers:/)
    expect(src('components/chat/ChatView.tsx')).not.toMatch(/<ConversationModelNote \/>/)
  })

  it('NEGATIVE CONTROL: nothing writes a model into an old message', () => {
    // No migration touches modelId. A guess written to disk is
    // indistinguishable from a measurement a week later, which is the whole
    // reason this defect was hard to see in the first place. The existing
    // rehydrate migration walks the same messages (it repairs agentBlocks),
    // so this pins that it leaves the model field alone.
    const store = src('stores/chatStore.ts')
    const migration = store.slice(
      store.indexOf('export function migratePersistedChat'),
      store.indexOf('interface ChatState'),
    )
    expect(migration).not.toMatch(/modelId/)
    expect(src('lib/conversation-model.ts')).not.toMatch(/modelId\s*=/)
  })

  it('NEGATIVE CONTROL: the picker still shows the pick, it was never wrong about that', () => {
    // ModelSelector answers "what does the next message run on". Moving it
    // onto the conversation would have made it lie in the other direction.
    expect(src('components/models/ModelSelector.tsx'))
      .toMatch(/const activeDisplayName = activeModel/)
  })
})
