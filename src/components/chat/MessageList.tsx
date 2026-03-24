import { useChatStore } from '../../stores/chatStore'
import { useAutoScroll } from '../../hooks/useAutoScroll'
import { MessageBubble } from './MessageBubble'
import { TypingIndicator } from './TypingIndicator'

interface Props {
  isGenerating: boolean
}

export function MessageList({ isGenerating }: Props) {
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
        .filter((m) => m.role !== 'system')
        .map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      {isGenerating && lastMessage?.role === 'assistant' && lastMessage.content === '' && (
        <TypingIndicator />
      )}
    </div>
  )
}
