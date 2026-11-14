/**
 * C2 Chat. Route /chat/:id, page, strand 1 (Chat core). The id "new" is a
 * chat that gets its id with the first message.
 *
 * From top to bottom: header (back, title, "Chat menu"), notice area, the
 * transcript, the composer. The send path is the desktop one
 * (src/hooks/useChat.ts); this file only draws and steers it.
 *
 * Bound through slots of other strands: EngineNotices (G10), ChatNoticeSlot
 * (C2.28 to C2.30), MessageBlocks (C2.20, C2.21, C2.25), ComposerStatus
 * (C2.10 to C2.12). Opened through their routes: chat options C5, documents
 * C8, preview C11, group chat C13, price G13.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Ellipsis, Users, X } from 'lucide-react'
import type { Conversation, Message } from '../../../types/chat'
import { useChat, useIsSendPending } from '../../../hooks/useChat'
import { useCloudSession } from '../../../hooks/useCloudSession'
import { systemVoiceUsable, useVoice } from '../../../hooks/useVoice'
import { matchAgentCommands, type AgentCommand } from '../../../lib/agent-commands'
import { MAX_CHAT_IMAGES, prepareChatImages } from '../../../lib/chat-image-input'
import { chatModelReady } from '../../../lib/chat-model-ready'
import { composerBusy } from '../../../lib/composer-busy'
import { dismissEngineError, useEngineView, usePreloadSkip } from '../../../lib/engine-view'
import { continuesInPlace } from '../../../lib/continue-answer'
import { isGroupChat } from '../../../lib/group-chat'
import { latestRefusalId, refusalNoticeApplies } from '../../../lib/refusal-detect'
import { useIsQueuedForLocalLane, useLocalLaneQueuePosition } from '../../../lib/run-idle'
import { useAgentModeStore } from '../../../stores/agentModeStore'
import { useChatNoticeStore } from '../../../stores/chatNoticeStore'
import { useChatStore } from '../../../stores/chatStore'
import { useGenerationStore } from '../../../stores/generationStore'
import { useModelStore } from '../../../stores/modelStore'
import { useRAGStore } from '../../../stores/ragStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useVoiceStore } from '../../../stores/voiceStore'
import { nav, useIsTop, useParams } from '../../nav'
import { useAppLifecycle } from '../../platform'
import { EngineNotices } from '../../resilience/EngineNotices'
import { useCloudOnline } from '../../resilience/useOnline'
import { CHAT_STRINGS } from '../../strings/chat'
import { Banner, Button, caretToEnd, Composer, EmptyState, Icon, IconButton, Page, Progress, SkeletonRows, Spinner, toast, tuneSummary } from '../../ui'
import { ChatNoticeSlot } from '../agent/ChatNoticeSlot'
import { AgentToolGuard, ComposerAlerts, useComposerStatusParts } from '../agent/ComposerStatus'
import { chatKey as agentChatKey } from '../agent/parts/chat-ref'
import { isDeviceModel, leavesPhone, modelPlace } from '../../lib/model-place'
import { canReport, reportForAnswer } from './parts/logic/policy'
import { markStoppedByUser } from './parts/user-stop'
import { openReport, storePolicy } from './parts/policy'
import { answerSpeedInput, reportSpeed, speedFigure } from './parts/adapters/generation-speed'
import { keepRememberRequest } from '../agent/parts/remember-request'
import { copyText } from './parts/adapters/handover'
import { viewAnswer } from './parts/adapters/run-error'
import './parts/chat.css'
import { chatModelDirect, chatModelLabel } from './parts/model-name'
import { DIRECT_MARK } from '../../policy/unfiltered'
import { useReadingNames } from './parts/logic/reading'
import { AttachmentChips, CommandList, ContextChip, DictationMeter, useClock } from './parts/ComposerParts'
import { cloudAllowed, isCloudModel } from './parts/consent'
import { ensureAiConsent } from './parts/policy'
import { registerChatController, takePendingContinue } from './parts/controller'
import { useChatsHydrated } from './parts/hooks'
import { chatTitleShown, shownText } from './parts/logic/chat-list'
import { ranOnOther } from './parts/logic/chat-state'
import { useArrivingModel } from '../models/parts/arriving'
import { imagesFromClipboard } from './parts/paste'
import { installDraftSaving } from './parts/draft-save'
import { useMarkRoom } from './parts/mark-room'
import { installSwitchNote } from './parts/switched-under-answer'
import { handOverFirstQuestion, releaseFirstQuestion } from '../../lib/first-question'
import { installCatalogueFacts } from './parts/model-name'
import { installChatPreload, loadModelNow, preloadForChat } from './parts/preload'
import { installVoicePreference, usePhoneSpeech } from './parts/voice-pref'
import { installThinkingDefault } from './parts/thinking-default'
import { readAloudWay, showsSpeakButton } from './parts/read-aloud'
import { useMobilePrefs } from '../settings/parts/prefs'
import { useEngineUi } from '../models/parts/engine'
import { startChat } from './parts/start-chat'
import { phoneEngineNote } from './parts/engine-note'
import { modelReadsImages } from './parts/vision'
import { NEW_CHAT_KEY, setPendingSend, takePendingSend, useDraft, useDraftStore } from './parts/logic/drafts'
import { continuableError, encodeFileRef, foldContinuations, isAtBottom, lastAnswerId, messageText, visibleMessages, widenWindow, windowStart, WINDOW_SIZE, writtenPart } from './parts/logic/messages'
import { MessageItem, type MessageHandlers } from './parts/MessageItem'

const S = CHAT_STRINGS

// The two seams this strand fills in the logic layer, once: how much room the phone has for a
// model that is loaded ahead, and whether read-aloud may use the voice of the system.
installChatPreload()
installVoicePreference()
installThinkingDefault()
installCatalogueFacts()
// What waits in the composer comes back after the app was ended (parts/draft-save.ts).
installDraftSaving()
// Choosing another model under a running answer is noted, so the chat says that and not "interrupted" (parts/switched-under-answer.ts).
installSwitchNote()

/** Messages this far from the end may skip their layout while off screen. */
const ALWAYS_LAID_OUT = 6

