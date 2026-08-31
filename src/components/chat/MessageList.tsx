import { useCallback, useRef } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useAutoScroll } from '../../hooks/useAutoScroll'
import { MessageBubble } from './MessageBubble'
import { WorkingAnchor } from './WorkingAnchor'

interface Props {
  /** GLOBAL generating flag — guards regenerate/edit so a second concurrent
   *  send (which shares the chat hook's stream refs) can't corrupt an in-flight
   *  turn. Stays global on purpose. */
  isGenerating: boolean
  /** Per-conversation generating flag — drives the 3-dot typing indicator so it
   *  shows ONLY in the chat that is actually generating, not in every chat the
   *  user switches to (David 2026-06-12). Falls back to isGenerating. */
  isThisChatGenerating?: boolean
  isLoadingModel?: boolean
  onRegenerate?: (conversationId: string, assistantMessageId: string) => void
  onEdit?: (conversationId: string, messageId: string, newContent: string) => void
  /** Tool-call id awaiting user approval — when set, the matching tool
   *  block renders Approve/Reject inline (replaces the old popup). */
  pendingApprovalId?: string | null
  onApprove?: () => void
  onReject?: () => void
}

export function MessageList({ isGenerating, isThisChatGenerating, isLoadingModel, onRegenerate, onEdit, pendingApprovalId, onApprove, onReject }: Props) {
  const showTyping = isThisChatGenerating ?? isGenerating
  const conversation = useChatStore((s) => {
    if (!s.activeConversationId) return undefined
    return s.conversations.find((c) => c.id === s.activeConversationId)
  })

  const lastMessage = conversation?.messages[conversation.messages.length - 1]
  // The approval id is part of the scroll trigger (G31): a run waiting for a
  // decision often adds NO content, so the list stood still while the inline
  // Approve/Reject grew in below the fold. Growth WITHOUT a trigger (Working
  // anchor mounting, a thinking block streaming while content stays empty) is
  // covered by the hook's ResizeObserver (G33). The resumeKey is the last
  // USER message: sending jumps all the way down even after scrolling away.
  const lastUserMessage = conversation?.messages.filter((m) => m.role === 'user').at(-1)
  const { ref: scrollRef, contentRef } = useAutoScroll(
    `${lastMessage?.content ?? ''}|${pendingApprovalId ?? ''}`,
    lastUserMessage?.id,
  )

  // MessageBubble is memoised, so its handlers have to keep the same identity
  // across renders. Binding the conversation id and the parent's callbacks
  // through a ref keeps ONE function alive for the whole list instead of
  // minting a fresh closure per message on every streaming frame.
  const bind = useRef({ conversation, onRegenerate, onEdit })
  bind.current = { conversation, onRegenerate, onEdit }

  const handleRegenerate = useCallback((messageId: string) => {
    const { conversation: c, onRegenerate: cb } = bind.current
    if (c && cb) cb(c.id, messageId)
  }, [])

  const handleEdit = useCallback((messageId: string, content: string) => {
    const { conversation: c, onEdit: cb } = bind.current
    if (c && cb) cb(c.id, messageId, content)
  }, [])

  if (!conversation) return null

  const visibleMessages = conversation.messages.filter((m) => m.role !== 'system' && !m.hidden)
  const lastVisibleId = visibleMessages[visibleMessages.length - 1]?.id

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto scrollbar-thin py-4"
      style={{
        // Soft top fade — chat content "blurs out" under the header (David).
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, #000 28px)',
        maskImage: 'linear-gradient(to bottom, transparent 0, #000 28px)',
      }}
    >
      {/* Single wrapper so the hook's ResizeObserver sees ALL content height,
          anchor included (G33). */}
      <div ref={contentRef} className="mx-auto w-full max-w-[var(--lu-measure)]">
        {visibleMessages
          .map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              isLast={message.id === lastVisibleId}
              // The live generating flag, not `message.usage`: a backend that
              // never reports usage would lose the action bar for good.
              isStreaming={showTyping && message.id === lastVisibleId && message.role === 'assistant'}
              onRegenerate={message.role === 'assistant' && onRegenerate && !isGenerating
                ? handleRegenerate
                : undefined}
              onEdit={message.role === 'user' && onEdit && !isGenerating
                ? handleEdit
                : undefined}
              pendingApprovalId={pendingApprovalId}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))}
        {/* The run anchor stays visible the entire time the agent is still
            working, including between tool calls and while the final answer
            streams. G14-6: one shimmering "Working" with the clock beside it,
            instead of three dots here and a floating counter elsewhere. */}
        {showTyping && lastMessage?.role === 'assistant' && (
          <WorkingAnchor isRunning label={isLoadingModel ? 'Loading model' : undefined} />
        )}
      </div>
    </div>
  )
}
