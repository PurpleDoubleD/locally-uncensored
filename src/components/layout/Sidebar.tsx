import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Search, Trash2, Edit3, Check, X, MessageSquare, Code, Radio, Copy, RefreshCw, Square, Wifi, Globe, QrCode, PanelLeftOpen, PanelLeftClose } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useUIStore } from '../../stores/uiStore'
import { useCompareStore } from '../../stores/compareStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCodexStore } from '../../stores/codexStore'
import { useRemoteStore, REMOTE_DEV_MODE_ERROR } from '../../stores/remoteStore'
import { workspaceRejectedMessage } from '../../lib/workspace-rejected'
import { backendCall, isTauri } from '../../api/backend'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'
import {
  conversationMatches, sameSidebarRows, toSidebarRow, type SidebarRow,
} from './sidebar-rows'

export function Sidebar() {
  // Gezielte Selektoren, durchgehend. Ein Abo auf den ganzen Store hat die
  // Seitenleiste einmal pro Bild neu gezeichnet, solange eine Antwort lief,
  // und zwar auch dann, wenn eine andere Ansicht auf dem Schirm stand, weil
  // AppShell die Seitenleiste bedingungslos mountet.
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const createConversation = useChatStore((s) => s.createConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const renameConversation = useChatStore((s) => s.renameConversation)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen)
  const sidebarWidth = useUIStore((s) => s.sidebarWidth)
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth)
  const setView = useUIStore((s) => s.setView)
  const currentView = useUIStore((s) => s.currentView)
  // A/B Compare takes the whole chat area, so neither rail nor panel belongs
  // on screen while it runs. AppShell already unmounts us there; this keeps
  // the rule readable in one place, the way apps/web does it.
  const isComparing = useCompareStore((s) => s.isComparing)
  const activeModel = useModelStore((s) => s.activeModel)
  const getActivePersona = useSettingsStore((s) => s.getActivePersona)
  const personasEnabled = useSettingsStore((s) => s.settings.personasEnabled)
  const chatMode = useCodexStore((s) => s.chatMode)
  const setChatMode = useCodexStore((s) => s.setChatMode)
  const remoteEnabled = useRemoteStore((s) => s.enabled)
  const passcode = useRemoteStore((s) => s.passcode)
  const passcodeExpiresAt = useRemoteStore((s) => s.passcodeExpiresAt)
  const lanUrl = useRemoteStore((s) => s.lanUrl)
  const mobileUrl = useRemoteStore((s) => s.mobileUrl)
  const qrPngBase64 = useRemoteStore((s) => s.qrPngBase64)
  const remoteLoading = useRemoteStore((s) => s.loading)
  const remoteError = useRemoteStore((s) => s.error)
  const tunnelActive = useRemoteStore((s) => s.tunnelActive)
  const tunnelUrl = useRemoteStore((s) => s.tunnelUrl)
  const tunnelLoading = useRemoteStore((s) => s.tunnelLoading)
  const awaitingTunnel = useRemoteStore((s) => s.awaitingTunnel)
  const qrVisible = useRemoteStore((s) => s.qrVisible)
  const hideQr = useRemoteStore((s) => s.hideQr)
  const refreshDevices = useRemoteStore((s) => s.refreshDevices)
  const dispatchedConversationId = useRemoteStore((s) => s.dispatchedConversationId)
  const dispatch = useRemoteStore((s) => s.dispatch)
  const undispatch = useRemoteStore((s) => s.undispatch)
  const regenerateToken = useRemoteStore((s) => s.regenerateToken)
  const restart = useRemoteStore((s) => s.restart)

  // The list subscribes to the PROJECTION, not to `conversations`. The array
  // itself is replaced on every streaming flush; the projected rows are not,
  // so the selector hands back the very same array and React skips the render.
  const rowCache = useRef<SidebarRow[]>([])
  const rows = useChatStore((s) => {
    const next = s.conversations.map(toSidebarRow)
    if (sameSidebarRows(rowCache.current, next)) return rowCache.current
    rowCache.current = next
    return next
  })
  // Waehrend des Ziehens laeuft KEINE Animation: framer-motion faehrt sonst
  // jede Zwischenbreite ueber 0,15 s an, und der Griff haengt sichtbar hinter
  // dem Zeiger zurueck. Das Auf- und Zuklappen behaelt seine Animation.
  const [ziehend, setZiehend] = useState(false)
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [countdown, setCountdown] = useState('')
  const [dispatchPicker, setDispatchPicker] = useState(false)
  const [qrModalOpen, setQrModalOpen] = useState(false)
  // Dieselbe Luecke wie in ChatView: das Zeilenmenue weiter unten hatte seinen
  // Escape-Pfad, diese beiden Flaechen nie. Eine Datei mit drei Flaechen kam
  // durch, weil EINE davon gepflegt war.
  useDismissOnEscape(dispatchPicker, () => setDispatchPicker(false))
  useDismissOnEscape(qrModalOpen, () => setQrModalOpen(false))
  // Right-click menu on a conversation row. sweenscapehub searched the whole
  // app and right-clicked the chats before asking in Discord how to delete one
  // (2026-07-30): the buttons existed, but at 10 px and only on hover, and the
  // gesture everyone tries first did nothing at all.
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  /**
   * Was zuletzt geloescht wurde, fuer die Vorlesehilfe.
   *
   * Ein Tester hat am 05.09.2026 gemessen, dass nach dem Loeschen NICHTS
   * zurueckkommt: keine Rueckfrage, kein Rueckgaengig, und der `aria-live`-
   * Bereich blieb leer. Wer sieht, merkt es an der verschwundenen Zeile. Wer
   * sich vorlesen laesst, erfaehrt gar nichts, und das wiegt hier schwerer als
   * sonst: der Tabstopp "Delete chat" folgt unmittelbar auf "Rename chat", ein
   * Enter zu frueh und der Chat ist weg. Ohne Ansage weiss man nicht einmal,
   * DASS es passiert ist.
   */
  const [zuletztGeloescht, setZuletztGeloescht] = useState<string | null>(null)

  /** Loeschen aus der Liste, mit Ansage. Die automatische Aufraeumung eines
   *  gescheiterten Fernauftrags geht bewusst nicht hier durch: sie ist keine
   *  Handlung des Nutzers und braucht keine Rueckmeldung. */
  const loescheChatMitAnsage = (id: string, titel: string) => {
    deleteConversation(id)
    setZuletztGeloescht(titel.trim() || 'Untitled chat')
  }

  const isCodingMode = chatMode === 'codex'
  const isRemoteMode = chatMode === 'remote'

  // Filter conversations by current mode
  const modeConversations = useMemo(
    () => rows.filter((r) => r.mode === chatMode),
    [rows, chatMode],
  )

  // The corpus scan used to run inside the render body against the RAW query,
  // so every streaming frame re-lowercased every message of every chat while
  // the search box had focus. It now runs in a memo keyed on the projected
  // rows (which stand still during streaming) and on a deferred query, and it
  // reads the message bodies through getState() — the bodies must not be part
  // of this component's subscription, or the projection above would be moot.
  const deferredSearch = useDeferredValue(search)
  const needle = deferredSearch.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!needle) return null
    // `rows` is both the freshness signal and the id allowlist: a chat that is
    // not in the projection cannot be in the result list either.
    const known = new Set(rows.map((r) => r.id))
    const hits = new Set<string>()
    for (const c of useChatStore.getState().conversations) {
      if (known.has(c.id) && conversationMatches(c, needle)) hits.add(c.id)
    }
    return hits
  }, [needle, rows])

  const filtered = useMemo(
    () => (matches ? modeConversations.filter((r) => matches.has(r.id)) : modeConversations),
    [matches, modeConversations],
  )

  const handleNewChat = () => {
    if (!activeModel) {
      // No model is active — clicking New Chat used to silently do nothing
      // (mylogz, Discord 2026-06-17: "cant make a new chat"). That happens
      // when no model is installed/selected, or the model list hasn't
      // populated yet. Send the user to the Models page where they can
      // install or pick one, instead of a dead click with no feedback.
      // Cloud mode hides that local-hardware view entirely (the hosted
      // catalog is just still loading/failed) — stay in chat there.
      if (useSettingsStore.getState().settings.appMode === 'cloud') return
      setView('models')
      return
    }
    // David's request: persona starts OFF on every new chat. We still
    // store the globally-selected persona's prompt as the conv's
    // systemPrompt (so toggling personaEnabled later "just works"
    // without re-reading global state), but useChat / useAgentChat
    // only apply it when personaEnabled === true.
    const persona = personasEnabled ? getActivePersona() : null
    createConversation(activeModel, persona?.systemPrompt || '', chatMode)
    setView('chat')
  }

  const handleDispatch = async (mode: 'lan' | 'internet') => {
    setDispatchPicker(false)
    if (!activeModel) return

    // Reported by @phantomderp on v2.4.2: clicking LAN/Internet from
    // `npm run dev` produced an HTTP 404 + cryptic JSON.parse error
    // because the dev server can't host the Rust HTTP server / JWT auth /
    // Cloudflare tunnel that Remote needs. Bail early with a clear,
    // actionable banner before we burn user time on the folder picker
    // and create a doomed conversation row. The store's startServer()
    // also throws REMOTE_DEV_MODE_ERROR for any future caller that
    // bypasses this guard.
    if (!isTauri()) {
      useRemoteStore.setState({ error: REMOTE_DEV_MODE_ERROR })
      return
    }

    // #29 follow-up: ask the user where the agent should write files for
    // this remote session BEFORE starting the server. Cancel = bail, no
    // orphan conv. Skip = keep `~/agent-workspace/<slug>/` default. The
    // path goes into a "__remote__" workspace override on the desktop;
    // every agent-tool call from mobile during this session resolves
    // relative paths against it.
    let pickedFolder: string | null = null
    try {
      const result = await backendCall<string | null>('pick_folder', {
        defaultPath: undefined,
      })
      // pick_folder returns null if user cancelled — abort the dispatch.
      if (result === null) return
      pickedFolder = result
    } catch {
      // pick_folder is best-effort UX; if it errors (e.g. dev/browser
      // mode without Tauri), proceed without an override.
      pickedFolder = null
    }

    if (pickedFolder) {
      try {
        await backendCall('set_chat_workspace_override', {
          chatId: '__remote__',
          path: pickedFolder,
        })
      } catch (e) {
        // Hier stand bis zum 04.09.2026 ein LEERES catch mit dem Kommentar
        // "Override is a nice-to-have", und der Auftrag fuhr trotzdem los.
        //
        // Seit 2.6.8 lehnt die Rust-Seite verbotene Wurzeln ab ($HOME genau,
        // /, /etc, ~/.ssh, C:\Windows). Das Verschlucken hatte zwei Folgen,
        // und die zweite ist die ernstere: der else-Zweig darunter, der eine
        // alte Bindung raeumt, lief in diesem Fall NICHT. Stand in
        // chat_workspace_overrides noch der Ordner eines frueheren Dispatchs
        // derselben App-Sitzung, arbeitete der Agent WEITER IM ALTEN ORDNER,
        // waehrend der Nutzer glaubte, gerade einen anderen gewaehlt zu haben.
        //
        // Also erst raeumen, dann reden, dann abbrechen. Abbrechen und nicht
        // durchlaufen, weil der Nutzer einen Ordner gewaehlt hat: ihn
        // stattdessen still in der Sandbox arbeiten zu lassen waere wieder
        // eine stille Abweichung, nur eine andere. Der Abbruch ist derselbe
        // wie beim Abbrechen des Dialogs weiter oben.
        try {
          await backendCall('set_chat_workspace_override', {
            chatId: '__remote__',
            path: null,
          })
        } catch {
          // Das Raeumen selbst darf die Meldung nicht verschlucken. Schlaegt
          // auch das fehl, ist der Abbruch erst recht richtig.
        }
        useRemoteStore.setState({ error: workspaceRejectedMessage(pickedFolder, e) })
        return
      }
    } else {
      // No folder picked → ensure no stale override from a previous
      // dispatch sticks around.
      try {
        await backendCall('set_chat_workspace_override', {
          chatId: '__remote__',
          path: null,
        })
      } catch { /* no-op */ }
    }

    // Remote dispatch — same default-OFF rule. The conv stores the global
    // persona prompt for later opt-in via the toggle, but it is NOT sent
    // to the mobile server as the dispatched system prompt. Mobile starts
    // clean (autonomy contract or codex prompt only). Without this, a
    // global "Devil's Advocate" persona silently hijacked every remote
    // session through `dispatchedSystemPrompt` on the mobile side.
    const persona = personasEnabled ? getActivePersona() : null
    const convId = createConversation(activeModel, persona?.systemPrompt || '', 'remote')
    setView('chat')
    // For internet mode, suppress the QR until the Cloudflare tunnel is
    // verified up (David 2026-06-15). Set this BEFORE dispatch() so the LAN
    // QR fetched during startServer never flashes. LAN mode shows the QR
    // immediately (no tunnel to wait for).
    useRemoteStore.setState({ awaitingTunnel: mode === 'internet' })
    try {
      await dispatch(convId, activeModel, '')
    } catch {
      // #29: server failed to start (port in use, firewall, etc.). The
      // store has the user-facing reason in `error` — drop the orphan
      // conversation row so the user isn't stranded on a chat tied to a
      // server that never came up. The error banner still surfaces in
      // ChatView so the user can act on it (e.g. close another LU
      // instance, then click Dispatch again).
      useRemoteStore.setState({ awaitingTunnel: false })
      deleteConversation(convId)
      return
    }
    // Auto-start tunnel for internet mode. startTunnel() clears awaitingTunnel
    // once Cloudflare is verified serving (or it fails), which reveals the QR.
    if (mode === 'internet') {
      useRemoteStore.getState().startTunnel()
    }
  }

  const handleRename = (id: string) => {
    if (editTitle.trim()) {
      renameConversation(id, editTitle.trim())
    }
    setEditingId(null)
  }

  /**
   * Kopieren sagte bisher nichts. Vier Knoepfe in diesem Panel schrieben in
   * die Zwischenablage und sahen danach aus wie davor — man klickte zweimal,
   * weil man es nicht wusste (Audit Welle 3).
   *
   * Das Rezept ist das aus `chat/CodeBlock.tsx`, nicht ein zweites: ein
   * `copied`-Zustand, gesetzt beim Kopieren, nach 2000 ms zurueck, und das
   * Glyph wechselt `Copy` → `Check`. Ein einziger Unterschied, und der ist
   * erzwungen: CodeBlock hat EINEN Knopf und kommt mit einem Boolean aus,
   * hier sind es vier, also merkt sich der Zustand WELCHER. Aus demselben
   * Grund raeumt der Timer funktional auf (`c === was ? null : c`) — sonst
   * loeschte der Timer des ersten Klicks die Rueckmeldung des zweiten.
   *
   * Und weil diese vier Knoepfe im Gegensatz zu CodeBlock keine
   * Beschriftung haben, wechselt zusaetzlich der zugaengliche Name: dort
   * traegt das Wort „Copied" die Rueckmeldung, hier muss es das Label tun.
   */
  const [copied, setCopied] = useState<string | null>(null)

  const copyToClipboard = (text: string, was: string) => {
    navigator.clipboard.writeText(text)
    setCopied(was)
    setTimeout(() => setCopied((c) => (c === was ? null : c)), 2000)
  }

  // Auto-hide the QR panel (a) as soon as the dispatched conversation
  // receives its first message, OR (b) as soon as a mobile has authenticated.
  // refreshDevices() itself sets qrVisible=false when devices.length > 0,
  // so here we only need to keep the polling alive.
  // Just the COUNT, straight out of the store: a number changes when a message
  // lands, not on every token of it, so the QR panel's auto-hide no longer
  // drags the whole sidebar along for the ride.
  const dispatchedMessageCount = useChatStore((s) =>
    dispatchedConversationId
      ? s.conversations.find((c) => c.id === dispatchedConversationId)?.messages.length ?? 0
      : 0,
  )
  useEffect(() => {
    if (qrVisible && dispatchedMessageCount > 0) hideQr()
  }, [qrVisible, dispatchedMessageCount, hideQr])
  useEffect(() => {
    if (!rowMenu) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setRowMenu(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rowMenu])
  // While the QR is visible, poll the connected-device list often so we
  // auto-hide it the moment the user's phone authenticates.
  useEffect(() => {
    if (!remoteEnabled || !qrVisible) return
    refreshDevices()
    const t = setInterval(refreshDevices, 2000)
    return () => clearInterval(t)
  }, [remoteEnabled, qrVisible, refreshDevices])

  // Passcode countdown
  useEffect(() => {
    if (!passcodeExpiresAt || !remoteEnabled) {
      setCountdown('')
      return
    }
    let regenerating = false
    const tick = () => {
      const remaining = passcodeExpiresAt - Math.floor(Date.now() / 1000)
      if (remaining <= 0) {
        setCountdown('Expired')
        if (!regenerating) {
          regenerating = true
          regenerateToken()
        }
      } else {
        const min = Math.floor(remaining / 60)
        const sec = remaining % 60
        setCountdown(`${min}:${sec.toString().padStart(2, '0')}`)
      }
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
    // `regenerateToken` ist eine Store-Action mit fester Referenz (wie das
    // `refreshDevices`/`hideQr` der Effekte darueber), der Countdown startet
    // also weiterhin nur bei neuem Ablaufzeitpunkt oder Remote-Umschaltung neu.
  }, [passcodeExpiresAt, regenerateToken, remoteEnabled])

  // Web parity (apps/web/components/layout/Sidebar.tsx:217): the conversation
  // list belongs to Chat and nowhere else. This used to be a side effect of
  // setView, which also tore the user's collapse open on every trip through
  // Models or Settings.
  const showSidebar = !isComparing && currentView === 'chat'

  /** One rail button, active or not. Same shape as the web rail.
   *
   *  D-T11: der Zustandswechsel dieser Schiene ist reine Farbe, Flaeche und
   *  Text. `transition-colors` laeuft in derselben Voreinstellung (150 ms) wie
   *  die pauschale Variante, die hier stand, benennt aber nur die
   *  Eigenschaften, die sich wirklich bewegen. Dasselbe gilt fuer die beiden
   *  Einzelknoepfe darunter (Aufklappen, New Chat) und den Zuklapp-Knopf in
   *  der Reiterzeile. */
  const railBtn = (active: boolean) =>
    `flex items-center justify-center w-9 h-9 rounded-md transition-colors ${
      active
        ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white'
        : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5'
    }`

  return (
    <>
    <AnimatePresence mode="wait" initial={false}>
      {/* Collapsed: the slim icon rail. Chat/Code/Remote stay visible and
          clickable, the top button expands to the full conversation list.
          56 px and w-9 buttons are the web numbers, unchanged. */}
      {showSidebar && !sidebarOpen && (
        <motion.aside
          key="rail"
          data-testid="sidebar-rail"
          className="h-full rounded-xl bg-gray-50 dark:bg-[#1e1e1e] ring-1 ring-black/[0.04] dark:ring-white/[0.05] flex flex-col items-center z-20 overflow-hidden shrink-0 py-2 gap-1"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 56, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.15 }}
          style={{ width: 56 }}
        >
          <button
            onClick={() => setSidebarOpen(true)}
            title="Expand sidebar"
            aria-label="Expand sidebar"
            data-testid="sidebar-toggle"
            className="flex items-center justify-center w-9 h-9 rounded-md text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
          >
            <PanelLeftOpen size={16} />
          </button>
          <div className="w-6 h-px bg-gray-200 dark:bg-white/10 my-1" />
          <button
            onClick={() => { setChatMode('lu'); setActiveConversation(null); setView('chat'); setDispatchPicker(false) }}
            title="Chat"
            aria-label="Chat"
            className={railBtn(!isCodingMode && !isRemoteMode)}
          >
            <MessageSquare size={15} />
          </button>
          <button
            onClick={() => { setChatMode('codex'); setActiveConversation(null); setView('chat'); setDispatchPicker(false) }}
            title="Code"
            aria-label="Code"
            className={railBtn(isCodingMode)}
          >
            <Code size={15} />
          </button>
          <button
            onClick={() => { setChatMode('remote'); setActiveConversation(dispatchedConversationId); setView('chat') }}
            title="Remote"
            aria-label="Remote"
            className={railBtn(isRemoteMode)}
          >
            <Radio size={15} />
          </button>
          <div className="flex-1" />
          <button
            onClick={handleNewChat}
            title={activeModel ? 'New Chat' : 'Pick or install a model first'}
            aria-label="New Chat"
            className="flex items-center justify-center w-9 h-9 rounded-md text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
          >
            {/* 16 statt 17: die 17 war die einzige im ganzen Baum und haette
                eine sechzehnte Symbolgroesse aufgemacht (icon-leiter.test.ts).
                16 ist ICON_MD, liegt bei 1x und 2x auf ganzen Geraetepixeln
                und steht einen Knopf weiter oben schon am Aufklapp-Pfeil. */}
            <Plus size={16} />
          </button>
        </motion.aside>
      )}
      {/* Expanded: the full conversation list. Die feste Breite von 200 px bei
          zoom 1.25 ist weg, die Spalte haengt jetzt am Ziehgriff weiter unten
          (sidebarWidth). `relative` traegt diesen Griff. */}
      {showSidebar && sidebarOpen && (
        <motion.aside
          key="full"
          data-testid="sidebar-panel"
          className="relative h-full rounded-[10px] bg-white dark:bg-[#1e1e1e] ring-1 ring-black/[0.04] dark:ring-white/[0.05] flex flex-col z-20 overflow-hidden"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: sidebarWidth, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: ziehend ? 0 : 0.15 }}
        >
          {/* Ziehgriff — D1, zweite Haelfte (David, 02.09.2026: "bzw dynamisch
              mit vergroesserung anpassend").

              Die Spalte war auf 250 px festgenagelt, es gab also gar keine
              Vergroesserung, an die sich der Titel haette anpassen koennen.
              Erst zusammen mit dem CSS-Schnitt in der Zeile ergibt das etwas:
              waere dort noch `truncate(title, 30)`, endete der Name auch in
              einer 480-px-Spalte nach 30 Zeichen und liesse den Rest leer.

              `-mr-0.5` legt die 1-px-Flaeche halb ueber die Kante, damit sie
              greifbar ist, ohne dass die Spalte 1 px breiter aussieht — genau
              wie der Griff des Agenten-Panels, nur spiegelverkehrt: das steht
              rechts und wird durch Ziehen NACH LINKS breiter, diese Spalte
              steht links und wird durch Ziehen NACH RECHTS breiter. */}
          <div
            onPointerDown={(e) => {
              e.preventDefault()
              setZiehend(true)
              const startX = e.clientX
              const startWidth = sidebarWidth
              const onMove = (ev: PointerEvent) =>
                setSidebarWidth(startWidth + (ev.clientX - startX), window.innerWidth)
              const onUp = () => {
                setZiehend(false)
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
              }
              window.addEventListener('pointermove', onMove)
              window.addEventListener('pointerup', onUp)
            }}
            title="Drag to resize"
            data-testid="sidebar-resize-handle"
            className="absolute right-0 top-0 h-full w-1 -mr-0.5 z-10 cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500/60 transition-colors"
          />
          {/* Mode Tabs (Chat | Code | Remote) — icon-only, like uselu.
              Labels live in title/aria-label for accessibility.

              D-S17 — die Hoehen kommen jetzt aus der Leiter, nicht aus dem
              Padding. Der Befund sprach von vier Hoehen; nachgemessen sind es
              FUENF, und zwei davon standen nebeneinander in DIESER Zeile.
              Gemessen am Dev-Server (Chromium, 900x900, HEAD b3f0f786,
              `offsetHeight`, also CSS-px auf dem unskalierten Entwurfsraster):

                Reiter Chat            30 px
                Reiter Code            30 px
                Reiter Remote          26 px   <- gleiche Zeile, 4 px kuerzer
                Suchfeld               31 px
                Chatzeile              36 px
                Dispatch / New Chat    36 px
                LAN / Internet         33 px

              Fuenf Stufen (26/30/31/33/36) auf 250 px Breite, keine davon
              benannt. Die App hat drei benannte: --control-h-sm 26,
              --control-h-md 32, --control-h-lg 40. Die Zuordnung ist nach
              BEDEUTUNG, nicht nach naechstem Zahlenwert:

                md  = das Normalmass der Spalte — Reiter, Suchfeld, Chatzeile.
                lg  = die EINE Primaeraktion am Fuss (New Chat bzw. Dispatch
                      und sein Waehler). --control-h-lg traegt in index.css
                      ausdruecklich den Kommentar „primary Create button";
                      genau diese Rolle hat der Knopf hier.
                sm  = kommt in dieser Spalte NICHT vor. 26 px ist das Mass der
                      Composer-Leiste (`.lu-control`), also einer dichten
                      Werkzeugzeile. Der Modusumschalter der Sidebar ist keine
                      Werkzeugzeile, und dass der Remote-Reiter zufaellig schon
                      auf 26 stand, ist kein Argument dafuer — er stand dort,
                      weil ihm der Textspan fehlt, nicht weil es gemeint war.

              Keine fuenfte Stufe erfunden. Was das kostet, offen gesagt: die
              Reiter wachsen um 2 px (30->32) bzw. 6 px (26->32), die Chatzeile
              schrumpft um 4 px (36->32), der Fussknopf waechst um 4 px
              (36->40). Die 33 px des LAN/Internet-Waehlers gehen auf 40, weil
              er im selben Slot steht wie die Aktion, die er ersetzt.

              Der Zuklapp-Knopf steht in derselben Zeile und haelt sich an
              dieselbe Leiter: md, quadratisch, damit er neben den Reitern
              keine sechste Hoehe aufmacht. Er schreibt das aber als Breite
              plus `aspect-square` (das Rezept, das create/ui/NumberField und
              der MaskEditor schon fuer quadratische Controls benutzen), nicht
              als Hoehenklasse: er ist KEIN Reiter, und die zwei Zaehlungen in
              die-spalte-kennt-ihre-breite und
              die-spalte-zeigt-ihre-primaeraktion, die "alle drei Reiter
              tragen dieselbe Stufe" pruefen, sollen ihn auch nicht fuer einen
              halten. Die Stufe ist dieselbe, das Quadrat kommt aus dem
              Seitenverhaeltnis.

              Seine Ecke ist `rounded-md` (6 px), wie die Knoepfe der
              eingeklappten Schiene. Das ist zugleich das Ziel, das der
              D-T08-Block in index.css fuer die 5px-Ecken dieser Datei
              festgelegt hat; eine einundzwanzigste 5px-Ecke waere in die
              Gegenrichtung gelaufen, und die Sperrklinke im Test darf nur
              sinken. Die uebrigen 20 wandern in ihrem eigenen Durchgang mit. */}
          <div className="flex items-center gap-[2.5px] px-2.5 pt-2.5 pb-1.25 text-[12px]">
            {/* Collapse back to the slim rail */}
            <button
              onClick={() => setSidebarOpen(false)}
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
              data-testid="sidebar-toggle"
              className="flex items-center justify-center w-[var(--control-h-md)] aspect-square rounded-md text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors shrink-0"
            >
              <PanelLeftClose size={13} />
            </button>
            {/* Chat tab */}
            <button
              onClick={() => { setChatMode('lu'); setActiveConversation(null); setView('chat'); setDispatchPicker(false) }}
              title="Chat"
              aria-label="Chat"
              className={`flex items-center gap-1.25 justify-center px-2.5 h-[var(--control-h-md)] rounded-[5px] font-medium transition-all flex-1 min-w-0 ${
                !isCodingMode && !isRemoteMode
                  ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white border border-gray-300 dark:border-white/15'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 border border-transparent'
              }`}
            >
              <MessageSquare size={11} />
              <span>Chat</span>
            </button>

            {/* Code tab — direct switch to the coding agent (no dropdown).
                Internal mode value 'codex' is kept for storage back-compat. */}
            <button
              onClick={() => { setChatMode('codex'); setActiveConversation(null); setView('chat'); setDispatchPicker(false) }}
              title="Code"
              aria-label="Code"
              className={`flex items-center gap-1.25 justify-center px-2.5 h-[var(--control-h-md)] rounded-[5px] font-medium transition-all flex-1 min-w-0 ${
                isCodingMode
                  ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white border border-gray-300 dark:border-white/15'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 border border-transparent'
              }`}
            >
              <Code size={11} />
              <span>Code</span>
            </button>

            {/* Remote tab — D-S04: der dritte Reiter trug sein Wort nur in
                `title` und `aria-label`, sichtbar war ein Radio-Icon allein.
                Neben zwei beschrifteten Geschwistern ist das kein dritter
                Reiter, sondern ein Raetsel an derselben Stelle: Maus und
                Screenreader bekamen „Remote" zu lesen, das Auge nicht.

                Der Reiter ist jetzt in JEDEM Stueck die Kopie der beiden
                anderen — dieselbe Klassenkette (ihm fehlte der Abstand
                zwischen Icon und Wort), dieselbe Icon-Groesse (14 -> 11), derselbe
                `<span>`, und `title` wie `aria-label` bleiben, weil Chat und
                Code sie auch tragen. Kein Sonderfall heisst: auch nicht in
                die andere Richtung.

                Und `min-w-0`, an ALLEN DREI. Das ist die Klasse, ohne die
                dieser Befund die Geometrie der Zeile mitgenommen haette:
                `flex-1` ist `flex: 1 1 0%`, aber die Vorgabe `min-width:auto`
                laesst ein Flex-Kind nicht unter seine Inhaltsbreite. Solange
                der dritte Reiter nur ein Icon trug, lag jeder Inhalt unter dem
                freien Mass und alle drei waren gleich breit. Ein Wort, das
                laenger ist als „Chat"/„Code", kippt das.

                Gemessen am Dev-Server (Chromium, Sidebar 250 CSS-px,
                --ui-scale 1,15), Breiten in GERENDERTEN px:

                  Reiterleiste innen                     264,50
                  davon zwei Abstaende (2 x 2,5 CSS)       5,75
                  bleibt fuer drei Reiter                258,75

                  ohne `min-w-0`   Chat 82,64  Code 82,64  Remote 93,47
                  mit  `min-w-0`   Chat 86,25  Code 86,25  Remote 86,25

                Die Schriftgroesse steht seit D-S04 EINMAL am Behaelter der
                drei statt dreimal in den Reitern. Sie war ohnehin an allen
                dreien dieselbe Aussage; ein Elternteil, das die Typo seiner
                Kinder setzt, ist die kuerzere und die richtige Stelle. (Was
                mich hinschauen liess, war der Zaehler in
                `die-typo-leiter-und-ihre-umgehung.test.ts`: er liest .tsx
                OHNE Kommentare zu strippen und deckelt die arbitraeren
                Schriftgroessen bei 1009. Der dritte Reiter haette eine
                dritte Fundstelle hinzugefuegt; eine am Behaelter macht aus
                den dreien eine. Gemessen: 1009 -> 1008.)

                86,25 ist genau das Mass, das alle drei schon vorher hatten.
                Mit `min-w-0` ist D-S04 also eine reine Beschriftung ohne
                Nebenwirkung auf das Raster; ohne sie haette der dritte Reiter
                seinen Geschwistern je 3,61 px abgenommen.

                Und es klemmt nichts: unter `min-w-0` steht der Span auf seiner
                natuerlichen Breite (50,08 px, Schrumpfung 0), einzeilig
                (Hoehe 20,69 px), und der Reiter meldet `scrollWidth` 73 =
                `clientWidth` 73, also keinen Ueberlauf. `truncate` waere hier
                eine Abkuerzung ohne Anlass. */}
            <button
              onClick={() => { setChatMode('remote'); setActiveConversation(dispatchedConversationId); setView('chat') }}
              title="Remote"
              aria-label="Remote"
              className={`flex items-center gap-1.25 justify-center px-2.5 h-[var(--control-h-md)] rounded-[5px] font-medium transition-all flex-1 min-w-0 ${
                isRemoteMode
                  ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white border border-gray-300 dark:border-white/15'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 border border-transparent'
              }`}
            >
              <Radio size={11} />
              <span>Remote</span>
            </button>
          </div>

          {/* Dispatch Panel — shown when Remote mode + active dispatch + qrVisible.
              Bug #16: collapse after first mobile message; reopen via the QR
              icon next to the dispatched chat row (see below). */}
          {isRemoteMode && remoteEnabled && dispatchedConversationId && qrVisible && (
            <div className="mx-2.5 mb-1.25 px-2.5 py-2.5 rounded-[8px] bg-green-500/[0.06] border border-green-500/20 space-y-[7.5px]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-[7.5px]">
                  <span className="w-[7.5px] h-[7.5px] rounded-full bg-green-400 animate-pulse" />
                  <span className="text-[11px] font-medium text-green-400">LIVE</span>
                </div>
                <div className="flex items-center gap-1.25">
                  <button
                    onClick={hideQr}
                    title="Hide QR panel (reopen via the QR icon on the chat row)"
                    className="flex items-center justify-center w-6.25 h-6.25 rounded-[5px] text-gray-400 hover:bg-white/10 transition-all"
                  >
                    <X size={10} />
                  </button>
                  <button
                    onClick={() => {
                      // Read at click time: the row projection carries what a
                      // row paints, not the model/system prompt.
                      const conv = useChatStore.getState().conversations
                        .find((c) => c.id === dispatchedConversationId)
                      restart(conv?.model, conv?.systemPrompt)
                    }}
                    disabled={remoteLoading}
                    title="Restart server (keeps this chat, issues a new passcode)"
                    className="flex items-center gap-1.25 px-[7.5px] py-[2.5px] rounded-[5px] text-[10px] text-blue-400 hover:bg-blue-500/15 border border-blue-500/20 transition-all disabled:opacity-50"
                  >
                    <RefreshCw size={9} className={remoteLoading ? 'animate-spin' : ''} />
                    Restart
                  </button>
                  <button
                    onClick={undispatch}
                    className="flex items-center gap-1.25 px-[7.5px] py-[2.5px] rounded-[5px] text-[10px] text-red-400 hover:bg-red-500/15 border border-red-500/20 transition-all"
                  >
                    <Square size={9} />
                    Stop
                  </button>
                </div>
              </div>

              {/* QR Code — hidden until Cloudflare is verified up (internet
                  mode); shown immediately for LAN. David 2026-06-15: never
                  flash a QR that points at the LAN IP while the tunnel is
                  still coming up. */}
              {awaitingTunnel ? (
                <div className="w-full flex flex-col items-center justify-center gap-1.25 py-5 text-center">
                  <RefreshCw size={20} className="animate-spin text-emerald-400/70" />
                  <span className="text-[11px] text-emerald-400/80">Connecting to Cloudflare…</span>
                  <span className="text-[9px] text-gray-500 leading-snug px-2.5">The QR appears once the tunnel is live</span>
                </div>
              ) : qrPngBase64 ? (
                <button
                  onClick={() => setQrModalOpen(true)}
                  title="Show large QR code"
                  className="w-full flex justify-center group"
                >
                  <div className="bg-white rounded-[5px] p-1.25 transition-all group-hover:ring-2 group-hover:ring-green-400/50 group-hover:scale-[1.04]">
                    <img src={`data:image/png;base64,${qrPngBase64}`} alt="QR" className="w-[90px] h-[90px]" />
                  </div>
                </button>
              ) : null}

              {/* Passcode. Bis zum 04.09.2026 stand er in einem mittleren Gelb,
                  und das war Schmuck ohne Aussage: Gelb heisst in dieser App
                  nichts mehr, seit `lib/hinweis.ts` die Toene auf zwei
                  festgelegt hat. Eine Ersatzfarbe bekommt er trotzdem nicht.
                  In diesem Panel sind alle Toene schon vergeben (gruen LIVE,
                  smaragd Tunnel, blau Adresse, rot Stop und abgelaufen), und
                  Violett gehoert der Cloud. Ein Passcode ist ohnehin kein
                  Zustand, sondern der Wert, den man abliest und abtippt. Also
                  der staerkste Kontrast statt eines sechsten Farbtons, in
                  beiden Modi. */}
              <div className="flex items-center justify-between">
                <code className="text-[14px] text-gray-900 dark:text-white font-mono tracking-[3.75px] font-bold">{passcode}</code>
                <div className="flex items-center gap-1.25">
                  <button
                    onClick={() => copyToClipboard(passcode, 'panel-passcode')}
                    className="p-[2.5px] hover:bg-white/10 rounded-[5px]"
                    aria-label={copied === 'panel-passcode' ? 'Passcode copied' : 'Copy passcode'}
                    title={copied === 'panel-passcode' ? 'Copied' : 'Copy passcode'}
                  >
                    {copied === 'panel-passcode'
                      ? <Check size={11} className="text-gray-500" />
                      : <Copy size={11} className="text-gray-500" />}
                  </button>
                  <button onClick={regenerateToken} className="p-[2.5px] hover:bg-white/10 rounded-[5px]">
                    <RefreshCw size={11} className="text-gray-500" />
                  </button>
                  {countdown && (
                    <span className={`text-[9px] font-mono ${countdown === 'Expired' ? 'text-red-400' : 'text-gray-600'}`}>
                      {countdown}
                    </span>
                  )}
                </div>
              </div>

              {/* URL — prefer tunnel URL when tunnel is active */}
              <div className="flex items-center gap-1.25">
                {tunnelLoading ? (
                  <code className="text-[10px] text-emerald-400/70 truncate flex-1 animate-pulse">Starting Cloudflare tunnel…</code>
                ) : (
                  <>
                    <code className={`text-[10px] truncate flex-1 ${tunnelActive ? 'text-emerald-400' : 'text-blue-400'}`}>
                      {tunnelActive && tunnelUrl ? `${tunnelUrl}/mobile` : (mobileUrl || lanUrl)}
                    </code>
                    <button
                      onClick={() => copyToClipboard(tunnelActive && tunnelUrl ? `${tunnelUrl}/mobile` : (mobileUrl || lanUrl), 'panel-url')}
                      className="p-[2.5px] hover:bg-white/10 rounded-[5px] shrink-0"
                      aria-label={copied === 'panel-url' ? 'Address copied' : 'Copy address'}
                      title={copied === 'panel-url' ? 'Copied' : 'Copy address'}
                    >
                      {copied === 'panel-url'
                        ? <Check size={11} className="text-gray-500" />
                        : <Copy size={11} className="text-gray-500" />}
                    </button>
                  </>
                )}
              </div>
              {/* DNS-propagation hint — Cloudflare *.trycloudflare.com
                  records can take 5-10 s to resolve on the mobile after
                  the URL is generated. Without this hint users see "DNS
                  not available" on first scan, panic, and click
                  Restart. The note is small + auto-disappears once a
                  device authenticates (qrVisible flips false). */}
              {tunnelActive && tunnelUrl && (
                <p className="text-[10px] text-gray-500/70 leading-snug">
                  First connection may take 5 to 10 s while DNS propagates. If you see a DNS error, wait a moment and reload.
                </p>
              )}

              {remoteError && (
                <p className="text-[10px] text-red-400 truncate">{remoteError}</p>
              )}
            </div>
          )}

          {/* Search */}
          <div className="px-2.5 pb-1.25">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600" />
              <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                /* D-S17: 31 px gemessen -> --control-h-md (32). */
                className="w-full pl-7.5 pr-2.5 h-[var(--control-h-md)] rounded-[8px] bg-transparent border border-gray-200 dark:border-white/[0.04] text-[13px] text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-gray-400 dark:focus:border-white/10"
              />
            </div>
          </div>

          {/* Nur fuer Vorlesehilfen: sagt an, dass und was geloescht wurde. */}
          <div role="status" aria-live="polite" className="sr-only">
            {zuletztGeloescht ? `Deleted chat: ${zuletztGeloescht}` : ''}
          </div>

          {/* Conversations */}
          <div className="flex-1 overflow-y-auto px-[7.5px] pt-1.25 scrollbar-thin">
            {/**
              * KF-8 — die Liste sagt jetzt, dass sie eine Liste ist.
              *
              * Gemessen war die Tab-Reihenfolge ab dem Suchfeld:
              *   Rename chat, Delete chat, Rename chat, Delete chat, New Chat
              * Die ZEILEN kamen nicht vor. Die Zeile war ein `<div>` mit
              * `onClick`, ohne Rolle und ohne `tabIndex` — wer mit der
              * Tastatur arbeitet, konnte jeden Chat umbenennen und loeschen,
              * aber keinen einzigen OEFFNEN. Die zerstoerenden Aktionen waren
              * erreichbar, die harmlose nicht.
              *
              * WARUM `listbox`/`option` UND NICHT `role="button"`.
              * Fachlich ist die Zeile eine Auswahl aus einer Liste, kein
              * Knopf: genau eine ist aktiv, und `aria-selected` sagt das
              * endlich maschinenlesbar — bisher war „aktiv" nur eine
              * Hintergrundfarbe.
              * Und `role="button"` waere hier nachweislich eine Falle. Ein
              * frischer Chat heisst `'New Chat'` (chatStore.createConversation),
              * also traegt die Zeile denselben zugaenglichen Namen wie die
              * Primaeraktion am Fuss. Jeder `getByRole('button', { name:
              * /New Chat/i })` — u.a. `e2e/support/ui.ts`, das JEDER Spec
              * benutzt — haette ab der ersten leeren Unterhaltung zwei
              * Treffer und damit eine strict-mode-Verletzung. `option` ist
              * nicht bloss das Ausweichen davor, es ist die richtige Rolle;
              * dass es die Locator scharf laesst, ist die Zugabe.
              *
              * Die Zeile ist ein echter `<button>` MIT `role="option"` — das
              * Muster, das `models/ModelTiles.tsx` schon faehrt. Vom Element
              * kommen Tab-Stop, Enter und Leertaste ohne eine Zeile
              * Tastatur-Code; die Rolle sagt, was es bedeutet. Ein
              * `tabIndex={0}` an einem `<div>` haette Enter/Leertaste selbst
              * nachbauen muessen.
              *
              * Die beiden Aktionsknoepfe bleiben GESCHWISTER der Option, nicht
              * ihre Kinder: `<button>` in `<button>` ist ungueltiges HTML, und
              * der Browser zerlegt es. Dadurch steht die Reihenfolge in der
              * Zeile von selbst richtig — Zeile, Umbenennen, Loeschen.
              */}
            <div role="listbox" aria-label="Conversations" className="space-y-px">
            {filtered.map((conv) => {
              // Der Marker der abgesetzten Remote-Zeile — dieselbe Bedingung
              // stand dreimal in dieser Zeile (Punkt, QR-Knopf, und ab jetzt
              // auch die Frage, ob die Aktionsleiste aus dem Fluss darf).
              const qrMarker = isRemoteMode && conv.id === dispatchedConversationId && remoteEnabled
              return (
              <div
                key={conv.id}
                /* D-S17: 36 px gemessen -> --control-h-md (32). Die Hoehe ist
                   jetzt GESETZT und nicht mehr ein Nebenprodukt: vorher
                   bestimmten die 26 px hohen Hover-Knoepfe plus py-1.25 das
                   Mass, die Zeile war also so hoch wie etwas, das man 99 % der
                   Zeit nicht sieht. Genau das macht D-S15 unten erst
                   ungefaehrlich — eine Leiste, die den Fluss verlaesst, darf
                   die Zeilenhoehe nicht mitnehmen, sonst springt die Liste
                   unter dem Zeiger. */
                className={`group flex items-center gap-[7.5px] px-2.5 h-[var(--control-h-md)] rounded-[8px] cursor-pointer transition-all ${
                  conv.id === activeConversationId
                    ? 'bg-gray-200 dark:bg-white/[0.06] text-gray-900 dark:text-white'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.03] hover:text-gray-800 dark:hover:text-gray-200'
                }`}
                /* Das `onClick` sitzt seit KF-8 an der Option darunter, nicht
                   mehr hier: sonst zaehlte jeder Klick doppelt. Der
                   Rechtsklick bleibt an der ZEILE, damit er wie bisher ueber
                   der ganzen Zeile aufgeht — auch ueber den Aktionsknoepfen,
                   die keine Kinder der Option sind. */
                onContextMenu={(e) => {
                  e.preventDefault()
                  setRowMenu({ id: conv.id, x: e.clientX, y: e.clientY })
                }}
              >
                <div className="flex-1 min-w-0">
                  {editingId === conv.id ? (
                    <div className="flex items-center gap-1.25">
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleRename(conv.id)}
                        className="w-full bg-white/5 rounded-[5px] px-1.25 py-[2.5px] text-[13px] text-white focus:outline-none"
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                      <button onClick={(e) => { e.stopPropagation(); handleRename(conv.id) }} className="text-green-400"><Check size={14} /></button>
                      <button onClick={(e) => { e.stopPropagation(); setEditingId(null) }} className="text-gray-500"><X size={14} /></button>
                    </div>
                  ) : (
                    <button
                      role="option"
                      aria-selected={conv.id === activeConversationId}
                      onClick={() => {
                        setActiveConversation(conv.id)
                        setView('chat')
                      }}
                      className="flex items-center gap-[7.5px] min-w-0 w-full text-left cursor-pointer"
                    >
                      {qrMarker && (
                        <span className="w-[7.5px] h-[7.5px] rounded-full bg-green-400 shrink-0" />
                      )}
                      {/* D-S14 — EINE Kuerzung, und zwar die, die die Spalte
                          kennt.
                          Hier standen zwei uebereinander: `truncate(title, 30)`
                          in JS und die CSS-Klasse `truncate` am selben <p>. Die
                          Messung sagt, welche der beiden ueberhaupt je etwas
                          tut (Chromium, 900x900, HEAD b3f0f786, Inter 13px):

                            Titelbox der Zeile        118,02 gerenderte px
                            passen hinein               14 Zeichen + Auslassung
                            30 Zeichen brauchten       229,27 gerenderte px

                          Die JS-Kuerzung haette also eine fast doppelt so
                          breite Spalte gebraucht, um je zuzuschneiden. Sie hat
                          in dieser Sidebar noch nie ein Zeichen entfernt — was
                          man sah, war immer der CSS-Schnitt. Zwei Kuerzungen
                          waren es nur auf dem Papier; in Wahrheit eine echte
                          und eine, die auf ihren Tag wartete.
                          Und der Tag waere HEUTE gekommen: D-S15 unten gibt der
                          Titelbox 62,66 gerenderte px zurueck (auf 180,67 =
                          22 Zeichen). Bliebe die 30er-Grenze stehen, waere sie
                          weiterhin unerreicht — aber sie waere ab jetzt eine
                          willkuerliche Obergrenze ueber einer Spalte, deren
                          Breite sich gerade geaendert hat. Genau dafuer gibt es
                          `text-overflow: ellipsis`: es misst.
                          Der zweite Grund ist der DOM. `truncate(t, 30)`
                          schreibt drei echte Punkte IN den Text — Kopieren,
                          Vorlesen und `title=` bekamen dann den beschnittenen
                          String. Der CSS-Schnitt laesst den vollen Titel im
                          Dokument stehen, deshalb kann `title=` hier jetzt das
                          Ganze zeigen. */}
                      <p className="text-[13px] truncate flex-1 min-w-0" title={conv.title}>{conv.title}</p>
                      {/* Already formatted in the projection — see SidebarRow.
                          Das Datum weicht, wenn die Aktionsleiste kommt: die
                          Leiste liegt seit D-S15 UEBER diesem Slot (62,66 von
                          49,33 gerenderten px Datum plus 7,5 px Abstand), und
                          zwei Dinge uebereinander sind schlimmer als eins
                          weniger. Es weicht nur optisch — der Platz bleibt, die
                          Titelbreite aendert sich beim Ueberfahren also nicht.
                          `group-focus-within` und nicht `focus-within`: der
                          Fokus sitzt dann in der Leiste, also im GESCHWISTER,
                          und nur die Zeile sieht beide. */}
                      <span className="text-[10px] text-gray-600 shrink-0 group-hover:opacity-0 group-focus-within:opacity-0 transition-opacity">{conv.date}</span>
                    </button>
                  )}
                </div>
                {editingId !== conv.id && (
                  <div className="relative flex items-center gap-[2.5px] shrink-0">
                    {/* Bug #16: QR icon on the dispatched Remote chat row.
                        Always visible (not hover-gated) and opens the LARGE
                        QR-modal directly — the row icon itself is just a
                        marker, the actual scannable code lives in the modal. */}
                    {qrMarker && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setQrModalOpen(true) }}
                        title="Show QR & passcode"
                        className="p-1.25 rounded-[5px] hover:bg-green-500/15 text-green-400 transition-colors"
                      >
                        <QrCode size={16} />
                      </button>
                    )}
                    {/**
                      * D-S15 — die Aktionsleiste gibt ihren Layoutplatz her.
                      *
                      * Gemessen am Dev-Server (Chromium, 900x900, HEAD
                      * b3f0f786), alles in GERENDERTEN px (--ui-scale 1,15):
                      *
                      *   Leiste (2 x 26 px CSS + 2,5 Abstand)   62,66 px
                      *   Titelbox vorher                       118,02 px
                      *   Titelbox nachher                      180,67 px
                      *   Zeichen im Titel                      14  ->  22
                      *
                      * Das sind +53 % Titelbreite, dauerhaft, fuer eine Leiste,
                      * die 99 % der Zeit unsichtbar ist. `opacity-0` nimmt nur
                      * die Farbe weg, nicht den Platz.
                      *
                      * WARUM DIE SIDEBAR DER ANDERE FALL IST ALS D-S07.
                      * In `chat/MessageBubble.tsx` ist bei D-S07 bewusst die
                      * umgekehrte Entscheidung getroffen worden — dort behaelt
                      * die Leiste ihren Platz, „weil sie UNTER der Nachricht
                      * liegt und das ganze Transkript beim Hovern wegspraenge".
                      * Der Unterschied ist die ACHSE, nicht die Meinung:
                      *
                      *   MessageBubble  Leiste unter der Nachricht -> sie
                      *                  belegt HOEHE. Faellt die Hoehe weg,
                      *                  ruecken alle folgenden Nachrichten
                      *                  eines scrollenden Protokolls nach oben,
                      *                  waehrend der Zeiger darauf steht.
                      *   Sidebar        Leiste rechts IN der Zeile -> sie
                      *                  belegt BREITE. Die Zeilenhoehe steht
                      *                  seit D-S17 fest (--control-h-md), also
                      *                  rueckt vertikal nichts, egal was hier
                      *                  ein- und ausgeblendet wird.
                      *
                      * Deshalb `absolute` und nicht `hidden`: `hidden` ist
                      * `display: none`, und ein Knopf mit `display: none` ist
                      * nicht fokussierbar. Damit waere Umbenennen/Loeschen per
                      * Tastatur GAR NICHT mehr erreichbar gewesen — das
                      * Kontextmenue der Zeile haengt an `onContextMenu`, ist
                      * also ebenfalls nur mit Zeiger zu oeffnen. `absolute`
                      * nimmt den Platz und laesst die Erreichbarkeit.
                      *
                      * `focus-within:opacity-100` stand hier schon vor dieser
                      * Aenderung und bleibt: gemessen (Fokus per Tastatur auf
                      * „Rename chat", nach Ablauf der 150-ms-Blende) steht die
                      * Leiste auf `opacity: 1`. Es ist kein `group-`Praefix
                      * noetig, weil die Knoepfe KINDER dieses Kastens sind —
                      * `group-focus-within` waere dieselbe Regel ueber den
                      * Umweg der Zeile. In MessageBubble steht das Praefix, weil
                      * die Sichtbarkeitsklasse dort am Kasten haengt und die
                      * Gruppe die Nachricht ist.
                      *
                      * `pointer-events-none` im Ruhezustand ist die Pflicht,
                      * die aus `absolute` folgt: der Kasten liegt jetzt UEBER
                      * dem Datum und den letzten ~4 px des Titels. Ohne die
                      * Regel wuerde ein unsichtbarer Kasten Klicks abfangen.
                      * Zum Beweis, dass das kein neues Problem ist: schon am
                      * HEAD liefert `elementFromPoint` auf einer NICHT
                      * ueberfahrenen Zeile 12 px vom rechten Rand „Delete
                      * chat". Diese Aenderung nimmt die Eigenschaft weg.
                      *
                      * Die eine Ausnahme: auf der abgesetzten Remote-Zeile
                      * steht der QR-Knopf im Fluss, und er ist der dokumentierte
                      * Weg zurueck zum QR-Blatt (Bug #16). Eine daruebergelegte
                      * Leiste wuerde ihn beim Hovern verdecken. Diese eine Zeile
                      * behaelt deshalb den reservierten Platz.
                      */}
                    {/* Die `group-`Zwillinge kamen mit KF-8 dazu. Seither ist
                        die ZEILE selbst ein Tab-Stop, und ihr Fokus sitzt in
                        der Option — also im GESCHWISTER dieser Leiste, wo das
                        blosse `focus-within` ihn nicht sieht. Ohne sie haette
                        Tab auf die Zeile das Datum ausgeblendet (der Span
                        haengt an `group-focus-within`) und nichts an seine
                        Stelle gesetzt. Jetzt tut der Fokus auf der Zeile
                        genau das, was das Ueberfahren tut, und zeigt einem
                        Tastaturnutzer im selben Moment, was zwei Tabs weiter
                        auf ihn wartet. Die beiden alten `focus-within`
                        bleiben: sie gelten, wenn der Fokus IN der Leiste
                        steht, und nur sie halten sie dann offen. */}
                    <div className={`${qrMarker ? '' : 'absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none group-hover:pointer-events-auto focus-within:pointer-events-auto group-focus-within:pointer-events-auto'} flex items-center gap-[2.5px] opacity-0 group-hover:opacity-100 focus-within:opacity-100 group-focus-within:opacity-100 transition-opacity`}>
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditingId(conv.id); setEditTitle(conv.title) }}
                        title="Rename chat"
                        aria-label="Rename chat"
                        className="p-1.25 rounded-[5px] hover:bg-white/10 text-gray-500 hover:text-gray-300"
                      >
                        <Edit3 size={16} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); loescheChatMitAnsage(conv.id, conv.title) }}
                        title="Delete chat"
                        aria-label="Delete chat"
                        className="p-1.25 rounded-[5px] hover:bg-red-500/20 text-gray-500 hover:text-red-400"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
              )
            })}
            </div>

            {filtered.length === 0 && (
              <p className="text-center text-gray-600 text-[12px] py-7.5">
                {search ? 'No results' : isRemoteMode ? 'No dispatched chats' : 'No conversations'}
              </p>
            )}
          </div>

          {/* Bottom Action */}
          <div className="px-2.5 pb-2.5 pt-1.25 border-t border-gray-200 dark:border-white/[0.04]">
            {/* #29: dispatch failure used to be invisible — the orphan
                conv was deleted in handleDispatch's catch block and the
                user was left looking at the Dispatch button as if nothing
                happened. Surface the actual reason here so the next click
                is informed (close other LU instance, change network,
                etc.). Only renders when no chat is dispatched, otherwise
                ChatView's "Server stopped" banner owns this. */}
            {isRemoteMode && remoteError && !dispatchedConversationId && (
              <div className="mb-[7.5px] px-2.5 py-1.25 rounded-[5px] border border-red-500/30 bg-red-500/5 text-[11px] text-red-300/90 flex items-start gap-[7.5px]">
                <span className="break-words flex-1 leading-snug">{remoteError}</span>
                <button
                  onClick={() => useRemoteStore.getState().clearError()}
                  title="Dismiss"
                  className="shrink-0 p-[2.5px] rounded-[5px] text-red-400/70 hover:text-red-300 hover:bg-red-500/15 transition-all"
                >
                  <X size={11} />
                </button>
              </div>
            )}
            {isRemoteMode ? (
              <AnimatePresence mode="wait">
                {!dispatchPicker ? (
                  <motion.button
                    key="dispatch"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.1 }}
                    onClick={() => setDispatchPicker(true)}
                    disabled={remoteLoading || !activeModel}
                    className="w-full flex items-center justify-center gap-[7.5px] px-[12.5px] h-[var(--control-h-lg)] rounded-[8px] text-[13px] text-gray-500 hover:text-white hover:bg-white/[0.04] border border-zinc-300/40 dark:border-zinc-500/40 hover:border-zinc-300/60 dark:hover:border-zinc-400/60 transition-all disabled:opacity-40"
                  >
                    <Radio size={15} />
                    <span>{remoteLoading ? '...' : 'Dispatch'}</span>
                  </motion.button>
                ) : (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setDispatchPicker(false)} />
                    <motion.div
                      key="picker"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.1 }}
                      className="relative z-50 w-full flex items-center gap-[2.5px]"
                    >
                      <button
                        onClick={() => handleDispatch('lan')}
                        className="flex-1 flex items-center justify-center gap-1.25 h-[var(--control-h-lg)] rounded-[8px] text-[11px] font-medium text-gray-400 border border-zinc-300/40 dark:border-zinc-500/40 hover:bg-white/[0.05] hover:text-zinc-100 hover:border-zinc-300/60 dark:hover:border-zinc-400/60 transition-all cursor-pointer"
                      >
                        <Wifi size={12} className="text-zinc-400" />
                        LAN
                      </button>
                      <button
                        onClick={() => handleDispatch('internet')}
                        className="flex-1 flex items-center justify-center gap-1.25 h-[var(--control-h-lg)] rounded-[8px] text-[11px] font-medium text-gray-400 border border-zinc-300/40 dark:border-zinc-500/40 hover:bg-white/[0.05] hover:text-zinc-100 hover:border-zinc-300/60 dark:hover:border-zinc-400/60 transition-all cursor-pointer"
                      >
                        <Globe size={12} className="text-zinc-400" />
                        Internet
                      </button>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            ) : (
              /* D-S03 — die Primaeraktion der Spalte wiegt jetzt mehr als
                  die Auswahl darueber.
                  Vorher trug dieser Knopf die neutrale Haut der Liste: eine
                  graue Flaeche mit grauem Rand, deren Ruhezustand
                  (`bg-gray-50 dark:bg-white/[0.03]`) blasser war als der
                  Hover-Zustand einer beliebigen Chatzeile und blasser als
                  die AKTIVE Zeile (`bg-gray-200 dark:bg-white/[0.06]`). Die
                  eine Aktion, die den Bereich weiterbringt, stand damit
                  optisch unter der Auswahl, die schon getroffen ist.
                  Kein neues Rezept und keine neue Farbe: `.lu-primary` ist
                  das EINE Primaer-Rezept des Hauses (index.css) — Flaeche,
                  Textfarbe, Rand und `font-weight: 500` kommen von dort, und
                  mit ihm der eigene Fokusring, den die Hausregel per
                  `:not(.lu-primary)` ausdruecklich freilaesst. Deshalb
                  fallen hier `font-medium` und die vier Graustufen-Klassen
                  weg statt ueberschrieben zu werden.
                  Die GEOMETRIE bleibt, wo sie war: `--control-h-lg` ist laut
                  index.css das Mass des „primary Create button", und D-S17
                  hat den Fussknopf genau darauf gestellt. `.lu-control` waere
                  hier falsch — das Rezept setzt `--control-h-sm` (26 px), das
                  Mass der Composer-Werkzeugleiste. */
              <button
                onClick={handleNewChat}
                title={activeModel ? 'Start a new chat' : 'Pick or install a model first'}
                className="lu-primary w-full flex items-center justify-center gap-[7.5px] px-[12.5px] h-[var(--control-h-lg)] rounded-[8px] text-[13px] transition-all"
              >
                <Plus size={15} />
                <span>New Chat</span>
              </button>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>

    <AnimatePresence>
      {/* Right-click menu for a conversation row. The hover buttons stay, this
          is the gesture people reach for first. */}
      {rowMenu && (
        <div
          key="row-menu"
          className="fixed inset-0 z-[110]"
          onClick={() => setRowMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setRowMenu(null) }}
        >
          <div
            role="menu"
            aria-label="Chat actions"
            className="absolute min-w-[180px] py-1.25 rounded-[8px] bg-white dark:bg-[#141414] border border-gray-200 dark:border-white/10 shadow-lg text-[14px]"
            style={{ left: Math.min(rowMenu.x, window.innerWidth - 160), top: Math.min(rowMenu.y, window.innerHeight - 80) }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              role="menuitem"
              onClick={() => {
                const conv = rows.find((r) => r.id === rowMenu.id)
                setEditingId(rowMenu.id)
                setEditTitle(conv?.title ?? '')
                setRowMenu(null)
              }}
              className="w-full flex items-center gap-2.5 px-3.75 py-[7.5px] text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
            >
              <Edit3 size={15} />
              <span>Rename</span>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                loescheChatMitAnsage(rowMenu.id, useChatStore.getState().conversations.find((c) => c.id === rowMenu.id)?.title ?? '')
                setRowMenu(null)
              }}
              className="w-full flex items-center gap-2.5 px-3.75 py-[7.5px] text-red-500 hover:bg-red-500/10"
            >
              <Trash2 size={15} />
              <span>Delete chat</span>
            </button>
          </div>
        </div>
      )}

      {/* QR Modal — large QR + passcode + URL, opened from the LIVE panel */}
      {qrModalOpen && (
        <motion.div
          key="qr-modal"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-7.5"
          onClick={() => setQrModalOpen(false)}
        >
          <motion.div
            initial={{ scale: 0.92, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.92, opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            /* Hellmodus-Luecke aus Welle 2, in f336b91e gemeldet statt
               geaendert („das Innere ist durchgehend dunkelmodus-only
               gefaerbt"). Beides zusammen, sonst waere es genau die
               Verschlimmbesserung, die dort beschrieben steht: die Flaeche
               auf Tokens, und jeder Akzent darin mit Hell-Pendant.
               Vorher im Hellmodus blieb die Flaeche #212121, waehrend der
               Rescue-Layer die Schrift nach unten drehte: `text-gray-400`
               wurde #374151 und stand bei 1,56:1. Nachher 10,31:1.
               Der Passcode trug damals amber-400 (1,92:1 auf Weiss) und
               bekam dafuer das Hell-Pendant amber-700. Seit dem 04.09.2026
               ist er gar nicht mehr farbig, sondern gray-900 auf Weiss und
               Weiss im Dunkeln: Gelb ist ersatzlos raus, und ein Wert, den
               man abtippt, braucht Kontrast und keinen Farbton. Die
               QR-Kachel ist selbst weiss und verschwaende sonst im weissen
               Dialog, daher die Kante. */
            className="bg-white dark:bg-lu-base border border-gray-200 dark:border-white/10 rounded-[10px] p-6.25 max-w-[450px] w-full flex flex-col items-center gap-3.75 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-[7.5px] text-green-700 dark:text-green-400">
                <span className="w-[7.5px] h-[7.5px] rounded-full bg-green-600 dark:bg-green-400 animate-pulse" />
                <span className="text-[14px] font-medium tracking-wide">LIVE</span>
              </div>
              <button
                onClick={() => setQrModalOpen(false)}
                className="p-[7.5px] rounded-[5px] hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            {awaitingTunnel ? (
              <div className="flex flex-col items-center justify-center gap-2.5 py-12.5 text-center">
                {/* 28 × 1,25 = 35; genommen ist 36, weil das die Zahl ist, die
                    die App an dieser Groesse schon fuehrt (icon-leiter.test.ts
                    zaehlt die verschiedenen Iconmasse). +2,9 % gegen den
                    exakten Wert. */}
                <RefreshCw size={36} className="animate-spin text-emerald-700 dark:text-emerald-400/70" />
                <span className="text-[16px] text-emerald-700 dark:text-emerald-400/90">Connecting to Cloudflare…</span>
                <span className="text-[12px] text-gray-500">The QR appears once the tunnel is live</span>
              </div>
            ) : qrPngBase64 ? (
              <div className="bg-white rounded-[10px] p-3.75 ring-1 ring-gray-200 dark:ring-0">
                <img
                  src={`data:image/png;base64,${qrPngBase64}`}
                  alt="QR code"
                  className="w-[350px] h-[350px] block"
                  style={{ imageRendering: 'pixelated' }}
                />
              </div>
            ) : null}

            <div className="flex items-center justify-center gap-3.75 w-full">
              <code className="text-[30px] font-mono font-bold text-gray-900 dark:text-white tracking-[10px]">{passcode}</code>
              <button
                onClick={() => copyToClipboard(passcode, 'modal-passcode')}
                className="p-[7.5px] rounded-[5px] hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                aria-label={copied === 'modal-passcode' ? 'Passcode copied' : 'Copy passcode'}
                title={copied === 'modal-passcode' ? 'Copied' : 'Copy passcode'}
              >
                {copied === 'modal-passcode' ? <Check size={18} /> : <Copy size={18} />}
              </button>
            </div>
            {countdown && (
              <div className={`text-[13px] font-mono ${countdown === 'Expired' ? 'text-red-700 dark:text-red-400' : 'text-gray-500'}`}>
                {countdown === 'Expired' ? 'Expired, regenerating…' : `Expires in ${countdown}`}
              </div>
            )}

            <div className="w-full flex items-center gap-2.5 px-3.75 py-2.5 rounded-[5px] bg-white/[0.04] border border-white/5">
              <code className={`text-[13px] truncate flex-1 ${tunnelActive ? 'text-emerald-700 dark:text-emerald-400' : 'text-blue-700 dark:text-blue-400'}`}>
                {tunnelActive && tunnelUrl ? `${tunnelUrl}/mobile` : (mobileUrl || lanUrl)}
              </code>
              <button
                onClick={() => copyToClipboard(tunnelActive && tunnelUrl ? `${tunnelUrl}/mobile` : (mobileUrl || lanUrl), 'modal-url')}
                className="p-1.25 rounded-[5px] hover:bg-white/10 text-gray-400 hover:text-white transition-colors shrink-0"
                aria-label={copied === 'modal-url' ? 'Address copied' : 'Copy address'}
                title={copied === 'modal-url' ? 'Copied' : 'Copy address'}
              >
                {copied === 'modal-url' ? <Check size={15} /> : <Copy size={15} />}
              </button>
            </div>

            <p className="text-[12px] text-gray-500 text-center">
              Scan the QR or enter the 6-digit code on your phone.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    </>
  )
}
