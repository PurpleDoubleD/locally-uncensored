import { ChatAttachment } from './ChatAttachment'
import { ChatFileChip } from './ChatFileChip'
import { FILE_ONLY_TEXT } from '../../lib/chat-files'
import { motion } from 'framer-motion'
import { User, Copy, Check, Pencil, RefreshCw, Wrench, Trash2, Scissors, Unlink, Film, Music, GitBranch, ListRestart } from 'lucide-react'
import { useState, useRef, useEffect, useMemo, memo } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { closeOpenMarkdown } from '../../lib/streaming-markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBand } from './ToolCallBand'
import { ReflectionBlock } from './ReflectionBlock'
import { groupAgentBlocks } from '../../lib/tool-call-groups'
import { VramSwitchCard } from './VramSwitchCard'
import { SpeakerButton } from './SpeakerButton'
import { ChatArtifactCard } from './ChatArtifactCard'
import { CreateOrders } from './create/CreateOrders'
import { messageHasCreateOrder } from '../../lib/create/chat-control'
import { displayModelName } from '../../api/providers/model-name'
import { modelDisplayLabel } from '../../lib/model-label'
import type { Message } from '../../types/chat'
import { shownAnswer } from '../../lib/shown-answer'
import { truncationNotice } from '../../lib/answer-notes'
import { unbackedLinksNotice } from '../../lib/unbacked-links'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { chatToolsReach } from '../../lib/chat-tools-reach'
import { useSettingsStore } from '../../stores/settingsStore'
import { extractToolCallsFromContent, looksLikeToolIntent } from '../../lib/tool-call-repair'
import { isAgentCompatible } from '../../lib/model-compatibility'
import { ContextMenu } from '../ui/ContextMenu'
import { buildMessageMenu, type MessageMenuHandlers } from '../ui/menu-actions'
import { MONOGRAM, MONOGRAM_INVERT } from '../layout/brand'
import { AVATAR_SLOT, MODEL_MARK, MODEL_MARK_SLOT } from './avatar-slot'
import { MOTION_S } from '../ui/motion'
import { Hinweis } from '../ui/Hinweis'
import { RefusalNotice } from './RefusalNotice'
import { RequestUsageLine } from './RequestUsageLine'
import { fitTextarea } from '../../lib/fit-textarea'
import { editableText } from '../../lib/message-edit'
import { editKeyAction, editShortcuts, enterKeyMode } from '../../lib/enter-key'
import { isMacOS } from '../../lib/device-kind'
import { ForkSwitcher } from './ForkSwitcher'

interface Props {
  message: Message
  /** Takes the message id rather than closing over it, so MessageList can pass
   *  ONE stable function to every bubble — a per-message closure would be a new
   *  prop on every render and defeat the memo() below. */
  onRegenerate?: (messageId: string) => void
  /** GH #199: a group speaker's answer also offers the whole round again,
   *  as an action of its own beside Regenerate. */
  onRegenerateRound?: (messageId: string) => void
  /** "Save & resend" of an edited user message. False when nothing could be
   *  sent; the edit is then saved instead of lost. */
  onEdit?: (messageId: string, newContent: string) => boolean
  /** GH #172, #174: this message carries the "< 1/2 >" of the kept versions
   *  under `forkKey`. Plain values, not an object, so the memo below holds. */
  forkKey?: string
  forkIndex?: number
  forkTotal?: number
  /** Absent while a turn streams. */
  onSwitchFork?: (key: string, index: number) => void
  /** GH #174: a new chat that ends with this message. */
  onBranch?: (messageId: string) => void
  /** Tool-call id awaiting user approval. When the matching block in
   *  this message has that id, ToolCallBlock renders Approve/Reject
   *  inline instead of a popup over the chat input. */
  pendingApprovalId?: string | null
  onApprove?: () => void
  onReject?: () => void
  /** True for the last visible message — gates the VRAM hand-off card so it
   *  only renders in the active assistant turn, not in every historical one. */
  isLast?: boolean
  /** This bubble is the one currently streaming — hides its action bar. */
  isStreaming?: boolean
  /** Group chat: the persona this participant speaks as, when it has one of
   *  its own. Shown in front of the model name. */
  speakerName?: string
  /** This answer is the latest one of the chat in which the model declined
   *  (lib/refusal-detect). The notice with "New chat" stands under it. */
  declined?: boolean
}

