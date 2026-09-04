import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useAutoScroll } from '../../hooks/useAutoScroll'
import { MessageBubble } from './MessageBubble'
import { WorkingAnchor } from './WorkingAnchor'
import { CompactBlock } from './CompactBlock'
import { compactionAnchors } from '../../lib/compact-summary'
import { Hinweis } from '../ui/Hinweis'

/**
 * Above this many visible messages the transcript stops paying full layout +
 * paint for the part of itself nobody is looking at.
 *
 * Why `content-visibility` and NOT a windowed slice: the list has exactly one
 * scroll mechanism (useAutoScroll pins to `scrollHeight` and re-pins from a
 * ResizeObserver on the content wrapper), and a slice would have to reproduce
 * that pin, the streaming follow, and the "sending jumps to the bottom" resume
 * on top of a moving set of mounted nodes. `content-visibility: auto` keeps
 * every message mounted and every id in the DOM — the pin, the observer, the
 * resume key, Cmd+F and the measure column are all untouched — and lets the
 * engine skip layout/paint for off-screen subtrees instead.
 *
 * The gate is deliberately NOT the audit's plain `length >= 200` check on
 * every render: flipping the property on mid-conversation would collapse every
 * off-screen bubble above the fold to its intrinsic-size estimate in one frame
 * and yank a reader who is scrolled up. It is decided once, when a
 * conversation becomes the active one, so the property is either on from the
 * first paint or off for that visit — never a switch under a live thread.
 */
const CONTENT_VISIBILITY_THRESHOLD = 200

/**
 * The tail stays fully rendered no matter what. The streaming bubble is
 * on-screen (so `auto` would render it anyway), but an exact height at the
 * bottom edge is what the auto-scroll pin measures against, and an estimate
 * there is the one place a wrong guess is visible.
 */
const ALWAYS_RENDERED_TAIL = 3

/** `auto` = keep the real height once a bubble has been rendered; the 8rem is
 *  only the never-yet-seen guess. */
const SKIPPABLE: CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 8rem',
}

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
  // The refresh happens in an effect, not in the render body: writing a ref
  // while rendering is a mutation React is allowed to throw away or replay
  // (React 19 `refs`). Both readers below are user-event handlers, which never
  // run before the effects of the render they belong to, so they still only
  // ever see the current conversation and callbacks.
  const bind = useRef({ conversation, onRegenerate, onEdit })
  useEffect(() => { bind.current = { conversation, onRegenerate, onEdit } })

  const handleRegenerate = useCallback((messageId: string) => {
    const { conversation: c, onRegenerate: cb } = bind.current
    if (c && cb) cb(c.id, messageId)
  }, [])

  const handleEdit = useCallback((messageId: string, content: string) => {
    const { conversation: c, onEdit: cb } = bind.current
    if (c && cb) cb(c.id, messageId, content)
  }, [])

  // Decided once per visited conversation, see CONTENT_VISIBILITY_THRESHOLD.
  // React's documented "adjust state when a prop changes" shape: the branch
  // below re-runs this component immediately and only this component, so the
  // gate is settled before anything paints.
  const [skipGate, setSkipGate] = useState<{ id: string | null; on: boolean }>({ id: null, on: false })

  if (!conversation) return null

  // App-Hinweise sind Systemnachrichten mit `notice` — sie erreichen das
  // Modell nie (die Nutzlast wirft `role:'system'` weg) und gehoeren trotzdem
  // in den Verlauf. Bis 2.6.8 filterte diese Zeile jede Systemnachricht weg,
  // und der Code-Verlauf zeigte sie schon; damit war `/compact` im Chat
  // stumm, sobald die beiden Zeilen ehrlich als Hinweise abgelegt wurden.
  const visibleMessages = conversation.messages.filter(
    (m) => (m.role !== 'system' || !!m.notice) && !m.hidden,
  )
  const lastVisibleId = visibleMessages[visibleMessages.length - 1]?.id

  if (skipGate.id !== conversation.id) {
    setSkipGate({
      id: conversation.id,
      on: visibleMessages.length >= CONTENT_VISIBILITY_THRESHOLD,
    })
  }
  const skipOffscreen = skipGate.id === conversation.id && skipGate.on
  const tailStart = visibleMessages.length - ALWAYS_RENDERED_TAIL

  // Die Verdichtungslinien. Berechnet aus der VOLLEN Nachrichtenliste, weil
  // der Schnittpunkt auf eine gefilterte Nachricht zeigen kann, aber
  // angezeigt an sichtbaren Zeilen — siehe compactionAnchors.
  const compactAt = compactionAnchors(
    conversation.messages,
    visibleMessages.map((m) => m.id),
    conversation.compactions,
  )

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
          .map((message, index) => (
            // The wrapper carries the skip hint so MessageBubble keeps owning
            // its own root class. It is a plain block inside a plain block, so
            // it adds no layout of its own.
            <div
              key={message.id}
              style={skipOffscreen && index < tailStart ? SKIPPABLE : undefined}
            >
              {message.role === 'system' && message.notice ? (
                // Schlichte Zeile, keine Blase: eine Blase wuerde behaupten,
                // das Modell habe es gesagt. Und kein Kasten mehr darum: der
                // Rahmen samt gelber Flaeche gab einem Satz das Gewicht eines
                // Absturzes. Es bleiben die zwei Toene aus `lib/hinweis.ts`,
                // dieselbe Form wie im Code-Verlauf (CodexView,
                // data-testid="codex-notice"): `warn` ist das, wo jemand
                // handeln muss, alles andere ist eine ruhige Bestaetigung.
                <div className="px-3 py-1" data-testid="chat-notice">
                  <Hinweis ton={message.notice === 'warn' ? 'fehler' : 'ruhig'}>
                    <span className="break-words">{message.content}</span>
                  </Hinweis>
                </div>
              ) : (
              <MessageBubble
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
              )}
              {compactAt.get(message.id)?.map((record) => (
                <CompactBlock key={record.id} record={record} />
              ))}
            </div>
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
