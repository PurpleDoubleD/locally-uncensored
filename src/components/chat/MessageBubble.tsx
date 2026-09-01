import { motion } from 'framer-motion'
import { User, Copy, Check, Pencil, RefreshCw, X, Wrench, Trash2, Scissors, Unlink } from 'lucide-react'
import { useState, useRef, useEffect, useMemo, memo } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBand } from './ToolCallBand'
import { ReflectionBlock } from './ReflectionBlock'
import { groupAgentBlocks } from '../../lib/tool-call-groups'
import { VramSwitchCard } from './VramSwitchCard'
import { SpeakerButton } from './SpeakerButton'
import { ChatArtifactCard } from './ChatArtifactCard'
import type { Message } from '../../types/chat'
import { stripModelNoise } from '../../lib/strip-model-noise'
import { truncationNotice } from '../../lib/answer-notes'
import { unbackedLinksNotice } from '../../lib/unbacked-links'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { extractToolCallsFromContent, looksLikeToolIntent } from '../../lib/tool-call-repair'
import { isAgentCompatible } from '../../lib/model-compatibility'
import { ContextMenu } from '../ui/ContextMenu'
import { buildMessageMenu, type MessageMenuHandlers } from '../ui/menu-actions'

interface Props {
  message: Message
  /** Takes the message id rather than closing over it, so MessageList can pass
   *  ONE stable function to every bubble — a per-message closure would be a new
   *  prop on every render and defeat the memo() below. */
  onRegenerate?: (messageId: string) => void
  onEdit?: (messageId: string, newContent: string) => void
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
}

