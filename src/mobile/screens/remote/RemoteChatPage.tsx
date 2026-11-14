/**
 * R4 Remote chat. Route /remote/chat/:id, page, strand 6 (Remote and resilience).
 *
 * From mobile-docs/design/DESIGN.md (German, element texts in English):
 *
 *   **R4 Remote-Unterhaltung** (`/remote/chat/:id`)
 *   Wie C2, mit diesen Unterschieden: Kopfzeile traegt die Unterzeile "On <Name des Desktops>". Die Modellwahl
 *   zeigt die Modelle des Desktops. C4 bietet Fotos und Dateien an, C5 zeigt nur Agent mode, Thinking, Persona und
 *   Caveman. Werkzeuge laufen auf dem Desktop mit dessen Rechten; die Seite sagt das einmal im Hinweisbereich.
 *   Zusaetzliche Zustaende: Verbindung verloren mitten in der Antwort: Fehlerkasten "Connection to your desktop
 *   was lost." mit "Reconnect".
 *
 * Elements (own numbers, R4 has none in the design):
 *   R4.1 message field   R4.2 send   R4.3 stop   R4.4 model on the desktop
 *   R4.5 chat options    R4.6 chat menu          R4.7 "More" at an answer
 *   R4.8 the button under an answer that did not end well
 *   R4.9 add photos
 *
 * A desktop of 3.0.5 sends an answer in one piece, so the wait shows "Your
 * desktop is working on it" with Stop, never text that pretends to type.
 * What the user typed is kept per chat in the store and survives every
 * error, a new pairing and the background.
 *
 * Round 2: photos (sheet "remote-attach", waiting above the text field
 * until Send), Agent mode with the tools of the desktop (the steps stand
 * above the answer), the short way of speaking, and chats that belong to one
 * desktop: a chat of another desktop can be read here and is not continued.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { MoreHorizontal, X } from 'lucide-react'
import { isThinkingModel } from '../../remote/remoteClient'
import { nav, useParams } from '../../nav'
import type { RemoteChat, RemoteImage, RemoteImageInput, RemoteMessage, RemoteStatus } from '../../remote/remoteClientStore'
import { REMOTE_STRINGS as S } from '../../strings/remote'
import { Button, Composer, EmptyState, IconButton, Notice, Page, SkeletonRows, Spinner, tuneSummary } from '../../ui'
import { ConnectionNotice } from './parts/ConnectionNotice'
import { Markdown } from '../../ui/Markdown'
import { openNewRemoteChat, sayOutcome } from './parts/actions'
import { removePendingPhoto, restorePendingPhotos, takePendingPhotos, usePendingPhotos } from './parts/photos'
import { remote, useKnownDesktops, useRemote } from './parts/session'
import { Steps } from './parts/Steps'
import { actionLabel, chatDesktopName, remoteModelLabel, desktopName, isForeignChat, messageFooter, sendBlocked, unansweredAction, type MessageAction } from './parts/view'
import './parts/remote.css'

function Photos({ images }: { images: readonly RemoteImage[] }) {
  const shown = images.filter((image) => image.thumb)
  return (
    <div className="m-remote-photos" data-testid="m-remote-chat-photos">
      {shown.map((image, index) => (
        <img key={index} className="m-remote-photo" src={`data:image/jpeg;base64,${image.thumb}`} alt={image.name || S.chat.photoAlt} />
      ))}
      {shown.length < images.length ? <span className="m-remote-photo-count">{S.chat.photoChip(images.length - shown.length)}</span> : null}
    </div>
  )
}

function Tray({ chatId, photos }: { chatId: string; photos: readonly RemoteImageInput[] }) {
  return (
    <div className="m-remote-tray" data-testid="m-remote-chat-tray">
      {photos.map((photo, index) => (
        <span key={index} className="m-remote-tray-item">
          {photo.thumb ? (
            <img className="m-remote-photo" src={`data:image/jpeg;base64,${photo.thumb}`} alt={photo.name || S.chat.photoAlt} />
          ) : (
            <span className="m-remote-photo-count">{S.chat.photoChip(1)}</span>
          )}
          <IconButton icon={X} label={S.chat.removePhoto(photo.name || S.chat.photoChip(1))} onPress={() => removePendingPhoto(chatId, index)} testid={`m-remote-chat-tray-remove-${index}`} />
        </span>
      ))}
    </div>
  )
}

function runAction(action: Exclude<MessageAction, null>, chatId: string): void {
  if (action === 'enter-code') {
    nav.push('/remote/connect')
    return
  }
  if (action === 'reconnect') {
    void remote().verifyConnection()
    return
  }
  void remote()
    .retryLast(chatId)
    .then((outcome) => void sayOutcome(outcome, chatId))
}

function Answer({ chat, message, isLast, status, waiting, foreign }: { chat: RemoteChat; message: RemoteMessage; isLast: boolean; status: RemoteStatus; waiting: boolean; foreign: boolean }) {
  // In a chat of another desktop nothing can be asked again, so no answer gets a button.
  const footer = messageFooter(message, isLast && !foreign, status)
  const button =
    footer?.action != null ? (
      <Button compact onPress={() => runAction(footer.action as Exclude<MessageAction, null>, chat.id)} testid="m-remote-chat-answer-action" el="R4.8">
        {actionLabel(footer.action)}
      </Button>
    ) : null

  return (
    <div className="m-remote-msg" data-testid="m-remote-chat-answer" data-m-id={message.id} data-m-state={message.state} aria-label={S.chat.desktop}>
      {message.thinking ? (
        <details className="m-remote-think">
          <summary>{S.chat.thinking}</summary>
          {message.thinking}
        </details>
      ) : null}
      {message.steps ? <Steps steps={message.steps} /> : null}
      {message.content ? <Markdown content={message.content} idPrefix="m-remote" /> : null}
      {waiting ? (
        <div className="m-remote-working" role="status" data-testid="m-remote-chat-working">
          <Spinner label={chat.agentMode ? S.chat.workingAgent : S.chat.working} />
          <span>
            <strong>{chat.agentMode ? S.chat.workingAgent : S.chat.working}</strong>
            {S.chat.workingText}
          </span>
        </div>
      ) : null}
      {message.agentEnd ? (
        <div className="m-remote-msg-foot m-remote-msg-foot--warn" data-testid="m-remote-chat-agent-end">
          <span className="m-grow">{message.agentEnd === 'max-iterations' ? S.chat.endMaxSteps : S.chat.endToolErrors}</span>
        </div>
      ) : null}
      {footer ? (
        footer.tone === 'error' ? (
          <Notice variant="error" title={footer.title} actions={button} testid="m-remote-chat-answer-error">
            {footer.text}
          </Notice>
        ) : (
          <div className={footer.tone === 'warn' ? 'm-remote-msg-foot m-remote-msg-foot--warn' : 'm-remote-msg-foot'} data-testid="m-remote-chat-answer-note">
            <span className="m-grow">{footer.text}</span>
            {button}
          </div>
        )
      ) : null}
      {message.state === 'done' && message.content ? (
        <div className="m-remote-msg-tools">
          <IconButton
            icon={MoreHorizontal}
            label={S.chat.moreForAnswer}
            onPress={() => nav.openSheet('remote-message', { chatId: chat.id, messageId: message.id })}
            testid="m-remote-chat-answer-more"
            el="R4.7"
          />
        </div>
      ) : null}
    </div>
  )
}

function Thread({ chat, status, streaming, foreign }: { chat: RemoteChat; status: RemoteStatus; streaming: boolean; foreign: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const last = chat.messages.at(-1)
  const signature = `${chat.messages.length}:${last?.id ?? ''}:${last?.state ?? ''}:${last?.content.length ?? 0}:${last?.steps?.length ?? 0}`

  useLayoutEffect(() => {
    // Keep the newest line in view: a question that was just sent, an answer that just arrived.
    const body = ref.current?.closest('.m-body')
    if (body) body.scrollTop = body.scrollHeight
  }, [signature])

  if (chat.messages.length === 0) {
    return (
      <EmptyState title={S.chat.emptyTitle} testid="m-remote-chat-empty">
        {S.chat.emptyText}
      </EmptyState>
    )
  }

  return (
    <div className="m-remote-thread" ref={ref} data-testid="m-remote-chat-thread">
      <p className="m-remote-thread-note" data-testid="m-remote-chat-note">
        {chat.agentMode ? S.chat.agentOnDesktop : S.chat.runsOnDesktop}
      </p>
      {chat.messages.map((message, index) => {
        const isLast = index === chat.messages.length - 1
        if (message.role === 'user') {
          return (
            <div key={message.id} className="m-remote-msg m-remote-msg--user" data-testid="m-remote-chat-question" aria-label={S.chat.you}>
              {message.images && message.images.length > 0 ? <Photos images={message.images} /> : null}
              {message.content ? <div className="m-remote-bubble">{message.content}</div> : null}
              {foreign ? null : (
                <div className="m-remote-msg-tools m-remote-msg-tools--user">
                  <IconButton
                    icon={MoreHorizontal}
                    label={S.chat.moreForQuestion}
                    onPress={() => nav.openSheet('remote-message', { chatId: chat.id, messageId: message.id })}
                    testid="m-remote-chat-question-more"
                    el="R4.7"
                  />
                </div>
              )}
            </div>
          )
        }
        return (
          <Answer
            key={message.id}
            chat={chat}
            message={message}
            isLast={isLast}
            status={status}
            foreign={foreign}
            // In Agent mode there is text between the steps while the work goes on.
            waiting={isLast && streaming && message.state === 'pending' && (chat.agentMode || !message.content)}
          />
        )
      })}
      {last?.role === 'user' && !streaming && status !== 'unpaired' && !foreign ? (
        <div className="m-remote-msg-foot" data-testid="m-remote-chat-unanswered">
          <span className="m-grow">{S.chat.unanswered}</span>
          <Button compact onPress={() => runAction(unansweredAction(status), chat.id)} testid="m-remote-chat-unanswered-action" el="R4.8">
            {actionLabel(unansweredAction(status))}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export default function RemoteChatPage() {
  const { id } = useParams<{ id: string }>()
  const hydrated = useRemote((s) => s.hydrated)
  const chat = useRemote((s) => s.chats.find((c) => c.id === id))
  const status = useRemote((s) => s.status)
  const streamingChatId = useRemote((s) => s.streamingChatId)
  const connection = useRemote((s) => s.connection)
  const draft = useRemote((s) => s.drafts[id] ?? '')
  const known = useKnownDesktops()
  const photos = usePendingPhotos(id)

  useEffect(() => {
    // The store sends into its active chat; this page is that chat while it is open.
    if (hydrated && chat) remote().selectChat(id)
  }, [hydrated, chat, id])

  if (!hydrated) {
    return (
      <Page title={S.chat.title} screen="remote-chat">
        <SkeletonRows rows={4} label={S.chat.loading} testid="m-remote-chat-loading" />
      </Page>
    )
  }

  if (!chat) {
    return (
      <Page title={S.chat.title} screen="remote-chat">
        <EmptyState
          title={S.chat.missingTitle}
          testid="m-remote-chat-missing"
          actions={
            <Button variant="primary" block onPress={() => void nav.back()} testid="m-remote-chat-missing-back">
              {S.chat.backToList}
            </Button>
          }
        >
          {S.chat.missingText}
        </EmptyState>
      </Page>
    )
  }

  const streaming = streamingChatId === chat.id
  const foreign = isForeignChat(chat, connection)
  const blocked = sendBlocked({ status, streamingChatId }, chat.id, foreign)
  const remoteRest = tuneSummary([chat.agentMode ? S.options.agentPart : null, isThinkingModel(chat.model) && chat.thinkEnabled ? S.options.thinkingPart : null])
  const ownDesktop = chatDesktopName(chat.baseUrl, connection, known) || desktopName(connection)

  const send = () => {
    const state = remote()
    state.selectChat(chat.id)
    // The photos leave the tray with the message and come back when the send did not start.
    const images = takePendingPhotos(chat.id)
    void state.sendMessage(undefined, { images }).then((outcome) => {
      if (outcome !== 'sent') restorePendingPhotos(chat.id, images)
      sayOutcome(outcome, chat.id)
    })
  }

  const banner = foreign ? (
    <Notice
      variant="info"
      title={S.chat.otherDesktopTitle(ownDesktop)}
      testid="m-remote-chat-other-desktop"
      actions={
        status === 'connected' ? (
          <Button compact onPress={openNewRemoteChat} testid="m-remote-chat-other-new">
            {S.chat.newChatHere}
          </Button>
        ) : null
      }
    >
      {S.chat.otherDesktopText(desktopName(connection))}
    </Notice>
  ) : (
    <ConnectionNotice where="chat" />
  )

  return (
    <Page
      title={chat.title}
      subtitle={foreign || status === 'connected' ? S.chat.onDesktop(ownDesktop) : S.chat.notConnected}
      screen="remote-chat"
      flush
      bareFooter
      actions={<IconButton icon={MoreHorizontal} label={S.chat.menu} onPress={() => nav.openSheet('remote-chat-menu', { chatId: chat.id, inChat: true })} testid="m-remote-chat-menu" el="R4.6" />}
      banner={banner}
      footer={
        <Composer
          value={draft}
          onChange={(text) => remote().setDraft(chat.id, text)}
          label={S.chat.message}
          placeholder={S.chat.placeholder}
          onSend={send}
          running={streaming}
          onStop={() => remote().stopStreaming()}
          sendBlocked={blocked}
          hasAttachment={photos.length > 0}
          attachments={photos.length > 0 ? <Tray chatId={chat.id} photos={photos} /> : undefined}
          idPrefix="m-remote-chat"
          testid="m-remote-chat-composer"
          el="R4.1"
          tune={{
            summary: (
              <>
                <b>{remoteModelLabel(chat.model) || S.chat.modelNone}</b>
                {remoteRest ? ` · ${remoteRest}` : null}
              </>
            ),
            label: S.options.settingsName(tuneSummary([remoteModelLabel(chat.model) || S.chat.modelNone, remoteRest])),
            changed: chat.agentMode || chat.systemPrompt !== null,
            onPress: () => nav.openSheet('remote-options', { chatId: chat.id }),
            testid: 'm-remote-chat-options',
            el: 'R4.5',
          }}
          attach={{ label: S.chat.attach, onPress: () => nav.openSheet('remote-attach', { chatId: chat.id }), testid: 'm-remote-chat-attach', el: 'R4.9' }}
        />
      }
    >
      <Thread chat={chat} status={status} streaming={streaming} foreign={foreign} />
    </Page>
  )
}
