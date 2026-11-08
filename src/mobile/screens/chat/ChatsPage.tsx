/**
 * C1 Chats. Route /chats, root of the tab Chat, strand 1 (Chat core).
 *
 * Large title with the Cloud switch (slot of strand 5), the segment
 * "On this phone" / "Remote desktop" (the second one shows the slot of strand
 * 6), the search, the list, and the fixed action "New chat".
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Ellipsis, Plus, Search } from 'lucide-react'
import type { Conversation } from '../../../types/chat'
import { conversationModel } from '../../../lib/conversation-model'
import { useChatStore } from '../../../stores/chatStore'
import { useGenerationStore } from '../../../stores/generationStore'
import { useModelStore } from '../../../stores/modelStore'
import { nav, useChatsSegment } from '../../nav'
import { CHAT_STRINGS } from '../../strings/chat'
import { useFootScrolls } from '../../ui/screen-shape'
import { Button, EmptyState, ErrorState, Field, IconButton, ListGroup, Notice, RootPage, Row, Segmented, SkeletonRows, Sparse, toast } from '../../ui'
import { RemoteHome } from '../remote/RemoteHome'
import { remoteDesktopOffered } from '../../policy/gates'
import { CloudSwitch } from '../settings/cloud/CloudSwitch'
import { useChatsUnreadable } from '../../lib/storage-alerts'
import { useBackupFound } from './parts/adapters/backup-found'
import { dismissRescueHint, lookForRescue, restoreFromHint, useRescueHint } from './parts/adapters/chat-rescue-hint'
import { installDeletionNote } from '../../lib/chat-rescue'
import './parts/chat.css'
import { chatModelLabel } from './parts/model-name'
import { useChatsHydrated } from './parts/hooks'
import { chatTitleShown, matchChats, phoneChats, previewLine, relativeTime } from './parts/logic/chat-list'
import { installChatPreload } from './parts/preload'
import { installCatalogueFacts } from './parts/model-name'
import { installThinkingDefault } from './parts/thinking-default'
import { useLongPress } from './parts/useLongPress'

const S = CHAT_STRINGS.list

// The first screen of the app: from here on the logic layer knows how much room this phone has
// for the model it loads ahead at the start (parts/preload.ts).
installChatPreload()
// The catalogue of the phone knows which of its models think (parts/model-name.ts).
installCatalogueFacts()
installThinkingDefault()
// A chat that leaves the list from here on was deleted on purpose: the restore from the backup does not offer it (C46).
installDeletionNote()


function ChatRow(props: { chat: Conversation; answering: boolean; model: string; now: number }) {
  const { chat, answering, model, now } = props
  const title = chatTitleShown(chat)
  const openMenu = () => nav.openSheet('chat-menu', { chatId: chat.id })
  // A long press opens the menu. The tap that ends the same press must not open the chat as well.
  const held = useRef(false)
  const press = useLongPress(() => {
    held.current = true
    openMenu()
  })
  return (
    <div className="m-rowwrap" data-testid="m-chats-item" data-m-id={chat.id} data-state={answering ? 'answering' : 'idle'} data-el="C1.4" {...press} onPointerDown={(event) => {
      held.current = false
      press.onPointerDown(event)
    }}>
      <Row
        title={title}
        chevron={false}
        subtitle={
          <>
            <span className="m-chat-row-sub">{previewLine(chat)}</span>
            <span className="m-chat-row-meta">
              {answering ? <span className="m-chat-row-live">{S.answering}</span> : null}
              {model ? <span>{model}</span> : null}
              <span>{relativeTime(chat.updatedAt, now)}</span>
            </span>
          </>
        }
        onPress={() => {
          if (held.current) {
            held.current = false
            return
          }
          nav.push('/chat/:id', { id: chat.id })
        }}
        testid="m-chats-open"
      />
      <IconButton icon={Ellipsis} label={S.moreFor(title)} onPress={openMenu} testid="m-chats-item-more" el="C1.5" />
    </div>
  )
}

export default function ChatsPage() {
  const hydrated = useChatsHydrated()
  const conversations = useChatStore((s) => s.conversations)
  const generating = useGenerationStore((s) => s.generating)
  const models = useModelStore((s) => s.models)
  // Kept by the scaffold (nav/chats-segment.ts): it survives leaving the tab, and other pages can lead here.
  const storedSegment = useChatsSegment((s) => s.segment)
  // Store switch remoteDesktop: without it there is no second segment, and the control is not drawn.
  const remoteOffered = remoteDesktopOffered()
  const segment = remoteOffered ? storedSegment : 'phone'
  const setSegment = useChatsSegment((s) => s.setSegment)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const chats = useMemo(() => phoneChats(conversations), [conversations])
  const shown = useMemo(() => matchChats(chats, deferredQuery), [chats, deferredQuery])
  // Not read is not empty: no "no chats yet", no restore offer, no new chat that could not be saved (F11).
  const unreadable = useChatsUnreadable()
  const rescue = useRescueHint()
  useEffect(() => {
    void lookForRescue()
  }, [])
  const showRescue = segment === 'phone' && hydrated && !unreadable && rescue.count > 0
  // The hint carries the restore itself; the quiet link of the empty list would be a second way to the same.
  const backupFound = useBackupFound(hydrated && chats.length === 0 && !unreadable) && !showRescue
  const restoreRescue = async () => {
    const { outcome, added } = await restoreFromHint()
    if (outcome === 'restored') toast(S.rescueDone(added), { testid: 'm-chats-rescue-done' })
    else toast(outcome === 'not-saved' ? S.rescueNotSaved : S.rescueFailed, { tone: 'error', testid: 'm-chats-rescue-error' })
  }
  const newChat = () => nav.push('/chat/:id', { id: 'new' })
  const searching = query.trim().length > 0
  // On a page too low for a fixed footer (a phone on its side) "New chat" stands at the end of the list; the
  // header carries the same action so it is one tap away (finding N8 of the Android review).
  const footScrolls = useFootScrolls()
  const canStart = segment === 'phone' && hydrated && !unreadable

  let list
  if (!hydrated) {
    list = <SkeletonRows rows={4} label={S.loading} testid="m-chats-loading" />
  } else if (unreadable && chats.length === 0) {
    list = (
      <Sparse>
        <ErrorState
          title={S.unreadableTitle}
          testid="m-chats-unreadable"
          el="C1.8"
          actions={
            <>
              <Button variant="primary" onPress={() => window.location.reload()} testid="m-chats-unreadable-retry" el="C1.8">
                {S.unreadableRetry}
              </Button>
              <Button onPress={() => nav.resetTo('settings', [{ route: '/settings/storage' }])} testid="m-chats-unreadable-storage" el="C1.8">
                {S.unreadableStorage}
              </Button>
            </>
          }
        >
          {unreadable.noSpace ? S.unreadableNoSpace : S.unreadableOther}
        </ErrorState>
      </Sparse>
    )
  } else if (chats.length === 0) {
    // Mark, title and one sentence in the middle, and when a backup with chats lies on the phone one quiet link under
    // them (C1.7). No second button for a new chat: the header carries it (round 57, David: a card and a large
    // button under the sentence sat off centre and were one action too many on a screen a new chat leads back to).
    list = (
      <EmptyState
        title={S.emptyTitle}
        testid="m-chats-empty"
        actions={
          backupFound ? (
            <Button variant="link" onPress={() => nav.resetTo('settings', [{ route: '/settings/data' }])} testid="m-chats-restore" el="C1.7">
              {S.restore}
            </Button>
          ) : undefined
        }
      >
        {S.emptyText}
      </EmptyState>
    )
  } else if (shown.length === 0) {
    list = (
      <EmptyState
        title={S.noMatch(query.trim())}
        icon={Search}
        testid="m-chats-nomatch"
        actions={
          <Button onPress={() => setQuery('')} testid="m-chats-nomatch-action">
            {S.clearSearch}
          </Button>
        }
      />
    )
  } else {
    list = (
      <div className="m-chat-list" data-testid="m-chats-list" data-m-count={shown.length}>
        <ListGroup label={S.groupLabel} flat>
          {shown.map((chat) => (
            <ChatRow key={chat.id} chat={chat} answering={!!generating[chat.id]} model={chatModelLabel(models, conversationModel(chat))} now={now} />
          ))}
        </ListGroup>
      </div>
    )
  }

  return (
    <RootPage
      title={S.title}
      screen="chats"
      flush
      actions={
        <>
          <CloudSwitch />
          {canStart && chats.length === 0 ? (
            <IconButton icon={Plus} label={S.newChat} onPress={newChat} testid="m-chats-empty-new" el="C1.6" />
          ) : canStart && footScrolls ? (
            <IconButton icon={Plus} label={S.newChat} onPress={newChat} testid="m-chats-new-head" el="C1.6" />
          ) : null}
        </>
      }
      footer={
        // The main action of the page is its footer with chats and without: the footer never lies under the tab
        // bar, and where it has to scroll with the content the round button leads to it (ui/Page.tsx, round 16 F8).
        // Not while the chats could not be read: a new chat would be the first write over what is there.
        // With no chat yet the list is an empty state with the plus in the header (above): nothing else to do here.
        canStart && chats.length > 0 ? (
          <Button variant="primary" block icon={Plus} onPress={newChat} testid="m-chats-new" el="C1.6">
            {S.newChat}
          </Button>
        ) : undefined
      }
    >
      {/* On a low phone at large text the bar scrolls sideways (chat.css); the layout check of the tests reads data-m-scroll-x. */}
      <div className="m-chat-tools" data-m-scroll-x="">
        {remoteOffered ? (
          <Segmented
            label={S.segmentLabel}
            look="tabs"
            value={segment}
            onChange={setSegment}
            options={[
              { value: 'phone', label: S.onPhone, testid: 'm-chats-segment-phone' },
              { value: 'remote', label: S.remote, testid: 'm-chats-segment-remote' },
            ]}
            testid="m-chats-segment"
            el="C1.2"
          />
        ) : null}
        {segment === 'phone' && hydrated && chats.length > 0 ? (
          <Field label={S.search} hideLabel placeholder={S.search} type="search" icon={Search} clearable value={query} onChange={setQuery} testid="m-chats-search" el="C1.3" />
        ) : null}
      </div>
      {showRescue ? (
        <Notice
          title={S.rescueTitle(rescue.count)}
          testid="m-chats-rescue"
          actions={
            <>
              <Button compact variant="primary" busy={rescue.busy} onPress={() => void restoreRescue()} testid="m-chats-rescue-restore">
                {S.rescueRestore}
              </Button>
              <Button compact variant="quiet" onPress={dismissRescueHint} testid="m-chats-rescue-dismiss">
                {S.rescueNotNow}
              </Button>
            </>
          }
        >
          {S.rescueText(rescue.count)}
        </Notice>
      ) : null}
      {segment === 'phone' ? list : <RemoteHome />}
      {segment === 'phone' && searching && shown.length > 0 ? <span className="m-sr" role="status">{`${shown.length}`}</span> : null}
    </RootPage>
  )
}