export default function ChatPage() {
  const { id } = useParams<{ id: string }>()
  const isNew = id === 'new'
  const hydrated = useChatsHydrated()
  const conversation = useChatStore((s) => (isNew ? undefined : s.conversations.find((c) => c.id === id)))

  if (!isNew && !conversation) {
    return (
      <Page title={S.chat.newTitle} screen="chat">
        {hydrated ? (
          <EmptyState
            title={S.chat.missingTitle}
            testid="m-chat-missing"
            actions={
              <Button variant="primary" onPress={() => void nav.back()} testid="m-chat-missing-back">
                {S.chat.backToChats}
              </Button>
            }
          >
            {S.chat.missingText}
          </EmptyState>
        ) : (
          <SkeletonRows rows={4} label={S.list.loading} testid="m-chat-loading" />
        )}
      </Page>
    )
  }
  return <ChatScreen key={id} chatId={isNew ? null : id} conversation={conversation} />
}

/** Store an answer and its continuation as the one answer the transcript shows (parts/logic/messages.ts). */
function storeFolded(chatId: string, final: boolean): void {
  useChatStore.setState((state) => {
    const chat = state.conversations.find((c) => c.id === chatId)
    if (!chat) return state
    const folded = foldContinuations(chat.messages, { final })
    if (folded === chat.messages) return state
    return { conversations: state.conversations.map((c) => (c.id === chatId ? { ...c, messages: [...folded] } : c)) }
  })
}

/** A scroll counts as the reader's own for this long after the last touch or wheel turn (a flick keeps rolling). */
const HAND_SCROLL_MS = 3000

/** "Answering, 0:07" in the notice area. The clock starts with the message the run is writing. */
function RunLine({ since }: { since: number | null }) {
  const clock = useClock(since)
  return (
    <div className="m-chat-status" role="status" data-testid="m-chat-running">
      <Spinner label={S.list.answering} />
      <span>{since === null ? S.list.answering : S.chat.answering(clock)}</span>
    </div>
  )
}

