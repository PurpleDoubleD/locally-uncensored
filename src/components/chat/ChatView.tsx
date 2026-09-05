import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useChat } from '../../hooks/useChat'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useRAGStore } from '../../stores/ragStore'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { AgentPanel } from './AgentPanel'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { RAGPanel } from './RAGPanel'
import { DocsButton } from './DocsButton'
import { RetrievalErrorBar } from './RetrievalErrorBar'
import { LuEngineSwitchBar } from './LuEngineSwitchBar'
import { useDocsAvailability } from '../../hooks/useDocsAvailability'
import { AgentModeToggle } from './AgentModeToggle'
import { AgentWorkspaceBadge } from './AgentWorkspaceBadge'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { useSettingsStore } from '../../stores/settingsStore'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'
import { ChevronDown, Download, Wrench, Radio, RefreshCw, X } from 'lucide-react'
import { PluginsDropdown } from './PluginsDropdown'
import { ModelSelector } from '../models/ModelSelector'
import { useConversationModelHint } from './ConversationModelNote'
import { GoalBar } from './GoalBar'
import { PlanBar } from './PlanBar'
import { LoopBar } from './LoopBar'
import { GroupCostHint } from './GroupCostHint'
import { MemoryDebugToggle } from './MemoryDebugPanel'
import { TokenCounter } from './TokenCounter'
import { ContextDropdown } from './ContextDropdown'
import { SmallModelModeToggle } from './SmallModelModeToggle'
import { ABCompare } from './ABCompare'
import { RecentChats } from './RecentChats'
import { useUIStore } from '../../stores/uiStore'
import { useCompareStore } from '../../stores/compareStore'
import { exportConversation } from '../../lib/chat-export'
import { PermissionOverrideBar } from './PermissionOverrideBar'
import { CodexView } from './CodexView'
import { useCodexStore } from '../../stores/codexStore'
import { useGenerationStore } from '../../stores/generationStore'
import { useRemoteStore } from '../../stores/remoteStore'
import { displayModelName } from '../../api/providers'
import { MONOGRAM, MONOGRAM_INVERT } from '../layout/brand'

/** Was die Eingangsseite sagt und anbietet, je nach Lage. */
interface Landing {
  readonly subline: string
  /** Zweite Zeile, einzeilig gekuerzt, heute der Name des Modells. */
  readonly note?: string
  readonly cta: { readonly label: string; readonly run: () => void } | null
}

