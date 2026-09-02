import { useCodex } from '../../hooks/useCodex'
import { useAutoScroll } from '../../hooks/useAutoScroll'
import { useCodexStore } from '../../stores/codexStore'
import { useChatStore } from '../../stores/chatStore'
import { useGenerationStore } from '../../stores/generationStore'
import { ChatInput } from './ChatInput'
import { ToolCallBlock } from './ToolCallBlock'
import { ToolCallBand } from './ToolCallBand'
import { groupAgentBlocks } from '../../lib/tool-call-groups'
import { ThinkingBlock } from './ThinkingBlock'
import { MarkdownRenderer } from './MarkdownRenderer'
import { TokenCounter } from './TokenCounter'
import { ContextDropdown } from './ContextDropdown'
import { SmallModelModeToggle } from './SmallModelModeToggle'
import { WorkingAnchor } from './WorkingAnchor'
import { useCodexConfirmStore } from '../../stores/codexConfirmStore'
import { PluginsDropdown } from './PluginsDropdown'
import { CodexModeDropdown } from './CodexModeDropdown'
import { ModelSelector } from '../models/ModelSelector'
import { GoalBar } from './GoalBar'
import { LoopBar } from './LoopBar'
import { useSettingsStore } from '../../stores/settingsStore'
import { useModelStore } from '../../stores/modelStore'
import { useAgentLoopStore } from '../../stores/agentLoopStore'
import { useAgentModeStore } from '../../stores/agentModeStore'
import {
  CODEX_WORKDIR_LOCK_TITLE,
  codexBusyReason,
  codexFallbackLabel,
} from '../../lib/codex-workdir'
import { resolveWorkspacePath } from '../../api/agents/workspace-resolve'
import { StagedChangesPanel } from './StagedChangesPanel'
import { SlashStepsBlock } from './SlashStepsBlock'
import { User, Code, Eye, GitBranch, Download, RefreshCw, RotateCcw, Folder, FolderX, Check, AlertTriangle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { checkGitInstalled, openExternal, type GitStatus } from '../../api/backend'
import { CodexConfirmDialog } from './CodexConfirmDialog'
import { stripModelNoise } from '../../lib/strip-model-noise'

// Code always drives a tool loop, so the aggressive tier applies here.
const stripChannelTags = (text: string) => stripModelNoise(text, { aggressive: true })

// Code-Mode renders EVERY between-tool answer as normal, always-visible prose
// now (David 2026-06-04: "kein Collapse, das soll ganz normal wie eine Antwort
// angezeigt werden"). The render path below dedupes verbatim repeats so a
// chatty small model can't stack the same line. (The old CollapsibleAnswer
// one-line-preview component was removed.)

export function CodexView() {
  const { sendInstruction, stopCodex, isRunning } = useCodex()
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)
  const thread = useCodexStore((s) => activeConversationId ? s.threads[activeConversationId] : undefined)

  const conversation = conversations.find(c => c.id === activeConversationId)
  const messages = conversation?.messages || []

  // Per-conversation generating flag (David 2026-06-12): the typing indicator
  // + realtime counter + a message's live-stream state must follow the coding
  // chat that's ACTUALLY running — not every chat the user switches to. The
  // hook's `isRunning` is global (kept for the input, which guards shared stream
  // refs); the visual bits below read this conversation-scoped flag instead.
  const generatingMap = useGenerationStore((s) => s.generating)
  const codexGenerating = !!activeConversationId && !!generatingMap[activeConversationId]
  const pendingConfirm = useCodexConfirmStore((s) => s.pending)

  // G8-3 (David): "sobald er fertig gedacht hat, hakt das so komisch ab und
  // zoomt irgendwo ganz anders hin." The hand-rolled pin here only fired on
  // [messages, events] changes, so the height SWAP when a thinking round ends
  // (live bubble cleared above, ThinkingBlock added below, preview collapses)
  // landed between triggers and left the view parked mid-transcript. Same
  // mechanism as G33 on the chat list, same cure: the shared useAutoScroll
  // hook re-pins through a ResizeObserver on EVERY content-height change,
  // growth and collapse alike, while the user is following. Scrolling up to
  // read stays possible (same <100px disengage), and sending an instruction
  // re-engages via the last user message id.
  const lastMessage = messages[messages.length - 1]
  const lastUserMessage = messages.filter((m) => m.role === 'user').at(-1)
  const { ref: scrollRef, contentRef } = useAutoScroll(
    `${lastMessage?.content ?? ''}|${thread?.events?.length ?? 0}`,
    lastUserMessage?.id,
  )

  const codexReviewMode = useSettingsStore((s) => s.settings.codexReviewMode)
  const userAvatarDataUrl = useSettingsStore((s) => s.settings.userAvatarDataUrl)
  const activeModel = useModelStore((s) => s.activeModel)
  const createConversation = useChatStore((s) => s.createConversation)
  const codexWorkingDir = useCodexStore((s) => s.workingDirectory)
  const clearWorkingDirectory = useCodexStore((s) => s.clearWorkingDirectory)
  // A8 (2.6.8): the same Remove sits in the explorer column, but that column
  // can be collapsed, and two users looked for a way out of their folder and
  // found none. The header always shows the folder, so it also carries the way
  // to give it back. Locked, not hidden, while a coding turn is in flight, and
  // the verdict is the shared one so the two buttons cannot drift apart.
  const sendsInFlight = useCodexStore((s) => s.sendsInFlight)
  const threads = useCodexStore((s) => s.threads)
  const loop = useAgentLoopStore((s) => s.loop)
  const lockReason = codexBusyReason({ sendsInFlight, threads, loop })

  // Where the agent goes while no folder is picked: a per-chat workspace or
  // settings.defaultWorkspace both beat an empty picker, so the header and the
  // empty state have to name the winner instead of always saying sandbox
  // (review S4).
  const perChatWorkspace = useAgentModeStore((s) =>
    activeConversationId ? s.workspaces[activeConversationId] : undefined,
  )
  const defaultWorkspace = useSettingsStore((s) => s.settings.defaultWorkspace)
  const fallbackLabel = codexFallbackLabel(
    resolveWorkspacePath({ perChat: perChatWorkspace, defaultWorkspace }),
  )

  // Git availability for the Codex view (v2.5.0). Codex shells out to git for
  // git_status/diff/commit/log; if git is missing those tools fail. Probe on
  // open and surface a minimal install banner when it's not on PATH.
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [gitChecking, setGitChecking] = useState(false)
  useEffect(() => {
    let cancelled = false
    setGitChecking(true)
    checkGitInstalled()
      .then((s) => { if (!cancelled) setGitStatus(s) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setGitChecking(false) })
    return () => { cancelled = true }
  }, [])
  const recheckGit = () => {
    setGitChecking(true)
    checkGitInstalled().then(setGitStatus).catch(() => {}).finally(() => setGitChecking(false))
  }

  // New coding session (David 2026-06-04: "start neu" must really start new).
  // Abort any in-flight loop, then create a fresh codex conversation. The
  // working directory persists in codexStore, so the new session keeps the
  // folder; a brand-new conversation means a brand-new thread on next send.
  const startNewSession = () => {
    stopCodex()
    if (activeModel) createConversation(activeModel, '', 'codex')
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Main panel */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Codex header */}
        <div
          data-testid="codex-header"
          className="flex items-center gap-1.5 px-2 py-0.5 border-b border-gray-200 dark:border-white/[0.04]"
        >
          <Code size={9} className="text-gray-500" />
          <span className="text-[0.55rem] text-gray-600 dark:text-gray-400 font-medium">Coding Agent</span>
          {/* Code-Review Mode badge (B13) — makes it impossible to miss
              that the agent is read-only. The toggle itself lives in
              Settings → Codex Agent; clicking the badge jumps you there
              isn't worth a routing change in v2.5.0. */}
          {codexReviewMode && (
            <span
              className="flex items-center gap-1 px-1.5 py-0 rounded border border-amber-500/30 text-amber-500 text-[0.55rem] bg-amber-500/[0.04]"
              title="Code-Review Mode is active. The coding agent will inspect the codebase but won't write files or run commands. Disable in Settings → Coding Agent."
            >
              <Eye size={9} />
              <span>Review</span>
            </span>
          )}
          {/* Working directory indicator — so the user always sees WHERE the
              agent operates (David 2026-06-04: "ich hab den Ordner angegeben …
              er ist eigentlich in Dokumenten"). Empty = per-chat sandbox under
              ~/agent-workspace, which is also where shell output now lands. */}
          <span
            className="flex items-center gap-1 text-[0.5rem] text-gray-500 dark:text-gray-500 font-mono truncate max-w-[200px]"
            title={codexWorkingDir || `No folder picked, the agent works in ${fallbackLabel}`}
          >
            <Folder size={9} className="shrink-0 opacity-70" />
            <span className="truncate">{codexWorkingDir || fallbackLabel}</span>
          </span>
          {codexWorkingDir && (
            <button
              onClick={() => { if (!lockReason) clearWorkingDirectory() }}
              disabled={!!lockReason}
              data-testid="codex-remove-folder"
              aria-label="Remove the working directory"
              title={
                lockReason
                  ? CODEX_WORKDIR_LOCK_TITLE[lockReason]
                  : `Remove this folder. The agent falls back to ${fallbackLabel} until you pick a new one.`
              }
              className="p-1 rounded text-gray-400 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-30 disabled:hover:text-gray-400 transition-colors shrink-0"
            >
              <FolderX size={11} />
            </button>
          )}
          <div className="flex-1" />
          {/* New coding session — aborts any running loop and starts a fresh
              chat/thread (keeps the working directory). David 2026-06-04:
              "start neu" must actually start new. */}
          <button
            onClick={startNewSession}
            title="New coding session (clears the current run, keeps the folder)"
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.55rem] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
          >
            <RotateCcw size={10} />
            <span>New</span>
          </button>
          {/* Plugins (Chat Tools · Caveman · Persona · Group) lives HERE, next
              to New, as a bare icon with the name in the tooltip. It used to
              sit in the composer action bar and was one of the four things
              crowding the prompt row (David, 2026-08-22: "das promptfenster ist
              ueberfuellt"). The dropdown itself is untouched, only the place
              and the trigger changed. */}
          <PluginsDropdown iconOnly />
          <TokenCounter />
          <ContextDropdown />
          <SmallModelModeToggle />
        </div>

        {/* Git-missing banner (v2.5.0). Codex shells out to git for
            status/diff/commit/log — without it those tools fail. Minimal,
            dismiss-by-installing: an Install button (opens the platform git
            download page) + a Recheck button for after the install. */}
        {gitStatus && !gitStatus.installed && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-amber-500/20 bg-amber-500/[0.06]">
            <GitBranch size={12} className="text-amber-500 shrink-0" />
            <span className="text-[0.6rem] text-amber-600 dark:text-amber-400/90 flex-1 leading-tight">
              Git isn't installed. The coding agent needs it for diffs, commits and history.
            </span>
            <button
              onClick={() => openExternal(gitStatus.download_url)}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[0.6rem] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-300 hover:bg-amber-500/25 border border-amber-500/30 transition-colors"
            >
              <Download size={11} /> Install Git
            </button>
            <button
              onClick={recheckGit}
              disabled={gitChecking}
              title="Re-check after installing Git"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.6rem] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={11} className={gitChecking ? 'animate-spin' : ''} />
            </button>
          </div>
        )}

        {/* Stage-and-Approve queue (B10). Renders nothing when there
            are no pending changes for the active chat, so non-stage-mode
            users never see it. */}
        <StagedChangesPanel chatId={activeConversationId} />

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Code size={24} className="text-gray-300 dark:text-gray-700 mb-2" />
              <p className="text-[0.7rem] text-gray-500 font-medium">Coding Agent</p>
              <p className="text-[0.55rem] text-gray-400 dark:text-gray-600 mt-0.5 max-w-[300px]">
                Send a coding instruction. The coding agent will read your codebase, write code, and run commands.
              </p>
              {!codexWorkingDir && (
                <p className="text-[0.55rem] text-amber-500/70 mt-2" data-testid="codex-no-folder-hint">
                  No folder picked. The agent works in {fallbackLabel}. Pick a project with
                  "Select folder..." in the file tree panel on the right.
                </p>
              )}
            </div>
          ) : (
            <div ref={contentRef} className="py-1">
              {messages.filter(msg => !msg.hidden).map((msg) => {
                // App notices (a staged change that landed on disk) are not
                // model turns. They used to be written hidden, so the one line
                // that says "the file on disk is not the diff you approved"
                // reached nobody, and an assistant bubble would be the other
                // wrong answer: it would claim the model said it.
                if (msg.role === 'system' && msg.notice) {
                  const warn = msg.notice === 'warn'
                  return (
                    <div key={msg.id} className="px-3 py-1" data-testid="codex-notice">
                      <div className={`flex items-start gap-1.5 px-2 py-1 rounded border text-[0.6rem] leading-snug ${
                        warn
                          ? 'border-amber-300/70 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-amber-900 dark:text-amber-200'
                          : 'border-gray-200 dark:border-white/10 bg-gray-50/60 dark:bg-white/[0.02] text-gray-500 dark:text-gray-400'
                      }`}>
                        {warn
                          ? <AlertTriangle size={10} className="mt-0.5 shrink-0" />
                          : <Check size={10} className="mt-0.5 shrink-0" />}
                        <span className="break-words">{msg.content}</span>
                      </div>
                    </div>
                  )
                }
                // Slash commands: the user typed "/review", but msg.content holds
                // the expanded instruction the model ran on, show displayContent.
                const rawForDisplay = msg.role === 'user' ? (msg.displayContent || msg.content) : msg.content
                const cleanContent = rawForDisplay ? stripChannelTags(rawForDisplay) : ''
                return (
                  <div
                    key={msg.id}
                    className={`flex gap-2 px-3 py-1 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
                  >
                    <div className={`w-5 h-5 rounded overflow-hidden flex items-center justify-center shrink-0 ${
                      msg.role === 'user'
                        ? 'bg-gray-100 dark:bg-white/8'
                        : ''
                    }`}>
                      {msg.role === 'user'
                        ? (userAvatarDataUrl
                            ? <img src={userAvatarDataUrl} alt="" className="w-full h-full object-cover" />
                            : <User size={9} className="text-gray-400" />)
                        : <img src="/LU-monogram-bw.png" alt="" className="w-full h-full object-contain dark:invert-0 invert opacity-80" />
                      }
                    </div>
                    <div className="max-w-[85%] space-y-0.5">
                      {/* Thinking */}
                      {msg.role === 'assistant' && msg.thinking && (
                        <ThinkingBlock
                          thinking={msg.thinking}
                          streaming={codexGenerating && msg.id === messages[messages.length - 1]?.id && !cleanContent.trim()}
                        />
                      )}
                      {(() => {
                        const running = codexGenerating && msg.id === messages[messages.length - 1]?.id
                        const hasBlocks = !!(msg.role === 'assistant' && msg.agentBlocks && msg.agentBlocks.length > 0)
                        const stepCount = msg.agentBlocks?.filter((b) => b.phase === 'tool_call' && b.toolCall).length ?? 0
                        const hasAnswerBlock = !!(msg.agentBlocks && msg.agentBlocks.some((b) => b.phase === 'answer' && b.content.trim()))

                        // Reflection blocks (Architect plan, RepoMap context) ,
                        // shown above the tool calls so the user sees what context
                        // primed the editor model before it started fetching tools.
                        const reflection = hasBlocks ? (
                          <div className="space-y-1">
                            {msg.agentBlocks!
                              .filter((b) => b.phase === 'reflection' && b.content)
                              .map((block) => (
                                <div
                                  key={block.id}
                                  className="px-2 py-1.5 rounded border border-gray-200 dark:border-white/10 bg-gray-50/60 dark:bg-white/[0.02] text-[0.7rem] text-gray-700 dark:text-gray-300"
                                >
                                  <MarkdownRenderer content={stripModelNoise(block.content)} />
                                </div>
                              ))}
                          </div>
                        ) : null

                        // Interleaved tool_call + answer blocks (Codex 2026-05) so
                        // commentary sits BETWEEN tool calls, else the legacy
                        // tool-only split. Identical logic to before, just hoisted
                        // into a value so a slash run can wrap it in the window.
                        const transcript = !hasBlocks
                          ? null
                          : hasAnswerBlock
                            ? (() => {
                                // Interleave strictly by timestamp: tool → answer →
                                // tool → tool → answer … in the real order produced
                                // (provider/LLM-agnostic, David 2026-06-02 r2). Drop
                                // answer blocks that strip to empty.
                                const ordered = [...msg.agentBlocks!]
                                  .filter(
                                    (b) =>
                                      (b.phase === 'tool_call' && b.toolCall) ||
                                      (b.phase === 'answer' && stripChannelTags(b.content)) ||
                                      // G21-2: per-round thoughts, chronological
                                      (b.phase === 'thinking' && b.content.trim()),
                                  )
                                  .sort((a, b) => a.timestamp - b.timestamp)
                                // Render EVERY answer normally + visible
                                // (David 2026-06-04: "kein Collapse, ganz
                                // normal wie eine Antwort"). Skip only a
                                // verbatim repeat of the previous answer.
                                const skippedAnswers = new Set<string>()
                                let lastAnswer = ''
                                for (const b of ordered) {
                                  if (b.phase !== 'answer') continue
                                  const a = stripChannelTags(b.content)
                                  if (!a) continue
                                  if (a === lastAnswer) skippedAnswers.add(b.id)
                                  else lastAnswer = a
                                }
                                return (
                                  <div className="space-y-1">
                                    {groupAgentBlocks(ordered).map((group) => {
                                      // Consecutive tool calls render as ONE
                                      // band that morphs from tool to tool and
                                      // collapses to "N steps" when done
                                      // (David 2026-07-31).
                                      if (group.kind === 'tools') {
                                        return (
                                          <ToolCallBand
                                            key={group.blocks[0].id}
                                            calls={group.calls}
                                            notes={group.notes}
                                            renderNote={(block) => {
                                              if (block.phase === 'thinking') {
                                                return <ThinkingBlock thinking={block.content} />
                                              }
                                              const note = stripChannelTags(block.content)
                                              if (!note) return null
                                              return (
                                                <div className="px-1 py-0.5 text-[0.7rem] leading-relaxed text-gray-500 dark:text-gray-400">
                                                  <MarkdownRenderer content={note} />
                                                </div>
                                              )
                                            }}
                                          />
                                        )
                                      }
                                      const block = group.block
                                      if (block.phase === 'thinking') {
                                        // Trailing thought before the final
                                        // answer, in its collapsed G14-7 bubble.
                                        return <ThinkingBlock key={block.id} thinking={block.content} />
                                      }
                                      if (block.phase === 'answer') {
                                        const answer = stripChannelTags(block.content)
                                        if (!answer || skippedAnswers.has(block.id)) return null
                                        return (
                                          <div key={block.id} className="px-1 py-0.5">
                                            <div className="text-[0.75rem] leading-relaxed">
                                              <MarkdownRenderer content={answer} />
                                            </div>
                                          </div>
                                        )
                                      }
                                      return null
                                    })}
                                  </div>
                                )
                              })()
                            : (
                                <div className="space-y-0">
                                  {(() => {
                                    const calls = msg.agentBlocks!
                                      .filter((b) => b.phase === 'tool_call' && b.toolCall)
                                      .map((b) => b.toolCall!)
                                    return calls.length > 0 ? <ToolCallBand calls={calls} /> : null
                                  })()}
                                </div>
                              )

                        // Text content, user bubble always; assistant only when
                        // there are no per-iteration answer blocks (interleave
                        // already rendered those). Assistant drops the bubble to
                        // match the regular Chat view; user keeps the right anchor.
                        const textContent = cleanContent && (msg.role === 'user' || !hasAnswerBlock) ? (
                          <div className={
                            msg.role === 'user'
                              ? 'rounded-lg px-2.5 py-1.5 bg-gray-100 dark:bg-white/[0.06] border border-gray-200 dark:border-white/[0.08]'
                              : 'px-1 py-0.5'
                          }>
                            <div className="text-[0.75rem] leading-relaxed">
                              {msg.role === 'user' ? (
                                <p className="text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{cleanContent}</p>
                              ) : (
                                <MarkdownRenderer content={cleanContent} />
                              )}
                            </div>
                          </div>
                        ) : null

                        // Slash command (David 2026-06-12): the STEPS (tool calls +
                        // intermediate commentary) go in the collapsible window;
                        // the FINAL answer renders OUTSIDE it, normal + readable ,
                        // "die finale antwort soll nicht im tool call sein, nur die
                        // letzte". Same block shape for Ollama + LM Studio, so this
                        // is backend-agnostic. The final answer = the last 'answer'
                        // block, or msg.content when the model never emitted one.
                        if (msg.role === 'assistant' && msg.slashCommand) {
                          const blocks = msg.agentBlocks || []
                          const answerBlocks = blocks
                            .filter((b) => b.phase === 'answer' && stripChannelTags(b.content))
                            .sort((a, b) => a.timestamp - b.timestamp)
                          const finalAnswerBlock = answerBlocks[answerBlocks.length - 1]
                          const finalAnswerText = finalAnswerBlock
                            ? stripChannelTags(finalAnswerBlock.content)
                            : (!hasAnswerBlock && cleanContent ? cleanContent : '')
                          // Steps = tool calls + every answer EXCEPT the final one.
                          const stepsOrdered = [...blocks]
                            .filter(
                              (b) =>
                                (b.phase === 'tool_call' && b.toolCall) ||
                                (b.phase === 'answer' &&
                                  stripChannelTags(b.content) &&
                                  b.id !== finalAnswerBlock?.id),
                            )
                            .sort((a, b) => a.timestamp - b.timestamp)
                          return (
                            <>
                              {(stepCount > 0 || running) && (
                                <SlashStepsBlock command={msg.slashCommand} stepCount={stepCount} running={running}>
                                  <div className="space-y-1">
                                    {reflection}
                                    <div className="space-y-1">
                                      {stepsOrdered.map((block, idx) => {
                                        if (block.phase === 'tool_call' && block.toolCall) {
                                          return <ToolCallBlock key={block.id} toolCall={block.toolCall} />
                                        }
                                        const answer = stripChannelTags(block.content)
                                        if (!answer) return null
                                        const prev = stepsOrdered
                                          .slice(0, idx)
                                          .reverse()
                                          .find((b) => b.phase === 'answer' && stripChannelTags(b.content))
                                        if (prev && stripChannelTags(prev.content) === answer) return null
                                        return (
                                          <div key={block.id} className="px-1 py-0.5">
                                            <div className="text-[0.75rem] leading-relaxed">
                                              <MarkdownRenderer content={answer} />
                                            </div>
                                          </div>
                                        )
                                      })}
                                    </div>
                                  </div>
                                </SlashStepsBlock>
                              )}
                              {finalAnswerText && (
                                <div className="px-1 py-0.5">
                                  <div className="text-[0.75rem] leading-relaxed">
                                    <MarkdownRenderer content={finalAnswerText} />
                                  </div>
                                </div>
                              )}
                            </>
                          )
                        }

                        return (
                          <>
                            {reflection}
                            {transcript}
                            {textContent}
                          </>
                        )
                      })()}
                    </div>
                  </div>
                )
              })}
              {/* 3-dot indicator while THIS coding chat is mid-loop. Bound to
                  the per-conversation flag so switching to another (idle) chat
                  doesn't show its dots — David 2026-06-12 ("die drei ladepunkte
                  kommen in vorherigen chats auch"). */}
              {/* Shell/code approval, inline in the stream so it reads as the
                  next step of the run instead of covering it (David 2026-07-24:
                  "ich hätte das gerne im chat, wie ein tool call"). Renders
                  nothing while no request is pending. */}
              <CodexConfirmDialog />
              {/* G14-6: one anchor with shimmer + clock, no dots, no floating
                  counter. It also names an approval wait for what it is, so a
                  blocked run never looks like a working one (G15b). */}
              <WorkingAnchor
                isRunning={codexGenerating}
                label={pendingConfirm ? 'Waiting for your approval' : undefined}
              />
            </div>
          )}
        </div>

        {/* One-time "/" hint, directly above the prompt (Code view only). */}

        {/* Input */}
        <ChatInput
          onSend={(content) => sendInstruction(content)}
          onStop={stopCodex}
          // Store flag, not the hook's local isRunning (audit A2): the view
          // remounts on every tab switch and a fresh hook says "idle" while
          // the old instance's loop is still running — which offered a second
          // parallel send and no Stop button. The generating flag follows the
          // conversation, not the hook instance.
          isGenerating={isRunning || codexGenerating}
          slashCommands
          composerModel={<ModelSelector openUpward surface="code" />}
          // No plan lives here. The prompt window is the prompt window
          // (David, 2026-08-22): the plan and its Approve-and-run card sit
          // at the bottom of the Explorer column on the right.
          composerAbove={<><LoopBar onStop={stopCodex} /><GoalBar /></>}
          // Ask / Bypass / Plan sits here, in the CODE composer only (plan
          // C1). ChatInput stays surface-neutral, so the Chat tab inherits
          // nothing from it. Plugins used to ride along here and now lives in
          // the header next to New, so this row carries ONE view-specific
          // control and stays a single quiet line in both states.
          composerActions={<CodexModeDropdown openUpward />}
        />
      </div>

      {/* Right column: explorer tree + file preview (C3), and at the bottom
          the plan plus its Approve-and-run card (C2). It owns its own width
          and collapsed state, both persisted in uiStore. The approve callback
          is threaded through because the card left the composer and this view
          is the only place that holds `sendInstruction`. */}
      <ExplorerPanel onApprovePlan={(text) => sendInstruction(text)} />
    </div>
  )
}

import { ExplorerPanel } from './ExplorerPanel'
