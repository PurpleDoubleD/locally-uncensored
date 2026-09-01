import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Search, Trash2, Edit3, Check, X, MessageSquare, Code, Radio, Copy, RefreshCw, Square, Wifi, Globe, QrCode } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCodexStore } from '../../stores/codexStore'
import { useRemoteStore, REMOTE_DEV_MODE_ERROR } from '../../stores/remoteStore'
import { backendCall, isTauri } from '../../api/backend'
import { truncate } from '../../lib/formatters'
import {
  conversationMatches, sameSidebarRows, toSidebarRow, type SidebarRow,
} from './sidebar-rows'

export function Sidebar() {
  // Targeted selectors throughout. A whole-store subscription here re-rendered
  // the entire sidebar once per animation frame for the full duration of every
  // streamed answer — and it did so even while another view was on screen,
  // because AppShell mounts the sidebar unconditionally.
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const createConversation = useChatStore((s) => s.createConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const renameConversation = useChatStore((s) => s.renameConversation)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const setView = useUIStore((s) => s.setView)
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
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [countdown, setCountdown] = useState('')
  const [dispatchPicker, setDispatchPicker] = useState(false)
  const [qrModalOpen, setQrModalOpen] = useState(false)
  // Right-click menu on a conversation row. sweenscapehub searched the whole
  // app and right-clicked the chats before asking in Discord how to delete one
  // (2026-07-30): the buttons existed, but at 10 px and only on hover, and the
  // gesture everyone tries first did nothing at all.
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null)

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
      } catch {
        // Override is a nice-to-have — fall through and dispatch anyway.
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

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
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

  return (
    <AnimatePresence>
      {sidebarOpen && (
        <motion.aside
          className="w-[200px] h-full rounded-xl bg-white dark:bg-[#1e1e1e] ring-1 ring-black/[0.04] dark:ring-white/[0.05] flex flex-col z-20 overflow-hidden"
          style={{ zoom: 1.25 }}
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 200, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          {/* Mode Tabs (Chat | Code | Remote) — icon-only, like uselu.
              Labels live in title/aria-label for accessibility. */}
          <div className="flex items-center gap-0.5 px-2 pt-2 pb-1">
            {/* Chat tab */}
            <button
              onClick={() => { setChatMode('lu'); setActiveConversation(null); setView('chat'); setDispatchPicker(false) }}
              title="Chat"
              aria-label="Chat"
              className={`flex items-center gap-1 justify-center px-2 py-1 rounded text-[0.6rem] font-medium transition-all flex-1 ${
                !isCodingMode && !isRemoteMode
                  ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white border border-gray-300 dark:border-white/15'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 border border-transparent'
              }`}
            >
              <MessageSquare size={9} />
              <span>Chat</span>
            </button>

            {/* Code tab — direct switch to the coding agent (no dropdown).
                Internal mode value 'codex' is kept for storage back-compat. */}
            <button
              onClick={() => { setChatMode('codex'); setActiveConversation(null); setView('chat'); setDispatchPicker(false) }}
              title="Code"
              aria-label="Code"
              className={`flex items-center gap-1 justify-center px-2 py-1 rounded text-[0.6rem] font-medium transition-all flex-1 ${
                isCodingMode
                  ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white border border-gray-300 dark:border-white/15'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 border border-transparent'
              }`}
            >
              <Code size={9} />
              <span>Code</span>
            </button>

            {/* Remote tab */}
            <button
              onClick={() => { setChatMode('remote'); setActiveConversation(dispatchedConversationId); setView('chat') }}
              title="Remote"
              aria-label="Remote"
              className={`flex items-center justify-center px-2 py-1 rounded font-medium transition-all flex-1 ${
                isRemoteMode
                  ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white border border-gray-300 dark:border-white/15'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 border border-transparent'
              }`}
            >
              <Radio size={11} />
            </button>
          </div>

          {/* Dispatch Panel — shown when Remote mode + active dispatch + qrVisible.
              Bug #16: collapse after first mobile message; reopen via the QR
              icon next to the dispatched chat row (see below). */}
          {isRemoteMode && remoteEnabled && dispatchedConversationId && qrVisible && (
            <div className="mx-2 mb-1 px-2 py-2 rounded-md bg-green-500/[0.06] border border-green-500/20 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  <span className="text-[0.55rem] font-medium text-green-400">LIVE</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={hideQr}
                    title="Hide QR panel (reopen via the QR icon on the chat row)"
                    className="flex items-center justify-center w-5 h-5 rounded text-gray-400 hover:bg-white/10 transition-all"
                  >
                    <X size={8} />
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
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.5rem] text-blue-400 hover:bg-blue-500/15 border border-blue-500/20 transition-all disabled:opacity-50"
                  >
                    <RefreshCw size={7} className={remoteLoading ? 'animate-spin' : ''} />
                    Restart
                  </button>
                  <button
                    onClick={undispatch}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.5rem] text-red-400 hover:bg-red-500/15 border border-red-500/20 transition-all"
                  >
                    <Square size={7} />
                    Stop
                  </button>
                </div>
              </div>

              {/* QR Code — hidden until Cloudflare is verified up (internet
                  mode); shown immediately for LAN. David 2026-06-15: never
                  flash a QR that points at the LAN IP while the tunnel is
                  still coming up. */}
              {awaitingTunnel ? (
                <div className="w-full flex flex-col items-center justify-center gap-1 py-4 text-center">
                  <RefreshCw size={16} className="animate-spin text-emerald-400/70" />
                  <span className="text-[0.55rem] text-emerald-400/80">Connecting to Cloudflare…</span>
                  <span className="text-[0.45rem] text-gray-500 leading-snug px-2">The QR appears once the tunnel is live</span>
                </div>
              ) : qrPngBase64 ? (
                <button
                  onClick={() => setQrModalOpen(true)}
                  title="Show large QR code"
                  className="w-full flex justify-center group"
                >
                  <div className="bg-white rounded p-1 transition-all group-hover:ring-2 group-hover:ring-green-400/50 group-hover:scale-[1.04]">
                    <img src={`data:image/png;base64,${qrPngBase64}`} alt="QR" className="w-[72px] h-[72px]" />
                  </div>
                </button>
              ) : null}

              {/* Passcode */}
              <div className="flex items-center justify-between">
                <code className="text-[0.7rem] text-amber-400 font-mono tracking-[3px] font-bold">{passcode}</code>
                <div className="flex items-center gap-1">
                  <button onClick={() => copyToClipboard(passcode)} className="p-0.5 hover:bg-white/10 rounded">
                    <Copy size={9} className="text-gray-500" />
                  </button>
                  <button onClick={regenerateToken} className="p-0.5 hover:bg-white/10 rounded">
                    <RefreshCw size={9} className="text-gray-500" />
                  </button>
                  {countdown && (
                    <span className={`text-[0.45rem] font-mono ${countdown === 'Expired' ? 'text-red-400' : 'text-gray-600'}`}>
                      {countdown}
                    </span>
                  )}
                </div>
              </div>

              {/* URL — prefer tunnel URL when tunnel is active */}
              <div className="flex items-center gap-1">
                {tunnelLoading ? (
                  <code className="text-[0.5rem] text-emerald-400/70 truncate flex-1 animate-pulse">Starting Cloudflare tunnel…</code>
                ) : (
                  <>
                    <code className={`text-[0.5rem] truncate flex-1 ${tunnelActive ? 'text-emerald-400' : 'text-blue-400'}`}>
                      {tunnelActive && tunnelUrl ? `${tunnelUrl}/mobile` : (mobileUrl || lanUrl)}
                    </code>
                    <button onClick={() => copyToClipboard(tunnelActive && tunnelUrl ? `${tunnelUrl}/mobile` : (mobileUrl || lanUrl))} className="p-0.5 hover:bg-white/10 rounded shrink-0">
                      <Copy size={9} className="text-gray-500" />
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
                <p className="text-[0.5rem] text-gray-500/70 leading-snug">
                  First connection may take 5 to 10 s while DNS propagates. If you see a DNS error, wait a moment and reload.
                </p>
              )}

              {remoteError && (
                <p className="text-[0.5rem] text-red-400 truncate">{remoteError}</p>
              )}
            </div>
          )}

          {/* Search */}
          <div className="px-2 pb-1">
            <div className="relative">
              <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-600" />
              <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-6 pr-2 py-1 rounded-md bg-transparent border border-gray-200 dark:border-white/[0.04] text-[0.65rem] text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-gray-400 dark:focus:border-white/10"
              />
            </div>
          </div>

          {/* Conversations */}
          <div className="flex-1 overflow-y-auto px-1.5 pt-1 space-y-px scrollbar-thin">
            {filtered.map((conv) => (
              <div
                key={conv.id}
                className={`group flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer transition-all ${
                  conv.id === activeConversationId
                    ? 'bg-gray-200 dark:bg-white/[0.06] text-gray-900 dark:text-white'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.03] hover:text-gray-800 dark:hover:text-gray-200'
                }`}
                onClick={() => {
                  setActiveConversation(conv.id)
                  setView('chat')
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setRowMenu({ id: conv.id, x: e.clientX, y: e.clientY })
                }}
              >
                <div className="flex-1 min-w-0">
                  {editingId === conv.id ? (
                    <div className="flex items-center gap-1">
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleRename(conv.id)}
                        className="w-full bg-white/5 rounded px-1 py-0.5 text-[0.65rem] text-white focus:outline-none"
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                      <button onClick={(e) => { e.stopPropagation(); handleRename(conv.id) }} className="text-green-400"><Check size={11} /></button>
                      <button onClick={(e) => { e.stopPropagation(); setEditingId(null) }} className="text-gray-500"><X size={11} /></button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 min-w-0">
                      {isRemoteMode && conv.id === dispatchedConversationId && remoteEnabled && (
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                      )}
                      <p className="text-[0.66rem] truncate flex-1 min-w-0">{truncate(conv.title, 30)}</p>
                      {/* Already formatted in the projection — see SidebarRow. */}
                      <span className="text-[0.5rem] text-gray-600 shrink-0">{conv.date}</span>
                    </div>
                  )}
                </div>
                {editingId !== conv.id && (
                  <div className="flex items-center gap-0.5 shrink-0">
                    {/* Bug #16: QR icon on the dispatched Remote chat row.
                        Always visible (not hover-gated) and opens the LARGE
                        QR-modal directly — the row icon itself is just a
                        marker, the actual scannable code lives in the modal. */}
                    {isRemoteMode && conv.id === dispatchedConversationId && remoteEnabled && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setQrModalOpen(true) }}
                        title="Show QR & passcode"
                        className="p-1 rounded hover:bg-green-500/15 text-green-400 transition-colors"
                      >
                        <QrCode size={13} />
                      </button>
                    )}
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditingId(conv.id); setEditTitle(conv.title) }}
                        title="Rename chat"
                        aria-label="Rename chat"
                        className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-gray-300"
                      >
                        <Edit3 size={13} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id) }}
                        title="Delete chat"
                        aria-label="Delete chat"
                        className="p-1 rounded hover:bg-red-500/20 text-gray-500 hover:text-red-400"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {filtered.length === 0 && (
              <p className="text-center text-gray-600 text-[0.6rem] py-6">
                {search ? 'No results' : isRemoteMode ? 'No dispatched chats' : 'No conversations'}
              </p>
            )}
          </div>

          {/* Bottom Action */}
          <div className="px-2 pb-2 pt-1 border-t border-gray-200 dark:border-white/[0.04]">
            {/* #29: dispatch failure used to be invisible — the orphan
                conv was deleted in handleDispatch's catch block and the
                user was left looking at the Dispatch button as if nothing
                happened. Surface the actual reason here so the next click
                is informed (close other LU instance, change network,
                etc.). Only renders when no chat is dispatched, otherwise
                ChatView's "Server stopped" banner owns this. */}
            {isRemoteMode && remoteError && !dispatchedConversationId && (
              <div className="mb-1.5 px-2 py-1 rounded border border-red-500/30 bg-red-500/5 text-[0.55rem] text-red-300/90 flex items-start gap-1.5">
                <span className="break-words flex-1 leading-snug">{remoteError}</span>
                <button
                  onClick={() => useRemoteStore.getState().clearError()}
                  title="Dismiss"
                  className="shrink-0 p-0.5 rounded text-red-400/70 hover:text-red-300 hover:bg-red-500/15 transition-all"
                >
                  <X size={9} />
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
                    className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-[0.65rem] text-gray-500 hover:text-white hover:bg-white/[0.04] border border-zinc-300/40 dark:border-zinc-500/40 hover:border-zinc-300/60 dark:hover:border-zinc-400/60 transition-all disabled:opacity-40"
                  >
                    <Radio size={12} />
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
                      className="relative z-50 w-full flex items-center gap-0.5"
                    >
                      <button
                        onClick={() => handleDispatch('lan')}
                        className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md text-[0.55rem] font-medium text-gray-400 border border-zinc-300/40 dark:border-zinc-500/40 hover:bg-white/[0.05] hover:text-zinc-100 hover:border-zinc-300/60 dark:hover:border-zinc-400/60 transition-all cursor-pointer"
                      >
                        <Wifi size={10} className="text-zinc-400" />
                        LAN
                      </button>
                      <button
                        onClick={() => handleDispatch('internet')}
                        className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md text-[0.55rem] font-medium text-gray-400 border border-zinc-300/40 dark:border-zinc-500/40 hover:bg-white/[0.05] hover:text-zinc-100 hover:border-zinc-300/60 dark:hover:border-zinc-400/60 transition-all cursor-pointer"
                      >
                        <Globe size={10} className="text-zinc-400" />
                        Internet
                      </button>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            ) : (
              <button
                onClick={handleNewChat}
                title={activeModel ? 'Start a new chat' : 'Pick or install a model first'}
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-[0.65rem] font-medium bg-gray-50 dark:bg-white/[0.03] hover:bg-gray-100 dark:hover:bg-white/[0.05] text-gray-800 dark:text-gray-200 border border-gray-200 dark:border-white/[0.06] hover:border-gray-300 dark:hover:border-white/[0.1] transition-all"
              >
                <Plus size={12} />
                <span>New Chat</span>
              </button>
            )}
          </div>
        </motion.aside>
      )}

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
            className="absolute min-w-[9rem] py-1 rounded-md bg-white dark:bg-[#141414] border border-gray-200 dark:border-white/10 shadow-lg text-[0.7rem]"
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
              className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
            >
              <Edit3 size={12} />
              <span>Rename</span>
            </button>
            <button
              role="menuitem"
              onClick={() => { deleteConversation(rowMenu.id); setRowMenu(null) }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-red-500 hover:bg-red-500/10"
            >
              <Trash2 size={12} />
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
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
          onClick={() => setQrModalOpen(false)}
        >
          <motion.div
            initial={{ scale: 0.92, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.92, opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="bg-[#212121] border border-white/10 rounded-xl p-5 max-w-[360px] w-full flex flex-col items-center gap-3 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-1.5 text-green-400">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                <span className="text-[0.7rem] font-medium tracking-wide">LIVE</span>
              </div>
              <button
                onClick={() => setQrModalOpen(false)}
                className="p-1.5 rounded hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>

            {awaitingTunnel ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                <RefreshCw size={28} className="animate-spin text-emerald-400/70" />
                <span className="text-[0.8rem] text-emerald-400/90">Connecting to Cloudflare…</span>
                <span className="text-[0.6rem] text-gray-500">The QR appears once the tunnel is live</span>
              </div>
            ) : qrPngBase64 ? (
              <div className="bg-white rounded-lg p-3">
                <img
                  src={`data:image/png;base64,${qrPngBase64}`}
                  alt="QR code"
                  className="w-[280px] h-[280px] block"
                  style={{ imageRendering: 'pixelated' }}
                />
              </div>
            ) : null}

            <div className="flex items-center justify-center gap-3 w-full">
              <code className="text-2xl font-mono font-bold text-amber-400 tracking-[8px]">{passcode}</code>
              <button
                onClick={() => copyToClipboard(passcode)}
                className="p-1.5 rounded hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                title="Copy passcode"
              >
                <Copy size={14} />
              </button>
            </div>
            {countdown && (
              <div className={`text-[0.65rem] font-mono ${countdown === 'Expired' ? 'text-red-400' : 'text-gray-500'}`}>
                {countdown === 'Expired' ? 'Expired, regenerating…' : `Expires in ${countdown}`}
              </div>
            )}

            <div className="w-full flex items-center gap-2 px-3 py-2 rounded bg-white/[0.04] border border-white/5">
              <code className={`text-[0.65rem] truncate flex-1 ${tunnelActive ? 'text-emerald-400' : 'text-blue-400'}`}>
                {tunnelActive && tunnelUrl ? `${tunnelUrl}/mobile` : (mobileUrl || lanUrl)}
              </code>
              <button
                onClick={() => copyToClipboard(tunnelActive && tunnelUrl ? `${tunnelUrl}/mobile` : (mobileUrl || lanUrl))}
                className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-white transition-colors shrink-0"
                title="Copy URL"
              >
                <Copy size={12} />
              </button>
            </div>

            <p className="text-[0.6rem] text-gray-500 text-center">
              Scan the QR or enter the 6-digit code on your phone.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
