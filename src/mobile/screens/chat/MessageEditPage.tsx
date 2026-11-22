/**
 * C6.4 Edit answer. Route /chat/:id/message/:messageId/edit, full screen,
 * strand 1. An answer is changed in place with "Save" and "Cancel"; nothing
 * is sent again. Leaving with unsaved changes asks first.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { useChatStore } from '../../../stores/chatStore'
import { useReplyWriteStore } from '../../../stores/replyWriteStore'
import { nav, useLeaveGuard, useParams, useRoute } from '../../nav'
import { CHAT_STRINGS } from '../../strings/chat'
import { Button, EmptyState, Page, toast } from '../../ui'
import { answerBody } from './parts/adapters/run-error'
import './parts/chat.css'

const S = CHAT_STRINGS

export default function MessageEditPage() {
  const { id, messageId } = useParams<{ id: string; messageId: string }>()
  const { key } = useRoute()
  const message = useChatStore((s) => s.conversations.find((c) => c.id === id)?.messages.find((m) => m.id === messageId))
  // The answer alone: what a failed run wrote behind it is not text to edit (G8).
  const original = message ? answerBody(message) : ''
  const [text, setText] = useState(original)
  const dirty = !!message && text !== original
  // A run that still writes this answer would overwrite what is saved now.
  const stillWriting = useReplyWriteStore((s) => !!s.open[messageId])
  useLeaveGuard(dirty)
  // The field is as tall as its text, so the page scrolls and not a box inside it.
  const field = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  if (!message || message.role !== 'assistant') {
    return (
      <Page title={S.edit.title} screen="chat-message-edit">
        <EmptyState
          title={S.edit.gone}
          testid="m-chat-edit-gone"
          actions={
            <Button variant="primary" onPress={() => void nav.back()} testid="m-chat-edit-back">
              {S.chat.backToChats}
            </Button>
          }
        />
      </Page>
    )
  }

  const empty = text.trim().length === 0
  const save = () => {
    if (empty || stillWriting) return
    useChatStore.getState().updateMessageContent(id, message.id, text.trim())
    // The text is the user's own now: what a failed run left at the answer no longer describes it.
    if (message.error) useChatStore.getState().updateMessageError(id, message.id, null)
    nav.setLeaveGuard(key, null)
    toast(S.edit.saved, { testid: 'answer-saved' })
    nav.back()
  }

  return (
    <Page
      title={S.edit.title}
      screen="chat-message-edit"
      flush
      noJumpWithKeyboard
      footer={
        <>
          <Button variant="primary" block disabled={empty || !dirty || stillWriting} disabledReason={stillWriting ? S.actions.busy : empty ? S.edit.empty : undefined} onPress={save} testid="m-chat-edit-save">
            {S.edit.save}
          </Button>
          <Button block onPress={() => void nav.back()} testid="m-chat-edit-cancel-page">
            {S.edit.cancel}
          </Button>
        </>
      }
    >
      <div className="m-chat-page-pad m-chat-editor">
        <textarea ref={field} aria-label={S.edit.field} value={text} data-testid="m-chat-edit-field" data-m-autofocus="" data-m-fits-room="" onChange={(event) => setText(event.target.value)} />
      </div>
    </Page>
  )
}
