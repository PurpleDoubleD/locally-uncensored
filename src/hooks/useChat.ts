import { useRef, useState, useCallback } from "react"
import { v4 as uuid } from "uuid"
import { useChatStore } from "../stores/chatStore"
import { useModelStore } from "../stores/modelStore"
import { useSettingsStore } from "../stores/settingsStore"
import { useRAGStore } from "../stores/ragStore"
import { useVoiceStore } from "../stores/voiceStore"
import { retrieveContext } from "../api/rag"
import { speakStreaming, isSpeechSynthesisSupported, getVoicesAsync } from "../api/voice"
import { useAgentChat } from "./useAgentChat"
import { useAgentModeStore } from "../stores/agentModeStore"
import { getProviderForModel } from "../api/providers"
import type { ChatStreamChunk } from "../api/providers/types"

export function useChat() {
  const [isGenerating, setIsGenerating] = useState(false)
  const [isLoadingModel, setIsLoadingModel] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const contentRef = useRef("")
  const thinkingRef = useRef("")
  const isThinkingRef = useRef(false)

  // Agent mode composition
  const agentChat = useAgentChat()

  const sendMessage = useCallback(async (content: string) => {
    const { activeModel } = useModelStore.getState()
    const { settings } = useSettingsStore.getState()
    const store = useChatStore.getState()
    const persona = useSettingsStore.getState().getActivePersona()

    // Agent mode delegation: if active for this conversation, use agent chat
    if (store.activeConversationId && useAgentModeStore.getState().isActive(store.activeConversationId)) {
      return agentChat.sendAgentMessage(content)
    }

    if (!activeModel) return

    let convId = store.activeConversationId
    if (!convId) {
      convId = store.createConversation(activeModel, persona?.systemPrompt || "")
    }

    const userMessage = {
      id: uuid(),
      role: "user" as const,
      content,
      timestamp: Date.now(),
    }
    useChatStore.getState().addMessage(convId, userMessage)

    const assistantMessage = {
      id: uuid(),
      role: "assistant" as const,
      content: "",
      thinking: "",
      timestamp: Date.now(),
    }
    useChatStore.getState().addMessage(convId, assistantMessage)

    const conv = useChatStore.getState().conversations.find((c) => c.id === convId)
    if (!conv) return

    // RAG context injection
    let systemPrompt = conv.systemPrompt
    const ragState = useRAGStore.getState()
    const ragEnabled = ragState.ragEnabled[convId] ?? false

    if (ragEnabled) {
      // Ensure chunks are loaded from IndexedDB before retrieval
      await ragState.loadChunksFromDB(convId)

      const chunks = ragState.getConversationChunks(convId)
      if (chunks.length > 0) {
        try {
          const { context: ragContext, scoredChunks } = await retrieveContext(
            content,
            chunks,
            ragState.embeddingModel
          )

          // Store scored chunks for display in RAGPanel
          ragState.setLastRetrievedChunks(scoredChunks)

          if (ragContext.chunks.length > 0) {
            const contextBlock = ragContext.chunks
              .map((c, i) => `[Source ${i + 1}]\n${c.content}`)
              .join("\n\n")
            const ragPrefix = `Use the following document context to help answer the user's question. If the context is not relevant, ignore it and answer normally.\n\n---\n${contextBlock}\n---\n\n`
            systemPrompt = ragPrefix + (systemPrompt || "")
          }
        } catch (err) {
          console.error("RAG retrieval failed, continuing without context:", err)
        }
      }
    }

    const messages = [
      ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
      ...conv.messages
        .filter((m) => m.content.trim() !== '')
        .map((m) => ({ role: m.role as 'user' | 'assistant' | 'system' | 'tool', content: m.content })),
    ]

    const abort = new AbortController()
    abortRef.current = abort
    setIsGenerating(true)
    setIsLoadingModel(true)
    contentRef.current = ""
    thinkingRef.current = ""
    isThinkingRef.current = false

    try {
      // ── Multi-Provider: resolve provider for active model ──
      const { provider, modelId } = getProviderForModel(activeModel)

      const stream = provider.chatStream(
        modelId,
        messages,
        {
          temperature: settings.temperature,
          topP: settings.topP,
          topK: settings.topK,
          maxTokens: settings.maxTokens || undefined,
          signal: abort.signal,
        },
      )

      let frameScheduled = false
      let firstChunk = true

      for await (const chunk of stream) {
        if (firstChunk) {
          firstChunk = false
          setIsLoadingModel(false)
        }

        if (chunk.content) {
          const text = chunk.content

          for (const char of text) {
            if (!isThinkingRef.current) {
              contentRef.current += char
              if (contentRef.current.endsWith("<think>")) {
                contentRef.current = contentRef.current.slice(0, -7)
                isThinkingRef.current = true
              }
            } else {
              thinkingRef.current += char
              if (thinkingRef.current.endsWith("</think>")) {
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
          useChatStore
            .getState()
            .updateMessageContent(convId!, assistantMessage.id, contentRef.current)
          if (thinkingRef.current) {
            useChatStore
              .getState()
              .updateMessageThinking(convId!, assistantMessage.id, thinkingRef.current)
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        const errorMsg = (err as any).code === 'auth'
          ? (err as Error).message
          : (err as any).code === 'rate_limit'
            ? (err as Error).message
            : `Error: ${(err as Error).message || 'Connection failed'}`

        useChatStore.getState().updateMessageContent(
          convId!,
          assistantMessage.id,
          contentRef.current + "\n\n" + errorMsg
        )
      }
    } finally {
      setIsGenerating(false)
      setIsLoadingModel(false)
      abortRef.current = null

      // Auto-speak response if TTS is enabled
      const voiceState = useVoiceStore.getState()
      if (voiceState.ttsEnabled && isSpeechSynthesisSupported() && contentRef.current.trim()) {
        try {
          let voice: SpeechSynthesisVoice | undefined
          if (voiceState.ttsVoice) {
            const voices = await getVoicesAsync()
            voice = voices.find((v) => v.name === voiceState.ttsVoice)
          }
          voiceState.setSpeaking(true)
          await speakStreaming(contentRef.current, voice, voiceState.ttsRate, voiceState.ttsPitch)
        } catch { /* TTS errors are non-critical */ }
        finally { voiceState.setSpeaking(false) }
      }
    }
  }, [])

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return {
    sendMessage,
    stopGeneration: agentChat.isAgentRunning ? agentChat.stopAgent : stopGeneration,
    isGenerating: isGenerating || agentChat.isAgentRunning,
    isLoadingModel,
    // Agent mode additions
    isAgentRunning: agentChat.isAgentRunning,
    pendingApproval: agentChat.pendingApproval,
    approveToolCall: agentChat.approveToolCall,
    rejectToolCall: agentChat.rejectToolCall,
  }
}