export function ChatView() {
  const { sendMessage, stopGeneration, isGenerating, isLoadingModel, regenerateMessage, editAndResend, pendingApproval, approveToolCall, rejectToolCall } = useChat()
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
  // has said. Screen check on the bundle (David, 2026-09-02): after New Chat the
  // main area went blank, because the recent list only stood on the no-chat
  // screen.
  //
  // Derived INSIDE the selector for the reason above: the answer is a boolean,
  // so it survives every streaming flush untouched and only re-renders on the
  // one frame where it actually flips.
  const activeConvIsEmpty = useChatStore((s) => {
    const conv = s.conversations.find((c) => c.id === s.activeConversationId)
    if (!conv || (conv.mode ?? 'lu') !== 'lu') return false
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

  // Per-conversation generating flag (David 2026-06-12): the typing indicator
  // + realtime counter must show ONLY in the chat that is actually generating,
  // not in every other chat the user switches to. `isGenerating` from the hook
  // is global (and stays so for the input, where it guards shared stream refs);
  // the visual indicators below read this conversation-scoped map instead.
  const generatingMap = useGenerationStore((s) => s.generating)
  const activeGenerating = !!activeConversationId && !!generatingMap[activeConversationId]

  const docCount = useRAGStore((s) =>
    activeConversationId ? (s.documents[activeConversationId] || []).length : 0
  )
  const ragEnabled = useRAGStore((s) =>
    activeConversationId ? s.ragEnabled[activeConversationId] ?? false : false
  )
  // Docs (RAG) needs a LOCAL EMBEDDINGS backend, which is not the same thing as
  // a local CHAT backend. That mix-up is what hid the button in Cloud mode until
  // A9 (aldrich_ironhart, 2026-09-01). The embeddings sidecar on 127.0.0.1:8128
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
  // While the panel is collapsed and the open chat is still empty, the recent
  // list belongs above the composer instead of nowhere at all.
  const showRecentsAboveComposer = !sidebarOpen && activeConvIsEmpty
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
      await remoteRestart(activeConv.model, activeConv.systemPrompt)
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
      ? { subline: 'Pick a model in the box below, then type.', cta: null }
      // Der Modellname steht auf einer EIGENEN Zeile und wird gekuerzt: er ist
      // haeufig 50+ Zeichen lang (`hf.co/DevQuasar/huihui-ai_Qwen3-4B-abliterated-GGUF`),
      // und im Fliesstext liess er die Zeile dreimal umbrechen.
      : { subline: 'Type below to start.', note: displayModelName(activeModel), cta: null }

  return (
    <div className="h-full flex flex-col min-w-0">
      {/* One composer, two places. The landing state used to render a logo and
          nothing else, so the screen you arrive on had no input field at all.
          sendMessage creates the conversation when none is active (useChat.ts),
          so the same element serves both branches, and it has to stay OUTSIDE
          the AnimatePresence as ONE instance: a second copy per branch would
          drop the draft the moment the first message creates the conversation,
          which is worse than having no input field at all. */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        <div className="flex-1 flex flex-col min-w-0 relative">
          {chatMode === 'codex' && activeConversationId ? (
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
              // das. Der Block ist deshalb (a) inhaltlich gefuellt, (b) auf die
              // Spaltenbreite `--lu-measure` gelegt und (c) im Chat UNTEN
              // verankert, damit er mit dem Composer als ein Element liest
              // statt als Fleck in einem Feld. Erfundene Beispiel-Prompts als
              // Fuellmaterial habe ich bewusst nicht gebaut: sie waeren Inhalt,
              // den niemand bestellt hat, und der Audit verlangt sie nicht.
              //
              // Im Code-Bereich steht er MITTIG, und das ist kein Widerspruch,
              // sondern dieselbe Regel unter anderer Voraussetzung: dort
              // rendert dieser Zweig ohne Composer (der Code-Composer haengt an
              // CodexView und damit an einer offenen Unterhaltung, siehe
              // `chatMode !== 'codex'` weiter unten). Der Block klebte deshalb
              // am unteren Fensterrand, ohne dass etwas darunter stand, an das
              // er sich haette anlehnen koennen. Gemessen am Windows-Bau
              // (1296x808): Blockmitte y=699,9 gegen Bereichsmitte y=445,4,
              // also 254,5 px zu tief. David, 05.09.2026: „genau mittig".
              <motion.div
                key="home"
                className={`flex-1 flex flex-col items-center min-h-0 px-3 pb-4 ${
                  chatMode === 'codex' ? 'justify-center' : 'justify-end'
                }`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.2 }}
              >
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
                      collapsed (David, web parity). Expanded, the list lives in
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

                  {!showRecentsAboveComposer && (
                    <MessageList
                      isGenerating={isGenerating}
                      isThisChatGenerating={activeGenerating}
                      isLoadingModel={isLoadingModel}
                      onRegenerate={regenerateMessage}
                      onEdit={editAndResend}
                      pendingApprovalId={pendingApproval?.id ?? null}
                      onApprove={approveToolCall}
                      onReject={rejectToolCall}
                    />
                  )}

                  {/* Ein offener, aber noch leerer Chat bekommt an dieser
                      Stelle die Liste der letzten Chats statt eines leeren
                      Transkripts (David, 2026-09-02: nach „New Chat" stand der
                      Hauptbereich blank da). Es ist DERSELBE Flex-Platz, den
                      das Transkript sonst nimmt, also bleibt der Composer, wo
                      er ist.

                      Warum zwei bewachte Bloecke statt eines Ternaers, obwohl
                      genau eines von beiden rendert: `zwei-baender-sind-eine-
                      flaeche.test.ts` liest, was zwischen `key="chat"` und dem
                      Transkript steht, und will dort NUR den PlanBar sehen. In
                      einem Ternaer stuende dieser Block textlich davor und
                      zaehlte als drittes Band, obwohl er auf dem Bildschirm
                      an der Stelle des Transkripts sitzt.

                      Unten verankert und mit dem Zeichen aus `brand.ts`, aus
                      demselben Grund wie die Eingangsseite selbst (D-S05): ein
                      Block, der in der Mitte einer leeren Flaeche schwebt,
                      liest als Fleck; unten am Composer liest er als ein
                      Element mit ihm. */}
                  {showRecentsAboveComposer && (
                    <div className="flex-1 min-h-0 flex flex-col items-center justify-end overflow-y-auto scrollbar-thin py-4">
                      <img
                        src={MONOGRAM}
                        alt=""
                        width={56}
                        height={56}
                        className={`${MONOGRAM_INVERT} opacity-90 mb-5`}
                      />
                      <RecentChats />
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
                  <div data-testid="chat-session-strip" className="flex items-center gap-1.5 px-2 py-0.5">
                    <AgentModeToggle />
                    <AgentWorkspaceBadge />

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
                        picker; David 2026-07-11). View / add / delete injected context. */}
                    <MemoryDebugToggle />

                    {/* Export */}
                    <div className="relative">
                      <button
                        onClick={() => setExportOpen(!exportOpen)}
                        className="flex items-center gap-1 px-2 py-0.5 rounded border border-gray-200 dark:border-white/[0.06] hover:border-gray-400 dark:hover:border-white/15 text-gray-500 transition-colors text-[0.55rem]"
                        title="Export chat"
                      >
                        <Download size={10} />
                      </button>
                      {exportOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
                          <div className="absolute right-0 top-full mt-1 z-50 w-32 rounded-lg bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 shadow-xl py-1">
                            {(['markdown', 'json'] as const).map(fmt => (
                              <button
                                key={fmt}
                                onClick={async () => {
                                  const conv = useChatStore.getState().conversations
                                    .find(c => c.id === activeConversationId)
                                  setExportOpen(false)
                                  if (!conv) return
                                  const result = await exportConversation(conv, fmt)
                                  if (result.status === 'saved' && result.path) {
                                    setExportToast(`Saved to ${result.path}`)
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

          {/* Code mode brings its own composer, so it stays out of this one. */}
          {chatMode !== 'codex' && (
            <ChatInput
              onSend={sendMessage}
              onStop={stopGeneration}
              isGenerating={isGenerating}
              pendingApproval={pendingApproval}
              onApprove={approveToolCall}
              onReject={rejectToolCall}
              // Commands need the tool catalog to drive, which only Agent
              // mode has here. Plain chat leaves "/cmd" as ordinary text.
              slashCommands={isAgentActive ? 'agent' : 'chat'}
              onAttachDocs={() => setRagPanelOpen(true)}
              composerModel={
                /* What this chat's answers were written by rides on the
                   picker itself now, as a dot plus a tooltip, instead of a
                   second chip in the row (Meldung 4, R5 re-measure; David
                   2026-09-02 wanted it hidden away). */
                <ModelSelector openUpward answeredBy={conversationModelHint} />
              }
              // No plan lives here. The prompt window is the prompt window
              // (David, 2026-08-22): the plan band sits in the session strip
              // above, next to the other standing status controls.
              composerAbove={<><LuEngineSwitchBar /><RetrievalErrorBar /><LoopBar onStop={stopGeneration} /><GoalBar /><GroupCostHint /></>}
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
                  <PluginsDropdown openUpward />

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
                          <div className="absolute left-0 bottom-full mb-0.5 z-50 w-28 rounded-md bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 shadow-xl py-0.5 px-0.5">
                            <PermissionOverrideBar />
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              }
            />
          )}
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
