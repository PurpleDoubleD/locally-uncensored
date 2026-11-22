/**
 * C6 Message / Answer. Sheet "message", strand 1 (Chat core).
 *
 * Opened with nav.openSheet('message', { chatId, messageId }) from "More" at
 * a message and from a long press on it. What needs the send path of the open
 * chat (read aloud, regenerate, edit a message of the user) goes through the
 * register in parts/controller.ts.
 */
import { Copy, Flag, Pencil, RefreshCw, Share2, Square, TextSelect, Trash2, Volume2 } from 'lucide-react'
import { useModelStore } from '../../../stores/modelStore'
import { useChatStore } from '../../../stores/chatStore'
import { useReplyWriteStore } from '../../../stores/replyWriteStore'
import { nav, useSheet } from '../../nav'
import { CHAT_STRINGS } from '../../strings/chat'
import { ListGroup, Notice, Row, Sheet, toast } from '../../ui'
import { copyText, shareMessageText } from './parts/adapters/handover'
import './parts/chat.css'
import { chatModelLabel } from './parts/model-name'
import { leavesPhone } from '../../lib/model-place'
import { chatController } from './parts/controller'
import { plainExcerpt } from './parts/logic/chat-list'
import { messageText } from './parts/logic/messages'
import { canReport, reportForAnswer } from './parts/logic/policy'
import { openReport, storePolicy } from './parts/policy'

const S = CHAT_STRINGS

export default function MessageSheet() {
  const sheet = useSheet<{ chatId?: string | null; messageId?: string } | undefined>()
  const chatId = sheet.props?.chatId ?? undefined
  const messageId = sheet.props?.messageId
  const message = useChatStore((s) => s.conversations.find((c) => c.id === chatId)?.messages.find((m) => m.id === messageId))
  const controller = chatController(chatId)
  // Stop ends `busy` at once, while a stopped agent run can still write this answer.
  const stillWriting = useReplyWriteStore((s) => !!messageId && !!s.open[messageId])

  if (!chatId || !message) {
    return (
      <Sheet title={S.message.sheetUser}>
        <Notice variant="info" testid="m-chat-message-gone">
          {S.message.gone}
        </Notice>
      </Sheet>
    )
  }

  const isAnswer = message.role === 'assistant'
  const text = messageText(message)
  const busy = controller?.isBusy() ?? false
  const speaking = controller?.isSpeaking(message.id) ?? false

  const copy = () => {
    void copyText(text).then((ok) => {
      if (ok) toast(S.actions.copied, { testid: 'copied' })
      else toast(S.actions.copyFailed, { tone: 'error', testid: 'copy-failed' })
      sheet.close()
    })
  }
  const share = () => {
    void shareMessageText(text).then((result) => {
      if (result === 'failed') toast(S.actions.shareFailed, { tone: 'error', testid: 'share-failed' })
      else sheet.close()
    })
  }
  const edit = () => {
    if (isAnswer) {
      nav.push('/chat/:id/message/:messageId/edit', { id: chatId, messageId: message.id })
      return
    }
    sheet.close()
    controller?.editInComposer(message)
  }
  const report = () => {
    // The report sheet takes the place of this one.
    sheet.close()
    const { models, activeModel } = useModelStore.getState()
    openReport(reportForAnswer(message, text, leavesPhone(message.modelId), activeModel ?? '', (id) => chatModelLabel(models, id)))
  }
  const remove = () => {
    void nav.confirm({ title: S.actions.deleteTitle, text: S.actions.deleteText, confirmLabel: S.actions.delete, tone: 'danger', testid: 'delete-message' }).then((yes) => {
      if (!yes) return
      useChatStore.getState().deleteMessage(chatId, message.id)
      nav.closeSheet()
      toast(S.actions.deleted, { testid: 'message-deleted' })
    })
  }

  return (
    <Sheet title={isAnswer ? S.message.sheetAnswer : S.message.sheetUser}>
      {text ? <p className="m-chat-quote">{plainExcerpt(text)}</p> : null}
      <ListGroup>
        <Row title={S.actions.copy} icon={Copy} chevron={false} disabled={!text} onPress={copy} testid="m-chat-message-copy" el="C6.1" />
        {isAnswer ? (
          <Row
            title={speaking ? S.actions.stopReading : S.actions.readAloud}
            icon={speaking ? Square : Volume2}
            chevron={false}
            disabled={!text || !controller}
            onPress={() => {
              sheet.close()
              controller?.speak(message)
            }}
            risk={!speaking && controller?.speakIsPaid?.() ? 'paid' : undefined}
            testid="m-chat-message-speak"
            el="C6.2"
          />
        ) : null}
        {isAnswer ? (
          <Row
            title={S.actions.regenerate}
            icon={RefreshCw}
            chevron={false}
            disabled={busy || !controller}
            disabledReason={busy ? S.actions.busy : undefined}
            onPress={() => {
              sheet.close()
              controller?.regenerate(message.id)
            }}
            risk={leavesPhone(useModelStore.getState().activeModel) ? 'paid' : undefined}
            testid="m-chat-message-regenerate"
            el="C6.3"
          />
        ) : null}
        <Row title={S.actions.edit} icon={Pencil} chevron={isAnswer} disabled={(isAnswer && (busy || stillWriting)) || (!isAnswer && !controller)} disabledReason={busy || (isAnswer && stillWriting) ? S.actions.busy : undefined} onPress={edit} testid="m-chat-message-edit" el="C6.4" />
        <Row title={S.actions.share} icon={Share2} chevron={false} disabled={!text} onPress={share} risk="leaves-app" testid="m-chat-message-share" el="C6.5" />
        <Row
          title={S.actions.selectText}
          icon={TextSelect}
          disabled={!text}
          onPress={() => nav.push('/chat/:id/message/:messageId/text', { id: chatId, messageId: message.id })}
          testid="m-chat-message-select"
          el="C6.6"
        />
        {canReport(message.role, storePolicy().reportContent) ? <Row title={S.policy.report} icon={Flag} chevron={false} onPress={report} testid="m-chat-message-report" el="C6.8" /> : null}
      </ListGroup>
      <ListGroup>
        <Row title={S.actions.delete} icon={Trash2} danger chevron={false} risk="destructive" disabled={busy} disabledReason={S.actions.busy} onPress={remove} testid="m-chat-message-delete" el="C6.7" />
      </ListGroup>
    </Sheet>
  )
}