function MessageBubbleImpl({ message, onRegenerate, onEdit, pendingApprovalId, onApprove, onReject, isLast, isStreaming }: Props) {
  const [copied, setCopied] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const isUser = message.role === 'user'

  // Bug #7 (phantomderp v2.4.3): the Codex-style "model parrots tool-call
  // JSON as plaintext" only happens when the active chat does NOT have
  // agent mode on. Detect the JSON pattern and show a one-click "Enable
  // agent" banner instead of leaving the user staring at a JSON dump.
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const deleteMessage = useChatStore((s) => s.deleteMessage)
  const updateMessageContent = useChatStore((s) => s.updateMessageContent)
  const isAgentActive = useAgentModeStore((s) =>
    activeConversationId ? s.agentModeActive[activeConversationId] ?? false : false
  )
  const activeModel = useModelStore((s) => s.activeModel)
  const toggleAgentMode = useAgentModeStore((s) => s.toggleAgentMode)
  const userAvatarDataUrl = useSettingsStore((s) => s.settings.userAvatarDataUrl)
  // Chat Tools (v2.5.3) gives plain chat web/file/image/video WITHOUT Agent Mode.
  // When it's on, the "turn Agent Mode on" banners below are wrong + contradictory
  // (the tool IS available in normal chat) — they predate Chat Tools and only
  // checked `!isAgentActive`. Suppress them when Chat Tools is enabled. David
  // 2026-06-16: web build, Agent off + Chat Tools on, image_generate emitted →
  // bubble showed "Turn Agent Mode on" even though the tool was already running.
  const chatToolsEnabled = useSettingsStore((s) => s.settings.chatToolsEnabled !== false)

  const suggestAgent = useMemo(() => {
    if (isUser || isAgentActive || chatToolsEnabled || !activeConversationId || !activeModel) return false
    if (!message.content || message.content.length < 10) return false
    // The repair helper extracts {name, arguments}-shaped JSON blocks, plus
    // <tool_call>...</tool_call> Hermes tags. If anything came out, the
    // model wanted to call a tool — even though we never registered any.
    const calls = extractToolCallsFromContent(message.content)
    if (!calls || calls.length === 0) return false
    // Only nudge when the model is on the agent-allow-list. Showing this
    // banner on a non-agent-capable model would be a dead-end.
    return isAgentCompatible(activeModel)
  }, [isUser, isAgentActive, chatToolsEnabled, activeConversationId, activeModel, message.content])

  // Thought-only completion (live find 2026-06-11): the model reasoned —
  // usually about calling a tool it doesn't have in a non-agent chat — and
  // stopped without ONE visible token. useChat persisted the reasoning onto
  // message.thinking; without this the bubble is silent dead air forever.
  // The last bubble additionally needs usage (set by the done chunk) so the
  // banner can't flash mid-stream while a visible thinking phase runs.
  const thoughtOnly = !isUser && !(message.content || '').trim() && !!(message.thinking || '').trim()
    && (!isLast || !!message.usage)

  // Orchestration strip for everything this bubble renders (2.5.9). Memoised:
  // the regex set is not cheap and a long agent chat re-renders these bubbles
  // often. Aggressive tier only while a tool loop drives the turn — in plain
  // chat a {"name": …, "arguments": …} block is often the answer itself.
  // Signature, not the array itself: a streaming turn may grow a block's
  // content in place, leaving the array reference identical. Keying on the
  // total length re-runs the strip on every token while still skipping the
  // work on unrelated re-renders.
  const blockSig = (message.agentBlocks ?? []).reduce((n, b) => n + b.content.length, 0)
    + ':' + (message.agentBlocks?.length ?? 0)
  const cleanBlocks = useMemo(() => {
    const map = new Map<string, string>()
    for (const b of message.agentBlocks ?? []) {
      if (b.phase === 'answer') map.set(b.id, stripModelNoise(b.content, { aggressive: true }))
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockSig])
  // Aggressive while a tool loop drives the turn, same as Code. In plain chat
  // the gentle tier only, because a {"name": …, "arguments": …} block there can
  // be exactly the answer the user asked the model to print.
  const toolLoopDriven = isAgentActive || !!message.agentBlocks?.length
  const cleanContent = useMemo(
    () => (isUser ? '' : stripModelNoise(message.content || '', { aggressive: toolLoopDriven })),
    [isUser, message.content, toolLoopDriven],
  )
  const thoughtOnlyToolIntent = useMemo(
    () => thoughtOnly && !isAgentActive && !chatToolsEnabled && looksLikeToolIntent(message.thinking || ''),
    [thoughtOnly, isAgentActive, chatToolsEnabled, message.thinking],
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
      editRef.current.style.height = 'auto'
      editRef.current.style.height = editRef.current.scrollHeight + 'px'
    }
  }, [isEditing])

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const startEdit = () => {
    // User: edit the short slash command, not its expanded instruction.
    // Assistant: edit what the model actually said.
    setEditContent(isUser ? (message.displayContent || message.content) : message.content)
    setIsEditing(true)
  }

  const confirmEdit = () => {
    const next = editContent.trim()
    if (next && next !== message.content) {
      if (isUser) {
        // Editing your own message re-asks the question (resend path).
        onEdit?.(message.id, next)
      } else if (activeConversationId) {
        // Editing the model's answer rewrites history in place (D#81):
        // no resend, and every later turn reads the edited text as context.
        updateMessageContent(activeConversationId, message.id, next)
      }
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
    remove: handleDelete,
  }
  // Die Leiste haengt an `!isEditing && !isStreaming` — das Menue bietet
  // dieselben Aktionen an, also gilt fuer es dieselbe Bedingung.
  const actionsAvailable = !isEditing && !isStreaming

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
      transition={{ duration: 0.15 }}
    >
      {/* Avatar */}
      <div
        className={
          'w-6 h-6 rounded-md overflow-hidden flex items-center justify-center shrink-0 ' +
          // User avatar keeps a framed chip; the AI monogram stands alone (no box).
          (isUser ? 'bg-gray-100 dark:bg-white/8 border border-gray-200 dark:border-white/10' : '')
        }
      >
        {isUser ? (
          userAvatarDataUrl
            ? <img src={userAvatarDataUrl} alt="" className="w-full h-full object-cover" />
            : <User size={11} className="text-gray-400" />
        ) : (
          // AI avatar = the LU monogram ALONE, filling the slot — no box/border/bg.
          <img src="/LU-monogram-bw.png" alt="" className="w-full h-full object-contain dark:invert-0 invert opacity-80" />
        )}
      </div>

      <div className="max-w-[80%] space-y-0.5">
        {/* Name the model that produced this answer. Group chats have always
            done this; since the R5 re-measure (2026-08-30) every assistant
            turn carries it, because the app had no model name at a single
            answer anywhere and therefore no way to be honest about an older
            chat. Turns from before that carry none and get no line, rather
            than a guess. */}
        {!isUser && message.modelId && (
          <div className="text-[0.55rem] font-mono text-gray-400 dark:text-gray-500 pl-1">{message.modelId}</div>
        )}
        {/* Thinking block — auto-expands while this (last) turn is still
            producing so the reasoning streams LIVE, then collapses (David 2026-06-04). */}
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
                    // the calls. The transient "Analyzing..." placeholder is a
                    // thinking block too and shows as a live bubble until the
                    // round's first token replaces it.
                    (b.phase === 'thinking' && b.content.trim()),
                )
                .sort((a, b) => a.timestamp - b.timestamp),
            )
              .map((group, gruppenIndex, gruppen) => {
                // Consecutive tool calls render as ONE band that morphs from
                // tool to tool and collapses to "N steps" when done (David
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
                        <MarkdownRenderer content={clean} />
                      </div>
                    </div>
                  )
                }
                return null
              })}
          </>
        )}

        {/* Feature EE (v2.5.0) — VRAM hand-off status card. Self-hides unless
            an actual model swap is in flight; gated to the last assistant
            message so a swap shows only in the active turn. */}
        {!isUser && isLast && <VramSwitchCard />}

        {/* Image attachments */}
        {message.images && message.images.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {message.images.map((img, i) => (
              <a
                key={i}
                href={`data:${img.mimeType};base64,${img.data}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={img.name}
                  className="max-w-[180px] max-h-[120px] object-cover rounded-md border border-white/10 hover:border-white/25 transition-colors cursor-pointer"
                />
              </a>
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
              ? 'rounded-lg px-2.5 py-1.5 bg-gray-100 dark:bg-white/[0.06] border border-gray-200 dark:border-white/[0.08]'
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
                  e.target.style.height = 'auto'
                  e.target.style.height = e.target.scrollHeight + 'px'
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmEdit() }
                  if (e.key === 'Escape') cancelEdit()
                }}
                className="w-full bg-transparent text-[0.78rem] leading-relaxed text-gray-800 dark:text-gray-200 resize-none focus:outline-none"
              />
              <div className="flex items-center gap-1 justify-end">
                <button onClick={confirmEdit} className="p-0.5 rounded hover:bg-green-500/20 text-green-500 transition-colors"><Check size={11} /></button>
                <button onClick={cancelEdit} className="p-0.5 rounded hover:bg-red-500/20 text-red-400 transition-colors"><X size={11} /></button>
              </div>
            </div>
          ) : isUser ? (
            // Slash command: show the short "/commit" (displayContent), not the
            // long expanded instruction held in content (which drives the model).
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
                  <MarkdownRenderer content={cleanContent} />
                  {/* Cut-off marker: a turn the model did not finish on its own
                      terms (length budget / dropped connection). The benchmark
                      screen has always flagged cut-offs; the chat did not, so a
                      truncated answer read as complete (David 2026-08-08). */}
                  {truncationNotice(message.finishReason) && (
                    <div className="mt-1 inline-flex items-center gap-1 text-[0.6rem] text-amber-600/80 dark:text-amber-300/70">
                      <Scissors size={9} className="shrink-0" />
                      <span>{truncationNotice(message.finishReason)}</span>
                    </div>
                  )}
                  {/* Z36 finding 3: the model cited links no tool returned and
                      ignored the corrective steer. The answer stays untouched,
                      it is the model's text (G14-2); this labelled app notice
                      names the links that came from nowhere. */}
                  {unbackedLinksNotice(message.unbackedLinks) && (
                    <div className="mt-1 flex items-start gap-1 text-[0.6rem] text-amber-600/80 dark:text-amber-300/70">
                      <Unlink size={9} className="mt-0.5 shrink-0" />
                      <span>{unbackedLinksNotice(message.unbackedLinks)}</span>
                    </div>
                  )}
                  {/* A reasoning-only reply used to print a stand-in sentence
                      here ("The model only produced internal reasoning and no
                      answer"). That is our text in the model's mouth (G14-3,
                      David 2026-08-07), and on an agent surface the loop's job
                      is to CONTINUE past such a round (G17), not to explain
                      it. The thinking block above already shows what happened.
                      The amber card below survives because it is a labelled
                      app hint with an action, not prose posing as an answer. */}
                  {thoughtOnly && thoughtOnlyToolIntent && activeModel && isAgentCompatible(activeModel) && (
                    <div className="mt-1 flex items-start gap-2 px-2 py-1.5 rounded-md border border-amber-400/30 bg-amber-500/10 text-[0.65rem] text-amber-700 dark:text-amber-200">
                      <Wrench size={11} className="mt-0.5 shrink-0" />
                      <div className="flex-1">
                        <p className="font-medium">The model spent its whole reply deciding to call a tool, but Agent Mode is off, so it never said anything.</p>
                        <p className="opacity-80 mt-0.5">Turn Agent Mode on and ask again to let it actually run the tool (search the web, generate media, read files). Its reasoning is in the thinking block above.</p>
                      </div>
                      <button
                        onClick={() => activeConversationId && toggleAgentMode(activeConversationId)}
                        className="shrink-0 px-2 py-0.5 rounded border border-amber-400/40 hover:bg-amber-500/20 transition-colors font-medium"
                      >
                        Enable Agent
                      </button>
                    </div>
                  )}
                  {suggestAgent && (
                    <div className="mt-2 flex items-start gap-2 px-2 py-1.5 rounded-md border border-amber-400/30 bg-amber-500/10 text-[0.65rem] text-amber-700 dark:text-amber-200">
                      <Wrench size={11} className="mt-0.5 shrink-0" />
                      <div className="flex-1">
                        <p className="font-medium">This model tried to call a tool, but Agent Mode is off for this chat.</p>
                        <p className="opacity-80 mt-0.5">Turn it on to let the model actually execute tools (read files, run commands, browse). Until then it'll keep emitting JSON that nothing reads.</p>
                      </div>
                      <button
                        onClick={() => activeConversationId && toggleAgentMode(activeConversationId)}
                        className="shrink-0 px-2 py-0.5 rounded border border-amber-400/40 hover:bg-amber-500/20 transition-colors font-medium"
                      >
                        Enable Agent
                      </button>
                    </div>
                  )}
                </div>
              )
            })()
          )}

        </div>

        {/* Chat-tools artifacts (David 2026-06-12): files the model "wrote" in
            plain chat, rendered inline with preview + Download, never on disk. */}
        {!isUser && message.artifacts && message.artifacts.length > 0 && (
          <div className="space-y-1">
            {message.artifacts.map((a) => (
              <ChatArtifactCard key={a.id} artifact={a} />
            ))}
          </div>
        )}

        {/* Action bar UNDER the message (David 2026-06-06: "eigene Leiste unter
            der Nachricht" instead of cramped hover-icons in the corner). Bigger
            targets, always visible but subtle; assistant left, user right. */}
        {/* Hidden while this very turn still streams: the bar used to hang on
            !isEditing alone, so Copy/Regenerate/Delete rendered under a
            half-written answer from the first token on. Gated on the live
            generating flag rather than on `usage`, because a backend that
            never reports usage would otherwise lose the bar for good. */}
        {actionsAvailable && (
          <div className={'flex items-center gap-0.5 ' + (isUser ? 'justify-end pr-0.5' : 'justify-start pl-0.5')}>
            {isUser && actions.edit && (
              <button onClick={actions.edit} className="p-1 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors" aria-label="Edit message" title="Edit"><Pencil size={12} /></button>
            )}
            {!isUser && actions.edit && (
              <button onClick={actions.edit} className="p-1 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors" aria-label="Edit response" title="Edit"><Pencil size={12} /></button>
            )}
            {actions.regenerate && (
              <button onClick={actions.regenerate} className="p-1 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors" aria-label="Regenerate response" title="Regenerate"><RefreshCw size={12} /></button>
            )}
            <button onClick={actions.copy} className="p-1 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors" aria-label="Copy message" title={copied ? 'Copied' : 'Copy'}>
              {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
            </button>
            {!isUser && <SpeakerButton text={message.content} />}
            <button onClick={actions.remove} className={'p-1 rounded-md transition-colors hover:bg-gray-100 dark:hover:bg-white/10 ' + (confirmDelete ? 'text-red-500' : 'text-gray-400 dark:text-gray-500 hover:text-red-500')} aria-label="Delete message" title={confirmDelete ? 'Click again to delete' : 'Delete message'}>
              <Trash2 size={12} />
            </button>
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
