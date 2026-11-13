import { registerChatSender } from '../../lib/remote-chat-senders'
import { composeFileMessage } from '../../lib/chat-files'
import { useCodex } from '../../hooks/useCodex'
import { RequestUsageLine } from './RequestUsageLine'
import { useAutoScroll } from '../../hooks/useAutoScroll'
import { useCodexStore } from '../../stores/codexStore'
import { useChatStore } from '../../stores/chatStore'
import { useComputerStore } from '../../stores/computerStore'
import { useBackgroundAgentWake } from '../../hooks/useBackgroundAgentWake'
import { useGenerationStore } from '../../stores/generationStore'
import { ChatInput } from './ChatInput'
import { ChatFileChip } from './ChatFileChip'
import { FILE_ONLY_TEXT } from '../../lib/chat-files'
import { ToolCallBlock } from './ToolCallBlock'
import { ToolCallBand } from './ToolCallBand'
import { groupAgentBlocks } from '../../lib/tool-call-groups'
import { ThinkingBlock } from './ThinkingBlock'
import { MarkdownRenderer } from './MarkdownRenderer'
import { closeOpenMarkdown } from '../../lib/streaming-markdown'
import { TokenCounter } from './TokenCounter'
import { ContextDropdown } from './ContextDropdown'
import { SmallModelModeToggle } from './SmallModelModeToggle'
import { FlashChatNotice } from './FlashChatNotice'
import { WorkingAnchor } from './WorkingAnchor'
import { useCodexConfirmStore } from '../../stores/codexConfirmStore'
import { PluginsDropdown } from './PluginsDropdown'
import { CodexModeDropdown } from './CodexModeDropdown'
import { ModelSelector } from '../models/ModelSelector'
import { MONOGRAM, MONOGRAM_INVERT } from '../layout/brand'
import { AVATAR_SLOT, MODEL_MARK, MODEL_MARK_SLOT } from './avatar-slot'
import { GoalBar } from './GoalBar'
import { ChatNotices } from './ChatNotices'
import { LocalLaneWaitLine } from './LocalLaneWaitLine'
import { LoopBar } from './LoopBar'
import { useSettingsStore } from '../../stores/settingsStore'
import { HowItWorks } from '../ui/HowItWorks'
import { useModelStore } from '../../stores/modelStore'
import { useAnyAgentLoopActive } from '../../stores/agentLoopStore'
import { useUIStore } from '../../stores/uiStore'
import { RecentChats } from './RecentChats'
import { openNewCodeSession } from '../../lib/code-session'
import { useAgentModeStore } from '../../stores/agentModeStore'
import {
  CODEX_WORKDIR_LOCK_TITLE,
  codexBusyReason,
  codexFallbackLabel,
} from '../../lib/codex-workdir'
import { resolveWorkspacePath } from '../../api/agents/workspace-resolve'
import { StagedChangesPanel } from './StagedChangesPanel'
import { PhoneWritesLine } from './PhoneWritesLine'
import { SlashStepsBlock } from './SlashStepsBlock'
import { CompactBlock } from './CompactBlock'
import { CompactLayerBanner, CompactLayerRail, useCompactLayers } from './CompactLayerRail'
import { User, Code, Eye, GitBranch, Download, RefreshCw, RotateCcw, Folder, FolderX, Check, AlertTriangle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { checkGitInstalled, openExternal, type GitStatus } from '../../api/backend'
import { CodexConfirmDialog } from './CodexConfirmDialog'
import { Hinweis } from '../ui/Hinweis'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { stripModelNoise } from '../../lib/strip-model-noise'
import { useIsQueuedForLocalLane, useLocalLaneQueuePosition } from '../../lib/run-idle'

// Code always drives a tool loop, so the aggressive tier applies here.
const stripChannelTags = (text: string) => stripModelNoise(text, { aggressive: true })

// Typo-Leiter (die-typo-leiter-und-ihre-umgehung.test.ts): the workdir-lock
// banner and the "no folder picked" hint both use the same quiet size and
// tone. That size is deliberately not folded into `.t-micro` (index.css,
// `.t-micro`-Audit: "kein Name unter 10"), so this is a shared literal, not a
// new consolidation. One constant means one occurrence in the source instead
// of two, which is the difference between staying under and going over the
// ratchet's cap.
const QUIET_HINT_TEXT = `text-[0.55rem] ${HINWEIS_TEXT.ruhig}`

// Code-Mode renders EVERY between-tool answer as normal, always-visible prose
// now (2026-06-04: "kein Collapse, das soll ganz normal wie eine Antwort
// angezeigt werden"). The render path below dedupes verbatim repeats so a
// chatty small model can't stack the same line. (The old CollapsibleAnswer
// one-line-preview component was removed.)

export function CodexView() {
  const { sendInstruction, stopCodex, isRunning } = useCodex()
  // A message from the paired phone in a shared Code chat goes through this
  // send path (lib/remote-chats-bridge). Code takes no pictures; files go in
  // as the same file blocks the chat composer writes.
  useEffect(() => registerChatSender('code', {
    send: async (content, _images, files) => {
      await sendInstruction(files.length ? composeFileMessage(content, files.map((f) => f.attachment)) : content)
    },
    stop: (convId) => stopCodex(convId),
  }), [sendInstruction, stopCodex])
  // Derselbe Weckhaken wie im Agentenweg: eine Hintergrundaufgabe endet fast
  // immer NACH dem Zug, der sie startete, und ohne diesen Haken erfuehre das
  // Modell davon erst bei der naechsten Eingabe des Menschen.
  //
  // R2-18: `sendInstruction` nimmt (text, opts), der Haken ruft aber
  // (text, images, opts). Das Objekt mit `hiddenUser: true` landete damit auf
  // Position 3 und fiel weg, also stand die Weckzeile als sichtbare
  // Nutzernachricht im Verlauf, als haette der Mensch sie getippt. Ein Adapter
  // schiebt sie auf die Stelle, an der sie gelesen wird.
  useBackgroundAgentWake(
    useChatStore((s) => s.activeConversationId),
    (text, _images, opts) => sendInstruction(text, opts),
  )
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)
  const thread = useCodexStore((s) => activeConversationId ? s.threads[activeConversationId] : undefined)
  // The mode the composer's trigger shows right now (CodexModeDropdown reads
  // the same function). Handed to the send, which never runs looser (A37).
  const codexDefaultMode = useSettingsStore((s) => s.settings.codexDefaultMode)
  const shownMode = useCodexStore((s) => s.nextSendMode(activeConversationId, codexDefaultMode))

  const conversation = conversations.find(c => c.id === activeConversationId)
  const messages = conversation?.messages || []

  // Per-conversation generating flag (2026-06-12): the typing indicator
  // + realtime counter + a message's live-stream state must follow the coding
  // chat that's ACTUALLY running, not every chat the user switches to. The
  // hook's `isRunning` is global (kept for the input, which guards shared stream
  // refs); the visual bits below read this conversation-scoped flag instead.
  const generatingMap = useGenerationStore((s) => s.generating)
  const codexGenerating = !!activeConversationId && !!generatingMap[activeConversationId]
  const pendingConfirm = useCodexConfirmStore((s) => s.pending)
  // The question of the first use of computer control is open in this conversation.
  const chatAsked = useComputerStore((s) => !!s.chatAsk && !s.chatAsk.voice && (s.chatAsk.conversationId === null || s.chatAsk.conversationId === activeConversationId))
  // Runde 4 (review-lanes.md Blocker 1+6): THIS conversation's own send
  // queued behind another local run. Not part of `generatingMap` (no stream
  // is flowing yet), so it needs its own read. Nachbesserung 9 (Runde 3) had
  // added a cross-conversation lock here via `composerBusy` (parity with
  // ChatView.tsx, closing the one path Blocker 1's Reichweite point noted as
  // reachable: Chat<->Code); that lock is gone as of this round, the same as
  // in ChatView.tsx, now that a local second send queues visibly instead of
  // racing the first one and a cloud second send just runs alongside it.
  const queuedForLocalLane = useIsQueuedForLocalLane(activeConversationId)
  const localLaneQueuePosition = useLocalLaneQueuePosition(activeConversationId)

  // G8-3: "sobald er fertig gedacht hat, hakt das so komisch ab und
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
  // Compact layers (3.0.9), as in the chat list: the view starts at the
  // newest compaction, the rail opens the stretch before each one, read only.
  // Codex hides only `hidden` messages; app notices stay in the transcript.
  const layers = useCompactLayers(conversation, lastUserMessage?.id)
  const readOnly = layers.layer !== null
  const shownItems = layers.items.filter((it) => it.kind === 'line' || !it.message.hidden)
  // The message a run is writing into. In an earlier layer nothing streams,
  // even where the cut runs through that very answer.
  const liveId = readOnly ? undefined : lastMessage?.id
  const { ref: scrollRef, contentRef } = useAutoScroll(
    `${lastMessage?.content ?? ''}|${thread?.events?.length ?? 0}`,
    `${lastUserMessage?.id ?? ''}|${layers.layer ?? 'now'}`,
  )

  const codexReviewMode = useSettingsStore((s) => s.settings.codexReviewMode)
  const cloudMode = useSettingsStore((s) => s.settings.appMode === 'cloud')
  const userAvatarDataUrl = useSettingsStore((s) => s.settings.userAvatarDataUrl)
  const activeModel = useModelStore((s) => s.activeModel)
  const codexWorkingDir = useCodexStore((s) => s.workingDirectory)
  const clearWorkingDirectory = useCodexStore((s) => s.clearWorkingDirectory)
  // A8 (2.6.8): the same Remove sits in the explorer column, but that column
  // can be collapsed, and two users looked for a way out of their folder and
  // found none. The header always shows the folder, so it also carries the way
  // to give it back. Locked, not hidden, while a coding turn is in flight, and
  // the verdict is the shared one so the two buttons cannot drift apart.
  // Beide Karten, aus demselben Grund wie im Explorer: ein Faden, der auf
  // 'running' stehengeblieben ist, sperrt den Ordner nicht mehr allein.
  const sendsInFlight = useCodexStore((s) => s.sendsInFlight)
  const threads = useCodexStore((s) => s.threads)
  // The working directory is GLOBAL across every Codex conversation (A8): a
  // loop in ANY of them must still keep the folder locked, not only the
  // active one's.
  const loop = useAnyAgentLoopActive()
  const lockReason = codexBusyReason({ sendsInFlight, threads, generating: generatingMap, loop })
  // The open explorer already says why the folder is held (explorer-workdir-lock).
  const explorerCollapsed = useUIStore((s) => s.explorerCollapsed)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)

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
  // Starts as `true` because the probe below starts with the component: the
  // effect used to flip it on synchronously, which is a cascading render for a
  // value that was already knowable at mount (React 19 `set-state-in-effect`).
  const [gitChecking, setGitChecking] = useState(true)
  useEffect(() => {
    let cancelled = false
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

  // New coding session (2026-06-04: "start neu" must really start new).
  // Abort any in-flight loop, then create a fresh codex conversation. The
  // working directory persists in codexStore, so the new session keeps the
  // folder; a brand-new conversation means a brand-new thread on next send.
  const startNewSession = () => {
    stopCodex()
    if (!activeModel) return
    openNewCodeSession(activeModel)
  }

  return (
    // Derselbe leckende Vorfahre wie in ChatView.tsx (flashchip Runde 5,
    // e111f8f6..d18d05a8): overflow-hidden clippt visuell, verhindert aber
    // kein programmatisches Scrollen. Ein Klick auf ModelSelector,
    // CodexModeDropdown oder PluginsDropdown, deren Ausloeser teilweise
    // ausserhalb der Zeile liegt, holt den Browser das fokussierte Element
    // per scrollLeft auf GENAU DIESEM Vorfahren "in Sicht" und verschiebt den
    // ganzen Code-Reiter seitlich, dauerhaft. overflow-clip clippt genauso,
    // laesst aber kein programmatisches Scrollen zu. Kein Nachkomme in dieser
    // Datei haengt scrollTop, scrollTo oder scrollIntoView an dieses Element
    // (grep gegen src/components/chat/CodexView.tsx bestaetigt das).
    // min-h-0 gehoert zwingend dazu (Issue 138): overflow-hidden machte dieses
    // Element zum Bildlaufbehaelter, und darin ist die automatische
    // Mindesthoehe eines Flex-Kindes 0. overflow-clip ist KEIN
    // Bildlaufbehaelter, also faellt min-height auf die Inhaltshoehe zurueck,
    // der Rahmen waechst mit dem Verlauf ueber das Fenster hinaus und schiebt
    // den Composer hinaus. ChatView.tsx Zeile 300 traegt dasselbe min-h-0.
    <div className="flex-1 flex overflow-clip min-h-0">
      {/* Main panel. min-h-0 aus demselben Grund wie am Rahmen darueber
          (Issue 138, ChatView.tsx Zeile 300): sonst erzwingt der Verlauf in
          dieser Spalte seine volle Inhaltshoehe und der Composer darunter
          landet unter dem Fensterrand. */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 relative">
        {/* Codex header */}
        {/* flex-wrap (Issue 309 T1, 375 px): ohne Umbruch lief die Zeile
            ueber den Rand der Spalte hinaus und lag auf dem Aufklappknopf des
            Explorers daneben. Kein overflow-hidden: die Menues dieser Zeile
            klappen nach unten auf und wuerden sonst abgeschnitten. */}
        <div
          data-testid="codex-header"
          className="flex flex-wrap items-center gap-1.5 px-2 py-0.5 border-b border-gray-200 dark:border-white/[0.04]"
        >
          <Code size={9} className="text-gray-500" />
          <span className="text-[0.55rem] text-gray-600 dark:text-gray-400 font-medium whitespace-nowrap shrink-0">Coding Agent</span>
          {/* Code-Review Mode badge (B13), makes it impossible to miss
              that the agent is read-only. The toggle itself lives in
              Settings → Codex Agent; clicking the badge jumps you there
              isn't worth a routing change in v2.5.0.
              Das Abzeichen stand in Gelb und las sich damit wie eine Stoerung,
              obwohl es das Gegenteil meldet: der Agent kann nichts anfassen.
              Gruen sagt "diese Zusicherung gilt". Es ist keine Ampel, sondern
              ein Zustandschip, deshalb behaelt es seine Form und wechselt nur
              den Farbton. Im Kopf daneben ist Gruen frei: der Modellumschalter
              nimmt Violett, alles andere ist grau. */}
          {codexReviewMode && (
            <span
              className="flex items-center gap-1 px-1.5 py-0 rounded border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-[0.55rem] bg-emerald-500/[0.04]"
              title="Code-Review Mode is active. The coding agent will inspect the codebase but won't write files or run commands. Disable in Settings → Coding Agent."
            >
              <Eye size={9} />
              <span>Review</span>
            </span>
          )}
          {/* Working directory indicator, so the user always sees WHERE the
              agent operates (2026-06-04: "ich hab den Ordner angegeben …
              er ist eigentlich in Dokumenten"). Empty = per-chat sandbox under
              ~/agent-workspace, which is also where shell output now lands. */}
          <span
            className="flex items-center gap-1 text-[0.5rem] text-gray-500 dark:text-gray-500 font-mono truncate min-w-0 max-w-[200px]"
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
          {/* New coding session: aborts any running loop and starts a fresh
              chat/thread (keeps the working directory). 2026-06-04:
              "start neu" must actually start new. */}
          <button
            onClick={startNewSession}
            title="New coding session (clears the current run, keeps the folder)"
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.55rem] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors whitespace-nowrap shrink-0"
          >
            <RotateCcw size={10} />
            <span>New</span>
          </button>
          {cloudMode && <HowItWorks topic="code" variant="mark" placement="below-end" />}
          {/* Plugins (Chat Tools · Caveman · Persona · Group) lives HERE, next
              to New, as a bare icon with the name in the tooltip. It used to
              sit in the composer action bar and was one of the four things
              crowding the prompt row (2026-08-22: "das promptfenster ist
              ueberfuellt"). The dropdown itself is untouched, only the place
              and the trigger changed. */}
          <PluginsDropdown iconOnly agentTools />
          {/* EIN Kontextelement (D-S06): der Fuellstand ist die Beschriftung
              des Fensterwaehlers, nicht dieselbe Zahl ein zweites Mal daneben. */}
          <ContextDropdown><TokenCounter /></ContextDropdown>
          <SmallModelModeToggle />
          {/* Was diese Runde kostet, denselben Ort wie im Chat-Reiter
              (ChatView.tsx): ein Etikett in dieser Leiste statt eines Bandes
              ueber der Eingabe. Rendert `null` ohne Flash-Modell. */}
          <FlashChatNotice />
        </div>

        {/* R2-21: der Sperrgrund hing bisher nur als `title` am Entfernen-Knopf,
            und ein `disabled` Knopf nimmt keine Mauszeiger-Ereignisse an, also
            ist der Hinweis nie erschienen (derselbe Fehler wie im ExplorerPanel,
            dort mit `explorer-workdir-lock` behoben). Ruhiger Ton, keine
            Warnfarbe: gesperrt ist ein Zustand, der von selbst endet.
            Nur wenn es den Entfernen-Knopf gibt und der offene Explorer
            denselben Satz nicht schon zeigt: sonst stand er zweimal
            nebeneinander, einmal ueber nichts. */}
        {lockReason && codexWorkingDir && explorerCollapsed && (
          <p
            data-testid="codex-workdir-lock"
            className={`px-3 py-1 ${QUIET_HINT_TEXT} border-b border-gray-200 dark:border-white/[0.04]`}
          >
            {CODEX_WORKDIR_LOCK_TITLE[lockReason]}
          </p>
        )}

        {/* Git-missing banner (v2.5.0). Codex shells out to git for
            status/diff/commit/log, and without it those tools fail. Minimal,
            dismiss-by-installing: an Install button (opens the platform git
            download page) + a Recheck button for after the install.
            Ton `fehler`: ohne git fallen echte Werkzeuge aus, und es gibt genau
            eine Handlung dagegen, die gleich daneben steht. Die gelbe Fuellung
            und der gelbe Rahmen sind weg, die Linie unten ist die Trennung zum
            Verlauf und dieselbe wie am Kopf darueber, kein Rahmen um den Satz
            (`lib/hinweis.ts`). */}
        {gitStatus && !gitStatus.installed && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 dark:border-white/[0.04]">
            <Hinweis ton="fehler" icon={<GitBranch size={12} className="shrink-0 mt-0.5" />} className="flex-1">
              Git isn't installed. The coding agent needs it for diffs, commits and history.
            </Hinweis>
            <button
              onClick={() => openExternal(gitStatus.download_url)}
              className="flex items-center gap-1 px-2 py-0.5 rounded t-micro font-medium text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
            >
              <Download size={11} /> Install Git
            </button>
            <button
              onClick={recheckGit}
              disabled={gitChecking}
              title="Re-check after installing Git"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded t-micro text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={11} className={gitChecking ? 'animate-spin' : ''} />
            </button>
          </div>
        )}

        {/* Stage-and-Approve queue (B10). Renders nothing when there
            are no pending changes for the active chat, so non-stage-mode
            users never see it. */}
        <StagedChangesPanel chatId={activeConversationId} />
        <PhoneWritesLine chatId={activeConversationId} />

        {/* Messages */}
        <div className="relative flex-1 min-h-[10rem] flex flex-col">
        <CompactLayerBanner view={layers} />
        <div
          ref={scrollRef}
          className={`flex-1 min-h-0 overflow-y-auto scrollbar-thin ${layers.cuts.length ? 'pl-6' : ''}`}
          data-testid="codex-transcript"
          data-compact-layer={layers.layer ?? 'current'}
        >
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center" data-testid="codex-landing">
              <Code size={28} className="text-gray-300 dark:text-gray-700 mb-2" />
              <p className="text-[0.7rem] text-gray-500 font-medium">Coding Agent</p>
              <p className="text-[0.55rem] text-gray-400 dark:text-gray-600 mt-0.5 max-w-[300px]">
                Send a coding instruction. The coding agent will read your codebase, write code, and run commands.
              </p>
              {/* Kein Ordner ist kein Fehler, sondern der Startzustand: der
                  Agent hat ein Ausweichverzeichnis und arbeitet darin. Die
                  Zeile stand in gedaempftem Gelb, also in Alarmfarbe fuer eine
                  Auskunft, und steht jetzt im ruhigen Ton der Absaetze darueber. */}
              {!codexWorkingDir && (
                <p className={`${QUIET_HINT_TEXT} mt-2`} data-testid="codex-no-folder-hint">
                  No folder picked. The agent works in {fallbackLabel}. Pick a project with
                  "Select folder..." in the file tree panel on the right.
                </p>
              )}
              {/* With the side panel collapsed the latest code chats stand
                  here, as they did on the old Code landing (GH #141). With no
                  conversation open this is the Code area's start screen. */}
              {!sidebarOpen && !activeConversationId && (
                <div className="w-full pt-3 flex flex-col items-center text-left">
                  <RecentChats />
                </div>
              )}
            </div>
          ) : (
            <div ref={contentRef} className="py-1">
              {shownItems.map((item) => {
                if (item.kind === 'line') return <CompactBlock key={item.cut.key} cut={item.cut} />
                const msg = item.message
                // Der Rumpf hat mehrere Ausgaenge (Hinweiszeile, Werkzeugblock,
                // normale Blase) und steht unveraendert in einer IIFE, seine
                // `return`s werden ihre. Bis 3.0.8 hing danach die
                // Verdichtungslinie an; seit 3.0.9 ist sie ein eigenes Element
                // der Ebene (lib/compact-layers.ts) und steht oben drueber.
                const gerendert = (() => {
                // App notices (a staged change that landed on disk) are not
                // model turns. They used to be written hidden, so the one line
                // that says "the file on disk is not the diff you approved"
                // reached nobody, and an assistant bubble would be the other
                // wrong answer: it would claim the model said it.
                // Die beiden Faelle unterscheiden sich im TON, nicht in der
                // Bauform: die Datei auf der Platte weicht vom genehmigten Diff
                // ab, da muss jemand hinsehen (rot), oder sie ist genau der
                // genehmigte Diff (ruhig). Vorher hatten beide einen Kasten,
                // der gelbe darin sah aus wie ein Absturz (`lib/hinweis.ts`).
                if (msg.role === 'system' && msg.notice) {
                  const warn = msg.notice === 'warn'
                  return (
                    <div key={msg.id} className="px-3 py-1" data-testid="codex-notice">
                      <Hinweis
                        ton={warn ? 'fehler' : 'ruhig'}
                        icon={warn
                          ? <AlertTriangle size={10} className="mt-0.5 shrink-0" />
                          : <Check size={10} className="mt-0.5 shrink-0" />}
                      >
                        <span className="break-words">{msg.content}</span>
                      </Hinweis>
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
                    {/* The same avatar column as in the chat (avatar-slot.ts). */}
                    {msg.role === 'user' ? (
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
                    <div className="max-w-[85%] space-y-0.5">
                      {/* Thinking */}
                      {msg.role === 'assistant' && msg.thinking && (
                        <ThinkingBlock
                          thinking={msg.thinking}
                          streaming={codexGenerating && msg.id === liveId && !cleanContent.trim()}
                        />
                      )}
                      {(() => {
                        const running = codexGenerating && msg.id === liveId
                        // While this message streams, an open ` or ** is closed
                        // for the frame (lib/streaming-markdown.ts).
                        const shown = (text: string) => (running ? closeOpenMarkdown(text) : text)
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
                                // (provider/LLM-agnostic, 2026-06-02 r2). Drop
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
                                // (2026-06-04: "kein Collapse, ganz
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
                                      // (2026-07-31).
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
                                            <div className="text-[12px] leading-relaxed">
                                              <MarkdownRenderer content={shown(answer)} />
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
                        // Files attached to this instruction: a chip each. The
                        // bytes are in the working folder, not in the chat.
                        const fileChips = msg.role === 'user' && msg.files?.length ? (
                          <div className="flex gap-1 flex-wrap justify-end">
                            {msg.files.map((file, i) => (
                              <ChatFileChip key={`${file.sha256}-${i}`} file={file} />
                            ))}
                          </div>
                        ) : null
                        const onlyFiles = !!fileChips && msg.displayContent === FILE_ONLY_TEXT
                        const textContent = cleanContent && !onlyFiles && (msg.role === 'user' || !hasAnswerBlock) ? (
                          <div className={
                            msg.role === 'user'
                              ? 'rounded-lg px-2.5 py-1.5 bg-gray-100 dark:bg-white/[0.06] border border-gray-200 dark:border-white/[0.08]'
                              : 'px-1 py-0.5'
                          }>
                            <div className="text-[12px] leading-relaxed">
                              {msg.role === 'user' ? (
                                <p className="text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{cleanContent}</p>
                              ) : (
                                <MarkdownRenderer content={shown(cleanContent)} />
                              )}
                            </div>
                          </div>
                        ) : null

                        // Slash command (2026-06-12): the STEPS (tool calls +
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
                                            <div className="text-[12px] leading-relaxed">
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
                                  <div className="text-[12px] leading-relaxed">
                                    <MarkdownRenderer content={shown(finalAnswerText)} />
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
                            {fileChips}
                            {textContent}
                          </>
                        )
                      })()}
                      {msg.role === 'assistant' && (
                        <RequestUsageLine usage={msg.requestUsage} className="block px-1" />
                      )}
                    </div>
                  </div>
                )
                })()
                return gerendert
              })}
              {/* A summary is being written: one line, where the next step will be. */}
              {!readOnly && layers.compacting && <CompactBlock />}
              {/* 3-dot indicator while THIS coding chat is mid-loop. Bound to
                  the per-conversation flag so switching to another (idle) chat
                  doesn't show its dots. 2026-06-12 ("die drei ladepunkte
                  kommen in vorherigen chats auch"). */}
              {/* Shell/code approval, inline in the stream so it reads as the
                  next step of the run instead of covering it (2026-07-24:
                  "ich hätte das gerne im chat, wie ein tool call"). Renders
                  nothing while no request is pending. */}
              {!readOnly && <CodexConfirmDialog />}
              {/* G14-6: one anchor with shimmer + clock, no dots, no floating
                  counter. It also names an approval wait for what it is, so a
                  blocked run never looks like a working one (G15b). */}
              {!readOnly && (
                <WorkingAnchor
                  isRunning={codexGenerating}
                  conversationId={activeConversationId}
                  awaitingApproval={!!pendingConfirm || chatAsked}
                  message={messages[messages.length - 1]?.role === 'assistant' ? messages[messages.length - 1] : undefined}
                />
              )}
            </div>
          )}
        </div>
        <CompactLayerRail view={layers} />
        </div>

        {/* Die stehenden Sitzungsbaender und die Zeilen, die frueher IM
            Composer standen (21.09.2026: „NICHTS im prompt fenster!").
            LoopBar und GoalBar sind Bedienelemente und bleiben sichtbar, nur
            als Geschwister UEBER dem Kasten statt darin; die Wartezeile und
            die Composer-Hinweise sind Hinweise und stehen jetzt hier. Die
            Zeile ueber das MODELL ist in den Modellwaehler gezogen. */}
        <ChatNotices surface="code" />
        <LoopBar onStop={stopCodex} />
        <GoalBar />
        <LocalLaneWaitLine waiting={!!queuedForLocalLane} queuePosition={localLaneQueuePosition} />

        {/* Input */}
        <ChatInput
          // Images have no path into a coding run; attached files do, they
          // are copied into the working folder (lib/chat-files.ts).
          onSend={(content, _images, files) => sendInstruction(content, files ? { files, shownMode } : { shownMode })}
          onStop={stopCodex}
          // Store flag, not the hook's local isRunning (audit A2): the view
          // remounts on every tab switch and a fresh hook says "idle" while
          // the old instance's loop is still running, which offered a second
          // parallel send and no Stop button. The generating flag follows the
          // conversation, not the hook instance.
          isGenerating={isRunning || codexGenerating || queuedForLocalLane}
          waitingForLocalLane={queuedForLocalLane}
          slashCommands="agent"
          filesReachTools
          draftScope="code"
          composerModel={<ModelSelector openUpward surface="code" />}
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