function MessageBubbleImpl({ message, onRegenerate, onRegenerateRound, onEdit, pendingApprovalId, onApprove, onReject, isLast, isStreaming, speakerName, declined, forkKey, forkIndex, forkTotal, onSwitchFork, onBranch }: Props) {
  const [copied, setCopied] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const isUser = message.role === 'user'

  // Bug #7 (a user v2.4.3): the Codex-style "model parrots tool-call
  // JSON as plaintext" only happens when the active chat does NOT have
  // agent mode on. Detect the JSON pattern and show a one-click "Enable
  // agent" banner instead of leaving the user staring at a JSON dump.
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const hasCreateOrder = !isUser && messageHasCreateOrder(message)
  const deleteMessage = useChatStore((s) => s.deleteMessage)
  const updateMessageContent = useChatStore((s) => s.updateMessageContent)
  const saveUserEdit = useChatStore((s) => s.saveUserEdit)
  const isAgentActive = useAgentModeStore((s) =>
    activeConversationId ? s.agentModeActive[activeConversationId] ?? false : false
  )
  const activeModel = useModelStore((s) => s.activeModel)
  // The catalogue's name for the model that wrote this turn ("Kimi K2.6"), the
  // same one the picker shows. A string, so the selector stays stable.
  const answeredByName = useModelStore((s) =>
    message.modelId ? modelDisplayLabel(s.models, message.modelId) : '',
  )
  const toggleAgentMode = useAgentModeStore((s) => s.toggleAgentMode)
  const userAvatarDataUrl = useSettingsStore((s) => s.settings.userAvatarDataUrl)
  // GH #202: the Enter key in the edit field follows the same setting as the composer.
  const enterMode = enterKeyMode(useSettingsStore((s) => s.settings.enterKey))
  const editKeys = editShortcuts(enterMode, isMacOS())
  // Chat Tools (v2.5.3) gives plain chat web/file/image/video WITHOUT Agent Mode.
  // When it's on, the "turn Agent Mode on" banners below are wrong + contradictory
  // (the tool IS available in normal chat) — they predate Chat Tools and only
  // checked `!isAgentActive`. Suppress them when Chat Tools is enabled. The owner
  // 2026-06-16: web build, Agent off + Chat Tools on, image_generate emitted →
  // bubble showed "Turn Agent Mode on" even though the tool was already running.
  // Chat Tools are always on since 3.0.7 where the model can call tools
  // (lib/chat-tools-reach.ts); the banners stay for a model that cannot.
  const chatToolsHere = useModelStore((s) => chatToolsReach(s.activeModel, s.models))

  const suggestAgent = useMemo(() => {
    if (isUser || isAgentActive || chatToolsHere || !activeConversationId || !activeModel) return false
    if (!message.content || message.content.length < 10) return false
    // The repair helper extracts {name, arguments}-shaped JSON blocks, plus
    // <tool_call>...</tool_call> Hermes tags. If anything came out, the
    // model wanted to call a tool — even though we never registered any.
    const calls = extractToolCallsFromContent(message.content)
    if (!calls || calls.length === 0) return false
    // Only nudge when the model is on the agent-allow-list. Showing this
    // banner on a non-agent-capable model would be a dead-end.
    return isAgentCompatible(activeModel)
  }, [isUser, isAgentActive, chatToolsHere, activeConversationId, activeModel, message.content])

  // Thought-only completion (live find 2026-06-11): the model reasoned —
  // usually about calling a tool it doesn't have in a non-agent chat — and
  // stopped without ONE visible token. useChat persisted the reasoning onto
  // message.thinking; without this the bubble is silent dead air forever.
  // The last bubble additionally needs usage (set by the done chunk) so the
  // banner can't flash mid-stream while a visible thinking phase runs.
  const thoughtOnly = !isUser && !(message.content || '').trim() && !!(message.thinking || '').trim()
    && (!isLast || !!message.usage)

  // Orchestration strip for everything this bubble renders (2.5.9), from the
  // one routine read-aloud takes its text from too (lib/shown-answer.ts).
  // Memoised: the regex set is not cheap and a long agent chat re-renders
  // these bubbles often. Aggressive tier only while a tool loop drives the
  // turn: in plain chat a {"name": …, "arguments": …} block is often the
  // answer itself.
  // Signature, not the array itself: a streaming turn may grow a block's
  // content in place, leaving the array reference identical. Keying on the
  // total length re-runs the strip on every token while still skipping the
  // work on unrelated re-renders.
  const blockSig = (message.agentBlocks ?? []).reduce((n, b) => n + b.content.length, 0)
    + ':' + (message.agentBlocks?.length ?? 0)
  const toolLoopDriven = isAgentActive || !!message.agentBlocks?.length
  const shown = useMemo(
    () => (isUser ? { blocks: new Map<string, string>(), content: '', spoken: '' } : shownAnswer(message, toolLoopDriven)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isUser, message.content, blockSig, toolLoopDriven],
  )
  const cleanBlocks = shown.blocks
  const cleanContent = shown.content
  const thoughtOnlyToolIntent = useMemo(
    () => thoughtOnly && !isAgentActive && !chatToolsHere && looksLikeToolIntent(message.thinking || ''),
    [thoughtOnly, isAgentActive, chatToolsHere, message.thinking],
  )

  // A turn whose visible body comes from per-iteration answer blocks has no
  // single editable text, so the pencil hides there instead of editing a
  // field nobody sees. Also used below to pick the content fallback.
  const hasRealAnswerBlocks = useMemo(() => [...cleanBlocks.values()].some(Boolean), [cleanBlocks])
  // No editing while the turn still streams: the flush would overwrite the
  // edit a frame later. Done is marked by usage arriving with the done chunk.
  const canEditAssistant = !isUser && !hasRealAnswerBlocks
    && !!(message.content || '').trim() && (!isLast || !!message.usage)

  useEffect(() => {
    if (isEditing && editRef.current) {
      editRef.current.focus()
      fitTextarea(editRef.current)
    }
  }, [isEditing])

  const handleCopy = () => {
    // A message with files copies what was typed, not the file summaries the
    // model received along with it.
    navigator.clipboard.writeText(isUser && message.files?.length ? (message.displayContent ?? message.content) : message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const startEdit = () => {
    // User: edit the short slash command, not its expanded instruction.
    // Assistant: edit what the model actually said.
    setEditContent(isUser ? editableText(message) : message.content)
    setIsEditing(true)
  }

  /**
   * "Save" (GH #172): the new text goes into the chat and nothing else
   * happens. No request, no model load, every later turn stays. Enter does
   * this, so a single key can never send. Editing the model's answer has
   * always worked this way (D#81).
   */
  const saveEdit = () => {
    const next = editContent.trim()
    if (next && activeConversationId) {
      if (isUser) {
        if (next !== editableText(message)) saveUserEdit(activeConversationId, message.id, next)
      } else if (next !== message.content) {
        updateMessageContent(activeConversationId, message.id, next)
      }
    }
    setIsEditing(false)
  }

  /**
   * "Save & resend": ask again from here. The old continuation is kept as a
   * version ("< 1/2 >"), not deleted. When the send path refuses (no model
   * picked, a run still going) the text is saved, so the edit is not lost.
   */
  const resendEdit = () => {
    const next = editContent.trim()
    if (!next) return
    if (!onEdit?.(message.id, next)) {
      saveEdit()
      return
    }
    setIsEditing(false)
  }

  const cancelEdit = () => {
    setIsEditing(false)
    setEditContent('')
  }

  // Two-step delete (D#81): first click arms (icon turns red), second within 3s
  // removes the single message. Guards against an accidental one-click nuke of a
  // line the user meant to keep.
  const handleDelete = () => {
    if (!activeConversationId) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      setTimeout(() => setConfirmDelete(false), 3000)
      return
    }
    deleteMessage(activeConversationId, message.id)
  }

  // EIN Satz Aktionen fuer diese Nachricht. Die Leiste unter der Nachricht
  // liest daraus, und das Kontextmenue bekommt DASSELBE Objekt gereicht
  // (`buildMessageMenu` gibt die Funktionen unveraendert als `run` weiter).
  // Rechtsklick und Knopf koennen damit nicht auseinanderlaufen — genau die
  // Doppelung, die dieses Projekt schon mehrfach bezahlt hat.
  //
  // `edit` und `regenerate` sind `null`, wo die Leiste den Knopf auch nicht
  // zeigt; das Menue laesst den Eintrag dann ebenfalls weg.
  const canEdit = (isUser && !!onEdit) || canEditAssistant
  const actions: MessageMenuHandlers = {
    copy: handleCopy,
    edit: canEdit ? startEdit : null,
    regenerate: !isUser && onRegenerate ? () => onRegenerate(message.id) : null,
    branch: onBranch ? () => onBranch(message.id) : null,
    remove: handleDelete,
  }
  // Die Leiste haengt an `!isEditing && !isStreaming` — das Menue bietet
  // dieselben Aktionen an, also gilt fuer es dieselbe Bedingung.
  const actionsAvailable = !isEditing && !isStreaming

  /**
   * D-S07 — die Leiste ist jetzt hover-gated.
   *
   * Der Befund: „Aktionsleiste ist dauerhaft sichtbar, nicht hover-gated:
   * drei 12px-Icons unter jeder Nachricht, immer." Der Kommentar an der Leiste
   * nannte „always visible but subtle" ausdruecklich als Absicht — in einem
   * Transkript mit 40 Antworten sind das 120 graue Glyphen, die nie jemand
   * angesehen hat, und sie stehen genau dort, wo die naechste Zeile Text
   * anfangen wuerde.
   *
   * Warum das JETZT geht und vorher nicht: seit `f2650788` traegt die
   * Nachricht ein Kontextmenue (Rechtsklick) mit denselben Aktionen ueber
   * DIESELBEN Handler (`actions` unten geht unveraendert an
   * `buildMessageMenu`). Vorher waere Verstecken ein Funktionsverlust
   * gewesen: wer die Maus nicht ueber die Nachricht haelt, haette keinen Weg
   * mehr zu Kopieren gehabt. Jetzt gibt es zwei.
   *
   * Was hier NICHT gemacht wird und warum:
   *
   *   - Kein `hidden`/`absolute`. Die Leiste behaelt ihren Layoutplatz. Das
   *     ist bei D-S15 (Sidebar) ausdruecklich falsch, weil sie dort 55px
   *     Titelbreite frisst — hier ist es richtig: die Zeile liegt UNTER der
   *     Nachricht, und wuerde sie beim Hovern erst entstehen, spraenge das
   *     ganze Transkript unter dem Mauszeiger weg. Ein scrollendes Protokoll,
   *     das bei jeder Mausbewegung umbricht, ist schlimmer als drei blasse
   *     Icons.
   *   - `group-focus-within` steht neben `group-hover`. Ohne das waere die
   *     Leiste per Tastatur unerreichbar sichtbar: die Knoepfe blieben
   *     fokussierbar, aber unsichtbar, und der Fokus verschwaende ins Nichts.
   *   - `copied` und `confirmDelete` halten sie offen. Beide sind
   *     Rueckmeldungen AUF einen Klick („Copied", „Click again to delete");
   *     verschwaende die Leiste, sobald die Maus weiterzieht, waere die
   *     Rueckmeldung fuer genau die Geste unsichtbar, die sie ausgeloest hat.
   *
   * Was das kostet, offen gesagt: auf einem Geraet ohne Zeiger (Touch) gibt
   * es weder Hover noch Rechtsklick. Das ist eine Tauri-Desktop-App fuer
   * mac/Windows/Linux, also heute kein realer Fall — aber es ist einer, falls
   * die App je auf ein Tablet geht.
   */
  const actionBarVisibility =
    copied || confirmDelete
      ? 'opacity-100'
      : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity'

  return (
    <motion.div
      className={'flex gap-2 px-3 py-1 group ' + (isUser ? 'flex-row-reverse' : '')}
      onContextMenu={(e) => {
        if (!actionsAvailable) return
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: MOTION_S.base }}
    >
      {/* The avatar column (avatar-slot.ts): a chip for the user, the bare mark for the model. */}
      {isUser ? (
        <div className={AVATAR_SLOT}>
          {userAvatarDataUrl
            ? <img src={userAvatarDataUrl} alt="" className="w-full h-full object-cover" />
            : <User size={11} className="text-gray-400" />}
        </div>
      ) : (
        <div className={MODEL_MARK_SLOT} data-testid="model-mark">
          <img src={MONOGRAM} alt="" className={`${MODEL_MARK} ${MONOGRAM_INVERT}`} />
        </div>
      )}

      {/* A reply with a Create order takes the full width in a narrow window:
          the card and the result need the room. */}
      <div className={(hasCreateOrder ? 'min-w-0 flex-1 sm:flex-none sm:max-w-[80%]' : 'max-w-[80%]') + ' space-y-0.5'}>
        {/* Name the model that produced this answer. Group chats have always
            done this; since the R5 re-measure (2026-08-30) every assistant
            turn carries it, because the app had no model name at a single
            answer anywhere and therefore no way to be honest about an older
            chat. Turns from before that carry none and get no line, rather
            than a guess. */}
        {!isUser && message.modelId && (
          // Ohne Steckplatz-Praefix: `openai::` ist unsere interne Adresse
          // fuer jedes Backend, das das OpenAI-Protokoll spricht, und stand
          // damit vor jedem lokalen Modellnamen im Chat (Persona P5,
          // 03./04.09.2026).
          //
          // Auch im title, seit dem 04.09.2026. Dort stand die rohe Kennung
          // mit der Begruendung "der volle Name bleibt im title", und das war
          // der Fehler in einem Wort: der volle Name ist der Modellname, die
          // Kennung davor ist unsere Adresse. Wer den Zeiger auf der Zeile
          // ruhen liess, bekam sie zu sehen, obwohl sie ihm nichts sagt.
          <div title={displayModelName(message.modelId)} data-testid="answered-by" className="t-mono text-gray-500 dark:text-gray-400 pl-1">
            {speakerName ? `${speakerName} · ${answeredByName}` : answeredByName}
          </div>
        )}
        {/* Thinking block — auto-expands while this (last) turn is still
            producing so the reasoning streams LIVE, then collapses (2026-06-04). */}
        {!isUser && message.thinking && (
          <ThinkingBlock thinking={message.thinking} streaming={!!isLast && !message.content?.trim() && !message.usage} />
        )}

        {/* Agent Mode: render tool_call + reflection + answer blocks
            chronologically. Reflection blocks persist narration the model
            emitted between tool calls (added for #29 follow-up). Answer
            blocks (2026-05) carry each iteration's outgoing text so the
            tool calls don't all stack above a wall of summary at the
            bottom — every provider, every model. */}
        {!isUser && message.agentBlocks && message.agentBlocks.length > 0 && (
          <>
            {groupAgentBlocks(
              [...message.agentBlocks]
                .filter(
                  (b) =>
                    b.phase === 'tool_call' ||
                    b.phase === 'reflection' ||
                    (b.phase === 'answer' && b.content.trim()) ||
                    // G21-2: per-round thoughts render chronologically between
                    // the calls.
                    (b.phase === 'thinking' && b.content.trim()),
                )
                .sort((a, b) => a.timestamp - b.timestamp),
            )
              .map((group, gruppenIndex, gruppen) => {
                // Consecutive tool calls render as ONE band that morphs from
                // tool to tool and collapses to "N steps" when done (the owner
                // 2026-07-31) instead of a chip per call.
                if (group.kind === 'tools') {
                  return (
                    <ToolCallBand
                      key={group.blocks[0].id}
                      calls={group.calls}
                      notes={group.notes}
                      renderNote={(block) =>
                        block.phase === 'thinking' ? (
                          <ThinkingBlock thinking={block.content} />
                        ) : block.phase === 'reflection' ? (
                          <ReflectionBlock content={block.content} />
                        ) : (
                          <div className="px-1 py-0.5 text-[0.7rem] leading-relaxed text-gray-500 dark:text-gray-400">
                            <MarkdownRenderer content={cleanBlocks.get(block.id) ?? block.content} />
                          </div>
                        )
                      }
                      pendingApprovalId={pendingApprovalId}
                      onApprove={onApprove}
                      onReject={onReject}
                    />
                  )
                }
                const block = group.block
                if (block.phase === 'thinking') {
                  // Trailing thought (after the last call, before the final
                  // answer) in its G14-7 bubble, collapsed, chronological.
                  return <ThinkingBlock key={block.id} thinking={block.content} />
                }
                if (block.phase === 'reflection') {
                  return <ReflectionBlock key={block.id} content={block.content} />
                }
                if (block.phase === 'answer') {
                  // A block that was ONLY orchestration (a bare LOOP_DONE line,
                  // a stray ool_call>) renders nothing, not an empty bubble.
                  const clean = cleanBlocks.get(block.id) ?? ''
                  if (!clean) return null
                  // Im Agent-Modus waechst der Text im LETZTEN Block, nicht
                  // in message.content — der Fallback unten rendert dann gar
                  // nichts. Also haengt der Balken hier, und nur am Schluss
                  // der Kette, damit nicht jeder aeltere Block einen bekommt.
                  const istSchluss = gruppenIndex === gruppen.length - 1
                  return (
                    <div key={block.id} className="px-1 py-0.5">
                      <div className={'text-[0.8rem] leading-relaxed' + (isStreaming && istSchluss ? ' lu-caret' : '')}>
                        <MarkdownRenderer content={isStreaming && istSchluss ? closeOpenMarkdown(clean) : clean} />
                      </div>
                    </div>
                  )
                }
                return null
              })}
          </>
        )}

        {/* Create in chat: order, progress and results, from the store of this
            conversation's orders. */}
        {hasCreateOrder && <CreateOrders message={message} conversationId={activeConversationId} />}

        {/* Feature EE (v2.5.0) — VRAM hand-off status card. Self-hides unless
            an actual model swap is in flight; gated to the last assistant
            message so a swap shows only in the active turn. */}
        {!isUser && isLast && <VramSwitchCard />}

        {/* Attached files: a chip each, the bytes are not in the chat. */}
        {message.files && message.files.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {message.files.map((file, i) => (
              <ChatFileChip key={`${file.sha256}-${i}`} file={file} />
            ))}
          </div>
        )}

        {/* Clips and sound tracks for Create: name and kind only, the bytes
            stay in the session. */}
        {isUser && message.media && message.media.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1" data-testid="chat-media-chips">
            {message.media.map((clip, i) => (
              <span key={i} className="flex max-w-[200px] items-center gap-1.5 rounded-md border border-gray-200 px-2 py-1 t-micro text-gray-500 dark:border-white/10 dark:text-gray-400">
                {clip.kind === 'video' ? <Film size={11} className="shrink-0" /> : <Music size={11} className="shrink-0" />}
                <span className="truncate">{clip.name}</span>
              </span>
            ))}
          </div>
        )}

        {/* Image attachments */}
        {message.images && message.images.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {message.images.map((img, i) => (
              <ChatAttachment key={i} image={img} />
            ))}
          </div>
        )}

        {/* Main content — assistant messages drop the bubble entirely
            (per user feedback: "die graue Blase komplett weghaben"). User
            messages keep theirs because they're right-aligned and need
            the visual anchor against the chat background. */}
        <div
          className={
            'relative ' +
            (isUser
              ? 'rounded-lg px-2.5 py-1.5 bg-gray-100 dark:bg-white/[0.06] border border-gray-200 dark:border-white/[0.08] focus-within:border-gray-400 dark:focus-within:border-white/20 transition-colors'
              : 'px-1 py-0.5')
          }
        >
          {isEditing ? (
            <div className="space-y-1">
              <textarea
                ref={editRef}
                value={editContent}
                onChange={(e) => {
                  setEditContent(e.target.value)
                  // Measured off-page (GH #139): this field sits INSIDE the
                  // transcript, so the old auto/scrollHeight toggle laid out
                  // the whole list on every key.
                  fitTextarea(e.target)
                }}
                onKeyDown={(e) => {
                  // Enter saves, Ctrl or Cmd with Enter resends, Shift with
                  // Enter is a new line. Enter used to resend and drop every
                  // later turn (GH #172). GH #202: in "new line" mode Enter is a
                  // line, Ctrl/Cmd+Enter saves and with Shift resends.
                  const action = editKeyAction({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing }, enterMode)
                  if (action !== 'none') {
                    e.preventDefault()
                    if (action === 'resend' && isUser && onEdit) resendEdit()
                    else saveEdit()
                  }
                  if (e.key === 'Escape') cancelEdit()
                }}
                aria-label={isUser ? 'Edit message text' : 'Edit response text'}
                className="w-full bg-transparent text-[0.78rem] leading-relaxed text-gray-800 dark:text-gray-200 resize-none focus:outline-none"
              />
              <div className="flex items-center gap-1 justify-end t-micro">
                <span className="mr-auto text-gray-500" data-testid="edit-key-hint">{editKeys.hint}</span>
                <button onClick={cancelEdit} className="px-1.5 py-0.5 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors">Cancel</button>
                <button onClick={saveEdit} title={`Change the text only (${editKeys.save})`} className="px-1.5 py-0.5 rounded text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors">Save</button>
                {isUser && onEdit && (
                  <button onClick={resendEdit} title={`Ask again from here and keep the current answers as a version (${editKeys.resend})`} className="px-1.5 py-0.5 rounded border border-gray-300 dark:border-white/15 text-gray-800 dark:text-gray-100 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors">Save &amp; resend</button>
                )}
              </div>
            </div>
          ) : isUser && message.files?.length && message.displayContent === FILE_ONLY_TEXT ? (
            // Nothing was typed: the chips below are the whole message.
            null
          ) : isUser ? (
            // Slash command: show the short "/commit" (displayContent), not the
            // long expanded instruction held in content (which drives the model).
            // The same holds for a message with files: content carries their
            // summaries for the model, the bubble shows what was typed.
            <p className="text-[0.78rem] leading-relaxed text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{message.displayContent || message.content}</p>
          ) : (
            // Answer-blocks (when present) already rendered the per-iteration
            // text chronologically above; skip message.content here to avoid
            // a duplicate dump at the bottom. Falls back to message.content
            // for legacy chats / non-agent messages without answer blocks.
            (() => {
              // Judge "has a real answer block" on the STRIPPED text: a block
              // holding nothing but a LOOP_DONE line must not suppress the
              // fallback, or the turn renders blank.
              if (hasRealAnswerBlocks) return null
              return (
                // `lu-caret` haengt den blinkenden Balken per CSS an den
                // LETZTEN Block dieser Antwort (index.css). Die Klasse ist
                // eine reine Funktion des vorhandenen `isStreaming`-Props —
                // kein Zustand, kein Timer, keine Subscription, also auch
                // kein Rerender, den der Stream nicht ohnehin ausloest.
                <div className={'text-[0.78rem] leading-relaxed' + (isStreaming ? ' lu-caret' : '')}>
                  {/* While it streams, an open ` or ** is closed for the frame
                      (lib/streaming-markdown.ts); the stored text is untouched. */}
                  <MarkdownRenderer content={isStreaming ? closeOpenMarkdown(cleanContent) : cleanContent} />
                  {/* Cut-off marker: a turn the model did not finish on its own
                      terms (length budget / dropped connection). The benchmark
                      screen has always flagged cut-offs; the chat did not, so a
                      truncated answer read as complete (2026-08-08). */}
                  {truncationNotice(message.finishReason) && (
                    // Ruhig, nicht laut: die Antwort ist kuerzer als geplant,
                    // kaputt ist nichts. Die Zeile stand vorher in Gelb und in
                    // derselben Farbe wie die erfundenen Links darunter, die
                    // etwas voellig anderes sagen (`lib/hinweis.ts`).
                    <Hinweis
                      className="mt-1"
                      icon={<Scissors size={9} className="mt-0.5 shrink-0" />}
                    >
                      {truncationNotice(message.finishReason)}
                    </Hinweis>
                  )}
                  {/* Z36 finding 3: the model cited links no tool returned and
                      ignored the corrective steer. The answer stays untouched,
                      it is the model's text (G14-2); this labelled app notice
                      names the links that came from nowhere. */}
                  {unbackedLinksNotice(message.unbackedLinks) && (
                    // Der eine Ton, der hier wirklich Fehler heisst: diese
                    // Links hat kein Werkzeug geliefert, und wer sie anklickt,
                    // landet nirgends. Das ist die Zeile, wegen der jemand
                    // etwas tun muss, also traegt sie Rot statt des alten
                    // Gelbs, das sie sich mit der Abschneide-Marke teilte.
                    <Hinweis
                      ton="fehler"
                      className="mt-1"
                      icon={<Unlink size={9} className="mt-0.5 shrink-0" />}
                    >
                      {unbackedLinksNotice(message.unbackedLinks)}
                    </Hinweis>
                  )}
                  {/* A reasoning-only reply used to print a stand-in sentence
                      here ("The model only produced internal reasoning and no
                      answer"). That is our text in the model's mouth (G14-3,
                      2026-08-07), and on an agent surface the loop's job
                      is to CONTINUE past such a round (G17), not to explain
                      it. The thinking block above already shows what happened.
                      The hint below survives because it is a labelled app hint
                      with an action, not prose posing as an answer. It is a
                      quiet line now, no longer a filled card with a framed
                      button: nothing is broken here, a switch is simply off,
                      and one line says so (see `lib/hinweis.ts`). */}
                  {thoughtOnly && thoughtOnlyToolIntent && activeModel && isAgentCompatible(activeModel) && (
                    <Hinweis
                      className="mt-1"
                      icon={<Wrench size={11} className="mt-0.5 shrink-0" />}
                    >
                      The model spent its whole reply deciding to call a tool, but Agent Mode is off, so nothing ran. Its reasoning is in the thinking block above.{' '}
                      <button
                        onClick={() => activeConversationId && toggleAgentMode(activeConversationId)}
                        className="font-medium underline underline-offset-2 hover:no-underline"
                      >
                        Enable Agent
                      </button>
                    </Hinweis>
                  )}
                  {suggestAgent && (
                    <Hinweis
                      className="mt-2"
                      icon={<Wrench size={11} className="mt-0.5 shrink-0" />}
                    >
                      This model tried to call a tool, but Agent Mode is off for this chat, so nothing ran and it will keep emitting JSON that nothing reads.{' '}
                      <button
                        onClick={() => activeConversationId && toggleAgentMode(activeConversationId)}
                        className="font-medium underline underline-offset-2 hover:no-underline"
                      >
                        Enable Agent
                      </button>
                    </Hinweis>
                  )}
                </div>
              )
            })()
          )}

        </div>

        {/* Chat-tools artifacts (2026-06-12): files the model "wrote" in
            plain chat, rendered inline with preview + Download, never on disk. */}
        {!isUser && message.artifacts && message.artifacts.length > 0 && (
          <div className="space-y-1">
            {message.artifacts.map((a) => (
              <ChatArtifactCard key={a.id} artifact={a} />
            ))}
          </div>
        )}

        {/* The model declined: said under the answer, never at the prompt
            field, and before the action bar so it reads as part of the turn. */}
        {declined && <RefusalNotice />}

        {/* Action bar UNDER the message (2026-06-06: "eigene Leiste unter
            der Nachricht" instead of cramped hover-icons in the corner). Bigger
            targets; assistant left, user right. */}
        {/* Hidden while this very turn still streams: the bar used to hang on
            !isEditing alone, so Copy/Regenerate/Delete rendered under a
            half-written answer from the first token on. Gated on the live
            generating flag rather than on `usage`, because a backend that
            never reports usage would otherwise lose the bar for good. */}
        {/* Und seit D-S07 nur noch beim Hovern/Fokus sichtbar — die Begruendung
            samt der beiden bewussten Ausnahmen steht bei `actionBarVisibility`. */}
        {/* GH #172, #174: the kept versions of this point of the chat. Always
            visible, not hover gated like the bar below: it says that there IS
            another version, which nobody would find under a hover. */}
        {forkKey !== undefined && forkIndex !== undefined && forkTotal !== undefined && !isEditing && (
          <ForkSwitcher
            forkKey={forkKey}
            index={forkIndex}
            total={forkTotal}
            onSwitch={onSwitchFork}
            align={isUser ? 'end' : 'start'}
          />
        )}

        {actionsAvailable && (
          <div className={
            'flex items-center gap-0.5 ' + actionBarVisibility + ' ' +
            (isUser ? 'justify-end pr-0.5' : 'justify-start pl-0.5')
          }>
            {isUser && actions.edit && (
              <button onClick={actions.edit} className="p-1 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors" aria-label="Edit message" title="Edit"><Pencil size={12} /></button>
            )}
            {!isUser && actions.edit && (
              <button onClick={actions.edit} className="p-1 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors" aria-label="Edit response" title="Edit"><Pencil size={12} /></button>
            )}
            {actions.regenerate && (
              <button onClick={actions.regenerate} className="p-1 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors" aria-label="Regenerate response" title={onRegenerateRound ? 'Regenerate this answer' : 'Regenerate'}><RefreshCw size={12} /></button>
            )}
            {!isUser && onRegenerateRound && (
              <button onClick={() => onRegenerateRound(message.id)} data-testid="regenerate-round" className="p-1 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors" aria-label="Regenerate whole round" title="Regenerate whole round: every speaker answers this message again"><ListRestart size={12} /></button>
            )}
            <button onClick={actions.copy} className="p-1 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors" aria-label="Copy message" title={copied ? 'Copied' : 'Copy'}>
              {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
            </button>
            {!isUser && <SpeakerButton text={shown.spoken} />}
            {actions.branch && (
              <button onClick={actions.branch} className="p-1 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors" aria-label="Branch from here" title="Branch from here: a new chat up to this message"><GitBranch size={12} /></button>
            )}
            <button onClick={actions.remove} className={'p-1 rounded-md transition-colors hover:bg-gray-100 dark:hover:bg-white/10 ' + (confirmDelete ? 'text-red-500' : 'text-gray-400 dark:text-gray-500 hover:text-red-500')} aria-label="Delete message" title={confirmDelete ? 'Click again to delete' : 'Delete message'}>
              <Trash2 size={12} />
            </button>
            {!isUser && <RequestUsageLine usage={message.requestUsage} className="pl-1.5" />}
          </div>
        )}

        {/* Rechtsklick auf die Nachricht — dieselben Aktionen, derselbe Code. */}
        {menu && (
          <ContextMenu
            items={buildMessageMenu(actions, { copied, confirmDelete })}
            x={menu.x}
            y={menu.y}
            label={isUser ? 'Message actions' : 'Response actions'}
            onClose={() => setMenu(null)}
          />
        )}

        {/* RAG sources */}
        {!isUser && message.sources && message.sources.length > 0 && (
          <div className="pt-1 border-t border-white/[0.04]">
            <p className="text-[0.5rem] text-gray-500 mb-0.5">Sources:</p>
            {message.sources.map((s, i) => (
              <p key={i} className="text-[0.5rem] text-gray-600 truncate">
                [{i + 1}] {s.documentName}, {s.preview.slice(0, 60)}...
              </p>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  )
}

/**
 * Memoised (2.6.3). The streaming flush replaces ONE message object per frame,
 * but the whole list re-rendered with it — every markdown body, every
 * highlighted code block, in a chat that can hold hundreds of messages. Only
 * the bubble whose `message` reference actually changed re-renders now.
 * Requires MessageList to pass stable handlers; see the note on Props.
 */
export const MessageBubble = memo(MessageBubbleImpl)
