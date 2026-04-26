import { useChatStore } from '../../stores/chatStore'
import { useAutoScroll } from '../../hooks/useAutoScroll'
import { MessageBubble } from './MessageBubble'
import { TypingIndicator } from './TypingIndicator'

interface Props {
  isGenerating: boolean
  isLoadingModel?: boolean
  onRegenerate?: (conversationId: string, assistantMessageId: string) => void
  onEdit?: (conversationId: string, messageId: string, newContent: string) => void
  /** Tool-call id awaiting user approval — when set, the matching tool
   *  block renders Approve/Reject inline (replaces the old popup). */
  pendingApprovalId?: string | null
  onApprove?: () => void
  onReject?: () => void
}

export function MessageList({ isGenerating, isLoadingModel, onRegenerate, onEdit, pendingApprovalId, onApprove, onReject }: Props) {
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
            pendingApprovalId={pendingApprovalId}
            onApprove={onApprove}
            onReject={onReject}
          />
        ))}
      {/* 3-dot loading indicator stays visible the entire time the agent
          is still working — including between tool calls and while the
          final answer is streaming. Previously it only showed when the
          last assistant message was empty, which made multi-turn agent
          runs look frozen between iterations (per user feedback). */}
      {isGenerating && lastMessage?.role === 'assistant' && (
        <TypingIndicator label={isLoadingModel ? 'Loading model...' : undefined} />
      )}
    </div>
  )
}
