import { useState, useEffect, useRef } from 'react'
import { usePopoverPlatz } from '../../hooks/usePopoverPlatz'
import { motion, AnimatePresence } from 'framer-motion'
import { useChat } from '../../hooks/useChat'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useRAGStore } from '../../stores/ragStore'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { AgentPanel } from './AgentPanel'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { COMPOSER_MAX_W } from './composer-width'
import { RAGPanel } from './RAGPanel'
import { DocsButton } from './DocsButton'
import { RetrievalErrorBar } from './RetrievalErrorBar'
import { ChatNotices } from './ChatNotices'
import { LocalLaneWaitLine } from './LocalLaneWaitLine'
import { useDocsAvailability } from '../../hooks/useDocsAvailability'
import { AgentModeToggle } from './AgentModeToggle'
import { FlashChatNotice } from './FlashChatNotice'
import { AgentWorkspaceBadge } from './AgentWorkspaceBadge'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { CHAT_BASE_SYSTEM_PROMPT } from '../../lib/system-prompt'
import { useSettingsStore } from '../../stores/settingsStore'
import { HowItWorks } from '../ui/HowItWorks'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'
import { ChevronDown, Download, Wrench, Radio, RefreshCw, X } from 'lucide-react'
import { PluginsDropdown } from './PluginsDropdown'
import { ModelSelector } from '../models/ModelSelector'
import { useConversationModelHint } from './ConversationModelNote'
import { GoalBar } from './GoalBar'
import { PlanBar } from './PlanBar'
import { LoopBar } from './LoopBar'
import { GroupCostHint } from './GroupCostHint'
import { GroupRoundBar } from './GroupRoundBar'
import { MemoryDebugToggle } from './MemoryDebugPanel'
import { TokenCounter } from './TokenCounter'
import { ContextDropdown } from './ContextDropdown'
import { SmallModelModeToggle } from './SmallModelModeToggle'
import { ABCompare } from './ABCompare'
import { RecentChats } from './RecentChats'
import { useUIStore } from '../../stores/uiStore'
import { chatModelReady } from '../../lib/chat-model-ready'
import { useCompareStore } from '../../stores/compareStore'
import { exportConversation, missingImagesNote } from '../../lib/chat-export'
import { conversationMode } from '../../lib/conversation-mode'
import { PermissionOverrideBar } from './PermissionOverrideBar'
import { CodexView } from './CodexView'
import { registerChatSender } from '../../lib/remote-chat-senders'
import { ContinueOnPhoneButton } from './ContinueOnPhoneButton'
import { HEADER_CHIP } from './header-chip'
import { useCodexStore } from '../../stores/codexStore'
import { useGenerationStore } from '../../stores/generationStore'
import { composerBusy } from '../../lib/composer-busy'
import { useIsQueuedForLocalLane, useLocalLaneQueuePosition, useLocalLaneHolderWaitsForApproval, useLocalLaneHolderId } from '../../lib/run-idle'
import { useRemoteStore } from '../../stores/remoteStore'
import { modelDisplayLabel } from '../../lib/model-label'
import { MONOGRAM, MONOGRAM_INVERT } from '../layout/brand'

/** Was die Eingangsseite sagt und anbietet, je nach Lage. */
interface Landing {
  readonly subline: string
  /** Zweite Zeile, einzeilig gekuerzt, heute der Name des Modells. */
  readonly note?: string
  readonly cta: { readonly label: string; readonly run: () => void } | null
}

