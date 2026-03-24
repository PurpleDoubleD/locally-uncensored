import { useRef, useState, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { chatStream } from '../api/ollama'
import { parseNDJSONStream } from '../api/stream'
import { useChatStore } from '../stores/chatStore'
import { useModelStore } from '../stores/modelStore'
import { useSettingsStore } from '../stores/settingsStore'

interface ChatChunk {
  message?: { content: string }
  done?: boolean
}

export function useChat() {
  const [isGenerating, setIsGenerating] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const contentRef = useRef('')
  const thinkingRef = useRef('')
  const isThinkingRef = useRef(false)

  const sendMessage = useCallback(async (content: string) => {
    const { activeModel } = useModelStore.getState()
    const { settings } = useSettingsStore.getState()
    const store = useChatStore.getState()
    const persona = useSettingsStore.getState().getActivePersona()

    if (!activeModel) return

    let convId = store.activeConversationId
    if (!convId) {
      convId = store.createConversation(activeModel, persona?.systemPrompt || '')
    }

    const userMessage = {
      id: uuid(),
      role: 'user' as const,
      content,
      timestamp: Date.now(),
    }
    useChatStore.getState().addMessage(convId, userMessage)

    const assistantMessage = {
      id: uuid(),
      role: 'assistant' as const,
      content: '',
      thinking: '',
      timestamp: Date.now(),
    }
    useChatStore.getState().addMessage(convId, assistantMessage)

    const conv = useChatStore.getState().conversations.find((c) => c.id === convId)
    if (!conv) return

    const messages = [
      ...(conv.systemPrompt ? [{ role: 'system', content: conv.systemPrompt }] : []),
      ...conv.messages.map((m) => ({ role: m.role, content: m.content })),
    ]

    const abort = new AbortController()
    abortRef.current = abort
    setIsGenerating(true)
    contentRef.current = ''
    thinkingRef.current = ''
    isThinkingRef.current = false

    try {
      const response = await chatStream(
        activeModel,
        messages,
        {
          temperature: settings.temperature,
          top_p: settings.topP,
          top_k: settings.topK,
          num_predict: settings.maxTokens || undefined,
        },
        abort.signal
      )

      let frameScheduled = false
      for await (const chunk of parseNDJSONStream<ChatChunk>(response)) {
        if (chunk.message?.content) {
          const text = chunk.message.content

          // Parse <think> tags character by character as they stream in
          for (const char of text) {
            // Check if we're entering a <think> block
            if (!isThinkingRef.current) {
              contentRef.current += char
              // Check if content ends with <think>
              if (contentRef.current.endsWith('<think>')) {
                contentRef.current = contentRef.current.slice(0, -7)
                isThinkingRef.current = true
              }
            } else {
              thinkingRef.current += char
              // Check if thinking ends with </think>
              if (thinkingRef.current.endsWith('</think>')) {
                thinkingRef.current = thinkingRef.current.slice(0, -8)
                isThinkingRef.current = false
              }
            }
          }

          if (!frameScheduled) {
            frameScheduled = true
            requestAnimationFrame(() => {
              const cId = convId!
              const mId = assistantMessage.id
              useChatStore.getState().updateMessageContent(cId, mId, contentRef.current)
              if (thinkingRef.current) {
                useChatStore.getState().updateMessageThinking(cId, mId, thinkingRef.current)
              }
              frameScheduled = false
            })
          }
        }
        if (chunk.done) {
          useChatStore.getState().updateMessageContent(convId!, assistantMessage.id, contentRef.current)
          if (thinkingRef.current) {
            useChatStore.getState().updateMessageThinking(convId!, assistantMessage.id, thinkingRef.current)
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        useChatStore.getState().updateMessageContent(
          convId!,
          assistantMessage.id,
          contentRef.current + '\n\n⚠️ Error: Connection failed'
        )
      }
    } finally {
      setIsGenerating(false)
      abortRef.current = null
    }
  }, [])

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return { sendMessage, stopGeneration, isGenerating }
}
