import { useChatStore } from '../../stores/chatStore'
import { useAutoScroll } from '../../hooks/useAutoScroll'
import { MessageBubble } from './MessageBubble'
import { TypingIndicator } from './TypingIndicator'

interface Props {
  isGenerating: boolean
  isLoadingModel?: boolean
  onRegenerate?: (conversationId: string, assistantMessageId: string) => void
  onEdit?: (conversationId: string, messageId: string, newContent: string) => void
}

export function MessageList({ isGenerating, isLoadingModel, onRegenerate, onEdit }: Props) {
  const conversation = useChatStore((s) => {
    if (!s.activeConversationId) return undefined
    return s.conversations.find((c) => c.id === s.activeConversationId)
  })

  const lastMessage = conversation?.messages[conversation.messages.length - 1]
  const scrollRef = useAutoScroll(lastMessage?.content)

  if (!conversation) return null

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin py-4">
      {conversation.messages
        .filter((m) => m.role !== 'system' && !m.hidden)
        .map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            onRegenerate={message.role === 'assistant' && onRegenerate && !isGenerating
              ? () => onRegenerate(conversation.id, message.id)
              : undefined}
            onEdit={message.role === 'user' && onEdit && !isGenerating
              ? (msgId, content) => onEdit(conversation.id, msgId, content)
              : undefined}
          />
        ))}
      {isGenerating && lastMessage?.role === 'assistant' && lastMessage.content === '' && (
        <TypingIndicator label={isLoadingModel ? 'Loading model...' : undefined} />
      )}
    </div>
  )
}