export function ChatView() {
  const { sendMessage, stopGeneration, isGenerating, isLoadingModel, regenerateMessage, regenerateSpeaker, editAndResend, pendingApproval, approveToolCall, rejectToolCall } = useChat()
  // A message from the paired phone in a shared chat goes through this very
  // send path (lib/remote-chats-bridge, lib/remote-chat-senders).
  useEffect(() => registerChatSender('chat', {
    send: (content, images, files) => sendMessage(content, images.length ? images : undefined, files.length ? files : undefined),
    // Stop of the open chat is this view's own Stop.
    stop: (convId) => { if (useChatStore.getState().activeConversationId === convId) stopGeneration() },
  }), [sendMessage, stopGeneration])
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  // Drives the recent-chats list on the empty screen: collapsed panel means
  // the list stands in the main area, expanded means it stands in the panel.
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  // NOT `s.conversations`. That array is replaced on every streaming flush, so
  // subscribing to it re-reconciled the entire chat chrome (composer, plan
  // bar, header controls, none of them memoised) once per frame for the whole
  // duration of an answer, which is why typing during a run felt broken. What
  // this component needs from the conversation while it renders is two SCALARS,
  // and a scalar stands still while tokens arrive. Everything else (model,
  // system prompt, the export payload) is read at click time from getState(),
  // where a fresh value is what you want anyway.
  const activeConvMode = useChatStore(
    (s) => s.conversations.find((c) => c.id === s.activeConversationId)?.mode,
  )
  // A chat that is open but has nothing in it yet. Counted the way MessageList
  // counts: the system prompt and hidden bookkeeping are not something the user
  // has said. Screen check on the bundle (2026-09-02): after New Chat the
  // main area went blank, because the recent list only stood on the no-chat
  // screen.
  //
  // Derived INSIDE the selector for the reason above: the answer is a boolean,
  // so it survives every streaming flush untouched and only re-renders on the
  // one frame where it actually flips.
  const activeConvIsEmpty = useChatStore((s) => {
    const conv = s.conversations.find((c) => c.id === s.activeConversationId)
    if (!conv) return false
    // Auflage A3 (review-leer2-offload.md): 'remote' zaehlt jetzt mit. Ein
    // dispatchter Remote-Chat ist bis zur ersten Mobil-Nachricht genauso
    // leer wie ein frischer lokaler Chat, und lief vorher auf denselben
    // leeren Hauptbereich wie das F1-Symptom oben, nur dass hier kein
    // Reiterwechsel den Zustand zuruecksetzt. 'codex' bleibt aussen vor
    // (eigene Ansicht, CodexView, siehe chatMode-Weiche oben); 'openclaw' hat
    // keinen aktiven Einstiegspunkt in der UI und bleibt deshalb unberuehrt.
    const mode = conversationMode(conv)
    if (mode !== 'lu' && mode !== 'remote') return false
    return conv.messages.filter((m) => m.role !== 'system' && !m.hidden).length === 0
  })
  const activeModel = useModelStore((s) => s.activeModel)
  const models = useModelStore((s) => s.models)
  // Meldung 4 (R5 re-measure): the model that wrote the answers on screen,
  // when it is not the one the picker stands on. Handed to the picker, which
  // marks itself with a dot and says the whole sentence in its tooltip.
  const conversationModelHint = useConversationModelHint()
  const [ragPanelOpen, setRagPanelOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportToast, setExportToast] = useState<string>('')
  const [toolsDropdownOpen, setToolsDropdownOpen] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const exportMenu = usePopoverPlatz(exportMenuRef, exportOpen)
  const toolsMenuRef = useRef<HTMLDivElement>(null)
  const toolsMenu = usePopoverPlatz(toolsMenuRef, toolsDropdownOpen, { bevorzugt: 'oben', abstand: 2 })
  // Beide Aufklapplisten dieser Datei legen eine volle `fixed inset-0`-Flaeche
  // ueber die App, und beide hatten Escape nie bekommen. Der Datei-Waechter
  // hat es uebersehen, weil weiter unten der Genehmigungsdialog auf 'Escape'
  // hoert: eine Datei, zwei Pfade, einer gepflegt. Nachgemessen: nach Escape
  // stand `aria-expanded="true"`, und ein Klick auf „New Chat" traf
  // `DIV.fixed inset-0 z-40` statt den Knopf.
  useDismissOnEscape(exportOpen, () => setExportOpen(false))
  useDismissOnEscape(toolsDropdownOpen, () => setToolsDropdownOpen(false))
  const chatMode = useCodexStore((s) => s.chatMode)
  const setView = useUIStore((s) => s.setView)
  // Nur noch fuer die Eingangsseite. Der Docs-Knopf haengt seit A9 NICHT mehr
  // hieran (er ist auch im Cloud-Chat da, siehe useDocsAvailability unten);
  // was am Betriebsmodus haengt, ist der Primaerknopf „Install a model": im
  // Cloud-Modus ist die Modellansicht ausgeblendet, ein Knopf dorthin waere
  // ein toter Klick.
  const appMode = useSettingsStore((s) => s.settings.appMode)

  // Per-conversation generating flag (2026-06-12): the typing indicator
  // + realtime counter must show ONLY in the chat that is actually generating,
  // not in every other chat the user switches to.
  //
  // Since T1 point 4 the COMPOSER reads it too. It used to read the hook's
  // app-wide `isGenerating`, so every other conversation lost its Send button
  // and got a Stop button that aborted the foreign run. `composerBusy` still
  // resolves what THIS conversation's own slot should show (own run, or an
  // orphaned run the maps have not caught up with yet); as of Runde 4
  // (review-lanes.md Blocker 1+6) it no longer feeds a lock on any OTHER
  // conversation into the composer at all, because there is nothing left to
  // lock: a second local send now queues visibly instead of racing the first
  // one for the built-in engine's one slot, and a second cloud send just runs
  // alongside it.
  const generatingMap = useGenerationStore((s) => s.generating)
  const activeGenerating = !!activeConversationId && !!generatingMap[activeConversationId]
  const busy = composerBusy(isGenerating, generatingMap, activeConversationId)
  // THIS conversation's own send queued behind another local run. Not part of
  // `generatingMap` (no stream is flowing yet), so `composerBusy` cannot see
  // it. Folded into `isGenerating` below so the composer shows Stop instead
  // of Send while it waits.
  const queuedForLocalLane = useIsQueuedForLocalLane(activeConversationId)
  const localLaneQueuePosition = useLocalLaneQueuePosition(activeConversationId)
  // Runde 5 (review-lanes.md, Runde 2 Antwort zu Punkt 1): the waiting line
  // must not claim a model is thinking when the holder is really stuck on a
  // person's tool approval.
  const waitingOnApproval = useLocalLaneHolderWaitsForApproval(activeConversationId)
  const localLaneHolderId = useLocalLaneHolderId(activeConversationId)
  const localLaneHolderTitle = useChatStore((s) =>
    localLaneHolderId ? s.conversations.find((c) => c.id === localLaneHolderId)?.title : undefined
  )

  const docCount = useRAGStore((s) =>
    activeConversationId ? (s.documents[activeConversationId] || []).length : 0
  )
  const ragEnabled = useRAGStore((s) =>
    activeConversationId ? s.ragEnabled[activeConversationId] ?? false : false
  )
  // Docs (RAG) needs a LOCAL EMBEDDINGS backend, which is not the same thing as
  // a local CHAT backend. That mix-up is what hid the button in Cloud mode until
  // A9 (2026-09-01). The embeddings sidecar on 127.0.0.1:8128
  // runs in Cloud mode too, and retrieval reaches the model through the system
  // prompt, which every provider takes. So the question is whether this machine
  // can embed, and that is what useDocsAvailability asks.
  const docs = useDocsAvailability()
  const isAgentActive = useAgentModeStore((s) =>
    activeConversationId ? s.agentModeActive[activeConversationId] ?? false : false
  )
  const isComparing = useCompareStore((s) => s.isComparing)

  // Remote-chat state: show a reactivate banner when the user is viewing a
  // Remote conversation whose server has been stopped.
  const remoteEnabled = useRemoteStore((s) => s.enabled)
  const remoteLoading = useRemoteStore((s) => s.loading)
  const remoteError = useRemoteStore((s) => s.error)
  const dispatchedConversationId = useRemoteStore((s) => s.dispatchedConversationId)
  const remoteRestart = useRemoteStore((s) => s.restart)
  const remoteClearError = useRemoteStore((s) => s.clearError)
  const connectedDevices = useRemoteStore((s) => s.connectedDevices)
  const refreshDevices = useRemoteStore((s) => s.refreshDevices)
  const isRemoteChat = activeConvMode === 'remote'
  const isThisRemoteActive = isRemoteChat && remoteEnabled && dispatchedConversationId === activeConversationId
  const isThisRemoteStopped = isRemoteChat && !isThisRemoteActive
  const mobileConnectedCount = connectedDevices.length

  // Bug #1: keep the "Live" banner honest. Poll the real connected-device
  // count every 5 s while we're viewing the dispatched chat so the badge
  // reflects whether a phone is actually attached, not just that the
  // server is running.
  useEffect(() => {
    if (!isThisRemoteActive) return
    refreshDevices()
    const t = setInterval(refreshDevices, 5000)
    return () => clearInterval(t)
  }, [isThisRemoteActive, refreshDevices])

  // Auto-dismiss the "saved to…" toast after a few seconds
  useEffect(() => {
    if (!exportToast) return
    const t = setTimeout(() => setExportToast(''), 4000)
    return () => clearTimeout(t)
  }, [exportToast])

  // Approval keyboard shortcuts: Enter approves, Esc rejects the
  // head-of-queue tool call. The buttons themselves now live inside
  // ToolCallBlock so they appear inline on the pending block, but the
  // keyboard layer stays here so the shortcuts work regardless of
  // scroll position.
  useEffect(() => {
    if (!pendingApproval || !approveToolCall || !rejectToolCall) return
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        approveToolCall()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        rejectToolCall()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [pendingApproval, approveToolCall, rejectToolCall])

  const handleRemoteReactivate = async () => {
    if (!activeConversationId) return
    const activeConv = useChatStore.getState().conversations
      .find((c) => c.id === activeConversationId)
    if (!activeConv) return
    try {
      // Der Grundtext, nie die Person: ein Neustart darf nicht heimlich
      // dispatchen, was der Dispatch selbst bewusst weglaesst. Siehe
      // Sidebar.tsx, handleDispatch.
      await remoteRestart(activeConv.model, CHAT_BASE_SYSTEM_PROMPT)
      useRemoteStore.setState({ dispatchedConversationId: activeConversationId })
    } catch {
      // #29: restart now rethrows. The store's `error` already holds the
      // reason (e.g. "Could not bind 0.0.0.0:11435: Address already in
      // use"). The "Server stopped" banner below renders that reason
      // inline so the user knows what to do, instead of clicking Restart
      // forever and watching nothing change.
    }
  }

  // A/B Compare mode takes over the entire view
  if (isComparing) {
    return <ABCompare />
  }

  // Die drei Lagen, in denen man auf der Eingangsseite landen kann. Der
  // Primaerknopf steht nur in der einen, die der Composer nicht loesen kann.
  const landing: Landing = !activeModel && models.length === 0
    ? (appMode === 'cloud'
        // Cloud versteckt die Modellansicht (lokale Hardware ist dort
        // bedeutungslos), ein Knopf dorthin waere ein toter Klick.
        ? { subline: 'The hosted catalogue is still loading.', cta: null }
        : {
            subline: 'No model is installed yet. That is the one thing this box cannot do for you.',
            cta: { label: 'Install a model', run: () => setView('models') },
          })
    : !activeModel
      // Der Waehler steht IM Composer und oeffnet nach oben. Der alte Satz
      // hier hiess „Select a model above." und zeigte in die falsche Richtung.
      // In der Cloud waehlt die App nie selbst (lib/active-model-mode), der
      // Satz ueber die 7B-Regel waere dort eine Auskunft ueber nichts.
      ? {
          subline: appMode === 'cloud'
            ? 'Choose a model below.'
            : 'Choose a model below. Automatic picks require a known size of at least 7B.',
          cta: null,
        }
      // Der Modellname steht auf einer EIGENEN Zeile und wird gekuerzt: er ist
      // haeufig 50+ Zeichen lang (`hf.co/DevQuasar/huihui-ai_Qwen3-4B-abliterated-GGUF`),
      // und im Fliesstext liess er die Zeile dreimal umbrechen.
      : { subline: 'Type below to start.', note: modelDisplayLabel(models, activeModel), cta: null }

  return (
    <div className="h-full flex flex-col min-w-0">
      {/* One composer, two places. The landing state used to render a logo and
          nothing else, so the screen you arrive on had no input field at all.
          sendMessage creates the conversation when none is active (useChat.ts),
          so the same element serves both branches, and it has to stay OUTSIDE
          the AnimatePresence as ONE instance: a second copy per branch would
          drop the draft the moment the first message creates the conversation,
          which is worse than having no input field at all. */}
      {/* Runde 5 (19.09.2026): `overflow-hidden` clippt visuell, verhindert aber
          KEIN programmatisches Scrollen. Klickt man einen Ausloeser, der
          teilweise ausserhalb der 360px-Zeile liegt (Modellwaehler, Sampling,
          Plugins), holt der Browser das fokussierte Element per `scrollLeft`
          auf GENAU DIESEM Vorfahren "in Sicht", und das verschiebt den ganzen
          Chat seitlich, dauerhaft. `overflow-clip` clippt genauso, laesst aber
          kein programmatisches Scrollen zu (CSS Overflow Module Level 3):
          `scrollLeft`-Zuweisungen darauf bleiben wirkungslos. Beide Achsen
          duerfen hier `clip` sein, kein Nachkomme haengt `scrollTop`,
          `scrollTo` oder `scrollIntoView` an DIESES Element (grep gegen
          `src/components/chat/`, siehe `flashchip.md` Runde 5); der Verlauf
          traegt seinen eigenen `overflow-y-auto` weiter unten. */}
      <div className="flex-1 flex overflow-clip min-h-0">
        <div className="flex-1 flex flex-col min-w-0 relative">
          {/* 3.0.4 Gegenprobe on the Windows box (02.10.2026): the Code area
              with no conversation fell through to the chat landing page, which
              says "Type below to start." over a composer the Code area hides,
              so there was nothing to type into until New Chat. The Code view
              has its own composer and its first send creates the code
              conversation (useCodex), so it serves the empty state too. */}
          {chatMode === 'codex' ? (
            <CodexView />
          ) : (<>
          <AnimatePresence mode="wait">
            {!activeConversationId ? (
              // ── Die Eingangsseite ──
              //
              // D-S02 („Empty-State ohne Titel und CTA") und D-S05 („1237x850px
              // tote Flaeche") sind EIN Befund und werden als einer geloest.
              //
              // Was hier stand: ein 46px-Monogramm auf `opacity-20`, mittig in
              // einer 850px hohen leeren Flaeche, und darunter, nur wenn
              // Modelle da waren, aber keins gewaehlt, der Satz „Select a
              // model above." Das war die erste Flaeche der App, und sie sagte
              // nicht, wie die App heisst, was sie tut oder was man tun soll.
              //
              // Der Satz war ausserdem falsch: der Modellwaehler ist mit dem
              // Umbau vom 2026-07-11 in den Composer gezogen und oeffnet nach
              // OBEN, er steht seither UNTER dem Text, der auf ihn zeigt. Wer
              // dem Hinweis folgte, sah in die Kopfzeile und fand nichts.
              //
              // Was jetzt hier steht: Zeichen, Titel, eine Zeile, die den
              // wirklichen naechsten Schritt benennt, und (nur wo er etwas
              // kann, was der Composer nicht kann) ein Primaerknopf.
              //
              // WIDERSPRUCH ZUM AUDIT, ausdruecklich: der Audit verlangt
              // „Zeichen + Headline + Subline + Primaerbutton", vier Dinge,
              // immer. Der vierte kommt hier nur im Modellfall. Begruendung:
              // als der Audit gemessen wurde, hatte dieser Screen GAR KEIN
              // Eingabefeld (D-S01, geschlossen mit `bcec642b`), ein
              // Primaerknopf war der einzig moegliche Weg vorwaerts. Seither
              // steht der Composer da, und der IST die Primaeraktion. Ein
              // zweiter Primaerknopf daneben, der nichts anderes tut, waere
              // genau die Doppelung, die dieser Audit an vier anderen Stellen
              // ruegt (D-S06, D-S07, D-S23, D-A5). Wo der Composer aber nicht
              // weiterhilft, also kein einziges Modell installiert, steht der
              // Knopf, und er fuehrt an die einzige Stelle, die das aendert.
              //
              // Zur toten Flaeche: kein Layout entfernt Leere, nur Inhalt tut
              // das. Der Block ist deshalb (a) inhaltlich gefuellt und (b) auf
              // die Spaltenbreite `--lu-measure` gelegt. Erfundene
              // Beispiel-Prompts als Fuellmaterial habe ich bewusst nicht
              // gebaut: sie waeren Inhalt, den niemand bestellt hat, und der
              // Audit verlangt sie nicht.
              //
              // 19.09.2026, AUFTRAG: der Block sitzt in beiden Lagen
              // (Chat und Code) MITTIG, nicht mehr unten. Am 05.09.2026 stand
              // hier noch die Regel „unten verankert im Chat, mittig im
              // Code" (`justify-end` fuer Chat, `justify-center` fuer Code):
              // das sollte den Block wie ein Element MIT dem Composer lesen
              // lassen statt als Fleck in der Flaeche darueber. Gemessen am
              // 19.09.2026 (Playwright, headless, Chromium, lokaler
              // Vite-Server) zeigt genau diese Regel den eigentlichen Fehler:
              // im lokalen wie im Cloud-Chat lag die Blockmitte 26 bis 38
              // Prozent der sichtbaren Flaeche zu tief (1100x700 bis
              // 1440x1080, mit und ohne Seitenleiste; die Zahl waechst mit der
              // Fensterhoehe, weil `justify-end` den Block am Composer
              // festnagelt statt an der Mitte). Der Code-Bereich stand mit
              // `justify-center` schon richtig (-0,9 bis -1,5 Prozent, leicht
              // ueber der Mitte). Der Inhaber: „er soll mittig sitzen." Die
              // Bedingung faellt deshalb weg, beide Lagen bekommen dieselbe
              // Regel.
              <motion.div
                key="home"
                className="relative flex-1 flex flex-col items-center justify-center min-h-0 px-3 pb-4"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.2 }}
              >
                {/* The lines the composer raises (a file that is too large,
                    too many attachments) have to be readable before the first
                    message too: a refusal nobody sees is a file that silently
                    did not attach. Same place as in a running chat, the top of
                    the surface and never the prompt field, and out of the
                    flow so the block below stays centred. */}
                <div className="absolute inset-x-0 top-0">
                  <ChatNotices onAttachDocs={() => setRagPanelOpen(true)} />
                </div>
                <div
                  data-testid="chat-landing"
                  className="w-full max-w-[var(--lu-measure)] flex flex-col items-center text-center gap-2"
                >
                  <img
                    src={MONOGRAM}
                    alt=""
                    width={56}
                    height={56}
                    className={`${MONOGRAM_INVERT} opacity-90`}
                  />
                  <h1 className="t-display text-gray-900 dark:text-gray-100">Ask LU anything</h1>
                  <p className="t-body text-gray-500 max-w-[40ch]">{landing.subline}</p>
                  {landing.note && (
                    <p className="t-mono w-full truncate px-4 text-gray-400 dark:text-gray-500" title={landing.note}>
                      {landing.note}
                    </p>
                  )}
                  {landing.cta && (
                    <button onClick={landing.cta.run} className="lu-primary lu-control mt-1">
                      {landing.cta.label}
                    </button>
                  )}

                  {/* The latest chats stand here only while the side panel is
                      collapsed (the owner, web parity). Expanded, the list lives in
                      the panel and would be on screen twice. They come AFTER
                      the headline: the block says where you are first and
                      offers somewhere to go second. */}
                  {!sidebarOpen && (
                    <div className="w-full pt-3 flex flex-col items-center text-left">
                      <RecentChats />
                    </div>
                  )}
                </div>
              </motion.div>
            ) : (
              // ── Active chat ──
              <motion.div
                key="chat"
                className="flex-1 flex flex-col min-w-0 min-h-0"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
              >
                  {/* The plan, for plain chat and for Agent alike. It belongs
                      above the transcript, not at the prompt box: the Chat
                      surface has no right-hand column to hand it to, and a plan
                      is what the run is going to DO, so it reads before the
                      output, not after it. Collapsed by default so it costs one
                      line, and it renders nothing at all while there is no plan,
                      so the empty case costs zero.
                      (Die uebrigen Sitzungsanzeigen sind mit D-S18 unter das
                      Transkript gezogen; der Plan bleibt, weil
                      `the-prompt-window-is-the-prompt-window.test.ts` genau
                      diese Reihenfolge festnagelt.) */}
                  <PlanBar />

                  {/* Der Platz, an den die Zeilen aus dem Composer gezogen
                      sind (21.09.2026: „NICHTS im prompt fenster!").
                      Oben im Verlauf, ruhig, mit x, und ausdruecklich NICHT am
                      Eingabefeld. `ChatNotices` traegt die beiden Zeilen, die
                      im Composer entstehen (ein Dokument gehoert in die Ablage,
                      Modell sieht keine Bilder), `RetrievalErrorBar` den Fehler, dass die
                      Dokumente zu einer Antwort nicht durchsucht wurden. */}
                  <ChatNotices onAttachDocs={() => setRagPanelOpen(true)} />
                  <RetrievalErrorBar />

                  {!activeConvIsEmpty && (
                    <MessageList
                      isGenerating={isGenerating}
                      isThisChatGenerating={activeGenerating}
                      isLoadingModel={isLoadingModel}
                      onRegenerate={regenerateMessage}
                      onRegenerateSpeaker={regenerateSpeaker}
                      onEdit={editAndResend}
                      pendingApprovalId={pendingApproval?.id ?? null}
                      onApprove={approveToolCall}
                      onReject={rejectToolCall}
                    />
                  )}

                  {/* Ein offener, aber noch leerer Chat bekommt an dieser
                      Stelle DENSELBEN Leerzustand wie die Eingangsseite
                      (Zeichen, Ueberschrift, Modellname), statt eines leeren
                      Transkripts. Es ist DERSELBE Flex-Platz, den das
                      Transkript sonst nimmt, also bleibt der Composer, wo er
                      ist.

                      FUND (19.09.2026, N9-Nachtest Windows-Box,
                      box-gruen/n2/BERICHT.md Teil A): die Bedingung war
                      vorher NICHT `activeConvIsEmpty`, sondern
                      `!sidebarOpen && activeConvIsEmpty`
                      (`showRecentsAboveComposer`). Bei aufgeklappter
                      Seitenleiste (dem Normalzustand) rendert dieser
                      Zweig deshalb NIE, `!activeConvIsEmpty` oben aber sehr
                      wohl (activeConversationId ist nach `+ New Chat`
                      sofort gesetzt, `createConversation` in chatStore.ts
                      setzt es synchron). Ergebnis: `<MessageList>` MIT
                      null Nachrichten, die selbst keinen eigenen
                      Leerzustand zeichnet (kein Platzhalter im Baum),
                      ein vollstaendig leerer Hauptbereich, reproduzierbar
                      auch nach vollem Neuladen, bis ein Wechsel auf einen
                      anderen Reiter und zurueck `activeConversationId`
                      ueber `Sidebar.tsx` (Klick auf „Chat") auf `null`
                      zuruecksetzt und damit den ECHTEN Leerzustand weiter
                      oben (`key="home"`) zeigt. Zwei verschiedene Zustaende
                      sahen zufaellig gleich aus, was den Fehler wie ein
                      Flackern wirken liess. Fix: dieselbe Bedingung wie fuer
                      das Transkript, nur umgekehrt, kein `sidebarOpen`
                      mehr davor. Die Liste der letzten Chats bleibt darin
                      NUR bei zugeklappter Seitenleiste (Doppelung sonst,
                      D-S06-Grund unveraendert).

                      Warum zwei bewachte Bloecke statt eines Ternaers, obwohl
                      genau eines von beiden rendert: `zwei-baender-sind-eine-
                      flaeche.test.ts` liest, was zwischen `key="chat"` und dem
                      Transkript steht, und will dort NUR den PlanBar sehen. In
                      einem Ternaer stuende dieser Block textlich davor und
                      zaehlte als drittes Band, obwohl er auf dem Bildschirm
                      an der Stelle des Transkripts sitzt.

                      Mittig, mit dem Zeichen aus `brand.ts`, aus demselben
                      Grund wie die Eingangsseite selbst (D-S05, der Inhaber
                      19.09.2026): am 05.09.2026 stand hier noch „unten
                      verankert ... wie am Composer". Gemessen am 19.09.2026
                      (Playwright, headless): dieselbe Regel gab hier eine
                      Blockmitte 35 bis 42 Prozent der sichtbaren Flaeche zu
                      tief, exakt der Fehler der Eingangsseite, nur an einem
                      zweiten Ort mit demselben Rezept. */}
                  {activeConvIsEmpty && (
                    // Runde 2 (the owner, Auflage A1, review-leer2-offload.md):
                    // `chat-landing` stand vorher auf DIESEM flex-1-Container
                    // selbst, also der sichtbaren Flaeche selbst, nicht auf
                    // dem Inhalt darin. `measureLanding` in
                    // leerzustand-sitzt-mittig.spec.ts nimmt `block.parentElement`
                    // als Flaeche, hier also den AEUSSEREN `motion.div key="chat"`
                    // (PlanBar + dieser Block + Sitzungsleiste + Remote-Baender
                    // zusammen), nicht die eigentliche Restflaeche zwischen
                    // PlanBar und Composer. Fix: `chat-landing` auf den
                    // INNEREN Inhalt (Zeichen, Ueberschrift, Modellname,
                    // Recents), der aeussere `flex-1 justify-center`-Container
                    // bleibt namenlos und ist jetzt die Flaeche, gegen die
                    // gemessen wird, genau wie beim Block der Eingangsseite
                    // oben (Zeile 355-362, dasselbe Rezept).
                    <div className="flex-1 min-h-0 flex flex-col items-center justify-center overflow-y-auto scrollbar-thin py-4 px-3">
                      <div
                        data-testid="chat-landing"
                        className="w-full max-w-[var(--lu-measure)] flex flex-col items-center text-center gap-2"
                      >
                        <img
                          src={MONOGRAM}
                          alt=""
                          width={56}
                          height={56}
                          className={`${MONOGRAM_INVERT} opacity-90`}
                        />
                        <h1 className="t-display text-gray-900 dark:text-gray-100">Ask LU anything</h1>
                        <p className="t-body text-gray-500 max-w-[40ch]">{landing.subline}</p>
                        {landing.note && (
                          <p className="t-mono w-full truncate px-4 text-gray-400 dark:text-gray-500" title={landing.note}>
                            {landing.note}
                          </p>
                        )}
                        {/* home-recent-chats.test.ts, "COUNTER-TEST: a remote
                            session keeps its own screen": Remote traegt schon
                            eigene Baender und einen eigenen Zustand unter dem
                            Transkript, eine Liste letzter Chats darueber waere
                            dort Rauschen, kein Sprungbrett. Deshalb hier
                            zusaetzlich zu `!sidebarOpen` auch `mode !== 'remote'`
                            (Auflage A3, review-leer2-offload.md): der Landing-
                            Block selbst (Zeichen, Ueberschrift, Modellname)
                            gilt fuer Remote genauso, nur die Recents-Liste
                            bleibt seine Ausnahme, unveraendert zum bisherigen
                            Verhalten vor A3. */}
                        {!sidebarOpen && activeConvMode !== 'remote' && (
                          <div className="w-full pt-3 flex flex-col items-center text-left">
                            <RecentChats />
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Die Statusleiste der Sitzung: Agent, Arbeitsordner,
                      Kontext, Memory, Export. Inhaltlich unveraendert; was sich
                      geaendert hat, ist der PLATZ.

                      D-S18, „Drei Baender vor dem ersten Inhalt": Titlebar
                      (h-8), Header (h-10) und diese Leiste. Zwei davon sind
                      Fensterrahmen und globale Navigation und koennen hier
                      nicht weg; die dritte muss aber gar nicht VOR dem
                      Transkript stehen. Nichts hier gehoert zur naechsten
                      Nachricht, es sind Eigenschaften des Laufs, und die
                      liest man, waehrend man tippt, nicht bevor man liest.
                      Also steht sie jetzt UNTER dem Transkript, direkt ueber
                      dem Composer, bei den anderen Sitzungsanzeigen (LoopBar,
                      GoalBar, GroupCostHint). Vor dem ersten Inhalt bleiben
                      zwei Baender.

                      ZWEITER DURCHGANG (01.09.2026): zwei ist die Zahl, und
                      das ist eine Entscheidung, keine Restschuld. Gemessen im
                      laufenden Fenster (Farben aus getComputedStyle):
                      Fensterrahmen, Titlebar und Header tragen DIESELBE
                      Flaeche (hell #e5e7eb, dunkel #141414), ohne Kante und
                      ohne Schatten dazwischen; der Kontrast zwischen Header
                      und Rahmen ist 1.00:1 in beiden Modi. Es liegen also
                      nicht zwei Streifen uebereinander, sondern ein
                      durchgehender Fenstergrund, auf dem die gerundete Pane
                      (#ffffff / #1e1e1e) liegt. Der Schritt von 2 auf 1 waere
                      ein DOM-Schritt ohne Bildschirmwirkung, und im Browser
                      ist es ohnehin nur EIN Streifen, weil die Titlebar
                      ausserhalb von Tauri `null` rendert.

                      Bewacht wird nicht die Entscheidung, sondern ihre
                      Voraussetzung: `chat/__tests__/zwei-baender-sind-eine-
                      flaeche.test.ts` faellt, sobald einer der beiden
                      Streifen eine eigene Flaeche, eine Kante oder einen
                      Schatten bekommt. Dann sind es wieder zwei sichtbare
                      Baender und die Frage ist neu zu stellen.

                      Ausdruecklich NICHT in den Composer hinein: `composerAbove`
                      rendert INNERHALB der Promptbox (ChatInput.tsx:318), und
                      „das promptfenster ist ueberfuellt" ist eine stehende
                      Regel dieses Hauses. Diese Leiste ist ein Geschwister der
                      Box, kein Inhalt darin.

                      Der PlanBar bleibt oben, denn `the-prompt-window-is-the-prompt-
                      window.test.ts` verlangt Plan vor Transkript, und er
                      rendert ohnehin `null`, solange es keinen Plan gibt. */}
                  {/* Auf der Breite der Promptbox, nicht auf der des ganzen
                      Bereichs. Gemessen am Windows-Bau (1296x808): die Leiste
                      war 980,9 px breit gegen 792,3 px Promptbox, ragte also
                      auf jeder Seite 94,3 px darueber hinaus. Der Inhaber,
                      05.09.2026: gleiche Breite, gleiche Mitte, und nie
                      breiter. Der Rahmen ist deshalb WOERTLICH der des
                      Composers, `COMPOSER_MAX_W` plus dessen `px-3`; zwei
                      eigene Zahlen koennten wieder auseinanderlaufen. */}
                  <div className={`w-full ${COMPOSER_MAX_W} mx-auto px-3`}>
                    <div data-testid="chat-session-strip" data-computer-note-yields="" className="flex items-center gap-1.5 px-2 py-0.5">
                      <AgentModeToggle />
                      {appMode === 'cloud' && <HowItWorks topic="agent" variant="mark" placement="above-start" markSize={10} />}
                      {appMode !== 'cloud' && <HowItWorks topic="chats" variant="mark" placement="above-start" markSize={10} />}
                      {/* Was diese Runde kostet, direkt neben dem Agent-Schalter
                          (19.09.2026): kein Band mehr ueber der Eingabe,
                          das diese Leiste nach oben schob, sondern ein Etikett
                          in genau dieser Leiste. Rendert `null` ohne
                          Flash-Modell, verschiebt also nichts, wenn es fehlt. */}
                      <FlashChatNotice />
                      <AgentWorkspaceBadge />
                      {/* GH #200: who answers the next round, and Skip /
                          Stop while one runs. Null outside a group chat. */}
                      <GroupRoundBar onStop={stopGeneration} />

                      {/* Spacer */}
                      <div className="flex-1" />

                      {/* EIN Kontextelement statt zwei (D-S06): der Fuellstand
                          ist die Beschriftung des Fensterwaehlers geworden, statt
                          dieselbe Zahl 24px daneben ein zweites Mal in einer
                          anderen Schreibweise zu zeigen. Die Begruendung samt der
                          beiden Ausweichfaelle steht im Kopf von ContextDropdown. */}
                      <ContextDropdown><TokenCounter /></ContextDropdown>

                      {/* Small-Model Mode, only relevant when the agent loop (tools)
                          is active; plain chat has no tool calls to lean out. */}
                      {isAgentActive && <SmallModelModeToggle />}

                      {/* Memory, standalone, top-right (moved out of the header model
                          picker; 2026-07-11). View / add / delete injected context. */}
                      <MemoryDebugToggle />

                      {/* Shared chats (CHATS-V1.md): this chat on the paired phone. */}
                      <ContinueOnPhoneButton />

                      {/* Export */}
                      <div className="relative">
                        <button
                          onClick={() => setExportOpen(!exportOpen)}
                          className={`${HEADER_CHIP} border-gray-200 dark:border-white/[0.06] hover:border-gray-400 dark:hover:border-white/15 text-gray-500`}
                          title="Export chat"
                        >
                          <Download size={10} />
                        </button>
                        {exportOpen && (
                          <>
                            <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
                            <div ref={exportMenuRef} style={exportMenu.style} className={`absolute right-0 z-50 w-32 rounded-lg lu-elevated py-1 overflow-y-auto scrollbar-thin ${exportMenu.nachOben ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
                              {(['markdown', 'json'] as const).map(fmt => (
                                <button
                                  key={fmt}
                                  onClick={async () => {
                                    const conv = useChatStore.getState().conversations
                                      .find(c => c.id === activeConversationId)
                                    setExportOpen(false)
                                    if (!conv) return
                                    const result = await exportConversation(conv, fmt, useSettingsStore.getState().personas)
                                    if (result.status === 'error') {
                                      setExportToast(result.error ?? 'Could not export chat.')
                                    } else if (result.status === 'saved' && result.path) {
                                      setExportToast(`Saved to ${result.path}.${missingImagesNote(result.missing)}`)
                                    } else if (result.status === 'downloaded') {
                                      setExportToast(`Downloaded .${fmt === 'markdown' ? 'md' : 'json'}`)
                                    }
                                    // status === 'cancelled' → no toast, user closed the dialog
                                  }}
                                  className="w-full text-left px-3 py-1 text-[0.55rem] text-gray-400 hover:bg-white/5 hover:text-gray-200 transition-colors"
                                >
                                  .{fmt === 'markdown' ? 'md' : fmt}
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Remote session banners */}
                  {isThisRemoteActive && (
                    <div className="mx-3 mb-1.5 flex items-center justify-between gap-2 px-2.5 py-1 rounded border border-green-500/25 bg-green-500/5 text-[0.6rem]">
                      <div className="flex items-center gap-1.5 text-green-400">
                        <Radio size={10} className="animate-pulse" />
                        <span className="font-medium">Live</span>
                        <span className="text-green-500/60">
                          {mobileConnectedCount > 0
                            ? `, ${mobileConnectedCount} mobile${mobileConnectedCount === 1 ? '' : 's'} connected`
                            : ', ready for mobile'}
                        </span>
                      </div>
                      <button
                        onClick={handleRemoteReactivate}
                        disabled={remoteLoading}
                        title="Regenerate passcode, keep this chat"
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-blue-400 hover:bg-blue-500/15 border border-blue-500/20 transition-all disabled:opacity-50"
                      >
                        <RefreshCw size={9} className={remoteLoading ? 'animate-spin' : ''} />
                        Restart
                      </button>
                    </div>
                  )}
                  {isThisRemoteStopped && (
                    <div
                      className={
                        'mx-3 mb-1.5 flex items-start justify-between gap-2 px-2.5 py-1 rounded border text-[0.6rem] ' +
                        (remoteError
                          ? 'border-red-500/30 bg-red-500/5'
                          : 'border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02]')
                      }
                    >
                      <div className={'flex flex-col gap-0.5 min-w-0 ' + (remoteError ? 'text-red-400' : 'text-gray-500')}>
                        <div className="flex items-center gap-1.5">
                          <Radio size={10} />
                          <span className="font-medium">Server stopped</span>
                          <span className={remoteError ? 'text-red-400/70' : 'text-gray-500/70'}>
                            {remoteError ? ', last attempt failed' : ', restart to reconnect mobile'}
                          </span>
                        </div>
                        {/* #29: surface the actual reason (port in use,
                            firewall, etc.) so the user knows why Restart is
                            not coming back, instead of staring at a button
                            that does nothing. */}
                        {remoteError && (
                          <div className="text-[0.55rem] text-red-300/80 break-words pl-4 leading-snug">
                            {remoteError}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {remoteError && (
                          <button
                            onClick={remoteClearError}
                            title="Dismiss error"
                            className="p-0.5 rounded text-red-400/70 hover:text-red-300 hover:bg-red-500/15 transition-colors"
                          >
                            <X size={9} />
                          </button>
                        )}
                        <button
                          onClick={handleRemoteReactivate}
                          disabled={remoteLoading}
                          title="Start a fresh server and reattach this chat"
                          className={
                            'flex items-center gap-1 px-2 py-0.5 rounded transition-all disabled:opacity-50 font-medium ' +
                            (remoteError
                              ? 'text-red-300 hover:bg-red-500/15 border border-red-500/40'
                              : 'text-green-400 hover:bg-green-500/15 border border-green-500/30')
                          }
                        >
                          <RefreshCw size={9} className={remoteLoading ? 'animate-spin' : ''} />
                          {remoteError ? 'Retry' : 'Restart'}
                        </button>
                      </div>
                    </div>
                  )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Die stehenden Sitzungsbaender: UEBER dem Kasten, nicht darin.
              `composerAbove` rendert INNERHALB der Promptbox, und dort darf
              seit dem 21.09.2026 nichts mehr stehen, was der Nutzer nur liest.
              LoopBar und GoalBar sind Bedienelemente (Bremse, Loeschen) und
              bleiben sichtbar, nur eine Etage hoeher; die Wartezeile der
              lokalen Spur ist ein Hinweis und war vorher im Kasten. */}
          <LoopBar onStop={stopGeneration} />
          <GoalBar />
          <LocalLaneWaitLine
            waiting={!!queuedForLocalLane}
            queuePosition={localLaneQueuePosition}
            onApproval={waitingOnApproval}
            onApprovalIn={localLaneHolderTitle}
          />

          {/* Code mode brings its own composer (CodexView above). */}
          <ChatInput
            onSend={sendMessage}
            modelReady={chatModelReady}
            onStop={stopGeneration}
            isGenerating={busy.thisChat || queuedForLocalLane}
            waitingForLocalLane={queuedForLocalLane}
            pendingApproval={pendingApproval}
            onApprove={approveToolCall}
            onReject={rejectToolCall}
            // Commands need the tool catalog to drive, which only Agent
            // mode has here. Plain chat leaves "/cmd" as ordinary text.
            slashCommands={isAgentActive ? 'agent' : 'chat'}
            // Agent mode copies attached files into the working folder;
            // plain chat hands the model a summary of them.
            filesReachTools={isAgentActive}
            composerModel={
              /* What this chat's answers were written by rides on the
                 picker itself now, as a dot plus a tooltip, instead of a
                 second chip in the row (Meldung 4, R5 re-measure; the owner
                 2026-09-02 wanted it hidden away). */
              <ModelSelector openUpward answeredBy={conversationModelHint} />
            }
            // No plan lives here. The prompt window is the prompt window
            // (2026-08-22): the plan band sits in the session strip
            // above, next to the other standing status controls.
            // Was HIER noch steht, ist genau eine Zeile, und sie steht
            // unter Vorbehalt: `GroupCostHint` sagt, was der naechste Enter
            // kostet („1 round = 3 answers = 3x the cost"). Geld wird nicht
            // stumm geschaltet, ohne dass der Eigner es entschieden hat, und
            // die Zeile gibt es ueberhaupt nur in einem Gruppenchat. Alles
            // andere, was hier stand, ist ausgezogen (siehe oben).
            composerAbove={<GroupCostHint />}
            composerActions={
              <>
                {/* Documents (RAG), shown in both modes since A9. In
                    Cloud mode without an embedding lane it stays visible
                    and says what is missing. */}
                <DocsButton
                  availability={docs}
                  open={ragPanelOpen}
                  ragEnabled={ragEnabled}
                  docCount={docCount}
                  onToggle={() => setRagPanelOpen(!ragPanelOpen)}
                />

                {/* Plugins (Chat Tools + Caveman + Personas) */}
                <PluginsDropdown openUpward agentTools={isAgentActive} />

                {/* Tools: agent permission overrides (only when agent active) */}
                {isAgentActive && (
                  <div className="relative">
                    <button
                      onClick={() => setToolsDropdownOpen(!toolsDropdownOpen)}
                      aria-expanded={toolsDropdownOpen}
                      className="lu-control"
                    >
                      {/* Kein eigener Gruenton mehr: das Icon erbt die
                          Farbe des Controls, sonst traegt ein neutrales
                          Control wieder einen Akzent von sich aus. */}
                      <Wrench size={11} />
                      <span>Tools</span>
                      <ChevronDown size={9} className={`transition-transform ${toolsDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {toolsDropdownOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setToolsDropdownOpen(false)} />
                        <div ref={toolsMenuRef} style={toolsMenu.style} className={`absolute left-0 z-50 w-28 rounded-md lu-elevated py-0.5 px-0.5 overflow-y-auto scrollbar-thin ${toolsMenu.nachOben ? 'bottom-full mb-0.5' : 'top-full mt-0.5'}`}>
                          <PermissionOverrideBar />
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            }
          />
          </>)}
        </div>

        {/* RAG Panel */}
        <AnimatePresence>
          {ragPanelOpen && activeConversationId && (
            <ErrorBoundary fallbackClassName="w-[280px] shrink-0 h-full border-l border-gray-200 dark:border-white/5 bg-white dark:bg-lu-overlay flex flex-col items-center justify-center p-6 gap-3">
              <RAGPanel conversationId={activeConversationId} onClose={() => setRagPanelOpen(false)} />
            </ErrorBoundary>
          )}
        </AnimatePresence>

        {/* Hintergrundagenten, ganz aussen rechts.
            HIER und nicht in CodexView, obwohl der Code-Modus eigene Spalten
            hat: diese eine Montage deckt BEIDE Bereiche ab, weil CodexView
            innerhalb dieser Zeile gerendert wird. Im Code-Modus steht das
            Panel damit rechts NEBEN dem Explorer statt in ihm, zwei
            Spalten mit zwei Aufgaben, und keine musste die andere aufnehmen.
            Es rendert `null`, solange diese Konversation keine
            Hintergrundaufgabe hat, also auch im normalen Chat immer: dort
            kommt `delegate_task` gar nicht erst in die Werkzeugliste
            (CHAT_TOOLS), festgehalten in multiagent-nicht-im-chat.test.ts. */}
        <AgentPanel />
      </div>

      {/* Export toast */}
      <AnimatePresence>
        {exportToast && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.18 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] px-4 py-2 rounded-lg bg-white dark:bg-lu-panel border border-green-600/40 dark:border-green-500/30 text-green-700 dark:text-green-400 text-[0.7rem] shadow-xl max-w-[min(90vw,520px)] truncate"
          >
            {exportToast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