function ChatScreen({ chatId, conversation }: { chatId: string | null; conversation: Conversation | undefined }) {
  const draftKey = chatId ?? NEW_CHAT_KEY
  const chat = useChat()
  const voice = useVoice()
  const online = useCloudOnline()
  const isTop = useIsTop()
  const { cloudAvailable } = useCloudSession()
  const engine = useEngineView()
  const preloadSkip = usePreloadSkip()
  const draft = useDraft(draftKey)

  const appMode = useSettingsStore((s) => s.settings.appMode)
  const activeModel = useModelStore((s) => s.activeModel)
  const models = useModelStore((s) => s.models)
  const inventoryLoaded = useModelStore((s) => s.inventoryLoaded)
  const generating = useGenerationStore((s) => s.generating)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const agentOn = useAgentModeStore((s) => (chatId ? (s.agentModeActive[chatId] ?? false) : false))
  const retrievalError = useRAGStore((s) => s.retrievalError)
  const notices = useChatNoticeStore((s) => s.notices)
  const queued = useIsQueuedForLocalLane(chatId)
  const queuePosition = useLocalLaneQueuePosition(chatId)

  const inCloud = appMode === 'cloud'
  // A model of a provider with the user's own key needs the network like LU Cloud does.
  const needsNet = inCloud || modelPlace(activeModel) === 'own'
  const modelName = activeModel ? chatModelLabel(models, activeModel) : null
  // Prompt v2: the grey summary next to the settings button (model, then what is on in this chat).
  const status = useComposerStatusParts(chatId ?? null, agentChatKey(chatId))
  const tuneRest = tuneSummary([...status.parts, inCloud ? S.chat.cloudPart : null, chatModelDirect(models, activeModel) ? DIRECT_MARK : null])
  const hasLocalModel = useMemo(() => models.some((m) => m.type === 'text' && m.provider !== 'lu-cloud'), [models])
  // From the tap on: a send first searches documents, picks memories and waits for the model, and only
  // then counts as generating. For that long the answer is empty and nobody has failed yet (H1).
  const sendPending = useIsSendPending(chatId)
  const running = chatId ? composerBusy(chat.isGenerating && activeConversationId === chatId, generating, chatId).thisChat || sendPending : false
  const lastOfChat = conversation?.messages.at(-1)
  const noTextYet = running && !(lastOfChat?.role === 'assistant' && (lastOfChat.content || lastOfChat.thinking))
  // One answer for "is the engine loading, ready or not holding the model": src/lib/engine-view.ts.
  const deviceModel = isDeviceModel(activeModel)
  const loadingModel = deviceModel && engine.state === 'loading'
  // "The model was unloaded to free memory" already carries "Load again" (resilience/EngineNotices).
  // A second button for the same thing under the transcript is one too many (small iPhone, N22).
  const engineBusy = useEngineUi((u) => !!u.busy)
  const unloadedNotice = useEngineUi((u) => !!u.unloaded && !u.busy && !u.failure)
  const notLoaded = deviceModel && engine.state === 'not-loaded' && !running && !unloadedNotice

  /* ---------- which chat the send path writes to ---------- */
  const ensureActive = useCallback(() => {
    const store = useChatStore.getState()
    if (store.activeConversationId !== chatId) store.setActiveConversation(chatId)
  }, [chatId])
  useEffect(() => {
    if (isTop) ensureActive()
  }, [isTop, ensureActive])

  /* ---------- the model is loaded ahead ---------- */
  // Opening a chat (and coming back to it) loads the chosen model before the first message asks for
  // it, when it fits into memory. The same function the start of the app uses, so nothing loads
  // twice. A message sent meanwhile waits for that load.
  useEffect(() => {
    if (isTop && deviceModel) void preloadForChat()
  }, [isTop, deviceModel, activeModel])
  useAppLifecycle({
    onForeground: () => {
      if (live.current.isTop && isDeviceModel(useModelStore.getState().activeModel)) void preloadForChat()
    },
  })

  /* ---------- transcript: window, scroll, jump ---------- */
  const visible = useMemo(() => visibleMessages(conversation?.messages ?? []), [conversation?.messages])
  const [shown, setShown] = useState(WINDOW_SIZE)
  const first = windowStart(visible.length, Math.max(shown, WINDOW_SIZE))
  const rendered = first > 0 ? visible.slice(first) : visible
  const lastVisible = visible[visible.length - 1]
  const streamingId = running && lastVisible?.role === 'assistant' ? lastVisible.id : null
  const answerId = lastAnswerId(visible)
  const declinedId = conversation && refusalNoticeApplies(conversation, agentOn) ? latestRefusalId(visible, streamingId) : null

  const rootRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  // A message to a cloud model costs credits: the send button carries the mark (TESTIDS.md, duty 6).
  const paidSend = isCloudModel(activeModel)
  const stick = useRef(true)
  /** On the way to the end ("Jump to latest"): the scroll events of that way must not count as the reader leaving. */
  const heading = useRef(false)
  const heightBefore = useRef<number | null>(null)
  const [away, setAway] = useState(false)
  const scroller = useCallback(() => rootRef.current?.closest<HTMLElement>('.m-body') ?? null, [])

  // A chat without a message has no end to stand at. What it says (the heading, the model, the way to
  // a model) begins at the top, and where the page is lower than that, the top is what shows: on its
  // side at the largest text the view stood at the end, the heading above it under the notice lines
  // (acceptance on the large iPhone, G6).
  const nothingYet = visible.length === 0
  // The mark of the greeting stays wherever it fits into the free area (parts/mark-room.ts).
  useMarkRoom(rootRef, nothingYet)
  const nothingRef = useRef(nothingYet)
  useLayoutEffect(() => {
    nothingRef.current = nothingYet
    const el = scroller()
    if (nothingYet && el) el.scrollTop = 0
  }, [nothingYet, scroller])
  /** Where the view stands while it follows: the end of the transcript, the top of an empty chat. */
  const endOf = useCallback((el: HTMLElement) => (nothingRef.current ? 0 : el.scrollHeight), [])

  const toEnd = useCallback(
    (smooth = false) => {
      const el = scroller()
      if (!el) return
      stick.current = true
      el.style.overflowAnchor = 'none'
      heading.current = smooth
      if (smooth) el.scrollTo({ top: endOf(el), behavior: 'smooth' })
      else el.scrollTop = endOf(el)
    },
    [scroller, endOf],
  )

  useLayoutEffect(() => {
    toEnd()
  }, [toEnd])

  // Messages that arrived while another page lay on top (an answer kept from Compare, a run that
  // went on) are what the user comes back for: the chat shows its end then (acceptance on Android, N7).
  const countWhenLeft = useRef<number | null>(null)
  const messageCount = conversation?.messages.length ?? 0
  useLayoutEffect(() => {
    if (!isTop) {
      if (countWhenLeft.current === null) countWhenLeft.current = messageCount
      return
    }
    const before = countWhenLeft.current
    countWhenLeft.current = null
    if (before !== null && messageCount > before) toEnd()
  }, [isTop, messageCount, toEnd])

  useEffect(() => {
    const el = scroller()
    if (!el) return
    let lastTop = el.scrollTop
    // While the view follows, this page places it and the browser must not correct an anchor on its own
    // (it does when skipped messages get their real height, and that reads like a move by the reader).
    // Away from the end the browser holds what the reader looks at.
    const setFollow = (follow: boolean) => {
      stick.current = follow
      el.style.overflowAnchor = follow ? 'none' : ''
      setAway(!follow)
    }
    setFollow(stick.current)
    // When a hand last touched the transcript. A position that drops without one is the browser
    // fitting the view to a new height (the keyboard opens, a line under the header goes), and that
    // must not count as the reader leaving the end: the chat then stood two answers back with the
    // keyboard open, behind "Jump to latest".
    let handAt = 0
    let handDown = false
    const onScroll = () => {
      const at = isAtBottom(el)
      const byHand = handDown || Date.now() - handAt < HAND_SCROLL_MS
      const movedUp = el.scrollTop < lastTop - 1 && byHand
      lastTop = el.scrollTop
      if (at) heading.current = false
      // Only a move upwards leaves the end. A scroll event also comes when the transcript grows under the view.
      const follow = at || heading.current || (stick.current && !movedUp)
      setFollow(follow)
      if (follow && !at && !heading.current && !nothingRef.current) el.scrollTop = el.scrollHeight
    }
    // A touch or a wheel turn means the reader takes over again.
    const onHand = () => {
      heading.current = false
      handAt = Date.now()
    }
    const onDown = () => {
      handDown = true
      onHand()
    }
    const onUp = () => {
      handDown = false
      handAt = Date.now()
    }
    // The way ended short because text arrived meanwhile: finish it.
    const onScrollEnd = () => {
      if (heading.current && !isAtBottom(el)) el.scrollTop = endOf(el)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('scrollend', onScrollEnd)
    el.addEventListener('touchstart', onDown, { passive: true })
    el.addEventListener('touchmove', onHand, { passive: true })
    el.addEventListener('touchend', onUp, { passive: true })
    el.addEventListener('touchcancel', onUp, { passive: true })
    el.addEventListener('pointerdown', onHand, { passive: true })
    el.addEventListener('wheel', onHand, { passive: true })
    el.addEventListener('keydown', onHand)
    // The transcript grows while an answer streams and shrinks when the keyboard opens.
    // Follow only while the reader stands at the end.
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = endOf(el)
      else setAway(!isAtBottom(el))
    })
    observer.observe(el)
    if (threadRef.current) observer.observe(threadRef.current)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('scrollend', onScrollEnd)
      el.removeEventListener('touchstart', onDown)
      el.removeEventListener('touchmove', onHand)
      el.removeEventListener('touchend', onUp)
      el.removeEventListener('touchcancel', onUp)
      el.removeEventListener('pointerdown', onHand)
      el.removeEventListener('wheel', onHand)
      el.removeEventListener('keydown', onHand)
      el.style.overflowAnchor = ''
      observer.disconnect()
    }
  }, [scroller, endOf])

  useLayoutEffect(() => {
    // "Show earlier" adds messages above: keep what the reader looks at in place.
    const el = scroller()
    if (el && heightBefore.current !== null) el.scrollTop += el.scrollHeight - heightBefore.current
    heightBefore.current = null
  }, [shown, scroller])

  const showEarlier = () => {
    heightBefore.current = scroller()?.scrollHeight ?? null
    setShown((n) => widenWindow(visible.length, Math.max(n, WINDOW_SIZE)))
  }

  const focusInput = useCallback(() => {
    const field = dockRef.current?.querySelector<HTMLTextAreaElement>('textarea')
    field?.focus()
    caretToEnd(field)
  }, [])

  /* ---------- sending ---------- */
  const openModels = useCallback((segment?: 'local' | 'cloud', vision?: boolean) => nav.openSheet('model', { segment, vision }), [])

  // True from the tap that creates a chat until its question is written and the page swapped.
  const handingOver = useRef(false)
  const send = useCallback(
    (text: string, withDraft: boolean) => {
      const state = useDraftStore.getState().drafts[draftKey]
      const images = withDraft ? (state?.images ?? []) : []
      const files = withDraft ? (state?.files ?? []) : []
      if (!text.trim() && images.length === 0 && files.length === 0) return
      if (handingOver.current) return
      if (!chatModelReady()) {
        toast(S.chat.chooseFirst, { testid: 'choose-model' })
        openModels()
        return
      }
      void cloudAllowed()
        .then((allowed) => {
          // Declined: nothing leaves the phone and the draft stays as it is (cloudAllowed says so itself).
          if (!allowed) return
          if (!chatId) {
            const newId = startChat({ keepDraft: false })
            // No chat without a model. The text stays, and the tap gets an answer instead of silence (N3).
            if (!newId) {
              toast(S.chat.chooseFirst, { testid: 'choose-model' })
              openModels()
              return
            }
            setPendingSend(newId, { text: text.trim(), images, files })
            // The question is on the disk before it looks sent: only then is the field emptied and the page
            // swapped (lib/first-question.ts, finding F2 on Android). A second tap meanwhile does nothing.
            const chat = useChatStore.getState().conversations.find((c) => c.id === newId)
            handingOver.current = true
            void handOverFirstQuestion(
              { chatId: newId, text: text.trim(), model: chat?.model ?? '', systemPrompt: chat?.systemPrompt ?? '', attachments: images.length + files.length, at: Date.now() },
              () => {
                handingOver.current = false
                useDraftStore.getState().clear(draftKey)
                nav.replace('/chat/:id', { id: newId })
              },
            )
            return
          }
          const sendNow = () => {
            ensureActive()
            if (withDraft) useDraftStore.getState().clear(draftKey)
            toEnd()
            // "Remember this: ..." is kept before the model answers, so its "I have noted" is true (Android 8 GB, B8).
            keepRememberRequest(text, chatId)
            void live.current.chat.sendMessage(text.trim(), images.length ? images : undefined, files.length ? files : undefined)
          }
          // A message without text has nothing a record could bring back.
          if (!text.trim()) return sendNow()
          // The same order as for a new chat (round 21, the rest of F2): the question is on the disk before the
          // field is emptied. A kill before that leaves the text in the field, a kill after it finds the record.
          const at = Date.now()
          const chat = useChatStore.getState().conversations.find((c) => c.id === chatId)
          handingOver.current = true
          void handOverFirstQuestion(
            { chatId, text: text.trim(), model: chat?.model ?? '', systemPrompt: chat?.systemPrompt ?? '', attachments: images.length + files.length, at, existing: true },
            () => {
              handingOver.current = false
              sendNow()
              releaseFirstQuestion(chatId, at)
            },
          )
        })
        // Anything that breaks between the tap and the hand over: the draft is still there, and the user is told (N3).
        .catch(() => {
          const drafts = useDraftStore.getState()
          if (withDraft && !drafts.drafts[draftKey]?.text) drafts.setText(draftKey, text)
          toast(S.policy.notSent, { tone: 'error', testid: 'send-failed' })
        })
    },
    [chatId, draftKey, ensureActive, openModels, toEnd],
  )

  useEffect(() => {
    if (!chatId) return
    const waiting = takePendingSend(chatId)
    if (!waiting) return
    ensureActive()
    keepRememberRequest(waiting.text, chatId)
    void chat.sendMessage(waiting.text, waiting.images?.length ? waiting.images : undefined, waiting.files?.length ? waiting.files : undefined)
    // The record of the tap has done its work once the chat store has written the question itself.
    releaseFirstQuestion(chatId)
    // Only once per chat page: the send that created this chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId])

  const submit = () => {
    if (draft.editing && chatId) {
      const text = draft.text.trim()
      const target = conversation?.messages.find((m) => m.id === draft.editing)
      if (!text) return
      if (!chatModelReady()) {
        toast(S.chat.chooseFirst, { testid: 'choose-model' })
        openModels()
        return
      }
      void cloudAllowed().then((allowed) => {
        if (!allowed) return
        useDraftStore.getState().clear(draftKey)
        if (!target) return
        ensureActive()
        toEnd()
        live.current.chat.editAndResend(chatId, target.id, text)
      })
      return
    }
    send(draft.text, true)
  }

  const stop = () => {
    ensureActive()
    chat.stopGeneration()
    // The answer says that it was stopped by the user, not that the model failed (round 22, N3).
    markStoppedByUser(chatId)
  }

  /* ---------- actions on messages ---------- */
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const readAloudOn = useVoiceStore((s) => s.ttsEnabled)
  // Read so the page paints again when "Use the system voice" is switched or the voice of the phone
  // is known (parts/voice-pref.ts); systemVoiceUsable() asks both.
  useMobilePrefs((s) => s.systemVoiceFallback)
  usePhoneSpeech((s) => s.source)
  const speakWay = readAloudWay({ hookVoice: voice.ttsAvailable || voice.ttsExternalReady, systemVoice: systemVoiceUsable() })
  const canSpeak = showsSpeakButton(readAloudOn, speakWay)
  // LU Cloud does the voice work when its voice is on: the hook then caps a recording, which is the one thing it tells.
  const cloudVoice = voice.maxRecordingMs !== null
  // The marks of what a tap costs (TESTIDS.md, duty 6). One object while nothing changes, so a finished message is not painted again.
  const paidMarks = useMemo(() => ({ regenerate: paidSend, speak: cloudVoice }), [paidSend, cloudVoice])
  const reportable = canReport('assistant', storePolicy().reportContent)

  // What the stable handlers below read at the moment they run.
  // A cut answer of this chat can be gone on with in place: the engine of this phone, a plain chat (round 10).
  const continues = continuesInPlace({ model: activeModel, agentOn, group: !!conversation && isGroupChat(conversation.groupModels) })
  const live = useRef({ chat, voice, running, speakingId, conversation, send, isTop, continues })
  useLayoutEffect(() => {
    live.current = { chat, voice, running, speakingId, conversation, send, isTop, continues }
  })

  const handlers = useMemo<MessageHandlers>(
    () => ({
      more: (message) => nav.openSheet('message', { chatId, messageId: message.id }),
      copy: (message) => {
        void copyText(messageText(message)).then((ok) => {
          if (ok) toast(S.actions.copied, { testid: 'copied' })
          else toast(S.actions.copyFailed, { tone: 'error', testid: 'copy-failed' })
        })
      },
      regenerate: (message) => {
        if (!chatId || live.current.running) return
        void cloudAllowed().then((allowed) => {
          if (!allowed || live.current.running) return
          ensureActive()
          toEnd()
          live.current.chat.regenerateMessage(chatId, message.id)
        })
      },
      report: (message) => {
        const state = useModelStore.getState()
        openReport(reportForAnswer(message, messageText(message), leavesPhone(message.modelId), state.activeModel ?? '', (id) => chatModelLabel(state.models, id)))
      },
      continueAnswer: (message) => {
        if (!chatId || live.current.running) return
        const view = viewAnswer(message, { cloud: isCloudModel(message.modelId) })
        // Cut by a closed app, or cut because the engine of this phone stopped under it ("Restart engine" while it wrote).
        const partial = continuableError(view.error?.kind, isCloudModel(message.modelId)) && view.body.trim() !== ''
        const from = writtenPart(message)
        // Nothing of the answer is there: asking again is all there is to do. And where the model cannot go on inside
        // its answer (LU Cloud, a provider with an own key, an agent run, a group chat) the box says "Regenerate"
        // and this is what it does (round 10). A request to continue made a small model start over, and what a
        // provider does with a cut answer as the last message is not known.
        if (!partial || from.trim() === '' || !live.current.continues) {
          handlers.regenerate(message)
          return
        }
        void cloudAllowed().then((allowed) => {
          if (!allowed || live.current.running) return
          // The part that arrived stays in the chat as it is, and the model is asked to go on from it.
          // Asking the whole question again would throw away what the user already has.
          // An earlier "Continue" that was cut as well is stored as one answer first, so this one goes on from all of it.
          storeFolded(chatId, false)
          useChatStore.getState().updateMessageFinishReason(chatId, message.id, 'stop')
          ensureActive()
          toEnd()
          // The request is a message of the send path, not of the reader: the transcript shows the answer going on
          // in its own bubble (parts/logic/messages.ts), and once the run is over the chat is stored that way.
          // The engine of the phone never reads the request: it gets the part back and writes on inside it.
          void live.current.chat.sendMessage(S.chat.continuePrompt, undefined, undefined, undefined, { continueFrom: from }).finally(() => storeFolded(chatId, true))
        })
      },
      speak: (message) => {
        const v = live.current.voice
        if (v.isSpeaking && live.current.speakingId === message.id) {
          v.stopSpeaking()
          setSpeakingId(null)
          return
        }
        // Nothing on this phone can speak: the sheet names what can. First, because the switch below is
        // locked on such a phone and "switch it on" would lead nowhere.
        // Asked at the tap: "Use the system voice" may have been switched in the settings since the last paint.
        if (readAloudWay({ hookVoice: v.ttsAvailable || v.ttsExternalReady, systemVoice: systemVoiceUsable() }) === null) {
          nav.openSheet('chat-voice-gate', { kind: 'speak' })
          return
        }
        // "Read aloud" is switched off in the settings: the voice hook then says nothing. Say so, with the way there.
        if (!useVoiceStore.getState().ttsEnabled) {
          nav.openSheet('chat-voice-gate', { kind: 'speak-off' })
          return
        }
        if (v.isSpeaking) v.stopSpeaking()
        setSpeakingId(message.id)
        void v.speakTextStreaming(messageText(message))
      },
      answerWithoutThinking: (message) => {
        if (!chatId || live.current.running) return
        useSettingsStore.getState().updateSettings({ thinkingEnabled: false })
        toast(S.message.thinkingOff, { testid: 'thinking-off' })
        handlers.regenerate(message)
      },
      newChat: () => nav.replace('/chat/:id', { id: 'new' }),
      chooseModel: (segment) => openModels(segment),
    }),
    [chatId, ensureActive, openModels, toEnd],
  )

  useEffect(() => {
    if (!chatId) return
    return registerChatController({
      chatId,
      isBusy: () => live.current.running,
      regenerate: (messageId) => {
        const message = live.current.conversation?.messages.find((m) => m.id === messageId)
        if (message) handlers.regenerate(message)
      },
      continueAnswer: (messageId) => {
        const message = live.current.conversation?.messages.find((m) => m.id === messageId)
        if (message) handlers.continueAnswer(message)
      },
      editInComposer: (message: Message) => {
        useDraftStore.getState().beginEdit(chatId, message.id, shownText(message))
        window.setTimeout(focusInput, 0)
      },
      speak: (message) => handlers.speak(message),
      isSpeaking: (messageId) => live.current.voice.isSpeaking && live.current.speakingId === messageId,
      speakIsPaid: () => live.current.voice.maxRecordingMs !== null,
      send: (text) => live.current.send(text, false),
    })
  }, [chatId, handlers, focusInput])

  // "Continue" from another screen while this page was not there (parts/controller.ts, continueReply).
  useEffect(() => {
    if (!chatId) return
    const messageId = takePendingContinue(chatId)
    if (!messageId) return
    const message = live.current.conversation?.messages.find((m) => m.id === messageId)
    if (message) handlers.continueAnswer(message)
  }, [chatId, handlers])

  // A toast lies over the lower edge for three seconds, and on a short screen that is where the text
  // field is (seen on 360x592: the tap hit "installed", the field got no focus, the typed words were
  // lost). A tap on a toast at the place of the field belongs to the field. The buttons of a toast keep
  // their taps. The kit now puts a toast at the top of the content on a page with a composer, so this
  // only matters for a toast that still ends up over the field (a very short screen with the keyboard up).
  useEffect(() => {
    if (!isTop) return
    const onTap = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target || !target.closest('.m-toast') || target.closest('button')) return
      const field = dockRef.current?.querySelector<HTMLTextAreaElement>('textarea')
      if (!field) return
      const box = field.getBoundingClientRect()
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) return
      field.focus()
    }
    window.addEventListener('click', onTap, true)
    return () => window.removeEventListener('click', onTap, true)
  }, [isTop])

  /* ---------- the end of a run ---------- */
  const runStart = useRef<number | null>(null)
  const firstTokenAt = useRef<number | null>(null)
  // The speed of the answer written last in this chat, for the quiet line under it (N22).
  const [speedOf, setSpeedOf] = useState<{ id: string; rate: number } | null>(null)
  const sessionShown = useRef<string | null>(null)
  useEffect(() => {
    if (running && !noTextYet && firstTokenAt.current === null) firstTokenAt.current = Date.now()
  }, [running, noTextYet])
  useEffect(() => {
    if (running) {
      if (runStart.current === null) {
        runStart.current = Date.now()
        firstTokenAt.current = null
      }
      return
    }
    if (runStart.current === null) return
    const startedAt = runStart.current
    const firstAt = firstTokenAt.current
    runStart.current = null
    firstTokenAt.current = null
    const last = live.current.conversation?.messages.at(-1)
    if (!last || last.role !== 'assistant') return
    const cloud = isCloudModel(last.modelId)
    const view = viewAnswer(last, { cloud })
    if (!view.error) {
      const measured = answerSpeedInput({
        reportedTokens: last.usage?.completionTokens && !last.usage.estimated ? last.usage.completionTokens : undefined,
        body: view.body,
        thinking: last.thinking,
        runStartedAt: startedAt,
        firstTokenAt: firstAt,
        endedAt: Date.now(),
      })
      const rate = reportSpeed({
        ...measured,
        model: last.modelId ?? useModelStore.getState().activeModel ?? '',
        where: cloud ? 'cloud' : 'device',
      })
      // Only an answer of this phone: the speed of a cloud model says nothing about the device.
      setSpeedOf(rate !== null && !cloud ? { id: last.id, rate } : null)
    } else if (view.error.kind === 'session' && sessionShown.current !== last.id) {
      // G6: the session ended in the middle of the work. The sheet asks to sign in again, the message stays.
      sessionShown.current = last.id
      nav.openSheet('session')
    }
  }, [running])

  /* ---------- dictation (C2.7) ---------- */
  const [recordingSince, setRecordingSince] = useState<number | null>(null)
  const stopDictation = useCallback(async () => {
    const text = (await live.current.voice.stopRecording()).trim()
    setRecordingSince(null)
    if (!text) return
    const current = useDraftStore.getState().drafts[draftKey]?.text ?? ''
    useDraftStore.getState().setText(draftKey, current ? `${current.replace(/\s+$/, '')} ${text}` : text)
    focusInput()
  }, [draftKey, focusInput])

  const dictate = async () => {
    if (voice.isRecording) return stopDictation()
    // A take is being written down: a second tap neither starts another nor sends (r48).
    if (voice.isTranscribing) return
    if (!voice.sttSupported) {
      nav.openSheet('chat-voice-gate', { kind: 'dictate' })
      return
    }
    // The recording goes to LU Cloud: asked before the microphone opens (M1).
    if (!(await ensureAiConsent())) {
      toast(S.voice.consentNeeded, { testid: 'consent-declined' })
      return
    }
    const started = await voice.startRecording()
    if (started) setRecordingSince(Date.now())
    else {
      // The toast says it; the line under the composer would say it a second time.
      voice.clearSttError()
      toast(S.voice.micDenied, { tone: 'error', testid: 'mic-denied' })
    }
  }

  useEffect(() => {
    if (!voice.isRecording || recordingSince === null || !voice.maxRecordingMs) return
    const timer = window.setTimeout(() => void stopDictation(), Math.max(0, voice.maxRecordingMs - (Date.now() - recordingSince)))
    return () => window.clearTimeout(timer)
  }, [voice.isRecording, voice.maxRecordingMs, recordingSince, stopDictation])

  const retryDictation = async () => {
    const text = (await voice.retryDictation()).trim()
    if (!text) return
    const current = useDraftStore.getState().drafts[draftKey]?.text ?? ''
    useDraftStore.getState().setText(draftKey, current ? `${current.replace(/\s+$/, '')} ${text}` : text)
  }

  /* ---------- what is drawn ---------- */
  const commands = draft.editing ? [] : matchAgentCommands(draft.text, agentOn ? 'agent' : 'chat')
  const pickCommand = (command: AgentCommand) => {
    useDraftStore.getState().setText(draftKey, `/${command.name} `)
    focusInput()
  }
  const hasAttachment = draft.images.length > 0 || draft.files.length > 0
  const readingNames = useReadingNames(draftKey)
  // Only when the chat ran on another model than the active one. A message keeps the bare name of
  // its model and the picker the routed one: the same model under two names is not "before" (M8).
  const ranOn = ranOnOther(conversation, activeModel)
  const ranOnLabel = ranOn ? chatModelLabel(models, ranOn) : null
  const modelHint = ranOnLabel && ranOnLabel !== modelName ? ranOnLabel : null
  const group = conversation && isGroupChat(conversation.groupModels) ? conversation.groupModels : null
  const noModelAtAll = inventoryLoaded && !hasLocalModel && !cloudAvailable && !activeModel
  // A first model that is still downloading is not "no model yet" (M1).
  // One source for "a model is on its way", shared with the onboarding and the Models tab (models/parts/arriving.ts).
  const arriving = useArrivingModel()
  const incoming = noModelAtAll ? arriving : null
  const incomingName = incoming?.name ?? ''
  const openFile = (fileId: string) => nav.push('/chat/:id/file/:fileId', { id: draftKey, fileId })

  const banner = (
    <>
      <EngineNotices />
      {chatId ? <ChatNoticeSlot chatId={chatId} /> : null}
      {/* The notices above already show an engine error, with "Pick another model". This line only
          speaks while they are silent (a load is running), so the same error is never on screen twice. */}
      {engine.state === 'error' && engine.note && engineBusy ? (
        <Banner variant="error" testid="m-chat-engine-error" action={{ label: S.engine.dismiss, onPress: dismissEngineError }}>
          {phoneEngineNote(engine.note)}
        </Banner>
      ) : null}
      {modelHint ? <Banner testid="m-chat-model-hint">{S.chat.ranOnBefore(modelHint)}</Banner> : null}
      {retrievalError ? (
        <Banner
          variant="warn"
          testid="m-chat-retrieval-error"
          action={
            answerId && !running
              ? {
                  label: S.retrieval.tryAgain,
                  onPress: () => {
                    useRAGStore.getState().setRetrievalError(null)
                    const message = visible.find((m) => m.id === answerId)
                    if (message) handlers.regenerate(message)
                  },
                }
              : { label: S.retrieval.dismiss, onPress: () => useRAGStore.getState().setRetrievalError(null) }
          }
        >
          {S.retrieval.title}
        </Banner>
      ) : null}
      {notices.map((notice) => (
        <Banner key={notice.id} variant={notice.ton === 'fehler' ? 'warn' : 'info'} testid="m-chat-notice-line" action={{ label: S.retrieval.dismiss, onPress: () => useChatNoticeStore.getState().dismiss(notice.id) }}>
          {notice.text}
        </Banner>
      ))}
      {running && !loadingModel ? <RunLine since={lastVisible?.timestamp ?? null} /> : null}
    </>
  )

  const pasteImages = async (files: File[]) => {
    const state = useModelStore.getState()
    if (!modelReadsImages(state.activeModel, state.models)) {
      toast(S.chat.pasteNoVision, { tone: 'error', testid: 'paste-no-vision' })
      return
    }
    const room = MAX_CHAT_IMAGES - (useDraftStore.getState().drafts[draftKey]?.images.length ?? 0)
    if (room <= 0) {
      toast(S.attach.tooManyImages(MAX_CHAT_IMAGES), { tone: 'error', testid: 'attach-limit' })
      return
    }
    const { images, errors } = await prepareChatImages(files, room)
    const added = images.length > 0 ? useDraftStore.getState().addImages(draftKey, images) : 0
    if (files.length > room) toast(S.attach.tooManyImages(MAX_CHAT_IMAGES), { tone: 'error', testid: 'attach-limit' })
    else if (added === 0) toast(errors[0] || S.attach.imageFailed, { tone: 'error', testid: 'attach-error' })
    else toast(S.chat.pasted(added), { testid: 'pasted' })
  }

  const dock = (
    <div
      className="m-chat-dock"
      ref={dockRef}
      onFocusCapture={(event) => {
        // Focus in the text field opens the keyboard: the transcript goes to its end (C2.3).
        if (event.target instanceof HTMLTextAreaElement) toEnd()
      }}
      onPasteCapture={(event) => {
        // A picture from the clipboard becomes an attachment (audit L16). Text is pasted as always.
        const files = imagesFromClipboard(event.clipboardData)
        if (files.length === 0) return
        event.preventDefault()
        void pasteImages(files)
      }}
    >
      {loadingModel ? (
        <div className="m-chat-status" role="status" data-testid="m-chat-loading-model" data-m-queued={noTextYet ? 'yes' : 'no'}>
          <Spinner label={modelName ? S.chat.loadingModel(modelName) : S.chat.loadingModelPlain} />
          <span>
            {modelName ? S.chat.loadingModel(modelName) : S.chat.loadingModelPlain}
            {noTextYet ? ` ${S.chat.loadingQueued}` : ''}
          </span>
        </div>
      ) : null}
      {notLoaded ? (
        <div className="m-chat-status" role="status" data-testid="m-chat-not-loaded" data-m-reason={preloadSkip ?? 'none'}>
          <span>
            {modelName ? S.chat.notLoaded(modelName) : S.chat.notLoadedPlain} {engine.note ?? S.chat.notLoadedHint}
          </span>
          {preloadSkip === 'no-room' ? null : (
            <Button compact onPress={() => void loadModelNow()} testid="m-chat-load-now">
              {S.chat.loadNow}
            </Button>
          )}
        </div>
      ) : null}
      {queued ? (
        <div className="m-chat-status" role="status" data-testid="m-chat-waiting">
          <Spinner label={S.chat.waitingLocal} />
          <span>
            {S.chat.waitingLocal}
            {queuePosition && queuePosition > 1 ? ` ${S.chat.waitingAhead(queuePosition - 1)}` : ''}
          </span>
        </div>
      ) : null}
      {group && chatId ? (
        <button type="button" className="m-chat-status" aria-label={S.chat.groupCostName(group.length)} data-testid="m-chat-group-cost" data-el="C2.33" style={{ minHeight: 'var(--m-touch)' }} onClick={() => nav.push('/chat/:id/group', { id: chatId })}>
          <Icon icon={Users} small />
          <span>{S.chat.groupCost(group.length)}</span>
        </button>
      ) : null}
      {voice.canRetryDictation ? (
        <div className="m-chat-status" role="status" data-testid="m-chat-dictation-retry">
          <span>{voice.sttError || S.voice.failed}</span>
          <Button compact busy={voice.isTranscribing} onPress={() => void retryDictation()} testid="m-chat-dictation-retry-action">
            {S.voice.retry}
          </Button>
          <Button compact variant="quiet" onPress={voice.discardDictation} testid="m-chat-dictation-discard">
            {S.voice.discard}
          </Button>
        </div>
      ) : voice.sttError && !voice.isRecording && !voice.isTranscribing ? (
        // Nothing kept to send again (too short, too long, unreadable): the reason still shows (r44).
        <div className="m-chat-status" role="status" data-testid="m-chat-dictation-said">
          <span>{voice.sttError}</span>
          <Button compact variant="quiet" onPress={voice.clearSttError} testid="m-chat-dictation-dismiss">
            {S.voice.dismiss}
          </Button>
        </div>
      ) : null}
      {draft.editing ? (
        <div className="m-chat-editing" data-testid="m-chat-editing">
          <span>{S.chat.editing}</span>
          <IconButton icon={X} label={S.chat.cancelEdit} onPress={() => useDraftStore.getState().cancelEdit(draftKey)} testid="m-chat-edit-cancel" />
        </div>
      ) : null}
      <CommandList commands={commands} onPick={pickCommand} />
      <Composer
        value={draft.text}
        onChange={(text) => useDraftStore.getState().setText(draftKey, text)}
        label={S.chat.input}
        onSend={submit}
        sendLabel={draft.editing ? S.chat.sendEdit : S.chat.send}
        running={running}
        onStop={stop}
        onDictate={draft.editing ? undefined : () => void dictate()}
        dictation={voice.isRecording ? 'recording' : voice.isTranscribing ? 'transcribing' : undefined}
        hasAttachment={hasAttachment}
        sendBlocked={needsNet && !online ? S.chat.offlineSend : undefined}
        cloud={inCloud}
        risk={paidSend ? 'paid' : undefined}
        // Always marked: with LU Cloud the recording costs credits, without it the tap opens the microphone of the
        // phone or the way to an account. None of that is for a sweep (acceptance Android, re-run, N9).
        micRisk="paid"
        status={
          <>
            {/* For every chat, the empty new one included: Agent mode goes off for a model without tools. */}
            <AgentToolGuard chatKey={agentChatKey(chatId)} />
            {/* Prompt v2: only warnings stand above the field. The state is the summary of the settings button. */}
            <ComposerAlerts chatKey={agentChatKey(chatId)} />
            {chatId ? <ContextChip chatId={chatId} busy={running} onCompact={() => send('/compact', false)} warnOnly /> : null}
          </>
        }
        attachments={
          hasAttachment || readingNames.length > 0 ? (
            <AttachmentChips
              images={draft.images}
              files={draft.files}
              onOpenImage={(index) => openFile(encodeFileRef({ kind: 'draft-image', index }))}
              onOpenFile={(index) => openFile(encodeFileRef({ kind: 'draft-file', index }))}
              onRemoveImage={(index) => useDraftStore.getState().removeImage(draftKey, index)}
              onRemoveFile={(index) => useDraftStore.getState().removeFile(draftKey, index)}
              reading={readingNames}
            />
          ) : undefined
        }
        replaceField={voice.isRecording || voice.isTranscribing ? <DictationMeter since={recordingSince ?? Date.now()} transcribing={!voice.isRecording} onStop={() => void stopDictation()} /> : undefined}
        tune={{
          summary: (
            <>
              <b>{modelName ?? S.chat.chooseModel}</b>
              {tuneRest ? ` · ${tuneRest}` : null}
            </>
          ),
          label: S.chat.settingsName(tuneSummary([modelName ?? S.chat.chooseModel, tuneRest])),
          changed: status.changed,
          place: inCloud ? 'cloud' : 'local',
          onPress: () => nav.openSheet('chat-options', { chatId: draftKey }),
          testid: 'm-chat-options',
          el: 'C2.5',
        }}
        attach={{ label: S.chat.attach, onPress: () => nav.openSheet('attach', { chatId: draftKey }), testid: 'm-chat-attach', el: 'C2.4' }}
      />
    </div>
  )

  return (
    <Page
      title={conversation ? chatTitleShown(conversation) : S.chat.newTitle}
      screen="chat"
      flush
      needsNetwork={needsNet}
      banner={banner}
      footer={dock}
      bareFooter
      // A chat that has not been started has nothing to rename, export, compare or delete: its menu was one line
      // saying so (second check on Android, F13). The button comes with the first message.
      actions={chatId ? <IconButton icon={Ellipsis} label={S.chat.menu} onPress={() => nav.openSheet('chat-menu', { chatId })} testid="m-chat-menu" el="C2.2" /> : undefined}
    >
      <div className="m-chat-scroll" ref={rootRef} data-m-running={running ? '' : undefined}>
        {visible.length === 0 ? (
          incoming ? (
            <EmptyState
              title={incoming.state === 'downloading' ? S.chat.incomingTitle(incomingName) : incoming.state === 'paused' ? S.chat.incomingPausedTitle(incomingName) : S.chat.incomingFailedTitle(incomingName)}
              testid="m-chat-empty"
              actions={
                <>
                  {incoming.state === 'failed' ? null : (
                    <Progress
                      label={S.chat.incomingProgress(incomingName)}
                      value={incoming.share > 0 || incoming.state === 'paused' ? incoming.share : undefined}
                      detail={incoming.share > 0 ? S.chat.incomingDetail : S.chat.incomingStarting}
                      state={incoming.state === 'paused' ? 'paused' : 'running'}
                      testid="m-chat-incoming-progress"
                    />
                  )}
                  <Button variant="primary" onPress={() => nav.resetTo('models', [{ route: '/models/downloads' }])} testid="m-chat-show-downloads">
                    {S.chat.showDownloads}
                  </Button>
                  <Button variant="quiet" onPress={() => nav.push('/cloud')} testid="m-chat-use-cloud">
                    {S.chat.useCloud}
                  </Button>
                </>
              }
            >
              <span data-testid="m-chat-incoming" data-m-state={incoming.state}>
                {incoming.state === 'downloading' ? S.chat.incomingText : incoming.state === 'paused' ? S.chat.incomingPausedText : S.chat.incomingFailedText}
              </span>
            </EmptyState>
          ) : noModelAtAll ? (
            <EmptyState
              title={S.chat.noModelTitle}
              testid="m-chat-empty"
              actions={
                <>
                  <Button variant="primary" onPress={() => nav.switchTab('models')} testid="m-chat-install-model">
                    {S.chat.installModel}
                  </Button>
                  <Button variant="cloud" onPress={() => nav.push('/cloud')} testid="m-chat-use-cloud">
                    {S.chat.useCloud}
                  </Button>
                </>
              }
            >
              {S.chat.noModelText}
            </EmptyState>
          ) : (
            <EmptyState title={S.chat.emptyTitle} testid="m-chat-empty">
              {activeModel ? S.chat.emptyType : S.chat.emptyChoose}
              {modelName ? (
                <>
                  <br />
                  <span className="m-mono" data-testid="m-chat-empty-model">
                    {modelName}
                  </span>
                </>
              ) : null}
            </EmptyState>
          )
        ) : (
          <div className="m-chat-thread" ref={threadRef} role="log" aria-label={S.chat.transcript} data-testid="m-chat-thread" data-m-count={visible.length} data-m-rendered={rendered.length}>
            {first > 0 ? (
              <div className="m-chat-earlier">
                <Button compact onPress={showEarlier} testid="m-chat-earlier">
                  {S.chat.earlier(first)}
                </Button>
              </div>
            ) : null}
            {rendered.map((message, index) => (
              <MessageItem
                key={message.id}
                chatId={chatId ?? NEW_CHAT_KEY}
                message={message}
                handlers={handlers}
                streaming={message.id === streamingId}
                last={message.id === answerId}
                busy={running}
                speaking={speakingId === message.id && voice.isSpeaking}
                canSpeak={canSpeak}
                paid={paidMarks}
                reportable={reportable}
                speed={speedOf?.id === message.id ? S.message.speed(speedFigure(speedOf.rate)) : undefined}
                declined={message.id === declinedId}
                skip={index < rendered.length - ALWAYS_LAID_OUT}
                continues={continues}
              />
            ))}
          </div>
        )}
        {away && visible.length > 0 ? (
          <button type="button" className="m-chat-jump" data-testid="m-chat-jump" data-el="C2.31" onClick={() => toEnd(true)}>
            <Icon icon={ArrowDown} small />
            {S.chat.jumpToLatest}
          </button>
        ) : null}
      </div>
    </Page>
  )
}
